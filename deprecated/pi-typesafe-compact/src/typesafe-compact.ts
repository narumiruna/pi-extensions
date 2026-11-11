import type { Api, Model } from "@earendil-works/pi-ai";
import {
  type ExtensionAPI,
  type ExtensionContext,
  estimateTokens,
  type SessionBeforeCompactEvent,
  type SessionEntry,
  sessionEntryToContextMessages,
} from "@earendil-works/pi-coding-agent";
import { sanitizeTerminalText } from "@narumitw/pi-tui-kit/terminal-text";
import { createTypeSafeClient, evaluateHistoryUnits, type TypeSafeClientFactory } from "./evaluator.js";
import {
  assertRetainedUnitsBounded,
  combineHistoryUnits,
  composeCompactionSummary,
  fileOperationLists,
  MAX_COMPACTION_DETAILS_BYTES,
  MAX_COMPACTION_SUMMARY_BYTES,
  parseTypeSafeCompactDetails,
  TYPESAFE_COMPACT_DETAILS_KIND,
  TYPESAFE_COMPACT_DETAILS_VERSION,
  type TypeSafeCompactDetails,
} from "./history-units.js";
import { showTypeSafeCompactMenu } from "./menu.js";
import { createTypeSafeCompactSettingsRuntime, type TypeSafeCompactSettingsRuntime } from "./settings.js";
import { summarizeWithPiNativeCompact } from "./summary.js";

const STATUS_KEY = "typesafe-compact";
type Summarize = typeof summarizeWithPiNativeCompact;

export interface TypeSafeCompactExtensionOptions {
  settingsRuntime?: TypeSafeCompactSettingsRuntime;
  clientFactory?: TypeSafeClientFactory;
  summarize?: Summarize;
}

interface SessionOwnership {
  generation: number;
  controller: AbortController;
}

function modelIdentity(model: Model<Api> | undefined): string | undefined {
  return model ? `${model.provider}\0${model.api}\0${model.id}` : undefined;
}

function latestPriorDetails(entries: readonly SessionEntry[]): TypeSafeCompactDetails | undefined {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry?.type !== "compaction") continue;
    return parseTypeSafeCompactDetails(entry.details);
  }
  return undefined;
}

function safeError(error: unknown, apiKey?: string): string {
  let message = error instanceof Error ? error.message : String(error);
  if (apiKey) message = message.split(apiKey).join("[REDACTED]");
  return sanitizeTerminalText(message).slice(0, 2_000);
}

function assertCompactedContextFits(
  summary: string,
  model: Model<Api>,
  preparation: SessionBeforeCompactEvent["preparation"],
  branchEntries: readonly SessionEntry[],
): void {
  const contextWindow = model.contextWindow ?? 0;
  if (contextWindow <= 0) return;
  const firstKeptIndex = branchEntries.findIndex((entry) => entry.id === preparation.firstKeptEntryId);
  if (firstKeptIndex < 0) throw new Error("Could not locate the retained Pi context suffix");
  const summaryTokens = estimateTokens({
    role: "compactionSummary",
    summary,
    tokensBefore: preparation.tokensBefore,
    timestamp: Date.now(),
  });
  const suffixTokens = branchEntries
    .slice(firstKeptIndex)
    .flatMap(sessionEntryToContextMessages)
    .reduce((total, message) => total + estimateTokens(message), 0);
  const tokenBudget = contextWindow - preparation.settings.reserveTokens;
  if (summaryTokens + suffixTokens > tokenBudget) {
    throw new Error("Compacted context exceeds the active model token budget");
  }
}

function sessionOwned(
  ctx: ExtensionContext,
  generation: number,
  currentGeneration: () => number,
  sessionId: string,
  ownerSignal: AbortSignal,
): boolean {
  return !ownerSignal.aborted && generation === currentGeneration() && ctx.sessionManager.getSessionId() === sessionId;
}

async function compactWithTypeSafe(
  event: SessionBeforeCompactEvent,
  ctx: ExtensionContext,
  options: {
    runtime: TypeSafeCompactSettingsRuntime;
    clientFactory: TypeSafeClientFactory;
    summarize: Summarize;
    generation: number;
    currentGeneration(): number;
    ownerSignal: AbortSignal;
  },
) {
  const settingsState = options.runtime.get();
  const apiKey = settingsState.kind === "loaded" ? settingsState.settings.apiKey : undefined;
  const model = ctx.model;
  const thinkingLevel = ctx.thinkingLevel;
  if (!apiKey || !model) return undefined;

  const sessionId = ctx.sessionManager.getSessionId();
  const identity = modelIdentity(model);
  const signal = AbortSignal.any([event.signal, options.ownerSignal]);
  const isCurrent = () =>
    sessionOwned(ctx, options.generation, options.currentGeneration, sessionId, options.ownerSignal) &&
    !signal.aborted &&
    modelIdentity(ctx.model) === identity &&
    options.runtime.get().settings.apiKey === apiKey;
  if (!isCurrent()) return { cancel: true as const };

  if (ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, "JEV evaluating history…");
  try {
    const prior = latestPriorDetails(event.branchEntries);
    const units = combineHistoryUnits(
      prior?.retainedUnits ?? [],
      event.preparation.messagesToSummarize,
      event.preparation.turnPrefixMessages,
    );
    const evaluation = await evaluateHistoryUnits(options.clientFactory(apiKey), units, signal);
    if (!isCurrent()) return { cancel: true as const };

    const selectedUnits = evaluation.decisions
      .filter((decision) => decision.summarize)
      .map((decision) => decision.unit);
    const retainedUnits = evaluation.decisions
      .filter((decision) => !decision.summarize)
      .map((decision) => decision.unit);
    assertRetainedUnitsBounded(retainedUnits);

    const fileOps = {
      read: new Set([...(prior?.readFiles ?? []), ...event.preparation.fileOps.read]),
      written: new Set(event.preparation.fileOps.written),
      edited: new Set([...(prior?.modifiedFiles ?? []), ...event.preparation.fileOps.edited]),
    };
    const { readFiles, modifiedFiles } = fileOperationLists(fileOps);
    if (ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, `Pi compacting ${selectedUnits.length} JEV-selected units…`);
    const generated = await options.summarize(ctx, {
      model,
      thinkingLevel,
      selectedUnits,
      preparation: {
        ...event.preparation,
        previousSummary: prior?.compressedSummary ?? event.preparation.previousSummary,
        fileOps,
      },
      customInstructions: event.customInstructions,
      signal,
      isCurrent,
    });
    if (!isCurrent()) return { cancel: true as const };

    const summary = composeCompactionSummary(generated.text, retainedUnits);
    if (Buffer.byteLength(summary, "utf8") > MAX_COMPACTION_SUMMARY_BYTES) {
      throw new Error("Final TypeSafe compaction summary exceeds the 512 KiB limit");
    }
    assertCompactedContextFits(summary, model, event.preparation, event.branchEntries);
    const details: TypeSafeCompactDetails = {
      kind: TYPESAFE_COMPACT_DETAILS_KIND,
      version: TYPESAFE_COMPACT_DETAILS_VERSION,
      compressedSummary: generated.text,
      retainedUnits,
      evaluator: {
        model: "jev-latest",
        evaluated: evaluation.decisions.length,
        summarized: selectedUnits.length,
        retained: retainedUnits.length,
        inputTokens: evaluation.usage.inputTokens,
        outputTokens: evaluation.usage.outputTokens,
      },
      readFiles,
      modifiedFiles,
    };
    if (Buffer.byteLength(JSON.stringify(details), "utf8") > MAX_COMPACTION_DETAILS_BYTES) {
      throw new Error("TypeSafe compaction details exceed the 768 KiB limit");
    }
    return {
      compaction: {
        summary,
        firstKeptEntryId: event.preparation.firstKeptEntryId,
        tokensBefore: event.preparation.tokensBefore,
        usage: generated.usage,
        details,
      },
    };
  } catch (error) {
    if (signal.aborted || !isCurrent()) return { cancel: true as const };
    if (ctx.hasUI) {
      ctx.ui.notify(`TypeSafe compaction failed; using Pi-native compaction. ${safeError(error, apiKey)}`, "warning");
    }
    return undefined;
  } finally {
    if (sessionOwned(ctx, options.generation, options.currentGeneration, sessionId, options.ownerSignal) && ctx.hasUI) {
      ctx.ui.setStatus(STATUS_KEY, undefined);
    }
  }
}

export function createTypeSafeCompactExtension(
  options: TypeSafeCompactExtensionOptions = {},
): (pi: ExtensionAPI) => void {
  return (pi) => {
    const runtime = options.settingsRuntime ?? createTypeSafeCompactSettingsRuntime();
    const clientFactory = options.clientFactory ?? createTypeSafeClient;
    const summarize = options.summarize ?? summarizeWithPiNativeCompact;
    const sessionOwnership = new WeakMap<object, SessionOwnership>();
    const ownershipFor = (ctx: ExtensionContext): SessionOwnership => {
      let ownership = sessionOwnership.get(ctx.sessionManager);
      if (!ownership) {
        ownership = { generation: 0, controller: new AbortController() };
        sessionOwnership.set(ctx.sessionManager, ownership);
      }
      return ownership;
    };

    pi.registerCommand("typesafe-compact", {
      description: "Configure TypeSafe JEV-guided compaction",
      handler: async (args, ctx) => {
        if (args.trim()) throw new Error("Usage: /typesafe-compact");
        const ownership = ownershipFor(ctx);
        const ownerGeneration = ownership.generation;
        const ownerController = ownership.controller;
        await showTypeSafeCompactMenu(runtime, ctx, {
          signal: ownerController.signal,
          isCurrent: () => ownerGeneration === ownership.generation && !ownerController.signal.aborted,
        });
      },
    });

    pi.on("session_start", async (_event, ctx) => {
      const ownership = ownershipFor(ctx);
      ownership.controller.abort();
      if (ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, undefined);
      ownership.controller = new AbortController();
      ownership.generation += 1;
      const ownerController = ownership.controller;
      const ownerGeneration = ownership.generation;
      const sessionId = ctx.sessionManager.getSessionId();
      try {
        const state = await runtime.reload(ownerController.signal);
        if (
          ownerController.signal.aborted ||
          ownerGeneration !== ownership.generation ||
          ctx.sessionManager.getSessionId() !== sessionId
        ) {
          return;
        }
        if (state.kind === "invalid" && ctx.hasUI) {
          ctx.ui.notify(
            `Invalid pi-typesafe-compact.json; Pi-native compaction remains active. ${safeError(state.issue ?? "unknown validation error")}`,
            "warning",
          );
        }
      } catch (error) {
        if (ownerController.signal.aborted || ownerGeneration !== ownership.generation) return;
        if (ctx.hasUI) {
          ctx.ui.notify(
            `Could not load pi-typesafe-compact.json; Pi-native compaction remains active. ${safeError(error)}`,
            "warning",
          );
        }
      }
    });

    pi.on("session_before_compact", (event, ctx) => {
      const ownership = ownershipFor(ctx);
      return compactWithTypeSafe(event, ctx, {
        runtime,
        clientFactory,
        summarize,
        generation: ownership.generation,
        currentGeneration: () => ownership.generation,
        ownerSignal: ownership.controller.signal,
      });
    });

    pi.on("session_shutdown", async (_event, ctx) => {
      const ownership = ownershipFor(ctx);
      ownership.generation += 1;
      ownership.controller.abort();
      sessionOwnership.delete(ctx.sessionManager);
      if (ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, undefined);
      await runtime.flush();
    });
  };
}

export default createTypeSafeCompactExtension();
