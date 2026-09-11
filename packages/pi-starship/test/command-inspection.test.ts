import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { KeybindingsManager } from "@earendil-works/pi-coding-agent";
import { CURSOR_MARKER, visibleWidth } from "@earendil-works/pi-tui";
import { createTuiHarness } from "@narumitw/pi-tui-kit/testing";
import { test } from "vitest";
import { createMockContext, createMockPi } from "../../../test/support.js";
import { formatFooterExplanation } from "../src/command-inspector.js";
import { registerStarshipCommand } from "../src/commands.js";
import { loadStarshipConfig } from "../src/config.js";
import type { ModuleInspection, StatuslineInspection } from "../src/modules/inspection.js";

const MODEL: ModuleInspection = {
  name: "model",
  description: "Current Pi model.",
  state: "Showing",
  preview: "◆ claude-sonnet-4",
  variables: ["symbol", "model"],
  styleFields: ["style"],
  displayRules: [],
  rootReferenced: true,
  reachable: true,
  reason: "Rendered in the current footer.",
};

const GIT_BRANCH: ModuleInspection = {
  name: "git_branch",
  description: "Current Git branch.\u001b[31m",
  state: "Empty",
  preview: "",
  variables: ["symbol", "branch", "remote_name"],
  styleFields: ["style"],
  displayRules: [],
  rootReferenced: true,
  reachable: true,
  reason: "Referenced by the root format, but the current snapshot produced no output.",
};

const COST: ModuleInspection = {
  name: "cost",
  description: "Reported estimated session cost.",
  state: "Not in format",
  preview: "",
  variables: ["symbol", "cost", "subscription"],
  styleFields: ["style"],
  displayRules: ["0: hidden", "1: yellow", "5: red"],
  rootReferenced: false,
  reachable: false,
  reason: "Not referenced by the root format or $all.",
};

const INSPECTION: StatuslineInspection = {
  modules: [MODEL, GIT_BRANCH, COST],
  showing: [MODEL],
};

test("footer explanation formatter covers available, empty, unavailable, and unsafe snapshots", () => {
  assert.equal(
    formatFooterExplanation(INSPECTION),
    ["model", "Value: ◆ claude-sonnet-4", "Current Pi model."].join("\n"),
  );
  assert.equal(
    formatFooterExplanation({ modules: INSPECTION.modules, showing: [] }),
    ["No modules are currently showing.", "Open Modules to inspect empty, disabled, or unreachable modules."].join(
      "\n",
    ),
  );
  assert.equal(
    formatFooterExplanation(undefined),
    ["Footer inspection is unavailable until the TUI footer is ready.", "No collection work was started."].join("\n"),
  );
  const unsafe: ModuleInspection = {
    ...MODEL,
    preview: "value\u0007\nnext\tvalue",
    description: "description\u001b]8;;https://unsafe.example\u0007",
  };
  const formatted = formatFooterExplanation({ modules: [unsafe], showing: [unsafe] });
  assert.equal(formatted.includes("\u001b"), false);
  assert.equal(formatted.includes("\u0007"), false);
  assert.equal(formatted.includes("\t"), false);
  assert.match(formatted, /model[\s\S]*Value: value[\s\S]*nextvalue[\s\S]*description/u);
});

test("/starship adds Explain footer and Modules without adding direct routes", async () => {
  const mock = createMockPi();
  const path = "/tmp/missing-pi-starship-inspection-menu.toml";
  registerStarshipCommand(mock.pi, {
    getLoaded: () => loadStarshipConfig(path),
    getInspection: () => INSPECTION,
    apply() {},
    settingsPath: path,
  });
  const command = mock.commands.get("starship");
  assert.ok(command);
  assert.ok(command.getArgumentCompletions);
  assert.deepEqual(
    (command.getArgumentCompletions("") as Array<{ value: string }>).map((item) => item.value),
    ["settings", "status", "help"],
  );

  const tui = createTuiHarness({ width: 40, rows: 24 });
  const context = createMockContext({ mode: "tui", hasUI: true, custom: tui.custom });
  const running = command.handler("", context.ctx);
  await tui.waitForOpen();
  const frame = tui.render().join("\n");
  assert.match(frame, /Customize footer/u);
  assert.match(frame, /Presets/u);
  assert.match(frame, /Explain footer/u);
  assert.match(frame, /Modules/u);
  assert.match(frame, /Configuration/u);
  assert.match(frame, /Help/u);
  assert.match(frame, /Restore built-in…/u);
  tui.press("ctrl+c");
  await running;
});

test("Explain footer is adaptive and lists only currently showing modules", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-starship-explain-"));
  const path = join(root, "pi-starship.toml");
  try {
    const mock = createMockPi();
    registerStarshipCommand(mock.pi, {
      getLoaded: () => loadStarshipConfig(path),
      getInspection: () => INSPECTION,
      apply() {},
      settingsPath: path,
    });
    const tui = createTuiHarness({ width: 20, rows: 8 });
    const context = createMockContext({ mode: "tui", hasUI: true, custom: tui.custom });
    const running = mock.commands.get("starship")?.handler("", context.ctx);
    await tui.waitForOpen();
    tui.press("tui.select.down");
    tui.press("tui.select.down");
    tui.press("tui.select.confirm");
    await tui.waitForOpen();
    for (const dimensions of [
      { width: 20, rows: 8 },
      { width: 28, rows: 12 },
      { width: 80, rows: 24 },
    ]) {
      const frame = tui.resize(dimensions);
      assert.ok(frame.length <= Math.max(1, dimensions.rows - 3));
      assert.ok(frame.every((line) => visibleWidth(line) <= dimensions.width));
    }
    const explanation = tui.resize({ width: 80, rows: 24 }).join("\n");
    assert.match(explanation, /Explain footer/u);
    assert.match(explanation, /model/u);
    assert.match(explanation, /◆ claude-sonnet-4/u);
    assert.match(explanation, /Current Pi model/u);
    assert.doesNotMatch(explanation, /git_branch|Reported estimated session cost/u);
    assert.equal(existsSync(path), false);
    tui.press("tui.select.cancel");
    await tui.waitForOpen();
    assert.match(tui.render().join("\n"), /→ Explain footer/u);
    tui.press("ctrl+c");
    await running;
    assert.equal(existsSync(path), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Explain footer scrolls long content and clamps it across resize", async () => {
  const moduleNames = [
    "brand",
    "provider",
    "model",
    "thinking",
    "directory",
    "git_branch",
    "activity",
    "context",
    "tokens",
    "cache",
    "cost",
    "time",
  ] as const;
  const showing: ModuleInspection[] = moduleNames.map((name, index) => ({
    ...MODEL,
    name,
    preview: `value ${index + 1}`,
    description: `Description ${index + 1}.`,
  }));
  const inspection = { modules: showing, showing };
  const mock = createMockPi();
  const path = "/tmp/missing-pi-starship-long-explain.toml";
  registerStarshipCommand(mock.pi, {
    getLoaded: () => loadStarshipConfig(path),
    getInspection: () => inspection,
    apply() {},
    settingsPath: path,
  });
  const tui = createTuiHarness({ width: 30, rows: 12 });
  const context = createMockContext({ mode: "tui", hasUI: true, custom: tui.custom });
  const running = mock.commands.get("starship")?.handler("", context.ctx);
  await tui.waitForOpen();
  tui.press("tui.select.down");
  tui.press("tui.select.down");
  tui.press("tui.select.confirm");
  await tui.waitForOpen();
  assert.match(tui.render().join("\n"), /brand/u);
  tui.press("end");
  tui.press("tui.select.up");
  assert.match(tui.render().join("\n"), /time/u);
  const constrained = tui.resize({ width: 20, rows: 7 });
  assert.ok(constrained.length <= 4);
  assert.ok(constrained.every((line) => visibleWidth(line) <= 20));
  assert.match(constrained.join("\n"), /\d+-\d+\/\d+/u);
  tui.press("tui.select.pageUp");
  assert.ok(tui.render().every((line) => visibleWidth(line) <= 20));
  tui.press("tui.select.cancel");
  await tui.waitForOpen();
  assert.match(tui.render().join("\n"), /→ Explain footer/u);
  tui.press("ctrl+c");
  await running;
});

test("Explain footer owner abort and external disposal close without writing", async () => {
  for (const exit of ["abort", "dispose"] as const) {
    const owner = new AbortController();
    const mock = createMockPi();
    const path = `/tmp/missing-pi-starship-explain-${exit}.toml`;
    registerStarshipCommand(mock.pi, {
      getLoaded: () => loadStarshipConfig(path),
      getInspection: () => INSPECTION,
      apply() {},
      settingsPath: path,
      getMenuOwner: () => ({
        signal: owner.signal,
        isCurrent: () => !owner.signal.aborted,
      }),
    });
    const tui = createTuiHarness({ width: 40, rows: 12 });
    const context = createMockContext({ mode: "tui", hasUI: true, custom: tui.custom });
    const running = mock.commands.get("starship")?.handler("", context.ctx);
    await tui.waitForOpen();
    tui.press("tui.select.down");
    tui.press("tui.select.down");
    tui.press("tui.select.confirm");
    await tui.waitForOpen();
    if (exit === "abort") owner.abort(new DOMException("Session replaced", "AbortError"));
    else tui.dispose();
    await running;
    assert.equal(tui.isOpen, false);
    assert.equal(existsSync(path), false);
  }
});

test("Explain footer has an explicit empty state", async () => {
  const mock = createMockPi();
  const path = "/tmp/missing-pi-starship-empty-explain.toml";
  registerStarshipCommand(mock.pi, {
    getLoaded: () => loadStarshipConfig(path),
    getInspection: () => ({ modules: INSPECTION.modules, showing: [] }),
    apply() {},
    settingsPath: path,
  });
  const tui = createTuiHarness({ width: 40, rows: 12 });
  const context = createMockContext({ mode: "tui", hasUI: true, custom: tui.custom });
  const running = mock.commands.get("starship")?.handler("", context.ctx);
  await tui.waitForOpen();
  tui.press("tui.select.down");
  tui.press("tui.select.down");
  tui.press("tui.select.confirm");
  await tui.waitForOpen();
  assert.match(tui.render().join("\n"), /No modules are currently showing/u);
  tui.press("ctrl+c");
  await running;
});

test("Modules is searchable, adaptive, terminal-safe, and restores search after detail", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-starship-modules-"));
  const path = join(root, "pi-starship.toml");
  try {
    const mock = createMockPi();
    registerStarshipCommand(mock.pi, {
      getLoaded: () => loadStarshipConfig(path),
      getInspection: () => INSPECTION,
      apply() {},
      settingsPath: path,
    });
    const tui = createTuiHarness({ width: 28, rows: 12 });
    const context = createMockContext({ mode: "tui", hasUI: true, custom: tui.custom });
    const running = mock.commands.get("starship")?.handler("", context.ctx);
    await tui.waitForOpen();
    tui.press("tui.select.down");
    tui.press("tui.select.down");
    tui.press("tui.select.down");
    tui.press("tui.select.confirm");
    await tui.waitForOpen();
    tui.setFocused(true);
    assert.equal(tui.render().join("\n").includes(CURSOR_MARKER), true);
    tui.type("git br");
    let frame = tui.render().join("\n");
    assert.match(frame, /git_branch/u);
    assert.match(frame, /Empty/u);
    assert.doesNotMatch(frame, /◆ claude-sonnet-4|Reported estimated session cost/u);
    assert.equal(frame.includes("\u001b[31m"), false);
    tui.press("tui.select.confirm");
    frame = tui.render().join("\n");
    assert.match(frame, /git_branch/u);
    assert.match(frame, /Status: Empty/u);
    assert.match(frame, /Root: Referenced/u);
    assert.match(frame, /Reachable: Yes/u);
    assert.equal(frame.includes("\u001b[31m"), false);
    tui.press("tui.select.pageDown");
    tui.press("tui.select.pageDown");
    frame = tui.render().join("\n");
    assert.match(frame, /snapshot produced no output/iu);
    assert.match(frame, /Variables:.*branch/u);
    assert.match(frame, /Style fields: style/u);
    for (const dimensions of [
      { width: 20, rows: 8 },
      { width: 80, rows: 24 },
    ]) {
      const resized = tui.resize(dimensions);
      assert.ok(resized.length <= Math.max(1, dimensions.rows - 3));
      assert.ok(resized.every((line) => visibleWidth(line) <= dimensions.width));
    }
    tui.press("tui.select.cancel");
    assert.match(tui.render().join("\n"), /git br/u);
    assert.equal(tui.render().join("\n").includes(CURSOR_MARKER), true);
    tui.send("\u0015");
    tui.type("zzz");
    assert.match(tui.render().join("\n"), /No matching items/u);
    assert.equal(existsSync(path), false);
    tui.press("ctrl+c");
    await running;
    assert.equal(existsSync(path), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Modules searches non-rendered module metadata", async () => {
  const mock = createMockPi();
  const path = "/tmp/missing-pi-starship-module-metadata-search.toml";
  registerStarshipCommand(mock.pi, {
    getLoaded: () => loadStarshipConfig(path),
    getInspection: () => INSPECTION,
    apply() {},
    settingsPath: path,
  });
  const tui = createTuiHarness({ width: 40, rows: 12 });
  const context = createMockContext({ mode: "tui", hasUI: true, custom: tui.custom });
  const running = mock.commands.get("starship")?.handler("", context.ctx);
  await tui.waitForOpen();
  tui.press("tui.select.down");
  tui.press("tui.select.down");
  tui.press("tui.select.down");
  tui.press("tui.select.confirm");
  await tui.waitForOpen();
  tui.setFocused(true);
  tui.type("remote_name");
  const frame = tui.render().join("\n");
  assert.match(frame, /git_branch/u);
  assert.doesNotMatch(frame, /No matching items/u);
  tui.press("ctrl+c");
  await running;
});

test("external module-browser disposal releases the component without writing settings", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-starship-modules-dispose-"));
  const path = join(root, "pi-starship.toml");
  try {
    const mock = createMockPi();
    registerStarshipCommand(mock.pi, {
      getLoaded: () => loadStarshipConfig(path),
      getInspection: () => INSPECTION,
      apply() {},
      settingsPath: path,
    });
    const tui = createTuiHarness({ width: 40, rows: 12 });
    const context = createMockContext({ mode: "tui", hasUI: true, custom: tui.custom });
    const running = Promise.resolve(mock.commands.get("starship")?.handler("", context.ctx));
    await tui.waitForOpen();
    tui.press("tui.select.down");
    tui.press("tui.select.down");
    tui.press("tui.select.down");
    tui.press("tui.select.confirm");
    await tui.waitForOpen();
    tui.dispose();
    await running;
    assert.equal(existsSync(path), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Modules honors injected keybindings and distinguishes Back from Close", async () => {
  const mapping: Record<string, string> = {
    "tui.select.up": "k",
    "tui.select.down": "j",
    "tui.select.pageUp": "u",
    "tui.select.pageDown": "d",
    "tui.select.confirm": "y",
    "tui.select.cancel": "q",
  };
  const keybindings: Pick<KeybindingsManager, "matches" | "getKeys"> = {
    matches: (data, binding) => data === mapping[binding],
    getKeys: (binding) => (mapping[binding] ? [mapping[binding] as never] : []),
  };
  const mock = createMockPi();
  const path = "/tmp/missing-pi-starship-module-keys.toml";
  registerStarshipCommand(mock.pi, {
    getLoaded: () => loadStarshipConfig(path),
    getInspection: () => INSPECTION,
    apply() {},
    settingsPath: path,
  });
  const tui = createTuiHarness({ width: 50, rows: 14, keybindings });
  const context = createMockContext({ mode: "tui", hasUI: true, custom: tui.custom });
  const running = mock.commands.get("starship")?.handler("", context.ctx);
  await tui.waitForOpen();
  tui.send("j");
  tui.send("j");
  tui.send("j");
  tui.send("y");
  await tui.waitForOpen();
  const frame = tui.render().join("\n");
  assert.match(frame, /k\/j navigate/u);
  assert.match(frame, /y details/u);
  assert.match(frame, /q back/u);
  tui.send("j");
  assert.match(tui.render().join("\n"), /git_branch/u);
  tui.send("q");
  await tui.waitForOpen();
  assert.match(tui.render().join("\n"), /→ Modules/u);
  tui.press("ctrl+c");
  await running;
});
