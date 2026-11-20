import type { KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import {
  decodeKittyPrintable,
  Editor,
  type Keybinding,
  matchesKey,
  type TUI,
  type TuiMouseEvent,
} from "@earendil-works/pi-tui";
import { sanitizeTerminalDocument } from "@narumitw/pi-tui-kit";
import { diffChars } from "diff";

const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";

// Pi handles these before newline and submit. This editor does not configure autocomplete.
const EDIT_ACTIONS_BEFORE_SUBMIT: readonly Keybinding[] = [
  "tui.input.copy",
  "tui.editor.undo",
  "tui.input.tab",
  "tui.editor.deleteToLineEnd",
  "tui.editor.deleteToLineStart",
  "tui.editor.deleteWordBackward",
  "tui.editor.deleteWordForward",
  "tui.editor.deleteCharBackward",
  "tui.editor.deleteCharForward",
  "tui.editor.yank",
  "tui.editor.yankPop",
  "tui.editor.historyPrevious",
  "tui.editor.historyNext",
  "tui.editor.cursorLineStart",
  "tui.editor.cursorLineEnd",
  "tui.editor.cursorWordLeft",
  "tui.editor.cursorWordRight",
];
const NAVIGATION_BEFORE_JUMP: readonly Keybinding[] = [
  "tui.editor.cursorUp",
  "tui.editor.cursorDown",
  "tui.editor.cursorRight",
  "tui.editor.cursorLeft",
  "tui.editor.pageUp",
  "tui.editor.pageDown",
];

interface DraftActions {
  back(): void;
  cancel(): void;
  save(readDraft: () => string): void;
}

export function createPromptHintEditor(
  tui: TUI,
  theme: Theme,
  keybindings: KeybindingsManager,
  initialText: string,
  actions: DraftActions,
) {
  const muted = (text: string) => theme.fg("muted", text);
  const editorTheme = {
    borderColor: (text: string) => theme.fg("borderMuted", text),
    selectList: {
      selectedPrefix: (text: string) => theme.fg("accent", text),
      selectedText: (text: string) => theme.fg("accent", text),
      description: muted,
      scrollInfo: muted,
      noMatch: muted,
    },
  };
  const editor = new Editor(tui, editorTheme);
  editor.disableSubmit = true;
  editor.setText(initialText);
  const initialDraft = editor.getExpandedText();
  let pasteBuffer: string | undefined;
  let awaitingJumpTarget = false;
  const displaySafe = () => sanitizeTerminalDocument(editor.getText()) === editor.getText();

  function handleInput(data: string) {
    const start = data.indexOf(PASTE_START);
    if (start >= 0 && pasteBuffer === undefined) {
      if (awaitingJumpTarget) {
        // A bracketed paste cancels Pi's pending character jump.
        editor.handleInput(PASTE_START + PASTE_END);
        awaitingJumpTarget = false;
      }
      pasteBuffer = "";
      data = data.slice(start + PASTE_START.length);
    }
    if (pasteBuffer !== undefined) {
      const searchFrom = Math.max(0, pasteBuffer.length - PASTE_END.length + 1);
      pasteBuffer += data;
      const end = pasteBuffer.indexOf(PASTE_END, searchFrom);
      if (end === -1) return;
      // Decode and filter the paste like Pi does, but use an empty editor so Pi's
      // large-paste marker cannot match literal text in the prompt draft.
      const decoder = new Editor(tui, editorTheme);
      decoder.handleInput(PASTE_START + pasteBuffer.slice(0, end) + PASTE_END);
      let pasted = decoder.getExpandedText();
      const { line, col } = editor.getCursor();
      if (/^[/~.]/u.test(pasted) && /\w/u.test(editor.getLines()[line]?.charAt(col - 1) ?? "")) pasted = ` ${pasted}`;
      editor.insertTextAtCursor(pasted);
      const tail = pasteBuffer.slice(end + PASTE_END.length);
      pasteBuffer = undefined;
      if (tail) handleInput(tail);
      return;
    }
    if (matchesKey(data, "ctrl+c")) {
      actions.cancel();
      return;
    }
    if (keybindings.matches(data, "tui.select.cancel")) {
      actions.back();
      return;
    }

    const jump =
      keybindings.matches(data, "tui.editor.jumpForward") || keybindings.matches(data, "tui.editor.jumpBackward");
    const wasAwaitingJumpTarget = awaitingJumpTarget;
    awaitingJumpTarget = false;
    if (wasAwaitingJumpTarget && (jump || isPrintableInput(data))) {
      editor.handleInput(data);
      return;
    }
    if (
      EDIT_ACTIONS_BEFORE_SUBMIT.some((action) => keybindings.matches(data, action)) ||
      matchesKey(data, "shift+backspace") ||
      matchesKey(data, "shift+delete")
    ) {
      editor.handleInput(data);
      return;
    }

    const submit = keybindings.matches(data, "tui.input.submit");
    const newline =
      keybindings.matches(data, "tui.input.newLine") ||
      data.startsWith("\n") ||
      data === "\x1b[13;2~" ||
      (data.includes("\x1b") && data.includes("\r"));
    if (!submit && !newline) {
      awaitingJumpTarget = jump && !NAVIGATION_BEFORE_JUMP.some((action) => keybindings.matches(data, action));
      editor.handleInput(data);
      return;
    }

    const { line, col } = editor.getCursor();
    const lines = editor.getLines();
    const backslash = lines[line]?.charAt(col - 1) === "\\";
    const fallbackSubmit =
      newline &&
      matchesKey(data, "enter") &&
      backslash &&
      keybindings.getKeys("tui.input.submit").some((key) => key === "shift+enter" || String(key) === "shift+return");
    if (newline && !fallbackSubmit) {
      editor.handleInput(data);
      return;
    }
    if (!newline && backslash) {
      // This native submit branch removes the backslash and inserts a newline.
      editor.disableSubmit = false;
      try {
        editor.handleInput(data);
      } finally {
        editor.disableSubmit = true;
      }
      return;
    }

    if (wasAwaitingJumpTarget) editor.handleInput(PASTE_START + PASTE_END);
    // Native submit clears Undo. Read the draft without submitting it to Pi.
    const offset = fallbackSubmit ? lines.slice(0, line).reduce((sum, text) => sum + text.length + 1, col - 1) : -1;
    const raw = editor.getExpandedText();
    const draft = offset === -1 ? raw : raw.slice(0, offset) + raw.slice(offset + 1);
    if (draft === initialDraft && initialDraft !== initialText) {
      actions.back();
      return;
    }
    actions.save(() => restoreUnchangedTabs(initialText, initialDraft, draft));
  }

  return {
    get focused() {
      return editor.focused;
    },
    set focused(value: boolean) {
      editor.focused = value;
    },
    get pasting() {
      return pasteBuffer !== undefined;
    },
    render: (width: number) =>
      displaySafe()
        ? editor.render(width)
        : [theme.fg("warning", "Draft contains unsafe terminal text. Undo or edit it.")],
    invalidate: () => editor.invalidate(),
    handleInput,
    handleMouse: (event: TuiMouseEvent) => (displaySafe() ? editor.handleMouse(event) : undefined),
  };
}

function isPrintableInput(data: string): boolean {
  if (data.charCodeAt(0) >= 32 || decodeKittyPrintable(data) !== undefined) return true;
  // xterm modifyOtherKeys encodes unmodified or Shift-modified printable input as CSI 27;mod;code~.
  const prefix = "\x1b[27;";
  if (!data.startsWith(prefix)) return false;
  const match = /^(\d+);(\d+)~$/u.exec(data.slice(prefix.length));
  if (!match) return false;
  const modifiers = (Number(match[1]) - 1) & ~(64 | 128);
  const codePoint = Number(match[2]);
  return (modifiers === 0 || modifiers === 1) && codePoint >= 32 && codePoint <= 0x10ffff;
}

function restoreUnchangedTabs(original: string, initialDraft: string, draft: string): string {
  if (!original.includes("\t")) return draft;
  const tabWidth = 4;
  const tabs = Array.from(original.matchAll(/\t/gu), (match, index) => match.index + index * (tabWidth - 1));
  const changes = diffChars(initialDraft, draft, { timeout: 200 });
  if (!changes) throw new Error("This edit is too large to preserve tabs. Edit pi-inline.json directly.");

  let sourceOffset = 0;
  let tabIndex = 0;
  const output: string[] = [];
  for (const { added, removed, value } of changes) {
    if (added) {
      output.push(value);
      continue;
    }
    const end = sourceOffset + value.length;
    if (!removed) {
      let from = 0;
      for (; tabIndex < tabs.length && tabs[tabIndex] + tabWidth <= end; tabIndex++) {
        const start = tabs[tabIndex] - sourceOffset;
        if (start < 0) continue;
        output.push(value.slice(from, start), "\t");
        from = start + tabWidth;
      }
      output.push(value.slice(from));
    }
    while (tabIndex < tabs.length && tabs[tabIndex] < end) tabIndex++;
    sourceOffset = end;
  }
  return output.join("");
}
