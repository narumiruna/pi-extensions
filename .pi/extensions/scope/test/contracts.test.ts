import { resolve } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { convertToLlm, type SessionEntry } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import {
  ANCHOR_TYPE,
  createScopeNotice,
  hasCurrentScopeNotice,
  NOTICE_TYPE,
  reconcileScopeContext,
} from "../contracts.ts";
import { createSnapshot, type ScopeState, STATE_TYPE } from "../state.ts";

const cwd = resolve("scope-contract-fixture");
const snapshot = createSnapshot(cwd, [{ path: resolve(cwd, "a.ts"), canonical: resolve(cwd, "a.ts") }]);
const active: ScopeState = { state: "active", snapshot, entryId: "active" };
const inactive: ScopeState = { state: "inactive", snapshot: createSnapshot(cwd, null), entryId: "off" };
const customEntry = (customType: string, data: unknown, id = customType): SessionEntry => ({
  type: "custom",
  id,
  parentId: null,
  timestamp: "2026-11-01T00:00:00.000Z",
  customType,
  data,
});
const branch = [customEntry(STATE_TYPE, snapshot, "active")];
const user = (content: string, timestamp = 1): AgentMessage => ({ role: "user", content, timestamp });
const assistant = (text: string, timestamp = 2): AssistantMessage => ({
  role: "assistant",
  content: [{ type: "text", text }],
  timestamp,
  api: "openai-responses",
  provider: "openai",
  model: "fixture",
  stopReason: "stop",
  usage: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  },
});
const normalized = (messages: readonly AgentMessage[]) =>
  convertToLlm([...messages]).map((message) =>
    Object.fromEntries(
      Object.entries(message).filter(
        ([key]) => !["timestamp", "usage", "api", "provider", "model", "stopReason"].includes(key),
      ),
    ),
  );
const noticeCount = (messages: AgentMessage[]) =>
  messages.filter((message) => message.role === "custom" && message.customType === NOTICE_TYPE).length;

describe("durable scope model contracts", () => {
  it("does not publish a bootstrap-inactive notice or replace a retained current notice", () => {
    const messages = [user("request")];
    expect(reconcileScopeContext(messages, [], { state: "inactive" }).messages).toEqual(messages);
    const retained = [...messages, createScopeNotice(active, 10) as AgentMessage];
    const result = reconcileScopeContext(retained, branch, active);
    expect(result.anchor).toBeUndefined();
    expect(normalized(result.messages)).toEqual(normalized(retained));
  });
  it("restores once after summaries and retains the exact ordinary-request prefix", () => {
    const summary: AgentMessage = { role: "compactionSummary", summary: "prior work", tokensBefore: 100, timestamp: 1 };
    const first = reconcileScopeContext([summary], branch, active, 10);
    expect(first.anchor).toBeDefined();
    expect(first.messages[0]).toEqual(summary);
    expect(noticeCount(first.messages)).toBe(1);
    const persisted = [...branch, customEntry(ANCHOR_TYPE, first.anchor)];
    const answer = assistant("done", 11);
    const second = reconcileScopeContext([summary, answer], persisted, active, 20);
    expect(second.anchor).toBeUndefined();
    expect(normalized(second.messages).slice(0, first.messages.length)).toEqual(normalized(first.messages));
    expect(second.messages.at(-1)).toEqual(answer);
    const third = reconcileScopeContext([summary, answer, user("next", 21)], persisted, active, 30);
    expect(third.anchor).toBeUndefined();
    expect(normalized(third.messages).slice(0, second.messages.length)).toEqual(normalized(second.messages));
    expect(reconcileScopeContext(third.messages, persisted, active).messages).toEqual(third.messages);
  });
  it("places late original publication at the first-seen boundary, once, without splitting tool results", () => {
    const request = user("change this");
    const first = reconcileScopeContext([request], branch, active, 10);
    const persisted = [...branch, customEntry(ANCHOR_TYPE, first.anchor)];
    const call: AgentMessage = {
      ...assistant("", 11),
      role: "assistant",
      content: [{ type: "toolCall", id: "call", name: "write", arguments: { path: "a.ts", content: "x" } }],
    };
    const result: AgentMessage = {
      role: "toolResult",
      toolCallId: "call",
      toolName: "write",
      content: [{ type: "text", text: "done" }],
      isError: false,
      timestamp: 12,
    };
    const late = createScopeNotice(active, 13) as AgentMessage;
    const restored = reconcileScopeContext([request, call, result, late], persisted, active, 20);
    expect(restored.anchor).toBeUndefined();
    expect(noticeCount(restored.messages)).toBe(1);
    expect(normalized(restored.messages).slice(0, first.messages.length)).toEqual(normalized(first.messages));
    expect(restored.messages.slice(2)).toEqual([call, result]);
    const afterReload = reconcileScopeContext([request, call, result, late, user("again")], persisted, active);
    expect(normalized(afterReload.messages).slice(0, restored.messages.length)).toEqual(normalized(restored.messages));
  });
  it("rebases only after compaction removes the anchored prefix and does not delete a retained native notice", () => {
    const first = reconcileScopeContext([user("old")], branch, active, 10);
    const persisted = [...branch, customEntry(ANCHOR_TYPE, first.anchor)];
    const rebased = reconcileScopeContext([user("new summary")], persisted, active, 20);
    expect(rebased.anchor).toBeDefined();
    const twice = [...persisted, customEntry(ANCHOR_TYPE, rebased.anchor, "new-anchor")];
    const next = reconcileScopeContext([user("new summary"), assistant("next")], twice, active);
    expect(next.anchor).toBeUndefined();
    expect(noticeCount(next.messages)).toBe(1);
    const retained = [user("unrelated summary"), createScopeNotice(active, 30) as AgentMessage];
    expect(reconcileScopeContext(retained, twice, active).messages).toEqual(retained);
  });
  it("preserves historical contracts across off and a later activation of the same files", () => {
    const first = reconcileScopeContext([user("one")], branch, active, 10);
    const persisted = [
      ...branch,
      customEntry(ANCHOR_TYPE, first.anchor),
      customEntry(STATE_TYPE, inactive.snapshot, "off"),
    ];
    const messages = [user("one"), assistant("done"), createScopeNotice(inactive, 20) as AgentMessage];
    const off = reconcileScopeContext(messages, persisted, inactive);
    expect(off.anchor).toBeUndefined();
    expect(normalized(off.messages).slice(0, first.messages.length)).toEqual(normalized(first.messages));
    const again: ScopeState = { ...active, entryId: "again" };
    const againBranch = [...persisted, customEntry(STATE_TYPE, snapshot, "again")];
    const on = reconcileScopeContext(messages, againBranch, again, 30);
    expect(on.anchor).toBeDefined();
    expect(hasCurrentScopeNotice(on.messages, again)).toBe(true);
    expect(normalized(on.messages).slice(0, off.messages.length)).toEqual(normalized(off.messages));
  });
  it("ignores non-model timestamp/usage changes, but not model-visible prefix edits", () => {
    const old = assistant("same", 1);
    const first = reconcileScopeContext([old], branch, active, 10);
    const persisted = [...branch, customEntry(ANCHOR_TYPE, first.anchor)];
    expect(
      reconcileScopeContext([{ ...old, timestamp: 1000, durationMs: 42 }], persisted, active).anchor,
    ).toBeUndefined();
    expect(reconcileScopeContext([assistant("different", 1)], persisted, active).anchor).toBeDefined();
  });
  it.each([
    null,
    {},
    { version: 2 },
    { version: 1, stateId: "active", state: "active", count: -1, digest: "a".repeat(64), sentAt: 1 },
    { version: 1, stateId: "missing", state: "active", count: 0, digest: "a".repeat(64), sentAt: 1 },
  ])("does not trust malformed or unrelated anchors %#", (data) => {
    const result = reconcileScopeContext([user("work")], [...branch, customEntry(ANCHOR_TYPE, data)], active);
    expect(result.anchor).toBeDefined();
    expect(noticeCount(result.messages)).toBe(1);
    expect(hasCurrentScopeNotice(result.messages, active)).toBe(true);
  });
  it("repairs a wrong latest notice even when an older equivalent notice is retained", () => {
    const history = [createScopeNotice(active, 1) as AgentMessage, createScopeNotice(inactive, 2) as AgentMessage];
    const result = reconcileScopeContext(history, branch, active, 3);
    expect(result.anchor).toBeDefined();
    expect(hasCurrentScopeNotice(result.messages, active)).toBe(true);
    expect(noticeCount(result.messages)).toBe(2);
  });
  it("keeps a blocked-state instruction deterministic and quotes tool paths through file URLs", () => {
    const blocked = createScopeNotice({ state: "blocked", entryId: "bad", error: "volatile error" });
    expect(blocked?.content).not.toContain("volatile error");
    const unusual = createSnapshot(cwd, [
      { path: resolve(cwd, "a\n\u00a0.ts"), canonical: resolve(cwd, "a\n\u00a0.ts") },
    ]);
    const notice = createScopeNotice({ state: "active", snapshot: unusual, entryId: "unicode" });
    expect(notice?.content).toContain("%0A%C2%A0.ts");
    expect(notice?.content).not.toContain("a\n\u00a0.ts");
  });
  it("never places even a valid empty-prefix anchor before the native leading system message", () => {
    const poisoned = {
      version: 1,
      stateId: "active",
      state: "active",
      count: 0,
      digest: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
      sentAt: 1,
    };
    const system: AgentMessage = { role: "system", content: "Native instructions", timestamp: 1 };
    const result = reconcileScopeContext(
      [system, user("request")],
      [...branch, customEntry(ANCHOR_TYPE, poisoned)],
      active,
    );
    expect(result.messages[0]).toEqual(system);
    expect(result.anchor?.count).toBe(2);
    expect(noticeCount(result.messages)).toBe(1);
  });
  it("bounds percent-expanded notices before activation can publish them", () => {
    const large = createSnapshot(
      cwd,
      Array.from({ length: 10 }, (_, index) => ({
        path: resolve(cwd, `${index}${"\u00a0".repeat(1000)}`),
        canonical: resolve(cwd, `real-${index}`),
      })),
    );
    expect(() => createScopeNotice({ state: "active", snapshot: large, entryId: "large" })).toThrow("notice exceeds");
  });
});
