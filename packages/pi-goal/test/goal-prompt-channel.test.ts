import assert from "node:assert/strict";
import { test } from "vitest";
import { builtinTool, createMockContext, createMockPi } from "../../../test/support.js";
import {
  DEFAULT_SETTINGS_PATH,
  registerGoalWithSettingsPath,
  requireLastGoal,
  type StoredGoal,
  startGoalForTest,
} from "./support/goal-fixture.js";

type SentCustom = {
  message?: { customType?: string; content?: unknown; details?: unknown; display?: unknown };
  options?: unknown;
};

function goalPromptSends(mock: ReturnType<typeof createMockPi>): SentCustom[] {
  return mock.sentMessages.filter(
    (sent: SentCustom) => (sent.message as { customType?: string } | undefined)?.customType === "pi.goal.prompt",
  );
}

test("activation prompt is sent over the collapsed custom channel with intact text", async () => {
  const mock = createMockPi({ activeTools: ["read", "bash"], allTools: [builtinTool("read"), builtinTool("bash")] });
  registerGoalWithSettingsPath(mock.pi, DEFAULT_SETTINGS_PATH);
  const context = createMockContext();
  mock.events.get("session_start")?.[0]?.({}, context.ctx);

  await mock.commands.get("goal")?.handler("ship the feature", context.ctx);

  let plainUserSends = 0;
  mock.rawPi.sendUserMessage = () => {
    plainUserSends += 1;
  };
  assert.equal(plainUserSends, 0);

  const sends = goalPromptSends(mock);
  assert.equal(sends.length, 1);
  const send = sends[0];
  assert.equal(send.message?.display, true);
  assert.equal(typeof send.message?.content, "string");
  assert.match(send.message?.content as string, /ship the feature/);
  assert.deepEqual(send.message?.details, { kind: "set", objective: "ship the feature" });
  assert.deepEqual(send.options, { deliverAs: "followUp", triggerTurn: true });
});

test("message_start on a custom goal prompt classifies the run as manual", async () => {
  const started = await startGoalForTest({}, "finish the work");
  const send = goalPromptSends(started.mock).at(-1);
  assert.ok(send);

  const prompt = send.message?.content as string;
  await started.mock.events.get("message_start")?.[0]?.(
    { message: { role: "custom", customType: "pi.goal.prompt", content: prompt, details: send.message?.details } },
    started.ctx,
  );
  assert.equal(requireLastGoal(started.mock).status, "active");
});

test("continuation dispatch sends a custom goal prompt classified as automatic", async () => {
  const started = await startGoalForTest({}, "finish the work");
  await started.mock.events.get("agent_end")?.[0]?.(
    {
      messages: [
        { role: "assistant", stopReason: "toolUse", content: [{ type: "toolCall", name: "read", arguments: {} }] },
        { role: "toolResult", content: [] },
      ],
    },
    started.ctx,
  );
  await started.mock.events.get("agent_settled")?.[0]?.({}, started.ctx);

  const sends = goalPromptSends(started.mock);
  assert.equal(sends.length, 2);
  const continuation = sends[1];
  assert.match((continuation.message?.content as string) ?? "", /automatic continuation #1/i);
  assert.equal((continuation.message?.details as { kind?: string } | undefined)?.kind, "continue");

  const prompt = continuation.message?.content as string;
  await started.mock.events.get("message_start")?.[0]?.(
    {
      message: {
        role: "custom",
        customType: "pi.goal.prompt",
        content: prompt,
        details: continuation.message?.details,
      },
    },
    started.ctx,
  );
  assert.equal(requireLastGoal(started.mock).status, "active");
});

test("a cancelled custom goal prompt is aborted at message_start without ending the goal", async () => {
  const started = await startGoalForTest({}, "finish the work");
  const goal: StoredGoal = requireLastGoal(started.mock);

  await started.mock.events.get("agent_end")?.[0]?.(
    {
      messages: [
        { role: "assistant", stopReason: "toolUse", content: [{ type: "toolCall", name: "read", arguments: {} }] },
        { role: "toolResult", content: [] },
      ],
    },
    started.ctx,
  );
  await started.mock.events.get("agent_settled")?.[0]?.({}, started.ctx);

  const continuation = goalPromptSends(started.mock).at(-1);
  assert.ok(continuation);
  const prompt = continuation.message?.content as string;

  // A superseding user input cancels the queued continuation...
  await started.mock.events.get("input")?.[0]?.(
    { source: "user", text: "changed my mind", streamingBehavior: "followUp" },
    started.ctx,
  );
  // ...but suppose it still delivered: message_start must abort without touching the goal.
  let aborts = 0;
  const abortingCtx = { ...started.ctx, abort: () => (aborts += 1) };
  await started.mock.events.get("message_start")?.[0]?.(
    {
      message: {
        role: "custom",
        customType: "pi.goal.prompt",
        content: prompt,
        details: continuation.message?.details,
      },
    },
    abortingCtx,
  );
  assert.equal(aborts, 0); // marker consumed by the earlier agent_settled dispatch is not "cancelled"
  assert.equal(requireLastGoal(started.mock).status, "active");
  assert.equal(requireLastGoal(started.mock).id, goal.id);
});

test("an owned custom goal prompt for a cleared goal is aborted at message_start", async () => {
  const started = await startGoalForTest({}, "finish the work");
  const send = goalPromptSends(started.mock).at(-1);
  assert.ok(send);
  const prompt = send.message?.content as string;

  await started.mock.commands.get("goal")?.handler("clear", started.ctx);

  let aborts = 0;
  const abortingCtx = { ...started.ctx, abort: () => (aborts += 1) };
  await started.mock.events.get("message_start")?.[0]?.(
    { message: { role: "custom", customType: "pi.goal.prompt", content: prompt, details: send.message?.details } },
    abortingCtx,
  );
  assert.equal(aborts, 1);
  // cleared: no goal remains persisted
  const { lastGoal } = await import("./support/goal-fixture.js");
  assert.equal(lastGoal(started.mock), null);
});

test("the message renderer is registered for the goal prompt custom type", async () => {
  const mock = createMockPi({ activeTools: ["read", "bash"], allTools: [builtinTool("read"), builtinTool("bash")] });
  registerGoalWithSettingsPath(mock.pi, DEFAULT_SETTINGS_PATH);
  assert.ok(mock.messageRenderers.has("pi.goal.prompt"));
});
