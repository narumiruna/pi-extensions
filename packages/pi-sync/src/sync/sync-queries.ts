import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { createSyncBackend, type SyncBackendFactory } from "../backends/backend-factory.js";
import type { SyncBackend } from "../backends/sync-backend.js";
import type { CommandOptions } from "../commands/command-types.js";
import { loadConfig, syncSessionsWarnings } from "../settings/config.js";
import { snapshotOptionsForContext } from "../snapshot/session-paths.js";
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

const DEFAULT_PROFILE = "default";

export async function status(
  ctx: ExtensionCommandContext,
  options: CommandOptions,
  factory: SyncBackendFactory = createSyncBackend,
) {
  const config = await loadConfig(options.setup);
  throwIfAborted(options.signal);
  setSyncStatus(ctx, `checking ${config.setupName}`, { activity: "checking" });
  const { head, selectionState, localChanged, remoteChanged, localFiles, destination, capability } = await inspectSync(
    config,
    snapshotOptionsForContext(ctx, config),
    options.signal,
    factory,
  );
  throwIfAborted(options.signal);

  const continuous = config.continuous
    ? await (await import("./continuous-record.js")).continuousStatusLines(config)
    : [];
  throwIfAborted(options.signal);
  const remoteText = head ? `remote: ${head.snapshotId} from ${head.machine} at ${head.createdAt}` : "remote: empty";
  const warnings = syncSessionsWarnings(config);
  setSyncStatus(ctx, undefined);
  ctx.ui.notify(
    [
      `sync setup: ${config.setupName}`,
      `storage connection: ${config.connectionName}`,
      `storage location: ${safeTerminalText(destination)}`,
      `publication safety: ${publicationCapabilityDescription(capability)}`,
      `included content: ${config.include.join(", ") || "none"}`,
      `sessions: ${config.include.includes("sessions") ? "included" : "excluded"}`,
      ...continuous,
      remoteText,
      formatRemoteSelectionStatus(selectionState),
      `local files: ${localFiles}`,
      `local changed since last sync: ${localChanged ? "yes" : "no"}`,
      `remote changed since last sync: ${remoteChanged ? "yes" : "no"}`,
      ...warnings,
    ].join("\n"),
    localChanged || remoteChanged || selectionState?.kind === "different" || warnings.length > 0 ? "warning" : "info",
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
  const local = portableSnapshot(
    await createSnapshot(config.snapshotIdentity, snapshotOptionsForContext(ctx, config)),
    config.localFields,
  );
  throwIfAborted(options.signal);
  const { snapshot: remote, selectionState } = await readRemoteSnapshot(backend, config, options.signal, {
    allowSelectionDifference: true,
  });
  throwIfAborted(options.signal);
  setSyncStatus(ctx, undefined);

  const warnings = syncSessionsWarnings(config);
  const header = [
    `sync setup: ${config.setupName}`,
    `storage connection: ${config.connectionName}`,
    `storage location: ${safeTerminalText(backend.destination)}`,
    `included content: ${config.include.join(", ") || "none"}`,
    `sessions: ${config.include.includes("sessions") ? "included" : "excluded"}`,
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
  const messages: string[] = [];
  let level: "info" | "warning" = "info";
  let snapshotOptions: SnapshotOptions = {};
  let profile = DEFAULT_PROFILE;
  let backend: SyncBackend | undefined;
  let backendSummary: string[] = [];

  try {
    const config = await loadConfig(options.setup);
    throwIfAborted(options.signal);
    backend = await factory(config);
    profile = config.snapshotIdentity;
    snapshotOptions = snapshotOptionsForContext(ctx, config);
    messages.push(
      `config: ok (sync setup ${config.setupName})`,
      `included content: ${config.include.join(", ") || "none"}`,
      `sessions: ${config.include.includes("sessions") ? "included" : "excluded"}`,
    );
    backendSummary = [
      `storage location: ${safeTerminalText(backend.destination)}`,
      `publication safety: ${publicationCapabilityDescription(backend.capability)}`,
    ];
    const warnings = syncSessionsWarnings(config);
    if (warnings.length > 0) {
      level = "warning";
      messages.push(...warnings);
    }
  } catch (error) {
    throwIfAborted(options.signal);
    level = "warning";
    messages.push(`config: ${errorMessage(error)}`);
  }

  const local = await createSnapshot(profile, snapshotOptions);
  throwIfAborted(options.signal);
  const secrets = scanSnapshot(local);
  if (secrets.length > 0) {
    level = "warning";
    messages.push("secret scan: possible secrets found:");
    messages.push(...secrets.map((secret) => `- ${secret}`));
  } else {
    messages.push(`secret scan: ok (${local.files.length} files checked)`);
  }

  const lock = await inspectLock();
  throwIfAborted(options.signal);
  if (lock.status === "valid" && isStaleLock(lock.lock)) {
    level = "warning";
    messages.push(`lock: stale (pid ${lock.lock.pid}); run /sync unlock --stale after verifying no sync is running`);
  } else if (lock.status === "valid") {
    messages.push(`lock: held by pid ${lock.lock.pid} since ${lock.lock.startedAt}`);
  } else if (lock.status === "unreadable") {
    level = "warning";
    messages.push("lock: unreadable; use /sync unlock --stale only after verifying no sync is running");
  } else if (await isLockGuardHeld()) {
    throwIfAborted(options.signal);
    level = "warning";
    messages.push("lock: guard active while metadata is missing or still being initialized");
  } else {
    messages.push("lock: free");
  }

  if (backend) {
    messages.push(...backendSummary);
    const diagnostics = await backend.diagnose(options.signal);
    throwIfAborted(options.signal);
    for (const diagnostic of diagnostics) {
      messages.push(diagnostic.message);
      if (diagnostic.level !== "info") level = "warning";
    }
  }
  ctx.ui.notify(messages.join("\n"), level);
}

export async function history(
  ctx: ExtensionCommandContext,
  options: CommandOptions,
  factory: SyncBackendFactory = createSyncBackend,
) {
  const config = await loadConfig(options.setup);
  throwIfAborted(options.signal);
  const backend = await factory(config);
  const snapshots = (await backend.listHistory(options.signal)).slice(-20).reverse();
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
