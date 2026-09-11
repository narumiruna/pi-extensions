import type { AutocompleteItem } from "@earendil-works/pi-tui";

export const STARSHIP_SUBCOMMANDS: readonly AutocompleteItem[] = [
  { value: "settings", label: "settings", description: "Customize the footer TOML" },
  { value: "status", label: "status", description: "Show configuration health and source" },
  { value: "help", label: "help", description: "Show configuration help" },
];

export function completeStarshipArguments(prefix: string): AutocompleteItem[] | null {
  const normalized = prefix.trim().toLowerCase();
  const matches = STARSHIP_SUBCOMMANDS.filter((item) => item.value.startsWith(normalized));
  return matches.length > 0 ? [...matches] : null;
}
