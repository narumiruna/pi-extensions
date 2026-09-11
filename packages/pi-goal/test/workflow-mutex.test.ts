import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import { createMockContext, createMockPi } from "../../../test/support.js";
import goal from "../src/goal.js";
import { AGENT_WORKFLOW_GROUP, WORKFLOW_MUTEX_CHANNEL, WorkflowMutex } from "../src/workflow-mutex.js";
import {
  assistantUsageEntry,
  DEFAULT_SETTINGS_PATH,
  lastGoalStatus,
  registerGoalWithSettingsPath,
  requireGoalTool,
  requireLastGoal,
  startGoalForTest,
} from "./support/goal-fixture.js";

function attempt(session: object, group = AGENT_WORKFLOW_GROUP) {
  return { session, group, busy: false };
}

function blockAgentWorkflow(mock: ReturnType<typeof createMockPi>, session: object) {
  return mock.eventBus.on(WORKFLOW_MUTEX_CHANNEL, (payload) => {
    if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return;
    const current = payload as { session?: object; group?: string; busy?: boolean };
    if (current.session !== session || current.group !== AGENT_WORKFLOW_GROUP) return;
    if (typeof current.busy !== "boolean") return;
    current.busy = true;
  });
}

test("workflow mutex ignores malformed, foreign-session, and foreign-group payloads", () => {
  const mock = createMockPi();
  const mutex = new WorkflowMutex(mock.pi);
  const session = {};
  mutex.bindSession(session);
  assert.ok(mutex.acquire());

  for (const payload of [undefined, null, [], "mutex", 1, { session }, { session, group: 1 }]) {
    assert.doesNotThrow(() => mock.eventBus.emit(WORKFLOW_MUTEX_CHANNEL, payload));
  }
  assert.doesNotThrow(() =>
    mock.eventBus.emit(
      WORKFLOW_MUTEX_CHANNEL,
      new Proxy(
        {},
        {
          get() {
            throw new Error("hostile getter");
          },
        },
      ),
    ),
  );

  const anotherSession = attempt({});
  mock.eventBus.emit(WORKFLOW_MUTEX_CHANNEL, anotherSession);
  assert.equal(anotherSession.busy, false);
  const anotherGroup = attempt(session, "other-workflow");
  mock.eventBus.emit(WORKFLOW_MUTEX_CHANNEL, anotherGroup);
  assert.equal(anotherGroup.busy, false);
  const malformedBusy = { session, group: AGENT_WORKFLOW_GROUP, busy: "false" };
  mock.eventBus.emit(WORKFLOW_MUTEX_CHANNEL, malformedBusy);
  assert.equal(malformedBusy.busy, "false");
});

test("workflow mutex preserves monotonic busy and fails closed on errors or mutation", () => {
  const mock = createMockPi();
  const session = {};
  mock.eventBus.on(WORKFLOW_MUTEX_CHANNEL, (payload) => {
    (payload as { busy: boolean }).busy = true;
  });
  const mutex = new WorkflowMutex(mock.pi);
  mutex.bindSession(session);
  const current = attempt(session);
  mock.eventBus.emit(WORKFLOW_MUTEX_CHANNEL, current);
  assert.equal(current.busy, true);
  assert.equal(mutex.acquire(), undefined);

  const throwing = new WorkflowMutex({
    events: {
      on: () => () => undefined,
      emit() {
        throw new Error("emit failed");
      },
    },
  } as never);
  throwing.bindSession({});
  assert.equal(throwing.acquire(), undefined);

  const mutatedMock = createMockPi();
  mutatedMock.eventBus.on(WORKFLOW_MUTEX_CHANNEL, (payload) => {
    (payload as { group: string }).group = "changed";
  });
  const mutated = new WorkflowMutex(mutatedMock.pi);
  mutated.bindSession({});
  assert.equal(mutated.acquire(), undefined);
});

test("workflow mutex rejects re-entry and stale release without clearing a new owner", () => {
  const mock = createMockPi();
  let mutex: WorkflowMutex;
  let replaced = false;
  const replacementSession = {};
  mock.eventBus.on(WORKFLOW_MUTEX_CHANNEL, () => {
    if (replaced) return;
    replaced = true;
    mutex.bindSession(replacementSession);
  });
  mutex = new WorkflowMutex(mock.pi);
  mutex.bindSession({});
  assert.equal(mutex.acquire(), undefined);
  const oldOwner = mutex.acquire();
  assert.ok(oldOwner);
  mutex.release(oldOwner);
  const currentOwner = mutex.acquire();
  assert.ok(currentOwner);
  mutex.release(oldOwner);
  assert.equal(mutex.isOwner(currentOwner), true);

  mutex.unbindSession(replacementSession);
  const released = attempt(replacementSession);
  mock.eventBus.emit(WORKFLOW_MUTEX_CHANNEL, released);
  assert.equal(released.busy, false);
});

test("active and waiting Goals hold while paused and budget-limited Goals release", async () => {
  const active = await startGoalForTest();
  const session = (active.ctx as unknown as { sessionManager: object }).sessionManager;
  const activeAttempt = attempt(session);
  active.mock.eventBus.emit(WORKFLOW_MUTEX_CHANNEL, activeAttempt);
  assert.equal(activeAttempt.busy, true);

  const goalId = requireLastGoal(active.mock).id;
  await requireGoalTool(active.mock, "goal_wait").execute(
    "wait",
    { goal_id: goalId, reason: "external deployment" },
    new AbortController().signal,
    () => undefined,
    active.ctx,
  );
  const waitingAttempt = attempt(session);
  active.mock.eventBus.emit(WORKFLOW_MUTEX_CHANNEL, waitingAttempt);
  assert.equal(waitingAttempt.busy, true);

  await active.mock.commands.get("goal")?.handler("pause", active.ctx);
  const pausedAttempt = attempt(session);
  active.mock.eventBus.emit(WORKFLOW_MUTEX_CHANNEL, pausedAttempt);
  assert.equal(pausedAttempt.busy, false);

  const budgetBranch: Record<string, unknown>[] = [];
  const budgetSession = { getBranch: () => budgetBranch, getEntries: () => budgetBranch };
  const budget = await startGoalForTest({ sessionManager: budgetSession }, "--tokens 1 bounded");
  budgetBranch.push(assistantUsageEntry({ totalTokens: 2 }));
  await budget.mock.events.get("tool_execution_end")?.[0]?.(
    { toolCallId: "budget", toolName: "read", result: {}, isError: false },
    budget.ctx,
  );
  const budgetAttempt = attempt(budgetSession);
  budget.mock.eventBus.emit(WORKFLOW_MUTEX_CHANNEL, budgetAttempt);
  assert.equal(budgetAttempt.busy, false);
});

test("busy direct start and resume preserve Goal state in every command mode", async () => {
  for (const mode of ["tui", "rpc", "print", "json"] as const) {
    const sessionManager = { getBranch: () => [], getEntries: () => [] };
    const mock = createMockPi({
      activeTools: ["read", "goal_complete", "goal_blocked", "goal_wait"],
    });
    blockAgentWorkflow(mock, sessionManager);
    registerGoalWithSettingsPath(mock.pi, DEFAULT_SETTINGS_PATH);
    const context = createMockContext({
      mode,
      hasUI: mode === "tui" || mode === "rpc",
      sessionManager,
    });
    await mock.events.get("session_start")?.[0]?.({ reason: "startup" }, context.ctx);
    const snapshot = {
      tools: mock.rawPi.getActiveTools(),
      entries: mock.entries.length,
      messages: mock.sentUserMessages.length,
      status: [...context.statuses],
    };
    const command = mock.commands.get("goal");
    assert.ok(command);
    if (mode === "print" || mode === "json") {
      await assert.rejects(async () => command.handler("blocked start", context.ctx), /Another workflow is active/u);
    } else {
      await command.handler("blocked start", context.ctx);
    }
    assert.deepEqual(mock.rawPi.getActiveTools(), snapshot.tools);
    assert.equal(mock.entries.length, snapshot.entries);
    assert.equal(mock.sentUserMessages.length, snapshot.messages);
    assert.deepEqual([...context.statuses], snapshot.status);
    assert.equal(lastGoalStatus(mock), null);
  }
});

test("busy active restore pauses safely without widening tools or scheduling work", async () => {
  const restored = {
    id: "restored-active",
    text: "restore safely",
    status: "active",
    startedAt: 1,
    updatedAt: 2,
    iteration: 0,
    tokensUsed: 0,
    timeUsedSeconds: 0,
    baselineTokens: 0,
    activeStartedAt: 1,
    automaticModelTurns: 0,
    toolFreeRepeatCount: 0,
  };
  const entry = { type: "custom", customType: "goal-state", data: { goal: restored } };
  const sessionManager = { getBranch: () => [entry], getEntries: () => [entry] };
  const mock = createMockPi({ activeTools: ["read"] });
  let activeToolWrites = 0;
  const setActiveTools = mock.rawPi.setActiveTools.bind(mock.rawPi);
  mock.rawPi.setActiveTools = (tools) => {
    activeToolWrites += 1;
    setActiveTools(tools);
  };
  blockAgentWorkflow(mock, sessionManager);
  goal(mock.pi, { settingsPath: DEFAULT_SETTINGS_PATH });
  const context = createMockContext({ mode: "tui", hasUI: true, sessionManager });

  await mock.events.get("session_start")?.[0]?.({ reason: "startup" }, context.ctx);
  assert.equal(activeToolWrites, 0);
  assert.deepEqual(mock.rawPi.getActiveTools(), ["read"]);
  assert.equal(lastGoalStatus(mock), "paused");
  assert.equal(mock.sentUserMessages.length, 0);
  assert.match(context.notifications.at(-1)?.message ?? "", /paused during restore/u);
  await mock.events.get("agent_settled")?.[0]?.({}, context.ctx);
  assert.equal(mock.sentUserMessages.length, 0);
});

test("busy managed-run RPC emits one anonymous terminal activation error", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-goal-mutex-rpc-"));
  try {
    const settingsPath = join(root, "pi-goal.json");
    await writeFile(settingsPath, JSON.stringify({ rpc: { enabled: true } }), "utf8");
    const sessionManager = { getBranch: () => [], getEntries: () => [] };
    const mock = createMockPi({
      activeTools: ["read", "goal_complete", "goal_blocked", "goal_wait"],
    });
    blockAgentWorkflow(mock, sessionManager);
    goal(mock.pi, { settingsPath });
    const context = createMockContext({ mode: "rpc", hasUI: true, sessionManager });
    await mock.events.get("session_start")?.[0]?.({ reason: "startup" }, context.ctx);
    const events: unknown[] = [];
    mock.eventBus.on("pi-goal:event:busy-run", (event) => events.push(event));

    mock.eventBus.emit("pi-goal:start", { runId: "busy-run", objective: "blocked run" });
    await Promise.resolve();
    await Promise.resolve();

    assert.deepEqual(events, [
      {
        type: "error",
        runId: "busy-run",
        operation: "start",
        error: {
          code: "ACTIVATION_FAILED",
          message: "Another workflow is active in this session. End it before starting Goal.",
        },
      },
    ]);
    assert.equal(mock.entries.length, 0);
    assert.equal(mock.sentUserMessages.length, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("pause, completion, clear, and shutdown release after Goal cleanup", async () => {
  for (const action of ["pause", "complete", "clear", "shutdown"] as const) {
    const fixture = await startGoalForTest();
    const session = (fixture.ctx as unknown as { sessionManager: object }).sessionManager;
    if (action === "complete") {
      const activeGoal = requireLastGoal(fixture.mock);
      await requireGoalTool(fixture.mock, "goal_complete").execute(
        "complete",
        { goal_id: activeGoal.id, summary: "All requirements completed and verified." },
        new AbortController().signal,
        () => undefined,
        fixture.ctx,
      );
    } else if (action === "shutdown") {
      await fixture.mock.events.get("session_shutdown")?.[0]?.({ reason: "quit" }, fixture.ctx);
    } else {
      await fixture.mock.commands.get("goal")?.handler(action, fixture.ctx);
    }
    const released = attempt(session);
    fixture.mock.eventBus.emit(WORKFLOW_MUTEX_CHANNEL, released);
    assert.equal(released.busy, false, `${action} should release after cleanup`);
  }
});

test("active Goal replacement reuses its owner while stopped resume reacquires", async () => {
  const active = await startGoalForTest({ confirm: async () => true });
  const session = (active.ctx as unknown as { sessionManager: object }).sessionManager;
  await active.mock.commands.get("goal")?.handler("replacement objective", active.ctx);
  const replacementAttempt = attempt(session);
  active.mock.eventBus.emit(WORKFLOW_MUTEX_CHANNEL, replacementAttempt);
  assert.equal(replacementAttempt.busy, true);

  await active.mock.commands.get("goal")?.handler("pause", active.ctx);
  blockAgentWorkflow(active.mock, session);
  const beforeResume = requireLastGoal(active.mock);
  const entryCount = active.mock.entries.length;
  await active.mock.commands.get("goal")?.handler("resume", active.ctx);
  assert.equal(requireLastGoal(active.mock).id, beforeResume.id);
  assert.equal(lastGoalStatus(active.mock), "paused");
  assert.equal(active.mock.entries.length, entryCount);
  assert.match(active.notifications.at(-1)?.message ?? "", /Another workflow is active/u);
});
