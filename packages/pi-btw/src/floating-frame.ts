import type { Theme } from "@earendil-works/pi-coding-agent";
import {
  type Component,
  type Focusable,
  isFocusable,
  isKeyRepeat,
  isKittyProtocolActive,
  type KeybindingsManager,
  type KeyId,
  matchesKey,
  type OverlayOptions,
  type ScrollView,
  type TUI,
  type TuiMouseEvent,
  type TuiMouseEventResult,
  visibleWidth,
} from "@earendil-works/pi-tui";
import { FloatingFrame } from "@narumitw/pi-tui-kit/floating-frame";
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
const MIN_WIDTH = 32;
const MIN_HEIGHT = 9;
const PAGE_RESERVED_APP_ROWS = 3;
const MOVE_KEYS = ["f9", "f10", "f11", "f12"] as const;
const SIZE_KEYS = ["f4", "f5", "f3", "f2"] as const;
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
  private readonly frame: FloatingFrame;
  private adjusting = false;
  private readonly pasteGuard = new BtwPasteGuard();
  private readonly shortcutBlockers: string[];
  private readonly directionBlockers: string[];
  private chosenKeys:
    | { kitty: boolean; move?: KeyId; directions?: (typeof DIRECTION_SETS)[number]; minimize?: KeyId; maximize?: KeyId }
    | undefined;

  constructor(
    private readonly parent: TUI,
    theme: Theme,
    private readonly keybindings: KeybindingsManager,
    private readonly hardCancel: () => void,
    overrides?: BtwKeybindingOverrides,
  ) {
    const frame = new FloatingFrame({
      getTerminalSize: () => parent.terminal,
      initialBounds: ({ columns, rows }) => {
        const width = Math.min(columns, Math.max(MIN_WIDTH, Math.floor(columns * 0.7)));
        const height = Math.min(rows, Math.max(MIN_HEIGHT, Math.floor(rows * 0.7)));
        return { width, height, col: Math.floor((columns - width) / 2), row: Math.floor((rows - height) / 2) };
      },
      minSize: { columns: MIN_WIDTH, rows: MIN_HEIGHT },
      requestRender: () => parent.requestRender(),
      styleBorder: (line) => theme.fg("border", line),
      styleTitle: (line) => theme.fg("muted", line),
      title: (columns) => this.renderTitle(columns),
      focusOnDrag: true,
      controls: {
        close: hardCancel,
        enabled: (action) => parent.mode === "fullscreen" || this.windowKeys[action] !== undefined,
        styleButton: (text) => theme.fg("text", text),
      },
      body: {
        render: ({ columns }) => this.page?.render(columns) ?? [theme.fg("muted", "Opening BTW…")],
        invalidate: () => this.page?.invalidate(),
        setFocused: (value) => {
          if (this.page && isFocusable(this.page)) this.page.focused = value && !this.adjusting;
        },
        handleMouse: (event) => this.handleBodyMouse(event),
      },
    });
    this.frame = frame;
    this.overlayOptions = frame.overlayOptions;
    const terminal = new Proxy(parent.terminal, {
      get(target, property) {
        if (property === "columns") return frame.viewport.columns;
        if (property === "rows") return frame.viewport.rows + PAGE_RESERVED_APP_ROWS;
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
    return this.frame.focused;
  }
  set focused(value: boolean) {
    this.frame.focused = value;
  }

  setPage(page: FloatingPage | undefined): void {
    if (this.page && isFocusable(this.page)) this.page.focused = false;
    this.page = page;
    this.focused = this.frame.focused;
    this.parent.requestRender();
  }

  invalidate(): void {
    this.frame.invalidate();
  }

  render(width: number): string[] {
    return this.frame.render(width);
  }

  private renderTitle(columns: number): string {
    const { move, directions, minimize, maximize } = this.windowKeys;
    const mode = this.frame.mode;
    const hints =
      mode === "minimized"
        ? [keyHint(minimize, "restore"), "Ctrl+C close"]
        : [
            mode === "normal" &&
              (this.adjusting && directions ? `${directions.label} move · Shift resize` : keyHint(move, "move/resize")),
            keyHint(minimize, "minimize"),
            keyHint(maximize, mode === "maximized" ? "restore size" : "maximize"),
          ];
    let title = " BTW";
    for (const hint of hints) {
      if (!hint) continue;
      const next = `${title} · ${hint}`;
      if (visibleWidth(next) <= columns) title = next;
    }
    return title;
  }

  handleInput(data: string): void {
    const mode = this.frame.mode;
    if (this.pasteGuard.consume(data)) {
      if (mode !== "minimized" && !this.adjusting) this.page?.handleInput?.(data);
      return;
    }
    if (
      matchesKey(data, "ctrl+c") ||
      (!this.adjusting && getBtwShortcuts(this.tui).matches(data, "exit")) ||
      (mode === "minimized" && this.keybindings.matches(data, "tui.select.cancel"))
    ) {
      this.hardCancel();
      return;
    }
    const { move, directions, minimize, maximize } = this.windowKeys;
    if (minimize && matchesKey(data, minimize)) {
      if (!isKeyRepeat(data)) {
        if (this.adjusting) this.setAdjusting(false);
        this.frame.toggleMinimized();
      }
    } else if (mode === "minimized") {
      return;
    } else if (maximize && matchesKey(data, maximize)) {
      if (!isKeyRepeat(data)) {
        if (this.adjusting) this.setAdjusting(false);
        this.frame.toggleMaximized();
      }
    } else if (mode === "normal" && move && matchesKey(data, move)) {
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
          if (resize) this.frame.resize(delta[0], delta[1]);
          else this.frame.move(delta[0], delta[1]);
          return;
        }
      }
    } else {
      this.page?.handleInput?.(data);
    }
  }

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    const mode = this.frame.mode;
    const result = this.frame.handleMouse(event);
    if (this.adjusting && mode !== this.frame.mode) this.setAdjusting(false);
    return result;
  }

  private handleBodyMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    const result = this.page?.handleMouse?.(event);
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
      const move = directions && MOVE_KEYS.find((key) => btwKeyHasReachableInput(key, blockers));
      const [minimize, maximize] = SIZE_KEYS.filter((key) => btwKeyHasReachableInput(key, blockers));
      this.chosenKeys = { kitty, move, directions, minimize, maximize };
    }
    return this.chosenKeys;
  }

  private setAdjusting(value: boolean): void {
    this.adjusting = value;
    this.focused = this.frame.focused;
    this.parent.requestRender();
  }
}

function keyHint(key: KeyId | undefined, action: string): string | undefined {
  return key && `${formatKeyLabel(key)} ${action}`;
}

function boundProperty<T extends object>(target: T, property: string | symbol): unknown {
  const value: unknown = Reflect.get(target, property, target);
  return typeof value === "function" ? value.bind(target) : value;
}
