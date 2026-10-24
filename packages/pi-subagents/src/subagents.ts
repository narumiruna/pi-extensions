import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { sanitizeSubagentDisplayText } from "./display-text.js";
import type { RegisteredDurableTools } from "./durable-tools.js";
import { registerMessageRenderers } from "./message-renderers.js";
import {
  DEFAULT_SUBAGENT_SETTINGS,
  loadSubagentsSettings,
  type SubagentSettings,
  SubagentSettingsStore,
  subagentSettingsPath,
} from "./settings.js";
import { registerSubagentTools, type SubagentToolsDependencies } from "./tools.js";
import { createSubagentWidgetController } from "./widget.js";

export interface SubagentsDependencies extends SubagentToolsDependencies {
  settingsStore?: Pick<SubagentSettingsStore, "userPath" | "load" | "save" | "flush">;
}

export default function subagents(pi: ExtensionAPI, dependencies: SubagentsDependencies = {}): void {
  registerMessageRenderers(pi);
  const store = dependencies.settingsStore ?? new SubagentSettingsStore(subagentSettingsPath());
  let legacy: ReturnType<typeof registerSubagentTools> | undefined;
  let durable: RegisteredDurableTools | undefined;
  let widget: ReturnType<typeof createSubagentWidgetController> | undefined;
  let selected: boolean | undefined;
  let activeContext: ExtensionContext | undefined;
  let requestedSession: ExtensionContext["sessionManager"] | undefined;
  let legacySession: ExtensionContext["sessionManager"] | undefined;
  let legacySuspension: Promise<void> | undefined;
  let sessionGeneration = 0;
  let owner = new AbortController();
  let ready = false;
  let menuOpen = false;
  let settings: SubagentSettings = { ...DEFAULT_SUBAGENT_SETTINGS };
  const menuTasks = new Set<Promise<void>>();
  const ownsSession = (ctx: ExtensionContext) => ctx.sessionManager === activeContext?.sessionManager;
  let lifecycle = Promise.resolve();
  const serialize = (operation: () => Promise<void>) => {
    const work = lifecycle.then(operation, operation);
    lifecycle = work.catch(() => undefined);
    return work;
  };
  const suspend = (ctx: ExtensionContext) => {
    if (legacySession === ctx.sessionManager && legacy) {
      widget?.shutdown(ctx);
      legacySuspension ??= legacy.runtime.shutdown();
      return legacySuspension;
    }
    return durable?.shutdown(ctx);
  };
  const shutdown = async (ctx: ExtensionContext) => {
    if (legacySession === ctx.sessionManager) {
      legacySession = undefined;
      widget?.shutdown(ctx);
      await legacySuspension;
      legacySuspension = undefined;
      await legacy?.shutdown();
    }
    await durable?.shutdown(ctx);
  };
  const drainControls = async () => {
    const results = await Promise.allSettled([...menuTasks, store.flush()]);
    const failed = results.find((result) => result.status === "rejected");
    if (failed?.status === "rejected") throw failed.reason;
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
        widget?.update(ctx, settings);
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
      const tools = legacy;
      if (route === "" && !tools) {
        ctx.ui.notify(
          "The job manager is available only in process mode. Use subagent_status, subagent_wait, and subagent_stop for durable conversations; /subagents settings edits process-widget preferences only.",
          "info",
        );
        return;
      }
      menuOpen = true;
      const generation = sessionGeneration;
      const signal = owner.signal;
      const isCurrent = () => generation === sessionGeneration && ownsSession(ctx) && !signal.aborted;
      const task = (async () => {
        if (route === "settings") {
          await openSettings(ctx, signal, isCurrent);
          return;
        }
        if (!tools) return;
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
    owner.abort();
    owner = new AbortController();
    ready = false;
    menuOpen = false;
    const generation = ++sessionGeneration;
    requestedSession = ctx.sessionManager;
    // Stop old work synchronously before slow UI saves or settings reads can block cleanup.
    const suspension = activeContext ? suspend(activeContext) : undefined;
    void suspension?.catch(() => undefined);
    return serialize(async () => {
      await suspension;
      if (activeContext) {
        const previous = activeContext;
        activeContext = undefined;
        await shutdown(previous);
      }
      if (generation !== sessionGeneration) return;
      await drainControls();
      if (generation !== sessionGeneration) return;
      const loaded = await store.load();
      if (generation !== sessionGeneration) return;
      const backendSettings = await loadSubagentsSettings(ctx.cwd, ctx.isProjectTrusted());
      if (generation !== sessionGeneration) return;
      for (const warning of backendSettings.warnings) {
        if (ctx.hasUI) ctx.ui.notify(warning, "warning");
        else process.stderr.write(`pi-subagents: ${warning}\n`);
      }
      // Backend-specific definitions remain fixed until /reload creates a fresh runtime.
      if (selected !== undefined && selected !== backendSettings.durable)
        throw new Error("Subagent backend changed; use /reload before continuing.");
      if (selected === undefined) {
        if (backendSettings.durable) {
          const { registerDurableTools } = await import("./durable-tools.js");
          if (generation !== sessionGeneration) return;
          durable = registerDurableTools(pi);
        } else {
          legacy = registerSubagentTools(pi, dependencies);
          widget = createSubagentWidgetController(legacy.runtime);
        }
        selected = backendSettings.durable;
      }
      activeContext = ctx;
      try {
        if (durable) await durable.startSession(ctx);
        else {
          legacySession = ctx.sessionManager;
          await legacy?.startSession();
        }
        if (generation !== sessionGeneration) {
          activeContext = undefined;
          await shutdown(ctx);
          return;
        }
        settings = { ...loaded.settings };
        ready = true;
        widget?.start(ctx, settings);
      } catch (error) {
        ready = false;
        activeContext = undefined;
        await shutdown(ctx);
        throw error;
      }
      // Invalid display preferences are observable diagnostics, not backend failures.
      if (loaded.diagnostics.length > 0) {
        const message = sanitizeSubagentDisplayText(`Subagent settings: ${loaded.diagnostics.join(" ")}`);
        if (ctx.hasUI) ctx.ui.notify(message, "warning");
        else throw new Error(message);
      }
    });
  });

  pi.on("agent_settled", async (_event, ctx) => {
    if (ownsSession(ctx)) await durable?.settled(ctx);
  });
  pi.on("session_tree", async (_event, ctx) => {
    if (!durable || !ownsSession(ctx) || ctx.sessionManager !== requestedSession) return;
    const generation = ++sessionGeneration;
    owner.abort();
    ready = false;
    menuOpen = false;
    activeContext = undefined;
    const suspension = suspend(ctx) ?? Promise.resolve();
    void suspension.catch(() => undefined);
    await serialize(async () => {
      await suspension;
      await shutdown(ctx);
      await drainControls();
    });
    if (generation !== sessionGeneration || ctx.sessionManager !== requestedSession) return;
    if (ctx.hasUI)
      ctx.ui.notify(
        "Durable subagents suspended after tree navigation. Fork into a new session or restore an unbranched session before enabling durable.",
        "warning",
      );
  });
  pi.on("session_shutdown", async (_event, ctx) => {
    // A replacement already owns cleanup of the previous session, even before it starts.
    if (ctx.sessionManager !== requestedSession) return;
    sessionGeneration++;
    requestedSession = undefined;
    owner.abort();
    ready = false;
    menuOpen = false;
    if (ownsSession(ctx)) activeContext = undefined;
    const suspension = suspend(ctx);
    void suspension?.catch(() => undefined);
    // Snapshot old controls now; a queued stale shutdown must not join a newer menu.
    const controls = drainControls();
    void controls.catch(() => undefined);
    await serialize(async () => {
      const results = await Promise.allSettled([
        (async () => {
          await suspension;
          await shutdown(ctx);
        })(),
        controls,
      ]);
      const failed = results.find((result) => result.status === "rejected");
      if (failed?.status === "rejected") throw failed.reason;
    });
  });
}
