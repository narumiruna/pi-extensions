import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, test, vi } from "vitest";
import { createMockContext, createMockPi } from "../../../test/support.js";
import type { ActiveGoal } from "../src/persistence.js";
import { createGoal } from "../src/runtime.js";
import {
  assistantUsageEntry,
  DEFAULT_SETTINGS_PATH,
  lastGoal,
  registerGoalWithSettingsPath,
  requireGoalTool,
  requireLastGoal,
  settingsPath,
} from "./support/goal-fixture.js";

const RETRY_MS = 15 * 60 * 1000;
const QUOTA_ERROR = "Codex error: The usage limit has been reached";
const MODEL = { provider: "openai-codex", id: "quota-test", name: "Quota test", api: "openai-codex-responses" };
const ENABLED_SETTINGS = settingsPath("usage-recovery-lifecycle.json");
const LIMITED_SETTINGS = settingsPath("usage-recovery-lifecycle-limits.json");
writeFileSync(ENABLED_SETTINGS, '{"retryUsageLimits":true,"rpc":{"enabled":true}}\n');
writeFileSync(
  LIMITED_SETTINGS,
  '{"retryUsageLimits":true,"continuationLimits":{"automaticTurns":2,"noProgressTurns":3}}\n',
);

type Fixture = Omit<ReturnType<typeof createMockContext>, "ctx"> & {
  ctx: ExtensionCommandContext;
  mock: ReturnType<typeof createMockPi>;
  branch: Record<string, unknown>[];
};
type UsageRequest = {
  session: unknown;
  sessionId: string;
  providerId: string;
  refresh: boolean;
  signal: AbortSignal;
  respond(value: unknown): boolean;
};
type RunEvent = { type: string; status?: string; goalId?: string; error?: { code: string } };
const fixtures: Fixture[] = [];

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-08T00:00:00Z"));
});

afterEach(async () => {
  for (const fixture of fixtures.splice(0)) await emit(fixture, "session_shutdown");
  assert.equal(vi.getTimerCount(), 0, "session cleanup must release owned timers");
  vi.useRealTimers();
});

async function initialize(
  overrides: Record<string, unknown> = {},
  branch: Record<string, unknown>[] = [],
  settings = ENABLED_SETTINGS,
): Promise<Fixture> {
  const mock = createMockPi();
  registerGoalWithSettingsPath(mock.pi, settings);
  const context = createMockContext({
    model: { ...MODEL },
    sessionManager: { getSessionId: () => "quota-session", getBranch: () => branch, getEntries: () => branch },
    ...overrides,
  });
  const fixture: Fixture = { mock, branch, ...context };
  fixtures.push(fixture);
  await emit(fixture, "session_start");
  return fixture;
}

async function start(
  overrides: Record<string, unknown> = {},
  command = "finish the objective",
  settings = ENABLED_SETTINGS,
) {
  const fixture = await initialize(overrides, [], settings);
  await fixture.mock.commands.get("goal")?.handler(command, fixture.ctx);
  await begin(fixture);
  return fixture;
}

async function emit(fixture: Fixture, event: string, payload: unknown = {}) {
  return await fixture.mock.events.get(event)?.[0]?.(payload, fixture.ctx);
}

async function begin(fixture: Fixture) {
  await emit(fixture, "before_agent_start", {
    prompt: fixture.mock.sentUserMessages.at(-1)?.text ?? "",
    systemPrompt: "base",
  });
  await emit(fixture, "agent_start");
}

function response(errorMessage: string | null = QUOTA_ERROR, content: unknown[] = []) {
  return {
    role: "assistant",
    stopReason: errorMessage === null ? "stop" : "error",
    errorMessage: errorMessage ?? undefined,
    content,
  };
}

async function finish(fixture: Fixture, message = response(), settle = true) {
  await emit(fixture, "turn_end", { message, toolResults: [] });
  await emit(fixture, "agent_end", { messages: [message] });
  if (settle) await emit(fixture, "agent_settled", { aborted: false });
}

function stored(fixture: Fixture): ActiveGoal {
  return requireLastGoal(fixture.mock) as ActiveGoal;
}

function stateEntry(goal: ActiveGoal | null) {
  return { type: "custom", customType: "goal-state", data: { goal: structuredClone(goal) } };
}

function pendingUsage(fixture: Fixture) {
  const requests: UsageRequest[] = [];
  let resolve: (value: unknown) => void = () => assert.fail("usage request was not offered");
  const result = new Promise<unknown>((done) => {
    resolve = done;
  });
  fixture.mock.eventBus.on("usage:query:v1", (payload) => {
    const request = payload as UsageRequest;
    requests.push(request);
    request.respond(result);
  });
  return { requests, resolve };
}

// Independent structural service fixture from the public usage v1 contract.
function readyUsage(resetAt: number) {
  return {
    status: "ready",
    providerId: MODEL.provider,
    source: "refresh",
    expiresAt: Date.now() + 60_000,
    report: {
      providerId: MODEL.provider,
      providerName: "Quota service fixture",
      capturedAt: Date.now(),
      source: "independent-test",
      semantics: { kind: "consumer-subscription", label: "Account allowance" },
      buckets: [
        {
          id: "opaque-constraint",
          label: "Allowance",
          modelKeys: [MODEL.id],
          unit: "count",
          remaining: 0,
          resetsAt: resetAt,
        },
      ],
      metrics: [],
    },
  };
}

const cancellationActions = [
  "pause",
  "clear",
  "edit",
  "replace",
  "complete",
  "block",
  "shutdown",
  "session replacement",
  "model change",
] as const;
type CancellationAction = (typeof cancellationActions)[number];

async function cancel(fixture: Fixture, action: CancellationAction) {
  const goal = stored(fixture);
  if (action === "pause" || action === "clear") {
    await fixture.mock.commands.get("goal")?.handler(action, fixture.ctx);
  } else if (action === "edit" || action === "replace") {
    await fixture.mock.commands
      .get("goal")
      ?.handler(action === "edit" ? "edit revised objective" : "replacement objective", fixture.ctx);
  } else if (action === "complete" || action === "block") {
    await requireGoalTool(fixture.mock, action === "complete" ? "goal_complete" : "goal_blocked").execute(
      `cancel-${action}`,
      action === "complete"
        ? { goal_id: goal.id, summary: "All requirements are complete and verified." }
        : {
            goal_id: goal.id,
            reason: "Access is permanently denied",
            evidence: "Verified in three separate turns",
            repeated_turns: 3,
          },
      new AbortController().signal,
      () => undefined,
      fixture.ctx,
    );
  } else if (action === "shutdown") {
    await emit(fixture, "session_shutdown");
  } else if (action === "session replacement") {
    const replacement = createMockContext({
      model: { ...MODEL },
      sessionManager: { getSessionId: () => "replacement-session", getBranch: () => [], getEntries: () => [] },
    });
    fixture.ctx = replacement.ctx;
    await emit(fixture, "session_start");
  } else {
    Object.assign(fixture.ctx, { model: { ...MODEL, id: "different-model" } });
    await emit(fixture, "model_select", { model: fixture.ctx.model, previousModel: MODEL, source: "set" });
  }
}

test.each(cancellationActions)(
  "%s aborts an in-flight usage read and prevents a late result or deadline from waking old work",
  async (action) => {
    const fixture = await start();
    const usage = pendingUsage(fixture);
    await finish(fixture);
    assert.equal(usage.requests.length, 1);
    const request = usage.requests[0];
    assert.ok(request);
    assert.equal(request.signal.aborted, false);
    assert.equal(request.session, fixture.ctx.sessionManager);
    assert.equal(request.sessionId, "quota-session");
    assert.equal(request.providerId, MODEL.provider);
    assert.equal(request.refresh, true);
    await cancel(fixture, action);
    assert.equal(request.signal.aborted, true, `${action} must release the service request immediately`);
    if (action !== "shutdown" && action !== "session replacement") {
      assert.equal(lastGoal(fixture.mock)?.waiting, undefined);
    }
    const entries = fixture.mock.entries.length;
    const messages = fixture.mock.sentUserMessages.length;
    usage.resolve(readyUsage(Date.now() + 30_000));
    await vi.advanceTimersByTimeAsync(RETRY_MS * 2);
    await emit(fixture, "agent_settled");
    assert.equal(fixture.mock.entries.length, entries, "late usage completion must not publish stale state");
    assert.equal(fixture.mock.sentUserMessages.length, messages, "old deadline must not send another prompt");
  },
);

test("full abort after agent_end takes precedence over entering quota recovery", async () => {
  const fixture = await start();
  const usage = pendingUsage(fixture);
  await finish(fixture, response(), false);
  assert.equal(stored(fixture).waiting, undefined, "agent_end must only record recovery intent");
  await emit(fixture, "agent_settled", { aborted: true });
  assert.equal(stored(fixture).status, "paused");
  assert.equal(usage.requests.length, 0);
  await vi.advanceTimersByTimeAsync(RETRY_MS);
  assert.equal(fixture.mock.sentUserMessages.length, 1);
});

test("late hooks after shutdown do not touch an invalidated context or revive quota recovery", async () => {
  const fixture = await start();
  const usage = pendingUsage(fixture);
  await finish(fixture);
  await emit(fixture, "session_shutdown");
  const entries = fixture.mock.entries.length;
  const stale = new Proxy(
    {},
    {
      get() {
        throw new Error("stale context accessed");
      },
    },
  );
  for (const event of ["agent_end", "agent_settled", "model_select", "turn_end"]) {
    await fixture.mock.events.get(event)?.[0]?.({ messages: [response()] }, stale);
  }
  usage.resolve(readyUsage(Date.now() + 30_000));
  await vi.advanceTimersByTimeAsync(RETRY_MS);
  assert.equal(fixture.mock.entries.length, entries);
  assert.equal(fixture.mock.sentUserMessages.length, 1);
});

test.each(["pause", "clear", "session replacement", "model change"] as const)(
  "synchronous usage-service reentry through %s cannot publish a stale reset or wake",
  async (action) => {
    const fixture = await start();
    const usage = pendingUsage(fixture);
    let cancellation: Promise<void> | undefined;
    fixture.mock.eventBus.on("usage:query:v1", () => {
      cancellation = cancel(fixture, action);
    });
    await finish(fixture);
    await cancellation;
    assert.equal(usage.requests[0]?.signal.aborted, true);
    const entries = fixture.mock.entries.length;
    const messages = fixture.mock.sentUserMessages.length;
    usage.resolve(readyUsage(Date.now() + 30_000));
    await vi.advanceTimersByTimeAsync(RETRY_MS);
    assert.equal(fixture.mock.entries.length, entries);
    assert.equal(fixture.mock.sentUserMessages.length, messages);
  },
);

test("a usage query timeout releases service work but preserves the original fallback deadline", async () => {
  const fixture = await start();
  const usage = pendingUsage(fixture);
  await finish(fixture);
  const waiting = structuredClone(stored(fixture));
  await vi.advanceTimersByTimeAsync(14_999);
  assert.equal(usage.requests[0]?.signal.aborted, false);
  await vi.advanceTimersByTimeAsync(1);
  assert.equal(usage.requests[0]?.signal.aborted, true);
  assert.deepEqual(stored(fixture).waiting, waiting.waiting);
  usage.resolve(readyUsage(Date.now() + 30_000));
  await vi.advanceTimersByTimeAsync(RETRY_MS - 15_001);
  assert.equal(fixture.mock.sentUserMessages.length, 1);
  await vi.advanceTimersByTimeAsync(1);
  assert.equal(fixture.mock.sentUserMessages.length, 2);
});

test("changing session ID on the same manager rejects an in-flight reset result", async () => {
  let sessionId = "original-session";
  const fixture = await start({
    sessionManager: { getSessionId: () => sessionId, getBranch: () => [], getEntries: () => [] },
  });
  const usage = pendingUsage(fixture);
  await finish(fixture);
  const deadline = stored(fixture).waiting?.resumeAt;
  sessionId = "new-session";
  usage.resolve(readyUsage(Date.now() + 30_000));
  await vi.advanceTimersByTimeAsync(0);
  assert.equal(stored(fixture).waiting?.resumeAt, deadline);
  assert.equal(usage.requests[0]?.signal.aborted, true);
});

test("a usable reset hint updates only the persisted deadline and dispatches exactly once", async () => {
  const fixture = await start();
  const usage = pendingUsage(fixture);
  const id = stored(fixture).id;
  await finish(fixture);
  const resetAt = Date.now() + 45_000;
  usage.resolve(readyUsage(resetAt));
  await vi.advanceTimersByTimeAsync(0);
  assert.equal(stored(fixture).waiting?.resumeAt, resetAt);
  assert.deepEqual(stored(fixture).waiting?.usageLimit, { provider: MODEL.provider, model: MODEL.id, api: MODEL.api });
  assert.equal(
    JSON.stringify(fixture.mock.entries).includes("opaque-constraint"),
    false,
    "raw reports must not be persisted",
  );
  await vi.advanceTimersByTimeAsync(44_999);
  assert.equal(fixture.mock.sentUserMessages.length, 1);
  await vi.advanceTimersByTimeAsync(1);
  await emit(fixture, "agent_settled");
  await emit(fixture, "agent_settled");
  assert.equal(fixture.mock.sentUserMessages.length, 2);
  assert.equal(stored(fixture).id, id);
});

test("reload retains the exact hinted deadline, safety counters, tokens, and quiet elapsed time", async () => {
  const original = await start();
  const usage = pendingUsage(original);
  await vi.advanceTimersByTimeAsync(5_000);
  await finish(original);
  const resetAt = Date.now() + RETRY_MS * 3;
  usage.resolve(readyUsage(resetAt));
  await vi.advanceTimersByTimeAsync(0);
  const snapshot = structuredClone(stored(original));
  await emit(original, "session_shutdown");
  await vi.advanceTimersByTimeAsync(RETRY_MS);
  const restored = await initialize({}, [stateEntry(snapshot)]);
  assert.deepEqual(stored(restored).waiting, snapshot.waiting);
  assert.equal(stored(restored).activeStartedAt, undefined);
  assert.equal(stored(restored).timeUsedSeconds, snapshot.timeUsedSeconds);
  assert.equal(stored(restored).automaticModelTurns, snapshot.automaticModelTurns);
  assert.equal(stored(restored).tokensUsed, snapshot.tokensUsed);
  await vi.advanceTimersByTimeAsync(RETRY_MS * 2 - 1);
  assert.equal(restored.mock.sentUserMessages.length, 0);
  await vi.advanceTimersByTimeAsync(1);
  assert.equal(restored.mock.sentUserMessages.length, 1);
  assert.equal(stored(restored).id, snapshot.id);
  assert.equal(stored(restored).timeUsedSeconds, snapshot.timeUsedSeconds);
});

function waitingGoal(overrides: Partial<ActiveGoal> = {}): ActiveGoal {
  return {
    ...createGoal("restore quota-limited objective", undefined, 0),
    waiting: {
      reason: "Provider usage limit",
      resumeAt: Date.now() + RETRY_MS,
      usageLimit: { provider: MODEL.provider, model: MODEL.id, api: MODEL.api },
    },
    activeStartedAt: undefined,
    ...overrides,
  };
}

test.each(["idle", "busy", "pending"] as const)(
  "overdue reload dispatches once only after the %s session is eligible",
  async (mode) => {
    let idle = mode !== "busy";
    let pending = mode === "pending";
    const snapshot = waitingGoal();
    assert.ok(snapshot.waiting?.resumeAt);
    vi.setSystemTime(snapshot.waiting.resumeAt + 1_000);
    const fixture = await initialize({ isIdle: () => idle, hasPendingMessages: () => pending }, [stateEntry(snapshot)]);
    assert.equal(
      stored(fixture).waiting?.resumeAt,
      snapshot.waiting.resumeAt,
      "restore must not clamp overdue deadlines",
    );
    assert.equal(fixture.mock.sentUserMessages.length, 0, "restore must not dispatch synchronously");
    await vi.advanceTimersByTimeAsync(0);
    assert.equal(fixture.mock.sentUserMessages.length, mode === "idle" ? 1 : 0);
    idle = true;
    pending = false;
    await emit(fixture, "agent_settled");
    await emit(fixture, "agent_settled");
    assert.equal(fixture.mock.sentUserMessages.length, 1);
    assert.equal(stored(fixture).id, snapshot.id);
  },
);

test("fork reconstruction uses the active branch, not a later wait from another branch", async () => {
  const chosen = waitingGoal({
    id: "chosen-goal",
    automaticModelTurns: 4,
    toolFreeRepeatCount: 2,
    tokensUsed: 7,
    baselineTokens: 0,
  });
  const unrelated = waitingGoal({
    id: "other-branch-goal",
    waiting: { reason: "Other branch", resumeAt: Date.now() + 10_000 },
  });
  const branch = [assistantUsageEntry({ totalTokens: 7 }), stateEntry(chosen)];
  const fixture = await initialize({
    sessionManager: {
      getSessionId: () => "fork-session",
      getBranch: () => branch,
      getEntries: () => [...branch, stateEntry(unrelated)],
    },
  });
  assert.equal(stored(fixture).id, chosen.id);
  assert.deepEqual(stored(fixture).waiting, chosen.waiting);
  assert.equal(stored(fixture).automaticModelTurns, 4);
  assert.equal(stored(fixture).toolFreeRepeatCount, 2);
  assert.equal(stored(fixture).tokensUsed, 7);
  await vi.advanceTimersByTimeAsync(RETRY_MS);
  assert.equal(fixture.mock.sentUserMessages.length, 1);
  assert.match(fixture.mock.sentUserMessages[0]?.text ?? "", /chosen-goal/);
});

test.each(["model", "provider", "api"] as const)(
  "restoring a quota wait under a different %s requires manual recovery",
  async (field) => {
    const selected = { ...MODEL, [field === "model" ? "id" : field]: "changed" };
    const snapshot = waitingGoal();
    const fixture = await initialize({ model: selected }, [stateEntry(snapshot)]);
    assert.equal(stored(fixture).status, "usage_limited");
    assert.equal(stored(fixture).id, snapshot.id);
    assert.equal(stored(fixture).waiting, undefined);
    await vi.advanceTimersByTimeAsync(RETRY_MS);
    assert.equal(fixture.mock.sentUserMessages.length, 0);
  },
);

test.each([
  ["automatic-work cap", { automaticModelTurns: 2 }, "paused"],
  ["no-progress cap", { toolFreeRepeatCount: 3 }, "paused"],
  ["token budget", { tokenBudget: 10, tokensUsed: 10 }, "budget_limited"],
] as const)(
  "an already exhausted %s cannot receive a quota-retry exemption on restore",
  async (_name, overrides, status) => {
    const snapshot = waitingGoal(overrides);
    const fixture = await initialize(
      {},
      [assistantUsageEntry({ totalTokens: snapshot.tokensUsed }), stateEntry(snapshot)],
      LIMITED_SETTINGS,
    );
    assert.equal(stored(fixture).status, status);
    assert.equal(stored(fixture).id, snapshot.id);
    assert.equal(stored(fixture).waiting, undefined);
    await vi.advanceTimersByTimeAsync(RETRY_MS);
    assert.equal(fixture.mock.sentUserMessages.length, 0);
  },
);

test("removing a required Goal helper before the deadline pauses instead of retrying", async () => {
  const fixture = await start();
  await finish(fixture);
  fixture.mock.rawPi.setActiveTools(["goal_complete", "goal_wait"]);
  await vi.advanceTimersByTimeAsync(RETRY_MS);
  assert.equal(stored(fixture).status, "paused");
  assert.equal(stored(fixture).waiting, undefined);
  assert.equal(fixture.mock.sentUserMessages.length, 1);
});

test("newly recorded usage exhausts the budget during a wait and cancels the pending read", async () => {
  const fixture = await start({}, "--tokens 10 finish");
  const usage = pendingUsage(fixture);
  await finish(fixture);
  fixture.branch.push(assistantUsageEntry({ totalTokens: 10 }));
  await emit(fixture, "tool_execution_end", {
    toolName: "read",
    toolCallId: "budget-boundary",
    result: {},
    isError: false,
  });
  assert.equal(stored(fixture).status, "budget_limited");
  assert.equal(stored(fixture).tokensUsed, 10);
  assert.equal(usage.requests[0]?.signal.aborted, true);
  const messages = fixture.mock.sentUserMessages.length;
  usage.resolve(readyUsage(Date.now() + 30_000));
  await vi.advanceTimersByTimeAsync(RETRY_MS);
  assert.equal(fixture.mock.sentUserMessages.length, messages);
});

test.each(["text", "tool attempted", "earlier response"] as const)(
  "scheduled quota rejection with %s is real automatic work",
  async (work) => {
    const fixture = await start();
    await finish(fixture);
    await vi.advanceTimersByTimeAsync(RETRY_MS);
    await begin(fixture);
    const before = stored(fixture).automaticModelTurns;
    if (work === "tool attempted")
      await emit(fixture, "tool_call", { toolName: "read", toolCallId: "partial-read", input: {} });
    if (work === "earlier response")
      await emit(fixture, "turn_end", {
        message: response(null, [{ type: "text", text: "Completed a real work step." }]),
        toolResults: [],
      });
    fixture.branch.push(assistantUsageEntry({ totalTokens: 7, input: 3, output: 4 }));
    await finish(
      fixture,
      response(QUOTA_ERROR, work === "text" ? [{ type: "text", text: "Partial work before rejection." }] : []),
    );
    assert.equal(stored(fixture).automaticModelTurns, before + (work === "earlier response" ? 2 : 1));
    assert.equal(stored(fixture).tokensUsed, 7);
    assert.equal(stored(fixture).status, "active");
    assert.ok(stored(fixture).waiting?.usageLimit);
  },
);

test("a quota error on an ordinary automatic request still consumes its work allowance", async () => {
  const fixture = await start();
  await finish(fixture, response(null, [{ type: "text", text: "Initial progress" }]));
  assert.equal(fixture.mock.sentUserMessages.length, 2);
  await begin(fixture);
  await finish(fixture);
  assert.equal(stored(fixture).automaticModelTurns, 1);
  assert.ok(stored(fixture).waiting?.usageLimit);
});

test("native retry responses retain ordinary accounting after a scheduled recovery encounters a non-quota error", async () => {
  const fixture = await start();
  await finish(fixture);
  await vi.advanceTimersByTimeAsync(RETRY_MS);
  await begin(fixture);
  await finish(fixture, response("HTTP 524: upstream timeout"), false);
  assert.equal(stored(fixture).automaticModelTurns, 1);
  assert.equal(stored(fixture).waiting, undefined);
  await emit(fixture, "agent_start");
  await finish(fixture, response(), false);
  assert.equal(
    stored(fixture).automaticModelTurns,
    2,
    "native retry must not inherit the work-free scheduled exemption",
  );
  await emit(fixture, "agent_settled", { aborted: false });
  assert.ok(stored(fixture).waiting?.usageLimit);
});

test("default-off restore stops tagged recovery without sending a prompt or rotating its Goal ID", async () => {
  const snapshot = waitingGoal();
  const fixture = await initialize({}, [stateEntry(snapshot)], DEFAULT_SETTINGS_PATH);
  assert.equal(stored(fixture).status, "usage_limited");
  assert.equal(stored(fixture).id, snapshot.id);
  assert.equal(stored(fixture).waiting, undefined);
  await vi.advanceTimersByTimeAsync(RETRY_MS);
  assert.equal(fixture.mock.sentUserMessages.length, 0);
});

test("a managed run stays active across repeated quota waits and emits only one cancellation terminal", async () => {
  const fixture = await initialize();
  const events: RunEvent[] = [];
  fixture.mock.eventBus.on("pi-goal:event:quota-run", (event) => events.push(event as RunEvent));
  fixture.mock.eventBus.emit("pi-goal:start", { runId: "quota-run", objective: "finish managed quota objective" });
  await vi.advanceTimersByTimeAsync(0);
  await begin(fixture);
  const id = stored(fixture).id;
  for (let attempt = 0; attempt < 2; attempt++) {
    await finish(fixture);
    assert.equal(stored(fixture).id, id);
    assert.deepEqual(
      events.filter((event) => event.type === "state").map((event) => event.status),
      ["active"],
    );
    await vi.advanceTimersByTimeAsync(RETRY_MS);
    await begin(fixture);
  }
  await finish(fixture);
  fixture.mock.eventBus.emit("pi-goal:cancel", { runId: "quota-run" });
  fixture.mock.eventBus.emit("pi-goal:cancel", { runId: "quota-run" });
  await vi.advanceTimersByTimeAsync(RETRY_MS);
  assert.deepEqual(
    events.filter((event) => event.type === "state").map((event) => event.status),
    ["active", "paused"],
  );
  assert.equal(stored(fixture).status, "paused");
  assert.equal(fixture.mock.sentUserMessages.length, 3);
});

test("a changed session ID on the same manager invalidates its old quota timer without session_start", async () => {
  let sessionId = "timer-original-session";
  const fixture = await start({
    sessionManager: { getSessionId: () => sessionId, getBranch: () => [], getEntries: () => [] },
  });
  await finish(fixture);
  sessionId = "timer-replacement-session";
  await vi.advanceTimersByTimeAsync(RETRY_MS);
  assert.equal(
    fixture.mock.sentUserMessages.length,
    1,
    "old session timer must not deliver into the replacement session",
  );
  await emit(fixture, "agent_settled");
  assert.equal(fixture.mock.sentUserMessages.length, 1, "settlement must enforce the same session boundary as timers");
});

test.each([false, true])(
  "deadline delivery failures retain quota metadata and bounded retry ownership (both fail: %s)",
  async (bothFail) => {
    const fixture = await start();
    await finish(fixture);
    const before = structuredClone(stored(fixture));
    const send = fixture.mock.rawPi.sendUserMessage.bind(fixture.mock.rawPi);
    let attempts = 0;
    fixture.mock.rawPi.sendUserMessage = (...args) => {
      attempts++;
      if (attempts === 1 || bothFail) throw new Error("recovery delivery failed");
      send(...args);
    };
    await vi.advanceTimersByTimeAsync(RETRY_MS);
    assert.equal(attempts, 1);
    assert.deepEqual(stored(fixture).waiting, before.waiting);
    await vi.advanceTimersByTimeAsync(999);
    assert.equal(attempts, 1);
    await vi.advanceTimersByTimeAsync(1);
    assert.equal(attempts, 2);
    if (bothFail) {
      assert.deepEqual(stored(fixture).waiting, before.waiting);
      await emit(fixture, "agent_settled");
      await vi.advanceTimersByTimeAsync(RETRY_MS);
      assert.equal(attempts, 2, "delivery failure must not create an unbounded retry loop");
    } else {
      await begin(fixture);
      await finish(fixture);
      assert.equal(
        stored(fixture).automaticModelTurns,
        before.automaticModelTurns,
        "successful redelivery must retain the work-free quota retry tag",
      );
      assert.ok(stored(fixture).waiting?.usageLimit);
    }
  },
);

test("a failed recovery delivery cannot resurrect a synchronously cleared Goal", async () => {
  const fixture = await start();
  await finish(fixture);
  fixture.mock.rawPi.sendUserMessage = () => {
    void fixture.mock.commands.get("goal")?.handler("clear", fixture.ctx);
    throw new Error("obsolete delivery failed");
  };
  await vi.advanceTimersByTimeAsync(RETRY_MS);
  assert.equal(lastGoal(fixture.mock), null);
  const entries = fixture.mock.entries.length;
  await vi.advanceTimersByTimeAsync(RETRY_MS);
  await emit(fixture, "agent_settled");
  assert.equal(fixture.mock.entries.length, entries);
  assert.equal(fixture.mock.sentUserMessages.length, 1);
});

test("quota recovery preserves a preexisting no-progress epoch and successful empty work still reaches its guard", async () => {
  const fingerprint = createHash("sha256").update("").digest("hex");
  const snapshot = waitingGoal({
    automaticModelTurns: 4,
    toolFreeRepeatCount: 2,
    lastToolFreeOutputFingerprint: fingerprint,
  });
  const fixture = await initialize({}, [stateEntry(snapshot)]);
  await vi.advanceTimersByTimeAsync(RETRY_MS);
  await begin(fixture);
  await finish(fixture);
  assert.equal(stored(fixture).automaticModelTurns, 4);
  assert.equal(stored(fixture).toolFreeRepeatCount, 2);
  assert.equal(stored(fixture).lastToolFreeOutputFingerprint, fingerprint);
  await vi.advanceTimersByTimeAsync(RETRY_MS);
  await begin(fixture);
  await finish(fixture, response(null));
  assert.equal(stored(fixture).status, "paused");
  assert.equal(stored(fixture).automaticModelTurns, 5);
  assert.equal(stored(fixture).toolFreeRepeatCount, 3);
  assert.equal(stored(fixture).safetyPauseCause, "no_progress");
});

test("completion after a managed quota recovery emits complete without an intermediate usage-limited terminal", async () => {
  const fixture = await initialize();
  const events: RunEvent[] = [];
  fixture.mock.eventBus.on("pi-goal:event:quota-completion", (event) => events.push(event as RunEvent));
  fixture.mock.eventBus.emit("pi-goal:start", { runId: "quota-completion", objective: "complete after quota resets" });
  await vi.advanceTimersByTimeAsync(0);
  await begin(fixture);
  await finish(fixture);
  await vi.advanceTimersByTimeAsync(RETRY_MS);
  await begin(fixture);
  await requireGoalTool(fixture.mock, "goal_complete").execute(
    "complete-after-quota-reset",
    { goal_id: stored(fixture).id, summary: "All objective requirements are complete and verified." },
    new AbortController().signal,
    () => undefined,
    fixture.ctx,
  );
  await Promise.resolve();
  await emit(fixture, "agent_settled");
  await vi.advanceTimersByTimeAsync(RETRY_MS);
  assert.deepEqual(
    events.filter((event) => event.type === "state").map((event) => event.status),
    ["active", "complete"],
  );
  assert.equal(fixture.mock.sentUserMessages.length, 2);
});

test("a cancellation event listener can start a successor without an obsolete recovery callback modifying it", async () => {
  const fixture = await initialize();
  let successor = false;
  fixture.mock.eventBus.on("pi-goal:event:first-quota-run", (payload) => {
    if ((payload as RunEvent).status !== "paused") return;
    successor = true;
    void fixture.mock.commands.get("goal")?.handler("clear", fixture.ctx);
    fixture.mock.eventBus.emit("pi-goal:start", { runId: "successor-quota-run", objective: "successor objective" });
  });
  fixture.mock.eventBus.emit("pi-goal:start", { runId: "first-quota-run", objective: "first objective" });
  await vi.advanceTimersByTimeAsync(0);
  await begin(fixture);
  const usage = pendingUsage(fixture);
  await finish(fixture);
  fixture.mock.eventBus.emit("pi-goal:cancel", { runId: "first-quota-run" });
  await vi.advanceTimersByTimeAsync(0);
  assert.equal(successor, true);
  assert.equal(stored(fixture).text, "successor objective");
  const successorId = stored(fixture).id;
  const messages = fixture.mock.sentUserMessages.length;
  usage.resolve(readyUsage(Date.now() + 30_000));
  await vi.advanceTimersByTimeAsync(RETRY_MS);
  assert.equal(stored(fixture).id, successorId);
  assert.equal(stored(fixture).waiting, undefined);
  assert.equal(fixture.mock.sentUserMessages.length, messages);
});

test("failed reset-hint publication keeps the original fallback deadline and owned timer", async () => {
  const fixture = await start();
  const usage = pendingUsage(fixture);
  await finish(fixture);
  const original = structuredClone(stored(fixture).waiting);
  const hint = Date.now() + RETRY_MS * 2;
  const append = fixture.mock.rawPi.appendEntry.bind(fixture.mock.rawPi);
  let failed = false;
  fixture.mock.rawPi.appendEntry = (...args) => {
    const goal = (args[1] as { goal?: ActiveGoal }).goal;
    if (!failed && goal?.waiting?.resumeAt === hint) {
      failed = true;
      throw new Error("hint publication unavailable");
    }
    append(...args);
  };
  usage.resolve(readyUsage(hint));
  await vi.advanceTimersByTimeAsync(0);
  assert.equal(failed, true);
  assert.deepEqual(stored(fixture).waiting, original);
  await vi.advanceTimersByTimeAsync(RETRY_MS);
  assert.equal(fixture.mock.sentUserMessages.length, 2);
});

test.each(["queued", "running"] as const)("model changes cancel a %s recovery request", async (phase) => {
  const fixture = await start();
  await finish(fixture);
  const id = stored(fixture).id;
  await vi.advanceTimersByTimeAsync(RETRY_MS);
  if (phase === "running") await begin(fixture);
  let aborts = 0;
  fixture.ctx.abort = () => {
    aborts++;
  };
  Object.assign(fixture.ctx, { model: { ...MODEL, id: "replacement-model" } });
  await emit(fixture, "model_select");
  assert.equal(stored(fixture).status, "usage_limited");
  assert.equal(stored(fixture).id, id);
  assert.equal(aborts, phase === "running" ? 1 : 0);
  if (phase === "queued") {
    assert.deepEqual(
      await emit(fixture, "input", {
        source: "extension",
        text: fixture.mock.sentUserMessages.at(-1)?.text,
        streamingBehavior: "followUp",
      }),
      { action: "handled" },
    );
  }
  await vi.advanceTimersByTimeAsync(RETRY_MS);
  assert.equal(fixture.mock.sentUserMessages.length, 2);
});

test.each(["initial", "scheduled", "native"] as const)(
  "model change after %s quota agent_end cannot rebind recovery to the new model",
  async (phase) => {
    const fixture = await start();
    if (phase === "scheduled") {
      await finish(fixture);
      await vi.advanceTimersByTimeAsync(RETRY_MS);
      await begin(fixture);
    }
    await finish(fixture, response(phase === "native" ? "Usage limit reached: HTTP 429" : QUOTA_ERROR), false);
    if (phase === "native") await emit(fixture, "agent_start");
    Object.assign(fixture.ctx, { model: { ...MODEL, id: "new-model-after-error" } });
    await emit(fixture, "model_select");
    assert.equal(stored(fixture).status, "usage_limited");
    await emit(fixture, "agent_settled");
    assert.equal(stored(fixture).status, "usage_limited");
    assert.equal(stored(fixture).waiting, undefined);
  },
);
