import assert from "node:assert/strict";
import {
  CURSOR_MARKER,
  isKittyProtocolActive,
  type KeyId,
  matchesKey,
  setKittyProtocolActive,
  visibleWidth,
} from "@earendil-works/pi-tui";
import { afterEach, test, vi } from "vitest";
import { NotePicker, resolveNoteDeleteKey } from "../src/note-picker.js";
import type { MarkdownEntry } from "../src/storage.js";

const initialKittyProtocol = isKittyProtocolActive();

afterEach(() => {
  vi.useRealTimers();
  setKittyProtocolActive(initialKittyProtocol);
});

function note(relativePath: string, size = 10): MarkdownEntry {
  return { relativePath, displayPath: relativePath, size };
}

function keybindings(overrides: Record<string, readonly string[]> = {}) {
  const defaults: Record<string, readonly string[]> = {
    "tui.select.up": ["up"],
    "tui.select.down": ["down"],
    "tui.select.pageUp": ["pageUp"],
    "tui.select.pageDown": ["pageDown"],
    "tui.select.confirm": ["enter"],
    "tui.select.cancel": ["escape", "ctrl+c"],
    "tui.input.submit": ["enter"],
    "tui.input.tab": ["tab"],
    "tui.editor.deleteCharBackward": ["backspace"],
    "tui.editor.deleteCharForward": ["delete", "ctrl+d"],
    "tui.editor.deleteWordBackward": ["ctrl+w"],
    "app.session.delete": ["ctrl+d"],
    ...overrides,
  };
  return {
    matches(data: string, binding: string) {
      return (defaults[binding] ?? []).some((key) => matchesKey(data, key as KeyId));
    },
    getKeys(binding: string) {
      return [...(defaults[binding] ?? [])] as KeyId[];
    },
  };
}

function createPicker(
  notes: readonly MarkdownEntry[],
  options: {
    bindings?: Record<string, readonly string[]>;
    rows?: number;
    query?: string;
    modifyOtherKeysActive?: boolean;
  } = {},
) {
  let result: unknown;
  let renders = 0;
  const picker = new NotePicker({
    tui: {
      terminal: {
        rows: options.rows ?? 24,
        modifyOtherKeysActive: options.modifyOtherKeysActive,
      },
      requestRender: () => {
        renders += 1;
      },
    } as never,
    theme: {
      fg: (_color: string, text: string) => text,
      bg: (_color: string, text: string) => text,
      bold: (text: string) => text,
    } as never,
    keybindings: keybindings(options.bindings) as never,
    notes,
    initialQuery: options.query,
    complete: (value) => {
      result = value;
    },
  });
  return { picker, result: () => result, renders: () => renders };
}

test("renders a width-safe note picker with effective open, delete, Back, and hard-close hints", () => {
  const unsafe = note("unsafe\u001b]52;c;QQ==\u0007\u202e.md", 42);
  unsafe.displayPath = "unsafe.md";
  const { picker } = createPicker([unsafe]);

  for (const width of [1, 8, 24, 80]) {
    const frame = picker.render(width);
    assert.ok(frame.every((line) => visibleWidth(line) <= width));
  }
  const rendered = picker.render(80).join("\n");
  assert.match(rendered, /Open a note/u);
  assert.match(rendered, /ctrl\+d delete/iu);
  assert.match(rendered, /enter open/iu);
  assert.match(rendered, /esc back/iu);
  assert.match(rendered, /ctrl\+c close/iu);
  assert.equal(rendered.includes("\u001b]"), false);
  assert.equal(rendered.includes("\u202e"), false);
});

test("search keeps printable remapped delete keys editable and uses the first non-conflicting fallback", () => {
  const notes = Array.from({ length: 9 }, (_, index) => note(`x-note-${index}.md`, index));
  const { picker, result } = createPicker(notes, {
    bindings: { "app.session.delete": ["x", "ctrl+x"] },
  });
  picker.focused = true;
  assert.equal(picker.render(100).join("\n").includes(CURSOR_MARKER), true);
  assert.match(picker.render(100).join("\n"), /ctrl\+x delete/iu);

  picker.handleInput("x");
  assert.equal(result(), undefined);
  assert.match(picker.render(100).join("\n"), /Search: .*x/u);
  picker.handleInput("\u0018");
  assert.deepEqual(result(), {
    kind: "delete",
    notePath: "x-note-0.md",
    nextSelectedPath: "x-note-1.md",
    query: "x",
  });
});

test("restored search query places the fresh cursor at the conventional end", () => {
  const notes = Array.from({ length: 9 }, (_, index) => note(`xnotex-${index}.md`, index));
  const { picker, result } = createPicker(notes, { query: "note" });
  picker.focused = true;

  picker.handleInput("x");
  picker.handleInput("\u0003");

  assert.deepEqual(result(), { kind: "close", selectedPath: "xnotex-0.md", query: "notex" });
});

test("Home and End edit the active search query instead of moving the note selection", () => {
  const notes = Array.from({ length: 9 }, (_, index) => note(`alpha-${index}.md`, index));
  const { picker, result } = createPicker(notes, { query: "lph" });
  picker.focused = true;

  picker.handleInput("\u001b[H");
  picker.handleInput("a");
  picker.handleInput("\u001b[F");
  picker.handleInput("a");
  picker.handleInput("\u0003");

  assert.deepEqual(result(), { kind: "close", selectedPath: "alpha-0.md", query: "alpha" });
});

test.each([
  {
    name: "Backspace",
    deleteKey: "backspace",
    editorBinding: "tui.editor.deleteCharBackward",
    data: "\u007f",
  },
  {
    name: "Ctrl+W",
    deleteKey: "ctrl+w",
    editorBinding: "tui.editor.deleteWordBackward",
    data: "\u0017",
  },
])("uses inactive $name editor binding to delete when search is hidden", ({ deleteKey, editorBinding, data }) => {
  const { picker, result } = createPicker([note("one.md"), note("two.md")], {
    bindings: {
      "app.session.delete": [deleteKey],
      [editorBinding]: [deleteKey],
    },
  });

  assert.match(picker.render(100).join("\n"), new RegExp(`${deleteKey.replace("+", "\\+")} delete`, "iu"));
  picker.handleInput(data);
  assert.deepEqual(result(), { kind: "delete", notePath: "one.md", nextSelectedPath: "two.md", query: "" });
});

test("mouse selection and activation preserve the standard open-note behavior", () => {
  const { picker, result } = createPicker([note("one.md"), note("two.md"), note("three.md")]);
  const width = 100;
  const frame = picker.render(width);
  const y = frame.findIndex((line) => line.includes("two.md"));
  assert.notEqual(y, -1);

  assert.deepEqual(
    picker.handleMouse({ type: "press", x: 3, y, width, height: frame.length, button: "left" } as never),
    { handled: true, focus: true, render: true },
  );
  assert.deepEqual(
    picker.handleMouse({ type: "click", x: 3, y, width, height: frame.length, button: "left" } as never),
    { handled: true },
  );
  assert.deepEqual(result(), { kind: "open", notePath: "two.md", query: "" });
});

test("every split paste-marker boundary keeps controls out of delete and hard-close shortcuts", () => {
  const notes = Array.from({ length: 9 }, (_, index) => note(`note-${index}.md`));
  const pasteStart = "\u001b[200~";
  const pasteEnd = "\u001b[201~";

  for (let startSplit = 1; startSplit < pasteStart.length; startSplit += 1) {
    for (let endSplit = 1; endSplit < pasteEnd.length; endSplit += 1) {
      const { picker, result } = createPicker(notes);
      picker.handleInput(pasteStart.slice(0, startSplit));
      picker.handleInput(`${pasteStart.slice(startSplit)}note`);
      picker.handleInput("\u0004");
      picker.handleInput("\u0003");
      picker.handleInput(pasteEnd.slice(0, endSplit));
      picker.handleInput(pasteEnd.slice(endSplit));

      assert.equal(result(), undefined);
      assert.match(picker.render(100).join("\n"), /Search: .*note/u);

      picker.handleInput("\u0003");
      assert.equal((result() as { kind: string }).kind, "close");
    }
  }
});

test("sanitizes pasted search text before Input advances the cursor", () => {
  const notes = Array.from({ length: 9 }, (_, index) => note(`abcdXYZef-${index}.md`));
  const { picker, result } = createPicker(notes, { query: "abcdef" });
  picker.focused = true;
  const width = 100;
  const frame = picker.render(width);
  const searchRow = frame.findIndex((line) => line.includes("Search:"));
  assert.notEqual(searchRow, -1);
  assert.deepEqual(
    picker.handleMouse({ type: "press", x: 14, y: searchRow, width, height: frame.length, button: "left" } as never),
    { handled: true, focus: true },
  );

  picker.handleInput("\u001b[200~\u001b[31mXY\u001b[0m\u001b[201~");
  picker.handleInput("Z");
  picker.handleInput("\u0003");

  assert.deepEqual(result(), { kind: "close", selectedPath: "abcdXYZef-0.md", query: "abcdXYZef" });
});

test.each([
  { name: "plain IME text", data: "X\u202eY", expectedQuery: "abcdXYZef", kitty: false },
  { name: "Kitty printable text", data: "\u001b[8238u", expectedQuery: "abcdZef", kitty: true },
])("sanitizes $name before Input advances the cursor", ({ data, expectedQuery, kitty }) => {
  setKittyProtocolActive(kitty);
  const notes = Array.from({ length: 9 }, (_, index) => note(`${expectedQuery}-${index}.md`));
  const { picker, result } = createPicker(notes, { query: "abcdef" });
  picker.focused = true;
  const width = 100;
  const frame = picker.render(width);
  const searchRow = frame.findIndex((line) => line.includes("Search:"));
  assert.notEqual(searchRow, -1);
  assert.deepEqual(
    picker.handleMouse({ type: "press", x: 14, y: searchRow, width, height: frame.length, button: "left" } as never),
    { handled: true, focus: true },
  );

  picker.handleInput(data);
  picker.handleInput("Z");
  picker.handleInput("\u0003");

  assert.deepEqual(result(), { kind: "close", selectedPath: `${expectedQuery}-0.md`, query: expectedQuery });
});

test("Escape returns Back and Ctrl+C remains a hard Close under remapped cancellation", () => {
  vi.useFakeTimers();
  const remapped = { "tui.select.cancel": ["ctrl+q"] };
  const back = createPicker([note("one.md")], { bindings: remapped });
  back.picker.handleInput("\u001b");
  assert.equal(back.result(), undefined);
  vi.runAllTimers();
  assert.deepEqual(back.result(), { kind: "back", selectedPath: "one.md" });

  const close = createPicker([note("one.md")], { bindings: remapped });
  close.picker.handleInput("\u0003");
  assert.deepEqual(close.result(), { kind: "close", selectedPath: "one.md" });
});

test("disposing clears a buffered paste prefix without dispatching it", () => {
  vi.useFakeTimers();
  const { picker, result } = createPicker([note("one.md")]);

  picker.handleInput("\u001b");
  picker.dispose();
  vi.runAllTimers();

  assert.equal(result(), undefined);
});

const deleteKeyCases: readonly {
  name: string;
  deleteKeys: readonly string[];
  reserved: Record<string, readonly string[]>;
  search: boolean;
  expected: string;
}[] = [
  {
    name: "normalizes aliases before checking standard controls",
    deleteKeys: ["return", "f6"],
    reserved: { "tui.select.confirm": ["enter"] },
    search: false,
    expected: "f6",
  },
  {
    name: "normalizes modifier order before checking collisions",
    deleteKeys: ["shift+ctrl+p", "f7"],
    reserved: { "tui.select.up": ["ctrl+shift+p"] },
    search: false,
    expected: "f7",
  },
  {
    name: "skips invalid configured strings",
    deleteKeys: ["meta+x", "ctrl+ctrl+x", "f8"],
    reserved: {},
    search: false,
    expected: "f8",
  },
  {
    name: "skips printable search collisions",
    deleteKeys: ["d", "shift+d", "ctrl+x"],
    reserved: {},
    search: true,
    expected: "ctrl+x",
  },
  {
    name: "reserves active editor bindings while searching",
    deleteKeys: ["backspace", "f9"],
    reserved: { "tui.editor.deleteCharBackward": ["backspace"] },
    search: true,
    expected: "f9",
  },
  {
    name: "reserves hard Escape even when configured cancellation is remapped",
    deleteKeys: ["escape", "f10"],
    reserved: { "tui.select.cancel": ["ctrl+q"] },
    search: false,
    expected: "f10",
  },
  {
    name: "reserves raw newline while searching",
    deleteKeys: ["ctrl+j", "f11"],
    reserved: { "tui.input.submit": [] },
    search: true,
    expected: "f11",
  },
];

test.each(deleteKeyCases)("resolves delete key: $name", ({ deleteKeys, reserved, search, expected }) => {
  const keys = keybindings({ ...reserved, "app.session.delete": deleteKeys });
  assert.equal(resolveNoteDeleteKey(keys as never, search), expected);
});

test("legacy, Kitty, and modifyOtherKeys modes resolve live matcher collisions independently", () => {
  const bindings = {
    "app.session.delete": ["alt+b", "f9"],
    "tui.editor.cursorWordLeft": ["alt+left"],
  };
  const keys = keybindings(bindings);

  setKittyProtocolActive(false);
  assert.equal(resolveNoteDeleteKey(keys as never, true), "f9");
  setKittyProtocolActive(true);
  assert.equal(resolveNoteDeleteKey(keys as never, true), "alt+b");

  setKittyProtocolActive(false);
  const notes = Array.from({ length: 9 }, (_, index) => note(`note-${index}.md`));
  const { picker, result } = createPicker(notes, { bindings, modifyOtherKeysActive: true });
  assert.match(picker.render(100).join("\n"), /alt\+b delete/iu);
  picker.handleInput("\u001b[27;3;98~");
  assert.deepEqual(result(), {
    kind: "delete",
    notePath: "note-0.md",
    nextSelectedPath: "note-1.md",
    query: "",
  });
});

test("paste-prefix routing rejects a split legacy delete encoding but retains its Kitty encoding", () => {
  const bindings = { "app.session.delete": ["ctrl+alt+[", "f12"] };
  const keys = keybindings(bindings);

  setKittyProtocolActive(false);
  assert.equal(resolveNoteDeleteKey(keys as never, false), "f12");
  const { picker, result } = createPicker([note("one.md"), note("two.md")], { bindings });
  assert.match(picker.render(100).join("\n"), /f12 delete/iu);
  picker.handleInput("\u001b[24~");
  assert.deepEqual(result(), { kind: "delete", notePath: "one.md", nextSelectedPath: "two.md", query: "" });

  setKittyProtocolActive(true);
  assert.equal(resolveNoteDeleteKey(keys as never, false), "alt+ctrl+[");
});
