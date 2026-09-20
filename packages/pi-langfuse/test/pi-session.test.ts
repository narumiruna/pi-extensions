import assert from "node:assert/strict";
import { test, vi } from "vitest";
import { createMockContext, createMockPi } from "../../../test/support.js";
import { createPiLangfuseSession, createPiLangfuseSessionController } from "../src/pi-session.js";
import { createLangfuseRuntimeFromBackend } from "../src/runtime-core.js";
import { FakeBackend } from "./support.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

test("two Pi sessions share one runtime without sharing lifecycle state", async () => {
  const backend = new FakeBackend();
  const runtime = createLangfuseRuntimeFromBackend(backend);
  const traceIdsA: string[] = [];
  const traceIdsB: string[] = [];
  const sessionA = createPiLangfuseSession(runtime, {
    traceName: "support-agent",
    sessionId: "host-session-a",
    userId: "user-a",
    tags: [" support ", "pi", "support"],
    metadata: { tenant: "tenant-a", "pi.session.id": "cannot-override" },
    onTraceId: (traceId) => traceIdsA.push(traceId),
  });
  const sessionB = createPiLangfuseSession(runtime, {
    sessionId: "host-session-b",
    onTraceId: (traceId) => traceIdsB.push(traceId),
  });
  const mockA = createMockPi();
  const mockB = createMockPi();
  sessionA.extension(mockA.pi);
  sessionB.extension(mockB.pi);
  const contextA = createMockContext({ cwd: "/workspace/a" }).ctx;
  const contextB = createMockContext({ cwd: "/workspace/b" }).ctx;

  await mockA.events.get("session_start")?.[0]?.({}, contextA);
  await mockB.events.get("session_start")?.[0]?.({}, contextB);
  sessionA.setRequestId("request-a-1");
  await mockA.events.get("before_agent_start")?.[0]?.({ prompt: "A", images: [], systemPrompt: "system" }, contextA);
  sessionB.setRequestId("request-b-1");
  await mockB.events.get("before_agent_start")?.[0]?.({ prompt: "B", images: [], systemPrompt: "system" }, contextB);

  const agents = backend.observations.filter(({ name }) => name === "pi.agent");
  assert.equal(agents.length, 2);
  assert.equal(agents[0]?.attributes.sessionId, "host-session-a");
  assert.equal(agents[0]?.attributes.userId, "user-a");
  assert.equal(agents[0]?.attributes.metadata?.tenant, "tenant-a");
  assert.equal(agents[0]?.attributes.metadata?.["pi.session.id"], "host-session-a");
  assert.equal(agents[0]?.attributes.metadata?.["pi.request.id"], "request-a-1");
  assert.equal(agents[0]?.traceUpdates[0]?.name, "support-agent");
  assert.deepEqual(agents[0]?.traceUpdates[0]?.tags, ["pi", "support"]);
  assert.equal(agents[1]?.attributes.sessionId, "host-session-b");
  assert.equal(agents[1]?.attributes.metadata?.["pi.request.id"], "request-b-1");
  assert.deepEqual(traceIdsA, [agents[0]?.traceId]);
  assert.deepEqual(traceIdsB, [agents[1]?.traceId]);

  await sessionA.dispose();
  await sessionA.dispose();
  assert.equal(agents[0]?.ended, true);
  assert.equal(agents[0]?.endCalls, 1);
  assert.equal(agents[1]?.ended, false);
  assert.equal(backend.shutdowns, 0);

  await mockB.events.get("agent_start")?.[0]?.({}, contextB);
  await mockB.events.get("turn_start")?.[0]?.({ turnIndex: 0, timestamp: 1 }, contextB);
  assert.equal(
    backend.observations.some(({ name }) => name === "pi.turn"),
    true,
  );

  await runtime.shutdown();
  assert.equal(agents[1]?.ended, true);
  assert.equal(backend.flushes, 1);
  assert.equal(backend.shutdowns, 1);
  await runtime.shutdown();
  assert.equal(backend.shutdowns, 1);
});

test("provider-only cache warming hooks never create Langfuse generations", async () => {
  const backend = new FakeBackend();
  const runtime = createLangfuseRuntimeFromBackend(backend);
  const session = createPiLangfuseSession(runtime);
  const mock = createMockPi();
  session.extension(mock.pi);
  const { ctx } = createMockContext({ model: { provider: "anthropic", id: "claude" } });
  await mock.events.get("session_start")?.[0]?.({}, ctx);
  await mock.events.get("before_agent_start")?.[0]?.({ prompt: "run", images: [] }, ctx);
  await mock.events.get("turn_start")?.[0]?.({ turnIndex: 0, timestamp: 1 }, ctx);

  const requestStartedAt = 1_234_567;
  const clock = vi.spyOn(Date, "now").mockReturnValue(requestStartedAt);
  try {
    await mock.events.get("before_provider_request")?.[0]?.({ payload: { request: 1 } }, ctx);
  } finally {
    clock.mockRestore();
  }
  await mock.events.get("after_provider_response")?.[0]?.({ status: 429, headers: { "retry-after": "0" } }, ctx);
  await mock.events.get("after_provider_response")?.[0]?.({ status: 200, headers: {} }, ctx);
  const firstAssistant = {
    role: "assistant",
    content: [{ type: "text", text: "tool" }],
    provider: "anthropic",
    model: "claude",
    usage: { input: 1, output: 1, totalTokens: 2, cacheRead: 0, cacheWrite: 0 },
    stopReason: "toolUse",
  };
  await mock.events.get("message_start")?.[0]?.({ message: firstAssistant }, ctx);
  await mock.events.get("message_end")?.[0]?.({ message: firstAssistant }, ctx);
  await mock.events.get("turn_end")?.[0]?.({ turnIndex: 0, message: firstAssistant, toolResults: [] }, ctx);
  const firstGeneration = backend.observations.find(({ name }) => name === "pi.llm");
  assert.equal(firstGeneration?.startTime?.getTime(), requestStartedAt);
  assert.equal(backend.observations.filter(({ name }) => name === "pi.llm").length, 1);

  await mock.events.get("before_provider_request")?.[0]?.({ payload: { cacheWarm: true } }, ctx);
  await mock.events.get("after_provider_response")?.[0]?.({ status: 200, headers: {} }, ctx);
  assert.equal(backend.observations.filter(({ name }) => name === "pi.llm").length, 1);

  await mock.events.get("turn_start")?.[0]?.({ turnIndex: 1, timestamp: 2 }, ctx);
  await mock.events.get("before_provider_request")?.[0]?.({ payload: { request: 2 } }, ctx);
  await mock.events.get("after_provider_response")?.[0]?.({ status: 200, headers: {} }, ctx);
  const finalAssistant = { ...firstAssistant, content: [{ type: "text", text: "done" }], stopReason: "stop" };
  await mock.events.get("message_start")?.[0]?.({ message: finalAssistant }, ctx);
  await mock.events.get("message_end")?.[0]?.({ message: finalAssistant }, ctx);
  await mock.events.get("turn_end")?.[0]?.({ turnIndex: 1, message: finalAssistant, toolResults: [] }, ctx);
  const generations = backend.observations.filter(({ name }) => name === "pi.llm");
  assert.equal(generations.length, 2);
  assert.deepEqual(generations[0]?.updates.at(-1)?.metadata?.["http.response.status_codes"], [429, 200]);
  assert.deepEqual(generations[1]?.updates.at(-1)?.metadata?.["http.response.status_codes"], [200]);

  await mock.events.get("agent_settled")?.[0]?.({}, ctx);
  await mock.events.get("before_provider_request")?.[0]?.({ payload: { idleWarm: true } }, ctx);
  await mock.events.get("after_provider_response")?.[0]?.({ status: 200, headers: {} }, ctx);
  assert.equal(backend.observations.filter(({ name }) => name === "pi.llm").length, 2);

  await mock.events.get("before_agent_start")?.[0]?.({ prompt: "cancel", images: [] }, ctx);
  await mock.events.get("turn_start")?.[0]?.({ turnIndex: 0, timestamp: 3 }, ctx);
  await mock.events.get("before_provider_request")?.[0]?.({ payload: { request: "cancel" } }, ctx);
  await mock.events.get("after_provider_response")?.[0]?.({ status: 499, headers: {} }, ctx);
  const abortedAssistant = { ...firstAssistant, content: [], stopReason: "aborted" };
  await mock.events.get("message_start")?.[0]?.({ message: abortedAssistant }, ctx);
  await mock.events.get("message_end")?.[0]?.({ message: abortedAssistant }, ctx);
  await mock.events.get("turn_end")?.[0]?.({ turnIndex: 0, message: abortedAssistant, toolResults: [] }, ctx);
  const afterCancellation = backend.observations.filter(({ name }) => name === "pi.llm");
  assert.equal(afterCancellation.length, 3);
  assert.deepEqual(afterCancellation[2]?.updates.at(-1)?.metadata?.["http.response.status_codes"], [499]);
  assert.equal(afterCancellation[2]?.updates.at(-1)?.level, "WARNING");

  await session.dispose();
  await runtime.shutdown();
});

test("one controller follows its Pi session across extension reloads", async () => {
  const backend = new FakeBackend();
  const runtime = createLangfuseRuntimeFromBackend(backend);
  const session = createPiLangfuseSession(runtime);
  const first = createMockPi();
  const second = createMockPi();
  const { ctx } = createMockContext();

  session.extension(first.pi);
  await first.events.get("session_start")?.[0]?.({}, ctx);
  await first.events.get("before_agent_start")?.[0]?.({ prompt: "before reload", images: [] }, ctx);
  await first.events.get("session_shutdown")?.[0]?.({ reason: "reload" }, ctx);

  session.extension(second.pi);
  await second.events.get("session_start")?.[0]?.({}, ctx);
  await second.events.get("before_agent_start")?.[0]?.({ prompt: "after reload", images: [] }, ctx);

  const agents = backend.observations.filter(({ name }) => name === "pi.agent");
  assert.equal(agents.length, 2);
  assert.equal(agents[0]?.ended, true);
  assert.equal(agents[1]?.ended, false);
  assert.equal(runtime.closed, false);

  await session.dispose();
  await runtime.shutdown();
});

test("one controller does not let another active Pi session steal its recorder", async () => {
  const backend = new FakeBackend();
  const runtime = createLangfuseRuntimeFromBackend(backend);
  const session = createPiLangfuseSession(runtime);
  const first = createMockPi();
  const second = createMockPi();
  const firstContext = createMockContext({ cwd: "/first" }).ctx;
  const secondContext = createMockContext({ cwd: "/second" }).ctx;

  session.extension(first.pi);
  session.extension(second.pi);
  await first.events.get("session_start")?.[0]?.({}, firstContext);
  await first.events.get("before_agent_start")?.[0]?.({ prompt: "first", images: [] }, firstContext);
  await second.events.get("session_start")?.[0]?.({}, secondContext);
  await second.events.get("before_agent_start")?.[0]?.({ prompt: "second", images: [] }, secondContext);

  const agents = backend.observations.filter(({ name }) => name === "pi.agent");
  assert.equal(agents.length, 1);
  assert.equal(agents[0]?.attributes.metadata?.["pi.cwd"], "/first");
  assert.equal(agents[0]?.ended, false);

  await session.dispose();
  await runtime.shutdown();
});

test("setRequestId applies only to the next trace and onTraceId failures do not break tracing", async () => {
  const backend = new FakeBackend();
  const runtime = createLangfuseRuntimeFromBackend(backend);
  let callbackCalls = 0;
  const session = createPiLangfuseSession(runtime, {
    onTraceId: () => {
      callbackCalls += 1;
      throw new Error("host callback failed");
    },
  });
  const mock = createMockPi();
  session.extension(mock.pi);
  const { ctx } = createMockContext();
  await mock.events.get("session_start")?.[0]?.({}, ctx);

  session.setRequestId("request-1");
  await mock.events.get("before_agent_start")?.[0]?.({ prompt: "one", images: [], systemPrompt: "system" }, ctx);
  session.setRequestId("request-2");
  await mock.events.get("agent_settled")?.[0]?.({}, ctx);
  await mock.events.get("before_agent_start")?.[0]?.({ prompt: "two", images: [], systemPrompt: "system" }, ctx);
  await mock.events.get("agent_settled")?.[0]?.({}, ctx);
  await mock.events.get("turn_start")?.[0]?.({ turnIndex: 0, timestamp: 1 }, ctx);

  const agents = backend.observations.filter(({ name }) => name === "pi.agent");
  assert.equal(agents.length, 3);
  assert.equal(agents[0]?.attributes.metadata?.["pi.request.id"], "request-1");
  assert.equal(agents[1]?.attributes.metadata?.["pi.request.id"], "request-2");
  assert.equal(agents[2]?.attributes.metadata?.["pi.request.id"], undefined);
  assert.deepEqual(agents[2]?.attributes.input, { prompt: "[automatic continuation]" });
  assert.equal(callbackCalls, 3);

  await session.dispose();
  await runtime.shutdown();
});

test("setRequestId preserves a reentrant value for the following trace", async () => {
  const backend = new FakeBackend();
  const runtime = createLangfuseRuntimeFromBackend(backend);
  let callbackCalls = 0;
  let session!: ReturnType<typeof createPiLangfuseSession>;
  session = createPiLangfuseSession(runtime, {
    onTraceId: () => {
      callbackCalls += 1;
      if (callbackCalls === 1) session.setRequestId("request-same");
    },
  });
  const mock = createMockPi();
  session.extension(mock.pi);
  const { ctx } = createMockContext();
  await mock.events.get("session_start")?.[0]?.({}, ctx);

  session.setRequestId("request-same");
  for (const prompt of ["one", "two", "three"]) {
    await mock.events.get("before_agent_start")?.[0]?.({ prompt, images: [], systemPrompt: "system" }, ctx);
    await mock.events.get("agent_settled")?.[0]?.({}, ctx);
  }

  const agents = backend.observations.filter(({ name }) => name === "pi.agent");
  assert.equal(agents[0]?.attributes.metadata?.["pi.request.id"], "request-same");
  assert.equal(agents[1]?.attributes.metadata?.["pi.request.id"], "request-same");
  assert.equal(agents[2]?.attributes.metadata?.["pi.request.id"], undefined);

  await session.dispose();
  await runtime.shutdown();
});

test("host trace identifiers and tags redact embedded base64 data URIs", async () => {
  const backend = new FakeBackend();
  const runtime = createLangfuseRuntimeFromBackend(backend);
  const unsafe = "prefix data:text/plain;base64,c2VjcmV0 suffix";
  const redacted = "prefix [base64 data URI omitted] suffix";
  const session = createPiLangfuseSession(runtime, {
    traceName: unsafe,
    sessionId: unsafe,
    userId: unsafe,
    tags: [unsafe],
    captureContent: false,
  });
  const mock = createMockPi();
  session.extension(mock.pi);
  const { ctx } = createMockContext();
  await mock.events.get("session_start")?.[0]?.({}, ctx);

  session.setRequestId(unsafe);
  await mock.events.get("before_agent_start")?.[0]?.({ prompt: "private", images: [], systemPrompt: "system" }, ctx);

  const agent = backend.observations.find(({ name }) => name === "pi.agent");
  assert.equal(agent?.attributes.sessionId, redacted);
  assert.equal(agent?.attributes.userId, redacted);
  assert.equal(agent?.attributes.metadata?.["pi.request.id"], redacted);
  assert.equal(agent?.traceUpdates[0]?.name, redacted);
  assert.deepEqual(agent?.traceUpdates[0]?.tags, ["pi", redacted]);

  await session.dispose();
  await runtime.shutdown();
});

test("host session rejects user IDs above the Langfuse limit", async () => {
  const backend = new FakeBackend();
  const runtime = createLangfuseRuntimeFromBackend(backend);

  assert.throws(
    () => createPiLangfuseSession(runtime, { userId: "u".repeat(201) }),
    /userId must be at most 200 characters/u,
  );
  const maximum = createPiLangfuseSession(runtime, { userId: "u".repeat(200) });
  await maximum.dispose();
  await runtime.shutdown();
});

test("onTraceId can dispose its own session after the root is initialized", async () => {
  const backend = new FakeBackend();
  const runtime = createLangfuseRuntimeFromBackend(backend);
  let session!: ReturnType<typeof createPiLangfuseSession>;
  session = createPiLangfuseSession(runtime, {
    onTraceId: () => {
      void session.dispose();
      return Promise.reject(new Error("ignored async callback failure"));
    },
  });
  const mock = createMockPi();
  session.extension(mock.pi);
  const { ctx } = createMockContext();
  await mock.events.get("session_start")?.[0]?.({}, ctx);

  await mock.events.get("before_agent_start")?.[0]?.(
    { prompt: "dispose from callback", images: [], systemPrompt: "system" },
    ctx,
  );

  const agent = backend.observations.find(({ name }) => name === "pi.agent");
  assert.equal(agent?.traceUpdates.length, 2);
  assert.equal(agent?.ended, true);
  assert.equal(agent?.endCalls, 1);
  assert.equal(runtime.closed, false);
  await runtime.shutdown();
});

test("stale session shutdown does not flush or close a replacement session", async () => {
  const backend = new FakeBackend();
  const runtime = createLangfuseRuntimeFromBackend(backend);
  const cleanup = deferred<void>();
  const controller = createPiLangfuseSessionController({
    resolveSession: async () => ({ runtime }),
    beforeSessionDispose: async () => cleanup.promise,
    flushOnReplacement: true,
    shutdownRuntimeOnQuit: true,
  });
  const mock = createMockPi();
  controller.extension(mock.pi);
  const { ctx } = createMockContext();
  await mock.events.get("session_start")?.[0]?.({}, ctx);

  const pendingShutdown = mock.events.get("session_shutdown")?.[0]?.({ reason: "quit" }, ctx);
  await mock.events.get("session_start")?.[0]?.({}, ctx);
  cleanup.resolve();
  await pendingShutdown;

  assert.equal(controller.active, true);
  assert.equal(runtime.closed, false);
  assert.equal(backend.flushes, 0);
  assert.equal(backend.shutdowns, 0);
  await controller.dispose();
  await runtime.shutdown();
});

test("final quit shuts down a retained runtime after a replacement session cannot bind", async () => {
  const backend = new FakeBackend();
  const runtime = createLangfuseRuntimeFromBackend(backend);
  let resolveCalls = 0;
  const shutdownErrors: unknown[] = [];
  backend.forceFlush = async () => {
    backend.flushes += 1;
    if (backend.flushes === 1) throw new Error("replacement flush failed");
  };
  const controller = createPiLangfuseSessionController({
    resolveSession: async () => {
      resolveCalls += 1;
      return resolveCalls === 1 ? { runtime } : undefined;
    },
    onShutdownError: (error) => shutdownErrors.push(error),
    flushOnReplacement: true,
    shutdownRuntimeOnQuit: true,
  });
  const mock = createMockPi();
  controller.extension(mock.pi);
  const { ctx } = createMockContext();

  await mock.events.get("session_start")?.[0]?.({}, ctx);
  await mock.events.get("session_shutdown")?.[0]?.({ reason: "reload" }, ctx);
  assert.deepEqual(
    shutdownErrors.map((error) => (error instanceof Error ? error.message : String(error))),
    ["replacement flush failed"],
  );
  assert.equal(backend.shutdowns, 0);

  await mock.events.get("session_start")?.[0]?.({}, ctx);
  assert.equal(controller.active, false);
  await mock.events.get("session_shutdown")?.[0]?.({ reason: "quit" }, ctx);

  assert.equal(runtime.closed, true);
  assert.equal(backend.flushes, 2);
  assert.equal(backend.shutdowns, 1);
});

test("final quit retains a shared runtime created by never-bound stale initialization", async () => {
  const backend = new FakeBackend();
  const runtime = createLangfuseRuntimeFromBackend(backend);
  const firstStart = deferred<{ runtime: typeof runtime; releaseIfStale: (reason: string) => Promise<void> }>();
  const initializationStarted = deferred<void>();
  const staleReasons: string[] = [];
  let resolveCalls = 0;
  const controller = createPiLangfuseSessionController({
    resolveSession: async () => {
      resolveCalls += 1;
      if (resolveCalls > 1) return undefined;
      initializationStarted.resolve();
      return firstStart.promise;
    },
    shutdownRuntimeOnQuit: true,
  });
  const mock = createMockPi();
  controller.extension(mock.pi);
  const { ctx } = createMockContext();

  const pendingFirstStart = mock.events.get("session_start")?.[0]?.({}, ctx);
  await initializationStarted.promise;
  await mock.events.get("session_start")?.[0]?.({}, ctx);
  firstStart.resolve({
    runtime,
    releaseIfStale: async (reason) => {
      staleReasons.push(reason);
    },
  });
  await pendingFirstStart;

  assert.deepEqual(staleReasons, ["replaced"]);
  assert.equal(controller.active, false);
  await mock.events.get("session_shutdown")?.[0]?.({ reason: "quit" }, ctx);
  assert.equal(runtime.closed, true);
  assert.equal(backend.flushes, 1);
  assert.equal(backend.shutdowns, 1);
});

test("final quit joins every superseded initialization before returning", async () => {
  const backend = new FakeBackend();
  const runtime = createLangfuseRuntimeFromBackend(backend);
  const firstStart = deferred<{ runtime: typeof runtime; releaseIfStale: (reason: string) => Promise<void> }>();
  const initializationStarted = deferred<void>();
  const staleReasons: string[] = [];
  let resolveCalls = 0;
  const controller = createPiLangfuseSessionController({
    resolveSession: async () => {
      resolveCalls += 1;
      if (resolveCalls > 1) return undefined;
      initializationStarted.resolve();
      return firstStart.promise;
    },
    shutdownRuntimeOnQuit: true,
  });
  const mock = createMockPi();
  controller.extension(mock.pi);
  const { ctx } = createMockContext();

  const pendingFirstStart = mock.events.get("session_start")?.[0]?.({}, ctx);
  await initializationStarted.promise;
  await mock.events.get("session_start")?.[0]?.({}, ctx);
  const pendingShutdown = Promise.resolve(mock.events.get("session_shutdown")?.[0]?.({ reason: "quit" }, ctx));
  let shutdownSettled = false;
  void pendingShutdown.then(() => {
    shutdownSettled = true;
  });
  await Promise.resolve();
  assert.equal(shutdownSettled, false);

  firstStart.resolve({
    runtime,
    releaseIfStale: async (reason) => {
      staleReasons.push(reason);
      if (reason === "quit") await runtime.shutdown();
    },
  });
  await Promise.all([pendingFirstStart, pendingShutdown]);

  assert.deepEqual(staleReasons, ["quit"]);
  assert.equal(shutdownSettled, true);
  assert.equal(runtime.closed, true);
  assert.equal(backend.shutdowns, 1);
});

test("runtime shutdown wins a race with asynchronous trace initialization", async () => {
  const backend = new FakeBackend();
  const runtime = createLangfuseRuntimeFromBackend(backend);
  const git = deferred<{ branch: string; detached: false }>();
  const controller = createPiLangfuseSessionController({
    resolveSession: async () => ({ runtime }),
    resolveGitMetadata: async () => git.promise,
  });
  const mock = createMockPi();
  controller.extension(mock.pi);
  const { ctx } = createMockContext();
  await mock.events.get("session_start")?.[0]?.({}, ctx);

  const pending = mock.events.get("before_agent_start")?.[0]?.(
    { prompt: "must not be traced", images: [], systemPrompt: "system" },
    ctx,
  );
  await runtime.shutdown();
  git.resolve({ branch: "main", detached: false });
  await pending;

  assert.equal(controller.active, false);
  assert.equal(backend.observations.length, 0);
  assert.equal(backend.shutdowns, 1);
});

test("disposing during asynchronous session initialization joins cleanup and leaves the shared runtime open", async () => {
  const backend = new FakeBackend();
  const runtime = createLangfuseRuntimeFromBackend(backend);
  const start = deferred<{ runtime: typeof runtime }>();
  const controller = createPiLangfuseSessionController({
    resolveSession: async () => start.promise,
  });
  const mock = createMockPi();
  controller.extension(mock.pi);
  const { ctx } = createMockContext();

  const pendingStart = mock.events.get("session_start")?.[0]?.({}, ctx);
  const pendingDispose = controller.dispose();
  let disposeSettled = false;
  void pendingDispose.then(() => {
    disposeSettled = true;
  });
  await Promise.resolve();
  assert.equal(disposeSettled, false);

  start.resolve({ runtime });
  await Promise.all([pendingStart, pendingDispose]);

  assert.equal(disposeSettled, true);
  assert.equal(controller.active, false);
  assert.equal(runtime.closed, false);
  assert.equal(backend.shutdowns, 0);
  await runtime.shutdown();
  assert.equal(backend.shutdowns, 1);
});

test("session shutdown reports stale initialization cleanup failures", async () => {
  const backend = new FakeBackend();
  const runtime = createLangfuseRuntimeFromBackend(backend);
  const cleanupError = new Error("stale cleanup failed");
  const start = deferred<{
    runtime: typeof runtime;
    releaseIfStale: () => Promise<void>;
  }>();
  const shutdownErrors: unknown[] = [];
  const controller = createPiLangfuseSessionController({
    resolveSession: async () => start.promise,
    onShutdownError: (error) => shutdownErrors.push(error),
  });
  const mock = createMockPi();
  controller.extension(mock.pi);
  const { ctx } = createMockContext();

  const pendingStart = Promise.resolve(mock.events.get("session_start")?.[0]?.({}, ctx));
  const startFailure = assert.rejects(pendingStart, /stale cleanup failed/u);
  const pendingShutdown = Promise.resolve(mock.events.get("session_shutdown")?.[0]?.({ reason: "quit" }, ctx));
  start.resolve({
    runtime,
    releaseIfStale: async () => {
      throw cleanupError;
    },
  });
  await Promise.all([startFailure, pendingShutdown]);

  assert.deepEqual(shutdownErrors, [cleanupError]);
  await runtime.shutdown();
});

test("controller disposal reports stale initialization cleanup failures", async () => {
  const backend = new FakeBackend();
  const runtime = createLangfuseRuntimeFromBackend(backend);
  const cleanupError = new Error("dispose cleanup failed");
  const start = deferred<{
    runtime: typeof runtime;
    releaseIfStale: () => Promise<void>;
  }>();
  const controller = createPiLangfuseSessionController({
    resolveSession: async () => start.promise,
  });
  const mock = createMockPi();
  controller.extension(mock.pi);
  const { ctx } = createMockContext();

  const pendingStart = Promise.resolve(mock.events.get("session_start")?.[0]?.({}, ctx));
  const startFailure = assert.rejects(pendingStart, /dispose cleanup failed/u);
  const pendingDispose = controller.dispose();
  const disposeFailure = assert.rejects(pendingDispose, /dispose cleanup failed/u);
  start.resolve({
    runtime,
    releaseIfStale: async () => {
      throw cleanupError;
    },
  });
  await Promise.all([startFailure, disposeFailure]);

  await runtime.shutdown();
});
