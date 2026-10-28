import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  queryUsage,
  type UsageChangedV1,
  type UsageClientResult,
  type UsageQueryRequestV1,
  type UsageQueryResultV1,
} from "./fixtures/usage-client.js";

function eventBus() {
  const listeners = new Map<string, Set<(data: unknown) => void>>();
  const events: ExtensionAPI["events"] = {
    on(channel, handler) {
      const handlers = listeners.get(channel) ?? new Set();
      handlers.add(handler);
      listeners.set(channel, handlers);
      return () => {
        handlers.delete(handler);
      };
    },
    emit(channel, data) {
      // Match Pi's synchronous, non-awaiting dispatch, not an async request/response bus.
      for (const handler of [...(listeners.get(channel) ?? [])]) handler(data);
    },
  };
  return {
    events,
    listeners,
    onQuery(handler: (request: UsageQueryRequestV1) => void) {
      return events.on("usage:query:v1", (data) => handler(data as UsageQueryRequestV1));
    },
  };
}

function context() {
  let sessionId = "session-a";
  const ctx = {
    sessionManager: { getSessionId: () => sessionId },
    model: { provider: "example", id: "model-a" },
  } as unknown as ExtensionContext;
  return { ctx, replaceSession: () => (sessionId = "session-b") };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function ready(): Extract<UsageQueryResultV1, { status: "ready" }> {
  return {
    status: "ready",
    providerId: "example",
    source: "cache",
    expiresAt: 10_000,
    report: {
      providerId: "example",
      providerName: "Example",
      capturedAt: 900,
      source: "provider-usage",
      semantics: { kind: "api-key", label: "Key limits" },
      accountLabel: "Account",
      buckets: [
        {
          id: "requests",
          label: "Requests",
          groupId: "group",
          groupLabel: "Group",
          modelKeys: ["model-a"],
          used: 0,
          remaining: 5,
          limit: 5,
          unit: "count",
          period: "daily",
          windowMinutes: 1440,
          resetsAt: 20_000,
        },
      ],
      metrics: [{ id: "spend", label: "Spend", value: 1, unit: "usd", currency: "USD" }],
      notes: ["Provider accounting can be delayed."],
    },
  };
}

function respondUnknown(request: UsageQueryRequestV1, value: unknown) {
  return request.respond(value as UsageQueryResultV1);
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000);
});

afterEach(() => {
  expect(vi.getTimerCount()).toBe(0);
  vi.useRealTimers();
});

test("an absent service returns no-service immediately without owning event subscriptions", async () => {
  const bus = eventBus();
  const { ctx } = context();
  expect(await queryUsage(bus, ctx)).toEqual({ status: "unavailable", providerId: "example", reason: "no-service" });
  ctx.model = undefined;
  expect(await queryUsage(bus, ctx)).toEqual({ status: "unavailable", reason: "no-service" });
  expect(bus.listeners.size).toBe(0);
});

test("a synchronous offer can contain an asynchronous result and uses the captured public scope", async () => {
  const bus = eventBus();
  const { ctx } = context();
  const pending = deferred<UsageQueryResultV1>();
  let request: UsageQueryRequestV1 | undefined;
  let accepted: boolean | undefined;
  bus.onQuery((value) => {
    request = value;
    accepted = value.respond(pending.promise);
  });
  const result = queryUsage(bus, ctx, { providerId: "example", refresh: true });
  expect(accepted).toBe(true);
  expect(request).toMatchObject({
    session: ctx.sessionManager,
    sessionId: "session-a",
    providerId: "example",
    refresh: true,
  });
  expect(request?.signal.aborted).toBe(false);
  const report = { ...ready(), source: "refresh" as const };
  pending.resolve(report);
  expect(await result).toEqual(report);
  expect(request?.signal.aborted).toBe(false);
  expect(bus.listeners.get("usage:query:v1")?.size).toBe(1);
});

test("an omitted provider remains omitted on the wire and refresh defaults to false", async () => {
  const bus = eventBus();
  const { ctx } = context();
  let request: UsageQueryRequestV1 | undefined;
  bus.onQuery((value) => {
    request = value;
    value.respond(ready());
  });
  expect((await queryUsage(bus, ctx)).status).toBe("ready");
  expect(request).not.toHaveProperty("providerId");
  expect(request?.refresh).toBe(false);
});

test("the offer window closes when emit returns, including before a handler's first await", async () => {
  const bus = eventBus();
  const { ctx } = context();
  let late: boolean | undefined;
  let signal: AbortSignal | undefined;
  bus.onQuery(async (request) => {
    signal = request.signal;
    await Promise.resolve();
    late = request.respond(Promise.reject(new Error("ignored late rejection")));
  });
  expect(await queryUsage(bus, ctx)).toMatchObject({ reason: "no-service" });
  expect(late).toBe(false);
  expect(signal?.aborted).toBe(true);
  await vi.runAllTimersAsync();
});

test("only the first offer wins and duplicate and late rejected promises are observed", async () => {
  const bus = eventBus();
  const { ctx } = context();
  const pending = deferred<UsageQueryResultV1>();
  const offers: boolean[] = [];
  let request: UsageQueryRequestV1 | undefined;
  bus.onQuery((value) => {
    request = value;
    offers.push(value.respond(pending.promise));
    offers.push(value.respond(Promise.reject(new Error("duplicate"))));
  });
  bus.onQuery((value) => offers.push(value.respond(ready())));
  const result = queryUsage(bus, ctx);
  offers.push(request?.respond(Promise.reject(new Error("late"))) ?? true);
  pending.resolve({ status: "unavailable", providerId: "example", reason: "cache-miss" });
  expect(await result).toMatchObject({ reason: "cache-miss" });
  expect(offers).toEqual([true, false, false, false]);
  await vi.runAllTimersAsync();
});

test("a malformed first offer cannot be replaced by a valid duplicate", async () => {
  const bus = eventBus();
  const { ctx } = context();
  const offers: boolean[] = [];
  bus.onQuery((request) => {
    offers.push(respondUnknown(request, null));
    offers.push(request.respond(ready()));
  });
  expect(await queryUsage(bus, ctx)).toMatchObject({ reason: "protocol-error" });
  expect(offers).toEqual([true, false]);
});

test.each(["rejection", "handler throw"])("unexpected %s becomes protocol-error", async (failure) => {
  const bus = eventBus();
  const { ctx } = context();
  let request: UsageQueryRequestV1 | undefined;
  bus.onQuery((value) => {
    request = value;
    if (failure === "handler throw") throw new Error("do not expose diagnostics");
    value.respond(Promise.reject(new Error("do not expose diagnostics")));
  });
  expect(await queryUsage(bus, ctx)).toEqual({
    status: "unavailable",
    providerId: "example",
    reason: "protocol-error",
  });
  expect(request?.signal.aborted).toBe(true);
});

const malformed: [string, unknown][] = [
  ["null result", null],
  ["array result", []],
  ["unknown status", { status: "future" }],
  ["unknown unavailable reason", { status: "unavailable", reason: "future" }],
  ["local reason from service", { status: "unavailable", reason: "no-service" }],
  ["optional message", { status: "unavailable", reason: "not-ready", message: 1 }],
  ["optional provider", { status: "unavailable", reason: "no-model", providerId: null }],
  ["wrong unavailable provider", { status: "unavailable", reason: "cache-miss", providerId: "other" }],
];

// Validate each declared field, not just the report's outer discriminator.
function malformedAt(path: string, value: unknown): [string, unknown] {
  const result = ready();
  const keys = path.split(".");
  let object = result as unknown as Record<string, unknown>;
  for (const key of keys.slice(0, -1)) object = object[key] as Record<string, unknown>;
  object[keys[keys.length - 1]] = value;
  return [path, result];
}

for (const path of [
  "providerId",
  "report.providerId",
  "report.providerName",
  "report.source",
  "report.semantics.label",
  "report.accountLabel",
  "report.buckets.0.id",
  "report.buckets.0.label",
  "report.buckets.0.groupId",
  "report.buckets.0.groupLabel",
  "report.buckets.0.period",
  "report.metrics.0.id",
  "report.metrics.0.label",
  "report.metrics.0.currency",
])
  malformed.push(malformedAt(path, 42));
for (const path of [
  "expiresAt",
  "report.capturedAt",
  "report.buckets.0.used",
  "report.buckets.0.remaining",
  "report.buckets.0.limit",
  "report.buckets.0.windowMinutes",
  "report.buckets.0.resetsAt",
  "report.metrics.0.value",
]) {
  for (const value of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, null]) {
    const [label, result] = malformedAt(path, value);
    malformed.push([`${label}=${value}`, result]);
  }
}
for (const [path, value] of [
  ["source", "future"],
  ["providerId", "other"],
  ["report.providerId", "other"],
  ["report.semantics", null],
  ["report.semantics.kind", "future"],
  ["report.buckets", {}],
  ["report.buckets", [null]],
  ["report.buckets", Array(1)],
  ["report.metrics", {}],
  ["report.metrics", [null]],
  ["report.buckets.0.unit", "tokens"],
  ["report.buckets.0.modelKeys", "model-a"],
  ["report.buckets.0.modelKeys", [1]],
  ["report.metrics.0.unit", "tokens"],
  ["report.metrics.0.value", false],
  ["report.notes", "note"],
  ["report.notes", [null]],
] as [string, unknown][])
  malformed.push(malformedAt(path, value));

describe("result validation", () => {
  test.each(malformed)("rejects %s", async (_label, value) => {
    const bus = eventBus();
    const { ctx } = context();
    bus.onQuery((request) => respondUnknown(request, value));
    expect(await queryUsage(bus, ctx)).toMatchObject({ reason: "protocol-error" });
  });

  test("rejects a missing required field and guards validation exceptions", async () => {
    const bus = eventBus();
    const { ctx } = context();
    const value = ready();
    Reflect.deleteProperty(value.report, "metrics");
    let response: unknown = value;
    bus.onQuery((request) => respondUnknown(request, response));
    expect(await queryUsage(bus, ctx)).toMatchObject({ reason: "protocol-error" });
    response = {
      get status() {
        throw new Error("untrusted getter");
      },
    };
    expect(await queryUsage(bus, ctx)).toMatchObject({ reason: "protocol-error" });
  });

  test("accepts unknown fields, optional omissions, unknown measurements, and string metrics", async () => {
    const bus = eventBus();
    const { ctx } = context();
    const value = ready();
    value.report.buckets = [{ id: "unknown", label: "Unknown", unit: "percent" }];
    value.report.metrics = [{ id: "plan", label: "Plan", value: "Pro" }];
    delete value.report.accountLabel;
    delete value.report.notes;
    Object.assign(value, { future: { arbitrary: true } });
    Object.assign(value.report.semantics, { future: true });
    bus.onQuery((request) => request.respond(value));
    expect(await queryUsage(bus, ctx)).toEqual(value);
    expect(value.report.buckets[0]).not.toHaveProperty("limit");
  });

  test.each(["consumer-subscription", "api-key", "project"] as const)(
    "accepts semantics %s and every unit",
    async (kind) => {
      const bus = eventBus();
      const { ctx } = context();
      const value = ready();
      value.report.semantics.kind = kind;
      value.report.buckets = ["percent", "usd", "currency", "count"].map((unit) => ({
        id: unit,
        label: unit,
        unit: unit as "percent" | "usd" | "currency" | "count",
      }));
      bus.onQuery((request) => request.respond(value));
      expect((await queryUsage(bus, ctx)).status).toBe("ready");
    },
  );

  test.each([
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
  ] as const)("preserves service reason %s", async (reason) => {
    const bus = eventBus();
    const { ctx } = context();
    const result = { status: "unavailable" as const, reason, providerId: "example", message: "Diagnostic" };
    bus.onQuery((request) => request.respond(result));
    expect(await queryUsage(bus, ctx)).toEqual(result);
  });

  test("no model may omit provider, but an explicit provider works without a model", async () => {
    const bus = eventBus();
    const { ctx } = context();
    ctx.model = undefined;
    const off = bus.onQuery((request) => request.respond({ status: "unavailable", reason: "no-model" }));
    expect(await queryUsage(bus, ctx)).toEqual({ status: "unavailable", reason: "no-model" });
    off();
    bus.onQuery((request) => request.respond(ready()));
    expect((await queryUsage(bus, ctx, { providerId: "example" })).status).toBe("ready");
  });

  test.each([false, true])("rejects the wrong satisfaction source for refresh=%s", async (refresh) => {
    const bus = eventBus();
    const { ctx } = context();
    bus.onQuery((request) => request.respond({ ...ready(), source: refresh ? "cache" : "refresh" }));
    expect(await queryUsage(bus, ctx, { refresh })).toMatchObject({ reason: "protocol-error" });
  });
});

function pendingQuery() {
  const bus = eventBus();
  const scope = context();
  const pending = deferred<UsageQueryResultV1>();
  let request!: UsageQueryRequestV1;
  bus.onQuery((value) => {
    request = value;
    value.respond(pending.promise);
  });
  return { bus, ...scope, pending, request: () => request };
}

test("pre-abort does not dispatch or install listeners or timers", async () => {
  const { bus, ctx } = pendingQuery();
  const caller = new AbortController();
  caller.abort();
  const emit = vi.spyOn(bus.events, "emit");
  const add = vi.spyOn(caller.signal, "addEventListener");
  expect(await queryUsage(bus, ctx, { signal: caller.signal })).toMatchObject({ reason: "cancelled" });
  expect(emit).not.toHaveBeenCalled();
  expect(add).not.toHaveBeenCalled();
});

test.each([undefined, 25])(
  "deadline %s stops waiting, aborts work, and removes the caller listener",
  async (timeoutMs) => {
    const fixture = pendingQuery();
    const caller = new AbortController();
    const add = vi.spyOn(caller.signal, "addEventListener");
    const remove = vi.spyOn(caller.signal, "removeEventListener");
    const result = queryUsage(fixture.bus, fixture.ctx, { signal: caller.signal, timeoutMs });
    const abort = vi.fn();
    fixture.request().signal.addEventListener("abort", abort, { once: true });
    await vi.advanceTimersByTimeAsync((timeoutMs ?? 15_000) - 1);
    expect(abort).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(await result).toMatchObject({ reason: "timeout" });
    expect(abort).toHaveBeenCalledTimes(1);
    expect(remove).toHaveBeenCalledWith("abort", add.mock.calls[0][1]);
    fixture.pending.reject(new Error("rejected after deadline"));
    caller.abort();
    await vi.runAllTimersAsync();
  },
);

test("caller cancellation stops waiting promptly and ignores late success", async () => {
  const fixture = pendingQuery();
  const caller = new AbortController();
  const remove = vi.spyOn(caller.signal, "removeEventListener");
  const result = queryUsage(fixture.bus, fixture.ctx, { signal: caller.signal });
  caller.abort();
  expect(fixture.request().signal.aborted).toBe(true);
  expect(await result).toMatchObject({ reason: "cancelled" });
  expect(remove).toHaveBeenCalledTimes(1);
  fixture.pending.resolve(ready());
  await vi.runAllTimersAsync();
});

test("cancellation during dispatch closes the offer window and observes rejected later offers", async () => {
  const bus = eventBus();
  const { ctx } = context();
  const caller = new AbortController();
  let accepted: boolean | undefined;
  let signal: AbortSignal | undefined;
  bus.onQuery((request) => {
    signal = request.signal;
    caller.abort();
    accepted = request.respond(Promise.reject(new Error("offered after cancellation")));
  });
  expect(await queryUsage(bus, ctx, { signal: caller.signal })).toMatchObject({ reason: "cancelled" });
  expect(accepted).toBe(false);
  expect(signal?.aborted).toBe(true);
  await vi.runAllTimersAsync();
});

test.each(["ready", "unavailable", "rejection", "no-service"])("cleans up on %s", async (outcome) => {
  const bus = eventBus();
  const { ctx } = context();
  const caller = new AbortController();
  const remove = vi.spyOn(caller.signal, "removeEventListener");
  if (outcome !== "no-service")
    bus.onQuery((request) => {
      if (outcome === "rejection") request.respond(Promise.reject(new Error("failure")));
      else request.respond(outcome === "ready" ? ready() : { status: "unavailable", reason: "not-ready" });
    });
  await queryUsage(bus, ctx, { signal: caller.signal });
  expect(remove).toHaveBeenCalledTimes(1);
  caller.abort();
});

test.each(["session-id", "session-manager", "model-id", "provider", "no-model"])(
  "rejects completion after %s replacement",
  async (change) => {
    const fixture = pendingQuery();
    const result = queryUsage(fixture.bus, fixture.ctx, { providerId: "example" });
    if (change === "session-id") fixture.replaceSession();
    else if (change === "session-manager") fixture.ctx.sessionManager = context().ctx.sessionManager;
    else if (change === "no-model") fixture.ctx.model = undefined;
    else
      fixture.ctx.model = {
        ...fixture.ctx.model,
        [change === "model-id" ? "id" : "provider"]: "replacement",
      } as ExtensionContext["model"];
    fixture.pending.resolve(ready());
    expect(await result).toMatchObject({ reason: "stale-context" });
    expect(fixture.request().signal.aborted).toBe(true);
  },
);

test("session replacement also takes precedence over a rejected accepted promise", async () => {
  const fixture = pendingQuery();
  const result = queryUsage(fixture.bus, fixture.ctx);
  fixture.replaceSession();
  fixture.pending.reject(new Error("obsolete request"));
  expect(await result).toMatchObject({ reason: "stale-context" });
  expect(fixture.request().signal.aborted).toBe(true);
});

test("a caller aborts a superseded request generation without cancelling its replacement", async () => {
  const bus = eventBus();
  const { ctx } = context();
  const first = deferred<UsageQueryResultV1>();
  const requests: UsageQueryRequestV1[] = [];
  bus.onQuery((request) => {
    requests.push(request);
    request.respond(requests.length === 1 ? first.promise : ready());
  });
  const owner = new AbortController();
  const old = queryUsage(bus, ctx, { signal: owner.signal });
  owner.abort();
  const next = queryUsage(bus, ctx);
  expect(await old).toMatchObject({ reason: "cancelled" });
  expect((await next).status).toBe("ready");
  first.resolve(ready());
  expect(requests.map((request) => request.signal.aborted)).toEqual([true, false]);
});

// Minimal caller policy used only in these tests. The request helper does not own a UI or view.
function consumerView(bus: ReturnType<typeof eventBus>, ctx: ExtensionContext) {
  const session = ctx.sessionManager;
  const sessionId = session.getSessionId();
  const providerId = ctx.model?.provider;
  let generation = 0;
  let disposed = false;
  let expiry: ReturnType<typeof setTimeout> | undefined;
  let active: AbortController | undefined;
  let value: UsageClientResult | undefined;
  const clear = () => {
    value = undefined;
    clearTimeout(expiry);
  };
  // Subscribe before the initial query. changedAt is deliberately not used as an ordering token.
  const off = bus.events.on("usage:changed:v1", (payload) => {
    const event = payload as UsageChangedV1;
    if (event.session !== session || event.sessionId !== sessionId || event.providerId !== providerId) return;
    generation += 1;
    clear();
  });
  return {
    value: () => value,
    async load() {
      while (!disposed) {
        const captured = generation;
        active = new AbortController();
        const result = await queryUsage(bus, ctx, { signal: active.signal });
        if (disposed) return;
        // A notification during the query makes even a valid response obsolete.
        if (captured !== generation) continue;
        clear();
        value = result;
        if (result.status === "ready") expiry = setTimeout(clear, result.expiresAt - Date.now());
        return;
      }
    },
    dispose() {
      disposed = true;
      generation += 1;
      active?.abort();
      off();
      clear();
    },
  };
}

test("subscription-before-query catches an update during dispatch and reads published cache after settlement", async () => {
  const bus = eventBus();
  const { ctx } = context();
  const old = deferred<UsageQueryResultV1>();
  let published = ready();
  const current = ready();
  current.report.metrics[0].value = 2;
  const requests: UsageQueryRequestV1[] = [];
  const observed: number[] = [];
  bus.events.on("usage:changed:v1", () => {
    observed.push(published.report.metrics[0].value as number);
  });
  bus.onQuery((request) => {
    requests.push(request);
    if (requests.length === 1) {
      request.respond(old.promise);
      published = current;
      bus.events.emit("usage:changed:v1", {
        session: ctx.sessionManager,
        sessionId: "session-a",
        providerId: "example",
        changedAt: 1_000,
        reason: "updated",
      } satisfies UsageChangedV1);
    } else request.respond(published);
  });
  const view = consumerView(bus, ctx);
  const load = view.load();
  expect(view.value()).toBeUndefined();
  expect(requests).toHaveLength(1); // Wait for settlement before another cache read.
  old.resolve(ready());
  await load;
  expect(observed).toEqual([2]);
  expect(view.value()).toEqual(current);
  expect(requests).toHaveLength(2);
  expect(requests.every((request) => request.refresh === false)).toBe(true);
  view.dispose();
  expect(bus.listeners.get("usage:changed:v1")?.size).toBe(1); // Unrelated subscription is retained.
});

test("consumer filters scope and provider, ignores timestamp order, and expires locally without events or refresh", async () => {
  const bus = eventBus();
  const { ctx } = context();
  let reads = 0;
  bus.onQuery((request) => {
    reads += 1;
    request.respond(ready());
  });
  const view = consumerView(bus, ctx);
  await view.load();
  const event: UsageChangedV1 = {
    session: ctx.sessionManager,
    sessionId: "session-a",
    providerId: "example",
    changedAt: 999_999,
    reason: "invalidated",
  };
  for (const replacement of [
    { session: context().ctx.sessionManager },
    { sessionId: "old-session" },
    { providerId: "other" },
  ]) {
    bus.events.emit("usage:changed:v1", { ...event, ...replacement });
  }
  expect(view.value()?.status).toBe("ready");
  await vi.advanceTimersByTimeAsync(8_999);
  expect(view.value()?.status).toBe("ready");
  await vi.advanceTimersByTimeAsync(1);
  expect(view.value()).toBeUndefined(); // No event is required at expiresAt.
  expect(reads).toBe(1);
  vi.setSystemTime(1_000);
  await view.load();
  bus.events.emit("usage:changed:v1", event);
  expect(view.value()).toBeUndefined();
  await view.load();
  bus.events.emit("usage:changed:v1", { ...event, changedAt: 0 });
  expect(view.value()).toBeUndefined(); // Observation timestamps are not sequence numbers.
  expect(reads).toBe(3); // Notifications never initiate refresh or polling.
  view.dispose();
  expect(bus.listeners.get("usage:changed:v1")?.size).toBe(0);
});

test("consumer disposal cancels pending work and prevents late view publication", async () => {
  const fixture = pendingQuery();
  const view = consumerView(fixture.bus, fixture.ctx);
  const load = view.load();
  view.dispose();
  view.dispose();
  await load;
  expect(fixture.request().signal.aborted).toBe(true);
  fixture.pending.resolve(ready());
  await vi.runAllTimersAsync();
  expect(view.value()).toBeUndefined();
  expect(fixture.bus.listeners.get("usage:changed:v1")?.size).toBe(0);
});

test("a valid report that expires while the offer is pending is not returned as fresh", async () => {
  const fixture = pendingQuery();
  const result = queryUsage(fixture.bus, fixture.ctx);
  await vi.advanceTimersByTimeAsync(9_000);
  fixture.pending.resolve(ready());
  expect(await result).toMatchObject({ reason: "cache-miss" });
});
