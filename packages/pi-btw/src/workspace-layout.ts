import type { Theme } from "@earendil-works/pi-coding-agent";
import {
  type Component,
  type Focusable,
  HStack,
  isFocusable,
  ScrollView,
  stripTerminalSequences,
  truncateToWidth,
  VStack,
  visibleWidth,
} from "@earendil-works/pi-tui";
import type { BtwLayout } from "./settings.js";

export const MIN_BTW_SPLIT_COLUMNS = 80;
const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

export interface BtwFullscreenLayoutComponent extends Component {
  getFullscreenLayout(): Component;
}

export interface BtwSplitPaneOptions {
  sideComponent: Component;
  sideLayout: Component;
  layout: Exclude<BtwLayout, "fullscreen">;
  mainThreadContext: string;
  mainEditorDraft: string;
  theme: Theme;
  terminalRows(): number;
}

export class BtwSplitPane implements BtwFullscreenLayoutComponent, Focusable {
  private readonly mainPane: MainThreadPane;
  private readonly layoutRoot: HStack;
  private _focused = false;

  constructor(private readonly options: BtwSplitPaneOptions) {
    this.mainPane = new MainThreadPane(
      options.mainThreadContext,
      options.mainEditorDraft,
      options.theme,
      options.terminalRows,
    );
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

  get focused(): boolean {
    return this._focused;
  }

  set focused(value: boolean) {
    this._focused = value;
    if (isFocusable(this.options.sideComponent)) this.options.sideComponent.focused = value;
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

  handleInput(data: string): void {
    this.options.sideComponent.handleInput?.(data);
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
  private readonly document: string;
  private readonly body: Component;
  private readonly root: VStack;

  constructor(
    mainThreadContext: string,
    mainEditorDraft: string,
    private readonly theme: Theme,
    private readonly terminalRows: () => number,
  ) {
    const context = sanitizeTerminalDocument(mainThreadContext).trim() || "(No main-thread messages)";
    const draft = sanitizeTerminalDocument(mainEditorDraft).trim();
    this.document = draft ? `${context}\n\nMain editor draft:\n${draft}` : context;
    this.body = {
      render: (width) => hardWrapTerminalDocument(this.document, width),
      invalidate() {},
    };
    const scroll = new ScrollView(this.body, {
      follow: "end",
      scrollbar: "auto",
      scrollbarTrackStyle: (text) => this.theme.fg("borderMuted", text),
      scrollbarThumbStyle: (text) => this.theme.fg("muted", text),
    });
    this.root = new VStack([
      { component: this.headerComponent(), basis: 1, shrink: 0, minSize: 1 },
      { component: scroll, basis: 0, grow: 1, minSize: 0 },
      { component: this.footerComponent(), basis: 1, shrink: 0, minSize: 1 },
    ]);
  }

  getLayout(): Component {
    return this.root;
  }

  render(width: number): string[] {
    if (width <= 0) return [];
    const safeWidth = Math.max(1, width);
    const rows = Math.max(1, this.terminalRows());
    if (rows === 1) return [renderMainThreadHeader(safeWidth, this.theme)];
    const bodyRows = Math.max(0, rows - 2);
    const body = this.body.render(safeWidth);
    return [
      renderMainThreadHeader(safeWidth, this.theme),
      ...body.slice(Math.max(0, body.length - bodyRows)),
      truncateToWidth(this.theme.fg("muted", "Read-only snapshot · wheel scrolls"), safeWidth),
    ].slice(0, rows);
  }

  private headerComponent(): Component {
    return {
      render: (width) => [renderMainThreadHeader(width, this.theme)],
      invalidate() {},
    };
  }

  private footerComponent(): Component {
    return {
      render: (width) => [truncateToWidth(this.theme.fg("muted", "Read-only snapshot · wheel scrolls"), width)],
      invalidate() {},
    };
  }
}

function renderMainThreadHeader(width: number, theme: Theme): string {
  const safeWidth = Math.max(1, width);
  const title = truncateToWidth("─ main thread · context snapshot ", safeWidth);
  return theme.fg("muted", `${title}${"─".repeat(Math.max(0, safeWidth - visibleWidth(title)))}`);
}

function sanitizeTerminalDocument(value: string): string {
  const stripped = stripTerminalSequences(value).replace(/\r\n?/gu, "\n");
  return [...stripped]
    .filter((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return (
        character === "\n" ||
        character === "\t" ||
        (codePoint > 31 &&
          !(codePoint >= 127 && codePoint <= 159) &&
          codePoint !== 0x061c &&
          codePoint !== 0x200e &&
          codePoint !== 0x200f &&
          !(codePoint >= 0x202a && codePoint <= 0x202e) &&
          !(codePoint >= 0x2066 && codePoint <= 0x2069))
      );
    })
    .join("");
}

function hardWrapTerminalDocument(value: string, width: number): string[] {
  const safeWidth = Math.max(1, Math.floor(width));
  return value.split("\n").flatMap((line) => hardWrapLine(expandTabs(line), safeWidth));
}

function expandTabs(line: string): string {
  let column = 0;
  let result = "";
  for (const { segment } of graphemeSegmenter.segment(line)) {
    if (segment === "\t") {
      const spaces = 4 - (column % 4);
      result += " ".repeat(spaces);
      column += spaces;
    } else {
      result += segment;
      column += visibleWidth(segment);
    }
  }
  return result;
}

function hardWrapLine(line: string, width: number): string[] {
  if (!line) return [""];
  const lines: string[] = [];
  let current = "";
  let currentWidth = 0;
  for (const { segment } of graphemeSegmenter.segment(line)) {
    const segmentWidth = visibleWidth(segment);
    if (segmentWidth > width) {
      if (current) lines.push(current);
      lines.push("?".repeat(width));
      current = "";
      currentWidth = 0;
      continue;
    }
    if (current && currentWidth + segmentWidth > width) {
      lines.push(current);
      current = "";
      currentWidth = 0;
    }
    current += segment;
    currentWidth += segmentWidth;
  }
  if (current || lines.length === 0) lines.push(current);
  return lines;
}

function padLine(line: string, width: number): string {
  const truncated = truncateToWidth(line, width);
  return `${truncated}${" ".repeat(Math.max(0, width - visibleWidth(truncated)))}`;
}
