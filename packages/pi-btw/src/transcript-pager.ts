import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
	AssistantMessageComponent,
	getMarkdownTheme,
	type KeybindingsManager,
	type Theme,
	UserMessageComponent,
} from "@earendil-works/pi-coding-agent";
import {
	type Component,
	Editor,
	type EditorTheme,
	type Focusable,
	Key,
	Loader,
	Markdown,
	matchesKey,
	type TUI,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";
import type { BtwThinkingLevel, SideThreadTurn } from "./side-thread.js";
import { sanitizeSingleLine } from "./text.js";

// Scrolling is owned by the fullscreen TUI: the transcript is rendered in full
// and the alt-screen primary scroll view handles wheel/PgUp/PgDn/Home/End/search.
const MAX_STEERING_DISPLAY_LINES = 3;
const OSC133_MARKERS = ["\u001b]133;A\u0007", "\u001b]133;B\u0007", "\u001b]133;C\u0007"];

export type TranscriptPagerAction =
	| { kind: "submit"; question: string }
	| { kind: "bringToMain"; questionDraft: string }
	| { kind: "close" };

export interface BtwThinkingControl {
	level: BtwThinkingLevel;
	levels: readonly BtwThinkingLevel[];
	keybindings: KeybindingsManager;
	onChange: (level: BtwThinkingLevel) => void;
}

export interface BtwAnsweringViewOptions {
	steering?: {
		questions: readonly string[];
		onSubmit: (question: string) => void;
		thinking?: BtwThinkingControl;
	};
}

export class BtwTranscriptPager implements Component, Focusable {
	private readonly transcriptComponents: Component[];
	private readonly editor: Editor;
	private readonly canBringToMain: boolean;
	private warning: string | undefined;
	private finished = false;
	private isFocused = false;
	private thinkingLevel: BtwThinkingLevel | undefined;

	constructor(
		private readonly tui: TUI,
		private readonly theme: Theme,
		turns: readonly SideThreadTurn[],
		private readonly onAction: (action: TranscriptPagerAction) => void,
		private readonly options: {
			initialQuestion?: string;
			thinking?: BtwThinkingControl;
		} = {},
	) {
		this.transcriptComponents = buildTranscriptComponents(turns, this.theme);
		this.canBringToMain = turns.some((turn) => turn.kind === "answered");
		this.thinkingLevel = options.thinking?.level;
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
		if (options.initialQuestion) this.editor.setText(options.initialQuestion);
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
		const contentLines = renderTranscriptLines(this.transcriptComponents, safeWidth);
		return [
			renderSideThreadHeader(safeWidth, this.theme, this.thinkingLevel),
			...contentLines,
			this.renderFooter(safeWidth),
			...editorLines,
		];
	}

	handleInput(data: string): void {
		if (this.finished) return;
		if (matchesKey(data, Key.ctrl("c"))) {
			this.finished = true;
			this.onAction({ kind: "close" });
			return;
		}
		if (this.canBringToMain && matchesKey(data, Key.ctrl("r"))) {
			this.finished = true;
			this.onAction({ kind: "bringToMain", questionDraft: this.editor.getExpandedText() });
			return;
		}
		const thinking = this.options.thinking;
		if (
			thinking &&
			thinking.levels.length > 1 &&
			thinking.keybindings.matches(data, "app.thinking.cycle")
		) {
			const currentIndex = thinking.levels.indexOf(this.thinkingLevel ?? thinking.level);
			const nextLevel = thinking.levels[(currentIndex + 1) % thinking.levels.length];
			if (nextLevel) {
				this.thinkingLevel = nextLevel;
				thinking.onChange(nextLevel);
				this.warning = undefined;
				this.tui.requestRender();
			}
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
		const thinking = this.options.thinking;
		const cycleHint =
			thinking && thinking.levels.length > 1 && this.thinkingLevel
				? ` • thinking ${this.thinkingLevel} • ${thinkingKeyLabel(thinking.keybindings)} cycle`
				: "";
		const base = this.canBringToMain
			? "btw • Enter send • Ctrl+R bring to main • Ctrl+C exit"
			: "btw • Enter send • Ctrl+C exit";
		const full = `${base}${cycleHint} • PgUp/PgDn scroll`;
		const compact = this.canBringToMain ? "btw • Enter • Ctrl+R • Ctrl+C" : "btw • Enter • Ctrl+C";
		const hints = visibleWidth(full) <= width ? full : compact;
		return truncateToWidth(this.theme.fg("muted", hints), width);
	}

	dispose(): void {
		if (this.finished) return;
		this.finished = true;
		this.onAction({ kind: "close" });
	}
}

export class BtwAnsweringView implements Component, Focusable {
	private readonly transcriptComponents: Component[];
	private readonly loader: Loader;
	private readonly editor: Editor | undefined;
	private readonly controller = new AbortController();
	private warning: string | undefined;
	private finished = false;
	private isFocused = false;
	private thinkingLevel: BtwThinkingLevel | undefined;

	constructor(
		private readonly tui: TUI,
		private readonly theme: Theme,
		turns: readonly SideThreadTurn[],
		pendingQuestion: string,
		private readonly onCancel: () => void,
		thinkingLevel?: BtwThinkingLevel,
		private readonly options: BtwAnsweringViewOptions = {},
	) {
		this.transcriptComponents = buildTranscriptComponents(turns, this.theme, pendingQuestion);
		this.thinkingLevel = options.steering?.thinking?.level ?? thinkingLevel;
		this.loader = new Loader(
			this.tui,
			(text) => this.theme.fg("accent", text),
			(text) => this.theme.fg("muted", text),
			"Answering…",
		);
		if (options.steering) {
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
				options.steering?.onSubmit(question);
				this.warning = undefined;
			};
		}
	}

	get focused(): boolean {
		return this.isFocused;
	}

	set focused(value: boolean) {
		this.isFocused = value;
		if (this.editor) this.editor.focused = value;
	}

	get signal(): AbortSignal {
		return this.controller.signal;
	}

	render(width: number): string[] {
		const safeWidth = Math.max(1, width);
		const editorLines = this.editor?.render(safeWidth) ?? [];
		const steeringLines = renderSteeringLines(
			this.options.steering?.questions ?? [],
			safeWidth,
			this.theme,
		);
		const contentLines = renderTranscriptLines(this.transcriptComponents, safeWidth);
		return [
			renderSideThreadHeader(safeWidth, this.theme, this.thinkingLevel),
			...contentLines,
			...steeringLines,
			this.renderFooter(safeWidth),
			...editorLines,
		];
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
		const thinking = this.options.steering?.thinking;
		if (
			thinking &&
			thinking.levels.length > 1 &&
			thinking.keybindings.matches(data, "app.thinking.cycle")
		) {
			const currentIndex = thinking.levels.indexOf(this.thinkingLevel ?? thinking.level);
			const nextLevel = thinking.levels[(currentIndex + 1) % thinking.levels.length];
			if (nextLevel) {
				this.thinkingLevel = nextLevel;
				thinking.onChange(nextLevel);
				this.warning = undefined;
				this.tui.requestRender();
			}
			return;
		}
		this.editor?.handleInput(data);
		this.tui.requestRender();
	}

	invalidate(): void {
		for (const component of this.transcriptComponents) component.invalidate();
		this.loader.invalidate();
		this.editor?.invalidate();
	}

	finish(): void {
		this.finished = true;
		this.loader.stop();
	}

	dispose(): void {
		if (this.finished) {
			this.loader.stop();
			this.controller.abort();
			return;
		}
		this.finished = true;
		this.loader.stop();
		this.controller.abort();
		this.onCancel();
	}

	private renderFooter(width: number): string {
		if (this.warning) {
			const warning = width < 32 ? "Empty • Ctrl+C" : `${this.warning} • Ctrl+C cancel`;
			return truncateToWidth(this.theme.fg("warning", warning), width);
		}
		const baseHint = this.editor ? "Enter steer • Ctrl+C cancel" : "Ctrl+C cancel";
		const thinking = this.options.steering?.thinking;
		const cycleHint =
			thinking && thinking.levels.length > 1 && this.thinkingLevel
				? ` • thinking ${this.thinkingLevel} • ${thinkingKeyLabel(thinking.keybindings)} cycle`
				: "";
		const scrollHint = " • PgUp/PgDn scroll";
		const hints = `${baseHint}${cycleHint}${scrollHint}`;
		const compactHints = this.editor ? "Enter • Ctrl+C" : "Ctrl+C";
		const selectedHints = visibleWidth(hints) <= width ? hints : compactHints;
		const loaderWidth = Math.max(1, width - visibleWidth(selectedHints) - 3);
		const loaderLine = this.loader.render(loaderWidth).at(-1) ?? "Answering…";
		return truncateToWidth(`${loaderLine} • ${this.theme.fg("muted", selectedHints)}`, width);
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

function renderSideThreadHeader(
	width: number,
	theme: Theme,
	thinkingLevel?: BtwThinkingLevel,
): string {
	const thinking = thinkingLevel ? ` · thinking ${thinkingLevel}` : "";
	const title = truncateToWidth(`─ btw · side thread${thinking} `, width);
	const ruleWidth = Math.max(0, width - visibleWidth(title));
	return theme.fg("muted", `${title}${"─".repeat(ruleWidth)}`);
}

function thinkingKeyLabel(keybindings: KeybindingsManager): string {
	const key =
		sanitizeSingleLine(String(keybindings.getKeys("app.thinking.cycle")[0] ?? "shift+tab")) ||
		"Shift+Tab";
	return key
		.split("+")
		.map((part) => {
			const lower = part.toLowerCase();
			if (lower === "shift") return "Shift";
			if (lower === "ctrl") return "Ctrl";
			if (lower === "alt") return "Alt";
			return part.length === 1
				? part.toUpperCase()
				: `${part[0]?.toUpperCase() ?? ""}${part.slice(1)}`;
		})
		.join("+");
}

function renderSteeringLines(questions: readonly string[], width: number, theme: Theme): string[] {
	if (questions.length === 0) return [];
	const formatQuestion = (question: string) =>
		sanitizeSingleLine(question) || "(non-printing message)";
	const hasOverflow = questions.length > MAX_STEERING_DISPLAY_LINES;
	const questionLimit = hasOverflow
		? Math.max(1, MAX_STEERING_DISPLAY_LINES - 1)
		: MAX_STEERING_DISPLAY_LINES;
	const lines = questions
		.slice(0, questionLimit)
		.map((question) =>
			truncateToWidth(theme.fg("dim", `Steering: ${formatQuestion(question)}`), width),
		);
	if (hasOverflow) {
		lines.push(
			truncateToWidth(
				theme.fg("dim", `Steering: … +${questions.length - questionLimit} more`),
				width,
			),
		);
	}
	return lines;
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
