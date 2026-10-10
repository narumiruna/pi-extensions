import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VERSION } from "@earendil-works/pi-coding-agent";
import { type TestContext, test } from "vitest";
import { createMockContext, createMockPi } from "../../../test/support.js";
import { registerCodexFastMode } from "../src/codex-fast-runtime.js";
import { createUsageSettingsRuntime } from "../src/settings.js";

const codexModel = {
  id: "gpt-5.6-sol",
  name: "GPT-5.6 Sol",
  api: "openai-codex-responses",
  provider: "openai-codex",
  baseUrl: "https://chatgpt.com/backend-api",
  reasoning: true,
  input: ["text"],
  cost: { input: 2.5, output: 15, cacheRead: 0.25, cacheWrite: 0 },
  contextWindow: 1_000_000,
  maxTokens: 128_000,
};

function catalogCredential(accountId = "catalog-account", signature = "signature") {
  const payload = Buffer.from(
    JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: accountId } }),
  ).toString("base64url");
  return {
    type: "oauth" as const,
    access: `fixture.${payload}.${signature}`,
    refresh: `fixture-refresh-${accountId}`,
    expires: Date.now() + 60_000,
    accountId,
  };
}

type FixtureCredential = ReturnType<typeof catalogCredential>;
type FixtureOptions = {
  enabled?: boolean;
  invalid?: boolean;
  model?: typeof codexModel;
  credential?: () => FixtureCredential;
  payload?: unknown;
  fetch?: (url: URL, init: RequestInit) => Response | Promise<Response>;
  failUpdates?: number;
  beforeWrite?: () => Promise<void>;
  beforeAuth?: () => Promise<void>;
};

async function fixture(t: TestContext, options: FixtureOptions = {}) {
  const directory = await mkdtemp(join(tmpdir(), "pi-fast-catalog-test-"));
  const path = join(directory, "pi-usage.json");
  const originalDocument = options.invalid
    ? '{"codexFastMode":"invalid"}'
    : JSON.stringify({ codexFastMode: options.enabled ?? false });
  await writeFile(path, originalDocument);
  let failures = options.failUpdates ?? 0;
  let writes = 0;
  const settings = createUsageSettingsRuntime({
    path,
    operations: {
      async writeFile(file, data, config) {
        writes += 1;
        if (failures > 0) {
          failures -= 1;
          throw new Error("disk full");
        }
        await options.beforeWrite?.();
        await writeFile(file, data, config);
      },
    },
  });
  await settings.reload();
  const credential = options.credential ?? (() => catalogCredential());
  const model = options.model ?? codexModel;
  const context = (currentModel = model, overrides: Record<string, unknown> = {}) =>
    createMockContext({
      hasUI: true,
      mode: "rpc",
      model: currentModel,
      sessionManager: { getSessionId: () => "session-a", getBranch: () => [], getEntries: () => [] },
      modelRegistry: {
        getApiKeyAndHeaders: async () => {
          await options.beforeAuth?.();
          return { ok: true, apiKey: credential().access };
        },
        getProviderAuth: async () => ({ source: "OAuth", auth: { apiKey: credential().access } }),
        getAvailable: () => [currentModel],
        getAll: () => [currentModel],
      },
      ...overrides,
    });
  const current = context();
  const originalFetch = globalThis.fetch;
  const requests: Array<{ url: URL; headers: Headers }> = [];
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(String(input));
    assert.equal(url.origin, "https://chatgpt.com");
    assert.equal(url.pathname, "/backend-api/codex/models");
    assert.equal(url.searchParams.get("client_version"), VERSION);
    assert.equal(init.method, "GET");
    requests.push({ url, headers: new Headers(init.headers) });
    const response = Promise.resolve(
      options.fetch?.(url, init) ??
        Response.json(
          options.payload ?? { models: [{ slug: codexModel.id, service_tiers: [{ id: "priority", name: "Fast" }] }] },
        ),
    );
    return new Promise<Response>((resolve, reject) => {
      const abort = () => reject(Object.assign(new Error("Fixture fetch aborted."), { name: "AbortError" }));
      const signal = init.signal;
      if (signal?.aborted) abort();
      else signal?.addEventListener("abort", abort, { once: true });
      response.then(
        (value) => {
          signal?.removeEventListener("abort", abort);
          resolve(value);
        },
        (error) => {
          signal?.removeEventListener("abort", abort);
          reject(error);
        },
      );
    });
  };
  const mock = createMockPi();
  let refreshes = 0;
  const fast = registerCodexFastMode(
    mock.pi,
    settings,
    () => {
      refreshes += 1;
    },
    {
      credentialReader: () => credential(),
    },
  );
  t.onTestFinished(async () => {
    try {
      await mock.events.get("session_shutdown")?.[0]?.({}, current.ctx);
    } finally {
      globalThis.fetch = originalFetch;
      await rm(directory, { recursive: true, force: true });
    }
  });
  const command = mock.commands.get("fast");
  const request = mock.events.get("before_provider_request")?.[0];
  const messageEnd = mock.events.get("message_end")?.[0];
  assert.ok(command);
  assert.ok(request);
  assert.ok(messageEnd);
  return {
    fast,
    mock,
    current,
    context,
    settings,
    requests,
    path,
    originalDocument,
    command,
    request,
    messageEnd,
    get writes() {
      return writes;
    },
    get refreshes() {
      return refreshes;
    },
  };
}

function assistantMessage() {
  return {
    role: "assistant",
    provider: "openai-codex",
    model: codexModel.id,
    usage: {
      input: 100,
      output: 20,
      cacheRead: 10,
      cacheWrite: 0,
      totalTokens: 130,
      cost: { input: 0.00025, output: 0.0003, cacheRead: 0.0000025, cacheWrite: 0, total: 0.0005525 },
    },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((release) => {
    resolve = release;
  });
  return { promise, resolve };
}

test("server-advertised future model enables Fast, status, and priority routing", async (t) => {
  const future = { ...codexModel, id: "future-codex-model", name: "Future Codex Model" };
  const f = await fixture(t, {
    model: future,
    payload: { models: [{ slug: future.id, service_tiers: [{ id: "priority" }] }] },
  });
  await f.command.handler("", f.current.ctx);
  assert.equal(f.settings.get().settings.codexFastMode, true);
  assert.equal(JSON.parse(await readFile(f.path, "utf8")).codexFastMode, true);
  assert.match(f.current.notifications[0]?.message ?? "", /1\.5× faster.*uses more/);
  assert.deepEqual(f.fast.availability(future as never), { kind: "available", enabled: true });
  assert.equal(f.fast.decorateStatus(future as never, "codex 80% 5h"), "codex fast 80% 5h");
  assert.deepEqual(await f.request({ payload: { model: future.id } }, f.current.ctx), {
    model: future.id,
    service_tier: "priority",
  });
  assert.equal(f.requests[0]?.headers.get("Authorization"), `Bearer ${catalogCredential().access}`);
  assert.equal(f.requests[0]?.headers.get("chatgpt-account-id"), "catalog-account");
  await f.command.handler("", f.current.ctx);
  assert.equal(f.settings.get().settings.codexFastMode, false);
  assert.equal(JSON.parse(await readFile(f.path, "utf8")).codexFastMode, false);
  assert.match(f.current.notifications[1]?.message ?? "", /standard routing/);
  assert.deepEqual(await f.request({ payload: { model: future.id } }, f.current.ctx), {
    model: future.id,
    service_tier: "default",
  });
  assert.equal(f.requests.length, 1);
  assert.equal(f.refreshes, 2);
});

test("legacy fast advertisement remains compatible with priority routing", async (t) => {
  const legacy = { ...codexModel, id: "legacy-codex-model" };
  const f = await fixture(t, {
    model: legacy,
    payload: { models: [{ slug: legacy.id, service_tiers: [], additional_speed_tiers: ["fast"] }] },
  });
  await f.command.handler("", f.current.ctx);
  assert.equal(f.settings.get().settings.codexFastMode, true);
  assert.deepEqual(await f.request({ payload: { model: legacy.id } }, f.current.ctx), {
    model: legacy.id,
    service_tier: "priority",
  });
});

test("model-directory responses larger than quota reports still enable advertised Fast", async (t) => {
  const f = await fixture(t, {
    payload: {
      models: [{ slug: codexModel.id, service_tiers: [{ id: "priority" }], base_instructions: "x".repeat(70 * 1024) }],
    },
  });
  await f.command.handler("", f.current.ctx);
  assert.equal(f.settings.get().settings.codexFastMode, true);
});

test("/fast rejects arguments and unsafe modes before filesystem or directory I/O", async (t) => {
  const f = await fixture(t);
  await f.command.handler("on", f.current.ctx);
  assert.match(f.current.notifications[0]?.message ?? "", /does not accept arguments/);
  for (const mode of ["print", "json"]) {
    const current = f.context(codexModel, { hasUI: false, mode });
    await assert.rejects(Promise.resolve(f.command.handler("", current.ctx)), /requires TUI or RPC/);
  }
  assert.equal(f.writes, 0);
  assert.equal(f.requests.length, 0);
});

test("foreign providers, APIs, and proxy origins remain outside Codex Fast discovery", async (t) => {
  const f = await fixture(t);
  for (const overrides of [
    { provider: "openai" },
    { provider: "openrouter" },
    { api: "openai-responses" },
    { baseUrl: "https://proxy.example.test" },
  ]) {
    const current = f.context({ ...codexModel, ...overrides });
    await f.command.handler("", current.ctx);
    assert.equal(current.notifications[0]?.level, "warning");
    assert.equal(await f.request({ payload: { model: codexModel.id } }, current.ctx), undefined);
  }
  assert.equal(f.writes, 0);
  assert.equal(f.requests.length, 0);
});

test("invalid settings stay intact and warn before attempting Fast discovery", async (t) => {
  const f = await fixture(t, { invalid: true });
  await f.command.handler("", f.current.ctx);
  assert.equal(f.current.notifications[0]?.level, "error");
  assert.equal(f.writes, 0);
  assert.equal(f.requests.length, 0);
  await f.mock.events.get("session_start")?.[0]?.({}, f.current.ctx);
  assert.match(f.current.notifications[1]?.message ?? "", /Invalid pi-usage\.json/);
  assert.equal(await readFile(f.path, "utf8"), f.originalDocument);
  assert.equal(f.refreshes, 1);
});

test("failed persistence preserves effective state and permits a retry", async (t) => {
  const f = await fixture(t, { failUpdates: 1 });
  await f.command.handler("", f.current.ctx);
  assert.equal(f.settings.get().settings.codexFastMode, false);
  assert.match(f.current.notifications[0]?.message ?? "", /disk full/);
  await f.command.handler("", f.current.ctx);
  assert.equal(f.settings.get().settings.codexFastMode, true);
});

test("provider payload captures the preference when its hook begins", async (t) => {
  let slow = false;
  const started = deferred<void>();
  const release = deferred<void>();
  const f = await fixture(t, {
    beforeAuth: async () => {
      if (slow) {
        started.resolve();
        await release.promise;
      }
    },
  });
  await f.command.handler("", f.current.ctx);
  slow = true;
  const pending = f.request({ payload: { model: codexModel.id } }, f.current.ctx);
  await started.promise;
  await f.command.handler("", f.current.ctx);
  release.resolve();
  assert.deepEqual(await pending, { model: codexModel.id, service_tier: "priority" });
  assert.deepEqual(await f.request({ payload: { model: codexModel.id } }, f.current.ctx), {
    model: codexModel.id,
    service_tier: "default",
  });
});

test("cost correction follows captured priority after the setting is disabled", async (t) => {
  const f = await fixture(t);
  await f.command.handler("", f.current.ctx);
  await f.request({ payload: { model: codexModel.id } }, f.current.ctx);
  await f.command.handler("", f.current.ctx);
  const correction = (await f.messageEnd({ message: assistantMessage() }, f.current.ctx)) as {
    message: ReturnType<typeof assistantMessage>;
  };
  assert.ok(Math.abs(correction.message.usage.cost.total - 0.001105) < 1e-12);
  assert.equal(await f.messageEnd({ message: assistantMessage() }, f.current.ctx), undefined);
});

test("an already-correct message still consumes its request marker", async (t) => {
  const f = await fixture(t, { enabled: true });
  await f.fast.refreshCapabilities(f.current.ctx);
  await f.request({ payload: { model: codexModel.id } }, f.current.ctx);
  const message = assistantMessage();
  // Exact floating-point values emitted by Pi for this worked cost example.
  message.usage.cost = {
    input: 0.0005,
    output: 0.0006000000000000001,
    cacheRead: 0.0000049999999999999996,
    cacheWrite: 0,
    total: 0.001105,
  };
  assert.equal(await f.messageEnd({ message }, f.current.ctx), undefined);
  message.usage.cost.total = 0;
  assert.equal(await f.messageEnd({ message }, f.current.ctx), undefined);
});

test("session replacement aborts queued Fast writes before UI publication", async (t) => {
  const started = deferred<void>();
  const release = deferred<void>();
  const f = await fixture(t, {
    beforeWrite: async () => {
      started.resolve();
      await release.promise;
    },
  });
  const pendingToggle = f.command.handler("", f.current.ctx);
  await started.promise;
  const replacement = f.context(codexModel, {
    sessionManager: { getSessionId: () => "session-b", getBranch: () => [], getEntries: () => [] },
  });
  const replacementLoad = f.mock.events.get("session_start")?.[0]?.({}, replacement.ctx);
  release.resolve();
  await Promise.all([pendingToggle, replacementLoad]);
  assert.deepEqual(f.current.notifications, []);
  assert.equal(f.settings.get().settings.codexFastMode, false);
  assert.equal(JSON.parse(await readFile(f.path, "utf8")).codexFastMode, false);
});

test.for([
  { name: "missing model", payload: { models: [] }, kind: "unknown" },
  { name: "missing capability fields", payload: { models: [{ slug: codexModel.id }] }, kind: "unknown" },
  {
    name: "explicitly unsupported model",
    payload: { models: [{ slug: codexModel.id, service_tiers: [] }] },
    kind: "unavailable",
  },
  {
    name: "malformed service tiers",
    payload: { models: [{ slug: codexModel.id, service_tiers: "priority" }] },
    kind: "unknown",
  },
])("$name uses default instead of claiming Fast", async ({ payload, kind }, t) => {
  const f = await fixture(t, { payload });
  await f.command.handler("", f.current.ctx);
  assert.equal(f.fast.availability(codexModel as never).kind, kind);
  assert.equal(f.settings.get().settings.codexFastMode, false);
  assert.equal(f.current.notifications[0]?.level, "warning");
  assert.deepEqual(await f.request({ payload: { model: codexModel.id } }, f.current.ctx), {
    model: codexModel.id,
    service_tier: "default",
  });
});

test("initial directory failure shows unknown, routes default, and still permits disabling the preference", async (t) => {
  const f = await fixture(t, {
    enabled: true,
    fetch: async () => {
      throw new TypeError("Network unavailable.");
    },
  });
  await f.fast.refreshCapabilities(f.current.ctx);
  assert.equal(f.fast.availability(codexModel as never).kind, "unknown");
  assert.match(f.fast.decorateStatus(codexModel as never, "codex 80% 5h"), /Fast unknown/);
  assert.deepEqual(await f.request({ payload: { model: codexModel.id } }, f.current.ctx), {
    model: codexModel.id,
    service_tier: "default",
  });
  await f.command.handler("", f.current.ctx);
  assert.equal(f.settings.get().settings.codexFastMode, false);
});

test("a transient directory failure preserves this account's successful capability cache", async (t) => {
  let offline = false;
  const f = await fixture(t, {
    fetch: async () => {
      if (offline) throw new TypeError("Network unavailable.");
      return Response.json({ models: [{ slug: codexModel.id, service_tiers: [{ id: "priority" }] }] });
    },
  });
  await f.command.handler("", f.current.ctx);
  offline = true;
  await f.fast.refreshCapabilities(f.current.ctx, undefined, true);
  assert.deepEqual(f.fast.availability(codexModel as never), { kind: "available", enabled: true });
  assert.deepEqual(await f.request({ payload: { model: codexModel.id } }, f.current.ctx), {
    model: codexModel.id,
    service_tier: "priority",
  });
});

test("authentication rejection invalidates cached capability and redacts account secrets", async (t) => {
  let denied = false;
  const credential = catalogCredential();
  const f = await fixture(t, {
    fetch: async () =>
      denied
        ? new Response(`Denied ${credential.accountId} Bearer ${credential.access}`, { status: 403 })
        : Response.json({ models: [{ slug: codexModel.id, service_tiers: [{ id: "priority" }] }] }),
  });
  await f.command.handler("", f.current.ctx);
  denied = true;
  await f.fast.refreshCapabilities(f.current.ctx, undefined, true);
  const availability = f.fast.availability(codexModel as never);
  assert.equal(availability.kind, "unknown");
  if (availability.kind === "unknown") {
    assert.ok(!availability.reason.includes(credential.access));
    assert.ok(!availability.reason.includes(credential.accountId));
  }
  assert.deepEqual(await f.request({ payload: { model: codexModel.id } }, f.current.ctx), {
    model: codexModel.id,
    service_tier: "default",
  });
});

test("account changes isolate capability while preserving the earlier request's cost snapshot", async (t) => {
  let credential = catalogCredential("account-a");
  const f = await fixture(t, {
    credential: () => credential,
    fetch: async (_url, init) =>
      Response.json({
        models: [
          {
            slug: codexModel.id,
            service_tiers:
              new Headers(init.headers).get("chatgpt-account-id") === "account-a" ? [{ id: "priority" }] : [],
          },
        ],
      }),
  });
  await f.command.handler("", f.current.ctx);
  await f.request({ payload: { model: codexModel.id } }, f.current.ctx);
  credential = catalogCredential("account-b");
  await f.fast.refreshCapabilities(f.current.ctx, undefined, true);
  assert.equal(f.fast.availability(codexModel as never).kind, "unavailable");
  const correction = (await f.messageEnd({ message: assistantMessage() }, f.current.ctx)) as {
    message: ReturnType<typeof assistantMessage>;
  };
  assert.ok(Math.abs(correction.message.usage.cost.total - 0.001105) < 1e-12);
  assert.deepEqual(await f.request({ payload: { model: codexModel.id } }, f.current.ctx), {
    model: codexModel.id,
    service_tier: "default",
  });
});

test("an old account's late directory response cannot authorize the new account", async (t) => {
  let credential = catalogCredential("account-a");
  const started = deferred<void>();
  const response = deferred<Response>();
  const f = await fixture(t, {
    credential: () => credential,
    fetch: async (_url, init) => {
      if (new Headers(init.headers).get("chatgpt-account-id") === "account-a") {
        started.resolve();
        return response.promise;
      }
      return Response.json({ models: [{ slug: codexModel.id, service_tiers: [] }] });
    },
  });
  const pending = f.command.handler("", f.current.ctx);
  await started.promise;
  credential = catalogCredential("account-b");
  await f.fast.refreshCapabilities(f.current.ctx, undefined, true);
  response.resolve(Response.json({ models: [{ slug: codexModel.id, service_tiers: [{ id: "priority" }] }] }));
  await pending;
  assert.equal(f.settings.get().settings.codexFastMode, false);
  assert.equal(f.fast.availability(codexModel as never).kind, "unavailable");
});

test("model switching and request routing stay responsive while discovering a new model", async (t) => {
  let discovering = false;
  const started = deferred<void>();
  const response = deferred<Response>();
  const f = await fixture(t, {
    fetch: async () => {
      if (discovering) {
        started.resolve();
        return response.promise;
      }
      return Response.json({ models: [{ slug: codexModel.id, service_tiers: [{ id: "priority" }] }] });
    },
  });
  await f.command.handler("", f.current.ctx);
  const future = { ...codexModel, id: "newly-discovered-model" };
  const payload = { models: [{ slug: future.id, service_tiers: [{ id: "priority" }] }] };
  const next = f.context(future);
  discovering = true;
  const selection = f.mock.events.get("model_select")?.[0]?.({ model: future }, next.ctx);
  await started.promise;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      Promise.resolve(selection),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("Model selection awaited the model-directory response.")), 1_000);
      }),
    ]);
    assert.deepEqual(await f.request({ payload: { model: future.id } }, next.ctx), {
      model: future.id,
      service_tier: "default",
    });
    response.resolve(Response.json(payload));
    await f.fast.refreshCapabilities(next.ctx);
    assert.deepEqual(await f.request({ payload: { model: future.id } }, next.ctx), {
      model: future.id,
      service_tier: "priority",
    });
  } finally {
    clearTimeout(timer);
    response.resolve(Response.json(payload));
  }
});
