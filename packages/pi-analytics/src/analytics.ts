import { randomUUID } from "node:crypto";
import path from "node:path";
import { type ExtensionAPI, type ExtensionContext, getAgentDir } from "@earendil-works/pi-coding-agent";
import { ResponseCollector } from "./collector.js";
import { type AnalyticsMenuDataSource, showAnalyticsMenu } from "./menu.js";
import { SkillTracker } from "./skills.js";
import type { ClearAnalyticsResult } from "./storage/files.js";
import type { AnalyticsSnapshot, TimeRange } from "./storage/queries.js";
import { AnalyticsStore } from "./storage/store.js";
import type { ModelIdentity, SettledRun, TriggerSource } from "./types.js";

const STORAGE_DIRECTORY = "pi-analytics";

export interface AnalyticsStorePort {
  readonly path: string;
  recordRun(run: SettledRun, signal?: AbortSignal): Promise<void>;
  getSnapshot(range: TimeRange, signal?: AbortSignal): Promise<AnalyticsSnapshot>;
  clearAll(signal?: AbortSignal): Promise<ClearAnalyticsResult>;
  close(): Promise<void>;
}

interface AnalyticsDependencies {
  createStore(path: string): AnalyticsStorePort;
  createSkillTracker(cwd: string): SkillTracker;
  getAgentDir(): string;
  now(): number;
  createId(): string;
}

export function createAnalyticsExtension(
  dependencies: Partial<AnalyticsDependencies> = {},
): (pi: ExtensionAPI) => void {
  const deps: AnalyticsDependencies = {
    createStore: dependencies.createStore ?? ((rootPath) => new AnalyticsStore(rootPath)),
    createSkillTracker: dependencies.createSkillTracker ?? ((cwd) => new SkillTracker(cwd)),
    getAgentDir: dependencies.getAgentDir ?? getAgentDir,
    now: dependencies.now ?? Date.now,
    createId: dependencies.createId ?? randomUUID,
  };

  return function analyticsExtension(pi: ExtensionAPI): void {
    let sessionGeneration = 0;
    let sessionController = new AbortController();
    let collector = new ResponseCollector();
    let skillTracker: SkillTracker | undefined;
    let store: AnalyticsStorePort | undefined;
    let storageFailure: string | undefined;
    const retiredCloseTasks = new Set<Promise<boolean>>();
    let writeFailureActive = false;
    let pendingTriggerSource: TriggerSource = "unknown";
    let pendingAttemptWithoutRun = false;

    pi.registerCommand("analytics", {
      description: "Open local Pi usage analytics",
      handler: async (args, ctx) => {
        if (args.trim()) {
          if (!ctx.hasUI || (ctx.mode !== "tui" && ctx.mode !== "rpc")) {
            throw new Error("/analytics does not accept arguments.");
          }
          ctx.ui.notify("/analytics does not accept arguments.", "warning");
          return;
        }
        if (!ctx.hasUI || (ctx.mode !== "tui" && ctx.mode !== "rpc")) {
          throw new Error("/analytics requires Pi TUI or RPC mode.");
        }
        const generation = sessionGeneration;
        const owner = sessionController;
        const source = menuSource(generation, owner.signal);
        await showAnalyticsMenu(ctx, source, {
          signal: owner.signal,
          isCurrent: () => generation === sessionGeneration && !owner.signal.aborted,
        });
      },
    });

    pi.on("session_start", (_event, ctx) => {
      ++sessionGeneration;
      const previousStore = store;
      sessionController.abort(new DOMException("Analytics session replaced", "AbortError"));
      if (previousStore) retire(previousStore);
      sessionController = new AbortController();
      collector = new ResponseCollector();
      skillTracker = deps.createSkillTracker(ctx.cwd);
      store = undefined;
      storageFailure = undefined;
      writeFailureActive = false;
      pendingTriggerSource = "unknown";
      pendingAttemptWithoutRun = false;
      const storageRoot = path.join(deps.getAgentDir(), STORAGE_DIRECTORY);
      try {
        store = deps.createStore(storageRoot);
      } catch {
        storageFailure = unavailableMessage();
        safeNotify(ctx, storageFailure, "warning");
      }
    });

    pi.on("input", (event, ctx) => {
      const now = deps.now();
      const tracker = skillTracker;
      tracker?.observeInput(event.text, event.source, now);
      if (event.source !== "extension") pendingTriggerSource = event.source;
      if (!tracker || !collector.hasActiveRun()) return;
      const explicit = tracker.consumeExplicitSkill();
      if (!explicit || !tracker.hasAvailableSkill(explicit.name)) return;
      collector.activateSkill({
        name: explicit.name,
        initiatedBy: "user",
        now: explicit.observedAtMs,
        model: modelIdentity(ctx, pi),
      });
    });

    pi.on("before_agent_start", async (event, ctx) => {
      const generation = sessionGeneration;
      const tracker = skillTracker;
      const activeCollector = collector;
      if (!tracker) return;
      const skills = availableSkills(pi, event.systemPromptOptions.skills ?? []);
      await tracker.setAvailableSkills(skills);
      if (generation !== sessionGeneration || tracker !== skillTracker || activeCollector !== collector) {
        return;
      }
      const explicit = tracker.consumeExplicitSkill();
      const interrupted = activeCollector.begin({
        id: deps.createId(),
        now: deps.now(),
        triggerSource: explicit?.source ?? pendingTriggerSource,
        model: modelIdentity(ctx, pi),
      });
      pendingTriggerSource = "unknown";
      if (interrupted) {
        await persistRun(interrupted, ctx, generation, sessionController.signal);
        if (generation !== sessionGeneration || tracker !== skillTracker || activeCollector !== collector) {
          return;
        }
      }
      if (explicit && skills.some(({ name }) => name === explicit.name)) {
        activeCollector.activateSkill({
          name: explicit.name,
          initiatedBy: "user",
          now: explicit.observedAtMs,
          model: modelIdentity(ctx, pi),
        });
      }
    });

    pi.on("agent_start", () => {
      if (collector.hasActiveRun()) collector.beginAttempt();
      else pendingAttemptWithoutRun = true;
    });

    pi.on("turn_start", (_event, ctx) => ensureRun(ctx, "extension"));

    pi.on("before_provider_request", (_event, ctx) => {
      ensureRun(ctx, "extension");
      collector.beginGeneration({
        id: deps.createId(),
        now: deps.now(),
        model: modelIdentity(ctx, pi),
      });
    });

    pi.on("after_provider_response", (event) => {
      collector.recordProviderResponse({ status: event.status, now: deps.now() });
    });

    pi.on("message_end", (event) => {
      if (event.message.role !== "assistant") return;
      collector.finishGeneration({
        now: deps.now(),
        stopReason: event.message.stopReason,
        errorMessage: event.message.errorMessage,
      });
    });

    pi.on("tool_execution_start", (event, ctx) => {
      ensureRun(ctx, "extension");
      collector.beginTool({
        id: event.toolCallId,
        name: event.toolName,
        now: deps.now(),
        model: modelIdentity(ctx, pi),
      });
    });

    pi.on("tool_result", async (event, ctx) => {
      if (event.toolName === "read" && !isBuiltinReadTool(pi)) return;
      const generation = sessionGeneration;
      const tracker = skillTracker;
      const activeCollector = collector;
      const runId = activeCollector.getActiveRunId();
      if (!tracker || !runId) return;
      const name = await tracker.matchSuccessfulRead({
        toolName: event.toolName,
        input: event.input,
        isError: event.isError,
      });
      if (
        !name ||
        generation !== sessionGeneration ||
        tracker !== skillTracker ||
        activeCollector !== collector ||
        activeCollector.getActiveRunId() !== runId
      ) {
        return;
      }
      activeCollector.activateSkill({
        name,
        initiatedBy: "model",
        now: deps.now(),
        model: modelIdentity(ctx, pi),
      });
    });

    pi.on("tool_execution_end", (event) => {
      collector.finishTool({ id: event.toolCallId, now: deps.now(), isError: event.isError });
    });

    pi.on("agent_settled", async (_event, ctx) => {
      const generation = sessionGeneration;
      const owner = sessionController;
      const run = collector.settle(deps.now());
      pendingAttemptWithoutRun = false;
      pendingTriggerSource = "unknown";
      skillTracker?.clearPending();
      if (run) await persistRun(run, ctx, generation, owner.signal);
    });

    pi.on("session_shutdown", async (_event, ctx) => {
      const activeStore = store;
      ++sessionGeneration;
      sessionController.abort(new DOMException("Analytics session shut down", "AbortError"));
      skillTracker?.clearPending();
      skillTracker = undefined;
      store = undefined;
      collector.interrupt(deps.now());
      const closing = activeStore ? [closeResult(activeStore), ...retiredCloseTasks] : [...retiredCloseTasks];
      const results = await Promise.all(closing);
      if (results.some((closed) => !closed)) {
        safeNotify(ctx, "Analytics storage shutdown was incomplete.", "warning");
      }
    });

    function retire(retiredStore: AnalyticsStorePort): void {
      const task = closeResult(retiredStore).finally(() => retiredCloseTasks.delete(task));
      retiredCloseTasks.add(task);
    }

    async function closeResult(activeStore: AnalyticsStorePort): Promise<boolean> {
      try {
        await activeStore.close();
        return true;
      } catch {
        return false;
      }
    }

    function ensureRun(ctx: ExtensionContext, triggerSource: TriggerSource): void {
      if (collector.hasActiveRun()) return;
      collector.begin({
        id: deps.createId(),
        now: deps.now(),
        triggerSource,
        model: modelIdentity(ctx, pi),
      });
      if (pendingAttemptWithoutRun) {
        pendingAttemptWithoutRun = false;
        collector.beginAttempt();
      }
    }

    async function persistRun(
      run: SettledRun,
      ctx: ExtensionContext,
      generation: number,
      signal: AbortSignal,
    ): Promise<void> {
      const activeStore = store;
      if (!activeStore || signal.aborted) return;
      try {
        await activeStore.recordRun(run, signal);
        if (generation !== sessionGeneration || activeStore !== store || signal.aborted) return;
        if (writeFailureActive) {
          writeFailureActive = false;
          safeNotify(ctx, "Local analytics storage recovered.", "info");
        }
      } catch {
        if (generation !== sessionGeneration || activeStore !== store || signal.aborted || writeFailureActive) {
          return;
        }
        writeFailureActive = true;
        safeNotify(ctx, "Analytics could not save this response cycle; its metrics were dropped.", "warning");
      }
    }

    function menuSource(generation: number, signal: AbortSignal): AnalyticsMenuDataSource {
      return {
        path: store?.path ?? path.join(deps.getAgentDir(), STORAGE_DIRECTORY),
        async load(range, actionSignal) {
          assertCurrent(generation, signal);
          const activeStore = store;
          if (!activeStore) {
            return { kind: "unavailable", message: storageFailure ?? unavailableMessage() };
          }
          const snapshot = await activeStore.getSnapshot(range, actionSignal);
          assertCurrent(generation, signal);
          return { kind: "ready", snapshot };
        },
        async clearAll(actionSignal) {
          assertCurrent(generation, signal);
          const activeStore = store;
          if (!activeStore) return { cleanupIncomplete: false };
          return activeStore.clearAll(actionSignal);
        },
      };
    }

    function assertCurrent(generation: number, signal: AbortSignal): void {
      if (generation !== sessionGeneration || signal.aborted) {
        throw new DOMException("Analytics interaction replaced", "AbortError");
      }
    }
  };
}

function modelIdentity(ctx: ExtensionContext, pi: ExtensionAPI): ModelIdentity | undefined {
  if (!ctx.model) return undefined;
  return {
    provider: ctx.model.provider,
    model: ctx.model.id,
    thinkingLevel: pi.getThinkingLevel(),
  };
}

export function isBuiltinReadTool(pi: ExtensionAPI): boolean {
  const read = pi.getAllTools().find(({ name }) => name === "read");
  return read?.sourceInfo.source === "builtin";
}

function availableSkills(
  pi: ExtensionAPI,
  systemSkills: ReadonlyArray<{ name: string; filePath: string }>,
): Array<{ name: string; filePath: string }> {
  const result = [...systemSkills];
  const seen = new Set(result.map(({ name }) => name));
  const getCommands = (pi as ExtensionAPI & { getCommands?: ExtensionAPI["getCommands"] }).getCommands;
  for (const command of typeof getCommands === "function" ? getCommands.call(pi) : []) {
    if (command.source !== "skill" || seen.has(command.name.replace(/^skill:/u, ""))) continue;
    const name = command.name.replace(/^skill:/u, "");
    seen.add(name);
    result.push({ name, filePath: command.sourceInfo.path });
  }
  return result;
}

function unavailableMessage(): string {
  return [
    "Local analytics storage could not be initialized safely.",
    "Existing files were not replaced.",
    "No analytics are being collected.",
  ].join("\n");
}

function safeNotify(ctx: ExtensionContext, message: string, level: "info" | "warning"): void {
  try {
    ctx.ui.notify(message, level);
  } catch {
    // A replaced Pi context cannot receive lifecycle feedback.
  }
}

export default createAnalyticsExtension();
