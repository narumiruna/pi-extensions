import type { KeybindingsManager } from "@earendil-works/pi-coding-agent";
import { isKittyProtocolActive, Key, type KeyId, matchesKey, type TUI } from "@earendil-works/pi-tui";
import { sanitizeFirecrawlDisplay } from "./tool-selector.js";

const actions = ["tui.select.up", "tui.select.down", "tui.select.confirm", "tui.select.cancel"] as const;
type Action = (typeof actions)[number];

/** Show the first usable configured key, following the wrapper and SettingsList's input order. */
export function settingsKeyHints(keybindings: Pick<KeybindingsManager, "getKeys" | "matches">, tui: TUI): string {
  const terminal = tui.terminal as typeof tui.terminal & { modifyOtherKeysActive?: boolean };
  const extended = isKittyProtocolActive() || terminal.kittyProtocolActive || terminal.modifyOtherKeysActive === true;
  const actionFor = (input: string): Action | undefined => {
    if (matchesKey(input, Key.ctrl("c"))) return "tui.select.cancel";
    if (keybindings.matches(input, "tui.select.up")) return "tui.select.up";
    if (keybindings.matches(input, "tui.select.down")) return "tui.select.down";
    if (keybindings.matches(input, "tui.select.confirm") || input === " ") return "tui.select.confirm";
    if (keybindings.matches(input, "tui.select.cancel")) return "tui.select.cancel";
    return undefined;
  };
  const usable = (key: string, action: Action) =>
    sanitizeFirecrawlDisplay(key) === key &&
    inputsFor(key, extended).some((input) => matchesKey(input, key as KeyId) && actionFor(input) === action);
  const hint = (action: Action, label: string, extra: string[] = []) => {
    const first = keybindings.getKeys(action).find((key) => usable(key, action));
    const keys = [first, ...extra.filter((key) => usable(key, action))].filter((key): key is string => !!key);
    const displayed = [...new Set(keys.map(displayKey))];
    return displayed.length ? `${displayed.join("/")} ${label}` : "";
  };
  return [
    hint("tui.select.up", "up"),
    hint("tui.select.down", "down"),
    hint("tui.select.confirm", "change", ["space"]),
    hint("tui.select.cancel", "close", ["ctrl+c"]),
    "Changes save immediately.",
  ]
    .filter(Boolean)
    .join(" · ");
}

function displayKey(key: string): string {
  const parts = key.toLowerCase().split("+");
  const base = parts.pop() ?? "";
  const modifiers = [...new Set(parts.filter((part) => ["shift", "ctrl", "alt", "super"].includes(part)))];
  const aliases: Record<string, string> = { up: "↑", down: "↓", escape: "esc", esc: "esc", return: "enter" };
  return [...modifiers, aliases[base] ?? base].join("+");
}

function inputsFor(key: string, extended: boolean): string[] {
  const parts = key.toLowerCase().split("+");
  const base = parts.pop() ?? "";
  const masks: Record<string, number> = { shift: 1, alt: 2, ctrl: 4, super: 8 };
  const modifier = parts.reduce((mask, part) => mask | (masks[part] ?? 0), 0) + 1;
  const codepoint = codepoints[base] ?? (base.length === 1 ? base.charCodeAt(0) : undefined);
  // Ask Pi's live matcher rather than inferring aliases, legacy collisions, or modifier support.
  // CSI-u and modifyOtherKeys are only candidates when the terminal supports disambiguation.
  return extended && codepoint !== undefined
    ? [...legacyInputs, `\x1b[${codepoint};${modifier}u`, `\x1b[27;${modifier};${codepoint}~`]
    : legacyInputs;
}

const codepoints: Record<string, number> = {
  escape: 27,
  esc: 27,
  enter: 13,
  return: 13,
  tab: 9,
  space: 32,
  backspace: 127,
  left: 57417,
  right: 57418,
  up: 57419,
  down: 57420,
  pageup: 57421,
  pagedown: 57422,
  home: 57423,
  end: 57424,
  insert: 57425,
  delete: 57426,
};
// Cover ASCII/Ctrl/Alt legacy identities, arrows, functional keys, and xterm modifiers.
// Lock bits and keypad/shifted identities have the same normalized action as these probes.
const legacyInputs = [
  ...Array.from({ length: 128 }, (_, code) => String.fromCharCode(code)),
  ...Array.from({ length: 128 }, (_, code) => `\x1b${String.fromCharCode(code)}`),
  "\x1b[Z",
  "\x1bOM",
  "\x1b[E",
  "\x1b[e",
  "\x1bOe",
  ...["OP", "OQ", "OR", "OS", "OH", "OF"].map((suffix) => `\x1b${suffix}`),
  ...[1, 2, 3, 4, 5, 6, 7, 8, 15, 17, 18, 19, 20, 21, 23, 24].flatMap((code) => [
    `\x1b[${code}~`,
    ...Array.from({ length: 16 }, (_, modifier) => `\x1b[${code};${modifier + 1}~`),
  ]),
  ...["A", "B", "C", "D", "E", "H", "F"].flatMap((suffix) => [
    `\x1b[${suffix}`,
    `\x1bO${suffix}`,
    ...Array.from({ length: 16 }, (_, modifier) => `\x1b[1;${modifier + 1}${suffix}`),
  ]),
];
