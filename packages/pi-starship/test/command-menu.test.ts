import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { initTheme } from "@earendil-works/pi-coding-agent";
import {
  isKittyProtocolActive,
  KeybindingsManager,
  type KeyId,
  setKittyProtocolActive,
  TUI_KEYBINDINGS,
  visibleWidth,
} from "@earendil-works/pi-tui";
import { createTuiHarness } from "@narumitw/pi-tui-kit/testing";
import { test } from "vitest";
import { createMockContext, createMockPi } from "../../../test/support.js";
import { configurationMenuScreen } from "../src/command-configuration.js";
import { showConfigurationMenu } from "../src/command-configuration-menu.js";
import { registerStarshipCommand } from "../src/commands.js";
import { BUILT_IN_EXAMPLE, loadStarshipConfig } from "../src/config.js";
import { STARSHIP_PRESETS } from "../src/presets/catalog.js";

initTheme("dark", false);

test("main menu has exactly six ordered actions and no duplicate editor or inspection routes", async () => {
  const mock = createMockPi();
  const path = "/tmp/pi-starship-menu-absent.toml";
  registerStarshipCommand(mock.pi, { settingsPath: path, getLoaded: () => loadStarshipConfig(path), apply() {} });
  const tui = createTuiHarness({ width: 120, rows: 30 });
  const ctx = createMockContext({ mode: "tui", hasUI: true, custom: tui.custom });
  try {
    const running = mock.commands.get("starship")?.handler("", ctx.ctx);
    await tui.waitForOpen();
    const text = stripVTControlCharacters(tui.render().join("\n"));
    const labels = ["Configure with agent", "Presets", "Profiles", "Configuration", "Restore built-in…", "Help"];
    const actionRows = text.split("\n").filter((line) => /^(?:→ | {2})\S/u.test(line));
    assert.equal(actionRows.length, labels.length);
    const positions = labels.map((label) => text.indexOf(label));
    assert.ok(positions.every((position, index) => position >= 0 && (index === 0 || position > positions[index - 1])));
    assert.match(text, /edits, module questions, and footer explanations/u);
    assert.doesNotMatch(text, /Customize footer|Explain footer|Modules|Advanced|Configure with agent…/u);
    tui.press("ctrl+c");
    await running;
  } finally {
    tui.dispose();
  }
});

test("Configuration summary covers every source and health class without creating missing settings", () => {
  const root = mkdtempSync(join(tmpdir(), "starship-menu-states-"));
  const path = join(root, "missing", "pi-starship.toml");
  const defaults = loadStarshipConfig(path);
  try {
    const cases = [
      { loaded: defaults, state: "Pi native footer", source: "No settings file", health: "Healthy" },
      {
        loaded: { ...defaults, source: "user" as const, rawDocument: BUILT_IN_EXAMPLE },
        state: "Saved built-in configuration",
        source: "User file",
        health: "Healthy",
      },
      {
        loaded: { ...defaults, source: "user" as const, rawDocument: STARSHIP_PRESETS[0]?.rawDocument },
        state: "preset",
        source: "Bundled preset",
        health: "Healthy",
      },
      {
        loaded: { ...defaults, source: "user" as const, rawDocument: "format = '$model'\n" },
        state: "Custom configuration",
        source: "User file",
        health: "Healthy",
      },
      {
        loaded: {
          ...defaults,
          source: "user" as const,
          rawDocument: "format = '$model'\n",
          diagnostics: [{ severity: "warning" as const, path: "model", message: "Warning text" }],
        },
        state: "Custom configuration",
        source: "User file",
        health: "1 warning",
      },
      {
        loaded: {
          ...defaults,
          rawDocument: "format = [",
          diagnostics: [{ severity: "error" as const, path: "root", message: "Invalid TOML" }],
        },
        state: "Built-in fallback",
        source: "Built-in fallback",
        health: "1 error",
      },
      {
        loaded: {
          ...defaults,
          diagnostics: [{ severity: "error" as const, path: "root", message: "Unable to read settings" }],
        },
        state: "Built-in fallback",
        source: "Built-in fallback",
        health: "1 error",
      },
    ];
    for (const item of cases) {
      const text = configurationMenuScreen(item.loaded, path).lines.join("\n");
      assert.ok(text.includes(item.state));
      assert.ok(text.includes(`Source: ${item.source}`));
      assert.ok(text.includes(`Health: ${item.health}`));
      assert.ok(text.includes(`Path: ${path}`));
      for (const diagnostic of item.loaded.diagnostics) assert.ok(text.includes(diagnostic.message));
    }
    assert.equal(existsSync(join(root, "missing")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Configuration scrolls all warnings, keeps action focus, sanitizes text, and clamps resize", async () => {
  const root = mkdtempSync(join(tmpdir(), "starship-summary-scroll-"));
  const path = join(root, "settings.toml");
  writeFileSync(path, "format = '$model'\n");
  const loaded = loadStarshipConfig(path);
  loaded.diagnostics = Array.from({ length: 35 }, (_, index) => ({
    severity: "warning",
    path: `module-${index}`,
    message: `Warning-${index} \u001b[31mred\u001b[0m\u202esafe 中文`,
  }));
  const original = JSON.stringify(loaded);
  const themeRoles = new Set<string>();
  let zeroWidth: string[] = [];
  const tui = createTuiHarness({
    theme: {
      fg(role, text) {
        themeRoles.add(role);
        return text;
      },
      bold: (text) => text,
    },
    width: 100,
    rows: 24,
    keybindings: new KeybindingsManager(TUI_KEYBINDINGS, {
      "tui.select.down": "j",
      "tui.select.up": "k",
      "tui.select.pageDown": "ctrl+n",
      "tui.select.pageUp": "ctrl+p",
    }),
  });
  const custom: typeof tui.custom = (factory, options) =>
    tui.custom(async (...args) => {
      const component = await factory(...args);
      zeroWidth = component.render(0);
      return component;
    }, options);
  const ctx = createMockContext({ mode: "tui", hasUI: true, custom });
  const controller = new AbortController();
  try {
    const running = showConfigurationMenu(
      ctx.ctx,
      { settingsPath: `${path}\u001b]8;;bad\u0007label`, getLoaded: () => loaded, apply() {} },
      { signal: controller.signal, isCurrent: () => !controller.signal.aborted },
    );
    await tui.waitForOpen();
    assert.ok(zeroWidth.every((line) => visibleWidth(line) === 0));
    let all = "";
    for (let index = 0; index < 45; index++) {
      const frame = tui.render();
      const text = stripVTControlCharacters(frame.join("\n"));
      all += text;
      assert.match(text, /→ Reload from disk/u);
      assert.doesNotMatch(text, /\u202e|\[31m|\]8;;/u);
      tui.send("\x0e");
    }
    for (let index = 0; index < 35; index++) assert.ok(all.includes(`Warning-${index} `));
    tui.send("j");
    for (const dimensions of [
      { width: 1, rows: 3 },
      { width: 1, rows: 7 },
      { width: 18, rows: 9 },
      { width: 60, rows: 20 },
    ]) {
      const frame = tui.resize(dimensions);
      assert.ok(frame.length <= Math.max(1, dimensions.rows - 3));
      assert.ok(frame.every((line) => visibleWidth(line) <= dimensions.width));
    }
    assert.match(tui.render().join("\n"), /→ Share settings/u);
    tui.press("tui.select.cancel");
    assert.deepEqual(await running, { kind: "completed", value: "back" });
    assert.equal(JSON.stringify(loaded), original);
    for (const role of ["border", "muted", "accent"]) assert.ok(themeRoles.has(role));
  } finally {
    controller.abort();
    tui.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});

for (const rows of [24, 9]) {
  test(`Configuration pointer routing uses visible frame rows at height ${rows}`, async () => {
    const path = "/tmp/starship-pointer-summary-absent.toml";
    const loaded = loadStarshipConfig(path);
    loaded.diagnostics = Array.from({ length: 30 }, (_, index) => ({
      severity: "warning",
      path: "model",
      message: `Warning ${index}`,
    }));
    const tui = createTuiHarness({ width: 100, rows });
    const ctx = createMockContext({ mode: "tui", hasUI: true, custom: tui.custom });
    const controller = new AbortController();
    const running = showConfigurationMenu(
      ctx.ctx,
      { settingsPath: path, getLoaded: () => loaded, apply() {} },
      { signal: controller.signal, isCurrent: () => !controller.signal.aborted },
    );
    try {
      await tui.waitForOpen();
      let frame = tui.render();
      if (rows === 24) {
        const summaryRow = frame.findIndex((line) => line.startsWith("State:"));
        assert.ok(summaryRow >= 0);
        tui.mouse({ type: "wheel", x: 2, y: summaryRow, wheelDelta: 1 });
        frame = tui.render();
        assert.match(frame.join("\n"), /Summary 11-/u);
      }
      const selectedRow = frame.findIndex((line) => line.startsWith("→ Reload"));
      assert.ok(selectedRow >= 0);
      tui.mouse({ type: "press", x: 3, y: selectedRow });
      tui.mouse({ type: "click", x: 3, y: selectedRow });
      assert.deepEqual(await running, { kind: "completed", value: "configuration-reload" });
    } finally {
      controller.abort();
      tui.dispose();
      await running;
    }
  });
}

test("Configuration preserves Home/End, cancellation priority, and narrow Gist warnings", async () => {
  const path = "/tmp/starship-config-navigation-absent.toml";
  const keys = new KeybindingsManager(TUI_KEYBINDINGS, { "tui.select.cancel": "ctrl+m" });
  const tui = createTuiHarness({ width: 42, rows: 26, keybindings: keys });
  const ctx = createMockContext({ mode: "tui", hasUI: true, custom: tui.custom });
  const controller = new AbortController();
  const running = showConfigurationMenu(
    ctx.ctx,
    { settingsPath: path, getLoaded: () => loadStarshipConfig(path), apply() {} },
    { signal: controller.signal, isCurrent: () => !controller.signal.aborted },
  );
  try {
    await tui.waitForOpen();
    tui.press("end");
    assert.match(tui.render().join("\n"), /→ History/u);
    tui.press("home");
    assert.match(tui.render().join("\n"), /→ Reload from disk/u);
    tui.press("tui.select.down");
    assert.match(tui.render().join(""), /unlisted, not private/u);
    assert.match(tui.render().join(""), /requires gh/u);
    tui.press("tui.select.confirm");
    // Legacy Ctrl+M collides with Enter: cancellation must win, as in Kit action screens.
    assert.deepEqual(await running, { kind: "completed", value: "back" });
  } finally {
    controller.abort();
    tui.dispose();
    await running;
  }
});

const scrollCases = [
  { label: "page-key alias", key: "PAGEDOWN", input: "\x1b[6~", scrolls: true },
  { label: "modifier order", key: "ctrl+shift+p", input: "\x1b[112;6u", scrolls: true },
  { label: "reversed modifier order", key: "shift+ctrl+p", input: "\x1b[112;6u", scrolls: true },
  { label: "first usable configured alternative", key: ["ctrl+escape", "ctrl+n"], input: "\x0e", scrolls: true },
  { label: "invalid key", key: "not-a-key", input: "\x0e", scrolls: false },
  { label: "legacy ctrl+i alias", key: "ctrl+i", input: "\t", scrolls: true, kitty: false },
  { label: "Kitty retains raw ctrl+i alias", key: "ctrl+i", input: "\t", scrolls: true, kitty: true },
  { label: "legacy alt+n", key: "alt+n", input: "\x1bn", scrolls: true, kitty: false },
  { label: "Kitty rejects legacy alt+n", key: "alt+n", input: "\x1bn", scrolls: false, kitty: true },
  { label: "selection wins collision", key: "down", input: "\x1b[B", scrolls: false },
  { label: "return alias keeps confirmation priority", key: "return", input: "\r", completes: "configuration-reload" },
  { label: "esc alias keeps cancellation priority", key: "esc", input: "\x1b", completes: "back" },
];
for (const item of scrollCases) {
  test(`Configuration summary key: ${item.label}`, async () => {
    const previousKitty = isKittyProtocolActive();
    setKittyProtocolActive(item.kitty ?? false);
    const path = "/tmp/starship-key-summary-absent.toml";
    const loaded = loadStarshipConfig(path);
    loaded.diagnostics = Array.from({ length: 40 }, (_, index) => ({
      severity: "warning",
      path: "model",
      message: `Warning ${index}`,
    }));
    const keys = new KeybindingsManager(TUI_KEYBINDINGS, { "tui.select.pageDown": item.key as KeyId | KeyId[] });
    const tui = createTuiHarness({ width: 100, rows: 24, keybindings: keys });
    const ctx = createMockContext({ mode: "tui", hasUI: true, custom: tui.custom });
    const controller = new AbortController();
    const running = showConfigurationMenu(
      ctx.ctx,
      { settingsPath: path, getLoaded: () => loaded, apply() {} },
      { signal: controller.signal, isCurrent: () => !controller.signal.aborted },
    );
    try {
      await tui.waitForOpen();
      const before = /Summary (\d+)-/u.exec(tui.render().join("\n"))?.[1];
      tui.send(item.input);
      if (item.completes) assert.deepEqual(await running, { kind: "completed", value: item.completes });
      else {
        const after = /Summary (\d+)-/u.exec(tui.render().join("\n"))?.[1];
        assert.equal(after !== before, item.scrolls);
        tui.press("ctrl+c");
        await running;
      }
    } finally {
      controller.abort();
      tui.dispose();
      await running;
      setKittyProtocolActive(previousKitty);
    }
  });
}

for (const mode of ["rpc", "print", "json"] as const) {
  test(`Configuration summary does not enter custom UI in ${mode} mode`, async () => {
    const path = "/tmp/starship-nontui-summary-absent.toml";
    const ctx = createMockContext({
      mode,
      hasUI: mode === "rpc",
      custom() {
        assert.fail("TUI-only summary");
      },
    });
    const result = await showConfigurationMenu(
      ctx.ctx,
      {
        settingsPath: path,
        getLoaded: () => loadStarshipConfig(path),
        apply() {
          assert.fail();
        },
      },
      { signal: new AbortController().signal, isCurrent: () => true },
    );
    assert.deepEqual(result, { kind: "unsupported", mode });
    assert.deepEqual(ctx.notifications, []);
  });
}

for (const ending of ["abort", "dispose", "ctrl+c"] as const) {
  test(`Configuration ${ending} releases the screen without applying settings`, async () => {
    const path = "/tmp/starship-config-abort-missing.toml";
    const controller = new AbortController();
    const tui = createTuiHarness();
    const ctx = createMockContext({ mode: "tui", hasUI: true, custom: tui.custom });
    try {
      const running = showConfigurationMenu(
        ctx.ctx,
        {
          settingsPath: path,
          getLoaded: () => loadStarshipConfig(path),
          apply() {
            assert.fail("Read-only summary must not apply");
          },
        },
        { signal: controller.signal, isCurrent: () => !controller.signal.aborted },
      );
      await tui.waitForOpen();
      if (ending === "abort") controller.abort();
      else if (ending === "dispose") tui.dispose();
      else tui.press("ctrl+c");
      const result = await running;
      assert.equal(result.kind, ending === "ctrl+c" ? "completed" : "stale");
      assert.equal(tui.isOpen, false);
    } finally {
      controller.abort();
      tui.dispose();
    }
  });
}
