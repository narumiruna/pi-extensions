import { stripVTControlCharacters } from "node:util";
import { type ExtensionCommandContext, initTheme } from "@earendil-works/pi-coding-agent";
import {
  getKeybindings,
  KeybindingsManager,
  setKeybindings,
  TUI_KEYBINDINGS,
  visibleWidth,
} from "@earendil-works/pi-tui";
import { createTuiHarness } from "@narumitw/pi-tui-kit/testing";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { type IllustrateMenuOwner, showIllustrateMenu } from "../src/menu.js";
import { defaultSettings, type IllustrateSettings } from "../src/settings.js";

const originalKeys = getKeybindings();
beforeAll(() => initTheme("dark", false));
afterEach(() => setKeybindings(originalKeys));

function fixture(remapped = false) {
  const keybindings = new KeybindingsManager(
    TUI_KEYBINDINGS,
    remapped
      ? {
          "tui.select.down": "ctrl+n",
          "tui.select.up": "ctrl+p",
          "tui.select.confirm": "ctrl+y",
          "tui.select.cancel": "ctrl+q",
        }
      : undefined,
  );
  setKeybindings(keybindings);
  const tui = createTuiHarness({ width: 100, rows: 35, keybindings });
  const controller = new AbortController();
  let active = true;
  let settings = defaultSettings();
  const saveSettings = vi.fn(async (patch: Partial<IllustrateSettings>) => {
    settings = { ...settings, ...patch };
  });
  const getStatus = vi.fn(() => [
    "Image protocol: Kitty available",
    "Mermaid appearance: dark (Pi appearance)",
    "Default width: auto",
    "Cached cell dimensions: 9 × 18 pixels (possibly estimated)",
    "Active rendering work: 0",
    "Untrusted: \x1b[2Jtext",
  ]);
  const owner: IllustrateMenuOwner = {
    signal: controller.signal,
    isCurrent: () => active,
    getSettings: () => ({ ...settings }),
    settingsPath: "/user/\x1b]0;unsafe\x07pi-illustrate.json",
    saveSettings,
    getStatus,
  };
  const notify = vi.fn();
  const input = vi.fn();
  const ctx = {
    mode: "tui",
    hasUI: true,
    ui: { custom: tui.custom, notify, input, onTerminalInput: () => () => {} },
  } as unknown as ExtensionCommandContext;
  return {
    tui,
    ctx,
    owner,
    notify,
    input,
    saveSettings,
    getStatus,
    controller,
    replace: () => {
      active = false;
      controller.abort();
    },
  };
}

function plain(lines: readonly string[]) {
  return lines.map(stripVTControlCharacters).join("\n");
}

describe("Illustrate manager", () => {
  it("opens only Settings, Status, and Help with current effective defaults", async () => {
    const f = fixture();
    const running = showIllustrateMenu(f.ctx, f.owner);
    await f.tui.waitForOpen();
    const frame = plain(f.tui.render());
    expect(frame).toContain("Default width: auto");
    expect(frame).toContain("Mermaid appearance: auto");
    expect(frame).toContain("Settings");
    expect(frame).toContain("Status");
    expect(frame).toContain("Help");
    expect(frame).not.toContain("History");
    expect(frame).not.toContain("Activate");
    expect(f.saveSettings).not.toHaveBeenCalled();
    expect(f.getStatus).not.toHaveBeenCalled();
    f.tui.press("ctrl+c");
    await running;
  });

  it("uses the same native Settings screen, returns Back to the manager, and refreshes its state", async () => {
    const f = fixture();
    const running = showIllustrateMenu(f.ctx, f.owner);
    await f.tui.waitForOpen();
    f.tui.press("tui.select.confirm");
    await f.tui.waitForOpen();
    expect(plain(f.tui.render())).toContain("Illustrate Settings");
    f.tui.press("tui.select.down");
    f.tui.press("tui.select.confirm");
    await f.tui.waitForPending();
    f.tui.press("tui.select.cancel");
    await f.tui.waitForOpen();
    expect(plain(f.tui.render())).toContain("Mermaid appearance: dark");
    expect(f.saveSettings).toHaveBeenCalledWith({ mermaidAppearance: "dark" });
    f.tui.press("ctrl+c");
    await running;
  });

  it("Ctrl+C in Settings closes the whole manager instead of reopening it", async () => {
    const f = fixture();
    const running = showIllustrateMenu(f.ctx, f.owner);
    await f.tui.waitForOpen();
    f.tui.press("tui.select.confirm");
    await f.tui.waitForOpen();
    f.tui.press("ctrl+c");
    await running;
    expect(f.tui.openCount).toBe(2);
    expect(f.tui.isOpen).toBe(false);
  });

  it("shows sanitized read-only status without starting any settings operation", async () => {
    const f = fixture();
    const running = showIllustrateMenu(f.ctx, f.owner);
    await f.tui.waitForOpen();
    f.tui.press("tui.select.down");
    f.tui.press("tui.select.confirm");
    await f.tui.waitForOpen();
    const raw = f.tui.render();
    expect(raw.join("\n")).not.toContain("\x1b[2J");
    const frame = plain(raw);
    expect(frame).toContain("Kitty available");
    expect(frame).toContain("dark (Pi appearance)");
    expect(frame).toContain("possibly estimated");
    expect(frame).toContain("Active rendering work: 0");
    expect(frame).toContain("Untrusted: text");
    expect(frame).toContain("/user/pi-illustrate.json");
    expect(frame).not.toContain("unsafe");
    expect(frame).not.toContain("→");
    expect(frame).not.toContain("Apply");
    expect(f.tui.isFocusable).toBe(false);
    expect(f.getStatus).toHaveBeenCalledTimes(1);
    expect(f.input).not.toHaveBeenCalled();
    expect(f.saveSettings).not.toHaveBeenCalled();
    expect(f.owner.settingsPath).toContain("\x1b");
    f.tui.press("tui.select.cancel");
    await f.tui.waitForOpen();
    f.tui.press("ctrl+c");
    await running;
  });

  it("explains local tools, width, privacy, and static SVG limits in a scrollable read-only Help view", async () => {
    const f = fixture();
    const running = showIllustrateMenu(f.ctx, f.owner);
    await f.tui.waitForOpen();
    f.tui.press("tui.select.down");
    f.tui.press("tui.select.down");
    f.tui.press("tui.select.confirm");
    await f.tui.waitForOpen();
    const start = plain(f.tui.render());
    expect(start).toContain("illustrate_svg");
    expect(start).toContain("illustrate_mermaid");
    expect(start).toContain("Kitty image support");
    expect(start.replace(/\n/g, "")).toContain("remote rendering service");
    expect(start).toContain("positive safe integer");
    f.tui.press("end");
    const end = plain(f.tui.render());
    expect(end).toContain("sendToModel defaults to false");
    expect(end).toContain("immutable PNG snapshot");
    expect(end).toContain("no scripts");
    expect(end).not.toContain("→");
    expect(f.getStatus).not.toHaveBeenCalled();
    expect(f.saveSettings).not.toHaveBeenCalled();
    f.tui.press("ctrl+c");
    await running;
  });

  it("keeps Status and Help width-safe and read-only at constrained heights and zero width", async () => {
    const f = fixture();
    const zeroFrames: string[][] = [];
    const custom = f.ctx.ui.custom;
    f.ctx.ui.custom = (factory, options) =>
      custom(async (...args) => {
        const component = await factory(...args);
        zeroFrames.push(component.render(0));
        return component;
      }, options);
    const running = showIllustrateMenu(f.ctx, f.owner);
    await f.tui.waitForOpen();
    for (let screen = 0; screen < 2; screen += 1) {
      f.tui.press("tui.select.down");
      f.tui.press("tui.select.confirm");
      await f.tui.waitForOpen();
      for (const rows of [24, 8, 7, 4]) {
        f.tui.resize({ rows });
        for (const width of [80, 12, 1]) {
          const lines = f.tui.render(width);
          expect(lines.length).toBeLessThanOrEqual(Math.max(1, rows - 3));
          expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
          expect(plain(lines)).not.toContain("→");
        }
      }
      f.tui.resize({ width: 100, rows: 35 });
      f.tui.press("tui.select.cancel");
      await f.tui.waitForOpen();
    }
    f.tui.press("ctrl+c");
    await running;
    expect(zeroFrames.length).toBeGreaterThanOrEqual(3);
    expect(zeroFrames.flat().every((line) => line === "")).toBe(true);
  });

  it("honors non-default menu and native settings navigation while retaining hard Close", async () => {
    const f = fixture(true);
    const running = showIllustrateMenu(f.ctx, f.owner);
    await f.tui.waitForOpen();
    f.tui.send("\x19");
    await f.tui.waitForOpen();
    f.tui.send("\x0e");
    f.tui.send("\x19");
    await f.tui.waitForPending();
    expect(f.saveSettings).toHaveBeenCalledWith({ mermaidAppearance: "dark" });
    f.tui.send("\x11");
    await f.tui.waitForOpen();
    f.tui.send("\x03");
    await running;
    expect(f.notify).not.toHaveBeenCalled();
  });

  it("settles without stale UI after replacement or external disposal", async () => {
    for (const exit of ["replace", "dispose"] as const) {
      const f = fixture();
      const running = showIllustrateMenu(f.ctx, f.owner);
      await f.tui.waitForOpen();
      if (exit === "replace") f.replace();
      else f.tui.dispose();
      await running;
      expect(f.tui.isOpen).toBe(false);
      expect(f.notify).not.toHaveBeenCalled();
    }
  });

  it.each(["rpc", "print", "json"] as const)(
    "rejects %s before any TUI operation as a defensive boundary",
    async (mode) => {
      const f = fixture();
      f.ctx.mode = mode;
      const custom = vi.spyOn(f.ctx.ui, "custom");
      await expect(showIllustrateMenu(f.ctx, f.owner)).rejects.toThrow("requires Pi TUI mode");
      expect(custom).not.toHaveBeenCalled();
      expect(f.notify).not.toHaveBeenCalled();
      expect(f.input).not.toHaveBeenCalled();
    },
  );
});
