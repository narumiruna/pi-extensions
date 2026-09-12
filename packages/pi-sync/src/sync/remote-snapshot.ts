import type { RemoteHead, SyncBackend } from "../backends/sync-backend.js";
import { syncConfigReviewFingerprint } from "../settings/config.js";
import type { AnySyncConfig } from "../settings/settings-types.js";
import { filterSnapshotForConfigPolicy } from "../snapshot/snapshot.js";
import type { Snapshot } from "../snapshot/snapshot-types.js";
import { safeTerminalText } from "../ui/terminal-text.js";
import {
  inspectRemoteSelection,
  type RemoteSelectionState,
  remoteSelectionMismatch,
  sameSyncInclude,
  snapshotSelectionInclude,
} from "./sync-policy.js";

export async function readSnapshotForHead(backend: SyncBackend, head: RemoteHead, signal?: AbortSignal) {
  const snapshot = await backend.readSnapshot(head.snapshotRef, signal);
  if (signal?.aborted) {
    throw signal.reason instanceof Error ? signal.reason : new DOMException("The operation was aborted", "AbortError");
  }
  if (snapshot.id !== head.snapshotId) {
    throw new Error(`Remote head ${head.snapshotId} resolved to unexpected snapshot ${snapshot.id}.`);
  }
  if (head.selection) {
    const snapshotInclude = snapshotSelectionInclude(snapshot);
    if (!snapshotInclude || !sameSyncInclude(head.selection.include, snapshotInclude)) {
      throw new Error("Remote head selection does not match its immutable snapshot.");
    }
  }
  return snapshot;
}

export function requireCompatibleRemoteSelection(config: AnySyncConfig, snapshot: Snapshot) {
  const state = inspectRemoteSelection(config.include, snapshot);
  if (state.kind === "different") {
    throw remoteSelectionMismatch(config, state.include, syncConfigReviewFingerprint(config));
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
  ].join("\n");
}

function safeList(values: readonly string[]) {
  return values.length > 0 ? values.map(safeTerminalText).join(", ") : "none";
}

export async function readRemoteSnapshot(
  backend: SyncBackend,
  config: AnySyncConfig,
  signal?: AbortSignal,
  options: { allowSelectionDifference?: boolean } = {},
) {
  const head = await backend.readHead(signal);
  if (!head) return { head: undefined, snapshot: undefined, selectionState: undefined };
  const snapshot = await readSnapshotForHead(backend, head, signal);
  const selectionState = inspectRemoteSelection(config.include, snapshot);
  if (!options.allowSelectionDifference && selectionState.kind === "different") {
    const configIdentity = syncConfigReviewFingerprint(config);
    throw remoteSelectionMismatch(config, selectionState.include, configIdentity);
  }
  return {
    head,
    snapshot: filterSnapshotForConfigPolicy(snapshot, config),
    selectionState,
  };
}
