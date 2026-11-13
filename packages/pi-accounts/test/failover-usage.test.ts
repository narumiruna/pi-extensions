import { EventEmitter } from "node:events";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, test, vi } from "vitest";
import { evaluateUsageAllowance, readUsageAllowance } from "../src/failover-usage.js";

const NOW = 1_800_000_000_000;
const STARTED = NOW - 100;
const PROVIDER = "openai-codex";
const MODEL = "gpt-5.4";
const RESET = NOW + 3_600_000;
function quota(id = "short", remaining = 5, resetsAt: number | undefined = RESET) {
  return { id, label: id, unit: "percent", used: 100 - remaining, remaining, limit: 100, resetsAt };
}
function ready() {
  return {
    status: "ready",
    providerId: PROVIDER,
    source: "refresh",
    expiresAt: NOW + 60_000,
    report: {
      providerId: PROVIDER,
      providerName: "OpenAI Codex",
      capturedAt: NOW - 50,
      source: "provider-quota",
      semantics: { kind: "consumer-subscription", label: "Included subscription" },
      accountLabel: "Not authentication evidence",
      buckets: [quota()],
      metrics: [] as { id: string; label: string; value: number | string; unit?: string }[],
      notes: ["A paid overage balance does not alter included allowance."],
      allowance: {
        kind: "included",
        scope: { kind: "models", modelIds: [MODEL] },
        coverage: "complete",
        bucketIds: ["short"],
        authBinding: "runtime",
      },
    },
  };
}
type Fixture = ReturnType<typeof ready>;
function decide(value: unknown, threshold = 5) {
  return evaluateUsageAllowance(value, PROVIDER, MODEL, threshold, STARTED, NOW);
}
function omit(value: object, key: string) {
  Reflect.deleteProperty(value, key);
}
function replace(value: object, key: string, replacement: unknown) {
  Object.defineProperty(value, key, { configurable: true, enumerable: true, writable: true, value: replacement });
}
function getter(value: object, key: string) {
  Object.defineProperty(value, key, {
    configurable: true,
    get: () => {
      throw new Error("private-provider-body");
    },
  });
}
function fixture() {
  const emitter = new EventEmitter();
  const events: ExtensionAPI["events"] = {
    emit: vi.fn((channel: string, data: unknown) => {
      emitter.emit(channel, data);
    }),
    on: vi.fn((channel: string, handler: (data: unknown) => void) => {
      emitter.on(channel, handler);
      return () => {
        emitter.off(channel, handler);
      };
    }),
  };
  let sessionId = "session-1";
  const ctx = {
    sessionManager: { getSessionId: () => sessionId },
    model: { provider: PROVIDER, id: MODEL, baseUrl: "https://invalid.example.test", name: "Model" },
  } as unknown as ExtensionContext;
  const controller = new AbortController();
  return {
    pi: { events },
    ctx,
    controller,
    sessionId: (value: string) => {
      sessionId = value;
    },
    listen: (handler: (request: Request) => void) => {
      emitter.on("usage:query:v1", handler);
    },
  };
}
type Request = {
  session: ExtensionContext["sessionManager"];
  sessionId: string;
  providerId: string;
  refresh: boolean;
  signal: AbortSignal;
  respond(value: unknown): boolean;
};
function pending<T = unknown>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((accept, fail) => {
    resolve = accept;
    reject = fail;
  });
  return { promise, resolve, reject };
}
function read(current: ReturnType<typeof fixture>, timeout?: number) {
  return readUsageAllowance(current.pi, current.ctx, current.controller.signal, timeout);
}
async function flush() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}
function unavailable(reason: string) {
  return { status: "unavailable", reason };
}
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("evaluateUsageAllowance", () => {
  test.each([
    [0, 0, "low"],
    [0, 0.01, "adequate"],
    [5, 0, "low"],
    [5, 4.99, "low"],
    [5, 5, "low"],
    [5, 5.01, "adequate"],
    [5, 100, "adequate"],
    [99.99, 99.99, "low"],
    [99.99, 100, "adequate"],
  ] as const)("threshold %s with %s remaining is %s", (threshold, remaining, kind) => {
    const result = ready();
    result.report.buckets = [quota("short", remaining)];
    expect(decide(result, threshold)).toEqual(kind === "low" ? { kind, resetsAt: RESET } : { kind });
  });

  test.each([NaN, Infinity, -Infinity, -1, 100, 101, "5", null, undefined])("rejects threshold %s", (value) => {
    expect(evaluateUsageAllowance(ready(), PROVIDER, MODEL, value as number, STARTED, NOW).kind).toBe("unknown");
  });

  const invalid: { name: string; change: (value: Fixture) => void }[] = [
    { name: "old report without metadata", change: (r) => omit(r.report, "allowance") },
    { name: "accountLabel is not auth binding", change: (r) => omit(r.report.allowance, "authBinding") },
    {
      name: "unbound companion auth",
      change: (r) => {
        r.report.allowance.authBinding = "unbound";
      },
    },
    {
      name: "unknown auth binding",
      change: (r) => {
        r.report.allowance.authBinding = "account-label";
      },
    },
    {
      name: "extra spending instead of included",
      change: (r) => {
        r.report.allowance.kind = "spend";
      },
    },
    {
      name: "provider-wide scope is not supported",
      change: (r) => {
        r.report.allowance.scope.kind = "provider";
      },
    },
    {
      name: "model name substring",
      change: (r) => {
        r.report.allowance.scope.modelIds = ["gpt-5"];
      },
    },
    {
      name: "model display group",
      change: (r) => {
        r.report.allowance.scope.modelIds = ["GPT-5.4"];
      },
    },
    {
      name: "empty model scope",
      change: (r) => {
        r.report.allowance.scope.modelIds = [];
      },
    },
    {
      name: "duplicate model IDs",
      change: (r) => {
        r.report.allowance.scope.modelIds.push(MODEL);
      },
    },
    {
      name: "empty model ID alongside exact model",
      change: (r) => {
        r.report.allowance.scope.modelIds.push("");
      },
    },
    {
      name: "empty bucket references",
      change: (r) => {
        r.report.allowance.bucketIds = [];
      },
    },
    {
      name: "duplicate bucket references",
      change: (r) => {
        r.report.allowance.bucketIds.push("short");
      },
    },
    {
      name: "empty bucket reference",
      change: (r) => {
        r.report.allowance.bucketIds.push(" ");
      },
    },
    {
      name: "missing referenced bucket",
      change: (r) => {
        r.report.allowance.bucketIds.push("missing");
      },
    },
    {
      name: "duplicate bucket IDs",
      change: (r) => {
        r.report.buckets.push(quota());
      },
    },
    {
      name: "blank bucket ID",
      change: (r) => {
        r.report.buckets[0].id = "";
      },
    },
    {
      name: "unsupported coverage",
      change: (r) => {
        r.report.allowance.coverage = "inferred";
      },
    },
    { name: "missing coverage", change: (r) => omit(r.report.allowance, "coverage") },
    {
      name: "outer provider mismatch",
      change: (r) => {
        r.providerId = "anthropic";
      },
    },
    {
      name: "inner provider mismatch",
      change: (r) => {
        r.report.providerId = "anthropic";
      },
    },
    {
      name: "cache result",
      change: (r) => {
        r.source = "cache";
      },
    },
    { name: "source cannot be inferred from report source", change: (r) => omit(r, "source") },
    {
      name: "expired report",
      change: (r) => {
        r.expiresAt = NOW - 1;
      },
    },
    {
      name: "exact expiry",
      change: (r) => {
        r.expiresAt = NOW;
      },
    },
    {
      name: "capture before request",
      change: (r) => {
        r.report.capturedAt = STARTED - 1;
      },
    },
    {
      name: "future capture",
      change: (r) => {
        r.report.capturedAt = NOW + 1;
      },
    },
    {
      name: "capture seconds",
      change: (r) => {
        r.report.capturedAt /= 1_000;
      },
    },
    {
      name: "expiry seconds",
      change: (r) => {
        r.expiresAt /= 1_000;
      },
    },
    {
      name: "capture NaN",
      change: (r) => {
        r.report.capturedAt = NaN;
      },
    },
    {
      name: "expiry infinity",
      change: (r) => {
        r.expiresAt = Infinity;
      },
    },
    {
      name: "fractional capture",
      change: (r) => {
        r.report.capturedAt += 0.5;
      },
    },
    {
      name: "out of range expiry",
      change: (r) => {
        r.expiresAt = 8_640_000_000_000_001;
      },
    },
    {
      name: "expired quota reset",
      change: (r) => {
        r.report.buckets[0].resetsAt = NOW - 1;
      },
    },
    {
      name: "exact quota reset",
      change: (r) => {
        r.report.buckets[0].resetsAt = NOW;
      },
    },
    {
      name: "reset seconds",
      change: (r) => {
        r.report.buckets[0].resetsAt = RESET / 1_000;
      },
    },
    {
      name: "reset infinity",
      change: (r) => {
        r.report.buckets[0].resetsAt = Infinity;
      },
    },
    {
      name: "reset fractional ms",
      change: (r) => {
        r.report.buckets[0].resetsAt = RESET + 0.5;
      },
    },
    {
      name: "reset zero",
      change: (r) => {
        r.report.buckets[0].resetsAt = 0;
      },
    },
    {
      name: "money unit",
      change: (r) => {
        r.report.buckets[0].unit = "usd";
      },
    },
    {
      name: "currency unit",
      change: (r) => {
        r.report.buckets[0].unit = "currency";
      },
    },
    {
      name: "count unit",
      change: (r) => {
        r.report.buckets[0].unit = "count";
      },
    },
    { name: "missing unit", change: (r) => omit(r.report.buckets[0], "unit") },
    {
      name: "unknown unit",
      change: (r) => {
        r.report.buckets[0].unit = "percentage";
      },
    },
    {
      name: "non-100 limit",
      change: (r) => {
        r.report.buckets[0].limit = 1;
      },
    },
    {
      name: "zero limit",
      change: (r) => {
        r.report.buckets[0].limit = 0;
      },
    },
    {
      name: "negative limit",
      change: (r) => {
        r.report.buckets[0].limit = -100;
      },
    },
    {
      name: "infinite limit",
      change: (r) => {
        r.report.buckets[0].limit = Infinity;
      },
    },
    {
      name: "NaN remaining",
      change: (r) => {
        r.report.buckets[0].remaining = NaN;
      },
    },
    {
      name: "infinite used",
      change: (r) => {
        r.report.buckets[0].used = Infinity;
      },
    },
    {
      name: "negative remaining",
      change: (r) => {
        r.report.buckets[0].remaining = -1;
      },
    },
    {
      name: "remaining greater than 100",
      change: (r) => {
        r.report.buckets[0].remaining = 101;
      },
    },
    {
      name: "negative used",
      change: (r) => {
        r.report.buckets[0].used = -1;
      },
    },
    {
      name: "used greater than 100",
      change: (r) => {
        r.report.buckets[0].used = 101;
      },
    },
    {
      name: "contradictory used and remaining",
      change: (r) => {
        r.report.buckets[0].used = 4;
      },
    },
    {
      name: "nearly consistent boundary is not zero",
      change: (r) => {
        r.report.buckets[0].used = 100;
        r.report.buckets[0].remaining = Number.EPSILON;
      },
    },
    {
      name: "nearly consistent full boundary",
      change: (r) => {
        r.report.buckets[0].used = Number.EPSILON;
        r.report.buckets[0].remaining = 100;
      },
    },
    {
      name: "missing measurements despite limit",
      change: (r) => {
        omit(r.report.buckets[0], "remaining");
        omit(r.report.buckets[0], "used");
      },
    },
    { name: "string measurement", change: (r) => replace(r.report.buckets[0], "remaining", "5") },
    { name: "null measurement", change: (r) => replace(r.report.buckets[0], "remaining", null) },
    { name: "missing buckets", change: (r) => omit(r.report, "buckets") },
    { name: "missing metrics", change: (r) => omit(r.report, "metrics") },
    {
      name: "invalid metric",
      change: (r) => {
        r.report.metrics.push({ id: "spent", label: "Spend", value: NaN });
      },
    },
    { name: "missing report semantics", change: (r) => omit(r.report, "semantics") },
    {
      name: "unknown report semantics",
      change: (r) => {
        r.report.semantics.kind = "included";
      },
    },
    { name: "missing provider name", change: (r) => omit(r.report, "providerName") },
    { name: "malformed notes", change: (r) => replace(r.report, "notes", [null]) },
    {
      name: "array hole",
      change: (r) => {
        r.report.buckets.length = 2;
      },
    },
  ];
  test.each(invalid)("unknown: $name", ({ change }) => {
    const value = ready();
    change(value);
    const result = decide(value);
    expect(result.kind).toBe("unknown");
    expect(result.resetsAt).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain("private");
  });

  test.each([
    undefined,
    null,
    true,
    0,
    "ready",
    [],
    {},
    new Error("HTTP 429"),
    { status: "error", code: 429 },
    { status: "unavailable", reason: "query-failed" },
    { status: "unavailable", reason: "auth-unavailable" },
    { status: "unavailable", reason: "unsupported" },
    { status: "unavailable", reason: "timeout" },
    { status: "unavailable", reason: "not-ready" },
    { status: "unavailable", reason: "query-failed", report: ready().report },
  ])("unknown inputs do not authorize failover: %s", (value) => {
    expect(decide(value).kind).toBe("unknown");
  });

  test.each([
    [NaN, NOW],
    [Infinity, NOW],
    [0, NOW],
    [NOW + 1, NOW],
    [STARTED, NaN],
    [STARTED, 0],
    [STARTED, Infinity],
  ])("rejects invalid request clock %s / %s", (started, now) => {
    expect(evaluateUsageAllowance(ready(), PROVIDER, MODEL, 5, started, now).kind).toBe("unknown");
  });

  test("freshness includes request start and current capture boundaries; default now uses milliseconds", () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const value = ready();
    for (const capturedAt of [STARTED, NOW]) {
      value.report.capturedAt = capturedAt;
      expect(evaluateUsageAllowance(value, PROVIDER, MODEL, 5, STARTED)).toEqual({ kind: "low", resetsAt: RESET });
    }
  });

  test.each(["used", "remaining"] as const)("a referenced constraint missing %s is unknown", (missing) => {
    const value = ready();
    omit(value.report.buckets[0], missing);
    expect(decide(value).kind).toBe("unknown");
    omit(value.report.buckets[0], "limit");
    expect(decide(value).kind).toBe("unknown");
  });

  test("an omitted limit with both percentage counters is not an unlimited allowance", () => {
    const value = ready();
    omit(value.report.buckets[0], "limit");
    expect(decide(value).kind).toBe("low");
  });

  test.each([
    [5e-10, "low"],
    [-5e-10, "low"],
    [2e-9, "unknown"],
    [-2e-9, "unknown"],
  ] as const)("sum100 tolerance: delta %s is %s", (delta, kind) => {
    const value = ready();
    value.report.buckets[0].used += delta;
    expect(decide(value).kind).toBe(kind);
  });

  test("accepts exactly 128 scope and bucket IDs and 512-character IDs", () => {
    const value = ready();
    value.report.allowance.scope.modelIds = [MODEL, ...Array.from({ length: 127 }, (_, index) => `model-${index}`)];
    value.report.buckets = Array.from({ length: 128 }, (_, index) =>
      quota(index === 0 ? "x".repeat(512) : `bucket-${index}`),
    );
    value.report.allowance.bucketIds = value.report.buckets.map((item) => item.id);
    expect(decide(value)).toEqual({ kind: "low", resetsAt: RESET });
    value.report.allowance.scope.modelIds[1] = "x".repeat(512);
    expect(decide(value).kind).toBe("low");
  });

  test.each(["models", "references"] as const)("rejects a 513-character %s ID", (target) => {
    const value = ready();
    if (target === "models") value.report.allowance.scope.modelIds.push("x".repeat(513));
    else {
      value.report.buckets[0].id = "x".repeat(513);
      value.report.allowance.bucketIds = [value.report.buckets[0].id];
    }
    expect(decide(value).kind).toBe("unknown");
  });

  test.each(["models", "references", "buckets", "metrics", "notes", "modelKeys"] as const)(
    "bounds pathological sparse %s arrays before reading elements",
    (target) => {
      const value = ready();
      const source: unknown[] = [];
      source.length = 4_294_967_295;
      const elementRead = vi.fn();
      const sparse = new Proxy(source, {
        getOwnPropertyDescriptor(array, key) {
          if (key !== "length") elementRead(key);
          return Reflect.getOwnPropertyDescriptor(array, key);
        },
      });
      if (target === "models") replace(value.report.allowance.scope, "modelIds", sparse);
      if (target === "references") replace(value.report.allowance, "bucketIds", sparse);
      if (target === "buckets") replace(value.report, "buckets", sparse);
      if (target === "metrics") replace(value.report, "metrics", sparse);
      if (target === "notes") replace(value.report, "notes", sparse);
      if (target === "modelKeys") replace(value.report.buckets[0], "modelKeys", sparse);
      expect(decide(value).kind).toBe("unknown");
      expect(elementRead).not.toHaveBeenCalled();
    },
  );

  test.each(["models", "references", "buckets"] as const)("rejects oversize dense %s arrays", (target) => {
    const value = ready();
    if (target === "models")
      value.report.allowance.scope.modelIds = [MODEL, ...Array.from({ length: 128 }, (_, index) => `model-${index}`)];
    if (target === "references")
      value.report.allowance.bucketIds = Array.from({ length: 129 }, (_, index) => `bucket-${index}`);
    if (target === "buckets")
      value.report.buckets = Array.from({ length: 2049 }, (_, index) => quota(`bucket-${index}`));
    expect(decide(value).kind).toBe("unknown");
  });

  test.each([0, 100])("accepts consistent percentage boundary %s", (remaining) => {
    const value = ready();
    value.report.buckets = [quota("short", remaining)];
    expect(decide(value).kind).toBe(remaining === 0 ? "low" : "adequate");
  });

  test.each([
    { values: [1, 99], coverage: "complete", kind: "low" },
    { values: [99, 1], coverage: "complete", kind: "low" },
    { values: [10, 90], coverage: "complete", kind: "adequate" },
    { values: [10, 90], coverage: "partial", kind: "unknown" },
    { values: [1, 99], coverage: "partial", kind: "low" },
  ])("independent windows $values / $coverage are $kind, never averaged", ({ values, coverage, kind }) => {
    const value = ready();
    value.report.buckets = values.map((remaining, index) => quota(`window-${index}`, remaining));
    value.report.allowance.bucketIds = value.report.buckets.map((item) => item.id);
    value.report.allowance.coverage = coverage;
    expect(decide(value).kind).toBe(kind);
  });

  test("all referenced constraints must validate before a low decision", () => {
    const value = ready();
    value.report.buckets.push(quota("long", 90));
    value.report.buckets[1].unit = "usd";
    value.report.allowance.bucketIds.push("long");
    expect(decide(value).kind).toBe("unknown");
    value.report.allowance.bucketIds.reverse();
    expect(decide(value).kind).toBe("unknown");
  });

  test("only explicit references apply, not labels, modelKeys, groupId, accountLabel, balances or spend", () => {
    const value = ready();
    value.report.buckets = [quota("short", 90), { ...quota("extra", 0), unit: "usd" }];
    replace(value.report.buckets[1], "modelKeys", [MODEL]);
    replace(value.report.buckets[1], "groupId", MODEL);
    value.report.metrics = [{ id: "balance", label: "Balance", value: 0, unit: "usd" }];
    value.report.allowance.scope.modelIds.push("another-exact-model");
    expect(decide(value)).toEqual({ kind: "adequate" });
    value.report.buckets[0] = quota("short", 0);
    value.report.metrics[0].value = 1_000_000;
    expect(decide(value).kind).toBe("low");
    omit(value.report, "allowance");
    expect(decide(value).kind).toBe("unknown");
  });

  test("reset is the latest known future reset among low constraints only", () => {
    const value = ready();
    value.report.buckets = [quota("a", 1, RESET), quota("b", 5, RESET + 1_000), quota("c", 90, RESET + 5_000)];
    value.report.allowance.bucketIds = ["a", "b", "c"];
    expect(decide(value)).toEqual({ kind: "low", resetsAt: RESET + 1_000 });
    value.report.buckets.reverse();
    value.report.allowance.bucketIds.reverse();
    expect(decide(value)).toEqual({ kind: "low", resetsAt: RESET + 1_000 });
  });

  test("missing reset on any low constraint suppresses cooldown rather than inventing one", () => {
    const value = ready();
    value.report.buckets = [quota("a", 1), quota("b", 2), quota("c", 90)];
    value.report.allowance.bucketIds = ["a", "b", "c"];
    omit(value.report.buckets[1], "resetsAt");
    expect(decide(value)).toEqual({ kind: "low" });
    value.report.buckets[1].resetsAt = RESET;
    omit(value.report.buckets[2], "resetsAt");
    expect(decide(value)).toEqual({ kind: "low", resetsAt: RESET });
    value.report.buckets[0].resetsAt = NOW - 1;
    expect(decide(value).kind).toBe("unknown");
    expect(decide(value).resetsAt).toBeUndefined();
  });

  const hostile: { name: string; create: () => unknown }[] = [
    {
      name: "status getter",
      create: () => {
        const r = ready();
        getter(r, "status");
        return r;
      },
    },
    {
      name: "remaining getter",
      create: () => {
        const r = ready();
        getter(r.report.buckets[0], "remaining");
        return r;
      },
    },
    {
      name: "scope getter",
      create: () => {
        const r = ready();
        getter(r.report.allowance, "scope");
        return r;
      },
    },
    {
      name: "array getter",
      create: () => {
        const r = ready();
        getter(r.report.buckets, "0");
        return r;
      },
    },
    {
      name: "nonthrowing accessor",
      create: () => {
        const r = ready();
        Object.defineProperty(r.report.buckets[0], "remaining", { get: () => 5 });
        return r;
      },
    },
    {
      name: "throwing descriptor trap",
      create: () =>
        new Proxy(ready(), {
          getOwnPropertyDescriptor() {
            throw new Error("private-proxy-secret");
          },
        }),
    },
    {
      name: "nested throwing descriptor trap",
      create: () => {
        const r = ready();
        r.report.allowance.scope.modelIds = new Proxy([MODEL], {
          getOwnPropertyDescriptor() {
            throw new Error("private-proxy-secret");
          },
        });
        return r;
      },
    },
    {
      name: "revoked proxy",
      create: () => {
        const { proxy, revoke } = Proxy.revocable(ready(), {});
        revoke();
        return proxy;
      },
    },
    {
      name: "revoked array",
      create: () => {
        const r = ready();
        const { proxy, revoke } = Proxy.revocable(r.report.buckets, {});
        revoke();
        r.report.buckets = proxy;
        return r;
      },
    },
    {
      name: "fractional proxy array length",
      create: () => {
        const r = ready();
        r.report.allowance.bucketIds = new Proxy(["short"], {
          getOwnPropertyDescriptor(target, key) {
            const descriptor = Reflect.getOwnPropertyDescriptor(target, key);
            return key === "length" ? { ...descriptor, value: 1.5 } : descriptor;
          },
        });
        return r;
      },
    },
    {
      name: "accessor array length trap",
      create: () => {
        const r = ready();
        r.report.allowance.bucketIds = new Proxy(["short"], {
          getOwnPropertyDescriptor(target, key) {
            return key === "length"
              ? { configurable: false, enumerable: false, get: () => 1 }
              : Reflect.getOwnPropertyDescriptor(target, key);
          },
        });
        return r;
      },
    },
    {
      name: "negative proxy array length",
      create: () => {
        const r = ready();
        r.report.allowance.bucketIds = new Proxy(["short"], {
          getOwnPropertyDescriptor(target, key) {
            const descriptor = Reflect.getOwnPropertyDescriptor(target, key);
            return key === "length" ? { ...descriptor, value: -1 } : descriptor;
          },
        });
        return r;
      },
    },
    { name: "inherited evidence", create: () => Object.create(ready()) },
    {
      name: "cyclic known field",
      create: () => {
        const r = ready();
        replace(r, "report", r);
        return r;
      },
    },
  ];
  test.each(hostile)("rejects $name without throwing or leaking", ({ create }) => {
    expect(() => decide(create())).not.toThrow();
    expect(decide(create()).kind).toBe("unknown");
    expect(JSON.stringify(decide(create()))).not.toContain("private");
  });

  test("valid data proxies are read once and decisions do not retain mutable payloads", () => {
    const value = ready();
    const reads = new Map<PropertyKey, number>();
    value.report.buckets[0] = new Proxy(value.report.buckets[0], {
      getOwnPropertyDescriptor(target, key) {
        reads.set(key, (reads.get(key) ?? 0) + 1);
        return Reflect.getOwnPropertyDescriptor(target, key);
      },
      get() {
        throw new Error("Do not invoke property getters");
      },
    });
    const result = decide(value);
    expect(result).toEqual({ kind: "low", resetsAt: RESET });
    expect([...reads.values()].every((count) => count === 1)).toBe(true);
    value.report.buckets.length = 0;
    value.report.allowance.bucketIds.push("missing");
    expect(result).toEqual({ kind: "low", resetsAt: RESET });
  });

  test("unknown fields do not invoke getters and null-prototype records work", () => {
    const value = ready();
    getter(value, "future-field");
    const copy = Object.assign(Object.create(null), value);
    expect(decide(copy).kind).toBe("low");
    const before = JSON.stringify(ready());
    const frozen = ready();
    Object.freeze(frozen.report.buckets[0]);
    Object.freeze(frozen.report.allowance.bucketIds);
    decide(frozen);
    expect(JSON.stringify(frozen)).toBe(before);
  });
});

describe("readUsageAllowance", () => {
  test("absent service returns immediately, does not subscribe, and removes timers/listeners", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const current = fixture();
    const add = vi.spyOn(current.controller.signal, "addEventListener");
    const remove = vi.spyOn(current.controller.signal, "removeEventListener");
    expect(await read(current)).toEqual(unavailable("no-service"));
    expect(current.pi.events.emit).toHaveBeenCalledTimes(1);
    expect(current.pi.events.on).not.toHaveBeenCalled();
    expect(add).toHaveBeenCalledTimes(1);
    expect(remove).toHaveBeenCalledTimes(1);
    expect(remove.mock.calls[0][1]).toBe(add.mock.calls[0][1]);
    expect(vi.getTimerCount()).toBe(0);
  });

  test.each(["tui", "rpc", "json", "print"] as const)(
    "exact refresh scope in %s; no UI/messages/tools",
    async (mode) => {
      vi.useFakeTimers();
      vi.setSystemTime(NOW);
      const current = fixture();
      current.ctx.mode = mode;
      for (const name of ["ui", "modelRegistry", "sendMessage", "setActiveTools"]) getter(current.ctx, name);
      let request!: Request;
      current.listen((value) => {
        request = value;
        expect(value.respond(Promise.resolve(ready()))).toBe(true);
      });
      expect(await read(current)).toEqual(ready());
      expect(request.session).toBe(current.ctx.sessionManager);
      expect(request.sessionId).toBe("session-1");
      expect(request.providerId).toBe(PROVIDER);
      expect(request.refresh).toBe(true);
      expect(request.signal).not.toBe(current.controller.signal);
      expect(request.signal.aborted).toBe(true);
      expect(Object.keys(request).sort()).toEqual([
        "providerId",
        "refresh",
        "respond",
        "session",
        "sessionId",
        "signal",
      ]);
      expect(current.pi.events.on).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  test("initialization not-ready is preserved and old metadata remains non-actionable", async () => {
    const current = fixture();
    let initialized = false;
    current.listen((request) => {
      const old = ready();
      omit(old.report, "allowance");
      request.respond(initialized ? old : { status: "unavailable", reason: "not-ready", providerId: PROVIDER });
    });
    expect(await read(current)).toEqual({ status: "unavailable", reason: "not-ready", providerId: PROVIDER });
    initialized = true;
    expect(decide(await read(current)).kind).toBe("unknown");
  });

  test("accepts the first synchronous pending offer and observes rejected duplicate offers", async () => {
    const current = fixture();
    const first = pending();
    const ignored = pending();
    let request!: Request;
    const offered: boolean[] = [];
    current.listen((value) => {
      request = value;
      offered.push(value.respond(first.promise));
      offered.push(value.respond(ignored.promise));
      offered.push(value.respond(Promise.reject(new Error("duplicate-secret"))));
    });
    const result = read(current);
    let settled = false;
    void result.then(() => {
      settled = true;
    });
    await flush();
    expect(settled).toBe(false);
    ignored.reject(new Error("ignored-secret"));
    first.resolve(ready());
    expect(await result).toEqual(ready());
    expect(offered).toEqual([true, false, false]);
    expect(request.respond(Promise.reject(new Error("late-secret")))).toBe(false);
    await flush();
  });

  test("late asynchronous offers cannot turn no-service into a report", async () => {
    const current = fixture();
    let request!: Request;
    current.listen((value) => {
      request = value;
      queueMicrotask(() => {
        value.respond(ready());
      });
    });
    expect(await read(current)).toEqual(unavailable("no-service"));
    expect(request.respond(Promise.reject(new Error("late-rejection")))).toBe(false);
    expect(request.signal.aborted).toBe(true);
    await flush();
  });

  test.each([
    undefined,
    null,
    [],
    {},
    { status: "ready" },
    { status: "error", code: 429 },
    Object.defineProperty({}, "status", {
      get: () => {
        throw new Error("private-secret");
      },
    }),
  ])("malformed first offers are protocol errors: %s", async (value) => {
    const current = fixture();
    const offered: boolean[] = [];
    current.listen((request) => {
      offered.push(request.respond(value), request.respond(ready()));
    });
    expect(await read(current)).toEqual(unavailable("protocol-error"));
    expect(offered).toEqual([true, false]);
  });

  test.each(["missing-counter", "oversize-scope", "missing-reference", "duplicate-reference"] as const)(
    "malformed declared metadata is a protocol error: %s",
    async (malformed) => {
      const current = fixture();
      const value = ready();
      if (malformed === "missing-counter") omit(value.report.buckets[0], "used");
      if (malformed === "oversize-scope")
        value.report.allowance.scope.modelIds = Array.from({ length: 129 }, (_, index) => `model-${index}`);
      if (malformed === "missing-reference") value.report.allowance.bucketIds = ["missing"];
      if (malformed === "duplicate-reference") value.report.allowance.bucketIds.push("short");
      current.listen((request) => {
        request.respond(value);
      });
      expect(await read(current)).toEqual(unavailable("protocol-error"));
    },
  );

  test.each(["providerId", "report-providerId"])("rejects mismatched %s", async (field) => {
    const current = fixture();
    const value = ready();
    if (field === "providerId") value.providerId = "anthropic";
    else value.report.providerId = "anthropic";
    current.listen((request) => {
      request.respond(value);
    });
    expect(await read(current)).toEqual(unavailable("protocol-error"));
  });

  test("unexpected rejections and thenable getters are observed without exposing errors", async () => {
    for (const offered of [
      Promise.reject(new Error("raw-429-secret")),
      // biome-ignore lint/suspicious/noThenProperty: Test a malformed response thenable.
      Object.defineProperty({}, "then", {
        get: () => {
          throw new Error("private-thenable-secret");
        },
      }),
    ]) {
      const current = fixture();
      current.listen((request) => {
        request.respond(offered);
      });
      expect(await read(current)).toEqual(unavailable("protocol-error"));
    }
  });

  test("throwing emit is a local protocol error and releases resources", async () => {
    vi.useFakeTimers();
    const current = fixture();
    const remove = vi.spyOn(current.controller.signal, "removeEventListener");
    current.pi.events.emit = () => {
      throw new Error("private-event-secret");
    };
    expect(await read(current)).toEqual(unavailable("protocol-error"));
    expect(remove).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  test("pre-aborted input dispatches nothing", async () => {
    vi.useFakeTimers();
    const current = fixture();
    current.controller.abort(new Error("private-secret"));
    expect(await read(current)).toEqual(unavailable("cancelled"));
    expect(current.pi.events.emit).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  test.each(["cancel", "deadline", "success", "rejection"] as const)(
    "%s removes deadline and abort listener",
    async (exit) => {
      vi.useFakeTimers();
      vi.setSystemTime(NOW);
      const current = fixture();
      const work = pending();
      let request!: Request;
      const add = vi.spyOn(current.controller.signal, "addEventListener");
      const remove = vi.spyOn(current.controller.signal, "removeEventListener");
      current.listen((value) => {
        request = value;
        value.respond(work.promise);
      });
      const result = read(current, 20);
      if (exit === "cancel") current.controller.abort();
      if (exit === "deadline") await vi.advanceTimersByTimeAsync(20);
      if (exit === "success") work.resolve(ready());
      if (exit === "rejection") work.reject(new Error("private-reject"));
      expect(await result).toEqual(
        exit === "success"
          ? ready()
          : unavailable(exit === "cancel" ? "cancelled" : exit === "deadline" ? "timeout" : "protocol-error"),
      );
      expect(request.signal.aborted).toBe(true);
      expect(remove.mock.calls[0][1]).toBe(add.mock.calls[0][1]);
      expect(remove).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(0);
      if (exit !== "success" && exit !== "rejection") work.reject(new Error("late-rejected-work"));
      expect(request.respond(Promise.reject(new Error("late-duplicate-work")))).toBe(false);
      await flush();
    },
  );

  test.each([undefined, 30_000, Infinity, NaN])("caps deadline at fifteen seconds: %s", async (timeout) => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const current = fixture();
    let request!: Request;
    current.listen((value) => {
      request = value;
      value.respond(new Promise(() => {}));
    });
    const result = read(current, timeout);
    let settled = false;
    void result.then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(14_999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await result).toEqual(unavailable("timeout"));
    expect(request.signal.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  test("elapsed deadline is checked even before the timer callback can run", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const current = fixture();
    current.listen((request) => {
      request.respond(ready());
      vi.setSystemTime(NOW + 50);
    });
    expect(await read(current, 20)).toEqual(unavailable("timeout"));
    expect(vi.getTimerCount()).toBe(0);
  });

  test.each(["session-id", "session-object", "model-id", "model-provider", "model-options", "no-model"] as const)(
    "revalidates %s after the pending result",
    async (change) => {
      const current = fixture();
      const work = pending();
      current.listen((request) => {
        request.respond(work.promise);
      });
      const result = read(current);
      if (change === "session-id") current.sessionId("session-2");
      if (change === "session-object")
        current.ctx.sessionManager = { getSessionId: () => "session-1" } as ExtensionContext["sessionManager"];
      if (change === "model-id" && current.ctx.model) current.ctx.model.id = "gpt-other";
      if (change === "model-provider" && current.ctx.model) current.ctx.model.provider = "anthropic";
      if (change === "model-options" && current.ctx.model) current.ctx.model.baseUrl = "https://changed.example.test";
      if (change === "no-model") current.ctx.model = undefined;
      work.resolve(ready());
      expect(await result).toEqual(unavailable("stale-context"));
    },
  );

  test("missing model does not dispatch and inaccessible initial context does not throw", async () => {
    const current = fixture();
    current.ctx.model = undefined;
    expect(await read(current)).toEqual(unavailable("no-model"));
    getter(current.ctx, "sessionManager");
    expect(await read(current)).toEqual(unavailable("stale-context"));
    expect(current.pi.events.emit).not.toHaveBeenCalled();
  });

  test("abort during context capture dispatches nothing", async () => {
    const current = fixture();
    const model = current.ctx.model;
    Object.defineProperty(current.ctx, "model", {
      get: () => {
        current.controller.abort();
        return model;
      },
    });
    expect(await read(current)).toEqual(unavailable("cancelled"));
    expect(current.pi.events.emit).not.toHaveBeenCalled();
  });

  test("inaccessible late context is stale, not a protocol error", async () => {
    const current = fixture();
    const work = pending();
    current.listen((request) => {
      request.respond(work.promise);
    });
    const result = read(current);
    getter(current.ctx, "model");
    work.resolve(ready());
    expect(await result).toEqual(unavailable("stale-context"));
  });

  test("revalidates context after snapshot descriptor traps run", async () => {
    const current = fixture();
    const value = new Proxy(ready(), {
      getOwnPropertyDescriptor(target, key) {
        current.sessionId("session-2");
        return Reflect.getOwnPropertyDescriptor(target, key);
      },
    });
    current.listen((request) => {
      request.respond(value);
    });
    expect(await read(current)).toEqual(unavailable("stale-context"));
  });

  test.each([0, -1])("nonpositive deadline %s cannot accept even an immediate report", async (timeout) => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const current = fixture();
    current.listen((request) => {
      request.respond(ready());
    });
    expect(await read(current, timeout)).toEqual(unavailable("timeout"));
    expect(vi.getTimerCount()).toBe(0);
  });

  test("detached response data cannot be changed through the service object or returned copy", async () => {
    const current = fixture();
    const original = ready();
    current.listen((request) => {
      request.respond(original);
    });
    const first = (await read(current)) as Fixture;
    first.report.buckets[0].remaining = 90;
    first.report.allowance.scope.modelIds.length = 0;
    expect(original).toEqual(ready());
    const second = (await read(current)) as Fixture;
    const decision = decide(second);
    original.report.buckets[0].remaining = 90;
    original.report.allowance.bucketIds.push("extra");
    expect(second).toEqual(ready());
    expect(decision).toEqual({ kind: "low", resetsAt: RESET });
  });

  test("reentrant self-notification cannot cause a refresh loop or discard a valid result", async () => {
    const current = fixture();
    current.listen((request) => {
      const report = ready();
      current.pi.events.emit("usage:changed:v1", {
        session: request.session,
        sessionId: request.sessionId,
        providerId: PROVIDER,
        changedAt: NOW,
        reason: "updated",
      });
      request.respond(Promise.resolve(report));
    });
    expect(decide(await read(current)).kind).toBe("low");
    expect(current.pi.events.emit).toHaveBeenCalledTimes(2);
    expect(
      vi.mocked(current.pi.events.emit).mock.calls.filter(([channel]) => channel === "usage:query:v1"),
    ).toHaveLength(1);
    expect(current.pi.events.on).not.toHaveBeenCalled();
  });
});
