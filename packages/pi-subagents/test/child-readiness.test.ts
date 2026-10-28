import assert from "node:assert/strict";
import { type AnyModel, type Api, InMemoryCredentialStore, type Model, type Provider } from "@earendil-works/pi-ai";
import { ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { afterEach, test, vi } from "vitest";
import { createMockPi } from "../../../test/support.js";
import { toolSourceId } from "../src/attachment-utils.js";
import { type ChildSelection, MAX_READINESS_FRAME_BYTES } from "../src/broker-credentials.js";
import { assertChildModelState, parseReadinessFrame } from "../src/child-readiness.js";
import { createChildReadinessProbe } from "../src/child-readiness-probe.js";

afterEach(() => vi.useRealTimers());

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function createTestRuntime() {
  return ModelRuntime.create({ modelsPath: null, refreshOnCreate: false, credentials: new InMemoryCredentialStore() });
}

function harness(id = "raw/model:high") {
  const model = { provider: "selected", id };
  const provider = {};
  const available = vi.fn(async (_type: string, _provider: string, _options: { signal: AbortSignal }) => [model]);
  const registry = {
    find: vi.fn((p: string, m: string) => (p === model.provider && m === model.id ? model : undefined)),
    getRegisteredNativeProvider: vi.fn(() => provider),
    getRegisteredProviderConfig: vi.fn(() => undefined),
    getAvailableOfType: available,
    getAvailable: vi.fn(() => []),
    refresh: vi.fn(
      async (_options: { providers: string[]; allowNetwork: boolean; signal: AbortSignal }): Promise<void> => undefined,
    ),
  };
  let sessionId = "session";
  const ctx = {
    model,
    modelRegistry: registry,
    sessionManager: { getSessionId: () => sessionId },
    cwd: "/project",
    isProjectTrusted: () => false,
    signal: undefined as AbortSignal | undefined,
  };
  const tools = [{ name: "subagent_send", sourceInfo: { path: "/bridge.ts" } }];
  const mock = createMockPi({ activeTools: ["subagent_send"], allTools: tools });
  const selection: ChildSelection = { provider: model.provider, model: model.id, thinkingLevel: "high" };
  const setModel = vi.fn(async (selected: typeof model) => {
    ctx.model = selected;
    return true;
  });
  const setThinking = vi.fn((_level: string) => undefined);
  mock.rawPi.setModel = setModel;
  mock.rawPi.setThinkingLevel = setThinking;
  const frames: string[] = [];
  const closed: number[] = [];
  createChildReadinessProbe(
    { fd: 4, expectedTools: ["subagent_send"], selection },
    (_fd, frame) => frames.push(frame),
    (fd) => closed.push(fd),
  )(mock.pi);
  const run = async () => {
    for (const handler of mock.events.get("resources_discover") ?? []) {
      await handler({ type: "resources_discover", reason: "startup", cwd: ctx.cwd }, ctx);
    }
  };
  const shutdown = async () => {
    for (const handler of mock.events.get("session_shutdown") ?? []) await handler({}, ctx);
  };
  const select = (selected: { provider: string; id: string }) => {
    selection.provider = selected.provider;
    selection.model = selected.id;
  };
  return {
    model,
    ctx,
    registry,
    mock,
    available,
    frames,
    closed,
    run,
    shutdown,
    selection,
    select,
    setModel,
    setThinking,
    replaceSession: () => {
      sessionId = "new";
    },
  };
}

for (const id of ["raw/model", "raw:model", "raw/model:high", "virtual"]) {
  test(`readiness attests only the literal selected pair ${id}`, async () => {
    const h = harness(id);
    await h.run();
    await h.shutdown();
    assert.deepEqual(
      h.frames.map((frame) => JSON.parse(frame)),
      [
        {
          ok: true,
          sources: [toolSourceId("/bridge.ts")],
          model: h.model,
        },
      ],
    );
    assert.deepEqual(h.closed, [4]);
    assert.equal(h.registry.getAvailable.mock.calls.length, 0);
    const [type, provider, options] = h.available.mock.calls[0] ?? [];
    assert.equal(type, "chat");
    assert.equal(provider, "selected");
    assert.equal(options?.signal.aborted, true);
  });
}

for (const selection of ["fuzzy", "FABRICATED", "image-only", "classifier-only", "inherited-unlisted"]) {
  test(`readiness rejects an unregistered exact chat selection: ${selection}`, async () => {
    const h = harness(selection);
    h.registry.find.mockReturnValue(undefined);
    await h.run();
    assert.equal(JSON.parse(h.frames[0] ?? "{}").ok, false);
    assert.match(h.frames[0] ?? "", /not registered.*exact chat/);
    assert.equal(h.available.mock.calls.length, 0);
    assert.deepEqual(h.closed, [4]);
  });
}

test("readiness rejects missing auth and filtered chat models despite a populated stale snapshot", async () => {
  for (const available of [
    [],
    [{ provider: "other", id: "raw/model:high" }],
    [{ provider: "selected", id: "RAW/MODEL:HIGH" }],
  ]) {
    const h = harness();
    h.registry.getAvailable.mockReturnValue([h.model] as never);
    h.available.mockResolvedValue(available);
    await h.run();
    assert.match(h.frames[0] ?? "", /unavailable.*exact chat.*credentials/);
    assert.equal(h.registry.getAvailable.mock.calls.length, 0);
  }
});

for (const mutation of [
  "model",
  "model-pair",
  "registry",
  "provider",
  "registration",
  "session",
  "manager",
  "cwd",
  "trust",
  "active-tools",
  "tool-source",
  "disposed",
]) {
  test(`readiness revalidates ${mutation} after fresh availability`, async () => {
    const h = harness();
    const waiting = deferred<(typeof h.model)[]>();
    h.available.mockReturnValue(waiting.promise);
    const work = h.run();
    await Promise.resolve();
    assert.equal(h.available.mock.calls.length, 1);
    switch (mutation) {
      case "model":
        h.ctx.model = { ...h.model };
        break;
      case "model-pair":
        h.model.id = "changed";
        break;
      case "registry":
        h.ctx.modelRegistry = { ...h.registry };
        break;
      case "provider":
        h.registry.getRegisteredNativeProvider.mockReturnValue({});
        break;
      case "registration":
        h.registry.find.mockReturnValue(undefined);
        break;
      case "session":
        h.replaceSession();
        break;
      case "manager":
        h.ctx.sessionManager = { getSessionId: () => "session" };
        break;
      case "cwd":
        h.ctx.cwd = "/replacement";
        break;
      case "trust":
        h.ctx.isProjectTrusted = () => true;
        break;
      case "active-tools":
        h.mock.rawPi.setActiveTools([]);
        break;
      case "tool-source":
        h.mock.rawPi.getAllTools = () => [{ name: "subagent_send", sourceInfo: { path: "/other.ts" } }];
        break;
      case "disposed":
        Object.defineProperty(h.ctx, "model", {
          get: () => {
            throw new Error("Disposed private context");
          },
        });
        break;
    }
    waiting.resolve([h.model]);
    await work;
    assert.equal(JSON.parse(h.frames[0] ?? "{}").ok, false);
    assert.doesNotMatch(h.frames[0] ?? "", /Disposed private context/);
    assert.deepEqual(h.closed, [4]);
  });
}

test("shutdown cancels in-flight fresh availability and closes exactly once before a late result", async () => {
  const h = harness();
  const waiting = deferred<(typeof h.model)[]>();
  h.available.mockReturnValue(waiting.promise);
  const work = h.run();
  await Promise.resolve();
  const signal = h.available.mock.calls[0]?.[2].signal;
  await h.shutdown();
  assert.equal(signal?.aborted, true);
  assert.match(h.frames[0] ?? "", /shut down before readiness/);
  waiting.resolve([h.model]);
  await work;
  await h.shutdown();
  await h.run();
  assert.equal(h.frames.length, 1);
  assert.deepEqual(h.closed, [4]);
});

test("fresh availability receives cancellation and redacts provider failures", async () => {
  const h = harness();
  const controller = new AbortController();
  h.ctx.signal = controller.signal;
  h.available.mockImplementation(
    async (_type, _provider, { signal }) =>
      new Promise<(typeof h.model)[]>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(new Error("secret key /private/provider.ts")), { once: true });
      }),
  );
  const work = h.run();
  await Promise.resolve();
  controller.abort();
  await work;
  assert.match(h.frames[0] ?? "", /model readiness failed/);
  assert.doesNotMatch(h.frames[0] ?? "", /secret|private/);
  assert.deepEqual(h.closed, [4]);
});

test("fresh availability deadline cancels owned work without a second frame", async () => {
  vi.useFakeTimers();
  const h = harness();
  h.available.mockImplementation(
    async (_type, _provider, { signal }) =>
      new Promise<(typeof h.model)[]>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(new Error("cancelled")), { once: true });
      }),
  );
  const work = h.run();
  await vi.advanceTimersByTimeAsync(30_000);
  await work;
  assert.match(h.frames[0] ?? "", /readiness timed out/);
  assert.deepEqual(h.closed, [4]);
  assert.equal(vi.getTimerCount(), 0);
});

test("large catalogs do not enter the bounded readiness frame", async () => {
  const h = harness();
  h.available.mockResolvedValue([
    ...Array.from({ length: 20_000 }, (_, index) => ({ provider: "selected", id: `catalog-${index}` })),
    h.model,
  ]);
  await h.run();
  assert.ok(Buffer.byteLength(h.frames[0] ?? "") < 256);
  assert.doesNotMatch(h.frames[0] ?? "", /catalog-/);
  assert.equal(JSON.parse(h.frames[0] ?? "{}").ok, true);
});

test("oversized pair produces a bounded failure frame and exact descriptor cleanup", async () => {
  const h = harness("x".repeat(MAX_READINESS_FRAME_BYTES));
  await h.run();
  assert.match(h.frames[0] ?? "", /frame exceeded its size limit/);
  assert.ok(Buffer.byteLength(h.frames[0] ?? "") < MAX_READINESS_FRAME_BYTES);
  assert.deepEqual(h.closed, [4]);
});

test("installed registry accepts late native registration and virtual models without its stale snapshot", async () => {
  const runtime = await createTestRuntime();
  const registry = new ModelRegistry(runtime);
  const base = runtime.getModels()[0];
  assert.ok(base);
  const model: Model<Api> = { ...base, provider: "late-child", id: "raw/path:high" };
  const provider: Provider = {
    id: model.provider,
    name: "Late child",
    auth: { apiKey: { name: "Fixture", resolve: async () => ({ auth: { apiKey: "fixture" }, source: "fixture" }) } },
    getModels: () => [model],
    stream: () => {
      throw new Error("Provider requests are forbidden in readiness tests.");
    },
    streamSimple: () => {
      throw new Error("Provider requests are forbidden in readiness tests.");
    },
  };
  runtime.registerNativeProvider(provider);
  // Registration schedules a refresh but cannot synchronously await its credential check.
  assert.equal(
    registry.getAvailable().some((entry) => entry.provider === model.provider),
    false,
  );
  assert.equal(registry.find(model.provider, "RAW/PATH:HIGH"), undefined);
  assert.equal(registry.find(model.provider, "fabricated"), undefined);
  const h = harness();
  Object.assign(h.ctx, { model, modelRegistry: registry });
  h.select(model);
  await h.run();
  assert.equal(JSON.parse(h.frames[0] ?? "{}").ok, true);
  runtime.registerVirtualModel({
    provider: "child-virtual",
    id: "auto:high",
    name: "Auto",
    route: () => ({ model, thinkingLevel: "off" }),
  });
  const virtual = registry.find("child-virtual", "auto:high");
  assert.ok(virtual);
  const v = harness();
  Object.assign(v.ctx, { model: virtual, modelRegistry: registry });
  v.select(virtual);
  await v.run();
  assert.deepEqual(JSON.parse(v.frames[0] ?? "{}").model, { provider: "child-virtual", id: "auto:high" });
});

test("installed registry rejects non-chat catalogs, lost auth, and current model filters", async () => {
  const runtime = await createTestRuntime();
  const registry = new ModelRegistry(runtime);
  const base = runtime.getModels()[0];
  assert.ok(base);
  let authenticated = true;
  let filtered = false;
  const model: Model<Api> = { ...base, provider: "credential-child", id: "chat" };
  const nonChat: AnyModel[] = [
    { ...base, provider: "credential-child", id: "image", type: "image", api: "openai-images", output: ["image"] },
    {
      ...base,
      provider: "credential-child",
      id: "classifier",
      type: "classifier",
      api: "typesafe-system-one",
      compat: undefined,
    },
  ];
  runtime.registerNativeProvider({
    id: model.provider,
    name: "Credential child",
    auth: {
      apiKey: {
        name: "Fixture",
        resolve: async () => (authenticated ? { auth: { apiKey: "fixture" }, source: "fixture" } : undefined),
      },
    },
    getModels: () => [model],
    getAllModels: () => [model, ...nonChat],
    filterModels: (models) => (filtered ? [] : models),
    stream: () => {
      throw new Error("Provider requests are forbidden in readiness tests.");
    },
    streamSimple: () => {
      throw new Error("Provider requests are forbidden in readiness tests.");
    },
  });
  await runtime.refresh({ providers: [model.provider], allowNetwork: false });
  assert.ok((await registry.getAvailableOfType("chat", model.provider)).some((entry) => entry.id === model.id));
  for (const selected of nonChat) {
    assert.equal(registry.find(selected.provider, selected.id), undefined);
    const h = harness();
    Object.assign(h.ctx, { model: selected, modelRegistry: registry });
    h.select(selected);
    await h.run();
    assert.match(h.frames[0] ?? "", /not registered.*exact chat/);
  }
  for (const missingAuth of [true, false]) {
    authenticated = !missingAuth;
    filtered = !missingAuth;
    const h = harness();
    Object.assign(h.ctx, { model, modelRegistry: registry });
    h.select(model);
    await h.run();
    assert.match(h.frames[0] ?? "", /unavailable.*exact chat/);
  }
});

test("installed composed providers may return new exact model objects on each lookup", async () => {
  const runtime = await createTestRuntime();
  const registry = new ModelRegistry(runtime);
  registry.registerProvider("composed-child", {
    api: "openai-completions",
    baseUrl: "http://127.0.0.1:1/v1",
    apiKey: "fixture",
    models: [
      {
        id: "raw/model:high",
        name: "Raw",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 4096,
        maxTokens: 128,
      },
    ],
  });
  const model = registry.find("composed-child", "raw/model:high");
  assert.ok(model);
  assert.notEqual(registry.find(model.provider, model.id), model);
  const h = harness();
  Object.assign(h.ctx, { model, modelRegistry: registry });
  h.select(model);
  await h.run();
  assert.deepEqual(JSON.parse(h.frames[0] ?? "{}").model, { provider: model.provider, id: model.id });
});

for (const id of ["fixture/base", "BASE"]) {
  test(`exact initial binding corrects the installed CLI collision for ${id}`, async () => {
    const runtime = await createTestRuntime();
    const registry = new ModelRegistry(runtime);
    registry.registerProvider("fixture", {
      api: "openai-completions",
      baseUrl: "http://127.0.0.1:1/v1",
      apiKey: "fixture",
      models: ["base", id].map((modelId) => ({
        id: modelId,
        name: modelId,
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 4096,
        maxTokens: 128,
      })),
    });
    const base = registry.find("fixture", "base");
    const exact = registry.find("fixture", id);
    assert.ok(base && exact);
    const h = harness(id);
    h.select(exact);
    Object.assign(h.ctx, { model: base, modelRegistry: registry });
    h.setModel.mockImplementation(async (selected) => {
      // Mirror the public setter's cached-auth gate, then its actual context publication.
      assert.equal(registry.hasConfiguredAuth(selected as Model<Api>), true);
      assert.equal(selected.id, id);
      assert.deepEqual(selected, registry.find("fixture", id));
      h.ctx.model = selected;
      return true;
    });
    h.setThinking.mockImplementation((level) => {
      assert.equal(h.ctx.model.id, id);
      assert.equal(level, "high");
    });
    await h.run();
    assert.equal(h.setModel.mock.calls.length, 1);
    assert.deepEqual(h.setThinking.mock.calls, [["high"]]);
    assert.deepEqual(JSON.parse(h.frames[0] ?? "{}").model, { provider: "fixture", id });
  });
}

test("an exact same-pair definition avoids setter auth and model-selection side effects", async () => {
  const h = harness();
  await h.run();
  assert.equal(h.setModel.mock.calls.length, 0);
  assert.deepEqual(h.setThinking.mock.calls, [["high"]]);
  const [options] = h.registry.refresh.mock.calls[0] ?? [];
  assert.deepEqual(options?.providers, ["selected"]);
  assert.equal(options?.allowNetwork, false);
  assert.equal(options?.signal.aborted, true);
});

test("a wrong same-pair CLI definition is bound to the exact registration", async () => {
  const h = harness();
  h.ctx.model = { ...h.model, name: "CLI fabricated" } as typeof h.model;
  await h.run();
  assert.deepEqual(h.setModel.mock.calls, [[h.model]]);
  assert.equal(JSON.parse(h.frames[0] ?? "{}").ok, true);
});

for (const failure of [
  "false",
  "error",
  "hook-pair",
  "hook-same-pair",
  "hook-definition",
  "hook-provider",
  "hook-registration",
  "hook-tools",
  "hook-session",
]) {
  test(`exact initial binding rejects ${failure} before applying requested thinking`, async () => {
    const h = harness();
    h.ctx.model = { ...h.model, id: "base" };
    h.setModel.mockImplementation(async (selected) => {
      h.ctx.model = selected;
      switch (failure) {
        case "false":
          return false;
        case "error":
          throw new Error("private provider credential /private/file");
        case "hook-pair":
          h.ctx.model = { ...selected, id: "other" };
          break;
        case "hook-same-pair":
          h.ctx.model = { ...selected };
          break;
        case "hook-definition":
          Object.assign(selected, { name: "mutated" });
          break;
        case "hook-provider":
          h.registry.getRegisteredNativeProvider.mockReturnValue({});
          break;
        case "hook-registration":
          h.registry.find.mockReturnValue(undefined);
          break;
        case "hook-tools":
          h.mock.rawPi.setActiveTools([]);
          break;
        case "hook-session":
          h.replaceSession();
          break;
      }
      return true;
    });
    await h.run();
    assert.equal(JSON.parse(h.frames[0] ?? "{}").ok, false);
    assert.doesNotMatch(h.frames[0] ?? "", /private|credential/);
    assert.equal(h.setThinking.mock.calls.length, 0);
    assert.deepEqual(h.closed, [4]);
  });
}

for (const phase of ["refresh", "availability", "selection", "post-action-availability"] as const) {
  for (const stop of ["cancel", "shutdown", "deadline"] as const) {
    test(`${stop} during ${phase} prevents late exact binding or publication`, async () => {
      vi.useFakeTimers();
      const h = harness();
      h.ctx.model = { ...h.model, id: "base" };
      const controller = new AbortController();
      h.ctx.signal = controller.signal;
      const waiting = deferred<void>();
      const postSelectionStarted = deferred<void>();
      if (phase === "post-action-availability") {
        h.available.mockResolvedValueOnce([h.model]).mockImplementationOnce(async () => {
          postSelectionStarted.resolve();
          await waiting.promise;
          return [h.model];
        });
      }
      if (phase === "refresh") h.registry.refresh.mockImplementation(async () => waiting.promise);
      if (phase === "availability")
        h.available.mockImplementation(async () => {
          await waiting.promise;
          return [h.model];
        });
      if (phase === "selection")
        h.setModel.mockImplementation(async (selected) => {
          await waiting.promise;
          h.ctx.model = selected;
          return true;
        });
      const work = h.run();
      if (phase === "post-action-availability") {
        await postSelectionStarted.promise;
        assert.equal(h.available.mock.calls.length, 2);
      } else {
        // Each preceding dependency resolves immediately; drain their promise continuations.
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
      }
      if (phase === "selection" || phase === "post-action-availability") assert.equal(h.setModel.mock.calls.length, 1);
      if (stop === "cancel") controller.abort();
      if (stop === "shutdown") await h.shutdown();
      if (stop === "deadline") await vi.advanceTimersByTimeAsync(30_000);
      waiting.resolve();
      await work;
      assert.equal(h.frames.length, 1);
      assert.equal(JSON.parse(h.frames[0] ?? "{}").ok, false);
      assert.equal(h.setThinking.mock.calls.length, phase === "post-action-availability" ? 1 : 0);
      assert.deepEqual(h.closed, [4]);
      assert.equal(vi.getTimerCount(), 0);
      if (phase !== "selection" && phase !== "post-action-availability") assert.equal(h.setModel.mock.calls.length, 0);
    });
  }
}

for (const hook of ["model_select", "thinking_level_select"])
  for (const mutation of ["auth", "filter"]) {
    test(`${hook} ${mutation} changes fail fresh post-action availability`, async () => {
      const runtime = await createTestRuntime();
      const registry = new ModelRegistry(runtime);
      const base = runtime.getModels()[0];
      assert.ok(base);
      const model: Model<Api> = { ...base, provider: "post-selection-child", id: "exact" };
      let authenticated = true;
      let filtered = false;
      runtime.registerNativeProvider({
        id: model.provider,
        name: "Post selection child",
        auth: {
          apiKey: {
            name: "Fixture",
            resolve: async () => (authenticated ? { auth: { apiKey: "fixture" }, source: "fixture" } : undefined),
          },
        },
        getModels: () => [model],
        filterModels: (models) => (filtered ? [] : models),
        stream: () => {
          throw new Error("Provider requests are forbidden in readiness tests.");
        },
        streamSimple: () => {
          throw new Error("Provider requests are forbidden in readiness tests.");
        },
      });
      const h = harness();
      h.select(model);
      Object.assign(h.ctx, {
        model: hook === "model_select" ? { ...model, id: "base" } : model,
        modelRegistry: registry,
      });
      const mutateAvailability = () => {
        if (mutation === "auth") authenticated = false;
        else filtered = true;
      };
      h.setModel.mockImplementation(async (selected) => {
        h.ctx.model = selected;
        if (hook === "model_select") mutateAvailability();
        return true;
      });
      h.setThinking.mockImplementation(() => {
        if (hook === "thinking_level_select") mutateAvailability();
      });
      const availability = vi.spyOn(registry, "getAvailableOfType");
      await h.run();
      assert.equal(h.setModel.mock.calls.length, hook === "model_select" ? 1 : 0);
      assert.equal(availability.mock.calls.length, 2);
      assert.equal(
        (await availability.mock.results[0]?.value)?.some((entry: Model<Api>) => entry.id === model.id),
        true,
      );
      assert.deepEqual(await availability.mock.results[1]?.value, []);
      assert.equal(JSON.parse(h.frames[0] ?? "{}").ok, false);
      assert.match(h.frames[0] ?? "", /unavailable.*exact chat.*credentials/);
      assert.deepEqual(h.setThinking.mock.calls, [["high"]]);
      assert.deepEqual(h.closed, [4]);
    });
  }

for (const mutation of [
  "model",
  "model-pair",
  "registry",
  "provider",
  "config",
  "registration",
  "session",
  "manager",
  "cwd",
  "trust",
  "active-tools",
  "tool-source",
  "disposed",
]) {
  test(`post-action availability revalidates ${mutation} before readiness publication`, async () => {
    const h = harness();
    h.ctx.model = { ...h.model, id: "base" };
    const waiting = deferred<(typeof h.model)[]>();
    const started = deferred<void>();
    h.available.mockResolvedValueOnce([h.model]).mockImplementationOnce(() => {
      started.resolve();
      return waiting.promise;
    });
    const work = h.run();
    await started.promise;
    switch (mutation) {
      case "model":
        h.ctx.model = { ...h.model };
        break;
      case "model-pair":
        h.model.id = "changed";
        break;
      case "registry":
        h.ctx.modelRegistry = { ...h.registry };
        break;
      case "provider":
        h.registry.getRegisteredNativeProvider.mockReturnValue({});
        break;
      case "config":
        h.registry.getRegisteredProviderConfig.mockReturnValue({} as never);
        break;
      case "registration":
        h.registry.find.mockReturnValue(undefined);
        break;
      case "session":
        h.replaceSession();
        break;
      case "manager":
        h.ctx.sessionManager = { getSessionId: () => "session" };
        break;
      case "cwd":
        h.ctx.cwd = "/replacement";
        break;
      case "trust":
        h.ctx.isProjectTrusted = () => true;
        break;
      case "active-tools":
        h.mock.rawPi.setActiveTools([]);
        break;
      case "tool-source":
        h.mock.rawPi.getAllTools = () => [{ name: "subagent_send", sourceInfo: { path: "/other.ts" } }];
        break;
      case "disposed":
        Object.defineProperty(h.ctx, "model", {
          get: () => {
            throw new Error("Disposed private context");
          },
        });
        break;
    }
    waiting.resolve([h.model]);
    await work;
    assert.equal(JSON.parse(h.frames[0] ?? "{}").ok, false);
    assert.doesNotMatch(h.frames[0] ?? "", /Disposed private context/);
    assert.deepEqual(h.setThinking.mock.calls, [["high"]]);
    assert.deepEqual(h.closed, [4]);
  });
}

for (const mutation of ["model", "provider", "config", "session", "tools"]) {
  test(`offline refresh rejects stale ${mutation} before availability or selection`, async () => {
    const h = harness();
    const waiting = deferred<void>();
    h.registry.refresh.mockReturnValue(waiting.promise);
    const work = h.run();
    switch (mutation) {
      case "model":
        h.ctx.model = { ...h.model };
        break;
      case "provider":
        h.registry.getRegisteredNativeProvider.mockReturnValue({});
        break;
      case "config":
        h.registry.getRegisteredProviderConfig.mockReturnValue({} as never);
        break;
      case "session":
        h.replaceSession();
        break;
      case "tools":
        h.mock.rawPi.setActiveTools([]);
        break;
    }
    waiting.resolve();
    await work;
    assert.equal(JSON.parse(h.frames[0] ?? "{}").ok, false);
    assert.equal(h.available.mock.calls.length, 0);
    assert.equal(h.setModel.mock.calls.length, 0);
    assert.equal(h.setThinking.mock.calls.length, 0);
  });
}

test("offline refresh can recompose the registered definition before exact selection", async () => {
  const h = harness();
  const recomposed = { ...h.model, name: "refreshed definition" };
  h.registry.refresh.mockImplementation(async () => {
    h.registry.find.mockReturnValue(recomposed);
  });
  h.available.mockResolvedValue([recomposed]);
  await h.run();
  assert.deepEqual(h.setModel.mock.calls, [[recomposed]]);
  assert.equal(JSON.parse(h.frames[0] ?? "{}").ok, true);
});

test("synchronous thinking selection mutation fails instead of publishing the former exact pair", async () => {
  const h = harness();
  h.setThinking.mockImplementation(() => {
    h.ctx.model = { ...h.model, id: "future" };
  });
  await h.run();
  assert.equal(JSON.parse(h.frames[0] ?? "{}").ok, false);
  assert.match(h.frames[0] ?? "", /changed during exact initial selection/);
});

test("model frame and state validation reject malformed and mismatching data", () => {
  const model = { provider: "test", id: "raw/model:high" };
  const expected = { provider: model.provider, model: model.id };
  const frame = { ok: true, sources: [], model };
  assert.deepEqual(parseReadinessFrame(Buffer.from(`${JSON.stringify(frame)}\n`), 0), frame);
  const invalidUtf8 = Buffer.concat([
    Buffer.from('{"ok":true,"sources":[],"model":{"provider":"test","id":"'),
    Buffer.from([0xff]),
    Buffer.from('"}}\n'),
  ]);
  assert.throws(() => parseReadinessFrame(invalidUtf8, 0), /invalid UTF-8/);
  for (const value of [
    null,
    [],
    {},
    { ok: true, sources: [] },
    { ...frame, extra: true },
    { ...frame, model: { ...model, extra: true } },
    { ...frame, model: { ...model, id: "\u001bmalicious" } },
  ]) {
    assert.throws(() => parseReadinessFrame(Buffer.from(`${JSON.stringify(value)}\n`), 0));
  }
  for (const text of ["", "{}", "{}\n{}\n", "not-json\n", "x".repeat(MAX_READINESS_FRAME_BYTES + 1)]) {
    assert.throws(() => parseReadinessFrame(Buffer.from(text), 0));
  }
  for (const state of [
    null,
    [],
    {},
    { model: null },
    { model: { ...model, provider: "TEST" } },
    { model: { ...model, id: "raw/model" } },
  ]) {
    assert.throws(() => assertChildModelState(state, expected));
  }
  assert.doesNotThrow(() => assertChildModelState({ model: { ...model, api: "api", contextWindow: 1234 } }, expected));
});
