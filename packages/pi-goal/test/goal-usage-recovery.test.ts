import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { afterEach, test, vi } from "vitest";
import {
  assistantUsageEntry,
  DEFAULT_SETTINGS_PATH,
  requireLastGoal,
  settingsPath,
  startGoalForTest,
} from "./support/goal-fixture.js";

const RETRY_MS = 15 * 60 * 1000;
const QUOTA_ERROR = "Codex error: The usage limit has been reached";
const enabledSettings = settingsPath("usage-recovery.json");
writeFileSync(enabledSettings, '{"retryUsageLimits":true}\n');
const model = {
  provider: "openai-codex",
  id: "quota-test",
  name: "Quota test",
  api: "openai-codex-responses",
};
type Fixture = Awaited<ReturnType<typeof startGoalForTest>>;
const fixtures: Fixture[] = [];

async function start(overrides: Record<string, unknown> = {}, settings = enabledSettings) {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-08T00:00:00Z"));
  const fixture = await startGoalForTest({ model, ...overrides }, "finish the objective", settings);
  fixtures.push(fixture);
  beginPrompt(fixture);
  return fixture;
}

function beginPrompt(fixture: Fixture) {
  const prompt = fixture.mock.sentUserMessages.at(-1)?.text ?? "";
  fixture.mock.events.get("before_agent_start")?.[0]?.({ prompt, systemPrompt: "base" }, fixture.ctx);
  fixture.mock.events.get("agent_start")?.[0]?.({}, fixture.ctx);
}

async function end(fixture: Fixture, errorMessage: string | null = QUOTA_ERROR, content: unknown[] = []) {
  const message = {
    role: "assistant",
    stopReason: errorMessage === null ? "stop" : "error",
    errorMessage: errorMessage ?? undefined,
    content,
  };
  fixture.mock.events.get("turn_end")?.[0]?.({ message, toolResults: [] }, fixture.ctx);
  await fixture.mock.events.get("agent_end")?.[0]?.({ messages: [message] }, fixture.ctx);
  await fixture.mock.events.get("agent_settled")?.[0]?.({ aborted: false }, fixture.ctx);
}

afterEach(async () => {
  for (const fixture of fixtures.splice(0)) {
    await fixture.mock.events.get("session_shutdown")?.[0]?.({}, fixture.ctx);
  }
  vi.useRealTimers();
});

test("usage-limit recovery remains stopped by default", async () => {
  const fixture = await start({}, DEFAULT_SETTINGS_PATH);
  await end(fixture);
  assert.equal(requireLastGoal(fixture.mock).status, "usage_limited");
  await vi.advanceTimersByTimeAsync(RETRY_MS);
  assert.equal(fixture.mock.sentUserMessages.length, 1);
});

test("the reported quota error waits 15 minutes without a usage service and dispatches once", async () => {
  const fixture = await start();
  const id = requireLastGoal(fixture.mock).id;
  await end(fixture);
  const waiting = requireLastGoal(fixture.mock);
  assert.equal(waiting.status, "active");
  assert.equal(waiting.waiting?.resumeAt, Date.now() + RETRY_MS);
  assert.equal(waiting.activeStartedAt, undefined);
  await vi.advanceTimersByTimeAsync(RETRY_MS - 1);
  assert.equal(fixture.mock.sentUserMessages.length, 1);
  await vi.advanceTimersByTimeAsync(1);
  assert.equal(fixture.mock.sentUserMessages.length, 2);
  assert.equal(requireLastGoal(fixture.mock).id, id);
  await fixture.mock.events.get("agent_settled")?.[0]?.({}, fixture.ctx);
  await fixture.mock.events.get("agent_settled")?.[0]?.({}, fixture.ctx);
  assert.equal(fixture.mock.sentUserMessages.length, 2);
});

test("20 scheduled quota rejections preserve work allowance and real usage, then successful work counts", async () => {
  const branch: Record<string, unknown>[] = [];
  const fixture = await start({
    sessionManager: { getSessionId: () => "quota-session", getBranch: () => branch, getEntries: () => branch },
  });
  const id = requireLastGoal(fixture.mock).id;
  await end(fixture);
  const initial = requireLastGoal(fixture.mock).automaticModelTurns;
  for (let attempt = 1; attempt <= 20; attempt++) {
    await vi.advanceTimersByTimeAsync(RETRY_MS);
    assert.equal(fixture.mock.sentUserMessages.length, attempt + 1);
    beginPrompt(fixture);
    branch.push(assistantUsageEntry({ totalTokens: 2, input: 2, output: 0 }));
    await end(fixture);
    const waiting = requireLastGoal(fixture.mock);
    assert.equal(waiting.id, id);
    assert.equal(waiting.status, "active");
    assert.equal(waiting.automaticModelTurns, initial);
    assert.equal(waiting.toolFreeRepeatCount, 0);
    assert.equal(waiting.tokensUsed, attempt * 2);
  }
  await vi.advanceTimersByTimeAsync(RETRY_MS);
  beginPrompt(fixture);
  await end(fixture, null, [{ type: "text", text: "Verified progress." }]);
  assert.equal(requireLastGoal(fixture.mock).waiting, undefined);
  assert.equal(requireLastGoal(fixture.mock).automaticModelTurns, (initial ?? 0) + 1);
  assert.equal(requireLastGoal(fixture.mock).tokensUsed, 40);
});
