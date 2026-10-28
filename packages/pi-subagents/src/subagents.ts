import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { sanitizeSubagentDisplayText } from "./display-text.js";
import { registerMessageRenderers } from "./message-renderers.js";
import {
  DEFAULT_SUBAGENT_SETTINGS,
  type SubagentSettings,
  SubagentSettingsStore,
  subagentSettingsPath,
} from "./settings.js";
import { registerSubagentTools, type SubagentToolsDependencies } from "./tools.js";
import { createSubagentWidgetController, type SubagentCyclePhase } from "./widget.js";

export interface SubagentsDependencies extends SubagentToolsDependencies {
  settingsStore?: Pick<SubagentSettingsStore, "userPath" | "load" | "save" | "flush">;
}

export default function subagents(pi: ExtensionAPI, dependencies: SubagentsDependencies = {}): void {
  registerMessageRenderers(pi);
  const tools = registerSubagentTools(pi, dependencies);
  const widget = createSubagentWidgetController(tools.runtime);
  const store = dependencies.settingsStore ?? new SubagentSettingsStore(subagentSettingsPath());
  let activeContext: ExtensionContext | undefined;
  let sessionGeneration = 0;
  let owner = new AbortController();
  let ready = false;
  let menuOpen = false;
  let cyclePhase: SubagentCyclePhase = "idle";
  let settings: SubagentSettings = { ...DEFAULT_SUBAGENT_SETTINGS };
  const menuTasks = new Set<Promise<void>>();
  const ownsSession = (ctx: ExtensionContext) =>
    activeContext !== undefined && ctx.sessionManager === activeContext.sessionManager;

  const joinCleanup = async (steps: (() => void | Promise<void>)[], errors: unknown[] = []): Promise<void> => {
    const results = await Promise.allSettled(steps.map(async (step) => step()));
    for (const result of results) {
      if (result.status === "rejected") errors.push(result.reason);
    }
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) throw new AggregateError(errors, "Subagents session cleanup failed");
  };

  const openSettings = async (
    ctx: ExtensionCommandContext,
    signal: AbortSignal,
    isCurrent: () => boolean,
  ): Promise<"back" | "close" | "stale"> => {
    if (signal.aborted || !isCurrent()) return "stale";
    if (ctx.mode !== "tui") {
      ctx.ui.notify(sanitizeSubagentDisplayText(`Edit user settings: ${store.userPath}. Then run /reload.`), "info");
      return "back";
    }
    const { showSubagentSettings } = await import("./settings-ui.js");
    if (signal.aborted || !isCurrent()) return "stale";
    return showSubagentSettings(ctx, {
      signal,
      isCurrent,
      get: () => ({ ...settings }),
      save: (key, value, actionSignal) => {
        actionSignal.throwIfAborted();
        if (!isCurrent()) throw new Error("The subagents session changed.");
        return store.save(key, value, actionSignal);
      },
      apply: (next) => {
        if (!isCurrent()) return;
        settings = { ...next };
        widget.update(ctx, settings);
      },
    });
  };

  pi.registerCommand("subagents", {
    description: "Manage subagent jobs and widget settings",
    getArgumentCompletions: (prefix) =>
      "settings".startsWith(prefix)
        ? [{ value: "settings", label: "settings", description: "Configure the subagent widget" }]
        : null,
    handler: async (args, ctx) => {
      if (!ctx.hasUI || (ctx.mode !== "tui" && ctx.mode !== "rpc")) {
        throw new Error("/subagents requires TUI or RPC mode.");
      }
      const route = args.trim();
      if (route !== "" && route !== "settings") {
        ctx.ui.notify("Usage: /subagents | /subagents settings", "warning");
        return;
      }
      if (!ownsSession(ctx) || !ready || menuOpen) {
        ctx.ui.notify("Subagent controls are loading, unavailable, or already open.", "warning");
        return;
      }
      menuOpen = true;
      const generation = sessionGeneration;
      const signal = owner.signal;
      const isCurrent = () => generation === sessionGeneration && !signal.aborted && ownsSession(ctx);
      const task = (async () => {
        if (route === "settings") {
          await openSettings(ctx, signal, isCurrent);
          return;
        }
        const { showSubagentsMenu } = await import("./menu.js");
        if (!isCurrent()) return;
        await showSubagentsMenu(ctx, {
          signal,
          isCurrent,
          getState: () => ({
            settings: { ...settings },
            settingsPath: store.userPath,
            ...tools.runtime.inspectJobs(),
          }),
          cancelJob: async (jobId, actionSignal) => {
            actionSignal.throwIfAborted();
            if (!isCurrent()) throw new Error("The subagents session changed.");
            await tools.runtime.cancel(jobId);
          },
          showSettings: (actionSignal) => openSettings(ctx, actionSignal, isCurrent),
          widget: widget.controls(ctx),
        });
      })();
      menuTasks.add(task);
      try {
        await task;
      } catch (error) {
        if (isCurrent()) {
          ctx.ui.notify(sanitizeSubagentDisplayText(error instanceof Error ? error.message : String(error)), "error");
        }
      } finally {
        menuTasks.delete(task);
        if (isCurrent()) menuOpen = false;
      }
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    const previousContext = activeContext;
    const generation = ++sessionGeneration;
    ready = false;
    menuOpen = false;
    owner.abort();
    owner = new AbortController();
    const signal = owner.signal;
    activeContext = ctx;
    cyclePhase = ctx.signal === undefined ? "idle" : "running";
    const isCurrent = () => generation === sessionGeneration && !signal.aborted && ownsSession(ctx);
    const errors: unknown[] = [];
    try {
      if (previousContext) widget.shutdown(previousContext);
    } catch (error) {
      errors.push(error);
    }
    // A failed UI handoff must still stop old children, menus, and pending saves.
    // Do not initialize another runtime or widget after that failure.
    const failedHandoff = errors.length > 0;
    await joinCleanup(
      [
        () => (failedHandoff ? tools.shutdown() : tools.startSession()),
        ...[...menuTasks].map((task) => () => task),
        ...(failedHandoff ? [() => store.flush()] : []),
      ],
      errors,
    );
    if (!isCurrent()) return;
    const loaded = await store.load();
    if (!isCurrent()) return;
    settings = { ...loaded.settings };
    widget.start(ctx, settings, cyclePhase);
    ready = true;
    if (loaded.diagnostics.length > 0) {
      const message = sanitizeSubagentDisplayText(`Subagent settings: ${loaded.diagnostics.join(" ")}`);
      if (ctx.hasUI) ctx.ui.notify(message, "warning");
      else throw new Error(message);
    }
  });

  pi.on("before_agent_start", (_event, ctx) => {
    if (!ownsSession(ctx)) return;
    cyclePhase = "preparing";
    if (ready) widget.preparing(ctx);
  });
  pi.on("session_before_compact", (event, ctx) => {
    if (!ownsSession(ctx)) return;
    if (event.reason === "manual") {
      cyclePhase = "maintenance";
      if (ready) widget.maintenance(ctx);
    } else {
      if (cyclePhase !== "running") cyclePhase = "auto-preparing";
      if (ready) widget.automaticCompaction(ctx);
    }
  });
  pi.on("session_before_tree", (_event, ctx) => {
    if (!ownsSession(ctx)) return;
    cyclePhase = "maintenance";
    if (ready) widget.maintenance(ctx);
  });
  pi.on("input", (_event, ctx) => {
    // Discard a canceled maintenance/preparation guard before a new idle prompt.
    // Do not count input as a consumed user message.
    if (!ownsSession(ctx) || !ctx.isIdle()) return;
    cyclePhase = "idle";
    if (ready) widget.clearCycle(ctx);
  });
  pi.on("agent_start", (_event, ctx) => {
    if (!ownsSession(ctx)) return;
    cyclePhase = "running";
    if (ready) widget.agentStarted(ctx);
  });
  pi.on("message_start", (event, ctx) => {
    // Input submission is not consumption. Extension-generated user messages count too.
    if (ready && ownsSession(ctx) && event.message.role === "user") widget.userMessage(ctx);
  });
  pi.on("turn_end", (event, ctx) => {
    if (ready && ownsSession(ctx) && event.message.role === "assistant")
      widget.turnEnded(ctx, event.message.stopReason);
  });
  pi.on("agent_settled", (event, ctx) => {
    if (!ownsSession(ctx)) return;
    cyclePhase = "idle";
    if (ready) widget.settled(ctx, event.aborted);
  });
  pi.on("session_tree", (_event, ctx) => {
    if (!ownsSession(ctx)) return;
    cyclePhase = "maintenance";
    if (!ready) return;
    sessionGeneration++;
    ready = false;
    menuOpen = false;
    owner.abort();
    owner = new AbortController();
    widget.start(ctx, settings, cyclePhase);
    ready = true;
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    if (!ownsSession(ctx)) return;
    sessionGeneration++;
    ready = false;
    menuOpen = false;
    activeContext = undefined;
    cyclePhase = "idle";
    owner.abort();
    const errors: unknown[] = [];
    try {
      widget.shutdown(ctx);
    } catch (error) {
      errors.push(error);
    }
    await joinCleanup(
      [() => tools.shutdown(), ...[...menuTasks].map((task) => () => task), () => store.flush()],
      errors,
    );
  });
}
