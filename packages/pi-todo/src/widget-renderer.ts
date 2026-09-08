import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { EditorStatusWidget } from "@narumitw/pi-tui-kit/editor-status-widget";
import { sanitizeTerminalDocument } from "@narumitw/pi-tui-kit/terminal-document";
import { DEFAULT_TODO_SETTINGS, type TodoWidgetSettings } from "./settings.js";
import type { Todo } from "./todo-widget.js";

export interface RenderTodoWidgetOptions {
	settings?: Readonly<TodoWidgetSettings>;
	terminalRows?: number;
}

interface RenderedTodo {
	todo: Todo;
	lines: string[];
}

export function renderTodoWidget(
	todos: readonly Todo[],
	theme: Theme,
	width: number,
	options: RenderTodoWidgetOptions = {},
): string[] {
	const renderWidth = Math.max(0, width);
	const settings = options.settings ?? DEFAULT_TODO_SETTINGS.widget;
	const header = renderHeader(todos, theme, renderWidth, settings.showProgress);
	const rendered = todos.map((todo) => ({ todo, lines: renderTodo(todo, theme, renderWidth) }));

	let lines: string[];
	switch (settings.displayMode) {
		case "expanded":
			lines = renderExpanded(header, rendered, settings, theme, renderWidth);
			break;
		case "collapsed":
			lines = renderCollapsed(
				header,
				rendered,
				settings,
				theme,
				renderWidth,
				widgetRowBudget(options.terminalRows),
			);
			break;
		case "adaptive": {
			const expanded = renderExpanded(header, rendered, settings, theme, renderWidth);
			const rowBudget = widgetRowBudget(options.terminalRows);
			const eligibleItems = settings.showCompleted
				? rendered.length
				: rendered.filter(({ todo }) => todo.status !== "completed").length;
			const itemCapHidesWork =
				settings.maxVisibleItems !== null && eligibleItems > settings.maxVisibleItems;
			lines =
				expanded.length <= rowBudget && !itemCapHidesWork
					? expanded
					: renderCollapsed(header, rendered, settings, theme, renderWidth, rowBudget);
			break;
		}
	}

	return lines.map((line) => truncateToWidth(line, renderWidth, ""));
}

export function renderCompletionSummary(total: number, theme: Theme, width: number): string[] {
	return new EditorStatusWidget({
		theme,
		renderBody: () => [theme.fg("success", `✓ ${total}/${total} tasks completed`)],
	}).render(width);
}

export function sanitizeTodoText(value: string): string {
	// Document sanitization preserves Todo's control-to-space policy; whitespace is local.
	return sanitizeTerminalDocument(value).replace(/\s+/gu, " ").trim();
}

export function widgetRowBudget(terminalRows?: number): number {
	const rows =
		typeof terminalRows === "number" && Number.isFinite(terminalRows)
			? Math.max(0, Math.floor(terminalRows))
			: 36;
	return Math.max(4, Math.min(12, Math.floor(rows / 3)));
}

function renderHeader(
	todos: readonly Todo[],
	theme: Theme,
	width: number,
	showProgress: boolean,
): string[] {
	const completed = todos.filter((todo) => todo.status === "completed").length;
	// Keep both heading rows inside Todo's existing adaptive budget.
	return new EditorStatusWidget({
		theme,
		renderBody: () => [
			theme.fg("muted", showProgress ? `Todo · ${completed}/${todos.length} complete` : "Todo"),
		],
	}).render(width);
}

function renderTodo(todo: Todo, theme: Theme, width: number): string[] {
	const step = sanitizeTodoText(todo.step) || "(text hidden after sanitization)";
	let prefix: string;
	let styledText: string;
	switch (todo.status) {
		case "completed":
			prefix = theme.fg("success", "✓ ");
			styledText = theme.fg("muted", theme.strikethrough(step));
			break;
		case "in_progress":
			prefix = theme.fg("accent", "▶ ");
			styledText = theme.fg("accent", theme.bold(step));
			break;
		case "blocked": {
			prefix = theme.fg("warning", "⚠ ");
			const reason = sanitizeTodoText(todo.reason ?? "") || "(reason hidden after sanitization)";
			styledText = `${theme.fg("warning", step)}${reason ? theme.fg("muted", ` — ${reason}`) : ""}`;
			break;
		}
		case "pending":
			prefix = theme.fg("dim", "○ ");
			styledText = theme.fg("text", step);
			break;
	}

	if (width <= 2) return [prefix];
	const wrapped = wrapTextWithAnsi(styledText, width - 2);
	return wrapped.map((line, index) => `${index === 0 ? prefix : "  "}${line}`);
}

function renderExpanded(
	header: readonly string[],
	rendered: readonly RenderedTodo[],
	settings: Readonly<TodoWidgetSettings>,
	theme: Theme,
	width: number,
): string[] {
	const candidates = settings.showCompleted
		? rendered
		: rendered.filter(({ todo }) => todo.status !== "completed");
	const visible = candidates.slice(0, settings.maxVisibleItems ?? candidates.length);
	const hidden = candidates.length - visible.length;
	const lines = [...header, ...visible.flatMap((item) => item.lines)];
	if (hidden > 0) lines.push(theme.fg("dim", `… ${hidden} more`));
	return lines.map((line) => truncateToWidth(line, width, ""));
}

function renderCollapsed(
	header: readonly string[],
	rendered: readonly RenderedTodo[],
	settings: Readonly<TodoWidgetSettings>,
	theme: Theme,
	width: number,
	rowBudget: number,
): string[] {
	const prioritized = [
		...rendered.filter(({ todo }) => todo.status === "in_progress"),
		...rendered.filter(({ todo }) => todo.status === "blocked"),
		...rendered.filter(({ todo }) => todo.status === "pending"),
	];
	const itemLimit = Math.min(settings.maxVisibleItems ?? prioritized.length, prioritized.length);
	const completed = rendered.filter(({ todo }) => todo.status === "completed").length;
	const bodyBudget = Math.max(0, rowBudget - header.length);
	const selected: string[] = [];
	let selectedItems = 0;
	let clippedItem = false;

	for (const item of prioritized.slice(0, itemLimit)) {
		const remainingItems = prioritized.length - selectedItems - 1;
		const needsFooter =
			remainingItems > 0 ||
			itemLimit < prioritized.length ||
			(settings.showCompleted && completed > 0);
		const available = bodyBudget - selected.length - (needsFooter ? 1 : 0);
		if (available <= 0) break;
		if (item.lines.length <= available) {
			selected.push(...item.lines);
			selectedItems += 1;
			continue;
		}
		if (selectedItems === 0) {
			selected.push(...clipLines(item.lines, available, width));
			selectedItems += 1;
			clippedItem = true;
		}
		break;
	}

	const hidden = prioritized.length - selectedItems;
	const footerParts: string[] = [];
	if (settings.showCompleted && completed > 0) footerParts.push(`✓ ${completed} completed`);
	if (hidden > 0) footerParts.push(`… ${hidden} more`);
	if (clippedItem) footerParts.push("item truncated");
	if (footerParts.length > 0 && selected.length < bodyBudget) {
		selected.push(theme.fg("dim", footerParts.join(" · ")));
	}

	return [...header, ...selected]
		.slice(0, rowBudget)
		.map((line) => truncateToWidth(line, width, ""));
}

function clipLines(lines: readonly string[], count: number, width: number): string[] {
	const clipped = lines.slice(0, count);
	const last = clipped.at(-1);
	if (last !== undefined) clipped[clipped.length - 1] = truncateToWidth(`${last}…`, width, "…");
	return clipped;
}
