import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
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
  type DocumentView,
  documentFingerprint,
  ensureDaemon,
  findDaemon,
  MAX_SETTINGS_BYTES,
  modelSignature,
  waitForDaemonExit,
} from "@narumitw/pi-sync-daemon";
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
import { type SyncStatusPresentation, setSyncStatus, showSyncConnectionStatus } from "../ui/sync-status.js";
import { safeTerminalText } from "../ui/terminal-text.js";
import { PiApplyGate } from "./apply-gate.js";
import { quarantineClient, recoverDetachedClients } from "./recovery.js";

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
  private closing = false;
  private paused = false;
  private pausing?: Promise<void>;
  private connecting?: Promise<DaemonConnection>;
  private contactRepair?: { controller: AbortController; done: Promise<void> };
  private contactAttempt?: { error?: unknown };
  private contactFactsUnpublished = false;
  private clearContactStatus?: (redraw?: boolean) => void;
  private disposed = false;
  private disposing?: Promise<void>;
  private uiContext: ExtensionContext;
  private reloadRequest?: { received: boolean };
  private pendingReload?: AbortController;
  private readonly busy = new Set<string>();
  private initialized = false;
  private startupDebug = false;
  private participantIdentity = { id: randomUUID(), generation: randomUUID() };
  get id() {
    return this.participantIdentity.id;
  }
  get generation() {
    return this.participantIdentity.generation;
  }
  readonly root: string;
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
      idle: !protectionOnly && !this.paused && !this.busy.size && this.ctx.isIdle(),
      ready: !protectionOnly && this.initialized,
      startupDebug: this.startupDebug,
      sessionFile: canonicalPath(manager.getSessionFile?.()),
      sessionId: manager.getSessionId?.(),
      sessionDir: canonicalPath(sessionDirFromContext(this.ctx)),
      model: protectionOnly ? undefined : this.modelBinding(),
    };
  }
  async configured() {
    this.validate();
    await settingsQueue;
    this.validate();
    const document = await peekLocalConfigDocument();
    this.validate();
    return Boolean(document && validateSettingsDocument(document.parsed).activeSyncSetup);
  }
  async pauseForSessionChange() {
    this.validate();
    this.paused = true;
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
    const address = await findDaemon(this.root);
    this.validate();
    if (!address) return false;
    const upgrade = allowUpgrade && address.needsUpgrade && this.ctx.hasUI && ["tui", "rpc"].includes(this.ctx.mode);
    let upgradeFailure: string | undefined;
    if (upgrade) {
      try {
        await this.connect();
        this.validate();
        return true;
      } catch (error) {
        this.validate();
        if (this.paused) throw error;
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
    if (this.connection) {
      await recoverDetachedClients({ paths: this.connection.paths, identity: this.connection.identity });
      this.validate();
      await this.connection.attach(this.signal);
      this.validate();
    }
  }
  async connect(existing?: Awaited<ReturnType<typeof ensureDaemon>>, requestSignal?: AbortSignal) {
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
          callback: (callback, signal) => this.callback(callback, signal, protectionOnly),
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
          error: () => {
            if (this.ownsContactUI()) this.showContactStatus("sync service unavailable", "blocked");
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
    })().catch((error) => {
      this.connecting = undefined;
      throw error;
    });
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
  private showContactStatus(text: string, activity: "retry" | "blocked") {
    const previous = this.clearContactStatus;
    this.clearContactStatus = showSyncConnectionStatus(this.ctx, text, {
      activity,
      reason: activity === "retry" ? "temp" : "repair",
    });
    previous?.();
  }
  private stopContactRepair(redraw: boolean) {
    this.contactRepair?.controller.abort(new DOMException("Pi session is changing", "AbortError"));
    this.clearContactStatus?.(redraw);
    this.clearContactStatus = undefined;
  }
  private observeContact(connection: DaemonConnection, state: ContactState) {
    if (connection !== this.connection || !this.ownsContactUI()) return;
    if (state === "active") {
      if (this.contactRepair || this.contactFactsUnpublished || connection.contactResumeState === "uncertain") return;
      this.clearRestoredContact();
    } else if (state === "expired" && connection.facts.hasUI && !this.contactAttempt && !this.contactRepair) {
      if (this.gate.size || connection.hasPendingWork) return;
      void this.resumeContact(connection).catch(() => {
        // The owning repair updates the status; a later command reports the error.
      });
    }
  }
  private clearRestoredContact() {
    this.contactAttempt = undefined;
    this.contactFactsUnpublished = false;
    this.clearContactStatus?.();
    this.clearContactStatus = undefined;
  }
  private async resumeContact(connection: DaemonConnection) {
    this.validate();
    if (this.paused || this.connection !== connection) throw new Error("Pi Sync is paused for a session change.");
    if (this.contactRepair) return this.contactRepair.done;
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
    const controller = new AbortController();
    const signal = AbortSignal.any([this.signal, controller.signal]);
    const attempt: { error?: unknown } = {};
    this.contactAttempt = attempt;
    const done = Promise.resolve().then(async () => {
      try {
        this.validate();
        signal.throwIfAborted();
        this.showContactStatus("sync reconnecting", "retry");
        // Admission can wait behind an apply. Do not advertise readiness using
        // facts sampled before that wait; publish current facts after the ack.
        await connection.resumeContact({ ...this.facts(), idle: false, ready: false }, signal);
        this.validate();
        signal.throwIfAborted();
        this.contactFactsUnpublished = true;
        this.contactAttempt = undefined;
        await connection.update(this.facts());
        this.validate();
        signal.throwIfAborted();
        this.confirmContact(connection);
      } catch (error) {
        attempt.error = error;
        if (this.ownsContactUI() && !signal.aborted)
          this.showContactStatus("sync reconnect blocked; check /sync daemon status", "blocked");
        throw error;
      } finally {
        if (this.contactRepair?.controller === controller) this.contactRepair = undefined;
      }
    });
    this.contactRepair = { controller, done };
    return done;
  }
  private async publishFacts(connection: DaemonConnection) {
    if (this.contactRepair) await this.contactRepair.done;
    this.validate();
    if (this.paused) throw new Error("Pi Sync is paused for a session change.");
    if (connection.contactResumeState === "uncertain")
      throw new Error("Pi Sync cannot verify the previous reconnect. Review pending work before using /reload.");
    try {
      await connection.update(this.facts());
    } catch (error) {
      if (!connection.facts.hasUI || !remoteErrorNamed(error, "ClientContactExpiredError")) throw error;
      await this.resumeContact(connection);
      this.validate();
      // A shared repair might have started before these facts changed.
      await connection.update(this.facts());
    }
    this.validate();
    this.confirmContact(connection);
  }
  private confirmContact(connection: DaemonConnection) {
    if (connection.contactState === "expired" || connection.contactState === "inactive")
      throw new Error("Pi Sync did not confirm active participation in the daemon.");
    this.clearRestoredContact();
  }
  async verifyConnection(signal?: AbortSignal) {
    const connection = await this.connect(undefined, signal);
    signal?.throwIfAborted();
    await this.publishFacts(connection);
    signal?.throwIfAborted();
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
  run(
    operation: string,
    payload: unknown,
    signal?: AbortSignal,
    ctx = this.ctx,
    onCommit?: () => void,
    reload?: AbortController,
  ) {
    const result = this.work.then(() => this.runCurrent(operation, payload, signal, ctx, onCommit, reload));
    this.work = result.then(
      () => {},
      () => {},
    );
    return result;
  }
  private async runCurrent(
    operation: string,
    payload: unknown,
    signal?: AbortSignal,
    ctx = this.ctx,
    onCommit?: () => void,
    reload?: AbortController,
  ) {
    this.validate();
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
    else await this.publishFacts(connection);
    this.validate();
    signal?.throwIfAborted();
    this.uiContext = ctx;
    // The daemon directs reload only to the submitting client, and run() serializes its jobs.
    const request = reload ? { received: false } : undefined;
    this.reloadRequest = request;
    try {
      const result = await connection.run(
        operation,
        payload,
        signal ? AbortSignal.any([signal, this.signal]) : this.signal,
        onCommit,
      );
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
  async markReady(debug: boolean) {
    this.validate();
    this.startupDebug = debug;
    this.initialized = true;
    await this.update();
    this.validate();
  }
  async setBusy(reason: string, busy: boolean, publish = true) {
    this.validate();
    if (busy) this.busy.add(reason);
    else this.busy.delete(reason);
    if (publish) await this.update();
    this.validate();
  }
  async update() {
    if (this.connection && !this.paused && !this.disposed && !this.signal.aborted)
      await this.publishFacts(this.connection);
  }
  private async callback(callback: Callback, signal: AbortSignal, protectionOnly: boolean) {
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
    };
    if (callback.kind === "queue-release") {
      if (typeof payload?.reservation !== "string") throw new Error("Invalid queue release.");
      await this.gate.releaseRequest(payload.reservation);
      return true;
    }
    this.validate();
    signal.throwIfAborted();
    if (this.paused) throw new Error("Pi session is changing; no new work is authorized.");
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
      const facts = this.facts();
      const connection = this.connection ?? this.partialConnection;
      if (connection && JSON.stringify(connection.facts.model) !== JSON.stringify(facts.model)) {
        await connection.update(facts);
        this.validate();
      }
      return payload.background && !facts.idle ? null : (facts.model ?? null);
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
    this.stopContactRepair(false);
    this.disposing = (async () => {
      const connection = this.connection ?? this.partialConnection ?? (await this.connecting?.catch(() => undefined));
      let confirmed = false;
      try {
        await connection?.dispose(handoff);
        confirmed = Boolean(connection);
      } finally {
        this.disposed = true;
        if (clients.get(this.manager) === this) clients.delete(this.manager);
        const gate = this.gate;
        gate.detach();
        if (connection) {
          if (confirmed) await gate.releaseAfterDrain();
          else quarantineClient(gate, connection.paths.root, connection.identity, connection.facts);
        }
        await this.work;
      }
    })();
    return this.disposing;
  }
}
