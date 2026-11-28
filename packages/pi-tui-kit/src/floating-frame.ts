import {
  type Component,
  type Focusable,
  type OverlayOptions,
  type TuiMouseEvent,
  type TuiMouseEventResult,
  truncateToWidth,
  visibleWidth,
} from "@earendil-works/pi-tui";

export interface FloatingViewport {
  columns: number;
  rows: number;
}

export interface FloatingBounds {
  col: number;
  row: number;
  width: number;
  height: number;
}

type WindowSizeAction = "minimize" | "maximize";
type WindowAction = WindowSizeAction | "close";
type WindowMode = "normal" | "maximized" | "minimized";

export interface FloatingFrameOptions {
  getTerminalSize(): FloatingViewport;
  initialBounds(viewport: FloatingViewport): FloatingBounds;
  minSize: FloatingViewport;
  requestRender(): void;
  styleBorder(text: string): string;
  styleTitle(text: string): string;
  title(innerColumns: number): string;
  overlay?: Pick<OverlayOptions, "nonCapturing" | "visible">;
  focusOnDrag?: boolean;
  controls?: {
    close(): void;
    enabled?(action: WindowSizeAction): boolean;
    styleButton?(text: string): string;
  };
  body: {
    render(viewport: FloatingViewport): readonly string[];
    invalidate(): void;
    setFocused?(focused: boolean): void;
    handleInput?(data: string): void;
    handleMouse?(event: TuiMouseEvent): TuiMouseEventResult | undefined;
  };
}

type ResizeDirection = -1 | 0 | 1;

export class FloatingFrame implements Component, Focusable {
  readonly overlayOptions: OverlayOptions;
  private preferred: FloatingBounds | undefined;
  private drag:
    | { start: FloatingBounds; x: number; y: number; horizontal: ResizeDirection; vertical: ResizeDirection }
    | undefined;
  private bodyPress = false;
  private isFocused = false;
  private windowMode: WindowMode = "normal";
  private expandedMode: Exclude<WindowMode, "minimized"> = "normal";
  private pressed: { action: WindowAction; bounds: FloatingBounds } | undefined;

  constructor(private readonly options: FloatingFrameOptions) {
    const frame = this;
    this.overlayOptions = {
      ...options.overlay,
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
  }

  get mode(): WindowMode {
    return this.windowMode;
  }

  get bounds(): FloatingBounds {
    const size = this.terminalSize();
    if (this.mode === "maximized") return { col: 0, row: 0, width: size.columns, height: size.rows };
    if (this.mode === "minimized") {
      const width = Math.min(size.columns, 64);
      return {
        col: Math.floor((size.columns - width) / 2),
        row: Math.max(0, size.rows - 1),
        width,
        height: Math.min(size.rows, 1),
      };
    }
    return this.fitBounds(this.preferred ?? this.options.initialBounds(size), size);
  }

  get viewport(): FloatingViewport {
    if (this.mode === "minimized") return { columns: 0, rows: 0 };
    const { width, height } = this.bounds;
    return innerViewport(width, height);
  }

  get focused(): boolean {
    return this.isFocused;
  }

  set focused(value: boolean) {
    this.isFocused = value;
    this.options.body.setFocused?.(value && this.mode !== "minimized");
  }

  toggleMinimized(): void {
    if (this.mode !== "minimized" && !this.controlEnabled("minimize")) return;
    this.setMode(this.mode === "minimized" ? this.expandedMode : "minimized");
  }

  toggleMaximized(): void {
    if (this.mode === "minimized" || !this.controlEnabled("maximize")) return;
    this.setMode(this.mode === "maximized" ? "normal" : "maximized");
  }

  move(dx: number, dy: number): void {
    if (this.mode === "normal") this.moveFrom(this.bounds, dx, dy);
  }

  resize(dx: number, dy: number): void {
    if (this.mode === "normal") this.resizeFrom(this.bounds, dx, dy, 1, 1);
  }

  invalidate(): void {
    this.pressed = undefined;
    this.options.body.invalidate();
  }

  handleInput(data: string): void {
    if (this.mode !== "minimized") this.options.body.handleInput?.(data);
  }

  render(width: number): string[] {
    const { height } = this.bounds;
    width = nonnegativeInteger(width);
    if (width === 0 || height === 0) return [];
    if (this.mode === "minimized") return [this.titleBar(width).line];
    const viewport = innerViewport(width, height);
    const inset = hasFrame(width, height);
    const body = this.options.body.render(viewport);
    const border = (text: string) => this.options.styleBorder(text);
    const lines = Array.from({ length: viewport.rows }, (_, row) => {
      const line = truncateToWidth(body[row] ?? "", viewport.columns, "", true);
      return inset ? border("│") + line + border("│") : line;
    });
    if (!inset) return lines;
    return [
      this.titleBar(width).line,
      ...lines,
      border(this.mode === "normal" ? `╰${"─".repeat(width - 3)}◢╯` : `╰${"─".repeat(width - 2)}╯`),
    ];
  }

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    const { x, y, width, height } = event;
    if (event.type === "press") {
      this.drag = undefined;
      this.bodyPress = false;
    }
    const framed = hasFrame(width, height);
    const title = y === 0 && (framed || this.mode === "minimized") ? this.titleBar(width) : undefined;
    const control = this.handleControlMouse(event, title?.buttons.find(({ from, to }) => x >= from && x < to)?.action);
    if (control || this.mode === "minimized") return control;
    if (this.drag && (event.type === "drag" || event.type === "release")) {
      const { start, x, y, horizontal, vertical } = this.drag;
      const dx = event.screenX - x;
      const dy = event.screenY - y;
      if (event.type === "release") this.drag = undefined;
      if (horizontal || vertical) this.resizeFrom(start, dx, dy, horizontal, vertical);
      else this.moveFrom(start, dx, dy);
      return { handled: true };
    }
    if (event.type === "press" && event.button === "left" && framed && x >= 0 && x < width && y >= 0 && y < height) {
      const bottom = y === height - 1;
      const horizontal = x === 0 ? -1 : x === width - 1 || (bottom && x === width - 2) ? 1 : 0;
      const onTitle = title !== undefined && x >= 2 && x < 2 + title.labelWidth;
      const vertical = onTitle ? 0 : y === 0 ? -1 : bottom ? 1 : 0;
      if (horizontal || vertical || onTitle) {
        if (this.mode === "maximized") return { handled: true };
        this.drag = { start: this.bounds, x: event.screenX, y: event.screenY, horizontal, vertical };
        return this.options.focusOnDrag ? { capture: true, focus: true } : { capture: true };
      }
    }
    const inset = framed ? 1 : 0;
    const continuesBodyPress = this.bodyPress && (event.type === "drag" || event.type === "release");
    if (event.type === "release") this.bodyPress = false;
    if (
      !continuesBodyPress &&
      (event.x < inset || event.y < inset || event.x >= event.width - inset || event.y >= event.height - inset)
    )
      return;
    const result = this.options.body.handleMouse?.({
      ...event,
      x: event.x - inset,
      y: event.y - inset,
      width: event.width - inset * 2,
      height: event.height - inset * 2,
    });
    if (event.type === "press" && result && !("target" in result)) {
      this.bodyPress = Boolean(result.handled || result.capture || result.focus);
    }
    return result;
  }

  private titleBar(width: number) {
    const { controls } = this.options;
    const minimized = this.mode === "minimized";
    const left = minimized ? (width >= 5 ? "╶" : "") : controls && width === 5 ? "╭" : "╭─";
    const right = minimized ? (left ? "╴" : "") : "╮";
    let available = width - left.length - right.length;
    const buttons: { action: WindowAction; label: string; from: number; to: number }[] = [];
    const add = (action: WindowAction, label: string) => {
      const cells = visibleWidth(label);
      if (cells > available) return;
      const to = left.length + available;
      available -= cells;
      buttons.unshift({ action, label, from: to - cells, to });
    };
    const styleBorder = (text: string) => this.options.styleBorder(text);
    const styleTitle = (text: string) => this.options.styleTitle(text);
    if (controls) {
      add("close", " × ");
      if (!minimized && this.controlEnabled("maximize")) {
        add("maximize", this.mode === "maximized" ? " ❐ " : " □ ");
      }
      if (minimized || this.controlEnabled("minimize")) add("minimize", minimized ? " + " : " − ");
    }
    const label = truncateToWidth(this.options.title(controls ? available : width - 2).trimEnd(), available, "");
    const labelWidth = visibleWidth(label);
    const gap = available - labelWidth;
    const fill = minimized ? " " : "─";
    const heading = styleBorder(left) + styleTitle(label);
    const line = buttons.length
      ? heading +
        (gap > 0 ? ` ${styleBorder(fill.repeat(gap - 1))}` : "") +
        buttons.map(({ label }) => controls?.styleButton?.(label) ?? styleTitle(label)).join("") +
        styleBorder(right)
      : heading + styleBorder(fill.repeat(gap) + right);
    return { line, labelWidth, buttons };
  }

  private controlEnabled(action: WindowSizeAction): boolean {
    const { controls } = this.options;
    return controls !== undefined && (controls.enabled?.(action) ?? true);
  }

  private handleControlMouse(event: TuiMouseEvent, action: WindowAction | undefined): TuiMouseEventResult | undefined {
    const { pressed } = this;
    if (event.type === "press") {
      this.pressed = undefined;
      if (!action) return;
      if (event.button !== "left") return { handled: true };
      const bounds = this.bounds;
      if (
        event.width !== bounds.width ||
        event.height !== bounds.height ||
        event.screenX !== bounds.col + event.x ||
        event.screenY !== bounds.row + event.y
      )
        return { handled: true };
      this.pressed = { action, bounds };
      return { capture: true };
    }
    if (!pressed || (event.type !== "drag" && event.type !== "release" && event.type !== "click")) return;
    const bounds = this.bounds;
    const sameControl = action === pressed.action && sameBounds(bounds, pressed.bounds);
    if (event.type !== "release" || !sameControl) this.pressed = undefined;
    if (event.type === "click" && sameControl) {
      if (action === "close") this.options.controls?.close();
      else if (action === "maximize") this.toggleMaximized();
      else this.toggleMinimized();
    }
    return { handled: true };
  }

  private setMode(mode: WindowMode): void {
    if (this.mode === "normal") this.preferred ??= this.bounds;
    if (this.mode !== "minimized") this.expandedMode = this.mode;
    this.windowMode = mode;
    this.drag = undefined;
    this.bodyPress = false;
    this.pressed = undefined;
    this.focused = this.isFocused;
    this.options.requestRender();
  }

  private terminalSize(): FloatingViewport {
    const { columns, rows } = this.options.getTerminalSize();
    return { columns: nonnegativeInteger(columns), rows: nonnegativeInteger(rows) };
  }

  private fitBounds(bounds: FloatingBounds, size: FloatingViewport): FloatingBounds {
    const width = clamp(bounds.width, this.options.minSize.columns, size.columns);
    const height = clamp(bounds.height, this.options.minSize.rows, size.rows);
    return {
      width,
      height,
      col: clamp(bounds.col, 0, size.columns - width),
      row: clamp(bounds.row, 0, size.rows - height),
    };
  }

  private moveFrom(start: FloatingBounds, dx: number, dy: number): void {
    this.preferred = this.fitBounds({ ...start, col: start.col + dx, row: start.row + dy }, this.terminalSize());
    this.options.requestRender();
  }

  private resizeFrom(
    start: FloatingBounds,
    dx: number,
    dy: number,
    horizontal: ResizeDirection,
    vertical: ResizeDirection,
  ): void {
    const size = this.terminalSize();
    const bounds = this.fitBounds(start, size);
    const [col, width] = resizeAxis(
      bounds.col,
      bounds.width,
      dx,
      this.options.minSize.columns,
      size.columns,
      horizontal,
    );
    const [row, height] = resizeAxis(bounds.row, bounds.height, dy, this.options.minSize.rows, size.rows, vertical);
    this.preferred = { col, row, width, height };
    this.options.requestRender();
  }
}

function sameBounds(a: FloatingBounds, b: FloatingBounds): boolean {
  return a.col === b.col && a.row === b.row && a.width === b.width && a.height === b.height;
}

function resizeAxis(
  origin: number,
  length: number,
  delta: number,
  min: number,
  limit: number,
  direction: ResizeDirection,
): [number, number] {
  if (direction === 0) return [origin, length];
  if (direction === 1) return [origin, clamp(length + delta, min, limit - origin)];
  const end = origin + length;
  const nextLength = clamp(length - delta, min, end);
  return [end - nextLength, nextLength];
}

function hasFrame(width: number, height: number): boolean {
  return width >= 3 && height >= 3;
}

function innerViewport(width: number, height: number): FloatingViewport {
  const inset = hasFrame(width, height) ? 2 : 0;
  return { columns: width - inset, rows: height - inset };
}

function nonnegativeInteger(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(nonnegativeInteger(max), Math.max(nonnegativeInteger(min), nonnegativeInteger(value)));
}
