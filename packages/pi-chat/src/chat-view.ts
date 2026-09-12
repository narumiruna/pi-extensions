import type { Theme } from "@earendil-works/pi-coding-agent";
import {
  type Component,
  Editor,
  type EditorTheme,
  type Focusable,
  Key,
  matchesKey,
  sliceByColumn,
  type TUI,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import type { ChatSnapshot } from "./chat-session.js";
import { sanitizeChatText, sanitizeSingleLine } from "./text.js";

export interface ChatViewOptions {
  tui: TUI;
  theme: Theme;
  getSnapshot(): ChatSnapshot;
  send(text: string): { id: string; relayedTo: number };
  initialDraft?: string;
  onDraftChange?(text: string): void;
  setViewOpen(open: boolean): void;
  subscribe?(listener: () => void): () => void;
  signal?: AbortSignal;
  onReturnToPi(): void;
  onClose(): void;
}

export class ChatView implements Component, Focusable {
  private readonly editor: Editor;
  private readonly tui: TUI;
  private readonly theme: Theme;
  private readonly options: ChatViewOptions;
  private scrollOffset = 0;
  private lastContentRows = 0;
  private lastViewportRows = 1;
  private followBottom = true;
  private messageStatus: { kind: "success" | "warning"; text: string } | undefined;
  private finished = false;
  private _focused = false;
  private readonly unsubscribe: () => void;
  private removeAbort = () => {};

  constructor(options: ChatViewOptions) {
    this.options = options;
    this.tui = options.tui;
    this.theme = options.theme;
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
    this.editor = new Editor(this.tui, editorTheme);
    if (options.initialDraft) this.editor.setText(options.initialDraft);
    this.unsubscribe = options.subscribe?.(() => this.tui.requestRender()) ?? (() => undefined);
    this.editor.onChange = () => {
      this.messageStatus = undefined;
      this.options.onDraftChange?.(this.editor.getExpandedText());
    };
    this.editor.onSubmit = (text) => {
      const message = text.trim();
      if (!message) {
        this.messageStatus = { kind: "warning", text: "Message cannot be empty" };
        this.tui.requestRender();
        return;
      }
      if (this.options.getSnapshot().directNeighbors === 0) {
        this.editor.setText(text);
        this.messageStatus = {
          kind: "warning",
          text: "No direct neighbors — message kept. Wait for connection or Esc to return.",
        };
        this.tui.requestRender();
        return;
      }
      try {
        const result = this.options.send(message);
        if (result.relayedTo === 0) {
          this.editor.setText(text);
          this.messageStatus = {
            kind: "warning",
            text: "No direct neighbors accepted it — message kept for retry.",
          };
        } else {
          this.editor.setText("");
          this.followBottom = true;
          this.messageStatus = {
            kind: "success",
            text: `Relayed to ${result.relayedTo} direct neighbor${result.relayedTo === 1 ? "" : "s"}`,
          };
        }
      } catch (error) {
        this.editor.setText(text);
        this.messageStatus = { kind: "warning", text: safeDisplayError(error) };
      }
      this.tui.requestRender();
    };
    this.options.setViewOpen(true);
    if (options.signal) {
      const abort = () => this.finish(false, true);
      options.signal.addEventListener("abort", abort, { once: true });
      this.removeAbort = () => options.signal?.removeEventListener("abort", abort);
      if (options.signal.aborted) abort();
    }
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
    const snapshot = this.options.getSnapshot();
    const editorLines = this.editor.render(safeWidth);
    const availableRows = Math.max(3, Math.min(16, Math.floor(this.tui.terminal.rows * 0.75)));
    const viewportRows = Math.max(0, availableRows - editorLines.length - 2);
    const content = renderTranscript(snapshot, safeWidth, this.theme);
    this.lastContentRows = content.length;
    this.lastViewportRows = viewportRows;
    if (this.followBottom) this.scrollOffset = this.maxScroll();
    this.scrollOffset = Math.max(0, Math.min(this.scrollOffset, this.maxScroll()));
    const participantCount = snapshot.participants.length;
    const header = truncateToWidth(
      this.theme.fg(
        "accent",
        this.theme.bold(
          `CHAT INPUT → ${sanitizeSingleLine(snapshot.room.label)} · ${participantCount} active · ${snapshot.directNeighbors} direct neighbor${snapshot.directNeighbors === 1 ? "" : "s"}`,
        ),
      ),
      safeWidth,
    );
    const footer = truncateToWidth(
      this.theme.fg(
        this.messageStatus?.kind === "warning" ? "warning" : this.messageStatus?.kind === "success" ? "success" : "dim",
        this.messageStatus?.text ?? "Enter sends · configured newline key inserts a line · Esc returns to Pi/LLM",
      ),
      safeWidth,
    );
    const lines = [
      header,
      ...content.slice(this.scrollOffset, this.scrollOffset + viewportRows),
      footer,
      ...editorLines,
    ];
    return lines.slice(-availableRows).map((line) => truncateToWidth(line, safeWidth));
  }

  handleInput(data: string): void {
    if (this.finished) return;
    if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
      this.close();
      return;
    }
    if (matchesKey(data, Key.pageUp)) {
      this.scrollOffset = Math.max(0, this.scrollOffset - this.lastViewportRows);
      this.followBottom = false;
      this.tui.requestRender();
      return;
    }
    if (matchesKey(data, Key.pageDown)) {
      this.scrollOffset = Math.min(this.maxScroll(), this.scrollOffset + this.lastViewportRows);
      this.followBottom = this.scrollOffset === this.maxScroll();
      this.tui.requestRender();
      return;
    }
    this.editor.handleInput(data);
    this.tui.requestRender();
  }

  invalidate(): void {
    this.editor.invalidate();
  }

  dispose(): void {
    this.finish(false, false);
  }

  private maxScroll(): number {
    return Math.max(0, this.lastContentRows - this.lastViewportRows);
  }

  private close(): void {
    this.finish(true, true);
  }

  private finish(returnedToPi: boolean, closeHost: boolean): void {
    if (this.finished) return;
    this.finished = true;
    this.removeAbort();
    this.removeAbort = () => {};
    this.unsubscribe();
    this.options.setViewOpen(false);
    if (returnedToPi) this.options.onReturnToPi();
    if (closeHost) this.options.onClose();
  }
}

function renderTranscript(snapshot: ChatSnapshot, width: number, theme: Theme): string[] {
  if (snapshot.transcript.length === 0) {
    const empty =
      snapshot.participants.length === 0
        ? "No other active participants discovered yet."
        : "No messages yet. Start the conversation below.";
    return wrapTextWithAnsi(theme.fg("muted", empty), width);
  }
  const lines: string[] = [];
  for (const entry of snapshot.transcript) {
    const label = sanitizeSingleLine(entry.label);
    const delivery =
      entry.author === "local" && entry.delivery === "not-relayed"
        ? " · not relayed"
        : entry.author === "local" && entry.relayedTo !== undefined
          ? ` · relayed to ${entry.relayedTo}`
          : "";
    lines.push(...wrapTextWithAnsi(theme.fg("accent", `${label}${delivery}`), width));
    for (const rawLine of sanitizeChatText(entry.text).split("\n")) {
      for (const line of hardWrapExact(rawLine, Math.max(1, width - 2))) {
        lines.push(truncateToWidth(`  ${line}`, width));
      }
    }
  }
  return lines;
}

function hardWrapExact(value: string, width: number): string[] {
  if (!value) return [" "];
  const columns = visibleWidth(value);
  const lines: string[] = [];
  for (let column = 0; column < columns; column += width) {
    lines.push(sliceByColumn(value, column, width));
  }
  return lines.length > 0 ? lines : [" "];
}

function safeDisplayError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return sanitizeSingleLine(message).slice(0, 200);
}
