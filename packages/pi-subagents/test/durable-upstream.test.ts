import { appendFile, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { awaitWithContext, BACKGROUND_CONTEXT, type Context, withAbortSignal } from "@earendil-works/chord/context";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall, Type } from "@earendil-works/pi-ai";
import {
  AgentDoc,
  createRegistry,
  defineDoc,
  defineExtension,
  defineTask,
  defineTool,
  Harness,
  hook,
  MemoryStorage,
  SessionFailed,
  type Storage,
  type StorageWrite,
  ToolTask,
} from "@earendil-works/pi-durable";
import { openNodeJsonlStorage } from "@earendil-works/pi-durable/storage/jsonl/node";
import { afterEach, describe, expect, it } from "vitest";

const context = BACKGROUND_CONTEXT;
const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  const errors: unknown[] = [];
  for (const close of cleanup.splice(0).reverse()) {
    try {
      await close();
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length) throw new AggregateError(errors, "Durable test cleanup failed");
});

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

// MemoryStorage normally cannot reopen after close. Keep only the backend alive between
// Harness instances; the last cleanup still closes it. No scheduler/runtime object is reused.
class ReopenableMemory extends MemoryStorage {
  failure: Error | undefined;
  closeCalls = 0;
  override async commit(writes: readonly StorageWrite[], ctx: Context) {
    if (this.failure) throw this.failure;
    return super.commit(writes, ctx);
  }
  override async close() {
    this.closeCalls++;
  }
  release() {
    return super.close(context);
  }
}

function memory() {
  const storage = new ReopenableMemory();
  cleanup.push(() => storage.release());
  return storage;
}

async function directory() {
  const path = await mkdtemp(join(tmpdir(), "pi-durable-upstream-"));
  cleanup.push(() => rm(path, { recursive: true, force: true }));
  return path;
}

async function fixture(storage: Storage = new MemoryStorage(), registry = createRegistry()) {
  const faux = fauxProvider({ tokenSize: { min: 100_000, max: 100_000 } });
  const models = createModels();
  models.setProvider(faux.provider);
  const reports: unknown[] = [];
  const reported = deferred<unknown>();
  const harness = await Harness.open(
    storage,
    {
      models,
      registry,
      settings: { compaction: { enabled: false }, retry: { maxRetries: 0 } },
      onReport: (error) => {
        reports.push(error);
        reported.resolve(error);
      },
    },
    context,
  );
  cleanup.push(() => harness.close(context));
  const root = await harness.root(context, {
    agent: { model: { provider: faux.provider.id, modelId: faux.getModel().id } },
  });
  return { harness, root, registry, faux, models, reports, reported };
}

const Evidence = defineDoc<{ completions: number }>({
  kind: "test.upstream.evidence",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => ({ completions: 0 }),
});

function task(version = 1, completed?: () => void) {
  return defineTask<null, { phase: "finish" }, string>({
    name: "test.upstream.task",
    version,
    initial: () => ({ phase: "finish" }),
    phases: {
      finish: async (_task, runtime, ctx) => {
        await runtime.commit(async (tx) => {
          (await tx.doc(Evidence, runtime.conversationId)).completions++;
          return { status: "terminal", outcome: { status: "completed", result: "finished" } };
        }, ctx);
        completed?.();
      },
    },
    abort: async (_task, runtime, ctx) => {
      await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), ctx);
    },
  });
}

async function seed(storage: Storage, version = 1) {
  const f = await fixture(storage);
  // Raw task creation deliberately does not request scheduler progress. Normal model
  // admission below always uses Conversation.submit(), never Tx.createSubmission().
  const id = await f.root.commit(async (tx) => {
    (await tx.doc(Evidence, f.root.id)).completions = 0;
    return tx.createTask(task(version), null, { ownership: { kind: "conversation" } });
  }, context);
  expect((await f.harness.inspect(context)).scheduling).toBe("paused");
  await f.harness.close(context);
  return { id, conversationId: f.root.id };
}

function installTask(registry: ReturnType<typeof createRegistry>, version = 1, completed?: () => void) {
  registry.install(defineExtension({ name: "upstream-task", tasks: [task(version, completed)] }));
}

describe("upstream durable recovery boundaries (not a coding-agent host)", () => {
  it("retains a missing task and resumes it when its definition is installed", async () => {
    const storage = memory();
    const { id, conversationId } = await seed(storage);
    const f = await fixture(storage);
    const before = await f.harness.getTask(id, context);
    f.harness.resume();
    expect((await f.harness.inspect(context)).tasks).toEqual([
      { record: before, state: { kind: "blocked", reason: "missing_task" } },
    ]);
    expect(await f.harness.snapshot(Evidence, conversationId, context)).toEqual({ completions: 0 });
    expect(await f.harness.getTask(id, context)).toEqual(before);
    const completed = deferred();
    installTask(f.registry, 1, completed.resolve);
    await completed.promise; // Registry installation alone wakes the already-enabled scheduler.
    expect((await f.harness.waitForTask(id, context)).state.outcome).toEqual({
      status: "completed",
      result: "finished",
    });
    expect(await f.harness.snapshot(Evidence, conversationId, context)).toEqual({ completions: 1 });
    expect(f.faux.state.callCount).toBe(0);
  });

  it.each([
    { stored: 2, installed: 1, reason: "task_too_old" },
    { stored: 1, installed: 2, reason: "migration_failed" },
  ])("blocks stored v$stored with installed v$installed without changing its checkpoint", async (row) => {
    const storage = memory();
    const { id, conversationId } = await seed(storage, row.stored);
    const registry = createRegistry();
    installTask(registry, row.installed);
    const f = await fixture(storage, registry);
    const before = await f.harness.getTask(id, context);
    expect((await f.harness.inspect(context)).tasks[0].state).toMatchObject({
      kind: "blocked",
      reason: row.reason,
    });
    f.harness.resume();
    if (row.reason === "migration_failed") {
      expect(String(await f.reported.promise)).toContain("has no migration from 1");
    }
    expect((await f.harness.inspect(context)).tasks[0].state).toMatchObject({
      kind: "blocked",
      reason: row.reason,
    });
    expect(await f.harness.getTask(id, context)).toEqual(before);
    expect(await f.harness.snapshot(Evidence, conversationId, context)).toEqual({ completions: 0 });
    await f.harness.close(context);
    const restored = createRegistry();
    installTask(restored, row.stored);
    const next = await fixture(storage, restored);
    expect((await next.harness.waitForTask(id, context)).state.outcome.status).toBe("completed");
    expect(await next.harness.snapshot(Evidence, conversationId, context)).toEqual({ completions: 1 });
  });

  it.each([true, false])("abortTask with definition installed=%s does not enable scheduling", async (installed) => {
    const f = await fixture();
    if (installed) installTask(f.registry);
    const id = await f.root.commit(
      (tx) => tx.createTask(task(), null, { ownership: { kind: "conversation" } }),
      context,
    );
    expect(await f.harness.abortTask(id, context)).toBe("marked");
    expect((await f.harness.inspect(context)).scheduling).toBe("paused");
    if (installed) {
      expect(await f.harness.getTask(id, context)).toMatchObject({
        abortRequested: true,
        state: { status: "pending" },
      });
    }
    // waitForTask, not abortTask, enables scheduling. Without a definition abortTask
    // instead settles a childless blocked task as orphaned on its mutation line.
    expect((await f.harness.waitForTask(id, context)).state.outcome).toMatchObject({
      status: installed ? "aborted" : "orphaned",
      ...(installed ? {} : { reason: "missing_task" }),
    });
    expect(f.faux.state.callCount).toBe(0);
  });

  it("ends with SessionFailed on commit failure, aborts work, and reopens without resetting committed state", async () => {
    const storage = memory();
    const f = await fixture(storage);
    const entered = deferred();
    const stopped = deferred();
    f.registry.install(
      defineExtension({
        name: "hold",
        tools: [
          defineTool({
            name: "hold",
            description: "Hold until shutdown",
            parameters: Type.Object({}),
            replay: "safe",
            execute: async (_args, _api, ctx) => {
              entered.resolve();
              try {
                await awaitWithContext(new Promise<never>(() => {}), ctx);
              } finally {
                stopped.resolve();
              }
              return {};
            },
          }),
        ],
      }),
    );
    f.faux.setResponses([
      fauxAssistantMessage(fauxToolCall("hold", {}, { id: "hold-call" }), { stopReason: "toolUse" }),
    ]);
    await f.root.commit(async (tx) => {
      (await tx.doc(Evidence, f.root.id)).completions = 7;
    }, context);
    const submission = await f.root.submit({ type: "input", content: "retained", requestId: "retained" }, context);
    await entered.promise; // Tool intent and the generation's assistant entry are already committed.
    const taskBefore = (await f.harness.inspect(context)).tasks.map(({ record }) => record);
    const transcriptBefore = (await f.root.context(context)).entries;
    const waiting = submission.wait(context).catch((error: unknown) => error);
    const failure = new Error("injected commit failure");
    storage.failure = failure;
    await expect(
      f.root.commit(async (tx) => {
        (await tx.doc(Evidence, f.root.id)).completions = 999;
      }, context),
    ).rejects.toBe(failure);
    const waitError = await waiting;
    expect(waitError).toBeInstanceOf(SessionFailed);
    expect((waitError as SessionFailed).cause).toBe(failure);
    await stopped.promise;
    expect(await f.harness.closed).toEqual({ reason: "failed", error: failure });
    await expect(f.harness.inspect(context)).rejects.toMatchObject({ cause: failure });
    expect(f.reports).toEqual([failure]);
    expect(storage.closeCalls).toBe(1);
    storage.failure = undefined;
    const next = await fixture(storage);
    expect(await next.harness.snapshot(Evidence, f.root.id, context)).toEqual({ completions: 7 });
    expect((await next.root.context(context)).entries).toEqual(transcriptBefore);
    expect((await next.harness.submission(submission.id, context))?.id).toBe(submission.id);
    for (const record of taskBefore) {
      expect(await next.harness.getTask(record.id, context)).toEqual({
        ...record,
        state: record.state.status === "running" ? { ...record.state, status: "pending" } : record.state,
      });
    }
    expect((await next.harness.inspect(context)).scheduling).toBe("paused");
    expect(next.faux.state.callCount).toBe(0);
  });

  for (const kind of ["main", "task", "doc"] as const) {
    it(`recovers an incomplete final ${kind} JSONL line and preserves confirmed records`, async () => {
      const path = await directory();
      const { id, conversationId } = await seed(await openNodeJsonlStorage(path, context, { fsync: true }));
      const files = await readdir(path);
      const file = kind === "main" ? "main.jsonl" : files.find((name) => name.startsWith(`${kind}-`));
      if (!file) throw new Error(`Missing ${kind} sidecar`);
      const target = join(path, file);
      const before = await readFile(target);
      await appendFile(target, '{"format":1,"torn":');
      const f = await fixture(await openNodeJsonlStorage(path, context, { fsync: true }));
      expect(await readFile(target)).toEqual(before);
      expect(await f.harness.getTask(id, context)).toMatchObject({ id, state: { status: "pending" } });
      expect(await f.harness.snapshot(Evidence, conversationId, context)).toEqual({ completions: 0 });
      expect((await f.harness.inspect(context)).scheduling).toBe("paused");
      installTask(f.registry);
      expect((await f.harness.waitForTask(id, context)).state.outcome.status).toBe("completed");
      expect(await f.harness.snapshot(Evidence, conversationId, context)).toEqual({ completions: 1 });
    });

    it(`rejects a complete malformed ${kind} JSONL line instead of resetting the store`, async () => {
      const path = await directory();
      await seed(await openNodeJsonlStorage(path, context, { fsync: true }));
      const files = await readdir(path);
      const file = kind === "main" ? "main.jsonl" : files.find((name) => name.startsWith(`${kind}-`));
      if (!file) throw new Error(`Missing ${kind} sidecar`);
      const target = join(path, file);
      await appendFile(target, '{"malformed":\n');
      const before = await readFile(target);
      await expect(openNodeJsonlStorage(path, context, { fsync: true })).rejects.toMatchObject({
        name: "JsonlCorruptionError",
        message: expect.stringContaining("Malformed complete"),
      });
      expect(await readFile(target)).toEqual(before);
      expect((await readdir(path)).sort()).toEqual(files.sort());
    });
  }

  it("silently omits missing selected tools and extensions: the host must preflight before resume", async () => {
    const path = await directory();
    const first = await fixture(await openNodeJsonlStorage(path, context, { fsync: true }));
    const tool = defineTool({
      name: "selected-tool",
      description: "Selected",
      parameters: Type.Object({}),
      execute: async () => ({}),
    });
    const extension = defineExtension({ name: "selected-extension", tools: [tool] });
    first.registry.install(extension);
    await first.root.configure({ extensions: [extension], tools: [tool] }, context);
    expect((await first.root.agent(context)).tools.map(({ name }) => name)).toEqual(["selected-tool"]);
    const stored = await first.harness.snapshot(AgentDoc, first.root.id, context);
    await first.harness.close(context);
    const next = await fixture(await openNodeJsonlStorage(path, context, { fsync: true }));
    const missingExtension = await next.root.agent(context);
    expect(missingExtension.extensions).toEqual([]);
    expect(missingExtension.tools).toEqual([]);
    // Keep the extension name but remove its selected tool: the second omission branch.
    next.registry.install(defineExtension({ name: extension.name }));
    expect((await next.root.agent(context)).extensions.map(({ name }) => name)).toEqual([extension.name]);
    expect((await next.root.agent(context)).tools).toEqual([]);
    expect(await next.harness.snapshot(AgentDoc, next.root.id, context)).toEqual(stored);
    next.faux.setResponses([fauxAssistantMessage("runs without selected capabilities")]);
    expect((await (await next.root.submit({ type: "input", content: "continue" }, context)).wait(context)).status).toBe(
      "done",
    );
    expect(next.reports).toEqual([]);
  });

  it.each(["unconfigured", "missing-provider", "missing-model"] as const)(
    "settles %s model selection as unanswered/no_model without failing the Harness",
    async (selection) => {
      const f = await fixture();
      await f.root.configure(
        {
          model:
            selection === "unconfigured"
              ? null
              : { provider: selection === "missing-provider" ? "absent" : f.faux.provider.id, modelId: "absent" },
        },
        context,
      );
      const submission = await f.root.submit({ type: "input", content: "no credentials or model" }, context);
      expect(await submission.wait(context)).toMatchObject({
        id: submission.id,
        status: "unanswered",
        reason: "no_model",
      });
      expect(f.faux.state.callCount).toBe(0);
      expect((await f.harness.inspect(context)).tasks).toEqual([]);
      // A missing model is a run failure, not terminal Harness failure.
      await f.root.configure({ model: { provider: f.faux.provider.id, modelId: f.faux.getModel().id } }, context);
      f.faux.setResponses([fauxAssistantMessage("repaired")]);
      expect((await (await f.root.submit({ type: "input", content: "retry" }, context)).wait(context)).status).toBe(
        "done",
      );
    },
  );

  it.each(["missing-provider", "missing-model", "missing-auth", "auth-resolver-error"] as const)(
    "recovers a committed model request with %s as an inspectable run failure",
    async (failure) => {
      const path = await directory();
      const first = await fixture(await openNodeJsonlStorage(path, context, { fsync: true }));
      const entered = deferred();
      const stopped = deferred();
      first.faux.setResponses([
        async (_request, options) => {
          if (!options?.signal) throw new Error("Missing model cancellation signal");
          entered.resolve();
          try {
            return await awaitWithContext(new Promise<never>(() => {}), withAbortSignal(options.signal, context));
          } finally {
            stopped.resolve();
          }
        },
      ]);
      const submission = await first.root.submit(
        { type: "input", content: "recover request", requestId: "request" },
        context,
      );
      await entered.promise;
      const generation = (await first.harness.inspect(context)).tasks.find(
        ({ record }) => record.kind === "pi.generation",
      );
      expect(generation?.record.state).toMatchObject({ status: "running", checkpoint: { phase: "request" } });
      const transcript = (await first.root.context(context)).entries;
      await first.harness.close(context);
      await stopped.promise;
      const next = await fixture(await openNodeJsonlStorage(path, context, { fsync: true }));
      if (failure === "missing-provider") {
        next.models.deleteProvider(next.faux.provider.id);
      } else if (failure === "missing-model") {
        next.models.setProvider({ ...next.faux.provider, getModels: () => [], getAllModels: () => [] });
      } else {
        next.models.setProvider({
          ...next.faux.provider,
          auth: {
            apiKey: {
              name: "Unavailable",
              resolve: async () => {
                if (failure === "auth-resolver-error") throw new Error("synthetic credential resolver failure");
                return undefined;
              },
            },
          },
        });
      }
      const resumed = await next.harness.submission(submission.id, context);
      if (!resumed || !generation) throw new Error("Lost committed request");
      const reason = failure === "missing-provider" || failure === "missing-model" ? "no_model" : "model_error";
      const settled = await resumed.wait(context);
      expect(settled).toMatchObject({ id: submission.id, requestId: "request", status: "unanswered", reason });
      if (reason === "model_error") {
        expect(settled).toMatchObject({
          detail: expect.stringContaining(
            failure === "missing-auth" ? "Provider is not configured" : "API key auth failed",
          ),
        });
      }
      expect(next.faux.state.callCount).toBe(0); // Missing auth never reaches provider code.
      expect((await next.root.context(context)).entries.slice(0, transcript.length)).toEqual(transcript);
      expect((await next.harness.getTask(generation.record.id, context))?.state).toMatchObject({
        status: "terminal",
        outcome: { status: "failed" },
      });
      expect((await next.harness.inspect(context)).tasks).toEqual([]);
      expect(next.reports).toEqual([]);
    },
  );

  it("records a synthetic provider authentication error as unanswered/model_error, not SessionFailed", async () => {
    const f = await fixture();
    f.faux.setResponses([
      async () => {
        throw new Error("401 Unauthorized: credentials unavailable");
      },
    ]);
    const submission = await f.root.submit({ type: "input", content: "auth failure" }, context);
    expect(await submission.wait(context)).toMatchObject({
      status: "unanswered",
      reason: "model_error",
      detail: "401 Unauthorized: credentials unavailable",
    });
    expect(f.faux.state.callCount).toBe(1);
    const messages = (await f.root.context(context)).entries.flatMap((entry) => entry.model ?? []);
    expect(messages).toContainEqual(
      expect.objectContaining({
        role: "assistant",
        stopReason: "error",
        errorMessage: "401 Unauthorized: credentials unavailable",
      }),
    );
    expect((await f.harness.inspect(context)).tasks).toEqual([]);
    f.faux.setResponses([fauxAssistantMessage("credentials reacquired")]);
    expect((await (await f.root.submit({ type: "input", content: "retry" }, context)).wait(context)).status).toBe(
      "done",
    );
  });

  it.each([
    { stored: "safe", current: "safe", reruns: true },
    { stored: "safe", current: "unsafe", reruns: false },
    { stored: "unsafe", current: "safe", reruns: false },
    { stored: "unsafe", current: "unsafe", reruns: false },
    { stored: "safe", current: "missing", reruns: false },
  ] as const)("restarts tool intent with stored=$stored/current=$current (trust hooks are not rerun)", async (row) => {
    const path = await directory();
    const first = await fixture(await openNodeJsonlStorage(path, context, { fsync: true }));
    const entered = deferred();
    let effects = 0;
    let attempts = 0;
    let hookCalls = 0;
    // A synthetic external idempotency ledger. Even a safe replay enters execute twice;
    // durable itself cannot promise exactly-once effects in an external system.
    const ledger = new Set<string>();
    const extension = (policy: "safe" | "unsafe", hold: boolean) =>
      defineExtension({
        name: "effect",
        tools: [
          defineTool({
            name: "effect",
            description: "Synthetic external effect",
            parameters: Type.Object({ key: Type.String() }),
            replay: policy,
            execute: async ({ key }, _api, ctx) => {
              attempts++;
              if (!ledger.has(key)) {
                ledger.add(key);
                effects++;
              }
              entered.resolve();
              if (hold) await awaitWithContext(new Promise<never>(() => {}), ctx);
              return { output: [{ type: "text", text: "effect committed" }] };
            },
          }),
        ],
        hooks: [
          hook(ToolTask, {
            beforeTool: () => {
              hookCalls++;
              return hold ? undefined : { block: "trust revoked" };
            },
          }),
        ],
      });
    first.registry.install(extension(row.stored, true));
    first.faux.setResponses([
      fauxAssistantMessage(fauxToolCall("effect", { key: "stable-effect" }, { id: "effect-call" }), {
        stopReason: "toolUse",
      }),
    ]);
    const submission = await first.root.submit({ type: "input", content: "effect", requestId: "effect" }, context);
    await entered.promise;
    const tool = (await first.harness.inspect(context)).tasks.find(({ record }) => record.kind === "pi.tool");
    expect(tool?.record.state).toMatchObject({
      status: "running",
      checkpoint: { phase: "execute", replay: row.stored },
    });
    await first.harness.close(context); // Suspends; it must not abort/settle durable work.
    const next = await fixture(await openNodeJsonlStorage(path, context, { fsync: true }));
    if (row.current !== "missing") next.registry.install(extension(row.current, false));
    next.faux.setResponses([fauxAssistantMessage("resumed final answer")]);
    expect((await next.harness.inspect(context)).scheduling).toBe("paused");
    expect(attempts).toBe(1);
    const resumed = await next.harness.submission(submission.id, context);
    if (!resumed || !tool) throw new Error("Lost durable identity");
    expect((await resumed.wait(context)).status).toBe("done");
    expect(attempts).toBe(row.reruns ? 2 : 1);
    expect(effects).toBe(1);
    expect(hookCalls).toBe(1); // New beforeTool block is skipped even for a safe replay.
    const result = (await next.root.context(context)).entries.find((entry) => entry.kind === "pi.tool-result");
    expect(result).toBeDefined();
    expect(result?.model?.[0]).toMatchObject({ role: "toolResult", isError: !row.reruns });
    if (!row.reruns) expect(JSON.stringify(result)).toContain("interrupted");
    expect((await next.harness.getTask(tool.record.id, context))?.state).toMatchObject({
      status: "terminal",
      outcome: { status: row.reruns ? "completed" : "failed" },
    });
  });
});
