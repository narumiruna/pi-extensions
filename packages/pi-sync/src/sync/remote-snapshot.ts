import type { RemoteHead, SyncBackend } from "../backends/sync-backend.js";
import { syncConfigReviewFingerprint } from "../settings/config.js";
import type { AnySyncConfig } from "../settings/settings-types.js";
import { filterSnapshotForConfigPolicy } from "../snapshot/snapshot.js";
import type { Snapshot } from "../snapshot/snapshot-types.js";
import { safeTerminalText } from "../ui/terminal-text.js";
import { sameLocalFields, validatePortableSnapshot } from "./local-fields.js";
import { throwIfAborted } from "./signals.js";
import {
  inspectRemoteSelection,
  portableSnapshotSelection,
  type RemoteSelectionState,
  remoteSelectionMismatch,
} from "./sync-policy.js";

export async function readSnapshotForHead(backend: SyncBackend, head: RemoteHead, signal?: AbortSignal) {
  const snapshot = await backend.readSnapshot(head.snapshotRef, signal);
  throwIfAborted(signal);
  validatePortableSnapshot(snapshot);
  if (snapshot.id !== head.snapshotId) {
    throw new Error(`Remote head ${head.snapshotId} resolved to unexpected snapshot ${snapshot.id}.`);
  }
  if (head.selection) {
    if (
      JSON.stringify(portableSnapshotSelection(head.selection)) !==
      JSON.stringify(snapshot.selection === undefined ? undefined : portableSnapshotSelection(snapshot.selection))
    ) {
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
  const state = inspectRemoteSelection(config, snapshot);
  if (state.kind === "different") {
    throw remoteSelectionMismatch(config, state.remoteSelection ?? state.include, syncConfigReviewFingerprint(config));
  }
}

export function formatRemoteSelectionStatus(state: RemoteSelectionState | undefined) {
  if (state?.kind === "different" && (state.localIgnore !== undefined || state.remoteIgnore !== undefined))
    return "remote sync policy: differs — review .syncignore before transferring";
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
  const selectionState = inspectRemoteSelection(config, snapshot);
  if (!options.allowSelectionDifference && selectionState.kind === "different") {
    const configIdentity = syncConfigReviewFingerprint(config);
    throw remoteSelectionMismatch(config, selectionState.remoteSelection ?? selectionState.include, configIdentity);
  }
  return {
    head,
    snapshot: filterSnapshotForConfigPolicy(snapshot, config),
    selectionState,
  };
}
