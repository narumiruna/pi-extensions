import type { RemoteHead, SyncBackend } from "../backends/sync-backend.js";
import type { CommandOptions } from "../commands/command-types.js";
import type { EngineContext } from "../host.js";
import type { AnySyncConfig } from "../settings/settings-types.js";
import { effectiveSessionRoot, resolvedSnapshotOptionsForContext } from "../snapshot/session-paths.js";
import { createSnapshot } from "../snapshot/snapshot.js";
import { StaleIgnorePolicyError } from "../snapshot/snapshot-transaction-policy.js";
import type { Snapshot, SnapshotOptions } from "../snapshot/snapshot-types.js";
import type { SyncState } from "../state/state-types.js";
import { readStateForConfig, syncStateFingerprint } from "../state/sync-state-store.js";
import { ContinuousError } from "./continuous-errors.js";
import { preflightMergedTargets } from "./merge-apply.js";
import { sameRemoteHead } from "./remote-snapshot.js";
import { protectedSessionPaths } from "./sync-local.js";
import { fileHashMap, sameHashes, syncPolicyChanged } from "./sync-state.js";

export function requireResolvedDirectionalProgress(state: SyncState, options: CommandOptions, allowForce = true) {
  if (state.unresolved?.length && (options.auto || !options.force || !allowForce))
    throw new Error(
      "Unresolved partial conflicts remain. Review /sync conflicts or explicitly choose push --force or pull --force; automatic transfer and rollback cannot accept unresolved groups.",
    );
}

export function requireIgnoreBaselineReview(
  ctx: EngineContext,
  config: AnySyncConfig,
  state: SyncState,
  options: CommandOptions,
) {
  if (
    (config.ignorePolicy || config.reservedIgnoreNames !== undefined || state.ignorePolicyKey !== undefined) &&
    state.lastAppliedSnapshot &&
    syncPolicyChanged(state, config) &&
    (options.auto || options.yes || !ctx.hasUI)
  ) {
    throw new Error(
      "Local ignore-file policy or source changed since the last accepted baseline. Review a foreground directional transfer.",
    );
  }
}

export async function validateDirectionalPublication(
  ctx: EngineContext,
  config: AnySyncConfig,
  options: SnapshotOptions,
  state: SyncState,
  expectedHashes: Record<string, string>,
  validatePolicy: () => Promise<void>,
  direction: "push" | "rollback",
  effectiveRoot = false,
) {
  const current = await createSnapshot(config.snapshotIdentity, options);
  if (!sameHashes(fileHashMap(current), expectedHashes))
    throw new Error(`Local bytes changed at the ${direction} publication boundary.`);
  if (syncStateFingerprint(await readStateForConfig(config)) !== syncStateFingerprint(state))
    throw new Error(`Baseline changed at the ${direction} publication boundary.`);
  if (
    (config.scope === "agent-directory" || direction === "push") &&
    options.sessionDir !==
      (effectiveRoot
        ? await effectiveSessionRoot(ctx, config, options.signal)
        : (await resolvedSnapshotOptionsForContext(ctx, config, options.signal)).sessionDir)
  )
    throw new Error(`Pi session storage changed at the ${direction} publication boundary.`);
  await validatePolicy();
}

export function checkLiveProtection(ctx: EngineContext, sessionDir: string | undefined, reviewed: ReadonlySet<string>) {
  const current = protectedSessionPaths(ctx, sessionDir);
  if (current.size !== reviewed.size || [...current].some((item) => !reviewed.has(item)))
    throw new StaleIgnorePolicyError("Live session protection changed during review; reopen the review.");
}

export function directionalApplyGuards({
  ctx,
  config,
  backend,
  state,
  sessionDir,
  head,
  protectedPaths,
  signal,
  validateMutation,
  validateIgnorePolicy,
  validateSettings,
  onCommit,
  effectiveRoot = false,
}: {
  ctx: EngineContext;
  config: AnySyncConfig;
  backend: SyncBackend;
  state: SyncState;
  sessionDir?: string;
  head?: RemoteHead;
  protectedPaths: ReadonlySet<string>;
  signal?: AbortSignal;
  validateMutation: () => void;
  validateIgnorePolicy?: () => Promise<void>;
  validateSettings?: () => Promise<void>;
  onCommit?: () => void;
  effectiveRoot?: boolean;
}) {
  if (!validateIgnorePolicy) return { validateMutation, validateApplyReview: validateSettings };
  const validateOwner = () => {
    validateMutation();
    checkLiveProtection(ctx, sessionDir, protectedPaths);
  };
  let committed = false;
  return {
    validateMutation: validateOwner,
    validateApplyReview: async () => {
      if (!sameRemoteHead(backend, head, await backend.readHead(signal)))
        throw new StaleIgnorePolicyError("Remote changed before local apply; reopen the review.");
      if (syncStateFingerprint(await readStateForConfig(config)) !== syncStateFingerprint(state))
        throw new StaleIgnorePolicyError("Baseline changed before local apply; reopen the review.");
      if (
        sessionDir !==
        (effectiveRoot
          ? await effectiveSessionRoot(ctx, config, signal)
          : (await resolvedSnapshotOptionsForContext(ctx, config, signal)).sessionDir)
      )
        throw new StaleIgnorePolicyError("Pi session storage changed before local apply; reopen the review.");
      await validateSettings?.();
      await validateIgnorePolicy();
      validateOwner();
      if (!committed) {
        onCommit?.();
        committed = true;
      }
    },
  };
}

export async function validateMergeApplyReview(
  backend: SyncBackend,
  config: AnySyncConfig,
  head: RemoteHead,
  stateIdentity: string,
  validateFresh: () => Promise<void>,
  signal?: AbortSignal,
) {
  if (!sameRemoteHead(backend, head, await backend.readHead(signal)))
    throw new Error("Remote head changed before merged apply; journal and backup retained.");
  if (syncStateFingerprint(await readStateForConfig(config)) !== stateIdentity)
    throw new Error("Sync baseline changed before merged apply; journal and backup retained.");
  await validateFresh();
}

export async function validateMergedPublication(
  ctx: EngineContext,
  config: AnySyncConfig,
  options: SnapshotOptions,
  before: Snapshot,
  after: Snapshot,
  stateIdentity: string,
  validateFresh: () => Promise<void>,
) {
  await validateFresh();
  const current = await createSnapshot(config.snapshotIdentity, options);
  const state = await readStateForConfig(config);
  if (!sameHashes(fileHashMap(current), fileHashMap(before)) || syncStateFingerprint(state) !== stateIdentity)
    throw new ContinuousError(
      "stale",
      "Local content or baseline changed at publication; journal and backup retained.",
    );
  await preflightMergedTargets(current, after, options, [
    ...(ctx.protectedSessionFiles ?? []),
    ...[ctx.sessionManager.getSessionFile?.()].filter((file): file is string => Boolean(file)),
  ]);
  await validateFresh();
}
