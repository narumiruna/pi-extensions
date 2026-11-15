import type { Theme } from "@earendil-works/pi-coding-agent";
import {
  type Component,
  getOsc8LinkAtColumn,
  type TuiMouseEvent,
  type TuiMouseEventResult,
} from "@earendil-works/pi-tui";
import { EditorStatusWidget, type EditorStatusWidgetState } from "@narumitw/pi-tui-kit/editor-status-widget";
import type { PiPane } from "./rex-snapshot.js";
import { layoutRexWidget, type RexDisplay, type RexLocation, rexSummary } from "./rex-widget.js";

interface Options {
  display(): RexDisplay;
  theme(): Theme;
  rows(): number;
  isCurrent(): boolean;
  state: EditorStatusWidgetState;
  here: RexLocation;
  navigate(target: PiPane): void;
  disposed(): void;
}

interface Layout {
  width: number;
  lines: string[];
  targets: (PiPane | undefined)[];
  display: RexDisplay;
}

/** Retains Kit framing, but reserves disclosure for the divider and body clicks for exact agents. */
export class RexAgentWidget implements Component {
  private readonly frame: EditorStatusWidget;
  private body: string[] = [];
  private summary = "";
  private layout?: Layout;
  private press?: { event: TuiMouseEvent; target: PiPane };
  private stopped = false;
  private rendering = 0;
  private revision = 0;

  constructor(private readonly options: Options) {
    const owner = this;
    this.frame = new EditorStatusWidget({
      name: "Rex",
      state: options.state,
      get theme() {
        return options.theme();
      },
      get summary() {
        return owner.summary;
      },
      renderBody: () => this.body,
    });
  }

  private current() {
    return !this.stopped && this.options.isCurrent();
  }

  render(width: number): string[] {
    if (!this.current()) return [];
    this.rendering++;
    const revision = this.revision;
    try {
      const display = this.options.display();
      const columns = Number.isFinite(width) ? Math.max(0, Math.floor(width)) : 0;
      const rendered = layoutRexWidget(display, this.options.theme(), columns, this.options.rows(), this.options.here);
      if (!this.current() || revision !== this.revision || this.options.display() !== display) return [];
      this.body = rendered.lines.slice(1);
      this.summary = rexSummary(display);
      const lines = this.frame.render(columns);
      if (!this.current() || revision !== this.revision || this.options.display() !== display) {
        this.invalidate();
        return [];
      }
      const targets = this.frame.collapsed ? [undefined] : rendered.targets;
      const previous = this.layout;
      if (
        !previous ||
        previous.width !== columns ||
        previous.display !== display ||
        previous.lines.length !== lines.length ||
        previous.lines.some((line, index) => line !== lines[index])
      )
        this.press = undefined;
      this.layout = { width: columns, lines, targets, display };
      return lines;
    } catch (error) {
      this.invalidate();
      throw error;
    } finally {
      this.rendering--;
    }
  }

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    if (this.rendering > 0) return undefined;
    const pressed = this.press;
    if (event.type !== "move") this.press = undefined;
    const layout = this.layout;
    if (!this.current() || !layout || this.options.display() !== layout.display) return undefined;
    // Invalid body coordinates clear Kit's previous divider press without letting a body click collapse it.
    const disclosure = this.frame.handleMouse(event.y === 0 ? event : { ...event, y: -1 });
    if (event.y === 0) {
      this.press = undefined;
      if (disclosure?.handled) this.layout = undefined;
      return disclosure;
    }
    if (this.frame.collapsed) return undefined;
    if (event.type === "move") {
      if (
        pressed &&
        !event.shift &&
        !event.ctrl &&
        !event.alt &&
        pressed.event.x === event.x &&
        pressed.event.y === event.y &&
        pressed.event.screenX === event.screenX &&
        pressed.event.screenY === event.screenY &&
        pressed.event.width === event.width &&
        pressed.event.height === event.height
      )
        this.press = pressed;
      else this.press = undefined;
      return undefined;
    }
    const target = layout.targets[event.y];
    if (
      !target ||
      !Number.isInteger(event.x) ||
      !Number.isInteger(event.y) ||
      event.width !== layout.width ||
      event.x < 0 ||
      event.x >= layout.width ||
      event.y < 1 ||
      event.y >= Math.min(layout.lines.length, event.height) ||
      event.shift ||
      event.ctrl ||
      event.alt ||
      (event.button !== "left" && !(event.button === "none" && (event.type === "release" || event.type === "click"))) ||
      getOsc8LinkAtColumn(layout.lines[event.y] ?? "", event.x) !== undefined
    )
      return undefined;
    if (event.type === "press") {
      this.press = { event: { ...event }, target };
      return undefined;
    }
    if (
      !pressed ||
      pressed.target !== target ||
      ["x", "y", "screenX", "screenY", "width", "height"].some(
        (key) => pressed.event[key as keyof TuiMouseEvent] !== event[key as keyof TuiMouseEvent],
      )
    )
      return undefined;
    if (event.type === "release") this.press = pressed;
    if (event.type !== "click") return undefined;
    this.options.navigate(target);
    return { handled: true };
  }

  invalidate() {
    this.revision++;
    this.layout = undefined;
    this.press = undefined;
    this.frame.invalidate();
  }

  dispose() {
    if (this.stopped) return;
    this.stopped = true;
    this.frame.dispose();
    this.layout = undefined;
    this.press = undefined;
    this.options.disposed();
  }
}
