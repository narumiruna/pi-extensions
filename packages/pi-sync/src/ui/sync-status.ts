import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ContinuousErrorKind } from "../sync/continuous-errors.js";

const STATUS_KEY = "sync";

type SyncStatusContext = Pick<ExtensionContext, "hasUI" | "sessionManager" | "ui">;

export type SyncStatusPresentation =
  | {
      activity:
        | "idle"
        | "checking"
        | "working"
        | "pushing"
        | "pulling"
        | "resolving"
        | "local-change"
        | "remote-change"
        | "review";
      reason?: never;
    }
  | { activity: "retry" | "blocked"; reason: SyncStatusReason };

type SyncStatusReason =
  | "temp"
  | "busy"
  | "stale"
  | "auth"
  | "storage"
  | "review"
  | "model"
  | "limit"
  | "unknown"
  | "repair";

const failureReasons: Record<ContinuousErrorKind, SyncStatusReason> = {
  transient: "temp",
  contention: "busy",
  stale: "stale",
  authentication: "auth",
  storage: "storage",
  unsafe: "review",
  model: "model",
  budget: "limit",
  unknown: "unknown",
};

export function syncStatusFailureReason(kind: ContinuousErrorKind | undefined): SyncStatusReason {
  return typeof kind === "string" && Object.hasOwn(failureReasons, kind) ? failureReasons[kind] : "unknown";
}

const enabledBySession = new WeakMap<ExtensionContext["sessionManager"], boolean>();
const publishersBySession = new WeakMap<ExtensionContext["sessionManager"], StatusBinding>();
const statusesBySession = new WeakMap<ExtensionContext["sessionManager"], StatusValue>();
const connectionStatusBySession = new WeakMap<ExtensionContext["sessionManager"], StatusValue>();

interface StatusValue {
  value: string;
  presentation?: SyncStatusPresentation;
}

interface StatusBinding {
  update(value: string | undefined, presentation?: SyncStatusPresentation): void;
  release(): void;
}

function statusPresentation(presentation: SyncStatusPresentation | undefined): SyncStatusPresentation | undefined {
  if (!presentation) return;
  try {
    const { activity, reason } = presentation;
    if (activity === "retry" || activity === "blocked") {
      if (typeof reason === "string" && /^[a-z][a-z0-9-]{0,31}$/u.exec(reason)?.[0] === reason)
        return { activity, reason };
    } else if (
      [
        "idle",
        "checking",
        "working",
        "pushing",
        "pulling",
        "resolving",
        "local-change",
        "remote-change",
        "review",
      ].includes(activity) &&
      reason === undefined
    ) {
      return { activity };
    }
  } catch {
    // Invalid optional annotations withdraw metadata, not the readable status.
  }
  return undefined;
}

/** Optional extension-status v1 publisher; it owns no domain work or captured context. */
export function createSyncStatusPublisher(events: ExtensionAPI["events"] | undefined) {
  let active: { sessionManager: ExtensionContext["sessionManager"]; binding: StatusBinding } | undefined;
  let used = false;
  let activation = 0;
  const emit = (payload: object) => {
    try {
      events?.emit("extension-status:v1:update", payload);
    } catch {
      // Optional delivery must not interrupt sync, including on minimal test buses.
    }
  };
  const bind = (ctx: SyncStatusContext): (() => void) => {
    if (!ctx.hasUI || (!active && used) || (active && active.sessionManager !== ctx.sessionManager)) return () => {};
    const { sessionManager } = ctx;
    if (active) {
      return publishersBySession.get(sessionManager) === active.binding ? active.binding.release : () => {};
    }
    const owner = activation;
    // Reserve first use before foreign cleanup can reenter this factory.
    used = true;
    publishersBySession.get(sessionManager)?.release();
    if (activation !== owner || publishersBySession.has(sessionManager)) return () => {};
    let current: ({ value: string } & SyncStatusPresentation) | undefined;
    let revision = 0;
    let unsubscribe: (() => void) | undefined;
    const isCurrent = () => publishersBySession.get(sessionManager) === binding;
    const publish = (requestId?: object) => {
      emit({
        version: 1,
        sessionManager,
        key: STATUS_KEY,
        ...(current ?? { value: undefined }),
        ...(requestId === undefined ? {} : { requestId }),
      });
    };
    const binding: StatusBinding = {
      update(value, presentation) {
        if (!isCurrent()) return;
        const owner = ++revision;
        const safePresentation = statusPresentation(presentation);
        if (!isCurrent() || revision !== owner) return;
        current = value && safePresentation ? { value, ...safePresentation } : undefined;
        publish();
      },
      release() {
        const owned = isCurrent();
        revision++;
        if (owned) {
          publishersBySession.delete(sessionManager);
          statusesBySession.delete(sessionManager);
          connectionStatusBySession.delete(sessionManager);
          current = undefined;
        }
        // Retire before optional callbacks; withdrawal observers cannot revive first-use binding.
        if (active?.binding === binding) active = undefined;
        const stop = unsubscribe;
        unsubscribe = undefined;
        try {
          stop?.();
        } catch {
          // A failing optional unsubscribe cannot stop lifecycle cleanup.
        }
        if (owned && !publishersBySession.has(sessionManager)) publish();
      },
    };
    active = { sessionManager, binding };
    used = true;
    publishersBySession.set(sessionManager, binding);
    try {
      unsubscribe = events?.on("extension-status:v1:request", (payload) => {
        try {
          if (!isCurrent() || !payload || typeof payload !== "object" || Array.isArray(payload)) return;
          const {
            version,
            sessionManager: manager,
            requestId,
          } = payload as {
            version?: unknown;
            sessionManager?: unknown;
            requestId?: unknown;
          };
          if (
            !isCurrent() ||
            version !== 1 ||
            manager !== sessionManager ||
            !requestId ||
            typeof requestId !== "object"
          )
            return;
          publish(requestId);
        } catch {
          // Malformed requests and optional delivery cannot affect sync.
        }
      });
    } catch {
      // Raw status remains available when optional subscription fails.
    }
    return binding.release;
  };
  return {
    bind,
    start(ctx: SyncStatusContext) {
      const owner = ++activation;
      const { sessionManager } = ctx;
      const previous = publishersBySession.get(sessionManager);
      active?.binding.release();
      if (
        activation !== owner ||
        (publishersBySession.has(sessionManager) && publishersBySession.get(sessionManager) !== previous)
      )
        return () => {};
      // Only an explicit lifecycle start can reactivate a released publisher.
      used = false;
      const release = bind(ctx);
      used = true;
      // A superseded start must not receive the newer activation's cleanup capability.
      return activation === owner ? release : () => {};
    },
    cleanupFor(ctx: SyncStatusContext) {
      return active?.sessionManager === ctx.sessionManager ? active.binding.release : () => {};
    },
  };
}

export function configureSyncStatus(ctx: SyncStatusContext, enabled: boolean) {
  enabledBySession.set(ctx.sessionManager, enabled);
  if (!enabled) {
    statusesBySession.delete(ctx.sessionManager);
    connectionStatusBySession.delete(ctx.sessionManager);
    renderSyncStatus(ctx);
  }
}

function renderSyncStatus(ctx: SyncStatusContext) {
  if (!ctx.hasUI) return;
  const { sessionManager } = ctx;
  const status = statusesBySession.get(sessionManager);
  const connection = connectionStatusBySession.get(sessionManager);
  const current = status && status.presentation?.activity !== "idle" ? status : (connection ?? status);
  ctx.ui.setStatus(STATUS_KEY, current?.value);
  publishersBySession.get(sessionManager)?.update(current?.value, current?.presentation);
}

export function setSyncStatus(
  ctx: SyncStatusContext,
  value: string | undefined,
  presentation?: SyncStatusPresentation,
) {
  if (!ctx.hasUI || (value !== undefined && enabledBySession.get(ctx.sessionManager) === false)) return;
  const { sessionManager } = ctx;
  if (value === undefined) statusesBySession.delete(sessionManager);
  else {
    const status: StatusValue = { value };
    statusesBySession.set(sessionManager, status);
    status.presentation = statusPresentation(presentation);
    // An annotation getter can reenter publication or replace the session.
    if (statusesBySession.get(sessionManager) !== status) return;
  }
  renderSyncStatus(ctx);
}

/** Connection repair never clears or replaces a transfer or review status. */
export function showSyncConnectionStatus(ctx: SyncStatusContext, value: string, presentation: SyncStatusPresentation) {
  if (!ctx.hasUI || enabledBySession.get(ctx.sessionManager) === false) return (_redraw?: boolean) => {};
  const { sessionManager } = ctx;
  const status: StatusValue = { value };
  connectionStatusBySession.set(sessionManager, status);
  status.presentation = statusPresentation(presentation);
  if (connectionStatusBySession.get(sessionManager) === status) renderSyncStatus(ctx);
  return (redraw = true) => {
    if (connectionStatusBySession.get(sessionManager) !== status) return;
    connectionStatusBySession.delete(sessionManager);
    if (redraw) renderSyncStatus(ctx);
  };
}
