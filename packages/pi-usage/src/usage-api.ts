import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { usageAdapters } from "./query.js";
import type { UsageReport } from "./types.js";
import type {
  UsageApi,
  UsageApiCallbacks,
  UsageBucketV1,
  UsageCapabilitiesResultV1,
  UsageChangedV1,
  UsageMeasurementV1,
  UsageMetricV1,
  UsageQueryResultV1,
  UsageReportV1,
  UsageUnavailableReasonV1,
  UsageUnavailableV1,
  UsageUnitV1,
} from "./usage-api-types.js";

export type { UsageApi, UsageApiCallbacks, UsageQueryResultV1 } from "./usage-api-types.js";

const DEADLINE_MS = 15_000;
const supportedProviders = new Set(usageAdapters().map((adapter) => adapter.id));
// Potential normalized fields, not entitlement or the current auth mode. Native OpenAI can
// optionally use companion app/plan quota windows, but does not expose Codex credit balance.
const measurements: Readonly<Record<string, readonly UsageMeasurementV1[]>> = {
  baseten: ["spend"],
  openai: ["quota", "reset-time"],
  "openai-codex": ["quota", "balance", "reset-time"],
  deepseek: ["balance"],
  "github-copilot": ["quota", "reset-time"],
  openrouter: ["quota", "spend"],
  "vercel-ai-gateway": ["balance", "spend"],
  "command-code": ["quota", "balance", "spend", "reset-time"],
  fireworks: ["spend"],
  "opencode-go": ["quota", "reset-time"],
  "kimi-coding": ["quota", "balance", "spend", "reset-time"],
  minimax: ["quota", "balance", "reset-time"],
  "minimax-cn": ["quota", "balance", "reset-time"],
  moonshotai: ["balance"],
  "moonshotai-cn": ["balance"],
  zai: ["quota", "reset-time"],
  "zai-coding-cn": ["quota", "reset-time"],
  xai: ["quota", "balance", "spend", "reset-time"],
};
const reasons = new Set<UsageUnavailableReasonV1>([
  "not-ready",
  "no-model",
  "unsupported",
  "auth-unavailable",
  "selection-required",
  "cache-miss",
  "query-failed",
  "cancelled",
  "timeout",
  "stale-context",
]);

type ApiResult = UsageQueryResultV1 | UsageCapabilitiesResultV1;
type Task = { cancel(reason: UsageUnavailableReasonV1): void };
type SessionState = {
  ctx: ExtensionContext;
  session: ExtensionContext["sessionManager"];
  sessionId: string;
  generation: number;
  ready: boolean;
  model: string;
  policy: string;
  exposed: Set<string>;
  tasks: Set<Task>;
  refreshes: Map<string, Task>;
};
type Request = {
  session: unknown;
  sessionId: string;
  providerId?: string;
  refresh: boolean;
  signal: AbortSignal;
  respond(value: Promise<ApiResult>): boolean;
};

function validProvider(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._~-]{0,127}$/u.test(value);
}

function parseRequest(value: unknown, query: boolean): Request | undefined {
  try {
    if (!value || typeof value !== "object" || Array.isArray(value)) return;
    const input = value as Record<string, unknown>;
    // Capture all request fields once: the sender can mutate its payload after dispatch.
    const { session, sessionId, providerId, signal, respond } = input;
    const refresh = query ? input.refresh : undefined;
    if (
      typeof sessionId !== "string" ||
      (providerId !== undefined && !validProvider(providerId)) ||
      !(signal instanceof AbortSignal) ||
      typeof respond !== "function" ||
      (refresh !== undefined && typeof refresh !== "boolean")
    )
      return;
    return {
      session,
      sessionId,
      providerId,
      signal,
      refresh: refresh === true,
      respond: (result) => Reflect.apply(respond, value, [result]) === true,
    };
  } catch {
    // Accessors and proxies are not trusted protocol input.
    return;
  }
}

function modelSnapshot(ctx: ExtensionContext): string {
  // Include origin, custom headers, and every other model field, not only provider/id.
  return JSON.stringify(ctx.model) ?? "null";
}

function failure(reason: UsageUnavailableReasonV1, providerId?: string): UsageUnavailableV1 {
  return { status: "unavailable", ...(providerId === undefined ? {} : { providerId }), reason };
}

function ownershipError(reason: UsageUnavailableReasonV1): Error {
  const name = reason === "timeout" ? "TimeoutError" : reason === "cancelled" ? "AbortError" : "UsageStaleContextError";
  return Object.assign(new Error("Usage request is no longer current."), { name });
}

/** Register the public bus boundary. No credential resolution, timers, or queries run here. */
export function registerUsageApi(pi: Pick<ExtensionAPI, "events">, callbacks: UsageApiCallbacks): UsageApi {
  let active: SessionState | undefined;
  let generation = 0;
  let unsubscribers: Array<() => void> = [];

  function matches(state: SessionState, ctx: ExtensionContext): boolean {
    return ctx.sessionManager === state.session && ctx.sessionManager.getSessionId() === state.sessionId;
  }

  function emit(state: SessionState, providerId: string, reason: UsageChangedV1["reason"]): void {
    const event: UsageChangedV1 = {
      session: state.session,
      sessionId: state.sessionId,
      providerId,
      changedAt: Date.now(),
      reason,
    };
    pi.events.emit("usage:changed:v1", event);
  }

  function invalidate(state: SessionState): void {
    // Invalidate ownership and clear exposure before notifying reentrant subscribers.
    state.generation = ++generation;
    const exposed = [...state.exposed];
    state.exposed.clear();
    for (const task of [...state.tasks]) task.cancel("stale-context");
    for (const providerId of exposed) emit(state, providerId, "invalidated");
  }

  function observe(ctx: ExtensionContext): void {
    const state = active;
    if (!state || ctx.sessionManager !== state.session) return;
    if (!matches(state, ctx)) {
      state.ready = false;
      invalidate(state);
      return;
    }
    const model = modelSnapshot(ctx);
    const policy = callbacks.policyIdentity();
    state.ctx = ctx;
    if (state.model === model && state.policy === policy) return;
    state.model = model;
    state.policy = policy;
    invalidate(state);
  }

  function handle(value: unknown, query: boolean): void {
    const request = parseRequest(value, query);
    const state = active;
    if (!request || !state || request.session !== state.session || request.sessionId !== state.sessionId) return;
    try {
      if (state.session.getSessionId() !== state.sessionId) return;
      const ctx = state.ctx;
      const providerId = request.providerId ?? ctx.model?.provider;
      const capturedModel = modelSnapshot(ctx);
      const wasReady = state.ready;
      let resolve!: (value: ApiResult) => void;
      const pending = new Promise<ApiResult>((done) => {
        resolve = done;
      });
      let accepted = false;
      try {
        accepted = request.respond(pending);
      } catch {
        /* A throwing offer owns no work. */
      }
      if (!accepted) {
        resolve(failure("cancelled", providerId));
        return;
      }
      const deadlineAt = Date.now() + DEADLINE_MS;
      // Observe current local state only after acceptance. A rejected offer must not even
      // trigger policy reads or invalidation hints. Capture updated ownership before work.
      try {
        if (active === state) observe(state.ctx);
      } catch {
        resolve(failure("query-failed", providerId));
        return;
      }
      const capturedGeneration = state.generation;
      const capturedPolicy = state.policy;
      const controller = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      let settled = false;
      let endedReason: UsageUnavailableReasonV1 | undefined;
      const finish = (result: ApiResult) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        request.signal.removeEventListener("abort", onAbort);
        state.tasks.delete(task);
        if (providerId !== undefined && state.refreshes.get(providerId) === task) state.refreshes.delete(providerId);
        resolve(result);
      };
      const task: Task = {
        cancel(reason) {
          if (settled) return;
          endedReason = reason;
          finish(failure(reason, providerId));
          controller.abort();
        },
      };
      const onAbort = () => task.cancel("cancelled");
      const checkCurrent = () => {
        if (settled) throw ownershipError(endedReason ?? "stale-context");
        if (request.signal.aborted) task.cancel("cancelled");
        else if (Date.now() >= deadlineAt) task.cancel("timeout");
        else {
          if (active === state) observe(state.ctx);
          if (
            active !== state ||
            !matches(state, ctx) ||
            state.generation !== capturedGeneration ||
            modelSnapshot(ctx) !== capturedModel ||
            state.model !== capturedModel ||
            state.policy !== capturedPolicy
          )
            task.cancel("stale-context");
        }
        if (settled) throw ownershipError(endedReason ?? "stale-context");
      };
      state.tasks.add(task);
      request.signal.addEventListener("abort", onAbort, { once: true });
      if (request.signal.aborted) {
        task.cancel("cancelled");
        return;
      }
      timer = setTimeout(() => task.cancel("timeout"), Math.max(0, deadlineAt - Date.now()));
      const execute = async (): Promise<void> => {
        try {
          checkCurrent();
          if (!wasReady) return finish(failure("not-ready", providerId));
          if (providerId === undefined) return finish(failure("no-model"));
          const supported = supportedProviders.has(providerId);
          // Only registered providers can expose usage data. Unknown IDs must not create
          // unbounded session state or a notification burst on the next invalidation.
          if (supported) state.exposed.add(providerId);
          if (!query) {
            return finish({
              status: "ready",
              providerId,
              supported,
              measurements: supported ? [...(measurements[providerId] ?? [])] : [],
              supportsRefresh: supported,
            });
          }
          if (!supported) return finish(failure("unsupported", providerId));
          // Pi has no public network-free proof of effective auth overrides/custom headers.
          // Do not resolve auth, credential sources, or targets, even for an existing cache entry.
          if (!request.refresh) return finish(failure("cache-miss", providerId));
          state.refreshes.get(providerId)?.cancel("stale-context");
          state.refreshes.set(providerId, task);
          const result = await callbacks.refresh(ctx, providerId, controller.signal, deadlineAt, checkCurrent);
          checkCurrent();
          const response = copyRefreshResult(result, providerId);
          checkCurrent();
          finish(response);
        } catch (error) {
          if (settled) return;
          const name = error instanceof Error ? error.name : undefined;
          const reason =
            name === "UsageStaleContextError"
              ? "stale-context"
              : name === "TimeoutError"
                ? "timeout"
                : name === "AbortError"
                  ? "cancelled"
                  : "query-failed";
          task.cancel(reason);
        }
      };
      // The promise is offered before this function starts any owned work. This continuation
      // catches late backend rejection even after cancellation has settled the public result.
      void execute();
    } catch {
      // A malformed/stale context must not throw raw diagnostics through the event bus.
    }
  }

  function subscribe(): void {
    if (unsubscribers.length) return;
    unsubscribers = [
      pi.events.on("usage:query:v1", (value) => handle(value, true)),
      pi.events.on("usage:capabilities:v1", (value) => handle(value, false)),
    ];
  }
  subscribe();

  return {
    start(ctx) {
      if (active) {
        const previous = active;
        active = undefined;
        invalidate(previous);
      }
      active = {
        ctx,
        session: ctx.sessionManager,
        sessionId: ctx.sessionManager.getSessionId(),
        generation: ++generation,
        ready: false,
        model: modelSnapshot(ctx),
        policy: callbacks.policyIdentity(),
        exposed: new Set(),
        tasks: new Set(),
        refreshes: new Map(),
      };
      subscribe();
    },
    ready(ctx) {
      observe(ctx);
      if (active && matches(active, ctx)) active.ready = true;
    },
    observe,
    stop(ctx) {
      // A manager can replace its session before shutdown without delivering another start.
      // Release the old saved scope in that case; a different manager cannot stop this one.
      if (!active || ctx.sessionManager !== active.session) return;
      const previous = active;
      active = undefined;
      for (const unsubscribe of unsubscribers) unsubscribe();
      unsubscribers = [];
      invalidate(previous);
    },
    changed(providerId, reason) {
      const state = active;
      if (
        !state?.ready ||
        !validProvider(providerId) ||
        !["updated", "invalidated", "query-failed"].includes(reason) ||
        !matches(state, state.ctx)
      )
        return;
      // Cache publication/eviction is not refresh supersession. The runtime owns cache state;
      // cancelling here would abort a query on its own publication or native invalidation.
      emit(state, providerId, reason);
    },
  };
}

function text(value: unknown): string {
  if (typeof value !== "string") throw new Error("Invalid usage report string.");
  return value;
}
function finite(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error("Invalid usage report number.");
  return value;
}
function unit(value: unknown): UsageUnitV1 {
  if (!["percent", "usd", "currency", "count"].includes(text(value))) throw new Error("Invalid usage report unit.");
  return value as UsageUnitV1;
}
function strings(value: unknown): string[] {
  if (!Array.isArray(value)) throw new Error("Invalid usage report array.");
  return Array.from(value, text);
}

function copyReport(report: UsageReportV1, resetMultiplier: number): UsageReportV1 {
  const kind = report.semantics.kind;
  if (!["consumer-subscription", "api-key", "project"].includes(kind)) throw new Error("Invalid usage semantics.");
  if (!Array.isArray(report.buckets) || !Array.isArray(report.metrics)) throw new Error("Invalid usage arrays.");
  const result: UsageReportV1 = {
    providerId: text(report.providerId),
    providerName: text(report.providerName),
    capturedAt: finite(report.capturedAt),
    source: text(report.source),
    semantics: { kind, label: text(report.semantics.label) },
    buckets: Array.from(report.buckets, (item) => {
      const bucket: UsageBucketV1 = { id: text(item.id), label: text(item.label), unit: unit(item.unit) };
      for (const key of ["groupId", "groupLabel", "period"] as const) {
        if (item[key] !== undefined) bucket[key] = text(item[key]);
      }
      for (const key of ["used", "remaining", "limit", "windowMinutes"] as const) {
        if (item[key] !== undefined) bucket[key] = finite(item[key]);
      }
      if (item.resetsAt !== undefined) bucket.resetsAt = finite(finite(item.resetsAt) * resetMultiplier);
      if (item.modelKeys !== undefined) bucket.modelKeys = strings(item.modelKeys);
      return bucket;
    }),
    metrics: Array.from(report.metrics, (item) => {
      const metric: UsageMetricV1 = {
        id: text(item.id),
        label: text(item.label),
        value: typeof item.value === "string" ? item.value : finite(item.value),
      };
      if (item.unit !== undefined) metric.unit = unit(item.unit);
      if (item.currency !== undefined) metric.currency = text(item.currency);
      return metric;
    }),
  };
  if (!validProvider(result.providerId)) throw new Error("Invalid usage report provider.");
  if (report.accountLabel !== undefined) result.accountLabel = text(report.accountLabel);
  if (report.notes !== undefined) result.notes = strings(report.notes);
  return result;
}

/** Convert internal reset timestamps (seconds) to protocol milliseconds on a detached copy. */
export function copyUsageReportForApi(report: UsageReport): UsageReportV1 {
  return copyReport(report, 1_000);
}

function copyRefreshResult(result: UsageQueryResultV1, providerId: string): UsageQueryResultV1 {
  if (result.status === "unavailable") {
    if (!reasons.has(result.reason) || (result.providerId !== undefined && result.providerId !== providerId)) {
      return failure("query-failed", providerId);
    }
    // Callback diagnostics are deliberately not passed across the protocol boundary.
    return failure(result.reason, providerId);
  }
  if (
    result.status !== "ready" ||
    result.source !== "refresh" ||
    result.providerId !== providerId ||
    result.report.providerId !== providerId ||
    finite(result.expiresAt) <= Date.now()
  ) {
    return failure("query-failed", providerId);
  }
  return {
    status: "ready",
    providerId,
    source: "refresh",
    expiresAt: result.expiresAt,
    report: copyReport(result.report, 1),
  };
}
