import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { awaitWithContext, withAbortSignal } from "@earendil-works/chord/context";
import {
  createModels,
  type FauxResponseStep,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  type Models,
  Type,
} from "@earendil-works/pi-ai";
import {
  createRegistry,
  defineTool,
  Harness,
  type HarnessSettings,
  type Harness as HarnessType,
  MemoryStorage,
  ProviderDoc,
  type Storage,
  ToolResultEntry,
  UserEntry,
} from "@earendil-works/pi-durable";
import { openNodeJsonlStorage } from "@earendil-works/pi-durable/storage/jsonl/node";
import { afterEach, describe, expect, it } from "vitest";
import { context, deferred } from "./durable-fixture.js";
import { createHostLedger, HostSeedDoc } from "./durable-host-ledger.js";
import { probeHostModels } from "./durable-host-models.js";

const harnesses: HarnessType[] = [];
const directories: string[] = [];
afterEach(async () => {
  const closes = await Promise.allSettled(harnesses.splice(0).map((harness) => harness.close(context)));
  const removals = await Promise.allSettled(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
  const failures = [...closes, ...removals].filter((result) => result.status === "rejected");
  if (failures.length > 0)
    throw new AggregateError(
      failures.map((failure) => failure.reason),
      "Host admission fixture cleanup failed",
    );
});
async function directory() {
  const path = await mkdtemp(join(tmpdir(), "pi-goal-host-admission-"));
  directories.push(path);
  return path;
}

async function open(
  options: {
    ledger?: ReturnType<typeof createHostLedger>;
    responses?: FauxResponseStep[];
    faux?: ReturnType<typeof fauxProvider>;
    storage?: Storage;
    settings?: HarnessSettings;
    now?: () => number;
    observeModels?: (models: Models) => Models;
  } = {},
) {
  const ledger = options.ledger ?? createHostLedger();
  const faux = options.faux ?? fauxProvider({ deferred: { pollAfterMs: 0, pendingFetches: 1 } });
  if (options.responses !== undefined) faux.setResponses(options.responses);
  const underlying = createModels();
  underlying.setProvider(faux.provider);
  const guarded = probeHostModels(underlying, ledger.admit);
  const models = options.observeModels?.(guarded) ?? guarded;
  const registry = createRegistry();
  registry.install(ledger.extension);
  const reports: unknown[] = [];
  const harness = await Harness.open(
    options.storage ?? new MemoryStorage(),
    {
      models,
      registry,
      now: options.now,
      settings: {
        compaction: { enabled: false, backgroundTokens: 0, keepRecentTokens: 16 },
        retry: { enabled: false },
        ...options.settings,
      },
      onReport: (error) => reports.push(error),
    },
    context,
  );
  harnesses.push(harness);
  const model = faux.getModel();
  const agent = { model: { provider: model.provider, modelId: model.id } };
  const root = await harness.root(context, { agent });
  ledger.attach(harness, root.id);
  return { harness, root, ledger, faux, models, agent, reports };
}

// Feasibility probes, including a failed unrelated-deferred isolation case.
// These tests do NOT pass the full approved safety gate: the full retry/recovery
// matrix, accounting deduplication, and host control protocol are not implemented.
describe("durable host-owned admission feasibility (partial gate)", () => {
  it("commits the native task reservation before dispatch and disables provider retries", async () => {
    let evidence: unknown;
    const fixture = await open({
      responses: [
        async (_messages, options) => {
          evidence = {
            state: await fixture.ledger.snapshot(),
            maxRetries: options?.maxRetries,
            sessionId: options?.sessionId,
            signal: options?.signal,
          };
          return fauxAssistantMessage("finished");
        },
      ],
    });
    await fixture.ledger.activate();
    expect((await (await fixture.root.submit({ type: "input", content: "run" }, context)).wait(context)).status).toBe(
      "done",
    );
    const provider = await fixture.harness.snapshot(ProviderDoc, fixture.root.id, context);
    expect(evidence).toMatchObject({
      maxRetries: 0,
      sessionId: provider?.sessionId,
      state: {
        responses: 0,
        outstanding: {
          status: "reserved",
          method: "streamSimple",
          conversationId: fixture.root.id,
          taskId: fixture.ledger.bound[0]?.taskId,
          attempt: 1,
        },
      },
    });
    expect(fixture.ledger.denials).toEqual([]);
    expect(fixture.faux.state.callCount).toBe(1);
    expect(await fixture.ledger.snapshot()).toMatchObject({ responses: 1 });
    expect((await fixture.ledger.snapshot())?.outstanding).toBeUndefined();
  });

  it.each(["response", "token"] as const)(
    "known %s exhaustion prevents a second provider request and a substantive tool",
    async (limit) => {
      let executions = 0;
      const action = defineTool({
        name: "action",
        description: "Synthetic effect",
        parameters: Type.Object({}),
        execute: async () => {
          executions++;
          return {};
        },
      });
      const ledger = createHostLedger({ tools: [action] });
      const { root, faux } = await open({
        ledger,
        responses: [
          fauxAssistantMessage(fauxToolCall("action", {}, { id: "denied" }), { stopReason: "toolUse" }),
          fauxAssistantMessage("must not dispatch"),
        ],
      });
      await ledger.activate(limit === "response" ? { responseLimit: 1 } : { tokenLimit: 1 });
      const settled = await (await root.submit({ type: "input", content: "run" }, context)).wait(context);
      expect(settled.status).toBe("unanswered");
      expect(faux.state.callCount).toBe(1);
      expect(executions).toBe(0);
      expect(ledger.attempts).toHaveLength(2);
      expect(ledger.denials).toContain("Goal response/token limit exhausted");
      expect(await ledger.snapshot()).toMatchObject({ responses: 1 });
      const results = (await root.context(context)).entries.filter(ToolResultEntry.is);
      expect(results).toHaveLength(1);
      expect(JSON.stringify(results)).toContain("Goal response/token limit exhausted");
    },
  );

  it("records usage before a terminal event can resolve Models stream.result", async () => {
    const receiptReady = deferred<void>();
    const release = deferred<void>();
    let resultResolved = false;
    let recorded: unknown;
    const ledger = createHostLedger({
      afterReceipt: async () => {
        recorded = await ledger.snapshot();
        receiptReady.resolve();
        await release.promise;
      },
    });
    const { root } = await open({
      ledger,
      responses: [fauxAssistantMessage("answer")],
      observeModels: (models) =>
        new Proxy(models, {
          get(target, key) {
            if (key === "streamSimple")
              return (...args: Parameters<Models["streamSimple"]>) => {
                const stream = target.streamSimple(...args);
                void stream.result().then(() => {
                  resultResolved = true;
                });
                return stream;
              };
            const value = Reflect.get(target, key);
            return typeof value === "function" ? value.bind(target) : value;
          },
        }),
    });
    await ledger.activate();
    const submitted = await root.submit({ type: "input", content: "run" }, context);
    try {
      await receiptReady.promise;
      expect(recorded).toMatchObject({ responses: 1, tokens: expect.any(Number) });
      expect((recorded as { tokens: number }).tokens).toBeGreaterThan(0);
      expect(resultResolved).toBe(false);
    } finally {
      release.resolve();
    }
    expect((await submitted.wait(context)).status).toBe("done");
    expect(resultResolved).toBe(true);
  });

  it("serializes simultaneous generation and compaction through one persisted reservation", async () => {
    const entered = deferred<void>();
    const release = deferred<void>();
    const { root, ledger, harness, faux } = await open({
      responses: [
        async (_messages, options) => {
          entered.resolve();
          if (options?.signal === undefined) throw new Error("Missing provider signal");
          await awaitWithContext(release.promise, withAbortSignal(options.signal, context));
          return fauxAssistantMessage("one admitted answer");
        },
        fauxAssistantMessage("must not dispatch"),
      ],
    });
    await ledger.activate({ tokenLimit: 1 });
    await root.commit(async (tx) => {
      for (const text of ["old", "recent"])
        await tx.appendEntry(UserEntry, root.id, {
          model: [{ role: "user", content: text.repeat(100), timestamp: 0 }],
        });
    }, context);
    const submitted = await root.submit({ type: "input", content: "run" }, context);
    await entered.promise;
    try {
      const compaction = await root.compact(undefined, context);
      expect((await harness.waitForTask(compaction, context)).state.outcome.status).toBe("faulted");
      expect(ledger.denials).toContain("Outstanding or uncertain reservation");
      expect(faux.state.callCount).toBe(1);
    } finally {
      release.resolve();
    }
    expect((await submitted.wait(context)).status).toBe("done");
    expect((await ledger.snapshot())?.responses).toBe(1);
    expect((await ledger.snapshot())?.tokens).toBeGreaterThan(1);
    await (await root.submit({ type: "input", content: "no further overshoot" }, context)).wait(context);
    expect(faux.state.callCount).toBe(1);
    expect(ledger.attempts.map((item) => item.method)).toContain("completeSimple");
  });

  it("admits compaction completion once with a durable receipt and provider retries disabled", async () => {
    let evidence: unknown;
    const fixture = await open({
      responses: [
        async (_messages, options) => {
          evidence = { state: await fixture.ledger.snapshot(), maxRetries: options?.maxRetries };
          return fauxAssistantMessage("compact summary");
        },
      ],
    });
    await fixture.ledger.activate();
    await fixture.root.commit(async (tx) => {
      for (const text of ["old", "recent"])
        await tx.appendEntry(UserEntry, fixture.root.id, {
          model: [{ role: "user", content: text.repeat(100), timestamp: 0 }],
        });
    }, context);
    const taskId = await fixture.root.compact(undefined, context);
    expect((await fixture.harness.waitForTask(taskId, context)).state.outcome.status).toBe("completed");
    await fixture.root.waitForIdle(context);
    expect(evidence).toMatchObject({
      maxRetries: 0,
      state: {
        outstanding: {
          taskId,
          method: "completeSimple",
          status: "reserved",
          attempt: 1,
        },
      },
    });
    expect(fixture.faux.state.callCount).toBe(1);
    expect(fixture.ledger.attempts.map((attempt) => attempt.method)).toEqual(["completeSimple"]);
    expect(await fixture.ledger.snapshot()).toMatchObject({ responses: 1, tokens: expect.any(Number) });
  });

  it("a failed receipt stays reserved across JSONL reopen and prevents a blind resend", async () => {
    const path = await directory();
    const first = await open({
      ledger: createHostLedger({
        beforeReceipt: async () => {
          throw new Error("injected receipt failure");
        },
      }),
      responses: [fauxAssistantMessage("provider did work")],
      storage: await openNodeJsonlStorage(path, context),
    });
    await first.ledger.activate();
    const request = { type: "input", content: "run", requestId: "goal:failed-receipt" } as const;
    expect((await (await first.root.submit(request, context)).wait(context)).status).toBe("unanswered");
    expect(first.faux.state.callCount).toBe(1);
    expect((await first.ledger.snapshot())?.outstanding?.status).toBe("reserved");
    await first.harness.close(context);

    const second = await open({
      responses: [fauxAssistantMessage("must not resend")],
      storage: await openNodeJsonlStorage(path, context),
    });
    expect((await second.ledger.snapshot())?.outstanding?.status).toBe("reserved");
    const view = await second.root.viewState(context);
    const graph = await second.harness.taskGraph(context);
    try {
      await second.harness.inspect(context);
      await second.root.context(context);
      expect(second.faux.state.callCount).toBe(0);
      expect(second.ledger.attempts).toHaveLength(0);
    } finally {
      view.dispose();
      graph.dispose();
    }
    await (
      await second.root.submit({ type: "input", content: "try again", requestId: "goal:new-delivery" }, context)
    ).wait(context);
    expect(second.ledger.denials).toContain("Outstanding or uncertain reservation");
    expect(second.faux.state.callCount).toBe(0);
  });

  it("excludes unrelated conversations and rejects inherited fork authority", async () => {
    const { root, ledger, harness, faux, agent } = await open({
      responses: [fauxAssistantMessage("unrelated answer")],
    });
    await ledger.activate({ responseLimit: 0 });
    await root.commit(
      (tx) =>
        tx.appendEntry(UserEntry, root.id, {
          model: [{ role: "user", content: "historical Goal", timestamp: 0 }],
        }),
      context,
    );
    const at = (await root.context(context)).entries.at(-1)?.id;
    if (at === undefined) throw new Error("Missing fork boundary");
    const fork = await root.fork(at, { ownership: { kind: "ownerless" } }, context);
    expect((await harness.snapshot(HostSeedDoc, fork.id, context))?.state?.conversationId).toBe(root.id);
    await (await fork.submit({ type: "input", content: "spend inherited authority" }, context)).wait(context);
    expect(faux.state.callCount).toBe(0);
    expect(ledger.denials).toContain("Stale Goal activation or fork");
    const unrelated = await harness.createConversation({ ownership: { kind: "ownerless" }, agent }, context);
    expect(
      (await (await unrelated.submit({ type: "input", content: "ordinary input" }, context)).wait(context)).status,
    ).toBe("done");
    expect(faux.state.callCount).toBe(1);
    expect((await ledger.snapshot())?.responses).toBe(0);
    expect(await harness.snapshot(ProviderDoc, fork.id, context)).not.toEqual(
      await harness.snapshot(ProviderDoc, root.id, context),
    );
  });

  it("characterizes the candidate's failed isolation of an unrelated deferred conversation", async () => {
    const { harness, ledger, faux, models, agent } = await open({
      responses: [fauxAssistantMessage("unrelated deferred answer")],
      settings: { stream: { deferred: true } },
    });
    await ledger.activate();
    const unrelated = await harness.createConversation({ ownership: { kind: "ownerless" }, agent }, context);
    try {
      const submitted = await unrelated.submit({ type: "input", content: "ordinary unrelated work" }, context);
      expect((await submitted.wait(context)).status).toBe("unanswered");
      expect(faux.state.callCount).toBe(1);
      expect(faux.state.deferredFetchCount).toBe(0);
      expect(ledger.denials).toContain("Unknown deferred handle");
      expect(await ledger.snapshot()).toMatchObject({ responses: 0, tokens: 0 });
      expect((await ledger.snapshot())?.outstanding).toBeUndefined();
      expect(faux.state.cancelledDeferred).toHaveLength(0);
    } finally {
      // The rejected native poll does not cancel the remote handle. Explicitly
      // clean up the synthetic work; this is another limit of this candidate.
      for (const attempt of ledger.attempts) {
        if (attempt.method === "fetchDeferred" && attempt.handle !== undefined) {
          await models.cancelDeferred(faux.getModel(), attempt.handle);
        }
      }
    }
  });

  it("revalidates activation after an awaited admission boundary", async () => {
    const entered = deferred<void>();
    const release = deferred<void>();
    const ledger = createHostLedger({
      beforeAdmission: async (attempt) => {
        entered.resolve();
        if (attempt.signal === undefined) throw new Error("Missing signal");
        await awaitWithContext(release.promise, withAbortSignal(attempt.signal, context));
      },
    });
    const { root, faux } = await open({ ledger, responses: [fauxAssistantMessage("must not dispatch")] });
    await ledger.activate();
    const submitted = await root.submit({ type: "input", content: "run" }, context);
    await entered.promise;
    await root.commit(async (tx) => {
      const state = (await tx.doc(HostSeedDoc, root.id)).state;
      if (state !== undefined) state.activation++;
    }, context);
    release.resolve();
    expect((await submitted.wait(context)).status).toBe("unanswered");
    expect(faux.state.callCount).toBe(0);
    expect(ledger.denials).toContain("Stale Goal activation or fork");
  });

  it("captures deferred polls without another beforeRequest hook and charges only the final response", async () => {
    const { root, ledger, faux } = await open({
      responses: [fauxAssistantMessage("deferred answer")],
      settings: { stream: { deferred: true } },
    });
    await ledger.activate();
    expect((await (await root.submit({ type: "input", content: "run" }, context)).wait(context)).status).toBe("done");
    expect(faux.state.callCount).toBe(1);
    expect(faux.state.deferredFetchCount).toBe(2);
    expect(ledger.bound).toHaveLength(1);
    expect(ledger.attempts.map((attempt) => attempt.method)).toEqual([
      "streamSimple",
      "fetchDeferred",
      "fetchDeferred",
    ]);
    expect(ledger.polls).toEqual([
      expect.objectContaining({ attempt: 1, cutoff: expect.any(Number), pollAt: expect.any(Number) }),
      expect.objectContaining({ attempt: 1, cutoff: expect.any(Number), pollAt: expect.any(Number) }),
    ]);
    expect(await ledger.snapshot()).toMatchObject({ responses: 1, tokens: expect.any(Number) });
    expect((await ledger.snapshot())?.outstanding).toBeUndefined();
  });

  it("restores a persisted deferred handle on reopen without observation starting work", async () => {
    const path = await directory();
    const faux = fauxProvider({ deferred: { pollAfterMs: 60_000, pendingFetches: 0 } });
    const now = Date.now();
    const first = await open({
      faux,
      now: () => now,
      responses: [fauxAssistantMessage("remote deferred answer")],
      storage: await openNodeJsonlStorage(path, context),
      settings: { stream: { deferred: true } },
    });
    await first.ledger.activate();
    const pollReady = deferred<void>();
    const unsubscribe = first.harness.subscribeCommits((publication) => {
      if (
        publication.changes.some(
          (change) =>
            change.type === "task" &&
            change.value.kind === "pi.generation" &&
            change.value.state.status === "running" &&
            typeof change.value.state.checkpoint === "object" &&
            change.value.state.checkpoint !== null &&
            !Array.isArray(change.value.state.checkpoint) &&
            change.value.state.checkpoint.phase === "poll",
        )
      )
        pollReady.resolve();
    });
    const submitted = await first.root.submit({ type: "input", content: "run", requestId: "goal:deferred" }, context);
    await pollReady.promise;
    unsubscribe();
    const receipt = (await first.ledger.snapshot())?.outstanding;
    expect(receipt).toMatchObject({ status: "pending", handle: expect.any(String) });
    expect(faux.state.deferredFetchCount).toBe(0);
    await first.harness.close(context);

    // Reuse only the faux remote service, not the wrapper or its WeakMap.
    const second = await open({
      faux,
      now: () => now + 120_000,
      storage: await openNodeJsonlStorage(path, context),
      settings: { stream: { deferred: true } },
    });
    const view = await second.root.viewState(context);
    try {
      expect((await second.harness.inspect(context)).scheduling).toBe("paused");
      expect((await second.ledger.snapshot())?.outstanding).toEqual(receipt);
      expect(second.ledger.bound).toHaveLength(0);
      expect(second.ledger.attempts).toHaveLength(0);
      expect(faux.state.deferredFetchCount).toBe(0);
    } finally {
      view.dispose();
    }
    const resumed = await second.harness.submission(submitted.id, context);
    if (resumed === undefined) throw new Error("Missing pending submission");
    expect((await resumed.wait(context)).status).toBe("done");
    expect(second.ledger.attempts.map((attempt) => attempt.method)).toEqual(["fetchDeferred"]);
    expect(second.ledger.polls[0]?.taskId).toBe(receipt?.taskId);
    expect(faux.state.callCount).toBe(1);
    expect(faux.state.deferredFetchCount).toBe(1);
    expect((await second.ledger.snapshot())?.responses).toBe(1);
  });

  it("keeps native deferred cancellation available after new poll admission is denied", async () => {
    const faux = fauxProvider({ deferred: { pollAfterMs: 60_000, pendingFetches: 0 } });
    const { root, ledger, harness, models } = await open({
      faux,
      responses: [fauxAssistantMessage("pending remote answer")],
      settings: { stream: { deferred: true } },
    });
    await ledger.activate();
    const pollReady = deferred<void>();
    const unsubscribe = harness.subscribeCommits((publication) => {
      if (
        publication.changes.some(
          (change) =>
            change.type === "task" &&
            change.value.kind === "pi.generation" &&
            change.value.state.status === "running" &&
            typeof change.value.state.checkpoint === "object" &&
            change.value.state.checkpoint !== null &&
            !Array.isArray(change.value.state.checkpoint) &&
            change.value.state.checkpoint.phase === "poll",
        )
      )
        pollReady.resolve();
    });
    try {
      await root.submit({ type: "input", content: "run" }, context);
      await pollReady.promise;
      const receipt = (await ledger.snapshot())?.outstanding;
      if (receipt?.handle === undefined) throw new Error("Missing persisted handle");
      const handle = JSON.parse(receipt.handle) as NonNullable<Parameters<Models["fetchDeferred"]>[1]>;
      await root.commit(async (tx) => {
        const state = (await tx.doc(HostSeedDoc, root.id)).state;
        if (state !== undefined) state.active = false;
      }, context);
      await expect(models.fetchDeferred(faux.getModel(), handle)).rejects.toThrow("Stale Goal activation or fork");
      expect(faux.state.deferredFetchCount).toBe(0);
      await root.abort(context);
      expect(faux.state.cancelledDeferred).toEqual([handle]);
      expect((await harness.getTask(receipt.taskId, context))?.state.outcome?.status).toBe("aborted");
    } finally {
      unsubscribe();
    }
  });

  it("blocks a nested substantive tool after state changes while its parent awaits", async () => {
    const entered = deferred<void>();
    const release = deferred<void>();
    let effects = 0;
    let nestedError: boolean | undefined;
    const effect = defineTool({
      name: "effect",
      description: "Synthetic nested effect",
      parameters: Type.Object({}),
      execute: async () => {
        effects++;
        return {};
      },
    });
    const parent = defineTool({
      name: "parent",
      description: "Call a nested effect",
      parameters: Type.Object({}),
      execute: async (_args, api, ctx) => {
        entered.resolve();
        await awaitWithContext(release.promise, ctx);
        nestedError = (await api.executeTool("effect", {}, ctx)).isError;
        return {};
      },
    });
    const ledger = createHostLedger({ tools: [effect, parent] });
    const { root, faux } = await open({
      ledger,
      responses: [
        fauxAssistantMessage(fauxToolCall("parent", {}, { id: "parent" }), { stopReason: "toolUse" }),
        fauxAssistantMessage("must not dispatch"),
      ],
    });
    await ledger.activate();
    const submitted = await root.submit({ type: "input", content: "run" }, context);
    await entered.promise;
    await root.commit(async (tx) => {
      const state = (await tx.doc(HostSeedDoc, root.id)).state;
      if (state !== undefined) state.tokenLimit = state.tokens;
    }, context);
    release.resolve();
    await submitted.wait(context);
    expect(nestedError).toBe(true);
    expect(effects).toBe(0);
    expect(faux.state.callCount).toBe(1);
  });

  it("guards replay-safe execute on reopen when native recovery bypasses beforeTool", async () => {
    const path = await directory();
    const entered = deferred<void>();
    const release = deferred<void>();
    let effects = 0;
    const action = defineTool({
      name: "action",
      description: "Replay-safe synthetic effect",
      parameters: Type.Object({}),
      replay: "safe",
      execute: async (_args, _api, ctx) => {
        effects++;
        entered.resolve();
        await awaitWithContext(release.promise, ctx);
        return {};
      },
    });
    const first = await open({
      ledger: createHostLedger({ tools: [action] }),
      responses: [fauxAssistantMessage(fauxToolCall("action", {}, { id: "replay" }), { stopReason: "toolUse" })],
      storage: await openNodeJsonlStorage(path, context),
    });
    await first.ledger.activate();
    const submitted = await first.root.submit(
      { type: "input", content: "run", requestId: "goal:tool-replay" },
      context,
    );
    await entered.promise;
    await first.harness.close(context);
    expect(effects).toBe(1);

    const second = await open({
      ledger: createHostLedger({ tools: [action] }),
      responses: [fauxAssistantMessage("must not dispatch")],
      storage: await openNodeJsonlStorage(path, context),
    });
    await second.root.commit(async (tx) => {
      const state = (await tx.doc(HostSeedDoc, second.root.id)).state;
      if (state !== undefined) state.tokenLimit = state.tokens;
    }, context);
    const resumed = await second.harness.submission(submitted.id, context);
    if (resumed === undefined) throw new Error("Missing interrupted tool submission");
    await resumed.wait(context);
    expect(effects).toBe(1);
    expect(second.faux.state.callCount).toBe(0);
    expect(JSON.stringify((await second.root.context(context)).entries.filter(ToolResultEntry.is))).toContain(
      "Goal response/token limit exhausted",
    );
  });

  it("retains an uncertain in-flight reservation across reopen instead of resending the request", async () => {
    const path = await directory();
    const entered = deferred<void>();
    const release = deferred<void>();
    const first = await open({
      responses: [
        async (_messages, options) => {
          entered.resolve();
          if (options?.signal === undefined) throw new Error("Missing provider signal");
          await awaitWithContext(release.promise, withAbortSignal(options.signal, context));
          return fauxAssistantMessage("never delivered");
        },
      ],
      storage: await openNodeJsonlStorage(path, context),
    });
    await first.ledger.activate();
    const submitted = await first.root.submit({ type: "input", content: "run", requestId: "goal:in-flight" }, context);
    await entered.promise;
    await first.harness.close(context);
    expect(first.faux.state.callCount).toBe(1);

    const second = await open({
      responses: [fauxAssistantMessage("must not resend")],
      storage: await openNodeJsonlStorage(path, context),
    });
    expect((await second.ledger.snapshot())?.outstanding).toBeDefined();
    const resumed = await second.harness.submission(submitted.id, context);
    if (resumed === undefined) throw new Error("Missing uncertain submission");
    expect((await resumed.wait(context)).status).toBe("unanswered");
    expect(second.faux.state.callCount).toBe(0);
    expect(second.ledger.denials).toContain("Outstanding or uncertain reservation");
  });
});
