import { stripVTControlCharacters } from "node:util";
import { type Input, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { HorizontalRule } from "../horizontal-rule.js";
import { formatInteractionHints } from "../interaction-hints.js";
import { replaceTerminalControls, safeMenuText } from "../text.js";
import type { ActionMenuItem } from "../types.js";
import type { MenuKeybindings, MenuScreenComponentOptions } from "./contracts.js";

export { safeMenuText } from "../text.js";

export function actionMenuItemPresentation(item: ActionMenuItem<string, string>): {
	label: string;
	description?: string;
} {
	const label = safeMenuText(item.label);
	const description = item.description ? safeMenuText(item.description) : undefined;
	return { label: item.disabled ? `[-] ${label}` : label, description };
}

export function actionMenuUnavailableDescription(
	item: ActionMenuItem<string, string>,
): string | undefined {
	if (!item.disabled) return undefined;
	const reason = safeMenuText(item.disabledReason ?? "");
	return reason ? `Unavailable: ${reason}` : undefined;
}

export function actionMenuDialogLabel(item: ActionMenuItem<string, string>): string {
	const label = safeMenuText(item.label);
	const reason = safeMenuText(item.disabledReason ?? "");
	if (!item.disabled || !reason) return label;
	return `[-] ${label} (unavailable: ${reason})`;
}

export function renderFrame<ScreenId extends string, ActionId extends string>(
	title: string,
	lines: readonly string[],
	content: readonly string[],
	destination: "back" | "close",
	width: number,
	options: MenuScreenComponentOptions<ScreenId, ActionId>,
	confirmAction = "select",
): string[] {
	const safeWidth = Math.max(1, width);
	const rule = renderHorizontalRule(safeWidth, options.theme);
	const titleRows = wrapTextWithAnsi(
		options.theme.fg("accent", options.theme.bold(safeMenuText(title))),
		safeWidth,
	);
	const contextRows = lines.flatMap((line) =>
		wrapTextWithAnsi(options.theme.fg("muted", safeMenuText(line)), safeWidth),
	);
	const hintRows = wrapTextWithAnsi(
		options.theme.fg("dim", menuHint(options.keybindings, destination, confirmAction)),
		safeWidth,
	);
	const fullFrame = [
		rule,
		...titleRows,
		...contextRows,
		...(content.length > 0 ? ["", ...content] : []),
		...hintRows,
		rule,
	];
	const maxRows = terminalRows(options.tui.terminal.rows);
	const result =
		fullFrame.length <= maxRows
			? fullFrame
			: compactFrame(rule, titleRows, contextRows, content, hintRows, maxRows);
	return result.map((line) => truncateToWidth(line, safeWidth, ""));
}

function compactFrame(
	rule: string,
	titleRows: readonly string[],
	contextRows: readonly string[],
	contentRows: readonly string[],
	hintRows: readonly string[],
	maxRows: number,
): string[] {
	if (maxRows === 1) {
		return [titleRows[0] ?? contentRows[0] ?? hintRows.at(-1) ?? rule];
	}
	if (maxRows === 2) return [rule, rule];
	if (maxRows === 3) return [rule, titleRows[0] ?? contentRows[0] ?? hintRows.at(-1) ?? "", rule];
	const boundedTitle = titleRows.slice(0, 1);
	const hintBudget = Math.min(hintRows.length, Math.max(0, maxRows - 2 - boundedTitle.length));
	const boundedHints = hintBudget > 0 ? hintRows.slice(-hintBudget) : [];
	const bodyBudget = Math.max(0, maxRows - 2 - boundedTitle.length - boundedHints.length);
	const boundedContent = focusedRows(contentRows, Math.min(contentRows.length, bodyBudget));
	const contextBudget = Math.max(0, bodyBudget - boundedContent.length);
	const boundedContext = contextRows.slice(0, contextBudget);
	return [rule, ...boundedTitle, ...boundedContext, ...boundedContent, ...boundedHints, rule].slice(
		0,
		maxRows,
	);
}

function focusedRows(rows: readonly string[], budget: number): readonly string[] {
	if (budget <= 0) return [];
	if (rows.length <= budget) return rows;
	const selectedIndex = rows.findIndex((line) => /^[→›]\s/u.test(stripVTControlCharacters(line)));
	if (selectedIndex < 0) return rows.slice(0, budget);
	const start = Math.max(0, Math.min(selectedIndex - Math.floor(budget / 2), rows.length - budget));
	return rows.slice(start, start + budget);
}

function terminalRows(rows: number) {
	return Number.isFinite(rows) ? Math.max(1, Math.floor(rows)) : 24;
}

export function renderHorizontalRule(
	width: number,
	theme: MenuScreenComponentOptions<string, string>["theme"],
): string {
	return (
		new HorizontalRule({
			ruleStyle: (text) => theme.fg("border", text),
		}).render(Math.max(1, width))[0] ?? ""
	);
}

export function menuHint(
	keybindings: MenuKeybindings,
	destination: "back" | "close",
	confirmAction: string,
) {
	return formatInteractionHints(keybindings, [
		{ bindings: ["tui.select.up", "tui.select.down"], label: "navigate" },
		...(confirmAction ? [{ bindings: ["tui.select.confirm"] as const, label: confirmAction }] : []),
		{
			bindings: ["tui.select.cancel"],
			excludeKeys: ["ctrl+c"],
			label: destination,
		},
		...(destination === "back" ? [{ keys: ["ctrl+c"], label: "close" }] : []),
	]);
}

export function handleSearchInput(input: Input, data: string) {
	input.handleInput(data);
	const value = replaceTerminalControls(input.getValue());
	if (value !== input.getValue()) input.setValue(value);
}
