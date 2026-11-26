import { createSyncBackend, type SyncBackendFactory } from "../backends/backend-factory.js";
import { expectedRemoteHead, type PublishSnapshotResult } from "../backends/sync-backend.js";
import type { CommandOptions } from "../commands/command-types.js";
import type { EngineContext as ExtensionCommandContext } from "../host.js";
import { loadConfig, syncCheckConfigFingerprint } from "../settings/config.js";
import {
  effectiveSessionRoot,
  requireStableMergeSessionRoot,
  resolvedSnapshotOptionsForContext,
  sessionDirForApply,
} from "../snapshot/session-paths.js";
import {
  createSnapshot,
  filterSnapshotForConfigPolicy,
  regenerateSnapshotIdentity,
  snapshotIncludesSessions,
  snapshotWithoutSessions,
} from "../snapshot/snapshot.js";
import { applySnapshot } from "../snapshot/snapshot-apply.js";
import type { Snapshot } from "../snapshot/snapshot-types.js";
import { pruneMergeBaselines } from "../state/merge-baseline-store.js";
import { readStateForConfig, syncStateFingerprint, writeStateForConfig } from "../state/sync-state-store.js";
import { formatRollbackSummary } from "../ui/sync-format.js";
import { inspectCaseCleanup, revalidateCaseCleanup } from "./apply-review.js";
import { confirmFieldMigration } from "./field-migration.js";
import { overlayLocalFields, portableSnapshot, sameLocalFields, validatePortableSnapshot } from "./local-fields.js";
import { requireNoMergeJournal, retireMergeJournal } from "./merge-journal.js";
import { readSnapshotForHead, sameRemoteHead, snapshotForUpload } from "./remote-snapshot.js";
import { throwIfAborted } from "./signals.js";
import { PublicationStatePersistenceError, RollbackPublicationError } from "./sync-errors.js";
import { backupLocal, captureMutationOwner, maybeReload, protectedSessionPaths } from "./sync-local.js";
import { requireLegacyTransferPolicy, syncSessionsSelected } from "./sync-policy.js";
import { acceptedSelection, fileHashMap, sameHashes } from "./sync-state.js";
import {
  checkLiveProtection,
  directionalApplyGuards,
  requireResolvedDirectionalProgress,
} from "./transfer-freshness.js";

import {
  requireTransferSize,
  selectedPublicationImage,
  selectedPullImage,
  transferSizeLimitsEnabled,
} from "./transfer-size-limits.js";

const VERSION = 1;
const POST_LOCAL_COMMIT_TIMEOUT_MS = 30_000;

export async function rollback(
  ctx: ExtensionCommandContext,
  options: CommandOptions,
  factory: SyncBackendFactory = createSyncBackend,
  expectedSelection?: { backendIdentity: string; setup?: string; snapshotId?: string },
) {
  if (options.directionalAction) throw new Error("Single-action transfer cannot authorize rollback.");
  const validateMutation = captureMutationOwner(ctx, options.signal);
  const validateCommittedOwner = captureMutationOwner(ctx);
  const target = options.args[0];
  if (!target) throw new Error("Usage: /sync rollback <snapshot-id> [--yes]");

  const config = await loadConfig(options.setup);
  validateMutation();

  const backend = await factory(config);
  if (
    expectedSelection &&
    (backend.identity !== expectedSelection.backendIdentity || config.setupName !== expectedSelection.setup)
  ) {
    throw new Error("Sync setup or storage location changed while history was open; reopen history and retry.");
  }
  await requireNoMergeJournal(config);
  const state = await readStateForConfig(config);
  validateMutation();
  requireResolvedDirectionalProgress(state, options, false);
  const decoded = await backend.readSnapshot(target, options.signal);
  validateMutation();
  validatePortableSnapshot(decoded);
  requireLegacyTransferPolicy(decoded);

  if (!sameLocalFields(decoded.localFields, config.localFields))
    throw new Error(
      "Rollback requires the historical snapshot local-field policy to match the configured rules. Review push --force from current local bytes to migrate policy first; choose matching history afterward.",
    );
  const snapshotOptions = await resolvedSnapshotOptionsForContext(ctx, config, options.signal);
  validateMutation();
  const selected = filterSnapshotForConfigPolicy(
    syncSessionsSelected(config) ? decoded : snapshotWithoutSessions(decoded),
    config,
    snapshotOptions,
  );
  const remote = portableSnapshot(regenerateSnapshotIdentity(selected), config.localFields);
  const local = await createSnapshot(config.snapshotIdentity, snapshotOptions);
  const expectedHead = await backend.readHead(options.signal);
  const currentRemote = expectedHead ? await readSnapshotForHead(backend, expectedHead, options.signal) : undefined;
  validateMutation();

  if (!(await confirmFieldMigration(ctx, config, state, currentRemote, true, options.signal))) return;
  validateMutation();
  const physical = overlayLocalFields(remote, local, config.localFields);
  if (config.scope === "agent-directory") requireStableMergeSessionRoot(local, physical, config.scope);
  const upload: Snapshot = await snapshotForUpload(
    backend,
    config,
    remote,
    expectedHead,
    currentRemote,
    snapshotOptions,
  );
  validateMutation();
  if (config.scope === "agent-directory") validatePortableSnapshot(upload);
  const caseCleanup = options.yes ? [] : await inspectCaseCleanup(physical, snapshotOptions);
  validateMutation();
  const reviewedProtectedPaths = protectedSessionPaths(ctx, snapshotOptions.sessionDir);
  const sizeLimited = transferSizeLimitsEnabled(config);
  if (sizeLimited)
    requireTransferSize(
      config,
      selectedPullImage(remote, local, reviewedProtectedPaths),
      selectedPublicationImage(upload, config, snapshotOptions.sessionDir),
    );

  if (!options.yes) {
    const title = snapshotIncludesSessions(remote) ? "Rollback pi settings and sessions?" : "Rollback pi settings?";
    const summary = formatRollbackSummary(
      config,
      backend.destination,
      local,
      physical,
      target,
      reviewedProtectedPaths,
      caseCleanup.map((item) => item.path),
    );
    const confirmed = await ctx.ui.confirm(title, summary.content, { signal: options.signal });
    validateMutation();
    if (!confirmed) {
      ctx.ui.notify("Rollback cancelled.", "info");
      return;
    }
  }

  validateMutation();
  const currentLocal = await createSnapshot(config.snapshotIdentity, snapshotOptions);
  if (!sameHashes(fileHashMap(currentLocal), fileHashMap(local)))
    throw new Error("Local bytes changed during rollback review.");
  if (syncCheckConfigFingerprint(config) !== syncCheckConfigFingerprint(await loadConfig(options.setup)))
    throw new Error("Settings changed during rollback review.");
  if (!sameRemoteHead(backend, expectedHead, await backend.readHead(options.signal)))
    throw new Error("Remote changed during rollback review.");
  validateMutation();
  throwIfAborted(options.signal);
  const backup = await backupLocal(config.snapshotIdentity, snapshotOptions, options.signal);
  const applySessionDir = await sessionDirForApply(ctx, config.scope ? physical : remote, snapshotOptions);
  const currentState = await readStateForConfig(config);
  if (!options.yes && syncStateFingerprint(currentState) !== syncStateFingerprint(state))
    throw new Error("Baseline changed during rollback review.");
  requireResolvedDirectionalProgress(currentState, options, false);
  if (!options.yes) await revalidateCaseCleanup(caseCleanup, physical, snapshotOptions);
  if (config.scope && applySessionDir !== (await effectiveSessionRoot(ctx, config, options.signal)))
    throw new Error("Pi session storage changed during rollback review.");
  validateMutation();
  if (syncCheckConfigFingerprint(config) !== syncCheckConfigFingerprint(await loadConfig(options.setup)))
    throw new Error("Settings changed during rollback review.");
  validateMutation();

  const protectedPaths = protectedSessionPaths(ctx, snapshotOptions.sessionDir);
  if (sizeLimited) checkLiveProtection(ctx, snapshotOptions.sessionDir, reviewedProtectedPaths);
  const applyGuards = directionalApplyGuards({
    ctx,
    config,
    backend,
    state,
    sessionDir: snapshotOptions.sessionDir,
    head: expectedHead,
    protectedPaths: reviewedProtectedPaths,
    signal: options.signal,
    onCommit: options.onCommit,
    validateMutation,

    validateSettings: async () => {
      if (
        syncCheckConfigFingerprint(config) !==
        syncCheckConfigFingerprint(await loadConfig(options.setup, options.signal))
      )
        throw new Error("Settings changed before rollback apply.");
      validateMutation();
      if (sizeLimited) checkLiveProtection(ctx, snapshotOptions.sessionDir, reviewedProtectedPaths);
    },
  });
  applyGuards.validateMutation();
  options.onCommit?.();
  const lastFileHashes = await applySnapshot(physical, protectedPaths, {
    ...snapshotOptions,
    sessionDir: applySessionDir,
    ...applyGuards,
    ...(config.scope === "agent-directory" || sizeLimited ? { reviewedLocal: local } : {}),
    expectedFileHashes: config.localFields?.length
      ? { "settings.json": fileHashMap(local)["settings.json"] ?? null }
      : undefined,
  });
  validateCommittedOwner();
  let result: PublishSnapshotResult;
  try {
    const signal = AbortSignal.timeout(POST_LOCAL_COMMIT_TIMEOUT_MS);
    result = await backend.publishSnapshot(upload, expectedRemoteHead(expectedHead), {
      signal,
    });
  } catch (error) {
    throw new RollbackPublicationError(backup, error);
  }
  try {
    await writeStateForConfig(
      config,
      {
        version: VERSION,
        profile: config.snapshotIdentity,
        lastAppliedSnapshot: result.head.snapshotId,
        lastRemoteRevision: result.head.revision,
        lastFileHashes: config.localFields?.length
          ? { ...lastFileHashes, "settings.json": fileHashMap(remote)["settings.json"] }
          : lastFileHashes,
        ...acceptedSelection(config),
        ...(config.localFields !== undefined ? { localFields: config.localFields } : {}),
      },
      remote,
      validateCommittedOwner,
    );
  } catch (error) {
    throw new PublicationStatePersistenceError(result.head, error, backup);
  }
  await retireMergeJournal(config);
  await pruneMergeBaselines(config, await readStateForConfig(config), validateCommittedOwner);
  validateCommittedOwner();
  if (options.signal?.aborted) return;
  ctx.ui.notify(
    [
      `Rolled back sync setup “${config.setupName}” to ${target}; latest: ${result.head.snapshotId}. Backup: ${backup}`,
      ...result.warnings,
    ]
      .filter(Boolean)
      .join("\n"),
    result.warnings.length > 0 ? "warning" : "info",
  );
  await maybeReload(ctx, options.signal, validateMutation);
}
