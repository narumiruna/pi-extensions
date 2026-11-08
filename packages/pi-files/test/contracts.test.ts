import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
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
} from "../src/scope/contracts.js";
import { createSnapshot, type ScopeState, STATE_TYPE } from "../src/scope/state.js";

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
  it("preserves legacy identities and exact model notices across the package rename", () => {
    expect([STATE_TYPE, NOTICE_TYPE, ANCHOR_TYPE]).toEqual(["scope-state", "scope-contract", "scope-context-anchor"]);
    expect(createScopeNotice(active)?.content).toBe(
      [
        "Scope editing restriction is active. This notice replaces earlier Scope notices.",
        "Only write or edit these exact selected file targets. Use their file URLs as tool paths to preserve literal Unicode and control characters:",
        `- ${JSON.stringify(pathToFileURL(resolve(cwd, "a.ts")).href)}`,
        "Other files may be read. Shell commands and unsupported tools cannot bypass this editing boundary. Only the user can change or end the scope with /scope.",
      ].join("\n"),
    );
    expect(createScopeNotice(inactive)?.content).toBe(
      "The user ended the Scope editing restriction. Earlier Scope notices no longer apply. All other existing instructions and tool restrictions remain unchanged.",
    );
    expect(createScopeNotice({ state: "blocked", entryId: "legacy" })?.content).toBe(
      "Scope state is unavailable. Do not edit files or use writing commands. The user must repair it with /scope or exit with /scope off. Reading remains available.",
    );
  });
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
  it.each(
    [inactive, { ...active, entryId: "again" }, { state: "blocked", entryId: "broken" } as ScopeState].flatMap(
      (current) =>
        [1, 2].flatMap((oldAnchors) =>
          [0, 1, 2].map((retained) => ({
            current,
            oldAnchors,
            retained,
            label: `${current.state}/${oldAnchors}/${retained}`,
          })),
        ),
    ),
  )(
    "keeps a newer recovery fixed after stale exclusions change the base: $label",
    ({ current, oldAnchors, retained }) => {
      const persisted = [...branch];
      for (let index = 0; index < oldAnchors; index += 1) {
        const old = reconcileScopeContext(
          Array.from({ length: index === 0 ? 5 : 1 }, (_, item) => user(`old prefix ${index}/${item}`)),
          persisted,
          active,
          index + 1,
        );
        expect(old.anchor).toBeDefined();
        persisted.push(customEntry(ANCHOR_TYPE, old.anchor, `old-anchor-${index}`));
      }
      persisted.push(customEntry(STATE_TYPE, current.snapshot ?? { version: 2 }, current.entryId));
      const head: AgentMessage = { role: "system", content: "Native head", timestamp: 1 };
      const summary: AgentMessage = {
        role: "compactionSummary",
        summary: "compacted",
        tokensBefore: 100,
        timestamp: 2,
      };
      const input: AgentMessage[] = [
        head,
        summary,
        ...Array.from({ length: retained }, (_, index) => createScopeNotice(active, index + 3) as AgentMessage),
      ];
      const recovered = reconcileScopeContext(input, persisted, current, 10);
      expect(recovered.anchor).toBeDefined();
      expect(recovered.messages.slice(0, input.length)).toEqual(input);
      persisted.push(customEntry(ANCHOR_TYPE, recovered.anchor, "recovery"));

      const answer = assistant("answer", 11);
      const next = reconcileScopeContext([...input, answer], persisted, current, 20);
      expect(next.anchor).toBeUndefined();
      expect(normalized(next.messages).slice(0, recovered.messages.length)).toEqual(normalized(recovered.messages));
      expect(next.messages.at(-1)).toEqual(answer);
      expect(noticeCount(next.messages)).toBe(retained + 1);

      const late = createScopeNotice(current, 21) as AgentMessage;
      const ordinary = reconcileScopeContext([...input, answer, late, user("next", 22)], persisted, current, 30);
      expect(ordinary.anchor).toBeUndefined();
      expect(normalized(ordinary.messages).slice(0, next.messages.length)).toEqual(normalized(next.messages));
      expect(noticeCount(ordinary.messages)).toBe(retained + 1);
      expect(reconcileScopeContext(ordinary.messages, persisted, current).messages).toEqual(ordinary.messages);
    },
  );
  it("rechecks a recovery after several distinct historical notices return to the base", () => {
    const first = reconcileScopeContext([user("old")], branch, active, 1);
    const history = [
      ...branch,
      customEntry(ANCHOR_TYPE, first.anchor, "old-active"),
      customEntry(STATE_TYPE, inactive.snapshot, "off"),
    ];
    const off = reconcileScopeContext([user("old"), assistant("done")], history, inactive, 2);
    history.push(customEntry(ANCHOR_TYPE, off.anchor, "old-off"));
    const again: ScopeState = { ...active, entryId: "again" };
    history.push(customEntry(STATE_TYPE, snapshot, "again"));
    const input = [
      user("compacted history"),
      createScopeNotice(active, 3) as AgentMessage,
      createScopeNotice(inactive, 4) as AgentMessage,
    ];
    const recovered = reconcileScopeContext(input, history, again, 5);
    history.push(customEntry(ANCHOR_TYPE, recovered.anchor, "new-recovery"));
    const next = reconcileScopeContext([...input, assistant("next")], history, again, 6);
    expect(next.anchor).toBeUndefined();
    expect(normalized(next.messages).slice(0, recovered.messages.length)).toEqual(normalized(recovered.messages));
    expect(next.messages.slice(0, input.length)).toEqual(input);
    expect(noticeCount(next.messages)).toBe(3);
    const current: ScopeState = { ...inactive, entryId: "off-again" };
    history.push(customEntry(STATE_TYPE, current.snapshot, current.entryId));
    const later = reconcileScopeContext(
      [...input, assistant("next"), createScopeNotice(current, 7) as AgentMessage],
      history,
      current,
      8,
    );
    expect(later.anchor).toBeUndefined();
    expect(normalized(later.messages).slice(0, next.messages.length)).toEqual(normalized(next.messages));
    expect(noticeCount(later.messages)).toBe(4);
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
    { version: 1, stateId: "active", state: "active", count: 1, digest: "a".repeat(64), sentAt: 1, recovery: -1 },
    { version: 1, stateId: "active", state: "active", count: 1, digest: "a".repeat(64), sentAt: 1, recovery: "1" },
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
    expect(result.messages.slice(0, history.length)).toEqual(history);
    expect(noticeCount(result.messages)).toBe(3);
  });
  it("retains active history and a blocked recovery when reload restores the same active state", () => {
    const head: AgentMessage = { role: "system", content: "Native head", timestamp: 1 };
    const input = [head, user("request"), createScopeNotice(active, 2) as AgentMessage];
    const blocked: ScopeState = { state: "blocked", entryId: active.entryId };
    const stopped = reconcileScopeContext(input, branch, blocked, 3);
    const persisted = [...branch, customEntry(ANCHOR_TYPE, stopped.anchor, "blocked-anchor")];
    const answer = assistant("answer before reload", 4);
    const restored = reconcileScopeContext([...input, answer], persisted, active, 5);
    expect(restored.anchor).toBeDefined();
    expect(normalized(restored.messages).slice(0, stopped.messages.length)).toEqual(normalized(stopped.messages));
    expect(restored.messages.slice(stopped.messages.length, -1)).toEqual([answer]);
    expect(noticeCount(restored.messages)).toBe(3);
    persisted.push(customEntry(ANCHOR_TYPE, restored.anchor, "active-again"));
    const ordinary = reconcileScopeContext([...input, answer, user("next", 6)], persisted, active, 7);
    expect(ordinary.anchor).toBeUndefined();
    expect(normalized(ordinary.messages).slice(0, restored.messages.length)).toEqual(normalized(restored.messages));
    expect(reconcileScopeContext(ordinary.messages, persisted, active).messages).toEqual(ordinary.messages);
  });
  it("keeps distinct repeated instances even when several transitions share the same raw prefix", () => {
    const input = [user("unchanged request")];
    const persisted = [...branch];
    const blocked: ScopeState = { state: "blocked", entryId: active.entryId };
    let previous: AgentMessage[] = input;
    for (const [index, current] of [active, blocked, active, blocked, active].entries()) {
      const result = reconcileScopeContext(input, persisted, current, index);
      expect(result.anchor).toBeDefined();
      expect(normalized(result.messages).slice(0, previous.length)).toEqual(normalized(previous));
      persisted.push(customEntry(ANCHOR_TYPE, result.anchor, `anchor-${index}`));
      expect(reconcileScopeContext(input, persisted, current).anchor).toBeUndefined();
      expect(reconcileScopeContext(result.messages, persisted, current).messages).toEqual(result.messages);
      previous = result.messages;
    }
    expect(noticeCount(previous)).toBe(5);
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
