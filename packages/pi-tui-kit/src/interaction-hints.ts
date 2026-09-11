import { safeMenuText } from "./text.js";

export interface InteractionKeybindings<Binding extends string = string> {
  getKeys(binding: Binding): readonly string[];
}

export interface InteractionHint<Binding extends string = string> {
  bindings?: readonly Binding[];
  keys?: readonly string[];
  excludeKeys?: readonly string[];
  label: string;
}

export interface FormatInteractionHintsOptions {
  separator?: string;
}

/** Format width-neutral interaction hints from Pi keybindings and literal shortcut keys. */
export function formatInteractionHints<Binding extends string>(
  keybindings: InteractionKeybindings<Binding>,
  hints: readonly InteractionHint<Binding>[],
  options: FormatInteractionHintsOptions = {},
): string {
  const separator = safeMenuText(options.separator ?? "•") || "•";
  return hints
    .map((hint) => formatHint(keybindings, hint))
    .filter(Boolean)
    .join(` ${separator} `);
}

function formatHint<Binding extends string>(
  keybindings: InteractionKeybindings<Binding>,
  hint: InteractionHint<Binding>,
): string {
  const excluded = new Set((hint.excludeKeys ?? []).map(normalizeKey).filter(Boolean));
  const keys = [...(hint.bindings ?? []).flatMap((binding) => keybindings.getKeys(binding)), ...(hint.keys ?? [])]
    .map(normalizeKey)
    .filter((key) => key && !excluded.has(key));
  const uniqueKeys = [...new Set(keys)];
  const label = safeMenuText(hint.label);
  return uniqueKeys.length > 0 && label ? `${uniqueKeys.join("/")} ${label}` : "";
}

function normalizeKey(value: string): string {
  const key = safeMenuText(value).toLowerCase();
  if (key === "up") return "↑";
  if (key === "down") return "↓";
  if (key === "return") return "enter";
  if (key === "escape") return "esc";
  return key;
}
