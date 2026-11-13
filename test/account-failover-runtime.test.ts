import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  getCurrentSystemPrompt,
  getCurrentTools,
  InMemoryCredentialStore,
  type TranscriptContext,
} from "@earendil-works/pi-ai";
import {
  createAgentSession,
  createEventBus,
  DefaultResourceLoader,
  type ExtensionContext,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { test, vi } from "vitest";
import {
  AccountStore,
  accountsExtension,
  agentDir,
  allowance,
  enabled,
  InMemoryAccountStorageBackend,
  keyFor,
  type UsageRequest,
} from "../packages/pi-accounts/test/account-failover-fixture.js";

// Only model-visible, cache-sensitive data is compared. Runtime accounting, session entry
// details, request IDs, and transport controls are not part of the normalized prefix.
function normalized(context: TranscriptContext) {
  return JSON.parse(
    JSON.stringify(
      {
        prompt: getCurrentSystemPrompt(context.messages),
        tools: getCurrentTools(context.messages).map((tool) => ({
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters,
          constrainedSampling: tool.constrainedSampling,
        })),
        messages: context.messages,
      },
      (key, value: unknown) =>
        ["timestamp", "usage", "durationMs", "details", "responseId", "diagnostics"].includes(key) ? undefined : value,
    ),
  ) as {
    prompt: string;
    tools: Array<{ name: string }>;
    messages: unknown[];
  };
}

async function runtimeFixture() {
  const root = await mkdtemp(join(agentDir, "runtime-"));
  const store = new AccountStore(new InMemoryAccountStorageBackend());
  await store.updateProvider("openrouter", () => ({
    active: "primary",
    fallback: enabled(),
    accounts: Object.fromEntries(
      ["primary", "backup", "spare"].map((account) => [account, { type: "api_key" as const, key: keyFor(account) }]),
    ),
  }));
  const { createBuiltinProviderAdapters } = await import("../packages/pi-accounts/src/oauth.js");
  const adapter = createBuiltinProviderAdapters().find((candidate) => candidate.id === "openrouter");
  assert.ok(adapter);
  const faux = fauxProvider({ provider: "openrouter", models: [{ id: "synthetic-failover-model" }] });
  const runtime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsPath: null,
    refreshOnCreate: false,
  });
  // Use the public extension-provider registration so stored/runtime API-key resolution
  // is Pi's real OpenRouter auth path, not Faux's intentionally keyless resolver.
  runtime.registerProvider("openrouter", {
    api: faux.api,
    baseUrl: faux.getModel().baseUrl,
    apiKey: "synthetic-default-login",
    models: faux.models,
    streamSimple: (model, context, options) => faux.provider.streamSimple(model, context, options),
  });
  const bus = createEventBus();
  const settings = SettingsManager.inMemory({
    compaction: { enabled: false },
    retry: { enabled: false },
    defaultTools: [],
  });
  let ctx: ExtensionContext | undefined;
  let executions = 0;
  const boundaries: Array<{ event: string; idle: boolean }> = [];
  const loader = new DefaultResourceLoader({
    cwd: root,
    agentDir: root,
    eventBus: bus,
    settingsManager: settings,
    noExtensions: true,
    noSkills: true,
    noThemes: true,
    noContextFiles: true,
    extensionFactories: [
      (pi) => accountsExtension(pi, { store, providers: [adapter] }),
      (pi) => {
        pi.on("session_start", (_event, current) => {
          ctx = current;
        });
        const observe = (event: string) => (_event: unknown, current: ExtensionContext) => {
          boundaries.push({ event, idle: current.isIdle() });
        };
        pi.on("before_agent_start", observe("before_agent_start"));
        pi.on("turn_start", observe("turn_start"));
        pi.on("agent_end", observe("agent_end"));
        pi.on("agent_settled", observe("agent_settled"));
        for (const name of ["prefix_probe", "unused_probe"])
          pi.registerTool({
            name,
            label: name,
            description: `Stable ${name} definition`,
            parameters: Type.Object({}),
            execute: async () => {
              executions++;
              return { content: [{ type: "text", text: "Stable completed tool result" }], details: { private: true } };
            },
          });
      },
    ],
  });
  await loader.reload();
  assert.deepEqual(loader.getExtensions().errors, []);
  const { session } = await createAgentSession({
    cwd: root,
    agentDir: root,
    resourceLoader: loader,
    settingsManager: settings,
    sessionManager: SessionManager.inMemory(root),
    modelRuntime: runtime,
    model: faux.getModel(),
    tools: ["prefix_probe", "unused_probe"],
  });
  await session.bindExtensions({ mode: "json" });
  session.setActiveToolsByName(["prefix_probe", "unused_probe"]);
  assert.ok(ctx);
  const current = ctx;
  return {
    root,
    store,
    adapter,
    faux,
    runtime,
    bus,
    session,
    ctx: current,
    boundaries,
    executions: () => executions,
    async shutdown() {
      await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
      session.dispose();
      await rm(root, { recursive: true, force: true });
    },
  };
}

test("real Pi awaits busy turn_start failover cleanup and preserves normalized prompt, history, and tools", async () => {
  const f = await runtimeFixture();
  const cleanupEntered = Promise.withResolvers<void>();
  const releaseCleanup = Promise.withResolvers<void>();
  const quotaEntered = Promise.withResolvers<void>();
  const releaseQuota = Promise.withResolvers<void>();
  const requests: Array<ReturnType<typeof normalized> & { key?: string; active: string[]; model: string }> = [];
  const trace: string[] = [];
  const queries: string[] = [];
  let switchNow = false;
  const cleanup = f.adapter.invalidateConnections;
  assert.ok(cleanup);
  f.adapter.invalidateConnections = async (sessionId) => {
    const key = await f.ctx.modelRegistry.getApiKeyForProvider("openrouter");
    trace.push(`cleanup:${key}`);
    await cleanup(sessionId);
    if (key !== keyFor("backup")) return;
    cleanupEntered.resolve();
    await releaseCleanup.promise;
    trace.push("candidate-cleanup-complete");
  };
  const unsubscribe = f.bus.on("usage:query:v1", (value) => {
    const request = value as UsageRequest;
    request.respond(
      (async () => {
        const key = await f.ctx.modelRegistry.getApiKeyForProvider("openrouter");
        assert.ok(key);
        queries.push(key);
        trace.push(`quota:${key}`);
        if (key === keyFor("backup")) {
          quotaEntered.resolve();
          await releaseQuota.promise;
        }
        // A refresh notification is an invalidation hint, never a recursive query command.
        f.bus.emit("usage:changed:v1", {
          session: request.session,
          sessionId: request.sessionId,
          providerId: "openrouter",
        });
        return allowance(f.ctx, switchNow && key === keyFor("primary") ? 0 : 50);
      })(),
    );
  });
  const record = (context: TranscriptContext, options: { apiKey?: string } | undefined, tool = false) => {
    trace.push(`request:${options?.apiKey}`);
    requests.push({
      ...normalized(context),
      key: options?.apiKey,
      active: f.session.getActiveToolNames(),
      model: f.session.model?.id ?? "",
    });
    return tool
      ? fauxAssistantMessage(fauxToolCall("prefix_probe", {}, { id: "completed-once" }), { stopReason: "toolUse" })
      : fauxAssistantMessage("Synthetic answer");
  };
  f.faux.setResponses([
    (context, options) => record(context, options, true),
    (context, options) => record(context, options),
    (context, options) => record(context, options),
    (context, options) => record(context, options),
  ]);
  let pending: Promise<void> | undefined;
  try {
    await f.session.prompt("First ordinary request with one tool");
    assert.equal(requests.length, 2, JSON.stringify({ messages: f.session.messages, trace, boundaries: f.boundaries }));
    assert.equal(
      f.executions(),
      1,
      JSON.stringify({ tools: f.session.getActiveToolNames(), messages: f.session.messages }),
    );
    assert.deepEqual(queries, [keyFor("primary")]);
    switchNow = true;
    const now = Date.now.bind(Date);
    vi.spyOn(Date, "now").mockImplementation(() => now() + 5 * 60_000);
    pending = f.session.prompt("Second ordinary request");
    await cleanupEntered.promise;
    assert.equal(f.session.isIdle, false);
    assert.equal(requests.length, 2, "provider requests must wait for candidate continuation cleanup");
    assert.equal(f.faux.state.callCount, 2);
    releaseCleanup.resolve();
    await quotaEntered.promise;
    assert.equal(requests.length, 2, "provider requests must also wait for verified adequate candidate quota");
    releaseQuota.resolve();
    await pending;
    assert.equal(requests.length, 3);
    assert.equal(requests[2]?.key, keyFor("backup"));
    const cleanupIndex = trace.indexOf("candidate-cleanup-complete");
    assert.ok(cleanupIndex >= 0 && cleanupIndex < trace.indexOf(`quota:${keyFor("backup")}`));
    assert.ok(trace.indexOf(`quota:${keyFor("backup")}`) < trace.indexOf(`request:${keyFor("backup")}`));
    const traceLength = trace.length;
    await f.session.prompt("Third ordinary request");
    assert.equal(requests.length, 4);
    assert.deepEqual(
      trace.slice(traceLength),
      [`request:${keyFor("backup")}`],
      "unchanged auth must retain continuation state",
    );
    assert.deepEqual(queries, ["primary", "primary", "backup"].map(keyFor));
    assert.equal(f.executions(), 1, "failover must not replay a completed tool");
    assert.ok(
      f.boundaries
        .filter((event) => ["before_agent_start", "turn_start", "agent_end"].includes(event.event))
        .every((event) => !event.idle),
    );
    assert.ok(f.boundaries.filter((event) => event.event === "agent_settled").every((event) => event.idle));
    assert.equal(f.boundaries.filter((event) => event.event === "turn_start").length, 4);
    assert.equal(f.boundaries.filter((event) => event.event === "agent_settled").length, 3);
    for (let index = 1; index < requests.length; index++) {
      const previous = requests[index - 1];
      const current = requests[index];
      assert.ok(previous && current);
      assert.equal(current.prompt, previous.prompt);
      assert.deepEqual(current.tools, previous.tools);
      assert.deepEqual(current.active, previous.active);
      assert.deepEqual(current.messages.slice(0, previous.messages.length), previous.messages);
      assert.equal(current.model, "synthetic-failover-model");
    }
    assert.deepEqual(
      requests[0]?.tools.map((tool) => tool.name),
      ["prefix_probe", "unused_probe"],
    );
    assert.deepEqual(
      requests.map((request) => request.key),
      ["primary", "primary", "backup", "backup"].map(keyFor),
    );
    assert.equal((await f.store.readProviderAsync("openrouter")).active, "primary");
  } finally {
    releaseCleanup.resolve();
    releaseQuota.resolve();
    await pending;
    unsubscribe();
    await f.shutdown();
  }
});

for (const message of ["HTTP 429 too many requests", "Provider authentication failed"]) {
  test(`provider error ${JSON.stringify(message)} never triggers account failover or a replay`, async () => {
    const f = await runtimeFixture();
    const keys: Array<string | undefined> = [];
    let queries = 0;
    const unsubscribe = f.bus.on("usage:query:v1", (value) => {
      queries++;
      (value as UsageRequest).respond(allowance(f.ctx, 50));
    });
    f.faux.setResponses([
      (_context, options) => {
        keys.push(options?.apiKey);
        return fauxAssistantMessage([], { stopReason: "error", errorMessage: message });
      },
    ]);
    try {
      await f.session.prompt("Do not retry or switch because of provider errors");
      assert.deepEqual(keys, [keyFor("primary")]);
      assert.equal(queries, 1);
      assert.equal(f.faux.state.callCount, 1);
      assert.equal(f.session.messages.at(-1)?.role, "assistant");
      assert.equal(await f.ctx.modelRegistry.getApiKeyForProvider("openrouter"), keyFor("primary"));
    } finally {
      unsubscribe();
      await f.shutdown();
    }
  });
}

test("real Pi blocks requests after failed restoration until verified settled recovery succeeds", async () => {
  const f = await runtimeFixture();
  const keys: Array<string | undefined> = [];
  let blockRestore = true;
  let queries = 0;
  const cleanup = f.adapter.invalidateConnections;
  assert.ok(cleanup);
  f.adapter.invalidateConnections = async (session) => {
    if (
      blockRestore &&
      queries >= 2 &&
      (await f.ctx.modelRegistry.getApiKeyForProvider("openrouter")) === keyFor("primary")
    ) {
      throw new Error("Synthetic restoration cleanup failure");
    }
    await cleanup(session);
  };
  const unsubscribe = f.bus.on("usage:query:v1", (value) => {
    queries++;
    (value as UsageRequest).respond(
      queries === 1
        ? allowance(f.ctx, 0)
        : { status: "unavailable", providerId: "openrouter", reason: "auth-unavailable" },
    );
  });
  f.faux.setResponses([
    (_context, options) => {
      keys.push(options?.apiKey);
      return fauxAssistantMessage("Only after verified recovery");
    },
  ]);
  try {
    await f.session.prompt("Do not send a request until authentication is restored");
    assert.equal(f.faux.state.callCount, 0);
    assert.deepEqual(keys, []);
    assert.equal(f.session.isIdle, true);
    blockRestore = false;
    await f.session.extensionRunner.emit({ type: "agent_settled", aborted: true });
    assert.equal(await f.ctx.modelRegistry.getApiKeyForProvider("openrouter"), keyFor("primary"));
    await f.session.prompt("A new explicit request after safe recovery");
    assert.deepEqual(keys, [keyFor("primary")]);
    assert.equal(f.faux.state.callCount, 1);
    assert.equal(queries, 2, "settled recovery and the next request must not restart a failed candidate scan");
  } finally {
    unsubscribe();
    await f.shutdown();
  }
});

for (const result of ["unknown quota", "unavailable model"] as const) {
  test(`real Pi sends no model request under candidate authentication with ${result}`, async () => {
    const f = await runtimeFixture();
    const keys: Array<string | undefined> = [];
    const queried: Array<string | undefined> = [];
    if (result === "unavailable model") {
      await f.store.updateProvider("openrouter", (state) => ({
        ...state,
        accounts: {
          ...state.accounts,
          backup: {
            type: "oauth",
            access: keyFor("backup"),
            refresh: "synthetic-refresh",
            expires: Date.now() + 3_600_000,
            availableModelIds: ["not-the-selected-model"],
          },
        },
      }));
      f.adapter.oauth = { ...f.adapter.oauth, toAuth: async (credential) => ({ apiKey: credential.access }) };
    }
    const unsubscribe = f.bus.on("usage:query:v1", (value) => {
      const request = value as UsageRequest;
      request.respond(
        (async () => {
          const key = await f.ctx.modelRegistry.getApiKeyForProvider("openrouter");
          queried.push(key);
          return key === keyFor("primary")
            ? allowance(f.ctx, 0)
            : { status: "unavailable", providerId: "openrouter", reason: "auth-unavailable" };
        })(),
      );
    });
    f.faux.setResponses([
      (_context, options) => {
        keys.push(options?.apiKey);
        return fauxAssistantMessage("Original account after guarded restoration");
      },
    ]);
    try {
      await f.session.prompt("One request only after safe restoration");
      assert.deepEqual(
        keys,
        [keyFor("primary")],
        JSON.stringify({ messages: f.session.messages, queried, boundaries: f.boundaries }),
      );
      assert.deepEqual(
        queried,
        result === "unknown quota" ? [keyFor("primary"), keyFor("backup")] : [keyFor("primary")],
      );
      assert.equal(f.faux.state.callCount, 1);
      assert.equal(f.session.model?.id, "synthetic-failover-model");
      assert.equal(f.session.model.provider, "openrouter");
      assert.equal((await f.store.readProviderAsync("openrouter")).active, "primary");
    } finally {
      unsubscribe();
      await f.shutdown();
    }
  });
}
