import type { KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import {
  type Component,
  type Focusable,
  fuzzyFilter,
  Input,
  Key,
  type KeyId,
  matchesKey,
  type TUI,
  TUI_KEYBINDINGS,
  type TuiMouseEvent,
  type TuiMouseEventResult,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { formatInteractionHints, HorizontalRule, renderBoundedFrame, sanitizeTerminalText } from "@narumitw/pi-tui-kit";
import type { MarkdownEntry } from "./storage.js";

const BRACKETED_PASTE_START = "\u001b[200~";
const BRACKETED_PASTE_END = "\u001b[201~";
const MAX_SEARCH_QUERY_LENGTH = 256;
const MAX_VISIBLE_NOTES = 12;

const MODIFIERS = ["shift", "alt", "ctrl", "super"] as const;
const SYMBOLS = "`-=[]\\;',./!@#$%^&*()_|~{}:<>?";
const SPECIAL_KEYS = new Set([
  "escape",
  "enter",
  "tab",
  "space",
  "backspace",
  "insert",
  "delete",
  "clear",
  "home",
  "end",
  "pageup",
  "pagedown",
  "left",
  "right",
  "up",
  "down",
]);
const FUNCTION_INPUTS = ["OP", "OQ", "OR", "OS", "[15~", "[17~", "[18~", "[19~", "[20~", "[21~", "[23~", "[24~"];
const LEGACY_INPUTS = [
  ...Array.from({ length: 128 }, (_, code) => String.fromCharCode(code)),
  ...Array.from({ length: 128 }, (_, code) => `\u001b${String.fromCharCode(code)}`),
  "\u001b[Z",
  "\u001bOM",
  "\u001b[E",
  "\u001b[e",
  "\u001bOe",
  ...FUNCTION_INPUTS.map((suffix) => `\u001b${suffix}`),
];
const SPECIAL_CODEPOINTS: Record<string, number> = {
  escape: 27,
  tab: 9,
  enter: 13,
  space: 32,
  backspace: 127,
  insert: 57425,
  delete: 57426,
  home: 57423,
  end: 57424,
  pageup: 57421,
  pagedown: 57422,
  left: 57417,
  right: 57418,
  up: 57419,
  down: 57420,
};

export type NotePickerResult =
  | { kind: "open"; notePath: string; query?: string }
  | { kind: "delete"; notePath: string; nextSelectedPath?: string; query?: string }
  | { kind: "back"; selectedPath?: string; query?: string }
  | { kind: "close"; selectedPath?: string; query?: string };

interface NotePickerOptions {
  tui: TUI;
  theme: Theme;
  keybindings: KeybindingsManager;
  notes: readonly MarkdownEntry[];
  lines?: readonly string[];
  initialSelectedPath?: string;
  initialQuery?: string;
  complete(result: NotePickerResult): void;
}

interface MouseLayout {
  width: number;
  inputFrameRow?: number;
  noteByFrameRow: ReadonlyMap<number, number>;
}

export class NotePicker implements Component, Focusable {
  private readonly searchInput = new Input();
  private readonly searchEnabled: boolean;
  private filteredNotes: MarkdownEntry[];
  private selectedPath: string | undefined;
  private restoreSelectedPath: string | undefined;
  private scrollOffset = 0;
  private pasteActive = false;
  private mousePressedIndex: number | undefined;
  private mouseLayout: MouseLayout | undefined;
  private disposed = false;
  private completed = false;
  private isFocused = false;

  constructor(private readonly options: NotePickerOptions) {
    this.searchEnabled = options.notes.length > 8;
    this.searchInput.setValue(sanitizeTerminalText(options.initialQuery ?? ""));
    this.searchInput.focused = false;
    this.filteredNotes = this.filterNotes();
    this.selectedPath = this.filteredNotes.some(({ relativePath }) => relativePath === options.initialSelectedPath)
      ? options.initialSelectedPath
      : this.filteredNotes[0]?.relativePath;
  }

  get focused(): boolean {
    return this.isFocused;
  }

  set focused(value: boolean) {
    this.isFocused = value;
    this.searchInput.focused = value && this.searchEnabled && !this.disposed;
  }

  render(width: number): string[] {
    const safeWidth = Math.max(1, Math.floor(width));
    const viewportSize = this.viewportSize();
    this.keepSelectionVisible(viewportSize);
    const visible = this.filteredNotes.slice(this.scrollOffset, this.scrollOffset + viewportSize);
    const rows = visible.map((note) => this.renderNote(note, note.relativePath === this.selectedPath, safeWidth));
    const content: string[] = [];
    let selectedContentIndex: number | undefined;

    if (this.searchEnabled) {
      content.push(this.renderSearch(safeWidth), "");
    }
    const listStart = content.length;
    if (rows.length > 0) {
      content.push(...rows);
      const selectedVisibleIndex = visible.findIndex(({ relativePath }) => relativePath === this.selectedPath);
      if (selectedVisibleIndex >= 0) selectedContentIndex = listStart + selectedVisibleIndex;
    } else {
      content.push(
        this.options.theme.fg(
          this.queryTooLong() ? "error" : "dim",
          this.queryTooLong()
            ? `  Search query is too long (maximum ${MAX_SEARCH_QUERY_LENGTH} characters)`
            : this.options.notes.length === 0
              ? "  No notes found."
              : "  No matching notes.",
        ),
      );
      selectedContentIndex = content.length - 1;
    }
    if (this.filteredNotes.length > viewportSize) {
      const selectedIndex = this.selectedIndex();
      content.push(this.options.theme.fg("dim", `  (${selectedIndex + 1}/${this.filteredNotes.length})`));
    }
    if (this.searchEnabled) content.push(this.options.theme.fg("dim", "Type to search"));

    const hint = this.interactionHint();
    const hintRows = wrapTextWithAnsi(this.options.theme.fg("dim", hint), safeWidth);
    const title = this.options.theme.fg("accent", this.options.theme.bold("Open a note"));
    const context = (this.options.lines ?? []).map((line) =>
      this.options.theme.fg("muted", sanitizeTerminalText(line)),
    );
    const rule =
      new HorizontalRule({ ruleStyle: (text) => this.options.theme.fg("border", text) }).render(safeWidth)[0] ?? "";
    const priorities = [
      ...(this.searchEnabled ? [0] : []),
      ...(selectedContentIndex === undefined ? [] : [selectedContentIndex]),
    ];
    const maxRows = Math.max(1, Math.floor(this.options.tui.terminal.rows) - 3);
    const frame = renderBoundedFrame({
      width: safeWidth,
      maxRows,
      rule,
      title: [title],
      context,
      content,
      hints: hintRows,
      compactHint: truncateToWidth(this.options.theme.fg("dim", hint), safeWidth, ""),
      priorityRows: priorities,
      focusedRow: selectedContentIndex,
    });
    const fullFrameRows = context.length + content.length + hintRows.length + 4;
    // Kit's compact frame does not expose public pointer-row metadata. Disable pointer routing there rather than
    // risk opening a different raw note identity; keyboard navigation remains available at every height.
    if (fullFrameRows <= maxRows) {
      const contentFrameStart = context.length + 3;
      this.mouseLayout = {
        width: safeWidth,
        ...(this.searchEnabled ? { inputFrameRow: contentFrameStart } : {}),
        noteByFrameRow: new Map(
          visible.map((_, index) => [contentFrameStart + listStart + index, this.scrollOffset + index]),
        ),
      };
    } else this.mouseLayout = undefined;
    return frame;
  }

  handleInput(data: string): void {
    if (this.disposed || this.completed) return;
    this.mousePressedIndex = undefined;
    this.mouseLayout = undefined;
    if (this.searchEnabled && this.consumePaste(data)) {
      this.applySearchInput(data);
      this.options.tui.requestRender();
      return;
    }
    if (matchesKey(data, Key.ctrl("c"))) {
      this.finish({ kind: "close", ...this.pickerState() });
      return;
    }
    if (matchesKey(data, Key.escape) || this.options.keybindings.matches(data, "tui.select.cancel")) {
      this.finish({ kind: "back", ...this.pickerState() });
      return;
    }
    if (this.options.keybindings.matches(data, "tui.select.up")) this.move(-1);
    else if (this.options.keybindings.matches(data, "tui.select.down")) this.move(1);
    else if (this.options.keybindings.matches(data, "tui.select.pageUp")) this.move(-this.viewportSize(), false);
    else if (this.options.keybindings.matches(data, "tui.select.pageDown")) this.move(this.viewportSize(), false);
    else if (matchesKey(data, Key.home)) this.selectAt(0);
    else if (matchesKey(data, Key.end)) this.selectAt(this.filteredNotes.length - 1);
    else if (this.options.keybindings.matches(data, "tui.select.confirm")) this.openSelected();
    else {
      const deleteKey = resolveNoteDeleteKey(this.options.keybindings, this.searchEnabled);
      if (deleteKey && matchesKey(data, deleteKey)) this.deleteSelected();
      else if (this.searchEnabled) this.applySearchInput(data);
    }
    if (!this.completed) this.options.tui.requestRender();
  }

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    if (this.disposed || this.completed || !this.mouseLayout || event.width !== this.mouseLayout.width) {
      return undefined;
    }
    if (event.y === this.mouseLayout.inputFrameRow) {
      const labelWidth = visibleWidth("Search: ");
      const inputWidth = Math.max(1, event.width - labelWidth);
      if (event.x < labelWidth || event.x >= labelWidth + inputWidth) return undefined;
      return this.searchInput.handleMouse({
        ...event,
        x: event.x - labelWidth,
        y: 0,
        width: inputWidth,
        height: 1,
      });
    }
    const mappedIndex = this.mouseLayout.noteByFrameRow.get(event.y);
    if (mappedIndex === undefined) return undefined;
    const noteIndex = event.type === "click" ? (this.mousePressedIndex ?? mappedIndex) : mappedIndex;
    if (noteIndex < 0 || noteIndex >= this.filteredNotes.length) return undefined;
    if (event.type === "wheel" && event.wheelDelta) {
      const next = Math.max(
        0,
        Math.min(this.filteredNotes.length - 1, this.selectedIndex() + (event.wheelDelta < 0 ? -1 : 1)),
      );
      const changed = next !== this.selectedIndex();
      if (changed) this.selectAt(next);
      return { handled: true, render: changed };
    }
    if (event.type === "move") return { handled: true };
    if (event.button !== "left") return undefined;
    if (event.type === "press") {
      this.mousePressedIndex = noteIndex;
      const changed = this.selectedIndex() !== noteIndex;
      if (changed) this.selectAt(noteIndex);
      return { handled: true, focus: true, render: changed };
    }
    if (event.type === "click") {
      this.mousePressedIndex = undefined;
      if (this.selectedIndex() !== noteIndex) this.selectAt(noteIndex);
      this.openSelected();
      return { handled: true };
    }
    return undefined;
  }

  invalidate(): void {
    this.mouseLayout = undefined;
    this.searchInput.invalidate();
  }

  dispose(): void {
    this.disposed = true;
    this.pasteActive = false;
    this.mousePressedIndex = undefined;
    this.mouseLayout = undefined;
    this.isFocused = false;
    this.searchInput.focused = false;
  }

  private renderSearch(width: number): string {
    const label = this.options.theme.fg("muted", "Search: ");
    const inputWidth = Math.max(1, width - visibleWidth(label));
    return truncateToWidth(`${label}${this.searchInput.render(inputWidth)[0] ?? ""}`, width, "");
  }

  private renderNote(note: MarkdownEntry, selected: boolean, width: number): string {
    const prefix = selected ? this.options.theme.fg("accent", "→ ") : "  ";
    const description = `${note.size} bytes`;
    const availableLabelWidth = Math.max(1, width - visibleWidth(prefix) - visibleWidth(description) - 2);
    const label = truncateToWidth(sanitizeTerminalText(note.displayPath), availableLabelWidth, "…");
    const spacing = " ".repeat(
      Math.max(1, width - visibleWidth(prefix) - visibleWidth(label) - visibleWidth(description)),
    );
    const line = truncateToWidth(
      `${prefix}${label}${this.options.theme.fg("muted", `${spacing}${description}`)}`,
      width,
      "",
    );
    return selected ? this.options.theme.bold(line) : line;
  }

  private interactionHint(): string {
    const deleteKey = resolveNoteDeleteKey(this.options.keybindings, this.searchEnabled);
    return formatInteractionHints(this.options.keybindings, [
      { bindings: ["tui.select.up", "tui.select.down"], label: "navigate" },
      { bindings: ["tui.select.confirm"], label: "open" },
      ...(deleteKey ? [{ keys: [deleteKey], label: "delete" }] : []),
      { bindings: ["tui.select.cancel"], keys: ["escape"], excludeKeys: ["ctrl+c"], label: "back" },
      { keys: ["ctrl+c"], label: "close" },
    ]);
  }

  private viewportSize(): number {
    const fixedRows = this.searchEnabled ? 9 : 6;
    return Math.max(1, Math.min(MAX_VISIBLE_NOTES, Math.floor(this.options.tui.terminal.rows) - fixedRows));
  }

  private query(): string {
    return this.searchEnabled ? this.searchInput.getValue() : "";
  }

  private queryTooLong(): boolean {
    return this.query().length > MAX_SEARCH_QUERY_LENGTH;
  }

  private filterNotes(): MarkdownEntry[] {
    const query = this.searchInput.getValue();
    if (!this.searchEnabled || !query.trim()) return [...this.options.notes];
    if (query.length > MAX_SEARCH_QUERY_LENGTH) return [];
    return fuzzyFilter([...this.options.notes], query, ({ displayPath }) => sanitizeTerminalText(displayPath));
  }

  private applySearchInput(data: string): void {
    const previousQuery = this.searchInput.getValue();
    this.searchInput.handleInput(data);
    const safeQuery = sanitizeTerminalText(this.searchInput.getValue());
    if (safeQuery !== this.searchInput.getValue()) this.searchInput.setValue(safeQuery);
    if (safeQuery === previousQuery) return;
    const previousSelection = this.selectedPath;
    this.filteredNotes = this.filterNotes();
    const restored = this.filteredNotes.find(({ relativePath }) => relativePath === this.restoreSelectedPath);
    const retained = this.filteredNotes.find(({ relativePath }) => relativePath === previousSelection);
    if (restored) {
      this.selectedPath = restored.relativePath;
      this.restoreSelectedPath = undefined;
    } else if (retained) this.selectedPath = retained.relativePath;
    else {
      if (previousSelection) this.restoreSelectedPath ??= previousSelection;
      this.selectedPath = this.filteredNotes[0]?.relativePath;
    }
    this.scrollOffset = 0;
  }

  private consumePaste(data: string): boolean {
    const wasActive = this.pasteActive;
    const starts = data.includes(BRACKETED_PASTE_START);
    if (starts) this.pasteActive = true;
    if (this.pasteActive && data.includes(BRACKETED_PASTE_END)) this.pasteActive = false;
    return wasActive || starts;
  }

  private selectedIndex(): number {
    return Math.max(
      0,
      this.filteredNotes.findIndex(({ relativePath }) => relativePath === this.selectedPath),
    );
  }

  private move(delta: number, wrap = true): void {
    if (this.filteredNotes.length === 0) return;
    const current = this.selectedIndex();
    const next = wrap
      ? (current + delta + this.filteredNotes.length) % this.filteredNotes.length
      : Math.max(0, Math.min(this.filteredNotes.length - 1, current + delta));
    this.selectAt(next);
  }

  private selectAt(index: number): void {
    if (this.filteredNotes.length === 0) return;
    const bounded = Math.max(0, Math.min(this.filteredNotes.length - 1, index));
    this.selectedPath = this.filteredNotes[bounded]?.relativePath;
    this.restoreSelectedPath = undefined;
  }

  private keepSelectionVisible(height: number): void {
    if (this.filteredNotes.length === 0) {
      this.scrollOffset = 0;
      return;
    }
    const index = this.selectedIndex();
    if (index < this.scrollOffset) this.scrollOffset = index;
    if (index >= this.scrollOffset + height) this.scrollOffset = index - height + 1;
    this.scrollOffset = Math.max(0, Math.min(this.scrollOffset, this.filteredNotes.length - height));
  }

  private openSelected(): void {
    if (!this.selectedPath) return;
    this.finish({ kind: "open", notePath: this.selectedPath, query: this.query() });
  }

  private deleteSelected(): void {
    if (!this.selectedPath) return;
    const selectedIndex = this.selectedIndex();
    const nextSelectedPath =
      this.filteredNotes[selectedIndex + 1]?.relativePath ?? this.filteredNotes[selectedIndex - 1]?.relativePath;
    this.finish({
      kind: "delete",
      notePath: this.selectedPath,
      ...(nextSelectedPath ? { nextSelectedPath } : {}),
      query: this.query(),
    });
  }

  private pickerState(): { selectedPath?: string; query?: string } {
    return {
      ...(this.selectedPath ? { selectedPath: this.selectedPath } : {}),
      ...(this.searchEnabled ? { query: this.query() } : {}),
    };
  }

  private finish(result: NotePickerResult): void {
    if (this.completed) return;
    this.completed = true;
    this.options.complete(result);
  }
}

/** Resolve the first effective delete binding that remains reachable in this picker. */
export function resolveNoteDeleteKey(
  keybindings: Pick<KeybindingsManager, "getKeys">,
  searchEnabled: boolean,
): KeyId | undefined {
  const reserved = [
    "ctrl+c",
    "home",
    "end",
    ...Object.keys(TUI_KEYBINDINGS).flatMap((binding) => {
      if (binding === "tui.editor.deleteCharForward") {
        return keybindings.getKeys(binding).filter((key) => normalizeKey(key) !== "ctrl+d");
      }
      return keybindings.getKeys(binding as keyof typeof TUI_KEYBINDINGS);
    }),
  ];
  for (const candidate of keybindings.getKeys("app.session.delete")) {
    const normalized = normalizeKey(candidate);
    if (!normalized || (searchEnabled && isTextKey(normalized))) continue;
    const inputs = inputsFor(normalized);
    if (inputs.length === 0) continue;
    if (reserved.some((other) => inputs.some((input) => matchesKey(input, other as KeyId)))) continue;
    return normalized as KeyId;
  }
  return undefined;
}

function normalizeKey(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > 80 || /[\s\p{Cc}]/u.test(value)) return undefined;
  const parts = value.toLowerCase().split("+");
  let base = parts.pop();
  if (!base) return undefined;
  if (base === "esc") base = "escape";
  if (base === "return") base = "enter";
  if (new Set(parts).size !== parts.length || parts.some((part) => !MODIFIERS.includes(part as never)))
    return undefined;
  if (
    !SPECIAL_KEYS.has(base) &&
    !/^f(?:[1-9]|1[0-2])$/u.test(base) &&
    !(base.length === 1 && (/^[a-z0-9]$/u.test(base) || SYMBOLS.includes(base)))
  )
    return undefined;
  if ((base === "escape" || /^f(?:[1-9]|1[0-2])$/u.test(base)) && parts.length > 0) return undefined;
  if (base === "clear" && (parts.length > 1 || (parts.length === 1 && !["ctrl", "shift"].includes(parts[0] ?? ""))))
    return undefined;
  return [...MODIFIERS.filter((modifier) => parts.includes(modifier)), base].join("+");
}

function inputsFor(key: string): string[] {
  const parts = key.split("+");
  const base = parts.pop() ?? "";
  const modifier = MODIFIERS.reduce((mask, part, bit) => mask | (parts.includes(part) ? 1 << bit : 0), 0);
  const code = SPECIAL_CODEPOINTS[base] ?? (base.length === 1 ? base.charCodeAt(0) : undefined);
  const inputs = code === undefined ? LEGACY_INPUTS : [...LEGACY_INPUTS, `\u001b[${code};${modifier + 1}u`];
  return inputs.filter((input) => matchesKey(input, key as KeyId));
}

function isTextKey(key: string): boolean {
  const parts = key.split("+");
  const base = parts.at(-1) ?? "";
  return (base.length === 1 || base === "space") && !parts.some((part) => ["ctrl", "alt", "super"].includes(part));
}
