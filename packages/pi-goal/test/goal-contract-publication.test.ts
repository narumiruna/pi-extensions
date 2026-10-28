import assert from "node:assert/strict";
import { test } from "vitest";
import { createMockContext, createMockPi } from "../../../test/support.js";
import { createGoalContextContract } from "../src/goal-contract.js";
import { createGoal, GoalRuntime } from "../src/runtime.js";
import { DEFAULT_SETTINGS_PATH, registerGoalWithSettingsPath } from "./support/goal-fixture.js";

function harness() {
  const branch: unknown[] = [];
  let visible: unknown[] = [];
  const sessionManager = {
    getBranch: () => branch,
    buildSessionContext: () => ({ messages: visible }),
  };
  const mock = createMockPi();
  const runtime = new GoalRuntime(mock.pi);
  runtime.bindWorkflowSession(sessionManager);
  const context = createMockContext({ isIdle: () => false, sessionManager });
  const goal = createGoal("retain the complete objective", undefined, 0);
  return {
    mock,
    runtime,
    ctx: context.ctx,
    goal,
    branch,
    setVisible: (messages: unknown[]) => {
      visible = messages;
    },
  };
}

function publication(mock: ReturnType<typeof createMockPi>, index = -1) {
  const message = mock.sentMessages.at(index)?.message as Record<string, unknown> | undefined;
  assert.ok(message);
  return { type: "custom_message", ...message };
}

test("a busy kickoff and its delayed startup boundary publish one contract", async () => {
  const mock = createMockPi();
  registerGoalWithSettingsPath(mock.pi, DEFAULT_SETTINGS_PATH);
  const context = createMockContext({ isIdle: () => false });
  await mock.events.get("session_start")?.[0]?.({ reason: "startup" }, context.ctx);
  await mock.commands.get("goal")?.handler("write the report end to end", context.ctx);
  assert.equal(mock.sentMessages.length, 1);

  const result = await mock.events.get("before_agent_start")?.[0]?.(
    { prompt: "ordinary run held by an earlier startup handler", systemPrompt: "stable" },
    context.ctx,
  );
  assert.equal(result, undefined, "the already queued contract must replace a second boundary copy");
  assert.equal(mock.sentMessages.length, 1);
});

test("repeated publication waits for the same queued contract", () => {
  const { runtime, mock, ctx, goal } = harness();
  runtime.ensureGoalContextContract(ctx, goal);
  runtime.ensureGoalContextContract(ctx, goal);
  assert.equal(runtime.goalContextContractForPrompt(ctx, goal), undefined);
  assert.equal(mock.sentMessages.length, 1);
});

test("synchronous reentry cannot publish the same contract twice", () => {
  const { runtime, mock, ctx, goal } = harness();
  const send = mock.rawPi.sendMessage;
  mock.rawPi.sendMessage = (message, options) => {
    runtime.ensureGoalContextContract(ctx, goal);
    send(message, options);
  };
  runtime.ensureGoalContextContract(ctx, goal);
  assert.equal(mock.sentMessages.length, 1);
});

test("queued active and inactive revisions preserve their order without duplicate copies", () => {
  const { runtime, mock, ctx, goal } = harness();
  runtime.ensureGoalContextContract(ctx, goal);
  runtime.ensureInactiveGoalContextContract(ctx);
  runtime.ensureInactiveGoalContextContract(ctx);
  runtime.ensureGoalContextContract(ctx, goal);
  runtime.ensureGoalContextContract(ctx, goal);
  assert.equal(mock.sentMessages.length, 3);
  assert.deepEqual(
    mock.sentMessages.map(({ message }) => (message as { details: { state: string } }).details.state),
    ["active", "inactive", "active"],
  );
});

test("an older saved copy cannot acknowledge a newer pending copy with the same content", () => {
  const { runtime, mock, ctx, goal, branch } = harness();
  runtime.ensureGoalContextContract(ctx, goal);
  const earlier = publication(mock);
  runtime.ensureInactiveGoalContextContract(ctx);
  runtime.ensureGoalContextContract(ctx, goal);
  branch.push(earlier);
  runtime.ensureGoalContextContract(ctx, goal);
  assert.equal(mock.sentMessages.length, 3);
});

test("a queued inactive revision overrides an older saved active contract", () => {
  const { runtime, mock, ctx, goal, branch, setVisible } = harness();
  const saved = { type: "custom_message", ...createGoalContextContract(goal) };
  branch.push(saved);
  setVisible([saved]);
  runtime.ensureInactiveGoalContextContract(ctx);
  runtime.ensureGoalContextContract(ctx, goal);
  assert.equal(mock.sentMessages.length, 2, "the saved active copy must not hide the later queued inactive copy");
});

for (const observeBeforeCompaction of [false, true]) {
  test(`saved publication does not suppress restoration after compaction, observed=${observeBeforeCompaction}`, () => {
    const { runtime, mock, ctx, goal, branch, setVisible } = harness();
    runtime.ensureGoalContextContract(ctx, goal);
    const saved = publication(mock);
    branch.push(saved);
    if (observeBeforeCompaction) {
      setVisible([saved]);
      assert.equal(runtime.goalContextContractForPrompt(ctx, goal), undefined);
    }
    setVisible([]);
    runtime.ensureGoalContextContract(ctx, goal);
    assert.equal(mock.sentMessages.length, 2);
  });
}

test("a failed publication can be retried", () => {
  const { runtime, mock, ctx, goal } = harness();
  const send = mock.rawPi.sendMessage;
  mock.rawPi.sendMessage = () => {
    throw new Error("publication failed");
  };
  assert.throws(() => runtime.ensureGoalContextContract(ctx, goal), /publication failed/);
  mock.rawPi.sendMessage = send;
  runtime.ensureGoalContextContract(ctx, goal);
  assert.equal(mock.sentMessages.length, 1);
});

test("a failed newer revision preserves the earlier pending publication", () => {
  const { runtime, mock, ctx, goal } = harness();
  runtime.ensureGoalContextContract(ctx, goal);
  mock.rawPi.sendMessage = () => {
    throw new Error("publication failed");
  };
  assert.throws(() => runtime.ensureInactiveGoalContextContract(ctx), /publication failed/);
  assert.equal(runtime.goalContextContractForPrompt(ctx, goal), undefined);
});

test("failure recovery does not replace a reentrant newer publication", () => {
  const { runtime, mock, ctx, goal } = harness();
  const send = mock.rawPi.sendMessage;
  let outer = true;
  mock.rawPi.sendMessage = (message, options) => {
    if (!outer) return send(message, options);
    outer = false;
    runtime.ensureInactiveGoalContextContract(ctx);
    throw new Error("outer publication failed");
  };
  assert.throws(() => runtime.ensureGoalContextContract(ctx, goal), /outer publication failed/);
  assert.equal(runtime.goalContextContractForPrompt(ctx), undefined);
  assert.equal(mock.sentMessages.length, 1);
});

test("a failed send cannot restore a reservation from a replaced session", () => {
  const { runtime, mock, ctx, goal } = harness();
  runtime.ensureGoalContextContract(ctx, goal);
  const send = mock.rawPi.sendMessage;
  mock.rawPi.sendMessage = () => {
    runtime.bindWorkflowSession({});
    throw new Error("session replaced");
  };
  assert.throws(() => runtime.ensureInactiveGoalContextContract(ctx), /session replaced/);
  mock.rawPi.sendMessage = send;
  runtime.ensureGoalContextContract(ctx, goal);
  assert.equal(mock.sentMessages.length, 2);
});

test("session replacement clears pending publication even when the Goal identity is reused", () => {
  const { runtime, mock, ctx, goal } = harness();
  runtime.ensureGoalContextContract(ctx, goal);
  runtime.bindWorkflowSession({});
  runtime.ensureGoalContextContract(ctx, goal);
  assert.equal(mock.sentMessages.length, 2);
});

test("session shutdown releases pending publication", () => {
  const { runtime, mock, ctx, goal } = harness();
  const session = {};
  runtime.bindWorkflowSession(session);
  runtime.ensureGoalContextContract(ctx, goal);
  runtime.unbindWorkflowSession(session);
  runtime.ensureGoalContextContract(ctx, goal);
  assert.equal(mock.sentMessages.length, 2);
});
