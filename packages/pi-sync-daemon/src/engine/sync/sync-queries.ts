import { createSyncBackend, type SyncBackendFactory } from "../backends/backend-factory.js";
import { HISTORY_PREVIEW_LIMIT, type SyncBackend } from "../backends/sync-backend.js";
import type { CommandOptions } from "../commands/command-types.js";
import type { EngineContext as ExtensionCommandContext } from "../host.js";
import {
  loadConfig,
  loadConfigForCheck,
  syncCheckConfigFingerprint,
  syncSessionsWarnings,
} from "../settings/config.js";
import type { AnySyncConfig } from "../settings/settings-types.js";
import { resolvedSnapshotOptionsForContext } from "../snapshot/session-paths.js";
import { createSnapshot, scanSnapshot } from "../snapshot/snapshot.js";
import type { SnapshotCaptureLimits } from "../snapshot/snapshot-capture-limit.js";
import type { SnapshotOptions } from "../snapshot/snapshot-types.js";
import { inspectLock, isLockGuardHeld, isStaleLock, withLock } from "../state/lock.js";
import { readStateForConfig } from "../state/sync-state-store.js";
import { formatDiff, formatSnapshotOnlyDiff, publicationCapabilityDescription } from "../ui/sync-format.js";
import { setSyncStatus } from "../ui/sync-status.js";
import { safeTerminalText } from "../ui/terminal-text.js";
import { portableSnapshot } from "./local-fields.js";
import { captureMutationOwner } from "./mutation-owner.js";
import { formatRemoteSelectionStatus, readRemoteSnapshot } from "./remote-snapshot.js";
import { throwIfAborted } from "./signals.js";
import { errorMessage } from "./sync-errors.js";
import { inspectSync } from "./sync-inspection.js";
import { rollback } from "./sync-mutations.js";
import { syncSessionsSelected } from "./sync-policy.js";

function contentLines(config: AnySyncConfig) {
  return [
    config.scope === "agent-directory"
      ? "included content: eligible files in the Pi agent directory"
      : `included content: ${config.include.map(safeTerminalText).join(", ") || "none"}`,
    ...(config.exclude === undefined
      ? []
      : [`excluded paths: ${config.exclude.map(safeTerminalText).join(", ") || "none"}`]),
    ...(config.reinclude === undefined
      ? []
      : [`re-included paths: ${config.reinclude.map(safeTerminalText).join(", ") || "none"}`]),
    `sessions: ${syncSessionsSelected(config) ? "included" : "excluded"}`,
  ];
}

function fileCount(count: number) {
  return `${count} ${count === 1 ? "file" : "files"}`;
}

function reportSection(title: string, lines: readonly string[]) {
  return lines.length > 0 ? ["", title, ...lines.map((line) => `  ${line}`)] : [];
}

function storageSection(connection: string, destination: string, details: readonly string[]) {
  return reportSection(`Storage · ${safeTerminalText(connection)}`, [
    `Location: ${safeTerminalText(destination)}`,
    ...details,
  ]);
}

export async function status(
  ctx: ExtensionCommandContext,
  options: CommandOptions,
  factory: SyncBackendFactory = createSyncBackend,
) {
  const config = await loadConfig(options.setup);
  throwIfAborted(options.signal);
  setSyncStatus(ctx, `checking ${config.setupName}`, { activity: "checking" });
  const { head, selectionState, localChanged, remoteChanged, localFiles, firstSync, destination, capability } =
    await inspectSync(
      config,
      await resolvedSnapshotOptionsForContext(ctx, config, options.signal),
      options.signal,
      factory,
    );
  throwIfAborted(options.signal);

  const continuous = config.continuous
    ? await (await import("./continuous-record.js")).continuousStatusLines(config)
    : [];
  throwIfAborted(options.signal);
  const warnings = syncSessionsWarnings(config);
  const files = fileCount(localFiles);
  const comparison = firstSync
    ? [`Local: ${files}`, `Remote: ${head ? "snapshot available" : "empty"}`]
    : [
        `Local: ${localChanged ? "changed" : "unchanged"} (${files})`,
        `Remote: ${remoteChanged ? "changed" : "unchanged"}`,
      ];
  setSyncStatus(ctx, undefined);
  ctx.ui.notify(
    [
      `Remote status · ${safeTerminalText(config.setupName)}`,
      ...reportSection(firstSync ? "No previous sync recorded" : "Changes since last sync", [
        ...comparison,
        ...(head ? formatRemoteSelectionStatus(selectionState).split("\n") : []),
      ]),
      ...reportSection("Needs attention", warnings),
      ...storageSection(config.connectionName, destination, [
        `Publication safety: ${publicationCapabilityDescription(capability)}`,
        ...(head
          ? [
              `Latest snapshot: ${safeTerminalText(head.snapshotId)}`,
              `Device: ${safeTerminalText(head.machine)}`,
              `Created: ${safeTerminalText(head.createdAt)}`,
            ]
          : firstSync
            ? []
            : ["Latest snapshot: none"]),
      ]),
      ...reportSection("Background activity", continuous.map(safeTerminalText)),
      ...reportSection("Sync scope", contentLines(config)),
    ].join("\n"),
    localChanged || remoteChanged || selectionState?.kind === "different" || warnings.length > 0 ? "warning" : "info",
    "report",
  );
}

export async function diff(
  ctx: ExtensionCommandContext,
  options: CommandOptions,
  factory: SyncBackendFactory = createSyncBackend,
) {
  const config = await loadConfig(options.setup);
  throwIfAborted(options.signal);
  setSyncStatus(ctx, `checking ${config.setupName}`, { activity: "checking" });
  const { local, remote, lines, warnings, selectionState } = await captureDiffComparison(
    ctx,
    config,
    options.signal,
    factory,
  );
  setSyncStatus(ctx, undefined);

  const header = lines.join("\n");
  const level = warnings.length > 0 || selectionState?.kind === "different" ? "warning" : "info";
  if (!remote) {
    ctx.ui.notify(`${header}\n\n${formatSnapshotOnlyDiff("Remote is empty. Local push would upload", local)}`, level);
    return;
  }

  ctx.ui.notify(`${header}\n\n${formatDiff(local, remote)}`, level);
}

export async function captureDiffComparison(
  ctx: ExtensionCommandContext,
  config: AnySyncConfig,
  signal?: AbortSignal,
  factory: SyncBackendFactory = createSyncBackend,
  limits?: { local: SnapshotCaptureLimits; remoteBytes: number },
) {
  const backend = await factory(config);
  throwIfAborted(signal);
  const snapshotOptions = await resolvedSnapshotOptionsForContext(ctx, config, signal);
  throwIfAborted(signal);
  const local = portableSnapshot(
    await createSnapshot(config.snapshotIdentity, snapshotOptions, limits?.local),
    config.localFields,
  );
  throwIfAborted(signal);
  const { snapshot: remote, selectionState } = await readRemoteSnapshot(backend, config, signal, {
    allowSelectionDifference: true,
    sessionDir: snapshotOptions.sessionDir,
    maxBytes: limits?.remoteBytes,
  });
  throwIfAborted(signal);
  const warnings = syncSessionsWarnings(config);
  return {
    local,
    remote: remote && portableSnapshot(remote, remote.localFields),
    warnings,
    selectionState,
    lines: [
      `sync setup: ${config.setupName}`,
      `storage connection: ${config.connectionName}`,
      `storage location: ${safeTerminalText(backend.destination)}`,
      ...contentLines(config),
      ...formatRemoteSelectionStatus(selectionState).split("\n"),
      ...warnings,
    ],
  };
}

export async function doctor(
  ctx: ExtensionCommandContext,
  options: CommandOptions,
  factory: SyncBackendFactory = createSyncBackend,
) {
  const attention: string[] = [];
  const localChecks: string[] = [];
  let config: AnySyncConfig | undefined;
  let snapshotOptions: SnapshotOptions | undefined;
  let backend: SyncBackend | undefined;

  try {
    config = await loadConfig(options.setup);
    throwIfAborted(options.signal);
    snapshotOptions = await resolvedSnapshotOptionsForContext(ctx, config, options.signal);
    throwIfAborted(options.signal);
    backend = await factory(config);
    throwIfAborted(options.signal);
    localChecks.push("Configuration: OK");
    attention.push(...syncSessionsWarnings(config));
  } catch (error) {
    throwIfAborted(options.signal);
    attention.push(`Configuration: ${safeTerminalText(errorMessage(error))}`);
  }

  if (config && snapshotOptions) {
    const local = await createSnapshot(config.snapshotIdentity, snapshotOptions);
    throwIfAborted(options.signal);
    const secrets = scanSnapshot(local);
    if (secrets.length > 0) {
      attention.push(
        "Secret scan: possible secrets found",
        ...secrets.map((secret) => `  - ${safeTerminalText(secret)}`),
      );
    } else {
      localChecks.push(`Secret scan: OK (${fileCount(local.files.length)} checked)`);
    }
  } else localChecks.push("Secret scan: skipped without a valid content policy");

  const lock = await inspectLock();
  throwIfAborted(options.signal);
  if (lock.status === "valid" && isStaleLock(lock.lock)) {
    attention.push(
      `Operation lock: stale (PID ${lock.lock.pid}); run /sync unlock --stale after verifying no sync is running`,
    );
  } else if (lock.status === "valid") {
    localChecks.push(`Operation lock: held by PID ${lock.lock.pid} since ${safeTerminalText(lock.lock.startedAt)}`);
  } else if (lock.status === "unreadable") {
    attention.push("Operation lock: unreadable; use /sync unlock --stale only after verifying no sync is running");
  } else if (await isLockGuardHeld()) {
    attention.push("Operation lock: guard active while metadata is missing or still being initialized");
  } else {
    localChecks.push("Operation lock: free");
  }
  throwIfAborted(options.signal);

  const storageChecks: string[] = [];
  if (backend) {
    const diagnostics = await backend.diagnose(options.signal);
    throwIfAborted(options.signal);
    for (const diagnostic of diagnostics) {
      if (diagnostic.key === "s3-config" && diagnostic.level === "info") continue;
      const finding = safeTerminalText(diagnostic.message.replaceAll("\n", " "));
      (diagnostic.level === "info" ? storageChecks : attention).push(finding);
    }
  }
  ctx.ui.notify(
    [
      config ? `Diagnostics · ${safeTerminalText(config.setupName)}` : "Diagnostics",
      ...reportSection("Needs attention", attention),
      ...reportSection("Local checks", localChecks),
      ...(config && backend
        ? storageSection(config.connectionName, backend.destination, [
            ...storageChecks,
            `Publication safety: ${publicationCapabilityDescription(backend.capability)}`,
          ])
        : []),
      ...(config ? reportSection("Sync scope", contentLines(config)) : []),
    ].join("\n"),
    attention.length > 0 ? "warning" : "info",
    "report",
  );
}

export async function history(
  ctx: ExtensionCommandContext,
  options: CommandOptions,
  factory: SyncBackendFactory = createSyncBackend,
  validateJob?: () => void,
) {
  const { signal } = options;
  const validateSession = captureMutationOwner(ctx, signal);
  const validateOwner = () => {
    validateJob?.();
    validateSession();
  };
  validateOwner();
  const config = await loadConfig(options.setup, signal);
  validateOwner();
  const backend = await factory(config);
  validateOwner();
  const entries = await backend.listHistory(signal);
  validateOwner();
  const interactive = ctx.hasUI && (ctx.mode === "tui" || ctx.mode === "rpc");
  const repair =
    interactive && !options.auto && config.backend.type === "webdav"
      ? backend.repairActiveHistory?.bind(backend)
      : undefined;
  const head = repair
    ? await backend.readHead(signal).catch(() => {
        validateOwner();
        ctx.ui.notify("History repair is unavailable because the active WebDAV snapshot could not be read.", "warning");
        return undefined;
      })
    : undefined;
  validateOwner();
  const repairHead = head && !entries.some((entry) => entry.snapshotRef === head.snapshotRef) ? head : undefined;
  const snapshots = entries.slice(-HISTORY_PREVIEW_LIMIT).reverse();
  const lastApplied = await readStateForConfig(config)
    .then((state) => state.lastAppliedSnapshot)
    .catch(() => undefined);
  validateOwner();
  const appliedDetails = lastApplied
    ? `Last applied snapshot ID: ${safeTerminalText(lastApplied)}\nApplication time: unavailable. Snapshot dates are creation times.`
    : "Last applied snapshot ID: unavailable.";
  if (snapshots.length === 0 && !repairHead) {
    ctx.ui.notify(`No remote pi-sync history found.\n${appliedDetails}`, "info");
    return;
  }

  const previewRollback = interactive && ctx.mode === "tui";
  if (!previewRollback) {
    ctx.ui.notify(
      [
        appliedDetails,
        ...snapshots.map(
          (item) =>
            `${safeTerminalText(item.snapshotRef)} ${safeTerminalText(item.createdAt)} ${safeTerminalText(item.machine)}`,
        ),
      ].join("\n"),
      "info",
    );
    if (!repairHead) return;
  }

  const currentSnapshot = repair ? head?.snapshotId : snapshots[0]?.snapshotId;
  const labels = previewRollback
    ? snapshots.map(
        (item, index) =>
          `${index + 1}. ${safeTerminalText(item.createdAt)} · ${safeTerminalText(item.machine)} · ${safeTerminalText(item.snapshotId)}${item.snapshotId === currentSnapshot ? " (current)" : ""}${item.syncSessions ? " · sessions" : ""}`,
      )
    : [];
  const setupName = safeTerminalText(config.setupName);
  const repairChoice = "Repair active snapshot history";
  const selected = await ctx.ui.select(
    [
      `History for sync setup “${setupName}”`,
      appliedDetails,
      ...(labels.length > 0 ? ["Choose a snapshot to preview rollback."] : []),
      ...(repairHead ? ["The active WebDAV snapshot is missing from History."] : []),
    ].join("\n\n"),
    [...labels, ...(repairHead ? [repairChoice] : []), "Back"],
    { signal },
  );
  validateOwner();
  if (!selected || selected === "Back") return;
  if (selected === repairChoice && repairHead && repair) {
    const validateRepairOwner = () => {
      validateOwner();
      if (!ctx.hasUI || (ctx.mode !== "tui" && ctx.mode !== "rpc"))
        throw new Error("History repair no longer has an observable TUI or RPC client.");
    };
    validateRepairOwner();
    const fingerprint = syncCheckConfigFingerprint(config);
    const confirmed = await ctx.ui.confirm(
      "Repair active WebDAV snapshot history?",
      [
        `Setup: ${setupName}`,
        `Storage: ${safeTerminalText(backend.destination)}`,
        `Active snapshot: ${safeTerminalText(repairHead.snapshotId)}`,
        "This runs a temporary conditional write/delete probe, then adds this snapshot to remote History if it is still missing. If History is full, the oldest entry is dropped. The active snapshot and local files do not change.",
      ].join("\n"),
      { signal },
    );
    validateRepairOwner();
    if (!confirmed) return;
    const validateSettings = async () => {
      validateRepairOwner();
      const current = await loadConfigForCheck(options.setup, signal);
      validateRepairOwner();
      if (syncCheckConfigFingerprint(current) !== fingerprint)
        throw new Error("The sync setup settings changed. Reopen History before repairing it.");
    };
    const repaired = await withLock("history repair", async () => {
      await validateSettings();
      validateRepairOwner();
      return repair(repairHead, {
        signal,
        validateOwner: validateRepairOwner,
        validateSettings,
        onCommit: options.onCommit,
      });
    });
    validateRepairOwner();
    ctx.ui.notify(
      repaired ? "Active WebDAV snapshot added to History." : "The active WebDAV snapshot is already in History.",
      "info",
    );
    return;
  }
  const snapshot = snapshots[labels.indexOf(selected)];
  if (!snapshot) return;
  await withLock("rollback", () => {
    validateOwner();
    return rollback(ctx, { ...options, args: [snapshot.snapshotRef], yes: false }, factory, {
      backendIdentity: backend.identity,
      setup: config.setupName,
    });
  });
}
