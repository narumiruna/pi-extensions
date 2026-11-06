import assert from "node:assert/strict";
import { afterEach, test } from "vitest";
import {
  assistantUsageEntry,
  LOW_LIMITS_SETTINGS_PATH,
  lastGoalStatus,
  ONE_TURN_LIMIT_SETTINGS_PATH,
  requireGoalTool,
  requireLastGoal,
  STALE_GOAL_TOOL_REASON,
  startGoalForTest,
} from "./support/goal-fixture.js";

type Fixture = Awaited<ReturnType<typeof startGoalForTest>>;
const fixtures: Fixture[] = [];

async function start(...args: Parameters<typeof startGoalForTest>) {
  const fixture = await startGoalForTest(...args);
  fixtures.push(fixture);
  return fixture;
}

afterEach(async () => {
  for (const fixture of fixtures.splice(0)) {
    await fixture.mock.events.get("session_shutdown")?.[0]?.({}, fixture.ctx);
  }
});

async function end(fixture: Fixture, message: Record<string, unknown>) {
  fixture.mock.events.get("turn_end")?.[0]?.({ message, toolResults: [] }, fixture.ctx);
  await fixture.mock.events.get("agent_end")?.[0]?.({ messages: [message] }, fixture.ctx);
}

async function settle(fixture: Fixture, aborted = false) {
  await fixture.mock.events.get("agent_settled")?.[0]?.({ aborted }, fixture.ctx);
}

async function beginAutomaticRun(fixture: Fixture) {
  await end(fixture, { role: "assistant", stopReason: "stop", content: [] });
  await settle(fixture);
  const prompt = fixture.mock.sentUserMessages.at(-1)?.text ?? "";
  assert.match(prompt, /pi-goal-continuation:/);
  fixture.mock.events.get("before_agent_start")?.[0]?.({ prompt, systemPrompt: "base" }, fixture.ctx);
}

test.each([
  ["Usage limit reached: HTTP 429", "usage_limited"],
  ["Quota exhausted: ResourceExhausted", "usage_limited"],
  ["Credit balance depleted: server error 503", "usage_limited"],
  ["Payment required: please retry your request", "usage_limited"],
  ["Unauthorized: network error", "active"],
  ["Multi-auth rotation failed: upstream connect", "active"],
])("native recovery is not vetoed by final-status policy: %s", async (errorMessage, status) => {
  let aborts = 0;
  const fixture = await start({ abort: () => aborts++ });
  const id = requireLastGoal(fixture.mock).id;
  await end(fixture, { role: "assistant", stopReason: "error", errorMessage });
  assert.equal(lastGoalStatus(fixture.mock), "active");
  assert.equal(requireLastGoal(fixture.mock).waiting, undefined);
  assert.equal(aborts, 0);
  assert.equal(fixture.mock.sentUserMessages.length, 1);

  await settle(fixture);
  const goal = requireLastGoal(fixture.mock);
  assert.equal(goal.id, id);
  assert.equal(goal.status, status);
  assert.equal(Boolean(goal.waiting), status === "active");
  assert.equal(goal.waiting?.resumeAt, undefined);
  assert.equal(fixture.mock.sentUserMessages.length, 1);
  const notifications = fixture.notifications.length;
  await settle(fixture);
  assert.equal(fixture.notifications.length, notifications, "finalize recovery exactly once");
});

test.each(["Usage limit reached: HTTP 429", "Unauthorized: network error"])(
  "native recovery success retains automatic ownership: %s",
  async (errorMessage) => {
    const fixture = await start({}, "finish", LOW_LIMITS_SETTINGS_PATH);
    const id = requireLastGoal(fixture.mock).id;
    await beginAutomaticRun(fixture);
    await end(fixture, { role: "assistant", stopReason: "error", errorMessage });
    fixture.mock.events.get("agent_start")?.[0]?.({}, fixture.ctx);
    await end(fixture, { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "Recovered" }] });
    assert.equal(fixture.mock.sentUserMessages.length, 2, "do not dispatch before native settlement");
    assert.equal(requireLastGoal(fixture.mock).automaticModelTurns, 2);
    await settle(fixture);
    assert.equal(requireLastGoal(fixture.mock).id, id);
    assert.equal(requireLastGoal(fixture.mock).waiting, undefined);
    assert.equal(fixture.mock.sentUserMessages.length, 3);
    await settle(fixture);
    assert.equal(fixture.mock.sentUserMessages.length, 3);
  },
);

test.each(["HTTP 503: temporary failure", "Usage limit reached: HTTP 429", "prompt too long"])(
  "cancellation at native settlement pauses instead of reporting the last error: %s",
  async (errorMessage) => {
    const fixture = await start();
    const id = requireLastGoal(fixture.mock).id;
    await end(fixture, { role: "assistant", stopReason: "error", errorMessage });
    await settle(fixture, true);
    assert.equal(lastGoalStatus(fixture.mock), "paused");
    assert.equal(requireLastGoal(fixture.mock).id, id);
    assert.equal(requireLastGoal(fixture.mock).waiting, undefined);
    assert.match(fixture.notifications.at(-1)?.message ?? "", /paused.*interruption/i);
    assert.doesNotMatch(fixture.notifications.at(-1)?.message ?? "", /temporary failure|usage limit|prompt too long/i);
    assert.equal(fixture.mock.sentUserMessages.length, 1);
    assert.deepEqual(
      fixture.mock.events.get("tool_call")?.[0]?.(
        { toolName: "bash", toolCallId: "cancelled", input: {} },
        fixture.ctx,
      ),
      { block: true, reason: STALE_GOAL_TOOL_REASON },
    );
    const count = fixture.notifications.length;
    await settle(fixture, true);
    assert.equal(fixture.notifications.length, count);
  },
);

test.each(["stop", "length", "toolUse"] as const)(
  "cancellation after an eligible %s run pauses before native post-run work",
  async (stopReason) => {
    const fixture = await start();
    await end(fixture, { role: "assistant", stopReason, content: [] });
    await settle(fixture, true);
    assert.equal(lastGoalStatus(fixture.mock), "paused");
    assert.equal(requireLastGoal(fixture.mock).waiting, undefined);
    assert.equal(fixture.mock.sentUserMessages.length, 1);
  },
);

test("cancellation after an explicit wait pauses the same Goal without dispatch", async () => {
  const fixture = await start();
  await requireGoalTool(fixture.mock, "goal_wait").execute(
    "wait-before-cancellation",
    { goal_id: requireLastGoal(fixture.mock).id, reason: "Waiting for a deployment" },
    undefined,
    undefined,
    fixture.ctx,
  );
  await end(fixture, { role: "assistant", stopReason: "stop", content: [] });
  await settle(fixture, true);
  assert.equal(lastGoalStatus(fixture.mock), "paused");
  assert.equal(fixture.mock.sentUserMessages.length, 1);
});

test("final usage-limit notifications sanitize and bound untrusted provider text", async () => {
  const fixture = await start();
  const errorMessage = `Usage limit reached: HTTP 429 \u001b]52;c;clipboard\u0007 ${"x".repeat(500)}`;
  await end(fixture, { role: "assistant", stopReason: "error", errorMessage });
  await settle(fixture);
  assert.equal(lastGoalStatus(fixture.mock), "usage_limited");
  const notification = fixture.notifications.at(-1)?.message ?? "";
  assert.match(notification, /provider usage limit/i);
  assert.ok(notification.length < 300);
  assert.doesNotMatch(notification, /clipboard/u);
  for (const character of notification) {
    const codePoint = character.codePointAt(0) ?? 0;
    assert.ok(codePoint > 0x1f && (codePoint < 0x7f || codePoint > 0x9f));
  }
});

test.each(
  ["pause", "replacement", "session replacement", "shutdown"].flatMap((transition) =>
    (["error", "length"] as const).map((stopReason) => [transition, stopReason] as const),
  ),
)("%s invalidates pending native %s recovery before late settlement", async (transition, stopReason) => {
  const fixture = await start();
  await end(fixture, {
    role: "assistant",
    stopReason,
    errorMessage: stopReason === "error" ? "Usage limit reached: HTTP 429" : undefined,
  });
  if (transition === "session replacement") {
    await fixture.mock.events.get("session_start")?.[0]?.({}, fixture.ctx);
    await fixture.mock.commands.get("goal")?.handler("replacement session objective", fixture.ctx);
  } else if (transition === "shutdown") {
    await fixture.mock.events.get("session_shutdown")?.[0]?.({}, fixture.ctx);
  } else {
    await fixture.mock.commands
      .get("goal")
      ?.handler(transition === "pause" ? "pause" : "replacement objective", fixture.ctx);
  }
  const expected = requireLastGoal(fixture.mock);
  const entries = fixture.mock.entries.length;
  const messages = fixture.mock.sentUserMessages.length;
  const context =
    transition === "shutdown"
      ? new Proxy(
          {},
          {
            get() {
              throw new Error("stale context must not be read");
            },
          },
        )
      : fixture.ctx;
  await fixture.mock.events.get("session_compact_failed")?.[0]?.(
    { reason: "overflow", willRetry: false, aborted: false },
    context,
  );
  await fixture.mock.events.get("agent_settled")?.[0]?.({ aborted: true }, context);
  assert.deepEqual(requireLastGoal(fixture.mock), expected);
  assert.equal(fixture.mock.entries.length, entries);
  assert.equal(fixture.mock.sentUserMessages.length, messages);
});

test.each(["success", "failure", "cancelled"])(
  "native length compaction retains run ownership through %s",
  async (outcome) => {
    const fixture = await start({}, "finish", LOW_LIMITS_SETTINGS_PATH);
    await beginAutomaticRun(fixture);
    await end(fixture, { role: "assistant", stopReason: "length", content: [{ type: "text", text: "Truncated" }] });
    assert.equal(requireLastGoal(fixture.mock).automaticModelTurns, 1);
    fixture.mock.events.get("session_before_compact")?.[0]?.({ reason: "overflow", willRetry: true }, fixture.ctx);
    if (outcome === "success") {
      await fixture.mock.events.get("session_compact")?.[0]?.({ reason: "overflow", willRetry: true }, fixture.ctx);
      assert.equal(fixture.mock.sentUserMessages.length, 2);
      fixture.mock.events.get("agent_start")?.[0]?.({}, fixture.ctx);
      await end(fixture, { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "Recovered" }] });
      assert.equal(requireLastGoal(fixture.mock).automaticModelTurns, 2);
    } else {
      await fixture.mock.events.get("session_compact_failed")?.[0]?.(
        { reason: "overflow", willRetry: true, aborted: outcome === "cancelled", errorMessage: "summary failed" },
        fixture.ctx,
      );
    }
    await settle(fixture);
    assert.equal(
      lastGoalStatus(fixture.mock),
      outcome === "success" ? "active" : outcome === "failure" ? "blocked" : "paused",
    );
    assert.equal(requireLastGoal(fixture.mock).waiting, undefined);
    assert.equal(fixture.mock.sentUserMessages.length, outcome === "success" ? 3 : 2);
  },
);

test.each(["interactive steer", "extension input", "custom follow-up", "interactive follow-up"])(
  "%s supersedes pending length ownership before native compaction",
  async (boundary) => {
    const fixture = await start({}, "finish", LOW_LIMITS_SETTINGS_PATH);
    await beginAutomaticRun(fixture);
    await end(fixture, { role: "assistant", stopReason: "length", content: [] });
    if (boundary === "custom follow-up") {
      fixture.mock.events.get("message_start")?.[0]?.(
        { message: { role: "custom", customType: "external", content: "Manual work" } },
        fixture.ctx,
      );
    } else {
      const followUp = boundary === "interactive follow-up";
      fixture.mock.events.get("input")?.[0]?.(
        {
          source: boundary === "extension input" ? "extension" : "interactive",
          text: "Manual work",
          streamingBehavior: followUp ? "followUp" : "steer",
        },
        fixture.ctx,
      );
      if (followUp) {
        fixture.mock.events.get("message_start")?.[0]?.(
          { message: { role: "user", content: "Manual work" } },
          fixture.ctx,
        );
      }
    }
    const beforeRetry = requireLastGoal(fixture.mock).automaticModelTurns;
    fixture.mock.events.get("session_before_compact")?.[0]?.({ reason: "overflow", willRetry: true }, fixture.ctx);
    await fixture.mock.events.get("session_compact")?.[0]?.({ reason: "overflow", willRetry: true }, fixture.ctx);
    fixture.mock.events.get("agent_start")?.[0]?.({}, fixture.ctx);
    await end(fixture, {
      role: "assistant",
      stopReason: "stop",
      content: [{ type: "text", text: "Manually steered result" }],
    });
    assert.equal(
      requireLastGoal(fixture.mock).automaticModelTurns,
      beforeRetry,
      "new manual work must not inherit old automatic recovery",
    );
  },
);

test("a queued interactive follow-up retains length ownership until it starts", async () => {
  const fixture = await start({}, "finish", LOW_LIMITS_SETTINGS_PATH);
  await beginAutomaticRun(fixture);
  await end(fixture, { role: "assistant", stopReason: "length", content: [] });
  fixture.mock.events.get("input")?.[0]?.(
    { source: "interactive", text: "Manual follow-up", streamingBehavior: "followUp" },
    fixture.ctx,
  );
  fixture.mock.events.get("session_before_compact")?.[0]?.({ reason: "overflow", willRetry: true }, fixture.ctx);
  await fixture.mock.events.get("session_compact")?.[0]?.({ reason: "overflow", willRetry: true }, fixture.ctx);
  fixture.mock.events.get("agent_start")?.[0]?.({}, fixture.ctx);
  fixture.mock.events.get("turn_end")?.[0]?.(
    { message: { role: "assistant", stopReason: "stop", content: [] }, toolResults: [] },
    fixture.ctx,
  );
  assert.equal(requireLastGoal(fixture.mock).automaticModelTurns, 2);
  fixture.mock.events.get("message_start")?.[0]?.(
    { message: { role: "user", content: "Manual follow-up" } },
    fixture.ctx,
  );
  await end(fixture, { role: "assistant", stopReason: "stop", content: [] });
  assert.equal(requireLastGoal(fixture.mock).automaticModelTurns, 0);
});

test.each(["goal_wait", "goal_blocked"] as const)(
  "explicit %s supersedes pending length recovery",
  async (toolName) => {
    const fixture = await start();
    await end(fixture, { role: "assistant", stopReason: "length", content: [] });
    const id = requireLastGoal(fixture.mock).id;
    await requireGoalTool(fixture.mock, toolName).execute(
      "explicit-stop",
      {
        goal_id: id,
        reason: "Waiting for external access",
        evidence: "Access was denied on three consecutive attempts.",
        repeated_turns: 3,
      },
      undefined,
      undefined,
      fixture.ctx,
    );
    fixture.mock.events.get("session_before_compact")?.[0]?.({ reason: "overflow", willRetry: true }, fixture.ctx);
    await fixture.mock.events.get("session_compact_failed")?.[0]?.(
      { reason: "overflow", willRetry: false, aborted: false },
      fixture.ctx,
    );
    await settle(fixture);
    assert.equal(lastGoalStatus(fixture.mock), toolName === "goal_wait" ? "active" : "blocked");
    assert.equal(
      requireLastGoal(fixture.mock).waiting?.reason,
      toolName === "goal_wait" ? "Waiting for external access" : undefined,
    );
    assert.equal(fixture.mock.sentUserMessages.length, 1);
  },
);

test.each(["threshold", "overflow"] as const)(
  "native %s compaction cancellation pauses its ended Goal even without an aborted settlement",
  async (reason) => {
    const fixture = await start();
    await end(fixture, {
      role: "assistant",
      stopReason: reason === "overflow" ? "error" : "stop",
      errorMessage: reason === "overflow" ? "prompt too long" : undefined,
      content: [],
    });
    fixture.mock.events.get("session_before_compact")?.[0]?.({ reason, willRetry: reason === "overflow" }, fixture.ctx);
    await fixture.mock.events.get("session_compact_failed")?.[0]?.(
      { reason, willRetry: false, aborted: true },
      fixture.ctx,
    );
    await settle(fixture);
    assert.equal(lastGoalStatus(fixture.mock), "paused");
    assert.equal(fixture.mock.sentUserMessages.length, 1);
  },
);

test("independent manual compaction cancellation does not pause an idle Goal", async () => {
  const fixture = await start();
  await fixture.mock.events.get("session_compact_failed")?.[0]?.(
    { reason: "manual", willRetry: false, aborted: true },
    fixture.ctx,
  );
  await settle(fixture);
  assert.equal(lastGoalStatus(fixture.mock), "active");
  assert.equal(fixture.mock.sentUserMessages.length, 1);
});

test("a repeated native length failure blocks without another before_compact event", async () => {
  const fixture = await start();
  await end(fixture, { role: "assistant", stopReason: "length", content: [] });
  await fixture.mock.events.get("session_compact_failed")?.[0]?.(
    {
      reason: "overflow",
      willRetry: false,
      aborted: false,
      errorMessage: "Truncated response recovery failed after one compact-and-retry attempt.",
    },
    fixture.ctx,
  );
  await settle(fixture);
  assert.equal(lastGoalStatus(fixture.mock), "blocked");
  assert.equal(fixture.mock.sentUserMessages.length, 1);
});

test.each([false, undefined])(
  "length without a native compaction retry keeps ordinary continuation: willRetry=%s",
  async (willRetry) => {
    const fixture = await start();
    await end(fixture, { role: "assistant", stopReason: "length", content: [] });
    if (willRetry !== undefined) {
      fixture.mock.events.get("session_before_compact")?.[0]?.({ reason: "threshold", willRetry }, fixture.ctx);
      await fixture.mock.events.get("session_compact")?.[0]?.({ reason: "threshold", willRetry }, fixture.ctx);
    }
    await settle(fixture);
    assert.equal(lastGoalStatus(fixture.mock), "active");
    assert.equal(fixture.mock.sentUserMessages.length, 2);
  },
);

test("native retry eligibility still obeys the automatic response cap", async () => {
  const fixture = await start({}, "finish", ONE_TURN_LIMIT_SETTINGS_PATH);
  await beginAutomaticRun(fixture);
  await end(fixture, { role: "assistant", stopReason: "error", errorMessage: "Usage limit reached: HTTP 429" });
  await settle(fixture);
  assert.equal(lastGoalStatus(fixture.mock), "paused");
  assert.equal(requireLastGoal(fixture.mock).safetyPauseCause, "continuation_limit");
  assert.equal(fixture.mock.sentUserMessages.length, 2);
});

test("native retry eligibility still obeys the token budget", async () => {
  const branch: unknown[] = [];
  const fixture = await start(
    { sessionManager: { getBranch: () => branch, getEntries: () => branch } },
    "--tokens 10 finish",
  );
  branch.push(assistantUsageEntry({ totalTokens: 12 }));
  await end(fixture, { role: "assistant", stopReason: "error", errorMessage: "Quota exhausted: ResourceExhausted" });
  await settle(fixture);
  assert.equal(lastGoalStatus(fixture.mock), "budget_limited");
  assert.equal(fixture.mock.sentUserMessages.length, 1);
});
