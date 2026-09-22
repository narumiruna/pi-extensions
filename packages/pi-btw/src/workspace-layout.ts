import type { Theme } from "@earendil-works/pi-coding-agent";
import { type Component, HStack, ScrollView, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { BtwLayout } from "./settings.js";

export const MIN_BTW_SPLIT_COLUMNS = 80;

export interface BtwFullscreenLayoutComponent extends Component {
  getFullscreenLayout(): Component;
}

export interface BtwSplitPaneOptions {
  sideComponent: Component;
  sideLayout: Component;
  mainThread: Component;
  layout: Exclude<BtwLayout, "fullscreen">;
  theme: Theme;
  terminalRows(): number;
}

export class BtwSplitPane implements BtwFullscreenLayoutComponent {
  private readonly mainPane: MainThreadPane;
  private readonly layoutRoot: HStack;

  constructor(private readonly options: BtwSplitPaneOptions) {
    this.mainPane = new MainThreadPane(options.mainThread, options.theme, options.terminalRows);
    const separator: Component = {
      render: (width) =>
        Array.from({ length: Math.max(1, options.terminalRows()) }, () =>
          truncateToWidth(options.theme.fg("borderMuted", "│"), width),
        ),
      invalidate() {},
    };
    const side = options.sideLayout;
    const main = this.mainPane.getLayout();
    this.layoutRoot =
      options.layout === "left-pane"
        ? new ResponsivePaneRow(side, separator, main, 0)
        : new ResponsivePaneRow(main, separator, side, 2);
  }

  getFullscreenLayout(): Component {
    return this.layoutRoot;
  }

  render(width: number): string[] {
    if (width <= 0) return [];
    const safeWidth = Math.max(1, width);
    if (safeWidth < MIN_BTW_SPLIT_COLUMNS) {
      return this.options.sideComponent.render(safeWidth).map((line) => truncateToWidth(line, safeWidth));
    }

    const separatorWidth = 1;
    const leftWidth = Math.max(1, Math.floor((safeWidth - separatorWidth) / 2));
    const rightWidth = Math.max(1, safeWidth - leftWidth - separatorWidth);
    const sideWidth = this.options.layout === "left-pane" ? leftWidth : rightWidth;
    const mainWidth = this.options.layout === "left-pane" ? rightWidth : leftWidth;
    const sideLines = this.options.sideComponent.render(sideWidth);
    const mainLines = this.mainPane.render(mainWidth);
    const rows = Math.max(1, this.options.terminalRows());
    const separator = this.options.theme.fg("borderMuted", "│");
    const lines: string[] = [];
    for (let index = 0; index < rows; index += 1) {
      const sideLine = padLine(sideLines[index] ?? "", sideWidth);
      const mainLine = padLine(mainLines[index] ?? "", mainWidth);
      lines.push(
        this.options.layout === "left-pane"
          ? `${sideLine}${separator}${mainLine}`
          : `${mainLine}${separator}${sideLine}`,
      );
    }
    return lines.map((line) => truncateToWidth(line, safeWidth));
  }

  invalidate(): void {
    this.layoutRoot.invalidate();
  }
}

// HStack has no percentage basis, so refresh exact half-width bases from its
// viewport callback before each layout pass and let the side pane fill narrow views.
class ResponsivePaneRow extends HStack {
  constructor(
    left: Component,
    separator: Component,
    right: Component,
    private readonly sideIndex: 0 | 2,
  ) {
    super([
      { component: left, basis: 1, grow: 0, shrink: 0, minSize: 1 },
      { component: separator, basis: 1, grow: 0, shrink: 0, minSize: 1 },
      { component: right, basis: 1, grow: 0, shrink: 0, minSize: 1 },
    ]);
    for (const [index, entry] of this.entries.entries()) {
      entry.visible = (viewport) => {
        if (index === 0) this.resize(viewport.width);
        return index === this.sideIndex || viewport.width >= MIN_BTW_SPLIT_COLUMNS;
      };
    }
  }

  private resize(width: number): void {
    const safeWidth = Math.max(1, Math.floor(width));
    if (safeWidth < MIN_BTW_SPLIT_COLUMNS) {
      for (const [index, entry] of this.entries.entries()) {
        entry.basis = index === this.sideIndex ? safeWidth : 1;
      }
      return;
    }
    const leftWidth = Math.max(1, Math.floor((safeWidth - 1) / 2));
    const rightWidth = Math.max(1, safeWidth - leftWidth - 1);
    const left = this.entries[0];
    const separator = this.entries[1];
    const right = this.entries[2];
    if (left) left.basis = leftWidth;
    if (separator) separator.basis = 1;
    if (right) right.basis = rightWidth;
  }
}

class MainThreadPane {
  private readonly body: Component;
  private readonly scroll: ScrollView;

  constructor(
    mainThread: Component,
    theme: Theme,
    private readonly terminalRows: () => number,
  ) {
    this.body = {
      render: (width) => mainThread.render(Math.max(1, width)).map((line) => truncateToWidth(line, Math.max(1, width))),
      invalidate() {},
    };
    this.scroll = new ScrollView(this.body, {
      follow: "end",
      scrollbar: "auto",
      scrollbarTrackStyle: (text) => theme.fg("borderMuted", text),
      scrollbarThumbStyle: (text) => theme.fg("muted", text),
    });
  }

  getLayout(): Component {
    return this.scroll;
  }

  render(width: number): string[] {
    if (width <= 0) return [];
    const safeWidth = Math.max(1, width);
    const rows = Math.max(1, this.terminalRows());
    const visible = this.body.render(safeWidth).slice(-rows);
    return [...Array.from({ length: Math.max(0, rows - visible.length) }, () => ""), ...visible];
  }
}

function padLine(line: string, width: number): string {
  const truncated = truncateToWidth(line, width);
  return `${truncated}${" ".repeat(Math.max(0, width - visibleWidth(truncated)))}`;
}
