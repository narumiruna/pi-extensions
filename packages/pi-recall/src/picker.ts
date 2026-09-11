import type { KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import {
  type Component,
  type Focusable,
  fuzzyFilter,
  Input,
  Key,
  matchesKey,
  type TUI,
  truncateToWidth,
  visibleWidth,
} from "@earendil-works/pi-tui";
import { formatInteractionHints } from "@narumitw/pi-tui-kit/interaction-hints";
import {
  filterRecallMessages,
  messagePreview,
  type RecallMessageRecord,
  type RecallScope,
  type RecallScopeContext,
} from "./messages.js";

const SCOPE_ORDER: readonly RecallScope[] = ["cwd", "all", "session"];
const SCOPE_LABELS: Record<RecallScope, string> = {
  all: "All",
  cwd: "Current cwd",
  session: "Current session",
};

export type RecallView = "all" | "user" | "assistant";

const VIEW_ORDER: readonly RecallView[] = ["all", "user", "assistant"];
const VIEW_LABELS: Record<RecallView, string> = {
  all: "All messages",
  user: "User only",
  assistant: "Assistant only",
};
const MAX_SEARCH_QUERY_LENGTH = 256;

export type ScopedRecallPickerResult =
  | {
      kind: "selected";
      recordId: string;
      scope: RecallScope;
      view: RecallView;
      query?: string;
    }
  | {
      kind: "delete";
      recordId: string;
      nextSelectedId?: string;
      scope: RecallScope;
      view: RecallView;
      query?: string;
    }
  | { kind: "back"; scope: RecallScope; view: RecallView; selectedId?: string; query?: string }
  | { kind: "close"; scope: RecallScope; view: RecallView; selectedId?: string; query?: string };

interface ScopedRecallPickerOptions {
  tui: TUI;
  theme: Theme;
  keybindings: KeybindingsManager;
  records: readonly RecallMessageRecord[];
  current: RecallScopeContext;
  initialScope?: RecallScope;
  initialView?: RecallView;
  initialSelectedId?: string;
  initialQuery?: string;
  complete: (result: ScopedRecallPickerResult) => void;
}

export class ScopedRecallPicker implements Component, Focusable {
  private readonly searchInput = new Input();
  private scope: RecallScope;
  private view: RecallView;
  private selectedId: string | undefined;
  private restoreSelectedId: string | undefined;
  private records: RecallMessageRecord[];
  private scrollOffset = 0;
  private disposed = false;
  private completed = false;
  private isFocused = false;

  constructor(private readonly options: ScopedRecallPickerOptions) {
    this.scope = options.initialScope ?? "cwd";
    this.view = options.initialView ?? "all";
    this.searchInput.setValue(replaceTerminalControls(options.initialQuery ?? ""));
    this.searchInput.focused = false;
    this.records = this.searchRecords(this.viewRecords(this.scopedRecords()));
    this.selectedId = this.records.some(({ id }) => id === options.initialSelectedId)
      ? options.initialSelectedId
      : this.records[0]?.id;
  }

  get focused(): boolean {
    return this.isFocused;
  }

  set focused(value: boolean) {
    this.isFocused = value;
    this.searchInput.focused = value && !this.disposed;
  }

  render(width: number): string[] {
    const safeWidth = Math.max(1, width);
    const scopedRecords = this.scopedRecords();
    const viewedRecords = this.viewRecords(scopedRecords);
    const listHeight = Math.max(1, Math.floor(this.options.tui.terminal.rows) - 8);
    this.keepSelectionVisible(this.records, listHeight);
    const visible = this.records.slice(this.scrollOffset, this.scrollOffset + listHeight);
    const rows = visible.map((record) => {
      const selected = record.id === this.selectedId;
      const role = record.role === "assistant" ? "assistant" : "user";
      const cursor = selected ? this.options.theme.fg("accent", "› ") : "  ";
      const roleLabel = this.options.theme.fg(role === "assistant" ? "success" : "accent", `${role}: `);
      const preview = sanitizeTerminalText(messagePreview(record.text, 72));
      const session = sanitizeTerminalText(record.source.sessionName ?? "unnamed");
      const timestamp = new Date(record.source.messageTimestamp).toISOString();
      let line = truncateToWidth(`${cursor}${roleLabel}${preview} · ${session} · ${timestamp}`, safeWidth, "…");
      if (selected) line = this.options.theme.bg("selectedBg", this.options.theme.bold(line));
      return line;
    });
    const query = this.query();
    const activeQuery = query.trim().length > 0;
    const matchCount = activeQuery
      ? ` · ${this.records.length} ${this.records.length === 1 ? "match" : "matches"}`
      : "";
    const scopeLine = `Scope: ${SCOPE_LABELS[this.scope]} (${scopedRecords.length}) · View: ${VIEW_LABELS[this.view]} (${viewedRecords.length})${matchCount} · Tab change scope`;
    const searchLabel = this.options.theme.fg("muted", "Search: ");
    const searchWidth = Math.max(1, safeWidth - visibleWidth(searchLabel));
    const searchLine = `${searchLabel}${this.searchInput.render(searchWidth)[0] ?? ""}`;
    const selectedIndex = this.records.findIndex(({ id }) => id === this.selectedId);
    const position = selectedIndex >= 0 ? selectedIndex + 1 : 0;
    const statusLine = this.options.theme.fg("muted", `  (${position}/${this.records.length}) [${this.view}]`);
    const emptyRows =
      scopedRecords.length === 0
        ? [this.options.theme.fg("dim", "  No saved messages in this scope")]
        : viewedRecords.length === 0
          ? [this.options.theme.fg("dim", `  No ${this.view} messages in this scope`)]
          : [
              ...(this.queryTooLong()
                ? [
                    this.options.theme.fg(
                      "error",
                      `  Search query is too long (maximum ${MAX_SEARCH_QUERY_LENGTH} characters)`,
                    ),
                  ]
                : []),
              this.options.theme.fg("dim", "  No matching saved messages"),
            ];
    return [
      truncateToWidth(this.options.theme.fg("accent", this.options.theme.bold("Pi Recall")), safeWidth, ""),
      truncateToWidth(this.options.theme.fg("muted", scopeLine), safeWidth, ""),
      truncateToWidth(searchLine, safeWidth, ""),
      "",
      ...(rows.length > 0 ? rows : emptyRows),
      truncateToWidth(statusLine, safeWidth, ""),
      ...this.footerLines(safeWidth),
    ].map((line) => truncateToWidth(line, safeWidth, ""));
  }

  handleInput(data: string): void {
    if (this.disposed || this.completed) return;
    if (matchesKey(data, Key.ctrl("c"))) {
      this.finish({
        kind: "close",
        scope: this.scope,
        view: this.view,
        selectedId: this.selectedId,
        query: this.query(),
      });
      return;
    }
    if (this.options.keybindings.matches(data, "app.session.delete")) {
      this.requestDelete();
      return;
    }
    if (matchesKey(data, Key.shift("tab"))) {
      this.cycleScope(-1);
    } else if (matchesKey(data, Key.tab)) {
      this.cycleScope(1);
    } else if (this.options.keybindings.matches(data, "app.tree.filter.cycleBackward")) {
      this.cycleView(-1);
    } else if (this.options.keybindings.matches(data, "app.tree.filter.cycleForward")) {
      this.cycleView(1);
    } else if (this.options.keybindings.matches(data, "tui.select.cancel")) {
      this.finish({
        kind: "back",
        scope: this.scope,
        view: this.view,
        selectedId: this.selectedId,
        query: this.query(),
      });
      return;
    } else if (this.options.keybindings.matches(data, "tui.select.up")) {
      this.move(-1);
    } else if (this.options.keybindings.matches(data, "tui.select.down")) {
      this.move(1);
    } else if (this.options.keybindings.matches(data, "tui.select.pageUp")) {
      this.move(-Math.max(1, Math.floor(this.options.tui.terminal.rows) - 8));
    } else if (this.options.keybindings.matches(data, "tui.select.pageDown")) {
      this.move(Math.max(1, Math.floor(this.options.tui.terminal.rows) - 8));
    } else if (matchesKey(data, Key.home)) {
      this.selectAt(0);
    } else if (matchesKey(data, Key.end)) {
      this.selectAt(this.records.length - 1);
    } else if (this.options.keybindings.matches(data, "tui.select.confirm")) {
      if (this.selectedId) {
        this.finish({
          kind: "selected",
          recordId: this.selectedId,
          scope: this.scope,
          view: this.view,
          query: this.query(),
        });
        return;
      }
    } else {
      const previousQuery = this.query();
      this.searchInput.handleInput(data);
      const safeQuery = replaceTerminalControls(this.searchInput.getValue());
      if (safeQuery !== this.searchInput.getValue()) this.searchInput.setValue(safeQuery);
      if (safeQuery !== previousQuery) this.applySearch();
    }
    this.options.tui.requestRender();
  }

  invalidate(): void {
    this.searchInput.invalidate();
  }

  dispose(): void {
    this.disposed = true;
    this.isFocused = false;
    this.searchInput.focused = false;
  }

  private scopedRecords(): RecallMessageRecord[] {
    return filterRecallMessages(this.options.records, this.scope, this.options.current).reverse();
  }

  private viewRecords(records: readonly RecallMessageRecord[]): RecallMessageRecord[] {
    return this.view === "all" ? [...records] : records.filter(({ role }) => role === this.view);
  }

  private searchRecords(records: readonly RecallMessageRecord[]): RecallMessageRecord[] {
    const query = this.query();
    if (this.queryTooLong()) return [];
    if (!query.trim()) return [...records];
    return fuzzyFilter([...records], query, searchRecordText);
  }

  private applySearch(): void {
    const previouslySelectedId = this.selectedId;
    this.records = this.searchRecords(this.viewRecords(this.scopedRecords()));
    const restoreIndex = this.records.findIndex(({ id }) => id === this.restoreSelectedId);
    const previousIndex = this.records.findIndex(({ id }) => id === previouslySelectedId);
    if (restoreIndex >= 0) {
      this.selectedId = this.records[restoreIndex]?.id;
      this.restoreSelectedId = undefined;
    } else if (previousIndex >= 0) {
      this.selectedId = this.records[previousIndex]?.id;
    } else {
      if (previouslySelectedId) this.restoreSelectedId ??= previouslySelectedId;
      this.selectedId = this.records[0]?.id;
    }
    this.scrollOffset = 0;
  }

  private cycleScope(delta: number): void {
    const index = SCOPE_ORDER.indexOf(this.scope);
    this.scope = SCOPE_ORDER[(index + delta + SCOPE_ORDER.length) % SCOPE_ORDER.length] ?? "cwd";
    this.refilterAfterModeChange();
  }

  private cycleView(delta: number): void {
    const index = VIEW_ORDER.indexOf(this.view);
    this.view = VIEW_ORDER[(index + delta + VIEW_ORDER.length) % VIEW_ORDER.length] ?? "all";
    this.refilterAfterModeChange();
  }

  private refilterAfterModeChange(): void {
    this.records = this.searchRecords(this.viewRecords(this.scopedRecords()));
    if (!this.records.some(({ id }) => id === this.selectedId)) {
      this.selectedId = this.records[0]?.id;
    }
    this.restoreSelectedId = undefined;
    this.scrollOffset = 0;
  }

  private requestDelete(): void {
    if (!this.selectedId) return;
    const selectedIndex = this.records.findIndex(({ id }) => id === this.selectedId);
    if (selectedIndex < 0) return;
    const nextSelectedId = this.records[selectedIndex + 1]?.id ?? this.records[selectedIndex - 1]?.id;
    this.finish({
      kind: "delete",
      recordId: this.selectedId,
      ...(nextSelectedId ? { nextSelectedId } : {}),
      scope: this.scope,
      view: this.view,
      query: this.query(),
    });
  }

  private footerLines(width: number): string[] {
    const primary = formatInteractionHints(
      this.options.keybindings,
      [
        { bindings: ["app.session.delete"], label: "delete" },
        { bindings: ["tui.select.confirm"], label: "open" },
        { bindings: ["tui.select.up", "tui.select.down"], label: "navigate" },
      ],
      { separator: "·" },
    );
    const navigation = formatInteractionHints(
      this.options.keybindings,
      [
        {
          bindings: ["app.tree.filter.cycleForward", "app.tree.filter.cycleBackward"],
          label: "view",
        },
        { keys: ["tab", "shift+tab"], label: "scope" },
        {
          bindings: ["tui.select.cancel"],
          excludeKeys: ["ctrl+c"],
          label: "back",
        },
        { keys: ["ctrl+c"], label: "close" },
      ],
      { separator: "·" },
    );
    const searchPrefix = width < 32 ? "" : "Type to search · ";
    return [this.options.theme.fg("dim", `${searchPrefix}${primary}`), this.options.theme.fg("dim", navigation)];
  }

  private move(delta: number): void {
    if (this.records.length === 0) return;
    const current = Math.max(
      0,
      this.records.findIndex(({ id }) => id === this.selectedId),
    );
    const next = Math.max(0, Math.min(this.records.length - 1, current + delta));
    this.selectedId = this.records[next]?.id;
    this.restoreSelectedId = undefined;
  }

  private selectAt(index: number): void {
    if (this.records.length === 0) return;
    const bounded = Math.max(0, Math.min(this.records.length - 1, index));
    this.selectedId = this.records[bounded]?.id;
    this.restoreSelectedId = undefined;
  }

  private keepSelectionVisible(records: readonly RecallMessageRecord[], height: number): void {
    if (records.length === 0) {
      this.scrollOffset = 0;
      return;
    }
    const index = Math.max(
      0,
      records.findIndex(({ id }) => id === this.selectedId),
    );
    if (index < this.scrollOffset) this.scrollOffset = index;
    if (index >= this.scrollOffset + height) this.scrollOffset = index - height + 1;
    this.scrollOffset = Math.max(0, Math.min(this.scrollOffset, records.length - height));
  }

  private query(): string {
    return this.searchInput.getValue();
  }

  private queryTooLong(): boolean {
    return this.query().length > MAX_SEARCH_QUERY_LENGTH;
  }

  private finish(result: ScopedRecallPickerResult): void {
    if (this.completed) return;
    this.completed = true;
    this.options.complete(result);
  }
}

function searchRecordText(record: RecallMessageRecord): string {
  return [
    sanitizeTerminalText(record.text),
    record.role,
    record.source.sessionName ? sanitizeTerminalText(record.source.sessionName) : "",
  ]
    .filter(Boolean)
    .join(" ");
}

function replaceTerminalControls(value: string): string {
  return Array.from(value, (character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 0x1f ||
      (codePoint >= 0x7f && codePoint <= 0x9f) ||
      isLineSeparator(codePoint) ||
      isBidiControl(codePoint)
      ? " "
      : character;
  }).join("");
}

export function sanitizeTerminalText(value: string): string {
  let safe = "";
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code === 0x1b) {
      const introducer = value[index + 1];
      if (introducer === "]") {
        index += 2;
        while (index < value.length) {
          const current = value.charCodeAt(index);
          if (current === 0x07) break;
          if (current === 0x1b && value[index + 1] === "\\") {
            index += 1;
            break;
          }
          index += 1;
        }
        continue;
      }
      if (introducer === "[") {
        index += 2;
        while (index < value.length) {
          const current = value.charCodeAt(index);
          if (current >= 0x40 && current <= 0x7e) break;
          index += 1;
        }
        continue;
      }
      continue;
    }
    if (isBidiControl(code)) continue;
    if (isLineSeparator(code) || code <= 0x1f || (code >= 0x7f && code <= 0x9f)) safe += " ";
    else safe += value[index];
  }
  return safe.replace(/\s+/gu, " ").trim();
}

function isLineSeparator(codePoint: number): boolean {
  return codePoint === 0x2028 || codePoint === 0x2029;
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
