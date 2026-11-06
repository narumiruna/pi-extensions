import assert from "node:assert/strict";
import { test } from "vitest";
import { BUILT_IN_CONFIG } from "../src/config.js";
import { parseFormat } from "../src/format/formatter.js";
import {
  inspectStatuslineModules,
  inspectUnavailableModules,
  MODULE_DEFINITIONS,
  type StarshipRuntimeSnapshot,
} from "../src/modules/index.js";

function fixture(overrides: Partial<StarshipRuntimeSnapshot> = {}): StarshipRuntimeSnapshot {
  return {
    cwd: "/work/pi-extensions",
    model: { provider: "anthropic", id: "claude-sonnet-4" },
    thinkingLevel: "high",
    turnCount: 2,
    activeTools: new Map(),
    isStreaming: false,
    contextUsage: { percent: 40, tokens: 400, contextWindow: 1000 },
    tokenTotals: {
      input: 100,
      output: 50,
      cacheRead: 0,
      cacheWrite: 0,
      cost: 0,
    },
    usingSubscription: false,
    gitBranch: null,
    extensionStatuses: new Map(),
    now: new Date(2026, 7, 2, 9, 5),
    ...overrides,
  };
}

function configWithFormat(format: string) {
  const config = structuredClone(BUILT_IN_CONFIG);
  config.format = format;
  config.formatAst = parseFormat(format);
  return config;
}

function extensionStatusConfig(format: string, maxStatuses = 5) {
  const config = configWithFormat(format);
  config.modules.extension_status.format = "$statuses";
  config.modules.extension_status.formatAst = parseFormat("$statuses");
  config.modules.extension_status.style = "none";
  config.extensionStatus.icons = { fallback: "" };
  config.extensionStatus.separator = " / ";
  config.extensionStatus.maxStatuses = maxStatuses;
  return config;
}

test("the module catalog exposes one concise description for every registered module", () => {
  const names = new Set<string>();
  for (const definition of MODULE_DEFINITIONS) {
    assert.equal(names.has(definition.name), false, definition.name);
    names.add(definition.name);
    assert.ok(definition.description.trim().length > 0, definition.name);
    assert.doesNotMatch(definition.description, /[\r\n]/u, definition.name);
  }
  assert.ok(names.size > 40);
});

test("inspection classifies explicit modules and explains each showing module once", () => {
  const config = configWithFormat("$model$model$git_branch$cost");
  const inspection = inspectStatuslineModules(config, fixture(), 80);
  const byName = new Map(inspection.modules.map((module) => [module.name, module]));

  assert.deepEqual(
    inspection.showing.map((module) => module.name),
    ["model"],
  );
  assert.equal(byName.get("model")?.state, "Showing");
  assert.match(byName.get("model")?.preview ?? "", /sonnet-4/u);
  assert.equal((byName.get("model")?.preview ?? "").includes("\u001b"), false);
  assert.equal(byName.get("git_branch")?.state, "Empty");
  assert.match(byName.get("git_branch")?.reason ?? "", /current snapshot produced no output/iu);
  assert.equal(byName.get("cost")?.state, "Empty");
  assert.equal(byName.get("brand")?.state, "Not in format");
  assert.match(byName.get("brand")?.reason ?? "", /root format|\$all/iu);
});

test("inspection distinguishes disabled modules and $all reachability", () => {
  const explicit = configWithFormat("$git_branch");
  explicit.modules.git_branch.disabled = true;
  const disabled = inspectStatuslineModules(
    explicit,
    fixture({ gitBranch: "feature", gitBranchDetails: { name: "feature", detached: false } }),
    80,
  );
  const disabledBranch = disabled.modules.find((module) => module.name === "git_branch");
  assert.equal(disabledBranch?.state, "Disabled");
  assert.equal(disabledBranch?.rootReferenced, true);
  assert.equal(disabledBranch?.reachable, false);

  const all = inspectStatuslineModules(configWithFormat("$all"), fixture(), 80);
  assert.equal(all.modules.find((module) => module.name === "directory")?.state, "Showing");
  assert.equal(all.modules.find((module) => module.name === "os")?.state, "Disabled");
  assert.notEqual(all.modules.find((module) => module.name === "brand")?.state, "Not in format");
});

test("unavailable inspection preserves config-derived disabled and reachability states", () => {
  const inspection = inspectUnavailableModules(BUILT_IN_CONFIG);
  assert.equal(inspection.showing.length, 0);
  assert.equal(inspection.modules.find((module) => module.name === "brand")?.state, "Unavailable");
  assert.equal(inspection.modules.find((module) => module.name === "os")?.state, "Disabled");
  assert.equal(inspection.modules.find((module) => module.name === "github_pr")?.state, "Not in format");
});

test("module inspection exposes read-only detail metadata", () => {
  const config = configWithFormat("$all");
  config.modules.model.styleRules = [{ selectors: { provider: "anthropic" }, style: "blue" }];
  const inspection = inspectStatuslineModules(config, fixture(), 80);
  const username = inspection.modules.find((module) => module.name === "username");
  const model = inspection.modules.find((module) => module.name === "model");
  const context = inspection.modules.find((module) => module.name === "context");

  assert.deepEqual(username?.styleFields, ["style", "style_user", "style_root"]);
  assert.ok(username?.variables.includes("user"));
  assert.equal(username?.reachable, true);
  assert.deepEqual(model?.styleRuleSelectors, ["provider", "model"]);
  assert.equal(model?.styleRuleCount, 1);
  assert.deepEqual(username?.styleRuleSelectors, []);
  assert.equal(username?.styleRuleCount, 0);
  assert.ok((context?.displayRules.length ?? 0) > 0);
  assert.equal(inspection.modules.length, MODULE_DEFINITIONS.length);
});

test.each([
  ["child only", `\${extension_status.a}`, "Showing", ["alpha"], ["beta", "gamma"]],
  ["absent child only", `\${extension_status.absent}`, "Empty", [], ["alpha", "beta", "gamma"]],
  ["several children", `\${extension_status.c}|\${extension_status.a}`, "Showing", ["gamma", "alpha"], ["beta"]],
  ["nested child", `([\${extension_status.a}](blue))`, "Showing", ["alpha"], ["beta", "gamma"]],
  ["aggregate only", "$extension_status", "Showing", ["alpha", "beta", "gamma"], []],
  ["aggregate plus child", `$extension_status|\${extension_status.a}`, "Showing", ["alpha", "beta", "gamma"], []],
  ["all plus child", `$all|\${extension_status.a}`, "Showing", ["alpha", "beta", "gamma"], []],
  [
    "all plus explicit aggregate and child",
    `$all$extension_status|\${extension_status.a}`,
    "Showing",
    ["alpha", "beta", "gamma"],
    [],
  ],
  [
    "all children leave an empty aggregate",
    `\${extension_status.a}\${extension_status.b}\${extension_status.c}($extension_status)`,
    "Showing",
    ["alpha", "beta", "gamma"],
    [],
  ],
  ["unreferenced", "$model", "Not in format", [], []],
  ["invalid empty suffix", `\${extension_status.}`, "Not in format", [], []],
] satisfies [string, string, string, string[], string[]][])(
  "extension-status inspection recognizes the parent for %s",
  (_name, format, state, included, excluded) => {
    const inspection = inspectStatuslineModules(
      extensionStatusConfig(format),
      fixture({
        extensionStatuses: new Map([
          ["a", "alpha"],
          ["b", "beta"],
          ["c", "gamma"],
        ]),
      }),
      80,
    );
    const parent = inspection.modules.find((module) => module.name === "extension_status");
    assert.ok(parent);
    assert.equal(parent.state, state);
    assert.equal(parent.rootReferenced, state !== "Not in format");
    assert.equal(parent.reachable, state !== "Not in format");
    assert.equal(
      inspection.showing.some((module) => module.name === "extension_status"),
      state === "Showing",
    );
    assert.equal(parent.preview.includes("\u001b"), false);
    for (const text of included) assert.ok(parent.preview.includes(text), parent.preview);
    for (const text of excluded) assert.equal(parent.preview.includes(text), false, parent.preview);
  },
);

test.each([
  ["empty snapshot", `\${extension_status.a}`, [], 5, false, "Empty"],
  [
    "empty child with an active unselected status",
    `\${extension_status.a}`,
    [
      ["a", " \t"],
      ["b", "beta"],
    ],
    5,
    false,
    "Empty",
  ],
  [
    "self child with an active unselected status",
    `\${extension_status.starship}`,
    [
      ["starship", "internal"],
      ["b", "beta"],
    ],
    5,
    false,
    "Empty",
  ],
  [
    "prefix-only child with an active unselected status",
    `\${extension_status.a}`,
    [
      ["a", "a: "],
      ["b", "beta"],
    ],
    5,
    false,
    "Empty",
  ],
  [
    "suppressed emoji-only child with an active unselected status",
    `\${extension_status.a}`,
    [
      ["a", "⚡"],
      ["b", "beta"],
    ],
    5,
    false,
    "Empty",
  ],
  ["disabled child", `\${extension_status.a}`, [["a", "alpha"]], 5, true, "Disabled"],
  [
    "disabled mixed layout",
    `$extension_status\${extension_status.a}`,
    [
      ["a", "alpha"],
      ["b", "beta"],
    ],
    5,
    true,
    "Disabled",
  ],
  ["zero-cap child", `\${extension_status.a}`, [["a", "alpha"]], 0, false, "Empty"],
  [
    "zero-cap mixed layout",
    `$extension_status\${extension_status.a}`,
    [
      ["a", "alpha"],
      ["b", "beta"],
    ],
    0,
    false,
    "Empty",
  ],
] satisfies [string, string, [string, string][], number, boolean, string][])(
  "extension-status inspection classifies %s without an unrelated preview",
  (_name, format, statuses, cap, disabled, state) => {
    const config = extensionStatusConfig(format, cap);
    config.modules.extension_status.disabled = disabled;
    config.extensionStatus.icons.a = "";
    const inspection = inspectStatuslineModules(config, fixture({ extensionStatuses: new Map(statuses) }), 80);
    const parent = inspection.modules.find((module) => module.name === "extension_status");
    assert.ok(parent);
    assert.equal(parent.state, state);
    assert.equal(parent.rootReferenced, true);
    assert.equal(parent.reachable, !disabled);
    assert.equal(parent.preview, "");
    assert.equal(
      inspection.showing.some((module) => module.name === "extension_status"),
      false,
    );
  },
);

test.each([
  ["child beyond the aggregate cap", `ROOT(\${extension_status.d})TAIL`, ["delta"], ["alpha", "beta", "gamma"]],
  ["mixed capped selections", `$extension_status|\${extension_status.d}`, ["alpha", "delta"], ["beta", "gamma"]],
  ["all capped selections", `$all|\${extension_status.d}`, ["alpha", "delta"], ["beta", "gamma"]],
  [
    "several independent child selections",
    `$extension_status|\${extension_status.b}|\${extension_status.d}`,
    ["alpha", "beta", "delta"],
    ["gamma"],
  ],
  ["repeated child selections", `\${extension_status.d}|\${extension_status.d}`, ["delta"], ["alpha", "beta", "gamma"]],
] satisfies [string, string, string[], string[]][])(
  "extension-status previews include only reachable expansions for %s",
  (_name, format, included, excluded) => {
    const inspection = inspectStatuslineModules(
      extensionStatusConfig(format, 1),
      fixture({
        extensionStatuses: new Map([
          ["a", "alpha"],
          ["b", "beta"],
          ["c", "gamma"],
          ["d", "delta"],
        ]),
      }),
      80,
    );
    const parent = inspection.modules.find((module) => module.name === "extension_status");
    assert.ok(parent);
    assert.equal(parent.state, "Showing");
    assert.equal(parent.rootReferenced, true);
    assert.equal(parent.reachable, true);
    for (const text of included) assert.ok(parent.preview.includes(text), parent.preview);
    for (const text of [...excluded, "ROOT", "TAIL"])
      assert.equal(parent.preview.includes(text), false, parent.preview);
  },
);

test("unavailable inspection derives child-only reachability without a runtime snapshot", () => {
  for (const disabled of [false, true]) {
    const config = extensionStatusConfig(`([\${extension_status.usage.slot}](blue))`);
    config.modules.extension_status.disabled = disabled;
    const inspection = inspectUnavailableModules(config);
    const parent = inspection.modules.find((module) => module.name === "extension_status");
    assert.equal(parent?.state, disabled ? "Disabled" : "Unavailable");
    assert.equal(parent?.rootReferenced, true);
    assert.equal(parent?.reachable, !disabled);
    assert.equal(parent?.preview, "");
    assert.equal(inspection.showing.length, 0);
  }
});
