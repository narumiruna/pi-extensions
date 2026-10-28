import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test, vi } from "vitest";
import { deferred, usageApiRuntime } from "./fixtures/usage-api-runtime.js";

for (const mode of ["tui", "rpc", "json", "print"] as const) {
  test(`API refresh is read-only and works without presentation in ${mode} mode`, async () => {
    const runtime = await usageApiRuntime({ mode });
    try {
      const statuses = [...runtime.context.statuses];
      const notifications = [...runtime.context.notifications];
      const activeTools = runtime.pi.getActiveTools();
      const toolDefinitions = structuredClone(runtime.pi.getAllTools());
      const first = await runtime.query({ refresh: true });
      assert.equal(first.status, "ready");
      if (first.status !== "ready") return;
      assert.equal(first.source, "refresh");
      assert.equal(first.providerId, "openrouter");
      assert.equal(first.report.metrics.find((metric) => metric.id === "usage-total")?.value, 25);
      assert.ok(first.expiresAt > Date.now());
      assert.equal(runtime.fetches.length, 1);
      first.report.metrics.length = 0;
      const cached = await runtime.query();
      assert.deepEqual(cached, { status: "unavailable", providerId: "openrouter", reason: "cache-miss" });
      const second = await runtime.query({ refresh: true });
      assert.equal(second.status, "ready");
      if (second.status === "ready") assert.ok(second.report.metrics.length > 0);
      assert.equal(runtime.fetches.length, 2);
      assert.deepEqual([...runtime.context.statuses], statuses);
      assert.deepEqual(runtime.context.notifications, notifications);
      assert.deepEqual(runtime.pi.getActiveTools(), activeTools);
      assert.deepEqual(runtime.pi.getAllTools(), toolDefinitions);
      assert.deepEqual(runtime.mock.sentMessages, []);
      assert.deepEqual(runtime.mock.sentUserMessages, []);
      assert.deepEqual(runtime.mock.entries, []);
      assert.equal(existsSync(join(runtime.directory, "pi-usage.json")), false);
      assert.ok(!JSON.stringify(second).includes("synthetic-api-key"));
    } finally {
      await runtime.close();
    }
  });
}

test("all cache-only auth classes avoid auth resolution, commands, credential-source dispatch, and fetch", async () => {
  const runtime = await usageApiRuntime();
  try {
    let sources = 0;
    runtime.pi.events.on("oauth:credential-source:v1", () => {
      sources++;
    });
    runtime.pi.events.on("oauth:credential-readiness:v1", () => {
      sources++;
    });
    runtime.onAuth(async () => {
      throw new Error("auth must not run");
    });
    for (const providerId of [
      "openrouter",
      "openai",
      "openai-codex",
      "github-copilot",
      "xai",
      "fireworks",
      "deepseek",
      "minimax",
      "moonshotai",
    ]) {
      assert.deepEqual(await runtime.query({ providerId }), {
        status: "unavailable",
        providerId,
        reason: "cache-miss",
      });
    }
    assert.equal(runtime.authCalls(), 0);
    assert.equal(runtime.fetches.length, 0);
    assert.equal(sources, 0);
  } finally {
    await runtime.close();
  }
});

test("refresh bypasses reports but preserves failure backoff and does not return an old report", async () => {
  const runtime = await usageApiRuntime();
  try {
    assert.equal((await runtime.query({ refresh: true })).status, "ready");
    runtime.onFetch(async () => new Response("provider body contains synthetic-api-key", { status: 503 }));
    assert.deepEqual(await runtime.query({ refresh: true }), {
      status: "unavailable",
      providerId: "openrouter",
      reason: "query-failed",
    });
    assert.equal(runtime.fetches.length, 2);
    assert.deepEqual(await runtime.query({ refresh: true }), {
      status: "unavailable",
      providerId: "openrouter",
      reason: "query-failed",
    });
    assert.equal(runtime.fetches.length, 2);
    assert.ok(runtime.changes.some((event) => event.reason === "query-failed"));
  } finally {
    await runtime.close();
  }
});

test("API timeout includes waiting for queued settings publication", async () => {
  const runtime = await usageApiRuntime();
  const hold = deferred<void>();
  const original = runtime.settings.flush;
  runtime.settings.flush = () => hold.promise;
  vi.useFakeTimers();
  try {
    const pending = runtime.query({ refresh: true, timeoutMs: 20_000 });
    await vi.advanceTimersByTimeAsync(15_000);
    assert.deepEqual(await pending, { status: "unavailable", providerId: "openrouter", reason: "timeout" });
    assert.equal(runtime.authCalls(), 0);
    assert.equal(runtime.fetches.length, 0);
    hold.resolve();
    await vi.runAllTimersAsync();
    assert.equal(runtime.fetches.length, 0);
    assert.equal(vi.getTimerCount(), 0);
  } finally {
    runtime.settings.flush = original;
    vi.useRealTimers();
    await runtime.close();
  }
});

test("settings changes during a queued publication cannot apply an old policy to refresh", async () => {
  const runtime = await usageApiRuntime();
  const hold = deferred<void>();
  const started = deferred<void>();
  runtime.settings.flush = () => {
    started.resolve();
    return hold.promise;
  };
  try {
    const pending = runtime.query({ refresh: true });
    await started.promise;
    await runtime.settings.update({ openaiUseCodexUsage: true });
    hold.resolve();
    assert.deepEqual(await pending, { status: "unavailable", providerId: "openrouter", reason: "stale-context" });
    assert.equal(runtime.fetches.length, 0);
  } finally {
    hold.resolve();
    await runtime.close();
  }
});

test("target discovery never selects or persists a billing target through the API", async () => {
  const runtime = await usageApiRuntime({
    model: {
      id: "accounts/fireworks/models/example",
      name: "Example",
      provider: "fireworks",
      baseUrl: "https://api.fireworks.ai/inference",
    },
  });
  try {
    runtime.onFetch(
      async () =>
        new Response(
          JSON.stringify({
            accounts: [
              { name: "accounts/alpha", displayName: "Alpha" },
              { name: "accounts/beta", displayName: "Beta" },
            ],
          }),
        ),
    );
    assert.deepEqual(await runtime.query({ refresh: true }), {
      status: "unavailable",
      providerId: "fireworks",
      reason: "selection-required",
    });
    assert.equal(runtime.fetches.length, 1);
    assert.equal(existsSync(join(runtime.directory, "pi-usage.json")), false);
    assert.ok(runtime.fetches.every((request) => !request.input.includes("billing")));
  } finally {
    await runtime.close();
  }
});

test("native OpenAI refresh cannot enable the companion opt-in or forward native tokens", async () => {
  const access = "synthetic-native-access";
  const runtime = await usageApiRuntime({
    source: "OAuth",
    model: { id: "gpt-native", name: "Native", provider: "openai", baseUrl: "https://api.openai.com/v1" },
    credential: {
      type: "oauth",
      access,
      refresh: "synthetic-native-refresh",
      expires: Date.now() + 3_600_000,
      clientId: "native-client",
      scopes: ["chatgpt.tokens.use.direct"],
    },
  });
  runtime.key(access);
  try {
    const result = await runtime.query({ refresh: true });
    assert.equal(result.status, "ready");
    assert.equal(runtime.fetches.length, 0);
    assert.equal(runtime.settings.get().settings.openaiUseCodexUsage, false);
    assert.equal(existsSync(join(runtime.directory, "pi-usage.json")), false);
    assert.ok(!JSON.stringify(result).includes(access));
  } finally {
    await runtime.close();
  }
});

test("API rejects custom origins without making a provider request", async () => {
  const runtime = await usageApiRuntime({
    model: { id: "proxy", name: "Proxy", provider: "openrouter", baseUrl: "https://proxy.invalid/v1" },
  });
  try {
    assert.deepEqual(await runtime.query({ refresh: true }), {
      status: "unavailable",
      providerId: "openrouter",
      reason: "auth-unavailable",
    });
    assert.equal(runtime.fetches.length, 0);
  } finally {
    await runtime.close();
  }
});

test("refresh publishes cache state before invalidation hints and cache reads do not loop", async () => {
  const runtime = await usageApiRuntime();
  try {
    const nested: ReturnType<typeof runtime.query>[] = [];
    const off = runtime.pi.events.on("usage:changed:v1", (event) => {
      const change = event as { reason: string };
      if (change.reason === "updated") nested.push(runtime.query());
    });
    assert.equal((await runtime.query({ refresh: true })).status, "ready");
    assert.equal(nested.length, 1);
    assert.equal((await nested[0])?.status, "unavailable");
    assert.equal(runtime.fetches.length, 1);
    assert.equal(runtime.changes.filter((event) => event.reason === "updated").length, 1);
    for (const change of runtime.changes) {
      assert.deepEqual(
        Object.keys(change).sort(),
        ["changedAt", "providerId", "reason", "session", "sessionId"].sort(),
      );
    }
    off();
  } finally {
    await runtime.close();
  }
});

test("an existing scheduled report and an API refresh use the same cache publication boundary", async () => {
  const runtime = await usageApiRuntime({ mode: "rpc" });
  try {
    // Selecting OpenRouter starts its existing scheduled status path, not an API-owned UI path.
    Object.assign(runtime.currentModel, runtime.providerModel);
    const published = deferred<void>();
    const setStatus = runtime.ctx.ui.setStatus.bind(runtime.ctx.ui);
    runtime.ctx.ui.setStatus = (key, value) => {
      setStatus(key, value);
      if (key === "usage" && value !== undefined && value !== "checking") published.resolve();
    };
    await runtime.emit("turn_start");
    await published.promise;
    assert.ok(runtime.context.statuses.has("usage"));
    const statuses = [...runtime.context.statuses];
    assert.equal((await runtime.query({ refresh: true })).status, "ready");
    assert.deepEqual([...runtime.context.statuses], statuses);
    assert.equal(runtime.changes.filter((event) => event.reason === "updated").length, 2);
  } finally {
    await runtime.close();
  }
});

test("refresh does not rewrite a persisted settings file", async () => {
  const runtime = await usageApiRuntime();
  try {
    await runtime.settings.update({ codexStatusPercentage: "used" });
    const path = join(runtime.directory, "pi-usage.json");
    const bytes = readFileSync(path, "utf8");
    assert.equal((await runtime.query({ refresh: true })).status, "ready");
    assert.equal(readFileSync(path, "utf8"), bytes);
  } finally {
    await runtime.close();
  }
});

test("a malformed provider response is unavailable without raw provider diagnostics", async () => {
  const runtime = await usageApiRuntime();
  try {
    runtime.onFetch(async () => new Response(JSON.stringify({ data: { usage: "synthetic-api-key" } })));
    const result = await runtime.query({ refresh: true });
    assert.deepEqual(result, { status: "unavailable", providerId: "openrouter", reason: "query-failed" });
    assert.ok(!JSON.stringify(result).includes("synthetic-api-key"));
  } finally {
    await runtime.close();
  }
});
