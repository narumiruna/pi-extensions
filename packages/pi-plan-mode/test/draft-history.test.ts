import assert from "node:assert/strict";
import { convertToLlm } from "@earendil-works/pi-coding-agent";
import { test } from "vitest";
import { planModeCompleted, planModeUpdated } from "../src/completion-tool.js";
import { formatImplementationHandoff } from "../src/fresh-implementation.js";
import { createImplementationRetentionCoordinator } from "../src/implementation-retention.js";
import { MODEL_DRAFT_MESSAGE_TYPE, PLAN_DRAFT_PREVIEW_MESSAGE_TYPE } from "../src/message-transform.js";
import type { PlanModeState } from "../src/state.js";

const DRAFT = "# Draft\n\nDo not implement this obsolete change.";
const COMPLETE = "# Approved plan\n\n- Implement this exact plan.  \n- Preserve the Markdown hard break above.";
const planning: PlanModeState = { enabled: true, awaitingAction: false, draftPlan: DRAFT };
const normal: PlanModeState = { enabled: false, awaitingAction: false };
const implementation: PlanModeState = {
  ...normal,
  activeImplementation: { id: "approved", plan: COMPLETE, source: "plan_mode_complete", startedAt: 42 },
};

const user = { role: "user", content: "Investigate first." };
const readCall = { type: "toolCall", id: "read", name: "read", arguments: { path: "README.md" } };
const readResult = { role: "toolResult", toolCallId: "read", toolName: "read", content: "Read result." };
const updateCall = { type: "toolCall", id: "update", name: "plan_mode_update", arguments: { plan: DRAFT } };
const updateResult = {
  role: "toolResult",
  toolCallId: "update",
  toolName: "plan_mode_update",
  ...planModeUpdated(),
};
const draft = { role: "custom", customType: MODEL_DRAFT_MESSAGE_TYPE, content: DRAFT, display: false };
const preview = { role: "custom", customType: PLAN_DRAFT_PREVIEW_MESSAGE_TYPE, content: DRAFT, display: true };
const assistant = (...content: unknown[]) => ({ role: "assistant", content });
const pair = [
  assistant({ type: "toolCall", id: "complete", name: "plan_mode_complete", arguments: {} }),
  { role: "toolResult", toolCallId: "complete", toolName: "plan_mode_complete", ...planModeCompleted(COMPLETE) },
];

function providerMessages(messages: unknown[]) {
  return convertToLlm(messages as Parameters<typeof convertToLlm>[0]).map(({ role, content }) => ({ role, content }));
}

test("a draft preview does not change the provider-facing Plan mode prefix", () => {
  const coordinator = createImplementationRetentionCoordinator();
  const retained = [user, assistant(updateCall), updateResult, draft];
  const first = coordinator.transformContext(retained, planning).messages;
  const followUp = { role: "user", content: "Another constraint." };
  const second = coordinator.transformContext([...retained, preview, followUp], planning).messages;
  assert.deepEqual(providerMessages(first), providerMessages(retained));
  assert.deepEqual(providerMessages(second), [...providerMessages(first), ...providerMessages([followUp])]);
});

test("Normal and retained implementation requests remove draft snapshots and both sides of update calls", () => {
  const coordinator = createImplementationRetentionCoordinator();
  const text = { type: "text", text: "I checked the README." };
  const mixed = assistant(text, updateCall, readCall);
  const abandonedUpdate = { type: "message", message: assistant({ ...updateCall, id: "abandoned" }) };
  const messages = [user, mixed, updateResult, readResult, abandonedUpdate, draft, preview, ...pair];
  const original = structuredClone(messages);
  const expected = [user, assistant(text, readCall), readResult];
  assert.deepEqual(coordinator.transformContext(messages, normal).messages, expected);
  const handoff = { role: "user", content: formatImplementationHandoff(COMPLETE) };
  const retained = coordinator.transformContext([...messages, handoff], implementation).messages;
  assert.deepEqual(retained, [...expected, handoff]);
  assert.deepEqual(coordinator.transformContext(retained, implementation).messages, retained);
  assert.deepEqual(messages, original);
});

test("conversation-history implementation retains the exact successful completion pair, never a draft or failure", () => {
  const coordinator = createImplementationRetentionCoordinator();
  const kickoff = { role: "user", content: "Implement the plan." };
  const failed = [
    assistant({ type: "toolCall", id: "failed", name: "plan_mode_complete", arguments: {} }),
    { role: "toolResult", toolName: "plan_mode_complete", toolCallId: "failed", isError: true, content: "Error." },
  ];
  const draftHistory = [assistant(updateCall), updateResult, draft, preview, ...failed];
  assert.deepEqual(coordinator.transformContext([user, ...draftHistory, kickoff], normal).messages, [user, kickoff]);
  const retained = coordinator.transformContext([user, ...pair, ...draftHistory, kickoff], normal).messages;
  assert.deepEqual(retained, [user, ...pair, kickoff]);
  assert.deepEqual(coordinator.transformContext(retained, normal).messages, retained);
});
