import type { KeyId } from "@earendil-works/pi-tui";

/**
 * Normalize a configured key without repairing invalid or unmatchable bindings.
 * This checks native matcher syntax, not terminal support or dispatch priority.
 * Use Pi's matchesKey() to match input; parseKey() decodes input, not settings.
 */
export function canonicalizeConfiguredKey(value: unknown): KeyId | undefined {
  if (typeof value !== "string") return undefined;
  // Match Pi's prefix grammar. '+' is a base key: 'ctrl++' is valid, 'ctrl+' is not.
  let key = value.toLowerCase();
  const seen = new Set<string>();
  while (true) {
    const modifier = MODIFIERS.find((name) => key.startsWith(`${name}+`));
    if (!modifier) break;
    if (seen.has(modifier)) return undefined;
    seen.add(modifier);
    key = key.slice(modifier.length + 1);
  }
  if (!key || (key.includes("+") && key !== "+")) return undefined;
  const base = key === "esc" ? "escape" : key === "return" ? "enter" : key;
  const modifiers = MODIFIERS.filter((modifier) => seen.has(modifier));
  if (!isExecutableKey(base, modifiers)) return undefined;
  // Pi's matcher is case-insensitive, but its public KeyId uses these spellings.
  const nativeBase = base === "pageup" ? "pageUp" : base === "pagedown" ? "pageDown" : base;
  return [...modifiers, nativeBase].join("+") as KeyId;
}

function isExecutableKey(base: string, modifiers: readonly string[]): boolean {
  if (!KEY_BASES.has(base)) return false;
  if (base === "escape" || /^f(?:[1-9]|1[0-2])$/u.test(base)) return modifiers.length === 0;
  if (base === "clear") {
    return modifiers.length === 0 || (modifiers.length === 1 && (modifiers[0] === "shift" || modifiers[0] === "ctrl"));
  }
  return true;
}

const MODIFIERS = ["shift", "ctrl", "alt", "super"] as const;
const KEY_BASES = new Set([
  ..."abcdefghijklmnopqrstuvwxyz0123456789`-=[]\\;',./!@#$%^&*()_+|~{}:<>?",
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
