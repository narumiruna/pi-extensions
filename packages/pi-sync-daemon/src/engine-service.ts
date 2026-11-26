import {
  authorizeAfterExit,
  captureAutomaticAuthorization,
  consentFingerprint,
  readConsent,
  requireHandover,
} from "./consent.js";
import { createDaemonDebug } from "./daemon-debug.js";
import { type DocumentView, documentFingerprint } from "./document.js";
import type { CommandOptions } from "./engine/commands/command-types.js";
import type { EngineContext } from "./engine/host.js";
import { retiredIgnorePolicy } from "./engine/settings/retired-ignore-policy.js";
import { assertNoRetiredRuleJournal } from "./engine/settings/retired-ignore-recovery.js";
import { captureStartupReviewLock } from "./engine/state/lock.js";
import { createLegacyConsentGuard } from "./legacy-consent-guard.js";
import { type Execute, type Execution, MAX_SETTINGS_BYTES, record } from "./protocol.js";
import type { startServer } from "./server.js";
import { createServiceContext, installServiceHost } from "./service-host.js";

function optionsFrom(
  value: unknown,
  execution: Execution,
  automatic: boolean,
): CommandOptions & { automaticFingerprint?: string } {
  if (!record(value)) throw new Error("Invalid operation options.");
  const allowed = new Set(["yes", "force", "stale", "silent", "reload", "setup", "args", "agentRetryRefusal"]);
  if (automatic) allowed.add("automaticFingerprint");
  if (
    Object.keys(value).some((key) => !allowed.has(key)) ||
    ["yes", "force", "stale", "silent", "reload", "agentRetryRefusal"].some(
      (key) => value[key] !== undefined && typeof value[key] !== "boolean",
    ) ||
    (value.setup !== undefined && (typeof value.setup !== "string" || value.setup.length > 512)) ||
    !Array.isArray(value.args) ||
    value.args.length > 16 ||
    value.args.some((arg) => typeof arg !== "string" || arg.length > 4096) ||
    (value.automaticFingerprint !== undefined &&
      (typeof value.automaticFingerprint !== "string" || !/^[a-f0-9]{64}$/u.test(value.automaticFingerprint))) ||
    (automatic &&
      (value.setup !== undefined ||
        value.force ||
        value.stale ||
        value.reload ||
        value.agentRetryRefusal ||
        value.args.length !== 0))
  )
    throw new Error("Invalid operation options.");
  return {
    yes: false,
    force: false,
    stale: false,
    silent: false,
    reload: false,
    auto: false,
    ...value,
    args: value.args as string[],
    ...(typeof value.automaticFingerprint === "string" ? { automaticFingerprint: value.automaticFingerprint } : {}),
    signal: execution.signal,
    onCommit: execution.committed,
    noteDebugOutcome: execution.noteDebugOutcome,
  };
}
/** Engine dispatch is loaded only by the service, never by the public IPC client. */
export function createEngineService(root: string) {
  const host = installServiceHost(root);
  const consentGuard = createLegacyConsentGuard(root);
  let server: Awaited<ReturnType<typeof startServer>> | undefined;
  const execute: Execute = (operation, payload, execution) =>
    host.run(execution, async () => {
      if (operation.startsWith("ignore.") || operation === "daemon.authorize-connected")
        throw retiredIgnorePolicy("settings");
      execution.validate();
      if (operation !== "settings.repair-read" && operation !== "monitor.pause") assertNoRetiredRuleJournal();
      if (operation === "daemon.authorize") {
        return Boolean(await authorizeAfterExit(execution, payload));
      }
      if (operation === "daemon.handover") {
        await requireHandover(execution);
        return true;
      }
      if (operation === "daemon.policy") {
        const { loadConfigForCheck } = await import("./engine/settings/config.js");
        const config = await loadConfigForCheck(undefined, execution.signal);
        execution.validate();
        const fingerprint = consentFingerprint(root, config);
        return { setup: config.setupName, fingerprint, automatic: true, afterExit: false };
      }
      if (operation === "monitor.pause") return;
      if (operation === "settings.read" || operation === "settings.repair-read") {
        const { readLocalConfigDocument } = await import("./engine/settings/settings-store.js");
        const { readActiveLocalConfigDocumentForRepair } = await import("./engine/settings/config-file.js");
        const document = await (operation === "settings.read" && readConsent(root)
          ? readLocalConfigDocument()
          : readActiveLocalConfigDocumentForRepair());
        execution.validate();
        if (document && operation === "settings.read") {
          const { validateSettingsDocument } = await import("./engine/settings/settings-validation.js");
          execution.validate();
          validateSettingsDocument(document.parsed);
        }
        return document ? ({ ...document, bytes: document.bytes.toString("base64") } satisfies DocumentView) : null;
      }
      if (operation === "settings.cas") {
        if (
          !record(payload) ||
          (payload.expected !== null &&
            (typeof payload.expected !== "string" || !/^[a-f0-9]{64}$/u.test(payload.expected))) ||
          !record(payload.next)
        )
          throw new Error("Invalid settings mutation.");
        const { updateLocalConfigDocument, peekLocalConfigDocument } = await import("./engine/settings/config-file.js");
        const { localConfigTemplate } = await import("./engine/settings/settings-store.js");
        const { validateSettingsDocument } = await import("./engine/settings/settings-validation.js");
        const next = validateSettingsDocument(payload.next);
        if (Buffer.byteLength(JSON.stringify(next)) > MAX_SETTINGS_BYTES)
          throw new Error("Settings exceed the editable local API byte limit; no fields were dropped.");
        const validateSource = (document: { bytes: Buffer; identity: { dev: number; ino: number } } | undefined) => {
          execution.validate();
          const view = document ? { bytes: document.bytes.toString("base64"), identity: document.identity } : undefined;
          if (documentFingerprint(view) !== payload.expected)
            throw new Error("Settings changed; reopen the review before saving.");
        };
        const original = await peekLocalConfigDocument();
        validateSource(original);
        if (original) validateSettingsDocument(original.parsed);
        await requireHandover(execution);
        execution.validate();
        const saved = await updateLocalConfigDocument(
          localConfigTemplate(),
          () => {
            execution.validate();
            validateSettingsDocument(next);
            return next;
          },
          validateSettingsDocument,
          execution.signal,
          validateSource,
        );
        if (!original || JSON.stringify(original.parsed) !== JSON.stringify(saved)) execution.committed();
        return saved;
      }
      const ctx = createServiceContext(execution);
      if (operation === "initialize") return initialize(ctx, execution);
      if (operation === "inspect") {
        if (!record(payload) || (payload.setup !== undefined && typeof payload.setup !== "string"))
          throw new Error("Invalid inspection request.");
        const { withStateDirectoryAccess } = await import("./engine/state/state-directory.js");
        const { withLock } = await import("./engine/state/lock.js");
        return withJobTimings(ctx, execution, "daemon inspection", (timings) =>
          withStateDirectoryAccess(() =>
            withLock("startup-check", async () => {
              const { loadConfigForCheck, syncCheckConfigFingerprint } = await import("./engine/settings/config.js");
              const config = await loadConfigForCheck(payload.setup as string | undefined, execution.signal);
              execution.validate();
              if (payload.fingerprint !== syncCheckConfigFingerprint(config))
                throw new Error("Settings changed before inspection.");
              const { snapshotOptionsForContext } = await import("./engine/snapshot/session-paths.js");
              const { inspectSync } = await import("./engine/sync/sync-inspection.js");
              execution.validate();
              return inspectSync(config, snapshotOptionsForContext(ctx, config), execution.signal, undefined, timings);
            }),
          ),
        );
      }
      if (operation === "push.foreground" || operation === "pull.foreground") {
        const direction = operation === "push.foreground" ? "push" : "pull";
        return runForegroundDirectional(host, execution, ctx, direction, payload);
      }
      const supported = [
        "status",
        "diff",
        "doctor",
        "history",
        "push",
        "pull",
        "sync",
        "startup-transfer",
        "shutdown",
        "conflicts",
        "rollback",
        "unlock",
        "migrate-state",
      ];
      if (!supported.includes(operation)) throw new Error("Unsupported engine operation.");
      const isAutomatic = operation === "startup-transfer" || operation === "shutdown";
      const options = optionsFrom(payload, execution, isAutomatic);
      if (options.agentRetryRefusal)
        throw new Error("Model retries are no longer supported. Use reviewed manual sync.");
      if (!options.reload) ctx.reload = undefined;
      if (operation === "shutdown") {
        const { loadConfigForCheck } = await import("./engine/settings/config.js");
        const { syncSessionsSelected } = await import("./engine/sync/sync-policy.js");
        const config = await loadConfigForCheck(undefined, execution.signal);
        execution.validate();
        if (!config.automatic || !syncSessionsSelected(config)) {
          execution.noteDebugOutcome?.("skipped");
          return;
        }
      }
      if (!ctx.hasUI || !["tui", "rpc"].includes(ctx.mode)) {
        execution.noteDebugOutcome?.("blocked");
        throw new Error("Synchronization requires an observable TUI or RPC client.");
      }
      const { withStateDirectoryAccess, migrateLegacyStateDirectory } = await import(
        "./engine/state/state-directory.js"
      );
      if (operation === "migrate-state") {
        if (!options.yes) {
          const accepted = await ctx.ui.confirm(
            "Migrate pi-sync state directory",
            "Confirm that every older Pi process is closed. Preserve both roots and pending journals on failure.",
            { signal: execution.signal },
          );
          execution.validate();
          if (!accepted) {
            execution.noteDebugOutcome?.("cancelled");
            return { status: "cancelled", message: "pi-sync state migration cancelled." };
          }
        }
        execution.validate();
        const result = await migrateLegacyStateDirectory();
        if (result.status === "migrated") execution.committed();
        execution.validate();
        return result;
      }
      return withStateDirectoryAccess(async () => {
        const automatic = isAutomatic
          ? await captureAutomaticAuthorization(execution, options.automaticFingerprint)
          : undefined;
        if (automatic) options.background = { validate: automatic.validate };
        if (["push", "pull", "sync", "startup-transfer", "shutdown", "conflicts", "rollback"].includes(operation)) {
          await requireHandover(execution);
          await automatic?.refresh();
          await initialize(ctx, execution, false);
          await automatic?.refresh();
        }
        const { withLock, unlock } = await import("./engine/state/lock.js");
        if (operation === "unlock") return unlock(ctx, options);
        const operations = await import("./engine/sync/sync-operations.js");
        if (operation === "conflicts") {
          const { showConflicts } = await import("./engine/sync/conflict-review.js");
          return withLock("sync", () => showConflicts(ctx, options));
        }
        if (operation === "shutdown") {
          const { pushSessionsOnShutdown } = await import("./engine/sync/session-push.js");
          return pushSessionsOnShutdown(ctx, options, { operations: async () => operations });
        }
        if (operation === "startup-transfer") {
          const { startupTransferEnabled } = await import("./engine/sync/agent-policy.js");
          if (!automatic || !startupTransferEnabled(automatic.config) || !ctx.isIdle()) {
            execution.noteDebugOutcome?.("blocked");
            throw new Error("Startup transfer is no longer authorized or idle.");
          }
          options.auto = true;
          options.yes = true;
          options.silent = true;
          options.reload = false;
        }
        if (operation === "sync" || operation === "startup-transfer") {
          const run = () =>
            withLock("sync", async () => {
              execution.validate();
              if (operation === "startup-transfer") {
                if (!automatic) throw new Error("Missing startup transfer authorization.");
                const { startupTransferEnabled } = await import("./engine/sync/agent-policy.js");
                const { inspectSync } = await import("./engine/sync/sync-inspection.js");
                const { snapshotOptionsForContext } = await import("./engine/snapshot/session-paths.js");
                await automatic.refresh();
                const config = automatic.config;
                const inspection = await inspectSync(config, snapshotOptionsForContext(ctx, config), options.signal);
                await automatic.refresh();
                execution.validate();
                if (
                  !startupTransferEnabled(config) ||
                  !ctx.isIdle() ||
                  execution.participants().some((peer) => peer.ready !== true) ||
                  inspection.firstSync ||
                  !inspection.head ||
                  inspection.selectionState?.kind !== "same"
                ) {
                  execution.noteDebugOutcome?.("blocked");
                  throw new Error(
                    "Startup transfer requires a fresh initialized baseline, matching selection, and idle ready clients; use the reviewed foreground command.",
                  );
                }
              }
              return operations.syncBoth(ctx, options);
            });
          return operation === "startup-transfer"
            ? withJobTimings(ctx, execution, "daemon transfer", async (timings) => {
                options.startupTimings = timings;
                const result = await run();
                if (timings.wasUnchanged()) execution.noteDebugOutcome?.("skipped");
                return result;
              })
            : run();
        }
        if (operation === "push" || operation === "pull" || operation === "rollback")
          return withLock<unknown>(operation, () => operations[operation](ctx, options));
        if (operation === "status" || operation === "diff" || operation === "doctor" || operation === "history")
          return operations[operation](ctx, options);
        throw new Error("Unreachable operation.");
      });
    });
  return {
    execute,
    bind(value: Awaited<ReturnType<typeof startServer>>) {
      server = value;
    },
    hooks: {
      diagnostic: createDaemonDebug(root),
      startup: {
        captureReviewLock: captureStartupReviewLock,
        async probe(fingerprint: string, signal: AbortSignal, reviewLock?: () => boolean) {
          const { captureStartupBootstrap } = await import("./engine/sync/startup-bootstrap.js");
          return captureStartupBootstrap(root, fingerprint, signal, reviewLock);
        },
      },
      async factsChanged() {
        if (server) consentGuard.factsChanged(server.participants());
      },
      lifetime: () => (host.cleanupRequired() ? Promise.resolve("pause" as const) : consentGuard.lifetime()),
      failure: consentGuard.block,
      foregroundRecoveryAllowed: consentGuard.allowsRecovery,
      upgradeAllowed: () => !host.cleanupRequired() && consentGuard.allowsRecovery(),
    },
  };
}
async function runForegroundDirectional(
  host: ReturnType<typeof installServiceHost>,
  execution: Execution,
  ctx: EngineContext,
  direction: "push" | "pull",
  payload: unknown,
) {
  const fingerprintPattern = /^[a-f0-9]{64}$/u;
  if (
    !execution.clientId ||
    !ctx.hasUI ||
    !["tui", "rpc"].includes(ctx.mode) ||
    !record(payload) ||
    Object.keys(payload).some((key) => !["setup", "fingerprint", "retryCheckpoint"].includes(key)) ||
    typeof payload.setup !== "string" ||
    !payload.setup ||
    payload.setup.length > 512 ||
    typeof payload.fingerprint !== "string" ||
    !fingerprintPattern.test(payload.fingerprint) ||
    (payload.retryCheckpoint !== undefined &&
      (typeof payload.retryCheckpoint !== "string" || !fingerprintPattern.test(payload.retryCheckpoint)))
  ) {
    throw new Error("Invalid foreground directional request.");
  }
  const { setup, fingerprint, retryCheckpoint } = payload;
  const { withStateDirectoryAccess } = await import("./engine/state/state-directory.js");
  const { withLock } = await import("./engine/state/lock.js");
  const { loadConfigForCheck, syncCheckConfigFingerprint } = await import("./engine/settings/config.js");
  const operations = await import("./engine/sync/sync-operations.js");
  const validate = (config: Awaited<ReturnType<typeof loadConfigForCheck>>) => {
    execution.validate();
    if (config.setupName !== setup || syncCheckConfigFingerprint(config) !== fingerprint)
      throw new Error(
        "The sync setup changed after the action was selected. No transfer was started for the changed setup.",
      );
  };
  execution.validate();
  return withStateDirectoryAccess(async () => {
    validate(await loadConfigForCheck(undefined, execution.signal));
    if (retryCheckpoint === undefined) {
      await requireHandover(execution);
      validate(await loadConfigForCheck(undefined, execution.signal));
      await initialize(ctx, execution, false);
    } else {
      if (!readConsent(execution.root))
        throw new Error("Daemon handover is no longer valid; the transfer was not replayed.");
      await requireStartupRecoveryCleared(execution);
    }
    return host.runForeground(execution, () =>
      withLock(direction, async () => {
        validate(await loadConfigForCheck(undefined, execution.signal));
        let message: string | undefined;
        const outcome = await operations[direction](ctx, {
          ...optionsFrom({ setup, args: [] }, execution, false),
          directionalAction: {
            validate,
            async checkpoint(current) {
              execution.validate();
              if (retryCheckpoint !== undefined && retryCheckpoint !== current)
                throw new Error(
                  "The transfer source or destination changed during recovery. The transfer was not replayed.",
                );
              const accepted = await execution.request("directional-checkpoint", { fingerprint: current });
              if (accepted !== true)
                throw new Error("The original transfer could not be retained for recovery. No transfer was started.");
              execution.validate();
            },
            notifySuccess(value) {
              message = value;
            },
          },
        });
        return { outcome, ...(message === undefined ? {} : { message }) };
      }),
    );
  });
}

async function withJobTimings<T>(
  ctx: EngineContext,
  execution: Execution,
  label: "daemon inspection" | "daemon transfer",
  action: (timings: import("./engine/sync/startup-timings.js").StartupTimings) => Promise<T>,
): Promise<T> {
  const { createStartupTimings } = await import("./engine/sync/startup-timings.js");
  const timings = createStartupTimings((_ctx, report) => execution.emit("timings", { report }));
  let completed = false;
  try {
    const result = await action(timings);
    completed = true;
    return result;
  } finally {
    timings.publish(
      ctx,
      execution.facts()?.startupDebug ?? false,
      execution.signal,
      label,
      completed ? "completed" : "stopped",
      timingObserver(execution),
    );
  }
}

async function requireStartupRecoveryCleared(execution: Execution) {
  const { pendingTransactionEntries } = await import("./engine/snapshot/snapshot-transaction-directory.js");
  execution.validate();
  const pending = await pendingTransactionEntries();
  execution.validate();
  if (pending.length)
    throw new Error(
      "Pi Sync startup cannot confirm recovery is clear. Preserve recovery files and check /sync doctor before retrying.",
    );
}

async function initialize(ctx: EngineContext, execution: Execution, diagnostics = true) {
  const { pendingTransactionEntries } = await import("./engine/snapshot/snapshot-transaction-directory.js");
  const pending = await pendingTransactionEntries();
  execution.validate();
  if (pending.some((entry) => entry.isDirectory()) && !readConsent(execution.root))
    throw new Error(
      "Pending local recovery requires reviewed daemon handover. Close older Pi processes and use /sync daemon handover, then /reload before editing managed files.",
    );
  if (!readConsent(execution.root)) {
    const { stateDirectoryMigrationNotice } = await import("./engine/state/state-directory.js");
    const notice = await stateDirectoryMigrationNotice();
    execution.validate();
    if (notice) throw new Error(notice);
    // Before ownership approval, report metadata without filename migration or recovery writes.
    const { peekLocalConfigDocument } = await import("./engine/settings/config-file.js");
    const { validateSettingsDocument } = await import("./engine/settings/settings-validation.js");
    const { configFromSettings } = await import("./engine/settings/config.js");
    const document = await peekLocalConfigDocument();
    execution.validate();
    const settings = document ? validateSettingsDocument(document.parsed) : undefined;
    const config = settings?.activeSyncSetup ? configFromSettings(settings) : undefined;
    if (diagnostics) await requireStartupRecoveryCleared(execution);
    execution.noteDebugOutcome?.("blocked");
    return { debug: settings?.debug ?? false, settings, config, handoverRequired: true };
  }
  const { initializeSync } = await import("./engine/sync/initialization.js");
  const initialized = await initializeSync(
    ctx,
    execution.signal,
    (_ctx, report) => {
      if (diagnostics) execution.emit("timings", { report });
    },
    diagnostics ? timingObserver(execution) : undefined,
  );
  execution.validate();
  if (diagnostics) await requireStartupRecoveryCleared(execution);
  execution.validate();
  return { ...initialized, handoverRequired: !readConsent(execution.root) };
}

function timingObserver(execution: Execution) {
  const debug = execution.debug;
  return debug ? (report: string) => debug({ event: "startup-timings", report }) : undefined;
}
