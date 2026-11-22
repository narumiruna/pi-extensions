import { createHash } from "node:crypto";
import type { RemoteHead } from "../backends/sync-backend.js";
import type { CommandOptions } from "../commands/command-types.js";
import type { EngineContext } from "../host.js";
import { loadConfigForCheck, syncCheckConfigFingerprint } from "../settings/config.js";
import type { AnySyncConfig } from "../settings/settings-types.js";
import { effectiveSessionRoot } from "../snapshot/session-paths.js";
import { agentDirectoryInventory, filterSnapshotForConfigPolicy } from "../snapshot/snapshot.js";
import type { Snapshot } from "../snapshot/snapshot-types.js";
import type { SyncState } from "../state/state-types.js";
import { syncStateFingerprint } from "../state/sync-state-store.js";
import { safeTerminalText } from "../ui/terminal-text.js";
import { inspectCaseCleanup } from "./apply-review.js";
import { requireCompatibleRemoteSelection } from "./remote-snapshot.js";
import { inspectRemoteSelection, syncSelectionHasContent } from "./sync-policy.js";
import { fileHashMap, syncPolicyChanged } from "./sync-state.js";
import { checkLiveProtection } from "./transfer-freshness.js";

export function foregroundDirectionalAction(ctx: EngineContext, options: CommandOptions) {
  const action = options.directionalAction;
  if (
    action &&
    (options.auto ||
      options.background ||
      options.force ||
      options.yes ||
      options.reload ||
      options.stale ||
      options.args.length > 0 ||
      options.agentRetryRefusal ||
      !ctx.hasUI ||
      (ctx.mode !== "tui" && ctx.mode !== "rpc"))
  )
    throw new Error("Single-action transfer requires a bound foreground Push or Pull.");
  return action;
}

export async function validateDirectionalSettings(
  options: CommandOptions,
  config: AnySyncConfig,
  validateMutation: () => void,
) {
  const current = await loadConfigForCheck(undefined, options.signal);
  validateMutation();
  options.directionalAction?.validate(current);
  if (syncCheckConfigFingerprint(current) !== syncCheckConfigFingerprint(config))
    throw new Error("Settings changed before the directional transfer could write.");
}

export async function checkpointDirectionalAction(
  options: CommandOptions,
  evidence: {
    direction: "push" | "pull";
    config: AnySyncConfig;
    state: SyncState;
    head: RemoteHead | undefined;
    local: Snapshot;
    remote: Snapshot | undefined;
    sessionDir: string | undefined;
    protectedPaths: ReadonlySet<string>;
  },
) {
  const { direction, config, state, head, local, remote, sessionDir, protectedPaths } = evidence;
  const hash = createHash("sha256")
    .update(
      JSON.stringify([
        direction,
        syncCheckConfigFingerprint(config),
        syncStateFingerprint(state),
        head,
        Object.entries(fileHashMap(local)).sort(),
        [...(agentDirectoryInventory(local)?.entries ?? [])].filter(([, kind]) => kind === "directory").sort(),
        remote && Object.entries(fileHashMap(remote)).sort(),
        sessionDir,
        [...protectedPaths].sort(),
      ]),
    )
    .digest("hex");
  await options.directionalAction?.checkpoint?.(hash);
}

export function requireDirectionalSelection(
  config: AnySyncConfig,
  state: SyncState,
  local: Snapshot,
  remote: Snapshot | undefined,
  sessionDir: string | undefined,
) {
  if (!syncSelectionHasContent(config)) throw new Error("This setup has no managed content for the transfer.");
  const current = config.ignorePolicy;
  const remoteProjected = current && remote && filterSnapshotForConfigPolicy(remote, config, { sessionDir });
  const managed = new Set([...local.files, ...(remoteProjected?.files ?? [])].map((file) => file.path));
  const provesNarrowing = (priorPaths: readonly string[], priorSessions: boolean) => {
    if (!current || (!priorSessions && current.sessions)) return false;
    const prior = new Set(priorPaths);
    return (
      [...managed].every((item) => prior.has(item)) &&
      ((priorSessions && !current.sessions) ||
        priorPaths.some((item) => !managed.has(item) && current.matches(item, false)))
    );
  };
  if (remote) {
    const selection = inspectRemoteSelection(config.include, remote, config.exclude, config);
    if (
      !(
        selection.ignorePolicyComparison === "mismatch" &&
        remote.selection?.version === 4 &&
        provesNarrowing(
          remote.files.map((file) => file.path),
          remote.selection.sessions,
        )
      )
    )
      requireCompatibleRemoteSelection(config, remote);
  }
  if (
    state.lastAppliedSnapshot &&
    syncPolicyChanged(state, config) &&
    !(
      state.scope === config.scope &&
      state.ignorePolicyKey &&
      provesNarrowing(Object.keys(state.lastFileHashes), state.include?.includes("sessions") === true)
    )
  )
    throw new Error(
      "Managed content policy changed and this transfer cannot prove that it only narrows the accepted selection. Review the new policy before transferring.",
    );
}

export function keepProtectedRemoteSessions(
  config: AnySyncConfig,
  upload: Snapshot,
  remote: Snapshot | undefined,
  sessionDir: string | undefined,
  protectedPaths: ReadonlySet<string>,
) {
  if (!protectedPaths.size) return upload;
  const retained = (remote?.files ?? []).filter((file) => protectedPaths.has(file.path));
  const selectedRemote = remote && filterSnapshotForConfigPolicy(remote, config, { sessionDir });
  const uploaded = new Set(upload.files.map((file) => file.path));
  const selected = new Set(selectedRemote?.files.map((file) => file.path));
  if (retained.some((file) => !selected.has(file.path) && !uploaded.has(file.path)))
    throw new Error("Push would remove a protected live session from remote storage.");
  const files = [...upload.files.filter((file) => !protectedPaths.has(file.path)), ...retained];
  return {
    ...upload,
    ...(upload.selection?.version === 4
      ? { syncSessions: files.some((file) => file.path.startsWith("sessions/")) }
      : {}),
    files: files.sort((a, b) => a.path.localeCompare(b.path)),
  };
}

export async function requireDirectionalPullBoundary(
  ctx: EngineContext,
  options: CommandOptions,
  config: AnySyncConfig,
  physical: Snapshot,
  snapshotOptions: Parameters<typeof inspectCaseCleanup>[1],
  protectedPaths: ReadonlySet<string>,
  validateMutation: () => void,
) {
  await validateDirectionalSettings(options, config, validateMutation);
  if ((await effectiveSessionRoot(ctx, config, options.signal)) !== snapshotOptions.sessionDir)
    throw new Error("Pi session storage changed before Pull could write.");
  if ((await inspectCaseCleanup(physical, snapshotOptions)).length)
    throw new Error(
      "Pull would remove case-variant paths not represented in its local backup. Review a separate Pull instead.",
    );
  validateMutation();
  checkLiveProtection(ctx, snapshotOptions.sessionDir, protectedPaths);
}

export function notifyDirectionalSuccess(
  ctx: EngineContext,
  options: CommandOptions,
  message: string,
  warning = false,
) {
  if (options.directionalAction?.notifySuccess) options.directionalAction.notifySuccess(message);
  else if (!options.silent) ctx.ui.notify(message, warning ? "warning" : "info");
}

export function remoteRestoreGuidance(head: RemoteHead) {
  const ref = head.snapshotRef === head.snapshotId ? "" : ` (reference ${safeTerminalText(head.snapshotRef)})`;
  return `Restore the previous remote version ${safeTerminalText(head.snapshotId)}${ref} from /sync → History.`;
}

export function localRestoreGuidance(backup: string) {
  return `Local backup: ${safeTerminalText(backup)}. To restore locally, close Pi and follow the local backup restore steps in the Pi Sync README.`;
}
