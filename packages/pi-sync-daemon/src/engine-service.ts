import { authorizeAfterExit, consentFingerprint, readConsent, requireHandover } from "./consent.js";
import { type DocumentView, documentFingerprint } from "./document.js";
import type { CommandOptions } from "./engine/commands/command-types.js";
import type { EngineContext } from "./engine/host.js";
import { createMonitor } from "./monitor.js";
import { type Execute, type Execution, MAX_SETTINGS_BYTES, record } from "./protocol.js";
import { createServiceContext, installServiceHost } from "./service-host.js";

function optionsFrom(value: unknown, execution: Execution): CommandOptions {
  if (!record(value)) throw new Error("Invalid operation options.");
  const allowed = new Set(["yes", "force", "stale", "silent", "reload", "setup", "args", "agentRetryRefusal"]);
  if (
    Object.keys(value).some((key) => !allowed.has(key)) ||
    ["yes", "force", "stale", "silent", "reload", "agentRetryRefusal"].some(
      (key) => value[key] !== undefined && typeof value[key] !== "boolean",
    ) ||
    (value.setup !== undefined && (typeof value.setup !== "string" || value.setup.length > 512)) ||
    !Array.isArray(value.args) ||
    value.args.length > 16 ||
    value.args.some((arg) => typeof arg !== "string" || arg.length > 4096)
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
    signal: execution.signal,
    onCommit: execution.committed,
  };
}
/** Engine dispatch is loaded only by the service, never by the public IPC client. */
export function createEngineService(root: string) {
  const host = installServiceHost(root);
  const monitor = createMonitor(root, host);
  const execute: Execute = (operation, payload, execution) =>
    host.run(execution, async () => {
      await monitor.pause();
      execution.validate();
      if (operation === "daemon.authorize") return authorizeAfterExit(execution, payload);
      if (operation === "daemon.handover") {
        await requireHandover(execution);
        return true;
      }
      if (operation === "daemon.policy") {
        const { loadConfig } = await import("./engine/settings/config.js");
        const config = await loadConfig();
        const fingerprint = consentFingerprint(root, config);
        const saved = readConsent(root)?.setups[config.setupName];
        const facts = execution.facts();
        return {
          setup: config.setupName,
          fingerprint,
          afterExit: Boolean(
            saved?.afterExit &&
              saved.fingerprint === fingerprint &&
              JSON.stringify(saved.model) === JSON.stringify(facts?.model) &&
              saved.sessionDir === facts?.sessionDir &&
              saved.cwd === facts?.cwd,
          ),
        };
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
        const next = payload.next;
        validateSettingsDocument(next);
        if (Buffer.byteLength(JSON.stringify(next)) > MAX_SETTINGS_BYTES)
          throw new Error("Settings exceed the editable local API byte limit; no fields were dropped.");
        const validateSource = (document: { bytes: Buffer; identity: { dev: number; ino: number } } | undefined) => {
          execution.validate();
          const view = document ? { bytes: document.bytes.toString("base64"), identity: document.identity } : undefined;
          if (documentFingerprint(view) !== payload.expected)
            throw new Error("Settings changed; reopen the review before saving.");
        };
        validateSource(await peekLocalConfigDocument());
        await requireHandover(execution);
        execution.validate();
        return updateLocalConfigDocument(
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
              const { loadConfig, syncCheckConfigFingerprint } = await import("./engine/settings/config.js");
              const config = await loadConfig(payload.setup as string | undefined);
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
      const options = optionsFrom(payload, execution);
      if (!options.reload) ctx.reload = undefined;
      if (operation === "shutdown") {
        const { loadConfigForCheck } = await import("./engine/settings/config.js");
        const { syncSessionsSelected } = await import("./engine/sync/sync-policy.js");
        const config = await loadConfigForCheck();
        execution.validate();
        if (!config.automatic || !syncSessionsSelected(config)) return;
      }
      if (!ctx.hasUI || !["tui", "rpc"].includes(ctx.mode))
        throw new Error("Synchronization requires an observable TUI or RPC client.");
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
          if (!accepted) return { status: "cancelled", message: "pi-sync state migration cancelled." };
        }
        execution.validate();
        const result = await migrateLegacyStateDirectory();
        if (result.status === "migrated") execution.committed();
        execution.validate();
        return result;
      }
      return withStateDirectoryAccess(async () => {
        if (["startup-transfer", "shutdown"].includes(operation) && !readConsent(root))
          throw new Error("Automatic work requires reviewed daemon handover first.");
        if (["push", "pull", "sync", "startup-transfer", "shutdown", "conflicts", "rollback"].includes(operation)) {
          await requireHandover(execution);
          await initialize(ctx, execution, false);
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
          const { loadConfig } = await import("./engine/settings/config.js");
          const { startupTransferEnabled } = await import("./engine/sync/agent-policy.js");
          if (!startupTransferEnabled(await loadConfig(options.setup)) || !ctx.isIdle())
            throw new Error("Startup transfer is no longer authorized or idle.");
          options.auto = true;
          options.yes = true;
          options.silent = true;
          options.reload = false;
        }
        if (operation === "sync" || operation === "startup-transfer") {
          const run = async () => {
            const { prepareResolverHost } = await import("./resolver-host.js");
            const { loadConfig } = await import("./engine/settings/config.js");
            const config = await loadConfig(options.setup);
            execution.validate();
            if (operation === "sync" && !options.agentRetryRefusal) monitor.explicitSync(config.setupName, execution);
            const binding = JSON.stringify(execution.facts()?.model);
            const resolver = await prepareResolverHost(
              root,
              config.agentMode ? execution.facts()?.model : undefined,
              execution.signal,
            );
            try {
              ctx.modelUnavailableReason = resolver.unavailable;
              Object.defineProperty(ctx, "model", {
                get: () => (JSON.stringify(execution.facts()?.model) === binding ? resolver.model : undefined),
              });
              ctx.validateModel = async () => {
                const fresh = await execution.request("model-binding", {});
                execution.validate();
                if (JSON.stringify(fresh ?? undefined) !== binding)
                  throw new Error("Selected provider/model capability changed before dispatch.");
              };
              ctx.modelRegistry = {
                streamSimple: (model, context, options) => {
                  execution.validate();
                  if (JSON.stringify(execution.facts()?.model) !== binding)
                    throw new Error("Selected model changed before dispatch.");
                  if (resolver.unavailable) throw new Error(resolver.unavailable);
                  return resolver.registry.streamSimple(model, context, options);
                },
              };
              const { withAgentSyncLock } = await import("./engine/sync/agent-sync.js");
              return await withAgentSyncLock(ctx, options, async (current) => {
                if (operation === "startup-transfer") {
                  const { loadConfig } = await import("./engine/settings/config.js");
                  const { startupTransferEnabled } = await import("./engine/sync/agent-policy.js");
                  const config = await loadConfig(current.setup);
                  execution.validate();
                  const { inspectSync } = await import("./engine/sync/sync-inspection.js");
                  const { snapshotOptionsForContext } = await import("./engine/snapshot/session-paths.js");
                  const inspection = await inspectSync(config, snapshotOptionsForContext(ctx, config), current.signal);
                  execution.validate();
                  if (
                    !startupTransferEnabled(config) ||
                    !ctx.isIdle() ||
                    execution.participants().some((peer) => peer.ready !== true) ||
                    inspection.firstSync ||
                    !inspection.head ||
                    inspection.selectionState?.kind !== "same"
                  )
                    throw new Error(
                      "Startup transfer requires a fresh initialized baseline, matching selection, and idle ready clients; use the reviewed foreground command.",
                    );
                }
                return operations.syncBoth(ctx, current);
              });
            } finally {
              await resolver.settle();
            }
          };
          return operation === "startup-transfer"
            ? withJobTimings(ctx, execution, "daemon transfer", (timings) => {
                options.startupTimings = timings;
                return run();
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
    bind: monitor.bind,
    hooks: {
      factsChanged: monitor.factsChanged,
      idle: monitor.schedule,
      close: monitor.close,
      lifetime: monitor.lifetime,
      quiesce: monitor.pause,
      failure: monitor.blockAutomatic,
    },
  };
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
    );
  }
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
    return { debug: settings?.debug ?? false, settings, config, handoverRequired: true };
  }
  const { initializeSync } = await import("./engine/sync/initialization.js");
  const initialized = await initializeSync(ctx, execution.signal, (_ctx, report) => {
    if (diagnostics) execution.emit("timings", { report });
  });
  return { ...initialized, handoverRequired: !readConsent(execution.root) };
}
