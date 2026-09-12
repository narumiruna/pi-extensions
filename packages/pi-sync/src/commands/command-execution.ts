import type { ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadConfig, sessionTokenWarnings, syncSessionsWarnings } from "../settings/config.js";
import { activeLocalConfigPath, createLocalConfigDocument, localConfigPath } from "../settings/config-file.js";
import { localConfigTemplate, readLocalConfigObject } from "../settings/settings-store.js";
import type { AnySyncConfig } from "../settings/settings-types.js";
import { unlock, withLock } from "../state/lock.js";
import { migrateLegacyStateDirectory, stateDirectoryMigrationNotice } from "../state/state-directory.js";
import { throwIfAborted } from "../sync/signals.js";
import { syncErrorGuidance } from "../sync/sync-error-guidance.js";
import { isSyncDecisionRequiredError, SetupPullRequiresUiError } from "../sync/sync-errors.js";
import type { SyncLoaders } from "../sync/sync-loaders.js";
import { RemoteSelectionMismatchError } from "../sync/sync-policy.js";
import { automaticSyncSummary } from "../ui/automatic-sync-summary.js";
import type { RunRouteResult } from "../ui/cancellable-operation.js";
import { parseOptions, resolveSyncCommand, splitArgs, usage, validateCommandOptions } from "./command.js";
import type { CommandOptions } from "./command-types.js";

const STATUS_KEY = "sync";

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
      const outcome = await withLock("push", () => operations.push(ctx, options));
      return { kind: "completed", ...(outcome ? { outcome } : {}) };
    }
    if (subcommand === "pull") {
      const outcome = await withLock("pull", () => operations.pull(ctx, options));
      return { kind: "completed", ...(outcome ? { outcome } : {}) };
    }
    await withLock("sync", () => operations.syncBoth(ctx, options));
    return { kind: "completed" };
  } catch (error) {
    if (signal?.aborted) return { kind: "failed" };
    ctx.ui.setStatus(STATUS_KEY, undefined);
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
): Promise<RunRouteResult> {
  try {
    const command = await resolveSyncCommand(rawArgs, ctx);
    if (signal?.aborted || !command) return { kind: "completed" };
    const { subcommand, rest } = command;
    const options = parseOptions(rest);
    if (setup !== undefined) options.setup = setup;
    if (signal) options.signal = signal;
    if (onCommit) options.onCommit = onCommit;
    validateCommandOptions(subcommand, options);

    switch (subcommand) {
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
            return withLock("pull", () => operations.pull(ctx, { ...options, setup: selectedSetup }));
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
      case "doctor": {
        const operations = await loaders.operations();
        throwIfAborted(options.signal);
        await operations.doctor(ctx, options);
        return { kind: "completed" };
      }
      case "push": {
        const operations = await loaders.operations();
        throwIfAborted(options.signal);
        const outcome = await withLock("push", () => operations.push(ctx, options));
        return { kind: "completed", ...(outcome ? { outcome } : {}) };
      }
      case "pull": {
        const operations = await loaders.operations();
        throwIfAborted(options.signal);
        const outcome = await withLock("pull", () => operations.pull(ctx, options));
        return { kind: "completed", ...(outcome ? { outcome } : {}) };
      }
      case "sync": {
        const operations = await loaders.operations();
        throwIfAborted(options.signal);
        await withLock("sync", () => operations.syncBoth(ctx, options));
        return { kind: "completed" };
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
        await withLock("rollback", () => operations.rollback(ctx, options));
        return { kind: "completed" };
      }
      case "migrate-state":
        await migrateStateDirectory(ctx, options);
        return { kind: "completed" };
      case "unlock":
        await unlock(ctx, options);
        return { kind: "completed" };
      default:
        ctx.ui.notify(`Unknown /sync command: ${subcommand}\n\n${usage()}`, "warning");
        return { kind: "failed" };
    }
  } catch (error) {
    if (signal?.aborted) return { kind: "failed" };
    ctx.ui.setStatus(STATUS_KEY, undefined);
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
  const notice = stateDirectoryMigrationNotice();
  if (!notice) {
    ctx.ui.notify("pi-sync already uses the canonical pi-sync/ state directory.", "info");
    return;
  }
  if (
    !options.yes &&
    !(await ctx.ui.confirm(
      "Migrate pi-sync state directory",
      "Confirm that every other Pi process is closed. pi-sync will atomically rename .pisync/ to pi-sync/ without merging or deleting either root.",
      { signal: options.signal },
    ))
  ) {
    ctx.ui.notify("pi-sync state migration cancelled.", "info");
    return;
  }
  throwIfAborted(options.signal);
  const result = await migrateLegacyStateDirectory();
  throwIfAborted(options.signal);
  if (result.status === "ready") {
    ctx.ui.notify("pi-sync already uses the canonical pi-sync/ state directory.", "info");
    return;
  }
  ctx.ui.notify(result.message, result.status === "migrated" ? "info" : "warning");
}

async function initConfig(ctx: ExtensionCommandContext, signal?: AbortSignal) {
  const configPath = localConfigPath();
  if (await readLocalConfigObject()) {
    ctx.ui.notify(`Config already exists: ${await activeLocalConfigPath()}`, "info");
    return;
  }

  if (ctx.mode === "tui") {
    const { showSetupWizard } = await import("../ui/setup/setup-wizard.js");
    throwIfAborted(signal);
    await showSetupWizard(ctx, signal);
    return;
  }
  await createLocalConfigDocument(localConfigTemplate());
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
      `included content: ${config.include.join(", ") || "none"}`,
      `sessions: ${config.include.includes("sessions") ? "included" : "not included"}`,
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
