import type { ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { showDaemonStatus } from "../daemon/daemon-status-ui.js";
import { CompletedDirectionalRecoveryError } from "../daemon/directional-recovery.js";
import { type PiDaemonClient, piDaemonClient, remoteOperation } from "../daemon/pi-client.js";
import { activeLocalConfigPath, createLocalConfigDocument, localConfigPath } from "../settings/config-file.js";
import { localConfigTemplate, readLocalConfigObject } from "../settings/settings-store.js";
import { throwIfAborted } from "../sync/signals.js";
import { syncErrorGuidance } from "../sync/sync-error-guidance.js";
import { errorMessage, isSyncDecisionRequiredError, SetupPullRequiresUiError } from "../sync/sync-errors.js";
import type { SyncLoaders } from "../sync/sync-loaders.js";
import { RemoteSelectionMismatchError } from "../sync/sync-policy.js";
import type { RunRouteResult } from "../ui/cancellable-operation.js";
import { trackOperationDialogs } from "../ui/operation-dialogs.js";
import { setSyncStatus } from "../ui/sync-status.js";
import { safeTerminalText } from "../ui/terminal-text.js";
import {
  parseOptions,
  resolveSyncCommand,
  retiredSyncCommandGuidance,
  splitArgs,
  usage,
  validateCommandOptions,
} from "./command.js";
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
  directionalFingerprint?: string,
): Promise<RunRouteResult> {
  ctx = trackOperationDialogs(ctx, onDialog);
  try {
    const directionalClient = directionalFingerprint === undefined ? undefined : piDaemonClient(ctx);
    const command = await resolveSyncCommand(rawArgs, ctx);
    if (signal?.aborted || !command) return { kind: "completed" };
    const { subcommand, rest } = command;
    const retired = retiredSyncCommandGuidance(subcommand);
    if (retired) {
      ctx.ui.notify(retired, "warning");
      return { kind: "failed" };
    }
    if (directionalClient && directionalFingerprint !== undefined) {
      if ((subcommand !== "push" && subcommand !== "pull") || rest.length || !setup || retryRefusal)
        throw new Error("Invalid directional action.");
      return await runDirectionalAction(
        directionalClient,
        ctx,
        subcommand,
        setup,
        directionalFingerprint,
        signal,
        onCommit,
      );
    }
    const options = parseOptions(rest);
    if (setup !== undefined) options.setup = setup;
    if (signal) options.signal = signal;
    if (onCommit) options.onCommit = onCommit;
    validateCommandOptions(subcommand, options);
    if (retryRefusal) throw new Error("Model retries are no longer supported. Use reviewed manual sync.");

    switch (subcommand) {
      case "daemon": {
        const client = piDaemonClient(ctx);
        const action = options.args[0] ?? "status";
        if (action === "recover") {
          if (rest.length !== 1) throw new Error("Usage: /sync daemon recover");
          const { recoverDaemonOwnership } = await import("../daemon/ownership-recovery.js");
          await recoverDaemonOwnership(ctx, client, signal);
        } else if (action === "handover") {
          await client.run("daemon.handover", {}, options.signal);
        } else if (action === "allow-after-exit") {
          throw new Error("Continuous sync was retired. New after-exit grants are not supported.");
        } else if (action === "revoke-after-exit") {
          await client.run("daemon.handover", {}, options.signal);
          const policy = (await client.run("daemon.policy", {}, options.signal)) as { fingerprint: string };
          await client.run("daemon.authorize", { fingerprint: policy.fingerprint, afterExit: false }, options.signal);
        } else if (action === "status") {
          await showDaemonStatus(ctx, client, options.signal);
        } else throw new Error("Use /sync daemon status|recover|handover|allow-after-exit|revoke-after-exit.");
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
      case "files": {
        const { showFileSelection } = await import("../ui/file-selection.js");
        throwIfAborted(options.signal);
        await showFileSelection(ctx, options.setup, options.signal);
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
        return { kind: "completed", ...(retryRefusal && outcome && outcome !== "archived" ? { outcome } : {}) };
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
    if (directionalFingerprint !== undefined) {
      ctx.ui.notify(safeTerminalText(errorMessage(error)).slice(0, 1200), "error");
      return { kind: "failed" };
    }
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

async function runDirectionalAction(
  client: PiDaemonClient,
  ctx: ExtensionCommandContext,
  direction: "push" | "pull",
  setup: string,
  fingerprint: string,
  signal: AbortSignal | undefined,
  onCommit: (() => void) | undefined,
): Promise<RunRouteResult> {
  try {
    const operation = `${direction}.foreground`;
    const intent = { setup, fingerprint };
    const result = (await client.run(operation, intent, signal, ctx, onCommit)) as
      | { outcome?: "applied" | "cancelled"; message?: string }
      | undefined;
    if (!client.canReportDirectionalResult() || (signal?.aborted && result?.outcome !== "applied"))
      return { kind: "failed" };
    if (
      !result ||
      (result.outcome !== "applied" && result.outcome !== "cancelled") ||
      (result.message !== undefined && typeof result.message !== "string")
    ) {
      throw new Error("Invalid result from directional synchronization.");
    }
    if (result.message) ctx.ui.notify(safeTerminalText(result.message), "info");
    return signal?.aborted ? { kind: "failed" } : { kind: "completed", outcome: result.outcome };
  } catch (error) {
    const completed = error instanceof CompletedDirectionalRecoveryError;
    if (!client.canReportDirectionalResult() || (signal?.aborted && !completed)) return { kind: "failed" };
    if (!signal?.aborted) setSyncStatus(ctx, undefined);
    const message = safeTerminalText(errorMessage(error));
    ctx.ui.notify(completed ? message : message.slice(0, 1200), "error");
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
