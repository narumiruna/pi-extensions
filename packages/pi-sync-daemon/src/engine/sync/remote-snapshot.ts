import type { RemoteHead, SyncBackend } from "../backends/sync-backend.js";
import { syncConfigReviewFingerprint } from "../settings/config.js";
import type { AnySyncConfig } from "../settings/settings-types.js";
import { filterSnapshotForConfigPolicy, mergeRemotePreservedFiles } from "../snapshot/snapshot.js";
import type { Snapshot, SnapshotOptions } from "../snapshot/snapshot-types.js";
import type { SyncState } from "../state/state-types.js";
import { safeTerminalText } from "../ui/terminal-text.js";
import { sameLocalFields, validatePortableSnapshot } from "./local-fields.js";
import { throwIfAborted } from "./signals.js";
import {
  inspectRemoteSelection,
  type RemoteSelectionState,
  remoteSelectionMismatch,
  requireLegacyTransferPolicy,
  sameSnapshotSelection,
} from "./sync-policy.js";
import { syncPolicyChanged } from "./sync-state.js";

async function readValidatedSnapshotForHead(
  backend: SyncBackend,
  head: RemoteHead,
  signal?: AbortSignal,
  maxBytes?: number,
) {
  const snapshot = await backend.readSnapshot(head.snapshotRef, signal, maxBytes);
  throwIfAborted(signal);
  return validateSnapshotForHead(snapshot, head);
}

function validateSnapshotForHead(snapshot: Snapshot, head: RemoteHead) {
  validatePortableSnapshot(snapshot);
  if (snapshot.id !== head.snapshotId) {
    throw new Error(`Remote head ${head.snapshotId} resolved to unexpected snapshot ${snapshot.id}.`);
  }
  if (head.selection) {
    if (!sameSnapshotSelection(head.selection, snapshot.selection)) {
      throw new Error("Remote head selection does not match its immutable snapshot.");
    }
  }
  return snapshot;
}

export function requireCompatibleRemoteSelection(config: AnySyncConfig, snapshot: Snapshot) {
  if (!sameLocalFields(config.localFields, snapshot.localFields))
    throw new Error(
      "Remote local-field policy differs; confirm a reviewed directional migration. Old history is not erased.",
    );
  const state = inspectRemoteSelection(config.include, snapshot, config.exclude, config);
  if (state.kind === "different") {
    throw remoteSelectionMismatch(config, state.include, syncConfigReviewFingerprint(config), state.exclude, state);
  }
}

export function formatRemoteSelectionStatus(state: RemoteSelectionState | undefined) {
  if (!state) return "remote included content: unavailable (remote is empty)";
  if (state.kind === "same") return "remote included content: matches this setup";
  if (state.kind === "legacy") {
    return `remote included content: unavailable in legacy snapshot (${state.discovered.length} path${state.discovered.length === 1 ? "" : "s"} discovered, partial)`;
  }
  return [
    "remote included content: differs from this setup",
    `remote-only selection: ${safeList(state.remoteOnly)}`,
    `local-only selection: ${safeList(state.localOnly)}`,
    `remote excluded paths: ${safeList(state.exclude ?? [])}`,
    ...(state.scope
      ? [`remote scope: ${state.scope}`, `remote re-included paths: ${safeList(state.reinclude ?? [])}`]
      : []),
  ].join("\n");
}

function safeList(values: readonly string[]) {
  return values.length > 0 ? values.map(safeTerminalText).join(", ") : "none";
}

export async function readRemoteSnapshot(
  backend: SyncBackend,
  config: AnySyncConfig,
  signal?: AbortSignal,
  options: {
    allowSelectionDifference?: boolean;
    sessionDir?: string;
    validateSelection?: (rawSnapshot: Snapshot) => void;
    maxBytes?: number;
  } = {},
) {
  const observed = await readCurrentSnapshot(backend, config.scope === "agent-directory", signal, options.maxBytes);
  if (!observed) return { head: undefined, snapshot: undefined, selectionState: undefined };
  const { head, snapshot: rawSnapshot } = observed;
  const selectionState = inspectRemoteSelection(config.include, rawSnapshot, config.exclude, config);
  if (options.validateSelection) options.validateSelection(rawSnapshot);
  else if (!options.allowSelectionDifference && selectionState.kind === "different")
    throw remoteSelectionMismatch(
      config,
      selectionState.include,
      syncConfigReviewFingerprint(config),
      selectionState.exclude,
      selectionState,
    );
  const snapshot = filterSnapshotForConfigPolicy(rawSnapshot, config, { sessionDir: options.sessionDir });
  return { head, snapshot, selectionState };
}

async function readCurrentSnapshot(
  backend: SyncBackend,
  singleObservation: boolean,
  signal?: AbortSignal,
  maxBytes?: number,
) {
  if (singleObservation && backend.readHeadAndSnapshot) {
    const observed = await backend.readHeadAndSnapshot(signal, maxBytes);
    throwIfAborted(signal);
    if (observed) validateSnapshotForHead(observed.snapshot, observed.head);
    return observed;
  }
  const head = await backend.readHead(signal);
  throwIfAborted(signal);
  return head && { head, snapshot: await readValidatedSnapshotForHead(backend, head, signal, maxBytes) };
}

export async function readSnapshotForHead(backend: SyncBackend, head: RemoteHead, signal?: AbortSignal) {
  const snapshot = await readValidatedSnapshotForHead(backend, head, signal);
  requireLegacyTransferPolicy(snapshot);
  return snapshot;
}

export async function readRemoteSnapshotForUpload(
  backend: SyncBackend,
  config: AnySyncConfig,
  head: RemoteHead | undefined,
  state: SyncState,
  options: { force?: boolean; signal?: AbortSignal },
) {
  if (!head) return undefined;
  if (
    !head.selection ||
    head.snapshotId !== state.lastAppliedSnapshot ||
    syncPolicyChanged(state, config) ||
    (state.lastRemoteRevision && !backend.sameRevision(head.revision, state.lastRemoteRevision)) ||
    (!options.force &&
      (config.scope === "agent-directory" ||
        inspectRemoteSelection(config.include, { selection: head.selection, files: [] }, config.exclude, config)
          .kind === "different"))
  )
    return readSnapshotForHead(backend, head, options.signal);
  return undefined;
}

export async function snapshotForUpload(
  backend: SyncBackend,
  config: AnySyncConfig,
  local: Snapshot,
  head: RemoteHead | undefined,
  remote: Snapshot | undefined,
  options: SnapshotOptions,
) {
  if (!head) return local;
  const snapshot = remote ?? (await readSnapshotForHead(backend, head, options.signal));
  if ((snapshot.selection?.version === 3) !== (config.scope === "agent-directory"))
    throw new Error(
      "Converting an existing remote between included paths and agent-directory scope is not supported. Use a separate storage location.",
    );
  return mergeRemotePreservedFiles(local, snapshot, config, options);
}

export function sameRemoteHead(backend: SyncBackend, left: RemoteHead | undefined, right: RemoteHead | undefined) {
  if (!left || !right) return left === right;
  return (
    left.snapshotId === right.snapshotId &&
    left.snapshotRef === right.snapshotRef &&
    backend.sameRevision(left.revision, right.revision) &&
    sameSnapshotSelection(left.selection, right.selection)
  );
}

export async function inspectHeadSelection(
  backend: SyncBackend,
  config: AnySyncConfig,
  head: RemoteHead,
  signal?: AbortSignal,
) {
  const remote = head.selection
    ? { selection: head.selection, files: [] }
    : await readSnapshotForHead(backend, head, signal);
  return inspectRemoteSelection(config.include, remote, config.exclude, config);
}
