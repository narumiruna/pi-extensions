import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { wrapTextWithAnsi } from "@earendil-works/pi-tui";

export const ACTIVE_TOOL_WIDGET_KEY = "tool:active-tools";
export const ACTIVE_TOOL_REFRESH_INTERVAL_MS = 500;
const MAX_TOOL_NAME_LENGTH = 32;

export interface ActiveToolStatusController {
  start(ctx: ExtensionContext, enabled: boolean): void;
  setEnabled(ctx: ExtensionContext, enabled: boolean): void;
  refresh(ctx: ExtensionContext): void;
  shutdown(ctx: ExtensionContext): void;
  isEnabled(): boolean;
}

export function createActiveToolStatusController(pi: ExtensionAPI): ActiveToolStatusController {
  let activeContext: ExtensionContext | undefined;
  let activeSession: ExtensionContext["sessionManager"] | undefined;
  let refreshTimer: ReturnType<typeof setInterval> | undefined;
  let enabled = false;
  let publishedValue: string | undefined;
  let hasPublished = false;

  const ownsSession = (ctx: ExtensionContext) => ctx.sessionManager === activeSession;

  const stopRefreshing = (): void => {
    if (!refreshTimer) return;
    clearInterval(refreshTimer);
    refreshTimer = undefined;
  };

  const clear = (ctx: ExtensionContext): void => {
    if (ctx.hasUI) ctx.ui.setWidget(ACTIVE_TOOL_WIDGET_KEY, undefined);
    publishedValue = undefined;
    hasPublished = false;
  };

  const publish = (ctx: ExtensionContext): void => {
    if (!enabled || !ctx.hasUI || !ownsSession(ctx)) return;
    const content = formatActiveToolWidget(pi.getActiveTools());
    const value = content?.join("\n");
    if (hasPublished && value === publishedValue) return;
    if (content && ctx.mode === "tui") {
      ctx.ui.setWidget(
        ACTIVE_TOOL_WIDGET_KEY,
        (_tui, theme) => ({
          render: (width: number) => renderActiveToolWidget(content, theme, width),
          invalidate: () => {},
        }),
        { placement: "aboveEditor" },
      );
    } else {
      ctx.ui.setWidget(ACTIVE_TOOL_WIDGET_KEY, content, { placement: "aboveEditor" });
    }
    publishedValue = value;
    hasPublished = true;
  };

  const startRefreshing = (ctx: ExtensionContext): void => {
    stopRefreshing();
    if (!enabled || !ctx.hasUI) return;
    refreshTimer = setInterval(() => {
      if (ownsSession(ctx)) publish(ctx);
    }, ACTIVE_TOOL_REFRESH_INTERVAL_MS);
  };

  return {
    start(ctx, nextEnabled) {
      stopRefreshing();
      if (activeContext) clear(activeContext);
      activeContext = ctx;
      activeSession = ctx.sessionManager;
      enabled = nextEnabled;
      publishedValue = undefined;
      hasPublished = false;
      if (!enabled) return;
      publish(ctx);
      startRefreshing(ctx);
    },
    setEnabled(ctx, nextEnabled) {
      if (!ownsSession(ctx) || enabled === nextEnabled) return;
      enabled = nextEnabled;
      if (!enabled) {
        stopRefreshing();
        clear(ctx);
        return;
      }
      publish(ctx);
      startRefreshing(ctx);
    },
    refresh(ctx) {
      publish(ctx);
    },
    shutdown(ctx) {
      if (!ownsSession(ctx)) return;
      stopRefreshing();
      clear(ctx);
      activeContext = undefined;
      activeSession = undefined;
      enabled = false;
    },
    isEnabled() {
      return enabled;
    },
  };
}

export function formatActiveToolWidget(toolNames: Iterable<string>): string[] | undefined {
  const tools = [...toolNames].map(sanitizeToolName);
  if (tools.length === 0) return undefined;
  const label = tools.length === 1 ? "Active tool" : "Active tools";
  return [`${label} (${tools.length})`, tools.join(" · ")];
}

export function renderActiveToolWidget(lines: readonly string[], theme: Theme, width: number): string[] {
  const renderWidth = Math.max(0, width);
  const contentLines =
    renderWidth === 0 ? lines.map(() => "") : lines.flatMap((line) => wrapTextWithAnsi(line, renderWidth));
  return [theme.fg("borderMuted", "─".repeat(renderWidth)), ...contentLines];
}

export function sanitizeToolName(value: string): string {
  const printable = value.replace(/[^\p{L}\p{N}_.:/-]+/gu, "");
  if (!printable) return "tool";
  const characters = [...printable];
  return characters.length > MAX_TOOL_NAME_LENGTH
    ? `${characters.slice(0, MAX_TOOL_NAME_LENGTH).join("")}…`
    : printable;
}
