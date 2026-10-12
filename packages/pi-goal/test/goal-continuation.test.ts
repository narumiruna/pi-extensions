import assert from "node:assert/strict";
import { test } from "vitest";
import { createMockPi } from "../../../test/support.js";
import {
  lastGoalStatus,
  registerGoal,
  requireGoalTool,
  requireLastGoal,
  STALE_GOAL_TOOL_REASON,
  startGoalForTest,
} from "./support/goal-fixture.js";

test("agent_settled dispatches one idle continuation after agent_end records intent", async () => {
  const settled = await startGoalForTest();

  await settled.mock.events.get("agent_end")?.[0]?.(
    { messages: [{ role: "assistant", stopReason: "stop" }] },
    settled.ctx,
  );
  assert.equal(settled.mock.sentUserMessages.length, 1);

  await settled.mock.events.get("agent_settled")?.[0]?.({}, settled.ctx);
  assert.equal(settled.mock.sentUserMessages.length, 2);
  assert.deepEqual(settled.mock.sentUserMessages.at(-1)?.options, {
    deliverAs: "followUp",
    triggerTurn: true,
  });
  assert.match(settled.mock.sentUserMessages.at(-1)?.text ?? "", /automatic continuation #1/i);

  await settled.mock.events.get("agent_settled")?.[0]?.({}, settled.ctx);
  assert.equal(settled.mock.sentUserMessages.length, 2);
});

test("agent_settled retains intent until idle and pending-message gates allow dispatch", async () => {
  let idle = false;
  let pending = true;
  const settled = await startGoalForTest({
    isIdle: () => idle,
    hasPendingMessages: () => pending,
  });

  await settled.mock.events.get("agent_end")?.[0]?.(
    { messages: [{ role: "assistant", stopReason: "stop" }] },
    settled.ctx,
  );
  await settled.mock.events.get("agent_settled")?.[0]?.({}, settled.ctx);
  assert.equal(settled.mock.sentUserMessages.length, 1);

  idle = true;
  await settled.mock.events.get("agent_settled")?.[0]?.({}, settled.ctx);
  assert.equal(settled.mock.sentUserMessages.length, 1);

  pending = false;
  await settled.mock.events.get("agent_settled")?.[0]?.({}, settled.ctx);
  assert.equal(settled.mock.sentUserMessages.length, 2);
});

test("failed settled dispatch retains intent for a later idle retry", async () => {
  const retried = await startGoalForTest();
  await retried.mock.events.get("agent_end")?.[0]?.(
    { messages: [{ role: "assistant", stopReason: "stop" }] },
    retried.ctx,
  );

  const sendUserMessage = retried.mock.rawPi.sendMessage.bind(retried.mock.rawPi);
  retried.mock.rawPi.sendMessage = () => {
    throw new Error("runtime unavailable");
  };
  await retried.mock.events.get("agent_settled")?.[0]?.({}, retried.ctx);
  assert.equal(retried.mock.sentUserMessages.length, 1);
  assert.match(retried.notifications.at(-1)?.message ?? "", /runtime unavailable/i);

  retried.mock.rawPi.sendMessage = sendUserMessage;
  await retried.mock.events.get("agent_settled")?.[0]?.({}, retried.ctx);
  assert.equal(retried.mock.sentUserMessages.length, 2);
});

test("new work supersedes an older continuation intent before it settles", async () => {
  const superseded = await startGoalForTest();
  await superseded.mock.events.get("agent_end")?.[0]?.(
    { messages: [{ role: "assistant", stopReason: "stop" }] },
    superseded.ctx,
  );

  superseded.mock.events.get("before_agent_start")?.[0]?.(
    { prompt: "queued user work", systemPrompt: "base" },
    superseded.ctx,
  );
  await superseded.mock.events.get("agent_settled")?.[0]?.({}, superseded.ctx);

  assert.equal(superseded.mock.sentUserMessages.length, 1);
});

test("newer work supersedes an accepted continuation delivery that lost the start race", async () => {
  const raced = await startGoalForTest();
  await raced.mock.events.get("agent_end")?.[0]?.({ messages: [{ role: "assistant", stopReason: "stop" }] }, raced.ctx);
  await raced.mock.events.get("agent_settled")?.[0]?.({}, raced.ctx);
  const staleContinuation = raced.mock.sentUserMessages.at(-1)?.text ?? "";

  raced.mock.events.get("before_agent_start")?.[0]?.(
    { prompt: "newer extension work", systemPrompt: "base" },
    raced.ctx,
  );
  assert.deepEqual(raced.mock.events.get("input")?.[0]?.({ source: "extension", text: staleContinuation }, raced.ctx), {
    action: "handled",
  });

  await raced.mock.events.get("agent_end")?.[0]?.({ messages: [{ role: "assistant", stopReason: "stop" }] }, raced.ctx);
  await raced.mock.events.get("agent_settled")?.[0]?.({}, raced.ctx);
  assert.equal(raced.mock.sentUserMessages.length, 3);
  assert.notEqual(raced.mock.sentUserMessages.at(-1)?.text, staleContinuation);
});

test("a stale continuation that crossed input cannot stop a replacement goal", async () => {
  let aborts = 0;
  const replaced = await startGoalForTest({ abort: () => aborts++ });
  await replaced.mock.events.get("agent_end")?.[0]?.(
    { messages: [{ role: "assistant", stopReason: "stop" }] },
    replaced.ctx,
  );
  await replaced.mock.events.get("agent_settled")?.[0]?.({}, replaced.ctx);
  const staleContinuation = replaced.mock.sentUserMessages.at(-1)?.text ?? "";
  const originalGoal = requireLastGoal(replaced.mock);

  await replaced.mock.commands.get("goal")?.handler("replacement objective", replaced.ctx);
  const replacement = requireLastGoal(replaced.mock);
  assert.notEqual(replacement.id, originalGoal.id);

  const staleResult = replaced.mock.events.get("before_agent_start")?.[0]?.(
    { prompt: staleContinuation, systemPrompt: "base" },
    replaced.ctx,
  );
  assert.equal(staleResult, undefined);
  assert.equal(aborts, 1);
  replaced.mock.events.get("agent_end")?.[0]?.(
    { messages: [{ role: "assistant", stopReason: "aborted" }] },
    replaced.ctx,
  );
  assert.equal(requireLastGoal(replaced.mock).id, replacement.id);
  assert.equal(lastGoalStatus(replaced.mock), "active");
});

test("pause aborts the current turn, blocks stale tools, and persists paused state", async () => {
  let pauseAborts = 0;
  const paused = await startGoalForTest({ abort: () => pauseAborts++ });
  await paused.mock.events.get("agent_end")?.[0]?.(
    { messages: [{ role: "assistant", stopReason: "stop" }] },
    paused.ctx,
  );
  await paused.mock.events.get("agent_settled")?.[0]?.({}, paused.ctx);
  const staleContinuation = paused.mock.sentUserMessages.at(-1)?.text ?? "";
  assert.match(staleContinuation, /pi-goal-continuation/);

  await paused.mock.commands.get("goal")?.handler("pause", paused.ctx);

  assert.equal(pauseAborts, 1);
  assert.equal(lastGoalStatus(paused.mock), "paused");
  assert.equal(paused.statuses.get("goal"), "paused · automatic 0/25");
  assert.deepEqual(
    paused.mock.events.get("input")?.[0]?.({ source: "extension", text: staleContinuation }, paused.ctx),
    { action: "handled" },
  );
  assert.deepEqual(
    paused.mock.events.get("tool_call")?.[0]?.({ toolName: "bash", toolCallId: "t1", input: {} }, paused.ctx),
    { block: true, reason: STALE_GOAL_TOOL_REASON },
  );
});

test("clear removes goal state without aborting or blocking stale tools", async () => {
  let clearAborts = 0;
  const cleared = await startGoalForTest({ abort: () => clearAborts++ });
  const beforeClearGoal = requireLastGoal(cleared.mock);
  await cleared.mock.events.get("agent_end")?.[0]?.(
    { messages: [{ role: "assistant", stopReason: "stop" }] },
    cleared.ctx,
  );
  await cleared.mock.events.get("agent_settled")?.[0]?.({}, cleared.ctx);
  const staleContinuation = cleared.mock.sentUserMessages.at(-1)?.text ?? "";
  assert.match(staleContinuation, /pi-goal-continuation/);

  await cleared.mock.commands.get("goal")?.handler("clear", cleared.ctx);

  assert.equal(clearAborts, 0);
  assert.equal(lastGoalStatus(cleared.mock), null);
  assert.equal(cleared.statuses.get("goal"), undefined);
  assert.deepEqual(
    cleared.mock.events.get("input")?.[0]?.({ source: "extension", text: staleContinuation }, cleared.ctx),
    { action: "handled" },
  );
  assert.equal(
    cleared.mock.events.get("tool_call")?.[0]?.({ toolName: "edit", toolCallId: "t-clear", input: {} }, cleared.ctx),
    undefined,
  );

  const tool = requireGoalTool(cleared.mock, "goal_complete");
  const staleCompletion = await tool.execute(
    "call-after-clear",
    { goal_id: beforeClearGoal.id, summary: "Implemented and verified." },
    new AbortController().signal,
    () => undefined,
    cleared.ctx,
  );

  assert.equal(staleCompletion.terminate, undefined);
  assert.match(staleCompletion.content?.[0]?.text ?? "", /no active goal/i);
});

test("clear releases stale tool-call block from a paused goal", async () => {
  let pauseAborts = 0;
  const paused = await startGoalForTest({ abort: () => pauseAborts++ });
  await paused.mock.events.get("agent_end")?.[0]?.(
    { messages: [{ role: "assistant", stopReason: "stop" }] },
    paused.ctx,
  );

  await paused.mock.commands.get("goal")?.handler("pause", paused.ctx);

  assert.equal(pauseAborts, 1);
  assert.equal(lastGoalStatus(paused.mock), "paused");
  assert.deepEqual(
    paused.mock.events.get("tool_call")?.[0]?.({ toolName: "bash", toolCallId: "t-paused", input: {} }, paused.ctx),
    { block: true, reason: STALE_GOAL_TOOL_REASON },
  );

  await paused.mock.commands.get("goal")?.handler("clear", paused.ctx);

  assert.equal(lastGoalStatus(paused.mock), null);
  assert.equal(paused.statuses.get("goal"), undefined);
  assert.equal(
    paused.mock.events.get("tool_call")?.[0]?.(
      { toolName: "bash", toolCallId: "t-after-clear", input: {} },
      paused.ctx,
    ),
    undefined,
  );
});

test("state changes between agent_end and agent_settled cancel stale continuation intent", async () => {
  for (const action of ["pause", "clear", "replace", "complete"] as const) {
    let aborts = 0;
    const changed = await startGoalForTest({ abort: () => aborts++ });
    const originalGoal = requireLastGoal(changed.mock);
    await changed.mock.events.get("agent_end")?.[0]?.(
      { messages: [{ role: "assistant", stopReason: "stop" }] },
      changed.ctx,
    );

    if (action === "pause" || action === "clear") {
      await changed.mock.commands.get("goal")?.handler(action, changed.ctx);
    } else if (action === "replace") {
      await changed.mock.commands.get("goal")?.handler("replacement objective", changed.ctx);
    } else {
      await requireGoalTool(changed.mock, "goal_complete").execute(
        "complete-before-settled",
        { goal_id: originalGoal.id, summary: "Implemented and verified." },
        new AbortController().signal,
        () => undefined,
        changed.ctx,
      );
    }

    const messagesBeforeSettled = changed.mock.sentUserMessages.length;
    await changed.mock.events.get("agent_settled")?.[0]?.({}, changed.ctx);
    assert.equal(
      changed.mock.sentUserMessages.length,
      messagesBeforeSettled,
      `${action} must not dispatch the stale continuation`,
    );
  }
});

test("lifecycle handlers ignore emits after session shutdown invalidated the context", async () => {
  const settled = await startGoalForTest();
  await settled.mock.events.get("agent_end")?.[0]?.(
    { messages: [{ role: "assistant", stopReason: "stop" }] },
    settled.ctx,
  );
  assert.equal(settled.mock.sentUserMessages.length, 1);
  settled.mock.events.get("session_shutdown")?.[0]?.({}, settled.ctx);

  const staleError = new Error(
    "This extension ctx is stale after session replacement or reload. Do not use a captured pi or command ctx after ctx.newSession(), ctx.fork(), ctx.switchSession(), or ctx.reload().",
  );
  let staleReads = 0;
  const staleCtx = new Proxy(
    {},
    {
      get() {
        staleReads += 1;
        throw staleError;
      },
    },
  ) as never;

  // Detached prompts keep emitting on the invalidated runner after /new,
  // /fork, /resume, /switch, or /reload. Every late emit must return before
  // touching the dead ctx.
  for (const name of [
    "session_before_compact",
    "session_compact",
    "input",
    "message_start",
    "context",
    "tool_call",
    "tool_execution_end",
    "before_agent_start",
    "agent_start",
    "turn_end",
    "agent_end",
    "agent_settled",
  ]) {
    for (const handler of settled.mock.events.get(name) ?? []) {
      await handler(
        {
          type: name,
          text: "stray input",
          source: "interactive",
          messages: [{ role: "assistant", stopReason: "stop" }],
          message: { role: "assistant", stopReason: "stop", content: [] },
        },
        staleCtx,
      );
    }
  }

  assert.equal(staleReads, 0);
  assert.equal(settled.mock.sentUserMessages.length, 1);
});

test("a stale context inside the /goal command resolves quietly", async () => {
  const staleError = new Error(
    "This extension ctx is stale after session replacement or reload. Do not use a captured pi or command ctx after ctx.newSession(), ctx.fork(), ctx.switchSession(), or ctx.reload().",
  );
  const staleCtx = new Proxy(
    {},
    {
      get() {
        throw staleError;
      },
    },
  ) as never;
  const mock = createMockPi();
  registerGoal(mock.pi);

  await mock.commands.get("goal")?.handler("resume", staleCtx);
  await mock.commands.get("goal")?.handler("show", staleCtx);

  const realError = new Proxy(
    {},
    {
      get() {
        throw new Error("boom");
      },
    },
  ) as never;
  await assert.rejects(async () => mock.commands.get("goal")?.handler("show", realError), /boom/);
});

test("failed continuation delivery does not rethrow through a stale notification target", async () => {
  const retried = await startGoalForTest();
  await retried.mock.events.get("agent_end")?.[0]?.(
    { messages: [{ role: "assistant", stopReason: "stop" }] },
    retried.ctx,
  );

  retried.mock.rawPi.sendMessage = () => {
    throw new Error("runtime unavailable");
  };
  const staleUi = retried.ctx as { ui: { notify: (message: string, level?: string) => void } };
  staleUi.ui.notify = () => {
    throw new Error("This extension ctx is stale after session replacement or reload. Do not use.");
  };

  await retried.mock.events.get("agent_settled")?.[0]?.({}, retried.ctx);
  assert.equal(retried.mock.sentUserMessages.length, 1);
});
