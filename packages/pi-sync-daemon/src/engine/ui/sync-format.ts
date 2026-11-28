import type { PublicationCapability, RemoteHead } from "../backends/sync-backend.js";
import type { CommonSyncConfig } from "../settings/settings-types.js";
import { agentDir } from "../snapshot/session-paths.js";
import { type SnapshotDifference, snapshotDifferences } from "../snapshot/snapshot-difference.js";
import type { Snapshot, SnapshotFileHash } from "../snapshot/snapshot-types.js";
import { inspectRemoteSelection } from "../sync/sync-policy.js";
import { safeTerminalText, snapshotPathLabel } from "./terminal-text.js";
import { transferChanges, transferCounts } from "./transfer-changes.js";

export function formatDiff(local: Snapshot, remote: Snapshot) {
  const changes = snapshotDifferences(local.files, remote.files);
  return [
    ...formatDiffCounts(local, remote),
    "",
    ...(changes.length ? changes.map(formatDiffRow) : ["No file differences."]),
  ].join("\n");
}

export function formatDiffCounts(local: Snapshot, remote: Snapshot) {
  return [
    `local: ${local.files.length} files`,
    `remote: ${safeTerminalText(remote.id)} (${remote.files.length} files)`,
  ];
}

export function formatDiffRow(change: SnapshotDifference<SnapshotFileHash>) {
  const label = { "local-only": "Local only", "remote-only": "Remote only", different: "Different" };
  return `${label[change.status]}: ${snapshotPathLabel(change.path)}`;
}

export function formatSnapshotOnlyDiff(title: string, snapshot: Snapshot) {
  return [
    `${safeTerminalText(title)}: ${safeTerminalText(snapshot.id)}`,
    ...snapshot.files.map((file) => `Add: ${snapshotPathLabel(file.path)}`),
  ].join("\n");
}

export interface TransferReview {
  lines: readonly string[];
  content: string;
}

export function formatTransferReview(...sections: (string | TransferReview)[]): TransferReview {
  return {
    lines: sections.flatMap((section) => (typeof section === "string" ? section.split("\n") : section.lines)),
    content: sections.map((section) => (typeof section === "string" ? section : section.content)).join("\n"),
  };
}

export function formatPushSummary(
  config: CommonSyncConfig,
  destination: string,
  upload: Snapshot,
  head: RemoteHead | undefined,
  preservedRemoteFileCount = 0,
  remote?: Snapshot,
) {
  return formatTransferReview(
    `Sync setup: ${safeTerminalText(config.setupName)}`,
    `Storage location: ${safeTerminalText(destination)}`,
    `Direction: Local → Remote. Source: ${safeTerminalText(agentDir())}.`,
    `Publish a snapshot containing ${upload.files.length} files; unchanged and preserved files are not counted as changes.`,
    `Sessions: ${upload.syncSessions ? "included — may contain private conversations" : "not included"}`,
    ...excludedPolicyLines(config),
    head ? `Remote latest: ${safeTerminalText(head.snapshotId)}` : "Remote latest: empty",
    "Publication effect: the backend's active head will reference the new immutable snapshot. Removed paths leave the active snapshot; retained history is not erased.",
    ...(remote && inspectRemoteSelection(config.include, remote, config.exclude, config).kind === "different"
      ? ["Included-content policy effect: replace the differing remote selection with this setup's local selection."]
      : []),
    formatPublicationPreview(remote, upload),
    config.skipSecretScan
      ? "Warning: possible-secret scanning is disabled for this push."
      : preservedRemoteFileCount > 0
        ? `Possible secrets in locally managed files were scanned before this prompt; ${preservedRemoteFileCount} preserved remote file(s) were not rescanned.`
        : "Possible secrets were scanned before this prompt.",
    ...(config.scope === "agent-directory"
      ? ["Warning: synced files may contain secrets or other sensitive data that the scanner cannot identify."]
      : []),
  );
}

function excludedPolicyLines(config: CommonSyncConfig) {
  const scoped = config.scope === "agent-directory";
  return [
    ...(scoped
      ? [
          "Scope: eligible files in the Pi agent directory.",
          "Always local: Pi credentials (auth.json), project trust (trust.json), their lock files, and Pi Sync settings and service state.",
        ]
      : []),
    ...(config.exclude === undefined && !scoped
      ? []
      : [`Excluded paths: ${(config.exclude ?? []).map(safeTerminalText).join(", ") || "none"}`]),
    ...(scoped ? [`Re-included paths: ${(config.reinclude ?? []).map(safeTerminalText).join(", ") || "none"}`] : []),
    ...(scoped || config.exclude !== undefined
      ? [
          "Excluded local files remain untouched; matching paths are omitted from new publications, not erased from history.",
        ]
      : []),
  ];
}

export function formatApplyPreview(
  local: Snapshot,
  remote: Snapshot,
  protectedPaths: ReadonlySet<string> = new Set(),
  additionalRemovals: readonly string[] = [],
) {
  return formatDirectionalChanges(
    local,
    remote,
    {
      add: "Add locally",
      update: "Update locally",
      remove: "Remove locally",
    },
    protectedPaths,
    additionalRemovals,
  );
}

export function formatPullSummary(
  config: CommonSyncConfig,
  destination: string,
  local: Snapshot,
  remote: Snapshot,
  protectedPaths: ReadonlySet<string>,
  additionalRemovals: readonly string[] = [],
) {
  return formatTransferReview(
    `Sync setup: ${safeTerminalText(config.setupName)}`,
    `Storage location: ${safeTerminalText(destination)}`,
    "Direction: Remote → Local.",
    `Snapshot: ${safeTerminalText(remote.id)}`,
    ...excludedPolicyLines(config),
    `Sessions: ${remote.syncSessions ? "included — may contain private conversations" : "not included"}`,
    `Protected live sessions: ${protectedPaths.size || "none"}`,
    formatApplyPreview(local, remote, protectedPaths, additionalRemovals),
    ...(additionalRemovals.length ? ["Case-variant aliases are removed before writing canonical paths."] : []),
    "A local backup is created before these writes/deletes. The remote active snapshot is unchanged.",
  );
}

export function formatRollbackSummary(
  config: CommonSyncConfig,
  destination: string,
  local: Snapshot,
  remote: Snapshot,
  requestedSnapshot: string,
  protectedPaths: ReadonlySet<string>,
  additionalRemovals: readonly string[] = [],
) {
  return formatTransferReview(
    `Sync setup: ${safeTerminalText(config.setupName)}`,
    `Storage location: ${safeTerminalText(destination)}`,
    "Direction: Historical snapshot → Local and remote active head.",
    `Snapshot: ${safeTerminalText(requestedSnapshot)}`,
    ...excludedPolicyLines(config),
    `Sessions: ${remote.syncSessions ? "included — may contain private conversations" : "not included"}`,
    `Protected live sessions: ${protectedPaths.size || "none"}`,
    formatApplyPreview(local, remote, protectedPaths, additionalRemovals),
    ...(additionalRemovals.length ? ["Case-variant aliases are removed before writing canonical paths."] : []),
    "A local backup is created before applying; the backend's active head will change.",
  );
}

export function formatPublicationPreview(remote: Snapshot | undefined, upload: Snapshot) {
  return formatDirectionalChanges(remote, upload, {
    add: "Add remotely",
    update: "Update remotely",
    remove: "Remove remotely",
  });
}

function formatDirectionalChanges(
  before: Snapshot | undefined,
  after: Snapshot,
  labels: { add: string; update: string; remove: string },
  protectedPaths: ReadonlySet<string> = new Set(),
  additionalRemovals: readonly string[] = [],
) {
  const changes = transferChanges(before, after, protectedPaths);
  const known = new Set(changes.map((change) => change.path));
  for (const filePath of additionalRemovals) {
    if (!known.has(filePath) && !protectedPaths.has(filePath)) {
      changes.push({ path: filePath, action: "Delete" });
      known.add(filePath);
    }
  }
  const counts = transferCounts(changes);
  const label = { Add: labels.add, Update: labels.update, Delete: labels.remove };
  const heading = `Changes: ${counts.add} add · ${counts.update} update · ${counts.remove} remove`;
  const lines = changes.length ? [heading] : [heading, "No file changes."];
  return {
    lines,
    content: [...lines, ...changes.map((change) => `${label[change.action]}: ${snapshotPathLabel(change.path)}`)].join(
      "\n",
    ),
  };
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
      return "Read-only until atomic conditional writes are verified";
    case "read-check-write-verify":
      return "read-check-write-verify (visible races rejected; simultaneous unseen races remain possible)";
  }
}

export function redact(value: string) {
  return value.length <= 8 ? "configured" : `${value.slice(0, 4)}…${value.slice(-4)}`;
}
