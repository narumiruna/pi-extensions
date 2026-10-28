import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMockPi } from "../../../test/support.js";
import { usageAdapters } from "../src/query.js";
import type { UsageReport } from "../src/types.js";
import { copyUsageReportForApi, registerUsageApi } from "../src/usage-api.js";
import type {
  UsageApiCallbacks,
  UsageCapabilitiesResultV1,
  UsageChangedV1,
  UsageQueryResultV1,
} from "../src/usage-api-types.js";

const QUERY = "usage:query:v1";
const CAPABILITIES = "usage:capabilities:v1";
const NOW = 1_800_000_000_000;

function context(id = "session-1") {
  let sessionId = id;
  const model = {
    id: "test-model",
    provider: "openai-codex",
    baseUrl: "https://chatgpt.com",
    headers: { "X-Test": "initial" },
  };
  const ctx = {
    sessionManager: { getSessionId: () => sessionId },
    model,
    ui: {},
    modelRegistry: new Proxy(
      {},
      {
        get: () => {
          throw new Error("Auth must not be resolved here.");
        },
      },
    ),
  } as unknown as ExtensionContext;
  return {
    ctx,
    model,
    setSessionId: (value: string) => {
      sessionId = value;
    },
  };
}

function report(): UsageReport {
  return {
    providerId: "openai-codex",
    providerName: "OpenAI Codex",
    capturedAt: NOW,
    source: "provider",
    semantics: { kind: "consumer-subscription", label: "Plan limits" },
    accountLabel: "Account",
    buckets: [
      {
        id: "daily",
        label: "Daily",
        groupId: "group",
        groupLabel: "Group",
        modelKeys: ["test"],
        used: 10,
        remaining: 90,
        limit: 100,
        unit: "percent",
        period: "daily",
        windowMinutes: 1440,
        resetsAt: NOW / 1000 + 3600,
      },
    ],
    metrics: [{ id: "credits", label: "Credits", value: 4, unit: "usd", currency: "USD" }],
    notes: ["Note"],
  };
}
function ready(providerId = "openai-codex"): UsageQueryResultV1 {
  return {
    status: "ready",
    providerId,
    source: "refresh",
    expiresAt: NOW + 60_000,
    report: copyUsageReportForApi({ ...report(), providerId }),
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}
function harness(refresh: UsageApiCallbacks["refresh"] = async (_ctx, providerId) => ready(providerId)) {
  const mock = createMockPi();
  const current = context();
  let policy = "policy-1";
  const callbacks = { refresh: vi.fn(refresh), policyIdentity: vi.fn(() => policy) };
  const api = registerUsageApi(mock.pi, callbacks);
  const notifications: UsageChangedV1[] = [];
  mock.eventBus.on("usage:changed:v1", (event) => {
    notifications.push(event as UsageChangedV1);
  });
  function request(channel = QUERY, overrides: Record<string, unknown> = {}) {
    const offered: Promise<UsageQueryResultV1 | UsageCapabilitiesResultV1>[] = [];
    const payload = {
      session: current.ctx.sessionManager,
      sessionId: current.ctx.sessionManager.getSessionId(),
      signal: new AbortController().signal,
      respond: (value: Promise<UsageQueryResultV1 | UsageCapabilitiesResultV1>) => {
        offered.push(value);
        return true;
      },
      ...overrides,
    };
    mock.eventBus.emit(channel, payload);
    return { payload, offered, result: offered[0] };
  }
  function start() {
    api.start(current.ctx);
    api.ready(current.ctx);
  }
  return {
    ...mock,
    ...current,
    callbacks,
    api,
    notifications,
    request,
    start,
    setPolicy: (value: string) => {
      policy = value;
    },
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("usage event adapter offers and validation", () => {
  it("registers listeners without session work and ignores requests until start", () => {
    const h = harness();
    expect(h.callbacks.policyIdentity).not.toHaveBeenCalled();
    expect(h.callbacks.refresh).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    expect(h.request().offered).toHaveLength(0);
  });

  it("offers a promise synchronously before refresh starts", async () => {
    const h = harness();
    h.start();
    let offered!: Promise<UsageQueryResultV1>;
    let inDispatch = true;
    h.eventBus.emit(QUERY, {
      session: h.ctx.sessionManager,
      sessionId: "session-1",
      refresh: true,
      signal: new AbortController().signal,
      respond(value: Promise<UsageQueryResultV1>) {
        expect(inDispatch).toBe(true);
        expect(h.callbacks.refresh).not.toHaveBeenCalled();
        offered = value;
        return true;
      },
    });
    inDispatch = false;
    expect(await offered).toEqual(ready());
    expect(h.callbacks.refresh).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([QUERY, CAPABILITIES])("returns not-ready while initializing on %s", async (channel) => {
    const h = harness();
    h.api.start(h.ctx);
    expect(await h.request(channel).result).toEqual({
      status: "unavailable",
      providerId: "openai-codex",
      reason: "not-ready",
    });
    expect(h.callbacks.refresh).not.toHaveBeenCalled();
    h.api.ready(h.ctx);
    expect((await h.request(CAPABILITIES).result)?.status).toBe("ready");
  });

  it.each([
    { providerId: "" },
    { providerId: "x".repeat(129) },
    { providerId: "openai\n" },
    { providerId: 7 },
    { signal: undefined },
    { signal: { aborted: false } },
    { respond: undefined },
    { sessionId: 7 },
    { refresh: "yes" },
    { refresh: null },
  ])("ignores malformed query fields %j", (fields) => {
    const h = harness();
    h.start();
    expect(h.request(QUERY, fields).offered).toHaveLength(0);
    expect(h.callbacks.refresh).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("safely ignores arbitrary payloads and throwing accessors", () => {
    const h = harness();
    h.start();
    for (const value of [
      undefined,
      null,
      [],
      "request",
      1,
      Object.defineProperty({}, "signal", {
        get() {
          throw new Error("secret");
        },
      }),
    ])
      expect(() => h.eventBus.emit(QUERY, value)).not.toThrow();
    expect(h.callbacks.refresh).not.toHaveBeenCalled();
  });

  it("requires exact manager and session ID even when UI is shared", () => {
    const h = harness();
    h.start();
    const foreign = context();
    foreign.ctx.ui = h.ctx.ui;
    expect(h.request(QUERY, { session: foreign.ctx.sessionManager }).offered).toHaveLength(0);
    expect(h.request(QUERY, { sessionId: "old-session" }).offered).toHaveLength(0);
    h.setSessionId("session-2");
    expect(h.request(QUERY, { sessionId: "session-1" }).offered).toHaveLength(0);
    expect(h.request().offered).toHaveLength(0);
    expect(h.callbacks.refresh).not.toHaveBeenCalled();
  });

  it.each([false, "throw"])("settles rejected offers with no owned work: %s", async (outcome) => {
    const h = harness();
    h.start();
    let pending!: Promise<UsageQueryResultV1>;
    const policyCalls = h.callbacks.policyIdentity.mock.calls.length;
    h.model.baseUrl = "https://changed.example";
    h.request(QUERY, {
      refresh: true,
      respond(value: Promise<UsageQueryResultV1>) {
        pending = value;
        if (outcome === "throw") throw new Error("secret");
        return false;
      },
    });
    expect(await pending).toMatchObject({ status: "unavailable", reason: "cancelled" });
    expect(h.callbacks.refresh).not.toHaveBeenCalled();
    expect(h.callbacks.policyIdentity).toHaveBeenCalledTimes(policyCalls);
    expect(h.notifications).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("captures provider, refresh, signal, and respond before sender mutation", async () => {
    const pending = deferred<UsageQueryResultV1>();
    const h = harness(async () => pending.promise);
    h.start();
    const original = new AbortController();
    const request = h.request(QUERY, { refresh: true, signal: original.signal });
    Object.assign(request.payload, {
      providerId: "deepseek",
      refresh: false,
      signal: new AbortController().signal,
      respond: () => {
        throw new Error("mutated");
      },
      sessionId: "other",
    });
    pending.resolve(ready());
    expect(await request.result).toEqual(ready());
    expect(h.callbacks.refresh.mock.calls[0]?.[1]).toBe("openai-codex");
  });
});

describe("usage potential capabilities and conservative cache reads", () => {
  const expected: Record<string, string[]> = {
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

  it("covers every registered adapter, including menu-only xAI", () => {
    expect(Object.keys(expected).sort()).toEqual(
      usageAdapters()
        .map((adapter) => adapter.id)
        .sort(),
    );
    expect(Object.keys(expected)).toHaveLength(18);
  });

  it.each(Object.entries(expected))(
    "reports potential fields and misses cache without auth/network: %s",
    async (providerId, fields) => {
      const fetch = vi.spyOn(globalThis, "fetch");
      const h = harness();
      h.start();
      expect(await h.request(CAPABILITIES, { providerId }).result).toEqual({
        status: "ready",
        providerId,
        supported: true,
        measurements: fields,
        supportsRefresh: true,
      });
      expect(await h.request(QUERY, { providerId }).result).toEqual({
        status: "unavailable",
        providerId,
        reason: "cache-miss",
      });
      expect(h.callbacks.refresh).not.toHaveBeenCalled();
      expect(fetch).not.toHaveBeenCalled();
      expect(h.entries).toEqual([]);
      expect(h.tools).toEqual([]);
      expect(h.sentMessages).toEqual([]);
      expect(h.notifications).toEqual([]);
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it("returns unknown capabilities and unsupported query, not a refresh", async () => {
    const h = harness();
    h.start();
    expect(await h.request(CAPABILITIES, { providerId: "custom-provider" }).result).toEqual({
      status: "ready",
      providerId: "custom-provider",
      supported: false,
      measurements: [],
      supportsRefresh: false,
    });
    expect(await h.request(QUERY, { providerId: "custom-provider", refresh: true }).result).toMatchObject({
      reason: "unsupported",
    });
    expect(h.callbacks.refresh).not.toHaveBeenCalled();
  });

  it.each([QUERY, CAPABILITIES])("returns no-model only when no provider was specified: %s", async (channel) => {
    const h = harness();
    h.ctx.model = undefined;
    h.start();
    expect(await h.request(channel).result).toEqual({ status: "unavailable", reason: "no-model" });
    expect(await h.request(channel, { providerId: "deepseek" }).result).not.toMatchObject({ reason: "no-model" });
  });

  it("accepts the repository's bounded provider identifier alphabet including tilde", async () => {
    const h = harness();
    h.start();
    expect(await h.request(CAPABILITIES, { providerId: "custom~provider" }).result).toMatchObject({
      status: "ready",
      providerId: "custom~provider",
      supported: false,
    });
  });

  it("detaches capability arrays and continues to miss after successful refresh", async () => {
    const h = harness();
    h.start();
    const first = await h.request(CAPABILITIES).result;
    if (first?.status === "ready" && "measurements" in first) first.measurements.length = 0;
    expect(await h.request(CAPABILITIES).result).toMatchObject({ measurements: expected["openai-codex"] });
    await h.request(QUERY, { refresh: true }).result;
    expect(await h.request().result).toMatchObject({ reason: "cache-miss" });
    expect(h.callbacks.refresh).toHaveBeenCalledOnce();
  });
});

describe("usage refresh cancellation and ownership", () => {
  it.each([QUERY, CAPABILITIES])("handles pre-aborted signals without refresh: %s", async (channel) => {
    const h = harness();
    h.start();
    const controller = new AbortController();
    controller.abort();
    expect(await h.request(channel, { refresh: true, signal: controller.signal }).result).toMatchObject({
      reason: "cancelled",
    });
    expect(h.callbacks.refresh).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("propagates abort, settles promptly, removes listener, and observes a late rejection", async () => {
    const backend = deferred<UsageQueryResultV1>();
    const h = harness(async () => backend.promise);
    h.start();
    const caller = new AbortController();
    const remove = vi.spyOn(caller.signal, "removeEventListener");
    const request = h.request(QUERY, { refresh: true, signal: caller.signal });
    const owned = h.callbacks.refresh.mock.calls[0]?.[2];
    caller.abort();
    expect(await request.result).toMatchObject({ reason: "cancelled" });
    expect(owned?.aborted).toBe(true);
    expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
    expect(vi.getTimerCount()).toBe(0);
    backend.reject(new Error("late secret"));
    await Promise.resolve();
    await Promise.resolve();
  });

  it("starts a 15-second total deadline at acceptance even for an uncooperative backend", async () => {
    const backend = deferred<UsageQueryResultV1>();
    const h = harness(async () => backend.promise);
    h.start();
    const request = h.request(QUERY, { refresh: true });
    expect(h.callbacks.refresh.mock.calls[0]?.[3]).toBe(NOW + 15_000);
    await vi.advanceTimersByTimeAsync(14_999);
    expect(h.callbacks.refresh.mock.calls[0]?.[2].aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await request.result).toMatchObject({ reason: "timeout" });
    expect(h.callbacks.refresh.mock.calls[0]?.[2].aborted).toBe(true);
    backend.resolve(ready());
    await Promise.resolve();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("checks elapsed deadline even before its timer gets a turn", async () => {
    const h = harness(async (_ctx, _provider, _signal, deadlineAt, checkCurrent) => {
      vi.setSystemTime(deadlineAt);
      checkCurrent();
      return ready();
    });
    h.start();
    expect(await h.request(QUERY, { refresh: true }).result).toMatchObject({ reason: "timeout" });
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    ["UsageStaleContextError", "stale-context"],
    ["AbortError", "cancelled"],
    ["TimeoutError", "timeout"],
    ["Error", "query-failed"],
  ])("maps %s to %s without raw diagnostics", async (name, reason) => {
    const h = harness(async () => {
      throw Object.assign(new Error("credential secret and raw body"), { name });
    });
    h.start();
    expect(await h.request(QUERY, { refresh: true }).result).toEqual({
      status: "unavailable",
      providerId: "openai-codex",
      reason,
    });
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["auth-unavailable", "selection-required", "unsupported", "query-failed"] as const)(
    "preserves typed %s without callback messages",
    async (reason) => {
      const h = harness(async () => ({ status: "unavailable", reason, message: "secret" }));
      h.start();
      expect(await h.request(QUERY, { refresh: true }).result).toEqual({
        status: "unavailable",
        providerId: "openai-codex",
        reason,
      });
    },
  );

  it("supersedes only a new API refresh for the same provider", async () => {
    const first = deferred<UsageQueryResultV1>();
    const h = harness(async (_ctx, providerId) => (providerId === "deepseek" ? ready(providerId) : first.promise));
    h.start();
    const one = h.request(QUERY, { refresh: true });
    const owned = h.callbacks.refresh.mock.calls[0]?.[2];
    await h.request().result;
    await h.request(CAPABILITIES).result;
    await h.request(QUERY, { providerId: "deepseek", refresh: true }).result;
    for (const reason of ["updated", "invalidated", "query-failed"] as const) h.api.changed("openai-codex", reason);
    expect(owned?.aborted).toBe(false);
    const two = h.request(QUERY, { refresh: true });
    expect(await one.result).toMatchObject({ reason: "stale-context" });
    expect(owned?.aborted).toBe(true);
    first.resolve(ready());
    expect(await two.result).toEqual(ready());
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["id", "provider", "baseUrl", "headers", "policy"])(
    "invalidates pending refresh after observed %s mutation",
    async (field) => {
      const backend = deferred<UsageQueryResultV1>();
      const h = harness(async () => backend.promise);
      h.start();
      const request = h.request(QUERY, { refresh: true });
      if (field === "policy") h.setPolicy("new-policy");
      else if (field === "headers") h.model.headers["X-Test"] = "rotated";
      else h.model[field as "id" | "provider" | "baseUrl"] = "changed";
      h.api.observe(h.ctx);
      expect(await request.result).toMatchObject({ reason: "stale-context" });
      expect(h.callbacks.refresh.mock.calls[0]?.[2].aborted).toBe(true);
      expect(h.notifications).toHaveLength(1);
      expect(h.notifications[0]).toMatchObject({ reason: "invalidated", providerId: "openai-codex" });
      backend.resolve(ready());
      await Promise.resolve();
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it.each(["policy", "model", "session"])("checks unobserved %s mutation through the backend guard", async (field) => {
    const backend = deferred<UsageQueryResultV1>();
    const h = harness(async () => backend.promise);
    h.start();
    const request = h.request(QUERY, { refresh: true });
    if (field === "policy") h.setPolicy("changed");
    else if (field === "model") h.model.headers["X-Test"] = "changed";
    else h.setSessionId("new-session");
    expect(() => h.callbacks.refresh.mock.calls[0]?.[4]()).toThrowError(
      expect.objectContaining({ name: "UsageStaleContextError" }),
    );
    expect(await request.result).toMatchObject({ reason: "stale-context" });
    backend.resolve(ready());
    await Promise.resolve();
  });

  it.each(["model", "policy"])(
    "accepts current state on a new request after an unobserved %s change",
    async (field) => {
      const h = harness();
      h.start();
      await h.request(CAPABILITIES).result;
      if (field === "model") h.model.headers["X-Test"] = "rotated";
      else h.setPolicy("new-policy");
      expect(await h.request(QUERY, { refresh: true }).result).toEqual(ready());
      expect(h.notifications).toHaveLength(1);
      expect(h.notifications[0]?.reason).toBe("invalidated");
      expect(h.callbacks.refresh).toHaveBeenCalledOnce();
    },
  );

  it("checks fresh lifecycle model snapshots rather than only the old context", async () => {
    const backend = deferred<UsageQueryResultV1>();
    const h = harness(async () => backend.promise);
    h.start();
    const request = h.request(QUERY, { refresh: true });
    const next = { ...h.ctx, model: { ...h.ctx.model, baseUrl: "https://other.example" } } as ExtensionContext;
    h.api.observe(next);
    expect(await request.result).toMatchObject({ reason: "stale-context" });
    backend.resolve(ready());
    await Promise.resolve();
  });

  it("detects a mutation after await even if the callback did not call its guard", async () => {
    const backend = deferred<UsageQueryResultV1>();
    const h = harness(async () => backend.promise);
    h.start();
    const request = h.request(QUERY, { refresh: true });
    h.model.baseUrl = "https://other.example";
    backend.resolve(ready());
    expect(await request.result).toMatchObject({ reason: "stale-context" });
  });
});

describe("usage lifecycle and invalidation hints", () => {
  it("uses the old scope on replacement and aborts pending work", async () => {
    const backend = deferred<UsageQueryResultV1>();
    const h = harness(async () => backend.promise);
    h.start();
    const request = h.request(QUERY, { refresh: true });
    h.setSessionId("session-2");
    h.api.start(h.ctx);
    expect(await request.result).toMatchObject({ reason: "stale-context" });
    expect(h.notifications).toEqual([
      {
        session: h.ctx.sessionManager,
        sessionId: "session-1",
        providerId: "openai-codex",
        changedAt: NOW,
        reason: "invalidated",
      },
    ]);
    expect(await h.request().result).toMatchObject({ reason: "not-ready" });
    h.api.ready(h.ctx);
    expect(await h.request().result).toMatchObject({ reason: "cache-miss" });
    backend.reject(new Error("late"));
    await Promise.resolve();
  });

  it("does not confuse managers sharing a no-op UI or let a foreign stop/ready affect the owner", async () => {
    const backend = deferred<UsageQueryResultV1>();
    const h = harness(async () => backend.promise);
    h.start();
    const other = context();
    other.ctx.ui = h.ctx.ui;
    const request = h.request(QUERY, { refresh: true });
    h.api.observe(other.ctx);
    h.api.stop(other.ctx);
    h.api.ready(other.ctx);
    expect(h.callbacks.refresh.mock.calls[0]?.[2].aborted).toBe(false);
    h.api.start(other.ctx);
    expect(await request.result).toMatchObject({ reason: "stale-context" });
    expect(h.request().offered).toHaveLength(0);
    const foreign = h.request(QUERY, { session: other.ctx.sessionManager });
    expect(await foreign.result).toMatchObject({ reason: "not-ready" });
    backend.resolve(ready());
    await Promise.resolve();
  });

  it("unsubscribes, invalidates state before events, aborts, and safely subscribes after shutdown", async () => {
    const backend = deferred<UsageQueryResultV1>();
    const h = harness(async () => backend.promise);
    h.start();
    const request = h.request(QUERY, { refresh: true });
    const offersDuringInvalidation: number[] = [];
    h.eventBus.on("usage:changed:v1", () => {
      offersDuringInvalidation.push(h.request().offered.length);
    });
    h.api.stop(h.ctx);
    h.api.stop(h.ctx);
    expect(await request.result).toMatchObject({ reason: "stale-context" });
    expect(offersDuringInvalidation).toEqual([0]);
    expect(h.request().offered).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
    h.start();
    h.api.ready(h.ctx);
    expect(h.request().offered).toHaveLength(1);
    h.api.changed("openai-codex", "updated");
    expect(h.notifications.at(-1)).toEqual({
      session: h.ctx.sessionManager,
      sessionId: "session-1",
      providerId: "openai-codex",
      changedAt: NOW,
      reason: "updated",
    });
    backend.resolve(ready());
    await Promise.resolve();
  });

  it("releases the saved scope on shutdown after a same-manager session ID change without start", async () => {
    const backend = deferred<UsageQueryResultV1>();
    const h = harness(async () => backend.promise);
    h.start();
    const request = h.request(QUERY, { refresh: true });
    h.setSessionId("session-2");
    h.api.stop(h.ctx);
    expect(await request.result).toMatchObject({ reason: "stale-context" });
    expect(h.callbacks.refresh.mock.calls[0]?.[2].aborted).toBe(true);
    expect(h.notifications).toEqual([
      {
        session: h.ctx.sessionManager,
        sessionId: "session-1",
        providerId: "openai-codex",
        changedAt: NOW,
        reason: "invalidated",
      },
    ]);
    expect(h.request().offered).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
    backend.reject(new Error("late"));
    await Promise.resolve();
    h.start();
    expect(await h.request().result).toMatchObject({ reason: "cache-miss" });
  });

  it("emits only documented fields and does not emit on reads", async () => {
    const h = harness();
    h.start();
    await h.request().result;
    await h.request(CAPABILITIES).result;
    expect(h.notifications).toEqual([]);
    for (const reason of ["updated", "invalidated", "query-failed"] as const) h.api.changed("openai-codex", reason);
    expect(h.notifications.map((event) => event.reason)).toEqual(["updated", "invalidated", "query-failed"]);
    for (const event of h.notifications)
      expect(Object.keys(event).sort()).toEqual(["changedAt", "providerId", "reason", "session", "sessionId"]);
    h.api.stop(h.ctx);
    h.api.changed("openai-codex", "updated");
    expect(h.notifications.at(-1)?.reason).toBe("invalidated");
  });

  it("publishes observed invalidation before reentrant requests and does not repeat exposure hints", async () => {
    const h = harness();
    h.start();
    await h.request(CAPABILITIES).result;
    let reentrant: Promise<UsageQueryResultV1 | UsageCapabilitiesResultV1> | undefined;
    h.eventBus.on("usage:changed:v1", () => {
      reentrant = h.request().result;
    });
    h.model.baseUrl = "https://changed.example";
    h.api.observe(h.ctx);
    expect(await reentrant).toMatchObject({ reason: "cache-miss" });
    expect(h.notifications).toHaveLength(1);
    h.api.observe(h.ctx);
    expect(h.notifications).toHaveLength(1);
  });
});

describe("usage report boundary", () => {
  it("converts bucket reset seconds to milliseconds and detaches every object/array", () => {
    const original = report();
    const copy = copyUsageReportForApi(original);
    expect(copy.buckets[0]?.resetsAt).toBe(NOW + 3_600_000);
    expect(copy.capturedAt).toBe(NOW);
    copy.semantics.label = "changed";
    copy.buckets[0]?.modelKeys?.push("other");
    if (copy.buckets[0]) copy.buckets[0].used = 99;
    if (copy.metrics[0]) copy.metrics[0].value = 999;
    copy.notes?.push("other");
    expect(original).toEqual(report());
  });

  it("detaches refresh results without converting reset timestamps twice or leaking extra fields", async () => {
    const result = ready();
    Object.assign(result, { fingerprint: "secret" });
    if (result.status === "ready") Object.assign(result.report, { credentials: "secret" });
    const h = harness(async () => result);
    h.start();
    const response = await h.request(QUERY, { refresh: true }).result;
    expect(response).toEqual(ready());
    if (response?.status === "ready" && "report" in response) {
      response.report.semantics.label = "changed";
      response.report.buckets[0]?.modelKeys?.push("changed");
    }
    expect(result).toMatchObject(ready());
  });

  it.each([NaN, Infinity, -Infinity])("rejects nonfinite internal report values: %s", (value) => {
    const original = report();
    original.capturedAt = value;
    expect(() => copyUsageReportForApi(original)).toThrow();
    original.capturedAt = NOW;
    if (original.buckets[0]) original.buckets[0].resetsAt = value;
    expect(() => copyUsageReportForApi(original)).toThrow();
  });

  it.each(["wrong-provider", "expired", "nonfinite", "cache-source", "malformed", "sparse"])(
    "returns typed failure for unsafe callback ready data: %s",
    async (variant) => {
      const result = ready();
      if (result.status !== "ready") throw new Error("fixture");
      if (variant === "wrong-provider") result.report.providerId = "deepseek";
      if (variant === "expired") result.expiresAt = NOW;
      if (variant === "nonfinite" && result.report.metrics[0]) result.report.metrics[0].value = NaN;
      if (variant === "cache-source") result.source = "cache";
      if (variant === "malformed") result.report.semantics = null as never;
      if (variant === "sparse") result.report.buckets = new Array(1);
      const h = harness(async () => result);
      h.start();
      expect(await h.request(QUERY, { refresh: true }).result).toEqual({
        status: "unavailable",
        providerId: "openai-codex",
        reason: "query-failed",
      });
      expect(vi.getTimerCount()).toBe(0);
    },
  );
});
