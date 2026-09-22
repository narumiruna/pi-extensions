import type { Theme } from "@earendil-works/pi-coding-agent";
import {
  type Component,
  type Focusable,
  HStack,
  isFocusable,
  ScrollView,
  type TuiMouseEvent,
  type TuiMouseEventResult,
  truncateToWidth,
  visibleWidth,
} from "@earendil-works/pi-tui";
import { BtwPasteGuard } from "./keybindings.js";
import {
  type BtwLayout,
  DEFAULT_BTW_SIDE_PANE_RATIO,
  MAX_BTW_SIDE_PANE_RATIO,
  MIN_BTW_SIDE_PANE_RATIO,
} from "./settings.js";

export const MIN_BTW_SPLIT_COLUMNS = 80;
const PANE_DIVIDER_COLUMNS = 1;
// biome-ignore lint/complexity/useRegexLiterals: the constructor keeps a raw ESC control character out of source.
const SGR_MOUSE_PRESS_PATTERN = new RegExp("^\\u001b\\[<(\\d+);(\\d+);\\d+M$");
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
  sidePaneRatio?: number;
  persistSidePaneRatio?(ratio: number): Promise<void>;
}

export class BtwSplitPane implements BtwFullscreenLayoutComponent {
  private readonly pasteGuard = new BtwPasteGuard();
  private readonly mainPane: MainThreadPane;
  private readonly layoutRoot: HStack;
  private readonly viewportRouter: PaneViewportRouter;
  private activePane: BtwActivePane = "side";
  private sidePaneRatio: number;
  private persistedSidePaneRatio: number;
  private dividerDragStartRatio: number | undefined;
  private focusGeneration = 0;
  private ratioSaveGeneration = 0;
  private confirmedRatioSaveGeneration = 0;
  private failedRatioSaveGenerationDuringDrag: number | undefined;
  private disposed = false;

  constructor(private readonly options: BtwSplitPaneOptions) {
    this.sidePaneRatio = clampSidePaneRatio(options.sidePaneRatio ?? DEFAULT_BTW_SIDE_PANE_RATIO);
    this.persistedSidePaneRatio = this.sidePaneRatio;
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
      handleMouse: (event) => this.handleDividerMouse(event),
      invalidate() {},
    };
    const side = options.sideLayout;
    const main = this.mainPane.getLayout();
    this.layoutRoot =
      options.layout === "left-pane"
        ? new ResponsivePaneRow(
            side,
            separator,
            main,
            0,
            () => this.sidePaneRatio,
            (width) => this.handleViewportWidth(width),
          )
        : new ResponsivePaneRow(
            main,
            separator,
            side,
            2,
            () => this.sidePaneRatio,
            (width) => this.handleViewportWidth(width),
          );
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
    const pane = paneForMouseClick(data, width, this.options.layout, this.sidePaneRatio);
    if (pane) this.queuePaneFocus(pane);
    return false;
  }

  render(width: number): string[] {
    if (width <= 0) return [];
    const safeWidth = Math.max(1, width);
    this.handleViewportWidth(safeWidth);
    if (safeWidth < MIN_BTW_SPLIT_COLUMNS) {
      return this.options.sideComponent.render(safeWidth).map((line) => truncateToWidth(line, safeWidth));
    }

    const { sideWidth, mainWidth } = paneWidths(safeWidth, this.options.layout, this.sidePaneRatio);
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
    this.dividerDragStartRatio = undefined;
    this.failedRatioSaveGenerationDuringDrag = undefined;
    this.viewportRouter.dispose();
  }

  private renderDivider(): string {
    return this.options.theme.fg("borderMuted", "│");
  }

  private handleDividerMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    if (this.disposed) return undefined;
    if (this.options.hasFocusedOverlay()) {
      return { handled: true, render: this.cancelDividerDrag() };
    }
    if (event.type === "press" && event.button === "left") {
      if (this.terminalColumns() < MIN_BTW_SPLIT_COLUMNS) return undefined;
      this.focusGeneration += 1;
      this.dividerDragStartRatio = this.sidePaneRatio;
      return { handled: true, capture: true, render: false };
    }
    if (this.dividerDragStartRatio === undefined) return undefined;
    if (event.type === "drag") {
      const changed = this.updateSidePaneRatio(event.screenX);
      return { handled: true, render: changed };
    }
    if (event.type === "release") {
      const changed = this.updateSidePaneRatio(event.screenX);
      const startRatio = this.dividerDragStartRatio;
      const failedDuringDrag = this.failedRatioSaveGenerationDuringDrag === this.ratioSaveGeneration;
      this.dividerDragStartRatio = undefined;
      this.failedRatioSaveGenerationDuringDrag = undefined;
      if (failedDuringDrag && this.sidePaneRatio === this.persistedSidePaneRatio) {
        return { handled: true, render: changed };
      }
      if (this.sidePaneRatio !== startRatio) {
        this.persistCurrentSidePaneRatio();
        return { handled: true, render: changed };
      }
      const restored = failedDuringDrag && this.restorePersistedSidePaneRatio();
      return { handled: true, render: changed || restored };
    }
    return { handled: true, render: false };
  }

  private updateSidePaneRatio(dividerColumn: number): boolean {
    const width = this.terminalColumns();
    if (width < MIN_BTW_SPLIT_COLUMNS) return false;
    const contentWidth = width - PANE_DIVIDER_COLUMNS;
    const leftWidth = clamp(Math.floor(dividerColumn), 1, contentWidth - 1);
    const sideWidth = this.options.layout === "left-pane" ? leftWidth : contentWidth - leftWidth;
    const ratio = clampSidePaneRatio(roundPaneRatio(sideWidth / contentWidth));
    if (ratio === this.sidePaneRatio) return false;
    this.sidePaneRatio = ratio;
    return true;
  }

  private cancelDividerDrag(): boolean {
    const startRatio = this.dividerDragStartRatio;
    if (startRatio === undefined) return false;
    const failedDuringDrag = this.failedRatioSaveGenerationDuringDrag === this.ratioSaveGeneration;
    this.dividerDragStartRatio = undefined;
    this.failedRatioSaveGenerationDuringDrag = undefined;
    return this.setSidePaneRatio(failedDuringDrag ? this.persistedSidePaneRatio : startRatio);
  }

  private persistCurrentSidePaneRatio(): void {
    const persist = this.options.persistSidePaneRatio;
    const ratio = this.sidePaneRatio;
    if (!persist) {
      this.persistedSidePaneRatio = ratio;
      return;
    }
    this.failedRatioSaveGenerationDuringDrag = undefined;
    const saveGeneration = ++this.ratioSaveGeneration;
    void Promise.resolve()
      .then(() => persist(ratio))
      .then(() => {
        if (saveGeneration <= this.confirmedRatioSaveGeneration) return;
        this.confirmedRatioSaveGeneration = saveGeneration;
        this.persistedSidePaneRatio = ratio;
      })
      .catch(() => {
        if (this.disposed || saveGeneration !== this.ratioSaveGeneration) return;
        const dragActive = this.dividerDragStartRatio !== undefined;
        const changed = this.restorePersistedSidePaneRatio();
        if (dragActive) this.failedRatioSaveGenerationDuringDrag = saveGeneration;
        if (changed) this.options.requestRender();
      });
  }

  private restorePersistedSidePaneRatio(): boolean {
    return this.setSidePaneRatio(this.persistedSidePaneRatio);
  }

  private setSidePaneRatio(ratio: number): boolean {
    if (ratio === this.sidePaneRatio) return false;
    this.sidePaneRatio = ratio;
    this.layoutRoot.invalidate();
    return true;
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

  private handleViewportWidth(width: number): void {
    if (
      this.disposed ||
      width >= MIN_BTW_SPLIT_COLUMNS ||
      this.activePane === "side" ||
      this.options.hasFocusedOverlay()
    ) {
      return;
    }
    this.activatePane("side");
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

// HStack has no percentage basis, so refresh exact ratio-based widths from its
// viewport callback before each layout pass and let the side pane fill narrow views.
class ResponsivePaneRow extends HStack {
  constructor(
    left: Component,
    separator: Component,
    right: Component,
    private readonly sideIndex: 0 | 2,
    private readonly sidePaneRatio: () => number,
    private readonly onViewportWidth: (width: number) => void,
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
    this.onViewportWidth(safeWidth);
    if (safeWidth < MIN_BTW_SPLIT_COLUMNS) {
      for (const [index, entry] of this.entries.entries()) {
        entry.basis = index === this.sideIndex ? safeWidth : 1;
      }
      return;
    }
    const layout = this.sideIndex === 0 ? "left-pane" : "right-pane";
    const { leftWidth, rightWidth } = paneWidths(safeWidth, layout, this.sidePaneRatio());
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
  sidePaneRatio: number,
): BtwActivePane | undefined {
  const match = SGR_MOUSE_PRESS_PATTERN.exec(data);
  if (!match) return undefined;
  const button = Number.parseInt(match[1] ?? "", 10);
  if ((button & 32) !== 0 || (button & 64) !== 0 || (button & 3) !== 0) return undefined;
  const column = Number.parseInt(match[2] ?? "", 10) - 1;
  if (!Number.isFinite(column) || column < 0 || column >= terminalColumns) return undefined;
  const { leftWidth } = paneWidths(terminalColumns, layout, sidePaneRatio);
  if (column >= leftWidth && column < leftWidth + PANE_DIVIDER_COLUMNS) return undefined;
  const clickedLeft = column < leftWidth;
  if (layout === "left-pane") return clickedLeft ? "side" : "main";
  return clickedLeft ? "main" : "side";
}

function paneWidths(width: number, layout: Exclude<BtwLayout, "fullscreen">, sidePaneRatio: number) {
  const contentWidth = Math.max(2, width - PANE_DIVIDER_COLUMNS);
  const sideWidth = clamp(
    Math.round(contentWidth * clampSidePaneRatio(sidePaneRatio)),
    1,
    Math.max(1, contentWidth - 1),
  );
  const mainWidth = Math.max(1, contentWidth - sideWidth);
  const leftWidth = layout === "left-pane" ? sideWidth : mainWidth;
  const rightWidth = layout === "left-pane" ? mainWidth : sideWidth;
  return { leftWidth, rightWidth, sideWidth, mainWidth };
}

function clampSidePaneRatio(ratio: number): number {
  return Number.isFinite(ratio)
    ? clamp(ratio, MIN_BTW_SIDE_PANE_RATIO, MAX_BTW_SIDE_PANE_RATIO)
    : DEFAULT_BTW_SIDE_PANE_RATIO;
}

function roundPaneRatio(ratio: number): number {
  return Math.round(ratio * 10_000) / 10_000;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}

function hasInput(component: Component | null): component is Component {
  return component !== null && typeof component.handleInput === "function";
}

function padLine(line: string, width: number): string {
  const truncated = truncateToWidth(line, width);
  return `${truncated}${" ".repeat(Math.max(0, width - visibleWidth(truncated)))}`;
}
