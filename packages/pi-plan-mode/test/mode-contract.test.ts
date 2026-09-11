import assert from "node:assert/strict";
import { test } from "vitest";
import {
  createModeContractMessage,
  latestModeContract,
  MODE_CONTRACT_MESSAGE_TYPE,
  modeContractContent,
  reconcileModeContract,
} from "../src/mode-contract.js";

const user = (content: string) => ({ role: "user", content });

test("mode contracts are bounded, hidden, model-visible, and versioned", () => {
  for (const mode of ["plan", "normal"] as const) {
    const message = createModeContractMessage(mode, 42);
    assert.equal(message.role, "custom");
    assert.equal(message.customType, MODE_CONTRACT_MESSAGE_TYPE);
    assert.equal(message.display, false);
    assert.deepEqual(message.details, { version: 1, mode });
    assert.equal(message.timestamp, 42);
    assert.equal(message.content, modeContractContent(mode));
    assert.ok(message.content.length < 20_000);
    assert.match(message.content, /PI PLAN MODE CONTRACT v1/u);
  }
});

test("reconciliation leaves an effective retained contract byte-for-byte unchanged", () => {
  const messages = [user("A"), createModeContractMessage("plan", 10), user("B")];
  assert.equal(reconcileModeContract(messages, "plan"), messages);
  assert.deepEqual(latestModeContract(messages), { index: 1, mode: "plan" });
});

test("reconciliation inserts one deterministic fallback after leading summaries", () => {
  const messages = [{ role: "compactionSummary", summary: "Earlier planning" }, user("retained tail")];
  const once = reconcileModeContract(messages, "plan");
  assert.equal(once[0], messages[0]);
  assert.equal(latestModeContract(once)?.index, 1);
  assert.equal((once[1] as { timestamp?: number }).timestamp, 0);
  assert.deepEqual(reconcileModeContract(once, "plan"), once);
});

test("reconciliation overrides stale, opposite, and legacy artifacts at a stable boundary", () => {
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

  assert.deepEqual(latestModeContract(reconciled), { index: 3, mode: "normal" });
  assert.equal(reconciled[0], legacy);
  assert.equal(reconciled[1], stale);
  assert.equal(reconciled[2], opposite);
  assert.equal(reconciled[4], tail);
  assert.deepEqual(reconcileModeContract(reconciled, "normal"), reconciled);
});
