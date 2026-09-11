import assert from "node:assert/strict";
import { test, vi } from "vitest";
import { createMockContext, createMockPi } from "../../../test/support.js";
import {
  assistantUsageEntry,
  findPersistedGoal,
  lastGoal,
  lastGoalStatus,
  nonGoalContractSentMessages,
  registerGoal,
  requireGoalTool,
  requireLastGoal,
  STALE_GOAL_TOOL_REASON,
  type StoredGoal,
} from "./support/goal-fixture.js";

test("parent and child stable Goal tool envelopes stay isolated", async () => {
  const root = createMockPi({ activeTools: ["read", "bash"] });
  registerGoal(root.pi);
  const rootContext = createMockContext();
  root.events.get("session_start")?.[0]?.({}, rootContext.ctx);
  await root.commands.get("goal")?.handler("parent objective", rootContext.ctx);
  assert.deepEqual(root.rawPi.getActiveTools(), ["read", "bash", "goal_complete", "goal_blocked", "goal_wait"]);

  const child = createMockPi({
    activeTools: ["read", "bash", "goal_complete", "goal_blocked", "goal_wait"],
  });
  registerGoal(child.pi);
  const childContext = createMockContext();
  child.events.get("session_start")?.[0]?.({}, childContext.ctx);
  assert.deepEqual(child.rawPi.getActiveTools(), ["read", "bash", "goal_complete", "goal_blocked", "goal_wait"]);
  assert.deepEqual(root.rawPi.getActiveTools(), ["read", "bash", "goal_complete", "goal_blocked", "goal_wait"]);

  await child.commands.get("goal")?.handler("child objective", childContext.ctx);
  assert.deepEqual(child.rawPi.getActiveTools(), ["read", "bash", "goal_complete", "goal_blocked", "goal_wait"]);
  await child.commands.get("goal")?.handler("clear", childContext.ctx);
  assert.deepEqual(root.rawPi.getActiveTools(), ["read", "bash", "goal_complete", "goal_blocked", "goal_wait"]);
});

test("child session initialization does not erase or reroute the parent goal", async () => {
  const rootBranch: Record<string, unknown>[] = [];
  const root = createMockPi();
  registerGoal(root.pi);
  const rootContext = createMockContext({
    sessionManager: { getBranch: () => rootBranch, getEntries: () => rootBranch },
  });
  root.events.get("session_start")?.[0]?.({}, rootContext.ctx);
  await root.commands.get("goal")?.handler("parent objective", rootContext.ctx);

  const rootGoal = requireLastGoal(root);
  rootBranch.push({
    type: "custom",
    customType: "goal-state",
    data: { goal: rootGoal },
  });
  const rootCompletion = requireGoalTool(root, "goal_complete");
  const rootEntriesBeforeChild = root.entries.length;

  const child = createMockPi();
  registerGoal(child.pi);
  const childContext = createMockContext({
    sessionManager: { getBranch: () => [], getEntries: () => [] },
  });
  child.events.get("session_start")?.[0]?.({}, childContext.ctx);

  // Empty-child startup must not claim the parent goal or append any snapshot of it.
  assert.equal(lastGoalStatus(child), null);
  assert.equal(child.entries.filter((entry) => entry.customType === "goal-state").length, 0);
  assert.equal(requireLastGoal(root).id, rootGoal.id);
  assert.equal(lastGoalStatus(root), "active");

  const result = await rootCompletion.execute(
    "root-completion",
    { goal_id: rootGoal.id, summary: "Verified parent completion." },
    new AbortController().signal,
    () => undefined,
    rootContext.ctx,
  );

  assert.equal(result.content?.[0]?.text, "Goal complete: Verified parent completion.");
  assert.equal(result.terminate, true);
  assert.equal(result.details?.goal, rootGoal.text);
  assert.equal(result.details?.goal_id, rootGoal.id);

  const rootGoalStates = root.entries
    .slice(rootEntriesBeforeChild)
    .filter((entry) => entry.customType === "goal-state")
    .map((entry) => entry.data as { goal?: StoredGoal | null });
  assert.equal(rootGoalStates.length, 2);
  assert.equal(rootGoalStates[0]?.goal?.status, "complete");
  assert.equal(rootGoalStates[0]?.goal?.id, rootGoal.id);
  assert.equal(rootGoalStates[0]?.goal?.text, rootGoal.text);
  assert.deepEqual(rootGoalStates[1], { goal: null });
  assert.equal(lastGoalStatus(root), null);

  const childGoalStates = child.entries.filter((entry) => entry.customType === "goal-state");
  assert.equal(childGoalStates.length, 0);
  assert.equal(
    childGoalStates.some((entry) => (entry.data as { goal?: StoredGoal | null } | undefined)?.goal?.id === rootGoal.id),
    false,
  );
});

test("independent goal instances keep distinct concurrent active goals", async () => {
  const root = createMockPi();
  registerGoal(root.pi);
  const rootContext = createMockContext();
  root.events.get("session_start")?.[0]?.({}, rootContext.ctx);
  await root.commands.get("goal")?.handler("root objective", rootContext.ctx);

  const child = createMockPi();
  registerGoal(child.pi);
  const childContext = createMockContext();
  child.events.get("session_start")?.[0]?.({}, childContext.ctx);
  await child.commands.get("goal")?.handler("child objective", childContext.ctx);

  const rootGoal = requireLastGoal(root);
  const childGoal = requireLastGoal(child);
  assert.notEqual(rootGoal.id, childGoal.id);
  assert.equal(rootGoal.text, "root objective");
  assert.equal(childGoal.text, "child objective");
  assert.equal(lastGoalStatus(root), "active");
  assert.equal(lastGoalStatus(child), "active");
  assert.match(String(rootContext.statuses.get("goal")), /^active /);
  assert.match(String(childContext.statuses.get("goal")), /^active /);

  root.events.get("session_shutdown")?.[0]?.({}, rootContext.ctx);
  child.events.get("session_shutdown")?.[0]?.({}, childContext.ctx);
});

test("independent goal instances keep completion local", async () => {
  const root = createMockPi();
  registerGoal(root.pi);
  const rootContext = createMockContext();
  root.events.get("session_start")?.[0]?.({}, rootContext.ctx);
  await root.commands.get("goal")?.handler("root objective", rootContext.ctx);

  const child = createMockPi();
  registerGoal(child.pi);
  const childContext = createMockContext();
  child.events.get("session_start")?.[0]?.({}, childContext.ctx);
  await child.commands.get("goal")?.handler("child objective", childContext.ctx);

  const rootGoal = requireLastGoal(root);
  const childGoal = requireLastGoal(child);
  const rootEntriesBefore = root.entries.length;
  const childEntriesBefore = child.entries.length;

  const result = await requireGoalTool(root, "goal_complete").execute(
    "root-completion",
    { goal_id: rootGoal.id, summary: "Root work verified." },
    new AbortController().signal,
    () => undefined,
    rootContext.ctx,
  );

  assert.equal(result.terminate, true);
  assert.equal(result.details?.goal, rootGoal.text);
  assert.equal(result.details?.goal_id, rootGoal.id);

  const rootCompletion = findPersistedGoal(root, "complete");
  assert.ok(rootCompletion);
  assert.equal(rootCompletion.id, rootGoal.id);
  assert.equal(rootCompletion.text, rootGoal.text);
  assert.deepEqual(lastGoal(root), null);
  assert.equal(lastGoalStatus(root), null);

  const rootGoalStates = root.entries
    .slice(rootEntriesBefore)
    .filter((entry) => entry.customType === "goal-state")
    .map((entry) => entry.data as { goal?: StoredGoal | null });
  assert.equal(rootGoalStates.length, 2);
  assert.equal(rootGoalStates[0]?.goal?.status, "complete");
  assert.deepEqual(rootGoalStates[1], { goal: null });

  assert.equal(child.entries.length, childEntriesBefore);
  assert.equal(lastGoalStatus(child), "active");
  assert.equal(requireLastGoal(child).id, childGoal.id);
  assert.equal(requireLastGoal(child).text, childGoal.text);
  root.events.get("session_shutdown")?.[0]?.({}, rootContext.ctx);
  child.events.get("session_shutdown")?.[0]?.({}, childContext.ctx);
});

test("tool lifecycle persistence stays on the owning goal instance", async () => {
  const rootBranch: Record<string, unknown>[] = [assistantUsageEntry({ totalTokens: 1 })];
  const root = createMockPi();
  registerGoal(root.pi);
  const rootContext = createMockContext({
    sessionManager: { getBranch: () => rootBranch, getEntries: () => rootBranch },
  });
  root.events.get("session_start")?.[0]?.({}, rootContext.ctx);
  await root.commands.get("goal")?.handler("root objective", rootContext.ctx);

  const childBranch: Record<string, unknown>[] = [assistantUsageEntry({ totalTokens: 2 })];
  const child = createMockPi();
  registerGoal(child.pi);
  const childContext = createMockContext({
    sessionManager: { getBranch: () => childBranch, getEntries: () => childBranch },
  });
  child.events.get("session_start")?.[0]?.({}, childContext.ctx);
  await child.commands.get("goal")?.handler("child objective", childContext.ctx);

  const rootGoal = requireLastGoal(root);
  const childGoal = requireLastGoal(child);
  const rootEntriesBefore = root.entries.length;
  const childEntriesBefore = child.entries.length;

  root.events.get("tool_execution_end")?.[0]?.({}, rootContext.ctx);
  assert.equal(root.entries.length, rootEntriesBefore + 1);
  assert.equal(child.entries.length, childEntriesBefore);
  const rootUpdated = requireLastGoal(root);
  assert.equal(rootUpdated.id, rootGoal.id);
  assert.equal(rootUpdated.text, "root objective");
  assert.equal(rootUpdated.status, "active");
  assert.equal(requireLastGoal(child).id, childGoal.id);
  assert.equal(requireLastGoal(child).text, "child objective");

  child.events.get("tool_execution_end")?.[0]?.({}, childContext.ctx);
  assert.equal(root.entries.length, rootEntriesBefore + 1);
  assert.equal(child.entries.length, childEntriesBefore + 1);
  const childUpdated = requireLastGoal(child);
  assert.equal(childUpdated.id, childGoal.id);
  assert.equal(childUpdated.text, "child objective");
  assert.equal(childUpdated.status, "active");
  assert.equal(requireLastGoal(root).id, rootGoal.id);
  assert.equal(requireLastGoal(root).text, "root objective");
  root.events.get("session_shutdown")?.[0]?.({}, rootContext.ctx);
  child.events.get("session_shutdown")?.[0]?.({}, childContext.ctx);
});

test("goal_blocked ownership stays on the root instance after child start", async () => {
  const root = createMockPi();
  registerGoal(root.pi);
  const rootContext = createMockContext();
  root.events.get("session_start")?.[0]?.({}, rootContext.ctx);
  await root.commands.get("goal")?.handler("root objective", rootContext.ctx);
  const rootGoal = requireLastGoal(root);
  const rootBlocker = requireGoalTool(root, "goal_blocked");
  const rootEntriesBeforeChild = root.entries.length;

  const child = createMockPi();
  registerGoal(child.pi);
  const childContext = createMockContext();
  child.events.get("session_start")?.[0]?.({}, childContext.ctx);
  assert.equal(lastGoalStatus(child), null);

  const result = await rootBlocker.execute(
    "root-block",
    {
      goal_id: rootGoal.id,
      reason: "Need offline hardware access that remains unavailable",
      evidence: "Attempted recovery three times with the same USB failure",
      repeated_turns: 3,
    },
    new AbortController().signal,
    () => undefined,
    rootContext.ctx,
  );

  assert.equal(result.terminate, true);
  assert.equal(result.details?.goal, rootGoal.text);
  assert.equal(result.details?.goal_id, rootGoal.id);
  assert.match(result.content?.[0]?.text ?? "", /Goal blocked:/i);

  const rootBlocked = findPersistedGoal(root, "blocked");
  assert.ok(rootBlocked);
  assert.equal(rootBlocked.id, rootGoal.id);
  assert.equal(rootBlocked.text, rootGoal.text);
  assert.equal(lastGoalStatus(root), "blocked");
  assert.ok(root.entries.length > rootEntriesBeforeChild);
  assert.equal(child.entries.filter((entry) => entry.customType === "goal-state").length, 0);
  assert.equal(lastGoalStatus(child), null);
  root.events.get("session_shutdown")?.[0]?.({}, rootContext.ctx);
  child.events.get("session_shutdown")?.[0]?.({}, childContext.ctx);
});

test("pending continuation and stopped budget state survive later child startup", async () => {
  const rootBranch: Record<string, unknown>[] = [assistantUsageEntry({ totalTokens: 0 })];
  const root = createMockPi();
  registerGoal(root.pi);
  const rootContext = createMockContext({
    sessionManager: { getBranch: () => rootBranch, getEntries: () => rootBranch },
  });
  root.events.get("session_start")?.[0]?.({}, rootContext.ctx);
  await root.commands.get("goal")?.handler("--tokens 1 root objective", rootContext.ctx);
  const rootGoal = requireLastGoal(root);
  const rootUserMessagesBefore = root.sentUserMessages.length;

  // Record the parent continuation before the child starts. Child session_start must not
  // clear an already-pending continuation or reroute its eventual delivery.
  await root.events.get("agent_end")?.[0]?.({ messages: [{ role: "assistant", stopReason: "stop" }] }, rootContext.ctx);
  const child = createMockPi();
  registerGoal(child.pi);
  const childContext = createMockContext();
  child.events.get("session_start")?.[0]?.({}, childContext.ctx);
  root.events.get("agent_settled")?.[0]?.({}, rootContext.ctx);
  assert.equal(root.sentUserMessages.length, rootUserMessagesBefore + 1);
  const staleContinuation = root.sentUserMessages.at(-1)?.text ?? "";
  assert.match(staleContinuation, new RegExp(`<!-- pi-goal-continuation:${rootGoal.id}:`));
  assert.equal(child.sentUserMessages.length, 0);

  // Exhaust the parent budget before another child starts. No follow-up work is queued,
  // and a historical wrap-up marker remains stale after the child startup.
  rootBranch.push(assistantUsageEntry({ totalTokens: 5 }));
  root.events.get("tool_execution_end")?.[0]?.({}, rootContext.ctx);
  assert.equal(lastGoalStatus(root), "budget_limited");
  assert.equal(nonGoalContractSentMessages(root).length, 0);

  const laterChild = createMockPi();
  registerGoal(laterChild.pi);
  const laterChildContext = createMockContext();
  laterChild.events.get("session_start")?.[0]?.({}, laterChildContext.ctx);
  const contextMessages = [
    { role: "custom", customType: "goal-budget-wrap-up", details: { goalId: rootGoal.id } },
    { role: "user", content: "continue" },
  ];
  assert.deepEqual(root.events.get("context")?.[0]?.({ messages: contextMessages }, rootContext.ctx), {
    messages: [{ role: "user", content: "continue" }],
  });
  assert.equal(child.sentMessages.length, 0);
  assert.equal(laterChild.sentMessages.length, 0);
  assert.equal(lastGoalStatus(child), null);
  assert.equal(lastGoalStatus(laterChild), null);
  assert.deepEqual(root.events.get("input")?.[0]?.({ source: "extension", text: staleContinuation }, rootContext.ctx), {
    action: "handled",
  });
  assert.equal(
    laterChild.events.get("input")?.[0]?.({ source: "extension", text: staleContinuation }, laterChildContext.ctx),
    undefined,
  );

  root.events.get("session_shutdown")?.[0]?.({}, rootContext.ctx);
  child.events.get("session_shutdown")?.[0]?.({}, childContext.ctx);
  laterChild.events.get("session_shutdown")?.[0]?.({}, laterChildContext.ctx);
});

test("stale tool guard survives later child startup", async () => {
  const root = createMockPi();
  registerGoal(root.pi);
  const rootContext = createMockContext();
  root.events.get("session_start")?.[0]?.({}, rootContext.ctx);
  await root.commands.get("goal")?.handler("root objective", rootContext.ctx);
  await root.commands.get("goal")?.handler("pause", rootContext.ctx);

  const child = createMockPi();
  registerGoal(child.pi);
  const childContext = createMockContext();
  child.events.get("session_start")?.[0]?.({}, childContext.ctx);
  const rootToolCall = root.events.get("tool_call")?.[0];
  assert.deepEqual(rootToolCall?.({ toolName: "bash", toolCallId: "root-stale", input: {} }, rootContext.ctx), {
    block: true,
    reason: STALE_GOAL_TOOL_REASON,
  });
  assert.equal(
    child.events.get("tool_call")?.[0]?.({ toolName: "bash", toolCallId: "child-fresh", input: {} }, childContext.ctx),
    undefined,
  );

  child.events.get("session_shutdown")?.[0]?.({}, childContext.ctx);
  assert.deepEqual(
    rootToolCall?.({ toolName: "bash", toolCallId: "root-stale-after-shutdown", input: {} }, rootContext.ctx),
    { block: true, reason: STALE_GOAL_TOOL_REASON },
  );
  assert.equal(lastGoalStatus(root), "paused");
  assert.equal(lastGoalStatus(child), null);
  root.events.get("session_shutdown")?.[0]?.({}, rootContext.ctx);
});

test("pending compaction recovery survives later child startup", async () => {
  const root = createMockPi();
  registerGoal(root.pi);
  const rootContext = createMockContext();
  root.events.get("session_start")?.[0]?.({}, rootContext.ctx);
  await root.commands.get("goal")?.handler("root objective", rootContext.ctx);
  requireLastGoal(root);
  const rootUserMessagesBefore = root.sentUserMessages.length;

  await root.events.get("agent_end")?.[0]?.(
    {
      messages: [
        {
          role: "assistant",
          stopReason: "error",
          errorMessage: "prompt is too long: 213462 tokens > 200000 maximum",
        },
      ],
    },
    rootContext.ctx,
  );

  const child = createMockPi();
  registerGoal(child.pi);
  const childContext = createMockContext();
  child.events.get("session_start")?.[0]?.({}, childContext.ctx);
  root.events.get("session_before_compact")?.[0]?.({}, rootContext.ctx);
  await root.events.get("session_compact")?.[0]?.({}, rootContext.ctx);
  root.events.get("agent_start")?.[0]?.({}, rootContext.ctx);
  await root.events.get("agent_end")?.[0]?.(
    { messages: [{ role: "assistant", stopReason: "stop", content: [] }] },
    rootContext.ctx,
  );
  await root.events.get("agent_settled")?.[0]?.({}, rootContext.ctx);
  assert.equal(root.sentUserMessages.length, rootUserMessagesBefore + 1);
  assert.equal(child.sentUserMessages.length, 0);
  assert.equal(lastGoalStatus(root), "active");
  assert.equal(lastGoalStatus(child), null);

  root.events.get("session_shutdown")?.[0]?.({}, rootContext.ctx);
  child.events.get("session_shutdown")?.[0]?.({}, childContext.ctx);
});

test("completion status timer survives later child startup", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout"] });
  const root = createMockPi();
  registerGoal(root.pi);
  const rootContext = createMockContext();
  root.events.get("session_start")?.[0]?.({}, rootContext.ctx);
  await root.commands.get("goal")?.handler("root objective", rootContext.ctx);
  const rootGoal = requireLastGoal(root);
  await requireGoalTool(root, "goal_complete").execute(
    "root-completion",
    { goal_id: rootGoal.id, summary: "Root work verified." },
    new AbortController().signal,
    () => undefined,
    rootContext.ctx,
  );
  assert.equal(rootContext.statuses.get("goal"), "complete");

  const child = createMockPi();
  registerGoal(child.pi);
  const childContext = createMockContext();
  child.events.get("session_start")?.[0]?.({}, childContext.ctx);
  vi.advanceTimersByTime(8_000);
  assert.equal(rootContext.statuses.get("goal"), undefined);
  assert.equal(childContext.statuses.get("goal"), undefined);

  root.events.get("session_shutdown")?.[0]?.({}, rootContext.ctx);
  child.events.get("session_shutdown")?.[0]?.({}, childContext.ctx);
});

test("child shutdown does not clear the parent goal", async () => {
  const root = createMockPi();
  registerGoal(root.pi);
  const rootContext = createMockContext();
  root.events.get("session_start")?.[0]?.({}, rootContext.ctx);
  await root.commands.get("goal")?.handler("root objective", rootContext.ctx);
  const rootGoal = requireLastGoal(root);
  const rootEntriesBeforeChild = root.entries.length;

  const child = createMockPi();
  registerGoal(child.pi);
  const childContext = createMockContext();
  child.events.get("session_start")?.[0]?.({}, childContext.ctx);
  child.events.get("session_shutdown")?.[0]?.({}, childContext.ctx);

  assert.equal(requireLastGoal(root).id, rootGoal.id);
  assert.equal(lastGoalStatus(root), "active");
  assert.equal(lastGoalStatus(child), null);
  assert.equal(child.entries.filter((entry) => entry.customType === "goal-state").length, 0);

  const result = await requireGoalTool(root, "goal_complete").execute(
    "root-completion-after-child-shutdown",
    { goal_id: rootGoal.id, summary: "Root work verified after child shutdown." },
    new AbortController().signal,
    () => undefined,
    rootContext.ctx,
  );

  assert.equal(result.terminate, true);
  assert.equal(result.details?.goal, rootGoal.text);
  assert.equal(result.details?.goal_id, rootGoal.id);

  const rootGoalStates = root.entries
    .slice(rootEntriesBeforeChild)
    .filter((entry) => entry.customType === "goal-state")
    .map((entry) => entry.data as { goal?: StoredGoal | null });
  assert.equal(rootGoalStates.length, 2);
  assert.equal(rootGoalStates[0]?.goal?.status, "complete");
  assert.equal(rootGoalStates[0]?.goal?.id, rootGoal.id);
  assert.deepEqual(rootGoalStates[1], { goal: null });
  assert.equal(lastGoalStatus(root), null);
  assert.equal(child.entries.length, 0);
  root.events.get("session_shutdown")?.[0]?.({}, rootContext.ctx);
});
