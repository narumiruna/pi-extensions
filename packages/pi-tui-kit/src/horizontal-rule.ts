import { type Component, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { sanitizeTerminalText } from "./terminal-text.js";

export type HorizontalRuleLabelAlignment = "left" | "center" | "right";

export interface HorizontalRuleOptions {
  /** Optional text rendered within the rule. */
  label?: string;
  /** Label position within the rule. */
  labelAlignment?: HorizontalRuleLabelAlignment;
  /** Blank cells on both sides of the rule. */
  paddingX?: number;
  /** Render-time styling callback for rule segments. */
  ruleStyle?: (text: string) => string;
  /** Render-time styling callback for the label. */
  labelStyle?: (text: string) => string;
}

/** Width-safe horizontal divider with optional inset and label. */
export class HorizontalRule implements Component {
  private readonly options: HorizontalRuleOptions;

  constructor(options: HorizontalRuleOptions = {}) {
    this.options = options;
  }

  invalidate() {}

  render(width: number): string[] {
    const renderWidth = normalizeSize(width);
    if (renderWidth === 0) return [""];

    const requestedPadding = normalizeSize(this.options.paddingX ?? 0);
    const padding = Math.min(requestedPadding, Math.floor((renderWidth - 1) / 2));
    const innerWidth = renderWidth - padding * 2;
    const label = sanitizeTerminalText(this.options.label ?? "").trim();
    const inner = label ? this.renderLabeledRule(label, innerWidth) : this.rule(innerWidth);
    return [fitToWidth(`${" ".repeat(padding)}${inner}${" ".repeat(padding)}`, renderWidth)];
  }

  private renderLabeledRule(label: string, width: number): string {
    if (width <= 2) return this.label(truncateToWidth(label, width, ""));

    const fittedLabel = truncateToWidth(label, width - 2, width > 3 ? "…" : "");
    const labelWidth = visibleWidth(fittedLabel);
    const ruleWidth = Math.max(0, width - labelWidth - 2);
    const [leftWidth, rightWidth] = distributeRule(ruleWidth, this.options.labelAlignment ?? "center");
    return `${this.rule(leftWidth)} ${this.label(fittedLabel)} ${this.rule(rightWidth)}`;
  }

  private rule(width: number): string {
    return (this.options.ruleStyle ?? identity)("─".repeat(width));
  }

  private label(text: string): string {
    return (this.options.labelStyle ?? identity)(text);
  }
}

function distributeRule(width: number, alignment: HorizontalRuleLabelAlignment): [left: number, right: number] {
  if (alignment === "left") return [Math.min(1, width), Math.max(0, width - 1)];
  if (alignment === "right") return [Math.max(0, width - 1), Math.min(1, width)];
  const left = Math.floor(width / 2);
  return [left, width - left];
}

function fitToWidth(value: string, width: number): string {
  const fitted = truncateToWidth(value, width, "");
  return fitted + " ".repeat(Math.max(0, width - visibleWidth(fitted)));
}

function normalizeSize(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

function identity(text: string): string {
  return text;
}
