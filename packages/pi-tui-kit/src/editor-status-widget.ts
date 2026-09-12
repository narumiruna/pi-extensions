import type { Theme } from "@earendil-works/pi-coding-agent";
import { type Component, truncateToWidth } from "@earendil-works/pi-tui";
import { HorizontalRule } from "./horizontal-rule.js";

export interface EditorStatusWidgetOptions {
  /** Active callback theme used for the standard muted editor divider. */
  theme: Pick<Theme, "fg">;
  /** Render extension-owned body rows for the normalized terminal width. */
  renderBody(width: number): readonly string[];
}

/** Width-safe presentation frame for passive status widgets near Pi's editor. */
export class EditorStatusWidget implements Component {
  private readonly options: EditorStatusWidgetOptions;
  private readonly rule: HorizontalRule;

  constructor(options: EditorStatusWidgetOptions) {
    this.options = options;
    this.rule = new HorizontalRule({
      ruleStyle: (text) => this.options.theme.fg("borderMuted", text),
    });
  }

  invalidate() {
    this.rule.invalidate();
  }

  render(width: number): string[] {
    const renderWidth = normalizeWidth(width);
    const body = this.options.renderBody(renderWidth);
    return [...this.rule.render(renderWidth), ...body.map((line) => truncateToWidth(line, renderWidth, ""))];
  }
}

function normalizeWidth(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}
