import type { KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import {
  getKeybindings,
  isKeyRepeat,
  matchesKey,
  type OverlayOptions,
  type TUI,
  type TuiMouseEvent,
  type TuiMouseEventResult,
  truncateToWidth,
  visibleWidth,
} from "@earendil-works/pi-tui";
import { type FloatingBounds, FloatingFrame, type FloatingFrameOptions } from "@narumitw/pi-tui-kit/floating-frame";

type WindowMode = "normal" | "maximized" | "minimized";
type WindowAction = "minimize" | "maximize" | "close";
type WindowKey = "m" | "u" | "z" | "w";

interface WindowOptions {
  title: string;
  tui: TUI;
  theme: Pick<Theme, "fg" | "bold">;
  keybindings: KeybindingsManager;
  body: FloatingFrameOptions["body"];
  isCurrent(): boolean;
  close(): void;
}

const REVIEW_BINDINGS = [
  "tui.select.cancel",
  "tui.select.up",
  "tui.select.down",
  "tui.select.pageUp",
  "tui.select.pageDown",
] as const;

function findWindowKey(candidates: readonly WindowKey[], { tui, keybindings }: WindowOptions): WindowKey | undefined {
  const host = getKeybindings();
  return candidates.find((key) =>
    [key, `\x1b[${key.charCodeAt(0)}u`].every(
      (input) =>
        !REVIEW_BINDINGS.some((binding) => keybindings.matches(input, binding)) &&
        !(tui.mode === "fullscreen" && host.matches(input, "tui.altScreen.search")),
    ),
  );
}

function sameBounds(a: FloatingBounds, b: FloatingBounds) {
  return a.col === b.col && a.row === b.row && a.width === b.width && a.height === b.height;
}

export class FloatingDiffWindow {
  readonly overlayOptions: OverlayOptions;
  private mode: WindowMode = "normal";
  private restoreMode: Exclude<WindowMode, "minimized"> = "normal";
  private normalBounds: FloatingBounds | undefined;
  private frame: FloatingFrame;
  private pressed: { action: WindowAction; bounds: FloatingBounds } | undefined;

  constructor(private readonly options: WindowOptions) {
    this.frame = this.createFrame();
    const window = this;
    this.overlayOptions = {
      get col() {
        return window.bounds.col;
      },
      get row() {
        return window.bounds.row;
      },
      get width() {
        return window.bounds.width;
      },
      get maxHeight() {
        return window.bounds.height;
      },
    };
  }

  private get bounds(): FloatingBounds {
    if (this.mode !== "minimized") return this.frame.bounds;
    const { columns, rows } = this.options.tui.terminal;
    const width = Math.min(columns, 64);
    return { width, height: Math.min(1, rows), col: Math.floor((columns - width) / 2), row: Math.max(0, rows - 1) };
  }

  private createFrame(): FloatingFrame {
    return new FloatingFrame({
      getTerminalSize: () => this.options.tui.terminal,
      initialBounds: ({ columns, rows }) => {
        if (this.mode === "maximized") return { col: 0, row: 0, width: columns, height: rows };
        if (this.normalBounds) return this.normalBounds;
        const width = Math.floor(columns * 0.9);
        const height = Math.floor(rows * 0.8);
        return { width, height, col: Math.floor((columns - width) / 2), row: Math.floor((rows - height) / 2) };
      },
      minSize: { columns: 24, rows: 5 },
      requestRender: () => this.options.tui.requestRender(),
      styleBorder: (text) => this.options.theme.fg("border", text),
      styleTitle: (text) => text,
      title: (columns) => this.titleBar(columns + 2).moveTitle,
      body: this.options.body,
    });
  }

  private keys() {
    return {
      minimize: findWindowKey(["m", "u"], this.options),
      maximize: findWindowKey(["z", "w"], this.options),
    };
  }

  private titleBar(width: number) {
    const minimized = this.mode === "minimized";
    const inset = minimized && width < 5 ? 0 : 1;
    const { minimize, maximize } = this.keys();
    const buttons: { action: WindowAction; label: string }[] = [];
    if (minimize) buttons.push({ action: "minimize", label: minimized ? " + " : " − " });
    if (!minimized && maximize) buttons.push({ action: "maximize", label: this.mode === "maximized" ? " ❐ " : " □ " });
    buttons.push({ action: "close", label: " × " });

    let titleWidth = width - 2 * inset;
    const visible = buttons
      .toReversed()
      .filter(({ label }) => {
        const cells = visibleWidth(label);
        if (cells > titleWidth) return false;
        titleWidth -= cells;
        return true;
      })
      .reverse();
    const hints = minimized
      ? [minimize && `${minimize} restore`, "ctrl+c close"]
      : [
          minimize && `${minimize} minimize`,
          maximize && `${maximize} ${this.mode === "maximized" ? "restore size" : "maximize"}`,
        ];
    const ruleStart = !minimized && titleWidth > 0 ? "─" : "";
    const headingWidth = titleWidth - ruleStart.length;
    const { theme, title } = this.options;
    const titleText = ` ${title}`;
    let hintText = "";
    for (const hint of hints) {
      if (!hint) continue;
      const next = `${hintText} · ${hint}`;
      if (visibleWidth(titleText + next) <= headingWidth) hintText = next;
    }
    const heading = theme.fg("accent", theme.bold(titleText)) + theme.fg("muted", hintText);
    const fittedHeading = truncateToWidth(heading, headingWidth, "", minimized);
    const remaining = headingWidth - visibleWidth(fittedHeading);
    const ruleEnd = remaining > 0 ? ` ${theme.fg("border", "─".repeat(remaining - 1))}` : "";
    let x = inset + titleWidth;
    const controls = visible.map(({ action, label }) => {
      const from = x;
      x += visibleWidth(label);
      return { action, from, to: x, label };
    });
    const left = inset ? theme.fg("border", (minimized ? "╶" : "╭") + ruleStart) : "";
    const right = inset ? theme.fg("border", minimized ? "╴" : "╮") : "";
    return {
      line: left + fittedHeading + ruleEnd + controls.map(({ label }) => theme.fg("text", label)).join("") + right,
      moveTitle: fittedHeading,
      controls,
    };
  }

  render(width: number): string[] {
    const { height } = this.bounds;
    if (width <= 0 || height <= 0) return [];
    if (this.mode === "minimized") return [this.titleBar(width).line];
    const rows = this.frame.render(width);
    if (width < 3 || height < 3) return rows;
    const title = this.titleBar(width).line;
    return this.mode === "maximized"
      ? [title, ...rows.slice(1, -1), this.options.theme.fg("border", `╰${"─".repeat(width - 2)}╯`)]
      : [title, ...rows.slice(1)];
  }

  invalidate(): void {
    this.pressed = undefined;
    this.frame.invalidate();
  }

  handleInput(input: string): void {
    if (!this.options.isCurrent()) return;
    if (matchesKey(input, "ctrl+c") || this.options.keybindings.matches(input, "tui.select.cancel")) {
      this.activate("close");
      return;
    }
    const { minimize, maximize } = this.keys();
    if (REVIEW_BINDINGS.some((binding) => this.options.keybindings.matches(input, binding))) {
      if (this.mode !== "minimized") this.frame.handleInput(input);
    } else if (minimize && matchesKey(input, minimize)) {
      if (!isKeyRepeat(input)) this.activate("minimize");
    } else if (this.mode !== "minimized" && maximize && matchesKey(input, maximize)) {
      if (!isKeyRepeat(input)) this.activate("maximize");
    } else if (this.mode !== "minimized") {
      this.frame.handleInput(input);
    }
  }

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    if (!this.options.isCurrent()) return undefined;
    const bounds = this.bounds;
    const framed = bounds.width >= 3 && bounds.height >= 3;
    const action =
      event.y === 0 && (framed || this.mode === "minimized")
        ? this.titleBar(bounds.width).controls.find(({ from, to }) => event.x >= from && event.x < to)?.action
        : undefined;

    if (event.type === "press") {
      this.pressed = undefined;
      if (action) {
        if (event.button !== "left") return { handled: true };
        this.pressed = { action, bounds };
        return { capture: true };
      }
    }
    const pressed = this.pressed;
    if (pressed && (event.type === "drag" || event.type === "release" || event.type === "click")) {
      const sameControl = action === pressed.action && sameBounds(bounds, pressed.bounds);
      if (event.type !== "release" || !sameControl) this.pressed = undefined;
      // Pi emits a click after a completed press/release, not after a drag or a lost capture.
      if (event.type === "click" && sameControl) this.activate(pressed.action);
      return { handled: true };
    }
    if (this.mode === "minimized") return undefined;
    if (
      this.mode === "maximized" &&
      framed &&
      event.type === "press" &&
      event.button === "left" &&
      (event.y === 0 || event.y === bounds.height - 1 || event.x === 0 || event.x === bounds.width - 1)
    ) {
      return { handled: true };
    }
    return this.frame.handleMouse(event);
  }

  private activate(action: WindowAction): void {
    this.pressed = undefined;
    if (action === "close") {
      this.options.close();
      return;
    }
    if (this.mode === "normal") this.normalBounds = this.frame.bounds;
    if (action === "maximize") {
      this.mode = this.mode === "maximized" ? "normal" : "maximized";
    } else if (this.mode === "minimized") {
      this.mode = this.restoreMode;
    } else {
      this.restoreMode = this.mode;
      this.mode = "minimized";
    }
    if (this.mode !== "minimized") this.frame = this.createFrame();
    this.options.tui.requestRender();
  }
}
