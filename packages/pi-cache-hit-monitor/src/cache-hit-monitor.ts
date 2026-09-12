import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import {
  type CacheMonitorView,
  type CacheSample,
  type CacheUsageRecord,
  cacheSamplesEqual,
  collectCacheSamples,
  createCacheMonitorView,
  createCacheSample,
  formatMonitorLines,
  type MonitorLine,
} from "./metrics.js";

export const COMMAND_NAME = "cache-hit-monitor";
export const WIDGET_KEY = "cache-hit-monitor";

export default function cacheHitMonitor(pi: ExtensionAPI): void {
  let activeSession: ExtensionContext["sessionManager"] | undefined;
  let finalizedSamples: CacheSample[] = [];
  let summaryRecords: CacheUsageRecord[] = [];
  const cacheReportingProviders = new Set<string>();
  let currentEpoch = 0;
  let streamingSample: CacheSample | undefined;
  let publishedSignature: string | undefined;
  let visible = false;

  const ownsSession = (ctx: ExtensionContext): boolean => ctx.sessionManager === activeSession;

  const resolveCostModel = (ctx: ExtensionContext, provider: string, model: string) =>
    ctx.modelRegistry.find(provider, model);

  const restore = (ctx: ExtensionContext): void => {
    const restored = collectCacheSamples(ctx.sessionManager.getBranch(), (provider, model) =>
      resolveCostModel(ctx, provider, model),
    );
    finalizedSamples = restored.samples;
    summaryRecords = restored.summaryRecords;
    cacheReportingProviders.clear();
    for (const sample of finalizedSamples) {
      if (sample.cacheRead > 0 || sample.cacheWrite > 0) {
        cacheReportingProviders.add(sample.provider);
      }
    }
    currentEpoch = restored.currentEpoch;
    streamingSample = undefined;
  };

  const sampleMessage = (message: AssistantMessage, ctx: ExtensionContext): CacheSample | null =>
    createCacheSample(
      message,
      currentEpoch,
      resolveCostModel(ctx, message.provider, message.model),
      cacheReportingProviders.has(message.provider),
    );

  const clearWidget = (ctx: ExtensionContext): void => {
    if (ctx.hasUI && ownsSession(ctx)) ctx.ui.setWidget(WIDGET_KEY, undefined);
    publishedSignature = undefined;
  };

  const publish = (ctx: ExtensionContext): void => {
    if (!visible || !ctx.hasUI || !ownsSession(ctx)) return;
    const view = createCacheMonitorView(finalizedSamples, streamingSample, {
      activeEpoch: currentEpoch,
      summaryRecords,
    });
    const lines = formatMonitorLines(view);
    const signature = JSON.stringify(lines);
    if (signature === publishedSignature) return;
    if (ctx.mode === "tui") {
      ctx.ui.setWidget(
        WIDGET_KEY,
        (_tui, theme) => ({
          render: (width: number) => renderCacheMonitor(view, theme, width),
          invalidate: () => {},
        }),
        { placement: "aboveEditor" },
      );
    } else {
      ctx.ui.setWidget(
        WIDGET_KEY,
        lines.map(({ text }) => text),
        { placement: "aboveEditor" },
      );
    }
    publishedSignature = signature;
  };

  pi.registerCommand(COMMAND_NAME, {
    description: "Show or hide live prompt-cache diagnostics",
    handler: async (args, ctx) => {
      if (args.trim()) {
        throw new Error(`Usage: /${COMMAND_NAME}`);
      }
      if (!ctx.hasUI) {
        throw new Error(`/${COMMAND_NAME} requires TUI or RPC mode.`);
      }
      if (!ownsSession(ctx)) {
        throw new Error(`/${COMMAND_NAME} is unavailable for a stale session.`);
      }

      visible = !visible;
      if (visible) publish(ctx);
      else clearWidget(ctx);
      ctx.ui.notify(`Cache hit monitor ${visible ? "shown" : "hidden"}.`, "info");
    },
  });

  pi.on("session_start", (_event, ctx) => {
    if (visible && activeSession !== ctx.sessionManager && ctx.hasUI) {
      ctx.ui.setWidget(WIDGET_KEY, undefined);
    }
    activeSession = ctx.sessionManager;
    visible = false;
    publishedSignature = undefined;
    restore(ctx);
  });

  pi.on("message_start", (event, ctx) => {
    if (!ownsSession(ctx) || event.message.role !== "assistant") return;
    streamingSample = undefined;
    publish(ctx);
  });

  pi.on("message_update", (event, ctx) => {
    if (!ownsSession(ctx) || event.message.role !== "assistant") return;
    const sample = sampleMessage(event.message, ctx);
    if (!sample || (streamingSample && cacheSamplesEqual(streamingSample, sample))) return;
    if (sample.cacheRead > 0 || sample.cacheWrite > 0) {
      cacheReportingProviders.add(sample.provider);
    }
    streamingSample = sample;
    publish(ctx);
  });

  pi.on("message_end", (event, ctx) => {
    if (!ownsSession(ctx) || event.message.role !== "assistant") return;
    const sample = sampleMessage(event.message, ctx);
    streamingSample = undefined;
    if (sample) {
      if (sample.cacheRead > 0 || sample.cacheWrite > 0) {
        cacheReportingProviders.add(sample.provider);
      }
      finalizedSamples.push(sample);
    }
    publish(ctx);
  });

  pi.on("agent_end", (_event, ctx) => {
    if (!ownsSession(ctx) || !streamingSample) return;
    streamingSample = undefined;
    publish(ctx);
  });

  pi.on("session_compact", (_event, ctx) => {
    if (!ownsSession(ctx)) return;
    restore(ctx);
    publish(ctx);
  });

  pi.on("session_tree", (_event, ctx) => {
    if (!ownsSession(ctx)) return;
    restore(ctx);
    publish(ctx);
  });

  pi.on("session_shutdown", (_event, ctx) => {
    if (!ownsSession(ctx)) return;
    clearWidget(ctx);
    activeSession = undefined;
    finalizedSamples = [];
    summaryRecords = [];
    cacheReportingProviders.clear();
    streamingSample = undefined;
    visible = false;
  });
}

export function renderCacheMonitor(view: CacheMonitorView, theme: Theme, width: number): string[] {
  const renderWidth = Math.max(0, width);
  if (renderWidth === 0) return ["", ...formatMonitorLines(view).map(() => "")];
  const divider = theme.fg("borderMuted", "─".repeat(renderWidth));
  const rendered = formatMonitorLines(view).flatMap((line) => {
    const styled = styleLine(line, theme);
    return wrapTextWithAnsi(styled, renderWidth);
  });
  return [divider, ...rendered].map((line) =>
    visibleWidth(line) <= renderWidth ? line : truncateToWidth(line, renderWidth, ""),
  );
}

function styleLine(line: MonitorLine, theme: Theme): string {
  switch (line.role) {
    case "title":
      return theme.fg("accent", theme.bold(line.text));
    case "good":
      return theme.fg("success", line.text);
    case "warning":
      return theme.fg("warning", line.text);
    case "bad":
      return theme.fg("error", line.text);
    case "muted":
      return theme.fg("muted", line.text);
    case "dim":
      return theme.fg("dim", line.text);
  }
}
