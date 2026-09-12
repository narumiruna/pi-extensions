import type { PublicationCapability, RemoteHead } from "../backends/sync-backend.js";
import type { CommonSyncConfig } from "../settings/settings-types.js";
import { agentDir } from "../snapshot/session-paths.js";
import type { Snapshot } from "../snapshot/snapshot-types.js";
import { inspectRemoteSelection } from "../sync/sync-policy.js";
import { fileHashMap } from "../sync/sync-state.js";
import { safeTerminalText } from "./terminal-text.js";

export function formatDiff(local: Snapshot, remote: Snapshot) {
  const localMap = fileHashMap(local);
  const remoteMap = fileHashMap(remote);
  const allPaths = [...new Set([...Object.keys(localMap), ...Object.keys(remoteMap)])].sort();
  const lines = [`local: ${local.files.length} files`, `remote: ${remote.id} (${remote.files.length} files)`, ""];
  let changed = 0;
  for (const filePath of allPaths) {
    if (!localMap[filePath]) {
      lines.push(`Remote only: ${filePath}`);
      changed += 1;
    } else if (!remoteMap[filePath]) {
      lines.push(`Local only: ${filePath}`);
      changed += 1;
    } else if (localMap[filePath] !== remoteMap[filePath]) {
      lines.push(`Different: ${filePath}`);
      changed += 1;
    }
  }
  if (changed === 0) lines.push("No file differences.");
  return lines.join("\n");
}

export function formatSnapshotOnlyDiff(title: string, snapshot: Snapshot) {
  return [`${title}: ${snapshot.id}`, ...snapshot.files.map((file) => `Add: ${file.path}`)].join("\n");
}

export function formatPushSummary(
  config: CommonSyncConfig,
  destination: string,
  upload: Snapshot,
  head: RemoteHead | undefined,
  preservedRemoteFileCount = 0,
  remote?: Snapshot,
) {
  return [
    `Sync setup: ${safeTerminalText(config.setupName)}`,
    `Storage location: ${safeTerminalText(destination)}`,
    `Upload ${upload.files.length} files from ${safeTerminalText(agentDir())}.`,
    `Sessions: ${upload.syncSessions ? "included — may contain private conversations" : "not included"}`,
    head ? `Remote latest: ${head.snapshotId}` : "Remote latest: empty",
    "Publication effect: the backend's active head will reference the new immutable snapshot.",
    ...(remote && inspectRemoteSelection(config.include, remote).kind === "different"
      ? ["Included-content policy effect: replace the differing remote selection with this setup's local selection."]
      : []),
    formatPublicationPreview(remote, upload),
    preservedRemoteFileCount > 0
      ? `Possible secrets in locally managed files were scanned before this prompt; ${preservedRemoteFileCount} preserved remote file(s) were not rescanned.`
      : "Possible secrets were scanned before this prompt.",
  ].join("\n");
}

export function formatApplyPreview(local: Snapshot, remote: Snapshot) {
  return formatDirectionalChanges(local, remote, {
    add: "Add locally",
    update: "Update locally",
    remove: "Remove locally",
  });
}

export function formatPullSummary(
  config: CommonSyncConfig,
  destination: string,
  local: Snapshot,
  remote: Snapshot,
  protectedSessionCount: number,
) {
  return [
    `Sync setup: ${safeTerminalText(config.setupName)}`,
    `Storage location: ${safeTerminalText(destination)}`,
    `Snapshot: ${safeTerminalText(remote.id)}`,
    `Sessions: ${remote.syncSessions ? "included — may contain private conversations" : "not included"}`,
    `Protected live sessions: ${protectedSessionCount || "none"}`,
    formatApplyPreview(local, remote),
    "A local backup is created before these writes/deletes. The remote active snapshot is unchanged.",
  ].join("\n");
}

export function formatRollbackSummary(
  config: CommonSyncConfig,
  destination: string,
  local: Snapshot,
  remote: Snapshot,
  requestedSnapshot: string,
  protectedSessionCount: number,
) {
  return [
    `Sync setup: ${safeTerminalText(config.setupName)}`,
    `Storage location: ${safeTerminalText(destination)}`,
    `Snapshot: ${safeTerminalText(requestedSnapshot)}`,
    `Sessions: ${remote.syncSessions ? "included — may contain private conversations" : "not included"}`,
    `Protected live sessions: ${protectedSessionCount || "none"}`,
    formatApplyPreview(local, remote),
    "A local backup is created before applying; the backend's active head will change.",
  ].join("\n");
}

function formatPublicationPreview(remote: Snapshot | undefined, upload: Snapshot) {
  if (!remote) {
    return ["Remote is empty.", ...upload.files.map((file) => `Add remotely: ${file.path}`)].join("\n");
  }
  return formatDirectionalChanges(remote, upload, {
    add: "Add remotely",
    update: "Update remotely",
    remove: "Remove remotely",
  });
}

function formatDirectionalChanges(
  before: Snapshot,
  after: Snapshot,
  labels: { add: string; update: string; remove: string },
) {
  const beforeMap = fileHashMap(before);
  const afterMap = fileHashMap(after);
  const paths = [...new Set([...Object.keys(beforeMap), ...Object.keys(afterMap)])].sort();
  const lines: string[] = [];
  for (const filePath of paths) {
    if (!beforeMap[filePath]) lines.push(`${labels.add}: ${filePath}`);
    else if (!afterMap[filePath]) lines.push(`${labels.remove}: ${filePath}`);
    else if (beforeMap[filePath] !== afterMap[filePath]) lines.push(`${labels.update}: ${filePath}`);
  }
  if (lines.length === 0) lines.push("No file changes.");
  return lines.join("\n");
}

export function countPreservedRemoteFiles(local: Snapshot, upload: Snapshot) {
  const localPaths = new Set(local.files.map((file) => file.path));
  return upload.files.filter((file) => !localPaths.has(file.path)).length;
}

export function publicationCapabilityDescription(capability: PublicationCapability) {
  switch (capability) {
    case "lease-protected":
      return "lease-protected (exact expected-ref update)";
    case "atomic-conditional":
      return "atomic-conditional (verified atomic precondition)";
    case "conditional-required":
      return "conditional-required (read-only until atomic preconditions are verified)";
    case "read-check-write-verify":
      return "read-check-write-verify (visible races rejected; simultaneous unseen races remain possible)";
  }
}

export function redact(value: string) {
  return value.length <= 8 ? "configured" : `${value.slice(0, 4)}…${value.slice(-4)}`;
}
