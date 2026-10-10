import { truncateToWidth } from "@earendil-works/pi-tui";
import type { PublicationCapability } from "../backends/sync-backend.js";
import type { Snapshot } from "../snapshot/snapshot-types.js";
import type { FileMergeDecision } from "../sync/file-merge-planner.js";
import { fileHashMap } from "../sync/sync-state.js";
import { safeTerminalText, snapshotPathLabel } from "./terminal-text.js";

interface FileChange {
  path: string;
  action: "Add" | "Update" | "Delete";
}

export interface MergedSyncSummaryInput {
  setupName: string;
  destination: string;
  localBefore: Snapshot;
  localAfter: Snapshot;
  remoteBefore: Snapshot;
  remoteAfter: Snapshot;
  publish: boolean;
  sessions: boolean;
  groups: readonly { paths: readonly string[] }[];
  decisions: readonly FileMergeDecision[];
  capability: PublicationCapability;
}

/** Presentation only: counts describe snapshot differences, not planner decisions. */
export function mergedSyncSummary(input: MergedSyncSummaryInput) {
  const local = changes(input.localBefore, input.localAfter);
  const remote = changes(input.remoteBefore, input.remoteAfter);
  const all = [...local, ...remote];
  const updatesOnly = all.length > 0 && all.every((change) => change.action === "Update");
  const verb = updatesOnly ? "Update" : "Apply changes to";
  const title =
    local.length && remote.length
      ? "Apply local and remote changes?"
      : all.length
        ? `${verb} ${all.length} ${local.length ? "local" : "remote"} ${all.length === 1 ? "file" : "files"}?`
        : input.publish
          ? "Publish a new remote snapshot?"
          : "Pi Sync is already up to date.";
  const confirmationLabel =
    local.length && remote.length
      ? "apply local and remote changes"
      : all.length
        ? `${updatesOnly ? "update" : "apply changes to"} ${local.length ? "local" : "remote"} ${all.length === 1 ? "file" : "files"}`
        : "publish remote snapshot";
  const sources = new Map(
    input.decisions.filter((item) => item.kind === "accepted").map((item) => [item.path, item.source]),
  );
  const label = (change: FileChange, side: "local" | "remote") => {
    const source = sources.get(change.path);
    const suffix =
      source === "merged"
        ? " (merged content)"
        : side === "local" && source === "remote"
          ? change.action === "Delete"
            ? " (deleted remotely)"
            : " from remote"
          : "";
    return `${change.action} ${snapshotPathLabel(change.path)}${suffix}`;
  };
  const section = (items: FileChange[], side: "local" | "remote", compact: boolean) => {
    const heading = side === "local" ? "Local changes" : "Remote file changes";
    if (!items.length) return [`${heading}: none`];
    const counts = ["Add", "Update", "Delete"].flatMap((action) => {
      const count = items.filter((item) => item.action === action).length;
      return count ? [`${count} ${action.toLowerCase()}`] : [];
    });
    return [
      `${heading}: ${counts.join(", ")}`,
      ...(compact ? items.slice(0, 3) : items).map(
        (item) => `  ${compact ? truncateToWidth(label(item, side), 80) : label(item, side)}`,
      ),
      ...(compact && items.length > 3 ? [`  ${items.length - 3} more files — View details`] : []),
    ];
  };
  const context = [`Setup: ${safeTerminalText(input.setupName)}`, `Remote: ${safeTerminalText(input.destination)}`];
  const safety = [
    `Remote snapshot publication: ${input.publish ? "yes" : "no"}`,
    `Sessions: ${input.sessions ? "included — may contain private conversations" : "not included"}`,
    input.groups.length
      ? `Unresolved groups: ${input.groups.length} — these paths stay unchanged on each side`
      : "Conflicts: none",
    ...(input.publish && input.capability === "read-check-write-verify"
      ? ["Warning: simultaneous remote writes can still race; visible changes are rejected."]
      : []),
    ...(input.publish && input.capability === "conditional-required"
      ? ["Remote publication requires verified conditional writes; verification failure stops the transfer."]
      : []),
    "The current session is protected. A backup and recovery journal will be saved.",
    "Resources will not reload automatically.",
  ];
  return {
    title,
    confirmationLabel,
    lines: [
      ...context.map((line) => truncateToWidth(line, 100)),
      ...section(local, "local", true),
      ...section(remote, "remote", true),
      ...safety,
    ],
    content: [
      ...context,
      "",
      ...section(local, "local", false),
      "",
      ...section(remote, "remote", false),
      "",
      ...safety,
      ...input.groups.flatMap((group) =>
        group.paths.map((filePath) => `Unchanged (unresolved): ${snapshotPathLabel(filePath)}`),
      ),
    ].join("\n"),
  };
}

function changes(before: Snapshot, after: Snapshot): FileChange[] {
  const beforeMap = fileHashMap(before);
  const afterMap = fileHashMap(after);
  return [...new Set([...Object.keys(beforeMap), ...Object.keys(afterMap)])]
    .sort()
    .flatMap((filePath): FileChange[] => {
      if (!Object.hasOwn(beforeMap, filePath)) return [{ path: filePath, action: "Add" }];
      if (!Object.hasOwn(afterMap, filePath)) return [{ path: filePath, action: "Delete" }];
      return beforeMap[filePath] !== afterMap[filePath] ? [{ path: filePath, action: "Update" }] : [];
    });
}
