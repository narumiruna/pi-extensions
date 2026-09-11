import type { KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import {
	fuzzyFilter,
	Input,
	isKittyProtocolActive,
	Key,
	type KeyId,
	matchesKey,
	parseKey,
	type TUI,
	type TuiMouseEvent,
	type TuiMouseEventResult,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";
import { renderBoundedFrameLayout } from "../bounded-frame.js";
import { HorizontalRule } from "../horizontal-rule.js";
import { formatInteractionHints } from "../interaction-hints.js";
import { sanitizeTerminalText } from "../terminal-text.js";
import type { MenuCloseReason } from "../types.js";
import { componentRows } from "./rendering.js";

const BRACKETED_PASTE_START = "\u001b[200~";
const BRACKETED_PASTE_END = "\u001b[201~";
const INPUT_PREFIX_TIMEOUT_MS = 10;

export interface PiSelectorRow<Value> {
	value: Value;
	primary: string;
	secondary?: string;
	description?: string;
	searchText?: string;
	current?: boolean;
	default?: boolean;
}

export interface PiSelectorOptions<Value> {
	title?: string;
	context?: readonly string[];
	rows: readonly PiSelectorRow<Value>[];
	initialValue?: Value;
	initialSearchInput?: string;
	viewportSize?: number;
	saveBinding: "app.models.save";
	cycleBinding?: "app.thinking.cycle";
	filterSelection: "bestMatch" | "preserveValue";
	inlineDescriptions?: boolean;
	prioritizeDefaultPrefix?: boolean;
	valueEquals(left: Value, right: Value): boolean;
	onComplete(
		result:
			| { kind: "selected"; value: Value }
			| { kind: "saveDefault"; value: Value }
			| { kind: "closed"; reason: MenuCloseReason },
	): void;
	tui: TUI;
	theme: Theme;
	keybindings: KeybindingsManager;
}

/** Shared public-primitive implementation for searchable default-aware selectors. */
export function createPiSelector<Value>(options: PiSelectorOptions<Value>) {
	const input = new Input();
	if (options.initialSearchInput) input.setValue(safe(options.initialSearchInput));
	let filtered = filterRows(
		options.rows,
		input.getValue(),
		options.prioritizeDefaultPrefix ?? false,
	);
	let selectedIndex =
		options.filterSelection === "bestMatch" && input.getValue()
			? 0
			: initialIndex(filtered, options.initialValue, options.valueEquals);
	let disposed = false;
	let pasteStartBuffer = "";
	let pasteBuffer: string | undefined;
	let pasteStartTimer: ReturnType<typeof setTimeout> | undefined;
	let mousePressedIndex: number | undefined;
	let mouseLayout:
		| {
				width: number;
				inputFrameRow?: number;
				itemByFrameRow: ReadonlyMap<number, number>;
		  }
		| undefined;

	const select = (index: number, wrap: boolean) => {
		if (filtered.length === 0) return;
		selectedIndex = wrap
			? (index + filtered.length) % filtered.length
			: Math.max(0, Math.min(index, filtered.length - 1));
		options.tui.requestRender();
	};
	const refilter = () => {
		const previous = filtered[selectedIndex]?.value;
		filtered = filterRows(options.rows, input.getValue(), options.prioritizeDefaultPrefix ?? false);
		if (options.filterSelection === "preserveValue" && previous !== undefined) {
			const preserved = filtered.findIndex((row) => options.valueEquals(row.value, previous));
			selectedIndex = Math.max(0, preserved);
		} else {
			selectedIndex = filtered.length === 0 ? 0 : Math.min(selectedIndex, filtered.length - 1);
			if (input.getValue()) selectedIndex = 0;
		}
		options.tui.requestRender();
	};
	const completeSelected = (kind: "selected" | "saveDefault") => {
		const selected = filtered[selectedIndex];
		if (!selected || disposed) return;
		options.onComplete({ kind, value: selected.value });
	};
	input.onSubmit = () => completeSelected("selected");
	const handleSearchInput = (data: string) => {
		input.handleInput(parseKey(data) === undefined ? safe(data) : data);
		if (!disposed) refilter();
	};
	const saveDefault = (data: string) => {
		if (!matchesBinding(options.keybindings, data, options.saveBinding)) return false;
		completeSelected("saveDefault");
		return true;
	};
	const handleNonPasteInput = (data: string) => {
		if (matchesKey(data, Key.ctrl("c"))) {
			options.onComplete({ kind: "closed", reason: "close" });
			return;
		}
		if (saveDefault(data)) return;
		if (options.keybindings.matches(data, "tui.select.confirm")) {
			completeSelected("selected");
			return;
		}
		if (options.keybindings.matches(data, "tui.select.cancel")) {
			options.onComplete({ kind: "closed", reason: "back" });
			return;
		}
		if (options.cycleBinding && matchesBinding(options.keybindings, data, options.cycleBinding)) {
			select(selectedIndex + 1, true);
			return;
		}
		if (options.keybindings.matches(data, "tui.select.up")) select(selectedIndex - 1, true);
		else if (options.keybindings.matches(data, "tui.select.down")) {
			select(selectedIndex + 1, true);
		} else if (options.keybindings.matches(data, "tui.select.pageUp")) {
			select(selectedIndex - normalizeViewportSize(options.viewportSize), false);
		} else if (options.keybindings.matches(data, "tui.select.pageDown")) {
			select(selectedIndex + normalizeViewportSize(options.viewportSize), false);
		} else handleSearchInput(data);
	};
	function routeInput(data: string) {
		clearPasteStartTimer();
		if (pasteBuffer !== undefined) {
			pasteBuffer += data;
			flushPasteBuffer();
			return;
		}
		const combined = pasteStartBuffer + data;
		pasteStartBuffer = "";
		const pasteStart = combined.indexOf(BRACKETED_PASTE_START);
		if (pasteStart >= 0) {
			if (pasteStart > 0) handleNonPasteInput(combined.slice(0, pasteStart));
			if (disposed) return;
			pasteBuffer = combined.slice(pasteStart + BRACKETED_PASTE_START.length);
			flushPasteBuffer();
			return;
		}
		const prefixLength = trailingMarkerPrefixLength(combined, BRACKETED_PASTE_START);
		const outsidePaste = combined.slice(0, combined.length - prefixLength);
		if (outsidePaste) handleNonPasteInput(outsidePaste);
		if (disposed) return;
		const prefix = combined.slice(combined.length - prefixLength);
		if (prefix) {
			pasteStartBuffer = prefix;
			pasteStartTimer = setTimeout(() => {
				pasteStartTimer = undefined;
				const pending = pasteStartBuffer;
				pasteStartBuffer = "";
				if (!disposed && pending) handleNonPasteInput(pending);
			}, INPUT_PREFIX_TIMEOUT_MS);
		}
	}

	function clearPasteStartTimer() {
		if (!pasteStartTimer) return;
		clearTimeout(pasteStartTimer);
		pasteStartTimer = undefined;
	}

	function flushPasteBuffer() {
		if (pasteBuffer === undefined) return;
		const pasteEnd = pasteBuffer.indexOf(BRACKETED_PASTE_END);
		if (pasteEnd < 0) return;
		const pasted = pasteBuffer.slice(0, pasteEnd);
		const remaining = pasteBuffer.slice(pasteEnd + BRACKETED_PASTE_END.length);
		pasteBuffer = undefined;
		input.handleInput(
			`${BRACKETED_PASTE_START}${normalizePastedInput(pasted)}${BRACKETED_PASTE_END}`,
		);
		refilter();
		if (remaining && !disposed) routeInput(remaining);
	}

	function handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (disposed || !mouseLayout || event.width !== mouseLayout.width) return undefined;
		if (event.y === mouseLayout.inputFrameRow) {
			return input.handleMouse({
				...event,
				x: event.x - 2,
				y: 0,
				width: Math.max(1, event.width - 2),
				height: 1,
			});
		}
		const itemIndex = mouseLayout.itemByFrameRow.get(event.y);
		if (itemIndex === undefined) return undefined;
		if (event.type === "wheel" && event.wheelDelta) {
			const next = Math.max(
				0,
				Math.min(filtered.length - 1, selectedIndex + (event.wheelDelta < 0 ? -1 : 1)),
			);
			const changed = next !== selectedIndex;
			if (changed) select(next, false);
			return { handled: true, render: changed };
		}
		if (event.type !== "move" && event.button !== "left") return undefined;
		if (event.type === "move" || event.type === "press") {
			if (event.type === "press") mousePressedIndex = itemIndex;
			const changed = itemIndex !== selectedIndex;
			if (changed) select(itemIndex, false);
			return {
				handled: true,
				focus: event.type === "press",
				...(event.type === "move" ? { render: changed } : {}),
			};
		}
		if (event.type === "click") {
			const clickedIndex = mousePressedIndex ?? itemIndex;
			mousePressedIndex = undefined;
			selectedIndex = clickedIndex;
			completeSelected("selected");
			return { handled: true };
		}
		return undefined;
	}

	return {
		get focused() {
			return input.focused;
		},
		set focused(value: boolean) {
			input.focused = value;
		},
		render(width: number) {
			if (!Number.isFinite(width) || width <= 0) return [];
			const safeWidth = Math.max(1, Math.floor(width));
			const viewportSize = normalizeViewportSize(options.viewportSize);
			const start = Math.max(
				0,
				Math.min(selectedIndex - Math.floor(viewportSize / 2), filtered.length - viewportSize),
			);
			const visible = filtered.slice(start, start + viewportSize);
			const searchRows = renderSearchInput(input, safeWidth);
			const descriptionColumnWidth = options.inlineDescriptions
				? inlineDescriptionColumnWidth(visible)
				: undefined;
			const content = [
				...searchRows,
				"",
				...visible.map((row, index) =>
					renderRow(
						row,
						start + index,
						selectedIndex,
						options.theme,
						safeWidth,
						descriptionColumnWidth,
					),
				),
			];
			const selected = filtered[selectedIndex];
			if (start > 0 || start + visible.length < filtered.length) {
				content.push(options.theme.fg("muted", `  (${selectedIndex + 1}/${filtered.length})`));
			}
			if (filtered.length === 0) {
				content.push(options.theme.fg("muted", "  No matching options"));
			} else if (!options.inlineDescriptions && selected?.description) {
				content.push("", options.theme.fg("muted", `  ${safe(selected.description)}`));
			}

			const keyPlan = selectorKeyPlan(
				options.keybindings,
				options.saveBinding,
				options.cycleBinding,
			);
			const hint = selectorHint(keyPlan);
			const cycleHint = selectorCycleHint(keyPlan);
			const listSelectedIndex = selectedIndex - start;
			const selectedContentIndex = searchRows.length + 1 + listSelectedIndex;
			const rule =
				new HorizontalRule({
					ruleStyle: (text) => options.theme.fg("borderMuted", text),
				}).render(safeWidth)[0] ?? "";
			const layout = renderBoundedFrameLayout({
				width: safeWidth,
				maxRows: componentRows(options.tui.terminal.rows),
				rule,
				title: options.title ? [safe(options.title)] : [],
				context: [
					...(cycleHint ? [cycleHint] : []),
					...(options.context ?? []).map((line) => safe(line)),
				],
				content,
				hints: hint ? [options.theme.fg("dim", `  ${hint}`)] : [],
				compactHint: hint ? options.theme.fg("dim", hint) : "",
				priorityRows: [0, selectedContentIndex],
				focusedRow: selectedContentIndex,
			});
			const frameRowByContent = new Map(
				layout.contentRows.map(({ contentIndex, frameIndex }) => [contentIndex, frameIndex]),
			);
			mouseLayout = {
				width: safeWidth,
				inputFrameRow: frameRowByContent.get(0),
				itemByFrameRow: new Map(
					visible.flatMap((_, index) => {
						const frameRow = frameRowByContent.get(searchRows.length + 1 + index);
						return frameRow === undefined ? [] : [[frameRow, start + index] as const];
					}),
				),
			};
			return layout.lines;
		},
		invalidate() {
			mouseLayout = undefined;
			input.invalidate();
		},
		handleInput(data: string) {
			if (!disposed) routeInput(data);
		},
		handleMouse,
		dispose() {
			disposed = true;
			clearPasteStartTimer();
			pasteStartBuffer = "";
			pasteBuffer = undefined;
			mousePressedIndex = undefined;
			mouseLayout = undefined;
		},
	};
}

function filterRows<Value>(
	rows: readonly PiSelectorRow<Value>[],
	query: string,
	prioritizeDefaultPrefix: boolean,
): PiSelectorRow<Value>[] {
	const safeQuery = safe(query).trim();
	if (!safeQuery) return [...rows];
	const filtered = fuzzyFilter([...rows], safeQuery, (row) =>
		[row.searchText, row.primary, row.secondary, row.description]
			.filter((value): value is string => Boolean(value))
			.map(safe)
			.join(" "),
	);
	if (!prioritizeDefaultPrefix || !"default".startsWith(safeQuery.toLowerCase())) {
		return filtered;
	}
	const defaults = rows.filter((row) => row.default);
	return [...defaults, ...filtered.filter((row) => !row.default)];
}

function initialIndex<Value>(
	rows: readonly PiSelectorRow<Value>[],
	initialValue: Value | undefined,
	equals: (left: Value, right: Value) => boolean,
) {
	if (initialValue !== undefined) {
		const explicit = rows.findIndex((row) => equals(row.value, initialValue));
		if (explicit >= 0) return explicit;
	}
	const current = rows.findIndex((row) => row.current);
	return Math.max(0, current);
}

function renderRow<Value>(
	row: PiSelectorRow<Value>,
	index: number,
	selectedIndex: number,
	theme: Theme,
	width: number,
	descriptionColumnWidth: number | undefined,
) {
	const selected = index === selectedIndex;
	const cursor = selected ? theme.fg("accent", "→ ") : "  ";
	const current = row.current ? theme.fg("accent", "✓ ") : "  ";
	const primary = selected ? theme.fg("accent", safe(row.primary)) : safe(row.primary);
	const secondary = row.secondary ? ` ${theme.fg("muted", safe(row.secondary))}` : "";
	const defaultBadge = row.default ? theme.fg("muted", " · default") : "";
	const prefix = `${cursor}${current}`;
	const primaryText = `${primary}${secondary}${defaultBadge}`;
	if (descriptionColumnWidth !== undefined && row.description && width > 40) {
		const effectiveColumnWidth = Math.max(
			1,
			Math.min(descriptionColumnWidth, width - visibleWidth(prefix) - 4),
		);
		const truncatedPrimary = truncateToWidth(
			primaryText,
			Math.max(1, effectiveColumnWidth - 2),
			"",
		);
		const spacing = " ".repeat(Math.max(1, effectiveColumnWidth - visibleWidth(truncatedPrimary)));
		const remainingWidth =
			width - visibleWidth(prefix) - visibleWidth(truncatedPrimary) - spacing.length - 2;
		if (remainingWidth > 10) {
			const description = truncateToWidth(safe(row.description), remainingWidth, "");
			return `${prefix}${truncatedPrimary}${theme.fg("muted", `${spacing}${description}`)}`;
		}
	}
	return `${prefix}${primaryText}`;
}

function inlineDescriptionColumnWidth<Value>(rows: readonly PiSelectorRow<Value>[]) {
	const widest = rows.reduce((width, row) => {
		const primary = `${safe(row.primary)}${row.secondary ? ` ${safe(row.secondary)}` : ""}${
			row.default ? " · default" : ""
		}`;
		return Math.max(width, visibleWidth(primary) + 2);
	}, 0);
	return Math.max(12, Math.min(widest, 32));
}

function renderSearchInput(input: Input, width: number) {
	const prefix = "  ";
	const inputWidth = Math.max(1, width - visibleWidth(prefix));
	return input.render(inputWidth).map((line) => truncateToWidth(`${prefix}${line}`, width, ""));
}

interface SelectorKeyPlan {
	save: readonly string[];
	confirm: readonly string[];
	cancel: readonly string[];
	cycle: readonly string[];
}

function selectorKeyPlan(
	keybindings: KeybindingsManager,
	saveBinding: "app.models.save",
	cycleBinding: "app.thinking.cycle" | undefined,
): SelectorKeyPlan {
	const claimed = ["ctrl+c"];
	const claim = (binding: string | undefined) => {
		const available: string[] = [];
		if (!binding) return available;
		for (const key of getBindingKeys(keybindings, binding)) {
			const canonical = canonicalKeyId(key);
			if (!canonical || claimed.some((other) => keysOverlap(canonical, other))) continue;
			claimed.push(canonical);
			available.push(canonical);
		}
		return available;
	};
	return {
		save: claim(saveBinding),
		confirm: claim("tui.select.confirm"),
		cancel: claim("tui.select.cancel"),
		cycle: claim(cycleBinding),
	};
}

function selectorHint(plan: SelectorKeyPlan) {
	return formatInteractionHints({ getKeys: () => [] }, [
		{ keys: plan.confirm, label: "select" },
		{ keys: plan.save, label: "set as default" },
		{ keys: plan.cancel, label: "cancel" },
	]);
}

function selectorCycleHint(plan: SelectorKeyPlan) {
	return formatInteractionHints({ getKeys: () => [] }, [
		{ keys: plan.cycle, label: "cycle choice" },
	]);
}

function canonicalKeyId(value: string): string | undefined {
	const parts = safe(value).toLowerCase().split("+");
	const rawBase = parts.at(-1);
	if (!rawBase) return undefined;
	const base = rawBase === "esc" ? "escape" : rawBase === "return" ? "enter" : rawBase;
	const modifiers = ["shift", "ctrl", "alt", "super"].filter((modifier) =>
		parts.includes(modifier),
	);
	if (!isExecutableKey(base, modifiers)) return undefined;
	return [...modifiers, base].join("+");
}

function keysOverlap(first: string, second: string) {
	if (isKittyProtocolActive()) return first === second;
	return inputsForKey(first).some((input) => matchesKey(input, second as KeyId));
}

function inputsForKey(key: string) {
	const parts = key.split("+");
	const base = parts.pop() ?? "";
	const modifier = parts.reduce(
		(mask, part) => mask | (KEY_MODIFIER_MASKS[part as keyof typeof KEY_MODIFIER_MASKS] ?? 0),
		0,
	);
	const codepoint = KEY_CODEPOINTS[base] ?? (base.length === 1 ? base.charCodeAt(0) : undefined);
	const candidates =
		codepoint === undefined
			? LEGACY_KEY_INPUTS
			: [...LEGACY_KEY_INPUTS, `\u001b[${codepoint};${modifier + 1}u`];
	return candidates.filter((input) => matchesKey(input, key as KeyId));
}

function isExecutableKey(base: string, modifiers: readonly string[]) {
	if (!KEY_BASES.has(base)) return false;
	if (base === "escape" || /^f(?:[1-9]|1[0-2])$/u.test(base)) return modifiers.length === 0;
	if (base === "clear") {
		return (
			modifiers.length === 0 ||
			(modifiers.length === 1 && (modifiers[0] === "shift" || modifiers[0] === "ctrl"))
		);
	}
	return true;
}

const KEY_MODIFIER_MASKS = { shift: 1, alt: 2, ctrl: 4, super: 8 } as const;
const KEY_CODEPOINTS: Record<string, number> = {
	escape: 27,
	tab: 9,
	enter: 13,
	space: 32,
	backspace: 127,
	insert: 57425,
	delete: 57426,
	home: 57423,
	end: 57424,
	pageup: 57421,
	pagedown: 57422,
	left: 57417,
	right: 57418,
	up: 57419,
	down: 57420,
};
const LEGACY_FUNCTION_INPUT_SUFFIXES = [
	"OP",
	"OQ",
	"OR",
	"OS",
	"[15~",
	"[17~",
	"[18~",
	"[19~",
	"[20~",
	"[21~",
	"[23~",
	"[24~",
];
// Probe every cross-identity legacy collision through Pi's live matcher. CSI-u,
// keypad, lock-bit, shifted-letter, and modifyOtherKeys forms normalize to the
// same key and modifiers, so one generated CSI-u identity covers those branches.
const LEGACY_KEY_INPUTS = [
	...Array.from({ length: 128 }, (_, code) => String.fromCharCode(code)),
	...Array.from({ length: 128 }, (_, code) => `\u001b${String.fromCharCode(code)}`),
	"\u001b[Z",
	"\u001bOM",
	"\u001b[E",
	"\u001b[e",
	"\u001bOe",
	...LEGACY_FUNCTION_INPUT_SUFFIXES.map((suffix) => `\u001b${suffix}`),
];
const KEY_BASES = new Set([
	..."abcdefghijklmnopqrstuvwxyz0123456789`-=[]\\;',./!@#$%^&*()_|~{}:<>?",
	"escape",
	"enter",
	"tab",
	"space",
	"backspace",
	"delete",
	"insert",
	"clear",
	"home",
	"end",
	"pageup",
	"pagedown",
	"up",
	"down",
	"left",
	"right",
	...Array.from({ length: 12 }, (_, index) => `f${index + 1}`),
]);

function matchesBinding(keybindings: KeybindingsManager, data: string, binding: string) {
	return (keybindings.matches as (input: string, keybinding: string) => boolean)(data, binding);
}

function getBindingKeys(keybindings: KeybindingsManager, binding: string) {
	return (keybindings.getKeys as (keybinding: string) => readonly string[])(binding);
}

function normalizeViewportSize(value: number | undefined) {
	return Number.isInteger(value) && (value ?? 0) > 0 ? (value as number) : 10;
}

function safe(value: string) {
	return sanitizeTerminalText(value);
}

function normalizePastedInput(value: string) {
	return safe(
		value.replace(/\r\n/gu, "").replace(/\r/gu, "").replace(/\n/gu, "").replace(/\t/gu, "    "),
	);
}

function trailingMarkerPrefixLength(value: string, marker: string) {
	for (let length = Math.min(value.length, marker.length - 1); length > 0; length -= 1) {
		if (value.endsWith(marker.slice(0, length))) return length;
	}
	return 0;
}
