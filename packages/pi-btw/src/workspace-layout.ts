import type { Theme } from "@earendil-works/pi-coding-agent";
import {
  type Component,
  type Focusable,
  HStack,
  isFocusable,
  ScrollView,
  truncateToWidth,
  visibleWidth,
} from "@earendil-works/pi-tui";
import { BtwPasteGuard } from "./keybindings.js";
import type { BtwLayout } from "./settings.js";

export const MIN_BTW_SPLIT_COLUMNS = 80;
const PANE_DIVIDER_COLUMNS = 3;
// biome-ignore lint/complexity/useRegexLiterals: the constructor keeps a raw ESC control character out of source.
const SGR_MOUSE_PATTERN = new RegExp("^\\u001b\\[<(\\d+);(\\d+);\\d+[Mm]$");
type BtwActivePane = "side" | "main";

export interface BtwFullscreenLayoutComponent extends Component {
  getFullscreenLayout(): Component;
  getPrimaryScrollView?(): ScrollView;
}

export class BtwMainThreadInput implements Component, Focusable {
  private target: Component | undefined;
  private _focused = false;
  private disposed = false;

  constructor(
    initialTarget: Component | null,
    private readonly resolveTarget: () => Component | null,
    private readonly requestRender: () => void,
  ) {
    this.target = hasInput(initialTarget) ? initialTarget : undefined;
  }

  get focused(): boolean {
    return this._focused;
  }

  set focused(value: boolean) {
    this._focused = value;
    if (this.target && isFocusable(this.target)) this.target.focused = value;
  }

  get wantsKeyRelease(): boolean {
    return this.target?.wantsKeyRelease ?? false;
  }

  render(): string[] {
    return [];
  }

  handleInput(data: string): void {
    if (this.disposed) return;
    this.refreshTarget();
    this.target?.handleInput?.(data);
    this.refreshTarget();
    this.requestRender();
  }

  refreshTarget(): void {
    if (this.disposed) return;
    const next = this.resolveTarget();
    if (!hasInput(next) || next === this.target) return;
    if (this._focused && this.target && isFocusable(this.target)) this.target.focused = false;
    this.target = next;
    if (this._focused && isFocusable(next)) next.focused = true;
  }

  invalidate(): void {}

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this._focused && this.target && isFocusable(this.target)) this.target.focused = false;
    this.target = undefined;
    this._focused = false;
  }
}

export interface BtwSplitPaneOptions {
  sideComponent: Component;
  sideLayout: Component;
  mainThread: Component;
  mainLayout?: Component;
  mainInput: Component;
  sideScrollView?: ScrollView;
  layout: Exclude<BtwLayout, "fullscreen">;
  theme: Theme;
  terminalColumns(): number;
  terminalRows(): number;
  hasFocusedOverlay(): boolean;
  setFocus(component: Component): void;
  setViewportTarget(scrollView: ScrollView | undefined): void;
  requestRender(): void;
}

export class BtwSplitPane implements BtwFullscreenLayoutComponent {
  private readonly pasteGuard = new BtwPasteGuard();
  private readonly mainPane: MainThreadPane;
  private readonly layoutRoot: HStack;
  private readonly viewportRouter: PaneViewportRouter;
  private activePane: BtwActivePane = "side";
  private focusGeneration = 0;
  private disposed = false;

  constructor(private readonly options: BtwSplitPaneOptions) {
    this.mainPane = new MainThreadPane(options.mainThread, options.mainLayout, options.theme, options.terminalRows);
    this.viewportRouter = new PaneViewportRouter(
      options.sideScrollView ?? findPrimaryScrollView(options.sideLayout),
      this.mainPane.getPrimaryScrollView(),
      options.setViewportTarget,
    );
    this.viewportRouter.activate("side");
    const separator: Component = {
      render: (width) =>
        Array.from({ length: Math.max(1, options.terminalRows()) }, () => truncateToWidth(this.renderDivider(), width)),
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

  handleTerminalInput(data: string): boolean {
    if (this.disposed) return false;
    const pasted = this.pasteGuard.consume(data);
    if (this.options.hasFocusedOverlay()) return false;
    const width = this.terminalColumns();
    if (width < MIN_BTW_SPLIT_COLUMNS && this.activePane !== "side") this.activatePane("side");
    if (pasted) {
      this.forwardPastedInput(data);
      return true;
    }
    if (width < MIN_BTW_SPLIT_COLUMNS) return false;
    const pane = paneForMouseClick(data, width, this.options.layout);
    if (pane) this.queuePaneFocus(pane);
    return false;
  }

  render(width: number): string[] {
    if (width <= 0) return [];
    const safeWidth = Math.max(1, width);
    if (safeWidth < MIN_BTW_SPLIT_COLUMNS) {
      return this.options.sideComponent.render(safeWidth).map((line) => truncateToWidth(line, safeWidth));
    }

    const leftWidth = Math.max(1, Math.floor((safeWidth - PANE_DIVIDER_COLUMNS) / 2));
    const rightWidth = Math.max(1, safeWidth - leftWidth - PANE_DIVIDER_COLUMNS);
    const sideWidth = this.options.layout === "left-pane" ? leftWidth : rightWidth;
    const mainWidth = this.options.layout === "left-pane" ? rightWidth : leftWidth;
    const sideLines = this.options.sideComponent.render(sideWidth);
    const mainLines = this.mainPane.render(mainWidth);
    const rows = Math.max(1, this.options.terminalRows());
    const separator = this.renderDivider();
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

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.focusGeneration += 1;
    this.viewportRouter.dispose();
  }

  private renderDivider(): string {
    const leftPane: BtwActivePane = this.options.layout === "left-pane" ? "side" : "main";
    const rightPane: BtwActivePane = leftPane === "side" ? "main" : "side";
    const border = (pane: BtwActivePane) =>
      this.options.theme.fg(pane === this.activePane ? "accent" : "borderMuted", pane === this.activePane ? "┃" : "│");
    return `${border(leftPane)} ${border(rightPane)}`;
  }

  private queuePaneFocus(pane: BtwActivePane): void {
    const generation = ++this.focusGeneration;
    queueMicrotask(() => {
      if (this.disposed || generation !== this.focusGeneration || this.options.hasFocusedOverlay()) return;
      this.activatePane(this.terminalColumns() < MIN_BTW_SPLIT_COLUMNS ? "side" : pane);
    });
  }

  private terminalColumns(): number {
    return Math.max(1, Math.floor(this.options.terminalColumns()));
  }

  private activatePane(pane: BtwActivePane): void {
    if (this.disposed) return;
    this.activePane = pane;
    this.viewportRouter.activate(pane);
    this.options.setFocus(pane === "side" ? this.options.sideComponent : this.options.mainInput);
    this.options.requestRender();
  }

  private forwardPastedInput(data: string): void {
    const target = this.activePane === "side" ? this.options.sideComponent : this.options.mainInput;
    target.handleInput?.(data);
    this.options.requestRender();
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
      {
        component: separator,
        basis: PANE_DIVIDER_COLUMNS,
        grow: 0,
        shrink: 0,
        minSize: PANE_DIVIDER_COLUMNS,
      },
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
    const leftWidth = Math.max(1, Math.floor((safeWidth - PANE_DIVIDER_COLUMNS) / 2));
    const rightWidth = Math.max(1, safeWidth - leftWidth - PANE_DIVIDER_COLUMNS);
    const left = this.entries[0];
    const separator = this.entries[1];
    const right = this.entries[2];
    if (left) left.basis = leftWidth;
    if (separator) separator.basis = PANE_DIVIDER_COLUMNS;
    if (right) right.basis = rightWidth;
  }
}

class MainThreadPane {
  private readonly body: Component;
  private readonly layout: Component;
  private readonly scroll: ScrollView | undefined;

  constructor(
    mainThread: Component,
    mainLayout: Component | undefined,
    theme: Theme,
    private readonly terminalRows: () => number,
  ) {
    this.body = {
      render: (width) => mainThread.render(Math.max(1, width)).map((line) => truncateToWidth(line, Math.max(1, width))),
      invalidate() {},
    };
    if (mainLayout) {
      this.layout = mainLayout;
      this.scroll = findPrimaryScrollView(mainLayout);
      return;
    }
    this.scroll = new ScrollView(this.body, {
      follow: "end",
      scrollbar: "auto",
      scrollbarTrackStyle: (text) => theme.fg("borderMuted", text),
      scrollbarThumbStyle: (text) => theme.fg("muted", text),
    });
    this.layout = this.scroll;
  }

  getLayout(): Component {
    return this.layout;
  }

  getPrimaryScrollView(): ScrollView | undefined {
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

class PaneViewportRouter {
  private readonly originalPrimary = new Map<ScrollView, boolean>();
  private disposed = false;

  constructor(
    private readonly side: ScrollView | undefined,
    private readonly main: ScrollView | undefined,
    private readonly setViewportTarget: (scrollView: ScrollView | undefined) => void,
  ) {
    for (const scrollView of [side, main]) {
      if (scrollView) this.originalPrimary.set(scrollView, scrollView.primary);
    }
  }

  activate(pane: BtwActivePane): void {
    if (this.disposed) return;
    const target = pane === "side" ? this.side : this.main;
    for (const scrollView of this.originalPrimary.keys()) setScrollViewPrimary(scrollView, scrollView === target);
    this.setViewportTarget(target);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const [scrollView, primary] of this.originalPrimary) setScrollViewPrimary(scrollView, primary);
    this.setViewportTarget(undefined);
  }
}

// Pi exposes primary as a constructor-time ScrollView option but has no public
// active-pane viewport router. Preserve and restore this runtime field so Pi's
// native search, prompt navigation, and scrolling keep their standard behavior.
function setScrollViewPrimary(scrollView: ScrollView, primary: boolean): void {
  Reflect.set(scrollView, "primary", primary);
}

function findPrimaryScrollView(root: Component): ScrollView | undefined {
  const visited = new Set<Component>();
  let fallback: ScrollView | undefined;
  let primary: ScrollView | undefined;
  const visit = (component: Component) => {
    if (visited.has(component)) return;
    visited.add(component);
    if (component instanceof ScrollView) {
      fallback ??= component;
      if (component.primary) primary = component;
    }
    if (!("children" in component) || !Array.isArray(component.children)) return;
    for (const child of component.children) visit(child);
  };
  visit(root);
  return primary ?? fallback;
}

function paneForMouseClick(
  data: string,
  terminalColumns: number,
  layout: Exclude<BtwLayout, "fullscreen">,
): BtwActivePane | undefined {
  const match = SGR_MOUSE_PATTERN.exec(data);
  if (!match) return undefined;
  const button = Number.parseInt(match[1] ?? "", 10);
  if ((button & 32) !== 0 || (button & 64) !== 0 || (button & 3) !== 0) return undefined;
  const column = Number.parseInt(match[2] ?? "", 10) - 1;
  if (!Number.isFinite(column) || column < 0 || column >= terminalColumns) return undefined;
  const leftWidth = Math.max(1, Math.floor((terminalColumns - PANE_DIVIDER_COLUMNS) / 2));
  if (column >= leftWidth && column < leftWidth + PANE_DIVIDER_COLUMNS) return undefined;
  const clickedLeft = column < leftWidth;
  if (layout === "left-pane") return clickedLeft ? "side" : "main";
  return clickedLeft ? "main" : "side";
}

function hasInput(component: Component | null): component is Component {
  return component !== null && typeof component.handleInput === "function";
}

function padLine(line: string, width: number): string {
  const truncated = truncateToWidth(line, width);
  return `${truncated}${" ".repeat(Math.max(0, width - visibleWidth(truncated)))}`;
}
