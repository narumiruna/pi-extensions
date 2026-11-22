import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "vitest";
import {
  createModeContractMessage,
  latestModeContract,
  MODE_CONTRACT_MESSAGE_TYPE,
  modeContractContent,
  modeContractFromMessage,
  reconcileModeContract,
} from "../src/mode-contract.js";

const user = (content: string) => ({ role: "user", content });

test("mode contracts are bounded, hidden, model-visible, and versioned", () => {
  for (const mode of ["plan", "normal"] as const) {
    const message = createModeContractMessage(mode, 42);
    assert.equal(message.role, "custom");
    assert.equal(message.customType, MODE_CONTRACT_MESSAGE_TYPE);
    assert.equal(message.display, false);
    const version = mode === "plan" ? 2 : 1;
    assert.deepEqual(message.details, { version, mode });
    assert.equal(message.timestamp, 42);
    assert.equal(message.content, modeContractContent(mode));
    assert.ok(message.content.length < 20_000);
    assert.match(message.content, new RegExp(`PI PLAN MODE CONTRACT v${version}`, "u"));
  }
});

test("reconciliation leaves an effective retained contract byte-for-byte unchanged", () => {
  const messages = [user("A"), createModeContractMessage("plan", 10), user("B")];
  assert.equal(reconcileModeContract(messages, "plan"), messages);
  assert.deepEqual(latestModeContract(messages), { index: 1, mode: "plan", version: 2 });
});

const preNativeMcpPlan = readFileSync(new URL("./fixtures/legacy-plan-contract.txt", import.meta.url), "utf8");
const nativeMcpPlan = preNativeMcpPlan.replace(
  /Non-built-in tools are denied by default[^\n]+/u,
  "Tools outside its reviewed core policy, including native MCP tools and orchestration tools, require explicit user opt-in at their own risk. Direct and model-only tools must be active; registered codemode or deferred tools can be selected without direct activation. Every nested call requires its own permission; selecting an orchestrator does not authorize its callees.",
);
for (const content of [preNativeMcpPlan, nativeMcpPlan]) {
  test(`the exact ${content === preNativeMcpPlan ? "pre-native-MCP" : "native-MCP"} v1 contract is retained before a tail upgrade`, () => {
    const legacy = { ...createModeContractMessage("plan", 10), details: { mode: "plan", version: 1 }, content };
    const messages = [
      createModeContractMessage("normal", 1),
      user("Earlier context"),
      legacy,
      user("Continue planning"),
    ];
    assert.deepEqual(latestModeContract(messages), { index: 2, mode: "plan", version: 1 });
    assert.equal(modeContractFromMessage({ type: "message", message: legacy }), "plan");
    assert.equal(modeContractFromMessage({ ...legacy, content: `${legacy.content}\nChanged instructions` }), undefined);
    const upgraded = reconcileModeContract(messages, "plan");
    assert.deepEqual(upgraded.slice(0, messages.length), messages);
    assert.deepEqual(upgraded.at(-1), createModeContractMessage("plan", 0));
    const next = [...upgraded, user("Another turn")];
    assert.equal(reconcileModeContract(next, "plan"), next);
  });
}

test("the Plan prompt separates full draft updates from standalone completion", () => {
  const { content } = createModeContractMessage("plan");
  assert.match(
    content,
    /plan_mode_update\(\{ plan \}\) with the full Markdown when there is no saved draft or the plan changes/u,
  );
  assert.match(content, /It replaces the entire draft/u);
  assert.match(
    content,
    /wait for the update to succeed\. Then call plan_mode_complete\(\{\}\) as the only tool call in a separate assistant message/u,
  );
  assert.match(content, /Do not pass arguments, call it from inside another tool/u);
  assert.match(content, /use the existing draft without resending it/u);
  assert.match(content, /Do not pass Markdown to plan_mode_complete or use a <proposed_plan> block/u);
});

test("reconciliation appends one deterministic fallback after all retained context", () => {
  const messages = [
    { role: "system", content: "Current instructions", timestamp: 0 },
    { role: "compactionSummary", summary: "Earlier planning" },
    user("retained tail"),
  ];
  const once = reconcileModeContract(messages, "plan");
  assert.equal(once[0], messages[0]);
  assert.equal(once[1], messages[1]);
  assert.equal(once[2], messages[2]);
  assert.equal(latestModeContract(once)?.index, 3);
  assert.deepEqual(once.at(-1), createModeContractMessage("plan", 0));
  assert.deepEqual(reconcileModeContract(once, "plan"), once);
});

test("reconciliation overrides stale, opposite, and legacy artifacts without changing the prefix", () => {
  const stale = {
    role: "custom",
    customType: MODE_CONTRACT_MESSAGE_TYPE,
    content: "[PI PLAN MODE CONTRACT v0: PLAN] stale",
    display: false,
  };
  const legacy = {
    role: "custom",
    customType: "plan-mode-context",
    content: "legacy repeated context",
    display: false,
  };
  const opposite = createModeContractMessage("plan", 10);
  const tail = user("Implement the plan.");
  const reconciled = reconcileModeContract([legacy, stale, opposite, tail], "normal");

  assert.deepEqual(latestModeContract(reconciled), { index: 4, mode: "normal", version: 1 });
  assert.deepEqual(reconciled.slice(0, -1), [legacy, stale, opposite, tail]);
  assert.deepEqual(reconcileModeContract(reconciled, "normal"), reconciled);
});
