import { type ExtensionContext, getMarkdownTheme, type Theme } from "@earendil-works/pi-coding-agent";
import {
  type Component,
  Markdown,
  ScrollView,
  type TUI,
  type TuiMouseEvent,
  truncateToWidth,
} from "@earendil-works/pi-tui";
import { sanitizeTerminalDocument } from "@narumitw/pi-tui-kit/terminal-document";
import { mountFullscreenPlanLayout, type PlanPaneSide } from "./fullscreen-plan-layout.js";

const WIDGET_KEY = "plan-mode.pane";

interface PaneBinding {
  session: ExtensionContext["sessionManager"];
  ui: ExtensionContext["ui"];
  side: PlanPaneSide;
  plan: string | undefined;
  widget?: PlanPaneWidget;
}

export function createPlanPaneController() {
  let binding: PaneBinding | undefined;

  function clear() {
    const previous = binding;
    binding = undefined;
    if (!previous) return;
    previous.widget?.dispose();
    try {
      previous.ui.setWidget(WIDGET_KEY, undefined);
    } catch {
      return;
    }
  }

  return {
    clear,
    update(ctx: ExtensionContext, placement: PlanPaneSide | "off", plan: string | undefined) {
      if (ctx.mode !== "tui" || !ctx.hasUI || placement === "off") {
        clear();
        return;
      }
      if (
        binding?.session === ctx.sessionManager &&
        binding.ui === ctx.ui &&
        binding.side === placement &&
        !binding.widget?.disposed
      ) {
        binding.plan = plan;
        binding.widget?.setPlan(plan);
        return;
      }
      clear();
      const owner: PaneBinding = { session: ctx.sessionManager, ui: ctx.ui, side: placement, plan };
      binding = owner;
      try {
        ctx.ui.setWidget(WIDGET_KEY, (tui, theme) => {
          if (binding !== owner) return { render: () => [], invalidate() {} };
          owner.widget?.dispose();
          owner.widget = new PlanPaneWidget(tui, theme, owner.side, owner.plan);
          return owner.widget;
        });
      } catch {
        clear();
      }
    },
  };
}

class PlanPaneWidget implements Component {
  disposed = false;
  private readonly body: PlanPaneBody;
  private readonly scroll: PlanPaneScrollView;
  private readonly attempted = new WeakSet<readonly Component[]>();
  private pending: readonly Component[] | undefined;
  private restore: (() => void) | undefined;

  constructor(
    private readonly tui: TUI,
    private readonly theme: Theme,
    private readonly side: PlanPaneSide,
    private plan: string | undefined,
  ) {
    this.body = new PlanPaneBody(theme);
    this.body.setPlan(plan);
    this.scroll = new PlanPaneScrollView(this.body, {
      overscroll: "contain",
      scrollbar: "always",
      scrollbarTrackStyle: (text) => theme.fg("scrollbarTrack", text),
      scrollbarThumbStyle: (text) => theme.fg("scrollbarThumb", text),
    });
    this.observeRenderer();
  }

  render(): string[] {
    this.observeRenderer();
    return [];
  }

  invalidate(): void {}

  setPlan(plan: string | undefined) {
    if (this.disposed || plan === this.plan) return;
    this.plan = plan;
    this.body.setPlan(plan);
    this.scroll.scrollToStart();
    if (this.tui?.mode === "fullscreen") this.tui.requestRender();
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.pending = undefined;
    this.unmount();
  }

  private observeRenderer() {
    if (this.disposed || !this.tui || this.tui.mode !== "fullscreen") return;
    const renderer = this.tui.children;
    if (this.pending === renderer || this.attempted.has(renderer)) return;
    this.pending = renderer;
    queueMicrotask(() => {
      if (this.disposed || this.pending !== renderer) return;
      this.pending = undefined;
      if (this.tui.mode !== "fullscreen" || this.tui.children !== renderer) return;
      this.attempted.add(renderer);
      this.unmount();
      try {
        this.restore = mountFullscreenPlanLayout(this.tui, renderer, this.side, this.scroll, this.theme);
      } catch {
        return;
      }
    });
  }

  private unmount() {
    const restore = this.restore;
    this.restore = undefined;
    try {
      restore?.();
    } catch {
      return;
    }
  }
}

class PlanPaneScrollView extends ScrollView {
  override handleMouse(event: TuiMouseEvent): ReturnType<ScrollView["handleMouse"]> {
    if (event.type !== "wheel") return;
    this.scrollBy(event.wheelDelta ?? 0);
    return {
      handled: true,
      render: false,
      target: {
        component: this,
        originX: event.screenX - event.x,
        originY: event.screenY - event.y,
        width: event.width,
        height: event.height,
      },
    };
  }
}

class PlanPaneBody implements Component {
  private text: string | undefined;
  private markdown: Markdown | undefined;
  private width: number | undefined;
  private lines: string[] = [];

  constructor(private readonly theme: Theme) {}

  setPlan(plan: string | undefined) {
    this.text = plan === undefined ? undefined : sanitizeTerminalDocument(plan);
    this.invalidate();
  }

  invalidate() {
    this.markdown = undefined;
    this.width = undefined;
    this.lines = [];
  }

  render(width: number): readonly string[] {
    if (width < 1) return [];
    if (this.width === width) return this.lines;
    const title = this.theme.bold(this.theme.fg("accent", "Plan"));
    if (this.text) this.markdown ??= new Markdown(this.text, 0, 0, getMarkdownTheme());
    const body = this.markdown?.render(width) ?? [this.theme.fg("muted", "No completed plan yet.")];
    this.width = width;
    this.lines = [title, "", ...body].map((line) => truncateToWidth(line, width));
    return this.lines;
  }
}
