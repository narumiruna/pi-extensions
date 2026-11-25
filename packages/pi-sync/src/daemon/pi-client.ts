import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { lstatSync, realpathSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { type ExtensionContext, getAgentDir } from "@earendil-works/pi-coding-agent";
import {
  type Callback,
  type ClientFacts,
  type ClientHandoff,
  type ContactState,
  DaemonConnection,
  DaemonError,
  type DaemonRecoveryTarget,
  type DocumentView,
  documentFingerprint,
  ensureDaemon,
  findDaemon,
  MAX_SETTINGS_BYTES,
  modelSignature,
  OWNERSHIP_CLEANUP_REQUIRED,
  waitForDaemonExit,
} from "@narumitw/pi-sync-daemon";
import { appendDebugEvent, type DebugEvent } from "@narumitw/pi-sync-daemon/engine/debug-log";
import { type ConfigAuthority, configureEngineHost } from "@narumitw/pi-sync-daemon/engine/host";
import {
  type LocalConfigDocument,
  peekLocalConfigDocument,
} from "@narumitw/pi-sync-daemon/engine/settings/config-file";
import { validateSettingsDocument } from "@narumitw/pi-sync-daemon/engine/settings/settings-validation";
import { sessionDirFromContext } from "@narumitw/pi-sync-daemon/engine/snapshot/session-paths";
import type { CommandOptions } from "../commands/command-types.js";
import type { StartupTimingPublisher } from "../sync/startup-timings.js";
import { errorMessage, SyncDecisionRequiredError } from "../sync/sync-errors.js";
import { RemoteSelectionMismatchError } from "../sync/sync-policy.js";
import {
  type SyncStatusPresentation,
  setSyncStatus,
  showSyncConnectionStatus,
  showSyncQueueReleaseRecovery,
} from "../ui/sync-status.js";
import { safeTerminalText } from "../ui/terminal-text.js";
import { PiApplyGate } from "./apply-gate.js";
import { observeDebugJob } from "./client-debug.js";
import {
  type DirectionalCheckpoint,
  isForegroundDirection,
  type PendingAdoptionRecovery,
  runDirectionalRecovery,
} from "./directional-recovery.js";
import { createQueueReleaseUI, type QueueReleaseEvent } from "./queue-release-ui.js";
import { quarantineClient, recoverDetachedClients } from "./recovery.js";
import { requestStartupBootstrap } from "./startup-bootstrap-client.js";

const scope = new AsyncLocalStorage<{ client: PiDaemonClient; reload?: AbortController }>();
const clients = new WeakMap<ExtensionContext["sessionManager"], PiDaemonClient>();
export function currentPiDaemonClient() {
  return current();
}
function current() {
  const client = scope.getStore()?.client;
  if (!client) throw new Error("Pi synchronization requires a current session-bound daemon client.");
  client.validate();
  return client;
}
function canonicalPath(value: string | undefined): string | undefined {
  // An in-memory session (`pi --no-session`) reports an empty session dir instead of
  // omitting it, so an empty path means "no path to publish", not a broken caller.
  if (value === undefined || value === "") return undefined;
  if (!path.isAbsolute(value)) throw new Error("Pi session paths must be absolute.");
  const parts: string[] = [];
  let cursor = path.resolve(value);
  for (;;) {
    try {
      return path.join(realpathSync(cursor), ...parts.toReversed());
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" || path.dirname(cursor) === cursor) throw error;
      parts.push(path.basename(cursor));
      cursor = path.dirname(cursor);
    }
  }
}
function decode(value: unknown): LocalConfigDocument | undefined {
  if (value === null) return undefined;
  const document = value as DocumentView;
  if (
    !document ||
    typeof document.path !== "string" ||
    typeof document.bytes !== "string" ||
    !document.identity ||
    !document.parsed
  )
    throw new Error("Invalid settings response.");
  return { ...document, bytes: Buffer.from(document.bytes, "base64") };
}
function fingerprint(document: LocalConfigDocument | undefined) {
  return documentFingerprint(
    document ? { bytes: document.bytes.toString("base64"), identity: document.identity } : undefined,
  );
}
let settingsQueue = Promise.resolve();
const authority: ConfigAuthority = {
  read: (repair) => {
    const client = current();
    return settingsQueue.then(() => {
      client.validate();
      return client.readSettings(repair);
    });
  },
  update: <T extends Record<string, unknown>>(
    fallback: T,
    update: (value: T) => T,
    validate: (value: Record<string, unknown>) => void,
    signal?: AbortSignal,
  ): Promise<T> => {
    const client = current();
    // Capture ownership and invocation order before prerequisite awaits.
    const operation = settingsQueue.then(async () => {
      client.validate();
      signal?.throwIfAborted();
      const document = await client.readSettings(true);
      client.validate();
      signal?.throwIfAborted();
      if (document) validate(document.parsed);
      const next = update(structuredClone(document?.parsed ?? fallback) as T);
      validate(next);
      await client.run("settings.cas", { expected: fingerprint(document), next }, signal);
      client.validate();
      return next;
    });
    settingsQueue = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  },
  create: async (next, signal) => {
    await current().run("settings.cas", { expected: null, next }, signal);
  },
  replace: async (document, next) => {
    await current().run("settings.cas", { expected: fingerprint(document), next });
  },
};
/** Factory registration installs only adapters; it starts no process and performs no I/O. */
export function installPiDaemonHost() {
  configureEngineHost({
    root: () => scope.getStore()?.client.root ?? path.resolve(getAgentDir()),
    config: authority,
    mutate: async () => {
      throw new Error("File mutation belongs to pi-sync-daemon; no in-process fallback is permitted.");
    },
    review: async () => {
      throw new Error("Engine reviews must arrive through the daemon API.");
    },
  });
}
export function bindPiDaemonClient(ctx: ExtensionContext, signal: AbortSignal, publish?: StartupTimingPublisher) {
  const client = new PiDaemonClient(ctx, signal, publish);
  clients.set(ctx.sessionManager, client);
  return client;
}
export function piDaemonClient(ctx: ExtensionContext) {
  const client = clients.get(ctx.sessionManager);
  if (!client) throw new Error("The Pi synchronization client is not attached to this session.");
  client.validate();
  return client;
}
export function withPiDaemonClient<Context extends ExtensionContext, T>(
  ctx: Context,
  action: (owned: Context) => Promise<T>,
  reload?: AbortController,
) {
  const owner = { client: piDaemonClient(ctx), reload };
  // TUI input arrives from Pi's event loop, outside the command's async call tree.
  // Bind public component methods so later menu actions retain this exact owner,
  // never a replacement session selected through a global fallback.
  const ui = new Proxy(ctx.ui, {
    get(target, property) {
      if (property !== "custom") return Reflect.get(target, property, target);
      return (...args: Parameters<ExtensionContext["ui"]["custom"]>) => {
        const [factory, options] = args;
        const wrap = (component: Awaited<ReturnType<typeof factory>>) => {
          const methods = new Map<PropertyKey, { source: unknown; bound: unknown }>();
          return new Proxy(component, {
            get(original, key) {
              const value: unknown = Reflect.get(original, key, original);
              if (typeof value !== "function") return value;
              const saved = methods.get(key);
              if (saved?.source === value) return saved.bound;
              const bound = (...values: unknown[]) => scope.run(owner, () => Reflect.apply(value, original, values));
              methods.set(key, { source: value, bound });
              return bound;
            },
          });
        };
        const invoke = (...provided: Parameters<typeof factory>) => {
          const component = scope.run(owner, () => factory(...provided));
          return component instanceof Promise ? component.then(wrap) : wrap(component);
        };
        // Do not turn synchronous editors/reviews into asynchronous factories.
        return target.custom(
          factory.constructor.name === "AsyncFunction" ? async (...provided) => invoke(...provided) : invoke,
          options,
        );
      };
    },
  });
  const owned = new Proxy(ctx, {
    get(target, key) {
      return key === "ui" ? ui : Reflect.get(target, key, target);
    },
  });
  return scope.run(owner, () => action(owned));
}
export async function remoteOperation(ctx: ExtensionContext, operation: string, options: CommandOptions) {
  const client = piDaemonClient(ctx);
  const { signal, onCommit, args, setup } = options;
  const owner = scope.getStore();
  const reload = options.reload && owner?.client === client ? owner.reload : undefined;
  reload?.signal.throwIfAborted();
  const payload = {
    args,
    ...(setup === undefined ? {} : { setup }),
    ...(options.automaticFingerprint === undefined ? {} : { automaticFingerprint: options.automaticFingerprint }),
    yes: options.yes,
    force: options.force,
    stale: options.stale,
    silent: options.silent,
    reload: reload !== undefined,
    ...(options.agentRetryRefusal ? { agentRetryRefusal: true } : {}),
  };
  return client.run(operation, payload, signal, ctx, onCommit, reload);
}
function remoteErrorNamed(error: unknown, name: string) {
  return error instanceof DaemonError && error.remote.name === name;
}

export class PiDaemonClient {
  private connection?: DaemonConnection;
  private protectionOnly = false;
  private partialConnection?: DaemonConnection;
  private work = Promise.resolve();
  private factsQueue = Promise.resolve();
  private closing = false;
  private paused = false;
  private pausing?: Promise<void>;
  private connecting?: Promise<DaemonConnection>;
  private contactRepair?: { controller: AbortController; done: Promise<void> };
  private contactAttempt?: { error?: unknown };
  private contactFactsUnpublished = false;
  private contactStatus?: { clear(redraw?: boolean): void; unavailable: boolean };
  private releaseUIEnabled = true;
  private runSignal?: AbortSignal;
  private readonly releaseUI = createQueueReleaseUI(
    () => {
      const ctx = this.releaseContext();
      if (ctx) return showSyncQueueReleaseRecovery(ctx);
    },
    () =>
      this.releaseContext()?.ui.notify(
        "Pi Sync could not confirm the file write queue release. Sync may be paused; check /sync daemon status before retrying.",
        "warning",
      ),
  );
  private readonly stopReleaseUI = () => {
    // Withdraw while the SDK owner is still active, but never redraw through a replaced context.
    this.releaseUIEnabled = false;
    this.releaseUI.clear(Boolean(this.releaseContext(true)));
  };
  private disposed = false;
  private disposing?: Promise<void>;
  private uiContext: ExtensionContext;
  private reloadRequest?: { received: boolean };
  private pendingReload?: AbortController;
  private directionalCheckpoint?: DirectionalCheckpoint;
  private adoptionRecovery?: {
    pending: PendingAdoptionRecovery;
    review: { setupName: string; fingerprint: string };
    assertRoot(): void;
  };
  private recoveringDirectionalOwner = false;
  private readonly busy = new Set<string>();
  private initialized = false;
  private startupDebug = false;
  private debug = false;
  private participantIdentity = { id: randomUUID(), generation: randomUUID() };
  get id() {
    return this.participantIdentity.id;
  }
  get generation() {
    return this.participantIdentity.generation;
  }
  readonly root: string;
  private cleanupRequired = false;
  private recoveredOwner?: DaemonRecoveryTarget;
  private readonly rawRoot: string;
  private readonly gate: PiApplyGate;
  private readonly manager: ExtensionContext["sessionManager"];
  constructor(
    private readonly ctx: ExtensionContext,
    private readonly signal: AbortSignal,
    private readonly publish?: StartupTimingPublisher,
  ) {
    this.uiContext = ctx;
    this.manager = ctx.sessionManager;
    this.rawRoot = getAgentDir();
    const root = canonicalPath(path.resolve(this.rawRoot));
    if (!root) throw new Error("Agent directory is unavailable.");
    this.root = root;
    this.gate = new PiApplyGate(() => this.validate());
    this.signal.addEventListener("abort", this.stopReleaseUI, { once: true });
  }
  validate() {
    this.signal.throwIfAborted();
    if (this.disposed || this.closing || clients.get(this.manager) !== this)
      throw new Error("Synchronization session was replaced.");
    // Public context access verifies the SDK runner is still active after awaits.
    this.ctx.isIdle();
    if (getAgentDir() !== this.rawRoot || canonicalPath(path.resolve(this.rawRoot)) !== this.root)
      throw new Error("Agent directory changed; reload before synchronization.");
  }
  get debugEnabled() {
    return this.debug;
  }
  setDebugPreference(debug: boolean) {
    this.debug = debug && this.ctx.hasUI && (this.ctx.mode === "tui" || this.ctx.mode === "rpc");
  }
  recordDebug(event: DebugEvent) {
    if (!this.debug || this.protectionOnly || this.pendingReload || !this.ownsContactUI()) return;
    try {
      this.validate();
      appendDebugEvent(this.root, "pi-sync", event);
    } catch {}
  }
  private modelBinding(): ClientFacts["model"] {
    const model = this.ctx.model;
    if (!model) return undefined;
    const registry = this.ctx.modelRegistry;
    if (registry.getRegisteredProviderIds().includes(model.provider)) return undefined;
    const source = registry.getProviderAuthStatus(model.provider).source;
    if (
      source !== "stored" &&
      source !== "environment" &&
      source !== "models_json_key" &&
      source !== "models_json_command"
    )
      return undefined;
    return { provider: model.provider, id: model.id, signature: modelSignature(model), authSource: source };
  }
  private facts(protectionOnly = this.protectionOnly): ClientFacts {
    const manager = this.ctx.sessionManager;
    return {
      id: this.id,
      generation: this.generation,
      pid: process.pid,
      cwd: this.ctx.cwd,
      mode: this.ctx.mode,
      hasUI: !protectionOnly && this.ctx.hasUI,
      idle: !protectionOnly && !this.recoveringDirectionalOwner && !this.paused && !this.busy.size && this.ctx.isIdle(),
      ready: !protectionOnly && !this.recoveringDirectionalOwner && this.initialized,
      startupDebug: this.startupDebug,
      sessionFile: canonicalPath(manager.getSessionFile?.()),
      sessionId: manager.getSessionId?.(),
      sessionDir: canonicalPath(sessionDirFromContext(this.ctx)),
      model: protectionOnly ? undefined : this.modelBinding(),
    };
  }
  async configured(matches?: (settings: ReturnType<typeof validateSettingsDocument>) => boolean) {
    this.validate();
    await settingsQueue;
    this.validate();
    const document = await peekLocalConfigDocument();
    this.validate();
    const settings = document && validateSettingsDocument(document.parsed);
    return Boolean(settings?.activeSyncSetup && (matches?.(settings) ?? true));
  }
  async pauseForSessionChange() {
    this.validate();
    this.paused = true;
    this.stopReleaseUI();
    this.stopContactRepair(true);
    this.gate.cancelPending();
    this.pausing ??= (async () => {
      const connection = this.connection ?? this.partialConnection ?? (await this.connecting?.catch(() => undefined));
      if (connection) {
        await connection.pause();
        await this.gate.releaseAfterDrain();
      }
    })();
    return this.pausing;
  }
  async attachExisting({ allowUpgrade = false } = {}) {
    this.validate();
    this.assertNoDirectionalRecovery();
    if (!allowUpgrade && !this.paused && this.connection?.contactState === "active") return !this.protectionOnly;
    const address = await findDaemon(this.root).catch((error: unknown) => {
      this.recordDebug({ event: "connection", outcome: "failed" });
      throw error;
    });
    this.validate();
    this.assertNoDirectionalRecovery();
    if (!address) {
      this.recordDebug({ event: "connection", outcome: "skipped" });
      return false;
    }
    const upgrade = allowUpgrade && address.needsUpgrade && this.ctx.hasUI && ["tui", "rpc"].includes(this.ctx.mode);
    let upgradeFailure: string | undefined;
    if (upgrade) {
      try {
        await this.connect();
        this.validate();
        return true;
      } catch (error) {
        this.validate();
        if (this.paused || this.recoveringDirectionalOwner) throw error;
        upgradeFailure = safeTerminalText(errorMessage(error));
      }
    }
    try {
      // If upgrade failed, try only the original owner, with its protection-only facts.
      await this.connect(address);
    } catch (error) {
      this.validate();
      if (remoteErrorNamed(error, "DaemonStoppingError")) return false;
      throw error;
    } finally {
      if (upgradeFailure !== undefined) {
        this.validate();
        this.ctx.ui.notify(`pi-sync daemon upgrade failed: ${upgradeFailure}`, "error");
      }
    }
    this.validate();
    // Headless, shutdown, and failed-upgrade paths must not schedule transfers on an older build.
    return !this.protectionOnly;
  }
  async finishReattachment() {
    this.validate();
    const connection = this.connection;
    if (!connection) return;
    await recoverDetachedClients(connection);
    await this.queueFacts(async () => {
      this.validateFactsScope(connection);
      await connection.attach(this.signal);
      this.validateFactsScope(connection);
    });
  }
  private assertNoDirectionalRecovery() {
    if (this.recoveringDirectionalOwner)
      throw new Error("Pi Sync is recovering the daemon for a transfer. Retry after recovery finishes.");
  }
  async connect(existing?: Awaited<ReturnType<typeof ensureDaemon>>, requestSignal?: AbortSignal) {
    this.assertNoDirectionalRecovery();
    return this.attachConnection(existing, requestSignal);
  }
  private async attachConnection(existing?: Awaited<ReturnType<typeof ensureDaemon>>, requestSignal?: AbortSignal) {
    const startupSignal = requestSignal ? AbortSignal.any([this.signal, requestSignal]) : this.signal;
    const validateStartup = () => {
      this.validate();
      startupSignal.throwIfAborted();
    };
    validateStartup();
    if (this.connection) {
      if (!existing && this.protectionOnly)
        throw new Error(
          "This session is only protecting its files on an older Pi Sync daemon. Use /reload to upgrade.",
        );
      return this.connection;
    }
    this.connecting ??= (async () => {
      if (this.partialConnection) {
        // A failed unpublished attempt may already be retired or own queue grants.
        // Confirm drain before replacing its identity; failed cleanup must block retry.
        await this.partialConnection.dispose();
        // Finish acknowledged cleanup even if this new startup was cancelled meanwhile.
        await this.gate.releaseAfterDrain();
        validateStartup();
        this.partialConnection = undefined;
        this.participantIdentity = { id: randomUUID(), generation: randomUUID() };
      }
      // Only explicit setup/command paths or a configured interactive session call connect.
      if (!existing) await fs.mkdir(this.root, { recursive: true, mode: 0o700 });
      validateStartup();
      let retried = false;
      for (;;) {
        validateStartup();
        const daemon = existing ?? (await ensureDaemon(this.root, startupSignal));
        validateStartup();
        if (daemon.paths.root !== this.root) throw new Error("Daemon root changed before attach.");
        const protectionOnly = daemon.needsUpgrade === true;
        const connection = new DaemonConnection(daemon.paths, daemon.identity, this.facts(protectionOnly), {
          callback: (callback, signal) => this.callback(connection, callback, signal, protectionOnly),
          mergeReview:
            !protectionOnly && this.ctx.hasUI
              ? (callback, loadDetails, signal) => this.pagedMergeReview(connection, callback, loadDetails, signal)
              : undefined,
          event: (event) => {
            if (event.kind === "commit") return;
            if (this.signal.aborted || this.disposed || this.closing || clients.get(this.manager) !== this) return;
            const payload = event.payload as {
              message?: string;
              level?: "info" | "warning" | "error";
              report?: string;
              value?: string;
              presentation?: SyncStatusPresentation;
            };
            if (event.kind === "notify" && typeof payload?.message === "string")
              this.uiContext.ui.notify(safeTerminalText(payload.message), payload.level ?? "info");
            if (event.kind === "timings" && typeof payload?.report === "string") {
              this.publish?.(this.ctx, payload.report.split("\n").map(safeTerminalText).join("\n"));
            }
            if (event.kind === "status")
              setSyncStatus(
                this.uiContext,
                typeof payload?.value === "string" ? safeTerminalText(payload.value) : undefined,
                payload.presentation,
              );
          },
          contact: (state) => this.observeContact(connection, state),
          queueRelease: (event) => this.observeQueueRelease(connection, event),
          error: () => {
            if (
              !this.recoveringDirectionalOwner &&
              this.ownsContactUI() &&
              connection.facts.hasUI &&
              !this.releaseUI.retrying
            )
              this.showContactStatus("sync service unavailable", "blocked", true);
          },
        });
        this.partialConnection = connection;
        try {
          await connection.attach(startupSignal);
        } catch (error) {
          if (!(error instanceof DaemonError) || error.remote.name !== "DaemonStoppingError") throw error;
          // The final idle fence rejected publication, so this connection owns no queue grants.
          await connection.dispose().catch(() => {});
          this.partialConnection = undefined;
          validateStartup();
          if (existing || retried) throw error;
          retried = true;
          await waitForDaemonExit(daemon.identity, startupSignal);
          validateStartup();
          continue;
        }
        this.validate();
        await recoverDetachedClients(daemon);
        if (this.signal.aborted || this.disposed || this.closing) {
          await connection.dispose();
          this.validate();
        }
        this.validate();
        this.connection = connection;
        this.protectionOnly = protectionOnly;
        this.partialConnection = undefined;
        return connection;
      }
    })().then(
      (connection) => {
        this.recordDebug({ event: "connection", outcome: startupSignal.aborted ? "cancelled" : "completed" });
        return connection;
      },
      (error: unknown) => {
        this.connecting = undefined;
        const outcome = startupSignal.aborted
          ? "cancelled"
          : existing && remoteErrorNamed(error, "DaemonStoppingError")
            ? "skipped"
            : "failed";
        this.recordDebug({ event: "connection", outcome });
        throw error;
      },
    );
    const connection = await this.connecting;
    validateStartup();
    if (!existing && this.protectionOnly)
      throw new Error("This session is only protecting its files on an older Pi Sync daemon. Use /reload to upgrade.");
    return connection;
  }
  private ownsContactUI() {
    return (
      !this.signal.aborted && !this.disposed && !this.closing && !this.paused && clients.get(this.manager) === this
    );
  }
  private releaseContext(cleanup = false) {
    if (clients.get(this.manager) !== this) return;
    if (!cleanup && (!this.releaseUIEnabled || !this.ownsContactUI() || this.busy.has("shutdown"))) return;
    try {
      this.ctx.isIdle(); // Also verifies the SDK context has not been retired.
      if (this.ctx.hasUI && (this.ctx.mode === "tui" || this.ctx.mode === "rpc")) return this.ctx;
    } catch {
      // Detached cleanup can outlive its UI.
    }
  }
  disableQueueReleaseUI() {
    this.stopReleaseUI();
  }
  private observeQueueRelease(connection: DaemonConnection, event: QueueReleaseEvent) {
    if (connection !== this.connection || !connection.facts.hasUI || !this.releaseContext()) return;
    if (event.state === "retrying" && this.contactStatus?.unavailable) this.clearConnectionStatus();
    this.releaseUI.observe(event, this.busy.has("command"), !this.runSignal || this.runSignal.aborted);
  }
  private showContactStatus(text: string, activity: "retry" | "blocked", unavailable = false) {
    const previous = this.contactStatus;
    this.contactStatus = {
      clear: showSyncConnectionStatus(this.ctx, text, { activity, reason: activity === "retry" ? "temp" : "repair" }),
      unavailable,
    };
    previous?.clear();
  }
  private clearConnectionStatus(redraw = true) {
    const status = this.contactStatus;
    this.contactStatus = undefined;
    status?.clear(redraw);
  }
  private stopContactRepair(redraw: boolean) {
    this.contactRepair?.controller.abort(new DOMException("Pi session is changing", "AbortError"));
    this.clearConnectionStatus(redraw);
  }
  private observeContact(connection: DaemonConnection, state: ContactState) {
    if (connection !== this.connection || !this.ownsContactUI()) return;
    if (state === "active") {
      if (this.contactRepair || this.contactFactsUnpublished || connection.contactResumeState === "uncertain") return;
      this.clearRestoredContact();
    } else if (state === "expired" && connection.facts.hasUI && !this.contactAttempt && !this.contactRepair) {
      if (this.gate.size || connection.hasPendingWork || this.releaseUI.retrying) return;
      void this.resumeContact(connection).catch(() => {
        // The owning repair updates the status; a later command reports the error.
      });
    }
  }
  private clearRestoredContact() {
    this.contactAttempt = undefined;
    this.contactFactsUnpublished = false;
    this.clearConnectionStatus();
  }
  private queueFacts<T>(publish: () => Promise<T>): Promise<T> {
    const result = this.factsQueue.then(publish);
    this.factsQueue = result.then(
      () => {},
      () => {},
    );
    return result;
  }
  private async queueFactsWithAbortableWait<T>(signal: AbortSignal, publish: () => Promise<T>): Promise<T> {
    signal.throwIfAborted();
    const cancelled = Promise.withResolvers<never>();
    const abort = () => cancelled.reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    const queued = this.queueFacts(() => {
      signal.removeEventListener("abort", abort);
      signal.throwIfAborted();
      return publish();
    });
    return Promise.race([queued, cancelled.promise]);
  }
  private validateFactsScope(connection?: DaemonConnection, signal?: AbortSignal) {
    this.validate();
    signal?.throwIfAborted();
    if (this.paused) throw new Error("Pi Sync is paused for a session change.");
    if (connection && connection !== (this.connection ?? this.partialConnection))
      throw new Error("Synchronization session was replaced.");
  }
  private async resumeContact(connection: DaemonConnection) {
    this.validateFactsScope(connection);
    if (this.contactRepair) return this.contactRepair.done;
    const controller = new AbortController();
    const signal = AbortSignal.any([this.signal, controller.signal]);
    const done = this.queueFacts(async () => {
      this.validateFactsScope(connection, signal);
      if (connection.contactState === "active" && connection.contactResumeState !== "uncertain") return;
      if (this.gate.size || connection.hasPendingWork || connection.contactResumeState === "uncertain") {
        throw new Error(
          "Pi Sync cannot reconnect while previous work is still running or uncertain. Check sync recovery before retrying.",
        );
      }
      const earlier = this.contactAttempt;
      if (connection.contactState !== "expired" || earlier) {
        throw new Error("Pi Sync could not restore contact. Review pending work before using /reload.", {
          cause: earlier?.error,
        });
      }
      const attempt: { error?: unknown } = {};
      this.contactAttempt = attempt;
      try {
        this.showContactStatus("sync reconnecting", "retry");
        // Admission can wait behind an apply. Do not advertise readiness using
        // facts sampled before that wait; publish current facts after the ack.
        await connection.resumeContact({ ...this.facts(), idle: false, ready: false }, signal);
        this.validateFactsScope(connection, signal);
        this.contactFactsUnpublished = true;
        this.contactAttempt = undefined;
        await this.publishCurrentFacts(connection, signal);
        this.recordDebug({ event: "connection", outcome: "completed" });
      } catch (error) {
        this.recordDebug({ event: "connection", outcome: signal.aborted ? "cancelled" : "failed" });
        attempt.error = error;
        if (this.ownsContactUI() && !signal.aborted) {
          this.validateFactsScope(connection, signal);
          this.showContactStatus("sync reconnect blocked; check /sync daemon status", "blocked");
        }
        throw error;
      }
    }).finally(() => {
      if (this.contactRepair?.controller === controller) this.contactRepair = undefined;
    });
    this.contactRepair = { controller, done };
    return done;
  }
  private async publishCurrentFacts(connection: DaemonConnection, signal?: AbortSignal) {
    this.validateFactsScope(connection, signal);
    if (connection.contactResumeState === "uncertain")
      throw new Error("Pi Sync cannot verify the previous reconnect. Review pending work before using /reload.");
    await connection.update(this.facts());
    this.validateFactsScope(connection, signal);
    this.confirmContact(connection);
  }
  private async publishFacts(connection: DaemonConnection, signal?: AbortSignal) {
    if (this.contactRepair) await this.contactRepair.done;
    const publish = () => this.queueFacts(() => this.publishCurrentFacts(connection, signal));
    try {
      await publish();
    } catch (error) {
      this.validateFactsScope(connection, signal);
      if (!connection.facts.hasUI || !remoteErrorNamed(error, "ClientContactExpiredError")) throw error;
      await this.resumeContact(connection);
      // A shared repair might have started before these facts changed.
      await publish();
    }
  }
  private confirmContact(connection: DaemonConnection) {
    if (connection.contactState === "expired" || connection.contactState === "inactive")
      throw new Error("Pi Sync did not confirm active participation in the daemon.");
    this.clearRestoredContact();
  }
  async verifyConnection(signal?: AbortSignal) {
    const connection = await this.connect(undefined, signal);
    this.validateFactsScope(connection, signal);
    this.assertNoDirectionalRecovery();
    await this.publishFacts(connection, signal);
    this.validateFactsScope(connection, signal);
    this.assertNoDirectionalRecovery();
    return connection;
  }
  async readSettings(repair = false) {
    this.validate();
    if (!this.connection || this.paused) {
      const document = await peekLocalConfigDocument();
      this.validate();
      if (document && document.bytes.length > MAX_SETTINGS_BYTES)
        throw new Error("Settings exceed the local API byte limit; the source document is unchanged.");
      if (document && !repair) validateSettingsDocument(document.parsed);
      return document;
    }
    return decode(await this.run(repair ? "settings.repair-read" : "settings.read", {}));
  }
  canReportDirectionalResult() {
    try {
      this.validateFactsScope();
      return !this.pendingReload;
    } catch {
      return false;
    }
  }
  get ownershipCleanupRequired() {
    return this.cleanupRequired;
  }
  get pendingPullReview() {
    const recovery = this.adoptionRecovery;
    if (
      !this.cleanupRequired ||
      !recovery ||
      this.paused ||
      recovery.pending.owner !== this.connection ||
      !recovery.pending.owner.canRecoverForeground(recovery.pending.job)
    )
      return undefined;
    return recovery.review;
  }
  confirmRecoveryExit(owner: DaemonRecoveryTarget) {
    this.adoptionRecovery = undefined;
    this.cleanupRequired = true;
    this.recoveredOwner = owner;
  }
  recordOwnershipFailure(error: unknown) {
    if (
      (error instanceof DaemonError && error.remote.properties?.code === OWNERSHIP_CLEANUP_REQUIRED) ||
      (error instanceof Error &&
        (("code" in error && error.code === OWNERSHIP_CLEANUP_REQUIRED) ||
          error.message === "Daemon ownership cleanup is uncertain; stop and reconcile before restarting." ||
          error.message === "Daemon ownership cleanup is uncertain; stop and reconcile before retrying." ||
          error.message ===
            "File-queue release is uncertain; stop the daemon and keep grants quarantined until owner exit."))
    )
      this.cleanupRequired = true;
  }
  run(
    operation: string,
    payload: unknown,
    signal?: AbortSignal,
    ctx = this.ctx,
    onCommit?: () => void,
    reload?: AbortController,
    requirePendingAdoption = false,
  ) {
    const diagnostics = this.debug ? observeDebugJob(operation, (event) => this.recordDebug(event)) : undefined;
    const adoptionRecovery =
      operation === "pull.foreground" && this.pendingPullReview ? this.adoptionRecovery : undefined;
    const result = this.work
      .then(() => {
        if (requirePendingAdoption && !adoptionRecovery)
          throw new Error("The original Pull is no longer available for automatic recovery.");
        return this.runCurrent(operation, payload, signal, ctx, onCommit, reload, diagnostics, adoptionRecovery);
      })
      .catch((error: unknown) => {
        diagnostics?.rejected(error, Boolean(signal?.aborted || reload?.signal.aborted));
        this.recordOwnershipFailure(error);
        throw error;
      });
    this.work = result.then(
      () => {},
      () => {},
    );
    return result;
  }
  private async recoverDirectionalOwner(
    connection: DaemonConnection,
    job: string,
    signal: AbortSignal,
    assertRoot: () => void,
  ) {
    this.validateFactsScope(connection, signal);
    this.recoveringDirectionalOwner = true;
    try {
      this.stopContactRepair(true);
      await this.factsQueue;
      this.validateFactsScope(connection, signal);
      await connection.recoverForeground(job, signal);
      if (this.connection !== connection) throw new Error("The Pi participant changed during daemon recovery.");
      this.confirmRecoveryExit(connection.identity);
      await this.gate.releaseAfterDrain();
      this.connection = undefined;
      this.connecting = undefined;
      this.cleanupRequired = false;
      this.validateFactsScope(undefined, signal);
      assertRoot();
      const replacement = await ensureDaemon(this.root, signal, { compatibleOnly: true });
      this.validateFactsScope(undefined, signal);
      assertRoot();
      const attached = await this.attachConnection(replacement, signal);
      this.validateFactsScope(attached, signal);
      assertRoot();
      return attached;
    } finally {
      this.recoveringDirectionalOwner = false;
    }
  }
  private async runCurrent(
    operation: string,
    payload: unknown,
    signal?: AbortSignal,
    ctx = this.ctx,
    onCommit?: () => void,
    reload?: AbortController,
    diagnostics?: ReturnType<typeof observeDebugJob>,
    adoptionRecovery?: PiDaemonClient["adoptionRecovery"],
  ) {
    this.validate();
    if (adoptionRecovery && (this.adoptionRecovery !== adoptionRecovery || !this.pendingPullReview))
      throw new Error("The original Pull is no longer available for automatic recovery.");
    signal?.throwIfAborted();
    reload?.signal.throwIfAborted();
    if (this.pendingReload) throw new Error("Pi resources are about to reload.");
    if (this.paused && operation !== "shutdown")
      throw new Error("Synchronization is paused for a session change; if it was cancelled, use /reload to reattach.");
    const connection = await this.connect(undefined, signal);
    if (this.paused && operation === "shutdown") {
      Object.assign(connection.facts, { ...this.facts(), idle: false, ready: false });
      await connection.attach(signal ? AbortSignal.any([signal, this.signal]) : this.signal);
      this.validate();
    }
    this.validate();
    signal?.throwIfAborted();
    if (this.paused)
      await connection.update(this.facts()); // Existing, explicitly attached shutdown path.
    else await this.publishFacts(connection, signal);
    this.validate();
    signal?.throwIfAborted();
    this.uiContext = ctx;
    // The daemon directs reload only to the submitting client, and run() serializes its jobs.
    const request = reload ? { received: false } : undefined;
    this.reloadRequest = request;
    const runSignal = signal ? AbortSignal.any([signal, this.signal]) : this.signal;
    this.runSignal = runSignal;
    const clearForeground = () => this.releaseUI.finishForeground(Boolean(this.releaseContext()));
    runSignal.addEventListener("abort", clearForeground, { once: true });
    try {
      const root = isForegroundDirection(operation) ? lstatSync(this.root) : undefined;
      const assertRoot =
        adoptionRecovery?.assertRoot ??
        (() => {
          const current = lstatSync(this.root);
          if (!root || !current.isDirectory() || current.dev !== root.dev || current.ino !== root.ino)
            throw new Error("The agent directory changed during the transfer.");
        });
      const intent = root ? structuredClone(payload) : payload;
      const pull = operation === "pull.foreground" ? (intent as { setup: string; fingerprint: string }) : undefined;
      if (
        adoptionRecovery &&
        (!pull ||
          pull.setup !== adoptionRecovery.review.setupName ||
          pull.fingerprint !== adoptionRecovery.review.fingerprint)
      )
        throw new Error("The sync setup changed before Pull recovery.");
      if (adoptionRecovery) {
        assertRoot();
        const { createSettingsConfigView, syncCheckConfigFingerprint } = await import("../settings/config.js");
        this.validateFactsScope(connection, runSignal);
        const document = await peekLocalConfigDocument();
        this.validateFactsScope(connection, runSignal);
        const config = document && (await createSettingsConfigView(document).observe(undefined, runSignal));
        this.validateFactsScope(connection, runSignal);
        assertRoot();
        if (!config || syncCheckConfigFingerprint(config) !== adoptionRecovery.review.fingerprint)
          throw new Error("The sync setup changed before Pull recovery.");
      }
      const result = root
        ? await runDirectionalRecovery(
            connection,
            runSignal,
            async (checkpoint, retryCheckpoint, retryAdoptionJournal) => {
              const current = checkpoint.connection;
              this.validateFactsScope(current, runSignal);
              assertRoot();
              this.directionalCheckpoint = checkpoint;
              try {
                return await current.run(
                  operation,
                  retryAdoptionJournal !== undefined
                    ? { ...pull, retryAdoptionJournal }
                    : retryCheckpoint === undefined
                      ? intent
                      : { ...(intent as object), retryCheckpoint },
                  runSignal,
                  onCommit,
                  (id) => {
                    checkpoint.job = id;
                    diagnostics?.onSubmit(id);
                  },
                );
              } finally {
                this.directionalCheckpoint = undefined;
              }
            },
            (owner, job, recoverySignal) => this.recoverDirectionalOwner(owner, job, recoverySignal, assertRoot),
            () => {
              this.cleanupRequired = true;
            },
            pull && {
              pending: adoptionRecovery?.pending,
              retain: (pending) => {
                this.adoptionRecovery = pending && {
                  pending,
                  review: { setupName: pull.setup, fingerprint: pull.fingerprint },
                  assertRoot,
                };
              },
            },
          )
        : await connection.run(operation, payload, runSignal, onCommit, diagnostics?.onSubmit);
      if (runSignal.aborted || reload?.signal.aborted) diagnostics?.rejected(undefined, true);
      else diagnostics?.returned(result);
      if (request?.received && reload && !this.paused && !reload.signal.aborted && !signal?.aborted) {
        this.validate();
        this.pendingReload = reload;
        // Close the command's UI, not the session. Pi reload must run after this job and its UI drain.
        reload.abort(new DOMException("Pi resource reload requested", "AbortError"));
      }
      return result;
    } catch (error) {
      if (error instanceof DaemonError) {
        const prototype =
          error.name === "RemoteSelectionMismatchError"
            ? RemoteSelectionMismatchError.prototype
            : error.name === "SyncDecisionRequiredError"
              ? SyncDecisionRequiredError.prototype
              : undefined;
        if (prototype) {
          const restored = Object.create(prototype) as Error;
          Object.assign(restored, error.remote.properties, { name: error.name, message: error.message });
          throw restored;
        }
        Object.assign(error, error.remote.properties);
      }
      throw error;
    } finally {
      runSignal.removeEventListener("abort", clearForeground);
      clearForeground();
      this.runSignal = undefined;
      this.uiContext = this.ctx;
      this.reloadRequest = undefined;
    }
  }
  canReload(owner: AbortController) {
    if (this.pendingReload !== owner || this.paused) return false;
    this.validate();
    return true;
  }
  releaseReload(owner: AbortController) {
    if (this.pendingReload === owner) this.pendingReload = undefined;
  }
  async readStartupSettings(signal: AbortSignal) {
    this.validate();
    await settingsQueue;
    this.validate();
    signal.throwIfAborted();
    const document = await peekLocalConfigDocument();
    this.validate();
    signal.throwIfAborted();
    if (document && document.bytes.length > MAX_SETTINGS_BYTES)
      throw new Error("Settings exceed the local API byte limit; the source document is unchanged.");
    return { document, settings: document && validateSettingsDocument(document.parsed) };
  }
  tryStartupBootstrap(document: LocalConfigDocument, debug: boolean, signal: AbortSignal) {
    const ownedSignal = AbortSignal.any([signal, this.signal]);
    let retirement: Promise<void> | undefined;
    const operation = this.work.then(async () => {
      const verify = (connection?: DaemonConnection) => {
        this.validateFactsScope(connection, ownedSignal);
        if (this.pendingReload) throw new Error("Pi Sync is paused for a session change.");
      };
      verify();
      const connection = await this.connect(undefined, ownedSignal);
      return this.queueFacts(async () => {
        verify(connection);
        if (connection.contactState !== "active" || connection.contactResumeState !== "idle") return false;
        const settingsFingerprint = fingerprint(document);
        let mayHavePublished = true;
        try {
          const ready = await requestStartupBootstrap(connection, settingsFingerprint, debug, ownedSignal);
          mayHavePublished = ready;
          verify(connection);
          if (!ready) return false;
          if (connection.contactState === "active") this.confirmContact(connection);
          this.startupDebug = debug;
          this.initialized = true;
          Object.assign(connection.facts, { ready: true, startupDebug: debug });
          return true;
        } catch (error) {
          if (mayHavePublished) {
            retirement = this.dispose();
            void retirement.catch(() => {});
          }
          throw error;
        }
      });
    });
    this.work = operation.then(
      () => {},
      () => {},
    );
    return operation.catch(async (error: unknown) => {
      try {
        await retirement;
      } catch (cause) {
        throw new AggregateError(
          [error, cause],
          "Startup readiness is uncertain; reconcile the daemon before reconnecting.",
        );
      }
      throw error;
    });
  }
  async markReady(debug: boolean) {
    this.validate();
    this.startupDebug = debug;
    this.setDebugPreference(debug);
    this.initialized = true;
    await this.update();
    this.validate();
  }
  async setBusy(reason: string, busy: boolean, publish = true) {
    this.validate();
    if (busy) this.busy.add(reason);
    else if (this.busy.delete(reason) && reason === "command") {
      // Local command completion does not depend on publishing idle facts.
      this.releaseUI.flushWarnings();
    }
    if (publish) await this.update();
    this.validate();
  }
  async update() {
    if (this.connection && !this.recoveringDirectionalOwner && !this.paused && !this.disposed && !this.signal.aborted)
      await this.publishFacts(this.connection);
  }
  private async pagedMergeReview(
    connection: DaemonConnection,
    callback: Callback,
    loadDetails: (signal?: AbortSignal) => Promise<string>,
    signal: AbortSignal,
  ) {
    const ctx = this.uiContext;
    const generation = this.generation;
    const combined = AbortSignal.any([signal, this.signal]);
    const isCurrent = () =>
      !combined.aborted &&
      this.ownsContactUI() &&
      this.uiContext === ctx &&
      this.generation === generation &&
      (this.connection ?? this.partialConnection) === connection;
    if (!isCurrent()) return false;
    this.validate();
    if (!ctx.hasUI || !["tui", "rpc"].includes(ctx.mode)) throw new Error("This client cannot present safety reviews.");
    const { title, confirmationLabel, summaryLines } = callback.payload as {
      title: string;
      confirmationLabel?: string;
      summaryLines: readonly string[];
    };
    const { confirmMergeReview } = await import("../ui/merge-review.js");
    if (!isCurrent()) return false;
    this.validate();
    const result = await confirmMergeReview(
      ctx,
      title,
      loadDetails,
      combined,
      isCurrent,
      confirmationLabel,
      summaryLines,
    );
    if (!isCurrent()) return false;
    this.validate();
    return result;
  }
  private async callback(
    connection: DaemonConnection,
    callback: Callback,
    signal: AbortSignal,
    protectionOnly: boolean,
  ) {
    const payload = callback.payload as {
      reservation?: string;
      targets?: string[];
      generation?: string;
      title?: string;
      message?: string;
      content?: string;
      confirmationLabel?: string;
      summaryLines?: string[];
      items?: string[];
      helpText?: string;
      background?: boolean;
      fingerprint?: string;
      adoptionRecovery?: number;
    };
    if (callback.kind === "queue-release") {
      if (typeof payload?.reservation !== "string") throw new Error("Invalid queue release.");
      await this.gate.releaseRequest(payload.reservation);
      return true;
    }
    this.validate();
    signal.throwIfAborted();
    if (this.paused) throw new Error("Pi session is changing; no new work is authorized.");
    if (callback.kind === "directional-checkpoint") {
      this.validateFactsScope(connection, this.runSignal);
      if (protectionOnly || this.directionalCheckpoint?.accept(connection, callback.job, payload?.fingerprint) !== true)
        return false;
      return payload.adoptionRecovery === 1 ? { adoptionRecovery: 1 } : true;
    }
    if (callback.kind === "queue-acquire") {
      if (this.pendingReload) throw new Error("Pi resources are about to reload.");
      if (payload.background && !this.facts().idle) throw new Error("Pi is busy; background apply was not granted.");
      if (
        payload.generation !== this.generation ||
        typeof payload.reservation !== "string" ||
        !Array.isArray(payload.targets)
      )
        throw new Error("Stale file-queue request.");
      return this.gate.acquire(payload.reservation, payload.targets, AbortSignal.any([signal, this.signal]));
    }
    const ctx = this.uiContext;
    const combined = AbortSignal.any([signal, this.signal]);
    if (callback.kind === "model-binding") {
      if (protectionOnly) return null;
      return this.queueFactsWithAbortableWait(combined, async () => {
        this.validateFactsScope(connection, combined);
        let facts = this.facts();
        if (JSON.stringify(connection.facts.model) !== JSON.stringify(facts.model)) {
          await connection.update(facts);
          this.validateFactsScope(connection, combined);
          facts = this.facts();
        }
        return (payload.background && !facts.idle) ||
          JSON.stringify(connection.facts.model) !== JSON.stringify(facts.model)
          ? null
          : (facts.model ?? null);
      });
    }
    if (callback.kind === "reload") {
      if (!this.reloadRequest) throw new Error("No active Pi command can reload resources.");
      this.reloadRequest.received = true;
      return true;
    }
    if (!ctx.hasUI || !["tui", "rpc"].includes(ctx.mode)) throw new Error("This client cannot present safety reviews.");
    let result: unknown;
    if (callback.kind === "merge-review" && typeof payload.title === "string" && typeof payload.content === "string") {
      const { confirmMergeReview } = await import("../ui/merge-review.js");
      this.validate();
      combined.throwIfAborted();
      result = await confirmMergeReview(
        ctx,
        payload.title,
        payload.content,
        combined,
        () => !combined.aborted && !this.disposed,
        payload.confirmationLabel,
        payload.summaryLines,
      );
    } else if (
      callback.kind === "confirm" &&
      typeof payload.title === "string" &&
      typeof payload.message === "string"
    ) {
      result = await ctx.ui.confirm(safeTerminalText(payload.title), safeTerminalText(payload.message), {
        signal: combined,
      });
    } else if (
      callback.kind === "select" &&
      typeof payload.title === "string" &&
      Array.isArray(payload.items) &&
      payload.items.every((item) => typeof item === "string")
    ) {
      const labels = payload.items.map(safeTerminalText);
      if (new Set(labels).size !== labels.length) throw new Error("Daemon choices have ambiguous terminal labels.");
      const selected = await ctx.ui.select(safeTerminalText(payload.title), labels, { signal: combined });
      const index = selected === undefined ? -1 : labels.indexOf(selected);
      result = index < 0 ? undefined : payload.items[index];
    } else throw new Error("Unsupported daemon UI callback.");
    this.validate();
    combined.throwIfAborted();
    return result;
  }
  disposeForShutdown(reason: string | undefined, targetFile?: string) {
    const facts = this.connection?.facts ?? this.partialConnection?.facts;
    return this.dispose({
      kind: ["new", "resume", "fork", "reload"].includes(reason ?? "") ? "replace" : "exit",
      ...(targetFile !== undefined
        ? { file: canonicalPath(targetFile) }
        : reason === "reload"
          ? { file: facts?.sessionFile, sessionId: facts?.sessionId }
          : {}),
      cwd: facts?.cwd,
    });
  }
  async dispose(handoff?: ClientHandoff) {
    if (this.disposing) return this.disposing;
    this.closing = true;
    this.signal.removeEventListener("abort", this.stopReleaseUI);
    this.stopReleaseUI();
    this.stopContactRepair(false);
    this.disposing = (async () => {
      const connection = this.connection ?? this.partialConnection ?? (await this.connecting?.catch(() => undefined));
      let confirmed = false;
      try {
        await connection?.dispose(handoff);
        confirmed = Boolean(connection);
      } catch (error) {
        if (
          !connection ||
          connection.identity.root !== this.recoveredOwner?.root ||
          connection.identity.instance !== this.recoveredOwner.instance ||
          connection.identity.pid !== this.recoveredOwner.pid
        )
          throw error;
      } finally {
        this.disposed = true;
        if (clients.get(this.manager) === this) clients.delete(this.manager);
        const gate = this.gate;
        gate.detach();
        if (connection) {
          if (confirmed) await gate.releaseAfterDrain();
          else quarantineClient(gate, connection.paths.root, connection.identity, connection.facts);
        }
        await Promise.all([this.work, this.factsQueue]);
      }
    })();
    return this.disposing;
  }
}
