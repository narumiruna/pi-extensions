import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { test } from "vitest";
import type { PlanModeState } from "../src/state.js";
import { createMockContext, createMockPi } from "./support.js";

const STATE_TYPE = "plan-mode-state";
const INACTIVE = { enabled: false, awaitingAction: false };

function appendExchange(manager: SessionManager, text: string) {
  manager.appendMessage({ role: "user", content: text, timestamp: 1 });
  manager.appendMessage({
    role: "assistant",
    content: [{ type: "text", text: `Reply to ${text}` }],
    api: "openai-responses",
    provider: "fixture",
    model: "fixture",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: 2,
  });
}

async function load(manager: SessionManager, options: { thinkingLevel?: "medium"; reason?: "new" | "resume" } = {}) {
  const { default: planMode } = await import("../src/plan-mode.js");
  const mock = createMockPi({ activeTools: ["read", "bash", "edit", "write"], thinkingLevel: "low" });
  mock.rawPi.appendEntry = (type, data) => {
    manager.appendCustomEntry(type, data);
    mock.entries.push({ customType: type, data });
  };
  planMode(mock.pi, {
    readSettings: async () => ({ kind: "loaded", settings: { thinkingLevel: options.thinkingLevel ?? "inherit" } }),
  });
  const context = createMockContext({ sessionManager: manager, mode: "json" });
  const { ctx } = context;
  const emit = async (name: string, event: unknown) => {
    for (const handler of mock.events.get(name) ?? []) await handler(event, ctx);
  };
  await emit("session_start", { reason: options.reason ?? "resume" });
  return { mock, ctx, context, manager, emit, close: () => emit("session_shutdown", { reason: "quit" }) };
}

for (const historicalState of [false, true]) {
  test(`idle shutdown preserves another writer's continuation (historical state: ${historicalState})`, async () => {
    const root = mkdtempSync(join(tmpdir(), "plan-state-writers-"));
    const sessions: Awaited<ReturnType<typeof load>>[] = [];
    try {
      const initial = SessionManager.create(root, join(root, "sessions"));
      if (historicalState) initial.appendCustomEntry(STATE_TYPE, INACTIVE);
      appendExchange(initial, "first");
      const file = initial.getSessionFile();
      assert.ok(file);
      const idle = await load(SessionManager.open(file));
      sessions.push(idle);
      const writerManager = SessionManager.open(file);
      const writer = await load(writerManager);
      sessions.push(writer);
      appendExchange(writerManager, "second");
      await writer.close();
      const before = readFileSync(file, "utf8");
      await idle.close();
      assert.equal(readFileSync(file, "utf8"), before, "idle shutdown must not append from a stale leaf");
      const resumed = SessionManager.open(file);
      assert.equal(resumed.getBranch().filter((entry) => entry.type === "message").length, 4);
      assert.equal(idle.mock.entries.length, 0);
    } finally {
      for (const session of sessions) await session.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
}

test("inactive in-memory sessions do not acquire state entries on repeated shutdown", async () => {
  const manager = SessionManager.inMemory();
  const session = await load(manager);
  await session.close();
  await session.close();
  assert.deepEqual(manager.getBranch(), []);
});

test("unchanged active turns and shutdown do not append state", async () => {
  const session = await load(SessionManager.inMemory());
  try {
    await session.mock.commands.get("plan")?.handler("start", session.ctx);
    const count = session.mock.entries.length;
    assert.ok(count > 0);
    await session.emit("agent_end", { messages: [] });
    await session.emit("agent_end", { messages: [] });
    await session.close();
    await session.close();
    assert.equal(session.mock.entries.length, count);
  } finally {
    await session.close();
  }
});

test("tree navigation resets the baseline without hiding a real exit on another branch", async () => {
  const manager = SessionManager.inMemory();
  const inactiveLeaf = manager.appendCustomEntry(STATE_TYPE, INACTIVE);
  const session = await load(manager);
  try {
    await session.mock.commands.get("plan")?.handler("start", session.ctx);
    const activeLeaf = manager.getLeafId();
    assert.ok(activeLeaf);
    const count = session.mock.entries.length;
    manager.branch(inactiveLeaf);
    await session.emit("session_tree", {});
    await session.close();
    assert.equal(session.mock.entries.length, count);
    manager.branch(activeLeaf);
    await session.emit("session_start", { reason: "reload" });
    await session.mock.commands.get("plan")?.handler("exit", session.ctx);
    assert.equal(session.mock.entries.length, count + 1);
    const state = session.mock.entries.at(-1)?.data as PlanModeState | undefined;
    assert.equal(state?.enabled, false);
  } finally {
    await session.close();
  }
});

test("replacement with an empty session does not publish the previous session's state", async () => {
  const session = await load(SessionManager.inMemory());
  await session.mock.commands.get("plan")?.handler("start", session.ctx);
  await session.close();
  const count = session.mock.entries.length;
  const replacement = SessionManager.inMemory();
  const { ctx } = createMockContext({ sessionManager: replacement, mode: "json" });
  await session.mock.events.get("session_start")?.[0]?.({ reason: "new" }, ctx);
  await session.mock.events.get("session_shutdown")?.[0]?.({ reason: "quit" }, ctx);
  assert.equal(session.mock.entries.length, count);
  assert.deepEqual(replacement.getBranch(), []);
});

test("first-prompt setup refresh seeds the baseline before shutdown", async () => {
  const manager = SessionManager.inMemory();
  const session = await load(manager, { reason: "new" });
  manager.appendCustomEntry(STATE_TYPE, {
    ...INACTIVE,
    savedPlan: { plan: "# Saved setup plan", source: "plan_mode_complete" },
  });
  await session.emit("before_agent_start", { messageType: "user" });
  assert.equal(session.context.statuses.get("plan-mode"), "plan saved");
  await session.close();
  assert.deepEqual(session.mock.entries, []);
});

test("shutdown preserves a manual thinking change without mutating earlier entries", async () => {
  const session = await load(SessionManager.inMemory(), { thinkingLevel: "medium" });
  await session.mock.commands.get("plan")?.handler("start", session.ctx);
  const before = session.mock.entries.at(-1)?.data as PlanModeState | undefined;
  session.mock.rawPi.setThinkingLevel("high");
  await session.close();
  assert.equal(before?.appliedThinkingLevel, "medium");
  const persisted = session.mock.entries.at(-1)?.data as PlanModeState | undefined;
  assert.equal(persisted?.manualThinkingLevel, "high");
  const count = session.mock.entries.length;
  await session.close();
  assert.equal(session.mock.entries.length, count);
});

test("thinking restoration events do not persist shutdown cleanup as a user change", async () => {
  const session = await load(SessionManager.inMemory(), { thinkingLevel: "medium" });
  await session.mock.commands.get("plan")?.handler("start", session.ctx);
  const count = session.mock.entries.length;
  const setThinkingLevel = session.mock.rawPi.setThinkingLevel;
  session.mock.rawPi.setThinkingLevel = (level) => {
    setThinkingLevel(level);
    for (const handler of session.mock.events.get("thinking_level_select") ?? []) handler({ level }, session.ctx);
  };
  await session.close();
  await session.close();
  assert.equal(session.mock.thinkingLevel, "low");
  assert.equal(session.mock.entries.length, count);
});

test("concurrent and repeated shutdown calls join the same cleanup task", async () => {
  const session = await load(SessionManager.inMemory());
  const shutdown = session.mock.events.get("session_shutdown")?.[0];
  assert.ok(shutdown);
  const first = shutdown({ reason: "quit" }, session.ctx);
  const concurrent = shutdown({ reason: "quit" }, session.ctx);
  assert.equal(concurrent, first);
  await first;
  assert.equal(shutdown({ reason: "quit" }, session.ctx), first);
});

test("an old shutdown cannot dispose a reloaded generation of the same manager", async () => {
  const session = await load(SessionManager.inMemory());
  await session.mock.commands.get("plan")?.handler("start", session.ctx);
  const shutdown = session.close();
  await session.emit("session_start", { reason: "reload" });
  await shutdown;
  assert.equal(session.context.statuses.get("plan-mode"), "plan active");
  const attempt = { session: session.manager, group: "agent-workflow", busy: false };
  session.mock.eventBus.emit("workflow:mutex:v1", attempt);
  assert.equal(attempt.busy, true);
  await session.close();
  attempt.busy = false;
  session.mock.eventBus.emit("workflow:mutex:v1", attempt);
  assert.equal(attempt.busy, false);
});

test("a failed shutdown append still clears UI and releases workflow ownership", async () => {
  const session = await load(SessionManager.inMemory(), { thinkingLevel: "medium" });
  await session.mock.commands.get("plan")?.handler("start", session.ctx);
  session.mock.rawPi.setThinkingLevel("high");
  let attempts = 0;
  session.mock.rawPi.appendEntry = () => {
    attempts += 1;
    throw new Error("shutdown append failed");
  };
  await assert.rejects(session.close(), /shutdown append failed/u);
  await assert.rejects(session.close(), /shutdown append failed/u);
  assert.equal(attempts, 1);
  assert.equal(session.context.statuses.get("plan-mode"), undefined);
  const attempt = { session: session.manager, group: "agent-workflow", busy: false };
  session.mock.eventBus.emit("workflow:mutex:v1", attempt);
  assert.equal(attempt.busy, false);
});
