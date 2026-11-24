import { createSyncBackend, type SyncBackendFactory } from "../backends/backend-factory.js";
import {
  expectedRemoteHead,
  type PublishSnapshotResult,
  type RemoteHead,
  type SyncBackend,
  SyncBackendConflictError,
} from "../backends/sync-backend.js";
import type { CommandOptions } from "../commands/command-types.js";
import type { EngineContext as ExtensionCommandContext, EngineContext as ExtensionContext } from "../host.js";
import { loadAdoptionJournal, requireNoPendingAdoption } from "../ignore/adoption-journal.js";
import { loadConfig, loadConfigForCheck, syncCheckConfigFingerprint } from "../settings/config.js";
import type { AnySyncConfig } from "../settings/settings-types.js";
import {
  effectiveSessionRoot,
  requireStableMergeSessionRoot,
  resolvedSnapshotOptionsForContext,
  sessionDirForApply,
} from "../snapshot/session-paths.js";
import {
  createSnapshot,
  filterSnapshotForConfigPolicy,
  scanSnapshot,
  snapshotIncludesSessions,
} from "../snapshot/snapshot.js";
import { applySnapshot } from "../snapshot/snapshot-apply.js";
import { pendingTransactionEntries } from "../snapshot/snapshot-transaction-directory.js";
import { ignorePolicyValidator } from "../snapshot/snapshot-transaction-policy.js";
import type { Snapshot } from "../snapshot/snapshot-types.js";
import { pruneMergeBaselines } from "../state/merge-baseline-store.js";
import type { SyncState } from "../state/state-types.js";
import { readStateForConfig, syncStateFingerprint, writeStateForConfig } from "../state/sync-state-store.js";
import { formatPullSummary } from "../ui/sync-format.js";
import { setSyncStatus } from "../ui/sync-status.js";
import { confirmTransferReview } from "../ui/transfer-review.js";
import { startupTransferEnabled } from "./agent-policy.js";
import { inspectCaseCleanup, revalidateCaseCleanup } from "./apply-review.js";
import {
  checkpointDirectionalAction,
  foregroundDirectionalAction,
  keepProtectedRemoteSessions,
  localRestoreGuidance,
  notifyDirectionalSuccess,
  remoteRestoreGuidance,
  requireDirectionalPullBoundary,
  requireDirectionalSelection,
  validateDirectionalSettings,
} from "./directional-action.js";
import { confirmFieldMigration } from "./field-migration.js";
import { adoptionSettingsFingerprint, adoptRemoteRules, canReviewAdoption } from "./ignore-adoption.js";
import { withPublishedIgnoreRules } from "./ignore-publication.js";
import { overlayLocalFields, portableSnapshot, sameLocalFields, validatePortableSnapshot } from "./local-fields.js";
import { readMergeJournal, requireNoMergeJournal, retireMergeJournal } from "./merge-journal.js";
import { mergeSync } from "./merged-sync.js";
import { confirmPush } from "./push-review.js";
import {
  readRemoteSnapshot,
  readRemoteSnapshotForUpload,
  readSnapshotForHead,
  requireCompatibleRemoteSelection,
  sameRemoteHead,
  snapshotForUpload,
} from "./remote-snapshot.js";
import { throwIfAborted } from "./signals.js";
import { createSyncDecision } from "./sync-decision.js";
import { errorMessage, PublicationStatePersistenceError } from "./sync-errors.js";

import {
  backupDirectionalSnapshot,
  backupLocal,
  captureMutationOwner,
  LocalBackupVerificationError,
  maybeReload,
  protectedSessionPaths,
} from "./sync-local.js";
import { inspectRemoteSelection, syncSelectionHasContent, syncSessionsSelected } from "./sync-policy.js";
import {
  acceptedSelection,
  canPullRemoteSessionsOnFirstSync,
  canPullRemoteSettingsOnFirstSync,
  fileHashMap,
  hasLocalChanges,
  hasRemoteChanges,
  remoteChangedSinceState,
  sameHashes,
  shouldRefreshSyncedState,
  snapshotHashesMatchState,
  snapshotsMatch,
  syncPolicyChanged,
} from "./sync-state.js";
import {
  checkLiveProtection,
  directionalApplyGuards,
  requireIgnoreBaselineReview,
  requireResolvedDirectionalProgress,
  validateDirectionalPublication,
} from "./transfer-freshness.js";

import {
  requireTransferSize,
  selectedPublicationImage,
  selectedPullImage,
  transferSizeLimitsEnabled,
} from "./transfer-size-limits.js";

const VERSION = 1;

export { PublicationStatePersistenceError, RollbackPublicationError } from "./sync-errors.js";
export { rollback } from "./sync-rollback.js";

interface PushInput {
  config: AnySyncConfig;
  state: SyncState;
  local: Snapshot;
  backend?: SyncBackend;
}

export async function push(
  ctx: ExtensionCommandContext | ExtensionContext,
  options: CommandOptions,
  input?: PushInput,
  factory: SyncBackendFactory = createSyncBackend,
) {
  requireNoPendingAdoption();
  const validateOwner = captureMutationOwner(ctx, options.signal);
  const validateCommittedOwner = captureMutationOwner(ctx);
  const action = foregroundDirectionalAction(ctx, options);
  if (action && input) throw new Error("Single-action Push must load the bound foreground setup.");
  const config = action
    ? await loadConfigForCheck(undefined, options.signal)
    : (input?.config ?? (await loadConfig(options.setup, options.signal)));
  const validateMutation = () => {
    validateOwner();
    options.background?.validate(config);
    action?.validate(config);
  };
  validateMutation();
  await requireNoMergeJournal(config, options);
  const state = input?.state ?? (await readStateForConfig(config));
  validateMutation();
  requireResolvedDirectionalProgress(state, options);
  if (
    options.auto &&
    (config.scope === "agent-directory" ||
      state.scope !== undefined ||
      config.reservedIgnoreNames !== undefined ||
      state.ignorePolicyKey !== undefined) &&
    (options.force || !state.lastAppliedSnapshot || syncPolicyChanged(state, config))
  ) {
    throw new Error("Automatic push requires an accepted baseline with matching content policy.");
  }
  setSyncStatus(ctx, `pushing ${config.setupName}`, { activity: "pushing" });
  const backend = input?.backend ?? (await factory(config));
  validateMutation();
  const snapshotOptions = await resolvedSnapshotOptionsForContext(ctx, config, options.signal);
  if (action) snapshotOptions.sessionDir = await effectiveSessionRoot(ctx, config, options.signal);
  validateMutation();
  const validateIgnorePolicy = ignorePolicyValidator({ ...snapshotOptions, validateMutation });
  const localRaw = input?.local ?? (await createSnapshot(config.snapshotIdentity, snapshotOptions));
  const local = portableSnapshot(localRaw, config.localFields);
  const reviewedProtectedPaths = action ? protectedSessionPaths(ctx, snapshotOptions.sessionDir) : new Set<string>();
  if (validateIgnorePolicy) await validateIgnorePolicy();
  throwIfAborted(options.signal);

  let head = await backend.readHead(options.signal);
  let remoteForUpload =
    action && head
      ? await readSnapshotForHead(backend, head, options.signal, config)
      : await readRemoteSnapshotForUpload(backend, config, head, state, options);
  validateMutation();
  const policyOverwrite = Boolean(
    config.ignorePolicy &&
      remoteForUpload &&
      inspectRemoteSelection(config.include, remoteForUpload, config.exclude, config).kind === "different",
  );
  if (policyOverwrite && remoteForUpload && (options.auto || options.background || options.yes || !ctx.hasUI))
    requireCompatibleRemoteSelection(config, remoteForUpload);
  if (action && !policyOverwrite)
    requireDirectionalSelection(config, state, localRaw, remoteForUpload, snapshotOptions.sessionDir);
  else requireIgnoreBaselineReview(ctx, config, state, options);
  if (!action && remoteForUpload && !options.force && !policyOverwrite) {
    requireCompatibleRemoteSelection(config, remoteForUpload);
  }
  if (
    !action &&
    remoteChangedSinceState(head, state, config, (left, right) => backend.sameRevision(left, right)) &&
    !options.force &&
    !policyOverwrite
  ) {
    const remoteForConflict = remoteForUpload
      ? filterSnapshotForConfigPolicy(remoteForUpload, config, snapshotOptions)
      : undefined;
    if (!remoteForConflict || !snapshotHashesMatchState(remoteForConflict, state, config)) {
      throw createSyncDecision({
        kind: head ? "remote-or-policy-changed" : "remote-empty",
        config,
        state,
        local,
        remote: remoteForConflict,
        localChanged: hasLocalChanges(local, state, config),
        remoteChanged: true,
        directMessage: "Remote or sync policy changed since last sync. Run /sync pull first or /sync push --force.",
      });
    }
  }

  if (!remoteForUpload && head && (config.localFields !== undefined || !options.yes))
    remoteForUpload = await readSnapshotForHead(backend, head, options.signal, config);
  validateMutation();
  if (!(await confirmFieldMigration(ctx, config, state, remoteForUpload, options.force, options.signal))) {
    setSyncStatus(ctx, undefined);
    return "cancelled" as const;
  }
  const configIdentity = syncCheckConfigFingerprint(config);
  const validateSettings = async () => {
    if (action) await validateDirectionalSettings(options, config, validateMutation);
    else if (configIdentity !== syncCheckConfigFingerprint(await loadConfig(options.setup, options.signal)))
      throw new Error("Settings changed during push review.");
    validateMutation();
  };
  const checkUpload = (upload: Snapshot) => {
    if (transferSizeLimitsEnabled(config))
      requireTransferSize(config, selectedPublicationImage(upload, config, snapshotOptions.sessionDir));
  };
  let upload = await snapshotForUpload(backend, config, local, head, remoteForUpload, snapshotOptions);
  if (action) {
    upload = keepProtectedRemoteSessions(
      config,
      upload,
      remoteForUpload,
      snapshotOptions.sessionDir,
      reviewedProtectedPaths,
    );
    validatePortableSnapshot(upload);
  }
  upload = await withPublishedIgnoreRules(upload, config, options.signal);
  validateMutation();
  checkUpload(upload);
  if (!config.skipSecretScan) {
    const secrets = scanSnapshot({ ...local, ...(upload.ignoreRules ? { ignoreRules: upload.ignoreRules } : {}) });
    if (secrets.length > 0) {
      throw new Error(`Refusing to push possible secrets:\n${secrets.map((s) => `- ${s}`).join("\n")}`);
    }
  }

  if (
    (!action || policyOverwrite) &&
    !(await confirmPush(ctx, options, config, backend, local, upload, head, remoteForUpload, validateMutation))
  ) {
    return "cancelled" as const;
  }
  if (action) {
    await checkpointDirectionalAction(options, {
      direction: "push",
      config,
      state,
      local: localRaw,
      remote: remoteForUpload,
      head,
      sessionDir: snapshotOptions.sessionDir,
      protectedPaths: reviewedProtectedPaths,
    });
    validateMutation();
  }

  if (options.force) {
    const refreshedHead = await backend.readHead(options.signal);
    validateMutation();
    if (!sameRemoteHead(backend, head, refreshedHead)) {
      if (config.ignorePolicy) throw new Error("Remote changed during ignore-file push review; reopen the review.");
      head = refreshedHead;
      remoteForUpload = head ? await readSnapshotForHead(backend, head, options.signal, config) : undefined;
      validateMutation();
      if (!(await confirmFieldMigration(ctx, config, state, remoteForUpload, options.force, options.signal))) {
        setSyncStatus(ctx, undefined);
        return "cancelled" as const;
      }
      validateMutation();
      upload = await snapshotForUpload(backend, config, local, head, remoteForUpload, snapshotOptions);
      validateMutation();
      checkUpload(upload);
      if (
        !(await confirmPush(
          ctx,
          options,
          config,
          backend,
          local,
          upload,
          head,
          remoteForUpload,
          validateMutation,
          "Remote changed during review. Push the refreshed plan?",
        ))
      ) {
        return "cancelled" as const;
      }
    }
  }

  validateMutation();
  await validateSettings();
  if (
    !action &&
    (config.scope === "agent-directory" ||
      validateIgnorePolicy ||
      !options.yes ||
      config.localFields !== undefined ||
      (await readMergeJournal(config)))
  ) {
    const current = await createSnapshot(config.snapshotIdentity, snapshotOptions);
    if (!sameHashes(fileHashMap(current), fileHashMap(localRaw)))
      throw new Error("Local content changed during push review; retry from current bytes.");
  }
  const currentState = await readStateForConfig(config);
  if ((validateIgnorePolicy || !options.yes) && syncStateFingerprint(currentState) !== syncStateFingerprint(state))
    throw new Error("Baseline changed during push review.");
  requireResolvedDirectionalProgress(currentState, options);
  if (
    config.scope === "agent-directory" &&
    snapshotOptions.sessionDir !== (await effectiveSessionRoot(ctx, config, options.signal))
  )
    throw new Error("Pi session storage changed during push review.");
  validateMutation();
  await validateSettings();
  const validatePublication =
    validateIgnorePolicy || options.background || action
      ? async () => {
          if (action && !sameRemoteHead(backend, head, await backend.readHead(options.signal)))
            throw new Error("Remote changed before Push could publish.");
          validateMutation();
          await validateDirectionalPublication(
            ctx,
            config,
            snapshotOptions,
            state,
            fileHashMap(localRaw),
            action
              ? async () => {
                  await validateIgnorePolicy?.();
                  await validateDirectionalSettings(options, config, validateMutation);
                  checkLiveProtection(ctx, snapshotOptions.sessionDir, reviewedProtectedPaths);
                }
              : (validateIgnorePolicy ?? validateSettings),
            "push",
            Boolean(action),
          );
        }
      : validateSettings;
  if (validateIgnorePolicy) {
    validatePortableSnapshot(upload);
    await validateIgnorePolicy();
  }
  if (action) await validatePublication?.();
  const accepted = action ? filterSnapshotForConfigPolicy(upload, config, snapshotOptions) : local;
  const restore =
    action && head && remoteForUpload
      ? remoteRestoreGuidance(head, remoteForUpload, config, snapshotOptions.sessionDir)
      : undefined;
  let result: PublishSnapshotResult;
  let startedPublication = false;
  try {
    result = await backend.publishSnapshot(upload, expectedRemoteHead(head), {
      ...(restore ? { preservePreviousHead: true } : {}),
      signal: options.signal,
      onCommit: action
        ? () => {
            options.onCommit?.();
            startedPublication = true;
          }
        : options.onCommit,
      validateIgnorePolicy: validatePublication,
    });
  } catch (error) {
    if (!action || (!startedPublication && options.signal?.aborted)) throw error;
    const mightCommit =
      startedPublication && !(error instanceof SyncBackendConflictError && error.phase === "before-commit");
    const phase = mightCommit ? "Push publication outcome is not verified." : "Push did not replace the remote head.";
    throw new Error([phase, errorMessage(error), startedPublication ? restore : undefined].filter(Boolean).join(" "), {
      cause: error,
    });
  }
  try {
    await writeStateForConfig(
      config,
      {
        version: VERSION,
        profile: config.snapshotIdentity,
        lastAppliedSnapshot: result.head.snapshotId,
        lastRemoteRevision: result.head.revision,
        lastFileHashes: fileHashMap(accepted),
        ...acceptedSelection(config),
        ...(config.localFields !== undefined ? { localFields: config.localFields } : {}),
      },
      accepted,
      validateCommittedOwner,
    );
  } catch (error) {
    const persistence = new PublicationStatePersistenceError(result.head, error);
    throw restore ? new Error(`${persistence.message} ${restore}`, { cause: persistence }) : persistence;
  }
  try {
    if (!action) await retireMergeJournal(config);
    await pruneMergeBaselines(config, await readStateForConfig(config), validateCommittedOwner);
    validateCommittedOwner();
  } catch (error) {
    if (!action) throw error;
    throw new Error(
      [
        `Remote publication ${result.head.snapshotId} is active, but final bookkeeping failed: ${errorMessage(error)}`,
        restore,
      ]
        .filter(Boolean)
        .join(" "),
      { cause: error },
    );
  }
  if (!options.signal?.aborted) setSyncStatus(ctx, undefined);
  if (options.signal?.aborted && !action) return;
  notifyDirectionalSuccess(
    ctx,
    options,
    [
      `Pushed ${upload.files.length} files from sync setup “${config.setupName}” as ${result.head.snapshotId}.`,
      restore,
      ...result.warnings,
    ]
      .filter(Boolean)
      .join("\n"),
    result.warnings.length > 0,
  );
  return "applied" as const;
}

interface InitialPullEvidence {
  configIdentity: string;
  stateIdentity: string;
  sessionDir: string | undefined;
  localHashes: Record<string, string>;
  head: RemoteHead | undefined;
}

export async function pull(
  ctx: ExtensionCommandContext | ExtensionContext,
  options: CommandOptions,
  factory: SyncBackendFactory = createSyncBackend,
  initial?: InitialPullEvidence,
) {
  const action = foregroundDirectionalAction(ctx, options);
  if (action && initial) throw new Error("Single-action Pull cannot be used for initial-source selection.");
  const adoptionReview = !initial && canReviewAdoption(ctx, options);
  const journal = adoptionReview ? await loadAdoptionJournal() : undefined;
  if (!adoptionReview) requireNoPendingAdoption();
  const validateOwner = captureMutationOwner(ctx, options.signal);
  const validateCommittedOwner = captureMutationOwner(ctx);
  const config = action ? await loadConfigForCheck(undefined, options.signal) : await loadConfig(options.setup);
  const validateMutation = () => {
    validateOwner();
    action?.validate(config);
  };
  validateMutation();
  const configIdentity = syncCheckConfigFingerprint(config);
  if (initial && initial.configIdentity !== configIdentity)
    throw new Error("Settings changed before initial pull; run sync again.");
  await requireNoMergeJournal(config, options);
  if (action && !journal && (await pendingTransactionEntries()).length)
    throw new Error("A pending local transaction must be reconciled before Pull; its evidence was retained.");
  validateMutation();
  setSyncStatus(ctx, `pulling ${config.setupName}`, { activity: "pulling" });
  const backend = await factory(config);
  const state = await readStateForConfig(config);
  validateMutation();
  if (initial && initial.stateIdentity !== syncStateFingerprint(state))
    throw new Error("Baseline changed before initial pull; run sync again.");
  requireResolvedDirectionalProgress(state, options);
  const snapshotOptions = await resolvedSnapshotOptionsForContext(ctx, config, options.signal);
  if (action) snapshotOptions.sessionDir = await effectiveSessionRoot(ctx, config, options.signal);
  validateMutation();
  if (journal) {
    if (
      journal.setupName !== config.setupName ||
      journal.setupFingerprint !== adoptionSettingsFingerprint(config) ||
      config.pathPolicy !== "ignore-file"
    )
      throw new Error(
        "Pending rule adoption belongs to a different setup. Preserve its journal and use the originating setup.",
      );
    const remote = await readSnapshotForHead(backend, journal.head, options.signal, config);
    validateMutation();
    return adoptRemoteRules({
      ctx,
      options,
      config,
      backend,
      state,
      head: journal.head,
      remote,
      snapshotOptions,
      validateMutation,
      journal,
    });
  }
  const validateIgnorePolicy = ignorePolicyValidator({ ...snapshotOptions, validateMutation });
  if (initial && initial.sessionDir !== snapshotOptions.sessionDir)
    throw new Error("Pi session storage changed before initial pull; run sync again.");
  const local = await createSnapshot(config.snapshotIdentity, snapshotOptions);
  validateMutation();
  if (initial && !sameHashes(initial.localHashes, fileHashMap(local)))
    throw new Error("Local bytes changed before initial pull; run sync again.");
  let preimageRemote: Snapshot | undefined;
  let adoption: Snapshot | undefined;
  const { head, snapshot: remote } = await readRemoteSnapshot(backend, config, options.signal, {
    ...snapshotOptions,
    ...(action || (adoptionReview && config.ignorePolicy)
      ? {
          validateSelection: (raw: Snapshot) => {
            const comparison = inspectRemoteSelection(
              config.include,
              raw,
              config.exclude,
              config,
            ).ignorePolicyComparison;
            if (adoptionReview && comparison === "mismatch") {
              adoption = raw;
            } else if (action) {
              requireDirectionalSelection(config, state, local, raw, snapshotOptions.sessionDir);
              preimageRemote = raw;
            } else {
              requireCompatibleRemoteSelection(config, raw);
            }
          },
        }
      : {}),
  });
  validateMutation();
  if (adoption && head)
    return adoptRemoteRules({
      ctx,
      options,
      config,
      backend,
      state,
      head,
      remote: adoption,
      snapshotOptions,
      validateMutation,
    });
  if (initial && !matchesInitialHead(initial, backend, head))
    throw new Error("Remote changed before initial pull; run sync again.");
  if (!action) requireIgnoreBaselineReview(ctx, config, state, options);
  const localChanged = hasLocalChanges(local, state, config);
  if (!remote) {
    throw createSyncDecision({
      kind: "remote-empty",
      config,
      state,
      local,
      localChanged,
      remoteChanged: false,
      directMessage: "Remote is empty. Run /sync push from a configured machine first.",
    });
  }

  if (!sameLocalFields(config.localFields, remote.localFields)) {
    setSyncStatus(ctx, undefined);
    throw new Error(
      "Pull requires the configured local-field policy to match the remote. To change the remote policy, review push --force from the authoritative machine first, then pull using matching rules; old history is not erased.",
    );
  }
  if (!(await confirmFieldMigration(ctx, config, state, remote, options.force, options.signal))) {
    setSyncStatus(ctx, undefined);
    return "cancelled" as const;
  }
  const logical = portableSnapshot(remote, config.localFields);
  const physical = overlayLocalFields(logical, local, config.localFields);
  if (action || config.scope === "agent-directory") requireStableMergeSessionRoot(local, physical, config.scope);
  const reviewedProtectedPaths = protectedSessionPaths(ctx, snapshotOptions.sessionDir);
  const sizeLimited = transferSizeLimitsEnabled(config);
  if (sizeLimited) requireTransferSize(config, selectedPullImage(logical, local, reviewedProtectedPaths));
  const remoteChanged = hasRemoteChanges(remote, state, config, reviewedProtectedPaths);
  if (!action && localChanged && remoteChanged && state.lastAppliedSnapshot && !options.force) {
    throw createSyncDecision({
      kind: "both-changed",
      config,
      state,
      local,
      remote,
      localChanged,
      remoteChanged,
      directMessage:
        "Both local and remote changed since last sync. Run /sync diff, then choose /sync pull --force or /sync push --force.",
    });
  }

  const caseCleanup = action || options.yes ? [] : await inspectCaseCleanup(physical, snapshotOptions);
  validateMutation();
  if (
    !action &&
    !options.yes &&
    !(await confirmTransferReview(
      ctx,
      snapshotIncludesSessions(remote) ? "Pull pi settings and sessions?" : "Pull pi settings?",
      formatPullSummary(
        config,
        backend.destination,
        local,
        physical,
        reviewedProtectedPaths,
        caseCleanup.map((item) => item.path),
      ),
      options.signal,
      validateMutation,
    ))
  ) {
    setSyncStatus(ctx, undefined);
    ctx.ui.notify("Pull cancelled.", "info");
    return "cancelled" as const;
  }

  const validateActionBoundary = action
    ? () =>
        requireDirectionalPullBoundary(
          ctx,
          options,
          config,
          config.scope ? physical : { ...physical, files: [...local.files, ...physical.files] },
          snapshotOptions,
          reviewedProtectedPaths,
          validateMutation,
        )
    : undefined;
  if (action) {
    await checkpointDirectionalAction(options, {
      direction: "pull",
      config,
      state,
      local,
      remote: preimageRemote,
      head,
      sessionDir: snapshotOptions.sessionDir,
      protectedPaths: reviewedProtectedPaths,
    });
    validateMutation();
    await validateActionBoundary?.();
  }

  throwIfAborted(options.signal);
  const recoveringMerge = Boolean(await readMergeJournal(config));
  const requireFreshRecovery = async () => {
    validateMutation();
    const currentHead = await backend.readHead(options.signal);
    validateMutation();
    const current = await createSnapshot(config.snapshotIdentity, snapshotOptions);
    validateMutation();
    if (!sameHashes(fileHashMap(current), fileHashMap(local)) || !sameRemoteHead(backend, head, currentHead)) {
      throw new Error("Local or remote content changed during recovery review; retry from a fresh diff.");
    }
  };
  if (recoveringMerge) await requireFreshRecovery();
  if (!action && configIdentity !== syncCheckConfigFingerprint(await loadConfig(options.setup)))
    throw new Error("Settings changed during pull review.");
  validateMutation();
  const refreshed = await createSnapshot(config.snapshotIdentity, snapshotOptions);
  if (!sameHashes(fileHashMap(local), fileHashMap(refreshed)))
    throw new Error("Local bytes changed during pull review.");
  if (!sameRemoteHead(backend, head, await backend.readHead(options.signal)))
    throw new Error("Remote changed during pull review.");
  validateMutation();
  const restorePoint = action ? await backupDirectionalSnapshot(local, options.signal) : undefined;
  const backup =
    restorePoint?.backupPath ?? (await backupLocal(config.snapshotIdentity, snapshotOptions, options.signal));
  let mayHaveApplied = false;
  let installed = false;
  try {
    const applySessionDir = action
      ? snapshotOptions.sessionDir
      : await sessionDirForApply(ctx, physical, snapshotOptions);
    if (recoveringMerge) await requireFreshRecovery();
    const currentState = await readStateForConfig(config);
    validateMutation();
    if (
      (validateIgnorePolicy || initial || !options.yes) &&
      syncStateFingerprint(currentState) !== syncStateFingerprint(state)
    )
      throw new Error("Baseline changed during pull review.");
    requireResolvedDirectionalProgress(currentState, options);
    if (!action && !options.yes) await revalidateCaseCleanup(caseCleanup, physical, snapshotOptions);
    if (initial && !matchesInitialHead(initial, backend, await backend.readHead(options.signal)))
      throw new Error("Remote changed during initial pull; run sync again.");
    validateMutation();
    if (config.scope && applySessionDir !== (await effectiveSessionRoot(ctx, config, options.signal)))
      throw new Error("Pi session storage changed during pull review.");
    validateMutation();
    if (!action && configIdentity !== syncCheckConfigFingerprint(await loadConfig(options.setup)))
      throw new Error("Settings changed during pull review.");
    validateMutation();
    if (validateIgnorePolicy) {
      if (!sameRemoteHead(backend, head, await backend.readHead(options.signal)))
        throw new Error("Remote changed during pull review.");
      await validateIgnorePolicy();
    }
    const protectedPaths = protectedSessionPaths(ctx, snapshotOptions.sessionDir);
    const validateApplySettings = async () => {
      if (configIdentity !== syncCheckConfigFingerprint(await loadConfig(options.setup, options.signal)))
        throw new Error("Settings changed before pull apply.");
      validateMutation();
      if (sizeLimited) checkLiveProtection(ctx, snapshotOptions.sessionDir, reviewedProtectedPaths);
    };
    const applyGuards = directionalApplyGuards({
      ctx,
      config,
      backend,
      state,
      sessionDir: snapshotOptions.sessionDir,
      head,
      protectedPaths: reviewedProtectedPaths,
      signal: options.signal,
      onCommit: action
        ? () => {
            options.onCommit?.();
            mayHaveApplied = true;
          }
        : options.onCommit,
      validateMutation,
      validateIgnorePolicy: action
        ? async () => {
            await restorePoint?.validate();
            await validateIgnorePolicy?.();
            await validateActionBoundary?.();
          }
        : validateIgnorePolicy,
      validateSettings: action ? undefined : validateApplySettings,
      effectiveRoot: Boolean(action),
    });
    applyGuards.validateMutation();
    if (!validateIgnorePolicy && !action) options.onCommit?.();
    const lastFileHashes = await applySnapshot(physical, protectedPaths, {
      ...snapshotOptions,
      sessionDir: applySessionDir,
      ...applyGuards,
      ...(action || config.scope === "agent-directory" || validateIgnorePolicy || sizeLimited
        ? { reviewedLocal: local }
        : {}),
      expectedFileHashes: config.localFields?.length
        ? { "settings.json": fileHashMap(local)["settings.json"] ?? null }
        : undefined,
    });
    // Local installation is complete; user cancellation must not leave the baseline stale.
    installed = true;
    validateCommittedOwner();
    await writeStateForConfig(
      config,
      {
        version: VERSION,
        profile: config.snapshotIdentity,
        lastAppliedSnapshot: remote.id,
        lastRemoteRevision: head?.revision,
        lastFileHashes: config.localFields?.length
          ? { ...lastFileHashes, "settings.json": fileHashMap(logical)["settings.json"] }
          : lastFileHashes,
        ...acceptedSelection(config),
        ...(config.localFields !== undefined ? { localFields: config.localFields } : {}),
      },
      logical,
      validateCommittedOwner,
    );
    if (!action) await retireMergeJournal(config);
    await pruneMergeBaselines(config, await readStateForConfig(config), validateCommittedOwner);
    validateCommittedOwner();
  } catch (error) {
    if (!action || (options.signal?.aborted && !mayHaveApplied)) throw error;
    const phase = installed
      ? "Local snapshot was applied, but final bookkeeping failed."
      : mayHaveApplied
        ? "Local apply did not finish; its outcome is not verified."
        : "Pull stopped before applying local files.";
    const message = `${phase} ${error instanceof LocalBackupVerificationError ? "" : `${localRestoreGuidance(backup)} `}${errorMessage(error)}`;
    if (error instanceof AggregateError) throw new AggregateError(error.errors, message, { cause: error });
    throw new Error(message, { cause: error });
  }
  if (options.signal?.aborted && !action) return "applied" as const;
  if (!options.signal?.aborted) setSyncStatus(ctx, undefined);
  if (action) {
    notifyDirectionalSuccess(ctx, options, `Pulled snapshot ${remote.id}. ${localRestoreGuidance(backup)}`);
  } else if (!options.silent) {
    ctx.ui.notify(`Pulled ${remote.files.length} files from ${remote.id}. Backup: ${backup}`, "info");
  } else if (options.auto && syncSessionsSelected(config) && snapshotIncludesSessions(remote)) {
    ctx.ui.notify(
      "Pulled Pi sessions after startup selected the current session. Restart Pi or resume a pulled session to use newly synced conversations.",
      "warning",
    );
  }
  if (options.reload) await maybeReload(ctx, options.signal, validateMutation);
  return "applied" as const;
}

export async function syncBoth(
  ctx: ExtensionCommandContext | ExtensionContext,
  options: CommandOptions,
  factory: SyncBackendFactory = createSyncBackend,
) {
  requireNoPendingAdoption();
  if (options.directionalAction) throw new Error("Single-action transfer cannot authorize bidirectional Sync.");
  const validateMutation = captureMutationOwner(ctx, options.signal);
  const config = await loadConfig(options.setup);
  throwIfAborted(options.signal);
  options.background?.validate(config);
  if (options.agentRetryRefusal) {
    if (!config.agentMode || options.auto || options.background || !ctx.hasUI)
      throw new Error("Enable Autonomous sync and use the foreground manager to retry a cached refusal.");
    const state = await readStateForConfig(config);
    validateMutation();
    const pending = await readMergeJournal(config);
    validateMutation();
    if (!syncSelectionHasContent(config) || !state.lastAppliedSnapshot || pending)
      throw new Error("Retry requires an accepted baseline and no pending journal. Use Sync now or reviewed recovery.");
    return mergeSync(ctx, options, factory);
  }
  if (syncSelectionHasContent(config) && options.auto && startupTransferEnabled(config))
    return mergeSync(ctx, options, factory);
  if (!options.auto && syncSelectionHasContent(config) && (await readMergeJournal(config)))
    return mergeSync(ctx, options, factory);
  const state = await readStateForConfig(config);
  throwIfAborted(options.signal);
  if (!options.auto && syncSelectionHasContent(config) && state.lastAppliedSnapshot)
    return mergeSync(ctx, options, factory);
  if (!syncSelectionHasContent(config)) {
    options.noteDebugOutcome?.("skipped");
    if (!options.silent) {
      ctx.ui.notify(
        `Sync setup “${config.setupName}” includes no files. Choose included content in /sync Settings before syncing.`,
        "warning",
      );
    }
    return;
  }
  const backend = await factory(config);
  const snapshotOptions = await resolvedSnapshotOptionsForContext(ctx, config, options.signal);
  validateMutation();
  const local = await createSnapshot(config.snapshotIdentity, snapshotOptions);
  throwIfAborted(options.signal);
  const { head, snapshot: remote } = await readRemoteSnapshot(backend, config, options.signal, snapshotOptions);
  throwIfAborted(options.signal);
  const localChanged = hasLocalChanges(local, state, config);
  const remoteChanged = remote
    ? hasRemoteChanges(remote, state, config, protectedSessionPaths(ctx, snapshotOptions.sessionDir))
    : false;
  if (options.auto) throw new Error("Automatic transfer is not authorized by the current settings.");

  // Established baselines return through mergeSync above; only initial-source selection remains.
  const portableLocal = portableSnapshot(local, config.localFields);
  const configIdentity = syncCheckConfigFingerprint(config);
  const pullInitialSource = () => {
    validateMutation();
    return pull(ctx, options, factory, {
      configIdentity,
      stateIdentity: syncStateFingerprint(state),
      sessionDir: snapshotOptions.sessionDir,
      localHashes: fileHashMap(local),
      head,
    });
  };
  const acceptMatchingState = async (snapshot: Snapshot) => {
    requireCompatibleRemoteSelection(config, snapshot);
    if (config.scope === "agent-directory") {
      const current = await createSnapshot(config.snapshotIdentity, snapshotOptions);
      const currentState = await readStateForConfig(config);
      const currentHead = await backend.readHead(options.signal);
      if (
        !sameHashes(fileHashMap(current), fileHashMap(local)) ||
        syncStateFingerprint(currentState) !== syncStateFingerprint(state) ||
        !sameRemoteHead(backend, head, currentHead)
      )
        throw new Error("Initial source changed before baseline acceptance; run sync again.");
      if (
        snapshotOptions.sessionDir !== (await effectiveSessionRoot(ctx, config, options.signal)) ||
        configIdentity !== syncCheckConfigFingerprint(await loadConfig(options.setup))
      )
        throw new Error("Settings or Pi session storage changed before baseline acceptance; run sync again.");
      validateMutation();
      const validateIgnorePolicy = ignorePolicyValidator({ ...snapshotOptions, validateMutation });
      if (validateIgnorePolicy) await validateIgnorePolicy();
    }
    const accepted = portableSnapshot(snapshot, config.localFields);
    await writeStateForConfig(
      config,
      {
        version: VERSION,
        profile: config.snapshotIdentity,
        lastAppliedSnapshot: snapshot.id,
        lastRemoteRevision: head?.revision,
        lastFileHashes: fileHashMap(accepted),
        ...acceptedSelection(config),
        ...(config.localFields !== undefined ? { localFields: config.localFields } : {}),
      },
      accepted,
      validateMutation,
    );
    await pruneMergeBaselines(config, await readStateForConfig(config), validateMutation);
    validateMutation();
  };
  if (remote && remote.files.length > 0 && local.files.length > 0) {
    requireCompatibleRemoteSelection(config, remote);
    const portableRemote = portableSnapshot(remote, config.localFields);
    if (!canPullRemoteSettingsOnFirstSync(portableLocal, portableRemote)) {
      throw createSyncDecision({
        kind: "first-sync-settings-diverged",
        config,
        state,
        local,
        remote,
        localChanged: true,
        remoteChanged: true,
        directMessage:
          "Remote settings exist and this machine has different local Pi settings. Run /sync diff, then manually choose /sync pull or /sync push.",
      });
    }
    if (!sameHashes(fileHashMap(portableLocal), fileHashMap(portableRemote))) {
      if (!canPullRemoteSessionsOnFirstSync(portableLocal, portableRemote)) {
        throw createSyncDecision({
          kind: "first-sync-sessions-diverged",
          config,
          state,
          local,
          remote,
          localChanged: true,
          remoteChanged: true,
          directMessage:
            "Remote settings match, but local and remote Pi sessions differ. Run /sync diff, then manually choose /sync pull or /sync push.",
        });
      }
      if ((await pullInitialSource()) === "cancelled") options.noteDebugOutcome?.("cancelled");
      return;
    }
    await acceptMatchingState(remote);
    if (!options.silent) ctx.ui.notify("pi-sync state initialized; local settings already match remote.", "info");
    return;
  }
  if (
    localChanged &&
    remoteChanged &&
    remote &&
    snapshotsMatch(portableLocal, portableSnapshot(remote, remote.localFields))
  ) {
    requireCompatibleRemoteSelection(config, remote);
    await acceptMatchingState(remote);
    if (!options.silent) ctx.ui.notify("pi-sync is already up to date.", "info");
    return;
  }
  if (remoteChanged) {
    if ((await pullInitialSource()) === "cancelled") options.noteDebugOutcome?.("cancelled");
    return;
  }
  if (localChanged || !remote) {
    if ((await push(ctx, options, { config, state, local, backend }, factory)) === "cancelled")
      options.noteDebugOutcome?.("cancelled");
    return;
  }
  if (shouldRefreshSyncedState(remote, head, state, config, (left, right) => backend.sameRevision(left, right))) {
    await acceptMatchingState(remote);
  } else options.noteDebugOutcome?.("skipped");
  if (!options.silent) ctx.ui.notify("pi-sync is already up to date.", "info");
}

function matchesInitialHead(initial: InitialPullEvidence, backend: SyncBackend, current: RemoteHead | undefined) {
  return sameRemoteHead(backend, initial.head, current);
}

export { backupLocal } from "./sync-local.js";
