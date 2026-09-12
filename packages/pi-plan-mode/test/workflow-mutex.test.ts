import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import planMode from "../src/plan-mode.js";
import { AGENT_WORKFLOW_GROUP, WORKFLOW_MUTEX_CHANNEL, WorkflowMutex } from "../src/workflow-mutex.js";
import { createMockContext, createMockPi } from "./support.js";

const PLAN_HELPERS = ["plan_mode_question", "plan_mode_complete"];

function attempt(session: object, group = AGENT_WORKFLOW_GROUP) {
  return { session, group, busy: false };
}

function blockAgentWorkflow(mock: ReturnType<typeof createMockPi>, session: object) {
  mock.eventBus.on(WORKFLOW_MUTEX_CHANNEL, (payload) => {
    if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return;
    const current = payload as { session?: object; group?: string; busy?: boolean };
    if (current.session !== session || current.group !== AGENT_WORKFLOW_GROUP) return;
    if (typeof current.busy !== "boolean") return;
    current.busy = true;
  });
}

function persistedPlanState(data: Record<string, unknown>) {
  return {
    type: "custom",
    customType: "plan-mode-state",
    data,
  };
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

test("workflow mutex reports a matching holder without erasing an earlier busy result", () => {
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
});

test("workflow mutex fails closed on emit errors and unexpected payload mutation", () => {
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

  const mock = createMockPi();
  mock.eventBus.on(WORKFLOW_MUTEX_CHANNEL, (payload) => {
    (payload as { group: string }).group = "changed";
  });
  const mutated = new WorkflowMutex(mock.pi);
  mutated.bindSession({});
  assert.equal(mutated.acquire(), undefined);
});

test("workflow mutex rejects synchronous re-entry that replaces the session", () => {
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
  const replacementOwner = mutex.acquire();
  assert.ok(replacementOwner);
  assert.equal(mutex.isOwner(replacementOwner), true);
});

test("workflow mutex stale release cannot clear a replacement owner", () => {
  const mock = createMockPi();
  const mutex = new WorkflowMutex(mock.pi);
  const session = {};
  mutex.bindSession(session);
  const oldOwner = mutex.acquire();
  assert.ok(oldOwner);
  mutex.release(oldOwner);
  const currentOwner = mutex.acquire();
  assert.ok(currentOwner);

  mutex.release(oldOwner);
  assert.equal(mutex.isOwner(currentOwner), true);
  const current = attempt(session);
  mock.eventBus.emit(WORKFLOW_MUTEX_CHANNEL, current);
  assert.equal(current.busy, true);
});

test("Plan holds the workflow mutex through planning, ready review, and revision", async () => {
  let idle = true;
  const mock = createMockPi({ activeTools: ["read", "write"] });
  planMode(mock.pi, { readSettings: async () => ({ kind: "missing" as const }) });
  const sessionManager = { getBranch: () => [], getEntries: () => [] };
  const context = createMockContext({
    mode: "tui",
    hasUI: true,
    isIdle: () => idle,
    sessionManager,
  });
  await mock.events.get("session_start")?.[0]?.({ reason: "startup" }, context.ctx);
  await mock.commands.get("plan")?.handler("start", context.ctx);

  const planning = attempt(sessionManager);
  mock.eventBus.emit(WORKFLOW_MUTEX_CHANNEL, planning);
  assert.equal(planning.busy, true);

  const complete = mock.tools.find((tool) => tool.name === "plan_mode_complete")?.execute as (
    ...args: unknown[]
  ) => Promise<unknown>;
  await complete("call", { plan: "# Ready plan" }, undefined, undefined, context.ctx);
  const ready = attempt(sessionManager);
  mock.eventBus.emit(WORKFLOW_MUTEX_CHANNEL, ready);
  assert.equal(ready.busy, true);

  await mock.events.get("before_agent_start")?.[0]?.({ systemPrompt: "base", prompt: "revise" }, context.ctx);
  const revision = attempt(sessionManager);
  mock.eventBus.emit(WORKFLOW_MUTEX_CHANNEL, revision);
  assert.equal(revision.busy, true);

  idle = false;
  await mock.commands.get("plan")?.handler("exit", context.ctx);
  const stillHeld = attempt(sessionManager);
  mock.eventBus.emit(WORKFLOW_MUTEX_CHANNEL, stillHeld);
  assert.equal(stillHeld.busy, true);
  assert.match(context.notifications.at(-1)?.message ?? "", /run is active.*retry/i);

  idle = true;
  await mock.commands.get("plan")?.handler("exit", context.ctx);
  const released = attempt(sessionManager);
  mock.eventBus.emit(WORKFLOW_MUTEX_CHANNEL, released);
  assert.equal(released.busy, false);
});

test("busy direct starts preserve state in every command mode", async () => {
  for (const mode of ["tui", "rpc", "print", "json"] as const) {
    const sessionManager = { getBranch: () => [], getEntries: () => [] };
    const mock = createMockPi({ activeTools: ["read", "write"], thinkingLevel: "low" });
    blockAgentWorkflow(mock, sessionManager);
    planMode(mock.pi, { readSettings: async () => ({ kind: "missing" as const }) });
    const context = createMockContext({
      mode,
      hasUI: mode === "tui" || mode === "rpc",
      sessionManager,
    });
    const command = mock.commands.get("plan");
    assert.ok(command);
    const snapshot = {
      activeTools: mock.rawPi.getActiveTools(),
      entries: mock.entries.length,
      messages: mock.sentUserMessages.length,
      thinking: mock.thinkingLevel,
      thinkingWrites: mock.thinkingLevels.length,
      statuses: [...context.statuses],
    };

    for (const input of ["start", "design a release"]) {
      if (mode === "print" || mode === "json") {
        await assert.rejects(async () => command.handler(input, context.ctx), /Another workflow is active/u);
      } else {
        await command.handler(input, context.ctx);
      }
      assert.deepEqual(mock.rawPi.getActiveTools(), snapshot.activeTools);
      assert.equal(mock.entries.length, snapshot.entries);
      assert.equal(mock.sentUserMessages.length, snapshot.messages);
      assert.equal(mock.thinkingLevel, snapshot.thinking);
      assert.equal(mock.thinkingLevels.length, snapshot.thinkingWrites);
      assert.deepEqual([...context.statuses], snapshot.statuses);
    }
    if (mode === "tui" || mode === "rpc") {
      assert.equal(context.notifications.length, 2);
      assert.ok(
        context.notifications.every(
          (notification) =>
            notification.level === "warning" &&
            notification.message === "Another workflow is active in this session. End it before starting Plan mode.",
        ),
      );
    }
  }
});

test("busy restored activation does not widen the startup tool envelope", async () => {
  const entry = persistedPlanState({ enabled: true, awaitingAction: false });
  const sessionManager = { getBranch: () => [entry], getEntries: () => [entry] };
  const mock = createMockPi({ activeTools: ["goal_complete"], thinkingLevel: "high" });
  let activeToolWrites = 0;
  const setActiveTools = mock.rawPi.setActiveTools.bind(mock.rawPi);
  mock.rawPi.setActiveTools = (names) => {
    activeToolWrites += 1;
    setActiveTools(names);
  };
  blockAgentWorkflow(mock, sessionManager);
  planMode(mock.pi, { readSettings: async () => ({ kind: "missing" as const }) });
  const context = createMockContext({ mode: "tui", hasUI: true, sessionManager });

  await mock.events.get("session_start")?.[0]?.({ reason: "startup" }, context.ctx);
  assert.equal(activeToolWrites, 0);
  assert.deepEqual(mock.rawPi.getActiveTools(), ["goal_complete", ...PLAN_HELPERS]);
  assert.equal(mock.thinkingLevel, "high");
  assert.equal(mock.thinkingLevels.length, 0);
  assert.equal(mock.entries.length, 0);
  assert.equal(context.statuses.get("plan-mode"), undefined);
  assert.match(context.notifications[0]?.message ?? "", /was not restored/u);

  const beforeStart = await mock.events.get("before_agent_start")?.[0]?.(
    { systemPrompt: "base", prompt: "continue" },
    context.ctx,
  );
  assert.equal(beforeStart, undefined);
  assert.equal(mock.sentUserMessages.length, 0);
});

test("busy menu, selected-tool, shortcut, and active-implementation starts stay atomic", async () => {
  for (const mode of ["tui", "rpc"] as const) {
    const sessionManager = { getBranch: () => [], getEntries: () => [] };
    const mock = createMockPi({ activeTools: ["read", "write"] });
    blockAgentWorkflow(mock, sessionManager);
    let launchOptions:
      | {
          start(signal: AbortSignal): void;
          startWithTools(names: string[], signal: AbortSignal): void;
        }
      | undefined;
    planMode(mock.pi, {
      readSettings: async () => ({ kind: "missing" as const }),
      loadInteractiveUi: async () =>
        ({
          showPlanLaunchMenu: async (_ctx: unknown, options: typeof launchOptions) => {
            launchOptions = options;
          },
        }) as never,
    });
    const context = createMockContext({ mode, hasUI: true, sessionManager });
    await mock.commands.get("plan")?.handler("", context.ctx);
    assert.ok(launchOptions);
    launchOptions.start(new AbortController().signal);
    launchOptions.startWithTools(["read"], new AbortController().signal);
    assert.deepEqual(mock.rawPi.getActiveTools(), ["read", "write", ...PLAN_HELPERS]);
    assert.equal(mock.entries.length, 0);
    assert.equal(context.notifications.length, 2);
  }

  const shortcutSession = { getBranch: () => [], getEntries: () => [] };
  const shortcutMock = createMockPi({ activeTools: ["read", "write"] });
  blockAgentWorkflow(shortcutMock, shortcutSession);
  planMode(shortcutMock.pi, {
    readSettings: async () => ({
      kind: "loaded" as const,
      settings: { thinkingLevel: "inherit" as const, toggleShortcut: "ctrl+shift+p" },
    }),
  });
  const shortcutContext = createMockContext({
    mode: "tui",
    hasUI: true,
    sessionManager: shortcutSession,
  });
  await shortcutMock.events.get("session_start")?.[0]?.({ reason: "startup" }, shortcutContext.ctx);
  await shortcutMock.shortcuts.get("ctrl+shift+p")?.handler(shortcutContext.ctx);
  assert.deepEqual(shortcutMock.rawPi.getActiveTools(), ["read", "write", ...PLAN_HELPERS]);
  assert.equal(shortcutMock.entries.length, 0);
  assert.match(shortcutContext.notifications.at(-1)?.message ?? "", /Another workflow/u);

  const activeEntry = persistedPlanState({
    enabled: false,
    awaitingAction: false,
    activeImplementation: {
      id: "active-plan",
      plan: "# Existing plan",
      source: "plan_mode_complete",
      startedAt: 1,
      retention: "keep",
    },
  });
  const activeSession = { getBranch: () => [activeEntry], getEntries: () => [activeEntry] };
  const activeMock = createMockPi({ activeTools: ["read", "write"] });
  blockAgentWorkflow(activeMock, activeSession);
  let startNew: (() => void) | undefined;
  planMode(activeMock.pi, {
    readSettings: async () => ({ kind: "missing" as const }),
    loadInteractiveUi: async () =>
      ({
        showActiveImplementationMenu: async (_ctx: unknown, options: { startNew(): void }) => {
          startNew = options.startNew;
        },
      }) as never,
  });
  const activeContext = createMockContext({
    mode: "tui",
    hasUI: true,
    sessionManager: activeSession,
  });
  await activeMock.events.get("session_start")?.[0]?.({ reason: "startup" }, activeContext.ctx);
  const statusSnapshot = [...activeContext.statuses];
  await activeMock.commands.get("plan")?.handler("", activeContext.ctx);
  assert.ok(startNew);
  startNew();
  assert.deepEqual(activeMock.rawPi.getActiveTools(), ["read", "write", ...PLAN_HELPERS]);
  assert.equal(activeMock.entries.length, 0);
  assert.deepEqual([...activeContext.statuses], statusSnapshot);
});

test("Plan releases only after exit, save, export, implementation handoff, and shutdown cleanup", async () => {
  const exportRoot = await mkdtemp(join(tmpdir(), "pi-plan-mutex-release-"));
  try {
    for (const action of ["exit", "save", "export", "implement", "shutdown"] as const) {
      const sessionManager = { getBranch: () => [], getEntries: () => [] };
      const mock = createMockPi({ activeTools: ["read", "write"] });
      planMode(mock.pi, { readSettings: async () => ({ kind: "missing" as const }) });
      const context = createMockContext({
        mode: "tui",
        hasUI: true,
        cwd: exportRoot,
        sessionManager,
      });
      await mock.events.get("session_start")?.[0]?.({ reason: "startup" }, context.ctx);
      await mock.commands.get("plan")?.handler("start", context.ctx);
      if (action === "save" || action === "export" || action === "implement") {
        const complete = mock.tools.find((tool) => tool.name === "plan_mode_complete")?.execute as (
          ...args: unknown[]
        ) => Promise<unknown>;
        await complete("call", { plan: `# ${action} plan` }, undefined, undefined, context.ctx);
      }

      if (action === "shutdown") {
        await mock.events.get("session_shutdown")?.[0]?.({ reason: "quit" }, context.ctx);
      } else if (action === "export") {
        await mock.commands.get("plan")?.handler(`export ${join(exportRoot, `${action}.md`)}`, context.ctx);
      } else {
        await mock.commands.get("plan")?.handler(action, context.ctx);
      }

      const released = attempt(sessionManager);
      mock.eventBus.emit(WORKFLOW_MUTEX_CHANNEL, released);
      assert.equal(released.busy, false, `${action} should release after cleanup`);
      assert.deepEqual(mock.rawPi.getActiveTools(), ["read", "write", "plan_mode_question", "plan_mode_complete"]);
    }
  } finally {
    await rm(exportRoot, { recursive: true, force: true });
  }
});

test("fresh-session cancellation and pre-shutdown success preserve the source owner", async () => {
  for (const cancelled of [true, false]) {
    const sessionManager = {
      getBranch: () => [],
      getEntries: () => [],
      getSessionFile: () => undefined,
    };
    const mock = createMockPi({ activeTools: ["read", "write"] });
    let implementFresh: ((runtime: object, signal: AbortSignal) => Promise<void>) | undefined;
    planMode(mock.pi, {
      readSettings: async () => ({ kind: "missing" as const }),
      loadInteractiveUi: async () =>
        ({
          showPlanModeMenu: async (
            _ctx: unknown,
            options: { implementFresh(runtime: object, signal: AbortSignal): Promise<void> },
          ) => {
            implementFresh = options.implementFresh;
          },
        }) as never,
    });
    const context = createMockContext({
      mode: "tui",
      hasUI: true,
      sessionManager,
      model: {},
      modelRegistry: {
        getApiKeyAndHeaders: async () => ({ ok: true }),
      },
      waitForIdle: async () => undefined,
      newSession: async () => ({ cancelled }),
    });
    await mock.events.get("session_start")?.[0]?.({ reason: "startup" }, context.ctx);
    await mock.commands.get("plan")?.handler("start", context.ctx);
    const complete = mock.tools.find((tool) => tool.name === "plan_mode_complete")?.execute as (
      ...args: unknown[]
    ) => Promise<unknown>;
    await complete("call", { plan: "# Ready plan" }, undefined, undefined, context.ctx);
    await mock.commands.get("plan")?.handler("", context.ctx);
    assert.ok(implementFresh);
    await implementFresh({}, new AbortController().signal);

    const beforeShutdown = attempt(sessionManager);
    mock.eventBus.emit(WORKFLOW_MUTEX_CHANNEL, beforeShutdown);
    assert.equal(beforeShutdown.busy, true);
    if (!cancelled) {
      await mock.events.get("session_shutdown")?.[0]?.({ reason: "new" }, context.ctx);
      const afterShutdown = attempt(sessionManager);
      mock.eventBus.emit(WORKFLOW_MUTEX_CHANNEL, afterShutdown);
      assert.equal(afterShutdown.busy, false);
    }
  }
});

test("workflow mutex replacement and shutdown clear only the bound session", () => {
  const mock = createMockPi();
  const mutex = new WorkflowMutex(mock.pi);
  const firstSession = {};
  const secondSession = {};
  mutex.bindSession(firstSession);
  assert.ok(mutex.acquire());

  mutex.bindSession(secondSession);
  const firstAttempt = attempt(firstSession);
  mock.eventBus.emit(WORKFLOW_MUTEX_CHANNEL, firstAttempt);
  assert.equal(firstAttempt.busy, false);
  const secondOwner = mutex.acquire();
  assert.ok(secondOwner);

  mutex.unbindSession(firstSession);
  assert.equal(mutex.isOwner(secondOwner), true);
  mutex.unbindSession(secondSession);
  const secondAttempt = attempt(secondSession);
  mock.eventBus.emit(WORKFLOW_MUTEX_CHANNEL, secondAttempt);
  assert.equal(secondAttempt.busy, false);
});
