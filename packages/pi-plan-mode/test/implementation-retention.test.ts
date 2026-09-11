import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import planMode from "../src/plan-mode.js";
import type { ImplementationPlanRetention } from "../src/settings.js";
import { restorePlanModeState } from "../src/state.js";
import { createMockContext, createMockPi } from "./support.js";

const PLAN = "# Retained plan\n\n1. Keep the complete handoff.";
const STATE_ENTRY_TYPE = "plan-mode-state";

function stateEntry(data: Record<string, unknown>) {
  return { type: "custom", customType: STATE_ENTRY_TYPE, data };
}

function latestState(mock: ReturnType<typeof createMockPi>) {
  return mock.entries.at(-1)?.data as {
    activeImplementation?: {
      id: string;
      plan: string;
      retention?: ImplementationPlanRetention;
    };
  };
}

async function beginImplementation(retention: ImplementationPlanRetention) {
  const mock = createMockPi({ activeTools: ["read", "edit"] });
  planMode(mock.pi, {
    readSettings: async () => ({
      kind: "loaded" as const,
      settings: {
        thinkingLevel: "inherit" as const,
        implementationPlanRetention: retention,
      },
    }),
  });
  const context = createMockContext();
  await mock.events.get("session_start")?.[0]?.({}, context.ctx);
  await mock.commands.get("plan")?.handler("start", context.ctx);
  const complete = mock.tools.find((tool) => tool.name === "plan_mode_complete")?.execute as
    | ((...args: unknown[]) => Promise<unknown>)
    | undefined;
  assert.ok(complete);
  await complete("complete", { plan: PLAN }, undefined, undefined, context.ctx);
  await mock.commands.get("plan")?.handler("implement", context.ctx);
  return { mock, context, handoff: mock.sentUserMessages.at(-1)?.text ?? "" };
}

test("active implementation state captures retention and legacy state restores as keep", () => {
  const legacy = restorePlanModeState(
    [
      stateEntry({
        enabled: false,
        awaitingAction: false,
        activeImplementation: {
          id: "legacy-implementation",
          plan: PLAN,
          source: "plan_mode_complete",
          startedAt: 42,
        },
      }),
    ],
    STATE_ENTRY_TYPE,
  );
  assert.equal(legacy.activeImplementation?.retention, "keep");

  const explicit = restorePlanModeState(
    [
      stateEntry({
        enabled: false,
        awaitingAction: false,
        activeImplementation: {
          id: "implementation-1",
          plan: PLAN,
          source: "plan_mode_complete",
          startedAt: 42,
          retention: "clear-after-first-run",
        },
      }),
    ],
    STATE_ENTRY_TYPE,
  );
  assert.equal(explicit.activeImplementation?.retention, "clear-after-first-run");
});

test("keep leaves the accepted plan active after context and settlement", async () => {
  const { mock, context, handoff } = await beginImplementation("keep");
  assert.equal(latestState(mock).activeImplementation?.retention, "keep");
  const transformed = (await mock.events.get("context")?.[0]?.(
    { messages: [{ role: "user", content: handoff }] },
    context.ctx,
  )) as { messages: Array<{ content?: unknown }> };
  assert.match(JSON.stringify(transformed.messages), /Retained plan/);
  await mock.events.get("agent_settled")?.[0]?.({}, context.ctx);
  assert.equal(latestState(mock).activeImplementation?.retention, "keep");
  assert.equal(context.statuses.get("plan-mode"), "plan implementing");
});

test("conversation-history implementation uses a short prompt without active-plan injection", async () => {
  const { mock, context, handoff } = await beginImplementation("clear-on-start");
  const contextHook = mock.events.get("context")?.[0];
  assert.ok(contextHook);
  assert.equal(handoff, "Implement the plan.");
  assert.equal(latestState(mock).activeImplementation, undefined);
  assert.equal(context.statuses.get("plan-mode"), undefined);

  const older = (await contextHook({ messages: [{ role: "user", content: "Older queued work" }] }, context.ctx)) as {
    messages: unknown[];
  };
  assert.doesNotMatch(JSON.stringify(older.messages), /Retained plan/);

  const planCall = {
    role: "assistant",
    content: [
      {
        type: "toolCall",
        id: "complete-plan",
        name: "plan_mode_complete",
        arguments: { plan: PLAN },
      },
    ],
  };
  const planResult = {
    role: "toolResult",
    toolCallId: "complete-plan",
    toolName: "plan_mode_complete",
    content: [{ type: "text", text: `**Proposed Plan**\n\n${PLAN}` }],
    details: { version: 1, source: "plan_mode_complete", plan: PLAN },
  };
  const messages = [planCall, planResult, { role: "user", content: handoff }];
  for (let call = 0; call < 2; call += 1) {
    const transformed = (await contextHook({ messages }, context.ctx)) as { messages: unknown[] };
    assert.match(JSON.stringify(transformed.messages[0]), /CONTRACT v1: NORMAL/u);
    assert.deepEqual(transformed.messages.slice(1), messages);
    assert.doesNotMatch(JSON.stringify(transformed.messages), /plan-mode-implementation-context/);
  }
  await mock.events.get("agent_settled")?.[0]?.({}, context.ctx);
  assert.equal(latestState(mock).activeImplementation, undefined);
});

test("conversation-history context keeps only the latest completed plan before kickoff", async () => {
  const mock = createMockPi({ activeTools: ["read", "edit"] });
  planMode(mock.pi);
  const context = createMockContext();
  const contextHook = mock.events.get("context")?.[0];
  assert.ok(contextHook);
  const completion = (id: string, plan: string) => [
    {
      role: "assistant",
      content: [{ type: "toolCall", id, name: "plan_mode_complete", arguments: { plan } }],
    },
    {
      role: "toolResult",
      toolCallId: id,
      toolName: "plan_mode_complete",
      content: [{ type: "text", text: `**Proposed Plan**\n\n${plan}` }],
      details: { version: 1, source: "plan_mode_complete", plan },
    },
  ];
  const oldCompletion = completion("old-plan", "# Old plan");
  const duplicateCurrentCall = {
    role: "assistant",
    content: [
      {
        type: "toolCall",
        id: "current-plan",
        name: "plan_mode_complete",
        arguments: { plan: "# Corrupt duplicate" },
      },
    ],
  };
  const currentCompletion = completion("current-plan", PLAN);
  const kickoff = { role: "user", content: "Implement the plan." };
  const transformed = (await contextHook(
    { messages: [...oldCompletion, duplicateCurrentCall, ...currentCompletion, kickoff] },
    context.ctx,
  )) as { messages: unknown[] };

  assert.deepEqual(transformed.messages, [...currentCompletion, kickoff]);
});

test("conversation-history context does not revive plans across user or summary boundaries", async () => {
  const mock = createMockPi({ activeTools: ["read", "edit"] });
  planMode(mock.pi);
  const context = createMockContext();
  const contextHook = mock.events.get("context")?.[0];
  assert.ok(contextHook);
  const planCall = {
    role: "assistant",
    content: [{ type: "toolCall", id: "complete-plan", name: "plan_mode_complete", arguments: {} }],
  };
  const planResult = {
    role: "toolResult",
    toolCallId: "complete-plan",
    toolName: "plan_mode_complete",
    content: [{ type: "text", text: PLAN }],
  };
  const kickoff = { role: "user", content: "Implement the plan." };
  const completedWork = { role: "assistant", content: "Implementation finished." };
  const unrelated = { role: "user", content: "Do unrelated work." };
  const laterKickoff = { role: "user", content: "Implement the plan." };
  const afterUserBoundary = (await contextHook(
    { messages: [planCall, planResult, unrelated, completedWork, laterKickoff] },
    context.ctx,
  )) as { messages: unknown[] };
  assert.deepEqual(afterUserBoundary.messages, [unrelated, completedWork, laterKickoff]);

  const followUp = { role: "user", content: "Continue with verification." };
  const naturalHistory = (await contextHook(
    { messages: [planCall, planResult, kickoff, completedWork, followUp] },
    context.ctx,
  )) as { messages: unknown[] };
  assert.deepEqual(naturalHistory.messages, [planCall, planResult, kickoff, completedWork, followUp]);

  const summary = { role: "compactionSummary", summary: "The older plan is summarized." };
  const afterSummaryBoundary = (await contextHook(
    { messages: [planCall, planResult, summary, laterKickoff] },
    context.ctx,
  )) as { messages: unknown[] };
  assert.deepEqual(afterSummaryBoundary.messages, [summary, laterKickoff]);
});

test("conversation-history context drops orphaned completion results", async () => {
  const mock = createMockPi({ activeTools: ["read", "edit"] });
  planMode(mock.pi);
  const context = createMockContext();
  const contextHook = mock.events.get("context")?.[0];
  assert.ok(contextHook);
  const orphanedResult = {
    role: "toolResult",
    toolCallId: "missing-call",
    toolName: "plan_mode_complete",
    content: [{ type: "text", text: PLAN }],
  };
  const kickoff = { role: "user", content: "Implement the plan." };
  const transformed = (await contextHook({ messages: [orphanedResult, kickoff] }, context.ctx)) as {
    messages: unknown[];
  };

  assert.deepEqual(transformed.messages, [kickoff]);
});

test("conversation-history context preserves a legacy proposed plan without reinjection", async () => {
  const mock = createMockPi({ activeTools: ["read", "edit"] });
  planMode(mock.pi);
  const context = createMockContext();
  const contextHook = mock.events.get("context")?.[0];
  assert.ok(contextHook);
  const proposedPlan = {
    role: "assistant",
    content: `<proposed_plan>\n${PLAN}\n</proposed_plan>`,
  };
  const kickoff = { role: "user", content: "Implement the plan." };
  const transformed = (await contextHook({ messages: [proposedPlan, kickoff] }, context.ctx)) as {
    messages: unknown[];
  };

  assert.deepEqual(transformed.messages, [proposedPlan, kickoff]);
  assert.doesNotMatch(JSON.stringify(transformed.messages), /plan-mode-implementation-context/);
});

test("first-run ignores older settlement and clears only after its handoff context settles", async () => {
  const { mock, context, handoff } = await beginImplementation("clear-after-first-run");
  await mock.events.get("agent_settled")?.[0]?.({}, context.ctx);
  assert.equal(latestState(mock).activeImplementation?.retention, "clear-after-first-run");

  const contextHook = mock.events.get("context")?.[0];
  assert.ok(contextHook);
  const firstImplementationContext = (await contextHook(
    { messages: [{ role: "user", content: handoff }] },
    context.ctx,
  )) as { messages: unknown[] };
  assert.match(JSON.stringify(firstImplementationContext.messages), /Retained plan/);
  assert.equal(context.statuses.get("plan-mode"), "plan implementing");
  await mock.events.get("agent_end")?.[0]?.({ messages: [] }, context.ctx);
  assert.equal(latestState(mock).activeImplementation?.retention, "clear-after-first-run");

  await mock.events.get("agent_settled")?.[0]?.({}, context.ctx);
  assert.equal(latestState(mock).activeImplementation, undefined);
  assert.equal(context.statuses.get("plan-mode"), undefined);
});

test("an armed older implementation cannot clear a superseding implementation", async () => {
  const { mock, context, handoff } = await beginImplementation("clear-after-first-run");
  const contextHook = mock.events.get("context")?.[0];
  assert.ok(contextHook);
  await contextHook({ messages: [{ role: "user", content: handoff }] }, context.ctx);
  const firstId = latestState(mock).activeImplementation?.id;

  await mock.commands.get("plan")?.handler("start", context.ctx);
  const complete = mock.tools.find((tool) => tool.name === "plan_mode_complete")?.execute as
    | ((...args: unknown[]) => Promise<unknown>)
    | undefined;
  assert.ok(complete);
  await complete("replacement", { plan: "# Replacement plan" }, undefined, undefined, context.ctx);
  await mock.commands.get("plan")?.handler("implement", context.ctx);
  const secondId = latestState(mock).activeImplementation?.id;
  assert.notEqual(secondId, firstId);

  await mock.events.get("agent_settled")?.[0]?.({}, context.ctx);
  assert.equal(latestState(mock).activeImplementation?.id, secondId);
  const secondHandoff = mock.sentUserMessages.at(-1)?.text ?? "";
  await contextHook({ messages: [{ role: "user", content: secondHandoff }] }, context.ctx);
  await mock.events.get("agent_settled")?.[0]?.({}, context.ctx);
  assert.equal(latestState(mock).activeImplementation, undefined);
});

test("Implement menus preview each configured retention outcome before confirmation", async () => {
  for (const [retention, preview] of [
    ["clear-on-start", "Off; use conversation history only"],
    ["clear-after-first-run", "Through the first implementation run"],
    ["keep", "Until /plan exit"],
  ] as const) {
    let menuTitle = "";
    const mock = createMockPi({ activeTools: ["read"] });
    planMode(mock.pi, {
      readSettings: async () => ({
        kind: "loaded" as const,
        settings: {
          thinkingLevel: "inherit" as const,
          implementationPlanRetention: retention,
        },
      }),
    });
    const context = createMockContext({
      hasUI: true,
      select: async (title: string) => {
        menuTitle = title;
        return "Stay in Plan mode";
      },
    });
    await mock.events.get("session_start")?.[0]?.({}, context.ctx);
    await mock.commands.get("plan")?.handler("start", context.ctx);
    const complete = mock.tools.find((tool) => tool.name === "plan_mode_complete")?.execute as
      | ((...args: unknown[]) => Promise<unknown>)
      | undefined;
    assert.ok(complete);
    await complete("complete", { plan: PLAN }, undefined, undefined, context.ctx);
    await mock.events.get("agent_settled")?.[0]?.({}, context.ctx);
    assert.match(menuTitle, new RegExp(preview.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "i"));
  }
});

test("changing Settings does not retroactively change an active implementation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-plan-retention-settings-"));
  const settingsPath = join(directory, "pi-plan-mode.json");
  try {
    const mock = createMockPi({ activeTools: ["read", "edit"] });
    planMode(mock.pi, {
      settingsPath,
      readSettings: async () => ({
        kind: "loaded" as const,
        settings: {
          thinkingLevel: "inherit" as const,
          implementationPlanRetention: "keep" as const,
        },
      }),
    });
    let openedSettings = false;
    let changedSetting = false;
    const context = createMockContext({
      hasUI: true,
      select: async (_title: string, options: string[]) => {
        if (options.includes("Settings")) {
          if (openedSettings) return undefined;
          openedSettings = true;
          return "Settings";
        }
        if (changedSetting) return undefined;
        changedSetting = true;
        return options.find((option) => option.startsWith("Plan reinjection"));
      },
    });
    await mock.events.get("session_start")?.[0]?.({}, context.ctx);
    await mock.commands.get("plan")?.handler("start", context.ctx);
    const complete = mock.tools.find((tool) => tool.name === "plan_mode_complete")?.execute as
      | ((...args: unknown[]) => Promise<unknown>)
      | undefined;
    assert.ok(complete);
    await complete("complete", { plan: PLAN }, undefined, undefined, context.ctx);
    await mock.commands.get("plan")?.handler("implement", context.ctx);
    assert.equal(latestState(mock).activeImplementation?.retention, "keep");

    await mock.commands.get("plan")?.handler("", context.ctx);
    assert.equal(
      (
        JSON.parse(await readFile(settingsPath, "utf8")) as {
          implementationPlanRetention?: string;
        }
      ).implementationPlanRetention,
      "clear-on-start",
    );
    assert.equal(latestState(mock).activeImplementation?.retention, "keep");
    const handoff = mock.sentUserMessages.at(-1)?.text ?? "";
    await mock.events.get("context")?.[0]?.({ messages: [{ role: "user", content: handoff }] }, context.ctx);
    await mock.events.get("agent_settled")?.[0]?.({}, context.ctx);
    assert.equal(latestState(mock).activeImplementation?.retention, "keep");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("restored cleanup policies re-arm safely in the replacement session", async () => {
  for (const retention of ["clear-on-start", "clear-after-first-run"] as const) {
    const restoredEntry = stateEntry({
      enabled: false,
      awaitingAction: false,
      activeImplementation: {
        id: `restored-${retention}`,
        plan: PLAN,
        source: "plan_mode_complete",
        startedAt: 42,
        retention,
      },
    });
    const mock = createMockPi({ activeTools: ["read", "edit"] });
    planMode(mock.pi);
    const context = createMockContext({
      sessionManager: {
        getBranch: () => [restoredEntry],
        getEntries: () => [restoredEntry],
      },
    });
    await mock.events.get("session_start")?.[0]?.({ reason: "resume" }, context.ctx);
    const transformed = (await mock.events.get("context")?.[0]?.(
      { messages: [{ role: "user", content: "Continue after resume" }] },
      context.ctx,
    )) as { messages: unknown[] };
    assert.match(JSON.stringify(transformed.messages), /Retained plan/);
    if (retention === "clear-after-first-run") {
      assert.equal(context.statuses.get("plan-mode"), "plan implementing");
      await mock.events.get("agent_settled")?.[0]?.({}, context.ctx);
    }
    assert.equal(latestState(mock).activeImplementation, undefined);
    assert.equal(context.statuses.get("plan-mode"), undefined);
  }
});

test("manual exit clears every retention policy before its automatic boundary", async () => {
  for (const retention of ["keep", "clear-on-start", "clear-after-first-run"] as const) {
    const { mock, context } = await beginImplementation(retention);
    await mock.commands.get("plan")?.handler("exit", context.ctx);
    assert.equal(latestState(mock).activeImplementation, undefined);
    assert.equal(context.statuses.get("plan-mode"), undefined);
  }
});
