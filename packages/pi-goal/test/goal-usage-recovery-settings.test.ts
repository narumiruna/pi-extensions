import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, test, vi } from "vitest";
import { createMockContext, createMockPi } from "../../../test/support.js";
import { GoalCommandController } from "../src/commands.js";
import { registerGoalLifecycle } from "../src/lifecycle.js";
import { GoalRunController } from "../src/run-protocol.js";
import { GoalRuntime } from "../src/runtime.js";
import { type GoalSettings, saveGoalSettings } from "../src/settings.js";
import { applyGoalSettings } from "../src/settings-ui.js";
import { requireLastGoal, settingsPath } from "./support/goal-fixture.js";

const RETRY_MS = 15 * 60 * 1000;
const MODEL = { provider: "openai-codex", id: "quota-test", name: "Quota test", api: "openai-codex-responses" };
type RunEvent = { type: string; status?: string };
type UsageRequest = { signal: AbortSignal; respond(value: unknown): boolean };
type Fixture = Omit<ReturnType<typeof createMockContext>, "ctx"> & {
  ctx: ExtensionCommandContext;
  mock: ReturnType<typeof createMockPi>;
  runtime: GoalRuntime;
  file: string;
  runEvents: RunEvent[];
};
const fixtures: Fixture[] = [];
let sequence = 0;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-08T00:00:00Z"));
});

afterEach(async () => {
  for (const fixture of fixtures.splice(0)) await emit(fixture, "session_shutdown");
  assert.equal(vi.getTimerCount(), 0, "settings lifecycle must not leak a timer");
  vi.useRealTimers();
});

async function emit(fixture: Fixture, event: string, data: unknown = {}) {
  return await fixture.mock.events.get(event)?.[0]?.(data, fixture.ctx);
}

async function start() {
  const file = settingsPath(`usage-recovery-settings-${sequence++}.json`);
  writeFileSync(file, '{"retryUsageLimits":true,"rpc":{"enabled":true},"future":{"keep":42}}\n');
  const mock = createMockPi({ activeTools: ["goal_complete", "goal_blocked", "goal_wait"] });
  const runtime = new GoalRuntime(mock.pi);
  const commands = new GoalCommandController(runtime);
  const runs = new GoalRunController(runtime, commands);
  runs.register(mock.pi);
  registerGoalLifecycle(mock.pi, runtime, runs, { settingsPath: file });
  const context = createMockContext({
    model: { ...MODEL },
    sessionManager: { getSessionId: () => "settings-quota-session", getBranch: () => [], getEntries: () => [] },
  });
  const runEvents: RunEvent[] = [];
  mock.eventBus.on("pi-goal:event:settings-quota-run", (event) => runEvents.push(event as RunEvent));
  const fixture: Fixture = { mock, runtime, file, runEvents, ...context };
  fixtures.push(fixture);
  await emit(fixture, "session_start");
  mock.eventBus.emit("pi-goal:start", { runId: "settings-quota-run", objective: "finish settings recovery objective" });
  await vi.advanceTimersByTimeAsync(0);
  await begin(fixture);
  return fixture;
}

async function begin(fixture: Fixture) {
  await emit(fixture, "before_agent_start", {
    prompt: fixture.mock.sentUserMessages.at(-1)?.text ?? "",
    systemPrompt: "base",
  });
  await emit(fixture, "agent_start");
}

async function rejectQuota(fixture: Fixture) {
  const message = {
    role: "assistant",
    stopReason: "error",
    errorMessage: "Codex error: The usage limit has been reached",
    content: [],
  };
  await emit(fixture, "turn_end", { message, toolResults: [] });
  await emit(fixture, "agent_end", { messages: [message] });
  await emit(fixture, "agent_settled", { aborted: false });
}

function statuses(fixture: Fixture) {
  return fixture.runEvents.filter((event) => event.type === "state").map((event) => event.status);
}

function setRetry(
  fixture: Fixture,
  enabled: boolean,
  save = (settings: GoalSettings) => saveGoalSettings(settings, fixture.file),
) {
  applyGoalSettings(
    fixture.runtime,
    { ...structuredClone(fixture.runtime.settings), retryUsageLimits: enabled },
    fixture.ctx,
    { save },
  );
}

function pendingUsage(fixture: Fixture) {
  let request: UsageRequest | undefined;
  let resolve: (value: unknown) => void = () => assert.fail("expected usage read");
  const promise = new Promise<unknown>((done) => {
    resolve = done;
  });
  fixture.mock.eventBus.on("usage:query:v1", (payload) => {
    request = payload as UsageRequest;
    request.respond(promise);
  });
  return {
    get request() {
      return request;
    },
    resolve,
  };
}

test("disabling a real quota wait commits settings before its one managed terminal and preserves unknown fields", async () => {
  const fixture = await start();
  const usage = pendingUsage(fixture);
  await rejectQuota(fixture);
  const id = fixture.runtime.activeGoal?.id;
  const observedDiskValues: unknown[] = [];
  fixture.mock.eventBus.on("pi-goal:event:settings-quota-run", (payload) => {
    if ((payload as RunEvent).status === "usage_limited") {
      observedDiskValues.push(JSON.parse(readFileSync(fixture.file, "utf8")).retryUsageLimits);
    }
  });
  setRetry(fixture, false);
  await Promise.resolve();
  assert.deepEqual(observedDiskValues, [false]);
  assert.equal(usage.request?.signal.aborted, true);
  assert.equal(fixture.runtime.activeGoal?.status, "usage_limited");
  assert.equal(fixture.runtime.activeGoal?.id, id);
  assert.equal(fixture.runtime.activeGoal?.waiting, undefined);
  assert.deepEqual(JSON.parse(readFileSync(fixture.file, "utf8")).future, { keep: 42 });
  assert.deepEqual(statuses(fixture), ["active", "usage_limited"]);
  usage.resolve({ status: "unavailable", reason: "cancelled" });
  await vi.advanceTimersByTimeAsync(RETRY_MS);
  await emit(fixture, "agent_settled");
  assert.equal(fixture.mock.sentUserMessages.length, 1);
  assert.deepEqual(statuses(fixture), ["active", "usage_limited"]);
});

test("failed settings persistence keeps the exact live deadline and publishes no managed terminal", async () => {
  const fixture = await start();
  const usage = pendingUsage(fixture);
  await rejectQuota(fixture);
  const before = structuredClone(fixture.runtime.activeGoal);
  const bytes = readFileSync(fixture.file, "utf8");
  assert.throws(
    () =>
      setRetry(fixture, false, () => {
        throw new Error("disk full");
      }),
    /disk full/,
  );
  assert.deepEqual(fixture.runtime.activeGoal, before);
  assert.equal(fixture.runtime.settings.retryUsageLimits, true);
  assert.equal(readFileSync(fixture.file, "utf8"), bytes);
  assert.deepEqual(statuses(fixture), ["active"]);
  usage.resolve({ status: "unavailable", reason: "query-failed" });
  await vi.advanceTimersByTimeAsync(RETRY_MS - 1);
  assert.equal(fixture.mock.sentUserMessages.length, 1);
  await vi.advanceTimersByTimeAsync(1);
  assert.equal(fixture.mock.sentUserMessages.length, 2);
  assert.deepEqual(statuses(fixture), ["active"]);
});

test("a runtime publication failure rolls back disk and the exact wait without irreversibly closing its managed run", async () => {
  const fixture = await start();
  const usage = pendingUsage(fixture);
  await rejectQuota(fixture);
  const before = structuredClone(fixture.runtime.activeGoal);
  const setStatus = fixture.ctx.ui.setStatus.bind(fixture.ctx.ui);
  let failures = 0;
  fixture.ctx.ui.setStatus = (key, value) => {
    if (fixture.runtime.activeGoal?.status === "usage_limited" && failures++ === 0)
      throw new Error("status publication failed");
    setStatus(key, value);
  };
  assert.throws(() => setRetry(fixture, false), /status publication failed/);
  assert.deepEqual(fixture.runtime.activeGoal, before);
  assert.equal(fixture.runtime.settings.retryUsageLimits, true);
  assert.equal(JSON.parse(readFileSync(fixture.file, "utf8")).retryUsageLimits, true);
  assert.deepEqual(statuses(fixture), ["active"], "failed transaction must discard queued terminal publications");
  assert.equal(fixture.runtime.ownsWorkflow(), true);
  assert.deepEqual(requireLastGoal(fixture.mock).waiting, before?.waiting);
  usage.resolve({ status: "unavailable", reason: "cancelled" });
  await vi.advanceTimersByTimeAsync(RETRY_MS);
  assert.equal(fixture.mock.sentUserMessages.length, 2, "rollback must restore the original timer");
  fixture.mock.eventBus.emit("pi-goal:cancel", { runId: "settings-quota-run" });
  await Promise.resolve();
  assert.deepEqual(statuses(fixture), ["active", "paused"], "managed controller must still own the restored run");
});

test("a failed settings transaction does not prevent a later successful disable", async () => {
  const fixture = await start();
  await rejectQuota(fixture);
  assert.throws(
    () =>
      setRetry(fixture, false, () => {
        throw new Error("first save failed");
      }),
    /first save failed/,
  );
  setRetry(fixture, false);
  await Promise.resolve();
  assert.equal(fixture.runtime.activeGoal?.status, "usage_limited");
  assert.deepEqual(statuses(fixture), ["active", "usage_limited"]);
  await vi.advanceTimersByTimeAsync(RETRY_MS);
  assert.equal(fixture.mock.sentUserMessages.length, 1);
});

test("an invalid existing file cannot disable a live recovery wait", async () => {
  const fixture = await start();
  await rejectQuota(fixture);
  const before = structuredClone(fixture.runtime.activeGoal);
  writeFileSync(fixture.file, "{invalid JSON\n");
  assert.throws(() => setRetry(fixture, false));
  assert.equal(readFileSync(fixture.file, "utf8"), "{invalid JSON\n");
  assert.deepEqual(fixture.runtime.activeGoal, before);
  assert.equal(fixture.runtime.settings.retryUsageLimits, true);
  assert.deepEqual(statuses(fixture), ["active"]);
  await vi.advanceTimersByTimeAsync(RETRY_MS);
  assert.equal(fixture.mock.sentUserMessages.length, 2);
});

test("reenabling recovery does not restart a previously stopped Goal or reopen its managed terminal", async () => {
  const fixture = await start();
  await rejectQuota(fixture);
  setRetry(fixture, false);
  const before = structuredClone(fixture.runtime.activeGoal);
  setRetry(fixture, true);
  await Promise.resolve();
  assert.deepEqual(fixture.runtime.activeGoal, before);
  assert.deepEqual(statuses(fixture), ["active", "usage_limited"]);
  await vi.advanceTimersByTimeAsync(RETRY_MS * 2);
  assert.equal(fixture.mock.sentUserMessages.length, 1);
});

test.each(["automaticTurns", "noProgressTurns"] as const)(
  "lowering %s during a real recovery wait stops pending work before another retry",
  async (field) => {
    const fixture = await start();
    const usage = pendingUsage(fixture);
    await rejectQuota(fixture);
    await vi.advanceTimersByTimeAsync(RETRY_MS);
    const success = { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "Unchanged work." }] };
    for (let index = 0; index < (field === "automaticTurns" ? 1 : 2); index++) {
      await begin(fixture);
      await emit(fixture, "turn_end", { message: success, toolResults: [] });
      await emit(fixture, "agent_end", { messages: [success] });
      await emit(fixture, "agent_settled", { aborted: false });
    }
    await begin(fixture);
    await rejectQuota(fixture);
    const before = structuredClone(fixture.runtime.activeGoal);
    assert.ok(before?.waiting?.usageLimit);
    assert.equal(usage.request?.signal.aborted, false);
    applyGoalSettings(
      fixture.runtime,
      {
        ...structuredClone(fixture.runtime.settings),
        continuationLimits: { ...fixture.runtime.settings.continuationLimits, [field]: 2 },
      },
      fixture.ctx,
      { save: (settings) => saveGoalSettings(settings, fixture.file) },
    );
    await Promise.resolve();
    assert.equal(fixture.runtime.activeGoal?.status, "paused");
    assert.equal(fixture.runtime.activeGoal?.id, before.id);
    assert.equal(fixture.runtime.activeGoal?.automaticModelTurns, before.automaticModelTurns);
    assert.equal(fixture.runtime.activeGoal?.toolFreeRepeatCount, before.toolFreeRepeatCount);
    assert.equal(usage.request?.signal.aborted, true);
    assert.deepEqual(statuses(fixture), ["active", "paused"]);
    const messages = fixture.mock.sentUserMessages.length;
    usage.resolve({ status: "unavailable", reason: "cancelled" });
    await vi.advanceTimersByTimeAsync(RETRY_MS);
    assert.equal(fixture.mock.sentUserMessages.length, messages);
  },
);

test.each(["queued", "running"] as const)(
  "disabling recovery cancels a %s scheduled request without rotating or resetting its Goal",
  async (phase) => {
    const fixture = await start();
    await rejectQuota(fixture);
    const before = structuredClone(fixture.runtime.activeGoal);
    await vi.advanceTimersByTimeAsync(RETRY_MS);
    assert.equal(fixture.mock.sentUserMessages.length, 2);
    if (phase === "running") await begin(fixture);
    let aborts = 0;
    fixture.ctx.abort = () => {
      aborts++;
    };
    setRetry(fixture, false);
    await Promise.resolve();
    assert.equal(fixture.runtime.activeGoal?.status, "usage_limited");
    assert.equal(fixture.runtime.activeGoal?.id, before?.id);
    assert.equal(fixture.runtime.activeGoal?.automaticModelTurns, before?.automaticModelTurns);
    assert.equal(fixture.runtime.activeGoal?.tokensUsed, before?.tokensUsed);
    assert.deepEqual(statuses(fixture), ["active", "usage_limited"]);
    if (phase === "queued") {
      const result = await emit(fixture, "input", {
        source: "extension",
        text: fixture.mock.sentUserMessages.at(-1)?.text,
        streamingBehavior: "followUp",
      });
      assert.deepEqual(result, { action: "handled" }, "queued recovery prompt must become stale after disabling");
    } else {
      assert.equal(aborts, 1, "an owned running recovery must be aborted");
    }
    await emit(fixture, "agent_settled", { aborted: phase === "running" });
    await vi.advanceTimersByTimeAsync(RETRY_MS);
    assert.equal(fixture.mock.sentUserMessages.length, 2);
    assert.deepEqual(statuses(fixture), ["active", "usage_limited"]);
  },
);

test("disabling quota recovery after actual work does not abort the recovered ordinary run", async () => {
  const fixture = await start();
  await rejectQuota(fixture);
  await vi.advanceTimersByTimeAsync(RETRY_MS);
  await begin(fixture);
  const message = { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "Verified progress." }] };
  await emit(fixture, "turn_end", { message, toolResults: [] });
  let aborts = 0;
  fixture.ctx.abort = () => {
    aborts++;
  };
  setRetry(fixture, false);
  assert.equal(fixture.runtime.activeGoal?.status, "active");
  assert.equal(fixture.runtime.activeGoal?.automaticModelTurns, 1);
  assert.equal(aborts, 0);
  assert.deepEqual(statuses(fixture), ["active"]);
  await emit(fixture, "agent_end", { messages: [message] });
  await emit(fixture, "agent_settled");
  assert.equal(fixture.mock.sentUserMessages.length, 3);
});

test("failed save preserves the owner of a pending successful reset query", async () => {
  const fixture = await start();
  const usage = pendingUsage(fixture);
  await rejectQuota(fixture);
  assert.throws(
    () =>
      setRetry(fixture, false, () => {
        throw new Error("disk full");
      }),
    /disk full/,
  );
  const resetAt = Date.now() + RETRY_MS * 2;
  usage.resolve({
    status: "ready",
    providerId: MODEL.provider,
    source: "refresh",
    expiresAt: Date.now() + 60_000,
    report: {
      providerId: MODEL.provider,
      providerName: "Service",
      source: "test",
      capturedAt: Date.now(),
      semantics: { kind: "consumer-subscription", label: "Allowance" },
      metrics: [],
      buckets: [
        { id: "constraint", label: "Allowance", modelKeys: [MODEL.id], unit: "count", remaining: 0, resetsAt: resetAt },
      ],
    },
  });
  await vi.advanceTimersByTimeAsync(0);
  assert.equal(fixture.runtime.activeGoal?.waiting?.resumeAt, resetAt);
  assert.deepEqual(statuses(fixture), ["active"]);
});

test("failed running-disable application does not abort work or publish an inactive contract", async () => {
  const fixture = await start();
  await rejectQuota(fixture);
  await vi.advanceTimersByTimeAsync(RETRY_MS);
  await begin(fixture);
  let aborts = 0;
  fixture.ctx.abort = () => {
    aborts++;
  };
  const messages = fixture.mock.sentMessages.length;
  const update = fixture.runtime.updateStatus.bind(fixture.runtime);
  let failed = false;
  fixture.runtime.updateStatus = (ctx, goal) => {
    if (!failed && goal.status === "usage_limited") {
      failed = true;
      throw new Error("post-stop application failed");
    }
    update(ctx, goal);
  };
  assert.throws(() => setRetry(fixture, false), /post-stop application failed/);
  assert.equal(aborts, 0);
  assert.equal(fixture.mock.sentMessages.length, messages);
  assert.equal(fixture.runtime.activeGoal?.status, "active");
  assert.equal(JSON.parse(readFileSync(fixture.file, "utf8")).retryUsageLimits, true);
  assert.deepEqual(statuses(fixture), ["active"]);
});

test("disabling recovery after quota agent_end cancels retained recovery before settlement", async () => {
  const fixture = await start();
  await rejectQuota(fixture);
  await vi.advanceTimersByTimeAsync(RETRY_MS);
  await begin(fixture);
  const message = {
    role: "assistant",
    stopReason: "error",
    content: [],
    errorMessage: "Codex error: The usage limit has been reached",
  };
  await emit(fixture, "turn_end", { message, toolResults: [] });
  await emit(fixture, "agent_end", { messages: [message] });
  setRetry(fixture, false);
  assert.equal(
    fixture.runtime.activeGoal?.status,
    "usage_limited",
    "disabling must cancel retained recovery immediately",
  );
  await emit(fixture, "agent_settled");
  await Promise.resolve();
  assert.equal(fixture.runtime.activeGoal?.status, "usage_limited");
  assert.deepEqual(statuses(fixture), ["active", "usage_limited"]);
});

test.each([
  ["manual", "disable"],
  ["manual", "model"],
  ["automatic", "disable"],
  ["automatic", "model"],
] as const)(
  "successful %s native retry retires quota policy before a %s event in its tool loop",
  async (origin, action) => {
    const fixture = await start();
    if (origin === "automatic") {
      const initial = { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "Initial progress" }] };
      await emit(fixture, "turn_end", { message: initial, toolResults: [] });
      await emit(fixture, "agent_end", { messages: [initial] });
      await emit(fixture, "agent_settled");
      await begin(fixture);
    }
    const quota = {
      role: "assistant",
      stopReason: "error",
      errorMessage: "Usage limit reached: HTTP 429",
      content: [],
    };
    await emit(fixture, "turn_end", { message: quota, toolResults: [] });
    await emit(fixture, "agent_end", { messages: [quota] });
    await emit(fixture, "agent_start");
    const work = {
      role: "assistant",
      stopReason: "toolUse",
      content: [{ type: "toolCall", id: "useful-work", name: "read", arguments: { path: "file.ts" } }],
    };
    await emit(fixture, "turn_end", { message: work, toolResults: [] });
    let aborts = 0;
    fixture.ctx.abort = () => {
      aborts++;
    };
    if (action === "disable") setRetry(fixture, false);
    else {
      Object.assign(fixture.ctx, { model: { ...MODEL, id: "normal-model-change" } });
      await emit(fixture, "model_select");
    }
    assert.equal(fixture.runtime.activeGoal?.status, "active");
    assert.equal(aborts, 0);
    assert.equal(fixture.runtime.goalRecovery?.kind, "provider_retry", "native run ownership must remain intact");
    assert.equal(fixture.runtime.goalRecovery?.usageLimitScope, undefined);
    assert.equal(fixture.runtime.activeGoal?.automaticModelTurns, origin === "manual" ? 0 : 2);
    assert.deepEqual(statuses(fixture), ["active"]);
  },
);
