import type { ExtensionCommandContext, KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import {
  type Component,
  isKeyRelease,
  matchesKey,
  type OverlayHandle,
  type TUI,
  type TuiMouseEvent,
  type TuiMouseEventResult,
} from "@earendil-works/pi-tui";
import { HorizontalRule, renderBoundedFrameLayout } from "@narumitw/pi-tui-kit";
import { demoHasHardCancel, HARD_CANCEL_WARNING } from "./hard-cancel.js";

interface NativeDemoOptions {
  signal: AbortSignal;
  isCurrent(): boolean;
}

/** Native Pi routing only: the caller owns session replacement/shutdown cancellation. */
export async function runNativePointerDemo(ctx: ExtensionCommandContext, options: NativeDemoOptions): Promise<void> {
  if (ctx.mode !== "tui" || options.signal.aborted || !options.isCurrent()) return;
  let demo: NativePointerDemo | undefined;
  try {
    await ctx.ui.custom<void>(
      (tui, theme, keys, done) => {
        if (!demoHasHardCancel(tui, true)) {
          if (!options.signal.aborted && options.isCurrent() && ctx.hasUI)
            ctx.ui.notify(HARD_CANCEL_WARNING, "warning");
          done();
          return { render: () => [], invalidate() {} };
        }
        demo = new NativePointerDemo(tui, theme, keys, done, options);
        return demo;
      },
      {
        overlay: true,
        overlayOptions: { width: "90%", maxHeight: "90%", anchor: "center" },
        onHandle: () => demo?.checkCurrent(),
      },
    );
  } finally {
    demo?.dispose();
  }
}

class NativePointerDemo implements Component {
  private closed = false;
  private selected = 0;
  private handleWheel = true;
  private feedback = ["No normalized pointer event received.", "", "", ""];
  private nested: OverlayHandle | undefined;
  private removeInput: (() => void) | undefined;
  private readonly rule: HorizontalRule;
  private actionRows = new Map<number, number>();

  constructor(
    private readonly tui: TUI,
    private readonly theme: Theme,
    private readonly keys: KeybindingsManager,
    private readonly done: () => void,
    private readonly options: NativeDemoOptions,
  ) {
    this.rule = new HorizontalRule({ ruleStyle: (text) => theme.fg("border", text) });
    options.signal.addEventListener("abort", this.close, { once: true });
    // Observe hard cancellation before focused-component dispatch, including nested focus.
    // No input is logged, retained, parsed as mouse data, or replayed to another component.
    this.removeInput = tui.addInputListener((data) => {
      if (!this.checkCurrent()) return { consume: true };
      if (!isKeyRelease(data) && matchesKey(data, "ctrl+c")) {
        this.close();
        return { consume: true };
      }
      return undefined;
    });
    this.checkCurrent();
  }

  checkCurrent(): boolean {
    if (this.closed) return false;
    if (this.options.signal.aborted || !this.options.isCurrent()) {
      this.close();
      return false;
    }
    return true;
  }

  private readonly close = (): void => {
    if (this.closed) return;
    this.closed = true;
    this.options.signal.removeEventListener("abort", this.close);
    this.removeInput?.();
    this.removeInput = undefined;
    this.closeNested();
    // Only custom()'s completion callback removes its root overlay.
    this.done();
  };

  dispose(): void {
    this.close();
  }

  private closeNested(): void {
    const handle = this.nested;
    this.nested = undefined;
    handle?.hide();
  }

  handleInput(data: string): void {
    if (!this.checkCurrent() || isKeyRelease(data)) return;
    if (matchesKey(data, "ctrl+c") || this.keys.matches(data, "tui.select.cancel")) this.close();
    else if (this.keys.matches(data, "tui.select.up")) this.selected = (this.selected + 2) % 3;
    else if (this.keys.matches(data, "tui.select.down")) this.selected = (this.selected + 1) % 3;
    else if (this.keys.matches(data, "tui.select.confirm")) this.activate();
    this.tui.requestRender();
  }

  private activate(): void {
    if (this.selected === 0) this.handleWheel = !this.handleWheel;
    else if (this.selected === 1) this.openNested();
    else this.close();
  }

  private openNested(): void {
    if (this.nested || !this.checkCurrent()) return;
    const panel: Component = {
      render: (width) => this.frame(width, true),
      invalidate: () => this.rule.invalidate(),
      handleInput: (data) => {
        if (!this.checkCurrent() || isKeyRelease(data)) return;
        if (matchesKey(data, "ctrl+c")) this.close();
        else if (this.keys.matches(data, "tui.select.cancel") || this.keys.matches(data, "tui.select.confirm")) {
          this.closeNested();
        }
        this.tui.requestRender();
      },
      handleMouse: (event) => this.pointer(event, true),
    };
    this.nested = this.tui.showOverlay(panel, {
      width: "70%",
      maxHeight: "70%",
      anchor: "top-center",
    });
  }

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    return this.pointer(event, false);
  }

  private pointer(event: TuiMouseEvent, nested: boolean): TuiMouseEventResult | undefined {
    if (!this.checkCurrent()) return undefined;
    const result: TuiMouseEventResult | undefined =
      event.type === "wheel"
        ? this.handleWheel
          ? { handled: true }
          : undefined
        : event.type === "press" && event.button === "left"
          ? { handled: true, capture: true, focus: true }
          : event.type === "move"
            ? undefined
            : { handled: true };
    // Keep only allowlisted normalized fields. Never retain raw terminal input or event objects.
    this.feedback = [
      `${event.type} ${nested ? "nested" : "root"}`,
      `local=${event.x},${event.y} screen=${event.screenX},${event.screenY}`,
      `button=${event.button} shift=${event.shift} alt=${event.alt} ctrl=${event.ctrl}`,
      `handled=${result?.handled === true} capture=${result?.capture === true} focus=${result?.focus === true}`,
    ];
    if (!nested && event.type === "click" && event.button === "left") {
      const selected = this.actionRows.get(event.y);
      if (selected !== undefined) {
        this.selected = selected;
        this.activate();
      }
    }
    this.tui.requestRender();
    return result;
  }

  render(width: number): string[] {
    return this.frame(width, false);
  }

  private frame(width: number, nested: boolean): string[] {
    const labels = [
      `Wheel handling: ${this.handleWheel ? "handled (blocks fallback)" : "unhandled (native scroll fallback)"}`,
      "Open nested native overlay",
      "Close native demo",
    ];
    const content = nested
      ? ["Configured selection confirm/cancel closes only this nested overlay."]
      : labels.map((label, index) => (index === this.selected ? this.theme.fg("accent", `> ${label}`) : `  ${label}`));
    const rows = this.tui.terminal.rows;
    const maxRows = Number.isFinite(rows) ? Math.max(0, Math.floor(rows * (nested ? 0.7 : 0.9))) : 0;
    const layout = renderBoundedFrameLayout({
      width,
      maxRows,
      rule: this.rule.render(width)[0] ?? "",
      title: [
        this.theme.fg("accent", nested ? "Native nested overlay routing" : "Native pointer / wheel / overlay routing"),
      ],
      context: [
        this.theme.fg("muted", "Fullscreen: normalized pointer events. Regular: terminal owns mouse/scrollback."),
        this.theme.fg("muted", "Press/click here; drag beyond the overlay to inspect native capture."),
        ...this.feedback.map((line) => this.theme.fg("muted", line)),
      ],
      content,
      priorityRows: [nested ? 0 : this.selected],
      focusedRow: nested ? 0 : this.selected,
      hints: [
        this.theme.fg(
          "muted",
          nested
            ? "Configured select confirm/cancel: close this nested overlay."
            : "Configured select up/down: choose; confirm: activate; cancel: close.",
        ),
        this.theme.fg("muted", "Ctrl+C: close all demo overlays, including under nested focus."),
      ],
      compactHint: this.theme.fg("muted", "Ctrl+C: close native demo"),
    });
    if (!nested) {
      this.actionRows = new Map(layout.contentRows.map(({ contentIndex, frameIndex }) => [frameIndex, contentIndex]));
    }
    return layout.lines;
  }

  invalidate(): void {
    this.rule.invalidate();
    this.actionRows.clear();
  }
}
