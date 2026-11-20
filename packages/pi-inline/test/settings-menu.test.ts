import { stripVTControlCharacters } from "node:util";
import {
  type KeybindingsManager as AppKeybindings,
  type ExtensionCommandContext,
  type ExtensionUIContext,
  initTheme,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import {
  type Component,
  CURSOR_MARKER,
  getKeybindings,
  isFocusable,
  type KeybindingsConfig,
  KeybindingsManager,
  setKeybindings,
  type TUI,
  TUI_KEYBINDINGS,
  visibleWidth,
} from "@earendil-works/pi-tui";
import { afterEach, beforeAll, expect, test, vi } from "vitest";
import { showInlineSettings } from "../src/settings-menu.js";

type MenuOptions = Parameters<typeof showInlineSettings>[1];
type MenuComponent = Component & { dispose?(): void; waitForPending?(): Promise<void> };

const originalKeybindings = getKeybindings();
const DOWN = "\x1b[B";
const ENTER = "\r";
const CANCEL = "\x1b";
const HARD_CANCEL = "\x03";
const text = (lines: readonly string[]) => lines.map(stripVTControlCharacters).join("\n");

beforeAll(() => initTheme("dark"));
afterEach(() => setKeybindings(originalKeybindings));

async function openMenu(options: Partial<MenuOptions> = {}, bindings?: KeybindingsConfig) {
  const notify = vi.fn();
  const setWikilinks = vi.fn();
  const save = vi.fn<MenuOptions["save"]>().mockResolvedValue(true);
  const closed = vi.fn();
  const requestRender = vi.fn();
  const terminal = { rows: 24 };
  const tui = { terminal, requestRender } as unknown as TUI;
  const theme = {
    bold: (line: string) => line,
    fg: (role: string, line: string) => (role === "border" ? `\x1b[35m${line}\x1b[39m` : line),
  } as Theme;
  const keybindings = new KeybindingsManager(TUI_KEYBINDINGS, bindings) as AppKeybindings;
  setKeybindings(keybindings);
  const mounted = Promise.withResolvers<MenuComponent>();
  const custom: ExtensionUIContext["custom"] = <T>(factory: Parameters<ExtensionUIContext["custom"]>[0]) => {
    const done = Promise.withResolvers<T>();
    let component: MenuComponent | undefined;
    const created = factory(tui, theme, keybindings, (result) => {
      closed(result);
      done.resolve(result as T);
      component?.dispose?.();
    });
    void Promise.resolve(created).then((value) => {
      component = value;
      if (isFocusable(component)) component.focused = true;
      mounted.resolve(component);
    }, mounted.reject);
    return done.promise;
  };
  const ctx = { mode: "tui", hasUI: true, ui: { custom, notify } } as unknown as ExtensionCommandContext;
  const result = showInlineSettings(ctx, {
    signal: new AbortController().signal,
    wikilinks: true,
    saved: { enabled: true, text: "Original" },
    active: { enabled: true, text: "Original" },
    saveBlocked: false,
    setWikilinks,
    save,
    ...options,
  });
  const component = await mounted.promise;
  const send = (...keys: string[]) => {
    for (const data of keys) component.handleInput?.(data);
  };
  return { component, terminal, result, send, closed, notify, requestRender, setWikilinks, save };
}

function click(component: MenuComponent, x: number, y: number) {
  return component.handleMouse?.({
    type: "click",
    button: "left",
    x,
    y,
    screenX: x,
    screenY: y,
    width: 60,
    height: 24,
    shift: false,
    alt: false,
    ctrl: false,
  });
}

test("renders a bounded callback-themed frame and separates saved and active settings", async () => {
  const menu = await openMenu({ active: { enabled: false, text: "Older" } });
  const frame = menu.component.render(60);
  expect(frame[0]).toBe(`\x1b[35m${"─".repeat(60)}\x1b[39m`);
  expect(frame.at(-1)).toBe(frame[0]);
  expect(text(frame)).toMatch(/Prompt Hint +On \(reload pending\)/u);
  menu.send(" ", DOWN);
  expect(menu.setWikilinks).toHaveBeenCalledExactlyOnceWith(false);
  expect(text(menu.component.render(60))).toContain("The active hint is Off.");
  expect(menu.save).not.toHaveBeenCalled();
  menu.terminal.rows = 4;
  menu.component.invalidate();
  expect(text(menu.component.render(60))).toMatch(/^→ Prompt Hint/u);
  expect(menu.component.render(0).every((line) => visibleWidth(line) === 0)).toBe(true);
  expect(menu.component.render(1).every((line) => visibleWidth(line) <= 1)).toBe(true);
  menu.send(ENTER);
  await expect(menu.result).resolves.toBe(true);
  expect(menu.save).toHaveBeenCalledExactlyOnceWith(
    { key: "promptHintEnabled", value: false },
    expect.any(AbortSignal),
  );
});

test("routes clipped list and editor mouse rows and forwards focus to the native editor", async () => {
  const menu = await openMenu({ saved: { enabled: false, text: "Original" } });
  menu.send(DOWN, DOWN);
  menu.terminal.rows = 4;
  expect(text(menu.component.render(60))).toContain("→ Edit Prompt Hint…");
  click(menu.component, 1, 0);
  expect(menu.component.render(60)[0]).toContain(CURSOR_MARKER);
  expect(text(menu.component.render(60))).toContain("Original");
  expect(menu.component.render(0).every((line) => visibleWidth(line) === 0)).toBe(true);
  expect(menu.component.render(1).every((line) => visibleWidth(line) <= 1)).toBe(true);
  if (isFocusable(menu.component)) menu.component.focused = false;
  expect(menu.component.render(60).join("")).not.toContain(CURSOR_MARKER);
  if (isFocusable(menu.component)) menu.component.focused = true;
  const editorRow = menu.component.render(60).findIndex((line) => line.includes(CURSOR_MARKER));
  click(menu.component, 0, editorRow);
  menu.send("A", ENTER);
  await expect(menu.result).resolves.toBe(true);
  expect(menu.save).toHaveBeenCalledExactlyOnceWith(
    { key: "promptHintText", value: "AOriginal" },
    expect.any(AbortSignal),
  );
});

test("uses remapped editor bindings and keeps spaces, multiline input, and expanded large paste", async () => {
  const menu = await openMenu(
    { saved: { enabled: true, text: "  Original" } },
    { "tui.input.submit": "f2", "tui.input.newLine": ["enter", "ctrl+j"], "tui.select.cancel": "ctrl+x" },
  );
  menu.send(DOWN, DOWN, ENTER, "x", "\x7f", ENTER, "Second ");
  const largePaste = "   pasted line \n".repeat(12);
  menu.send(`\x1b[200~${largePaste}`, HARD_CANCEL, "\x1b[20", "1~");
  expect(text(menu.component.render(60))).toContain("[paste #1");
  expect(menu.closed).not.toHaveBeenCalled();
  expect(menu.save).not.toHaveBeenCalled();
  menu.send("\x1bOQ");
  await expect(menu.result).resolves.toBe(true);
  expect(menu.save).toHaveBeenCalledExactlyOnceWith(
    { key: "promptHintText", value: `  Original\nSecond ${largePaste}` },
    expect.any(AbortSignal),
  );
});

test("backs out with remapped cancel and hard-cancels from the editor", async () => {
  const menu = await openMenu({}, { "tui.select.cancel": "ctrl+x" });
  menu.send(DOWN, DOWN, ENTER, CANCEL);
  expect(text(menu.component.render(60))).toContain("Original");
  menu.send("\x18");
  expect(text(menu.component.render(60))).toContain("→ Edit Prompt Hint…");
  menu.send(ENTER, HARD_CANCEL);
  await expect(menu.result).resolves.toBe(false);
  expect(menu.save).not.toHaveBeenCalled();
});

test("keeps the editor draft after failure and does not submit a second save while pending", async () => {
  const menu = await openMenu();
  menu.save.mockRejectedValueOnce(new Error("Fix the file."));
  menu.send(DOWN, DOWN, ENTER, " changed", ENTER, ENTER);
  await menu.component.waitForPending?.();
  expect(menu.notify).toHaveBeenCalledExactlyOnceWith("Fix the file.", "error");
  expect(menu.save).toHaveBeenCalledTimes(1);
  expect(text(menu.component.render(60))).toContain("Original changed");
  menu.send(ENTER);
  await expect(menu.result).resolves.toBe(true);
  expect(menu.save).toHaveBeenCalledTimes(2);
});

test("does not close the menu for an unchanged save or rewrite an untouched prefill with tabs", async () => {
  const menu = await openMenu({ saved: { enabled: true, text: "\tOriginal" } });
  menu.save.mockResolvedValue(false);
  menu.send(DOWN, ENTER);
  await menu.component.waitForPending?.();
  expect(menu.closed).not.toHaveBeenCalled();
  expect(text(menu.component.render(60))).toMatch(/→ Prompt Hint +On/u);
  menu.send(DOWN, ENTER, ENTER);
  expect(text(menu.component.render(60))).toContain("→ Edit Prompt Hint…");
  expect(menu.save).toHaveBeenCalledTimes(1);
  menu.send(CANCEL);
  await expect(menu.result).resolves.toBe(false);
});

test("keeps invalid-file settings read-only but allows Wikilinks to change", async () => {
  const menu = await openMenu({ saveBlocked: true });
  expect(text(menu.component.render(60))).toContain("Repair pi-inline.json");
  menu.send(ENTER, DOWN, ENTER, DOWN, ENTER, CANCEL);
  await expect(menu.result).resolves.toBe(false);
  expect(menu.save).not.toHaveBeenCalled();
  expect(menu.setWikilinks).toHaveBeenCalledExactlyOnceWith(false);
});

test("does not render unsafe draft controls", async () => {
  const menu = await openMenu();
  menu.send(DOWN, DOWN, ENTER, "\x1b[200~\u202etext\x1b[201~");
  const draft = text(menu.component.render(60));
  expect(draft).toContain("Draft contains unsafe terminal text");
  expect(draft).not.toContain("\u202e");
  menu.send(HARD_CANCEL);
  await expect(menu.result).resolves.toBe(false);
});

test("host disposal cancels and drains the save without calling done", async () => {
  const started = Promise.withResolvers<AbortSignal>();
  const released = Promise.withResolvers<boolean>();
  const menu = await openMenu({
    save(_change, signal) {
      started.resolve(signal);
      return released.promise;
    },
  });
  menu.send(DOWN, ENTER);
  const signal = await started.promise;
  menu.component.dispose?.();
  expect(signal.aborted).toBe(true);
  const completed = vi.fn();
  void menu.result.then(completed);
  await Promise.resolve();
  expect(completed).not.toHaveBeenCalled();
  released.resolve(true);
  await expect(menu.result).resolves.toBe(false);
  expect(menu.closed).not.toHaveBeenCalled();
  expect(menu.notify).not.toHaveBeenCalled();
});
