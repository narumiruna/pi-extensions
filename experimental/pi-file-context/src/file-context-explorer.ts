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
import {
	createFileQuote,
	createFileQuoteSnapshot,
	type FileQuote,
	type LoadedProjectTextFile,
} from "./file-context.js";
import { ProjectFileSearch } from "./file-search.js";
import type {
	GitBlameInfo,
	GitContext,
	GitFileContext,
	GitHistoryEntry,
	GitRevisionFile,
} from "./git-context.js";

const RESERVED_APP_ROWS = 3;
const EXPLORER_CHROME_ROWS = 4;
const PREVIEW_CHROME_ROWS = 4;
const HISTORY_CHROME_ROWS = 3;
const DIFF_CHROME_ROWS = 3;

export type FileQuoteExplorerResult =
	| { kind: "quote"; quote: FileQuote }
	| { kind: "reference"; path: string };

interface FileQuoteExplorerOptions {
	tui: TUI;
	theme: Theme;
	keybindings: KeybindingsManager;
	files: readonly string[];
	initialPath?: string;
	loadFile: (path: string) => Promise<LoadedProjectTextFile>;
	gitContext?: GitContext;
	done: (result: FileQuoteExplorerResult | undefined) => void;
}

export class FileQuoteExplorer implements Component, Focusable {
	private readonly search = new Input();
	private readonly revisionInput = new Input();
	private readonly fileSearch: ProjectFileSearch;
	private filteredFiles: string[];
	private selectedFileIndex = 0;
	private fileScrollOffset = 0;
	private mode: "files" | "preview" | "history" | "revision" | "diff" = "files";
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
	private loading = false;
	private error: string | undefined;
	private finished = false;
	private isFocused = false;

	constructor(private readonly options: FileQuoteExplorerOptions) {
		this.fileSearch = new ProjectFileSearch(options.files);
		this.filteredFiles = [...options.files];
		if (options.initialPath && options.files.includes(options.initialPath)) {
			this.selectedFileIndex = options.files.indexOf(options.initialPath);
			void this.openFile(options.initialPath);
		}
	}

	get focused(): boolean {
		return this.isFocused;
	}

	set focused(value: boolean) {
		this.isFocused = value;
		this.search.focused = value && this.mode === "files";
		this.revisionInput.focused = value && this.mode === "revision";
	}

	render(width: number): string[] {
		const safeWidth = Math.max(1, width);
		if (this.mode === "files") return this.renderFileList(safeWidth);
		if (this.mode === "history") return this.renderHistory(safeWidth);
		if (this.mode === "revision") return this.renderRevisionInput(safeWidth);
		if (this.mode === "diff") return this.renderDiff(safeWidth);
		return this.renderPreview(safeWidth);
	}

	handleInput(data: string): void {
		if (this.finished) return;
		if (matchesKey(data, Key.ctrl("c"))) {
			this.finish(undefined);
			return;
		}
		if (this.mode === "files") this.handleFileInput(data);
		else if (this.mode === "history") this.handleHistoryInput(data);
		else if (this.mode === "revision") this.handleRevisionInput(data);
		else if (this.mode === "diff") this.handleDiffInput(data);
		else this.handlePreviewInput(data);
		if (!this.finished) this.options.tui.requestRender();
	}

	invalidate(): void {
		this.search.invalidate();
		this.revisionInput.invalidate();
	}

	private renderFileList(width: number): string[] {
		const availableRows = Math.max(1, this.options.tui.terminal.rows - RESERVED_APP_ROWS);
		const listHeight = Math.max(1, availableRows - EXPLORER_CHROME_ROWS);
		this.keepFileVisible(listHeight);
		const project = this.options.gitContext?.project;
		const repositoryLabel = project
			? ` · ${escapeTerminalControls(project.branch)}@${project.head.slice(0, 12)}${project.dirty ? " · dirty" : ""}`
			: "";
		const title = this.options.theme.fg(
			"accent",
			this.options.theme.bold(`File Context · files${repositoryLabel}`),
		);
		const queryLabel = this.options.theme.fg("muted", "Search: ");
		const queryWidth = Math.max(1, width - visibleWidth(queryLabel));
		const searchLine = `${queryLabel}${this.search.render(queryWidth)[0] ?? ""}`;
		const visibleFiles = this.filteredFiles.slice(
			this.fileScrollOffset,
			this.fileScrollOffset + listHeight,
		);
		const fileLines = visibleFiles.map((file, visibleIndex) => {
			const index = this.fileScrollOffset + visibleIndex;
			const prefix = index === this.selectedFileIndex ? "> " : "  ";
			const status = this.options.gitContext?.statuses.get(file)?.code ?? "  ";
			const line = `${prefix}${status} ${escapeTerminalControls(file)}`;
			return truncateToWidth(
				index === this.selectedFileIndex
					? this.options.theme.bg("selectedBg", this.options.theme.fg("text", line))
					: line,
				width,
				"",
			);
		});
		if (fileLines.length === 0) {
			fileLines.push(
				truncateToWidth(this.options.theme.fg("muted", "  No matching files"), width, ""),
			);
		}
		const state = this.loading
			? this.options.theme.fg("warning", "Loading…")
			: this.error
				? this.options.theme.fg(
						"error",
						truncateToWidth(escapeTerminalControls(this.error), width, ""),
					)
				: this.options.theme.fg(
						"muted",
						`${this.filteredFiles.length} files · ↑↓ navigate · Enter preview · Tab reference · Esc cancel`,
					);
		return fitRows(
			[
				truncateToWidth(title, width, ""),
				truncateToWidth(searchLine, width, ""),
				...fileLines,
				truncateToWidth(state, width, ""),
			],
			availableRows,
		);
	}

	private renderPreview(width: number): string[] {
		const availableRows = Math.max(1, this.options.tui.terminal.rows - RESERVED_APP_ROWS);
		const previewHeight = Math.max(1, availableRows - PREVIEW_CHROME_ROWS);
		const loadedFile = this.loadedFile;
		if (!loadedFile) return [this.options.theme.fg("warning", "Loading preview…")];
		this.keepPreviewVisible(previewHeight);
		const digits = String(Math.max(1, loadedFile.lines.length)).length;
		const range = this.getSelectionRange();
		const changedLines = new Set(this.loadedGit?.hunks.flatMap((hunk) => hunk.changedLines) ?? []);
		const deletedAtLines = new Set(
			(this.loadedGit?.hunks ?? [])
				.filter((hunk) => hunk.changedLines.length === 0 && hunk.oldCount > 0)
				.map((hunk) => Math.max(1, hunk.newStart)),
		);
		const visibleLines = loadedFile.lines.slice(
			this.previewScrollOffset,
			this.previewScrollOffset + previewHeight,
		);
		const previewLines = visibleLines.map((rawLine, visibleIndex) => {
			const index = this.previewScrollOffset + visibleIndex;
			const selected = index >= range.start && index <= range.end;
			const cursor = index === this.previewCursor ? ">" : " ";
			const marker = changedLines.has(index + 1) ? "+" : deletedAtLines.has(index + 1) ? "-" : " ";
			const number = String(index + 1).padStart(digits, " ");
			const line = `${cursor}${marker}${number} │ ${escapeTerminalControls(rawLine)}`;
			const styled = selected
				? this.options.theme.bg("selectedBg", this.options.theme.fg("text", line))
				: index === this.previewCursor
					? this.options.theme.fg("accent", line)
					: line;
			return truncateToWidth(styled, width, "");
		});
		if (previewLines.length === 0) {
			previewLines.push(truncateToWidth(this.options.theme.fg("muted", "  Empty file"), width, ""));
		}
		const selecting =
			this.previewAnchor === undefined
				? "cursor line"
				: `lines ${range.start + 1}-${range.end + 1}`;
		const selectedText = loadedFile.lines.slice(range.start, range.end + 1).join("\n");
		const estimatedTokens = Math.max(1, Math.ceil(Buffer.byteLength(selectedText, "utf8") / 4));
		const footer = this.error
			? this.options.theme.fg("error", escapeTerminalControls(this.error))
			: `~${estimatedTokens} tokens · Enter attach ${selecting} · Space anchor · ↑↓ extend · [] hunks · b blame · h history · r revision · d diff · Esc files`;
		const project = this.options.gitContext?.project;
		const gitLabel = this.loadedRevision
			? `${escapeTerminalControls(this.loadedRevision.revision)}@${this.loadedRevision.commit.slice(0, 12)} · historical`
			: project
				? `${escapeTerminalControls(project.branch)}@${project.head.slice(0, 12)}${project.dirty ? " · dirty" : ""}${this.loadedGit?.status ? ` · ${this.loadedGit.status.label}` : " · clean"}`
				: "";
		const blameLabel = this.blame
			? `L${this.previewCursor + 1} · ${this.blame.committed ? this.blame.commit.slice(0, 12) : "uncommitted"} · ${escapeTerminalControls(this.blame.author)} · ${escapeTerminalControls(this.blame.summary)}`
			: "";
		return fitRows(
			[
				truncateToWidth(
					this.options.theme.fg(
						"accent",
						this.options.theme.bold(
							`${escapeTerminalControls(loadedFile.path)}${gitLabel ? ` · ${gitLabel}` : ""}`,
						),
					),
					width,
					"",
				),
				truncateToWidth(this.options.theme.fg("muted", blameLabel), width, ""),
				...previewLines,
				truncateToWidth(this.options.theme.fg("muted", footer), width, ""),
			],
			availableRows,
		);
	}

	private renderRevisionInput(width: number): string[] {
		const availableRows = Math.max(1, this.options.tui.terminal.rows - RESERVED_APP_ROWS);
		const title = this.options.theme.fg(
			"accent",
			this.options.theme.bold(
				`Open Git revision · ${escapeTerminalControls(this.loadedFile?.path ?? "")}`,
			),
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
			[
				truncateToWidth(title, width, ""),
				truncateToWidth(input, width, ""),
				truncateToWidth(state, width, ""),
			],
			availableRows,
		);
	}

	private renderDiff(width: number): string[] {
		const availableRows = Math.max(1, this.options.tui.terminal.rows - RESERVED_APP_ROWS);
		const contentHeight = Math.max(1, availableRows - DIFF_CHROME_ROWS);
		const hunk = this.loadedGit?.hunks[this.diffHunkIndex];
		const path = escapeTerminalControls(this.loadedFile?.path ?? "");
		const title = this.options.theme.fg(
			"accent",
			this.options.theme.bold(`Git diff · ${path} · HEAD → worktree`),
		);
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
			[
				truncateToWidth(title, width, ""),
				...lines,
				truncateToWidth(this.options.theme.fg("muted", footer), width, ""),
			],
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
				index === this.historyIndex
					? this.options.theme.bg("selectedBg", this.options.theme.fg("text", line))
					: line,
				width,
				"",
			);
		});
		if (entries.length === 0) {
			entries.push(truncateToWidth(this.options.theme.fg("muted", "  No file history"), width, ""));
		}
		const footer = this.error
			? escapeTerminalControls(this.error)
			: "↑↓ navigate · Enter open revision · Esc preview";
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
		if (matchesKey(data, Key.escape)) {
			this.finish(undefined);
			return;
		}
		if (this.loading) return;
		if (this.options.keybindings.matches(data, "tui.select.up")) {
			this.selectedFileIndex = Math.max(0, this.selectedFileIndex - 1);
			return;
		}
		if (this.options.keybindings.matches(data, "tui.select.down")) {
			this.selectedFileIndex = Math.min(
				Math.max(0, this.filteredFiles.length - 1),
				this.selectedFileIndex + 1,
			);
			return;
		}
		if (this.options.keybindings.matches(data, "tui.select.pageUp")) {
			this.selectedFileIndex = Math.max(0, this.selectedFileIndex - 10);
			return;
		}
		if (this.options.keybindings.matches(data, "tui.select.pageDown")) {
			this.selectedFileIndex = Math.min(
				Math.max(0, this.filteredFiles.length - 1),
				this.selectedFileIndex + 10,
			);
			return;
		}
		if (this.options.keybindings.matches(data, "tui.select.confirm")) {
			const path = this.filteredFiles[this.selectedFileIndex];
			if (path) void this.openFile(path);
			return;
		}
		if (this.options.keybindings.matches(data, "tui.input.tab")) {
			const path = this.filteredFiles[this.selectedFileIndex];
			if (path) this.finish({ kind: "reference", path });
			return;
		}

		const previousQuery = this.search.getValue();
		this.search.handleInput(data);
		const query = this.search.getValue();
		if (query !== previousQuery) {
			this.filteredFiles = this.fileSearch.search(query);
			this.selectedFileIndex = 0;
			this.fileScrollOffset = 0;
			this.error = undefined;
		}
	}

	private handlePreviewInput(data: string): void {
		const loadedFile = this.loadedFile;
		if (!loadedFile) return;
		const lines = loadedFile.lines;
		if (matchesKey(data, Key.escape)) {
			this.cancelDetailRequest();
			this.mode = "files";
			this.loadedFile = undefined;
			this.loadedGit = undefined;
			this.loadedRevision = undefined;
			this.previewAnchor = undefined;
			this.blame = undefined;
			this.search.focused = this.isFocused;
			return;
		}
		if (data === " ") {
			this.previewAnchor = this.previewAnchor === undefined ? this.previewCursor : undefined;
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
			const anchor = this.previewAnchor ?? this.previewCursor;
			try {
				const project = this.options.gitContext?.project;
				const revision = this.loadedRevision;
				this.finish({
					kind: "quote",
					quote: createFileQuote(
						loadedFile.path,
						lines,
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
					),
				});
			} catch (error: unknown) {
				this.error = formatError(error);
			}
		}
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
			this.diffScrollOffset = Math.min(
				Math.max(0, hunkLines.length - 1),
				this.diffScrollOffset + 1,
			);
			return;
		}
		if (this.options.keybindings.matches(data, "tui.select.pageUp")) {
			this.diffScrollOffset = Math.max(0, this.diffScrollOffset - 10);
			return;
		}
		if (this.options.keybindings.matches(data, "tui.select.pageDown")) {
			this.diffScrollOffset = Math.min(
				Math.max(0, hunkLines.length - 1),
				this.diffScrollOffset + 10,
			);
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
				this.finish({
					kind: "quote",
					quote: createFileQuoteSnapshot(
						loadedFile.path,
						startLine,
						endLine,
						hunk.lines.join("\n"),
						{
							head: project.head,
							branch: project.branch,
							status: this.loadedGit?.status?.label ?? "modified",
							blob: this.loadedGit?.blob,
							source: "git_diff",
							base: "HEAD",
						},
					),
				});
			} catch (error: unknown) {
				this.error = formatError(error);
			}
		}
	}

	private async loadRevision(revision: string, historicalPath?: string): Promise<void> {
		const path = this.loadedFile?.path;
		const gitContext = this.options.gitContext;
		if (!path || !gitContext) {
			this.error = "Git revision browsing is unavailable";
			return;
		}
		const request = this.beginDetailRequest();
		this.error = undefined;
		this.options.tui.requestRender();
		try {
			const loadedRevision = await gitContext.loadRevision(path, revision, historicalPath);
			if (this.finished || request !== this.detailRequest) return;
			this.loadedRevision = loadedRevision;
			this.loadedFile = { path: loadedRevision.path, lines: loadedRevision.lines };
			this.previewCursor = 0;
			this.previewAnchor = undefined;
			this.previewScrollOffset = 0;
			this.blame = undefined;
			this.mode = "preview";
			this.revisionInput.focused = false;
		} catch (error: unknown) {
			if (request === this.detailRequest) this.error = formatError(error);
		} finally {
			if (request === this.detailRequest) this.loading = false;
			this.options.tui.requestRender();
		}
	}

	private async loadBlame(): Promise<void> {
		const path = this.loadedFile?.path;
		const gitContext = this.options.gitContext;
		if (!path || !gitContext) {
			this.error = "Git blame is unavailable";
			return;
		}
		const request = this.beginDetailRequest();
		const requestedLine = this.previewCursor + 1;
		this.error = undefined;
		this.options.tui.requestRender();
		try {
			const blame = await gitContext.getBlame(path, requestedLine, this.loadedRevision?.commit);
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
			if (request === this.detailRequest) this.error = formatError(error);
		} finally {
			if (request === this.detailRequest) this.loading = false;
			this.options.tui.requestRender();
		}
	}

	private async loadHistory(): Promise<void> {
		const path = this.loadedFile?.path;
		const gitContext = this.options.gitContext;
		if (!path || !gitContext) {
			this.error = "Git history is unavailable";
			return;
		}
		const request = this.beginDetailRequest();
		this.error = undefined;
		this.options.tui.requestRender();
		try {
			const history = await gitContext.getHistory(path);
			if (this.finished || request !== this.detailRequest || this.mode !== "preview") return;
			this.history = history;
			this.historyIndex = 0;
			this.mode = "history";
		} catch (error: unknown) {
			if (request === this.detailRequest) this.error = formatError(error);
		} finally {
			if (request === this.detailRequest) this.loading = false;
			this.options.tui.requestRender();
		}
	}

	private async openFile(path: string): Promise<void> {
		this.loading = true;
		this.error = undefined;
		this.options.tui.requestRender();
		try {
			const [loadedFile, loadedGit] = await Promise.all([
				this.options.loadFile(path),
				this.options.gitContext?.getFileContext(path),
			]);
			if (this.finished) return;
			this.loadedFile = loadedFile;
			this.loadedGit = loadedGit;
			this.loadedRevision = undefined;
			this.mode = "preview";
			this.previewCursor = 0;
			this.previewAnchor = undefined;
			this.previewScrollOffset = 0;
			this.hunkIndex = -1;
			this.blame = undefined;
			this.history = [];
			this.detailRequest += 1;
			this.error = undefined;
			this.search.focused = false;
		} catch (error: unknown) {
			this.error = formatError(error);
		} finally {
			this.loading = false;
			this.options.tui.requestRender();
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

	private beginDetailRequest(): number {
		const request = ++this.detailRequest;
		this.loading = true;
		return request;
	}

	private cancelDetailRequest(): void {
		this.detailRequest += 1;
		this.loading = false;
	}

	private movePreviewCursor(next: number): void {
		if (next === this.previewCursor) return;
		this.cancelDetailRequest();
		this.previewCursor = next;
		this.blame = undefined;
	}

	private finish(result: FileQuoteExplorerResult | undefined): void {
		this.finished = true;
		this.options.done(result);
	}

	private getSelectionRange(): { start: number; end: number } {
		const anchor = this.previewAnchor ?? this.previewCursor;
		return {
			start: Math.min(anchor, this.previewCursor),
			end: Math.max(anchor, this.previewCursor),
		};
	}

	private keepFileVisible(height: number): void {
		if (this.selectedFileIndex < this.fileScrollOffset)
			this.fileScrollOffset = this.selectedFileIndex;
		if (this.selectedFileIndex >= this.fileScrollOffset + height) {
			this.fileScrollOffset = this.selectedFileIndex - height + 1;
		}
	}

	private keepPreviewVisible(height: number): void {
		if (this.previewCursor < this.previewScrollOffset)
			this.previewScrollOffset = this.previewCursor;
		if (this.previewCursor >= this.previewScrollOffset + height) {
			this.previewScrollOffset = this.previewCursor - height + 1;
		}
	}
}

function fitRows(lines: string[], height: number): string[] {
	if (lines.length <= height) return lines;
	if (height <= 1) return lines.slice(0, 1);
	return [...lines.slice(0, height - 1), lines.at(-1) ?? ""];
}

function escapeTerminalControls(text: string): string {
	return [...text]
		.map((character) => {
			if (character === "\t") return "    ";
			const code = character.charCodeAt(0);
			if (code <= 31 || (code >= 127 && code <= 159)) {
				return `\\x${code.toString(16).padStart(2, "0")}`;
			}
			return character;
		})
		.join("");
}

function formatHistoryDate(authorTime: number): string {
	const date = new Date(authorTime * 1_000);
	return Number.isFinite(date.getTime()) ? date.toISOString().slice(0, 10) : "unknown-date";
}

function formatError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
