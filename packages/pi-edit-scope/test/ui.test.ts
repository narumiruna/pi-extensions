import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import type { ExtensionCommandContext, ExtensionUIContext, Theme } from "@earendil-works/pi-coding-agent";
import { getKeybindings, isFocusable, setKeybindings, Text, type TUI, visibleWidth } from "@earendil-works/pi-tui";
import { runTask } from "@narumitw/pi-tui-kit";
import { afterAll, afterEach, expect, it, vi } from "vitest";
import { scopeOverlayContext } from "../src/ui.js";
import {
  callTool,
  cleanupSmokeRoot,
  createFixture,
  createNativeSession,
  disposeNativeSession,
  sdk,
} from "./smoke-fixture.js";
import { createScopeUIHost, nativeKeys } from "./ui-host.js";

sdk.initTheme("dark", false);
const originalKeys = getKeybindings();
const theme = {
  fg: (_role: string, text: string) => text,
  bg: (_role: string, text: string) => text,
  bold: (text: string) => text,
} as unknown as Theme;
afterEach(() => setKeybindings(originalKeys));
afterAll(cleanupSmokeRoot);

it("keeps live context getters and UI receivers while requesting a bounded owned overlay", async () => {
  let idle = true;
  const component = { render: (_width: number) => ["content"], invalidate() {}, dispose: vi.fn() };
  const factory = vi.fn(() => component);
  const onHandle = vi.fn();
  const tui = { terminal: { rows: 24 } } as unknown as TUI;
  const keys = nativeKeys();
  const done = vi.fn();
  const custom = vi.fn(async function (
    this: ExtensionUIContext,
    received: Parameters<ExtensionUIContext["custom"]>[0],
    options: unknown,
  ) {
    return { ui: this, component: await received(tui, theme, keys, done), options };
  }) as unknown as ExtensionUIContext["custom"];
  const notify = vi.fn(function (this: ExtensionUIContext) {
    return this;
  });
  const ui = { custom, notify } as unknown as ExtensionUIContext;
  const ctx = {
    ui,
    get mode() {
      return idle ? "tui" : "rpc";
    },
    isIdle() {
      return idle;
    },
  } as unknown as ExtensionCommandContext;
  const adapted = scopeOverlayContext(ctx);
  const result = (await adapted.ui.custom(factory, { onHandle })) as {
    ui: ExtensionUIContext;
    component: typeof component;
    options: unknown;
  };
  expect(result.ui).toBe(ui);
  expect(result.options).toEqual({
    onHandle,
    overlay: true,
    overlayOptions: { anchor: "bottom-left", width: "100%", maxHeight: "100%", margin: 0 },
  });
  expect(factory).toHaveBeenCalledWith(tui, theme, keys, done);
  expect(result.component.render(80)).toEqual(["content"]);
  expect(result.component.render(0)).toEqual([]);
  expect(result.component.render(Number.NaN)).toEqual([]);
  result.component.dispose();
  expect(component.dispose.mock.contexts).toEqual([component]);
  expect(ctx.ui).toBe(ui);
  expect(ctx.ui.custom).toBe(custom);
  adapted.ui.notify("status");
  expect(notify.mock.contexts).toEqual([ui]);
  idle = false;
  expect(adapted.mode).toBe("rpc");
  expect(adapted.isIdle()).toBe(false);
});

it.each(["regular", "fullscreen"] as const)(
  "%s native rendering retains the selected file across constrained heights and arbitrary footer rows",
  async (mode) => {
    const keys = nativeKeys({ "tui.select.confirm": "f2", "tui.select.cancel": "f4" });
    setKeybindings(keys);
    const host = createScopeUIHost(mode, keys, theme);
    const fixture = createFixture();
    for (let index = 0; index < 18; index++)
      writeFileSync(join(fixture.cwd, `file-${String(index).padStart(2, "0")}`), "fixture");
    const { session, errors } = await createNativeSession(fixture, { mode: "tui", uiContext: host.ui });
    host.attach(session, 4);
    const command = session.prompt("/edit-scope");
    try {
      await host.waitForOpen();
      host.send("\x1bOQ"); // Remapped F2 opens the picker.
      const picker = await host.waitForOpen();
      await host.pending();
      host.send("file-");
      for (let index = 0; index < 12; index++) host.send("\x1b[B");
      const evidence: Array<{ width: number; rows: number; screen: string[]; overlay: string[] }> = [];
      for (const rows of [1, 2, 3, 4, 5, 6, 7, 8, 12, 32, 7]) {
        for (const width of [80, 24, 8, 1]) {
          host.resize(width, rows);
          const screen = host.screen().map(stripVTControlCharacters);
          const bounds = picker?.handle?.getBounds();
          evidence.push({
            width,
            rows,
            screen,
            overlay: bounds ? screen.slice(bounds.row, bounds.row + bounds.height) : [],
          });
        }
      }
      host.send("\x03");
      await command;
      expect(errors).toEqual([]);
      expect(host.widgets.has("edit-scope")).toBe(true);
      expect(picker && isFocusable(picker.component) && picker.component.focused).toBe(false);
      for (const item of evidence) {
        expect(item.screen.length).toBeLessThanOrEqual(item.rows);
        expect(item.screen.every((line) => visibleWidth(line) <= item.width)).toBe(true);
        expect(item.overlay.length).toBeGreaterThan(0);
        if (item.width === 80) {
          expect(item.overlay.join("\n")).toContain("→ [ ] ");
          expect(item.overlay.join("\n")).toContain("file-12");
          if (item.rows >= 8) {
            expect(item.overlay[0]).toMatch(/^─+$/u);
            expect(item.overlay.at(-1)).toMatch(/^─+$/u);
          }
        }
      }
      expect(host.calls.length).toBeGreaterThanOrEqual(2);
      expect(
        host.calls.every(
          (options) =>
            JSON.stringify(options) ===
            JSON.stringify({
              overlay: true,
              overlayOptions: { anchor: "bottom-left", width: "100%", maxHeight: "100%", margin: 0 },
            }),
        ),
      ).toBe(true);
      expect((await callTool(session, "write", { path: fixture.outside, content: "blocked" })).isError).toBe(true);
    } finally {
      await disposeNativeSession(session);
      await command;
      host.dispose();
    }
  },
);

it.each(["regular", "fullscreen"] as const)(
  "%s task overlays retain their label on tiny terminals and drain cancellation",
  async (mode) => {
    const keys = nativeKeys({ "tui.select.cancel": "f4" });
    setKeybindings(keys);
    const host = createScopeUIHost(mode, keys, theme);
    const { session } = await createNativeSession(createFixture(), { mode: "tui", uiContext: host.ui });
    host.attach(session);
    let release!: () => void;
    let signal: AbortSignal | undefined;
    const task = runTask(scopeOverlayContext({ mode: "tui", hasUI: true, ui: host.ui } as ExtensionCommandContext), {
      label: "Pending apply",
      task: async ({ signal: operation }) => {
        signal = operation;
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      },
    });
    try {
      const mounted = await host.waitForOpen();
      const evidence: Array<{ rows: number; lines: string[] }> = [];
      for (const rows of [1, 2, 3, 4, 5, 6, 7, 32]) {
        host.resize(80, rows);
        const screen = host.screen().map(stripVTControlCharacters);
        const bounds = mounted?.handle?.getBounds();
        evidence.push({ rows, lines: bounds ? screen.slice(bounds.row, bounds.row + bounds.height) : [] });
      }
      host.send("\x03");
      expect(signal?.aborted).toBe(true);
      release();
      expect(await task).toEqual({ kind: "cancelled" });
      for (const item of evidence) {
        expect(item.lines.length).toBeLessThanOrEqual(item.rows);
        expect(item.lines.join("\n")).toContain("Pending apply");
        if (item.rows >= 5) {
          expect(item.lines[0]).toMatch(/^─+$/u);
          expect(item.lines.at(-1)).toMatch(/^─+$/u);
        }
      }
    } finally {
      release?.();
      await task;
      await disposeNativeSession(session);
      host.dispose();
    }
  },
);

it.each(["regular", "fullscreen"] as const)(
  "%s shutdown removes only Scope's overlay and leaves an unrelated focused overlay intact",
  async (mode) => {
    const keys = nativeKeys();
    setKeybindings(keys);
    const host = createScopeUIHost(mode, keys, theme);
    const { session, errors } = await createNativeSession(createFixture(), { mode: "tui", uiContext: host.ui });
    host.attach(session);
    const command = session.prompt("/scope");
    try {
      const scope = await host.waitForOpen();
      host.screen();
      const other = host.tui.showOverlay(new Text("Unrelated overlay", 0, 0), { width: 24, anchor: "top-right" });
      await session.extensionRunner.emit({ type: "session_shutdown", reason: "reload" });
      await command;
      const painted = host.screen().map(stripVTControlCharacters).join("\n");
      expect(scope?.handle).toBeDefined();
      expect(scope?.handle?.getBounds()).toBeUndefined();
      expect(scope?.handle?.isFocused()).toBe(false);
      expect(other.isHidden()).toBe(false);
      expect(other.isFocused()).toBe(true);
      expect(painted).toContain("Unrelated overlay");
      expect(host.widgets.has("edit-scope")).toBe(false);
      expect(errors).toEqual([]);
      other.hide();
    } finally {
      await disposeNativeSession(session);
      await command;
      host.dispose();
    }
  },
);
