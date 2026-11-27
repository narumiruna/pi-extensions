import type { Theme } from "@earendil-works/pi-coding-agent";
import {
  type Component,
  type Focusable,
  isFocusable,
  isKittyProtocolActive,
  type KeybindingsManager,
  type KeyId,
  matchesKey,
  type OverlayOptions,
  type ScrollView,
  type TUI,
  type TuiMouseEvent,
  type TuiMouseEventResult,
  truncateToWidth,
} from "@earendil-works/pi-tui";
import {
  type BtwKeybindingOverrides,
  BtwPasteGuard,
  btwKeyHasReachableInput,
  getBtwShortcuts,
  resolveBtwShortcuts,
  setBtwHostInputBlockers,
  setBtwKeybindings,
  setBtwShortcuts,
} from "./keybindings.js";
import { formatKeyLabel } from "./text.js";

export type FloatingPage = Component & { dispose?(): void; getPrimaryScrollView?(): ScrollView };
type Rectangle = { col: number; row: number; width: number; height: number };
const MIN_WIDTH = 32;
const MIN_HEIGHT = 9;
const PAGE_RESERVED_APP_ROWS = 3;
const WINDOW_KEYS = ["f9", "f10", "f11", "f12"] as const;
const DIRECTION_SETS = [
  { keys: ["left", "right", "up", "down"], label: "Arrows" },
  { keys: ["a", "d", "w", "s"], label: "WASD" },
] as const;
const DELTAS = [
  [-1, 0],
  [1, 0],
  [0, -1],
  [0, 1],
] as const;
const floatingTuis = new WeakSet<TUI>();

export function isBtwFloatingTui(tui: TUI): boolean {
  return floatingTuis.has(tui);
}

export class BtwFloatingFrame implements Component, Focusable {
  readonly tui: TUI;
  readonly overlayOptions: OverlayOptions;
  private page: FloatingPage | undefined;
  private preferred: Rectangle | undefined;
  private drag: { start: Rectangle; x: number; y: number; resize: boolean } | undefined;
  private adjusting = false;
  private isFocused = false;
  private readonly pasteGuard = new BtwPasteGuard();
  private readonly shortcutBlockers: string[];
  private readonly directionBlockers: string[];
  private chosenKeys: { kitty: boolean; key?: KeyId; directions?: (typeof DIRECTION_SETS)[number] } | undefined;

  constructor(
    private readonly parent: TUI,
    private readonly theme: Theme,
    private readonly keybindings: KeybindingsManager,
    private readonly hardCancel: () => void,
    overrides?: BtwKeybindingOverrides,
  ) {
    const frame = this;
    this.overlayOptions = {
      get col() {
        return frame.bounds.col;
      },
      get row() {
        return frame.bounds.row;
      },
      get width() {
        return frame.bounds.width;
      },
      get maxHeight() {
        return frame.bounds.height;
      },
    };
    const terminal = new Proxy(parent.terminal, {
      get(target, property) {
        if (property === "columns") return frame.bodyWidth;
        if (property === "rows") return frame.bodyHeight + PAGE_RESERVED_APP_ROWS;
        return boundProperty(target, property);
      },
    });
    this.tui = new Proxy(parent, {
      get: (target, property) => (property === "terminal" ? terminal : boundProperty(target, property)),
    });
    floatingTuis.add(this.tui);
    const hostBlockers = [
      ...(parent.mode === "fullscreen" ? keybindings.getKeys("tui.altScreen.search") : []),
      ...(parent.onDebug ? ["shift+ctrl+d"] : []),
    ];
    this.shortcutBlockers = [
      ...hostBlockers,
      ...Object.values(keybindings.getResolvedBindings()).flatMap((keys) => keys ?? []),
    ];
    this.directionBlockers = [
      ...hostBlockers,
      ...keybindings.getKeys("tui.select.confirm"),
      ...keybindings.getKeys("tui.select.cancel"),
    ];
    setBtwKeybindings(this.tui, keybindings);
    setBtwShortcuts(this.tui, resolveBtwShortcuts(overrides, keybindings));
    setBtwHostInputBlockers(this.tui, hostBlockers);
  }

  get focused(): boolean {
    return this.isFocused;
  }
  set focused(value: boolean) {
    this.isFocused = value;
    if (this.page && isFocusable(this.page)) this.page.focused = value && !this.adjusting;
  }

  setPage(page: FloatingPage | undefined): void {
    if (this.page && isFocusable(this.page)) this.page.focused = false;
    this.page = page;
    this.focused = this.isFocused;
    this.parent.requestRender();
  }

  invalidate(): void {
    this.page?.invalidate();
  }

  render(width: number): string[] {
    const { height } = this.bounds;
    if (width <= 0 || height <= 0) return [];
    const framed = width >= 3 && height >= 3;
    const innerWidth = framed ? width - 2 : width;
    const innerHeight = framed ? height - 2 : height;
    const content = this.page?.render(innerWidth) ?? [this.theme.fg("muted", "Opening BTW…")];
    const border = (s: string) => this.theme.fg("border", s);
    const rows = Array.from({ length: innerHeight }, (_, row) => {
      const line = truncateToWidth(content[row] ?? "", innerWidth, "", true);
      return framed ? border("│") + line + border("│") : line;
    });
    if (!framed) return rows;
    const { key, directions } = this.windowKeys;
    const hint =
      this.adjusting && directions
        ? `${directions.label} move · Shift resize`
        : key
          ? `${formatKeyLabel(key)} move/resize`
          : "";
    const label = truncateToWidth(hint ? ` BTW · ${hint} ` : " BTW ", innerWidth, "", true);
    return [
      border("╭") + this.theme.fg("muted", label) + border("╮"),
      ...rows,
      border(`╰${"─".repeat(innerWidth - 1)}◢╯`),
    ];
  }

  handleInput(data: string): void {
    if (this.pasteGuard.consume(data)) {
      if (!this.adjusting) this.page?.handleInput?.(data);
      return;
    }
    if (matchesKey(data, "ctrl+c") || (!this.adjusting && getBtwShortcuts(this.tui).matches(data, "exit"))) {
      this.hardCancel();
      return;
    }
    const { key, directions } = this.windowKeys;
    if (key && matchesKey(data, key)) {
      this.setAdjusting(!this.adjusting);
    } else if (this.adjusting && directions) {
      if (
        matchesKey(data, "escape") ||
        this.keybindings.matches(data, "tui.select.cancel") ||
        this.keybindings.matches(data, "tui.select.confirm")
      ) {
        this.setAdjusting(false);
        return;
      }
      for (const [index, direction] of directions.keys.entries()) {
        const resize = matchesKey(data, `shift+${direction}`);
        const delta = DELTAS[index];
        if (delta && (resize || matchesKey(data, direction))) {
          this.adjust(this.bounds, delta[0], delta[1], resize);
          return;
        }
      }
    } else {
      this.page?.handleInput?.(data);
    }
  }

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    if (this.drag && (event.type === "drag" || event.type === "release")) {
      const { start, x, y, resize } = this.drag;
      this.adjust(start, event.screenX - x, event.screenY - y, resize);
      if (event.type === "release") this.drag = undefined;
      return { handled: true };
    }
    const framed = event.width >= 3 && event.height >= 3;
    if (event.type === "press" && event.button === "left") {
      this.drag = undefined;
      const resize = framed && event.x >= event.width - 2 && event.y === event.height - 1;
      if (resize || (framed && event.y === 0)) {
        this.drag = { start: this.bounds, x: event.screenX, y: event.screenY, resize };
        return { capture: true, focus: true };
      }
    }
    const inset = framed ? 1 : 0;
    if (event.x < inset || event.y < inset || event.x >= event.width - inset || event.y >= event.height - inset) return;
    const result = this.page?.handleMouse?.({
      ...event,
      x: event.x - inset,
      y: event.y - inset,
      width: event.width - inset * 2,
      height: event.height - inset * 2,
    });
    if (result) return result;
    const scroll = this.page?.getPrimaryScrollView?.();
    if (event.type === "wheel" && scroll && event.wheelDelta) {
      scroll.scrollBy(event.wheelDelta);
      return { handled: true };
    }
  }

  private get windowKeys() {
    const kitty = isKittyProtocolActive();
    if (this.chosenKeys?.kitty !== kitty) {
      const directions = DIRECTION_SETS.find(({ keys }) =>
        keys.every(
          (key) =>
            btwKeyHasReachableInput(key, this.directionBlockers) &&
            btwKeyHasReachableInput(`shift+${key}`, this.directionBlockers),
        ),
      );
      const blockers = [...this.shortcutBlockers, ...Object.values(getBtwShortcuts(this.tui).keys).flat()];
      const key = directions && WINDOW_KEYS.find((key) => btwKeyHasReachableInput(key, blockers));
      this.chosenKeys = { kitty, key, directions };
    }
    return this.chosenKeys;
  }

  private setAdjusting(value: boolean): void {
    this.adjusting = value;
    this.focused = this.isFocused;
    this.parent.requestRender();
  }

  private get bodyWidth(): number {
    const { width, height } = this.bounds;
    return width >= 3 && height >= 3 ? width - 2 : width;
  }

  private get bodyHeight(): number {
    const { width, height } = this.bounds;
    return width >= 3 && height >= 3 ? height - 2 : height;
  }

  private get bounds(): Rectangle {
    const { columns, rows } = this.parent.terminal;
    const width = Math.min(columns, Math.max(MIN_WIDTH, this.preferred?.width ?? Math.floor(columns * 0.7)));
    const height = Math.min(rows, Math.max(MIN_HEIGHT, this.preferred?.height ?? Math.floor(rows * 0.7)));
    const col = clamp(this.preferred?.col ?? Math.floor((columns - width) / 2), 0, columns - width);
    const row = clamp(this.preferred?.row ?? Math.floor((rows - height) / 2), 0, rows - height);
    return { col, row, width, height };
  }

  private adjust(start: Rectangle, dx: number, dy: number, resize: boolean): void {
    const { columns, rows } = this.parent.terminal;
    const { col, row, width, height } = start;
    this.preferred = resize
      ? {
          col,
          row,
          width: clamp(width + dx, MIN_WIDTH, columns - col),
          height: clamp(height + dy, MIN_HEIGHT, rows - row),
        }
      : { width, height, col: clamp(col + dx, 0, columns - width), row: clamp(row + dy, 0, rows - height) };
    this.parent.requestRender();
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function boundProperty<T extends object>(target: T, property: string | symbol): unknown {
  const value: unknown = Reflect.get(target, property, target);
  return typeof value === "function" ? value.bind(target) : value;
}
