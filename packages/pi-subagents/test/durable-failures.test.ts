import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { awaitWithContext, BACKGROUND_CONTEXT, type Context, withCancel } from "@earendil-works/chord/context";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  type DocumentObserver,
  type DocumentWatch,
  defineTask,
  Harness,
  type Storage,
  type TaskId,
  type WatchEnd,
} from "@earendil-works/pi-durable";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type DurableProfile, type DurableRuntimeOptions, DurableSubagentRuntime } from "../src/durable-runtime.js";
import { type DurableState, DurableStateDoc } from "../src/durable-state.js";
import { observeState } from "../src/durable-tasks.js";
import { runtimeModels } from "./durable-runtime-worker.js";

const context = BACKGROUND_CONTEXT;
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  const errors: unknown[] = [];
  try {
    for (const close of cleanup.splice(0).reverse()) {
      try {
        await close();
      } catch (error) {
        errors.push(error);
      }
    }
  } finally {
    vi.restoreAllMocks();
  }
  if (errors.length) throw new AggregateError(errors, "Durable failure test cleanup failed");
});

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

class Checkpoints {
  private readonly arrivals = new Map<string, ReturnType<typeof deferred>>();
  private readonly gates = new Map<string, ReturnType<typeof deferred>>();
  readonly counts = new Map<string, number>();
  fault?: string;
  constructor(...blocked: string[]) {
    for (const name of blocked) this.gates.set(name, deferred());
  }
  checkpoint = async (name: string, ctx: Context) => {
    this.counts.set(name, (this.counts.get(name) ?? 0) + 1);
    this.arrival(name).resolve(undefined);
    const gate = this.gates.get(name);
    if (gate) await awaitWithContext(gate.promise, ctx);
    if (name === this.fault) throw new Error(`checkpoint failure: ${name}`);
  };
  private arrival(name: string) {
    let arrival = this.arrivals.get(name);
    if (!arrival) {
      arrival = deferred();
      this.arrivals.set(name, arrival);
    }
    return arrival;
  }
  reached(name: string) {
    return this.arrival(name).promise;
  }
  block(name: string) {
    this.arrivals.delete(name);
    this.gates.set(name, deferred());
  }
  release(name: string) {
    this.gates.get(name)?.resolve(undefined);
    this.gates.delete(name);
  }
}

async function fixture(options: Partial<DurableRuntimeOptions> = {}, checkpoints = new Checkpoints()) {
  const root = options.directory ?? (await mkdtemp(join(tmpdir(), "subagents-failures-")));
  if (!options.directory) cleanup.push(() => rm(root, { recursive: true, force: true }));
  const source = runtimeModels(checkpoints.checkpoint);
  const nativeOpen = Harness.open;
  let harness!: Harness;
  let storage!: Storage;
  const capture = vi.spyOn(Harness, "open").mockImplementation(async (store, settings, ctx) => {
    storage = store;
    harness = await nativeOpen(store, settings, ctx);
    return harness;
  });
  let runtime: DurableSubagentRuntime;
  try {
    runtime = await DurableSubagentRuntime.open({
      directory: root,
      binding: "failure-regressions:linear-session",
      models: source.models,
      authorize: async () => {},
      checkpoint: checkpoints.checkpoint,
      ...options,
    });
  } finally {
    capture.mockRestore();
  }
  cleanup.push(() => runtime.shutdown());
  const profile: DurableProfile = {
    model: source.model,
    thinkingLevel: "off",
    tools: ["read"],
    cwd: root,
    trusted: true,
  };
  return { runtime, profile, root, checkpoints, harness, storage, ...source };
}

// Bound failure assertions without sleeping or letting a broken waiter consume the test timeout.
async function promptly<T>(work: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error("Failure was not observable to the waiter")), 1000);
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

async function rejectsPromptly(work: Promise<unknown>) {
  const result = await promptly(
    work.then(
      () => ({ rejected: false, error: undefined }),
      (error: unknown) => ({ rejected: true, error }),
    ),
  );
  expect(result.rejected).toBe(true);
  return result.error;
}

function mockDocumentObserver() {
  const ended = deferred<WatchEnd>();
  const started = deferred();
  const stop = vi.fn(async () => ({ reason: "stopped" as const }));
  const watch: DocumentWatch<DurableState> = {
    value: { version: 1, agents: {}, requests: {}, reports: {}, stops: {} },
    start: () => started.resolve(),
    stop,
    closed: ended.promise,
  };
  const owner = { watchDoc: vi.fn(async () => watch) } as unknown as DocumentObserver;
  return { owner, watch, ended, started, stop };
}

describe("durable document observation failures", () => {
  it.each(["session_failed", "session_closed", "retired", "listener_error", "cancelled", "stopped"] as const)(
    "rejects an unmet predicate when its watch ends with %s and disposes the watch",
    async (reason) => {
      const mock = mockDocumentObserver();
      const waiting = observeState(mock.owner, () => undefined, context);
      await mock.started.promise;
      const error = new Error("document storage failure");
      mock.ended.resolve(reason === "session_failed" || reason === "listener_error" ? { reason, error } : { reason });
      await rejectsPromptly(waiting);
      expect(mock.stop).toHaveBeenCalledOnce();
    },
  );

  it("disposes the watch when selection throws or the caller cancels", async () => {
    const first = mockDocumentObserver();
    await expect(
      observeState(
        first.owner,
        () => {
          throw new Error("invalid state");
        },
        context,
      ),
    ).rejects.toThrow("invalid state");
    expect(first.stop).toHaveBeenCalledOnce();
    const second = mockDocumentObserver();
    const cancelled = withCancel(context);
    const waiting = observeState(second.owner, () => undefined, cancelled.context);
    await second.started.promise;
    cancelled.cancel(new Error("caller cancelled"));
    await expect(waiting).rejects.toThrow();
    expect(second.stop).toHaveBeenCalledOnce();
  });
});

// Real native Harness, JSONL storage, Faux model, and Linux descriptor ownership; no fake effect runtime.
describe.skipIf(process.platform !== "linux")("durable native workflow failure recovery", () => {
  it.each(["submitted", "settled"] as const)(
    "suspends a %s reporter fault and recovers only on an explicit matching reopen",
    async (stage) => {
      const checkpoints = new Checkpoints(stage);
      checkpoints.fault = stage;
      const f = await fixture({}, checkpoints);
      const agent = await f.runtime.spawn("original-call", "A", f.profile, 60_000);
      await checkpoints.reached(stage);
      const before = await f.runtime.state();
      const saved = before.requests[agent.requestId];
      expect(saved?.deadline).not.toBeNull();
      const taskId = saved?.taskId as TaskId;
      const publications: unknown[] = [];
      const unsubscribe = f.harness.subscribeCommits((publication) => {
        for (const change of publication.changes)
          if (change.type === "task" && change.value.id === taskId) publications.push(change.value.state);
      });
      cleanup.push(async () => unsubscribe());
      const waiting = f.runtime.wait(agent.conversationId, undefined);
      checkpoints.release(stage);
      await rejectsPromptly(waiting);
      await f.runtime.shutdown();
      expect(publications).toContainEqual({
        status: "terminal",
        outcome: { status: "faulted", error: { message: `checkpoint failure: ${stage}` } },
      });
      expect(publications).not.toContainEqual(expect.objectContaining({ outcome: { status: "aborted" } }));
      expect(checkpoints.counts.get(stage)).toBe(1);

      const next = await fixture({ directory: f.root }, new Checkpoints("submitted"));
      const restored = (await next.runtime.state()).requests[agent.requestId];
      expect(restored).toEqual({ ...saved, taskId: expect.any(Number) });
      expect(restored).toMatchObject({ outcome: null, cancelOutcome: null });
      expect(restored?.taskId).not.toBe(taskId);
      expect(await next.harness.getTask(taskId, context)).toMatchObject({
        state: { status: "terminal", outcome: { status: "faulted" } },
      });
      expect(await next.runtime.spawn("original-call", "A", next.profile, 60_000)).toEqual(agent);
      const recovered = next.runtime.wait(agent.conversationId, undefined);
      next.checkpoints.release("submitted");
      expect(await recovered).toMatchObject({ outcome: "completed", result: "answer:A", timedOut: false });
      expect(Object.keys((await next.runtime.state()).agents)).toEqual([agent.conversationId]);
      expect(Object.keys((await next.runtime.state()).requests)).toEqual([agent.requestId]);
      expect(await next.runtime.reports()).toHaveLength(1);
      if (stage === "settled") expect(next.faux.state.callCount).toBe(0);
    },
  );

  it("does not let a throwing transition observer fault native work or prevent later assignments", async () => {
    const changed = vi.fn(() => {
      throw new Error("observer failure");
    });
    const f = await fixture({ changed });
    const agent = await f.runtime.spawn("first", "A", f.profile, null);
    expect(await f.runtime.wait(agent.conversationId, undefined)).toMatchObject({
      outcome: "completed",
      result: "answer:A",
    });
    await f.runtime.send(agent.conversationId, "second", "B", "followUp");
    expect(await f.runtime.wait(agent.conversationId, undefined)).toMatchObject({
      outcome: "completed",
      result: "answer:B",
    });
    expect(changed).toHaveBeenCalled();
    for (const request of Object.values((await f.runtime.state()).requests))
      expect(await f.harness.getTask(request.taskId as TaskId, context)).toMatchObject({
        state: { status: "terminal", outcome: { status: "completed" } },
      });
    expect(f.faux.state.callCount).toBe(2);
  });

  it("retains completed reporter records and reports when another reporter needs reconstruction", async () => {
    const checkpoints = new Checkpoints();
    const f = await fixture({}, checkpoints);
    const completed = await f.runtime.spawn("completed", "first", f.profile, null);
    await f.runtime.wait(completed.conversationId, undefined);
    const saved = await f.runtime.state();
    checkpoints.block("settled");
    checkpoints.fault = "settled";
    const pending = await f.runtime.spawn("pending", "second", f.profile, null);
    await checkpoints.reached("settled");
    const waiting = f.runtime.wait(pending.conversationId, undefined);
    checkpoints.release("settled");
    await rejectsPromptly(waiting);
    await f.runtime.shutdown();
    const next = await fixture({ directory: f.root });
    const restored = await next.runtime.state();
    expect(restored.requests.completed).toEqual(saved.requests.completed);
    for (const [id, report] of Object.entries(saved.reports)) expect(restored.reports[id]).toEqual(report);
    expect(await next.runtime.wait(pending.conversationId, undefined)).toMatchObject({ outcome: "completed" });
    expect(next.faux.state.callCount).toBe(0);
  });

  it("monitors a deadline-created stop fault after initial observation and recovers its captured boundary", async () => {
    const checkpoints = new Checkpoints("generation:A", "before-stop");
    checkpoints.fault = "before-stop";
    const f = await fixture({}, checkpoints);
    const attached = deferred<TaskId>();
    const nativeWait = f.harness.waitForTask.bind(f.harness);
    vi.spyOn(f.harness, "waitForTask").mockImplementation((id, ctx) => {
      attached.resolve(id);
      return nativeWait(id, ctx);
    });
    const agent = await f.runtime.spawn("deadline", "A", f.profile, 500);
    await checkpoints.reached("generation:A");
    expect(await attached.promise).toBe((await f.runtime.state()).requests.deadline?.taskId);
    const waiting = f.runtime.wait(agent.conversationId, undefined);
    await checkpoints.reached("before-stop");
    const captured = await f.runtime.state();
    expect(captured.requests.deadline?.outcome).toBe("timed_out");
    expect(captured.agents[agent.conversationId]?.stopTargets).toEqual(["deadline"]);
    checkpoints.release("before-stop");
    await rejectsPromptly(waiting);
    await expect(f.runtime.state()).rejects.toThrow(/suspended/i);
    await f.runtime.shutdown();

    const next = await fixture({ directory: f.root }, new Checkpoints("before-stop"));
    const restored = await next.runtime.state();
    expect(restored.requests.deadline).toEqual(captured.requests.deadline);
    expect(restored.agents[agent.conversationId]?.stopTargets).toEqual(["deadline"]);
    expect(restored.agents[agent.conversationId]?.stopTaskId).not.toBe(
      captured.agents[agent.conversationId]?.stopTaskId,
    );
    const recovered = next.runtime.wait(agent.conversationId, undefined);
    await next.checkpoints.reached("before-stop");
    next.checkpoints.release("before-stop");
    expect(await recovered).toMatchObject({ outcome: "timed_out", state: "idle", timedOut: false });
    expect(next.faux.state.callCount).toBe(0);
    await next.runtime.send(agent.conversationId, "next", "B", "followUp");
    expect(await next.runtime.wait(agent.conversationId, undefined)).toMatchObject({
      outcome: "completed",
      result: "answer:B",
    });
  });

  it("faults once again in a new matching epoch instead of retrying a broken private workflow live", async () => {
    const first = new Checkpoints("settled");
    first.fault = "settled";
    const f = await fixture({}, first);
    const agent = await f.runtime.spawn("same-call", "A", f.profile, null);
    await first.reached("settled");
    const initial = (await f.runtime.state()).requests[agent.requestId];
    const waiting = f.runtime.wait(agent.conversationId, undefined);
    first.release("settled");
    await rejectsPromptly(waiting);
    await f.runtime.shutdown();
    const again = new Checkpoints("settled");
    again.fault = "settled";
    const next = await fixture({ directory: f.root }, again);
    const resumed = next.runtime.wait(agent.conversationId, undefined);
    await again.reached("settled");
    const recovered = (await next.runtime.state()).requests[agent.requestId];
    expect(recovered?.taskId).not.toBe(initial?.taskId);
    expect(recovered?.outcome).toBeNull();
    again.release("settled");
    await rejectsPromptly(resumed);
    await next.runtime.shutdown();
    expect(first.counts.get("settled")).toBe(1);
    expect(again.counts.get("settled")).toBe(1);
    expect(next.faux.state.callCount).toBe(0);
  });

  it.each([false, true])("recovers only a captured stop scope (foreign receipt: %s)", async (foreign) => {
    const checkpoints = new Checkpoints("generation:A");
    const f = await fixture({}, checkpoints);
    const agent = await f.runtime.spawn("warm", "warm", f.profile, null);
    await f.runtime.wait(agent.conversationId, undefined);
    await f.runtime.stop(agent.conversationId, "prior-stop");
    const priorReceipt = (await f.runtime.state()).stops["prior-stop"];
    checkpoints.block("before-stop");
    checkpoints.fault = "before-stop";
    await f.runtime.send(agent.conversationId, "spawn", "A", "followUp");
    await checkpoints.reached("generation:A");
    const stopping = f.runtime.stop(agent.conversationId, "original-stop");
    await checkpoints.reached("before-stop");
    const captured = await f.runtime.state();
    const oldTask = captured.agents[agent.conversationId]?.stopTaskId;
    const oldTargets = captured.agents[agent.conversationId]?.stopTargets;
    if (foreign)
      await f.harness.commit(async (tx) => {
        (await tx.doc(DurableStateDoc)).stops["foreign-stop"] = { conversationId: 999_999, taskId: oldTask as number };
      }, context);
    const waiting = f.runtime.wait(agent.conversationId, undefined);
    checkpoints.release("before-stop");
    await Promise.all([rejectsPromptly(stopping), rejectsPromptly(waiting)]);
    await f.runtime.shutdown();
    if (foreign) {
      await expect(fixture({ directory: f.root })).rejects.toThrow(/receipt ownership/i);
      return;
    }

    const next = await fixture({ directory: f.root }, new Checkpoints("before-stop", "generation:B"));
    const recovered = await next.runtime.state();
    const newTask = recovered.agents[agent.conversationId]?.stopTaskId;
    expect(newTask).not.toBe(oldTask);
    expect(recovered.agents[agent.conversationId]?.stopTargets).toEqual(oldTargets);
    expect(recovered.stops["original-stop"]?.taskId).toBe(newTask);
    expect(recovered.stops["prior-stop"]).toEqual(priorReceipt);
    const stoppingAgain = next.runtime.stop(agent.conversationId, "original-stop");
    await next.checkpoints.reached("before-stop");
    next.checkpoints.release("before-stop");
    expect(await stoppingAgain).toMatchObject({ state: "idle" });
    expect(await next.runtime.wait(agent.conversationId, undefined)).toMatchObject({ outcome: "cancelled" });
    expect(next.faux.state.callCount).toBe(0);
    await next.runtime.send(agent.conversationId, "new-work", "B", "followUp");
    await next.checkpoints.reached("generation:B");
    await next.runtime.stop(agent.conversationId, "original-stop");
    await next.runtime.stop(agent.conversationId, "prior-stop");
    expect((await next.runtime.state()).requests["new-work"]).toMatchObject({ outcome: null, cancelOutcome: null });
    next.checkpoints.release("generation:B");
    expect(await next.runtime.wait(agent.conversationId, undefined)).toMatchObject({
      requestId: "new-work",
      outcome: "completed",
      result: "answer:B",
    });
  });

  it.each(["missing", "kind", "version"] as const)(
    "fails closed for a pending request with a %s native task",
    async (kind) => {
      const checkpoints = new Checkpoints("submitted");
      const f = await fixture({}, checkpoints);
      await f.runtime.spawn("spawn", "A", f.profile, null);
      await checkpoints.reached("submitted");
      await (await f.harness.root(context)).commit(async (tx) => {
        const state = await tx.doc(DurableStateDoc);
        const request = state.requests.spawn;
        if (!request) throw new Error("Missing test request");
        request.taskId =
          kind === "missing"
            ? 999_999
            : await tx.createTask(
                defineTask<null, { phase: "done" }, null>({
                  name: kind === "kind" ? "unrelated.private-workflow" : "pi-subagents.reporter",
                  version: kind === "version" ? 999 : 1,
                  initial: () => ({ phase: "done" }),
                  phases: { done: async () => {} },
                  abort: async () => {},
                }),
                null,
                { ownership: { kind: "conversation" }, background: true },
              );
      }, context);
      await f.runtime.shutdown();
      await expect(fixture({ directory: f.root })).rejects.toThrow();
    },
  );

  it("uses one committed document for a targeted status instead of mixing request frontiers", async () => {
    const f = await fixture();
    const agent = await f.runtime.spawn("spawn", "A", f.profile, null);
    await f.runtime.wait(agent.conversationId, undefined);
    const before = await f.runtime.state();
    await f.runtime.send(agent.conversationId, "new", "B", "followUp");
    await f.runtime.wait(agent.conversationId, undefined);
    const snapshot = vi.spyOn(f.harness, "snapshot");
    snapshot.mockResolvedValueOnce(before);
    expect(await f.runtime.status(agent.conversationId)).toMatchObject({
      conversations: [{ conversationId: agent.conversationId, requestId: "spawn", outcome: "completed" }],
    });
    expect(snapshot).toHaveBeenCalledOnce();
  });

  it("clears its waiter timer and cancellation scope when native resume throws synchronously", async () => {
    const f = await fixture({}, new Checkpoints("generation:A"));
    const agent = await f.runtime.spawn("spawn", "A", f.profile, null);
    await f.checkpoints.reached("generation:A");
    const allocate = vi.spyOn(globalThis, "setTimeout");
    const clear = vi.spyOn(globalThis, "clearTimeout");
    const resume = vi.spyOn(f.harness, "resume").mockImplementationOnce(() => {
      throw new Error("native resume failed");
    });
    await expect(f.runtime.wait(agent.conversationId, 60_000)).rejects.toThrow("native resume failed");
    const timerIndex = allocate.mock.calls.findIndex((args) => args[1] === 60_000);
    expect(timerIndex).toBeGreaterThanOrEqual(0);
    expect(clear).toHaveBeenCalledWith(allocate.mock.results[timerIndex]?.value);
    resume.mockRestore();
    await f.runtime.shutdown();
  });

  it("cancels its allocated waiter scope when timer allocation throws synchronously", async () => {
    const f = await fixture({}, new Checkpoints("generation:A"));
    const agent = await f.runtime.spawn("spawn", "A", f.profile, null);
    await f.checkpoints.reached("generation:A");
    const caller = new AbortController();
    const NativeController = globalThis.AbortController;
    const allocated: AbortController[] = [];
    vi.spyOn(globalThis, "AbortController").mockImplementation(
      class extends NativeController {
        constructor() {
          super();
          allocated.push(this);
        }
      },
    );
    const timer = vi.spyOn(globalThis, "setTimeout").mockImplementationOnce(() => {
      throw new Error("timer allocation failed");
    });
    await expect(f.runtime.wait(agent.conversationId, 60_000, caller.signal)).rejects.toThrow(
      "timer allocation failed",
    );
    timer.mockRestore();
    expect(allocated).toHaveLength(1);
    expect(allocated[0]?.signal.aborted).toBe(true);
    expect(caller.signal.aborted).toBe(false);
  });

  it("starts a new flush when changed arrives after inner work resolves but before an outer finally could run", async () => {
    const f = await fixture();
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = join(f.root, "agent");
    cleanup.push(async () => {
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    });
    // Import after setting the agent directory; extension modules can cache Pi paths.
    vi.resetModules();
    const { SessionManager } = await import("@earendil-works/pi-coding-agent");
    const { DurableMainBridge } = await import("../src/durable-main-bridge.js");
    const { registerDurableTools } = await import("../src/durable-tools.js");
    const manager = SessionManager.create(f.root, join(f.root, "main-session"));
    manager.appendMessage({ role: "user", content: "Existing main conversation", timestamp: 1 });
    const pi = {
      registerTool: () => {},
      appendEntry: (type: string, data: unknown) => manager.appendCustomEntry(type, data),
      sendMessage: () => {},
    } as unknown as ExtensionAPI;
    const ctx = {
      sessionManager: manager,
      cwd: f.root,
      modelRegistry: {},
      isIdle: () => true,
      isProjectTrusted: () => true,
      hasUI: false,
      mode: "json",
    } as unknown as ExtensionContext;
    let changed: (() => void) | undefined;
    const registered = registerDurableTools(pi, {
      openRuntime: async (options) => {
        changed = options.changed;
        return f.runtime;
      },
    });
    cleanup.push(() => registered.shutdown(ctx));
    await registered.startSession(ctx);
    const entered = deferred();
    const release = deferred<{ acknowledged: string[]; pending: string[] }>();
    const second = deferred();
    const nativeFlush = DurableMainBridge.prototype.flush;
    const flush = vi.spyOn(DurableMainBridge.prototype, "flush");
    flush
      .mockImplementationOnce(() => {
        entered.resolve();
        return release.promise;
      })
      .mockImplementationOnce(function (this: InstanceType<typeof DurableMainBridge>, reports, callbacks) {
        second.resolve();
        return nativeFlush.call(this, reports, callbacks);
      });
    const first = registered.settled(ctx);
    await entered.promise;
    // Resolution queues inner work first. This callback then runs before the
    // continuation of any outer await/finally, exactly at the old lost-wakeup gap.
    release.resolve({ acknowledged: [], pending: [] });
    queueMicrotask(() => changed?.());
    await first;
    await promptly(second.promise);
    expect(flush).toHaveBeenCalledTimes(2);
  });

  it("rejects an uncancelled waiter when native storage fails and releases ownership on shutdown", async () => {
    const f = await fixture({}, new Checkpoints("generation:A"));
    const agent = await f.runtime.spawn("spawn", "A", f.profile, null);
    await f.checkpoints.reached("generation:A");
    const attached = deferred();
    const nativeWatch = f.harness.watchDoc.bind(f.harness);
    const watch = vi.spyOn(f.harness, "watchDoc").mockImplementation(async (...args) => {
      const result = await (nativeWatch as (...args: unknown[]) => Promise<DocumentWatch<DurableState> | undefined>)(
        ...args,
      );
      attached.resolve();
      return result;
    });
    const abort = new AbortController();
    const waiting = f.runtime.wait(agent.conversationId, undefined, abort.signal);
    await attached.promise;
    vi.spyOn(f.storage, "commit").mockRejectedValueOnce(new Error("native storage failed"));
    await expect(
      f.harness.commit(async (tx) => {
        const state = await tx.doc(DurableStateDoc);
        state.version += 1;
      }, context),
    ).rejects.toThrow();
    await rejectsPromptly(waiting);
    expect(abort.signal.aborted).toBe(false);
    expect(await f.harness.closed).toMatchObject({ reason: "failed" });
    watch.mockRestore();
    await Promise.all([f.runtime.shutdown(), f.runtime.shutdown()]);
    const next = await fixture({ directory: f.root });
    expect(await next.runtime.wait(agent.conversationId, undefined)).toMatchObject({ outcome: "completed" });
  });
});
