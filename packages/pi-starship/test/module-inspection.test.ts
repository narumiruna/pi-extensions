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
  const inspection = inspectStatuslineModules(configWithFormat("$all"), fixture(), 80);
  const username = inspection.modules.find((module) => module.name === "username");
  const context = inspection.modules.find((module) => module.name === "context");

  assert.deepEqual(username?.styleFields, ["style", "style_user", "style_root"]);
  assert.ok(username?.variables.includes("user"));
  assert.equal(username?.reachable, true);
  assert.ok((context?.displayRules.length ?? 0) > 0);
  assert.equal(inspection.modules.length, MODULE_DEFINITIONS.length);
});
