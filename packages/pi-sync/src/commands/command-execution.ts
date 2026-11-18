import type { ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { piDaemonClient, remoteOperation } from "../daemon/pi-client.js";
import { loadConfig, sessionTokenWarnings, syncSessionsWarnings } from "../settings/config.js";
import { activeLocalConfigPath, createLocalConfigDocument, localConfigPath } from "../settings/config-file.js";
import { localConfigTemplate, readLocalConfigObject } from "../settings/settings-store.js";
import type { AnySyncConfig } from "../settings/settings-types.js";
import { throwIfAborted } from "../sync/signals.js";
import { syncErrorGuidance } from "../sync/sync-error-guidance.js";
import { isSyncDecisionRequiredError, SetupPullRequiresUiError } from "../sync/sync-errors.js";
import type { SyncLoaders } from "../sync/sync-loaders.js";
import { RemoteSelectionMismatchError, syncSessionsSelected } from "../sync/sync-policy.js";
import { automaticSyncSummary } from "../ui/automatic-sync-summary.js";
import type { RunRouteResult } from "../ui/cancellable-operation.js";
import { trackOperationDialogs } from "../ui/operation-dialogs.js";
import { startupTransferSummary } from "../ui/sync-behavior.js";
import { setSyncStatus } from "../ui/sync-status.js";
import { safeTerminalText } from "../ui/terminal-text.js";
import { parseOptions, resolveSyncCommand, splitArgs, usage, validateCommandOptions } from "./command.js";
import type { CommandOptions } from "./command-types.js";

export async function executeRecoveryCommand(
  rawArgs: string,
  ctx: ExtensionContext,
  signal: AbortSignal | undefined,
  loaders: SyncLoaders,
  onCommit?: () => void,
  setup?: string,
): Promise<RunRouteResult> {
  try {
    const [subcommand, ...rest] = splitArgs(rawArgs);
    if (subcommand !== "sync" && subcommand !== "pull" && subcommand !== "push") {
      throw new Error(`Unsupported sync recovery route: ${subcommand ?? "missing"}`);
    }
    const options = parseOptions(rest);
    if (setup !== undefined) options.setup = setup;
    if (signal) options.signal = signal;
    if (onCommit) options.onCommit = onCommit;
    options.reload = false;
    options.auto = false;
    validateCommandOptions(subcommand, options);
    const operations = await loaders.operations();
    throwIfAborted(options.signal);
    if (subcommand === "push") {
      const outcome = await operations.push(ctx, options);
      return { kind: "completed", ...(outcome ? { outcome } : {}) };
    }
    if (subcommand === "pull") {
      const outcome = await operations.pull(ctx, options);
      return { kind: "completed", ...(outcome ? { outcome } : {}) };
    }
    await operations.syncBoth(ctx, options);
    return { kind: "completed" };
  } catch (error) {
    if (signal?.aborted) return { kind: "failed" };
    setSyncStatus(ctx, undefined);
    if (error instanceof RemoteSelectionMismatchError) {
      return { kind: "remote-selection-required", decision: error.decision };
    }
    if (isSyncDecisionRequiredError(error)) {
      return { kind: "decision-required", decision: error.decision };
    }
    ctx.ui.notify(syncErrorGuidance(error), "error");
    return { kind: "failed" };
  }
}

export async function executeCommand(
  rawArgs: string,
  ctx: ExtensionCommandContext,
  signal: AbortSignal | undefined,
  loaders: SyncLoaders,
  onCommit?: () => void,
  setup?: string,
  onDialog?: (active: boolean) => void,
  retryRefusal = false,
): Promise<RunRouteResult> {
  ctx = trackOperationDialogs(ctx, onDialog);
  try {
    const command = await resolveSyncCommand(rawArgs, ctx);
    if (signal?.aborted || !command) return { kind: "completed" };
    const { subcommand, rest } = command;
    const options = parseOptions(rest);
    if (setup !== undefined) options.setup = setup;
    if (signal) options.signal = signal;
    if (onCommit) options.onCommit = onCommit;
    validateCommandOptions(subcommand, options);
    if (retryRefusal) {
      if (subcommand !== "sync") throw new Error("A refused-model retry is available only for merged sync.");
      options.agentRetryRefusal = true;
    }

    switch (subcommand) {
      case "daemon": {
        const client = piDaemonClient(ctx);
        const action = options.args[0] ?? "status";
        if (action === "handover") {
          await client.run("daemon.handover", {}, options.signal);
        } else if (action === "allow-after-exit" || action === "revoke-after-exit") {
          await client.run("daemon.handover", {}, options.signal);
          const policy = (await client.run("daemon.policy", {}, options.signal)) as { fingerprint: string };
          await client.run(
            "daemon.authorize",
            { fingerprint: policy.fingerprint, afterExit: action === "allow-after-exit" },
            options.signal,
          );
        } else if (action === "status") {
          const connection = await client.verifyConnection(options.signal);
          ctx.ui.notify(
            `pi-sync-daemon: connected\nPID: ${connection.identity.pid}\nInstance: ${connection.identity.instance}\nUse pi-sync-daemon status/stop/restart --root <agent-directory> for explicit lifecycle control.`,
            "info",
          );
        } else throw new Error("Use /sync daemon status|handover|allow-after-exit|revoke-after-exit.");
        return { kind: "completed" };
      }
      case "help":
        ctx.ui.notify(usage(), "info");
        return { kind: "completed" };
      case "use": {
        const { useSyncSetup } = await loaders.setupSwitch();
        throwIfAborted(options.signal);
        await useSyncSetup(
          ctx,
          options.args[0] ?? "",
          async (selectedSetup) => {
            const operations = await loaders.operations();
            throwIfAborted(options.signal);
            return operations.pull(ctx, { ...options, setup: selectedSetup });
          },
          undefined,
          options.signal,
        );
        return { kind: "completed" };
      }
      case "init":
        await initConfig(ctx, signal);
        return { kind: "completed" };
      case "config":
        await showConfig(ctx, options);
        return { kind: "completed" };
      case "files": {
        const { showFileSelection } = await import("../ui/file-selection.js");
        throwIfAborted(options.signal);
        await showFileSelection(ctx, options.setup, options.signal);
        return { kind: "completed" };
      }
      case "status": {
        const operations = await loaders.operations();
        throwIfAborted(options.signal);
        await operations.status(ctx, options);
        return { kind: "completed" };
      }
      case "diff": {
        const operations = await loaders.operations();
        throwIfAborted(options.signal);
        await operations.diff(ctx, options);
        return { kind: "completed" };
      }
      case "conflicts": {
        const { showConflicts } = await import("../sync/conflict-review.js");
        throwIfAborted(options.signal);
        await showConflicts(ctx, options);
        return { kind: "completed" };
      }
      case "doctor": {
        const operations = await loaders.operations();
        throwIfAborted(options.signal);
        await operations.doctor(ctx, options);
        return { kind: "completed" };
      }
      case "push": {
        const operations = await loaders.operations();
        throwIfAborted(options.signal);
        const outcome = await operations.push(ctx, options);
        return { kind: "completed", ...(outcome ? { outcome } : {}) };
      }
      case "pull": {
        const operations = await loaders.operations();
        throwIfAborted(options.signal);
        const outcome = await operations.pull(ctx, options);
        return { kind: "completed", ...(outcome ? { outcome } : {}) };
      }
      case "sync": {
        const operations = await loaders.operations();
        throwIfAborted(options.signal);
        const outcome = await operations.syncBoth(ctx, options);
        return { kind: "completed", ...(retryRefusal && outcome ? { outcome } : {}) };
      }
      case "history": {
        const operations = await loaders.operations();
        throwIfAborted(options.signal);
        await operations.history(ctx, options);
        return { kind: "completed" };
      }
      case "rollback": {
        const operations = await loaders.operations();
        throwIfAborted(options.signal);
        await operations.rollback(ctx, options);
        return { kind: "completed" };
      }
      case "migrate-state":
        await migrateStateDirectory(ctx, options);
        return { kind: "completed" };
      case "unlock":
        await remoteOperation(ctx, "unlock", options);
        return { kind: "completed" };
      default:
        ctx.ui.notify(`Unknown /sync command: ${subcommand}\n\n${usage()}`, "warning");
        return { kind: "failed" };
    }
  } catch (error) {
    if (signal?.aborted) return { kind: "failed" };
    setSyncStatus(ctx, undefined);
    if (error instanceof SetupPullRequiresUiError) throw error;
    if (error instanceof RemoteSelectionMismatchError) {
      return { kind: "remote-selection-required", decision: error.decision };
    }
    if (isSyncDecisionRequiredError(error)) {
      return { kind: "decision-required", decision: error.decision };
    }
    ctx.ui.notify(syncErrorGuidance(error), "error");
    return { kind: "failed" };
  }
}

async function migrateStateDirectory(ctx: ExtensionCommandContext, options: CommandOptions) {
  const result = (await remoteOperation(ctx, "migrate-state", options)) as
    | { status: string; message?: string }
    | undefined;
  throwIfAborted(options.signal);
  ctx.ui.notify(
    result?.message ?? "pi-sync already uses the canonical pi-sync/ state directory.",
    result?.status === "deferred" ? "warning" : "info",
  );
}

async function initConfig(ctx: ExtensionCommandContext, signal?: AbortSignal) {
  const configPath = localConfigPath();
  const existing = await readLocalConfigObject();
  throwIfAborted(signal);
  if (existing) {
    const activePath = await activeLocalConfigPath();
    throwIfAborted(signal);
    ctx.ui.notify(`Config already exists: ${activePath}`, "info");
    return;
  }

  if (ctx.mode === "tui") {
    const { showSetupWizard } = await import("../ui/setup/setup-wizard.js");
    throwIfAborted(signal);
    await showSetupWizard(ctx, signal);
    return;
  }
  await createLocalConfigDocument(localConfigTemplate(), signal);
  throwIfAborted(signal);
  ctx.ui.notify(`Created ${configPath}. Add a storage connection and sync setup before syncing.`, "info");
}

async function showConfig(ctx: ExtensionCommandContext, options: CommandOptions) {
  const config = await loadConfig(options.setup);
  const warnings = [
    ...(config.backend.type === "s3" ? sessionTokenWarnings(config.backend.profile) : []),
    ...syncSessionsWarnings(config),
  ];
  const storageLines = configStorageLines(config);
  ctx.ui.notify(
    [
      "pi-sync config:",
      `sync setup: ${config.setupName}`,
      `storage connection: ${config.connectionName}`,
      ...storageLines,
      `storage path: ${config.storagePath}`,
      `automatic sync: ${automaticSyncSummary(config.automatic)}`,
      `settings field merge: ${config.mergeSettings ? "On" : "Off"}`,
      `machine-local settings.json fields: ${(config.localFields ?? []).map(safeTerminalText).join(", ") || "none"}`,
      `startup transfer: ${startupTransferSummary(config)}`,
      `autonomous sync: ${config.agentMode ? "On" : "Off"}`,
      `continuous sync: ${config.continuous ? (config.agentMode ? "On" : "paused; Autonomous sync is Off") : "Off"}`,
      `included content: ${config.include.join(", ") || "none"}`,
      `sessions: ${syncSessionsSelected(config) ? "included" : "not included"}`,
      `settings file: ${localConfigPath()}`,
      ...warnings,
    ].join("\n"),
    warnings.length > 0 ? "warning" : "info",
  );
}

function configStorageLines(config: AnySyncConfig) {
  switch (config.backend.type) {
    case "git":
      return [
        "kind: git",
        `remote: ${displayGitRemote(config.backend.profile.remote)}`,
        "authentication: existing Git/SSH credentials (not stored)",
        `branch: ${config.backend.destination.branch}`,
      ];
    case "webdav":
      return [
        "kind: webdav",
        `url: ${displayWebDavUrl(config.backend.profile.url, config.backend.profile.username)}`,
        "username: configured (value hidden)",
        "password: configured",
      ];
    case "s3":
      return [
        "kind: s3",
        `endpoint: ${config.backend.profile.endpoint}`,
        `bucket: ${config.backend.destination.bucket}`,
        `region: ${config.backend.profile.region}`,
        "access key id: configured",
        "secret access key: configured",
        `session token: ${config.backend.profile.sessionToken ? "configured" : "not configured"}`,
      ];
  }
}

function displayGitRemote(value: string | undefined) {
  if (!value) return "missing";
  try {
    const url = new URL(value);
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return value.replace(/^(?:[^@\s]+@)?(?<host>[^:]+):.+$/u, "$<host>:…");
  }
}

function displayWebDavUrl(value: string | undefined, username: string | undefined) {
  if (!value) return "missing";
  try {
    const url = new URL(value);
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return username ? `${url.origin}/…` : `${url.origin}${url.pathname}`;
  } catch {
    return "invalid (value hidden)";
  }
}
