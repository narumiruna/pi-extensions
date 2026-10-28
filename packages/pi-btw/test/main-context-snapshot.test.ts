import assert from "node:assert/strict";
import type { AssistantMessage, ToolResultMessage } from "@earendil-works/pi-ai";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { test } from "vitest";
import {
  buildMainContextSnapshot,
  captureMainContextSource,
  validateMainContextSnapshot,
} from "../src/main-context-snapshot.js";

function assistant(text: string, stopReason: AssistantMessage["stopReason"] = "stop"): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    stopReason,
    timestamp: 1,
    api: "anthropic-messages",
    provider: "test",
    model: "side",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  };
}
function user(manager: SessionManager, text: string) {
  return manager.appendMessage({ role: "user", content: text, timestamp: 1 });
}

test("captures an empty root and imports finalized descendants without mutating the main tree", () => {
  const manager = SessionManager.inMemory();
  const { anchor, conversationContext } = captureMainContextSource(manager);
  assert.equal(anchor?.entryId, null);
  assert.equal(conversationContext, "");
  assert.equal(buildMainContextSnapshot(manager, anchor).kind, "empty");
  user(manager, "C");
  manager.appendMessage(assistant("D"));
  const before = JSON.stringify(manager.getEntries());
  const result = buildMainContextSnapshot(manager, anchor);
  assert.equal(result.kind, "ready");
  if (result.kind !== "ready") throw new Error("missing snapshot");
  assert.match(result.text, /C[\s\S]*D/u);
  user(manager, "later");
  assert.equal(validateMainContextSnapshot(manager, result), true);
  assert.doesNotMatch(result.text, /later/u);
  assert.equal(JSON.stringify(manager.getEntries().slice(0, -1)), before);
});

test("historical anchors import descendants and reject sibling and ancestor navigation", () => {
  const manager = SessionManager.inMemory();
  const a = user(manager, "A");
  const b = user(manager, "B");
  const source = captureMainContextSource(manager, b);
  assert.match(source.conversationContext, /A[\s\S]*B/u);
  user(manager, "C");
  assert.equal(buildMainContextSnapshot(manager, source.anchor).kind, "ready");
  manager.branch(a);
  assert.equal(buildMainContextSnapshot(manager, source.anchor).kind, "unavailable");
  user(manager, "sibling");
  assert.equal(buildMainContextSnapshot(manager, source.anchor).kind, "unavailable");
});

test.each(["compaction", "context_edit", "branch_summary"])(
  "rejects %s after the cursor and after a preview",
  (type) => {
    const manager = SessionManager.inMemory();
    const a = user(manager, "A");
    const { anchor } = captureMainContextSource(manager);
    user(manager, "C");
    const snapshot = buildMainContextSnapshot(manager, anchor);
    assert.equal(snapshot.kind, "ready");
    if (type === "compaction") manager.appendCompaction("summary", a, 100);
    else if (type === "context_edit") manager.appendContextEdit(a, { content: [{ type: "text", text: "edited" }] });
    else {
      const leaf = manager.getLeafId();
      assert.ok(leaf);
      manager.branchWithSummary(leaf, "summary");
    }
    assert.equal(buildMainContextSnapshot(manager, anchor).kind, "unavailable");
    if (snapshot.kind === "ready") assert.equal(validateMainContextSnapshot(manager, snapshot), false);
  },
);

test("waits for all parallel tool results and includes standalone text results, not thinking/images", () => {
  const manager = SessionManager.inMemory();
  const { anchor } = captureMainContextSource(manager);
  const message = assistant("running", "toolUse");
  message.content.push(
    { type: "thinking", thinking: "PRIVATE", thinkingSignature: "sig" },
    { type: "toolCall", id: "one", name: "bash", arguments: { command: "true" } },
    { type: "toolCall", id: "two", name: "read", arguments: { path: "file" } },
  );
  manager.appendMessage(message);
  const result = (id: string): ToolResultMessage => ({
    role: "toolResult",
    toolCallId: id,
    toolName: id,
    content: [
      { type: "text", text: `result-${id}` },
      { type: "image", data: "IMAGE", mimeType: "image/png" },
    ],
    isError: id === "two",
    timestamp: 1,
  });
  assert.equal(buildMainContextSnapshot(manager, anchor).kind, "empty");
  manager.appendMessage(result("two"));
  assert.equal(buildMainContextSnapshot(manager, anchor).kind, "empty");
  manager.appendMessage(result("one"));
  const snapshot = buildMainContextSnapshot(manager, anchor);
  assert.equal(snapshot.kind, "ready");
  if (snapshot.kind !== "ready") throw new Error("missing snapshot");
  assert.match(snapshot.text, /Tool call: bash/u);
  assert.match(snapshot.text, /result-two[\s\S]*result-one/u);
  assert.match(snapshot.text, /two \(error\)/u);
  assert.doesNotMatch(snapshot.text, /PRIVATE|IMAGE/u);
});

test("a source created between a tool call and its result does not skip pending evidence", () => {
  const manager = SessionManager.inMemory();
  const message = assistant("running", "toolUse");
  message.content.push({ type: "toolCall", id: "one", name: "bash", arguments: {} });
  manager.appendMessage(message);
  const { anchor } = captureMainContextSource(manager);
  assert.equal(buildMainContextSnapshot(manager, anchor).kind, "empty");
  manager.appendMessage({
    role: "toolResult",
    toolCallId: "one",
    toolName: "bash",
    content: [{ type: "text", text: "done" }],
    isError: false,
    timestamp: 1,
  });
  const snapshot = buildMainContextSnapshot(manager, anchor);
  assert.equal(snapshot.kind, "ready");
});

test.each(["error", "aborted", "length"] as const)(
  "labels finalized %s responses without representing success",
  (reason) => {
    const manager = SessionManager.inMemory();
    const { anchor } = captureMainContextSource(manager);
    const message = assistant("partial", reason);
    if (reason === "error" || reason === "aborted")
      message.content.push({ type: "toolCall", id: "never-executed", name: "bash", arguments: {} });
    manager.appendMessage(message);
    const snapshot = buildMainContextSnapshot(manager, anchor);
    assert.equal(snapshot.kind, "ready");
    if (snapshot.kind === "ready") assert.match(snapshot.text, new RegExp(`assistant \\(${reason}\\)`));
  },
);

test.each(["pending", "deferred"] as const)("does not cross a persisted %s response", (reason) => {
  const manager = SessionManager.inMemory();
  const { anchor } = captureMainContextSource(manager);
  const completed = user(manager, "completed input");
  manager.appendMessage(assistant("NOT-COMPLETED", reason));
  user(manager, "later input");
  const snapshot = buildMainContextSnapshot(manager, anchor);
  assert.equal(snapshot.kind, "ready");
  if (snapshot.kind === "ready") {
    assert.equal(snapshot.target.entryId, completed);
    assert.doesNotMatch(snapshot.text, /NOT-COMPLETED|later input/u);
    assert.equal(buildMainContextSnapshot(manager, snapshot.target).kind, "empty");
  }
});

test("length-limited tool calls wait for the runtime's synthetic failure results", () => {
  const manager = SessionManager.inMemory();
  const { anchor } = captureMainContextSource(manager);
  const message = assistant("truncated call", "length");
  message.content.push({ type: "toolCall", id: "cut-off", name: "bash", arguments: {} });
  manager.appendMessage(message);
  assert.equal(buildMainContextSnapshot(manager, anchor).kind, "empty");
  manager.appendMessage({
    role: "toolResult",
    toolCallId: "cut-off",
    toolName: "bash",
    content: [{ type: "text", text: "Tool call was not executed: output token limit." }],
    isError: true,
    timestamp: 1,
  });
  const snapshot = buildMainContextSnapshot(manager, anchor);
  assert.equal(snapshot.kind, "ready");
  if (snapshot.kind === "ready")
    assert.match(snapshot.text, /assistant \(length\)[\s\S]*Tool result: bash \(error\)[\s\S]*not executed/u);
});

test("bounds the complete import and each text block, preserving order and explicit omissions", () => {
  const manager = SessionManager.inMemory();
  const { anchor } = captureMainContextSource(manager);
  for (let i = 0; i < 10; i++) user(manager, `${i}:${"x".repeat(12_000)}`);
  const snapshot = buildMainContextSnapshot(manager, anchor);
  assert.equal(snapshot.kind, "ready");
  if (snapshot.kind === "ready") {
    assert.ok(snapshot.text.length <= 40_000);
    assert.match(snapshot.text, /^user:\n0:/u);
    assert.match(snapshot.text, /Remaining content omitted/u);
  }
});

test("rejects different sessions and absent source entries, and ignores non-content entries", () => {
  const manager = SessionManager.inMemory();
  const { anchor } = captureMainContextSource(manager);
  assert.equal(buildMainContextSnapshot(SessionManager.inMemory(), anchor).kind, "unavailable");
  assert.equal(
    buildMainContextSnapshot(manager, { sessionId: manager.getSessionId(), entryId: "missing" }).kind,
    "unavailable",
  );
  manager.appendCustomEntry("state", { value: 1 });
  assert.equal(buildMainContextSnapshot(manager, anchor).kind, "empty");
});
