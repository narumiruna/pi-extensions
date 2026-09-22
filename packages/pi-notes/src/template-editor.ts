import type { ExtensionCommandContext, KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import {
  type Component,
  Editor,
  type EditorTheme,
  type Focusable,
  Key,
  matchesKey,
  parseKey,
  type TUI,
  type TuiMouseEvent,
  type TuiMouseEventResult,
  truncateToWidth,
} from "@earendil-works/pi-tui";
import { runCustomInteraction } from "@narumitw/pi-tui-kit/custom-interaction";
import { sanitizeTerminalText } from "@narumitw/pi-tui-kit/terminal-text";
import type { TemplateSnapshot } from "./storage.js";

const BRACKETED_PASTE_START = "\u001b[200~";
const BRACKETED_PASTE_END = "\u001b[201~";
const PASTE_TAIL_SETTLE_MS = 50;

interface TemplateEditorOwnership {
  signal: AbortSignal;
  isCurrent(): boolean;
}

export async function showTemplateEditor(
  ctx: ExtensionCommandContext,
  template: TemplateSnapshot,
  ownership: TemplateEditorOwnership,
): Promise<string | undefined> {
  const result = await runCustomInteraction<string | undefined>(ctx, {
    signal: ownership.signal,
    isCurrent: ownership.isCurrent,
    create: ({ tui, theme, keybindings, complete }) =>
      new TemplateEditor({
        tui,
        theme,
        keybindings,
        title: `Edit template · ${sanitizeTerminalText(template.relativePath)}`,
        content: template.content,
        onDone: complete,
      }),
  });
  if (result.kind === "error") throw result.error;
  return result.kind === "completed" ? result.value : undefined;
}

interface TemplateEditorOptions {
  tui: TUI;
  theme: Theme;
  keybindings: KeybindingsManager;
  title: string;
  content: string;
  onDone(value: string | undefined): void;
}

class TemplateEditor implements Component, Focusable {
  private readonly tui: TUI;
  private readonly theme: Theme;
  private readonly keybindings: KeybindingsManager;
  private readonly editor: RawPreservingEditor;
  private readonly title: string;
  private readonly onDone: (value: string | undefined) => void;
  private editorStartRow = 1;
  private editorRows = 0;
  private deferredPasteInputs: string[] = [];
  private pasteTailTimer: ReturnType<typeof setTimeout> | undefined;
  private pendingPasteWork: Promise<void> | undefined;
  private resolvePendingPasteWork: (() => void) | undefined;
  private finished = false;
  private _focused = false;

  constructor(options: TemplateEditorOptions) {
    this.tui = options.tui;
    this.theme = options.theme;
    this.keybindings = options.keybindings;
    this.title = options.title;
    this.onDone = options.onDone;
    const editorTheme: EditorTheme = {
      borderColor: (text) => this.theme.fg("accent", text),
      selectList: {
        selectedPrefix: (text) => this.theme.fg("accent", text),
        selectedText: (text) => this.theme.fg("accent", text),
        description: (text) => this.theme.fg("muted", text),
        scrollInfo: (text) => this.theme.fg("dim", text),
        noMatch: (text) => this.theme.fg("warning", text),
      },
    };
    this.editor = new RawPreservingEditor(this.tui, editorTheme);
    this.editor.setText(options.content);
  }

  get focused(): boolean {
    return this._focused;
  }

  set focused(value: boolean) {
    this._focused = value;
    this.editor.focused = value;
  }

  render(width: number): string[] {
    const safeWidth = Math.max(1, width);
    const title = truncateToWidth(this.theme.fg("accent", this.theme.bold(this.title)), safeWidth);
    const warnings: string[] = [];
    const pasteError = this.editor.getPasteError();
    if (pasteError) warnings.push(truncateToWidth(this.theme.fg("error", pasteError), safeWidth));
    if (this.editor.hasHiddenCharacters()) {
      warnings.push(
        truncateToWidth(
          this.theme.fg("warning", "Terminal controls are hidden as spaces and preserved unless removed."),
          safeWidth,
        ),
      );
    }
    const editorLines = this.editor.render(safeWidth);
    this.editorStartRow = 1 + warnings.length;
    this.editorRows = editorLines.length;
    const hint = truncateToWidth(this.theme.fg("muted", this.hintText()), safeWidth);
    return [title, ...warnings, ...editorLines, hint];
  }

  handleInput(data: string): void {
    if (this.finished) return;
    if (this.editor.hasPendingPaste) {
      this.handlePendingPasteInput(data);
      return;
    }
    this.dispatchInput(data);
  }

  async waitForPending(): Promise<void> {
    for (;;) {
      const pending = this.pendingPasteWork;
      if (!pending) return;
      await pending;
    }
  }

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    if (event.y < this.editorStartRow || event.y >= this.editorStartRow + this.editorRows) {
      return { handled: true, focus: true };
    }
    return this.editor.handleMouse({
      ...event,
      y: event.y - this.editorStartRow,
      height: Math.max(1, this.editorRows),
    });
  }

  invalidate(): void {
    this.editor.invalidate();
  }

  dispose(): void {
    this.finished = true;
    this.cancelPendingPasteWork();
    this.editor.dispose();
  }

  private dispatchInput(data: string): void {
    if (this.editor.isPasting || data.includes(BRACKETED_PASTE_START) || data.includes(BRACKETED_PASTE_END)) {
      const remaining = this.editor.handleInput(data);
      this.tui.requestRender();
      if (remaining) this.handleInput(remaining);
      return;
    }
    if (matchesKey(data, Key.ctrl("c")) || this.keybindings.matches(data, "tui.select.cancel")) {
      this.finish(undefined);
      return;
    }
    if (isEditorNewlineInput(data, this.keybindings)) {
      this.editor.handleInput(data);
      this.tui.requestRender();
      return;
    }
    if (this.keybindings.matches(data, "tui.input.submit")) {
      if (this.editor.hasBackslashBeforeCursor()) {
        this.editor.replaceBackslashWithNewline();
        this.tui.requestRender();
        return;
      }
      this.finish(this.editor.getExpandedText());
      return;
    }
    this.editor.handleInput(data);
    this.tui.requestRender();
  }

  private handlePendingPasteInput(data: string): void {
    if (data.includes(BRACKETED_PASTE_START) || data.includes(BRACKETED_PASTE_END)) {
      const resolve = this.detachPendingPasteWork();
      this.deferredPasteInputs = [];
      this.editor.rejectPendingPaste();
      this.tui.requestRender();
      resolve?.();
      return;
    }
    this.deferredPasteInputs.push(data);
    this.armPasteTailTimer();
  }

  private armPasteTailTimer(): void {
    if (!this.pendingPasteWork) {
      this.pendingPasteWork = new Promise<void>((resolve) => {
        this.resolvePendingPasteWork = resolve;
      });
    }
    if (this.pasteTailTimer) clearTimeout(this.pasteTailTimer);
    this.pasteTailTimer = setTimeout(() => this.flushPendingPasteInputs(), PASTE_TAIL_SETTLE_MS);
  }

  private flushPendingPasteInputs(): void {
    const resolve = this.detachPendingPasteWork();
    const inputs = this.deferredPasteInputs;
    this.deferredPasteInputs = [];
    this.editor.commitPendingPaste();
    for (const input of inputs) {
      if (this.finished) break;
      this.dispatchInput(input);
    }
    resolve?.();
  }

  private cancelPendingPasteWork(): void {
    const resolve = this.detachPendingPasteWork();
    this.deferredPasteInputs = [];
    resolve?.();
  }

  private detachPendingPasteWork(): (() => void) | undefined {
    if (this.pasteTailTimer) clearTimeout(this.pasteTailTimer);
    this.pasteTailTimer = undefined;
    const resolve = this.resolvePendingPasteWork;
    this.resolvePendingPasteWork = undefined;
    this.pendingPasteWork = undefined;
    return resolve;
  }

  private finish(value: string | undefined): void {
    if (this.finished) return;
    this.finished = true;
    this.cancelPendingPasteWork();
    this.editor.dispose();
    this.onDone(value);
  }

  private hintText(): string {
    const groups = [
      keyHint(this.keybindings, "tui.input.submit", "save"),
      keyHint(this.keybindings, "tui.input.newLine", "newline"),
      cancelHint(this.keybindings),
    ].filter(Boolean);
    return groups.join("  ");
  }
}

class RawPreservingEditor implements Focusable {
  private editor: Editor;
  private readonly rawByMarker = new Map<string, string>();
  private markerCodePoint = 0xe000;
  private pasteBuffer: string | undefined;
  private pasteSnapshot: string | undefined;
  private pasteError: string | undefined;

  constructor(
    private readonly tui: TUI,
    private readonly theme: EditorTheme,
  ) {
    this.editor = this.createEditor();
  }

  get focused(): boolean {
    return this.editor.focused;
  }

  set focused(value: boolean) {
    this.editor.focused = value;
  }

  get isPasting(): boolean {
    return this.pasteBuffer !== undefined;
  }

  get hasPendingPaste(): boolean {
    return this.pasteSnapshot !== undefined;
  }

  handleInput(data: string): string | undefined {
    if (this.pasteBuffer !== undefined) {
      this.pasteBuffer += data;
      return this.flushPasteBuffer();
    }
    const pasteStart = data.indexOf(BRACKETED_PASTE_START);
    if (pasteStart >= 0) {
      if (pasteStart > 0) this.handleInput(data.slice(0, pasteStart));
      this.pasteSnapshot = this.getExpandedText();
      this.pasteError = undefined;
      this.pasteBuffer = data.slice(pasteStart + BRACKETED_PASTE_START.length);
      return this.flushPasteBuffer();
    }
    if (data.includes(BRACKETED_PASTE_END) && this.pasteSnapshot !== undefined) {
      this.rejectPendingPaste();
      return undefined;
    }
    this.pasteError = undefined;
    if (
      parseKey(data) === undefined &&
      [...data].some((character) => isUnsafeEditorCharacter(character) || this.rawByMarker.has(character))
    ) {
      this.editor.handleInput(this.encode(data));
      return undefined;
    }
    this.editor.handleInput(data);
    return undefined;
  }

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    return this.editor.handleMouse(event);
  }

  render(width: number): string[] {
    return this.editor
      .render(width)
      .map((line) => [...line].map((character) => (this.rawByMarker.has(character) ? " " : character)).join(""));
  }

  invalidate(): void {
    this.editor.invalidate();
  }

  setText(value: string): void {
    this.rawByMarker.clear();
    this.markerCodePoint = 0xe000;
    this.pasteBuffer = undefined;
    this.pasteSnapshot = undefined;
    this.pasteError = undefined;
    this.editor.setText(this.encode(value));
  }

  getExpandedText(): string {
    return this.decode(this.editor.getExpandedText());
  }

  getPasteError(): string | undefined {
    return this.pasteError;
  }

  hasHiddenCharacters(): boolean {
    return [...this.editor.getExpandedText()].some((character) => this.rawByMarker.has(character));
  }

  hasBackslashBeforeCursor(): boolean {
    const cursor = this.editor.getCursor();
    const line = this.editor.getLines()[cursor.line] ?? "";
    return cursor.col > 0 && line[cursor.col - 1] === "\\";
  }

  replaceBackslashWithNewline(): void {
    this.editor.handleInput(Key.backspace);
    this.editor.handleInput("\u001b\r");
  }

  commitPendingPaste(): void {
    this.pasteSnapshot = undefined;
  }

  rejectPendingPaste(): void {
    const snapshot = this.pasteSnapshot;
    if (snapshot === undefined) return;
    this.restorePasteSnapshot(snapshot);
    this.pasteError = "Paste rejected because it contains an ambiguous bracketed-paste terminator.";
  }

  dispose(): void {
    this.editor.focused = false;
    this.pasteBuffer = undefined;
    this.pasteSnapshot = undefined;
  }

  private flushPasteBuffer(): string | undefined {
    if (this.pasteBuffer === undefined) return undefined;
    const pasteEnd = this.pasteBuffer.indexOf(BRACKETED_PASTE_END);
    if (pasteEnd < 0) return undefined;
    if (this.pasteBuffer.includes(BRACKETED_PASTE_END, pasteEnd + BRACKETED_PASTE_END.length)) {
      this.rejectPendingPaste();
      return undefined;
    }
    const raw = this.pasteBuffer.slice(0, pasteEnd);
    const remaining = this.pasteBuffer.slice(pasteEnd + BRACKETED_PASTE_END.length);
    this.pasteBuffer = undefined;
    this.editor.handleInput(`${BRACKETED_PASTE_START}${this.encode(raw)}${BRACKETED_PASTE_END}`);
    return remaining || undefined;
  }

  private restorePasteSnapshot(value: string): void {
    const focused = this.editor.focused;
    this.rawByMarker.clear();
    this.markerCodePoint = 0xe000;
    this.pasteBuffer = undefined;
    this.pasteSnapshot = undefined;
    this.pasteError = undefined;
    this.editor = this.createEditor();
    this.editor.focused = focused;
    this.editor.setText(this.encode(value));
  }

  private createEditor(): Editor {
    const editor = new Editor(this.tui, this.theme, { paddingX: 0 });
    editor.disableSubmit = true;
    return editor;
  }

  private encode(value: string): string {
    const forbidden = new Set([...value, ...this.editor.getExpandedText(), ...this.rawByMarker.keys()]);
    return [...value]
      .map((character) => {
        if (!isUnsafeEditorCharacter(character) && !this.rawByMarker.has(character)) return character;
        const marker = this.nextMarker(forbidden);
        this.rawByMarker.set(marker, character);
        forbidden.add(marker);
        return marker;
      })
      .join("");
  }

  private decode(value: string): string {
    return [...value].map((character) => this.rawByMarker.get(character) ?? character).join("");
  }

  private nextMarker(forbidden: ReadonlySet<string>): string {
    for (;;) {
      if (this.markerCodePoint === 0xf900) this.markerCodePoint = 0xf0000;
      if (this.markerCodePoint === 0xffffe) this.markerCodePoint = 0x100000;
      if (this.markerCodePoint > 0x10fffd) throw new Error("Template editor exhausted its safe input markers");
      const marker = String.fromCodePoint(this.markerCodePoint++);
      if (!forbidden.has(marker)) return marker;
    }
  }
}

function isEditorNewlineInput(data: string, keybindings: KeybindingsManager): boolean {
  return (
    keybindings.matches(data, "tui.input.newLine") ||
    (data.charCodeAt(0) === 10 && data.length > 1) ||
    data === "\u001b\r" ||
    data === "\u001b[13;2~" ||
    (data.length > 1 && data.includes("\u001b") && data.includes("\r")) ||
    data === "\n"
  );
}

function keyHint(
  keybindings: KeybindingsManager,
  binding: "tui.input.submit" | "tui.input.newLine",
  label: string,
): string {
  const keys = keybindings.getKeys(binding);
  return keys.length > 0 ? `${sanitizeTerminalText(keys.join("/"))} ${label}` : "";
}

function cancelHint(keybindings: KeybindingsManager): string {
  const keys = [...new Set([...keybindings.getKeys("tui.select.cancel"), "ctrl+c"])];
  return `${sanitizeTerminalText(keys.join("/"))} cancel`;
}

function isUnsafeEditorCharacter(character: string): boolean {
  const codePoint = character.codePointAt(0) ?? 0;
  return (
    character !== "\n" &&
    (codePoint <= 0x1f ||
      (codePoint >= 0x7f && codePoint <= 0x9f) ||
      codePoint === 0x2028 ||
      codePoint === 0x2029 ||
      isBidiControl(codePoint))
  );
}

function isBidiControl(codePoint: number): boolean {
  return (
    codePoint === 0x061c ||
    codePoint === 0x200e ||
    codePoint === 0x200f ||
    (codePoint >= 0x202a && codePoint <= 0x202e) ||
    (codePoint >= 0x2066 && codePoint <= 0x2069)
  );
}
