import type { Theme } from "@earendil-works/pi-coding-agent";
import { Loader, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { BtwThinkingLevel } from "./side-thread.js";
import { sanitizeSingleLine } from "./text.js";

/** Display-only identity, not a model/session runtime or a source of request options. */
export interface BtwDisplayModel {
  id: string;
  provider: string;
}

export interface BtwWorkspaceFocus {
  pane: "side" | "main";
  shortcutLabel: string | undefined;
}

// Pi's status classes are not root exports. Use the public Loader extension
// points to supply the same border text without importing app-owned handlers.
export class BtwWorkingIndicator extends Loader {
  renderInBorder(width: number): string {
    const line = super.render(width + 2)[1] ?? "";
    return truncateToWidth(line.startsWith(" ") ? line.slice(1).trimEnd() : line.trimEnd(), width, "");
  }

  renderSpinnerInBorder(width: number): string {
    return truncateToWidth(this.getRenderedIndicator(), width, "");
  }
}

/** Native CustomEditor's border geometry, through public Editor/Loader hooks. */
export function renderWorkingBorder(
  width: number,
  hiddenLineCount: number,
  borderColor: (text: string) => string,
  status: BtwWorkingIndicator,
): string | undefined {
  if (width <= 0) return "";
  let label = status.renderInBorder(Math.max(1, width - 5));
  let labelWidth = visibleWidth(label);
  if (labelWidth === 0) return undefined;
  const overflow = hiddenLineCount > 0 ? ` ↑ ${hiddenLineCount} more ` : undefined;
  const overflowWidth = overflow ? visibleWidth(overflow) : 0;
  const overflowStart = Math.floor((width - overflowWidth) / 2);
  const fitsOverflow = () =>
    overflow !== undefined && overflowWidth + 2 <= width && overflowStart - (3 + labelWidth + 1) >= 1;
  if (overflow && !fitsOverflow()) {
    label = status.renderSpinnerInBorder(width);
    labelWidth = visibleWidth(label);
  }
  if (fitsOverflow()) {
    const leftWidth = 3 + labelWidth + 1;
    return (
      borderColor("── ") +
      label +
      borderColor(
        ` ${"─".repeat(overflowStart - leftWidth)}${overflow}${"─".repeat(width - overflowStart - overflowWidth)}`,
      )
    );
  }
  if (width >= labelWidth + 5) {
    return borderColor("── ") + label + borderColor(` ${"─".repeat(width - labelWidth - 4)}`);
  }
  label = status.renderSpinnerInBorder(width);
  labelWidth = visibleWidth(label);
  const prefix = Math.min(3, Math.max(0, width - labelWidth));
  return borderColor("─".repeat(prefix)) + label + borderColor("─".repeat(Math.max(0, width - prefix - labelWidth)));
}

export function renderConversationFooter(
  width: number,
  theme: Theme,
  options: {
    model?: BtwDisplayModel;
    thinkingLevel?: BtwThinkingLevel;
    focus?: BtwWorkspaceFocus;
    hint: string;
    warning?: boolean;
  },
): string[] {
  if (width < 3) return [];
  const focus = options.focus ? `${options.focus.pane === "side" ? "BTW" : "Main"} focus` : undefined;
  const left = focus && visibleWidth(`btw · ${focus}`) <= width ? `btw · ${focus}` : "btw";
  const model = options.model ? sanitizeSingleLine(`${options.model.provider}/${options.model.id}`) : "";
  const thinking = options.thinkingLevel ? `thinking ${options.thinkingLevel}` : "";
  const right = [[model, thinking].filter(Boolean).join(" • "), thinking, model].find(
    (value) => value && visibleWidth(left) + 2 + visibleWidth(value) <= width,
  );
  const identity = right ? `${left}${" ".repeat(width - visibleWidth(left) - visibleWidth(right))}${right}` : left;
  return [
    theme.fg("dim", identity),
    ...(options.hint ? [theme.fg(options.warning ? "warning" : "muted", options.hint)] : []),
  ];
}
