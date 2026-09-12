import assert from "node:assert/strict";
import { test } from "vitest";
import { createModeContractMessage } from "../src/mode-contract.js";
import planMode from "../src/plan-mode.js";
import { builtinTool, createMockContext, createMockPi } from "./support.js";

const PLAN = "# Branch-owned plan\n\n1. Restore this branch.";
const BASELINE = ["read", "bash", "edit", "write", "plan_mode_question", "plan_mode_complete"];

function stateEntry(data: Record<string, unknown>) {
  return { type: "custom", customType: "plan-mode-state", data };
}

function contractEntry(mode: "plan" | "normal") {
  const { role: _role, timestamp: _timestamp, ...message } = createModeContractMessage(mode, 10);
  return { type: "custom_message", ...message };
}

test("inactive state-only resume and reload leave ordinary context unchanged", async () => {
  const source = createMockPi({ activeTools: ["read"] });
  planMode(source.pi, { readSettings: async () => ({ kind: "missing" as const }) });
  const sourceContext = createMockContext();
  await source.events.get("session_start")?.[0]?.({ reason: "startup" }, sourceContext.ctx);
  await source.events.get("session_shutdown")?.[0]?.({ reason: "quit" }, sourceContext.ctx);
  const persisted = source.entries.at(-1);
  assert.ok(persisted);

  const branch = [{ type: "custom", ...persisted }];
  const sessionManager = {
    getBranch: () => branch,
    getEntries: () => branch,
  };
  const resumed = createMockPi({ activeTools: ["read"] });
  planMode(resumed.pi, { readSettings: async () => ({ kind: "missing" as const }) });
  const resumedContext = createMockContext({ sessionManager });
  const contextHook = resumed.events.get("context")?.[0];
  assert.ok(contextHook);
  const messages = [{ role: "user", content: "ordinary request" }];

  for (const reason of ["resume", "reload"] as const) {
    await resumed.events.get("session_start")?.[0]?.({ reason }, resumedContext.ctx);
    const transformed = (await contextHook({ messages }, resumedContext.ctx)) as {
      messages: unknown[];
    };
    assert.deepEqual(transformed.messages, messages, reason);
  }
});

test("internal mode contracts cannot be selected as tree navigation targets", async () => {
  const contract = contractEntry("plan");
  const ordinary = { type: "message", message: { role: "assistant" } };
  const sessionManager = {
    getBranch: () => [],
    getEntries: () => [],
    getEntry: (id: string) => (id === "contract" ? contract : ordinary),
  };
  const mock = createMockPi({ activeTools: ["read"] });
  planMode(mock.pi, { readSettings: async () => ({ kind: "missing" as const }) });
  const context = createMockContext({ hasUI: true, sessionManager });
  await mock.events.get("session_start")?.[0]?.({ reason: "startup" }, context.ctx);
  await mock.commands.get("plan")?.handler("start", context.ctx);
  const stateEntriesBefore = mock.entries.length;
  const beforeTree = mock.events.get("session_before_tree")?.[0];
  assert.ok(beforeTree);

  const blocked = await beforeTree(
    { preparation: { targetId: "contract" }, signal: new AbortController().signal },
    context.ctx,
  );
  assert.deepEqual(blocked, { cancel: true });
  assert.equal(mock.entries.length, stateEntriesBefore);
  assert.equal(context.statuses.get("plan-mode"), "plan active");
  assert.match(context.notifications.at(-1)?.message ?? "", /transition markers are internal/u);

  const allowed = await beforeTree(
    { preparation: { targetId: "ordinary" }, signal: new AbortController().signal },
    context.ctx,
  );
  assert.equal(allowed, undefined);
});

test("manual tree navigation restores branch-owned mode state without changing the tool envelope", async () => {
  const branch: unknown[] = [];
  const sessionManager = {
    getBranch: () => branch,
    getEntries: () => branch,
  };
  const mock = createMockPi({
    activeTools: ["read", "bash", "edit", "write"],
    allTools: [builtinTool("read"), builtinTool("bash"), builtinTool("edit"), builtinTool("write")],
    thinkingLevel: "low",
  });
  planMode(mock.pi, {
    readSettings: async () => ({
      kind: "loaded" as const,
      settings: { thinkingLevel: "medium" as const },
    }),
  });
  const context = createMockContext({ sessionManager });
  await mock.events.get("session_start")?.[0]?.({ reason: "startup" }, context.ctx);
  const tree = mock.events.get("session_tree")?.[0];
  assert.ok(tree);
  assert.deepEqual(mock.rawPi.getActiveTools(), [
    "read",
    "bash",
    "edit",
    "write",
    "plan_mode_question",
    "plan_mode_complete",
  ]);

  branch.splice(
    0,
    branch.length,
    contractEntry("plan"),
    stateEntry({
      enabled: true,
      awaitingAction: false,
      previousThinkingLevel: "low",
      appliedThinkingLevel: "medium",
    }),
  );
  await tree({}, context.ctx);
  assert.equal(context.statuses.get("plan-mode"), "plan active");
  assert.equal(mock.thinkingLevel, "medium");
  assert.deepEqual(mock.rawPi.getActiveTools(), BASELINE);

  branch.splice(
    0,
    branch.length,
    contractEntry("normal"),
    stateEntry({
      enabled: false,
      awaitingAction: false,
      savedPlan: { plan: PLAN, source: "plan_mode_complete" },
    }),
  );
  await tree({}, context.ctx);
  assert.equal(context.statuses.get("plan-mode"), "plan saved");
  assert.equal(mock.thinkingLevel, "low");
  assert.deepEqual(mock.rawPi.getActiveTools(), BASELINE);

  branch.splice(
    0,
    branch.length,
    contractEntry("normal"),
    stateEntry({
      enabled: false,
      awaitingAction: false,
      activeImplementation: {
        id: "branch-implementation",
        plan: PLAN,
        source: "plan_mode_complete",
        startedAt: 42,
        retention: "keep",
      },
    }),
  );
  await tree({}, context.ctx);
  assert.equal(context.statuses.get("plan-mode"), "plan implementing");
  assert.deepEqual(mock.rawPi.getActiveTools(), BASELINE);

  branch.splice(0, branch.length);
  await tree({}, context.ctx);
  assert.equal(context.statuses.get("plan-mode"), undefined);
  assert.equal(context.widgets.get("plan-mode-plan"), undefined);
  assert.equal(mock.thinkingLevel, "low");
  assert.deepEqual(mock.rawPi.getActiveTools(), BASELINE);
  assert.equal(mock.sentUserMessages.length, 0);
  assert.equal(mock.sentMessages.length, 0);
});

test("failed inline kickoff publishes a Normal rollback contract and restores inactive state", async () => {
  const mock = createMockPi({ activeTools: ["read", "write"] });
  mock.rawPi.sendUserMessage = () => {
    throw new Error("kickoff failed");
  };
  planMode(mock.pi);
  const context = createMockContext({ mode: "tui", hasUI: true });

  await mock.commands.get("plan")?.handler("plan a rollback", context.ctx);

  assert.equal(context.statuses.get("plan-mode"), undefined);
  assert.equal(mock.sentMessages.length, 2);
  assert.match(JSON.stringify(mock.sentMessages[0]?.message), /CONTRACT v1: PLAN/u);
  assert.match(JSON.stringify(mock.sentMessages[1]?.message), /CONTRACT v1: NORMAL/u);
  assert.equal((mock.entries.at(-1)?.data as { enabled?: boolean } | undefined)?.enabled, false);
  assert.match(context.notifications.at(-1)?.message ?? "", /kickoff failed/u);
});
