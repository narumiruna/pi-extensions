import type { ExtensionCommandContext, KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import {
  Editor,
  type EditorTheme,
  Key,
  Markdown,
  matchesKey,
  type TUI,
  type TuiMouseEvent,
  type TuiMouseEventResult,
  truncateToWidth,
  visibleWidth,
} from "@earendil-works/pi-tui";
import { hardWrapTerminalDocument, sanitizeTerminalDocument } from "@narumitw/pi-tui-kit/terminal-document";
import { sanitizeTerminalText } from "@narumitw/pi-tui-kit/terminal-text";
import { createNotesChildSession, type NotesChildSession } from "./child-session.js";
import { MAX_TRANSCRIPT_CHARS, MAX_TRANSCRIPT_MESSAGES, WIDE_WORKSPACE_COLUMNS } from "./constants.js";
import { runFullscreenInteraction } from "./fullscreen.js";
import type { NoteSnapshot, NotesStorage } from "./storage.js";

type CreateChildSession = typeof createNotesChildSession;
type Pane = "chat" | "preview";

export interface NotesWorkspaceDependencies {
  createChildSession?: CreateChildSession;
  runInteraction?: typeof runFullscreenInteraction;
}

export interface OpenNotesWorkspaceOptions {
  ctx: ExtensionCommandContext;
  agentDir: string;
  storage: NotesStorage;
  notePath: string;
  thinkingLevel: Parameters<CreateChildSession>[0]["thinkingLevel"];
  signal: AbortSignal;
  isCurrent(): boolean;
  dependencies?: NotesWorkspaceDependencies;
}

export async function openNotesWorkspace(options: OpenNotesWorkspaceOptions): Promise<void> {
  const runInteraction = options.dependencies?.runInteraction ?? runFullscreenInteraction;
  const interaction = await runInteraction<"closed">(options.ctx, {
    signal: options.signal,
    isCurrent: options.isCurrent,
    create: ({ tui, theme, keybindings, signal, complete }) =>
      new NotesWorkspace({
        tui,
        theme,
        keybindings,
        signal,
        complete,
        agentDir: options.agentDir,
        storage: options.storage,
        notePath: options.notePath,
        parentModel: options.ctx.model,
        thinkingLevel: options.thinkingLevel,
        createChildSession: options.dependencies?.createChildSession ?? createNotesChildSession,
      }),
    onError: (ctx, error) => safeNotify(ctx, `Pi Notes workspace failed: ${safeErrorMessage(error)}`, "error"),
  });
  if (interaction.kind === "error") throw interaction.error;
}

interface NotesWorkspaceOptions {
  tui: TUI;
  theme: Theme;
  keybindings: KeybindingsManager;
  signal: AbortSignal;
  complete(value: "closed"): void;
  agentDir: string;
  storage: NotesStorage;
  notePath: string;
  parentModel: OpenNotesWorkspaceOptions["ctx"]["model"];
  thinkingLevel: OpenNotesWorkspaceOptions["thinkingLevel"];
  createChildSession: CreateChildSession;
}

export class NotesWorkspace {
  private readonly tui: TUI;
  private readonly theme: Theme;
  private readonly keybindings: KeybindingsManager;
  private readonly options: NotesWorkspaceOptions;
  private readonly editor: Editor;
  private readonly lifetime = new AbortController();
  private readonly pending = new Set<Promise<unknown>>();
  private removeUpstreamAbort = () => {};
  private child: NotesChildSession | undefined;
  private unsubscribe = () => {};
  private note: NoteSnapshot | undefined;
  private status = "Opening embedded note session…";
  private error: string | undefined;
  private pane: Pane = "chat";
  private transcriptScroll = 0;
  private previewScroll = 0;
  private transcriptRows = 1;
  private previewRows = 1;
  private transcriptLineCount = 0;
  private previewLineCount = 0;
  private followTranscript = true;
  private disposed = false;
  private finished = false;
  private generation = 0;
  private promptTask: Promise<unknown> | undefined;
  private promptPreflightPending = false;
  private stopPromise: Promise<void> | undefined;
  private editorMouseBounds:
    | { x: number; y: number; width: number; visibleHeight: number; lineOffset: number; fullHeight: number }
    | undefined;
  private _focused = false;
  private inPaste = false;

  constructor(options: NotesWorkspaceOptions) {
    this.options = options;
    this.tui = options.tui;
    this.theme = options.theme;
    this.keybindings = options.keybindings;
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
    this.editor.disableSubmit = true;
    this.editor.onChange = () => {
      this.error = undefined;
      this.tui.requestRender();
    };
    this.editor.onSubmit = (text) => this.submit(text);

    const abort = () => this.dispose();
    options.signal.addEventListener("abort", abort, { once: true });
    this.removeUpstreamAbort = () => options.signal.removeEventListener("abort", abort);
    if (options.signal.aborted) abort();
    else this.track(this.start());
  }

  get focused(): boolean {
    return this._focused;
  }

  set focused(value: boolean) {
    this._focused = value;
    this.editor.focused = value && this.pane === "chat";
  }

  render(width: number): string[] {
    const safeWidth = Math.max(1, width);
    const availableRows = Math.max(1, this.tui.terminal.rows - (this.tui.mode === "fullscreen" ? 0 : 4));
    this.editorMouseBounds = undefined;
    const title = truncateToWidth(
      this.theme.fg("accent", this.theme.bold(`Pi Notes · ${sanitizeTerminalText(this.options.notePath)}`)),
      safeWidth,
    );
    const hint = truncateToWidth(this.theme.fg("muted", this.hintText()), safeWidth);
    const bodyRows = Math.max(1, availableRows - 2);
    const body =
      safeWidth >= WIDE_WORKSPACE_COLUMNS
        ? this.renderWide(safeWidth, bodyRows)
        : this.renderNarrow(safeWidth, bodyRows);
    return [title, ...body, hint].slice(0, availableRows).map((line) => truncateToWidth(line, safeWidth));
  }

  handleInput(data: string): void {
    if (this.disposed || this.finished) return;
    if (this.handlePaste(data)) return;
    if (matchesKey(data, Key.ctrl("c"))) {
      this.close();
      return;
    }
    if (this.keybindings.matches(data, "tui.select.cancel")) {
      this.close();
      return;
    }
    if (this.keybindings.matches(data, "tui.input.tab")) {
      this.pane = this.pane === "chat" ? "preview" : "chat";
      this.editor.focused = this._focused && this.pane === "chat";
      this.tui.requestRender();
      return;
    }
    if (this.keybindings.matches(data, "tui.select.pageUp")) {
      this.scroll(-1);
      return;
    }
    if (this.keybindings.matches(data, "tui.select.pageDown")) {
      this.scroll(1);
      return;
    }
    if (this.pane !== "chat") return;
    this.editor.handleInput(data);
    this.tui.requestRender();
  }

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    if (this.disposed || this.finished) return undefined;
    if (event.type === "wheel") {
      const lines = Math.trunc(event.wheelDelta ?? 0);
      if (lines === 0) return { handled: true, render: false };
      this.scrollPane(this.paneAt(event.x, event.width), lines);
      return { handled: true };
    }
    const bounds = this.editorMouseBounds;
    if (
      !bounds ||
      event.x < bounds.x ||
      event.x >= bounds.x + bounds.width ||
      event.y < bounds.y ||
      event.y >= bounds.y + bounds.visibleHeight
    ) {
      return undefined;
    }
    this.pane = "chat";
    this.editor.focused = this._focused;
    return this.editor.handleMouse({
      ...event,
      x: event.x - bounds.x,
      y: event.y - bounds.y + bounds.lineOffset,
      width: bounds.width,
      height: bounds.fullHeight,
    });
  }

  invalidate(): void {
    this.editor.invalidate();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.generation += 1;
    this.removeUpstreamAbort();
    this.removeUpstreamAbort = () => {};
    this.lifetime.abort(new DOMException("Notes workspace disposed", "AbortError"));
    this.unsubscribe();
    this.unsubscribe = () => {};
    this.stopPromise = this.stopChild();
  }

  async waitForPending(): Promise<void> {
    const pending = [...this.pending];
    // Pi prompt preflight has no cancellation parameter; do not let an uncooperative auth check block teardown.
    if (
      this.promptPreflightPending &&
      this.promptTask &&
      (this.disposed || this.finished || this.options.signal.aborted)
    ) {
      const promptIndex = pending.indexOf(this.promptTask);
      if (promptIndex >= 0) pending.splice(promptIndex, 1);
    }
    await Promise.allSettled(pending);
    await this.stopPromise;
  }

  private async start(): Promise<void> {
    const generation = this.generation;
    try {
      const note = await this.options.storage.readNote(this.options.notePath, this.signal());
      if (!this.isCurrent(generation)) return;
      this.note = note;
      const child = await this.options.createChildSession({
        agentDir: this.options.agentDir,
        storage: this.options.storage,
        notePath: this.options.notePath,
        parentModel: this.options.parentModel,
        thinkingLevel: this.options.thinkingLevel,
        signal: this.signal(),
        onNoteChanged: (changed) => {
          if (!this.isCurrent(generation)) return;
          this.note = changed;
          this.previewScroll = Math.min(this.previewScroll, this.maxPreviewScroll());
          this.tui.requestRender();
        },
      });
      if (!this.isCurrent(generation)) {
        child.session.dispose();
        return;
      }
      this.child = child;
      this.unsubscribe = child.session.subscribe((event) => {
        if (!this.isCurrent(generation)) return;
        if (event.type === "agent_start") this.status = "Agent is working…";
        else if (event.type === "tool_execution_start")
          this.status = `Running ${sanitizeTerminalText(event.toolName)}…`;
        else if (event.type === "agent_settled") this.status = "Ready";
        this.tui.requestRender();
      });
      this.status = child.resumed ? "Ready · resumed note conversation" : "Ready · new note conversation";
      this.error = child.recoveryWarning ?? child.modelFallbackMessage;
      this.editor.disableSubmit = false;
      this.tui.requestRender();
    } catch (error) {
      if (!this.isCurrent(generation) || isAbortError(error)) return;
      this.status = "Unavailable";
      this.error = safeErrorMessage(error);
      this.editor.disableSubmit = true;
      this.tui.requestRender();
    }
  }

  private submit(rawText: string): void {
    const text = rawText.trim();
    const session = this.child?.session;
    if (!text || !session || session.isStreaming || this.disposed) {
      if (!text) this.error = "Message cannot be empty";
      this.tui.requestRender();
      return;
    }
    const generation = this.generation;
    this.editor.disableSubmit = true;
    this.status = "Sending…";
    this.error = undefined;
    this.promptPreflightPending = true;
    let task!: Promise<void>;
    task = session
      .prompt(text, {
        expandPromptTemplates: false,
        preflightResult: (accepted) => {
          if (this.promptTask === task) this.promptPreflightPending = false;
          if (!this.isCurrent(generation)) return;
          if (!accepted) {
            const currentDraft = this.editor.getExpandedText();
            this.editor.setText(currentDraft ? `${text}\n\n${currentDraft}` : text);
            this.tui.requestRender();
            return;
          }
          this.status = "Agent is working…";
          this.followTranscript = true;
          this.tui.requestRender();
        },
      })
      .then(async () => {
        if (!this.isCurrent(generation)) return;
        const note = await this.options.storage.readNote(this.options.notePath, this.signal());
        if (!this.isCurrent(generation)) return;
        this.note = note;
        this.status = "Ready";
      })
      .catch((error: unknown) => {
        if (!this.isCurrent(generation) || isAbortError(error)) return;
        this.status = "Ready";
        this.error = safeErrorMessage(error);
      })
      .finally(() => {
        if (this.promptTask === task) {
          this.promptTask = undefined;
          this.promptPreflightPending = false;
        }
        if (!this.isCurrent(generation)) return;
        this.editor.disableSubmit = false;
        this.tui.requestRender();
      });
    this.promptTask = task;
    this.track(task);
    this.tui.requestRender();
  }

  private renderWide(width: number, rows: number): string[] {
    const separator = " │ ";
    const leftWidth = Math.max(1, Math.floor((width - visibleWidth(separator)) * 0.52));
    const rightWidth = Math.max(1, width - leftWidth - visibleWidth(separator));
    const left = this.renderChat(leftWidth, rows, 0, 1);
    const right = this.renderPreview(rightWidth, rows);
    const lines: string[] = [];
    for (let index = 0; index < rows; index += 1) {
      lines.push(
        `${padLine(left[index] ?? "", leftWidth)}${this.theme.fg("borderMuted", separator)}${padLine(right[index] ?? "", rightWidth)}`,
      );
    }
    return lines;
  }

  private renderNarrow(width: number, rows: number): string[] {
    return this.pane === "chat" ? this.renderChat(width, rows, 0, 1) : this.renderPreview(width, rows);
  }

  private renderChat(width: number, rows: number, originX: number, originY: number): string[] {
    const editorLines = this.editor.render(width);
    const header = truncateToWidth(
      this.theme.fg(this.pane === "chat" ? "accent" : "muted", `Chat · ${this.status}`),
      width,
    );
    const errorLines = this.error
      ? hardWrapTerminalDocument(`Error: ${this.error}`, Math.max(1, width)).map((line) =>
          this.theme.fg("warning", line),
        )
      : [];
    const viewportRows = Math.max(0, rows - editorLines.length - errorLines.length - 1);
    const transcript = this.renderTranscript(width);
    this.transcriptLineCount = transcript.length;
    this.transcriptRows = Math.max(1, viewportRows);
    if (this.followTranscript) this.transcriptScroll = this.maxTranscriptScroll();
    this.transcriptScroll = clamp(this.transcriptScroll, 0, this.maxTranscriptScroll());
    const visible = transcript.slice(this.transcriptScroll, this.transcriptScroll + viewportRows);
    const content = [header, ...visible, ...errorLines, ...editorLines];
    const firstVisibleRow = Math.max(0, content.length - rows);
    const editorStartRow = content.length - editorLines.length;
    const firstVisibleEditorRow = Math.max(firstVisibleRow, editorStartRow);
    const visibleEditorHeight = Math.max(0, content.length - firstVisibleEditorRow);
    if (visibleEditorHeight > 0) {
      this.editorMouseBounds = {
        x: originX,
        y: originY + firstVisibleEditorRow - firstVisibleRow,
        width,
        visibleHeight: visibleEditorHeight,
        lineOffset: firstVisibleEditorRow - editorStartRow,
        fullHeight: editorLines.length,
      };
    }
    return content.slice(firstVisibleRow);
  }

  private renderPreview(width: number, rows: number): string[] {
    const header = truncateToWidth(
      this.theme.fg(this.pane === "preview" ? "accent" : "muted", `Preview · ${this.note?.size ?? 0} bytes`),
      width,
    );
    const bodyRows = Math.max(0, rows - 1);
    const markdown = this.note?.content
      ? new Markdown(sanitizeTerminalDocument(this.note.content), 0, 0, markdownTheme(this.theme))
      : undefined;
    const content = markdown?.render(width) ?? [this.theme.fg("muted", "(Empty note)")];
    this.previewLineCount = content.length;
    this.previewRows = Math.max(1, bodyRows);
    this.previewScroll = clamp(this.previewScroll, 0, this.maxPreviewScroll());
    return [header, ...content.slice(this.previewScroll, this.previewScroll + bodyRows)];
  }

  private renderTranscript(width: number): string[] {
    const session = this.child?.session;
    if (!session) return [this.theme.fg("muted", "Preparing the embedded agent…")];
    const messages = [...session.messages];
    const streaming = session.state.streamingMessage;
    if (streaming && messages.at(-1) !== streaming) messages.push(streaming);
    const selected = messages.slice(-MAX_TRANSCRIPT_MESSAGES);
    const sections: Array<{ role: string; text: string }> = [];
    let remainingCharacters = MAX_TRANSCRIPT_CHARS;
    for (let index = selected.length - 1; index >= 0 && remainingCharacters > 0; index -= 1) {
      const message = selected[index] as unknown;
      const section = transcriptSection(message);
      if (!section) continue;
      if (section.text.length > remainingCharacters) {
        const marker = "[Earlier content omitted]\n".slice(0, remainingCharacters);
        const available = remainingCharacters - marker.length;
        sections.unshift({
          ...section,
          text: `${marker}${available > 0 ? section.text.slice(-available) : ""}`,
        });
        remainingCharacters = 0;
        break;
      }
      sections.unshift(section);
      remainingCharacters -= section.text.length;
    }
    if (sections.length === 0) return [this.theme.fg("muted", "Ask the agent to work on this note.")];
    const lines: string[] = [];
    for (const section of sections) {
      lines.push(this.theme.fg("accent", this.theme.bold(section.role)));
      for (const line of hardWrapTerminalDocument(section.text, Math.max(1, width - 2))) {
        lines.push(truncateToWidth(`  ${line}`, width));
      }
    }
    return lines;
  }

  private scroll(direction: -1 | 1): void {
    const rows = this.pane === "preview" ? this.previewRows : this.transcriptRows;
    this.scrollPane(this.pane, direction * Math.max(1, rows - 1));
  }

  private scrollPane(pane: Pane, lines: number): void {
    if (pane === "preview") {
      this.previewScroll = clamp(this.previewScroll + lines, 0, this.maxPreviewScroll());
    } else {
      this.transcriptScroll = clamp(this.transcriptScroll + lines, 0, this.maxTranscriptScroll());
      this.followTranscript = this.transcriptScroll === this.maxTranscriptScroll();
    }
    this.tui.requestRender();
  }

  private paneAt(x: number, width: number): Pane {
    if (width < WIDE_WORKSPACE_COLUMNS) return this.pane;
    const separatorWidth = visibleWidth(" │ ");
    const leftWidth = Math.max(1, Math.floor((width - separatorWidth) * 0.52));
    return x < leftWidth + Math.floor(separatorWidth / 2) ? "chat" : "preview";
  }

  private maxTranscriptScroll(): number {
    return Math.max(0, this.transcriptLineCount - this.transcriptRows);
  }

  private maxPreviewScroll(): number {
    return Math.max(0, this.previewLineCount - this.previewRows);
  }

  private hintText(): string {
    return "Submit sends · Switch-pane action changes Chat/Preview · Page actions scroll · Cancel closes · Ctrl+C hard-cancels";
  }

  private handlePaste(data: string): boolean {
    const start = data.includes("\u001b[200~");
    const wasPasting = this.inPaste;
    if (start) this.inPaste = true;
    if (!start && !wasPasting) return false;
    this.pane = "chat";
    this.editor.focused = this._focused;
    this.editor.handleInput(data);
    if (data.includes("\u001b[201~")) this.inPaste = false;
    this.tui.requestRender();
    return true;
  }

  private close(): void {
    if (this.finished) return;
    this.finished = true;
    this.generation += 1;
    this.lifetime.abort(new DOMException("Notes workspace closed", "AbortError"));
    this.unsubscribe();
    this.unsubscribe = () => {};
    void this.stopChild();
    this.options.complete("closed");
  }

  private async stopChild(): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    const session = this.child?.session;
    this.child = undefined;
    this.stopPromise = (async () => {
      if (!session) return;
      try {
        await session.abort();
      } finally {
        session.dispose();
      }
    })();
    return this.stopPromise;
  }

  private signal(): AbortSignal {
    return this.options.signal.aborted
      ? this.options.signal
      : AbortSignal.any([this.options.signal, this.lifetime.signal]);
  }

  private isCurrent(generation: number): boolean {
    return !this.disposed && !this.finished && !this.options.signal.aborted && generation === this.generation;
  }

  private track<T>(promise: Promise<T>): Promise<T> {
    this.pending.add(promise);
    void promise.then(
      () => this.pending.delete(promise),
      () => this.pending.delete(promise),
    );
    return promise;
  }
}

function transcriptSection(message: unknown): { role: string; text: string } | undefined {
  if (!message || typeof message !== "object") return undefined;
  const record = message as { role?: unknown; content?: unknown };
  const role =
    record.role === "user"
      ? "You"
      : record.role === "assistant"
        ? "Agent"
        : record.role === "toolResult"
          ? "Tool"
          : undefined;
  if (!role) return undefined;
  const text = messageText(record.content);
  return text ? { role, text } : undefined;
}

function messageText(content: unknown): string {
  if (typeof content === "string") return sanitizeTerminalDocument(content);
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const value of content) {
    if (!value || typeof value !== "object") continue;
    const block = value as { type?: unknown; text?: unknown; name?: unknown; arguments?: unknown; content?: unknown };
    if ((block.type === "text" || block.type === "thinking") && typeof block.text === "string") {
      parts.push(block.text);
    } else if (block.type === "toolCall" && typeof block.name === "string") {
      parts.push(`Tool call: ${block.name}`);
    } else if (block.type === "toolResult") {
      parts.push(typeof block.name === "string" ? `Tool result: ${block.name}` : "Tool result");
    }
  }
  return sanitizeTerminalDocument(parts.join("\n"));
}

function markdownTheme(theme: Theme) {
  return {
    heading: (text: string) => theme.fg("mdHeading", theme.bold(text)),
    link: (text: string) => theme.fg("mdLink", text),
    linkUrl: (text: string) => theme.fg("mdLinkUrl", text),
    code: (text: string) => theme.fg("mdCode", text),
    codeBlock: (text: string) => theme.fg("mdCodeBlock", text),
    codeBlockBorder: (text: string) => theme.fg("mdCodeBlockBorder", text),
    quote: (text: string) => theme.fg("mdQuote", text),
    quoteBorder: (text: string) => theme.fg("mdQuoteBorder", text),
    hr: (text: string) => theme.fg("mdHr", text),
    listBullet: (text: string) => theme.fg("mdListBullet", text),
    bold: (text: string) => theme.bold(text),
    italic: (text: string) => theme.italic(text),
    strikethrough: (text: string) => theme.strikethrough(text),
    underline: (text: string) => theme.underline(text),
  };
}

function padLine(line: string, width: number): string {
  const truncated = truncateToWidth(line, width);
  return `${truncated}${" ".repeat(Math.max(0, width - visibleWidth(truncated)))}`;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(value, maximum));
}

function safeErrorMessage(error: unknown): string {
  return sanitizeTerminalText(error instanceof Error ? error.message : String(error)).slice(0, 500);
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && (error.name === "AbortError" || /aborted|disposed/iu.test(error.message));
}

function safeNotify(ctx: ExtensionCommandContext, message: string, level: "info" | "warning" | "error"): void {
  try {
    ctx.ui.notify(sanitizeTerminalText(message), level);
  } catch {
    // Session replacement can invalidate the parent UI during workspace cleanup.
  }
}
