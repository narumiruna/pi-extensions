import assert from "node:assert/strict";
import { afterEach, test, vi } from "vitest";
import { formatUsageReport, formatUsageStatusline } from "../src/format.js";
import { normalizeCodexBackendPayload, normalizeCodexResetDetails } from "../src/providers/codex.js";
import { adapterForProvider } from "../src/query.js";
import type { ResolvedUsageAuth } from "../src/types.js";

const usage = {
  rate_limit: { primary_window: { used_percent: 25 } },
  rate_limit_reset_credits: { available_count: 2, applicable_available_count: 0 },
};
const credit = {
  id: "not-for-display",
  reset_type: "codex_rate_limits",
  is_supported_by_plan: true,
  status: "available",
  title: "Full reset",
  expires_at: "2026-10-04T05:32:41.007467Z",
};
const auth: ResolvedUsageAuth = {
  headers: { Authorization: "Bearer test-token" },
  fingerprint: "account",
  secrets: ["test-token"],
  model: { provider: "openai-codex", baseUrl: "https://chatgpt.com/backend-api" } as never,
};
const adapter = adapterForProvider("openai-codex");
if (!adapter) throw new Error("Codex adapter missing");
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

test("Codex details use only authenticated GETs and preserve the summary count", async () => {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  const guard = vi.fn(async () => {});
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    return Response.json(calls.length === 1 ? usage : { credits: [credit], available_count: 99 });
  });
  const report = await adapter.query(auth, new AbortController().signal, 5_000, guard);
  assert.deepEqual(
    calls.map(({ url }) => url),
    ["https://chatgpt.com/backend-api/wham/usage", "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits"],
  );
  for (const { init } of calls) {
    assert.ok(init);
    assert.equal(init.method, "GET");
    assert.equal(init?.body, undefined);
    assert.equal(init?.redirect, "error");
    assert.equal((init.headers as Record<string, string>).Authorization, "Bearer test-token");
  }
  assert.equal(guard.mock.calls.length, 2);
  assert.equal(report.metrics.find((metric) => metric.id === "reset-credits")?.value, 2);
  assert.equal(report.codexResetCredits?.[0]?.expiresAt, Date.parse(credit.expires_at));
  assert.match(formatUsageReport(report, "configured"), /2 available/);
});

for (const count of [undefined, 0]) {
  test(`Codex skips optional request without banked credits (${count})`, async () => {
    const fetcher = vi.fn(async () =>
      Response.json({ ...usage, rate_limit_reset_credits: { available_count: count } }),
    );
    vi.stubGlobal("fetch", fetcher);
    const report = await adapter.query(auth, new AbortController().signal, 5_000);
    assert.equal(fetcher.mock.calls.length, 1);
    assert.equal(report.buckets[0]?.remaining, 75);
  });
}

for (const failure of ["http", "json", "network", "shape", "redirect"]) {
  test(`Codex optional ${failure} failure preserves usage and count`, async () => {
    let calls = 0;
    vi.stubGlobal("fetch", async () => {
      if (++calls === 1) return Response.json(usage);
      if (failure === "network") throw new Error("offline test-token");
      if (failure === "http") return new Response("denied", { status: 403 });
      if (failure === "json") return new Response("not json");
      if (failure === "redirect") {
        const response = Response.json({ credits: [credit] });
        Object.defineProperty(response, "redirected", { value: true });
        return response;
      }
      return Response.json({ credits: {} });
    });
    const report = await adapter.query(auth, new AbortController().signal, 5_000);
    assert.equal(report.codexResetCredits, undefined);
    assert.match(formatUsageReport(report, "current"), /2 available/);
    assert.match(formatUsageReport(report, "current"), /75% left/);
    assert.doesNotMatch(formatUsageReport(report, "current"), /test-token/);
  });
}

test("Codex skips optional details when the usage request exhausts its budget", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
  const fetcher = vi.fn(async () => {
    vi.setSystemTime(4_950);
    return Response.json(usage);
  });
  vi.stubGlobal("fetch", fetcher);
  const report = await adapter.query(auth, new AbortController().signal, 5_000);
  assert.equal(fetcher.mock.calls.length, 1);
  assert.equal(report.buckets[0]?.remaining, 75);
  assert.equal(vi.getTimerCount(), 0);
});

test("Codex optional timeout releases the request without hiding usage", async () => {
  vi.useFakeTimers();
  let ready!: () => void;
  const started = new Promise<void>((resolve) => {
    ready = resolve;
  });
  let calls = 0;
  let aborted = false;
  vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
    if (++calls === 1) return Response.json(usage);
    return new Promise((_resolve, reject) => {
      init.signal?.addEventListener("abort", () => {
        aborted = true;
        reject(new DOMException("Aborted", "AbortError"));
      });
      ready();
    });
  });
  const pending = adapter.query(auth, new AbortController().signal, 5_000);
  await started;
  await vi.advanceTimersByTimeAsync(1_500);
  const report = await pending;
  assert.equal(aborted, true);
  assert.equal(report.buckets[0]?.remaining, 75);
  assert.equal(vi.getTimerCount(), 0);
});

test("Codex cancellation during optional body read rejects and cancels its stream", async () => {
  const controller = new AbortController();
  let calls = 0;
  let ready!: () => void;
  const started = new Promise<void>((resolve) => {
    ready = resolve;
  });
  let cancelled = false;
  vi.stubGlobal("fetch", async () => {
    if (++calls === 1) return Response.json(usage);
    return new Response(
      new ReadableStream({
        pull() {
          ready();
        },
        cancel() {
          cancelled = true;
        },
      }),
    );
  });
  const pending = adapter.query(auth, controller.signal, 5_000);
  await started;
  controller.abort();
  await assert.rejects(pending, { name: "AbortError" });
  assert.equal(cancelled, true);
});

test("Codex revalidates before optional request and after completion", async () => {
  for (const staleAt of [1, 2]) {
    let calls = 0;
    let guards = 0;
    vi.stubGlobal("fetch", async () => Response.json(++calls === 1 ? usage : { credits: [credit] }));
    await assert.rejects(
      adapter.query(auth, new AbortController().signal, 5_000, async () => {
        if (++guards === staleAt) throw new DOMException("Account changed", "AbortError");
      }),
      { name: "AbortError" },
    );
    assert.equal(calls, staleAt);
  }
});

test("Codex details retain every returned Codex status, not just redeemable options", () => {
  const details = normalizeCodexResetDetails({
    credits: [
      null,
      1,
      {},
      { ...credit, reset_type: "other" },
      ...["available", "redeemed", "expired", "redeeming", "future_status"].map((status) => ({
        ...credit,
        status,
        is_supported_by_plan: false,
      })),
    ],
  });
  assert.deepEqual(
    details?.map((item) => item.status),
    ["available", "redeemed", "expired", "redeeming", "future_status"],
  );
  assert.equal(normalizeCodexResetDetails(null), undefined);
  assert.deepEqual(normalizeCodexResetDetails({ credits: [] }), []);
});

test("Codex missing and malformed expiration dates remain unavailable", () => {
  for (const expires_at of [
    undefined,
    null,
    "",
    123,
    "bad",
    "2026-10-04",
    "2026-10-04T05:32:41",
    "2026-02-30T00:00:00Z",
  ]) {
    const report = normalizeCodexBackendPayload(usage, 0);
    report.codexResetCredits = normalizeCodexResetDetails({ credits: [{ ...credit, expires_at, status: null }] });
    assert.match(formatUsageReport(report, "current"), /Full reset · unavailable · expiration unavailable/);
    assert.doesNotMatch(formatUsageReport(report, "current"), /Does not expire|Invalid Date/);
  }
});

test("Codex reset rendering sanitizes untrusted fields without mutating report data", () => {
  const report = normalizeCodexBackendPayload(usage, 0);
  report.codexResetCredits = normalizeCodexResetDetails({
    credits: [{ ...credit, title: "\u001b[31mFull\nreset", status: "available\u0007" }],
  });
  const before = structuredClone(report);
  const text = formatUsageReport(report, "current");
  for (const unsafe of ["\u001b", "\u0007", "not-for-display"]) assert.equal(text.includes(unsafe), false);
  assert.match(text, /Full reset · available · expires/);
  assert.deepEqual(report, before);
  assert.equal(formatUsageStatusline(report), formatUsageStatusline(normalizeCodexBackendPayload(usage, 0)));
});

test("Codex expiration uses local timezone with date-specific DST offsets", () => {
  const previous = process.env.TZ;
  try {
    for (const [zone, date, offset, hour] of [
      ["America/New_York", "2026-01-04T05:32:41Z", "GMT-05:00", "12:32:41"],
      ["America/New_York", "2026-07-04T05:32:41Z", "GMT-04:00", "01:32:41"],
      ["Asia/Kolkata", "2026-10-04T05:32:41Z", "GMT+05:30", "11:02:41"],
    ] as const) {
      process.env.TZ = zone;
      const report = normalizeCodexBackendPayload(usage, 0);
      report.codexResetCredits = normalizeCodexResetDetails({ credits: [{ ...credit, expires_at: date }] });
      const text = formatUsageReport(report, "configured");
      assert.ok(text.includes(offset), text);
      assert.ok(text.includes(hour) || (hour === "12:32:41" && text.includes("00:32:41")), text);
      assert.match(text, /2026/);
    }
  } finally {
    if (previous === undefined) delete process.env.TZ;
    else process.env.TZ = previous;
  }
});
