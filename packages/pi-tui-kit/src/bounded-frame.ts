import { stripVTControlCharacters } from "node:util";
import { truncateToWidth } from "@earendil-works/pi-tui";

/** Already formatted single-line rows. Sanitize untrusted values before styling or wrapping. */
export interface BoundedFrameOptions {
	width: number;
	maxRows: number;
	rule: string;
	title: readonly string[];
	context?: readonly string[];
	content: readonly string[];
	hints?: readonly string[];
	/** Full hints for compact mode, optionally including an overflow indicator. */
	compactHints?: readonly string[];
	compactHint?: string;
	/** Content row indexes in retention priority order; blank rows are ignored when compacting. */
	priorityRows?: readonly number[];
	/** Content row whose neighbors fill the remaining compact budget. */
	focusedRow?: number;
}

/** Frame terminal-formatted rows without owning input, persistence, or terminal reservations. */
export function renderBoundedFrame(options: BoundedFrameOptions): string[] {
	const width = dimension(options.width);
	const maxRows = dimension(options.maxRows);
	if (maxRows === 0) return [];
	const { rule, title, content, hints = [], context = [], compactHint = "" } = options;
	const full = [
		rule,
		...title,
		...context,
		...(content.length ? ["", ...content] : []),
		...hints,
		rule,
	];
	if (full.length <= maxRows) return full.map((line) => truncateToWidth(line, width, ""));

	const framed = maxRows >= 5;
	const available = maxRows - (framed ? 2 : 0);
	const rows = content
		.map((line, index) => ({ line, index }))
		.filter(({ line }) => stripVTControlCharacters(line).trim().length > 0);
	const priorities = [...new Set(options.priorityRows ?? [])]
		.map((index) => rows.findIndex((row) => row.index === index))
		.filter((index) => index >= 0);
	const focused = rows.findIndex((row) => row.index === options.focusedRow);
	const body = rows.length
		? compactContent(
				title,
				context,
				rows.map(({ line }) => line),
				options.compactHints ?? hints,
				compactHint,
				available,
				priorities,
				focused,
			)
		: compactStatic(title, context, compactHint, available);
	return (framed ? [rule, ...body, rule] : body).map((line) => truncateToWidth(line, width, ""));
}

function dimension(value: number): number {
	return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

function compactContent(
	title: readonly string[],
	context: readonly string[],
	content: readonly string[],
	hints: readonly string[],
	compactHint: string,
	available: number,
	priorities: readonly number[],
	focused: number,
): string[] {
	const hintBudget = compactHint && available > 1 ? 1 : 0;
	const minimumContent = Math.min(available - hintBudget, Math.max(1, priorities.length));
	let remaining = Math.max(0, available - hintBudget - minimumContent);
	const titleBudget = title.length > 0 && remaining > 0 ? 1 : 0;
	remaining -= titleBudget;
	const extraHints = Math.max(0, hints.length - hintBudget);
	const fullHints = hintBudget > 0 && hints.length > 0 && extraHints <= remaining;
	if (fullHints) remaining -= extraHints;
	const contentBudget = Math.min(content.length, minimumContent + remaining);
	remaining -= contentBudget - minimumContent;
	const contextBudget = Math.min(context.length, remaining);
	const indexes = new Set(priorities.slice(0, contentBudget));
	const fillOrder = content
		.map((_, index) => index)
		.sort((left, right) =>
			focused < 0
				? left - right
				: Math.abs(left - focused) - Math.abs(right - focused) || left - right,
		);
	for (const index of fillOrder) {
		if (indexes.size >= contentBudget) break;
		indexes.add(index);
	}
	return [
		...title.slice(0, titleBudget),
		...context.slice(0, contextBudget),
		...[...indexes].sort((left, right) => left - right).map((index) => content[index] ?? ""),
		...(hintBudget ? (fullHints ? hints : [compactHint]) : []),
	];
}

function compactStatic(
	title: readonly string[],
	context: readonly string[],
	compactHint: string,
	available: number,
): string[] {
	if (available === 1) return [context[0] || compactHint || title[0] || ""];
	const hintBudget = compactHint ? 1 : 0;
	const minimumContext = context.length > 0 ? 1 : 0;
	let remaining = Math.max(0, available - hintBudget - minimumContext);
	const titleBudget = title.length > 0 && remaining > 0 ? 1 : 0;
	remaining -= titleBudget;
	return [
		...title.slice(0, titleBudget),
		...context.slice(0, Math.min(context.length, minimumContext + remaining)),
		...(hintBudget ? [compactHint] : []),
	];
}
