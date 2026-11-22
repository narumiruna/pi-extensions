import assert from "node:assert/strict";
import { type AssistantMessage, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import type { ExtensionRunner, MessageEndEvent, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { createMockPi as createBaseMockPi } from "../../../test/support.js";
import { restorePlanModeState } from "../src/state.js";

export {
  builtinTool,
  createCustomSelectorHarness,
  createMockContext,
  driveCustomSelector,
  extensionTool,
} from "../../../test/support.js";

const PLAN_HELPERS = ["plan_mode_question", "plan_mode_update", "plan_mode_complete"];

export function restoreMockPlanModeState(
  mock: Pick<ReturnType<typeof createBaseMockPi>, "entries">,
  branch: unknown[],
) {
  return restorePlanModeState(
    [...branch, ...mock.entries.map((entry) => ({ type: "custom", ...entry }))],
    "plan-mode-state",
  );
}

export function createMockPi(options: Parameters<typeof createBaseMockPi>[0] = {}) {
  return createBaseMockPi({
    ...options,
    activeTools: [...new Set([...(options.activeTools ?? []), ...PLAN_HELPERS])],
  });
}

export function planCompletionMessages(plan: string, callId = "complete") {
  return [
    fauxAssistantMessage(fauxToolCall("plan_mode_update", { plan }, { id: `${callId}-update` })),
    fauxAssistantMessage(fauxToolCall("plan_mode_complete", {}, { id: callId })),
  ] as const;
}

async function runPlanCompletion(
  plan: string,
  callId: string,
  messageEnd: (event: MessageEndEvent) => Promise<unknown>,
  execute: (name: string, id: string, args: Record<string, unknown>) => ReturnType<ToolDefinition["execute"]>,
) {
  const [update, complete] = planCompletionMessages(plan, callId);
  async function dispatch(message: AssistantMessage) {
    const call = message.content[0];
    assert.ok(call?.type === "toolCall");
    await messageEnd({ type: "message_end", message });
    return execute(call.name, call.id, call.arguments);
  }
  const updateResult = await dispatch(update);
  assert.notEqual(updateResult.terminate, true, "a draft update must not end the turn");
  return dispatch(complete);
}

export function updateThenCompletePlan(
  mock: ReturnType<typeof createMockPi>,
  ctx: unknown,
  plan: string,
  callId = "complete",
) {
  return runPlanCompletion(
    plan,
    callId,
    async (event) => {
      for (const handler of mock.events.get("message_end") ?? []) await handler(event, ctx);
    },
    (name, id, args) => {
      const tool = mock.tools.find((candidate) => candidate.name === name);
      assert.ok(tool && typeof tool.execute === "function", `${name} must be registered`);
      return tool.execute(id, args, undefined, undefined, ctx);
    },
  );
}

export function updateThenCompletePlanInRunner(runner: ExtensionRunner, plan: string, callId = "complete") {
  const signal = new AbortController().signal;
  return runPlanCompletion(
    plan,
    callId,
    (event) => runner.emitMessageEnd(event),
    (name, id, args) => {
      const tool = runner.getToolDefinition(name);
      assert.ok(tool, `${name} must be registered`);
      return tool.execute(id, args, signal, undefined, runner.createToolContext(id, signal));
    },
  );
}
