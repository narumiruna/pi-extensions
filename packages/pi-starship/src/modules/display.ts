import type { ModuleDisplayConfig } from "./types.js";

export function resolveDisplayStyle(
  display: readonly ModuleDisplayConfig[],
  value: number | null | undefined,
): string | undefined {
  if (value === null || value === undefined || !Number.isFinite(value)) return undefined;
  let selected: ModuleDisplayConfig | undefined;
  for (const entry of display) {
    if (entry.threshold > value) continue;
    if (!selected || entry.threshold >= selected.threshold) selected = entry;
  }
  return selected && !selected.hidden ? selected.style : undefined;
}
