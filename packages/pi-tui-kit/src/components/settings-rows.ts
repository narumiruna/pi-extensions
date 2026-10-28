import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { MenuSettingItem } from "../types.js";
import type { MenuScreenComponentOptions } from "./contracts.js";
import { safeMenuText } from "./rendering.js";

type SettingRow<ActionId extends string> = { item: MenuSettingItem<ActionId>; label: string };

/** Keep one pointer target per setting; extra selected information is passive context. */
export function renderSettingsRows<ScreenId extends string, ActionId extends string>(
  filteredItems: readonly SettingRow<ActionId>[],
  allItems: readonly SettingRow<ActionId>[],
  selectedIndex: number,
  displayed: ReadonlyMap<string, string>,
  width: number,
  options: MenuScreenComponentOptions<ScreenId, ActionId>,
): { lines: string[]; priorityTailRows: number; viewportStart: number; visibleCount: number } {
  if (allItems.length === 0 || filteredItems.length === 0) {
    return {
      lines: [
        options.theme.fg(
          "dim",
          allItems.length === 0 ? "  No settings available" : "  No matching settings; edit search",
        ),
      ],
      priorityTailRows: 1,
      viewportStart: 0,
      visibleCount: 0,
    };
  }

  const maxVisible = Math.min(filteredItems.length, 10);
  const startIndex = Math.max(
    0,
    Math.min(selectedIndex - Math.floor(maxVisible / 2), filteredItems.length - maxVisible),
  );
  const endIndex = Math.min(startIndex + maxVisible, filteredItems.length);
  const valueFor = (item: MenuSettingItem<ActionId>) => {
    const value = safeMenuText(displayed.get(item.id) ?? item.currentValue);
    return item.disabled ? `(unavailable) ${value}` : value;
  };
  const widestLabel = Math.max(...allItems.map(({ label }) => visibleWidth(label)));
  const widestValue = Math.max(...allItems.map(({ item }) => visibleWidth(valueFor(item))));
  // Reserve up to half the available cells for values. Short values leave more room for labels.
  const available = Math.max(0, width - 4); // Two cells each for cursor and column gap.
  const reservedValue = Math.min(widestValue, Math.ceil(available / 2));
  const labelWidth = width < 6 ? Math.max(0, width - 2) : Math.min(widestLabel, available - reservedValue);
  const valueWidth = width < 6 ? 0 : available - labelWidth;
  const gap = width < 6 ? "" : "  ";
  const ellipsize = (text: string, cells: number) => truncateToWidth(text, cells, cells > 1 ? "…" : "");
  const lines: string[] = [];
  for (let index = startIndex; index < endIndex; index += 1) {
    const candidate = filteredItems[index];
    if (!candidate) continue;
    const { item, label } = candidate;
    const selected = index === selectedIndex;
    const prefix = selected ? options.theme.fg("accent", "→ ") : "  ";
    const boundedLabel = ellipsize(label, labelWidth);
    const labelPadded = boundedLabel + " ".repeat(Math.max(0, labelWidth - visibleWidth(boundedLabel)));
    let labelText = labelPadded;
    let valueText = ellipsize(valueFor(item), valueWidth);
    if (selected) {
      labelText = options.theme.fg("accent", labelText);
      valueText = options.theme.fg("accent", valueText);
    } else if (item.disabled) {
      labelText = options.theme.fg("dim", labelText);
      valueText = options.theme.fg("dim", valueText);
    } else {
      valueText = options.theme.fg("muted", valueText);
    }
    lines.push(truncateToWidth(`${prefix}${labelText}${gap}${valueText}`, width, ""));
  }
  if (startIndex > 0 || endIndex < filteredItems.length) {
    lines.push(options.theme.fg("dim", `  (${selectedIndex + 1}/${filteredItems.length})`));
  }
  let priorityTailRows = 0;
  const selected = filteredItems[selectedIndex];
  if (selected) {
    const value = valueFor(selected.item);
    const details = [
      ...(visibleWidth(selected.label) > labelWidth ? [selected.label] : []),
      ...(visibleWidth(value) > valueWidth ? [`Value: ${value}`] : []),
      ...(selected.item.description ? [safeMenuText(selected.item.description)] : []),
    ];
    if (details.length > 0) lines.push("");
    for (const detail of details) {
      for (const line of wrapTextWithAnsi(detail, Math.max(1, width - 4))) {
        lines.push(options.theme.fg("muted", `  ${line}`));
        priorityTailRows += 1;
      }
    }
  }
  return { lines, priorityTailRows, viewportStart: startIndex, visibleCount: endIndex - startIndex };
}
