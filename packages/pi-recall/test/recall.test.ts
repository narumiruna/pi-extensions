import assert from "node:assert/strict";
import { test } from "vitest";
import { createMockContext, createMockPi } from "../../../test/support.js";
import type { MessageCandidate, RecallMessageRecord } from "../src/messages.js";
import { createRecallExtension } from "../src/recall.js";
import type { RecallStore, RecallStoreSnapshot } from "../src/store.js";

function emptyStore(overrides: Partial<RecallStore> = {}): RecallStore {
  return {
    path: "/agent/pi-recall.jsonl",
    async load(): Promise<RecallStoreSnapshot> {
      return { path: this.path, records: [], bytes: 0 };
    },
    async save(candidate: MessageCandidate): Promise<RecallMessageRecord> {
      return {
        type: "recall_message",
        version: 1,
        id: "saved",
        savedAt: "2026-08-04T12:00:00.000Z",
        source: {
          sessionId: candidate.source.sessionId,
          entryId: candidate.entryId,
          cwd: candidate.source.cwd,
          messageTimestamp: candidate.messageTimestamp,
        },
        role: candidate.role,
        text: candidate.text,
      };
    },
    async delete() {
      return false;
    },
    ...overrides,
  } as RecallStore;
}

async function emit(mock: ReturnType<typeof createMockPi>, name: string, event: unknown, ctx: unknown): Promise<void> {
  for (const handler of mock.events.get(name) ?? []) await handler(event, ctx);
}

test("registers /recall without notifying on session start", async () => {
  const mock = createMockPi();
  createRecallExtension({ getAgentDir: () => "/agent", createStore: () => emptyStore() })(mock.pi);
  assert.ok(mock.commands.has("recall"));
  const first = createMockContext({ hasUI: true, mode: "rpc" });
  const second = createMockContext({ hasUI: true, mode: "rpc" });
  await emit(mock, "session_start", { reason: "startup" }, first.ctx);
  await emit(mock, "session_start", { reason: "new" }, second.ctx);
  assert.deepEqual(first.notifications, []);
  assert.deepEqual(second.notifications, []);
});

test("rejects arguments and print/json modes before opening interactive UI", async () => {
  const mock = createMockPi();
  createRecallExtension({ getAgentDir: () => "/agent", createStore: () => emptyStore() })(mock.pi);
  const command = mock.commands.get("recall");
  assert.ok(command);
  const rpc = createMockContext({ hasUI: true, mode: "rpc" });
  await emit(mock, "session_start", { reason: "startup" }, rpc.ctx);
  await command?.handler("unexpected", rpc.ctx);
  assert.match(rpc.notifications.at(-1)?.message ?? "", /Usage: \/recall/);
  for (const mode of ["print", "json"] as const) {
    const headless = createMockContext({ hasUI: false, mode });
    await assert.rejects(Promise.resolve(command?.handler("trailing", headless.ctx)), /Usage: \/recall/);
    await assert.rejects(Promise.resolve(command?.handler("", headless.ctx)), /requires Pi TUI or RPC mode/);
  }
});

test("builds save candidates only from the current active branch with normalized source metadata", async () => {
  let observed: MessageCandidate | undefined;
  const store = emptyStore({
    async save(value: MessageCandidate) {
      observed = value;
      return emptyStore().save(value);
    },
  });
  const mock = createMockPi();
  createRecallExtension({ getAgentDir: () => "/agent", createStore: () => store })(mock.pi);
  let selects = 0;
  const sessionManager = {
    getSessionId: () => "session-current",
    getSessionName: () => "Current work",
    getBranch: () => [
      {
        type: "message",
        id: "branch-message",
        message: { role: "user", content: "save me", timestamp: 100 },
      },
    ],
  };
  const ctx = createMockContext({
    hasUI: true,
    mode: "rpc",
    cwd: "/work/./project",
    sessionManager,
    select: async (_title: string, options: string[]) => {
      selects += 1;
      if (selects <= 2) return options[0];
      return "Close";
    },
  });
  await emit(mock, "session_start", { reason: "startup" }, ctx.ctx);
  await mock.commands.get("recall")?.handler("", ctx.ctx);
  assert.equal(observed?.entryId, "branch-message");
  assert.equal(observed?.source.sessionId, "session-current");
  assert.equal(observed?.source.sessionName, "Current work");
  assert.equal(observed?.source.cwd, "/work/project");
});

test("session shutdown aborts an in-flight save and suppresses stale success UI", async () => {
  let saveStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    saveStarted = resolve;
  });
  const store = emptyStore({
    async save(candidate: MessageCandidate, signal?: AbortSignal) {
      saveStarted();
      await new Promise<void>((_resolve, reject) => {
        if (signal?.aborted) return reject(signal.reason);
        signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
      return emptyStore().save(candidate);
    },
  });
  const mock = createMockPi();
  createRecallExtension({ getAgentDir: () => "/agent", createStore: () => store })(mock.pi);
  const sessionManager = {
    getSessionId: () => "session",
    getSessionName: () => undefined,
    getBranch: () => [
      {
        type: "message",
        id: "message",
        message: { role: "assistant", content: [{ type: "text", text: "answer" }], timestamp: 1 },
      },
    ],
  };
  let selects = 0;
  const ctx = createMockContext({
    hasUI: true,
    mode: "rpc",
    sessionManager,
    select: async (_title: string, options: string[]) => (selects++ < 2 ? options[0] : undefined),
  });
  await emit(mock, "session_start", { reason: "startup" }, ctx.ctx);
  const running = Promise.resolve(mock.commands.get("recall")?.handler("", ctx.ctx));
  await started;
  await emit(mock, "session_shutdown", { reason: "quit" }, ctx.ctx);
  await running;
  assert.equal(ctx.notifications.filter(({ message }) => /Saved message/.test(message)).length, 0);
});

test("a completed publication after replacement does not touch the stale UI", async () => {
  let release!: () => void;
  let started!: () => void;
  const waiting = new Promise<void>((resolve) => {
    started = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const store = emptyStore({
    async save(candidate: MessageCandidate) {
      started();
      await gate;
      return emptyStore().save(candidate);
    },
  });
  const mock = createMockPi();
  createRecallExtension({ getAgentDir: () => "/agent", createStore: () => store })(mock.pi);
  const sessionManager = {
    getSessionId: () => "session",
    getSessionName: () => undefined,
    getBranch: () => [
      {
        type: "message",
        id: "message",
        message: { role: "user", content: "save", timestamp: 1 },
      },
    ],
  };
  let selects = 0;
  const first = createMockContext({
    hasUI: true,
    mode: "rpc",
    sessionManager,
    select: async (_title: string, options: string[]) => (selects++ < 2 ? options[0] : undefined),
  });
  await emit(mock, "session_start", { reason: "startup" }, first.ctx);
  const running = mock.commands.get("recall")?.handler("", first.ctx);
  await waiting;
  const replacement = createMockContext({ hasUI: true, mode: "rpc" });
  await emit(mock, "session_start", { reason: "new" }, replacement.ctx);
  release();
  await running;
  assert.equal(first.notifications.filter(({ message }) => /Saved message/.test(message)).length, 0);
});
