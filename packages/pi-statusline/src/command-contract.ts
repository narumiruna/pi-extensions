import type { AutocompleteItem } from "@earendil-works/pi-tui";

export const STATUSLINE_SUBCOMMANDS: readonly AutocompleteItem[] = [
  { value: "settings", label: "settings", description: "Edit pi-statusline.json" },
  { value: "status", label: "status", description: "Show effective statusline settings" },
  { value: "help", label: "help", description: "Show configuration help" },
];

export function completeStatuslineArguments(prefix: string): AutocompleteItem[] | null {
  const normalized = prefix.trim().toLowerCase();
  const matches = STATUSLINE_SUBCOMMANDS.filter((item) => item.value.startsWith(normalized));
  return matches.length > 0 ? [...matches] : null;
}
