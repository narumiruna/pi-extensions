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
import {
  canOpenFullscreenPlanLayout,
  type MountedPlanLayout,
  mountFullscreenPlanLayout,
  type PlanPaneSide,
} from "./fullscreen-plan-layout.js";
import type { DraftPreview } from "./plan-draft.js";
import { DEFAULT_PLAN_PANE_WIDTH_RATIO } from "./settings.js";

type PlanPaneContent = string | DraftPreview | undefined;
type PaneDocument = { raw: string; text: string; completed: boolean };

function paneDocument(content: PlanPaneContent): PaneDocument | undefined {
  const completed = typeof content === "string";
  const raw = completed ? content : content?.kind === "draft" ? content.text : undefined;
  if (raw === undefined) return;
  const text = sanitizeTerminalDocument(raw);
  if (text.trim()) return { raw, text, completed };
}

const WIDGET_KEY = "plan-mode.pane";

interface PaneBinding {
  session: ExtensionContext["sessionManager"];
  ui: ExtensionContext["ui"];
  side: PlanPaneSide;
  document: PaneDocument;
  widthRatio: number;
  onResize: ((ratio: number) => void) | undefined;
  widget?: PlanPaneWidget;
}

export function createPlanPaneController() {
  let binding: PaneBinding | undefined;
  let hidden = false;

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
    reset() {
      hidden = false;
      clear();
    },
    toggle(session: ExtensionContext["sessionManager"]) {
      if (binding?.session !== session || !binding.widget) return;
      if (binding.widget.setHidden(!hidden)) hidden = !hidden;
    },
    showsCompletedPlan(session: ExtensionContext["sessionManager"], plan: string) {
      return binding?.session === session && binding.widget?.showsCompletedPlan(plan) === true;
    },
    update(
      ctx: ExtensionContext,
      placement: PlanPaneSide | "off",
      plan: PlanPaneContent,
      widthRatio = DEFAULT_PLAN_PANE_WIDTH_RATIO,
      onResize?: (ratio: number) => void,
    ) {
      if (ctx.mode !== "tui" || !ctx.hasUI || placement === "off" || typeof tuiCore.ScrollView !== "function") {
        clear();
        return;
      }
      const document = paneDocument(plan);
      if (!document) {
        clear();
        return;
      }
      if (
        binding?.session === ctx.sessionManager &&
        binding.ui === ctx.ui &&
        binding.side === placement &&
        !binding.widget?.disposed
      ) {
        binding.document = document;
        binding.widthRatio = widthRatio;
        binding.onResize = onResize;
        binding.widget?.setDocument(document);
        binding.widget?.setWidthRatio(widthRatio);
        return;
      }
      clear();
      const owner: PaneBinding = {
        session: ctx.sessionManager,
        ui: ctx.ui,
        side: placement,
        document,
        widthRatio,
        onResize,
      };
      binding = owner;
      try {
        ctx.ui.setWidget(WIDGET_KEY, (tui, theme) => {
          if (binding !== owner) return { render: () => [], invalidate() {} };
          owner.widget?.dispose();
          owner.widget = new PlanPaneWidget(
            tui,
            theme,
            owner.side,
            owner.document,
            hidden,
            owner.widthRatio,
            (ratio) => {
              if (binding === owner) owner.onResize?.(ratio);
            },
          );
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

  constructor(
    private readonly tui: TUI,
    private readonly theme: Theme,
    private readonly side: PlanPaneSide,
    private document: PaneDocument,
    private hidden: boolean,
    private widthRatio: number,
    private readonly onResize: (ratio: number) => void,
  ) {
    this.body = new PlanPaneBody(theme, document);
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

  setDocument(document: PaneDocument) {
    if (this.disposed || (document.raw === this.document.raw && document.completed === this.document.completed)) return;
    this.document = document;
    this.body.setDocument(document);
    this.scroll.scrollToStart();
    if (this.tui?.mode === "fullscreen") this.tui.requestRender();
  }

  setWidthRatio(ratio: number) {
    this.widthRatio = ratio;
    this.layout?.setWidthRatio(ratio);
  }

  setHidden(hidden: boolean): boolean {
    if (this.disposed || !this.tui || hidden === this.hidden) return false;
    if (hidden) {
      if (!this.layout?.isVisible()) return false;
      this.hidden = true;
      this.pending = undefined;
      this.unmount();
      this.scroll.scrollToStart();
      return true;
    }
    if (!canOpenFullscreenPlanLayout(this.tui)) return false;
    const renderer = this.tui.children;
    this.mount(renderer);
    if (!this.layout?.isVisible()) {
      this.unmount();
      return false;
    }
    this.hidden = false;
    return true;
  }

  showsCompletedPlan(plan: string) {
    return (
      !this.disposed &&
      !this.hidden &&
      this.document.completed &&
      this.document.raw === plan &&
      this.layout?.isVisible() === true
    );
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.pending = undefined;
    this.unmount();
  }

  private observeRenderer() {
    if (this.disposed || this.hidden || !this.tui || this.tui.mode !== "fullscreen") return;
    const renderer = this.tui.children;
    if (this.pending === renderer || this.attempted.has(renderer)) return;
    this.pending = renderer;
    queueMicrotask(() => {
      if (this.disposed || this.hidden || this.pending !== renderer) return;
      this.pending = undefined;
      if (this.tui.mode !== "fullscreen" || this.tui.children !== renderer) return;
      this.mount(renderer);
    });
  }

  private mount(renderer: readonly Component[]) {
    this.attempted.add(renderer);
    this.unmount();
    try {
      this.layout = mountFullscreenPlanLayout(
        this.tui,
        renderer,
        this.side,
        this.scroll,
        this.theme,
        this.widthRatio,
        this.onResize,
      );
    } catch {
      return;
    }
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
  private markdown: Markdown | undefined;
  private width: number | undefined;
  private lines: string[] = [];

  constructor(
    private readonly theme: Theme,
    private document: PaneDocument,
  ) {}

  setDocument(document: PaneDocument) {
    this.document = document;
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
    const title = this.theme.bold(this.theme.fg("accent", this.document.completed ? "Plan · Ready" : "Plan draft"));
    this.markdown ??= new Markdown(this.document.text, 0, 0, getMarkdownTheme());
    this.width = width;
    this.lines = [title, "", ...this.markdown.render(width)].map((line) => truncateToWidth(line, width));
    return this.lines;
  }
}
