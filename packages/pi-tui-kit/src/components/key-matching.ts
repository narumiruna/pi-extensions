import { isKittyProtocolActive, type KeyId, matchesKey, type TUI } from "@earendil-works/pi-tui";

import { canonicalizeConfiguredKey } from "../key-matching.js";

/** Internal protocol probes use lowercase lookup keys, not public KeyId spelling. */
export function canonicalKeyId(value: string): string | undefined {
  return canonicalizeConfiguredKey(value)?.toLowerCase();
}

export function usesDisambiguatedKeyProtocol(tui: { terminal: { readonly rows: number } }) {
  const terminal = tui.terminal as Partial<TUI["terminal"]> & { readonly modifyOtherKeysActive?: boolean };
  return isKittyProtocolActive() || terminal.kittyProtocolActive === true || terminal.modifyOtherKeysActive === true;
}

export function keysOverlap(first: string, second: string, disambiguatedKeyProtocol: boolean) {
  if (first === second) return true;
  // Enhanced protocols also have multiple matching identities. Let Pi decide
  // physical/logical shifted symbols and base-layout fallback, in both directions.
  const candidates = [...protocolInputs(first, second), ...protocolInputs(second, first)];
  if (candidates.some((input) => matchesKey(input, first as KeyId) && matchesKey(input, second as KeyId))) return true;
  return !disambiguatedKeyProtocol && inputsForKey(first).some((input) => matchesKey(input, second as KeyId));
}

function keyIdentity(key: string) {
  const parts = key === "+" ? [] : key.endsWith("++") ? key.slice(0, -2).split("+") : key.split("+");
  const base = key.endsWith("+") ? "+" : (parts.pop() ?? "");
  const modifier = parts.reduce(
    (mask, part) => mask | (KEY_MODIFIER_MASKS[part as keyof typeof KEY_MODIFIER_MASKS] ?? 0),
    0,
  );
  return { codepoint: KEY_CODEPOINTS[base] ?? (base.length === 1 ? base.charCodeAt(0) : undefined), modifier };
}

function protocolInputs(key: string, other: string) {
  const { codepoint, modifier } = keyIdentity(key);
  const alternate = keyIdentity(other).codepoint;
  if (codepoint === undefined || alternate === undefined) return [];
  return [
    // Alternate key fields describe printable keys, not functional keys.
    // Inventing them for Ctrl+Up would incorrectly reserve every Ctrl binding.
    ...(codepoint >= 33 && codepoint <= 126 && alternate >= 33 && alternate <= 126
      ? [`\u001b[${codepoint}:${alternate};${modifier + 1}u`, `\u001b[${codepoint}::${alternate};${modifier + 1}u`]
      : []),
    `\u001b[27;${modifier + 1};${codepoint}~`,
  ];
}

function inputsForKey(key: string) {
  const cacheKey = `${isKittyProtocolActive()}:${isLocalWindowsTerminalSession() ? "windows" : "other"}:${key}`;
  const cached = LEGACY_KEY_INPUT_CACHE.get(cacheKey);
  if (cached) return cached;
  const { codepoint, modifier } = keyIdentity(key);
  const candidates =
    codepoint === undefined ? LEGACY_KEY_INPUTS : [...LEGACY_KEY_INPUTS, `\u001b[${codepoint};${modifier + 1}u`];
  const inputs = candidates.filter((input) => matchesKey(input, key as KeyId));
  LEGACY_KEY_INPUT_CACHE.set(cacheKey, inputs);
  return inputs;
}

function isLocalWindowsTerminalSession() {
  return (
    Boolean(process.env.WT_SESSION) && !process.env.SSH_CONNECTION && !process.env.SSH_CLIENT && !process.env.SSH_TTY
  );
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
// Probe raw legacy collisions separately from enhanced protocol identities.
// Keypad, lock-bit, event-type, and shifted-letter variants preserve these
// identities; shifted symbols and base-layout alternatives are probed above.
const LEGACY_KEY_INPUT_CACHE = new Map<string, readonly string[]>();
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
