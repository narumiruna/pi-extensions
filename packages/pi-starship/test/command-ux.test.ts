import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { KeybindingsManager } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { createTuiHarness } from "@narumitw/pi-tui-kit/testing";
import { test } from "vitest";
import { createMockContext, createMockPi } from "../../../test/support.js";
import { registerStarshipCommand } from "../src/commands.js";
import { BUILT_IN_EXAMPLE, type LoadedStarshipConfig, loadStarshipConfig } from "../src/config.js";
import { STARSHIP_PRESETS } from "../src/presets/catalog.js";

test("/starship distinguishes built-in defaults, saved built-in, custom, and fallback states", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-starship-command-state-"));
  try {
    const cases = [
      {
        name: "missing",
        path: join(root, "missing.toml"),
        expected: /Built-in defaults · Healthy/u,
      },
      {
        name: "saved built-in",
        path: join(root, "built-in.toml"),
        raw: BUILT_IN_EXAMPLE,
        expected: /Saved built-in configuration · Healthy/u,
      },
      {
        name: "custom",
        path: join(root, "custom.toml"),
        raw: "format = 'custom'\n",
        expected: /Custom configuration · Healthy/u,
      },
      {
        name: "invalid",
        path: join(root, "invalid.toml"),
        raw: "format = [\n",
        expected: /Built-in fallback · 1 error/u,
      },
    ] as const;

    for (const item of cases) {
      if ("raw" in item) writeFileSync(item.path, item.raw);
      const mock = createMockPi();
      registerStarshipCommand(mock.pi, {
        getLoaded: () => loadStarshipConfig(item.path),
        apply() {},
        settingsPath: item.path,
      });
      const tui = createTuiHarness({ width: 40, rows: 24 });
      const context = createMockContext({ mode: "tui", hasUI: true, custom: tui.custom });
      const running = mock.commands.get("starship")?.handler("", context.ctx);
      await tui.waitForOpen();
      const frame = tui.render().join("\n");
      assert.match(frame, item.expected, item.name);
      assert.match(frame, /Configuration/u, item.name);
      assert.match(frame, /Restore built-in…/u, item.name);
      assert.doesNotMatch(frame, /Advanced/u, item.name);
      tui.press("ctrl+c");
      await running;
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Presets stays shallow, identifies the exact active document, and restores focus", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-starship-command-presets-"));
  const path = join(root, "pi-starship.toml");
  const minimal = STARSHIP_PRESETS[0];
  assert.ok(minimal);
  writeFileSync(path, minimal.rawDocument);
  try {
    const mock = createMockPi();
    const previewed: Array<string | undefined> = [];
    const commandOptions = {
      getLoaded: () => loadStarshipConfig(path),
      apply() {},
      preview(next: LoadedStarshipConfig | undefined) {
        previewed.push(next && presetForRawDocument(next.rawDocument));
      },
      settingsPath: path,
    };
    registerStarshipCommand(mock.pi, commandOptions);
    const tui = createTuiHarness({ width: 40, rows: 18 });
    const context = createMockContext({ mode: "tui", hasUI: true, custom: tui.custom });
    const running = mock.commands.get("starship")?.handler("", context.ctx);
    await tui.waitForOpen();
    assert.match(tui.render().join("\n"), /Minimal preset · Healthy/u);
    tui.press("tui.select.down");
    assert.match(tui.render().join("\n"), /→ Presets/u);
    tui.press("tui.select.confirm");
    await tui.waitForOpen();
    for (const dimensions of [
      { width: 20, rows: 8 },
      { width: 40, rows: 18 },
      { width: 80, rows: 24 },
    ]) {
      const frame = tui.resize(dimensions);
      assert.ok(frame.every((line) => visibleWidth(line) <= dimensions.width));
    }
    const full = tui.render().join("\n");
    assert.match(full, /Minimal/u);
    assert.match(full, /Bracketed Segments/u);
    assert.match(full, /Catppuccin Powerline/u);
    assert.match(full, /Nerd Font Symbols/u);
    assert.match(full, /Currently applied/u);
    assert.match(full, /Cannot apply: Already applied; press e to customize/u);
    assert.match(full, /\(1\/13\)/u);
    assert.deepEqual(previewed, ["minimal"]);
    tui.press("tui.select.confirm");
    await flushAsyncWork();
    assert.match(tui.render().join("\n"), /Presets · current:/u);
    tui.press("end");
    const lastPreset = tui.render().join("\n");
    assert.match(lastPreset, /Tokyo Night/u);
    assert.match(lastPreset, /requires Nerd Font/u);
    assert.match(lastPreset, /\(13\/13\)/u);
    assert.equal(previewed.at(-1), "tokyo-night");
    tui.press("home");
    assert.equal(previewed.at(-1), "minimal");
    tui.press("tui.select.pageDown");
    assert.equal(previewed.at(-1), "plain-text-symbols");
    tui.press("tui.select.cancel");
    await tui.waitForOpen();
    assert.match(tui.render().join("\n"), /→ Presets/u);
    tui.press("ctrl+c");
    await running;
    assert.equal(readFileSync(path, "utf8"), minimal.rawDocument);
    assert.equal(previewed.at(-1), undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the active preset keeps Customize available while Apply is gated", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-starship-active-preset-customize-"));
  const path = join(root, "pi-starship.toml");
  const minimal = STARSHIP_PRESETS[0];
  assert.ok(minimal);
  writeFileSync(path, minimal.rawDocument);
  try {
    let editorDraft = "";
    const mock = createMockPi();
    registerStarshipCommand(mock.pi, {
      getLoaded: () => loadStarshipConfig(path),
      apply() {
        assert.fail("Cancelling customization must not apply settings");
      },
      settingsPath: path,
    });
    const tui = createTuiHarness({ width: 60, rows: 18 });
    const context = createMockContext({
      mode: "tui",
      hasUI: true,
      custom: tui.custom,
      editor: async (_title: string, draft: string) => {
        editorDraft = draft;
        return undefined;
      },
    });
    const running = mock.commands.get("starship")?.handler("", context.ctx);
    await tui.waitForOpen();
    tui.press("tui.select.down");
    tui.press("tui.select.confirm");
    await tui.waitForOpen();
    tui.press("tui.select.confirm");
    await flushAsyncWork();
    assert.equal(editorDraft, "");
    tui.send("e");
    await tui.waitForOpen();
    assert.equal(editorDraft, minimal.rawDocument);
    assert.match(tui.render().join("\n"), /→ Presets/u);
    tui.press("ctrl+c");
    await running;
    assert.equal(readFileSync(path, "utf8"), minimal.rawDocument);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("live preset preview restores on Ctrl+C and external disposal", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-starship-command-preset-preview-exit-"));
  const path = join(root, "pi-starship.toml");
  try {
    for (const exit of ["close", "dispose"] as const) {
      const mock = createMockPi();
      const previewed: Array<string | undefined> = [];
      const commandOptions = {
        getLoaded: () => loadStarshipConfig(path),
        apply() {
          assert.fail("Browsing presets must not apply settings");
        },
        preview(next: LoadedStarshipConfig | undefined) {
          previewed.push(next && presetForRawDocument(next.rawDocument));
        },
        settingsPath: path,
      };
      registerStarshipCommand(mock.pi, commandOptions);
      const tui = createTuiHarness({ width: 50, rows: 16 });
      const context = createMockContext({ mode: "tui", hasUI: true, custom: tui.custom });
      const running = mock.commands.get("starship")?.handler("", context.ctx);
      await tui.waitForOpen();
      tui.press("tui.select.down");
      tui.press("tui.select.confirm");
      await tui.waitForOpen();
      assert.equal(previewed.at(-1), "minimal");
      if (exit === "close") tui.press("ctrl+c");
      else tui.dispose();
      await running;
      assert.equal(previewed.at(-1), undefined, exit);
      assert.equal(existsSync(path), false, exit);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("preset preview failure closes safely and restores the effective footer", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-starship-preset-preview-failure-"));
  const path = join(root, "pi-starship.toml");
  try {
    const mock = createMockPi();
    registerStarshipCommand(mock.pi, {
      getLoaded: () => loadStarshipConfig(path),
      apply() {
        assert.fail("A failed preview must not apply settings");
      },
      preview(next) {
        if (next) throw new Error("preview exploded");
      },
      settingsPath: path,
    });
    const tui = createTuiHarness({ width: 50, rows: 16 });
    const context = createMockContext({ mode: "tui", hasUI: true, custom: tui.custom });
    const running = mock.commands.get("starship")?.handler("", context.ctx);
    await tui.waitForOpen();
    tui.press("tui.select.down");
    tui.press("tui.select.confirm");
    await running;
    assert.equal(existsSync(path), false);
    assert.match(context.notifications.at(-1)?.message ?? "", /Live choice failed/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("preset preview cancellation is inert and confirmed apply replaces atomically", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-starship-command-preset-apply-"));
  const path = join(root, "pi-starship.toml");
  const original = "format = 'custom'\nfuture = true\n";
  writeFileSync(path, original);
  try {
    const mock = createMockPi();
    let applied = 0;
    let confirmation = "";
    const previewed: Array<string | undefined> = [];
    const commandOptions = {
      getLoaded: () => loadStarshipConfig(path),
      apply() {
        applied += 1;
      },
      preview(next: LoadedStarshipConfig | undefined) {
        previewed.push(next && presetForRawDocument(next.rawDocument));
      },
      settingsPath: path,
      renderPreview: (loaded: LoadedStarshipConfig) => [loaded.config.format],
    };
    registerStarshipCommand(mock.pi, commandOptions);

    const cancelledTui = createTuiHarness({ width: 50, rows: 16 });
    const cancelledContext = createMockContext({
      mode: "tui",
      hasUI: true,
      custom: cancelledTui.custom,
      confirm: async () => false,
    });
    const cancelled = mock.commands.get("starship")?.handler("", cancelledContext.ctx);
    await cancelledTui.waitForOpen();
    cancelledTui.press("tui.select.down");
    cancelledTui.press("tui.select.confirm");
    await cancelledTui.waitForOpen();
    assert.equal(previewed.at(-1), "minimal");
    cancelledTui.press("tui.select.confirm");
    await cancelledTui.waitForOpen();
    assert.equal(readFileSync(path, "utf8"), original);
    assert.equal(applied, 0);
    assert.equal(previewed.at(-1), undefined);
    assert.match(cancelledTui.render().join("\n"), /→ Presets/u);
    cancelledTui.press("ctrl+c");
    await cancelled;
    assert.equal(readFileSync(path, "utf8"), original);
    assert.equal(applied, 0);
    assert.equal(previewed.at(-1), undefined);

    const appliedTui = createTuiHarness({ width: 50, rows: 16 });
    const appliedContext = createMockContext({
      mode: "tui",
      hasUI: true,
      custom: appliedTui.custom,
      confirm: async (_title: string, message: string) => {
        confirmation = message;
        return true;
      },
    });
    const running = mock.commands.get("starship")?.handler("", appliedContext.ctx);
    await appliedTui.waitForOpen();
    appliedTui.press("tui.select.down");
    appliedTui.press("tui.select.confirm");
    await appliedTui.waitForOpen();
    appliedTui.press("tui.select.confirm");
    await running;
    assert.equal(readFileSync(path, "utf8"), STARSHIP_PRESETS[0]?.rawDocument);
    assert.equal(applied, 1);
    assert.match(confirmation, /Minimal/u);
    assert.match(confirmation, /custom settings, unknown fields, and comments will be removed/iu);
    assert.match(confirmation, /No backup is kept after success/u);
    assert.equal(previewed.at(-1), undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("failed direct preset apply clears the preview and preserves the previous footer", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-starship-command-preset-failed-apply-"));
  const path = join(root, "pi-starship.toml");
  const original = "format = 'custom'\n";
  writeFileSync(path, original);
  try {
    const previewed: Array<string | undefined> = [];
    const mock = createMockPi();
    registerStarshipCommand(mock.pi, {
      getLoaded: () => loadStarshipConfig(path),
      apply() {
        assert.fail("Failed save must not apply settings");
      },
      preview(next: LoadedStarshipConfig | undefined) {
        previewed.push(next && presetForRawDocument(next.rawDocument));
      },
      save() {
        throw new Error("publish failed");
      },
      settingsPath: path,
    });
    const tui = createTuiHarness({ width: 50, rows: 16 });
    const context = createMockContext({
      mode: "tui",
      hasUI: true,
      custom: tui.custom,
      confirm: async () => true,
    });
    const running = mock.commands.get("starship")?.handler("", context.ctx);
    await tui.waitForOpen();
    tui.press("tui.select.down");
    tui.press("tui.select.confirm");
    await tui.waitForOpen();
    assert.equal(previewed.at(-1), "minimal");
    tui.press("tui.select.confirm");
    await tui.waitForOpen();
    assert.equal(previewed.at(-1), undefined);
    assert.equal(readFileSync(path, "utf8"), original);
    assert.match(context.notifications.at(-1)?.message ?? "", /publish failed/u);
    assert.match(tui.render().join("\n"), /→ Presets/u);
    tui.press("ctrl+c");
    await running;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Customize before applying starts from the preset and saves the edited document", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-starship-command-preset-customize-"));
  const path = join(root, "pi-starship.toml");
  const bracketed = STARSHIP_PRESETS[1];
  assert.ok(bracketed);
  try {
    const mock = createMockPi();
    let editorDraft = "";
    let applied = 0;
    registerStarshipCommand(mock.pi, {
      getLoaded: () => loadStarshipConfig(path),
      apply() {
        applied += 1;
      },
      settingsPath: path,
      renderPreview: (loaded) => [loaded.config.format],
    });
    const tui = createTuiHarness({ width: 60, rows: 18 });
    const context = createMockContext({
      mode: "tui",
      hasUI: true,
      custom: tui.custom,
      editor: async (_title: string, draft: string) => {
        editorDraft = draft;
        return `${draft}# personalized\n`;
      },
      confirm: async () => true,
    });
    const running = mock.commands.get("starship")?.handler("", context.ctx);
    await tui.waitForOpen();
    tui.press("tui.select.down");
    tui.press("tui.select.confirm");
    await tui.waitForOpen();
    tui.press("tui.select.down");
    tui.send("e");
    await tui.waitForOpen();
    assert.equal(editorDraft, bracketed.rawDocument);
    assert.match(tui.render().join("\n"), /Bracketed Segments preset preview/u);
    tui.press("tui.select.confirm");
    await running;
    assert.equal(readFileSync(path, "utf8"), `${bracketed.rawDocument}# personalized\n`);
    assert.equal(applied, 1);
    assert.match(context.notifications.at(-1)?.message ?? "", /Bracketed Segments preset saved and applied/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an invalid customized preset returns to preset recovery without changing the footer", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-starship-command-preset-invalid-"));
  const path = join(root, "pi-starship.toml");
  try {
    const mock = createMockPi();
    let applied = 0;
    registerStarshipCommand(mock.pi, {
      getLoaded: () => loadStarshipConfig(path),
      apply() {
        applied += 1;
      },
      settingsPath: path,
    });
    const tui = createTuiHarness({ width: 50, rows: 16 });
    const context = createMockContext({
      mode: "tui",
      hasUI: true,
      custom: tui.custom,
      editor: async () => "format = [",
    });
    const running = mock.commands.get("starship")?.handler("", context.ctx);
    await tui.waitForOpen();
    tui.press("tui.select.down");
    tui.press("tui.select.confirm");
    await tui.waitForOpen();
    tui.send("e");
    await tui.waitForOpen();
    const errorFrame = tui.render().join("\n");
    assert.match(errorFrame, /Preset needs attention/u);
    assert.match(errorFrame, /Continue editing/u);
    assert.match(errorFrame, /Choose another preset/u);
    assert.match(context.notifications.at(-1)?.message ?? "", /Preset draft is invalid/u);
    tui.press("tui.select.cancel");
    await tui.waitForOpen();
    assert.match(tui.render().join("\n"), /Presets/u);
    tui.press("ctrl+c");
    await running;
    assert.equal(existsSync(path), false);
    assert.equal(applied, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Configuration combines state, source, path, health, and diagnostics", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-starship-command-configuration-"));
  const path = join(root, "pi-starship.toml");
  writeFileSync(path, "future = true\n");
  try {
    const mock = createMockPi();
    registerStarshipCommand(mock.pi, {
      getLoaded: () => loadStarshipConfig(path),
      apply() {},
      settingsPath: path,
    });
    const tui = createTuiHarness({ width: 80, rows: 24 });
    const context = createMockContext({ mode: "tui", hasUI: true, custom: tui.custom });
    const running = mock.commands.get("starship")?.handler("", context.ctx);
    await tui.waitForOpen();
    for (let index = 0; index < 4; index += 1) tui.press("tui.select.down");
    tui.press("tui.select.confirm");
    await tui.waitForOpen();
    tui.press("tui.select.confirm");
    await tui.waitForOpen();
    const frame = tui.render().join("\n");
    assert.match(frame, /Configuration/u);
    assert.match(frame, /State: Custom configuration/u);
    assert.match(frame, /Source: User file/u);
    assert.match(frame, /Path:[\s\S]*pi-starship\.toml/u);
    assert.match(frame, /Health: 1 warning/u);
    assert.match(frame, /future/u);
    tui.press("ctrl+c");
    await running;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("healthy missing settings disable restore without creating a document", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-starship-command-missing-restore-"));
  const path = join(root, "pi-starship.toml");
  try {
    const mock = createMockPi();
    let confirmations = 0;
    registerStarshipCommand(mock.pi, {
      getLoaded: () => loadStarshipConfig(path),
      apply() {},
      settingsPath: path,
    });
    const tui = createTuiHarness({ width: 80, rows: 24 });
    const context = createMockContext({
      mode: "tui",
      hasUI: true,
      custom: tui.custom,
      confirm: async () => {
        confirmations += 1;
        return true;
      },
    });
    const running = mock.commands.get("starship")?.handler("", context.ctx);
    await tui.waitForOpen();
    for (let index = 0; index < 6; index += 1) tui.press("tui.select.down");
    tui.press("tui.select.confirm");
    await tui.waitForOpen();
    assert.match(tui.render().join("\n"), /Already using defaults · no file to replace/u);
    assert.equal(confirmations, 0);
    assert.equal(existsSync(path), false);
    tui.press("ctrl+c");
    await running;
    assert.equal(existsSync(path), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("preview remains operable across terminal sizes and dynamic resize", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-starship-command-preview-size-"));
  const path = join(root, "pi-starship.toml");
  try {
    const mock = createMockPi();
    const loaded = loadStarshipConfig(path);
    registerStarshipCommand(mock.pi, {
      getLoaded: () => loaded,
      apply() {},
      settingsPath: path,
      renderPreview: () => Array.from({ length: 40 }, (_, index) => `Preview line ${index + 1}: long content`),
    });
    const tui = createTuiHarness({ width: 80, rows: 24 });
    const context = createMockContext({
      mode: "tui",
      hasUI: true,
      custom: tui.custom,
      editor: async () => "format = 'draft'\n",
    });
    const running = mock.commands.get("starship")?.handler("settings", context.ctx);
    await tui.waitForOpen();

    for (const dimensions of [
      { width: 80, rows: 24 },
      { width: 20, rows: 8 },
      { width: 28, rows: 12 },
    ]) {
      const frame = tui.resize(dimensions);
      assert.ok(frame.length <= Math.max(1, dimensions.rows - 3));
      assert.ok(frame.every((line) => visibleWidth(line) <= dimensions.width));
      assert.match(frame.join("\n"), /Apply changes…/u);
    }

    tui.press("tui.select.down");
    assert.match(tui.render().join("\n"), /Continue editing/u);
    tui.press("tui.select.down");
    assert.match(tui.render().join("\n"), /Discard draft/u);
    tui.press("ctrl+c");
    await running;
    assert.equal(existsSync(path), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("preset picker uses injected navigation bindings and exposes their hints", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-starship-preset-picker-keys-"));
  const path = join(root, "pi-starship.toml");
  try {
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
    const previewed: Array<string | undefined> = [];
    const mock = createMockPi();
    const commandOptions = {
      getLoaded: () => loadStarshipConfig(path),
      apply() {},
      preview(next: LoadedStarshipConfig | undefined) {
        previewed.push(next && presetForRawDocument(next.rawDocument));
      },
      settingsPath: path,
    };
    registerStarshipCommand(mock.pi, commandOptions);
    const tui = createTuiHarness({ width: 50, rows: 16, keybindings });
    const context = createMockContext({ mode: "tui", hasUI: true, custom: tui.custom });
    const running = mock.commands.get("starship")?.handler("", context.ctx);
    await tui.waitForOpen();
    tui.send("j");
    tui.send("y");
    await tui.waitForOpen();
    const frame = tui.render().join("\n");
    assert.match(frame, /k\/j live preview/u);
    assert.match(frame, /y apply/u);
    assert.match(frame, /q\s+back/u);
    tui.send("j");
    assert.equal(previewed.at(-1), "bracketed-segments");
    tui.send("q");
    await tui.waitForOpen();
    assert.equal(previewed.at(-1), undefined);
    tui.press("ctrl+c");
    await running;
    assert.equal(existsSync(path), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("preview uses injected keybindings and exposes their hints", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-starship-command-preview-keys-"));
  const path = join(root, "pi-starship.toml");
  try {
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
    const loaded = loadStarshipConfig(path);
    registerStarshipCommand(mock.pi, {
      getLoaded: () => loaded,
      apply() {},
      settingsPath: path,
      renderPreview: () => ["Preview"],
    });
    const tui = createTuiHarness({ width: 40, rows: 12, keybindings });
    const context = createMockContext({
      mode: "tui",
      hasUI: true,
      custom: tui.custom,
      editor: async () => "format = 'draft'\n",
    });
    let settled = false;
    const running = Promise.resolve(mock.commands.get("starship")?.handler("settings", context.ctx));
    void running.then(() => {
      settled = true;
    });
    await tui.waitForOpen();
    const frame = tui.render().join("\n");
    assert.match(frame, /k\/j navigate/u);
    assert.match(frame, /y select/u);
    assert.match(frame, /q discard/u);
    tui.send("j");
    assert.match(tui.render().join("\n"), /Continue editing/u);
    tui.send("q");
    await flushAsyncWork();
    try {
      assert.equal(settled, true);
    } finally {
      if (!settled) tui.dispose();
      await running;
    }
    assert.equal(existsSync(path), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Escape returns a preview draft to editing and restores the main selection", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-starship-command-preview-edit-"));
  const path = join(root, "pi-starship.toml");
  try {
    const mock = createMockPi();
    const loaded = loadStarshipConfig(path);
    let editorCalls = 0;
    const drafts: string[] = [];
    registerStarshipCommand(mock.pi, {
      getLoaded: () => loaded,
      apply() {},
      settingsPath: path,
      renderPreview: () => ["Preview"],
    });
    const tui = createTuiHarness({ width: 40, rows: 12 });
    const context = createMockContext({
      mode: "tui",
      hasUI: true,
      custom: tui.custom,
      editor: async (_title: string, draft: string) => {
        drafts.push(draft);
        editorCalls += 1;
        return editorCalls === 1 ? "format = 'draft'\n" : undefined;
      },
    });
    const running = mock.commands.get("starship")?.handler("", context.ctx);
    await tui.waitForOpen();
    tui.press("tui.select.confirm");
    await tui.waitForOpen();
    tui.press("tui.select.down");
    tui.press("tui.select.confirm");
    await tui.waitForOpen();
    assert.equal(editorCalls, 2);
    assert.equal(drafts[1], "format = 'draft'\n");
    assert.match(tui.render().join("\n"), /→ Customize footer/u);
    tui.press("ctrl+c");
    await running;
    assert.equal(existsSync(path), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Ctrl+C in preview closes the whole /starship workflow", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-starship-command-preview-close-"));
  const path = join(root, "pi-starship.toml");
  try {
    const mock = createMockPi();
    const loaded = loadStarshipConfig(path);
    registerStarshipCommand(mock.pi, {
      getLoaded: () => loaded,
      apply() {},
      settingsPath: path,
      renderPreview: () => ["Preview"],
    });
    const tui = createTuiHarness({ width: 40, rows: 12 });
    const context = createMockContext({
      mode: "tui",
      hasUI: true,
      custom: tui.custom,
      editor: async () => "format = 'draft'\n",
    });
    let settled = false;
    const running = Promise.resolve(mock.commands.get("starship")?.handler("", context.ctx));
    void running.then(() => {
      settled = true;
    });
    await tui.waitForOpen();
    tui.press("tui.select.confirm");
    await tui.waitForOpen();
    tui.press("ctrl+c");
    await flushAsyncWork();
    try {
      assert.equal(settled, true);
      assert.equal(tui.isOpen, false);
    } finally {
      if (!settled) tui.dispose();
      await running;
    }
    assert.equal(existsSync(path), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("external preview disposal cancels without saving", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-starship-command-preview-dispose-"));
  const path = join(root, "pi-starship.toml");
  try {
    const mock = createMockPi();
    const loaded = loadStarshipConfig(path);
    registerStarshipCommand(mock.pi, {
      getLoaded: () => loaded,
      apply() {},
      settingsPath: path,
      renderPreview: () => ["Preview"],
    });
    const tui = createTuiHarness({ width: 40, rows: 12 });
    const context = createMockContext({
      mode: "tui",
      hasUI: true,
      custom: tui.custom,
      editor: async () => "format = 'draft'\n",
    });
    const running = mock.commands.get("starship")?.handler("settings", context.ctx);
    await tui.waitForOpen();
    tui.dispose();
    await running;
    assert.equal(existsSync(path), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function presetForRawDocument(rawDocument: string | undefined): string | undefined {
  return STARSHIP_PRESETS.find((preset) => preset.rawDocument === rawDocument)?.id;
}

async function flushAsyncWork() {
  await new Promise<void>((resolve) => setImmediate(resolve));
}
