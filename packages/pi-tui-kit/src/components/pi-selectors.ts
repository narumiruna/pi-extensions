import type { KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import {
	fuzzyFilter,
	Input,
	isKittyProtocolActive,
	Key,
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
	const handleSearchInput = (data: string) => {
		input.handleInput(parseKey(data) === undefined ? safe(data) : data);
		refilter();
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
			const content = [
				...searchRows,
				"",
				...visible.map((row, index) => renderRow(row, start + index, selectedIndex, options.theme)),
			];
			const selected = filtered[selectedIndex];
			if (start > 0 || start + visible.length < filtered.length) {
				content.push(options.theme.fg("muted", `  (${selectedIndex + 1}/${filtered.length})`));
			}
			if (filtered.length === 0) {
				content.push(options.theme.fg("muted", "  No matching options"));
			} else if (selected?.description) {
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
) {
	const selected = index === selectedIndex;
	const cursor = selected ? theme.fg("accent", "→ ") : "  ";
	const current = row.current ? theme.fg("accent", "✓ ") : "  ";
	const primary = selected ? theme.fg("accent", safe(row.primary)) : safe(row.primary);
	const secondary = row.secondary ? ` ${theme.fg("muted", safe(row.secondary))}` : "";
	const defaultBadge = row.default ? theme.fg("muted", " · default") : "";
	return `${cursor}${current}${primary}${secondary}${defaultBadge}`;
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
	const claimed = new Set([keyClaimIdentity("ctrl+c")]);
	const claim = (binding: string | undefined) => {
		const available: string[] = [];
		if (!binding) return available;
		for (const key of getBindingKeys(keybindings, binding)) {
			const canonical = canonicalKeyId(key);
			if (!canonical) continue;
			const identity = keyClaimIdentity(canonical);
			if (claimed.has(identity)) continue;
			claimed.add(identity);
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

function keyClaimIdentity(canonical: string): string {
	if (isKittyProtocolActive()) return canonical;
	if (canonical === "ctrl+i") return "tab";
	if (canonical === "ctrl+j" || canonical === "ctrl+m") return "enter";
	if (canonical === "ctrl+[") return "escape";
	if (canonical === "ctrl+_") return "ctrl+-";
	if (canonical === "alt+b") return "alt+left";
	if (canonical === "alt+f") return "alt+right";
	if (canonical === "alt+p") return "alt+up";
	if (canonical === "alt+n") return "alt+down";
	return canonical;
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
