import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import { type ExtensionCommandContext, ExtensionInputComponent, initTheme } from "@earendil-works/pi-coding-agent";
import {
  type Component,
  getKeybindings,
  type KeybindingsConfig,
  KeybindingsManager,
  setKeybindings,
  setKittyProtocolActive,
  TUI_KEYBINDINGS,
  visibleWidth,
} from "@earendil-works/pi-tui";
import { createTuiHarness } from "@narumitw/pi-tui-kit/testing";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { IllustrateMenuOwner } from "../src/menu.js";
import { defaultSettings, type IllustrateSettings } from "../src/settings.js";
import { showIllustrateSettings } from "../src/settings-screen.js";

const originalKeys = getKeybindings();
beforeAll(() => initTheme("dark", false));
afterEach(() => {
  setKeybindings(originalKeys);
  setKittyProtocolActive(false);
});

function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

function fixture(options: { rows?: number; config?: KeybindingsConfig } = {}) {
  const keybindings = new KeybindingsManager(TUI_KEYBINDINGS, options.config);
  setKeybindings(keybindings);
  const roles: string[] = [];
  const tui = createTuiHarness({
    rows: options.rows,
    keybindings,
    theme: {
      fg: (role, text) => {
        roles.push(role);
        return text;
      },
      bold: (text) => text,
    },
  });
  const controller = new AbortController();
  let active = true;
  let settings = defaultSettings();
  const listeners = new Set<(data: string) => { consume?: boolean } | undefined>();
  const inputs: ExtensionInputComponent[] = [];
  const saveSettings = vi.fn(async (patch: Partial<IllustrateSettings>) => {
    settings = { ...settings, ...patch };
  });
  const owner: IllustrateMenuOwner = {
    signal: controller.signal,
    isCurrent: () => active,
    getSettings: () => ({ ...settings }),
    settingsPath: "/agent/\x1b]0;unsafe\x07pi-illustrate.json\nfile",
    saveSettings,
    getStatus: () => [],
  };
  const input = vi.fn<ExtensionCommandContext["ui"]["input"]>((title, placeholder, opts) =>
    tui.custom<string | undefined>((_tui, _theme, _keys, done) => {
      const component = new ExtensionInputComponent(title, placeholder, done, () => done(undefined));
      inputs.push(component);
      const abort = () => done(undefined);
      opts?.signal?.addEventListener("abort", abort, { once: true });
      const dispose = component.dispose.bind(component);
      component.dispose = () => {
        opts?.signal?.removeEventListener("abort", abort);
        dispose();
      };
      return component;
    }),
  );
  const notify = vi.fn();
  const ctx = {
    mode: "tui",
    hasUI: true,
    ui: {
      custom: tui.custom,
      notify,
      input,
      onTerminalInput: (listener: Parameters<ExtensionCommandContext["ui"]["onTerminalInput"]>[0]) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
  } as unknown as ExtensionCommandContext;
  const send = (data: string) => {
    for (const listener of listeners) if (listener(data)?.consume) return;
    tui.send(data);
  };
  return {
    tui,
    ctx,
    owner,
    notify,
    saveSettings,
    roles,
    controller,
    inputs,
    input,
    listeners,
    send,
    replace: () => {
      active = false;
      controller.abort();
    },
    get settings() {
      return settings;
    },
  };
}

async function openNumeric(f: ReturnType<typeof fixture>) {
  f.tui.press("tui.select.confirm");
  f.tui.press("tui.select.down");
  f.tui.press("tui.select.confirm");
  await f.tui.waitForOpen();
}

function plain(lines: readonly string[]) {
  return lines.map(stripVTControlCharacters);
}

describe("native Illustrate settings", () => {
  it("keeps published mouse geometry across press, release, and click before another render", async () => {
    const f = fixture();
    let mounted: Component | undefined;
    const custom = f.ctx.ui.custom;
    f.ctx.ui.custom = (factory, options) =>
      custom(async (...args) => {
        const component = await factory(...args);
        mounted = component;
        return component;
      }, options);
    const running = showIllustrateSettings(f.ctx, f.owner);
    await f.tui.waitForOpen();
    const frame = plain(f.tui.render());
    const y = frame.findIndex((line) => line.includes("Mermaid appearance"));
    assert.ok(y >= 0 && mounted?.handleMouse);
    const event = {
      button: "left" as const,
      shift: false,
      alt: false,
      ctrl: false,
      x: 2,
      y,
      screenX: 2,
      screenY: y,
      width: 80,
      height: frame.length,
    };
    mounted.handleMouse({ ...event, type: "press" });
    mounted.handleMouse({ ...event, type: "release" });
    mounted.handleMouse({ ...event, type: "click" });
    await f.tui.waitForPending();
    f.tui.press("ctrl+c");
    await expect(running).resolves.toBe("close");
    expect(f.saveSettings).toHaveBeenCalledExactlyOnceWith({ mermaidAppearance: "dark" });
  });
  it("shows the user path, effective values, immediate-save behavior, and callback frame roles", async () => {
    const f = fixture();
    const running = showIllustrateSettings(f.ctx, f.owner);
    await f.tui.waitForOpen();
    const raw = f.tui.render(100);
    expect(raw.join("\n")).not.toContain("\x1b]0;unsafe");
    const lines = plain(raw);
    expect(lines[0]).toBe("─".repeat(100));
    expect(lines.at(-1)).toBe("─".repeat(100));
    expect(lines.join("\n")).toContain("Default width");
    expect(lines.join("\n")).toContain("Mermaid appearance");
    expect(lines.join("\n")).toContain("auto");
    expect(lines.join("\n")).toContain("Changes save immediately");
    expect(lines.join("\n")).toContain("/agent/pi-illustrate.json file");
    expect(lines.join("\n")).not.toContain("unsafe");
    expect(lines.join("\n")).not.toContain("sendToModel");
    expect(f.roles).toContain("border");
    expect(f.roles).toContain("muted");
    expect(f.owner.settingsPath).toContain("\x1b");
    f.tui.press("tui.select.cancel");
    expect(await running).toBe("back");
    expect(f.saveSettings).not.toHaveBeenCalled();
  });

  it("keeps the active row in normal, narrow, zero-width, and constrained frames after resize and invalidation", async () => {
    const f = fixture();
    const running = showIllustrateSettings(f.ctx, f.owner);
    await f.tui.waitForOpen();
    f.tui.press("tui.select.down");
    for (const rows of [24, 12, 8, 7, 4]) {
      f.tui.resize({ rows });
      for (const width of [80, 20, 1]) {
        const lines = f.tui.render(width);
        expect(lines.length).toBeLessThanOrEqual(Math.max(1, rows - 3));
        expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
        if (width > 1) expect(plain(lines).some((line) => line.startsWith("→"))).toBe(true);
        expect(plain(lines).filter((line) => /^─+$/.test(line)).length).toBe(rows - 3 >= 5 ? 2 : 0);
      }
    }
    const before = f.roles.length;
    f.tui.invalidate();
    f.tui.render(80);
    expect(f.roles.length).toBeGreaterThan(before);
    f.tui.press("ctrl+c");
    expect(await running).toBe("close");
  });

  it("bounds zero and non-finite widths at the actual custom component boundary", async () => {
    const f = fixture();
    const evidence: string[][] = [];
    const custom = f.ctx.ui.custom;
    f.ctx.ui.custom = (factory, options) =>
      custom(async (...args) => {
        const component = await factory(...args);
        evidence.push(component.render(0), component.render(NaN));
        return component;
      }, options);
    const running = showIllustrateSettings(f.ctx, f.owner);
    await f.tui.waitForOpen();
    f.tui.press("ctrl+c");
    await running;
    expect(evidence).toHaveLength(2);
    expect(evidence.flat().every((line) => line === "")).toBe(true);
  });

  it("saves enum changes immediately in action order without reopening the native list", async () => {
    const f = fixture();
    const entered = gate();
    const release = gate();
    let call = 0;
    f.saveSettings.mockImplementation(async (patch) => {
      if (++call === 1) {
        entered.release();
        await release.promise;
      }
      Object.assign(f.settings, patch);
    });
    const running = showIllustrateSettings(f.ctx, f.owner);
    await f.tui.waitForOpen();
    f.tui.press("tui.select.down");
    f.tui.press("tui.select.confirm");
    f.tui.press("tui.select.confirm");
    await entered.promise;
    expect(f.saveSettings).toHaveBeenCalledTimes(1);
    expect(plain(f.tui.render()).join("\n")).toContain("light");
    release.release();
    await f.tui.waitForPending();
    expect(f.saveSettings.mock.calls.map(([patch]) => patch)).toEqual([
      { mermaidAppearance: "dark" },
      { mermaidAppearance: "light" },
    ]);
    expect(f.settings.mermaidAppearance).toBe("light");
    expect(f.tui.openCount).toBe(1);
    f.tui.press("tui.select.cancel");
    expect(await running).toBe("back");
    expect(f.settings.mermaidAppearance).toBe("light");
  });

  it("restores the accepted displayed value after failure and keeps the save queue usable", async () => {
    const f = fixture();
    f.saveSettings.mockRejectedValueOnce(new Error("disk\x1b[2Jfailed"));
    const running = showIllustrateSettings(f.ctx, f.owner);
    await f.tui.waitForOpen();
    f.tui.press("tui.select.down");
    f.tui.press("tui.select.confirm");
    await f.tui.waitForPending();
    expect(f.settings.mermaidAppearance).toBe("auto");
    expect(plain(f.tui.render()).find((line) => line.startsWith("→"))).toContain("auto");
    expect(f.notify).toHaveBeenCalledWith("Cannot save Illustrate settings: diskfailed", "error");
    f.tui.press("tui.select.confirm");
    await f.tui.waitForPending();
    expect(f.settings.mermaidAppearance).toBe("dark");
    f.tui.press("ctrl+c");
    await running;
  });

  it.each(["back", "close", "dispose"] as const)("drains accepted saves on %s", async (exit) => {
    const f = fixture();
    const entered = gate();
    const release = gate();
    f.saveSettings.mockImplementationOnce(async (patch) => {
      entered.release();
      await release.promise;
      Object.assign(f.settings, patch);
    });
    let settled = false;
    const running = showIllustrateSettings(f.ctx, f.owner).then((result) => {
      settled = true;
      return result;
    });
    await f.tui.waitForOpen();
    f.tui.press("tui.select.down");
    f.tui.press("tui.select.confirm");
    await entered.promise;
    if (exit === "dispose") f.tui.dispose();
    else f.tui.press(exit === "close" ? "ctrl+c" : "tui.select.cancel");
    expect(settled).toBe(false);
    release.release();
    expect(await running).toBe(exit === "dispose" ? "stale" : exit);
    expect(f.settings.mermaidAppearance).toBe("dark");
  });

  it("does not start queued saves or report stale failures after owner replacement", async () => {
    const f = fixture();
    const entered = gate();
    const release = gate();
    f.saveSettings.mockImplementationOnce(async () => {
      entered.release();
      await release.promise;
      throw new Error("old owner");
    });
    const running = showIllustrateSettings(f.ctx, f.owner);
    await f.tui.waitForOpen();
    f.tui.press("tui.select.down");
    f.tui.press("tui.select.confirm");
    f.tui.press("tui.select.confirm");
    await entered.promise;
    f.replace();
    release.release();
    expect(await running).toBe("stale");
    expect(f.saveSettings).toHaveBeenCalledTimes(1);
    expect(f.notify).not.toHaveBeenCalled();
  });

  it("uses Auto and a native numeric input, preserves editing/paste/IME, then restores width focus", async () => {
    const f = fixture();
    const running = showIllustrateSettings(f.ctx, f.owner);
    await f.tui.waitForOpen();
    await openNumeric(f);
    expect(f.input).toHaveBeenCalledWith("Default width in columns", "Positive safe integer", {
      signal: expect.any(AbortSignal),
    });
    expect(f.inputs).toHaveLength(1);
    expect(f.tui.isFocusable).toBe(true);
    f.tui.setFocused(true);
    expect(f.inputs[0]?.focused).toBe(true);
    f.send("\x1b[200~120\x1b[201~");
    f.send("\x7f");
    f.send("8");
    f.send("\r");
    await f.tui.waitForOpen();
    expect(f.settings.defaultCols).toBe(128);
    expect(f.saveSettings).toHaveBeenCalledWith({ defaultCols: 128 });
    expect(plain(f.tui.render()).find((line) => line.startsWith("→"))).toContain("Default width");
    expect(f.listeners.size).toBe(0);
    f.tui.press("tui.select.confirm");
    f.tui.press("tui.select.up");
    f.tui.press("tui.select.confirm");
    await f.tui.waitForPending();
    expect(f.settings.defaultCols).toBe("auto");
    f.tui.press("ctrl+c");
    expect(await running).toBe("close");
  });

  it.each(["0", "-1", "2.5", "9007199254740992", "auto", "", "3\n4"])(
    "rejects invalid numeric entry %j without a save",
    async (value) => {
      const f = fixture();
      f.ctx.ui.input = vi.fn().mockResolvedValue(value);
      const running = showIllustrateSettings(f.ctx, f.owner);
      await f.tui.waitForOpen();
      await openNumeric(f);
      expect(f.saveSettings).not.toHaveBeenCalled();
      expect(f.notify).toHaveBeenCalledWith("Width must be a positive safe integer.", "error");
      f.tui.press("ctrl+c");
      await running;
    },
  );

  it("returns from width submenu and numeric-input Escape without closing Settings or saving", async () => {
    const f = fixture();
    const running = showIllustrateSettings(f.ctx, f.owner);
    await f.tui.waitForOpen();
    f.tui.press("tui.select.confirm");
    f.tui.press("tui.select.cancel");
    expect(plain(f.tui.render()).join("\n")).toContain("Mermaid appearance");
    await openNumeric(f);
    f.send("\x1b");
    await f.tui.waitForOpen();
    expect(plain(f.tui.render()).join("\n")).toContain("Mermaid appearance");
    expect(f.saveSettings).not.toHaveBeenCalled();
    f.tui.press("ctrl+c");
    expect(await running).toBe("close");
  });

  it("restores the numeric width after a failed input save", async () => {
    const f = fixture();
    f.ctx.ui.input = vi.fn().mockResolvedValue("96");
    f.saveSettings.mockRejectedValueOnce(new Error("read-only settings"));
    const running = showIllustrateSettings(f.ctx, f.owner);
    await f.tui.waitForOpen();
    await openNumeric(f);
    expect(f.settings.defaultCols).toBe("auto");
    expect(plain(f.tui.render()).find((line) => line.startsWith("→"))).toContain("auto");
    expect(f.notify).toHaveBeenCalledWith("Cannot save Illustrate settings: read-only settings", "error");
    f.tui.press("ctrl+c");
    await running;
  });

  it("keeps the selected width choice in a one-row frame and routes clipped mouse coordinates", async () => {
    const f = fixture();
    const running = showIllustrateSettings(f.ctx, f.owner);
    await f.tui.waitForOpen();
    f.tui.press("tui.select.confirm");
    f.tui.press("tui.select.down");
    const choice = plain(f.tui.resize({ rows: 4, width: 80 }));
    expect(choice).toHaveLength(1);
    expect(choice[0]).toContain("Custom columns");
    f.tui.press("tui.select.cancel");
    f.tui.press("tui.select.down");
    expect(plain(f.tui.render())[0]).toContain("Mermaid appearance");
    f.tui.mouse({ type: "press", x: 2, y: 0 });
    f.tui.mouse({ type: "click", x: 2, y: 0 });
    await f.tui.waitForPending();
    expect(f.saveSettings).toHaveBeenCalledWith({ mermaidAppearance: "dark" });
    f.tui.press("ctrl+c");
    await running;
  });

  it.each(["list", "submenu", "input"] as const)(
    "hard-closes %s with Ctrl+C when cancellation is remapped",
    async (screen) => {
      const f = fixture({ config: { "tui.select.cancel": "ctrl+q" } });
      const running = showIllustrateSettings(f.ctx, f.owner);
      await f.tui.waitForOpen();
      if (screen === "submenu") f.tui.press("tui.select.confirm");
      if (screen === "input") await openNumeric(f);
      f.send("\x03");
      expect(await running).toBe("close");
      expect(f.listeners.size).toBe(0);
    },
  );

  it.each([
    { name: "legacy", raw: "\x03", kitty: false, closes: true },
    { name: "Kitty", raw: "\x1b[99;5u", kitty: true, closes: true },
    { name: "modifyOtherKeys", raw: "\x1b[27;5;99~", kitty: false, closes: true },
    { name: "Kitty repeat", raw: "\x1b[99;5:2u", kitty: true, closes: true },
    { name: "Kitty release", raw: "\x1b[99;5:3u", kitty: true, closes: false },
    { name: "extra Alt modifier", raw: "\x1b[99;7u", kitty: true, closes: false },
    { name: "extra Shift modifier", raw: "\x1b[99;6u", kitty: true, closes: false },
  ])("matches only a hard-cancel press in native input: $name", async ({ raw, kitty, closes }) => {
    setKittyProtocolActive(kitty);
    const f = fixture({ config: { "tui.select.cancel": "ctrl+q" } });
    const running = showIllustrateSettings(f.ctx, f.owner);
    await f.tui.waitForOpen();
    await openNumeric(f);
    f.send(raw);
    if (!closes) {
      expect(f.tui.isOpen).toBe(true);
      expect(f.listeners.size).toBe(1);
      f.send("\x03");
    }
    expect(await running).toBe("close");
    expect(f.listeners.size).toBe(0);
  });

  it("does not treat pasted Ctrl+C as a screen shortcut", async () => {
    const f = fixture();
    const running = showIllustrateSettings(f.ctx, f.owner);
    await f.tui.waitForOpen();
    await openNumeric(f);
    f.send("\x1b[200~12\x038\x1b[201~");
    expect(f.tui.isOpen).toBe(true);
    f.send("\x1b");
    await f.tui.waitForOpen();
    f.tui.press("ctrl+c");
    expect(await running).toBe("close");
  });

  it("hard-closes native input during an unfinished paste even with remapped cancellation", async () => {
    const f = fixture({ config: { "tui.select.cancel": "ctrl+q" } });
    const running = showIllustrateSettings(f.ctx, f.owner);
    await f.tui.waitForOpen();
    await openNumeric(f);
    f.send("\x1b[200~12");
    f.send("\x03");
    expect(await running).toBe("close");
    expect(f.listeners.size).toBe(0);
    expect(f.saveSettings).not.toHaveBeenCalled();
  });

  it("aborts native numeric input and removes its listener on owner replacement", async () => {
    const f = fixture();
    const running = showIllustrateSettings(f.ctx, f.owner);
    await f.tui.waitForOpen();
    await openNumeric(f);
    f.replace();
    expect(await running).toBe("stale");
    expect(f.listeners.size).toBe(0);
    expect(f.saveSettings).not.toHaveBeenCalled();
  });

  it.each([
    { name: "up", binding: "tui.select.up", raw: "\x11" },
    { name: "down", binding: "tui.select.down", raw: "\x11" },
    { name: "page up", binding: "tui.select.pageUp", raw: "\x11" },
    { name: "page down", binding: "tui.select.pageDown", raw: "\x11" },
    { name: "confirmation", binding: "tui.select.confirm", raw: "\x11" },
    { name: "literal Space", binding: undefined, raw: " " },
    { name: "legacy Tab/Ctrl+I", binding: "tui.select.confirm", raw: "\t" },
  ])("keeps native $name priority ahead of a conflicting cancellation", async ({ binding, raw }) => {
    const cancel = raw === " " ? "space" : raw === "\t" ? "ctrl+i" : "ctrl+q";
    const config: KeybindingsConfig = { "tui.select.cancel": cancel };
    if (binding) config[binding] = raw === "\t" ? "tab" : "ctrl+q";
    const f = fixture({ config });
    const running = showIllustrateSettings(f.ctx, f.owner);
    await f.tui.waitForOpen();
    f.send(raw);
    expect(f.tui.isOpen).toBe(true);
    f.send("\x03");
    expect(await running).toBe("close");
  });

  it.each([
    { name: "escape alias", keys: ["esc"], raw: "\x1b", kitty: false },
    { name: "modifier order", keys: ["alt+ctrl+q"], raw: "\x1b[113;7u", kitty: true },
    { name: "legacy Ctrl+I collision", keys: ["ctrl+i"], raw: "\t", kitty: false },
    { name: "Kitty Ctrl+I", keys: ["ctrl+i"], raw: "\x1b[105;5u", kitty: true },
    { name: "invalid then usable fallback", keys: ["ctrl+ctrl+q", "ctrl+q"], raw: "\x11", kitty: false },
  ])("uses native configured cancellation ($name) without false literal hints", async ({ keys, raw, kitty }) => {
    setKittyProtocolActive(kitty);
    const f = fixture({ config: { "tui.select.cancel": keys as KeybindingsConfig[string] } });
    const running = showIllustrateSettings(f.ctx, f.owner);
    await f.tui.waitForOpen();
    const lines = plain(f.tui.render()).join("\n");
    expect(lines).not.toContain("Enter/Space");
    expect(lines).not.toContain("Esc to cancel");
    f.send(raw);
    expect(await running).toBe("back");
  });

  it.each(["rpc", "print", "json"] as const)("never opens native Settings in %s mode", async (mode) => {
    const f = fixture();
    f.ctx.mode = mode;
    const custom = vi.spyOn(f.ctx.ui, "custom");
    expect(await showIllustrateSettings(f.ctx, f.owner)).toBe("stale");
    expect(custom).not.toHaveBeenCalled();
  });
});
