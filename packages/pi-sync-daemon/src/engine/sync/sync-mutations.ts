import { createSyncBackend, type SyncBackendFactory } from "../backends/backend-factory.js";
import {
  expectedRemoteHead,
  type PublishSnapshotResult,
  type RemoteHead,
  type SyncBackend,
} from "../backends/sync-backend.js";
import type { CommandOptions } from "../commands/command-types.js";
import type { EngineContext as ExtensionCommandContext, EngineContext as ExtensionContext } from "../host.js";
import { loadConfig, syncCheckConfigFingerprint } from "../settings/config.js";
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
  regenerateSnapshotIdentity,
  scanSnapshot,
  snapshotIncludesSessions,
  snapshotWithoutSessions,
} from "../snapshot/snapshot.js";
import { applySnapshot } from "../snapshot/snapshot-apply.js";
import { ignorePolicyValidator } from "../snapshot/snapshot-transaction-policy.js";
import type { Snapshot } from "../snapshot/snapshot-types.js";
import { pruneMergeBaselines } from "../state/merge-baseline-store.js";
import type { SyncState } from "../state/state-types.js";
import { readStateForConfig, syncStateFingerprint, writeStateForConfig } from "../state/sync-state-store.js";
import {
  countPreservedRemoteFiles,
  formatPublicationPreview,
  formatPullSummary,
  formatPushSummary,
  formatRollbackSummary,
  formatTransferReview,
} from "../ui/sync-format.js";
import { setSyncStatus } from "../ui/sync-status.js";
import { confirmTransferReview } from "../ui/transfer-review.js";
import { startupTransferEnabled } from "./agent-policy.js";
import { inspectCaseCleanup, revalidateCaseCleanup } from "./apply-review.js";
import { confirmFieldMigration } from "./field-migration.js";
import { overlayLocalFields, portableSnapshot, sameLocalFields, validatePortableSnapshot } from "./local-fields.js";
import { readMergeJournal, requireNoMergeJournal, retireMergeJournal } from "./merge-journal.js";
import { mergeSync } from "./merged-sync.js";
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
import { errorMessage } from "./sync-errors.js";

import { backupLocal, captureMutationOwner, protectedSessionPaths } from "./sync-local.js";
import {
  formatIgnorePolicyComparison,
  inspectRemoteSelection,
  requireLegacyTransferPolicy,
  syncSelectionHasContent,
  syncSessionsSelected,
} from "./sync-policy.js";
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
  directionalApplyGuards,
  requireIgnoreBaselineReview,
  requireResolvedDirectionalProgress,
  validateDirectionalPublication,
} from "./transfer-freshness.js";

const VERSION = 1;
const POST_LOCAL_COMMIT_TIMEOUT_MS = 30_000;

export class PublicationStatePersistenceError extends Error {
  readonly head: RemoteHead;
  readonly backupPath?: string;

  constructor(head: RemoteHead, cause: unknown, backupPath?: string) {
    super(
      `Remote publication ${head.snapshotId} is active, but local sync state could not be saved${backupPath ? `; local backup: ${backupPath}` : ""}: ${errorMessage(cause)}`,
      { cause },
    );
    this.name = "PublicationStatePersistenceError";
    this.head = head;
    this.backupPath = backupPath;
  }
}

export class RollbackPublicationError extends Error {
  readonly backupPath: string;

  constructor(backupPath: string, cause: unknown) {
    super(`Rollback applied locally with backup ${backupPath}, but remote publication failed: ${errorMessage(cause)}`, {
      cause,
    });
    this.name = "RollbackPublicationError";
    this.backupPath = backupPath;
  }
}

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
  const validateOwner = captureMutationOwner(ctx, options.signal);
  const validateCommittedOwner = captureMutationOwner(ctx);
  const config = input?.config ?? (await loadConfig(options.setup, options.signal));
  const validateMutation = () => {
    validateOwner();
    options.background?.validate(config);
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
  throwIfAborted(options.signal);
  const snapshotOptions = await resolvedSnapshotOptionsForContext(ctx, config, options.signal);
  validateMutation();
  const validateIgnorePolicy = ignorePolicyValidator({ ...snapshotOptions, validateMutation });
  const localRaw = input?.local ?? (await createSnapshot(config.snapshotIdentity, snapshotOptions));
  const local = portableSnapshot(localRaw, config.localFields);
  if (validateIgnorePolicy) await validateIgnorePolicy();
  throwIfAborted(options.signal);

  let head = await backend.readHead(options.signal);
  let remoteForUpload = await readRemoteSnapshotForUpload(backend, config, head, state, options);
  validateMutation();
  if (config.ignorePolicy && remoteForUpload && options.force && (options.auto || options.yes || !ctx.hasUI)) {
    const comparison = inspectRemoteSelection(config.include, remoteForUpload, config.exclude, config);
    if (comparison.kind === "different") requireCompatibleRemoteSelection(config, remoteForUpload);
  }
  requireIgnoreBaselineReview(ctx, config, state, options);
  if (remoteForUpload && !options.force) {
    requireCompatibleRemoteSelection(config, remoteForUpload);
  }
  if (
    remoteChangedSinceState(head, state, config, (left, right) => backend.sameRevision(left, right)) &&
    !options.force
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
  let upload = await snapshotForUpload(backend, config, local, head, remoteForUpload, snapshotOptions);
  if (!config.skipSecretScan) {
    const secrets = scanSnapshot(local);
    if (secrets.length > 0) {
      throw new Error(`Refusing to push possible secrets:\n${secrets.map((s) => `- ${s}`).join("\n")}`);
    }
  }

  if (!(await confirmPush(ctx, options, config, backend, local, upload, head, remoteForUpload, validateMutation))) {
    return "cancelled" as const;
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
  if (configIdentity !== syncCheckConfigFingerprint(await loadConfig(options.setup)))
    throw new Error("Settings changed during push review.");
  validateMutation();
  if (
    config.scope === "agent-directory" ||
    validateIgnorePolicy ||
    !options.yes ||
    config.localFields !== undefined ||
    (await readMergeJournal(config))
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
  if (configIdentity !== syncCheckConfigFingerprint(await loadConfig(options.setup)))
    throw new Error("Settings changed during push review.");
  validateMutation();
  const validatePublication =
    validateIgnorePolicy || options.background
      ? () =>
          validateDirectionalPublication(
            ctx,
            config,
            snapshotOptions,
            state,
            fileHashMap(localRaw),
            validateIgnorePolicy ??
              (async () => {
                if (configIdentity !== syncCheckConfigFingerprint(await loadConfig(options.setup, options.signal)))
                  throw new Error("Settings changed before push publication.");
                validateMutation();
              }),
            "push",
          )
      : undefined;
  if (validateIgnorePolicy) {
    validatePortableSnapshot(upload);
    await validateIgnorePolicy();
  }
  const result = await backend.publishSnapshot(upload, expectedRemoteHead(head), {
    signal: options.signal,
    onCommit: options.onCommit,
    ...(validatePublication ? { validateIgnorePolicy: validatePublication } : {}),
  });
  try {
    await writeStateForConfig(
      config,
      {
        version: VERSION,
        profile: config.snapshotIdentity,
        lastAppliedSnapshot: result.head.snapshotId,
        lastRemoteRevision: result.head.revision,
        lastFileHashes: fileHashMap(local),
        ...acceptedSelection(config),
        ...(config.localFields !== undefined ? { localFields: config.localFields } : {}),
      },
      local,
      validateCommittedOwner,
    );
  } catch (error) {
    throw new PublicationStatePersistenceError(result.head, error);
  }
  await retireMergeJournal(config);
  await pruneMergeBaselines(config, await readStateForConfig(config), validateCommittedOwner);
  validateCommittedOwner();
  if (options.signal?.aborted) return;
  setSyncStatus(ctx, undefined);
  if (!options.silent) {
    ctx.ui.notify(
      [
        `Pushed ${upload.files.length} files from sync setup “${config.setupName}” as ${result.head.snapshotId}.`,
        ...result.warnings,
      ]
        .filter(Boolean)
        .join("\n"),
      result.warnings.length > 0 ? "warning" : "info",
    );
  }
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
  const validateMutation = captureMutationOwner(ctx, options.signal);
  const validateCommittedOwner = captureMutationOwner(ctx);
  const config = await loadConfig(options.setup);
  validateMutation();
  const configIdentity = syncCheckConfigFingerprint(config);
  if (initial && initial.configIdentity !== configIdentity)
    throw new Error("Settings changed before initial pull; run sync again.");
  await requireNoMergeJournal(config, options);
  setSyncStatus(ctx, `pulling ${config.setupName}`, { activity: "pulling" });
  const backend = await factory(config);
  const state = await readStateForConfig(config);
  validateMutation();
  if (initial && initial.stateIdentity !== syncStateFingerprint(state))
    throw new Error("Baseline changed before initial pull; run sync again.");
  requireResolvedDirectionalProgress(state, options);
  const snapshotOptions = await resolvedSnapshotOptionsForContext(ctx, config, options.signal);
  validateMutation();
  const validateIgnorePolicy = ignorePolicyValidator({ ...snapshotOptions, validateMutation });
  if (initial && initial.sessionDir !== snapshotOptions.sessionDir)
    throw new Error("Pi session storage changed before initial pull; run sync again.");
  const local = await createSnapshot(config.snapshotIdentity, snapshotOptions);
  validateMutation();
  if (initial && !sameHashes(initial.localHashes, fileHashMap(local)))
    throw new Error("Local bytes changed before initial pull; run sync again.");
  const { head, snapshot: remote } = await readRemoteSnapshot(backend, config, options.signal, snapshotOptions);
  validateMutation();
  if (initial && !matchesInitialHead(initial, backend, head))
    throw new Error("Remote changed before initial pull; run sync again.");
  requireIgnoreBaselineReview(ctx, config, state, options);
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
  if (config.scope === "agent-directory") requireStableMergeSessionRoot(local, physical, config.scope);
  const reviewedProtectedPaths = protectedSessionPaths(ctx, snapshotOptions.sessionDir);
  const remoteChanged = hasRemoteChanges(remote, state, config, reviewedProtectedPaths);
  if (localChanged && remoteChanged && state.lastAppliedSnapshot && !options.force) {
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

  const caseCleanup = options.yes ? [] : await inspectCaseCleanup(physical, snapshotOptions);
  validateMutation();
  if (
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
  if (configIdentity !== syncCheckConfigFingerprint(await loadConfig(options.setup)))
    throw new Error("Settings changed during pull review.");
  validateMutation();
  const refreshed = await createSnapshot(config.snapshotIdentity, snapshotOptions);
  if (!sameHashes(fileHashMap(local), fileHashMap(refreshed)))
    throw new Error("Local bytes changed during pull review.");
  if (!sameRemoteHead(backend, head, await backend.readHead(options.signal)))
    throw new Error("Remote changed during pull review.");
  validateMutation();
  const backup = await backupLocal(config.snapshotIdentity, snapshotOptions, options.signal);
  const applySessionDir = await sessionDirForApply(ctx, physical, snapshotOptions);
  if (recoveringMerge) await requireFreshRecovery();
  const currentState = await readStateForConfig(config);
  validateMutation();
  if (
    (validateIgnorePolicy || initial || !options.yes) &&
    syncStateFingerprint(currentState) !== syncStateFingerprint(state)
  )
    throw new Error("Baseline changed during pull review.");
  requireResolvedDirectionalProgress(currentState, options);
  if (!options.yes) await revalidateCaseCleanup(caseCleanup, physical, snapshotOptions);
  if (initial && !matchesInitialHead(initial, backend, await backend.readHead(options.signal)))
    throw new Error("Remote changed during initial pull; run sync again.");
  validateMutation();
  if (config.scope && applySessionDir !== (await effectiveSessionRoot(ctx, config, options.signal)))
    throw new Error("Pi session storage changed during pull review.");
  validateMutation();
  if (configIdentity !== syncCheckConfigFingerprint(await loadConfig(options.setup)))
    throw new Error("Settings changed during pull review.");
  validateMutation();
  if (validateIgnorePolicy) {
    if (!sameRemoteHead(backend, head, await backend.readHead(options.signal)))
      throw new Error("Remote changed during pull review.");
    await validateIgnorePolicy();
  }
  const protectedPaths = protectedSessionPaths(ctx, snapshotOptions.sessionDir);
  const applyGuards = directionalApplyGuards({
    ctx,
    config,
    backend,
    state,
    sessionDir: snapshotOptions.sessionDir,
    head,
    protectedPaths: reviewedProtectedPaths,
    signal: options.signal,
    onCommit: options.onCommit,
    validateMutation,
    validateIgnorePolicy,
  });
  applyGuards.validateMutation();
  if (!validateIgnorePolicy) options.onCommit?.();
  const lastFileHashes = await applySnapshot(physical, protectedPaths, {
    ...snapshotOptions,
    sessionDir: applySessionDir,
    ...applyGuards,
    ...(config.scope === "agent-directory" || validateIgnorePolicy ? { reviewedLocal: local } : {}),
    expectedFileHashes: config.localFields?.length
      ? { "settings.json": fileHashMap(local)["settings.json"] ?? null }
      : undefined,
  });
  // Local installation is complete; user cancellation must not leave the baseline stale.
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
  await retireMergeJournal(config);
  await pruneMergeBaselines(config, await readStateForConfig(config), validateCommittedOwner);
  validateCommittedOwner();
  if (options.signal?.aborted) return "applied" as const;
  setSyncStatus(ctx, undefined);
  if (!options.silent) {
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

export async function rollback(
  ctx: ExtensionCommandContext,
  options: CommandOptions,
  factory: SyncBackendFactory = createSyncBackend,
  expectedSelection?: { backendIdentity: string; setup?: string; snapshotId?: string },
) {
  const validateMutation = captureMutationOwner(ctx, options.signal);
  const validateCommittedOwner = captureMutationOwner(ctx);
  const target = options.args[0];
  if (!target) throw new Error("Usage: /sync rollback <snapshot-id> [--yes]");

  const config = await loadConfig(options.setup);
  validateMutation();
  if (config.ignorePolicy && (options.yes || options.auto || !ctx.hasUI))
    throw new Error("Ignore-file rollback requires a separate foreground review; --yes cannot confirm it.");
  const backend = await factory(config);
  if (
    expectedSelection &&
    (backend.identity !== expectedSelection.backendIdentity || config.setupName !== expectedSelection.setup)
  ) {
    throw new Error("Sync setup or storage location changed while history was open; reopen history and retry.");
  }
  // --force is only a rollback compatibility flag, not a reviewed merge-recovery direction.
  await requireNoMergeJournal(config);
  const state = await readStateForConfig(config);
  validateMutation();
  requireIgnoreBaselineReview(ctx, config, state, options);
  requireResolvedDirectionalProgress(state, options, false);
  const decoded = await backend.readSnapshot(target, options.signal);
  validateMutation();
  validatePortableSnapshot(decoded);
  if (!config.ignorePolicy) requireLegacyTransferPolicy(decoded);
  if (config.ignorePolicy && expectedSelection?.snapshotId && decoded.id !== expectedSelection.snapshotId)
    throw new Error("Historical snapshot changed while history was open; reopen history and retry.");
  if (!sameLocalFields(decoded.localFields, config.localFields))
    throw new Error(
      "Rollback requires the historical snapshot local-field policy to match the configured rules. Review push --force from current local bytes to migrate policy first; choose matching history afterward.",
    );
  const snapshotOptions = await resolvedSnapshotOptionsForContext(ctx, config, options.signal);
  validateMutation();
  const validateIgnorePolicy = ignorePolicyValidator({ ...snapshotOptions, validateMutation });
  const selected = filterSnapshotForConfigPolicy(
    config.ignorePolicy || syncSessionsSelected(config) ? decoded : snapshotWithoutSessions(decoded),
    config,
    snapshotOptions,
  );
  const remote = portableSnapshot(regenerateSnapshotIdentity(selected), config.localFields);
  const local = await createSnapshot(config.snapshotIdentity, snapshotOptions);
  const expectedHead = await backend.readHead(options.signal);
  const currentRemote = expectedHead
    ? await readSnapshotForHead(backend, expectedHead, options.signal, config)
    : undefined;
  validateMutation();
  if (config.ignorePolicy && currentRemote) requireCompatibleRemoteSelection(config, currentRemote);
  if (!(await confirmFieldMigration(ctx, config, state, currentRemote, true, options.signal))) return;
  validateMutation();
  const physical = overlayLocalFields(remote, local, config.localFields);
  if (config.scope === "agent-directory") requireStableMergeSessionRoot(local, physical, config.scope);
  const upload = config.ignorePolicy
    ? remote
    : await snapshotForUpload(backend, config, remote, expectedHead, currentRemote, snapshotOptions);
  if (config.scope === "agent-directory") validatePortableSnapshot(upload);
  const caseCleanup = options.yes ? [] : await inspectCaseCleanup(physical, snapshotOptions);
  validateMutation();
  const reviewedProtectedPaths = protectedSessionPaths(ctx, snapshotOptions.sessionDir);

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
    const confirmed = config.ignorePolicy
      ? await confirmTransferReview(
          ctx,
          title,
          formatTransferReview(
            "Historical files are projected through this device's current ignore rules. Historical rules are not adopted. Retained history is not erased.",
            "",
            summary,
            "",
            "Remote publication:",
            formatPublicationPreview(currentRemote, upload),
          ),
          options.signal,
          validateMutation,
        )
      : await ctx.ui.confirm(title, summary.content, { signal: options.signal });
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
  if ((validateIgnorePolicy || !options.yes) && syncStateFingerprint(currentState) !== syncStateFingerprint(state))
    throw new Error("Baseline changed during rollback review.");
  requireResolvedDirectionalProgress(currentState, options, false);
  if (!options.yes) await revalidateCaseCleanup(caseCleanup, physical, snapshotOptions);
  if (config.scope && applySessionDir !== (await effectiveSessionRoot(ctx, config, options.signal)))
    throw new Error("Pi session storage changed during rollback review.");
  validateMutation();
  if (syncCheckConfigFingerprint(config) !== syncCheckConfigFingerprint(await loadConfig(options.setup)))
    throw new Error("Settings changed during rollback review.");
  validateMutation();
  if (validateIgnorePolicy) {
    if (!sameRemoteHead(backend, expectedHead, await backend.readHead(options.signal)))
      throw new Error("Remote changed during rollback review.");
    await validateIgnorePolicy();
  }
  const protectedPaths = protectedSessionPaths(ctx, snapshotOptions.sessionDir);
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
    validateIgnorePolicy,
  });
  applyGuards.validateMutation();
  if (!validateIgnorePolicy) options.onCommit?.();
  const lastFileHashes = await applySnapshot(physical, protectedPaths, {
    ...snapshotOptions,
    sessionDir: applySessionDir,
    ...applyGuards,
    ...(config.scope === "agent-directory" || validateIgnorePolicy ? { reviewedLocal: local } : {}),
    expectedFileHashes: config.localFields?.length
      ? { "settings.json": fileHashMap(local)["settings.json"] ?? null }
      : undefined,
  });
  // The local transaction is retired; finish publication despite caller cancellation.
  validateCommittedOwner();
  let result: PublishSnapshotResult;
  try {
    const signal = AbortSignal.timeout(POST_LOCAL_COMMIT_TIMEOUT_MS);
    const validatePolicy = ignorePolicyValidator({
      ...snapshotOptions,
      signal,
      validateMutation: validateCommittedOwner,
    });
    const validatePublication = validatePolicy
      ? () =>
          validateDirectionalPublication(
            ctx,
            config,
            { ...snapshotOptions, sessionDir: applySessionDir, signal },
            state,
            lastFileHashes,
            validatePolicy,
            "rollback",
          )
      : undefined;
    result = await backend.publishSnapshot(upload, expectedRemoteHead(expectedHead), {
      signal,
      ...(validatePublication ? { validateIgnorePolicy: validatePublication } : {}),
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

async function maybeReload(
  ctx: ExtensionCommandContext | ExtensionContext,
  signal?: AbortSignal,
  validateMutation = captureMutationOwner(ctx, signal),
) {
  if (signal?.aborted || typeof ctx.reload !== "function") return;
  validateMutation();
  if (
    ctx.hasUI &&
    (await ctx.ui.confirm(
      "Reload Pi resources now?",
      "This reloads extensions, skills, prompts, themes, and context files.",
    ))
  ) {
    if (signal?.aborted) return;
    validateMutation();
    await ctx.reload();
  }
}

async function confirmPush(
  ctx: ExtensionCommandContext | ExtensionContext,
  options: CommandOptions,
  config: AnySyncConfig,
  backend: SyncBackend,
  local: Snapshot,
  upload: Snapshot,
  head: RemoteHead | undefined,
  remote: Snapshot | undefined,
  validateMutation: () => void,
  title = snapshotIncludesSessions(upload) ? "Push pi settings and sessions?" : "Push pi settings?",
) {
  validateMutation();
  if (options.yes) return true;
  const summary = formatPushSummary(
    config,
    backend.destination,
    upload,
    head,
    countPreservedRemoteFiles(local, upload),
    remote,
  );
  const comparison =
    config.ignorePolicy && remote
      ? inspectRemoteSelection(config.include, remote, config.exclude, config).ignorePolicyComparison
      : undefined;
  const confirmed = await confirmTransferReview(
    ctx,
    title,
    comparison && comparison !== "match"
      ? formatTransferReview(
          formatIgnorePolicyComparison(comparison),
          "Only files selected by this device's rules are published. Remote rules are not adopted.",
          "",
          summary,
        )
      : summary,
    options.signal,
    validateMutation,
  );
  throwIfAborted(options.signal);
  if (confirmed) return true;
  setSyncStatus(ctx, undefined);
  ctx.ui.notify("Push cancelled.", "info");
  return false;
}

function matchesInitialHead(initial: InitialPullEvidence, backend: SyncBackend, current: RemoteHead | undefined) {
  return sameRemoteHead(backend, initial.head, current);
}

export { backupLocal } from "./sync-local.js";
