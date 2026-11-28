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

  get bounds(): FloatingBounds {
    const size = this.terminalSize();
    return this.fitBounds(this.preferred ?? this.options.initialBounds(size), size);
  }

  get viewport(): FloatingViewport {
    const { width, height } = this.bounds;
    return innerViewport(width, height);
  }

  get focused(): boolean {
    return this.isFocused;
  }

  set focused(value: boolean) {
    this.isFocused = value;
    this.options.body.setFocused?.(value);
  }

  move(dx: number, dy: number): void {
    this.moveFrom(this.bounds, dx, dy);
  }

  resize(dx: number, dy: number): void {
    this.resizeFrom(this.bounds, dx, dy, 1, 1);
  }

  invalidate(): void {
    this.options.body.invalidate();
  }

  handleInput(data: string): void {
    this.options.body.handleInput?.(data);
  }

  render(width: number): string[] {
    const { height } = this.bounds;
    width = nonnegativeInteger(width);
    if (width === 0 || height === 0) return [];
    const viewport = innerViewport(width, height);
    const inset = hasFrame(width, height);
    const body = this.options.body.render(viewport);
    const border = (text: string) => this.options.styleBorder(text);
    const lines = Array.from({ length: viewport.rows }, (_, row) => {
      const line = truncateToWidth(body[row] ?? "", viewport.columns, "", true);
      return inset ? border("│") + line + border("│") : line;
    });
    if (!inset) return lines;
    const label = this.titleLabel(viewport.columns);
    return [
      border("╭─") +
        this.options.styleTitle(label) +
        border(`${"─".repeat(viewport.columns - 1 - visibleWidth(label))}╮`),
      ...lines,
      border(`╰${"─".repeat(viewport.columns - 1)}◢╯`),
    ];
  }

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    if (this.drag && (event.type === "drag" || event.type === "release")) {
      const { start, x, y, horizontal, vertical } = this.drag;
      const dx = event.screenX - x;
      const dy = event.screenY - y;
      if (event.type === "release") this.drag = undefined;
      if (horizontal || vertical) this.resizeFrom(start, dx, dy, horizontal, vertical);
      else this.moveFrom(start, dx, dy);
      return { handled: true };
    }
    const { x, y, width, height } = event;
    const framed = hasFrame(width, height);
    if (event.type === "press") {
      this.drag = undefined;
      this.bodyPress = false;
      if (event.button === "left" && framed && x >= 0 && x < width && y >= 0 && y < height) {
        const bottom = y === height - 1;
        const horizontal = x === 0 ? -1 : x === width - 1 || (bottom && x === width - 2) ? 1 : 0;
        const onTitle = y === 0 && x >= 2 && x < 2 + visibleWidth(this.titleLabel(width - 2));
        const vertical = onTitle ? 0 : y === 0 ? -1 : bottom ? 1 : 0;
        if (horizontal || vertical || onTitle) {
          this.drag = { start: this.bounds, x: event.screenX, y: event.screenY, horizontal, vertical };
          return this.options.focusOnDrag ? { capture: true, focus: true } : { capture: true };
        }
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

  private titleLabel(innerColumns: number): string {
    return truncateToWidth(this.options.title(innerColumns).trimEnd(), innerColumns - 1, "");
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
