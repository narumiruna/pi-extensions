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
const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";
const CTRL_UNDERSCORE = "\x1f";
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
  expect(text(menu.component.render(60))).toContain("pasted line");
  expect(text(menu.component.render(60))).not.toContain("[paste #");
  expect(menu.closed).not.toHaveBeenCalled();
  expect(menu.save).not.toHaveBeenCalled();
  menu.send("\x1bOQ");
  await expect(menu.result).resolves.toBe(true);
  expect(menu.save).toHaveBeenCalledExactlyOnceWith(
    { key: "promptHintText", value: `  Original\nSecond ${largePaste}` },
    expect.any(AbortSignal),
  );
});

test("keeps literal paste markers in the prefill and inside a multiline paste", async () => {
  const original = "Keep [paste #1] and [paste #2 +11 lines].\n";
  const pasted = `[paste #1]\n${"Pasted line\n".repeat(10)}`;
  const menu = await openMenu({ saved: { enabled: true, text: original } });
  menu.send(DOWN, DOWN, ENTER, PASTE_START + pasted + PASTE_END, ENTER);
  await expect(menu.result).resolves.toBe(true);
  expect(menu.save).toHaveBeenCalledExactlyOnceWith(
    { key: "promptHintText", value: original + pasted },
    expect.any(AbortSignal),
  );
});

test("preserves tabs before and after edits and leaves ordinary spaces unchanged", async () => {
  const menu = await openMenu({ saved: { enabled: true, text: "\tKeep this line\n    Change this line\t" } });
  menu.send(DOWN, DOWN, ENTER, "!");
  const row = menu.component.render(60).findIndex((line) => line.includes("Change this line"));
  click(menu.component, 4, row);
  menu.send("Do not ", ENTER);
  await expect(menu.result).resolves.toBe(true);
  expect(menu.save).toHaveBeenCalledExactlyOnceWith(
    { key: "promptHintText", value: "\tKeep this line\n    Do not Change this line\t!" },
    expect.any(AbortSignal),
  );
});

test("uses the native backslash newline fallback with the default submit key", async () => {
  const menu = await openMenu();
  menu.send(DOWN, DOWN, ENTER, "\\", ENTER, "Next line");
  expect(menu.save).not.toHaveBeenCalled();
  menu.send(ENTER);
  await expect(menu.result).resolves.toBe(true);
  expect(menu.save).toHaveBeenCalledExactlyOnceWith(
    { key: "promptHintText", value: "Original\nNext line" },
    expect.any(AbortSignal),
  );
});

test("submits without the backslash with the native remapped newline fallback", async () => {
  const menu = await openMenu({}, { "tui.input.newLine": "enter", "tui.input.submit": "shift+enter" });
  menu.send(DOWN, DOWN, ENTER, "\\", ENTER);
  await expect(menu.result).resolves.toBe(true);
  expect(menu.save).toHaveBeenCalledExactlyOnceWith(
    { key: "promptHintText", value: "Original" },
    expect.any(AbortSignal),
  );
});

test("preserves native editing priority when the save and Backspace bindings overlap", async () => {
  const menu = await openMenu({}, { "tui.input.submit": ["f2", "backspace"] });
  menu.send(DOWN, DOWN, ENTER, "\x7f");
  expect(menu.save).not.toHaveBeenCalled();
  menu.send("\x1bOQ");
  await expect(menu.result).resolves.toBe(true);
  expect(menu.save).toHaveBeenCalledExactlyOnceWith(
    { key: "promptHintText", value: "Origina" },
    expect.any(AbortSignal),
  );
});

test("uses a remapped printable submit key as the target of a native character jump", async () => {
  const menu = await openMenu(
    { saved: { enabled: true, text: "one" } },
    { "tui.editor.jumpBackward": "f2", "tui.input.submit": "o" },
  );
  menu.send(DOWN, DOWN, ENTER, "\x1bOQ", "o", "A");
  expect(menu.save).not.toHaveBeenCalled();
  menu.send("o");
  await expect(menu.result).resolves.toBe(true);
  expect(menu.save).toHaveBeenCalledExactlyOnceWith({ key: "promptHintText", value: "Aone" }, expect.any(AbortSignal));
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

test("Undo after a failed save removes the paste, not the draft", async () => {
  const menu = await openMenu({}, { "tui.editor.undo": "ctrl+_" });
  menu.save.mockRejectedValueOnce(new Error("Fix the file."));
  const pasted = "\nPasted line".repeat(11);
  menu.send(DOWN, DOWN, ENTER, " changed", PASTE_START + pasted + PASTE_END, ENTER);
  await menu.component.waitForPending?.();
  expect(menu.save).toHaveBeenCalledExactlyOnceWith(
    { key: "promptHintText", value: `Original changed${pasted}` },
    expect.any(AbortSignal),
  );
  menu.send(CTRL_UNDERSCORE, ENTER);
  await expect(menu.result).resolves.toBe(true);
  expect(menu.save).toHaveBeenLastCalledWith(
    { key: "promptHintText", value: "Original changed" },
    expect.any(AbortSignal),
  );
});

test.for([
  { cancelKey: CANCEL, bindings: undefined },
  { cancelKey: "\x18", bindings: { "tui.select.cancel": "ctrl+x" } },
])("ignores configured cancel during a save and completes with the saved result", async ({ cancelKey, bindings }) => {
  const started = Promise.withResolvers<AbortSignal>();
  const saved = Promise.withResolvers<boolean>();
  const menu = await openMenu(
    {
      save(_change, signal) {
        started.resolve(signal);
        return saved.promise;
      },
    },
    bindings as KeybindingsConfig | undefined,
  );
  menu.send(DOWN, ENTER);
  const signal = await started.promise;
  menu.send(cancelKey);
  expect(menu.closed).not.toHaveBeenCalled();
  expect(signal.aborted).toBe(false);
  saved.resolve(true);
  await expect(menu.result).resolves.toBe(true);
});

test.for([true, false])(
  "hard-cancels immediately and reports whether an in-flight save committed (%j)",
  async (committed) => {
    const started = Promise.withResolvers<AbortSignal>();
    const saved = Promise.withResolvers<boolean>();
    const menu = await openMenu({
      save(_change, signal) {
        started.resolve(signal);
        return saved.promise;
      },
    });
    menu.send(DOWN, ENTER);
    const signal = await started.promise;
    menu.send(HARD_CANCEL);
    expect(menu.closed).toHaveBeenCalledOnce();
    expect(signal.aborted).toBe(true);
    saved.resolve(committed);
    await expect(menu.result).resolves.toBe(committed ? "saved-after-cancel" : false);
  },
);

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
