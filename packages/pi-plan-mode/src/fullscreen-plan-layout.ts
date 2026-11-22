import type { Theme } from "@earendil-works/pi-coding-agent";
import { type Component, HStack, isViewportTUI, type TUI } from "@earendil-works/pi-tui";

const MIN_COLUMNS = 80;
const MIN_ROWS = 12;

export type PlanPaneSide = "left" | "right";

export function mountFullscreenPlanLayout(
  tui: TUI,
  rendererChildren: readonly Component[],
  side: PlanPaneSide,
  pane: Component,
  theme: Theme,
): (() => void) | undefined {
  if (tui.mode !== "fullscreen" || tui.children !== rendererChildren || !isViewportTUI(tui)) return;
  const readRoot = (): unknown => Reflect.get(tui, "layoutRoot");
  const original = readRoot();
  if (!isNativeFullscreenRoot(original, rendererChildren)) return;

  const wrapper = new PlanSplitLayout(original, pane, side, tui, theme);
  const restore = () => {
    if (tui.mode === "fullscreen" && readRoot() === wrapper) {
      tui.setLayoutRoot(original);
    }
  };
  try {
    tui.setLayoutRoot(wrapper);
    return readRoot() === wrapper ? restore : undefined;
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

class PlanSplitLayout extends HStack {
  constructor(main: Component, pane: Component, side: PlanPaneSide, tui: TUI, theme: Theme) {
    const divider = {
      render: (width: number) =>
        width < 1 ? [] : Array.from({ length: tui.terminal.rows }, () => theme.fg("borderMuted", "│")),
      invalidate() {},
    };
    const mainEntry = { component: main, basis: 0, grow: 1, minSize: 1 };
    const dividerEntry = { component: divider, basis: 1, shrink: 0 };
    const sideEntry = { component: pane, basis: 1, shrink: 0 };
    super(side === "left" ? [sideEntry, dividerEntry, mainEntry] : [mainEntry, dividerEntry, sideEntry]);
    const paneSlot = this.entries[side === "left" ? 0 : 2];
    const dividerSlot = this.entries[1];
    if (!paneSlot || !dividerSlot) return;
    const visible = ({ width, height }: { width: number; height: number }) =>
      width >= MIN_COLUMNS && Math.min(height, tui.terminal.rows) >= MIN_ROWS;
    paneSlot.visible = (viewport) => {
      paneSlot.basis = Math.floor((viewport.width - 1) / 3);
      return visible(viewport);
    };
    dividerSlot.visible = visible;
  }
}
