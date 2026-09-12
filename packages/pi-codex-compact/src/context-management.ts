import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
  type AgentEndEvent,
  type ExtensionAPI,
  type ExtensionContext,
  type SessionBeforeCompactEvent,
  type SessionCompactEvent,
  sessionEntryToContextMessages,
} from "@earendil-works/pi-coding-agent";
import { latestCheckpoint } from "./checkpoint.js";
import {
  type ContextToolRuntime,
  EXPERIMENTAL_CONTEXT_TOOL_NAMES,
  registerExperimentalContextTools,
} from "./context-tools.js";
import {
  activeExperimentalCompaction,
  CONTEXT_CONTRACT_MESSAGE_TYPE,
  CONTEXT_DEACTIVATION_MESSAGE_TYPE,
  CONTEXT_DETAILS_KIND,
  CONTEXT_STATE_ENTRY_TYPE,
  CONTEXT_VERSION,
  type ContextLineage,
  compactionRetainedContext,
  contextContract,
  contextDeactivation,
  createExperimentalContextDetails,
  createInitialContextState,
  hasContextContract,
  latestContextMode,
  loadContextLineage,
  parseExperimentalCompaction,
  projectExperimentalContext,
  reconcileContextContract,
} from "./context-window.js";
import type { CodexCompactSettingsRuntime } from "./settings.js";
import { terminalText } from "./terminal.js";

const CONTINUATION_MESSAGE_TYPE = "pi-codex-context-continuation";
const EXTENSION_ENTRY_PATH = realpathSync(join(fileURLToPath(new URL(".", import.meta.url)), "index.ts"));

type PendingRollover = {
  requestId: string;
  nextWindowId: string;
  sessionId: string;
  generation: number;
  status: "requested" | "compacting" | "completed" | "failed";
  turnStartedAfterRequest: boolean;
  successfulTurnAfterRequest: boolean;
  reason?: string;
  errorMessage?: string;
};

function sameNames(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((name, index) => name === right[index]);
}

function isOwnedToolSource(tool: { sourceInfo: { path: string } } | undefined): boolean {
  if (!tool || tool.sourceInfo.path.startsWith("<")) return false;
  try {
    return realpathSync(tool.sourceInfo.path) === EXTENSION_ENTRY_PATH;
  } catch {
    return false;
  }
}

function contractMessage(lineage: ContextLineage) {
  return {
    customType: CONTEXT_CONTRACT_MESSAGE_TYPE,
    content: contextContract(lineage),
    display: false,
    details: {
      kind: CONTEXT_DETAILS_KIND,
      version: CONTEXT_VERSION,
      currentWindowId: lineage.currentWindowId,
    },
  };
}

function deactivationMessage() {
  return {
    customType: CONTEXT_DEACTIVATION_MESSAGE_TYPE,
    content: contextDeactivation(),
    display: false,
    details: { kind: CONTEXT_DETAILS_KIND, version: CONTEXT_VERSION },
  };
}

function deactivationAgentMessage(): AgentMessage {
  return {
    role: "custom",
    ...deactivationMessage(),
    timestamp: 0,
  };
}

interface CompactFailedEvent {
  errorMessage?: string;
  aborted: boolean;
}

function latestAssistantStopReason(messages: readonly AgentMessage[]): string | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role === "assistant") return message.stopReason;
  }
  return undefined;
}

export interface ExperimentalContextManager {
  isEnabled(): boolean;
  isRoutingExperimental(): boolean;
  startSession(ctx: ExtensionContext): void;
  onSessionTree(ctx: ExtensionContext): void;
  applySettings(ctx: ExtensionContext): void;
  beforeCompact(
    event: SessionBeforeCompactEvent,
    ctx: ExtensionContext,
  ):
    | {
        compaction: {
          summary: string;
          firstKeptEntryId: string;
          tokensBefore: number;
          details: unknown;
        };
      }
    | undefined;
  projectContext(messages: readonly AgentMessage[], ctx: ExtensionContext): AgentMessage[] | undefined;
  onCompact(event: SessionCompactEvent, ctx: ExtensionContext): void;
  onCompactFailed(event: CompactFailedEvent, ctx: ExtensionContext): void;
  onAgentStart(ctx: ExtensionContext): void;
  onAgentEnd(event: AgentEndEvent, ctx: ExtensionContext): void;
  onTurnStart(ctx: ExtensionContext): void;
  onAgentSettled(ctx: ExtensionContext): void;
  shutdown(): void;
}

export function createExperimentalContextManager(
  pi: ExtensionAPI,
  settingsRuntime: CodexCompactSettingsRuntime,
): ExperimentalContextManager {
  let generation = 0;
  let ownerSessionId: string | undefined;
  let lineage: ContextLineage | undefined;
  let pending: PendingRollover | undefined;
  let warned = false;
  let warnedOpaque = false;
  let warnedUnavailableTools = false;
  let toolsAvailable = false;
  let removeToolsAtSettlement = false;
  let fallbackDeactivationPending = false;
  let agentRunActive = false;
  let controller = new AbortController();

  const isConfigured = () => settingsRuntime.get().settings.experimentalContextManagement;

  const inspectToolUnit = () => {
    const available = new Map(pi.getAllTools().map((tool) => [tool.name, tool]));
    const ownedNames = new Set<string>(
      EXPERIMENTAL_CONTEXT_TOOL_NAMES.filter((name) => isOwnedToolSource(available.get(name))),
    );
    const activeNames = new Set(pi.getActiveTools());
    const unavailableNames = EXPERIMENTAL_CONTEXT_TOOL_NAMES.filter((name) => !ownedNames.has(name));
    const inactiveNames = EXPERIMENTAL_CONTEXT_TOOL_NAMES.filter(
      (name) => ownedNames.has(name) && !activeNames.has(name),
    );
    return {
      ownedNames,
      unavailableNames,
      inactiveNames,
      complete: unavailableNames.length === 0 && inactiveNames.length === 0,
    };
  };

  const isEnabled = () => (isConfigured() || removeToolsAtSettlement) && toolsAvailable && inspectToolUnit().complete;

  const isRoutingExperimental = () => isConfigured() || removeToolsAtSettlement || fallbackDeactivationPending;

  const isOwned = (ctx: ExtensionContext, request?: PendingRollover) =>
    !controller.signal.aborted &&
    ownerSessionId === ctx.sessionManager.getSessionId() &&
    (!request ||
      (request.sessionId === ownerSessionId &&
        request.generation === generation &&
        pending?.requestId === request.requestId));

  const removeOwnedTools = (ownedNames: ReadonlySet<string>) => {
    const current = pi.getActiveTools();
    const next = current.filter((name) => !ownedNames.has(name));
    if (!sameNames(current, next)) pi.setActiveTools(next);
  };

  const warnToolUnitUnavailable = (
    ctx: ExtensionContext,
    unavailableNames: readonly string[],
    inactiveNames: readonly string[],
  ) => {
    if (warnedUnavailableTools || !ctx.hasUI) return;
    warnedUnavailableTools = true;
    const names = [...unavailableNames, ...inactiveNames];
    ctx.ui.notify(
      `Experimental context management could not activate because these tool names are unavailable, inactive, or owned by another extension: ${names.join(", ")}. Pi-native compaction remains active.`,
      "warning",
    );
  };

  const reconcileTools = (configured: boolean, ctx: ExtensionContext): boolean => {
    const inspection = inspectToolUnit();
    toolsAvailable = configured && inspection.unavailableNames.length === 0;
    const current = pi.getActiveTools();
    const withoutOwned = current.filter((name) => !inspection.ownedNames.has(name));
    const next = toolsAvailable ? [...withoutOwned, ...EXPERIMENTAL_CONTEXT_TOOL_NAMES] : withoutOwned;
    if (!sameNames(current, next)) pi.setActiveTools(next);
    if (configured && !toolsAvailable) {
      warnToolUnitUnavailable(ctx, inspection.unavailableNames, inspection.inactiveNames);
    }
    return toolsAvailable;
  };

  const deactivateIncompleteToolUnit = (ctx: ExtensionContext): boolean => {
    const inspection = inspectToolUnit();
    if (inspection.complete) return false;
    const branchIsActive = latestContextMode(ctx.sessionManager.getBranch()) === "active";
    if (branchIsActive && !fallbackDeactivationPending) {
      pi.sendMessage(deactivationMessage(), { triggerTurn: false });
    }
    fallbackDeactivationPending = branchIsActive;
    if (pending?.status === "requested" || pending?.status === "compacting") {
      pending.status = "failed";
      pending.errorMessage = "Experimental context management tool unit became incomplete during rollover.";
    }
    removeToolsAtSettlement = false;
    toolsAvailable = false;
    removeOwnedTools(inspection.ownedNames);
    warnToolUnitUnavailable(ctx, inspection.unavailableNames, inspection.inactiveNames);
    return branchIsActive;
  };

  const ensureLineage = (ctx: ExtensionContext): ContextLineage => {
    const persisted = lineage ?? loadContextLineage(ctx.sessionManager.getBranch());
    if (persisted) {
      lineage = persisted;
      return persisted;
    }
    const state = createInitialContextState();
    pi.appendEntry(CONTEXT_STATE_ENTRY_TYPE, state);
    lineage = state;
    return state;
  };

  const warnEnabled = (ctx: ExtensionContext) => {
    if (warned || !ctx.hasUI) return;
    warned = true;
    ctx.ui.notify(
      "Experimental context management is active. Context rollover does not create a summary; preserve important information with codex_compact_update_notes.",
      "warning",
    );
  };

  const applySettings = (ctx: ExtensionContext) => {
    if (!isOwned(ctx)) return;
    const branch = ctx.sessionManager.getBranch();
    const runIsActive = agentRunActive || ctx.signal !== undefined;
    if (!isConfigured()) {
      const inspection = inspectToolUnit();
      if (runIsActive && toolsAvailable && inspection.complete) {
        removeToolsAtSettlement = true;
        fallbackDeactivationPending = false;
        return;
      }
      const branchIsActive = latestContextMode(branch) === "active";
      if (branchIsActive && !fallbackDeactivationPending) {
        pi.sendMessage(deactivationMessage(), { triggerTurn: false });
      }
      removeToolsAtSettlement = false;
      fallbackDeactivationPending = branchIsActive && runIsActive;
      reconcileTools(false, ctx);
      return;
    }
    const contractAlreadyActiveOrQueued = removeToolsAtSettlement && !fallbackDeactivationPending;
    const deactivationAlreadyPending = fallbackDeactivationPending;
    const toolsWereAvailable = toolsAvailable;
    removeToolsAtSettlement = false;
    fallbackDeactivationPending = false;
    if (!reconcileTools(true, ctx)) {
      const contractMayBeActive =
        latestContextMode(branch) === "active" ||
        (runIsActive && (toolsWereAvailable || contractAlreadyActiveOrQueued));
      if (contractMayBeActive && !deactivationAlreadyPending) {
        pi.sendMessage(deactivationMessage(), { triggerTurn: false });
      }
      fallbackDeactivationPending = runIsActive && (contractMayBeActive || deactivationAlreadyPending);
      return;
    }
    let activeLineage: ContextLineage;
    try {
      activeLineage = ensureLineage(ctx);
    } catch (error) {
      reconcileTools(false, ctx);
      throw error;
    }
    if (!warnedOpaque && !activeExperimentalCompaction(branch) && latestCheckpoint(branch) && ctx.hasUI) {
      warnedOpaque = true;
      ctx.ui.notify(
        "The active remote checkpoint contains opaque history that codex_compact_recall_context cannot decode; only plaintext Pi entries and future notes are locally recallable.",
        "warning",
      );
    }
    const messages = branch.flatMap(sessionEntryToContextMessages);
    if (
      deactivationAlreadyPending ||
      (!contractAlreadyActiveOrQueued &&
        (latestContextMode(branch) !== "active" || !hasContextContract(messages, activeLineage)))
    ) {
      pi.sendMessage(contractMessage(activeLineage), { triggerTurn: false });
    }
    warnEnabled(ctx);
  };

  const requestNewContext: ContextToolRuntime["requestNewContext"] = (ctx, input) => {
    if (!isOwned(ctx)) throw new Error("The context session was replaced; retry in the active session");
    if (!isConfigured()) {
      throw new Error("Experimental context management is deactivating; retry after enabling it");
    }
    if (pending) throw new Error("A context rollover is already pending");
    const activeLineage = ensureLineage(ctx);
    pending = {
      requestId: randomUUID(),
      nextWindowId: randomUUID(),
      sessionId: ctx.sessionManager.getSessionId(),
      generation,
      status: "requested",
      turnStartedAfterRequest: false,
      successfulTurnAfterRequest: false,
      ...(input.reason ? { reason: input.reason } : {}),
    };
    return { requestId: pending.requestId, currentWindowId: activeLineage.currentWindowId };
  };

  registerExperimentalContextTools(pi, { isEnabled, requestNewContext });

  const continueAfterRollover = (ctx: ExtensionContext, request: PendingRollover) => {
    if (!isOwned(ctx, request) || request.status !== "completed") return;
    const current = lineage;
    const contextToolsAvailable = isEnabled();
    pending = undefined;
    if (!current) return;
    pi.sendMessage(
      {
        customType: CONTINUATION_MESSAGE_TYPE,
        content: [
          `Context window ${current.currentWindowId} is now active.`,
          request.reason ? `Rollover reason: ${request.reason}` : undefined,
          contextToolsAvailable
            ? "Continue the interrupted task. Use codex_compact_recall_context for older details and do not assume an automatic summary exists."
            : "Continue the interrupted task. The experimental context tools became unavailable; do not assume an automatic summary or local recall is available.",
        ]
          .filter((line): line is string => Boolean(line))
          .join("\n"),
        display: false,
        details: {
          kind: CONTEXT_DETAILS_KIND,
          version: CONTEXT_VERSION,
          requestId: request.requestId,
          currentWindowId: current.currentWindowId,
        },
      },
      { triggerTurn: true },
    );
  };

  const failRollover = (ctx: ExtensionContext, request: PendingRollover, message: string) => {
    if (!isOwned(ctx, request)) return;
    pending = undefined;
    const safeMessage = terminalText(message).slice(0, 2_000);
    if (ctx.hasUI) ctx.ui.notify(safeMessage, "warning");
    pi.sendMessage(
      {
        customType: CONTINUATION_MESSAGE_TYPE,
        content: `The requested experimental context rollover failed. Continue with Pi's active fallback context. ${safeMessage}`,
        display: false,
        details: {
          kind: CONTEXT_DETAILS_KIND,
          version: CONTEXT_VERSION,
          requestId: request.requestId,
          failed: true,
        },
      },
      request.successfulTurnAfterRequest
        ? { triggerTurn: false }
        : ctx.isIdle()
          ? { triggerTurn: true }
          : { triggerTurn: true, deliverAs: "followUp" },
    );
  };

  return {
    isEnabled,
    isRoutingExperimental,
    startSession(ctx) {
      controller.abort();
      controller = new AbortController();
      generation += 1;
      ownerSessionId = ctx.sessionManager.getSessionId();
      lineage = loadContextLineage(ctx.sessionManager.getBranch());
      pending = undefined;
      warned = false;
      warnedOpaque = false;
      warnedUnavailableTools = false;
      toolsAvailable = false;
      removeToolsAtSettlement = false;
      fallbackDeactivationPending = false;
      agentRunActive = false;
      applySettings(ctx);
    },
    onSessionTree(ctx) {
      if (!isOwned(ctx)) return;
      generation += 1;
      lineage = loadContextLineage(ctx.sessionManager.getBranch());
      pending = undefined;
      removeToolsAtSettlement = false;
      fallbackDeactivationPending = false;
      agentRunActive = false;
      applySettings(ctx);
    },
    applySettings,
    beforeCompact(event, ctx) {
      if (!isOwned(ctx) || event.signal.aborted) return undefined;
      if (toolsAvailable && !inspectToolUnit().complete) deactivateIncompleteToolUnit(ctx);
      if (!isEnabled()) return undefined;
      const activeLineage = ensureLineage(ctx);
      const request = pending?.status === "requested" || pending?.status === "compacting" ? pending : undefined;
      // Completed and failed requests still owe their terminal outcome at the idle boundary.
      const details = createExperimentalContextDetails({
        lineage: activeLineage,
        ...compactionRetainedContext(event),
        reason: event.reason,
        ...(request ? { requestId: request.requestId, windowId: request.nextWindowId } : {}),
      });
      if (request) request.status = "compacting";
      return {
        compaction: {
          summary: contextContract(details),
          firstKeptEntryId: event.preparation.firstKeptEntryId,
          tokensBefore: event.preparation.tokensBefore,
          details,
        },
      };
    },
    projectContext(messages, ctx) {
      if (!isOwned(ctx)) return undefined;
      if (toolsAvailable && !inspectToolUnit().complete) deactivateIncompleteToolUnit(ctx);
      if (!isEnabled()) {
        if (fallbackDeactivationPending) {
          if (latestContextMode(ctx.sessionManager.getBranch()) !== "inactive") {
            return [...messages, deactivationAgentMessage()];
          }
          fallbackDeactivationPending = false;
        }
        return undefined;
      }
      const activeLineage = lineage ?? loadContextLineage(ctx.sessionManager.getBranch());
      if (!activeLineage) return undefined;
      const compaction = activeExperimentalCompaction(ctx.sessionManager.getBranch());
      if (compaction) {
        const projected = projectExperimentalContext(messages, compaction.entry, compaction.details);
        return projected ? reconcileContextContract(projected, compaction.details) : undefined;
      }
      return hasContextContract(messages, activeLineage)
        ? undefined
        : reconcileContextContract(messages, activeLineage);
    },
    onCompact(event, ctx) {
      if (!isOwned(ctx) || !ctx.sessionManager.getBranch().some((entry) => entry.id === event.compactionEntry.id)) {
        return;
      }
      const details = parseExperimentalCompaction(event.compactionEntry);
      const request = pending;
      if (request?.status !== "compacting" || !isOwned(ctx, request)) {
        if (details) lineage = details;
        return;
      }
      if (!details || details.requestId !== request.requestId) {
        request.status = "failed";
        request.errorMessage = "Compaction completed without the requested context marker.";
        return;
      }
      lineage = details;
      request.status = "completed";
    },
    onCompactFailed(event, ctx) {
      const request = pending;
      if (request?.status !== "compacting" || !isOwned(ctx, request)) return;
      if (event.aborted) {
        pending = undefined;
        return;
      }
      request.status = "failed";
      request.errorMessage = event.errorMessage ?? "Compaction failed.";
    },
    onAgentStart(ctx) {
      if (isOwned(ctx)) agentRunActive = true;
    },
    onAgentEnd(event, ctx) {
      const request = pending;
      if (!request || !isOwned(ctx, request)) return;
      const stopReason = latestAssistantStopReason(event.messages);
      if (ctx.signal?.aborted || stopReason === "aborted") {
        pending = undefined;
        return;
      }
      if (request.turnStartedAfterRequest && (stopReason === "stop" || stopReason === "toolUse")) {
        request.successfulTurnAfterRequest = true;
      }
    },
    onTurnStart(ctx) {
      const request = pending;
      if (request && isOwned(ctx, request)) request.turnStartedAfterRequest = true;
    },
    onAgentSettled(ctx) {
      if (!isOwned(ctx)) return;
      agentRunActive = ctx.signal !== undefined;
      if (agentRunActive) return;
      if (removeToolsAtSettlement) {
        removeToolsAtSettlement = false;
        if (!isConfigured()) {
          if (latestContextMode(ctx.sessionManager.getBranch()) !== "inactive") {
            pi.sendMessage(deactivationMessage(), { triggerTurn: false });
          }
          toolsAvailable = false;
          removeOwnedTools(inspectToolUnit().ownedNames);
        }
      }
      const request = pending;
      if (!request || !isOwned(ctx, request)) return;
      if (!isConfigured() && (request.status === "requested" || request.status === "compacting")) {
        request.status = "failed";
        request.errorMessage = "Experimental context management was disabled before rollover completed.";
      }
      if (request.status === "completed") {
        if (request.successfulTurnAfterRequest) pending = undefined;
        else continueAfterRollover(ctx, request);
        return;
      }
      if (request.status === "failed") {
        failRollover(ctx, request, request.errorMessage ?? "Compaction failed.");
        return;
      }
      if (request.status !== "requested") return;
      request.status = "compacting";
      ctx.compact({
        onComplete: (result) => {
          if (!isOwned(ctx, request)) return;
          if (request.status === "failed") {
            failRollover(
              ctx,
              request,
              request.errorMessage ?? "Compaction completed without the requested context marker.",
            );
            return;
          }
          const details = parseExperimentalCompaction(result);
          if (request.status !== "completed" || !details || details.requestId !== request.requestId) {
            failRollover(ctx, request, "Compaction completed without the requested context marker.");
            return;
          }
          lineage = details;
          if (request.successfulTurnAfterRequest) pending = undefined;
          else continueAfterRollover(ctx, request);
        },
        onError: (error) => failRollover(ctx, request, error.message),
      });
    },
    shutdown() {
      generation += 1;
      controller.abort();
      ownerSessionId = undefined;
      lineage = undefined;
      pending = undefined;
      warned = false;
      warnedOpaque = false;
      warnedUnavailableTools = false;
      toolsAvailable = false;
      removeToolsAtSettlement = false;
      fallbackDeactivationPending = false;
      agentRunActive = false;
    },
  };
}
