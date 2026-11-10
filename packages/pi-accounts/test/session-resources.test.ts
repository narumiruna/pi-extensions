import assert from "node:assert/strict";
import { InMemoryCredentialStore, registerSessionResourceCleanup } from "@earendil-works/pi-ai";
import {
  type ExtensionCommandContext,
  type ExtensionContext,
  ModelRegistry,
  ModelRuntime,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import { test } from "vitest";
import { createMockContext, createMockPi } from "../../../test/support.js";
import { AccountStore, InMemoryAccountStorageBackend } from "../src/account-store.js";
import accountsExtension, { ACCOUNTS_STATUS_KEY, FAIL_CLOSED_API_KEY } from "../src/accounts.js";
import type { AccountActivationResult } from "../src/accounts-protocol.js";
import { createBuiltinProviderAdapters } from "../src/oauth.js";
import { OAUTH_CREDENTIAL_READINESS_CHANNEL } from "../src/oauth-credential-source.js";
import { isolateAccountEnvironment } from "./isolate-account-environment.js";

isolateAccountEnvironment();

async function fixture(id: "anthropic" | "openrouter", active?: string) {
  const adapters = createBuiltinProviderAdapters().filter(
    (provider) => provider.id === "anthropic" || provider.id === "openrouter",
  );
  const adapter = adapters.find((provider) => provider.id === id);
  assert.ok(adapter);
  const runtime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsPath: null,
    refreshOnCreate: false,
  });
  const registry = new ModelRegistry(runtime);
  const model = registry.getAll().find((candidate) => candidate.provider === id);
  assert.ok(model);
  const store = new AccountStore(new InMemoryAccountStorageBackend());
  await store.updateProvider(id, () => ({
    ...(active ? { active } : {}),
    accounts: {
      personal: { type: "api_key", key: "sk-personal-fixture" },
      work: { type: "api_key", key: "sk-work-fixture" },
    },
  }));
  const mock = createMockPi();
  const selections: string[] = [];
  let idle = true;
  let aborts = 0;
  let run = new AbortController();
  const context = createMockContext({
    mode: "rpc",
    hasUI: true,
    model,
    modelRegistry: registry,
    sessionManager: SessionManager.inMemory(process.cwd()),
    isIdle: () => idle,
    abort: () => {
      aborts++;
      run.abort();
    },
    select: async (_title: string, values: string[]) => {
      const selected = selections.shift();
      if (selected !== undefined) assert.ok(values.includes(selected), `Missing option: ${selected}`);
      return selected;
    },
  });
  const ctx: ExtensionCommandContext = context.ctx;
  Object.defineProperty(ctx, "signal", { get: () => run.signal });
  accountsExtension(mock.pi, { store, providers: adapters });
  const emit = async (name: string, current: ExtensionContext = ctx) => {
    const handler = mock.events.get(name)?.[0];
    assert.ok(handler);
    await handler({ model: current.model }, current);
  };
  return {
    ...context,
    ctx,
    adapter,
    registry,
    store,
    emit,
    setIdle(value: boolean) {
      idle = value;
    },
    aborts: () => aborts,
    newRun() {
      run = new AbortController();
    },
    activate(account: string | null) {
      return new Promise<AccountActivationResult>((reply) => {
        mock.eventBus.emit("accounts:activation:v1", { session: ctx.sessionManager, provider: id, account, reply });
      });
    },
    setModel(provider: string) {
      const selected = registry.getAll().find((candidate) => candidate.provider === provider);
      assert.ok(selected);
      Object.assign(ctx, { model: selected });
    },
    async ready(current: ExtensionContext = ctx, provider = id) {
      const tasks: Promise<unknown>[] = [];
      mock.eventBus.emit(OAUTH_CREDENTIAL_READINESS_CHANNEL, {
        session: current.sessionManager,
        provider,
        waitUntil: (task: Promise<unknown>) => tasks.push(task),
      });
      assert.equal(tasks.length, 1);
      await Promise.all(tasks);
    },
    async start() {
      await emit("session_start");
      await emit("before_agent_start");
    },
    async select(name: string) {
      selections.push(`Switch ${adapter.displayName} account`, name);
      await mock.commands.get("accounts")?.handler("", ctx);
      assert.deepEqual(selections, []);
    },
  };
}

test("every built-in adapter clears only the requested session through Pi's public cleanup", async () => {
  const calls: Array<string | undefined> = [];
  const unregister = registerSessionResourceCleanup((sessionId) => calls.push(sessionId));
  try {
    const adapters = createBuiltinProviderAdapters();
    for (const adapter of adapters) {
      assert.equal(typeof adapter.invalidateConnections, "function", adapter.id);
      await adapter.invalidateConnections?.(`session-${adapter.id}`);
    }
    assert.deepEqual(
      calls,
      adapters.map((adapter) => `session-${adapter.id}`),
    );
  } finally {
    unregister();
  }
});

test("an explicit Codex cleanup override is preserved without invoking the default cleanup", async () => {
  const defaults: Array<string | undefined> = [];
  const overrides: Array<string | undefined> = [];
  const unregister = registerSessionResourceCleanup((sessionId) => defaults.push(sessionId));
  try {
    const adapter = createBuiltinProviderAdapters({
      closeCodexWebSockets: (sessionId) => overrides.push(sessionId),
    }).find((provider) => provider.id === "openai-codex");
    assert.ok(adapter?.invalidateConnections);
    await adapter.invalidateConnections("codex-session");
    assert.deepEqual(overrides, ["codex-session"]);
    assert.deepEqual(defaults, []);
  } finally {
    unregister();
  }
});

for (const id of ["anthropic", "openrouter"] as const) {
  test(`${id} clears continuation state only when the applied authentication identity changes`, async () => {
    const f = await fixture(id);
    const sessionId = f.ctx.sessionManager.getSessionId();
    const calls: Array<string | undefined> = [];
    const state = new Set([sessionId, "unrelated-session"]);
    const unregister = registerSessionResourceCleanup((owner) => {
      calls.push(owner);
      if (owner) state.delete(owner);
      else state.clear();
    });
    try {
      await f.start();
      assert.deepEqual(calls, [], "first observation of default auth must preserve state");
      await f.select("personal");
      assert.deepEqual(calls, [sessionId]);
      assert.equal(await f.registry.getApiKeyForProvider(id), "sk-personal-fixture");
      assert.equal(state.has(sessionId), false);
      assert.equal(state.has("unrelated-session"), true);

      state.add(sessionId);
      await f.emit("before_agent_start");
      await f.store.updateProvider(id, (provider) => ({ ...provider, future: "metadata only" }));
      await f.emit("model_select");
      assert.deepEqual(calls, [sessionId]);
      assert.equal(state.has(sessionId), true, "ordinary requests must retain continuation state");

      await f.store.updateProvider(id, (provider) => ({
        ...provider,
        accounts: { ...provider.accounts, personal: { type: "api_key", key: "sk-replaced-fixture" } },
      }));
      await f.emit("model_select");
      assert.deepEqual(calls, [sessionId, sessionId]);
      assert.equal(await f.registry.getApiKeyForProvider(id), "sk-replaced-fixture");
      assert.equal(state.has(sessionId), false);

      await f.select("work");
      assert.equal(await f.registry.getApiKeyForProvider(id), "sk-work-fixture");
      await f.select("default");
      assert.notEqual(await f.registry.getApiKeyForProvider(id), "sk-work-fixture");
      await f.emit("before_agent_start");
      assert.deepEqual(calls, Array(4).fill(sessionId));
      await f.select("personal");
      assert.deepEqual(calls, Array(5).fill(sessionId));
      assert.equal(state.has("unrelated-session"), true);
    } finally {
      unregister();
      await f.emit("session_shutdown");
    }
  });

  test(`${id} clears resumed named-account state once and fails closed if cleanup fails`, async () => {
    const f = await fixture(id, "work");
    const calls: Array<string | undefined> = [];
    let fail = true;
    const unregister = registerSessionResourceCleanup((sessionId) => {
      calls.push(sessionId);
      if (fail) throw new Error("fixture cleanup failure");
    });
    try {
      await f.start();
      assert.equal(await f.registry.getApiKeyForProvider(id), FAIL_CLOSED_API_KEY);
      assert.match(f.statuses.get(ACCOUNTS_STATUS_KEY) ?? "", /auth error/u);
      assert.deepEqual(calls, [f.ctx.sessionManager.getSessionId()]);

      fail = false;
      await f.emit("before_agent_start");
      assert.equal(await f.registry.getApiKeyForProvider(id), "sk-work-fixture");
      assert.equal(f.statuses.get(ACCOUNTS_STATUS_KEY), "account:work");
      await f.emit("before_agent_start");
      assert.deepEqual(calls, Array(2).fill(f.ctx.sessionManager.getSessionId()));
    } finally {
      unregister();
      await f.emit("session_shutdown");
    }
  });
}

test("delayed background authentication cannot interrupt another provider's active stream", async () => {
  const f = await fixture("anthropic", "work");
  const codex = f.registry.getAll().find((model) => model.provider === "openai-codex");
  assert.ok(codex);
  const streaming: ExtensionContext = { ...f.ctx, model: codex, isIdle: () => false };
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const read = f.store.readProviderAsync.bind(f.store);
  let blocked = false;
  f.store.readProviderAsync = async (...args) => {
    if (!blocked) {
      blocked = true;
      started.resolve();
      await release.promise;
    }
    return read(...args);
  };
  let busy = true;
  let interrupted = false;
  let cleanups = 0;
  const unregister = registerSessionResourceCleanup(() => {
    cleanups++;
    if (busy) interrupted = true;
  });
  try {
    await f.emit("session_start", streaming);
    await started.promise;
    release.resolve();
    await f.ready(streaming);
    assert.equal(await f.registry.getApiKeyForProvider("anthropic"), "sk-work-fixture");
    assert.equal(interrupted, false);
    assert.equal(cleanups, 0);

    f.setIdle(false);
    await f.emit("model_select");
    assert.equal(cleanups, 0, "model changes during a run must defer session-wide cleanup");
    assert.equal(f.aborts(), 1, "a provider switch with pending authentication must cancel the old run");
    busy = false;
    f.newRun();
    await f.emit("turn_start");
    assert.equal(cleanups, 1);
    assert.equal(interrupted, false);
    await f.emit("turn_start");
    assert.equal(cleanups, 1, "ordinary turns must not reset strict-tool or thread state");
  } finally {
    release.resolve();
    unregister();
    await f.emit("session_shutdown");
  }
});

for (const outcome of ["success", "failure", "shutdown"] as const) {
  test(`pending cleanup handles ${outcome} at the awaited pre-request boundary`, async () => {
    const f = await fixture("anthropic", "work");
    f.setIdle(false);
    let calls = 0;
    const unregister = registerSessionResourceCleanup(() => {
      calls++;
      if (outcome === "failure") throw new Error("pre-request cleanup failed");
    });
    try {
      await f.start();
      assert.equal(calls, 0, "before_agent_start is not an idle boundary");
      if (outcome === "shutdown") await f.emit("session_shutdown");
      await f.emit("turn_start");
      assert.equal(calls, outcome === "shutdown" ? 0 : 1);
      assert.equal(f.aborts(), outcome === "failure" ? 1 : 0);
      assert.equal(
        await f.registry.getApiKeyForProvider("anthropic"),
        outcome === "failure" ? FAIL_CLOSED_API_KEY : outcome === "shutdown" ? undefined : "sk-work-fixture",
      );
    } finally {
      unregister();
      await f.emit("session_shutdown");
    }
  });
}

for (const replacement of ["routine sync", "provider switch"] as const) {
  test(`a superseding ${replacement} cancels the old boundary and preserves pending cleanup`, async () => {
    const f = await fixture("anthropic", "work");
    await f.store.updateProvider("openrouter", () => ({
      active: "work",
      accounts: { work: { type: "api_key", key: "sk-gateway-fixture" } },
    }));
    f.setIdle(false);
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let calls = 0;
    const unregister = registerSessionResourceCleanup(() => calls++);
    let boundary: Promise<void> | undefined;
    try {
      await f.start();
      await f.ready(f.ctx, "openrouter");
      const read = f.store.readProviderAsync.bind(f.store);
      let blocked = false;
      f.store.readProviderAsync = async (...args) => {
        if (args[0] === "anthropic" && !blocked) {
          blocked = true;
          started.resolve();
          await release.promise;
        }
        return read(...args);
      };
      boundary = f.emit("turn_start");
      await started.promise;
      if (replacement === "provider switch") f.setModel("openrouter");
      await f.emit("model_select");
      assert.equal(f.ctx.signal?.aborted, true);
      assert.equal(calls, 0);
      release.resolve();
      await boundary;
      assert.equal(calls, 0, "the cancelled boundary must not clear the replacement provider");
      f.newRun();
      await f.emit("before_agent_start");
      await f.emit("turn_start");
      assert.equal(calls, 1, "the next request must not escape with cleanup still pending");
      if (replacement === "provider switch") {
        f.setModel("anthropic");
        await f.emit("turn_start");
        assert.equal(calls, 2, "the previous provider keeps its own pending invalidation");
      }
    } finally {
      release.resolve();
      await boundary;
      unregister();
      await f.emit("session_shutdown");
    }
  });
}

test("run cancellation releases a blocked pre-request wait and preserves cleanup for retry", async () => {
  const f = await fixture("anthropic", "work");
  f.setIdle(false);
  const controller = new AbortController();
  const current: ExtensionContext = { ...f.ctx, signal: controller.signal };
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let readSignal: AbortSignal | undefined;
  let calls = 0;
  const unregister = registerSessionResourceCleanup(() => calls++);
  let boundary: Promise<void> | undefined;
  try {
    await f.start();
    const read = f.store.readProviderAsync.bind(f.store);
    let blocked = false;
    f.store.readProviderAsync = async (...args) => {
      if (!blocked) {
        blocked = true;
        readSignal = args[1];
        started.resolve();
        await release.promise;
      }
      return read(...args);
    };
    boundary = f.emit("turn_start", current);
    await started.promise;
    controller.abort();
    await boundary;
    assert.equal(readSignal?.aborted, true);
    assert.equal(calls, 0);
    release.resolve();
    await f.ready();
    await f.emit("before_agent_start");
    await f.emit("turn_start");
    assert.equal(calls, 1);
    assert.equal(await f.registry.getApiKeyForProvider("anthropic"), "sk-work-fixture");
  } finally {
    release.resolve();
    await boundary;
    unregister();
    await f.emit("session_shutdown");
  }
});

test("credential replacement during a run cancels it and leaves cleanup for the next request", async () => {
  const f = await fixture("anthropic", "work");
  let calls = 0;
  const unregister = registerSessionResourceCleanup(() => calls++);
  try {
    await f.start();
    f.setIdle(false);
    await f.emit("turn_start");
    await f.store.updateProvider("anthropic", (provider) => ({
      ...provider,
      accounts: { ...provider.accounts, work: { type: "api_key", key: "sk-replaced-fixture" } },
    }));
    await f.ready();
    assert.equal(f.ctx.signal?.aborted, true);
    assert.equal(f.aborts(), 1);
    assert.equal(calls, 1);
    f.newRun();
    await f.emit("before_agent_start");
    await f.emit("turn_start");
    assert.equal(calls, 2);
    assert.equal(await f.registry.getApiKeyForProvider("anthropic"), "sk-replaced-fixture");
  } finally {
    unregister();
    await f.emit("session_shutdown");
  }
});

test("activation from a later turn_start handler cancels the run without clearing a busy socket", async () => {
  const f = await fixture("anthropic", "work");
  let calls = 0;
  const unregister = registerSessionResourceCleanup(() => calls++);
  try {
    await f.start();
    assert.equal(calls, 1);
    f.setIdle(false);
    await f.emit("turn_start");
    // Pi runs later extensions' handlers before preparing the same provider request.
    const result = await f.activate("personal");
    assert.equal(result.status, "active");
    assert.equal(f.ctx.signal?.aborted, true);
    assert.equal(f.aborts(), 1);
    assert.equal(calls, 1, "cancellation must not close the in-flight provider socket");
    f.newRun();
    await f.emit("before_agent_start");
    await f.emit("turn_start");
    assert.equal(calls, 2);
    assert.equal(await f.registry.getApiKeyForProvider("anthropic"), "sk-personal-fixture");
  } finally {
    unregister();
    await f.emit("session_shutdown");
  }
});

test("a stale cleanup failure cannot change authentication after session replacement", async () => {
  const f = await fixture("anthropic", "work");
  const cleanup = f.adapter.invalidateConnections;
  assert.ok(cleanup);
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let first = true;
  f.adapter.invalidateConnections = async (sessionId) => {
    await cleanup(sessionId);
    if (!first) return;
    first = false;
    started.resolve();
    await release.promise;
    throw new Error("obsolete cleanup failure");
  };
  const stale = f.start();
  let replacement: ExtensionContext | undefined;
  try {
    await started.promise;
    await f.emit("session_shutdown");
    const next = createMockContext({
      model: f.ctx.model,
      modelRegistry: f.registry,
      sessionManager: SessionManager.inMemory(process.cwd()),
    });
    replacement = next.ctx;
    await f.emit("session_start", replacement);
    await f.emit("before_agent_start", replacement);
    release.resolve();
    await stale;
    assert.equal(await f.registry.getApiKeyForProvider("anthropic"), "sk-work-fixture");
    assert.equal(next.statuses.get(ACCOUNTS_STATUS_KEY), "account:work");
    assert.equal(f.statuses.get(ACCOUNTS_STATUS_KEY), undefined);
  } finally {
    release.resolve();
    await stale;
    await f.emit("session_shutdown", replacement ?? f.ctx);
  }
});
