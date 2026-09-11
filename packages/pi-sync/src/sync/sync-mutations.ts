import fs from "node:fs/promises";
import path from "node:path";
import type { ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createSyncBackend, type SyncBackendFactory } from "../backends/backend-factory.js";
import {
  expectedRemoteHead,
  type PublishSnapshotResult,
  type RemoteHead,
  type SyncBackend,
} from "../backends/sync-backend.js";
import type { CommandOptions } from "../commands/command-types.js";
import { loadConfig } from "../settings/config.js";
import type { AnySyncConfig } from "../settings/settings-types.js";
import { sessionDirForApply, sessionDirFromContext, snapshotOptionsForContext } from "../snapshot/session-paths.js";
import {
  createSnapshot,
  filterSnapshotForConfigPolicy,
  mergeRemotePreservedFiles,
  regenerateSnapshotIdentity,
  scanSnapshot,
  sessionSnapshotPathFromAbsolute,
  snapshotIncludesSessions,
  snapshotWithoutSessions,
} from "../snapshot/snapshot.js";
import { applySnapshot } from "../snapshot/snapshot-apply.js";
import { encodeSnapshot } from "../snapshot/snapshot-codec.js";
import type { Snapshot, SnapshotOptions } from "../snapshot/snapshot-types.js";
import { stateDir } from "../state/state-directory.js";
import type { SyncState } from "../state/state-types.js";
import { readStateForConfig, writeStateForConfig } from "../state/sync-state-store.js";
import {
  countPreservedRemoteFiles,
  formatPullSummary,
  formatPushSummary,
  formatRollbackSummary,
} from "../ui/sync-format.js";
import { readRemoteSnapshot, readSnapshotForHead, requireCompatibleRemoteSelection } from "./remote-snapshot.js";
import { throwIfAborted } from "./signals.js";
import { createSyncDecision } from "./sync-decision.js";
import { errorMessage } from "./sync-errors.js";
import { inspectRemoteSelection } from "./sync-policy.js";
import {
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

const STATUS_KEY = "sync";
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
  const config = input?.config ?? (await loadConfig(options.setup));
  throwIfAborted(options.signal);
  ctx.ui.setStatus(STATUS_KEY, `pushing ${config.setupName}`);
  const backend = input?.backend ?? (await factory(config));
  const state = input?.state ?? (await readStateForConfig(config));
  throwIfAborted(options.signal);
  const local = input?.local ?? (await createSnapshot(config.snapshotIdentity, snapshotOptionsForContext(ctx, config)));
  throwIfAborted(options.signal);

  let head = await backend.readHead(options.signal);
  let remoteForUpload = await readRemoteSnapshotForUpload(backend, config, head, state, options.signal);
  if (
    !options.force &&
    !remoteForUpload &&
    head?.selection &&
    inspectRemoteSelection(config.include, { selection: head.selection, files: [] }).kind === "different"
  ) {
    remoteForUpload = await readSnapshotForHead(backend, head, options.signal);
  }
  if (remoteForUpload && !options.force) {
    requireCompatibleRemoteSelection(config, remoteForUpload);
  }
  if (
    remoteChangedSinceState(head, state, config, (left, right) => backend.sameRevision(left, right)) &&
    !options.force
  ) {
    const remoteForConflict = remoteForUpload ? filterSnapshotForConfigPolicy(remoteForUpload, config) : undefined;
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

  let upload = await snapshotForUpload(backend, config, local, head, remoteForUpload, options.signal);
  if (!config.skipSecretScan) {
    const secrets = scanSnapshot(local);
    if (secrets.length > 0) {
      throw new Error(`Refusing to push possible secrets:\n${secrets.map((s) => `- ${s}`).join("\n")}`);
    }
  }

  if (!(await confirmPush(ctx, options, config, backend, local, upload, head, remoteForUpload))) {
    return "cancelled" as const;
  }

  if (options.force) {
    const refreshedHead = await backend.readHead(options.signal);
    if (!sameRemoteHead(backend, head, refreshedHead)) {
      head = refreshedHead;
      remoteForUpload = head ? await backend.readSnapshot(head.snapshotRef, options.signal) : undefined;
      upload = await snapshotForUpload(backend, config, local, head, remoteForUpload, options.signal);
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
          "Remote changed during review. Push the refreshed plan?",
        ))
      ) {
        return "cancelled" as const;
      }
    }
  }

  const result = await backend.publishSnapshot(upload, expectedRemoteHead(head), {
    signal: options.signal,
    onCommit: options.onCommit,
  });
  try {
    await writeStateForConfig(config, {
      version: VERSION,
      profile: config.snapshotIdentity,
      lastAppliedSnapshot: result.head.snapshotId,
      lastRemoteRevision: result.head.revision,
      lastFileHashes: fileHashMap(local),
      include: [...config.include],
    });
  } catch (error) {
    throw new PublicationStatePersistenceError(result.head, error);
  }
  if (options.signal?.aborted) return;
  ctx.ui.setStatus(STATUS_KEY, undefined);
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

export async function pull(
  ctx: ExtensionCommandContext | ExtensionContext,
  options: CommandOptions,
  factory: SyncBackendFactory = createSyncBackend,
) {
  const config = await loadConfig(options.setup);
  throwIfAborted(options.signal);
  ctx.ui.setStatus(STATUS_KEY, `pulling ${config.setupName}`);
  const backend = await factory(config);
  const state = await readStateForConfig(config);
  throwIfAborted(options.signal);
  const local = await createSnapshot(config.snapshotIdentity, snapshotOptionsForContext(ctx, config));
  throwIfAborted(options.signal);
  const { head, snapshot: remote } = await readRemoteSnapshot(backend, config, options.signal);
  throwIfAborted(options.signal);
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

  const remoteChanged = hasRemoteChanges(remote, state, config, protectedSessionPaths(ctx));
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

  if (
    !options.yes &&
    !(await ctx.ui.confirm(
      snapshotIncludesSessions(remote) ? "Pull pi settings and sessions?" : "Pull pi settings?",
      formatPullSummary(config, backend.destination, local, remote, protectedSessionPaths(ctx).size),
    ))
  ) {
    ctx.ui.setStatus(STATUS_KEY, undefined);
    ctx.ui.notify("Pull cancelled.", "info");
    return "cancelled" as const;
  }

  throwIfAborted(options.signal);
  const backup = await backupLocal(config.snapshotIdentity, snapshotOptionsForContext(ctx, config), options.signal);
  const applySessionDir = await sessionDirForApply(ctx, remote);
  throwIfAborted(options.signal);
  options.onCommit?.();
  const lastFileHashes = await applySnapshot(remote, protectedSessionPaths(ctx), {
    include: config.include,
    sessionDir: applySessionDir,
  });
  await writeStateForConfig(config, {
    version: VERSION,
    profile: config.snapshotIdentity,
    lastAppliedSnapshot: remote.id,
    lastRemoteRevision: head?.revision,
    lastFileHashes,
    include: [...config.include],
  });
  if (options.signal?.aborted) return "applied" as const;
  ctx.ui.setStatus(STATUS_KEY, undefined);
  if (!options.silent) {
    ctx.ui.notify(`Pulled ${remote.files.length} files from ${remote.id}. Backup: ${backup}`, "info");
  } else if (options.auto && config.include.includes("sessions") && snapshotIncludesSessions(remote)) {
    ctx.ui.notify(
      "Pulled Pi sessions after startup selected the current session. Restart Pi or resume a pulled session to use newly synced conversations.",
      "warning",
    );
  }
  if (options.reload) await maybeReload(ctx, options.signal);
  return "applied" as const;
}

export async function syncBoth(
  ctx: ExtensionCommandContext | ExtensionContext,
  options: CommandOptions,
  factory: SyncBackendFactory = createSyncBackend,
) {
  const config = await loadConfig(options.setup);
  throwIfAborted(options.signal);
  const backend = await factory(config);
  const state = await readStateForConfig(config);
  throwIfAborted(options.signal);
  const local = await createSnapshot(config.snapshotIdentity, snapshotOptionsForContext(ctx, config));
  throwIfAborted(options.signal);
  if (config.include.length === 0) {
    if (!options.silent) {
      ctx.ui.notify(
        `Sync setup “${config.setupName}” includes no files. Choose included content in /sync Settings before syncing.`,
        "warning",
      );
    }
    return;
  }
  const { head, snapshot: remote } = await readRemoteSnapshot(backend, config, options.signal);
  throwIfAborted(options.signal);
  const localChanged = hasLocalChanges(local, state, config);
  const remoteChanged = remote ? hasRemoteChanges(remote, state, config, protectedSessionPaths(ctx)) : false;
  const firstSync = !state.lastAppliedSnapshot;

  if (firstSync && remote && remote.files.length > 0 && local.files.length > 0) {
    if (!canPullRemoteSettingsOnFirstSync(local, remote)) {
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
    if (!sameHashes(fileHashMap(local), fileHashMap(remote))) {
      if (!canPullRemoteSessionsOnFirstSync(local, remote)) {
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
      await pull(ctx, options, factory);
      return;
    }
    await writeStateForConfig(config, {
      version: VERSION,
      profile: config.snapshotIdentity,
      lastAppliedSnapshot: remote.id,
      lastRemoteRevision: head?.revision,
      lastFileHashes: fileHashMap(remote),
      include: [...config.include],
    });
    if (!options.silent) ctx.ui.notify("pi-sync state initialized; local settings already match remote.", "info");
    return;
  }
  if (localChanged && remoteChanged && remote && snapshotsMatch(local, remote)) {
    await writeStateForConfig(config, {
      version: VERSION,
      profile: config.snapshotIdentity,
      lastAppliedSnapshot: remote.id,
      lastRemoteRevision: head?.revision,
      lastFileHashes: fileHashMap(remote),
      include: [...config.include],
    });
    if (!options.silent) ctx.ui.notify("pi-sync is already up to date.", "info");
    return;
  }
  if (localChanged && remoteChanged && state.lastAppliedSnapshot) {
    throw createSyncDecision({
      kind: "both-changed",
      config,
      state,
      local,
      remote,
      localChanged,
      remoteChanged,
      directMessage: "Both local and remote changed. Run /sync diff and resolve with push --force or pull --force.",
    });
  }
  if (remoteChanged) {
    await pull(ctx, options, factory);
    return;
  }
  if (localChanged || !remote) {
    await push(ctx, options, undefined, factory);
    return;
  }
  if (shouldRefreshSyncedState(remote, head, state, config, (left, right) => backend.sameRevision(left, right))) {
    await writeStateForConfig(config, {
      version: VERSION,
      profile: config.snapshotIdentity,
      lastAppliedSnapshot: remote.id,
      lastRemoteRevision: head?.revision,
      lastFileHashes: fileHashMap(remote),
      include: [...config.include],
    });
  }
  if (!options.silent) ctx.ui.notify("pi-sync is already up to date.", "info");
}

export async function rollback(
  ctx: ExtensionCommandContext,
  options: CommandOptions,
  factory: SyncBackendFactory = createSyncBackend,
  expectedSelection?: { backendIdentity: string; setup?: string },
) {
  const target = options.args[0];
  if (!target) throw new Error("Usage: /sync rollback <snapshot-id> [--yes]");

  const config = await loadConfig(options.setup);
  throwIfAborted(options.signal);
  const backend = await factory(config);
  if (
    expectedSelection &&
    (backend.identity !== expectedSelection.backendIdentity || config.setupName !== expectedSelection.setup)
  ) {
    throw new Error("Sync setup or storage location changed while history was open; reopen history and retry.");
  }
  const decoded = await backend.readSnapshot(target, options.signal);
  const selected = filterSnapshotForConfigPolicy(
    config.include.includes("sessions") ? decoded : snapshotWithoutSessions(decoded),
    config,
  );
  const remote = regenerateSnapshotIdentity(selected);
  const local = await createSnapshot(config.snapshotIdentity, snapshotOptionsForContext(ctx, config));
  const expectedHead = await backend.readHead(options.signal);
  throwIfAborted(options.signal);

  if (
    !options.yes &&
    !(await ctx.ui.confirm(
      snapshotIncludesSessions(remote) ? "Rollback pi settings and sessions?" : "Rollback pi settings?",
      formatRollbackSummary(config, backend.destination, local, remote, target, protectedSessionPaths(ctx).size),
    ))
  ) {
    ctx.ui.notify("Rollback cancelled.", "info");
    return;
  }

  throwIfAborted(options.signal);
  const backup = await backupLocal(config.snapshotIdentity, snapshotOptionsForContext(ctx, config), options.signal);
  const applySessionDir = await sessionDirForApply(ctx, remote);
  throwIfAborted(options.signal);
  options.onCommit?.();
  const lastFileHashes = await applySnapshot(remote, protectedSessionPaths(ctx), {
    include: config.include,
    sessionDir: applySessionDir,
  });
  let result: PublishSnapshotResult;
  try {
    const completionSignal = AbortSignal.timeout(POST_LOCAL_COMMIT_TIMEOUT_MS);
    const upload = await snapshotForUpload(backend, config, remote, expectedHead, undefined, completionSignal, {
      ignoreUnreadableRemote: true,
    });
    result = await backend.publishSnapshot(upload, expectedRemoteHead(expectedHead), {
      signal: completionSignal,
    });
  } catch (error) {
    throw new RollbackPublicationError(backup, error);
  }
  try {
    await writeStateForConfig(config, {
      version: VERSION,
      profile: config.snapshotIdentity,
      lastAppliedSnapshot: result.head.snapshotId,
      lastRemoteRevision: result.head.revision,
      lastFileHashes,
      include: [...config.include],
    });
  } catch (error) {
    throw new PublicationStatePersistenceError(result.head, error, backup);
  }
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
  await maybeReload(ctx, options.signal);
}

function protectedSessionPaths(ctx: ExtensionCommandContext | ExtensionContext) {
  const getSessionFile = ctx.sessionManager.getSessionFile;
  if (typeof getSessionFile !== "function") return new Set<string>();
  const sessionFile = getSessionFile.call(ctx.sessionManager) as string | undefined;
  const snapshotPath = sessionFile
    ? sessionSnapshotPathFromAbsolute(sessionFile, sessionDirFromContext(ctx))
    : undefined;
  return snapshotPath ? new Set([snapshotPath]) : new Set<string>();
}

async function maybeReload(ctx: ExtensionCommandContext | ExtensionContext, signal?: AbortSignal) {
  if (signal?.aborted || !("reload" in ctx)) return;
  if (
    ctx.hasUI &&
    (await ctx.ui.confirm(
      "Reload Pi resources now?",
      "This reloads extensions, skills, prompts, themes, and context files.",
    ))
  ) {
    if (signal?.aborted) return;
    await ctx.reload();
  }
}

async function readRemoteSnapshotForUpload(
  backend: SyncBackend,
  config: AnySyncConfig,
  head: RemoteHead | undefined,
  state: SyncState,
  signal?: AbortSignal,
) {
  if (
    !head ||
    (head.snapshotId === state.lastAppliedSnapshot &&
      !syncPolicyChanged(state, config) &&
      (!state.lastRemoteRevision || backend.sameRevision(head.revision, state.lastRemoteRevision)))
  ) {
    return undefined;
  }
  return backend.readSnapshot(head.snapshotRef, signal);
}

async function snapshotForUpload(
  backend: SyncBackend,
  config: AnySyncConfig,
  local: Snapshot,
  head: RemoteHead | undefined,
  remote?: Snapshot,
  signal?: AbortSignal,
  options: { ignoreUnreadableRemote?: boolean } = {},
) {
  if (!head) return local;
  let snapshot = remote;
  if (!snapshot) {
    try {
      snapshot = await backend.readSnapshot(head.snapshotRef, signal);
    } catch (error) {
      if (options.ignoreUnreadableRemote) return local;
      throw error;
    }
  }
  return mergeRemotePreservedFiles(local, snapshot, config);
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
  title = snapshotIncludesSessions(upload) ? "Push pi settings and sessions?" : "Push pi settings?",
) {
  throwIfAborted(options.signal);
  if (options.yes) return true;
  const confirmed = await ctx.ui.confirm(
    title,
    formatPushSummary(config, backend.destination, upload, head, countPreservedRemoteFiles(local, upload), remote),
  );
  throwIfAborted(options.signal);
  if (confirmed) return true;
  ctx.ui.setStatus(STATUS_KEY, undefined);
  ctx.ui.notify("Push cancelled.", "info");
  return false;
}

function sameRemoteHead(backend: SyncBackend, left: RemoteHead | undefined, right: RemoteHead | undefined) {
  if (!left || !right) return left === right;
  return backend.sameRevision(left.revision, right.revision);
}

export async function backupLocal(profile: string, options: SnapshotOptions = {}, signal?: AbortSignal) {
  throwIfAborted(signal);
  const snapshot = await createSnapshot(profile, options);
  throwIfAborted(signal);
  const backupDirectory = path.join(stateDir(), "backups");
  await fs.mkdir(backupDirectory, { recursive: true });
  throwIfAborted(signal);
  const backupPath = path.join(backupDirectory, `${snapshot.id}.json.gz`);
  const encoded = await encodeSnapshot(snapshot);
  throwIfAborted(signal);
  await fs.writeFile(backupPath, encoded, { signal });
  return backupPath;
}
