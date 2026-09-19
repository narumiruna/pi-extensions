import assert from "node:assert/strict";
import { test } from "vitest";
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

test("setRequestId applies to future traces and onTraceId failures do not break tracing", async () => {
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
  session.setRequestId(undefined);
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

test("disposing during asynchronous session initialization leaves the shared runtime open", async () => {
  const backend = new FakeBackend();
  const runtime = createLangfuseRuntimeFromBackend(backend);
  const start = deferred<{ runtime: typeof runtime }>();
  const controller = createPiLangfuseSessionController({
    resolveSession: async () => start.promise,
  });
  const mock = createMockPi();
  controller.extension(mock.pi);
  const { ctx } = createMockContext();

  const pending = mock.events.get("session_start")?.[0]?.({}, ctx);
  await controller.dispose();
  start.resolve({ runtime });
  await pending;

  assert.equal(controller.active, false);
  assert.equal(runtime.closed, false);
  assert.equal(backend.shutdowns, 0);
  await runtime.shutdown();
  assert.equal(backend.shutdowns, 1);
});
