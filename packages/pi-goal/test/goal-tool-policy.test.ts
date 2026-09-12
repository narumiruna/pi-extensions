import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "vitest";
import { createMockContext, createMockPi } from "../../../test/support.js";
import {
  assistantUsageEntry,
  GOAL_SETTINGS_DIRECTORY,
  INVALID_SETTINGS_PATH,
  lastGoalStatus,
  MISSING_SETTINGS_PATH,
  registerGoal,
  registerGoalWithSettingsPath,
  requireGoalTool,
  requireLastGoal,
  restoreGoalForTest,
  type StoredGoal,
  startGoalForTest,
} from "./support/goal-fixture.js";

test("goal registers command, status tools, and lifecycle hooks", () => {
  // Production leaves extension tools active until session_start; factory registration
  // itself does not call setActiveTools (actions may still be unbound).
  const mock = createMockPi({
    activeTools: ["read", "bash", "goal_complete", "goal_blocked", "goal_wait"],
  });
  registerGoalWithSettingsPath(mock.pi, MISSING_SETTINGS_PATH);

  assert.ok(mock.commands.has("goal"));
  assert.equal(typeof mock.commands.get("goal")?.getArgumentCompletions, "function");
  assert.deepEqual(
    mock.tools.map((tool) => tool.name),
    ["goal_complete", "goal_blocked", "goal_wait"],
  );
  assert.deepEqual(mock.rawPi.getActiveTools(), ["read", "bash", "goal_complete", "goal_blocked", "goal_wait"]);
  const context = createMockContext();
  mock.events.get("session_start")?.[0]?.({}, context.ctx);
  assert.deepEqual(mock.rawPi.getActiveTools(), ["read", "bash", "goal_complete", "goal_blocked", "goal_wait"]);
  for (const tool of mock.tools.filter((candidate) => candidate.name?.startsWith("goal_"))) {
    assert.match(String(tool.description), /visibility alone does not activate Goal mode/i);
    assert.equal(tool.promptSnippet, undefined);
    assert.equal(tool.promptGuidelines, undefined);
  }
  const completionParameters = mock.tools.find((tool) => tool.name === "goal_complete")?.parameters as
    | {
        required?: string[];
        properties?: Record<string, { minLength?: number; maxLength?: number }>;
      }
    | undefined;
  assert.deepEqual(completionParameters?.required, ["goal_id", "summary"]);
  assert.equal(completionParameters?.properties?.goal_id?.minLength, 1);
  assert.equal(completionParameters?.properties?.goal_id?.maxLength, 128);
  assert.equal(completionParameters?.properties?.summary?.minLength, 1);
  assert.equal(completionParameters?.properties?.summary?.maxLength, 4_000);
  const blockerDefinition = mock.tools.find((tool) => tool.name === "goal_blocked");
  const blockedParameters = blockerDefinition?.parameters as
    | {
        required?: string[];
        properties?: Record<string, { minimum?: number; minLength?: number; maxLength?: number }>;
      }
    | undefined;
  assert.deepEqual(blockedParameters?.required, ["goal_id", "reason", "evidence", "repeated_turns"]);
  assert.equal(blockedParameters?.properties?.goal_id?.minLength, 1);
  assert.equal(blockedParameters?.properties?.goal_id?.maxLength, 128);
  assert.equal(blockedParameters?.properties?.reason?.minLength, 1);
  assert.equal(blockedParameters?.properties?.reason?.maxLength, 1_000);
  assert.equal(blockedParameters?.properties?.evidence?.minLength, 1);
  assert.equal(blockedParameters?.properties?.evidence?.maxLength, 4_000);
  assert.equal(blockedParameters?.properties?.repeated_turns?.minimum, 3);
  assert.match(String(blockerDefinition?.description), /blocker.*three consecutive Goal turns/i);
  assert.match(String(blockerDefinition?.description), /visibility alone does not activate Goal mode/i);
  assert.equal(blockerDefinition?.promptSnippet, undefined);
  assert.equal(blockerDefinition?.promptGuidelines, undefined);
  const waitDefinition = mock.tools.find((tool) => tool.name === "goal_wait");
  const waitParameters = waitDefinition?.parameters as
    | {
        required?: string[];
        properties?: Record<string, { minimum?: number; maximum?: number; minLength?: number; maxLength?: number }>;
      }
    | undefined;
  assert.deepEqual(waitParameters?.required, ["goal_id", "reason"]);
  assert.equal(waitParameters?.properties?.goal_id?.maxLength, 128);
  assert.equal(waitParameters?.properties?.reason?.maxLength, 1_000);
  assert.equal(waitParameters?.properties?.resume_after_ms?.minimum, 1);
  assert.equal(waitParameters?.properties?.resume_after_ms?.maximum, 2_147_483_647);
  assert.match(String(waitDefinition?.description), /external wake event.*call goal_wait alone/is);
  assert.match(String(waitDefinition?.description), /visibility alone does not activate Goal mode/i);
  assert.match(String(waitDefinition?.description), /below 10000ms.*clamped/is);
  assert.equal(waitDefinition?.promptSnippet, undefined);
  assert.equal(waitDefinition?.promptGuidelines, undefined);
  assert.deepEqual([...mock.events.keys()].sort(), [
    "agent_end",
    "agent_settled",
    "agent_start",
    "before_agent_start",
    "context",
    "input",
    "message_start",
    "session_before_compact",
    "session_compact",
    "session_shutdown",
    "session_start",
    "tool_call",
    "tool_execution_end",
    "turn_end",
  ]);
});

test("bare goal is menu-first in TUI, observable in RPC, and rejects headless modes", async () => {
  const mock = createMockPi({ activeTools: ["goal_complete", "goal_blocked", "goal_wait"] });
  registerGoal(mock.pi);
  const selections: Array<{ title: string; actions: string[] }> = [];
  const tui = createMockContext({
    mode: "tui",
    hasUI: true,
    select: async (title: string, actions: string[]) => {
      selections.push({ title, actions });
      return undefined;
    },
  });
  mock.events.get("session_start")?.[0]?.({}, tui.ctx);

  await mock.commands.get("goal")?.handler("", tui.ctx);
  assert.equal(selections.length, 1);
  assert.match(selections[0]?.title ?? "", /Goal\nNo goal is currently set/i);
  assert.ok(selections[0]?.actions.includes("Start a goal…"));
  assert.equal(tui.notifications.length, 0);

  await mock.commands.get("goal")?.handler("status", tui.ctx);
  assert.equal(selections.length, 1);
  assert.match(tui.notifications.at(-1)?.message ?? "", /No goal is currently set/i);

  const rpc = createMockContext({ mode: "rpc", hasUI: true });
  await mock.commands.get("goal")?.handler("status", rpc.ctx);
  assert.match(rpc.notifications.at(-1)?.message ?? "", /No goal is currently set/i);

  let printSelections = 0;
  const print = createMockContext({
    mode: "print",
    hasUI: false,
    select: async () => {
      printSelections++;
      return undefined;
    },
  });
  await assert.rejects(
    mock.commands.get("goal")?.handler("", print.ctx) as Promise<unknown>,
    /\/goal status is unavailable in print mode/i,
  );
  assert.equal(printSelections, 0);
  assert.equal(print.notifications.length, 0);

  const json = createMockContext({ mode: "json", hasUI: false });
  await assert.rejects(
    mock.commands.get("goal")?.handler("status", json.ctx) as Promise<unknown>,
    /\/goal status is unavailable in json mode/i,
  );
});

test("malformed goal commands notify UI modes and reject headless modes observably", async () => {
  const mock = createMockPi({ activeTools: ["goal_complete", "goal_blocked", "goal_wait"] });
  registerGoal(mock.pi);

  for (const mode of ["tui", "rpc"] as const) {
    const context = createMockContext({ mode, hasUI: true });
    await mock.commands.get("goal")?.handler("pause now", context.ctx);
    assert.match(context.notifications.at(-1)?.message ?? "", /Usage: \/goal pause/i);
  }

  for (const mode of ["print", "json"] as const) {
    const context = createMockContext({ mode, hasUI: false });
    await assert.rejects(
      mock.commands.get("goal")?.handler("pause now", context.ctx) as Promise<unknown>,
      /Usage: \/goal pause/i,
    );
    assert.equal(context.notifications.length, 0);
  }
});

test("session start uses defaults without materializing missing settings", () => {
  const parent = join(GOAL_SETTINGS_DIRECTORY, "session-missing");
  const settingsPath = join(parent, "pi-goal.json");
  const mock = createMockPi({
    activeTools: ["read", "bash", "goal_complete", "goal_blocked", "goal_wait"],
  });
  registerGoalWithSettingsPath(mock.pi, settingsPath);
  const context = createMockContext();

  mock.events.get("session_start")?.[0]?.({}, context.ctx);
  mock.events.get("session_start")?.[0]?.({}, context.ctx);

  assert.equal(existsSync(parent), false);
  assert.deepEqual(mock.rawPi.getActiveTools(), ["read", "bash", "goal_complete", "goal_blocked", "goal_wait"]);
  assert.equal(context.notifications.length, 0);
});

test("missing and invalid settings keep the stable Goal tool envelope", () => {
  for (const [settingsPath, expectsWarning] of [
    [MISSING_SETTINGS_PATH, false],
    [INVALID_SETTINGS_PATH, true],
  ] as const) {
    const mock = createMockPi({
      activeTools: ["read", "bash", "goal_complete", "goal_blocked", "goal_wait"],
    });
    registerGoalWithSettingsPath(mock.pi, settingsPath);
    const context = createMockContext();
    mock.events.get("session_start")?.[0]?.({}, context.ctx);

    assert.deepEqual(mock.rawPi.getActiveTools(), ["read", "bash", "goal_complete", "goal_blocked", "goal_wait"]);
    assert.equal(
      context.notifications.some((notice) => /settings ignored/.test(notice.message)),
      expectsWarning,
    );
  }
});

test("invalid settings remain read-only in the Goal settings UI", async () => {
  const mock = createMockPi({ activeTools: ["goal_complete", "goal_blocked", "goal_wait"] });
  registerGoalWithSettingsPath(mock.pi, INVALID_SETTINGS_PATH);
  const selections = ["Settings…", undefined, "Close"];
  let settingsRender = "";
  const context = createMockContext({
    mode: "tui",
    hasUI: true,
    select: async (title: string) => {
      if (/Read only/i.test(title)) settingsRender = title;
      return selections.shift();
    },
  });
  mock.events.get("session_start")?.[0]?.({}, context.ctx);

  await mock.commands.get("goal")?.handler("", context.ctx);

  assert.match(settingsRender, /Read only/i);
  assert.match(settingsRender, /invalid settings file/i);
  assert.match(settingsRender, /using built-in defaults/i);
  assert.equal(readFileSync(INVALID_SETTINGS_PATH, "utf8"), '{"toolVisibility":"sometimes","rpc":{"enabled":"yes"}}\n');
});

test("Goal lifecycle never mutates its stable helper-tool envelope", async () => {
  const tools = ["read", "bash", "goal_complete", "goal_blocked", "goal_wait"];
  const mock = createMockPi({ activeTools: tools });
  registerGoal(mock.pi);
  let activeToolWrites = 0;
  const setActiveTools = mock.rawPi.setActiveTools.bind(mock.rawPi);
  mock.rawPi.setActiveTools = (names) => {
    activeToolWrites += 1;
    setActiveTools(names);
  };
  const context = createMockContext();

  mock.events.get("session_start")?.[0]?.({}, context.ctx);
  await mock.commands.get("goal")?.handler("finish the work", context.ctx);
  const started = requireLastGoal(mock);
  await requireGoalTool(mock, "goal_complete").execute(
    "complete-1",
    { goal_id: started.id, summary: "Verified every requirement against current evidence." },
    new AbortController().signal,
    () => undefined,
    context.ctx,
  );
  await mock.commands.get("goal")?.handler("clear", context.ctx);
  mock.events.get("session_start")?.[0]?.({}, context.ctx);

  assert.equal(activeToolWrites, 0);
  assert.deepEqual(mock.rawPi.getActiveTools(), tools);
});

test("restoring an unfinished goal keeps registered Goal tools active", () => {
  for (const status of ["active", "paused", "blocked", "usage_limited", "budget_limited"] as const) {
    const { mock } = restoreGoalForTest(status);
    assert.deepEqual(
      mock.rawPi.getActiveTools(),
      ["goal_complete", "goal_blocked", "goal_wait"],
      `expected unlock for restored ${status} goal`,
    );
  }
});

test("restore does not widen an earlier restrictive session-start policy", () => {
  const sessionGoal: StoredGoal = {
    id: "restored-under-restriction",
    text: "restore without widening",
    status: "active",
    startedAt: 1,
    updatedAt: 2,
    iteration: 3,
    tokensUsed: 5,
    timeUsedSeconds: 4,
    baselineTokens: 0,
  };
  const branch = [
    { type: "custom", customType: "goal-state", data: { goal: sessionGoal } },
    assistantUsageEntry({ totalTokens: 5 }),
  ];
  const mock = createMockPi();
  registerGoal(mock.pi);
  // Simulate an earlier session_start handler restoring Plan mode's saved tool set.
  mock.rawPi.setActiveTools(["read", "bash"]);
  let aborts = 0;
  const context = createMockContext({
    abort: () => aborts++,
    sessionManager: { getBranch: () => branch, getEntries: () => branch },
  });

  mock.events.get("session_start")?.[0]?.({}, context.ctx);

  assert.deepEqual(mock.rawPi.getActiveTools(), ["read", "bash"]);
  assert.equal(lastGoalStatus(mock), "paused");
  assert.equal(aborts, 0);
  mock.events.get("input")?.[0]?.(
    { source: "extension", text: "startup follow-up", streamingBehavior: undefined },
    context.ctx,
  );
  assert.equal(
    mock.events.get("tool_call")?.[0]?.(
      { toolName: "read", toolCallId: "startup-extension-read", input: {} },
      context.ctx,
    ),
    undefined,
  );
  assert.match(context.notifications.at(-1)?.message ?? "", /goal tools.*paused/i);
});

test("an active goal pauses without aborting an unrelated restrictive turn", async () => {
  let aborts = 0;
  const mock = createMockPi({
    activeTools: ["read", "bash", "scrape", "goal_complete", "goal_blocked", "goal_wait"],
  });
  registerGoal(mock.pi);
  const context = createMockContext({ abort: () => aborts++ });
  mock.events.get("session_start")?.[0]?.({}, context.ctx);
  await mock.commands.get("goal")?.handler("finish the work", context.ctx);

  // Plan-mode style whole-set replacement drops goal tools and keeps unrelated ones.
  mock.rawPi.setActiveTools(["read", "bash", "scrape"]);
  const result = mock.events.get("before_agent_start")?.[0]?.(
    { prompt: "continue work", systemPrompt: "base" },
    context.ctx,
  );
  assert.equal(result, undefined);
  assert.deepEqual(mock.rawPi.getActiveTools(), ["read", "bash", "scrape"]);
  assert.equal(lastGoalStatus(mock), "paused");
  assert.equal(aborts, 0);
  assert.equal(
    mock.events.get("tool_call")?.[0]?.({ toolName: "read", toolCallId: "plan-read", input: {} }, context.ctx),
    undefined,
  );
  assert.match(context.notifications.at(-1)?.message ?? "", /goal tools.*paused/i);
});

test("missing goal tools abort an automatic continuation turn", async () => {
  let aborts = 0;
  const active = await startGoalForTest({ abort: () => aborts++ });
  await active.mock.events.get("agent_end")?.[0]?.(
    { messages: [{ role: "assistant", stopReason: "stop" }] },
    active.ctx,
  );
  await active.mock.events.get("agent_settled")?.[0]?.({}, active.ctx);
  const continuationPrompt = active.mock.sentUserMessages.at(-1)?.text ?? "";
  assert.match(continuationPrompt, /pi-goal-continuation:/);
  active.mock.rawPi.setActiveTools(["read", "bash"]);

  active.mock.events.get("before_agent_start")?.[0]?.({ prompt: continuationPrompt, systemPrompt: "base" }, active.ctx);

  assert.equal(lastGoalStatus(active.mock), "paused");
  assert.equal(aborts, 1);
});

describe("missing goal tools abort kickoff, resume, and active-edit prompts", () => {
  test("kickoff", async () => {
    let aborts = 0;
    const started = await startGoalForTest({ abort: () => aborts++ });
    const kickoffPrompt = started.mock.sentUserMessages.at(-1)?.text ?? "";
    started.mock.events.get("input")?.[0]?.(
      { source: "extension", text: kickoffPrompt, streamingBehavior: "followUp" },
      started.ctx,
    );
    started.mock.rawPi.setActiveTools(["read", "bash"]);

    started.mock.events.get("before_agent_start")?.[0]?.(
      { prompt: `transformed by an earlier extension\n\n${kickoffPrompt}`, systemPrompt: "base" },
      started.ctx,
    );

    assert.equal(lastGoalStatus(started.mock), "paused");
    assert.equal(aborts, 1);
  });

  test("resume", async () => {
    let aborts = 0;
    const resumed = restoreGoalForTest("paused", {}, { abort: () => aborts++ });
    await resumed.mock.commands.get("goal")?.handler("resume", resumed.ctx);
    const resumePrompt = resumed.mock.sentUserMessages.at(-1)?.text ?? "";
    resumed.mock.rawPi.setActiveTools(["read", "bash"]);

    resumed.mock.events.get("before_agent_start")?.[0]?.({ prompt: resumePrompt, systemPrompt: "base" }, resumed.ctx);

    assert.equal(lastGoalStatus(resumed.mock), "paused");
    assert.equal(aborts, 1);
  });

  test("active edit", async () => {
    let aborts = 0;
    const edited = await startGoalForTest({ abort: () => aborts++ });
    await edited.mock.commands.get("goal")?.handler("edit revised objective", edited.ctx);
    const editPrompt = edited.mock.sentUserMessages.at(-1)?.text ?? "";
    edited.mock.rawPi.setActiveTools(["read", "bash"]);

    edited.mock.events.get("before_agent_start")?.[0]?.({ prompt: editPrompt, systemPrompt: "base" }, edited.ctx);

    assert.equal(lastGoalStatus(edited.mock), "paused");
    assert.equal(aborts, 1);
  });
});

test("a later restrictive tool policy pauses the goal at agent_end without continuation", async () => {
  const mock = createMockPi({
    activeTools: ["read", "bash", "goal_complete", "goal_blocked", "goal_wait"],
  });
  registerGoal(mock.pi);
  const context = createMockContext();
  mock.events.get("session_start")?.[0]?.({}, context.ctx);
  await mock.commands.get("goal")?.handler("finish the work", context.ctx);

  const promptResult = mock.events.get("before_agent_start")?.[0]?.(
    { prompt: "continue work", systemPrompt: "base" },
    context.ctx,
  ) as { message?: { customType?: string } } | undefined;
  assert.equal(promptResult?.message?.customType, "goal-contract");
  mock.rawPi.setActiveTools(["read", "bash"]);
  mock.events.get("agent_end")?.[0]?.({ messages: [{ role: "assistant", stopReason: "stop" }] }, context.ctx);
  mock.events.get("agent_settled")?.[0]?.({}, context.ctx);

  assert.equal(lastGoalStatus(mock), "paused");
  assert.equal(mock.sentUserMessages.length, 1);
  assert.deepEqual(mock.rawPi.getActiveTools(), ["read", "bash"]);
});

test("restored active goal applies budget limits before unavailable-tool pauses", () => {
  for (const [tokensUsed, expectedStatus, expectedNotice] of [
    [5, "paused", /goal tools.*paused/i],
    [100, "budget_limited", /token budget reached/i],
  ] as const) {
    const sessionGoal: StoredGoal = {
      id: `restored-without-tools-${tokensUsed}`,
      text: "restore safely",
      status: "active",
      startedAt: 1,
      updatedAt: 2,
      iteration: 3,
      tokenBudget: 100,
      tokensUsed,
      timeUsedSeconds: 4,
      baselineTokens: 0,
    };
    const branch = [
      { type: "custom", customType: "goal-state", data: { goal: sessionGoal } },
      assistantUsageEntry({ totalTokens: tokensUsed }),
    ];
    const mock = createMockPi();
    registerGoal(mock.pi);
    mock.rawPi.setActiveTools([]);
    const originalSetActiveTools = mock.rawPi.setActiveTools.bind(mock.rawPi);
    mock.rawPi.setActiveTools = (names: string[]) => {
      originalSetActiveTools(names.filter((name) => !name.startsWith("goal_")));
    };
    const context = createMockContext({
      sessionManager: { getBranch: () => branch, getEntries: () => branch },
    });

    mock.events.get("session_start")?.[0]?.({}, context.ctx);

    assert.equal(lastGoalStatus(mock), expectedStatus);
    assert.equal(mock.sentUserMessages.length, 0);
    assert.match(context.notifications.at(-1)?.message ?? "", expectedNotice);
  }
});

test("stable Goal tools respect a restrictive policy when starting a goal", async () => {
  const mock = createMockPi();
  registerGoal(mock.pi);
  const context = createMockContext();
  mock.events.get("session_start")?.[0]?.({}, context.ctx);
  mock.rawPi.setActiveTools(["read", "bash"]);

  await mock.commands.get("goal")?.handler("finish the work", context.ctx);

  assert.equal(lastGoalStatus(mock), null);
  assert.equal(mock.sentUserMessages.length, 0);
  assert.deepEqual(mock.rawPi.getActiveTools(), ["read", "bash"]);
  assert.match(context.notifications.at(-1)?.message ?? "", /Cannot start \/goal/i);
});

test("failed replacement activation pauses an existing active goal without terminal tools", async () => {
  const existing = await startGoalForTest();
  existing.mock.rawPi.setActiveTools(["read", "bash"]);

  await existing.mock.commands.get("goal")?.handler("replacement objective", existing.ctx);

  const restored = requireLastGoal(existing.mock);
  assert.equal(restored.status, "paused");
  assert.equal(restored.text, "finish");
  assert.equal(existing.mock.sentUserMessages.length, 1);
  assert.match(existing.notifications.at(-1)?.message ?? "", /goal tools.*paused/i);
});

test("start fails without committing a goal when a required tool is inactive", async () => {
  const mock = createMockPi({ activeTools: ["read", "bash"] });
  registerGoal(mock.pi);
  const context = createMockContext();
  mock.events.get("session_start")?.[0]?.({}, context.ctx);
  mock.rawPi.setActiveTools(["read", "bash", "goal_complete"]);
  let activeToolWrites = 0;
  const setActiveTools = mock.rawPi.setActiveTools.bind(mock.rawPi);
  mock.rawPi.setActiveTools = (names) => {
    activeToolWrites += 1;
    setActiveTools(names);
  };

  await mock.commands.get("goal")?.handler("finish the work", context.ctx);
  assert.equal(lastGoalStatus(mock), null);
  assert.equal(mock.sentUserMessages.length, 0);
  assert.match(context.notifications.at(-1)?.message ?? "", /Cannot start \/goal/i);
  assert.equal(activeToolWrites, 0);
  assert.deepEqual(mock.rawPi.getActiveTools(), ["read", "bash", "goal_complete"]);
});

test("failed first prompt delivery preserves the stable tool set", async () => {
  const mock = createMockPi({ activeTools: ["read", "bash"] });
  registerGoal(mock.pi);
  const context = createMockContext();
  mock.events.get("session_start")?.[0]?.({}, context.ctx);

  const sendUserMessage = mock.rawPi.sendUserMessage.bind(mock.rawPi);
  mock.rawPi.sendUserMessage = () => {
    throw new Error("delivery failed");
  };
  await mock.commands.get("goal")?.handler("finish the work", context.ctx);
  assert.equal(lastGoalStatus(mock), null);
  assert.deepEqual(mock.rawPi.getActiveTools(), ["read", "bash", "goal_complete", "goal_blocked", "goal_wait"]);

  mock.rawPi.sendUserMessage = sendUserMessage;
  await mock.commands.get("goal")?.handler("finish the work again", context.ctx);
  assert.equal(lastGoalStatus(mock), "active");
  assert.deepEqual(mock.rawPi.getActiveTools(), ["read", "bash", "goal_complete", "goal_blocked", "goal_wait"]);
});

test("failed first prompt delivery preserves a preexisting external goal-tool set", async () => {
  const mock = createMockPi({
    activeTools: ["read", "bash", "goal_complete", "goal_blocked", "goal_wait"],
  });
  registerGoal(mock.pi);
  const context = createMockContext();
  mock.events.get("session_start")?.[0]?.({}, context.ctx);
  // Another extension exposes both terminal tools while pi-goal remains locked.
  mock.rawPi.setActiveTools(["read", "goal_complete", "goal_blocked", "goal_wait", "scrape"]);
  mock.rawPi.sendUserMessage = () => {
    throw new Error("delivery failed");
  };

  await mock.commands.get("goal")?.handler("finish the work", context.ctx);

  assert.equal(lastGoalStatus(mock), null);
  assert.deepEqual(mock.rawPi.getActiveTools(), ["read", "goal_complete", "goal_blocked", "goal_wait", "scrape"]);
});

describe("failed lazy reactivation deliveries restore the restrictive tool set", () => {
  test("stopped-goal replacement", async () => {
    const replaced = restoreGoalForTest("paused");
    const original = requireLastGoal(replaced.mock);
    replaced.mock.rawPi.setActiveTools(["read", "bash"]);
    replaced.mock.rawPi.sendUserMessage = () => {
      throw new Error("replacement delivery failed");
    };

    await replaced.mock.commands.get("goal")?.handler("replacement objective", replaced.ctx);

    assert.equal(requireLastGoal(replaced.mock).id, original.id);
    assert.equal(lastGoalStatus(replaced.mock), "paused");
    assert.deepEqual(replaced.mock.rawPi.getActiveTools(), ["read", "bash"]);
  });

  test("resume", async () => {
    const resumed = restoreGoalForTest("paused");
    const original = requireLastGoal(resumed.mock);
    resumed.mock.rawPi.setActiveTools(["read", "bash"]);
    resumed.mock.rawPi.sendUserMessage = () => {
      throw new Error("resume delivery failed");
    };

    await resumed.mock.commands.get("goal")?.handler("resume", resumed.ctx);

    assert.equal(requireLastGoal(resumed.mock).id, original.id);
    assert.equal(lastGoalStatus(resumed.mock), "paused");
    assert.deepEqual(resumed.mock.rawPi.getActiveTools(), ["read", "bash"]);
  });

  test("budget-increase edit", async () => {
    const edited = restoreGoalForTest("budget_limited");
    const original = requireLastGoal(edited.mock);
    edited.mock.rawPi.setActiveTools(["read", "bash"]);
    edited.mock.rawPi.sendUserMessage = () => {
      throw new Error("edit delivery failed");
    };

    await edited.mock.commands.get("goal")?.handler("edit --tokens 20 revised objective", edited.ctx);

    assert.equal(requireLastGoal(edited.mock).id, original.id);
    assert.equal(lastGoalStatus(edited.mock), "budget_limited");
    assert.deepEqual(edited.mock.rawPi.getActiveTools(), ["read", "bash"]);
  });
});

test("a stale first kickoff cannot run or roll back a newer replacement", async () => {
  const mock = createMockPi({ activeTools: ["read", "bash"] });
  registerGoal(mock.pi);
  let aborts = 0;
  const context = createMockContext({ abort: () => aborts++ });
  mock.events.get("session_start")?.[0]?.({}, context.ctx);
  const sentPrompts: string[] = [];
  let rejectFirstSend: ((error: Error) => void) | undefined;
  mock.rawPi.sendUserMessage = (prompt: string) => {
    sentPrompts.push(prompt);
    if (sentPrompts.length === 1) {
      return new Promise<void>((_resolve, reject) => {
        rejectFirstSend = reject;
      });
    }
  };

  const firstStart = mock.commands.get("goal")?.handler("first objective", context.ctx);
  await Promise.resolve();
  await mock.commands.get("goal")?.handler("replacement objective", context.ctx);
  const replacement = requireLastGoal(mock);
  assert.equal(replacement.text, "replacement objective");
  assert.equal(replacement.status, "active");

  assert.deepEqual(mock.events.get("input")?.[0]?.({ source: "extension", text: sentPrompts[0] }, context.ctx), {
    action: "handled",
  });
  assert.equal(mock.events.get("input")?.[0]?.({ source: "extension", text: sentPrompts[1] }, context.ctx), undefined);
  assert.equal(aborts, 0);
  assert.equal(requireLastGoal(mock).id, replacement.id);
  assert.equal(requireLastGoal(mock).status, "active");

  rejectFirstSend?.(new Error("late first delivery failure"));
  await firstStart;
  assert.equal(requireLastGoal(mock).id, replacement.id);
  assert.deepEqual(mock.rawPi.getActiveTools(), ["read", "bash", "goal_complete", "goal_blocked", "goal_wait"]);
});
