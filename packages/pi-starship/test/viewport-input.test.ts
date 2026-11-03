import assert from "node:assert/strict";
import type { ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import {
  type Component,
  getKeybindings,
  KeybindingsManager,
  type KeyId,
  setKeybindings,
  TUI_KEYBINDINGS,
  TuiAltScreen,
  TuiMainScreen,
} from "@earendil-works/pi-tui";
import { FullscreenTerminal } from "@narumitw/pi-tui-kit/testing";
import { test } from "vitest";
import { createMockContext } from "../../../test/support.js";
import { showConfigurationMenu } from "../src/command-configuration-menu.js";
import { showPreviewActionMenu } from "../src/command-preview.js";
import { nativeFooterConfig } from "../src/config.js";

function nativeMenu(fullscreen: boolean, pageDown: KeyId) {
  const previous = getKeybindings();
  const keys = new KeybindingsManager(TUI_KEYBINDINGS, {
    "tui.altScreen.pageDown": pageDown,
    "tui.select.pageDown": pageDown,
  });
  setKeybindings(keys);
  const terminal = new FullscreenTerminal();
  terminal.rows = 20;
  const host = fullscreen ? new TuiAltScreen(terminal, false) : new TuiMainScreen(terminal, false);
  const theme = {
    fg: (_role: string, text: string) => text,
    bold: (text: string) => text,
  } as Theme;
  let component: (Component & { dispose?(): void }) | undefined;
  let mounted!: () => void;
  const ready = new Promise<void>((resolve) => {
    mounted = resolve;
  });
  const custom: ExtensionCommandContext["ui"]["custom"] = (factory) =>
    new Promise((resolve, reject) => {
      Promise.resolve(factory(host, theme, keys as never, resolve))
        .then((value) => {
          component = value;
          host.addChild(value);
          host.setFocus(value);
          host.start();
          host.renderNow(true);
          mounted();
        })
        .catch(reject);
    });
  const { ctx } = createMockContext({ mode: "tui", hasUI: true, custom });
  return {
    ctx,
    host,
    terminal,
    ready,
    capture: () => component?.capturesViewportInput,
    render: () => component?.render(80).join("\n") ?? "",
    dispose() {
      component?.dispose?.();
      host.stop({ preserveScreen: true });
      setKeybindings(previous);
    },
  };
}

for (const fullscreen of [false, true]) {
  test.each([
    { name: "PageDown", key: "pageDown" as const, data: "\u001b[6~" },
    { name: "Ctrl+V", key: "ctrl+v" as const, data: "\u0016" },
  ])(`native ${fullscreen ? "fullscreen" : "regular"} configuration summary capture: $name`, async ({ key, data }) => {
    const f = nativeMenu(fullscreen, key);
    const loaded = nativeFooterConfig("/settings/pi-starship.toml");
    loaded.diagnostics = Array.from({ length: 30 }, (_, index) => ({
      severity: "warning",
      path: `item-${index}`,
      message: `Warning ${index}`,
    }));
    const running = showConfigurationMenu(
      f.ctx,
      {
        settingsPath: loaded.settingsPath,
        getLoaded: () => loaded,
        apply() {},
      },
      { signal: new AbortController().signal, isCurrent: () => true },
    );
    try {
      await f.ready;
      assert.equal(f.capture(), true);
      assert.match(f.render(), /Summary 1-/u);
      f.terminal.input(data);
      assert.doesNotMatch(f.render(), /Summary 1-/u);
      assert.match(f.render(), /→ Reload from disk/u);
      f.terminal.input("\u001b[5~");
      assert.match(f.render(), /Summary 1-/u);
      f.terminal.input("\u001b[B");
      assert.match(f.render(), /→ Share settings/u);
      f.terminal.input("\u0003");
      assert.deepEqual(await running, { kind: "completed", value: "close" });
    } finally {
      f.dispose();
    }
  });

  test.each([
    { name: "PageDown", key: "pageDown" as const, data: "\u001b[6~" },
    { name: "Ctrl+V", key: "ctrl+v" as const, data: "\u0016" },
  ])(`native ${fullscreen ? "fullscreen" : "regular"} preview capture: $name`, async ({ key, data }) => {
    const f = nativeMenu(fullscreen, key);
    const running = showPreviewActionMenu(
      f.ctx,
      "Preview",
      () => Array.from({ length: 60 }, (_, index) => `Preview line ${index}`),
      [
        { value: "apply", label: "Apply" },
        { value: "discard", label: "Discard" },
      ],
    );
    try {
      await f.ready;
      assert.equal(f.capture(), true);
      assert.match(f.render(), /Preview line 0\n/u);
      f.terminal.input(data);
      assert.doesNotMatch(f.render(), /Preview line 0\n/u);
      assert.match(f.render(), /→ Apply/u);
      f.terminal.input("\u001b[5~");
      assert.match(f.render(), /Preview line 0\n/u);
      f.terminal.input("\u001b[B");
      f.terminal.input("\r");
      assert.deepEqual(await running, { kind: "selected", value: "discard" });
    } finally {
      f.dispose();
    }
  });
}
