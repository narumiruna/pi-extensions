import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
	AssistantMessageComponent,
	getMarkdownTheme,
	type Theme,
	UserMessageComponent,
} from "@earendil-works/pi-coding-agent";
import {
	type Component,
	CURSOR_MARKER,
	Editor,
	type EditorTheme,
	Key,
	Loader,
	Markdown,
	matchesKey,
	type TUI,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";
import type { SideThreadTurn } from "./side-thread.js";

const TRANSCRIPT_CHROME_LINES = 2;
const OSC133_MARKERS = ["\u001b]133;A\u0007", "\u001b]133;B\u0007", "\u001b]133;C\u0007"];
// Pi renders a spacer above the custom component and a two-line built-in footer below it.
const RESERVED_APP_LINES = 3;

export type TranscriptPagerAction = { kind: "submit"; question: string } | { kind: "close" };

export class BtwTranscriptPager implements Component {
	private readonly transcriptComponents: Component[];
	private readonly editor: Editor;
	private scrollOffset = 0;
	private lastContentLineCount = 0;
	private lastViewportHeight = 1;
	private followBottom: boolean;
	private warning: string | undefined;
	private finished = false;
	private isFocused = false;

	constructor(
		private readonly tui: TUI,
		private readonly theme: Theme,
		turns: readonly SideThreadTurn[],
		private readonly onAction: (action: TranscriptPagerAction) => void,
		options: { startAtBottom?: boolean } = {},
	) {
		this.transcriptComponents = buildTranscriptComponents(turns, this.theme);
		this.followBottom = options.startAtBottom ?? false;
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
		this.editor.onChange = () => {
			this.warning = undefined;
		};
		this.editor.onSubmit = (text) => {
			const question = text.trim();
			if (!question) {
				this.warning = "Question cannot be empty";
				return;
			}
			this.finished = true;
			this.onAction({ kind: "submit", question });
		};
	}

	get focused(): boolean {
		return this.isFocused;
	}

	set focused(value: boolean) {
		this.isFocused = value;
		this.editor.focused = value;
	}

	render(width: number): string[] {
		const safeWidth = Math.max(1, width);
		const editorLines = this.editor.render(safeWidth);
		const availableRows = Math.max(1, this.tui.terminal.rows - RESERVED_APP_LINES);
		const viewportHeight = Math.max(
			0,
			availableRows - editorLines.length - TRANSCRIPT_CHROME_LINES,
		);
		const contentLines = renderTranscriptLines(this.transcriptComponents, safeWidth);
		this.lastContentLineCount = contentLines.length;
		this.lastViewportHeight = viewportHeight;
		if (this.followBottom) this.scrollOffset = this.getMaxScrollOffset();
		this.clampScrollOffset();

		return fitComposerLayout(
			renderSideThreadHeader(safeWidth, this.theme),
			contentLines.slice(this.scrollOffset, this.scrollOffset + viewportHeight),
			this.renderFooter(safeWidth),
			editorLines,
			availableRows,
		);
	}

	handleInput(data: string): void {
		if (this.finished) return;
		if (matchesKey(data, Key.ctrl("c"))) {
			this.finished = true;
			this.onAction({ kind: "close" });
			return;
		}
		if (matchesKey(data, Key.pageUp)) {
			const previousOffset = this.scrollOffset;
			this.scrollBy(-this.lastViewportHeight);
			if (this.scrollOffset < previousOffset) this.followBottom = false;
			this.tui.requestRender();
			return;
		}
		if (matchesKey(data, Key.pageDown)) {
			this.scrollBy(this.lastViewportHeight);
			this.followBottom = this.scrollOffset >= this.getMaxScrollOffset();
			this.tui.requestRender();
			return;
		}
		this.editor.handleInput(data);
		if (!this.finished) this.tui.requestRender();
	}

	invalidate(): void {
		for (const component of this.transcriptComponents) component.invalidate();
		this.editor.invalidate();
	}

	private renderFooter(width: number): string {
		if (this.warning) {
			const warning = width < 32 ? "Empty • Ctrl+C" : `${this.warning} • Ctrl+C exit`;
			return truncateToWidth(this.theme.fg("warning", warning), width);
		}
		const scrollable = this.getMaxScrollOffset() > 0;
		const fullBase = "btw • Enter send • Ctrl+C exit";
		const compactBase = "btw • Enter • Ctrl+C";
		let hints = visibleWidth(fullBase) <= width ? fullBase : compactBase;
		if (scrollable) {
			const history = ` • ${this.scrollOffset > 0 ? "↑ older" : "↓ newer"} • PgUp/PgDn history`;
			const compactHistory = " • PgUp/PgDn";
			if (visibleWidth(`${hints}${history}`) <= width) {
				hints += history;
			} else if (visibleWidth(`${hints}${compactHistory}`) <= width) {
				hints += compactHistory;
			} else if (visibleWidth(`${compactBase}${compactHistory}`) <= width) {
				hints = `${compactBase}${compactHistory}`;
			}
		}
		return truncateToWidth(this.theme.fg("muted", hints), width);
	}

	private scrollBy(delta: number): void {
		this.scrollOffset += delta;
		this.clampScrollOffset();
	}

	private clampScrollOffset(): void {
		this.scrollOffset = Math.max(0, Math.min(this.scrollOffset, this.getMaxScrollOffset()));
	}

	private getMaxScrollOffset(): number {
		return Math.max(0, this.lastContentLineCount - this.lastViewportHeight);
	}
}

export class BtwAnsweringView implements Component {
	private readonly transcriptComponents: Component[];
	private readonly loader: Loader;
	private readonly controller = new AbortController();
	private scrollOffset = 0;
	private lastContentLineCount = 0;
	private lastViewportHeight = 1;
	private followBottom = true;
	private finished = false;

	constructor(
		private readonly tui: TUI,
		private readonly theme: Theme,
		turns: readonly SideThreadTurn[],
		pendingQuestion: string,
		private readonly onCancel: () => void,
	) {
		this.transcriptComponents = buildTranscriptComponents(turns, this.theme, pendingQuestion);
		this.loader = new Loader(
			this.tui,
			(text) => this.theme.fg("accent", text),
			(text) => this.theme.fg("muted", text),
			"Answering…",
		);
	}

	get signal(): AbortSignal {
		return this.controller.signal;
	}

	render(width: number): string[] {
		const safeWidth = Math.max(1, width);
		const availableRows = Math.max(1, this.tui.terminal.rows - RESERVED_APP_LINES);
		const viewportHeight = Math.max(0, availableRows - TRANSCRIPT_CHROME_LINES);
		const contentLines = renderTranscriptLines(this.transcriptComponents, safeWidth);
		this.lastContentLineCount = contentLines.length;
		this.lastViewportHeight = viewportHeight;
		if (this.followBottom) this.scrollOffset = this.getMaxScrollOffset();
		this.clampScrollOffset();
		const cancelHint = safeWidth < 28 ? "Ctrl+C" : "Ctrl+C cancel";
		const loaderWidth = Math.max(1, safeWidth - visibleWidth(cancelHint) - 3);
		const loaderLine = this.loader.render(loaderWidth).at(-1) ?? "Answering…";
		const lines = [
			renderSideThreadHeader(safeWidth, this.theme),
			...contentLines.slice(this.scrollOffset, this.scrollOffset + viewportHeight),
			truncateToWidth(`${loaderLine} • ${this.theme.fg("muted", cancelHint)}`, safeWidth),
		];
		return fitWithFixedHeader(lines, availableRows);
	}

	handleInput(data: string): void {
		if (this.finished) return;
		if (matchesKey(data, Key.ctrl("c"))) {
			this.finished = true;
			this.loader.stop();
			this.controller.abort();
			this.onCancel();
			return;
		}
		if (matchesKey(data, Key.pageUp)) {
			const previousOffset = this.scrollOffset;
			this.scrollBy(-this.lastViewportHeight);
			if (this.scrollOffset < previousOffset) this.followBottom = false;
			this.tui.requestRender();
		} else if (matchesKey(data, Key.pageDown)) {
			this.scrollBy(this.lastViewportHeight);
			this.followBottom = this.scrollOffset >= this.getMaxScrollOffset();
			this.tui.requestRender();
		}
	}

	invalidate(): void {
		for (const component of this.transcriptComponents) component.invalidate();
		this.loader.invalidate();
	}

	finish(): void {
		this.finished = true;
		this.loader.stop();
	}

	dispose(): void {
		this.finish();
		this.controller.abort();
	}

	private scrollBy(delta: number): void {
		this.scrollOffset += delta;
		this.clampScrollOffset();
	}

	private clampScrollOffset(): void {
		this.scrollOffset = Math.max(0, Math.min(this.scrollOffset, this.getMaxScrollOffset()));
	}

	private getMaxScrollOffset(): number {
		return Math.max(0, this.lastContentLineCount - this.lastViewportHeight);
	}
}

export function formatSideTranscript(turns: readonly SideThreadTurn[]): string {
	return turns
		.map((turn) => {
			const question = escapeTerminalControls(turn.question);
			const rawAnswer = escapeTerminalControls(turn.answer);
			const answer = turn.kind === "error" ? `Error: ${rawAnswer}` : rawAnswer;
			return `${question}\n\n${answer}`;
		})
		.join("\n\n");
}

function buildTranscriptComponents(
	turns: readonly SideThreadTurn[],
	theme: Theme,
	pendingQuestion?: string,
): Component[] {
	const components = turns.flatMap((turn): Component[] => {
		const question = new UserMessageComponent(
			escapeTerminalControls(turn.question),
			getMarkdownTheme(),
			1,
		);
		if (turn.kind === "error") {
			const error = new Markdown(
				`Error: ${escapeTerminalControls(turn.answer)}`,
				1,
				1,
				getMarkdownTheme(),
				{ color: (text) => theme.fg("error", text) },
			);
			return [question, error];
		}
		const response: AssistantMessage = {
			...turn.response,
			content: [{ type: "text", text: escapeTerminalControls(turn.answer) }],
			stopReason: "stop",
			errorMessage: undefined,
		};
		return [question, new AssistantMessageComponent(response, true, getMarkdownTheme(), "", 1)];
	});
	if (pendingQuestion) {
		components.push(
			new UserMessageComponent(escapeTerminalControls(pendingQuestion), getMarkdownTheme(), 1),
		);
	}
	return components;
}

function renderTranscriptLines(components: readonly Component[], width: number): string[] {
	return components
		.flatMap((component) => component.render(width))
		.map(stripShellIntegrationMarkers);
}

function renderSideThreadHeader(width: number, theme: Theme): string {
	const title = truncateToWidth("─ btw · side thread ", width);
	const ruleWidth = Math.max(0, width - visibleWidth(title));
	return theme.fg("muted", `${title}${"─".repeat(ruleWidth)}`);
}

function fitComposerLayout(
	header: string,
	contentLines: string[],
	footer: string,
	editorLines: string[],
	availableRows: number,
): string[] {
	const lines = [header, ...contentLines, footer, ...editorLines];
	if (lines.length <= availableRows) return lines;
	if (availableRows <= 1) return [header];
	const editorBudget = Math.max(0, availableRows - 2);
	return [header, footer, ...fitEditorLines(editorLines, editorBudget)];
}

function fitEditorLines(editorLines: string[], budget: number): string[] {
	if (budget <= 0) return [];
	if (editorLines.length <= budget) return editorLines;
	const cursorIndex = editorLines.findIndex((line) => line.includes(CURSOR_MARKER));
	if (cursorIndex < 0) return editorLines.slice(-budget);
	const start = Math.min(cursorIndex, editorLines.length - budget);
	return editorLines.slice(start, start + budget);
}

function fitWithFixedHeader(lines: string[], availableRows: number): string[] {
	if (lines.length <= availableRows) return lines;
	if (availableRows <= 1) return lines.slice(0, 1);
	return [lines[0] ?? "", ...lines.slice(lines.length - availableRows + 1)];
}

function stripShellIntegrationMarkers(line: string): string {
	return OSC133_MARKERS.reduce((result, marker) => result.replaceAll(marker, ""), line);
}

function escapeTerminalControls(text: string): string {
	return [...text]
		.map((character) => {
			if (character === "\n") return character;
			if (character === "\t") return "    ";
			const code = character.charCodeAt(0);
			if (code <= 31 || (code >= 127 && code <= 159)) {
				return `\\x${code.toString(16).padStart(2, "0")}`;
			}
			return character;
		})
		.join("");
}
