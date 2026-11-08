import assert from "node:assert/strict";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, test, vi } from "vitest";
import { readUsageReset } from "../src/usage-reset.js";

type Context = Pick<ExtensionContext, "sessionManager" | "model">;
type Request = {
  session: Context["sessionManager"];
  sessionId: string;
  providerId: string;
  refresh: boolean;
  signal: AbortSignal;
  respond(value: unknown): boolean;
};
type RecordValue = Record<string, unknown>;
const NOW = Date.parse("2026-11-08T00:00:00Z");
const RESET = NOW + 60_000;
const verifyCleanup: (() => void)[] = [];

function bucket(overrides: RecordValue = {}) {
  return {
    id: "opaque-constraint",
    label: "Allowance",
    modelKeys: ["selected-model"],
    used: 100,
    remaining: 0,
    limit: 100,
    unit: "percent",
    resetsAt: RESET,
    ...overrides,
  };
}

function ready(buckets: RecordValue[] = [bucket()]) {
  return {
    status: "ready",
    providerId: "test-provider",
    source: "refresh",
    expiresAt: NOW + 30_000,
    report: {
      providerId: "test-provider",
      providerName: "Test Provider",
      capturedAt: NOW,
      source: "public-test-service",
      semantics: { kind: "consumer-subscription", label: "Subscription" },
      buckets,
      metrics: [] as RecordValue[],
    },
  };
}

function fixture(handler?: (request: Request) => void) {
  let sessionId = "session-a";
  const ctx = {
    sessionManager: { getSessionId: () => sessionId },
    model: { provider: "test-provider", id: "selected-model", name: "Selected Model" },
  } as Context;
  const caller = new AbortController();
  const emit = vi.fn((channel: string, value: unknown) => {
    assert.equal(channel, "usage:query:v1");
    handler?.(value as Request);
  });
  const on = vi.fn();
  const pi: Pick<ExtensionAPI, "events"> = { events: { emit, on } };
  const add = vi.spyOn(caller.signal, "addEventListener");
  const remove = vi.spyOn(caller.signal, "removeEventListener");
  verifyCleanup.push(() => {
    assert.deepEqual(
      remove.mock.calls.map((call) => call.slice(0, 2)),
      add.mock.calls.map((call) => call.slice(0, 2)),
    );
    for (const [, value] of emit.mock.calls) assert.equal((value as Request).signal.aborted, true);
    assert.equal(on.mock.calls.length, 0);
  });
  return {
    ctx,
    pi,
    caller,
    emit,
    on,
    add,
    remove,
    changeSessionId: () => {
      sessionId = "session-b";
    },
    run: () => readUsageReset(pi, ctx, caller.signal),
  };
}

function deferred() {
  let resolve!: (value: unknown) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<unknown>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

afterEach(() => {
  for (const verify of verifyCleanup.splice(0)) verify();
  assert.equal(vi.getTimerCount(), 0, "request timers must be released");
  vi.restoreAllMocks();
  vi.useRealTimers();
});

test("requests a synchronous scoped refresh and returns an absolute millisecond hint", async () => {
  let request: Request | undefined;
  const f = fixture((value) => {
    request = value;
    assert.equal(value.respond(ready()), true);
  });
  assert.equal(await f.run(), RESET);
  assert.equal(request?.session, f.ctx.sessionManager);
  assert.equal(request?.sessionId, "session-a");
  assert.equal(request?.providerId, "test-provider");
  assert.equal(request?.refresh, true);
  assert.notEqual(request?.signal, f.caller.signal);
  assert.equal(request?.signal.aborted, true);
  assert.equal(f.on.mock.calls.length, 0, "no subscriptions");
  assert.equal(f.add.mock.calls.length, 1);
  assert.equal(f.remove.mock.calls.length, 1);
  assert.equal(f.add.mock.calls[0]?.[1], f.remove.mock.calls[0]?.[1]);
});

test("no service completes immediately, closes late offers, and aborts the request", async () => {
  let request: Request | undefined;
  const f = fixture((value) => {
    request = value;
  });
  assert.equal(await f.run(), undefined);
  assert.equal(request?.signal.aborted, true);
  assert.equal(request?.respond(Promise.reject(new Error("late offer"))), false);
  await Promise.resolve();
  assert.equal(f.remove.mock.calls.length, 1);
});

test("an offer after the first asynchronous boundary is too late", async () => {
  let accepted: boolean | undefined;
  const f = fixture((request) => {
    void Promise.resolve().then(() => {
      accepted = request.respond(Promise.reject(new Error("late asynchronous offer")));
    });
  });
  assert.equal(await f.run(), undefined);
  assert.equal(accepted, false);
});

test("only the first offer wins; rejected duplicate promises are observed", async () => {
  const accepted: boolean[] = [];
  const f = fixture((request) => {
    accepted.push(request.respond(Promise.resolve(ready())));
    accepted.push(request.respond(Promise.reject(new Error("duplicate"))));
    accepted.push(request.respond(ready([bucket({ resetsAt: RESET + 10_000 })])));
  });
  assert.equal(await f.run(), RESET);
  assert.deepEqual(accepted, [true, false, false]);
});

test("does not replace a failed first offer with a later valid offer", async () => {
  const f = fixture((request) => {
    assert.equal(request.respond(Promise.reject(new Error("first offer"))), true);
    assert.equal(request.respond(ready()), false);
  });
  assert.equal(await f.run(), undefined);
});

test.each([false, true])("unexpected dispatch throw after offer=%s is contained", async (offer) => {
  const f = fixture((request) => {
    if (offer) request.respond(Promise.reject(new Error("offered rejection")));
    throw new Error("dispatch failed");
  });
  assert.equal(await f.run(), undefined);
  assert.equal(f.remove.mock.calls.length, 1);
});

test("already aborted caller does not dispatch or allocate a listener", async () => {
  const f = fixture();
  f.caller.abort();
  assert.equal(await f.run(), undefined);
  assert.equal(f.emit.mock.calls.length, 0);
  assert.equal(f.add.mock.calls.length, 0);
});

test.each(["dispatch", "pending"] as const)("caller cancellation during %s releases work", async (phase) => {
  const pending = deferred();
  let request: Request | undefined;
  const f = fixture((value) => {
    request = value;
    value.respond(pending.promise);
    if (phase === "dispatch") f.caller.abort();
  });
  const result = f.run();
  if (phase === "pending") f.caller.abort();
  assert.equal(await result, undefined);
  assert.equal(request?.signal.aborted, true);
  assert.equal(f.remove.mock.calls.length, 1);
  pending.reject(new Error("late cancellation rejection"));
  await Promise.resolve();
});

test("the 15-second deadline aborts a never-settling service and ignores late completion", async () => {
  const pending = deferred();
  let request: Request | undefined;
  const f = fixture((value) => {
    request = value;
    value.respond(pending.promise);
  });
  let settled = false;
  const result = f.run().then((value) => {
    settled = true;
    return value;
  });
  await vi.advanceTimersByTimeAsync(14_999);
  assert.equal(settled, false);
  assert.equal(request?.signal.aborted, false);
  await vi.advanceTimersByTimeAsync(1);
  assert.equal(await result, undefined);
  assert.equal(request?.signal.aborted, true);
  assert.equal(f.remove.mock.calls.length, 1);
  pending.resolve(ready());
  await Promise.resolve();
});

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
  "future-unknown-reason",
])("unavailable %s returns no hint", async (reason) => {
  const f = fixture((request) => request.respond({ status: "unavailable", providerId: "test-provider", reason }));
  assert.equal(await f.run(), undefined);
});

test.each([
  "manager",
  "session-id",
  "model-object",
  "provider",
  "model-id",
  "model-name",
  "other-model-field",
  "no-model",
])("rejects stale %s after awaiting", async (change) => {
  const pending = deferred();
  const f = fixture((request) => request.respond(pending.promise));
  const result = f.run();
  switch (change) {
    case "manager":
      f.ctx.sessionManager = { getSessionId: () => "session-a" } as Context["sessionManager"];
      break;
    case "session-id":
      f.changeSessionId();
      break;
    case "model-object":
      if (f.ctx.model) f.ctx.model = { ...f.ctx.model };
      break;
    case "provider":
      if (f.ctx.model) f.ctx.model.provider = "other-provider";
      break;
    case "model-id":
      if (f.ctx.model) f.ctx.model.id = "other-model";
      break;
    case "model-name":
      if (f.ctx.model) f.ctx.model.name = "Other Model";
      break;
    case "other-model-field":
      Object.assign(f.ctx.model ?? {}, { contextWindow: 999 });
      break;
    case "no-model":
      f.ctx.model = undefined;
  }
  pending.resolve(ready());
  assert.equal(await result, undefined);
});

test("revalidates synchronous event reentry even for an immediate result", async () => {
  const f = fixture((request) => {
    request.respond(ready());
    f.changeSessionId();
  });
  assert.equal(await f.run(), undefined);
});

test.each(["missing-model", "empty-provider", "empty-id", "snapshot-throws", "session-throws"])(
  "invalid initial context %s does not dispatch",
  async (change) => {
    const f = fixture();
    if (change === "missing-model") f.ctx.model = undefined;
    if (change === "empty-provider" && f.ctx.model) f.ctx.model.provider = "";
    if (change === "empty-id" && f.ctx.model) f.ctx.model.id = "";
    if (change === "snapshot-throws")
      Object.assign(f.ctx.model ?? {}, {
        toJSON: () => {
          throw new Error("snapshot");
        },
      });
    if (change === "session-throws")
      f.ctx.sessionManager.getSessionId = () => {
        throw new Error("session");
      };
    assert.equal(await f.run(), undefined);
    assert.equal(f.emit.mock.calls.length, 0);
  },
);

test("contains context getter failures after await", async () => {
  const pending = deferred();
  const f = fixture((request) => request.respond(pending.promise));
  const result = f.run();
  f.ctx.sessionManager.getSessionId = () => {
    throw new Error("session unavailable");
  };
  pending.resolve(ready());
  assert.equal(await result, undefined);
});

test.each([null, [], undefined, "ready", {}, { status: "other" }, { status: "ready" }])(
  "malformed envelope %# returns no hint",
  async (value) => {
    assert.equal(await fixture((request) => request.respond(value)).run(), undefined);
  },
);

const invalidFields: [string, unknown][] = [
  ["providerId", "other-provider"],
  ["source", "cache"],
  ["source", "unknown"],
  ["expiresAt", Number.NaN],
  ["expiresAt", Number.POSITIVE_INFINITY],
  ["expiresAt", NOW],
  ["expiresAt", NOW - 1],
  ["expiresAt", "tomorrow"],
  ["report", null],
  ["report.providerId", "other-provider"],
  ["report.providerName", 12],
  ["report.capturedAt", Number.NaN],
  ["report.capturedAt", Number.NEGATIVE_INFINITY],
  ["report.capturedAt", NOW + 1],
  ["report.capturedAt", -1],
  ["report.capturedAt", NOW - 1],
  ["report.source", null],
  ["report.semantics", []],
  ["report.semantics.kind", "unknown"],
  ["report.semantics.kind", { toString: () => "consumer-subscription" }],
  ["report.semantics.label", false],
  ["report.accountLabel", 12],
  ["report.buckets", {}],
  ["report.buckets", [null]],
  ["report.metrics", null],
  ["report.metrics", [null]],
  ["report.notes", "not-an-array"],
  ["report.notes", [12]],
];

function fieldTarget(value: object, path: string) {
  const parts = path.split(".");
  let target = value as RecordValue;
  for (const key of parts.slice(0, -1)) target = target[key] as RecordValue;
  return { target, key: parts.at(-1) as string };
}

function setField(value: object, path: string, replacement: unknown) {
  const { target, key } = fieldTarget(value, path);
  target[key] = replacement;
}

test.each(invalidFields)("rejects invalid %s=%s", async (path, value) => {
  const result = ready();
  setField(result, path, value);
  assert.equal(await fixture((request) => request.respond(result)).run(), undefined);
});

test.each([
  "status",
  "providerId",
  "source",
  "expiresAt",
  "report.providerId",
  "report.providerName",
  "report.capturedAt",
  "report.source",
  "report.semantics",
  "report.semantics.kind",
  "report.semantics.label",
  "report.buckets",
  "report.metrics",
])("requires public field %s", async (path) => {
  const result = ready();
  setField(result, path, undefined);
  assert.equal(await fixture((request) => request.respond(result)).run(), undefined);
});

test.each([
  ["id", undefined],
  ["label", undefined],
  ["unit", undefined],
  ["unit", "tokens"],
  ["unit", { toString: () => "percent" }],
  ["groupId", 1],
  ["groupLabel", false],
  ["modelKeys", "selected-model"],
  ["modelKeys", [42]],
  ["used", Number.NaN],
  ["remaining", Number.POSITIVE_INFINITY],
  ["limit", Number.NEGATIVE_INFINITY],
  ["period", 1],
  ["windowMinutes", Number.NaN],
  ["windowMinutes", 0],
  ["resetsAt", Number.NaN],
  ["resetsAt", "soon"],
] as [string, unknown][])("validates every bucket field: %s=%s", async (field, value) => {
  assert.equal(await fixture((request) => request.respond(ready([bucket({ [field]: value })]))).run(), undefined);
});

test.each([
  { id: 1, label: "Metric", value: 1 },
  { id: "metric", value: 1 },
  { id: "metric", label: "Metric" },
  { id: "metric", label: "Metric", value: Number.NaN },
  { id: "metric", label: "Metric", value: Number.POSITIVE_INFINITY },
  { id: "metric", label: "Metric", value: {} },
  { id: "metric", label: "Metric", value: 1, unit: "tokens" },
  { id: "metric", label: "Metric", value: 1, currency: 12 },
])("validates complete metrics %# even when buckets have a usable reset", async (metric) => {
  const result = ready();
  result.report.metrics = [metric];
  assert.equal(await fixture((request) => request.respond(result)).run(), undefined);
});

test.each(["consumer-subscription", "api-key", "project"])(
  "accepts valid %s semantics without provider policy",
  async (kind) => {
    const result = ready();
    result.report.semantics.kind = kind;
    Object.assign(result.report, { accountLabel: "Account", notes: ["Note"], futureField: true });
    Object.assign(result, { futureField: { allowed: true } });
    result.report.metrics = [
      { id: "m1", label: "Balance", value: 10, unit: "usd", currency: "USD" },
      { id: "m2", label: "State", value: "known" },
    ];
    assert.equal(await fixture((request) => request.respond(result)).run(), RESET);
  },
);

test.each(["percent", "usd", "currency", "count"])("accepts finite exhausted %s quantities", async (unit) => {
  assert.equal(await fixture((request) => request.respond(ready([bucket({ unit })]))).run(), RESET);
});

test.each([
  { used: undefined, limit: undefined, remaining: 0 },
  { used: undefined, limit: undefined, remaining: -5 },
  { used: 100, limit: 100, remaining: undefined },
  { used: 101, limit: 100, remaining: undefined },
])("accepts explicit finite exhaustion %#", async (measurements) => {
  assert.equal(await fixture((request) => request.respond(ready([bucket(measurements)]))).run(), RESET);
});

test.each([
  { used: undefined, limit: undefined, remaining: undefined },
  { used: 100, limit: undefined, remaining: undefined },
  { used: undefined, limit: 100, remaining: undefined },
  { used: -1 },
  { limit: 0 },
  { limit: -1 },
  { used: 99, remaining: 0 },
  { used: 100, remaining: 1 },
])("unknown or contradictory applicable measurements %# require fallback", async (measurements) => {
  assert.equal(await fixture((request) => request.respond(ready([bucket(measurements)]))).run(), undefined);
});

test.each(
  [undefined, [], ["other-model"], ["Selected"], ["SELECTED-MODEL"], ["selected-model-extra"]].map((modelKeys) => ({
    modelKeys,
  })),
)("unproven model scope $modelKeys does not produce a hint", async ({ modelKeys }) => {
  assert.equal(await fixture((request) => request.respond(ready([bucket({ modelKeys })]))).run(), undefined);
});

test.each(
  [["selected-model"], ["Selected Model"], ["other-model", "selected-model"]].map((modelKeys) => ({ modelKeys })),
)("exact public model key $modelKeys proves applicability", async ({ modelKeys }) => {
  assert.equal(await fixture((request) => request.respond(ready([bucket({ modelKeys })]))).run(), RESET);
});

test("cannot prove base/all-model scope from omitted keys, labels, groups, or period", async () => {
  const base = bucket({
    modelKeys: undefined,
    id: "all-models",
    label: "All models",
    groupId: "base",
    period: "weekly",
  });
  assert.equal(await fixture((request) => request.respond(ready([bucket(), base]))).run(), undefined);
});

test("chooses latest reset across every applicable exhausted window, independent of order/group", async () => {
  const buckets = [
    bucket({ id: "window-a", resetsAt: RESET + 500_000, groupId: "a", windowMinutes: 10 }),
    bucket({ id: "window-b", resetsAt: RESET, groupId: "b", windowMinutes: 60 }),
    bucket({ id: "window-c", resetsAt: RESET + 100_000, groupId: "a", windowMinutes: 20 }),
  ];
  assert.equal(await fixture((request) => request.respond(ready(buckets))).run(), RESET + 500_000);
  assert.equal(await fixture((request) => request.respond(ready([...buckets].reverse()))).run(), RESET + 500_000);
});

test.each([undefined, NOW - 1, NOW, 1_800_000_000, Number.POSITIVE_INFINITY, 9e15])(
  "one unusable blocking reset %s invalidates every otherwise valid hint",
  async (resetsAt) => {
    const buckets = [bucket(), bucket({ id: "other-constraint", resetsAt })];
    assert.equal(await fixture((request) => request.respond(ready(buckets))).run(), undefined);
  },
);

test("expiresAt is never a reset; reports without a blocking reset fall back", async () => {
  const result = ready([bucket({ resetsAt: undefined })]);
  result.expiresAt = RESET + 999_000;
  assert.equal(await fixture((request) => request.respond(result)).run(), undefined);
});

test("known nonblocking windows need no reset and disjoint model windows do not block", async () => {
  const result = ready([
    bucket(),
    bucket({ id: "available", used: 20, remaining: 80, resetsAt: undefined }),
    bucket({
      id: "other-model",
      modelKeys: ["other-model"],
      used: undefined,
      remaining: undefined,
      limit: undefined,
      resetsAt: undefined,
    }),
  ]);
  assert.equal(await fixture((request) => request.respond(result)).run(), RESET);
});

test.each([[], [bucket({ used: 20, remaining: 80 })]].map((buckets) => ({ buckets })))(
  "no applicable exhausted buckets %# returns no hint",
  async ({ buckets }) => {
    assert.equal(await fixture((request) => request.respond(ready(buckets))).run(), undefined);
  },
);

test("unknown applicability/exhaustion cannot be hidden behind a known blocking window", async () => {
  const unknown = bucket({ id: "unknown", used: undefined, remaining: undefined, limit: undefined });
  assert.equal(await fixture((request) => request.respond(ready([bucket(), unknown]))).run(), undefined);
});

test("validates even explicitly disjoint bucket measurements", async () => {
  const malformed = bucket({ id: "other", modelKeys: ["other-model"], used: Number.NaN });
  assert.equal(await fixture((request) => request.respond(ready([bucket(), malformed]))).run(), undefined);
});

test("revalidates freshness and reset against completion time", async () => {
  const pending = deferred();
  const result = ready();
  const f = fixture((request) => request.respond(pending.promise));
  const answer = f.run();
  vi.setSystemTime(result.expiresAt);
  pending.resolve(result);
  assert.equal(await answer, undefined);
});

test("never caches a report across calls", async () => {
  let queries = 0;
  const f = fixture((request) => {
    queries += 1;
    if (queries === 1) request.respond(ready());
  });
  assert.equal(await f.run(), RESET);
  assert.equal(await f.run(), undefined);
  assert.equal(queries, 2);
});

test("malicious response accessors and thenables are contained", async () => {
  const throwing = Object.defineProperty({}, "status", {
    get() {
      throw new Error("accessor");
    },
  });
  assert.equal(await fixture((request) => request.respond(throwing)).run(), undefined);
  // biome-ignore lint/suspicious/noThenProperty: Exercise a malformed public promise offer.
  const thenable = Object.defineProperty({}, "then", {
    get() {
      throw new Error("thenable");
    },
  });
  assert.equal(await fixture((request) => request.respond(thenable)).run(), undefined);
});

test("synchronous stale-context reentry cancels an unresolved service immediately", async () => {
  const pending = deferred();
  const f = fixture((request) => {
    request.respond(pending.promise);
    f.changeSessionId();
  });
  assert.equal(await f.run(), undefined);
  pending.reject(new Error("obsolete work"));
  await Promise.resolve();
});

test.each(["used", "remaining", "limit"])("rejects every non-finite or nonnumeric %s measurement", async (field) => {
  for (const invalid of [null, "0", {}, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
    assert.equal(await fixture((request) => request.respond(ready([bucket({ [field]: invalid })]))).run(), undefined);
  }
});

test.each(["metrics", "buckets", "modelKeys", "notes"])("rejects sparse %s arrays", async (field) => {
  const result = ready();
  const sparseKeys = Array<string>(2);
  sparseKeys[1] = "selected-model";
  if (field === "modelKeys") result.report.buckets[0].modelKeys = sparseKeys;
  else Object.assign(result.report, { [field]: Array(1) });
  assert.equal(await fixture((request) => request.respond(result)).run(), undefined);
});

test("duplicate bucket identities leave the window relationship ambiguous", async () => {
  const result = ready([bucket(), bucket({ resetsAt: RESET + 1_000 })]);
  assert.equal(await fixture((request) => request.respond(result)).run(), undefined);
});

test("a reset that passes during the request cannot be returned", async () => {
  const pending = deferred();
  const result = ready([bucket({ resetsAt: NOW + 1_000 })]);
  const f = fixture((request) => request.respond(pending.promise));
  const answer = f.run();
  vi.setSystemTime(NOW + 1_000);
  pending.resolve(result);
  assert.equal(await answer, undefined);
});

test("a delayed valid refresh is evaluated at completion, not dispatch", async () => {
  const pending = deferred();
  const result = ready();
  const f = fixture((request) => request.respond(pending.promise));
  const answer = f.run();
  vi.setSystemTime(NOW + 1_000);
  result.report.capturedAt = NOW + 1_000;
  pending.resolve(result);
  assert.equal(await answer, RESET);
});

test("validation cannot publish a hint after reentrant model mutation", async () => {
  const result = ready();
  const f = fixture((request) => request.respond(result));
  Object.defineProperty(result.report, "metrics", {
    get() {
      if (f.ctx.model) f.ctx.model.id = "replaced-during-validation";
      return [];
    },
  });
  assert.equal(await f.run(), undefined);
});

test.each(["reset", "expiry"])("rejects a %s that passes during report validation", async (deadline) => {
  const result = ready([bucket({ resetsAt: deadline === "reset" ? NOW + 1_000 : RESET })]);
  Object.defineProperty(result.report, "metrics", {
    get() {
      vi.setSystemTime(deadline === "reset" ? NOW + 1_000 : result.expiresAt);
      return [];
    },
  });
  assert.equal(await fixture((request) => request.respond(result)).run(), undefined);
});

test("abort listeners cannot replace ownership during successful cleanup", async () => {
  const f = fixture((request) => {
    request.signal.addEventListener("abort", () => f.changeSessionId(), { once: true });
    request.respond(ready());
  });
  assert.equal(await f.run(), undefined);
});

test("a synchronous dispatch cannot evade the deadline by delaying the timer callback", async () => {
  vi.spyOn(performance, "now").mockReturnValueOnce(0).mockReturnValue(15_000);
  const f = fixture((request) => request.respond(ready()));
  assert.equal(await f.run(), undefined);
});

test("a varying reset accessor cannot publish an infinite wait", async () => {
  const result = ready();
  let reads = 0;
  Object.defineProperty(result.report.buckets[0], "resetsAt", {
    get: () => (++reads <= 2 ? RESET : Number.POSITIVE_INFINITY),
  });
  assert.equal(await fixture((request) => request.respond(result)).run(), undefined);
  assert.equal(reads, 0, "known-field accessors must not execute");
});

const accessorFields: [string, unknown][] = [
  ["status", "ready"],
  ["providerId", "test-provider"],
  ["source", "refresh"],
  ["expiresAt", NOW + 30_000],
  ["report", ready().report],
  ["report.providerId", "test-provider"],
  ["report.providerName", "Test Provider"],
  ["report.capturedAt", NOW],
  ["report.source", "public-test-service"],
  ["report.semantics", { kind: "consumer-subscription", label: "Subscription" }],
  ["report.semantics.kind", "consumer-subscription"],
  ["report.semantics.label", "Subscription"],
  ["report.accountLabel", "Account"],
  ["report.notes", ["Note"]],
  ["report.notes.0", "Note"],
  ["report.buckets", [bucket()]],
  ["report.buckets.0", bucket()],
  ["report.buckets.0.id", "opaque-constraint"],
  ["report.buckets.0.label", "Allowance"],
  ["report.buckets.0.unit", "percent"],
  ["report.buckets.0.groupId", "group"],
  ["report.buckets.0.groupLabel", "Group"],
  ["report.buckets.0.modelKeys", ["selected-model"]],
  ["report.buckets.0.modelKeys.0", "selected-model"],
  ["report.buckets.0.used", 100],
  ["report.buckets.0.remaining", 0],
  ["report.buckets.0.limit", 100],
  ["report.buckets.0.period", "window"],
  ["report.buckets.0.windowMinutes", 60],
  ["report.buckets.0.resetsAt", RESET],
  ["report.metrics", [{ id: "metric", label: "Metric", value: 1 }]],
  ["report.metrics.0", { id: "metric", label: "Metric", value: 1 }],
  ["report.metrics.0.id", "metric"],
  ["report.metrics.0.label", "Metric"],
  ["report.metrics.0.value", 1],
  ["report.metrics.0.unit", "count"],
  ["report.metrics.0.currency", "USD"],
];

test.each(accessorFields)("rejects a varying accessor for known field %s", async (path, initial) => {
  const result = ready();
  Object.assign(result.report, { notes: ["Note"], metrics: [{ id: "metric", label: "Metric", value: 1 }] });
  const { target, key } = fieldTarget(result, path);
  let reads = 0;
  Object.defineProperty(target, key, {
    get: () => (++reads === 1 ? initial : Number.POSITIVE_INFINITY),
  });
  assert.equal(await fixture((request) => request.respond(result)).run(), undefined);
  assert.equal(reads, 0, "known-field accessors must not execute");
});

test("proxy mutation cannot replace a reset after its data descriptor was captured", async () => {
  const result = ready();
  const source = result.report.buckets[0];
  result.report.buckets[0] = new Proxy(source, {
    getOwnPropertyDescriptor(target, key) {
      const descriptor = Reflect.getOwnPropertyDescriptor(target, key);
      if (key === "resetsAt") target.resetsAt = Number.POSITIVE_INFINITY;
      return descriptor;
    },
    get(target, key, receiver) {
      const value = Reflect.get(target, key, receiver);
      if (key === "resetsAt") target.resetsAt = Number.POSITIVE_INFINITY;
      return value;
    },
  });
  assert.equal(await fixture((request) => request.respond(result)).run(), RESET);
  assert.equal(source.resetsAt, Number.POSITIVE_INFINITY);
});

test("proxy mutation before capture is validated rather than trusted", async () => {
  const result = ready();
  const source = result.report.buckets[0];
  result.report.buckets[0] = new Proxy(source, {
    getOwnPropertyDescriptor(target, key) {
      if (key === "resetsAt") target.resetsAt = Number.POSITIVE_INFINITY;
      return Reflect.getOwnPropertyDescriptor(target, key);
    },
  });
  assert.equal(await fixture((request) => request.respond(result)).run(), undefined);
});

test.each([
  "report",
  "report.semantics",
  "report.buckets",
  "report.buckets.0",
  "report.buckets.0.modelKeys",
  "report.metrics",
  "report.metrics.0",
  "report.notes",
])("contains descriptor failures from a proxy at %s", async (path) => {
  const result = ready();
  Object.assign(result.report, { notes: ["Note"], metrics: [{ id: "metric", label: "Metric", value: 1 }] });
  const { target, key } = fieldTarget(result, path);
  target[key] = new Proxy(target[key] as object, {
    getOwnPropertyDescriptor() {
      throw new Error("malformed proxy");
    },
  });
  assert.equal(await fixture((request) => request.respond(result)).run(), undefined);
});

test("later proxy mutation cannot change captured model keys, quantities, or bucket entries", async () => {
  const result = ready();
  const sourceBucket = result.report.buckets[0];
  const sourceKeys = sourceBucket.modelKeys;
  assert.ok(Array.isArray(sourceKeys));
  result.report.metrics = [
    new Proxy(
      { id: "metric", label: "Metric", value: 1 },
      {
        getOwnPropertyDescriptor(target, key) {
          sourceKeys[0] = "other-model";
          sourceBucket.used = Number.POSITIVE_INFINITY;
          sourceBucket.remaining = 1;
          result.report.buckets[0] = bucket({ resetsAt: Number.POSITIVE_INFINITY });
          return Reflect.getOwnPropertyDescriptor(target, key);
        },
      },
    ),
  ];
  assert.equal(await fixture((request) => request.respond(result)).run(), RESET);
  assert.equal(sourceKeys[0], "other-model");
  assert.equal(sourceBucket.used, Number.POSITIVE_INFINITY);
});

test.each(["buckets", "metrics", "modelKeys", "notes"])(
  "does not use a provider-controlled %s iterator",
  async (field) => {
    const result = ready();
    Object.assign(result.report, { notes: ["Note"], metrics: [{ id: "metric", label: "Metric", value: 1 }] });
    const array = field === "modelKeys" ? result.report.buckets[0].modelKeys : Reflect.get(result.report, field);
    let iterations = 0;
    Object.defineProperty(array, Symbol.iterator, {
      get() {
        iterations += 1;
        result.report.buckets[0].resetsAt = Number.POSITIVE_INFINITY;
        return Array.prototype[Symbol.iterator];
      },
    });
    assert.equal(await fixture((request) => request.respond(result)).run(), RESET);
    assert.equal(iterations, 0);
  },
);

test("unknown fields do not execute accessors or require cloneable values", async () => {
  const result = ready();
  result.report.metrics = [{ id: "metric", label: "Metric", value: 1 }];
  let reads = 0;
  for (const target of [
    result,
    result.report,
    result.report.semantics,
    result.report.buckets[0],
    result.report.metrics[0],
  ]) {
    Object.defineProperty(target, "futureField", {
      enumerable: true,
      get() {
        reads += 1;
        throw new Error("unknown fields must be ignored");
      },
    });
    Object.assign(target, { futureFunction: () => {}, futureSymbol: Symbol("future"), futureCycle: target });
  }
  assert.equal(await fixture((request) => request.respond(result)).run(), RESET);
  assert.equal(reads, 0);
});

test("negative metric balances and optional valid bucket fields remain protocol-compatible", async () => {
  const result = ready([bucket({ groupId: "group", groupLabel: "Group", period: "window", windowMinutes: 0.5 })]);
  result.report.metrics = [{ id: "balance", label: "Balance", value: -10, unit: "currency", currency: "EUR" }];
  assert.equal(await fixture((request) => request.respond(result)).run(), RESET);
});
