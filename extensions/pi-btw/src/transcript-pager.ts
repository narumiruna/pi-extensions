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
	Markdown,
	matchesKey,
	type TUI,
	truncateToWidth,
} from "@earendil-works/pi-tui";
import type { SideThreadTurn } from "./side-thread.js";

const TRANSCRIPT_CHROME_LINES = 1;
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
			1,
			availableRows - editorLines.length - TRANSCRIPT_CHROME_LINES,
		);
		const contentLines = this.transcriptComponents
			.flatMap((component) => component.render(safeWidth))
			.map(stripShellIntegrationMarkers);
		this.lastContentLineCount = contentLines.length;
		this.lastViewportHeight = viewportHeight;
		if (this.scrollToBottomOnFirstRender) {
			this.scrollOffset = this.getMaxScrollOffset();
			this.scrollToBottomOnFirstRender = false;
		}
		this.clampScrollOffset();

		const lines = [
			...contentLines.slice(this.scrollOffset, this.scrollOffset + viewportHeight),
			this.renderFooter(safeWidth),
			...editorLines,
		];
		return lines.length <= availableRows ? lines : lines.slice(lines.length - availableRows);
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
		const hints =
			width < 28 ? "Enter • Ctrl+C exit" : "Enter send • Ctrl+C exit • PgUp/PgDn history";
		const text = this.warning
			? this.theme.fg("warning", this.warning)
			: this.theme.fg("dim", hints);
		return truncateToWidth(text, width);
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

function buildTranscriptComponents(turns: readonly SideThreadTurn[], theme: Theme): Component[] {
	return turns.flatMap((turn): Component[] => {
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
