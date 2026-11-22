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
import { getDraftChanges, renderDraftChanges } from "./plan-pane-diff.js";

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
      if (
        ctx.mode !== "tui" ||
        !ctx.hasUI ||
        placement === "off" ||
        typeof tuiCore.ScrollView !== "function" ||
        typeof tuiCore.VStack !== "function"
      ) {
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
  private readonly pane: Component;
  private togglePress: ReturnType<MountedPlanLayout["interactionViewport"]>;

  constructor(
    private readonly tui: TUI,
    private readonly theme: Theme,
    private readonly side: PlanPaneSide,
    private plan: PlanPaneContent,
  ) {
    this.body = new PlanPaneBody(theme);
    this.body.setPlan(plan, false);
    this.scroll = createPaneScrollView(this.body, {
      overscroll: "contain",
      scrollbar: "always",
      scrollbarTrackStyle: (text) => theme.fg("scrollbarTrack", text),
      scrollbarThumbStyle: (text) => theme.fg("scrollbarThumb", text),
    });
    const toggle: Component = {
      render: (width) => {
        const label = this.body.toggleLabel();
        return width < 1 || !label ? [] : [truncateToWidth(theme.fg("accent", label), width)];
      },
      invalidate() {},
      handleMouse: (event) => this.handleToggleMouse(event),
    };
    this.pane = new tuiCore.VStack([
      { component: toggle, basis: 1, shrink: 0, visible: () => this.body.toggleLabel() !== undefined },
      { component: this.scroll, basis: 0, grow: 1, minSize: 1 },
    ]);
    this.observeRenderer();
  }

  render(): string[] {
    this.observeRenderer();
    return [];
  }

  invalidate(): void {
    this.pane.invalidate();
  }

  setPlan(plan: PlanPaneContent) {
    if (this.disposed || plan === this.plan) return;
    this.plan = plan;
    if (!this.body.setPlan(plan, this.layout?.isVisible() === true)) return;
    this.togglePress = undefined;
    this.scroll.scrollToStart();
    if (this.tui?.mode === "fullscreen") this.tui.requestRender();
  }

  showsCompletedPlan(plan: string) {
    return !this.disposed && this.plan === plan && this.body.hasDisplayableText() && this.layout?.isVisible() === true;
  }

  private handleToggleMouse(event: TuiMouseEvent) {
    if (this.disposed) return;
    const viewport = this.layout?.interactionViewport();
    const label = this.body.toggleLabel();
    if (!viewport || !label) return;
    if (event.type === "wheel") return this.scroll.handleMouse(event);
    if (event.button !== "left" || event.y !== 0 || event.x < 0 || event.x >= label.length) return;
    if (event.type === "press") {
      this.togglePress = viewport;
      return { handled: true, render: false };
    }
    if (event.type !== "click") return;
    const press = this.togglePress;
    this.togglePress = undefined;
    if (viewport !== press) return;
    this.body.toggleView();
    this.scroll.scrollToStart();
    return { handled: true, render: true };
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
        this.layout = mountFullscreenPlanLayout(this.tui, renderer, this.side, this.pane, this.theme);
      } catch {
        return;
      }
    });
  }

  private unmount() {
    const layout = this.layout;
    this.layout = undefined;
    this.togglePress = undefined;
    if (this.body.clearComparison() && !this.disposed) this.scroll.scrollToStart();
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
  private isDraft = false;
  private displayableText = false;
  private changes: readonly string[] | undefined;
  private showingChanges = false;
  private title = "Plan";
  private placeholder = "No completed plan yet.";
  private markdown: Markdown | undefined;
  private width: number | undefined;
  private lines: string[] = [];

  constructor(private readonly theme: Theme) {}

  setPlan(plan: PlanPaneContent, compare: boolean) {
    const raw = typeof plan === "string" ? plan : plan?.kind === "draft" ? plan.text : undefined;
    const text = raw === undefined ? undefined : sanitizeTerminalDocument(raw);
    const isDraft = typeof plan === "object" && plan.kind === "draft";
    if (isDraft && this.isDraft && text === this.text) return false;
    const previousDraft = compare && this.isDraft && this.displayableText ? this.text : undefined;
    this.text = text;
    this.isDraft = isDraft;
    this.displayableText = Boolean(text?.trim());
    this.changes =
      isDraft && previousDraft && this.displayableText && text ? getDraftChanges(previousDraft, text) : undefined;
    this.showingChanges = this.changes !== undefined;
    this.title = typeof plan === "string" ? "Plan · Ready" : plan ? "Plan draft" : "Plan";
    this.placeholder =
      typeof plan === "object"
        ? plan.kind === "error"
          ? plan.reason
          : "Waiting for the Markdown draft."
        : "No completed plan yet.";
    this.invalidate();
    return true;
  }

  hasDisplayableText() {
    return this.displayableText;
  }

  toggleLabel() {
    return this.changes === undefined ? undefined : this.showingChanges ? "[Show Markdown]" : "[Show changes]";
  }

  toggleView() {
    this.showingChanges = !this.showingChanges;
    this.invalidate();
  }

  clearComparison() {
    if (this.changes === undefined) return false;
    this.changes = undefined;
    this.showingChanges = false;
    this.invalidate();
    return true;
  }

  invalidate() {
    this.markdown = undefined;
    this.width = undefined;
    this.lines = [];
  }

  render(width: number): readonly string[] {
    if (width < 1) return [];
    if (this.width === width) return this.lines;
    const title = this.showingChanges ? "Plan draft · Changes" : this.title;
    const body =
      this.showingChanges && this.changes
        ? renderDraftChanges(this.changes, width, this.theme)
        : this.renderMarkdown(width);
    this.width = width;
    this.lines = [this.theme.bold(this.theme.fg("accent", title)), "", ...body].map((line) =>
      truncateToWidth(line, width),
    );
    return this.lines;
  }

  private renderMarkdown(width: number): readonly string[] {
    this.markdown ??= this.text
      ? new Markdown(this.text, 0, 0, getMarkdownTheme())
      : new Markdown(sanitizeTerminalDocument(this.placeholder), 0, 0, getMarkdownTheme(), {
          color: (text) => this.theme.fg("muted", text),
        });
    return this.markdown.render(width);
  }
}
