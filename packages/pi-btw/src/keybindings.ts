import {
	isKeyRelease,
	isKittyProtocolActive,
	KeybindingsManager,
	type KeyId,
	matchesKey,
	type TUI,
	TUI_KEYBINDINGS,
} from "@earendil-works/pi-tui";
import { formatKeyLabel } from "./text.js";

export const BTW_SHORTCUT_ACTIONS = ["exit", "cycleThinkingLevel", "bringToMain"] as const;
export type BtwShortcutAction = (typeof BTW_SHORTCUT_ACTIONS)[number];
export type BtwKeybindingOverrides = Partial<Record<BtwShortcutAction, string>>;

const MODIFIERS = ["shift", "alt", "ctrl", "super"] as const;
const SYMBOLS = "`-=[]\\;',./!@#$%^&*()_|~{}:<>?";
const SPECIAL: Record<string, number> = {
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
const FUNCTION_INPUTS = [
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
// All cross-identity legacy collisions in Pi's matchesKey(): raw Ctrl bytes,
// ESC-prefixed bytes (including Alt+arrows), BS/DEL, Enter and Shift+Tab.
// CSI-u, keypad, lock bits, shifted letters and modifyOtherKeys normalize to
// the same key+modifiers; probe that identity instead of duplicating the parser.
const LEGACY_INPUTS = [
	...Array.from({ length: 128 }, (_, code) => String.fromCharCode(code)),
	...Array.from({ length: 128 }, (_, code) => `\u001b${String.fromCharCode(code)}`),
	"\u001b[Z",
	"\u001bOM",
	"\u001b[E",
	"\u001b[e",
	"\u001bOe",
	...FUNCTION_INPUTS.map((suffix) => `\u001b${suffix}`),
];

/** Strict settings syntax; Pi itself ignores unknown/duplicate modifier tokens. */
export function normalizeBtwKey(value: unknown): string | undefined {
	if (typeof value !== "string" || value.length > 80 || /[\s\p{Cc}]/u.test(value)) return undefined;
	const parts = value.toLowerCase().split("+");
	let base = parts.pop();
	if (!base) return undefined;
	if (base === "esc") base = "escape";
	if (base === "return") base = "enter";
	if (
		new Set(parts).size !== parts.length ||
		parts.some((part) => !MODIFIERS.includes(part as never))
	)
		return undefined;
	if (
		!Object.hasOwn(SPECIAL, base) &&
		base !== "clear" &&
		!/^f(?:[1-9]|1[0-2])$/u.test(base) &&
		!(base.length === 1 && (/^[a-z0-9]$/u.test(base) || SYMBOLS.includes(base)))
	)
		return undefined;
	if ((base === "escape" || (base.startsWith("f") && base.length > 1)) && parts.length)
		return undefined;
	if (
		base === "clear" &&
		(parts.length > 1 || (parts.length === 1 && !["ctrl", "shift"].includes(parts[0] ?? "")))
	)
		return undefined;
	return [...MODIFIERS.filter((part) => parts.includes(part)), base].join("+");
}

/** Representative inputs are checked by Pi, including its live terminal-mode branches. */
function inputsFor(key: string): string[] {
	const parts = key.split("+");
	const base = parts.pop() ?? "";
	const modifier = MODIFIERS.reduce(
		(mask, part, bit) => mask | (parts.includes(part) ? 1 << bit : 0),
		0,
	);
	const code = SPECIAL[base] ?? (base.length === 1 ? base.charCodeAt(0) : undefined);
	const inputs =
		code === undefined ? LEGACY_INPUTS : [...LEGACY_INPUTS, `\u001b[${code};${modifier + 1}u`];
	return inputs.filter((input) => matchesKey(input, key as KeyId));
}

export function btwKeysOverlap(first: string, second: string): boolean {
	const normalized = normalizeBtwKey(first);
	return (
		normalized !== undefined &&
		inputsFor(normalized).some((input) => matchesKey(input, second as KeyId))
	);
}

export interface BtwShortcuts {
	keys: Record<BtwShortcutAction, readonly string[]>;
	warnings: readonly string[];
	matches(data: string, action: BtwShortcutAction): boolean;
	label(action: BtwShortcutAction): string;
}

function reservedKeys(keybindings: KeybindingsManager, copyOnSelect: boolean): string[] {
	// Editor has no autocomplete provider here. Select bindings are still reserved
	// because exit also applies to BTW-owned nested review/menu components.
	return [
		"ctrl+c",
		"shift+backspace",
		"shift+delete",
		"shift+space",
		// Exact-range review uses these fixed selection actions even if Editor is remapped.
		"shift+left",
		"shift+right",
		"shift+up",
		"shift+down",
		"left",
		"right",
		"enter",
		"alt+enter",
		"ctrl+j",
		"pageUp",
		"pageDown",
		...Object.keys(TUI_KEYBINDINGS).flatMap((id) =>
			keybindings.getKeys(id as keyof typeof TUI_KEYBINDINGS),
		),
		...(!copyOnSelect ? keybindings.getKeys("app.message.copy") : []),
	];
}

function isTextKey(key: string): boolean {
	const parts = key.split("+");
	const base = parts.at(-1) ?? "";
	return (
		(base.length === 1 || base === "space") &&
		!parts.some((part) => ["ctrl", "alt", "super"].includes(part))
	);
}

export function resolveBtwShortcuts(
	overrides: BtwKeybindingOverrides = {},
	keybindings: KeybindingsManager,
	copyOnSelect = true,
): BtwShortcuts {
	let mode = isKittyProtocolActive();
	let snapshot = resolveShortcutSnapshot(overrides, keybindings, copyOnSelect);
	const current = () => {
		if (mode !== isKittyProtocolActive()) {
			mode = isKittyProtocolActive();
			snapshot = resolveShortcutSnapshot(overrides, keybindings, copyOnSelect);
		}
		return snapshot;
	};
	// ProcessTerminal negotiates Kitty asynchronously after the dedicated TUI starts.
	// Hints and matching must use the same policy after that mode transition.
	return {
		get keys() {
			return current().keys;
		},
		get warnings() {
			return current().warnings;
		},
		matches: (data, action) => current().matches(data, action),
		label: (action) => current().label(action),
	};
}

function resolveShortcutSnapshot(
	overrides: BtwKeybindingOverrides = {},
	keybindings: KeybindingsManager,
	copyOnSelect = true,
): BtwShortcuts {
	const reserved = reservedKeys(keybindings, copyOnSelect);
	const keys: BtwShortcuts["keys"] = { exit: ["ctrl+c"], cycleThinkingLevel: [], bringToMain: [] };
	const warnings: string[] = [];
	const defaults: Record<BtwShortcutAction, readonly string[]> = {
		exit: ["ctrl+c"],
		cycleThinkingLevel: keybindings.getKeys("app.thinking.cycle"),
		bringToMain: ["ctrl+r"],
	};
	const usable = (
		action: BtwShortcutAction,
		candidate: string,
		inherited = false,
	): string | undefined => {
		const key = normalizeBtwKey(candidate);
		if (!key || (!inherited && isTextKey(key))) return undefined;
		const inputs = inputsFor(key);
		if (!inputs.length) return undefined;
		if (action === "exit" && key === "ctrl+c") return key;
		if (
			reserved.some(
				(other) =>
					typeof other === "string" && inputs.some((input) => matchesKey(input, other as KeyId)),
			)
		)
			return undefined;
		return key;
	};
	const candidates: BtwKeybindingOverrides = {};
	const availableDefaults = { ...defaults };
	for (const action of BTW_SHORTCUT_ACTIONS) {
		availableDefaults[action] = defaults[action]
			.map((key) => usable(action, key, action === "cycleThinkingLevel"))
			.filter((key): key is string => key !== undefined);
		const override = overrides[action];
		if (override !== undefined) candidates[action] = usable(action, override);
	}
	// Compare the complete proposal, not only actions visited earlier. Reject conflicts
	// together, then repeat because a rejected override restores its default bindings.
	for (;;) {
		const rejected = BTW_SHORTCUT_ACTIONS.filter((action) => {
			const candidate = candidates[action];
			return (
				candidate !== undefined &&
				BTW_SHORTCUT_ACTIONS.some(
					(other) =>
						other !== action &&
						(candidates[other] ? [candidates[other]] : availableDefaults[other]).some((key) =>
							btwKeysOverlap(candidate, key),
						),
				)
			);
		});
		if (!rejected.length) break;
		for (const action of rejected) delete candidates[action];
	}
	for (const action of BTW_SHORTCUT_ACTIONS) {
		const override = overrides[action];
		const selected = candidates[action];
		if (override !== undefined && !selected)
			warnings.push(
				`${action}: configured shortcut is invalid or conflicts with a reserved action; using an available default.`,
			);
		const effective = selected
			? [selected]
			: availableDefaults[action].filter(
					(key) =>
						!BTW_SHORTCUT_ACTIONS.some(
							(other) => other !== action && keys[other].some((used) => btwKeysOverlap(key, used)),
						),
				);
		keys[action] = action === "exit" ? [...new Set([...effective, "ctrl+c"])] : effective;
		if (!keys[action].length && (override !== undefined || defaults[action].length > 0))
			warnings.push(`${action}: no usable shortcut; change Pi BTW Settings or Pi keybindings.`);
	}
	return {
		keys,
		warnings,
		matches: (data, action) =>
			!isKeyRelease(data) && keys[action].some((key) => matchesKey(data, key as KeyId)),
		label: (action) =>
			keys[action].length ? formatKeyLabel(keys[action][0] ?? "") : "Unavailable",
	};
}

export function validateBtwShortcutEdit(
	action: BtwShortcutAction,
	value: string | undefined,
	overrides: BtwKeybindingOverrides,
	keybindings: KeybindingsManager,
	copyOnSelect: boolean,
): string | undefined {
	// Reset must remain available even when several existing overrides conflict.
	if (value === undefined) return undefined;
	if (!normalizeBtwKey(value))
		return "Invalid key combination. Use a Pi key name such as ctrl+q or f6.";
	const next = { ...overrides, [action]: value };
	const resolved = resolveBtwShortcuts(next, keybindings, copyOnSelect);
	const previous = resolveBtwShortcuts(overrides, keybindings, copyOnSelect);
	// Reject edits that disable another binding as well as the edited binding.
	for (const item of BTW_SHORTCUT_ACTIONS) {
		if (
			(item === action && !resolved.keys[item].includes(normalizeBtwKey(value) ?? "")) ||
			(item !== action && previous.keys[item].some((key) => !resolved.keys[item].includes(key)))
		) {
			return `${item} conflicts with another BTW shortcut, editing, selection, search, scrolling, or copying. Choose a different key.`;
		}
	}
	return undefined;
}

const bindingsByTui = new WeakMap<TUI, BtwShortcuts>();
export function setBtwShortcuts(tui: TUI, shortcuts: BtwShortcuts): void {
	bindingsByTui.set(tui, shortcuts);
}
export function getBtwShortcuts(tui: TUI, keybindings?: KeybindingsManager): BtwShortcuts {
	return (
		bindingsByTui.get(tui) ??
		resolveBtwShortcuts(
			{},
			keybindings ??
				new KeybindingsManager({
					...TUI_KEYBINDINGS,
					"app.thinking.cycle": { defaultKeys: "shift+tab" },
				}),
		)
	);
}

/** Keep split bracketed-paste payloads away from screen-level shortcuts. */
export class BtwPasteGuard {
	private active = false;
	consume(data: string): boolean {
		const wasActive = this.active;
		const starts = data.includes("\u001b[200~");
		if (starts) this.active = true;
		if (this.active && data.includes("\u001b[201~")) this.active = false;
		return wasActive || starts;
	}
}
