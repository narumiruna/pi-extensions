import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { type TestContext, test } from "vitest";
import { AnalyticsRunFiles } from "../src/storage/files.js";
import { resolveTimeRange } from "../src/storage/queries.js";
import { AnalyticsStore } from "../src/storage/store.js";
import type { SettledRun } from "../src/types.js";

function run(id: string, startedAtMs: number, options: Partial<SettledRun> = {}): SettledRun {
  return {
    id,
    startedAtMs,
    finishedAtMs: startedAtMs + 100,
    durationMs: 100,
    triggerSource: "interactive",
    initialProvider: "openai",
    initialModel: "gpt-test",
    outcome: "success",
    attemptCount: 1,
    generations: [],
    tools: [],
    skills: [],
    providerErrors: [],
    toolErrorCount: 0,
    providerErrorCount: 0,
    recoveredErrorCount: 0,
    ...options,
  };
}

async function fixture(t: TestContext): Promise<AnalyticsStore> {
  const directory = await mkdtemp(path.join(tmpdir(), "pi-analytics-store-"));
  t.onTestFinished(() => rm(directory, { recursive: true, force: true }));
  const store = new AnalyticsStore(path.join(directory, "pi-analytics"));
  t.onTestFinished(() => store.close().catch(() => undefined));
  return store;
}

test("store publishes a content-free run and returns reconciled analytics", async (t) => {
  const store = await fixture(t);
  const started = new Date(2026, 7, 2, 12).getTime();
  await store.recordRun(
    run("run-1", started, {
      outcome: "recovered_success",
      attemptCount: 2,
      generations: [
        {
          id: "g1",
          ordinal: 0,
          provider: "openai",
          model: "gpt-a",
          startedAtMs: started,
          finishedAtMs: started + 10,
          durationMs: 10,
          stopReason: "error",
          outcome: "error",
          responses: [
            { ordinal: 0, occurredAtMs: started + 1, status: 429 },
            { ordinal: 1, occurredAtMs: started + 2, status: 500 },
          ],
        },
        {
          id: "g2",
          ordinal: 1,
          provider: "anthropic",
          model: "claude-b",
          startedAtMs: started + 20,
          finishedAtMs: started + 40,
          durationMs: 20,
          stopReason: "stop",
          outcome: "stop",
          responses: [{ ordinal: 0, occurredAtMs: started + 21, status: 200 }],
        },
      ],
      tools: [
        {
          id: "tool-1",
          ordinal: 0,
          name: "read",
          provider: "openai",
          model: "gpt-a",
          startedAtMs: started + 5,
          finishedAtMs: started + 15,
          durationMs: 10,
          isError: true,
          completionState: "finished",
        },
      ],
      skills: [
        {
          id: "skill-1",
          name: "reviewing-code",
          initiatedBy: "model",
          occurredAtMs: started + 5,
          provider: "openai",
          model: "gpt-a",
        },
      ],
      providerErrors: [
        {
          id: "error-1",
          generationId: "g1",
          occurredAtMs: started + 10,
          provider: "openai",
          model: "gpt-a",
          category: "timeout",
          recovered: true,
          terminal: false,
        },
      ],
      toolErrorCount: 1,
      providerErrorCount: 3,
      recoveredErrorCount: 3,
    }),
  );

  const snapshot = await store.getSnapshot({ fromMs: started - 1, toMs: started + 1_000 });
  assert.deepEqual(snapshot.overview, {
    responseCycles: 1,
    llmCalls: 2,
    callsPerResponse: 2,
    p95CallsPerResponse: 2,
    toolCalls: 1,
    toolErrors: 1,
    skillActivations: 1,
    providerErrors: 3,
    recoveredErrors: 3,
  });
  assert.deepEqual(snapshot.skills[0]?.models, [{ provider: "openai", model: "gpt-a", count: 1 }]);
  assert.equal(snapshot.tools[0]?.averageDurationMs, 10);
  assert.equal(snapshot.reliability.http429, 1);
  assert.equal(snapshot.reliability.http5xx, 1);
  assert.equal(snapshot.reliability.categories.timeout, 1);
});

test("duplicate run ids remain idempotent across independent writer files", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "pi-analytics-dedup-"));
  t.onTestFinished(() => rm(directory, { recursive: true, force: true }));
  const root = path.join(directory, "pi-analytics");
  const left = new AnalyticsStore(root);
  const right = new AnalyticsStore(root);
  t.onTestFinished(async () => {
    await Promise.all([left.close(), right.close()]);
  });
  await Promise.all([left.recordRun(run("same", 1)), right.recordRun(run("same", 1))]);
  assert.equal((await left.getSnapshot({ fromMs: 0, toMs: 10 })).overview.responseCycles, 1);
});

test("two stores publish concurrently and clear switches every writer to fresh data", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "pi-analytics-concurrent-"));
  t.onTestFinished(() => rm(directory, { recursive: true, force: true }));
  const root = path.join(directory, "pi-analytics");
  const left = new AnalyticsStore(root);
  const right = new AnalyticsStore(root);
  t.onTestFinished(async () => {
    await Promise.all([left.close(), right.close()]);
  });
  await Promise.all(
    Array.from({ length: 20 }, (_, index) => (index % 2 ? left : right).recordRun(run(`run-${index}`, index + 1))),
  );
  assert.equal((await left.getSnapshot({ fromMs: 0, toMs: 100 })).overview.responseCycles, 20);
  assert.equal((await left.clearAll()).cleanupIncomplete, false);
  await right.recordRun(run("new", 50));
  assert.deepEqual((await left.getSnapshot({ fromMs: 0, toMs: 100 })).overview.responseCycles, 1);
});

test("a snapshot crossing Clear retries against only the active generation", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "pi-analytics-read-clear-"));
  t.onTestFinished(() => rm(directory, { recursive: true, force: true }));
  const root = path.join(directory, "pi-analytics");
  const writer = new AnalyticsStore(root);
  await writer.recordRun(run("before", 1));
  let reached!: () => void;
  const waiting = new Promise<void>((resolve) => {
    reached = resolve;
  });
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  let blockedOnce = false;
  const reader = new AnalyticsStore(root, {
    files: new AnalyticsRunFiles(root, {
      async beforeReadFile() {
        if (blockedOnce) return;
        blockedOnce = true;
        reached();
        await blocked;
      },
    }),
  });
  const reading = reader.getSnapshot({ fromMs: 0, toMs: 10 });
  await waiting;
  await writer.clearAll();
  release();
  assert.equal((await reading).overview.responseCycles, 0);
});

test("snapshot cancellation drains a read waiting between files", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "pi-analytics-read-abort-"));
  t.onTestFinished(() => rm(directory, { recursive: true, force: true }));
  const root = path.join(directory, "pi-analytics");
  const writer = new AnalyticsStore(root);
  await writer.recordRun(run("before", 1));
  let reached!: () => void;
  const waiting = new Promise<void>((resolve) => {
    reached = resolve;
  });
  const reader = new AnalyticsStore(root, {
    files: new AnalyticsRunFiles(root, {
      async beforeReadFile(signal) {
        reached();
        await new Promise<void>((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
      },
    }),
  });
  const controller = new AbortController();
  const reading = reader.getSnapshot({ fromMs: 0, toMs: 10 }, controller.signal);
  await waiting;
  controller.abort(new DOMException("cancelled read", "AbortError"));
  await assert.rejects(reading, /cancelled read/);
});

test("response statistics honor exact bounds and nearest-rank percentiles", async (t) => {
  const store = await fixture(t);
  for (const [index, calls] of [1, 2, 3, 4, 7, 9].entries()) {
    await store.recordRun(
      run(`range-${index}`, 100 + index, {
        generations: Array.from({ length: calls }, (_, ordinal) => ({
          id: `range-${index}-generation-${ordinal}`,
          ordinal,
          startedAtMs: 100 + index,
          outcome: "stop" as const,
          responses: [],
        })),
      }),
    );
  }
  const snapshot = await store.getSnapshot({ fromMs: 101, toMs: 105 });
  assert.equal(snapshot.responses.count, 4);
  assert.equal(snapshot.responses.average, 4);
  assert.equal(snapshot.responses.median, 3.5);
  assert.equal(snapshot.responses.p95, 7);
  assert.equal(snapshot.responses.maximum, 7);
  assert.deepEqual(snapshot.responses.distribution, {
    one: 0,
    twoToThree: 2,
    fourToSix: 1,
    sevenPlus: 1,
  });
});

test("time ranges use local Today and rolling windows", () => {
  const now = new Date(2026, 7, 2, 15, 30).getTime();
  assert.equal(resolveTimeRange("today", now).fromMs, new Date(2026, 7, 2).getTime());
  assert.equal(resolveTimeRange("7d", now).fromMs, now - 7 * 24 * 60 * 60 * 1_000);
  assert.equal(resolveTimeRange("30d", now).fromMs, now - 30 * 24 * 60 * 60 * 1_000);
  assert.equal(resolveTimeRange("all", now).fromMs, 0);
  assert.equal(resolveTimeRange("all", now).toMs, now + 1);
});
