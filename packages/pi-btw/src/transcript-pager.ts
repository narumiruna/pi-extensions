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
	CURSOR_MARKER,
	Editor,
	type EditorTheme,
	type Focusable,
	Key,
	Loader,
	Markdown,
	matchesKey,
	ScrollView,
	type TUI,
	truncateToWidth,
	VStack,
	visibleWidth,
} from "@earendil-works/pi-tui";
import type { BtwFullscreenLayoutComponent } from "./fullscreen-ui.js";
import type { BtwThinkingLevel, SideThreadTurn } from "./side-thread.js";
import { formatKeyLabel, sanitizeSingleLine } from "./text.js";

const TRANSCRIPT_CHROME_LINES = 2;
const MAX_STEERING_DISPLAY_LINES = 3;
const OSC133_MARKERS = ["\u001b]133;A\u0007", "\u001b]133;B\u0007", "\u001b]133;C\u0007"];
// Pi renders a spacer above the custom component and a two-line built-in footer below it.
const RESERVED_APP_LINES = 3;

// A temporary fit after manual scrolling must not silently resume following new output.
class PreservingScrollView extends ScrollView {
	override updateLayout(
		contentHeight: number,
		viewportHeight: number,
		requestRender: () => void,
	): void {
		const preserveManualPosition = !this.isFollowingEnd;
		super.updateLayout(contentHeight, viewportHeight, requestRender);
		if (preserveManualPosition && this.isFollowingEnd) {
			this.scrollTo(this.scrollTop, { disableFollow: true });
		}
	}
}

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

export class BtwTranscriptPager implements BtwFullscreenLayoutComponent, Focusable {
	private readonly transcriptComponents: Component[];
	private readonly editor: Editor;
	private readonly canBringToMain: boolean;
	private readonly scrollView: ScrollView;
	private readonly layoutRoot: VStack;
	private lastContentLineCount = 0;
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
			startAtBottom?: boolean;
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
		const transcript = this.createTranscriptComponent();
		this.scrollView = new PreservingScrollView(transcript, {
			follow: options.startAtBottom ? "end" : "none",
			primary: true,
		});
		this.layoutRoot = new VStack([
			{ component: this.createHeaderComponent(), basis: 1, shrink: 0, minSize: 1 },
			{ component: this.scrollView, basis: 0, grow: 1, minSize: 0 },
			{ component: this.createFooterComponent(), basis: 1, shrink: 0, minSize: 1 },
			{ component: this.editor, basis: "auto", shrink: 1, minSize: 0 },
		]);
	}

	get focused(): boolean {
		return this.isFocused;
	}

	set focused(value: boolean) {
		this.isFocused = value;
		this.editor.focused = value;
	}

	getFullscreenLayout(): Component {
		return this.layoutRoot;
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
		this.scrollView.updateLayout(contentLines.length, viewportHeight, () =>
			this.tui.requestRender(),
		);

		return fitComposerLayout(
			renderSideThreadHeader(safeWidth, this.theme, this.thinkingLevel),
			contentLines.slice(this.scrollView.scrollTop, this.scrollView.scrollTop + viewportHeight),
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
		if (matchesKey(data, Key.pageUp)) {
			this.scrollView.scrollBy(-Math.max(1, this.scrollView.viewportHeight));
			this.tui.requestRender();
			return;
		}
		if (matchesKey(data, Key.pageDown)) {
			this.scrollView.scrollBy(Math.max(1, this.scrollView.viewportHeight));
			this.tui.requestRender();
			return;
		}
		this.editor.handleInput(data);
		if (!this.finished) this.tui.requestRender();
	}

	invalidate(): void {
		this.layoutRoot.invalidate();
	}

	dispose(): void {
		if (this.finished) return;
		this.finished = true;
		this.onAction({ kind: "close" });
	}

	private renderFooter(width: number): string {
		if (this.warning) {
			const warning = width < 32 ? "Empty • Ctrl+C" : `${this.warning} • Ctrl+C exit`;
			return truncateToWidth(this.theme.fg("warning", warning), width);
		}
		const scrollable = this.getMaxScrollOffset() > 0;
		const thinking = this.options.thinking;
		const cycleHint =
			thinking && thinking.levels.length > 1 && this.thinkingLevel
				? ` • thinking ${this.thinkingLevel} • ${thinkingKeyLabel(thinking.keybindings)} cycle`
				: "";
		const base = this.canBringToMain
			? "btw • Enter send • Ctrl+R bring to main • Ctrl+C exit"
			: "btw • Enter send • Ctrl+C exit";
		const fullBase = `${base}${cycleHint}`;
		const fallbackBase = "btw • Enter • Ctrl+C";
		const compactBase = this.canBringToMain ? "btw • Enter • Ctrl+R • Ctrl+C" : fallbackBase;
		const compactWithThinking = `${compactBase}${cycleHint}`;
		let hints =
			visibleWidth(fullBase) <= width
				? fullBase
				: visibleWidth(compactWithThinking) <= width
					? compactWithThinking
					: visibleWidth(compactBase) <= width
						? compactBase
						: fallbackBase;
		if (scrollable) {
			const history = ` • ${this.scrollView.scrollTop > 0 ? "↑ older" : "↓ newer"} • PgUp/PgDn history`;
			const compactHistory = " • PgUp/PgDn";
			const compactScrollable = this.canBringToMain
				? "Enter • Ctrl+R • Ctrl+C • PgUp/PgDn"
				: `${fallbackBase}${compactHistory}`;
			if (visibleWidth(`${hints}${history}`) <= width) {
				hints += history;
			} else if (visibleWidth(`${compactBase}${history}`) <= width) {
				hints = `${compactBase}${history}`;
			} else if (visibleWidth(`${hints}${compactHistory}`) <= width) {
				hints += compactHistory;
			} else if (visibleWidth(`${compactBase}${compactHistory}`) <= width) {
				hints = `${compactBase}${compactHistory}`;
			} else if (visibleWidth(compactScrollable) <= width) {
				hints = compactScrollable;
			}
		}
		return truncateToWidth(this.theme.fg("muted", hints), width);
	}

	private createHeaderComponent(): Component {
		return {
			render: (width) => [renderSideThreadHeader(width, this.theme, this.thinkingLevel)],
			invalidate() {},
		};
	}

	private createTranscriptComponent(): Component {
		return {
			render: (width) => {
				const lines = renderTranscriptLines(this.transcriptComponents, width);
				this.lastContentLineCount = lines.length;
				return lines;
			},
			invalidate: () => {
				for (const component of this.transcriptComponents) component.invalidate();
			},
		};
	}

	private createFooterComponent(): Component {
		return {
			render: (width) => [this.renderFooter(width)],
			invalidate() {},
		};
	}

	private getMaxScrollOffset(): number {
		return Math.max(0, this.lastContentLineCount - this.scrollView.viewportHeight);
	}
}

export class BtwAnsweringView implements BtwFullscreenLayoutComponent, Focusable {
	private readonly transcriptComponents: Component[];
	private readonly loader: Loader;
	private readonly editor: Editor | undefined;
	private readonly controller = new AbortController();
	private readonly scrollView: ScrollView;
	private readonly layoutRoot: VStack;
	private lastContentLineCount = 0;
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
		const transcript = this.createTranscriptComponent();
		this.scrollView = new PreservingScrollView(transcript, { follow: "end", primary: true });
		this.layoutRoot = new VStack([
			{ component: this.createHeaderComponent(), basis: 1, shrink: 0, minSize: 1 },
			{ component: this.scrollView, basis: 0, grow: 1, minSize: 0 },
			{
				component: this.createSteeringComponent(),
				basis: "auto",
				shrink: 1,
				minSize: 0,
				maxSize: MAX_STEERING_DISPLAY_LINES,
			},
			{ component: this.createFooterComponent(), basis: 1, shrink: 0, minSize: 1 },
			...(this.editor
				? [{ component: this.editor, basis: "auto" as const, shrink: 1, minSize: 0 }]
				: []),
		]);
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

	getFullscreenLayout(): Component {
		return this.layoutRoot;
	}

	render(width: number): string[] {
		const safeWidth = Math.max(1, width);
		const availableRows = Math.max(1, this.tui.terminal.rows - RESERVED_APP_LINES);
		const editorLines = this.editor?.render(safeWidth) ?? [];
		const steeringCapacity = Math.max(
			0,
			availableRows - editorLines.length - TRANSCRIPT_CHROME_LINES,
		);
		const steeringLines = renderSteeringLines(
			this.options.steering?.questions ?? [],
			safeWidth,
			this.theme,
			Math.min(MAX_STEERING_DISPLAY_LINES, steeringCapacity),
		);
		const viewportHeight = Math.max(
			0,
			availableRows - editorLines.length - TRANSCRIPT_CHROME_LINES - steeringLines.length,
		);
		const contentLines = renderTranscriptLines(this.transcriptComponents, safeWidth);
		this.lastContentLineCount = contentLines.length;
		this.scrollView.updateLayout(contentLines.length, viewportHeight, () =>
			this.tui.requestRender(),
		);

		return fitComposerLayout(
			renderSideThreadHeader(safeWidth, this.theme, this.thinkingLevel),
			contentLines.slice(this.scrollView.scrollTop, this.scrollView.scrollTop + viewportHeight),
			this.renderFooter(safeWidth),
			editorLines,
			availableRows,
			steeringLines,
		);
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
		if (matchesKey(data, Key.pageUp)) {
			this.scrollView.scrollBy(-Math.max(1, this.scrollView.viewportHeight));
			this.tui.requestRender();
			return;
		}
		if (matchesKey(data, Key.pageDown)) {
			this.scrollView.scrollBy(Math.max(1, this.scrollView.viewportHeight));
			this.tui.requestRender();
			return;
		}
		this.editor?.handleInput(data);
		this.tui.requestRender();
	}

	invalidate(): void {
		this.layoutRoot.invalidate();
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
		const scrollHint = this.getMaxScrollOffset() > 0 ? " • PgUp/PgDn history" : "";
		const hints = `${baseHint}${cycleHint}${scrollHint}`;
		const compactHints = this.editor ? "Enter • Ctrl+C" : "Ctrl+C";
		const selectedHints = visibleWidth(hints) <= width ? hints : compactHints;
		const loaderWidth = Math.max(1, width - visibleWidth(selectedHints) - 3);
		const loaderLine = this.loader.render(loaderWidth).at(-1) ?? "Answering…";
		return truncateToWidth(`${loaderLine} • ${this.theme.fg("muted", selectedHints)}`, width);
	}

	private createHeaderComponent(): Component {
		return {
			render: (width) => [renderSideThreadHeader(width, this.theme, this.thinkingLevel)],
			invalidate() {},
		};
	}

	private createTranscriptComponent(): Component {
		return {
			render: (width) => {
				const lines = renderTranscriptLines(this.transcriptComponents, width);
				this.lastContentLineCount = lines.length;
				return lines;
			},
			invalidate: () => {
				for (const component of this.transcriptComponents) component.invalidate();
			},
		};
	}

	private createSteeringComponent(): Component {
		return {
			render: (width) =>
				renderSteeringLines(
					this.options.steering?.questions ?? [],
					width,
					this.theme,
					MAX_STEERING_DISPLAY_LINES,
				),
			invalidate() {},
		};
	}

	private createFooterComponent(): Component {
		return {
			render: (width) => [this.renderFooter(width)],
			invalidate: () => this.loader.invalidate(),
		};
	}

	private getMaxScrollOffset(): number {
		return Math.max(0, this.lastContentLineCount - this.scrollView.viewportHeight);
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
	return (
		formatKeyLabel(String(keybindings.getKeys("app.thinking.cycle")[0] ?? "shift+tab")) ||
		"Shift+Tab"
	);
}

function fitComposerLayout(
	header: string,
	contentLines: string[],
	footer: string,
	editorLines: string[],
	availableRows: number,
	statusLines: string[] = [],
): string[] {
	const lines = [header, ...contentLines, ...statusLines, footer, ...editorLines];
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

function renderSteeringLines(
	questions: readonly string[],
	width: number,
	theme: Theme,
	maxLines: number,
): string[] {
	if (questions.length === 0 || maxLines <= 0) return [];
	const formatQuestion = (question: string) =>
		sanitizeSingleLine(question) || "(non-printing message)";
	if (maxLines === 1 && questions.length > 1) {
		return [
			truncateToWidth(
				theme.fg(
					"dim",
					`Steering (+${questions.length - 1} more): ${formatQuestion(questions[0] ?? "")}`,
				),
				width,
			),
		];
	}
	const hasOverflow = questions.length > maxLines;
	const questionLimit = hasOverflow ? Math.max(1, maxLines - 1) : maxLines;
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
