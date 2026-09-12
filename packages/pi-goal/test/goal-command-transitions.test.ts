import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { test } from "vitest";
import { createMockContext, createMockPi } from "../../../test/support.js";
import {
  assistantUsageEntry,
  LOW_LIMITS_SETTINGS_PATH,
  lastGoalStatus,
  pickSafetyState,
  registerGoal,
  registerGoalWithSettingsPath,
  requireLastGoal,
  restoreGoalForTest,
  restoreStoredGoalForTest,
  STALE_GOAL_TOOL_REASON,
  type StoredGoal,
  settingsPath,
  startGoalForTest,
} from "./support/goal-fixture.js";

test("legacy queue commands warn affected users without replacing the goal", async () => {
  const legacySettingsPath = settingsPath("legacy-experimental-goals.json");
  writeFileSync(legacySettingsPath, '{"experimental":{"goals":true}}\n');
  const active = await startGoalForTest({}, "current objective", legacySettingsPath);
  const before = requireLastGoal(active.mock);

  await active.mock.commands.get("goal")?.handler("prioritize urgent objective", active.ctx);

  assert.equal(requireLastGoal(active.mock).id, before.id);
  assert.equal(requireLastGoal(active.mock).text, "current objective");
  assert.equal(active.mock.sentUserMessages.length, 1);
  assert.match(active.notifications.at(-1)?.message ?? "", /ordered goal queue has been removed/i);
  assert.match(active.notifications.at(-1)?.message ?? "", /\/goal edit/i);
});

test("legacy persisted queue state is inert and shows migration guidance", () => {
  const mock = createMockPi();
  registerGoal(mock.pi);
  const legacyGoal = {
    id: "legacy-head",
    text: "legacy head",
    status: "active",
    startedAt: 1,
    updatedAt: 1,
    iteration: 0,
    tokensUsed: 0,
    timeUsedSeconds: 0,
    baselineTokens: 0,
    automaticModelTurns: 0,
    toolFreeRepeatCount: 0,
  };
  const context = createMockContext({
    sessionManager: {
      getBranch: () => [
        {
          type: "custom",
          customType: "goal-state",
          data: { goal: legacyGoal, queue: [{ ...legacyGoal, id: "legacy-tail" }] },
        },
      ],
    },
  });

  mock.events.get("session_start")?.[0]?.({}, context.ctx);

  assert.equal(mock.sentUserMessages.length, 0);
  assert.equal(context.statuses.get("goal"), undefined);
  assert.match(context.notifications.at(-1)?.message ?? "", /ordered goal queue has been removed/i);
  assert.match(context.notifications.at(-1)?.message ?? "", /\/goal <objectives>/i);
  assert.match(context.notifications.at(-1)?.message ?? "", /\/goal clear/i);

  mock.commands.get("goal")?.handler("clear", context.ctx);

  assert.equal(context.statuses.get("goal"), undefined);
  assert.equal(mock.entries.at(-1)?.customType, "goal-state");
  assert.deepEqual(mock.entries.at(-1)?.data, { goal: null });
  assert.match(context.notifications.at(-1)?.message ?? "", /legacy ordered goal queue state/i);
});

test("legacy setting plus persisted queue state emits one usable warning", () => {
  const legacySettingsPath = settingsPath("legacy-setting-with-persisted-queue.json");
  writeFileSync(legacySettingsPath, '{"experimental":{"goals":true}}\n');
  const mock = createMockPi();
  registerGoalWithSettingsPath(mock.pi, legacySettingsPath);
  const legacyGoal = {
    id: "legacy-head",
    text: "legacy head",
    status: "active",
    startedAt: 1,
    updatedAt: 1,
    iteration: 0,
    tokensUsed: 0,
    timeUsedSeconds: 0,
    baselineTokens: 0,
    automaticModelTurns: 0,
    toolFreeRepeatCount: 0,
  };
  const context = createMockContext({
    sessionManager: {
      getBranch: () => [
        {
          type: "custom",
          customType: "goal-state",
          data: { goal: legacyGoal, queue: [{ ...legacyGoal, id: "legacy-tail" }] },
        },
      ],
    },
  });

  mock.events.get("session_start")?.[0]?.({}, context.ctx);

  const queueWarnings = context.notifications.filter((notification) =>
    /ordered goal queue has been removed/i.test(notification.message),
  );
  assert.equal(queueWarnings.length, 1);
  assert.match(queueWarnings[0]?.message ?? "", /\/goal <objectives>/i);
  assert.doesNotMatch(queueWarnings[0]?.message ?? "", /\/goal edit/i);
});

test("failed start from inert legacy queue state preserves the old queue", async () => {
  const mock = createMockPi();
  registerGoal(mock.pi);
  const legacyGoal = {
    id: "legacy-head",
    text: "legacy head",
    status: "active",
    startedAt: 1,
    updatedAt: 1,
    iteration: 0,
    tokensUsed: 0,
    timeUsedSeconds: 0,
    baselineTokens: 0,
    automaticModelTurns: 0,
    toolFreeRepeatCount: 0,
  };
  const context = createMockContext({
    sessionManager: {
      getBranch: () => [
        {
          type: "custom",
          customType: "goal-state",
          data: { goal: legacyGoal, queue: [{ ...legacyGoal, id: "legacy-tail" }] },
        },
      ],
    },
  });

  mock.events.get("session_start")?.[0]?.({}, context.ctx);
  mock.rawPi.sendUserMessage = () => {
    throw new Error("runtime became busy");
  };

  await mock.commands.get("goal")?.handler("merged objective", context.ctx);

  assert.equal(mock.entries.length, 0);
  assert.equal(mock.sentUserMessages.length, 0);
  assert.equal(context.statuses.get("goal"), undefined);

  await mock.commands.get("goal")?.handler("", context.ctx);

  assert.match(context.notifications.at(-1)?.message ?? "", /Legacy queue state with 2 retained goals/i);
  assert.match(context.notifications.at(-1)?.message ?? "", /\/goal <objectives>/i);
});

test("session persistence restores stopped states with resumable command hints", async () => {
  for (const [status, statusline] of [
    ["paused", "paused"],
    ["blocked", "blocked"],
    ["usage_limited", "usage"],
    ["budget_limited", "budget 5/10"],
  ] as const) {
    const restored = restoreGoalForTest(status);
    assert.equal(restored.statuses.get("goal"), `${statusline} · automatic 0/25`);

    await restored.mock.commands.get("goal")?.handler("", restored.ctx);
    assert.match(restored.notifications.at(-1)?.message ?? "", new RegExp(`Status: ${status}`));
    assert.match(restored.notifications.at(-1)?.message ?? "", /\/goal resume/);
  }
});

test("resume safely reactivates every resumable stopped status and rotates goal_id", async () => {
  for (const status of ["paused", "blocked", "usage_limited", "budget_limited"] as const) {
    const restored = restoreGoalForTest(status);
    const beforeResume = restored.sessionGoal;

    await restored.mock.commands.get("goal")?.handler("resume", restored.ctx);

    const resumed = requireLastGoal(restored.mock);
    assert.equal(resumed.status, "active", `${status} should resume`);
    assert.notEqual(resumed.id, beforeResume.id);
    assert.equal(restored.statuses.get("goal"), "active 5/10 · automatic 0/25");
    assert.match(restored.notifications.at(-1)?.message ?? "", /counter.*0 of 25/i);
    assert.match(restored.notifications.at(-1)?.message ?? "", /progress and cumulative usage are preserved/i);
    assert.equal(restored.mock.sentUserMessages.length, 1);
    assert.match(restored.mock.sentUserMessages[0]?.text ?? "", /explicitly resumed/i);
    assert.equal(
      restored.mock.events.get("tool_call")?.[0]?.(
        { toolName: "bash", toolCallId: `tool-after-${status}`, input: {} },
        restored.ctx,
      ),
      undefined,
    );
  }
});

test("safety epochs reset on successful resume and active edit", async () => {
  const safety = {
    automaticModelTurns: 25,
    toolFreeRepeatCount: 3,
    lastToolFreeOutputFingerprint: "a".repeat(64),
    safetyPauseCause: "no_progress" as const,
  };
  const resumed = restoreGoalForTest("paused", safety);
  await resumed.mock.commands.get("goal")?.handler("resume", resumed.ctx);
  assert.deepEqual(pickSafetyState(requireLastGoal(resumed.mock)), safety);
  resumed.mock.events.get("before_agent_start")?.[0]?.(
    { prompt: resumed.mock.sentUserMessages.at(-1)?.text ?? "", systemPrompt: "base" },
    resumed.ctx,
  );
  assert.deepEqual(pickSafetyState(requireLastGoal(resumed.mock)), {
    automaticModelTurns: 0,
    toolFreeRepeatCount: 0,
    lastToolFreeOutputFingerprint: undefined,
    safetyPauseCause: undefined,
  });

  const edited = await startGoalForTest();
  const activeGoal = requireLastGoal(edited.mock);
  activeGoal.automaticModelTurns = 8;
  activeGoal.toolFreeRepeatCount = 2;
  activeGoal.lastToolFreeOutputFingerprint = "b".repeat(64);
  edited.mock.entries.push({ customType: "goal-state", data: { goal: activeGoal } });
  await edited.mock.commands.get("goal")?.handler("edit revised objective", edited.ctx);
  assert.deepEqual(pickSafetyState(requireLastGoal(edited.mock)), {
    automaticModelTurns: 8,
    toolFreeRepeatCount: 2,
    lastToolFreeOutputFingerprint: "b".repeat(64),
    safetyPauseCause: undefined,
  });
  edited.mock.events.get("before_agent_start")?.[0]?.(
    { prompt: edited.mock.sentUserMessages.at(-1)?.text ?? "", systemPrompt: "base" },
    edited.ctx,
  );
  assert.deepEqual(pickSafetyState(requireLastGoal(edited.mock)), {
    automaticModelTurns: 0,
    toolFreeRepeatCount: 0,
    lastToolFreeOutputFingerprint: undefined,
    safetyPauseCause: undefined,
  });
});

test("queued resume and active edit persist a reset that survives reload", async () => {
  const safety = {
    automaticModelTurns: 3,
    toolFreeRepeatCount: 3,
    lastToolFreeOutputFingerprint: "d".repeat(64),
    safetyPauseCause: "continuation_limit" as const,
  };
  const resumed = restoreGoalForTest("paused", safety);
  await resumed.mock.commands.get("goal")?.handler("resume", resumed.ctx);
  const queuedResume = requireLastGoal(resumed.mock);
  assert.deepEqual(pickSafetyState(queuedResume), safety);

  const reloadedResume = restoreStoredGoalForTest(queuedResume, [], {}, LOW_LIMITS_SETTINGS_PATH);
  assert.equal(lastGoalStatus(reloadedResume.mock), "active");
  assert.deepEqual(pickSafetyState(requireLastGoal(reloadedResume.mock)), {
    automaticModelTurns: 0,
    toolFreeRepeatCount: 0,
    lastToolFreeOutputFingerprint: undefined,
    safetyPauseCause: undefined,
  });

  const editSafety = { ...safety, toolFreeRepeatCount: 2 };
  const activeGoal: StoredGoal = {
    ...queuedResume,
    ...editSafety,
    id: "active-before-edit",
    status: "active",
    activeStartedAt: Date.now(),
    safetyResetPending: undefined,
  };
  const edited = restoreStoredGoalForTest(activeGoal);
  await edited.mock.commands.get("goal")?.handler("edit revised after reload", edited.ctx);
  const queuedEdit = requireLastGoal(edited.mock);
  assert.deepEqual(pickSafetyState(queuedEdit), editSafety);

  const reloadedEdit = restoreStoredGoalForTest(queuedEdit, [], {}, LOW_LIMITS_SETTINGS_PATH);
  assert.equal(lastGoalStatus(reloadedEdit.mock), "active");
  assert.deepEqual(pickSafetyState(requireLastGoal(reloadedEdit.mock)), {
    automaticModelTurns: 0,
    toolFreeRepeatCount: 0,
    lastToolFreeOutputFingerprint: undefined,
    safetyPauseCause: undefined,
  });
});

test("stopped input and failed resume preserve the exact safety epoch", async () => {
  const safety = {
    automaticModelTurns: 25,
    toolFreeRepeatCount: 3,
    lastToolFreeOutputFingerprint: "c".repeat(64),
    safetyPauseCause: "continuation_limit" as const,
  };
  const restored = restoreGoalForTest("paused", safety);
  restored.mock.events.get("input")?.[0]?.({ source: "interactive", text: "what happened?" }, restored.ctx);
  assert.deepEqual(pickSafetyState(requireLastGoal(restored.mock)), safety);

  restored.mock.rawPi.sendUserMessage = () => {
    throw new Error("resume delivery failed");
  };
  await restored.mock.commands.get("goal")?.handler("resume", restored.ctx);
  assert.equal(requireLastGoal(restored.mock).id, restored.sessionGoal.id);
  assert.deepEqual(pickSafetyState(requireLastGoal(restored.mock)), safety);
});

test("direct active input resets safety and reclassifies an in-flight automatic run", async () => {
  const active = await startGoalForTest({}, "finish", LOW_LIMITS_SETTINGS_PATH);
  await active.mock.events.get("agent_end")?.[0]?.(
    { messages: [{ role: "assistant", stopReason: "stop", content: [] }] },
    active.ctx,
  );
  await active.mock.events.get("agent_settled")?.[0]?.({}, active.ctx);
  const continuation = active.mock.sentUserMessages.at(-1)?.text ?? "";
  active.mock.events.get("before_agent_start")?.[0]?.({ prompt: continuation, systemPrompt: "base" }, active.ctx);
  active.mock.events.get("turn_end")?.[0]?.(
    { message: { role: "assistant", stopReason: "stop", content: [] }, toolResults: [] },
    active.ctx,
  );
  assert.equal(requireLastGoal(active.mock).automaticModelTurns, 1);
  active.mock.events.get("input")?.[0]?.({ source: "extension", text: "unrelated extension input" }, active.ctx);
  assert.equal(requireLastGoal(active.mock).automaticModelTurns, 1);

  active.mock.events.get("input")?.[0]?.({ source: "interactive", text: "new evidence" }, active.ctx);
  active.mock.events.get("turn_end")?.[0]?.(
    { message: { role: "assistant", stopReason: "stop", content: [] }, toolResults: [] },
    active.ctx,
  );
  await active.mock.events.get("agent_end")?.[0]?.(
    { messages: [{ role: "assistant", stopReason: "stop", content: [] }] },
    active.ctx,
  );

  assert.equal(requireLastGoal(active.mock).automaticModelTurns, 0);
  assert.equal(requireLastGoal(active.mock).toolFreeRepeatCount, 0);
});

test("busy active edit claims ownership and resets safety only when its queued run starts", async () => {
  const branch = [assistantUsageEntry({ totalTokens: 100 })];
  const edited = await startGoalForTest(
    { sessionManager: { getBranch: () => branch, getEntries: () => branch } },
    "finish",
    LOW_LIMITS_SETTINGS_PATH,
  );
  const kickoff = edited.mock.sentUserMessages.at(-1)?.text ?? "";
  edited.mock.events.get("before_agent_start")?.[0]?.({ prompt: kickoff, systemPrompt: "base" }, edited.ctx);
  const previous = requireLastGoal(edited.mock);
  previous.automaticModelTurns = 2;
  previous.toolFreeRepeatCount = 2;
  previous.lastToolFreeOutputFingerprint = "e".repeat(64);

  await edited.mock.commands.get("goal")?.handler("edit busy replacement", edited.ctx);
  const candidate = requireLastGoal(edited.mock);
  assert.notEqual(candidate.id, previous.id);
  assert.equal(candidate.automaticModelTurns, 2);
  const editPrompt = edited.mock.sentUserMessages.at(-1)?.text ?? "";
  edited.mock.events.get("input")?.[0]?.({ source: "extension", text: editPrompt }, edited.ctx);
  assert.equal(requireLastGoal(edited.mock).automaticModelTurns, 2);
  assert.equal(requireLastGoal(edited.mock).toolFreeRepeatCount, 2);
  branch.push(assistantUsageEntry({ totalTokens: 20 }));
  await edited.mock.events.get("tool_execution_end")?.[0]?.({}, edited.ctx);
  assert.equal(requireLastGoal(edited.mock).tokensUsed, 0);

  edited.mock.events.get("message_start")?.[0]?.(
    { message: { role: "user", content: [{ type: "text", text: editPrompt }] } },
    edited.ctx,
  );
  assert.equal(requireLastGoal(edited.mock).automaticModelTurns, 0);
  assert.equal(requireLastGoal(edited.mock).toolFreeRepeatCount, 0);
  assert.equal(requireLastGoal(edited.mock).baselineTokens, 120);

  await edited.mock.events.get("agent_end")?.[0]?.(
    { messages: [{ role: "assistant", stopReason: "stop", content: [] }] },
    edited.ctx,
  );
  await edited.mock.events.get("agent_settled")?.[0]?.({}, edited.ctx);
  assert.equal(lastGoalStatus(edited.mock), "active");
  assert.equal(edited.mock.sentUserMessages.length, 3);
});

test("resume rejects active goals and exhausted budgets without rotating goal_id", async () => {
  const active = await startGoalForTest();
  const activeGoal = requireLastGoal(active.mock);
  const activeMessageCount = active.mock.sentUserMessages.length;
  await active.mock.commands.get("goal")?.handler("resume", active.ctx);
  assert.match(active.notifications.at(-1)?.message ?? "", /only paused, blocked/i);
  assert.equal(requireLastGoal(active.mock).id, activeGoal.id);
  assert.equal(active.mock.sentUserMessages.length, activeMessageCount);

  for (const status of ["paused", "blocked", "usage_limited", "budget_limited"] as const) {
    const exhausted = restoreGoalForTest(status, { tokensUsed: 10 });
    await exhausted.mock.commands.get("goal")?.handler("resume", exhausted.ctx);
    assert.match(exhausted.notifications.at(-1)?.message ?? "", /still reached/i);
    exhausted.mock.events.get("session_shutdown")?.[0]?.({}, exhausted.ctx);
    assert.equal(lastGoalStatus(exhausted.mock), status);
    assert.equal(requireLastGoal(exhausted.mock).id, exhausted.sessionGoal.id);
    assert.equal(exhausted.mock.sentUserMessages.length, 0);
  }
});

test("failed resume delivery restores the stopped state and original goal_id", async () => {
  const restored = restoreGoalForTest("blocked");
  restored.mock.rawPi.sendUserMessage = () => {
    throw new Error("runtime became busy");
  };

  await restored.mock.commands.get("goal")?.handler("resume", restored.ctx);

  assert.equal(lastGoalStatus(restored.mock), "blocked");
  assert.equal(requireLastGoal(restored.mock).id, restored.sessionGoal.id);
  assert.equal(restored.statuses.get("goal"), "blocked · automatic 0/25");
  assert.equal(restored.mock.sentUserMessages.length, 0);
  assert.match(restored.notifications.at(-1)?.message ?? "", /runtime became busy/i);
  assert.deepEqual(
    restored.mock.events.get("tool_call")?.[0]?.(
      { toolName: "bash", toolCallId: "stale-after-failed-resume", input: {} },
      restored.ctx,
    ),
    { block: true, reason: STALE_GOAL_TOOL_REASON },
  );
});

test("resume stays stopped when another policy hides terminal tools", async () => {
  const restored = restoreGoalForTest("paused");
  const originalId = restored.sessionGoal.id;
  const originalSetActiveTools = restored.mock.rawPi.setActiveTools.bind(restored.mock.rawPi);
  originalSetActiveTools(["read", "bash"]);

  await restored.mock.commands.get("goal")?.handler("resume", restored.ctx);

  assert.equal(lastGoalStatus(restored.mock), "paused");
  assert.equal(requireLastGoal(restored.mock).id, originalId);
  assert.equal(restored.mock.sentUserMessages.length, 0);
  assert.match(restored.notifications.at(-1)?.message ?? "", /Cannot resume \/goal/i);
});

test("resume succeeds after the restrictive policy restores terminal tools", async () => {
  const restored = restoreGoalForTest("paused");
  restored.mock.rawPi.setActiveTools(["read", "bash"]);
  restored.mock.rawPi.setActiveTools(["read", "bash", "goal_complete", "goal_blocked", "goal_wait"]);

  await restored.mock.commands.get("goal")?.handler("resume", restored.ctx);

  assert.equal(lastGoalStatus(restored.mock), "active");
  assert.equal(restored.mock.sentUserMessages.length, 1);
  assert.deepEqual(restored.mock.rawPi.getActiveTools(), [
    "read",
    "bash",
    "goal_complete",
    "goal_blocked",
    "goal_wait",
  ]);
});

test("active edit pauses when another policy hides terminal tools", async () => {
  const edited = await startGoalForTest();
  edited.mock.rawPi.setActiveTools(["read", "bash"]);

  await edited.mock.commands.get("goal")?.handler("edit changed objective", edited.ctx);

  const restored = requireLastGoal(edited.mock);
  assert.equal(restored.status, "paused");
  assert.equal(restored.text, "finish");
  assert.equal(edited.mock.sentUserMessages.length, 1);
  assert.match(edited.notifications.at(-1)?.message ?? "", /goal tools.*paused/i);
});

test("failed start delivery clears a new goal and restores a replaced stopped goal", async () => {
  const freshMock = createMockPi();
  registerGoal(freshMock.pi);
  const freshContext = createMockContext();
  freshMock.events.get("session_start")?.[0]?.({}, freshContext.ctx);
  freshMock.rawPi.sendUserMessage = () => {
    throw new Error("start delivery failed");
  };
  await freshMock.commands.get("goal")?.handler("new objective", freshContext.ctx);
  assert.equal(lastGoalStatus(freshMock), null);
  assert.equal(freshContext.statuses.get("goal"), undefined);
  assert.match(freshContext.notifications.at(-1)?.message ?? "", /start delivery failed/i);

  let activeReplacementAborts = 0;
  const activeReplacementBranch: Record<string, unknown>[] = [];
  const activeReplacement = await startGoalForTest({
    abort: () => activeReplacementAborts++,
    sessionManager: {
      getBranch: () => activeReplacementBranch,
      getEntries: () => activeReplacementBranch,
    },
  });
  const activeOriginal = requireLastGoal(activeReplacement.mock);
  activeReplacementBranch.push(assistantUsageEntry({ totalTokens: 5 }));
  activeReplacement.mock.rawPi.sendUserMessage = () => {
    throw new Error("active replacement delivery failed");
  };
  await activeReplacement.mock.commands.get("goal")?.handler("active replacement objective", activeReplacement.ctx);
  const restoredActive = requireLastGoal(activeReplacement.mock);
  assert.equal(restoredActive.id, activeOriginal.id);
  assert.equal(restoredActive.text, activeOriginal.text);
  assert.equal(restoredActive.status, "active");
  assert.equal(restoredActive.tokensUsed, 5);
  assert.equal(activeReplacementAborts, 0);
  const replacementOwner = {
    session: (activeReplacement.ctx as unknown as { sessionManager: object }).sessionManager,
    group: "agent-workflow",
    busy: false,
  };
  activeReplacement.mock.eventBus.emit("workflow:mutex:v1", replacementOwner);
  assert.equal(replacementOwner.busy, true);

  const replacement = await startGoalForTest();
  await replacement.mock.commands.get("goal")?.handler("pause", replacement.ctx);
  const original = requireLastGoal(replacement.mock);
  replacement.mock.rawPi.sendUserMessage = () => {
    throw new Error("replacement delivery failed");
  };
  await replacement.mock.commands.get("goal")?.handler("replacement objective", replacement.ctx);
  const restored = requireLastGoal(replacement.mock);
  assert.equal(restored.id, original.id);
  assert.equal(restored.text, original.text);
  assert.equal(restored.status, "paused");
  assert.deepEqual(
    replacement.mock.events.get("tool_call")?.[0]?.(
      { toolName: "bash", toolCallId: "stale-after-replacement-failure", input: {} },
      replacement.ctx,
    ),
    { block: true, reason: STALE_GOAL_TOOL_REASON },
  );
});

test("failed active edit delivery restores the exact prior active goal", async () => {
  let aborts = 0;
  const edited = await startGoalForTest({ abort: () => aborts++ });
  const original = requireLastGoal(edited.mock);
  edited.mock.rawPi.sendUserMessage = () => {
    throw new Error("active edit delivery failed");
  };

  await edited.mock.commands.get("goal")?.handler("edit changed objective", edited.ctx);
  const restored = requireLastGoal(edited.mock);
  assert.equal(restored.id, original.id);
  assert.equal(restored.text, original.text);
  assert.equal(restored.status, "active");
  assert.equal(aborts, 0);
  const editOwner = {
    session: (edited.ctx as unknown as { sessionManager: object }).sessionManager,
    group: "agent-workflow",
    busy: false,
  };
  edited.mock.eventBus.emit("workflow:mutex:v1", editOwner);
  assert.equal(editOwner.busy, true);
  assert.equal(
    edited.mock.events.get("tool_call")?.[0]?.(
      { toolName: "bash", toolCallId: "stale-after-edit-failure", input: {} },
      edited.ctx,
    ),
    undefined,
  );
});

test("editing paused, blocked, or usage-limited goals preserves their stopped state", async () => {
  for (const status of ["paused", "blocked", "usage_limited"] as const) {
    const restored = restoreGoalForTest(status);
    const oldId = restored.sessionGoal.id;
    await restored.mock.commands.get("goal")?.handler("edit --tokens 20 revised objective", restored.ctx);

    const edited = requireLastGoal(restored.mock);
    assert.equal(edited.status, status);
    assert.equal(edited.tokenBudget, 20);
    assert.notEqual(edited.id, oldId);
    assert.equal(restored.mock.sentUserMessages.length, 0);
    assert.deepEqual(
      restored.mock.events.get("tool_call")?.[0]?.(
        { toolName: "bash", toolCallId: `stale-after-edit-${status}`, input: {} },
        restored.ctx,
      ),
      { block: true, reason: STALE_GOAL_TOOL_REASON },
    );
  }
});

test("pause remains active-only for new stopped statuses", async () => {
  for (const status of ["blocked", "usage_limited", "budget_limited"] as const) {
    const restored = restoreGoalForTest(status);
    await restored.mock.commands.get("goal")?.handler("pause", restored.ctx);
    assert.match(restored.notifications.at(-1)?.message ?? "", /only active goals can be paused/i);
    const label = status === "usage_limited" ? "usage" : status === "budget_limited" ? "budget 5/10" : status;
    assert.equal(restored.statuses.get("goal"), `${label} · automatic 0/25`);
  }
});
