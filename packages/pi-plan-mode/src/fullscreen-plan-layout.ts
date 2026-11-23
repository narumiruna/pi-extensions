import type { Theme } from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import * as tuiCore from "@earendil-works/pi-tui";

const MIN_COLUMNS = 80;
const MIN_ROWS = 12;
const MIN_PANE_COLUMNS = 24;
const MIN_CONVERSATION_COLUMNS = 48;
const DIVIDER_COLUMNS = 1;

export type PlanPaneSide = "left" | "right";

type Viewport = { width: number; height: number };

export interface MountedPlanLayout {
  isVisible(): boolean;
  restore(): void;
}

function canShowPane({ width, height }: Viewport) {
  return width >= MIN_COLUMNS && height >= MIN_ROWS;
}

function nativeFullscreenRoot(tui: TUI, rendererChildren: readonly Component[]) {
  if (
    tui.mode !== "fullscreen" ||
    tui.children !== rendererChildren ||
    typeof tuiCore.HStack !== "function" ||
    typeof tuiCore.isViewportTUI !== "function" ||
    !tuiCore.isViewportTUI(tui)
  )
    return;
  const root: unknown = Reflect.get(tui, "layoutRoot");
  return isNativeFullscreenRoot(root, rendererChildren) ? { root, viewport: tui } : undefined;
}

export function canOpenFullscreenPlanLayout(tui: TUI): boolean {
  return (
    canShowPane({ width: tui.terminal.columns, height: tui.terminal.rows }) &&
    nativeFullscreenRoot(tui, tui.children) !== undefined
  );
}

export function mountFullscreenPlanLayout(
  tui: TUI,
  rendererChildren: readonly Component[],
  side: PlanPaneSide,
  pane: Component,
  theme: Theme,
): MountedPlanLayout | undefined {
  const native = nativeFullscreenRoot(tui, rendererChildren);
  if (!native) return;
  const { root: original, viewport } = native;
  const readRoot = (): unknown => Reflect.get(tui, "layoutRoot");
  let active = true;
  const ownsLayout = (): boolean =>
    active && tui.mode === "fullscreen" && tui.children === rendererChildren && readRoot() === wrapper;
  const wrapper = createPlanSplitLayout(original, pane, side, tui, theme, ownsLayout);
  const restore = () => {
    active = false;
    if (tui.mode === "fullscreen" && readRoot() === wrapper) {
      viewport.setLayoutRoot(original);
    }
  };
  try {
    viewport.setLayoutRoot(wrapper);
    if (readRoot() === wrapper) {
      return {
        isVisible: () => ownsLayout() && canShowPane({ width: tui.terminal.columns, height: tui.terminal.rows }),
        restore,
      };
    }
    active = false;
    return;
  } catch {
    restore();
    return;
  }
}

function hasComponentChildren(value: unknown): value is Component & { children: Component[] } {
  return (
    typeof value === "object" &&
    value !== null &&
    "children" in value &&
    Array.isArray(value.children) &&
    "render" in value &&
    typeof value.render === "function" &&
    "invalidate" in value &&
    typeof value.invalidate === "function"
  );
}

function isNativeFullscreenRoot(value: unknown, rendererChildren: readonly Component[]): value is Component {
  if (!hasComponentChildren(value) || value.children.length !== 2) return false;
  const [transcript, dock] = value.children;
  return (
    hasComponentChildren(transcript) &&
    "scrollBy" in transcript &&
    typeof transcript.scrollBy === "function" &&
    "primary" in transcript &&
    transcript.primary === true &&
    transcript.children.length === 1 &&
    transcript.children[0] === rendererChildren[0] &&
    hasComponentChildren(dock) &&
    dock.children.length === rendererChildren.length - 1 &&
    dock.children.every((component, index) => component === rendererChildren[index + 1])
  );
}

function createPlanSplitLayout(
  main: Component,
  pane: Component,
  side: PlanPaneSide,
  tui: TUI,
  theme: Theme,
  ownsLayout: () => boolean,
) {
  let viewport: Viewport = { width: 0, height: 0 };
  let preferredWidth: number | undefined;
  const clampWidth = (width: number, requested: number) =>
    Math.min(width - DIVIDER_COLUMNS - MIN_CONVERSATION_COLUMNS, Math.max(MIN_PANE_COLUMNS, requested));
  const paneWidth = (width: number) => clampWidth(width, preferredWidth ?? Math.floor((width - DIVIDER_COLUMNS) / 3));
  const canDrag = (start: typeof viewport) =>
    start === viewport &&
    start.width === tui.terminal.columns &&
    start.height === tui.terminal.rows &&
    canShowPane(start) &&
    ownsLayout();
  const divider: Component = {
    render: (width) =>
      width < DIVIDER_COLUMNS ? [] : Array.from({ length: tui.terminal.rows }, () => theme.fg("borderMuted", "│")),
    invalidate() {},
    handleMouse(event) {
      if (event.type !== "press" || event.button !== "left" || !canDrag(viewport)) return;
      let start: typeof viewport | undefined = viewport;
      const capturedDrag: Component = {
        render: () => [],
        invalidate() {},
        handleMouse(event) {
          if (!start || !canDrag(start)) {
            start = undefined;
            return;
          }
          if (event.type !== "drag" || event.button !== "left") return;
          const requested = side === "left" ? event.screenX : start.width - DIVIDER_COLUMNS - event.screenX;
          const nextWidth = clampWidth(start.width, requested);
          const render = nextWidth !== paneWidth(start.width);
          preferredWidth = nextWidth;
          return { handled: true, render };
        },
      };
      return {
        handled: true,
        capture: true,
        render: false,
        target: {
          component: capturedDrag,
          originX: event.screenX - event.x,
          originY: event.screenY - event.y,
          width: event.width,
          height: event.height,
        },
      };
    },
  };
  const mainEntry = { component: main, basis: 0, grow: 1, minSize: 1 };
  const dividerEntry = { component: divider, basis: DIVIDER_COLUMNS, shrink: 0 };
  const sideEntry = { component: pane, basis: 1, shrink: 0 };
  return new (class extends tuiCore.HStack {
    constructor() {
      super(side === "left" ? [sideEntry, dividerEntry, mainEntry] : [mainEntry, dividerEntry, sideEntry]);
      const paneSlot = this.entries[side === "left" ? 0 : 2];
      const dividerSlot = this.entries[1];
      if (!paneSlot || !dividerSlot) return;
      const updateViewport = ({ width, height }: typeof viewport) => {
        const rows = Math.min(height, tui.terminal.rows);
        if (viewport.width !== width || viewport.height !== rows) viewport = { width, height: rows };
        return canShowPane(viewport);
      };
      paneSlot.visible = (size) => {
        if (!updateViewport(size)) return false;
        paneSlot.basis = paneWidth(size.width);
        return true;
      };
      dividerSlot.visible = updateViewport;
    }
  })();
}
