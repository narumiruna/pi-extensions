import {
  type Component,
  type Focusable,
  type OverlayOptions,
  type TuiMouseEvent,
  type TuiMouseEventResult,
  truncateToWidth,
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

export class FloatingFrame implements Component, Focusable {
  readonly overlayOptions: OverlayOptions;
  private preferred: FloatingBounds | undefined;
  private drag: { start: FloatingBounds; x: number; y: number; resize: boolean } | undefined;
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
    const preferred = this.preferred ?? this.options.initialBounds(size);
    const width = clamp(preferred.width, this.options.minSize.columns, size.columns);
    const height = clamp(preferred.height, this.options.minSize.rows, size.rows);
    return {
      width,
      height,
      col: clamp(preferred.col, 0, size.columns - width),
      row: clamp(preferred.row, 0, size.rows - height),
    };
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
    this.adjust(this.bounds, dx, dy, false);
  }

  resize(dx: number, dy: number): void {
    this.adjust(this.bounds, dx, dy, true);
  }

  invalidate(): void {
    this.options.body.invalidate();
  }

  handleInput(data: string): void {
    this.options.body.handleInput?.(data);
  }

  render(width: number): string[] {
    const { height } = this.bounds;
    if (width <= 0 || height <= 0) return [];
    const viewport = innerViewport(width, height);
    const inset = hasFrame(width, height);
    const body = this.options.body.render(viewport);
    const border = (text: string) => this.options.styleBorder(text);
    const lines = Array.from({ length: viewport.rows }, (_, row) => {
      const line = truncateToWidth(body[row] ?? "", viewport.columns, "", true);
      return inset ? border("│") + line + border("│") : line;
    });
    if (!inset) return lines;
    const label = truncateToWidth(this.options.title(viewport.columns), viewport.columns, "", true);
    return [
      border("╭") + this.options.styleTitle(label) + border("╮"),
      ...lines,
      border(`╰${"─".repeat(viewport.columns - 1)}◢╯`),
    ];
  }

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    if (this.drag && (event.type === "drag" || event.type === "release")) {
      const { start, x, y, resize } = this.drag;
      this.adjust(start, event.screenX - x, event.screenY - y, resize);
      if (event.type === "release") this.drag = undefined;
      return { handled: true };
    }
    const framed = hasFrame(event.width, event.height);
    if (event.type === "press") {
      this.drag = undefined;
      this.bodyPress = false;
      const resize = event.x >= event.width - 2 && event.y === event.height - 1;
      if (event.button === "left" && framed && (resize || event.y === 0)) {
        this.drag = { start: this.bounds, x: event.screenX, y: event.screenY, resize };
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

  private terminalSize(): FloatingViewport {
    const { columns, rows } = this.options.getTerminalSize();
    return { columns: nonnegativeInteger(columns), rows: nonnegativeInteger(rows) };
  }

  private adjust(start: FloatingBounds, dx: number, dy: number, resize: boolean): void {
    const { columns, rows } = this.terminalSize();
    const { width, height } = start;
    const col = clamp(start.col, 0, columns - nonnegativeInteger(this.options.minSize.columns));
    const row = clamp(start.row, 0, rows - nonnegativeInteger(this.options.minSize.rows));
    this.preferred = resize
      ? {
          col,
          row,
          width: clamp(width + dx, this.options.minSize.columns, columns - col),
          height: clamp(height + dy, this.options.minSize.rows, rows - row),
        }
      : {
          width,
          height,
          col: clamp(start.col + dx, 0, Math.max(0, columns - width)),
          row: clamp(start.row + dy, 0, Math.max(0, rows - height)),
        };
    this.options.requestRender();
  }
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
