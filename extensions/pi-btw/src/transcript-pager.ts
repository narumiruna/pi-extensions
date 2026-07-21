import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
	AssistantMessageComponent,
	getMarkdownTheme,
	type Theme,
	UserMessageComponent,
} from "@earendil-works/pi-coding-agent";
import {
	type Component,
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
	private scrollToBottomOnFirstRender: boolean;
	private hasRendered = false;
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
		this.scrollToBottomOnFirstRender = options.startAtBottom ?? false;
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
		const shouldFollowBottom =
			this.scrollToBottomOnFirstRender ||
			(this.hasRendered && this.scrollOffset >= this.getMaxScrollOffset());
		this.lastContentLineCount = contentLines.length;
		this.lastViewportHeight = viewportHeight;
		if (shouldFollowBottom) this.scrollOffset = this.getMaxScrollOffset();
		this.scrollToBottomOnFirstRender = false;
		this.hasRendered = true;
		this.clampScrollOffset();

		const lines = [
			renderSideThreadHeader(safeWidth, this.theme),
			...contentLines.slice(this.scrollOffset, this.scrollOffset + viewportHeight),
			this.renderFooter(safeWidth),
			...editorLines,
		];
		return fitWithFixedHeader(lines, availableRows);
	}

	handleInput(data: string): void {
		if (this.finished) return;
		if (matchesKey(data, Key.ctrl("c"))) {
			this.finished = true;
			this.onAction({ kind: "close" });
			return;
		}
		if (matchesKey(data, Key.pageUp)) {
			this.scrollBy(-this.lastViewportHeight);
			this.tui.requestRender();
			return;
		}
		if (matchesKey(data, Key.pageDown)) {
			this.scrollBy(this.lastViewportHeight);
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
		let hints: string;
		if (width < 28) {
			hints = "btw • Enter • Ctrl+C";
		} else if (width < 52) {
			hints = `btw • Enter • Ctrl+C${scrollable ? " • PgUp/PgDn" : ""}`;
		} else {
			hints = `btw • Enter send • Ctrl+C exit${
				scrollable ? ` • ${this.scrollOffset > 0 ? "↑ older" : "↓ newer"} • PgUp/PgDn history` : ""
			}`;
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
	private scrollToBottomOnFirstRender = true;
	private hasRendered = false;
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
		const shouldFollowBottom =
			this.scrollToBottomOnFirstRender ||
			(this.hasRendered && this.scrollOffset >= this.getMaxScrollOffset());
		this.lastContentLineCount = contentLines.length;
		this.lastViewportHeight = viewportHeight;
		if (shouldFollowBottom) this.scrollOffset = this.getMaxScrollOffset();
		this.scrollToBottomOnFirstRender = false;
		this.hasRendered = true;
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
			this.scrollBy(-this.lastViewportHeight);
			this.tui.requestRender();
		} else if (matchesKey(data, Key.pageDown)) {
			this.scrollBy(this.lastViewportHeight);
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
