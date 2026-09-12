import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createEventBus,
  DefaultResourceLoader,
  ExtensionRunner,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { afterAll, test } from "vitest";
import goal from "../packages/pi-goal/src/goal.js";
import planMode from "../packages/pi-plan-mode/src/plan-mode.js";
import { builtinTool, createMockContext, createMockPi, extensionTool } from "./support.js";

const WORKFLOW_MUTEX_CHANNEL = "workflow:mutex:v1";
const AGENT_WORKFLOW_GROUP = "agent-workflow";
const root = mkdtempSync(join(tmpdir(), "plan-goal-coexistence-"));
const goalSettingsPath = join(root, "pi-goal.json");
const goalRpcSettingsPath = join(root, "pi-goal-rpc.json");
writeFileSync(goalSettingsPath, "{}\n");
writeFileSync(goalRpcSettingsPath, '{"rpc":{"enabled":true}}\n');
afterAll(() => rmSync(root, { recursive: true, force: true }));

type LoadOrder = "plan-first" | "goal-first";

type CapturedPlanUi = {
  launch?: {
    start(signal: AbortSignal): void;
    startWithTools(names: string[], signal: AbortSignal): void;
  };
};

function workflowAttempt(session: object) {
  return { session, group: AGENT_WORKFLOW_GROUP, busy: false };
}

function planEntry(data: Record<string, unknown>) {
  return { type: "custom", customType: "plan-mode-state", data };
}

function goalEntry(goalState: Record<string, unknown>) {
  return { type: "custom", customType: "goal-state", data: { goal: goalState } };
}

function activeGoal(id = "restored-goal", waiting?: { reason: string; resumeAt?: number }) {
  return {
    id,
    text: `Goal ${id}`,
    status: "active",
    startedAt: 1,
    updatedAt: 2,
    iteration: 0,
    tokensUsed: 0,
    timeUsedSeconds: 0,
    baselineTokens: 0,
    activeStartedAt: waiting ? undefined : 1,
    automaticModelTurns: 0,
    toolFreeRepeatCount: 0,
    ...(waiting ? { waiting } : {}),
  };
}

function latestStateEntry(entries: Array<{ customType: string; data: unknown }>, customType: string) {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    if (entries[index]?.customType === customType) {
      return entries[index]?.data as Record<string, unknown> | undefined;
    }
  }
  return undefined;
}

function goalStatus(entries: Array<{ customType: string; data: unknown }>) {
  const data = latestStateEntry(entries, "goal-state");
  const stored = data?.goal as { status?: string } | null | undefined;
  return stored?.status ?? null;
}

async function emitLifecycle(
  events: ReadonlyMap<string, Array<(...args: unknown[]) => unknown>>,
  name: string,
  ...args: unknown[]
) {
  let result: unknown;
  for (const handler of events.get(name) ?? []) result = await handler(...args);
  return result;
}

function createFixture(
  loadOrder: LoadOrder,
  options: {
    branch?: Record<string, unknown>[];
    goalRpc?: boolean;
    planShortcut?: boolean;
    capturePlanUi?: CapturedPlanUi;
  } = {},
) {
  const branch = options.branch ?? [];
  const sessionManager = {
    getSessionId: () => "coexistence-session",
    getSessionName: () => undefined,
    getSessionFile: () => undefined,
    getBranch: () => branch,
    getEntries: () => branch,
  };
  const mock = createMockPi({
    activeTools: [
      "read",
      "bash",
      "write",
      "goal_complete",
      "goal_blocked",
      "goal_wait",
      "plan_mode_question",
      "plan_mode_complete",
    ],
    allTools: [
      builtinTool("read"),
      builtinTool("bash"),
      builtinTool("write"),
      extensionTool("goal_complete"),
      extensionTool("goal_blocked"),
      extensionTool("goal_wait"),
      extensionTool("plan_mode_question"),
      extensionTool("plan_mode_complete"),
    ],
    thinkingLevel: "low",
  });
  const activeToolWrites: string[][] = [];
  const setActiveTools = mock.rawPi.setActiveTools.bind(mock.rawPi);
  mock.rawPi.setActiveTools = (names) => {
    activeToolWrites.push([...names]);
    setActiveTools(names);
  };
  const captured = options.capturePlanUi;
  const registerPlan = () =>
    planMode(mock.pi, {
      readSettings: async () =>
        options.planShortcut
          ? {
              kind: "loaded" as const,
              settings: { thinkingLevel: "inherit" as const, toggleShortcut: "ctrl+shift+p" },
            }
          : { kind: "missing" as const },
      ...(captured
        ? {
            loadInteractiveUi: async () =>
              ({
                showPlanLaunchMenu: async (_ctx: unknown, launch: CapturedPlanUi["launch"]) => {
                  captured.launch = launch;
                },
              }) as never,
          }
        : {}),
    });
  const registerGoal = () =>
    goal(mock.pi, {
      settingsPath: options.goalRpc ? goalRpcSettingsPath : goalSettingsPath,
    });
  if (loadOrder === "plan-first") {
    registerPlan();
    registerGoal();
  } else {
    registerGoal();
    registerPlan();
  }
  const context = createMockContext({
    mode: "tui",
    hasUI: true,
    cwd: root,
    sessionManager,
    confirm: async () => true,
    model: {},
    modelRegistry: { getApiKeyAndHeaders: async () => ({ ok: true }) },
  });
  return { mock, context, sessionManager, activeToolWrites, captured };
}

async function startSession(fixture: ReturnType<typeof createFixture>, reason = "startup") {
  await emitLifecycle(fixture.mock.events, "session_start", { reason }, fixture.context.ctx);
}

async function startPlan(fixture: ReturnType<typeof createFixture>, prompt?: string) {
  await fixture.mock.commands.get("plan")?.handler(prompt === undefined ? "start" : prompt, fixture.context.ctx);
}

async function startGoal(fixture: ReturnType<typeof createFixture>, objective = "integrated goal") {
  await fixture.mock.commands.get("goal")?.handler(objective, fixture.context.ctx);
}

function assertOneHolder(fixture: ReturnType<typeof createFixture>) {
  const current = workflowAttempt(fixture.sessionManager);
  fixture.mock.eventBus.emit(WORKFLOW_MUTEX_CHANNEL, current);
  assert.equal(current.busy, true);
}

for (const loadOrder of ["plan-first", "goal-first"] as const) {
  for (const acquisitionOrder of ["plan-first", "goal-first"] as const) {
    test(`${loadOrder} load and ${acquisitionOrder} acquisition produce one holder`, async () => {
      const fixture = createFixture(loadOrder);
      await startSession(fixture);
      if (acquisitionOrder === "plan-first") await startPlan(fixture);
      else await startGoal(fixture);
      const writesBeforeRejection = fixture.activeToolWrites.length;
      const entriesBeforeRejection = fixture.mock.entries.length;
      const promptsBeforeRejection = fixture.mock.sentUserMessages.length;
      const thinkingBeforeRejection = fixture.mock.thinkingLevels.length;

      if (acquisitionOrder === "plan-first") await startGoal(fixture, "losing Goal");
      else await startPlan(fixture);

      assertOneHolder(fixture);
      assert.equal(fixture.activeToolWrites.length, writesBeforeRejection);
      assert.equal(fixture.mock.entries.length, entriesBeforeRejection);
      assert.equal(fixture.mock.sentUserMessages.length, promptsBeforeRejection);
      assert.equal(fixture.mock.thinkingLevels.length, thinkingBeforeRejection);
      if (acquisitionOrder === "plan-first") {
        assert.equal(
          (latestStateEntry(fixture.mock.entries, "plan-mode-state") as { enabled?: boolean })?.enabled,
          true,
        );
        assert.equal(goalStatus(fixture.mock.entries), null);
        assert.equal(fixture.context.statuses.get("plan-mode"), "plan active");
      } else {
        assert.equal(latestStateEntry(fixture.mock.entries, "plan-mode-state"), undefined);
        assert.equal(goalStatus(fixture.mock.entries), "active");
        assert.match(fixture.context.statuses.get("goal") ?? "", /^active/u);
      }
      assert.match(fixture.context.notifications.at(-1)?.message ?? "", /Another workflow/u);
    });
  }
}

for (const loadOrder of ["plan-first", "goal-first"] as const) {
  test(`${loadOrder} Plan activation preserves the stable helper envelope`, async () => {
    const fixture = createFixture(loadOrder);
    await startSession(fixture);
    const stableTools = fixture.mock.rawPi.getActiveTools();
    const writesBefore = fixture.activeToolWrites.length;

    await startPlan(fixture);

    assert.deepEqual(fixture.mock.rawPi.getActiveTools(), stableTools);
    assert.equal(fixture.activeToolWrites.length, writesBefore);
  });
}

test("Plan ready and revision states reject Goal without changing Plan tools", async () => {
  const fixture = createFixture("plan-first");
  await startSession(fixture);
  await startPlan(fixture);
  const complete = fixture.mock.tools.find((tool) => tool.name === "plan_mode_complete")?.execute as (
    ...args: unknown[]
  ) => Promise<unknown>;
  await complete("complete-plan", { plan: "# Integrated ready plan" }, undefined, undefined, fixture.context.ctx);
  const readyTools = fixture.mock.rawPi.getActiveTools();
  const writesBeforeReadyRejection = fixture.activeToolWrites.length;
  await startGoal(fixture, "Goal rejected during ready review");
  assert.deepEqual(fixture.mock.rawPi.getActiveTools(), readyTools);
  assert.equal(fixture.activeToolWrites.length, writesBeforeReadyRejection);
  assert.equal(fixture.context.statuses.get("plan-mode"), "plan ready");

  await emitLifecycle(
    fixture.mock.events,
    "before_agent_start",
    { prompt: "revise", systemPrompt: "base" },
    fixture.context.ctx,
  );
  const writesBeforeRevisionRejection = fixture.activeToolWrites.length;
  await startGoal(fixture, "Goal rejected during revision");
  assert.equal(fixture.activeToolWrites.length, writesBeforeRevisionRejection);
  assert.equal(fixture.context.statuses.get("plan-mode"), "plan active");
  assertOneHolder(fixture);
});

test("paused Goal cannot resume or widen tools while Plan holds", async () => {
  const fixture = createFixture("goal-first");
  await startSession(fixture);
  await startGoal(fixture, "Goal to pause");
  await fixture.mock.commands.get("goal")?.handler("pause", fixture.context.ctx);
  await startPlan(fixture);
  const planTools = fixture.mock.rawPi.getActiveTools();
  const writesBeforeResume = fixture.activeToolWrites.length;
  const entriesBeforeResume = fixture.mock.entries.length;
  await fixture.mock.commands.get("goal")?.handler("resume", fixture.context.ctx);
  assert.equal(goalStatus(fixture.mock.entries), "paused");
  assert.equal(fixture.activeToolWrites.length, writesBeforeResume);
  assert.equal(fixture.mock.entries.length, entriesBeforeResume);
  assert.deepEqual(fixture.mock.rawPi.getActiveTools(), planTools);
  assert.match(fixture.context.notifications.at(-1)?.message ?? "", /Another workflow/u);
});

test("waiting Goal rejects Plan direct, prompted, menu, selected-tool, and shortcut starts", async () => {
  const captured: CapturedPlanUi = {};
  const fixture = createFixture("goal-first", {
    capturePlanUi: captured,
    planShortcut: true,
  });
  await startSession(fixture);
  await startGoal(fixture, "Goal waiting for an external event");
  const activeGoal = latestStateEntry(fixture.mock.entries, "goal-state")?.goal as {
    id: string;
  };
  const waitTool = fixture.mock.tools.find((tool) => tool.name === "goal_wait")?.execute as (
    ...args: unknown[]
  ) => Promise<unknown>;
  await waitTool(
    "wait",
    { goal_id: activeGoal.id, reason: "external review" },
    undefined,
    undefined,
    fixture.context.ctx,
  );
  const goalTools = fixture.mock.rawPi.getActiveTools();
  const writesBefore = fixture.activeToolWrites.length;
  const entriesBefore = fixture.mock.entries.length;
  const promptsBefore = fixture.mock.sentUserMessages.length;

  await startPlan(fixture);
  await startPlan(fixture, "prompted Plan start");
  await fixture.mock.commands.get("plan")?.handler("", fixture.context.ctx);
  assert.ok(captured.launch);
  captured.launch.start(new AbortController().signal);
  captured.launch.startWithTools(["read"], new AbortController().signal);
  await fixture.mock.shortcuts.get("ctrl+shift+p")?.handler(fixture.context.ctx);

  assert.equal(fixture.activeToolWrites.length, writesBefore);
  assert.equal(fixture.mock.entries.length, entriesBefore);
  assert.equal(fixture.mock.sentUserMessages.length, promptsBefore);
  assert.deepEqual(fixture.mock.rawPi.getActiveTools(), goalTools);
  assert.equal(goalStatus(fixture.mock.entries), "active");
  assertOneHolder(fixture);
});

test("Plan holder rejects managed-run Goal activation with one terminal error", async () => {
  const fixture = createFixture("plan-first", { goalRpc: true });
  await startSession(fixture);
  await startPlan(fixture);
  const events: unknown[] = [];
  fixture.mock.eventBus.on("pi-goal:event:coexistence-run", (event) => events.push(event));
  const writesBefore = fixture.activeToolWrites.length;
  const entriesBefore = fixture.mock.entries.length;
  fixture.mock.eventBus.emit("pi-goal:start", {
    runId: "coexistence-run",
    objective: "managed Goal blocked by Plan",
  });
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(events, [
    {
      type: "error",
      runId: "coexistence-run",
      operation: "start",
      error: {
        code: "ACTIVATION_FAILED",
        message: "Another workflow is active in this session. End it before starting Goal.",
      },
    },
  ]);
  assert.equal(fixture.activeToolWrites.length, writesBefore);
  assert.equal(fixture.mock.entries.length, entriesBefore);
  assert.equal(goalStatus(fixture.mock.entries), null);
  assertOneHolder(fixture);
});

test("restored Goal leaves inactive Plan state uncommitted", async () => {
  const branch = [goalEntry(activeGoal("restored-holder"))];
  const fixture = createFixture("goal-first", { branch });
  await startSession(fixture, "resume");
  assert.equal(goalStatus(fixture.mock.entries), "active");
  assert.equal(latestStateEntry(fixture.mock.entries, "plan-mode-state"), undefined);
  assert.equal(fixture.context.statuses.get("plan-mode"), undefined);
  assertOneHolder(fixture);
});

for (const loadOrder of ["plan-first", "goal-first"] as const) {
  test(`${loadOrder} simultaneous restore selects one safe holder`, async () => {
    const branch = [planEntry({ enabled: true, awaitingAction: false }), goalEntry(activeGoal())];
    const fixture = createFixture(loadOrder, { branch });
    await startSession(fixture, "resume");
    assertOneHolder(fixture);
    if (loadOrder === "plan-first") {
      assert.equal(fixture.context.statuses.get("plan-mode"), "plan active");
      assert.equal(goalStatus(fixture.mock.entries), "paused");
      assert.deepEqual(fixture.mock.rawPi.getActiveTools(), [
        "read",
        "bash",
        "write",
        "goal_complete",
        "goal_blocked",
        "goal_wait",
        "plan_mode_question",
        "plan_mode_complete",
      ]);
    } else {
      assert.equal(fixture.context.statuses.get("plan-mode"), undefined);
      assert.equal(goalStatus(fixture.mock.entries), "active");
      assert.match(fixture.context.statuses.get("goal") ?? "", /^active/u);
      assert.deepEqual(fixture.mock.rawPi.getActiveTools(), [
        "read",
        "bash",
        "write",
        "goal_complete",
        "goal_blocked",
        "goal_wait",
        "plan_mode_question",
        "plan_mode_complete",
      ]);
    }
  });
}

test("each workflow can acquire only after the other finishes cleanup", async () => {
  const fixture = createFixture("plan-first");
  await startSession(fixture);
  await startPlan(fixture);
  await fixture.mock.commands.get("plan")?.handler("exit", fixture.context.ctx);
  await startGoal(fixture, "Goal after Plan cleanup");
  assert.equal(goalStatus(fixture.mock.entries), "active");
  assertOneHolder(fixture);

  await fixture.mock.commands.get("goal")?.handler("pause", fixture.context.ctx);
  await startPlan(fixture);
  assert.equal((latestStateEntry(fixture.mock.entries, "plan-mode-state") as { enabled?: boolean })?.enabled, true);
  assertOneHolder(fixture);
});

test("standalone Plan and Goal preserve representative lifecycle behavior", async () => {
  const planMock = createMockPi({
    activeTools: ["read", "write", "plan_mode_question", "plan_mode_complete"],
  });
  planMode(planMock.pi, { readSettings: async () => ({ kind: "missing" as const }) });
  const planContext = createMockContext({ mode: "tui", hasUI: true });
  await emitLifecycle(planMock.events, "session_start", { reason: "startup" }, planContext.ctx);
  await planMock.commands.get("plan")?.handler("start", planContext.ctx);
  assert.equal(planContext.statuses.get("plan-mode"), "plan active");
  await planMock.commands.get("plan")?.handler("exit", planContext.ctx);
  assert.equal(planContext.statuses.get("plan-mode"), undefined);

  const goalMock = createMockPi({
    activeTools: ["read", "goal_complete", "goal_blocked", "goal_wait"],
  });
  goal(goalMock.pi, { settingsPath: goalSettingsPath });
  const goalContext = createMockContext({ mode: "tui", hasUI: true });
  await emitLifecycle(goalMock.events, "session_start", { reason: "startup" }, goalContext.ctx);
  await goalMock.commands.get("goal")?.handler("standalone Goal", goalContext.ctx);
  assert.equal(goalStatus(goalMock.entries), "active");
  await goalMock.commands.get("goal")?.handler("pause", goalContext.ctx);
  assert.equal(goalStatus(goalMock.entries), "paused");
});

test("built generated entries share one Pi bus and stale invalidation removes both listeners", async () => {
  const agentDir = join(root, "generated-agent");
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  try {
    const eventBus = createEventBus();
    const loader = new DefaultResourceLoader({
      cwd: root,
      agentDir,
      settingsManager: SettingsManager.inMemory({}),
      eventBus,
      additionalExtensionPaths: [
        join(process.cwd(), "packages/pi-plan-mode/dist/index.ts"),
        join(process.cwd(), "packages/pi-goal/dist/index.ts"),
      ],
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
    });
    await loader.reload();
    const loaded = loader.getExtensions();
    assert.deepEqual(loaded.errors, []);
    assert.equal(loaded.extensions.length, 2);
    assert.ok(loaded.extensions.some((extension) => extension.commands.has("plan")));
    assert.ok(loaded.extensions.some((extension) => extension.commands.has("goal")));
    assert.ok(loaded.extensions.some((extension) => extension.tools.has("plan_mode_complete")));
    assert.ok(loaded.extensions.some((extension) => extension.tools.has("goal_complete")));

    let activeTools = ["read", "write", "goal_complete", "goal_blocked", "goal_wait"];
    const sessionManager = {
      getSessionId: () => "generated-coexistence",
      getSessionName: () => undefined,
      getSessionFile: () => undefined,
      getBranch: () => [],
      getEntries: () => [],
    };
    const runner = new ExtensionRunner(loaded.extensions, loaded.runtime, root, sessionManager as never, {} as never);
    runner.bindCore(
      {
        sendMessage: () => undefined,
        sendUserMessage: () => undefined,
        appendEntry: () => undefined,
        setSessionName: () => undefined,
        getSessionName: () => undefined,
        setLabel: () => undefined,
        getActiveTools: () => [...activeTools],
        getAllTools: () => [
          builtinTool("read"),
          builtinTool("write"),
          extensionTool("goal_complete"),
          extensionTool("goal_blocked"),
          extensionTool("goal_wait"),
        ],
        setActiveTools: (names: string[]) => {
          activeTools = [...names];
        },
        refreshTools: () => undefined,
        getCommands: () => [],
        setModel: async () => true,
        getThinkingLevel: () => "off",
        setThinkingLevel: () => undefined,
      } as never,
      {
        getModel: () => undefined,
        getScopedModels: () => [],
        isIdle: () => true,
        isProjectTrusted: () => true,
        getSignal: () => undefined,
        abort: () => undefined,
        hasPendingMessages: () => false,
        shutdown: () => undefined,
        getContextUsage: () => undefined,
        compact: () => undefined,
        getSystemPrompt: () => "",
        getSystemPromptOptions: () => ({ cwd: root }),
      } as never,
    );
    const goalCommand = runner.getCommand("goal");
    assert.ok(goalCommand);
    await goalCommand.handler("generated shared-bus goal", runner.createCommandContext());
    const active = workflowAttempt(sessionManager);
    eventBus.emit(WORKFLOW_MUTEX_CHANNEL, active);
    assert.equal(active.busy, true);

    loaded.runtime.invalidate("generated coexistence reload");
    const stale = workflowAttempt(sessionManager);
    eventBus.emit(WORKFLOW_MUTEX_CHANNEL, stale);
    assert.equal(stale.busy, false);
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  }
});
