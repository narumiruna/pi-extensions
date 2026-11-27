import { createSyncBackend, type SyncBackendFactory } from "../backends/backend-factory.js";
import { HISTORY_PREVIEW_LIMIT, type SyncBackend } from "../backends/sync-backend.js";
import type { CommandOptions } from "../commands/command-types.js";
import type { EngineContext as ExtensionCommandContext } from "../host.js";
import { loadConfig, syncSessionsWarnings } from "../settings/config.js";
import type { AnySyncConfig } from "../settings/settings-types.js";
import { resolvedSnapshotOptionsForContext } from "../snapshot/session-paths.js";
import { createSnapshot, scanSnapshot } from "../snapshot/snapshot.js";
import type { SnapshotOptions } from "../snapshot/snapshot-types.js";
import { inspectLock, isLockGuardHeld, isStaleLock, withLock } from "../state/lock.js";
import { readStateForConfig } from "../state/sync-state-store.js";
import { formatDiff, formatSnapshotOnlyDiff, publicationCapabilityDescription } from "../ui/sync-format.js";
import { setSyncStatus } from "../ui/sync-status.js";
import { safeTerminalText } from "../ui/terminal-text.js";
import { portableSnapshot } from "./local-fields.js";
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
  const backend = await factory(config);
  const snapshotOptions = await resolvedSnapshotOptionsForContext(ctx, config, options.signal);
  const local = portableSnapshot(await createSnapshot(config.snapshotIdentity, snapshotOptions), config.localFields);
  throwIfAborted(options.signal);
  const { snapshot: remote, selectionState } = await readRemoteSnapshot(backend, config, options.signal, {
    allowSelectionDifference: true,
    sessionDir: snapshotOptions.sessionDir,
  });
  throwIfAborted(options.signal);
  setSyncStatus(ctx, undefined);

  const warnings = syncSessionsWarnings(config);
  const header = [
    `sync setup: ${config.setupName}`,
    `storage connection: ${config.connectionName}`,
    `storage location: ${safeTerminalText(backend.destination)}`,
    ...contentLines(config),
    formatRemoteSelectionStatus(selectionState),
    ...warnings,
  ].join("\n");
  const level = warnings.length > 0 || selectionState?.kind === "different" ? "warning" : "info";
  if (!remote) {
    ctx.ui.notify(`${header}\n\n${formatSnapshotOnlyDiff("Remote is empty. Local push would upload", local)}`, level);
    return;
  }

  ctx.ui.notify(`${header}\n\n${formatDiff(local, portableSnapshot(remote, remote.localFields))}`, level);
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
) {
  const config = await loadConfig(options.setup);
  throwIfAborted(options.signal);
  const backend = await factory(config);
  const snapshots = (await backend.listHistory(options.signal)).slice(-HISTORY_PREVIEW_LIMIT).reverse();
  throwIfAborted(options.signal);
  const lastApplied = await readStateForConfig(config)
    .then((state) => state.lastAppliedSnapshot)
    .catch(() => undefined);
  throwIfAborted(options.signal);
  const appliedDetails = lastApplied
    ? `Last applied snapshot ID: ${safeTerminalText(lastApplied)}\nApplication time: unavailable. Snapshot dates are creation times.`
    : "Last applied snapshot ID: unavailable.";
  if (snapshots.length === 0) {
    ctx.ui.notify(`No remote pi-sync history found.\n${appliedDetails}`, "info");
    return;
  }

  const currentSnapshot = snapshots[0]?.snapshotId;
  if (ctx.mode === "tui") {
    const labels = snapshots.map(
      (item, index) =>
        `${index + 1}. ${item.createdAt} · ${safeTerminalText(item.machine)} · ${item.snapshotId}${item.snapshotId === currentSnapshot ? " (current)" : ""}${item.syncSessions ? " · sessions" : ""}`,
    );
    const selected = await ctx.ui.select(
      `History for sync setup “${safeTerminalText(config.setupName)}”\n\n${appliedDetails}\n\nChoose a snapshot to preview rollback.`,
      [...labels, "Back"],
      { signal: options.signal },
    );
    if (!selected || selected === "Back") return;
    throwIfAborted(options.signal);
    const index = labels.indexOf(selected);
    const snapshot = snapshots[index];
    if (!snapshot) return;
    await withLock("rollback", () =>
      rollback(ctx, { ...options, args: [snapshot.snapshotRef], yes: false }, factory, {
        backendIdentity: backend.identity,
        setup: config.setupName,
      }),
    );
    return;
  }
  ctx.ui.notify(
    [
      appliedDetails,
      ...snapshots.map((item) => `${item.snapshotRef} ${item.createdAt} ${safeTerminalText(item.machine)}`),
    ].join("\n"),
    "info",
  );
}
