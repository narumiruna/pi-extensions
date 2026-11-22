import { type ExtensionContext, getMarkdownTheme, type Theme } from "@earendil-works/pi-coding-agent";
import * as tuiCore from "@earendil-works/pi-tui";
import {
  type Component,
  Markdown,
  type ScrollView,
  type TUI,
  type TuiMouseEvent,
  truncateToWidth,
} from "@earendil-works/pi-tui";
import { sanitizeTerminalDocument } from "@narumitw/pi-tui-kit/terminal-document";
import { type MountedPlanLayout, mountFullscreenPlanLayout, type PlanPaneSide } from "./fullscreen-plan-layout.js";
import type { DraftPreview } from "./plan-draft.js";

type PlanPaneContent = string | DraftPreview | undefined;

const WIDGET_KEY = "plan-mode.pane";

interface PaneBinding {
  session: ExtensionContext["sessionManager"];
  ui: ExtensionContext["ui"];
  side: PlanPaneSide;
  plan: PlanPaneContent;
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
    showsCompletedPlan(session: ExtensionContext["sessionManager"], plan: string) {
      return binding?.session === session && binding.widget?.showsCompletedPlan(plan) === true;
    },
    update(ctx: ExtensionContext, placement: PlanPaneSide | "off", plan: PlanPaneContent) {
      if (ctx.mode !== "tui" || !ctx.hasUI || placement === "off" || typeof tuiCore.ScrollView !== "function") {
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
  private readonly scroll: ScrollView;
  private readonly attempted = new WeakSet<readonly Component[]>();
  private pending: readonly Component[] | undefined;
  private layout: MountedPlanLayout | undefined;
  private hasDisplayablePlan = false;

  constructor(
    private readonly tui: TUI,
    private readonly theme: Theme,
    private readonly side: PlanPaneSide,
    private plan: PlanPaneContent,
  ) {
    this.body = new PlanPaneBody(theme);
    this.hasDisplayablePlan = this.body.setPlan(plan);
    this.scroll = createPaneScrollView(this.body, {
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

  invalidate(): void {
    this.scroll.invalidate();
  }

  setPlan(plan: PlanPaneContent) {
    if (this.disposed || plan === this.plan) return;
    this.plan = plan;
    this.hasDisplayablePlan = this.body.setPlan(plan);
    this.scroll.scrollToStart();
    if (this.tui?.mode === "fullscreen") this.tui.requestRender();
  }

  showsCompletedPlan(plan: string) {
    return !this.disposed && this.plan === plan && this.hasDisplayablePlan && this.layout?.isVisible() === true;
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
        this.layout = mountFullscreenPlanLayout(this.tui, renderer, this.side, this.scroll, this.theme);
      } catch {
        return;
      }
    });
  }

  private unmount() {
    const layout = this.layout;
    this.layout = undefined;
    try {
      layout?.restore();
    } catch {
      return;
    }
  }
}

function createPaneScrollView(...args: ConstructorParameters<typeof tuiCore.ScrollView>): ScrollView {
  const scroll = new tuiCore.ScrollView(...args);
  scroll.handleMouse = (event: TuiMouseEvent) => {
    if (event.type !== "wheel") return;
    scroll.scrollBy(event.wheelDelta ?? 0);
    return {
      handled: true,
      render: false,
      target: {
        component: scroll,
        originX: event.screenX - event.x,
        originY: event.screenY - event.y,
        width: event.width,
        height: event.height,
      },
    };
  };
  return scroll;
}

class PlanPaneBody implements Component {
  private text: string | undefined;
  private title = "Plan";
  private placeholder = "No completed plan yet.";
  private markdown: Markdown | undefined;
  private width: number | undefined;
  private lines: string[] = [];

  constructor(private readonly theme: Theme) {}

  setPlan(plan: PlanPaneContent) {
    const text = typeof plan === "string" ? plan : plan?.kind === "draft" ? plan.text : undefined;
    this.text = text === undefined ? undefined : sanitizeTerminalDocument(text);
    this.title = typeof plan === "string" ? "Plan · Ready" : plan ? "Plan draft" : "Plan";
    this.placeholder =
      typeof plan === "object"
        ? plan.kind === "error"
          ? plan.reason
          : "Waiting for the Markdown draft."
        : "No completed plan yet.";
    this.invalidate();
    return Boolean(this.text?.trim());
  }

  invalidate() {
    this.markdown = undefined;
    this.width = undefined;
    this.lines = [];
  }

  render(width: number): readonly string[] {
    if (width < 1) return [];
    if (this.width === width) return this.lines;
    const title = this.theme.bold(this.theme.fg("accent", this.title));
    if (this.text) this.markdown ??= new Markdown(this.text, 0, 0, getMarkdownTheme());
    const body =
      this.markdown?.render(width) ??
      new Markdown(sanitizeTerminalDocument(this.placeholder), 0, 0, getMarkdownTheme(), {
        color: (text) => this.theme.fg("muted", text),
      }).render(width);
    this.width = width;
    this.lines = [title, "", ...body].map((line) => truncateToWidth(line, width));
    return this.lines;
  }
}
