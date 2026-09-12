import type { ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadConfig } from "../settings/config.js";
import { readStateForConfig, syncStateFingerprint } from "../state/sync-state-store.js";
import { combineSignals } from "../sync/signals.js";
import { errorMessage } from "../sync/sync-errors.js";
import type { SyncLoaders } from "../sync/sync-loaders.js";
import { formatRemoteSelectionMismatch } from "../sync/sync-policy.js";
import type { RunRouteResult } from "../ui/cancellable-operation.js";
import {
  observationMatchesConfig,
  type SyncAttentionController,
  type SyncAttentionOrigin,
  syncAttentionMatchesConfig,
} from "../ui/sync-attention.js";
import { parseOptions, splitArgs } from "./command.js";
import { executeCommand, executeRecoveryCommand } from "./command-execution.js";

const STATUS_KEY = "sync";

export async function handleCommand(
  rawArgs: string,
  ctx: ExtensionCommandContext,
  sessionSignal: AbortSignal,
  loaders: SyncLoaders,
  attention: SyncAttentionController,
) {
  await reconcileObservation(attention, sessionSignal);
  if (sessionSignal.aborted) return;
  const run = (route: string, signal?: AbortSignal, onCommit?: () => void, target?: string) =>
    executeCommand(
      route,
      ctx,
      combineSignals(sessionSignal, signal),
      loaders,
      observationCommitCallback(attention, sessionSignal, onCommit),
      target,
    );
  if (!rawArgs.trim()) {
    try {
      const { showSyncManager } = await import("../ui/manager-ui.js");
      if (sessionSignal.aborted) return;
      await showSyncManager(ctx, run, sessionSignal, {
        getAttention: () => attention.current(),
        getObservation: () => attention.observation(),
        onObservationInvalidated: () => attention.clearObservation(),
        onSelectionResolved: (expected) => {
          if (attention.current() === expected) attention.clear(ctx);
        },
      });
    } catch (error) {
      if (sessionSignal.aborted) return;
      ctx.ui.setStatus(STATUS_KEY, undefined);
      ctx.ui.notify(errorMessage(error), "error");
    }
    await reconcileObservation(attention, sessionSignal);
    if (!sessionSignal.aborted) await attention.publish(ctx, sessionSignal);
    return;
  }
  const result = await run(rawArgs);
  if (result.kind === "decision-required") {
    ctx.ui.notify(result.decision.directMessage, "error");
  } else if (result.kind === "remote-selection-required") {
    const origin = directSelectionOrigin(rawArgs);
    if (origin) attention.set(result.decision, origin);
    const deterministic = splitArgs(rawArgs).some((arg) => arg === "--yes" || arg === "-y");
    if (origin && ctx.mode === "tui" && !deterministic) {
      await resolveSelectionAttention(ctx, attention, sessionSignal, loaders);
    } else {
      ctx.ui.notify(
        formatRemoteSelectionMismatch(
          result.decision.setupName,
          result.decision.localInclude,
          result.decision.remoteInclude,
        ),
        "error",
      );
    }
  }
  await clearAttentionAfterCompletedOperation(rawArgs, result, ctx, attention, sessionSignal);
  await reconcileSelectionAttention(ctx, attention, sessionSignal);
  await reconcileObservation(attention, sessionSignal);
  if (!sessionSignal.aborted) await attention.publish(ctx, sessionSignal);
}

function observationCommitCallback(
  attention: SyncAttentionController,
  sessionSignal: AbortSignal,
  onCommit?: () => void,
) {
  const observed = attention.observation();
  return () => {
    // Opening or cancelling a review changes nothing. A commit may change data
    // even if later publication/baseline cleanup fails; never restore old hints.
    if (!sessionSignal.aborted && attention.observation() === observed) attention.clearObservation();
    onCommit?.();
  };
}

async function reconcileObservation(attention: SyncAttentionController, signal: AbortSignal) {
  const observed = attention.observation();
  if (!observed || signal.aborted) return;
  try {
    const config = await loadConfig();
    if (signal.aborted || attention.observation() !== observed) return;
    if (!observationMatchesConfig(observed, config)) {
      attention.clearObservation();
      return;
    }
    const state = await readStateForConfig(config);
    if (signal.aborted || attention.observation() !== observed) return;
    if (syncStateFingerprint(state) !== observed.inspection.stateIdentity) attention.clearObservation();
  } catch {
    if (!signal.aborted && attention.observation() === observed) attention.clearObservation();
  }
}

async function clearAttentionAfterCompletedOperation(
  rawArgs: string,
  result: RunRouteResult,
  ctx: ExtensionContext,
  attention: SyncAttentionController,
  signal: AbortSignal,
) {
  if (result.kind !== "completed" || result.outcome === "cancelled" || signal.aborted) return;
  const [command, ...rest] = splitArgs(rawArgs);
  if (command !== "sync" && command !== "pull" && command !== "push") return;
  const current = attention.current();
  if (!current) return;
  try {
    const options = parseOptions(rest);
    const setupName = options.setup ?? (await loadConfig()).setupName;
    if (signal.aborted || attention.current() !== current) return;
    if (current.decision.setupName === setupName) attention.clear(ctx);
  } catch {
    // Attention reconciliation below owns malformed or concurrently changed settings.
  }
}

async function reconcileSelectionAttention(
  ctx: ExtensionContext,
  attention: SyncAttentionController,
  signal: AbortSignal,
) {
  const current = attention.current();
  if (!current || signal.aborted) return;
  try {
    const config = await loadConfig(current.decision.setupName);
    if (signal.aborted || attention.current() !== current) return;
    if (!syncAttentionMatchesConfig(current, config)) attention.clear(ctx);
  } catch {
    if (!signal.aborted && attention.current() === current) attention.clear(ctx);
  }
}

function directSelectionOrigin(rawArgs: string): SyncAttentionOrigin | undefined {
  const command = splitArgs(rawArgs)[0];
  return command === "sync" || command === "pull" || command === "push" ? command : undefined;
}

export async function resolveSelectionAttention(
  ctx: ExtensionContext,
  attention: SyncAttentionController,
  signal: AbortSignal,
  loaders: SyncLoaders,
  options: {
    cancelLabel?: string;
    withStateAccess?: <T>(task: () => Promise<T>) => Promise<T>;
  } = {},
) {
  const current = attention.current();
  if (!current || signal.aborted) return;
  const { dispatchManagerResult } = await import("../ui/manager-result-dispatcher.js");
  if (signal.aborted || attention.current() !== current) return;
  await dispatchManagerResult(
    ctx,
    { kind: "remote-selection-required", decision: current.decision },
    current.origin,
    (route, actionSignal, onCommit, target) => {
      const execute = () =>
        executeRecoveryCommand(
          route,
          ctx,
          combineSignals(signal, actionSignal),
          loaders,
          observationCommitCallback(attention, signal, onCommit),
          target,
        );
      return options.withStateAccess ? options.withStateAccess(execute) : execute();
    },
    signal,
    {
      cancelLabel: options.cancelLabel,
      withStateAccess: options.withStateAccess,
      onSelectionResolved: () => {
        if (attention.current() === current) attention.clear(ctx);
      },
    },
  );
}
