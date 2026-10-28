import assert from "node:assert/strict";
import { afterEach, test, vi } from "vitest";
import { createMockPi } from "../../../test/support.js";
import { MessageBroker } from "../src/message-broker.js";
import { COMPLETION_MESSAGE_TYPE } from "../src/message-renderers.js";
import { type StartJobInput, SubagentRuntime } from "../src/runtime.js";
import type { ChildRequest, ChildResult } from "../src/types.js";

const cleanup: Array<() => Promise<void>> = [];
const input: StartJobInput = {
  task: "Test completion delivery",
  tools: [],
  skills: [],
  extensions: [],
  toolSources: {},
  provider: "test",
  model: "test-model",
  thinkingLevel: "off",
  defaultThinkingLevel: "off",
  cwd: process.cwd(),
  projectTrusted: false,
};

afterEach(async () => {
  try {
    for (const release of cleanup.splice(0).reverse()) await release();
  } finally {
    vi.restoreAllMocks();
  }
});

test("terminal listener shutdown suppresses completion synchronously", async () => {
  const f = await fixture();
  const { jobId } = f.runtime.start(input);
  await f.started.promise;
  let observedState: string | undefined;
  let shutdown: Promise<void> | undefined;
  f.subscribe(() => {
    const state = f.runtime.inspectJobs().jobs.find((job) => job.jobId === jobId)?.state;
    if (state !== "completed" || shutdown) return;
    observedState = state;
    shutdown = f.track(f.runtime.shutdown());
  });
  const waiting = f.track(f.runtime.wait(jobId, undefined));
  f.childResult.resolve(completed("retained after shutdown"));

  assert.deepEqual(await waiting, {
    jobId,
    state: "completed",
    timedOut: false,
    result: "retained after shutdown",
  });
  assert.equal(observedState, "completed");
  assert.ok(shutdown);
  await shutdown;
  assert.deepEqual(f.mock.sentMessages, []);
  assert.throws(() => f.runtime.start(input), /session is not active/u);
});

test("terminal listener reentrant cancellation delivers completion once", async () => {
  const f = await fixture();
  const { jobId } = f.runtime.start(input);
  await f.started.promise;
  let observedState: string | undefined;
  let cancellation: ReturnType<SubagentRuntime["cancel"]> | undefined;
  f.subscribe(() => {
    const state = f.runtime.inspectJobs().jobs.find((job) => job.jobId === jobId)?.state;
    if (state !== "completed" || cancellation) return;
    observedState = state;
    cancellation = f.track(f.runtime.cancel(jobId));
  });
  const waiting = f.track(f.runtime.wait(jobId, undefined));
  f.childResult.resolve(completed("original result"));

  const result = await waiting;
  assert.equal(observedState, "completed");
  assert.ok(cancellation);
  assert.deepEqual(await cancellation, { jobId, state: "completed" });
  assert.deepEqual(result, { jobId, state: "completed", timedOut: false, result: "original result" });
  await f.runtime.cancel(jobId);
  assert.deepEqual(await f.runtime.wait(jobId, undefined), result);
  assertCompletion(f.mock, result);
});

test("two cancellations join held child teardown and discard its stale result", async () => {
  const f = await fixture();
  const { jobId } = f.runtime.start(input);
  const request = await f.started.promise;
  let firstSettled = false;
  let secondSettled = false;
  const first = f.track(
    f.runtime.cancel(jobId).then((result) => {
      firstSettled = true;
      return result;
    }),
  );
  await f.aborted.promise;
  const second = f.track(
    f.runtime.cancel(jobId).then((result) => {
      secondSettled = true;
      return result;
    }),
  );
  assert.equal(request.signal.aborted, true);
  assert.equal(firstSettled, false);
  assert.equal(secondSettled, false);
  assert.equal(f.runtime.inspectJobs().jobs[0]?.state, "running");
  assert.deepEqual(f.mock.sentMessages, []);

  f.childResult.resolve({ ...completed("stale child result"), limitations: ["stale limitation"] });
  assert.deepEqual(await Promise.all([first, second]), [
    { jobId, state: "cancelled" },
    { jobId, state: "cancelled" },
  ]);
  const result = await f.runtime.wait(jobId, undefined);
  assert.deepEqual(result, {
    jobId,
    state: "cancelled",
    timedOut: false,
    error: "Subagent execution was cancelled.",
  });
  assertCompletion(f.mock, result);
});

test("throwing sendMessage with reentrant cancellation retains the result without retry", async () => {
  const f = await fixture();
  const { jobId } = f.runtime.start(input);
  await f.started.promise;
  let observedState: string | undefined;
  let cancellation: ReturnType<SubagentRuntime["cancel"]> | undefined;
  const send = vi.spyOn(f.mock.rawPi, "sendMessage").mockImplementation(() => {
    observedState = f.runtime.inspectJobs().jobs.find((job) => job.jobId === jobId)?.state;
    cancellation = f.track(f.runtime.cancel(jobId));
    throw new Error("Completion delivery failed");
  });
  const waiting = f.track(f.runtime.wait(jobId, undefined));
  f.childResult.resolve(completed("available through wait"));

  const result = await waiting;
  assert.equal(observedState, "completed");
  assert.ok(cancellation);
  assert.deepEqual(await cancellation, { jobId, state: "completed" });
  assert.deepEqual(result, {
    jobId,
    state: "completed",
    timedOut: false,
    result: "available through wait",
  });
  assert.equal(send.mock.calls.length, 1);
  const [message, options] = send.mock.calls[0] ?? [];
  assert.deepEqual((message as { details: unknown }).details, result);
  assert.deepEqual(options, { deliverAs: "steer" });
  await f.runtime.cancel(jobId);
  assert.deepEqual(await f.runtime.wait(jobId, undefined), result);
  assert.equal(f.runtime.inspectJobs().jobs[0]?.state, "completed");
  await f.runtime.shutdown();
  assert.deepEqual(await f.runtime.wait(jobId, undefined), result);
  assert.equal(send.mock.calls.length, 1);
  assert.deepEqual(f.mock.sentMessages, []);
});

test.each(["after start", "from queued listener"] as const)(
  "cancellation %s completes once without starting the queued child",
  async (when) => {
    const f = await fixture();
    let cancellation: ReturnType<SubagentRuntime["cancel"]> | undefined;
    if (when === "from queued listener") {
      f.subscribe(() => {
        const queued = f.runtime.inspectJobs().jobs.find((job) => job.state === "queued");
        if (queued && !cancellation) cancellation = f.track(f.runtime.cancel(queued.jobId));
      });
    }
    const { jobId } = f.runtime.start(input);
    cancellation ??= f.track(f.runtime.cancel(jobId));

    assert.deepEqual(await cancellation, { jobId, state: "cancelled" });
    assert.deepEqual(f.requests, []);
    const result = await f.runtime.wait(jobId, undefined);
    assert.deepEqual(result, {
      jobId,
      state: "cancelled",
      timedOut: false,
      error: "Subagent execution was cancelled.",
    });
    await f.runtime.cancel(jobId);
    assertCompletion(f.mock, result);
  },
);

async function fixture() {
  const mock = createMockPi();
  const broker = new MessageBroker({ onMessage() {} });
  const started = deferred<ChildRequest>();
  const aborted = deferred<void>();
  const childResult = deferred<ChildResult>();
  const requests: ChildRequest[] = [];
  const operations: Promise<unknown>[] = [];
  const unsubscribers: Array<() => void> = [];
  const runtime = new SubagentRuntime(mock.pi, broker, {
    runChild: async (request) => {
      requests.push(request);
      const onAbort = () => aborted.resolve();
      request.signal.addEventListener("abort", onAbort, { once: true });
      if (request.signal.aborted) onAbort();
      started.resolve(request);
      try {
        return await childResult.promise;
      } finally {
        request.signal.removeEventListener("abort", onAbort);
      }
    },
  });
  cleanup.push(async () => {
    for (const unsubscribe of unsubscribers) unsubscribe();
    try {
      const shutdown = runtime.shutdown();
      childResult.resolve(completed("cleanup"));
      await shutdown;
      await Promise.allSettled(operations);
    } finally {
      await broker.shutdown();
    }
  });
  await broker.start();
  runtime.beginSession();
  return {
    mock,
    runtime,
    started,
    aborted,
    childResult,
    requests,
    subscribe(listener: () => void) {
      unsubscribers.push(runtime.subscribeJobs(listener));
    },
    track<T>(operation: Promise<T>): Promise<T> {
      operations.push(operation);
      void operation.catch(() => undefined);
      return operation;
    },
  };
}

function assertCompletion(mock: ReturnType<typeof createMockPi>, result: unknown) {
  assert.equal(mock.sentMessages.length, 1);
  const sent = mock.sentMessages[0];
  assert.ok(sent);
  const message = sent.message as { customType: string; details: unknown };
  assert.equal(message.customType, COMPLETION_MESSAGE_TYPE);
  assert.deepEqual(message.details, result);
  assert.deepEqual(sent.options, { deliverAs: "steer" });
}

function completed(result: string): ChildResult {
  return { state: "completed", result, limitations: [], truncated: false };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
