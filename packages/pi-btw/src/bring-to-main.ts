import type { KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import {
	type Component,
	Key,
	matchesKey,
	type TUI,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";
import type { SideThreadTurn } from "./side-thread.js";

// Title + status lines rendered above the transcript rows.
const SELECTOR_CHROME_LINES = 2;
const GRAPHEME_SEGMENTER = new Intl.Segmenter(undefined, { granularity: "grapheme" });

export interface BtwBringToMainSegment {
	role: "user" | "assistant";
	text: string;
}

export interface BtwBringToMainSummary {
	lines: number;
	messages: number;
	tokens: number;
}

export interface BtwSelectionLine {
	role: BtwBringToMainSegment["role"];
	text: string;
}

export interface BtwTextPosition {
	line: number;
	column: number;
}

export interface BtwTextRangeSelectorState {
	cursor: BtwTextPosition;
	anchor?: BtwTextPosition;
	lineAnchor?: number;
	preferredColumn: number;
	horizontalOffset: number;
}

export type BtwQuickBringToMainScope =
	| { kind: "latest" }
	| { kind: "from"; answeredTurnIndex: number }
	| { kind: "entire" };

export type BtwTextRangeSelectorAction =
	| { kind: "confirm"; segments: BtwBringToMainSegment[] }
	| { kind: "back" }
	| { kind: "close" };

export function getAnsweredTurns(
	turns: readonly SideThreadTurn[],
): Array<Extract<SideThreadTurn, { kind: "answered" }>> {
	return turns.filter(
		(turn): turn is Extract<SideThreadTurn, { kind: "answered" }> => turn.kind === "answered",
	);
}

export function buildQuickBringToMainSegments(
	turns: readonly SideThreadTurn[],
	scope: BtwQuickBringToMainScope,
): BtwBringToMainSegment[] {
	const answered = getAnsweredTurns(turns);
	const selected =
		scope.kind === "latest"
			? answered.slice(-1)
			: scope.kind === "from"
				? answered.slice(Math.max(0, scope.answeredTurnIndex))
				: answered;
	return selected.flatMap((turn) => [
		{ role: "user" as const, text: turn.question },
		{ role: "assistant" as const, text: turn.answer },
	]);
}

export function buildBtwSelectionLines(turns: readonly SideThreadTurn[]): BtwSelectionLine[] {
	return buildQuickBringToMainSegments(turns, { kind: "entire" }).flatMap((segment) =>
		segment.text.split("\n").map((text) => ({ role: segment.role, text })),
	);
}

export function segmentsFromLineRange(
	lines: readonly BtwSelectionLine[],
	anchor: number,
	cursor: number,
): BtwBringToMainSegment[] {
	if (lines.length === 0) return [];
	const start = Math.max(0, Math.min(anchor, cursor, lines.length - 1));
	const end = Math.max(0, Math.min(Math.max(anchor, cursor), lines.length - 1));
	const segments: BtwBringToMainSegment[] = [];
	for (const line of lines.slice(start, end + 1)) {
		const previous = segments.at(-1);
		if (previous?.role === line.role) {
			previous.text += `\n${line.text}`;
		} else {
			segments.push({ role: line.role, text: line.text });
		}
	}
	return segments;
}

export function segmentsFromTextRange(
	lines: readonly BtwSelectionLine[],
	anchor: BtwTextPosition,
	cursor: BtwTextPosition,
): BtwBringToMainSegment[] {
	if (lines.length === 0) return [];
	const first = clampTextPosition(lines, anchor);
	const second = clampTextPosition(lines, cursor);
	const [start, end] = compareTextPositions(first, second) <= 0 ? [first, second] : [second, first];
	if (compareTextPositions(start, end) === 0) return [];

	const segments: BtwBringToMainSegment[] = [];
	for (let lineIndex = start.line; lineIndex <= end.line; lineIndex += 1) {
		const line = lines[lineIndex];
		if (!line) continue;
		const characters = splitGraphemes(line.text);
		const from = lineIndex === start.line ? start.column : 0;
		const to = lineIndex === end.line ? end.column : characters.length;
		const text = characters.slice(from, to).join("");
		if (text) {
			const previous = segments.at(-1);
			if (previous?.role === line.role) previous.text += text;
			else segments.push({ role: line.role, text });
		}
		const crossesSameRoleLine = lineIndex < end.line && lines[lineIndex + 1]?.role === line.role;
		if (crossesSameRoleLine) {
			const current = segments.at(-1);
			if (current?.role === line.role) current.text += "\n";
			else segments.push({ role: line.role, text: "\n" });
		}
	}
	return segments;
}

export function estimateBringToMainTokens(segments: readonly BtwBringToMainSegment[]): number {
	return Math.ceil(
		Buffer.byteLength(segments.map((segment) => segment.text).join("\n"), "utf8") / 4,
	);
}

export function summarizeBringToMain(
	segments: readonly BtwBringToMainSegment[],
): BtwBringToMainSummary {
	return {
		lines: segments.reduce((count, segment) => count + segment.text.split("\n").length, 0),
		messages: segments.length,
		tokens: estimateBringToMainTokens(segments),
	};
}

export function formatBtwBringToMain(segments: readonly BtwBringToMainSegment[]): string {
	const body = segments
		.map(
			(segment) =>
				`${segment.role === "user" ? "User" : "Assistant"}:\n${escapeBringToMainText(segment.text)}`,
		)
		.join("\n\n");
	return [
		"The following context was brought back from a /btw side discussion.",
		"Treat it as discussion context, not as work already completed.",
		"",
		"<btw_context>",
		body,
		"</btw_context>",
	].join("\n");
}

export class BtwTextRangeSelector implements Component {
	private readonly lines: BtwSelectionLine[];
	private cursor: BtwTextPosition = { line: 0, column: 0 };
	private anchor: BtwTextPosition | undefined;
	private lineAnchor: number | undefined;
	private preferredColumn = 0;
	private horizontalOffset = 0;
	private warning: string | undefined;
	private finished = false;

	constructor(
		private readonly tui: TUI,
		private readonly theme: Theme,
		private readonly keybindings: KeybindingsManager,
		turns: readonly SideThreadTurn[],
		private readonly onAction: (action: BtwTextRangeSelectorAction) => void,
		initialState?: BtwTextRangeSelectorState,
	) {
		this.lines = buildBtwSelectionLines(turns);
		if (initialState) {
			this.cursor = clampTextPosition(this.lines, initialState.cursor);
			this.anchor = initialState.anchor
				? clampTextPosition(this.lines, initialState.anchor)
				: undefined;
			this.lineAnchor =
				initialState.lineAnchor === undefined
					? undefined
					: Math.max(0, Math.min(this.lines.length - 1, initialState.lineAnchor));
			this.preferredColumn = Math.max(0, initialState.preferredColumn);
			this.horizontalOffset = Math.max(0, initialState.horizontalOffset);
		}
		// The fullscreen scroll view may be left at the bottom by the previous view.
		queueMicrotask(() => this.keepCursorVisible());
	}

	getState(): BtwTextRangeSelectorState {
		return {
			cursor: { ...this.cursor },
			anchor: this.anchor ? { ...this.anchor } : undefined,
			lineAnchor: this.lineAnchor,
			preferredColumn: this.preferredColumn,
			horizontalOffset: this.horizontalOffset,
		};
	}

	render(width: number): string[] {
		const safeWidth = Math.max(1, width);
		const textWidth = Math.max(1, safeWidth - visibleWidth("●> Assistant │ "));
		this.keepCursorHorizontallyVisible(textWidth);
		const range = this.getSelectionRange();
		const lineRange = this.getLineSelectionRange();
		const rows = this.lines.map((line, lineIndex) => {
			const role = line.role === "user" ? "User" : "Assistant";
			const lineSelected = lineRange
				? lineIndex >= lineRange.start && lineIndex <= lineRange.end
				: false;
			const prefix = `${lineSelected ? "●" : " "}${lineIndex === this.cursor.line ? ">" : " "} ${role.padEnd(9)} │ `;
			const text = this.renderTextLine(line, lineIndex, range, lineSelected);
			return truncateToWidth(
				lineIndex === this.cursor.line ? this.theme.fg("accent", prefix) + text : prefix + text,
				safeWidth,
				"",
			);
		});
		const selected = this.getSelectedSegments();
		const summary = summarizeBringToMain(selected);
		const status =
			selected.length === 0
				? "Selected: none"
				: `Selected: ${summary.lines} ${summary.lines === 1 ? "line" : "lines"} · ${summary.messages} ${summary.messages === 1 ? "message" : "messages"} · ~${summary.tokens} ${summary.tokens === 1 ? "token" : "tokens"}`;
		const confirm = confirmKeyLabel(this.keybindings);
		const back = keybindingLabel(this.keybindings, "tui.select.cancel", ["ctrl+c"]);
		const vertical = `${keybindingLabel(this.keybindings, "tui.select.up")}/${keybindingLabel(this.keybindings, "tui.select.down")}`;
		const confirmUsesSpace = this.keybindings.matches(" ", "tui.select.confirm");
		const detailedFooter = this.warning
			? `${this.warning} • ${confirmUsesSpace ? "Shift+Arrows select" : "Space lines • Shift+Arrows text"} • ${back} back • Ctrl+C close`
			: this.lineAnchor !== undefined
				? `${confirmUsesSpace ? `${vertical} extend lines` : `Space clear • ${vertical} extend lines`} • Shift+Arrows text • ${confirm} bring • ${back} back • Ctrl+C close`
				: `Shift+Arrows select • Arrows move${confirmUsesSpace ? "" : " • Space lines"} • ${confirm} bring • ${back} back • Ctrl+C close`;
		const criticalFooter = `${confirm} bring • ${back} back • Ctrl+C close`;
		const footer = visibleWidth(detailedFooter) <= safeWidth ? detailedFooter : criticalFooter;
		return [
			truncateToWidth(
				this.theme.fg("accent", this.theme.bold("Select text to bring to main")),
				safeWidth,
				"",
			),
			truncateToWidth(this.theme.fg("muted", status), safeWidth, ""),
			...rows,
			truncateToWidth(this.theme.fg(this.warning ? "warning" : "muted", footer), safeWidth, ""),
		];
	}

	handleInput(data: string): void {
		if (this.finished) return;
		if (matchesKey(data, Key.ctrl("c"))) {
			this.finish({ kind: "close" });
			return;
		}
		if (this.keybindings.matches(data, "tui.select.cancel")) {
			this.finish({ kind: "back" });
			return;
		}
		if (matchesConfirm(data, this.keybindings)) {
			if (this.lines.length > 0) {
				const segments = this.getSelectedSegments();
				if (segments.length === 0) {
					this.warning = "Select text first";
					this.tui.requestRender();
				} else {
					this.finish({ kind: "confirm", segments });
				}
			}
			return;
		}
		if (matchesKey(data, Key.space)) {
			this.anchor = undefined;
			this.lineAnchor = this.lineAnchor === undefined ? this.cursor.line : undefined;
			this.afterMove();
			return;
		}
		if (matchesKey(data, Key.shift("left"))) {
			this.moveHorizontal(-1, true);
			return;
		}
		if (matchesKey(data, Key.shift("right"))) {
			this.moveHorizontal(1, true);
			return;
		}
		if (matchesKey(data, Key.shift("up"))) {
			this.moveVertical(-1, true);
			return;
		}
		if (matchesKey(data, Key.shift("down"))) {
			this.moveVertical(1, true);
			return;
		}
		if (matchesKey(data, Key.left)) {
			this.moveHorizontal(-1, false);
			return;
		}
		if (matchesKey(data, Key.right)) {
			this.moveHorizontal(1, false);
			return;
		}
		if (this.keybindings.matches(data, "tui.select.up")) {
			this.moveVertical(-1, false);
			return;
		}
		if (this.keybindings.matches(data, "tui.select.down")) {
			this.moveVertical(1, false);
			return;
		}
	}

	invalidate(): void {}

	private renderTextLine(
		line: BtwSelectionLine,
		lineIndex: number,
		range: { start: BtwTextPosition; end: BtwTextPosition } | undefined,
		lineSelected: boolean,
	): string {
		const characters = splitGraphemes(line.text);
		let rendered = this.horizontalOffset > 0 ? this.theme.fg("muted", "…") : "";
		let buffer = "";
		let bufferSelected = false;
		const flush = () => {
			if (!buffer) return;
			rendered += bufferSelected
				? this.theme.bg("selectedBg", this.theme.fg("text", buffer))
				: buffer;
			buffer = "";
		};
		for (let column = this.horizontalOffset; column <= characters.length; column += 1) {
			if (range && lineIndex === range.start.line && column === range.start.column) {
				flush();
				rendered += this.theme.fg("accent", "[");
			}
			if (lineIndex === this.cursor.line && column === this.cursor.column) {
				flush();
				rendered += this.theme.fg("accent", "│");
			}
			if (range && lineIndex === range.end.line && column === range.end.column) {
				flush();
				rendered += this.theme.fg("accent", "]");
			}
			const character = characters[column];
			if (character === undefined) continue;
			const selected =
				lineSelected || (range ? positionFallsInside(lineIndex, column, range) : false);
			if (buffer && selected !== bufferSelected) flush();
			bufferSelected = selected;
			buffer += escapeTerminalControls(character);
		}
		flush();
		return rendered;
	}

	private getSelectionRange(): { start: BtwTextPosition; end: BtwTextPosition } | undefined {
		if (!this.anchor || compareTextPositions(this.anchor, this.cursor) === 0) return undefined;
		return compareTextPositions(this.anchor, this.cursor) < 0
			? { start: this.anchor, end: this.cursor }
			: { start: this.cursor, end: this.anchor };
	}

	private getLineSelectionRange(): { start: number; end: number } | undefined {
		return this.lineAnchor === undefined
			? undefined
			: {
					start: Math.min(this.lineAnchor, this.cursor.line),
					end: Math.max(this.lineAnchor, this.cursor.line),
				};
	}

	private getSelectedSegments(): BtwBringToMainSegment[] {
		if (this.lineAnchor !== undefined) {
			return segmentsFromLineRange(this.lines, this.lineAnchor, this.cursor.line);
		}
		return this.anchor ? segmentsFromTextRange(this.lines, this.anchor, this.cursor) : [];
	}

	private moveHorizontal(delta: -1 | 1, extend: boolean): void {
		if (this.lines.length === 0) return;
		if (!extend) this.lineAnchor = undefined;
		if (!extend && this.anchor) {
			const range = this.getSelectionRange();
			if (range) this.cursor = delta < 0 ? range.start : range.end;
			this.anchor = undefined;
			this.preferredColumn = this.cursor.column;
			this.afterMove();
			return;
		}
		this.beginOrClearSelection(extend);
		const line = this.lines[this.cursor.line];
		const length = line ? splitGraphemes(line.text).length : 0;
		if (delta < 0) {
			if (this.cursor.column > 0) this.cursor = { ...this.cursor, column: this.cursor.column - 1 };
			else if (this.cursor.line > 0) {
				const previousLine = this.lines[this.cursor.line - 1];
				this.cursor = {
					line: this.cursor.line - 1,
					column: previousLine ? splitGraphemes(previousLine.text).length : 0,
				};
			}
		} else if (this.cursor.column < length) {
			this.cursor = { ...this.cursor, column: this.cursor.column + 1 };
		} else if (this.cursor.line < this.lines.length - 1) {
			this.cursor = { line: this.cursor.line + 1, column: 0 };
		}
		this.preferredColumn = this.cursor.column;
		this.afterMove();
	}

	private moveVertical(delta: number, extend: boolean): void {
		if (this.lines.length === 0) return;
		if (extend || this.lineAnchor === undefined) this.beginOrClearSelection(extend);
		const line = Math.max(0, Math.min(this.lines.length - 1, this.cursor.line + delta));
		const target = this.lines[line];
		this.cursor = {
			line,
			column: Math.min(this.preferredColumn, target ? splitGraphemes(target.text).length : 0),
		};
		this.afterMove();
	}

	private beginOrClearSelection(extend: boolean): void {
		if (extend) this.lineAnchor = undefined;
		if (extend && !this.anchor) this.anchor = { ...this.cursor };
		if (!extend) this.anchor = undefined;
	}

	private afterMove(): void {
		this.warning = undefined;
		this.keepCursorVisible();
		this.tui.requestRender();
	}

	// Reveal the cursor row inside the fullscreen scroll view (wheel/PgUp/PgDn scroll it natively).
	private keepCursorVisible(): void {
		const view = this.tui as TUI & { viewportTop?: number; scrollBy?: (lines: number) => void };
		if (typeof view.scrollBy !== "function" || typeof view.viewportTop !== "number") return;
		const row = SELECTOR_CHROME_LINES + this.cursor.line;
		const height = Math.max(1, this.tui.terminal.rows);
		const top = view.viewportTop + SELECTOR_CHROME_LINES;
		const bottom = view.viewportTop + height - 2;
		if (row < top) view.scrollBy(row - top);
		else if (row > bottom) view.scrollBy(row - bottom);
	}

	private keepCursorHorizontallyVisible(width: number): void {
		const characters = splitGraphemes(this.lines[this.cursor.line]?.text ?? "");
		const displayWidths = characters.map((character) =>
			visibleWidth(escapeTerminalControls(character)),
		);
		const currentWidth = displayWidths[this.cursor.column] ?? 0;
		let usedWidth = 1 + Math.min(currentWidth, Math.max(0, width - 1));
		let offset = this.cursor.column;
		for (let index = this.cursor.column - 1; index >= 0; index -= 1) {
			const nextWidth = usedWidth + (displayWidths[index] ?? 0) + (index > 0 ? 1 : 0);
			if (nextWidth > width) break;
			usedWidth += displayWidths[index] ?? 0;
			offset = index;
		}
		this.horizontalOffset = offset;
	}

	private finish(action: BtwTextRangeSelectorAction): void {
		if (this.finished) return;
		this.finished = true;
		this.onAction(action);
	}
}

function clampTextPosition(
	lines: readonly BtwSelectionLine[],
	position: BtwTextPosition,
): BtwTextPosition {
	const line = Math.max(0, Math.min(lines.length - 1, position.line));
	const text = lines[line]?.text ?? "";
	return {
		line,
		column: Math.max(0, Math.min(splitGraphemes(text).length, position.column)),
	};
}

function confirmKeyLabel(keybindings: KeybindingsManager): string {
	return keybindingLabel(keybindings, "tui.select.confirm", ["ctrl+c"], "enter");
}

function matchesConfirm(data: string, keybindings: KeybindingsManager): boolean {
	if (matchesKey(data, Key.ctrl("c"))) return false;
	const hasUsableBinding = keybindings
		.getKeys("tui.select.confirm")
		.map(String)
		.some((key) => key.toLowerCase() !== "ctrl+c");
	return (
		keybindings.matches(data, "tui.select.confirm") ||
		(!hasUsableBinding && matchesKey(data, Key.enter))
	);
}

function keybindingLabel(
	keybindings: KeybindingsManager,
	keybinding: "tui.select.confirm" | "tui.select.cancel" | "tui.select.up" | "tui.select.down",
	excluded: readonly string[] = [],
	fallback?: string,
): string {
	const key = keybindings
		.getKeys(keybinding)
		.map(String)
		.find((candidate) => !excluded.includes(candidate.toLowerCase()));
	return formatKeyLabel(key ?? fallback ?? keybinding);
}

function formatKeyLabel(key: string): string {
	return key
		.split("+")
		.map((part) => {
			const lower = part.toLowerCase();
			if (lower === "ctrl") return "Ctrl";
			if (lower === "alt") return "Alt";
			if (lower === "shift") return "Shift";
			if (lower === "escape" || lower === "esc") return "Esc";
			if (lower === "enter" || lower === "return") return "Enter";
			if (lower === "pageup") return "PgUp";
			if (lower === "pagedown") return "PgDn";
			return part.length === 1
				? part.toUpperCase()
				: `${part[0]?.toUpperCase() ?? ""}${part.slice(1)}`;
		})
		.join("+");
}

function splitGraphemes(text: string): string[] {
	return [...GRAPHEME_SEGMENTER.segment(text)].map(({ segment }) => segment);
}

function compareTextPositions(first: BtwTextPosition, second: BtwTextPosition): number {
	return first.line === second.line ? first.column - second.column : first.line - second.line;
}

function positionFallsInside(
	line: number,
	column: number,
	range: { start: BtwTextPosition; end: BtwTextPosition },
): boolean {
	const position = { line, column };
	return (
		compareTextPositions(position, range.start) >= 0 &&
		compareTextPositions(position, range.end) < 0
	);
}

function escapeBringToMainText(text: string): string {
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
		.join("")
		.replace(/<btw_context(?=[ \t\r\n>])/g, "&lt;btw_context")
		.replace(/<\/btw_context[ \t\r\n]*>/g, (terminator) =>
			terminator.replaceAll("<", "&lt;").replaceAll(">", "&gt;"),
		);
}

function escapeTerminalControls(text: string): string {
	return [...text]
		.map((character) => {
			const code = character.charCodeAt(0);
			if (code <= 31 || (code >= 127 && code <= 159)) {
				return `\\x${code.toString(16).padStart(2, "0")}`;
			}
			return character;
		})
		.join("");
}
