import type { KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import {
  type Component,
  type Focusable,
  Input,
  Key,
  matchesKey,
  type TUI,
  truncateToWidth,
  visibleWidth,
} from "@earendil-works/pi-tui";
import type { ContentSearchMatch } from "./content-search.js";
import { ContentSearchSession } from "./content-search-session.js";
import {
  safeTerminalText as escapeTerminalControls,
  type ProjectBrowserItem,
  ProjectFileBrowser,
  parentProjectDirectory,
} from "./file-browser.js";
import { renderFileBrowser } from "./file-browser-ui.js";
import {
  createFileQuote,
  createFileQuoteSnapshot,
  type FileQuote,
  type LoadedProjectTextFile,
} from "./file-context.js";
import { renderFilePreview, renderFilePreviewHelp, type SelectedContextState } from "./file-context-preview-ui.js";
import { ProjectFileSearch } from "./file-search.js";
import type { GitBlameInfo, GitContext, GitFileContext, GitHistoryEntry, GitRevisionFile } from "./git-context.js";

const RESERVED_APP_ROWS = 3;
const EXPLORER_CHROME_ROWS = 4;
const HISTORY_CHROME_ROWS = 3;
const DIFF_CHROME_ROWS = 3;

export type FileQuoteExplorerResult =
  | { kind: "quote"; quote: FileQuote }
  | { kind: "reference"; path: string }
  | { kind: "back" }
  | { kind: "close" };

interface FileQuoteExplorerOptions {
  tui: TUI;
  theme: Theme;
  keybindings: KeybindingsManager;
  files: readonly string[];
  cwd?: string;
  loadFile: (path: string, signal?: AbortSignal) => Promise<LoadedProjectTextFile>;
  editFile?: (path: string, signal?: AbortSignal) => Promise<void>;
  gitContext?: GitContext;
  rootNavigation?: boolean;
  getSelectedContextState?: () => SelectedContextState;
  validateQuote?: (quote: FileQuote) => void;
  onAddAndContinue?: (quote: FileQuote) => void;
  done: (result: FileQuoteExplorerResult | undefined) => void;
}

/**
 * Keeps the explorer's coupled mode transitions and request generations in one controller so every
 * cancellation path invalidates the same state instead of coordinating lifecycle across components.
 */
export class FileQuoteExplorer implements Component, Focusable {
  private readonly search = new Input();
  private readonly contentSearch: ContentSearchSession;
  private readonly revisionInput = new Input();
  private readonly fileSearch: ProjectFileSearch;
  private readonly fileBrowser: ProjectFileBrowser;
  private fileItems: ProjectBrowserItem[];
  private currentDirectory = "";
  private readonly directoryPositions = new Map<string, { index: number; offset: number }>();
  private selectedFileIndex = 0;
  private fileScrollOffset = 0;
  private mode: "files" | "contents" | "preview" | "preview-help" | "history" | "revision" | "diff" = "files";
  private previewReturnMode: "files" | "contents" = "files";
  private activeContentMatch: ContentSearchMatch | undefined;
  private loadedFile: LoadedProjectTextFile | undefined;
  private loadedGit: GitFileContext | undefined;
  private previewCursor = 0;
  private previewAnchor: number | undefined;
  private previewScrollOffset = 0;
  private hunkIndex = -1;
  private blame: GitBlameInfo | undefined;
  private history: GitHistoryEntry[] = [];
  private historyIndex = 0;
  private loadedRevision: GitRevisionFile | undefined;
  private diffHunkIndex = 0;
  private diffScrollOffset = 0;
  private detailRequest = 0;
  private detailController: AbortController | undefined;
  private openRequest = 0;
  private openController: AbortController | undefined;
  private editRequest = 0;
  private editController: AbortController | undefined;
  private loading = false;
  private error: string | undefined;
  private finished = false;
  private disposed = false;
  private isFocused = false;

  constructor(private readonly options: FileQuoteExplorerOptions) {
    this.fileSearch = new ProjectFileSearch(options.files);
    this.fileBrowser = new ProjectFileBrowser(options.files);
    this.fileItems = this.fileBrowser.list("");
    this.contentSearch = new ContentSearchSession({
      tui: options.tui,
      theme: options.theme,
      keybindings: options.keybindings,
      files: options.files,
      cwd: options.cwd,
      loadFile: options.loadFile,
      onPreview: (match) => {
        void this.openFile(match.path, {
          returnMode: "contents",
          cursorIndex: match.lineNumber - 1,
          match,
        });
      },
      onReference: (path) => this.finish({ kind: "reference", path }),
      onSwitchFiles: () => this.showFileSearch(),
      onCancel: () => this.finish(this.rootExit("back")),
    });
  }

  get focused(): boolean {
    return this.isFocused;
  }

  set focused(value: boolean) {
    this.isFocused = value;
    this.search.focused = value && this.mode === "files";
    this.contentSearch.focused = value && this.mode === "contents";
    this.revisionInput.focused = value && this.mode === "revision";
  }

  render(width: number): string[] {
    const safeWidth = Math.max(1, width);
    if (this.mode === "files") return this.renderFileList(safeWidth);
    if (this.mode === "contents") return this.renderContentSearch(safeWidth);
    if (this.mode === "history") return this.renderHistory(safeWidth);
    if (this.mode === "revision") return this.renderRevisionInput(safeWidth);
    if (this.mode === "diff") return this.renderDiff(safeWidth);
    if (this.mode === "preview-help") return this.renderPreviewHelp(safeWidth);
    return this.renderPreview(safeWidth);
  }

  handleInput(data: string): void {
    if (this.finished || this.disposed) return;
    if (matchesKey(data, Key.ctrl("c"))) {
      this.finish(this.rootExit("close"));
      return;
    }
    if (this.mode === "files") this.handleFileInput(data);
    else if (this.mode === "contents") this.handleContentInput(data);
    else if (this.mode === "history") this.handleHistoryInput(data);
    else if (this.mode === "revision") this.handleRevisionInput(data);
    else if (this.mode === "diff") this.handleDiffInput(data);
    else if (this.mode === "preview-help") this.handlePreviewHelpInput(data);
    else this.handlePreviewInput(data);
    if (!this.finished) this.options.tui.requestRender();
  }

  invalidate(): void {
    this.search.invalidate();
    this.contentSearch.invalidate();
    this.revisionInput.invalidate();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.contentSearch.dispose();
    this.cancelOpenRequest();
    this.cancelDetailRequest();
    this.cancelEditRequest();
    if (!this.finished) {
      this.finished = true;
      this.options.done(undefined);
    }
  }

  private renderFileList(width: number): string[] {
    const availableRows = Math.max(1, this.options.tui.terminal.rows - RESERVED_APP_ROWS);
    const listHeight = Math.max(1, availableRows - EXPLORER_CHROME_ROWS);
    this.keepFileVisible(listHeight);
    const project = this.options.gitContext?.project;
    const repositoryLabel = project
      ? ` · ${escapeTerminalControls(project.branch)}@${project.head.slice(0, 12)}${project.dirty ? " · dirty" : ""}`
      : "";
    const queryLabel = this.options.theme.fg("muted", "Search: ");
    const queryWidth = Math.max(1, width - visibleWidth(queryLabel));
    const searchLine = `${queryLabel}${this.search.render(queryWidth)[0] ?? ""}`;
    return fitRows(
      renderFileBrowser({
        theme: this.options.theme,
        keybindings: this.options.keybindings,
        width,
        height: listHeight,
        items: this.fileItems,
        selectedIndex: this.selectedFileIndex,
        scrollOffset: this.fileScrollOffset,
        currentDirectory: this.currentDirectory,
        searchLine,
        searchActive: this.isFileSearchActive(),
        repositoryLabel,
        statuses: this.options.gitContext?.statuses,
        loading: this.loading,
        error: this.error,
      }),
      availableRows,
    );
  }

  private renderContentSearch(width: number): string[] {
    const availableRows = Math.max(1, this.options.tui.terminal.rows - RESERVED_APP_ROWS);
    return this.contentSearch.render(width, availableRows, this.loading, this.error);
  }

  private renderPreview(width: number): string[] {
    const availableRows = Math.max(1, this.options.tui.terminal.rows - RESERVED_APP_ROWS);
    if (!this.loadedFile) return [this.options.theme.fg("warning", "Loading preview…")];
    return renderFilePreview({
      theme: this.options.theme,
      keybindings: this.options.keybindings,
      width,
      availableRows,
      file: this.loadedFile,
      fileGit: this.loadedGit,
      project: this.options.gitContext?.project,
      revision: this.loadedRevision,
      contentMatch: this.activeContentMatch,
      blame: this.blame,
      cursor: this.previewCursor,
      anchor: this.previewAnchor,
      scrollOffset: this.previewScrollOffset,
      error: this.error,
      selectedContext: this.options.getSelectedContextState?.(),
      canContinue: this.options.onAddAndContinue !== undefined,
      canEdit: this.options.editFile !== undefined && this.loadedRevision === undefined,
    });
  }

  private renderPreviewHelp(width: number): string[] {
    const availableRows = Math.max(1, this.options.tui.terminal.rows - RESERVED_APP_ROWS);
    return renderFilePreviewHelp(
      this.options.theme,
      this.options.keybindings,
      width,
      availableRows,
      this.options.editFile !== undefined && this.loadedRevision === undefined,
    );
  }

  private renderRevisionInput(width: number): string[] {
    const availableRows = Math.max(1, this.options.tui.terminal.rows - RESERVED_APP_ROWS);
    const title = this.options.theme.fg(
      "accent",
      this.options.theme.bold(`Open Git revision · ${escapeTerminalControls(this.loadedFile?.path ?? "")}`),
    );
    const label = this.options.theme.fg("muted", "Revision: ");
    const inputWidth = Math.max(1, width - visibleWidth(label));
    const input = `${label}${this.revisionInput.render(inputWidth)[0] ?? ""}`;
    const state = this.error
      ? this.options.theme.fg("error", escapeTerminalControls(this.error))
      : this.loading
        ? this.options.theme.fg("warning", "Loading revision…")
        : this.options.theme.fg("muted", "Enter open commit/branch/tag · Esc preview");
    return fitRows(
      [truncateToWidth(title, width, ""), truncateToWidth(input, width, ""), truncateToWidth(state, width, "")],
      availableRows,
    );
  }

  private renderDiff(width: number): string[] {
    const availableRows = Math.max(1, this.options.tui.terminal.rows - RESERVED_APP_ROWS);
    const contentHeight = Math.max(1, availableRows - DIFF_CHROME_ROWS);
    const hunk = this.loadedGit?.hunks[this.diffHunkIndex];
    const path = escapeTerminalControls(this.loadedFile?.path ?? "");
    const title = this.options.theme.fg("accent", this.options.theme.bold(`Git diff · ${path} · HEAD → worktree`));
    const hunkLines = hunk?.lines ?? ["No changed hunks"];
    const maxScroll = Math.max(0, hunkLines.length - contentHeight);
    this.diffScrollOffset = Math.min(this.diffScrollOffset, maxScroll);
    const lines = hunkLines
      .slice(this.diffScrollOffset, this.diffScrollOffset + contentHeight)
      .map((line) =>
        truncateToWidth(
          line.startsWith("+")
            ? this.options.theme.fg("success", escapeTerminalControls(line))
            : line.startsWith("-")
              ? this.options.theme.fg("error", escapeTerminalControls(line))
              : escapeTerminalControls(line),
          width,
          "",
        ),
      );
    const text = hunk?.lines.join("\n") ?? "";
    const tokens = Math.max(1, Math.ceil(Buffer.byteLength(text, "utf8") / 4));
    const footer = this.error
      ? this.options.theme.fg("error", escapeTerminalControls(this.error))
      : `~${tokens} tokens · Enter attach diff · Hunk ${hunk ? this.diffHunkIndex + 1 : 0}/${this.loadedGit?.hunks.length ?? 0} · rows ${hunkLines.length === 0 ? 0 : this.diffScrollOffset + 1}-${Math.min(hunkLines.length, this.diffScrollOffset + contentHeight)}/${hunkLines.length} · ↑↓ scroll · [] navigate · Esc preview`;
    return fitRows(
      [truncateToWidth(title, width, ""), ...lines, truncateToWidth(this.options.theme.fg("muted", footer), width, "")],
      availableRows,
    );
  }

  private renderHistory(width: number): string[] {
    const availableRows = Math.max(1, this.options.tui.terminal.rows - RESERVED_APP_ROWS);
    const listHeight = Math.max(1, availableRows - HISTORY_CHROME_ROWS);
    const loadedFile = this.loadedFile;
    const title = this.options.theme.fg(
      "accent",
      this.options.theme.bold(`File history · ${escapeTerminalControls(loadedFile?.path ?? "")}`),
    );
    const start = Math.max(0, this.historyIndex - listHeight + 1);
    const entries = this.history.slice(start, start + listHeight).map((entry, visibleIndex) => {
      const index = start + visibleIndex;
      const prefix = index === this.historyIndex ? "> " : "  ";
      const date = formatHistoryDate(entry.authorTime);
      const line = `${prefix}${entry.commit.slice(0, 12)} · ${date} · ${escapeTerminalControls(entry.author)} · ${escapeTerminalControls(entry.summary)}`;
      return truncateToWidth(
        index === this.historyIndex ? this.options.theme.bg("selectedBg", this.options.theme.fg("text", line)) : line,
        width,
        "",
      );
    });
    if (entries.length === 0) {
      entries.push(truncateToWidth(this.options.theme.fg("muted", "  No file history"), width, ""));
    }
    const footer = this.error ? escapeTerminalControls(this.error) : "↑↓ navigate · Enter open revision · Esc preview";
    return fitRows(
      [
        truncateToWidth(title, width, ""),
        ...entries,
        truncateToWidth(this.options.theme.fg("muted", footer), width, ""),
      ],
      availableRows,
    );
  }

  private handleFileInput(data: string): void {
    if (this.options.keybindings.matches(data, "tui.select.cancel")) {
      this.cancelFileList();
      return;
    }
    if (matchesKey(data, Key.ctrl("f"))) {
      this.showContentSearch();
      return;
    }
    if (matchesKey(data, Key.escape)) {
      this.cancelFileList();
      return;
    }
    if (this.loading) return;
    if (this.options.keybindings.matches(data, "tui.select.up")) {
      this.selectedFileIndex = Math.max(0, this.selectedFileIndex - 1);
      return;
    }
    if (this.options.keybindings.matches(data, "tui.select.down")) {
      this.selectedFileIndex = Math.min(Math.max(0, this.fileItems.length - 1), this.selectedFileIndex + 1);
      return;
    }
    if (this.options.keybindings.matches(data, "tui.select.pageUp")) {
      this.selectedFileIndex = Math.max(0, this.selectedFileIndex - 10);
      return;
    }
    if (this.options.keybindings.matches(data, "tui.select.pageDown")) {
      this.selectedFileIndex = Math.min(Math.max(0, this.fileItems.length - 1), this.selectedFileIndex + 10);
      return;
    }
    if (this.options.keybindings.matches(data, "tui.select.confirm")) {
      this.openSelectedFileItem();
      return;
    }
    if (this.options.keybindings.matches(data, "tui.input.tab")) {
      const item = this.fileItems[this.selectedFileIndex];
      if (item?.kind === "file") this.finish({ kind: "reference", path: item.path });
      return;
    }
    if (
      !this.isFileSearchActive() &&
      this.currentDirectory &&
      (matchesKey(data, Key.left) || matchesKey(data, Key.backspace))
    ) {
      this.showParentDirectory();
      return;
    }
    if (!this.isFileSearchActive() && matchesKey(data, Key.right)) {
      const item = this.fileItems[this.selectedFileIndex];
      if (item?.kind === "directory") this.showDirectory(item.path);
      return;
    }

    const previousQuery = this.search.getValue();
    this.search.handleInput(data);
    const query = this.search.getValue();
    if (query !== previousQuery) {
      this.refreshFileItems(query);
      this.selectedFileIndex = 0;
      this.fileScrollOffset = 0;
      this.error = undefined;
    }
  }

  private handleContentInput(data: string): void {
    this.cancelOpenRequest();
    this.error = undefined;
    this.contentSearch.handleInput(data);
  }

  private handlePreviewInput(data: string): void {
    const loadedFile = this.loadedFile;
    if (!loadedFile) return;
    const lines = loadedFile.lines;
    if (this.options.keybindings.matches(data, "app.editor.external")) {
      if (this.loadedRevision) {
        this.error = "Historical revisions are read-only; return to the worktree preview to edit";
      } else if (this.options.editFile && !this.loading) {
        void this.editCurrentFile();
      } else if (!this.options.editFile) {
        this.error = "External editing is unavailable";
      }
      return;
    }
    if (matchesKey(data, Key.escape)) {
      this.returnToOrigin();
      return;
    }
    if (data === "?") {
      this.cancelDetailRequest();
      this.mode = "preview-help";
      this.search.focused = false;
      this.contentSearch.focused = false;
      return;
    }
    if (data === "a" && this.options.onAddAndContinue) {
      try {
        const quote = this.createSelectedQuote();
        this.options.onAddAndContinue(quote);
        this.returnToOrigin();
      } catch (error: unknown) {
        this.error = formatError(error);
      }
      return;
    }
    if (data === " ") {
      this.previewAnchor = this.previewAnchor === undefined ? this.previewCursor : undefined;
      this.error = undefined;
      return;
    }
    if (data === "b") {
      void this.loadBlame();
      return;
    }
    if (data === "h") {
      void this.loadHistory();
      return;
    }
    if (data === "r") {
      this.mode = "revision";
      this.revisionInput.setValue("");
      this.revisionInput.focused = this.isFocused;
      this.error = undefined;
      return;
    }
    if (data === "d") {
      if (this.loadedRevision) {
        this.error = "Diff context is available from the worktree preview";
        return;
      }
      if ((this.loadedGit?.hunks.length ?? 0) === 0) {
        this.error = "No changed hunks for this file";
        return;
      }
      this.diffHunkIndex = Math.max(0, this.hunkIndex);
      this.diffScrollOffset = 0;
      this.mode = "diff";
      this.error = undefined;
      return;
    }
    if (this.options.keybindings.matches(data, "tui.select.up")) {
      this.movePreviewCursor(Math.max(0, this.previewCursor - 1));
      return;
    }
    if (this.options.keybindings.matches(data, "tui.select.down")) {
      this.movePreviewCursor(Math.min(Math.max(0, lines.length - 1), this.previewCursor + 1));
      return;
    }
    if (this.options.keybindings.matches(data, "tui.select.pageUp")) {
      this.movePreviewCursor(Math.max(0, this.previewCursor - 10));
      return;
    }
    if (this.options.keybindings.matches(data, "tui.select.pageDown")) {
      this.movePreviewCursor(Math.min(Math.max(0, lines.length - 1), this.previewCursor + 10));
      return;
    }
    if (data === "]" || data === "[") {
      this.navigateHunk(data === "]" ? 1 : -1);
      return;
    }
    if (this.options.keybindings.matches(data, "tui.select.confirm")) {
      try {
        const quote = this.createSelectedQuote();
        this.options.validateQuote?.(quote);
        this.finish({ kind: "quote", quote });
      } catch (error: unknown) {
        this.error = formatError(error);
      }
    }
  }

  private handlePreviewHelpInput(data: string): void {
    if (matchesKey(data, Key.escape)) this.mode = "preview";
  }

  private handleHistoryInput(data: string): void {
    if (matchesKey(data, Key.escape)) {
      this.cancelDetailRequest();
      this.mode = "preview";
      this.error = undefined;
      return;
    }
    if (this.options.keybindings.matches(data, "tui.select.up")) {
      this.historyIndex = Math.max(0, this.historyIndex - 1);
      return;
    }
    if (this.options.keybindings.matches(data, "tui.select.down")) {
      this.historyIndex = Math.min(Math.max(0, this.history.length - 1), this.historyIndex + 1);
      return;
    }
    if (this.options.keybindings.matches(data, "tui.select.confirm")) {
      const entry = this.history[this.historyIndex];
      if (entry) void this.loadRevision(entry.commit, entry.path);
    }
  }

  private handleRevisionInput(data: string): void {
    if (matchesKey(data, Key.escape)) {
      this.cancelDetailRequest();
      this.mode = "preview";
      this.revisionInput.focused = false;
      this.error = undefined;
      return;
    }
    if (this.loading) return;
    if (this.options.keybindings.matches(data, "tui.select.confirm")) {
      void this.loadRevision(this.revisionInput.getValue());
      return;
    }
    this.revisionInput.handleInput(data);
  }

  private handleDiffInput(data: string): void {
    if (matchesKey(data, Key.escape)) {
      this.mode = "preview";
      this.error = undefined;
      return;
    }
    const hunks = this.loadedGit?.hunks ?? [];
    const hunkLines = hunks[this.diffHunkIndex]?.lines ?? [];
    if (this.options.keybindings.matches(data, "tui.select.up")) {
      this.diffScrollOffset = Math.max(0, this.diffScrollOffset - 1);
      return;
    }
    if (this.options.keybindings.matches(data, "tui.select.down")) {
      this.diffScrollOffset = Math.min(Math.max(0, hunkLines.length - 1), this.diffScrollOffset + 1);
      return;
    }
    if (this.options.keybindings.matches(data, "tui.select.pageUp")) {
      this.diffScrollOffset = Math.max(0, this.diffScrollOffset - 10);
      return;
    }
    if (this.options.keybindings.matches(data, "tui.select.pageDown")) {
      this.diffScrollOffset = Math.min(Math.max(0, hunkLines.length - 1), this.diffScrollOffset + 10);
      return;
    }
    if (data === "]" || data === "[") {
      if (hunks.length > 0) {
        const direction = data === "]" ? 1 : -1;
        this.diffHunkIndex = (this.diffHunkIndex + direction + hunks.length) % hunks.length;
        this.diffScrollOffset = 0;
      }
      return;
    }
    if (this.options.keybindings.matches(data, "tui.select.confirm")) {
      const hunk = hunks[this.diffHunkIndex];
      const loadedFile = this.loadedFile;
      const project = this.options.gitContext?.project;
      if (!hunk || !loadedFile || !project) return;
      try {
        const startLine = Math.max(1, hunk.newStart);
        const endLine = Math.max(startLine, hunk.newStart + hunk.newCount - 1);
        const quote = createFileQuoteSnapshot(loadedFile.path, startLine, endLine, hunk.lines.join("\n"), {
          head: project.head,
          branch: project.branch,
          status: this.loadedGit?.status?.label ?? "modified",
          blob: this.loadedGit?.blob,
          source: "git_diff",
          base: "HEAD",
        });
        this.options.validateQuote?.(quote);
        this.finish({ kind: "quote", quote });
      } catch (error: unknown) {
        this.error = formatError(error);
      }
    }
  }

  private async editCurrentFile(): Promise<void> {
    const path = this.loadedFile?.path;
    const editFile = this.options.editFile;
    if (!path || !editFile || this.loadedRevision) return;
    this.cancelOpenRequest();
    this.cancelDetailRequest();
    this.cancelEditRequest();
    const request = this.editRequest;
    const controller = new AbortController();
    this.editController = controller;
    this.loading = true;
    this.error = undefined;
    this.options.tui.requestRender();
    try {
      await editFile(path, controller.signal);
      if (!this.isCurrentEditRequest(request, controller, path)) return;
      const gitContext = this.options.gitContext;
      const [loadedFile, loadedGit] = await Promise.all([
        this.options.loadFile(path, controller.signal),
        gitContext
          ? (gitContext.refreshFileContext?.(path, controller.signal) ??
            gitContext.getFileContext(path, controller.signal))
          : undefined,
      ]);
      if (!this.isCurrentEditRequest(request, controller, path)) return;
      const maximumIndex = Math.max(0, loadedFile.lines.length - 1);
      this.loadedFile = loadedFile;
      this.loadedGit = loadedGit;
      this.previewCursor = Math.min(this.previewCursor, maximumIndex);
      if (this.previewAnchor !== undefined) {
        this.previewAnchor = Math.min(this.previewAnchor, maximumIndex);
      }
      this.previewScrollOffset = Math.min(this.previewScrollOffset, maximumIndex);
      this.activeContentMatch = undefined;
      this.hunkIndex = -1;
      this.blame = undefined;
      this.history = [];
      this.error = undefined;
    } catch (error: unknown) {
      if (this.isCurrentEditRequest(request, controller, path) && !isAbortError(error)) {
        this.error = formatError(error);
      }
    } finally {
      if (request === this.editRequest && this.editController === controller) {
        this.loading = false;
        this.editController = undefined;
      }
      if (!this.finished && !this.disposed) this.options.tui.requestRender(true);
    }
  }

  private async loadRevision(revision: string, historicalPath?: string): Promise<void> {
    const path = this.loadedFile?.path;
    const gitContext = this.options.gitContext;
    if (!path || !gitContext) {
      this.error = "Git revision browsing is unavailable";
      return;
    }
    const { request, signal } = this.beginDetailRequest();
    this.error = undefined;
    this.options.tui.requestRender();
    try {
      const loadedRevision = await gitContext.loadRevision(path, revision, historicalPath, signal);
      if (this.finished || request !== this.detailRequest) return;
      this.loadedRevision = loadedRevision;
      this.loadedFile = { path: loadedRevision.path, lines: loadedRevision.lines };
      this.activeContentMatch = undefined;
      this.previewCursor = 0;
      this.previewAnchor = undefined;
      this.previewScrollOffset = 0;
      this.blame = undefined;
      this.mode = "preview";
      this.revisionInput.focused = false;
    } catch (error: unknown) {
      if (request === this.detailRequest && !isAbortError(error)) this.error = formatError(error);
    } finally {
      this.finishDetailRequest(request);
    }
  }

  private async loadBlame(): Promise<void> {
    const path = this.loadedFile?.path;
    const gitContext = this.options.gitContext;
    if (!path || !gitContext) {
      this.error = "Git blame is unavailable";
      return;
    }
    const { request, signal } = this.beginDetailRequest();
    const requestedLine = this.previewCursor + 1;
    this.error = undefined;
    this.options.tui.requestRender();
    try {
      const blame = await gitContext.getBlame(path, requestedLine, this.loadedRevision?.commit, signal);
      if (
        this.finished ||
        request !== this.detailRequest ||
        this.mode !== "preview" ||
        requestedLine !== this.previewCursor + 1
      ) {
        return;
      }
      this.blame = blame;
      if (!blame) this.error = "No blame information for this line";
    } catch (error: unknown) {
      if (request === this.detailRequest && !isAbortError(error)) this.error = formatError(error);
    } finally {
      this.finishDetailRequest(request);
    }
  }

  private async loadHistory(): Promise<void> {
    const path = this.loadedFile?.path;
    const gitContext = this.options.gitContext;
    if (!path || !gitContext) {
      this.error = "Git history is unavailable";
      return;
    }
    const { request, signal } = this.beginDetailRequest();
    this.error = undefined;
    this.options.tui.requestRender();
    try {
      const history = await gitContext.getHistory(path, signal);
      if (this.finished || request !== this.detailRequest || this.mode !== "preview") return;
      this.history = history;
      this.historyIndex = 0;
      this.mode = "history";
    } catch (error: unknown) {
      if (request === this.detailRequest && !isAbortError(error)) this.error = formatError(error);
    } finally {
      this.finishDetailRequest(request);
    }
  }

  private async openFile(
    path: string,
    options: {
      returnMode?: "files" | "contents";
      cursorIndex?: number;
      match?: ContentSearchMatch;
    } = {},
  ): Promise<void> {
    this.cancelOpenRequest();
    const request = this.openRequest;
    const controller = new AbortController();
    this.openController = controller;
    this.loading = true;
    this.error = undefined;
    this.options.tui.requestRender();
    try {
      const [loadedFile, loadedGit] = await Promise.all([
        this.options.loadFile(path, controller.signal),
        this.options.gitContext?.getFileContext(path, controller.signal),
      ]);
      if (!this.isCurrentOpenRequest(request, controller)) return;
      this.loadedFile = loadedFile;
      this.loadedGit = loadedGit;
      this.loadedRevision = undefined;
      this.mode = "preview";
      this.previewReturnMode = options.returnMode ?? "files";
      this.activeContentMatch = options.match;
      this.previewCursor = Math.max(0, Math.min(Math.max(0, loadedFile.lines.length - 1), options.cursorIndex ?? 0));
      this.previewAnchor = undefined;
      this.previewScrollOffset = Math.max(0, this.previewCursor - 1);
      this.hunkIndex = -1;
      this.blame = undefined;
      this.history = [];
      this.detailRequest += 1;
      this.error = undefined;
      this.search.focused = false;
      this.contentSearch.focused = false;
    } catch (error: unknown) {
      if (this.isCurrentOpenRequest(request, controller) && !isAbortError(error)) {
        this.error = formatError(error);
      }
    } finally {
      if (request === this.openRequest) {
        this.loading = false;
        this.openController = undefined;
      }
      if (!this.finished && !this.disposed) this.options.tui.requestRender();
    }
  }

  private navigateHunk(direction: 1 | -1): void {
    const hunks = this.loadedGit?.hunks ?? [];
    const lineCount = this.loadedFile?.lines.length ?? 0;
    if (hunks.length === 0 || lineCount === 0) {
      this.error = "No changed hunks for this file";
      return;
    }
    this.hunkIndex =
      this.hunkIndex < 0
        ? direction > 0
          ? 0
          : hunks.length - 1
        : (this.hunkIndex + direction + hunks.length) % hunks.length;
    const hunk = hunks[this.hunkIndex];
    const selectedLines = hunk.changedLines.length > 0 ? hunk.changedLines : [hunk.newStart];
    const start = Math.max(0, Math.min(...selectedLines) - 1);
    const end = Math.max(start, Math.min(lineCount - 1, Math.max(...selectedLines) - 1));
    this.previewAnchor = start;
    this.movePreviewCursor(end);
    this.error = undefined;
  }

  private showContentSearch(): void {
    this.cancelOpenRequest();
    this.mode = "contents";
    this.search.focused = false;
    this.contentSearch.activate();
    this.contentSearch.focused = this.isFocused;
    this.error = undefined;
  }

  private showFileSearch(): void {
    this.contentSearch.deactivate();
    this.cancelOpenRequest();
    this.mode = "files";
    this.search.focused = this.isFocused;
    this.error = undefined;
  }

  private openSelectedFileItem(): void {
    const item = this.fileItems[this.selectedFileIndex];
    if (item?.kind === "directory") {
      this.showDirectory(item.path);
      return;
    }
    if (item?.kind === "file") void this.openFile(item.path);
  }

  private showDirectory(directory: string): void {
    this.directoryPositions.set(this.currentDirectory, {
      index: this.selectedFileIndex,
      offset: this.fileScrollOffset,
    });
    this.currentDirectory = directory;
    this.refreshFileItems("");
    const position = this.directoryPositions.get(directory);
    this.selectedFileIndex = Math.min(position?.index ?? 0, Math.max(0, this.fileItems.length - 1));
    this.fileScrollOffset = Math.min(position?.offset ?? 0, this.selectedFileIndex);
    this.error = undefined;
  }

  private showParentDirectory(): void {
    this.cancelOpenRequest();
    this.currentDirectory = parentProjectDirectory(this.currentDirectory);
    this.refreshFileItems("");
    const position = this.directoryPositions.get(this.currentDirectory);
    this.selectedFileIndex = Math.min(position?.index ?? 0, Math.max(0, this.fileItems.length - 1));
    this.fileScrollOffset = Math.min(position?.offset ?? 0, this.selectedFileIndex);
    this.error = undefined;
  }

  private refreshFileItems(query: string): void {
    this.fileItems = this.isFileSearchActive(query)
      ? this.fileBrowser.searchResults(this.fileSearch.search(query))
      : this.fileBrowser.list(this.currentDirectory);
  }

  private isFileSearchActive(query = this.search.getValue()): boolean {
    return escapeTerminalControls(query).trim().length > 0;
  }

  private cancelFileList(): void {
    if (this.currentDirectory && !this.isFileSearchActive()) {
      this.showParentDirectory();
      return;
    }
    this.finish(this.rootExit("back"));
  }

  private cancelOpenRequest(): void {
    this.openRequest += 1;
    this.openController?.abort();
    this.openController = undefined;
    this.loading = false;
  }

  private isCurrentOpenRequest(request: number, controller: AbortController): boolean {
    return (
      !this.finished &&
      !this.disposed &&
      request === this.openRequest &&
      this.openController === controller &&
      !controller.signal.aborted
    );
  }

  private isCurrentEditRequest(request: number, controller: AbortController, path: string): boolean {
    return (
      !this.finished &&
      !this.disposed &&
      this.mode === "preview" &&
      this.loadedRevision === undefined &&
      this.loadedFile?.path === path &&
      request === this.editRequest &&
      this.editController === controller &&
      !controller.signal.aborted
    );
  }

  private beginDetailRequest(): { request: number; signal: AbortSignal } {
    this.cancelDetailRequest();
    const request = this.detailRequest;
    const controller = new AbortController();
    this.detailController = controller;
    this.loading = true;
    return { request, signal: controller.signal };
  }

  private finishDetailRequest(request: number): void {
    if (request === this.detailRequest) {
      this.loading = false;
      this.detailController = undefined;
    }
    if (!this.finished && !this.disposed) this.options.tui.requestRender();
  }

  private cancelDetailRequest(): void {
    this.detailRequest += 1;
    this.detailController?.abort();
    this.detailController = undefined;
    this.loading = false;
  }

  private cancelEditRequest(): void {
    this.editRequest += 1;
    this.editController?.abort();
    this.editController = undefined;
    this.loading = false;
  }

  private movePreviewCursor(next: number): void {
    if (next === this.previewCursor) return;
    this.cancelDetailRequest();
    this.previewCursor = next;
    this.blame = undefined;
    this.error = undefined;
  }

  private createSelectedQuote(): FileQuote {
    const loadedFile = this.loadedFile;
    if (!loadedFile) throw new Error("No file is open");
    const anchor = this.previewAnchor ?? this.previewCursor;
    const project = this.options.gitContext?.project;
    const revision = this.loadedRevision;
    return createFileQuote(
      loadedFile.path,
      loadedFile.lines,
      anchor,
      this.previewCursor,
      project
        ? {
            head: project.head,
            branch: project.branch,
            status: revision ? "historical" : (this.loadedGit?.status?.label ?? "clean"),
            revision: revision?.revision,
            blob: revision?.blob ?? this.loadedGit?.blob,
            source: revision ? "revision" : "worktree",
            base: revision ? undefined : "HEAD",
          }
        : undefined,
    );
  }

  private returnToOrigin(): void {
    this.cancelDetailRequest();
    this.cancelOpenRequest();
    this.cancelEditRequest();
    this.mode = this.previewReturnMode;
    this.loadedFile = undefined;
    this.loadedGit = undefined;
    this.loadedRevision = undefined;
    this.previewAnchor = undefined;
    this.blame = undefined;
    this.error = undefined;
    this.search.focused = this.isFocused && this.mode === "files";
    this.contentSearch.focused = this.isFocused && this.mode === "contents";
  }

  private finish(result: FileQuoteExplorerResult | undefined): void {
    this.finished = true;
    this.contentSearch.dispose();
    this.cancelOpenRequest();
    this.cancelDetailRequest();
    this.cancelEditRequest();
    this.options.done(result);
  }

  private rootExit(kind: "back" | "close"): FileQuoteExplorerResult | undefined {
    return this.options.rootNavigation ? { kind } : undefined;
  }

  private keepFileVisible(height: number): void {
    if (this.selectedFileIndex < this.fileScrollOffset) this.fileScrollOffset = this.selectedFileIndex;
    if (this.selectedFileIndex >= this.fileScrollOffset + height) {
      this.fileScrollOffset = this.selectedFileIndex - height + 1;
    }
  }
}

function fitRows(lines: string[], height: number): string[] {
  if (lines.length <= height) return lines;
  if (height <= 1) return lines.slice(0, 1);
  return [...lines.slice(0, height - 1), lines.at(-1) ?? ""];
}

function formatHistoryDate(authorTime: number): string {
  const date = new Date(authorTime * 1_000);
  return Number.isFinite(date.getTime()) ? date.toISOString().slice(0, 10) : "unknown-date";
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
