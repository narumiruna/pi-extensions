import type { Theme } from "@earendil-works/pi-coding-agent";
import {
  type Component,
  getOsc8LinkAtColumn,
  type TuiMouseEvent,
  type TuiMouseEventResult,
  truncateToWidth,
} from "@earendil-works/pi-tui";
import { HorizontalRule, type HorizontalRuleOptions } from "./horizontal-rule.js";
import { sanitizeTerminalText } from "./terminal-text.js";

/** Owner-local presentation state; retain it when replacing a widget component. */
export interface EditorStatusWidgetState {
  collapsed: boolean;
}

export interface EditorStatusWidgetOptions {
  /** Active callback theme used for the standard muted editor divider. */
  theme: Pick<Theme, "fg">;
  /** A name enables the labeled divider and whole-widget collapse control. */
  name?: string;
  /** Optional owner-local state shared by successive mounts, never by unrelated widgets. */
  state?: EditorStatusWidgetState;
  /** Render extension-owned body rows for the normalized terminal width. */
  renderBody(width: number): readonly string[];
}

/** Width-safe editor status frame with optional, unfocused mouse disclosure. */
export class EditorStatusWidget implements Component {
  private readonly options: EditorStatusWidgetOptions;
  private readonly state: EditorStatusWidgetState;
  private readonly name: string;
  private readonly rule: HorizontalRule;
  private readonly ruleOptions: HorizontalRuleOptions;
  private layout: { width: number; lines: string[] } | undefined;
  private pressVersion: number | undefined;
  private invalidation = 0;
  private disposed = false;

  constructor(options: EditorStatusWidgetOptions) {
    this.options = options;
    this.state = options.state ?? { collapsed: false };
    this.name = sanitizeTerminalText(options.name ?? "").trim();
    this.ruleOptions = {
      labelAlignment: "left",
      ruleStyle: (text) => this.options.theme.fg("borderMuted", text),
      labelStyle: (text) => this.options.theme.fg("muted", text),
    };
    this.rule = new HorizontalRule(this.ruleOptions);
  }

  get collapsed(): boolean {
    return this.name !== "" && this.state.collapsed;
  }

  /** Call from an owner keyboard action, then request a host render when this returns true. */
  setCollapsed(collapsed: boolean): boolean {
    if (this.disposed || !this.name || this.state.collapsed === collapsed) return false;
    this.state.collapsed = collapsed;
    this.invalidate();
    return true;
  }

  invalidate() {
    this.invalidation++;
    this.layout = undefined;
    this.rule.invalidate();
  }

  render(width: number): string[] {
    if (this.disposed) return [];
    this.invalidate();
    const renderWidth = normalizeWidth(width);
    const body = this.collapsed ? [] : this.options.renderBody(renderWidth);
    if (this.disposed) return [];
    // A body callback can change disclosure. Build the label and visible body
    // from the current state, not the state before that callback.
    this.ruleOptions.label = this.name ? `${this.collapsed ? "▸" : "▾"} ${this.name}` : undefined;
    const visibleBody = this.collapsed ? [] : body;
    const version = this.invalidation;
    const lines = [
      ...this.rule.render(renderWidth),
      ...visibleBody.map((line) => truncateToWidth(line, renderWidth, "")),
    ];
    if (this.disposed || this.invalidation !== version) return [];
    this.layout = { width: renderWidth, lines };
    return lines;
  }

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    const layout = this.layout;
    if (
      this.disposed ||
      !this.name ||
      !layout ||
      event.width !== layout.width ||
      !Number.isInteger(event.x) ||
      !Number.isInteger(event.y) ||
      event.x < 0 ||
      event.x >= layout.width ||
      event.y < 0 ||
      event.y >= Math.min(layout.lines.length, event.height) ||
      event.button !== "left" ||
      event.shift ||
      event.alt ||
      event.ctrl ||
      getOsc8LinkAtColumn(layout.lines[event.y] ?? "", event.x) !== undefined
    )
      return undefined;
    // Accept the press so Pi can synthesize a click on release. Never take
    // keyboard focus or toggle on press: a drag is not a click.
    if (event.type === "press") {
      this.pressVersion = this.invalidation;
      return { handled: true, render: false };
    }
    if (event.type !== "click") return undefined;
    // Pi retains the press target's old screen origin until release. A redraw
    // can move this widget, so do not accept a click from that old geometry.
    const cancelled = this.pressVersion !== undefined && this.pressVersion !== this.invalidation;
    this.pressVersion = undefined;
    if (cancelled) return { handled: true, render: false };
    return this.setCollapsed(!this.collapsed) ? { handled: true, render: true } : undefined;
  }

  dispose() {
    this.disposed = true;
    this.invalidate();
  }
}

function normalizeWidth(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}
