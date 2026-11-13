import assert from "node:assert/strict";
import { afterEach, beforeEach, test, vi } from "vitest";
import { createGoal, formatStatus } from "../src/runtime.js";
import {
  DEFAULT_SETTINGS_PATH,
  requireGoalTool,
  requireLastGoal,
  restoreStoredGoalForTest,
  startGoalForTest,
  UNLIMITED_SETTINGS_PATH,
} from "./support/goal-fixture.js";

const reasons = [
  {
    language: "English",
    reason: `${"Waiting for the external review service to report its final result. ".repeat(12)}Diagnostic tail.`,
  },
  { language: "Chinese", reason: `${"等待外部審查服務回報完整結果並確認所有必要條件。".repeat(30)}完整診斷結尾。` },
];
const limits = [
  { label: "finite", settings: DEFAULT_SETTINGS_PATH, limit: 25, automatic: "automatic 0/25" },
  { label: "unlimited", settings: UNLIMITED_SETTINGS_PATH, limit: null, automatic: "automatic Unlimited" },
];
const fixtures: Pick<Awaited<ReturnType<typeof startGoalForTest>>, "mock" | "ctx">[] = [];

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-13T00:00:00.000Z"));
});

afterEach(async () => {
  for (const fixture of fixtures.splice(0)) {
    await fixture.mock.events.get("session_shutdown")?.[0]?.({}, fixture.ctx);
  }
  vi.useRealTimers();
});

test("formatStatus ignores every waiting detail without mutating the Goal", () => {
  for (const reason of ["", ...reasons.map((entry) => entry.reason), "\u001b]0;unsafe\u0007\n\t"]) {
    for (const { limit } of limits) {
      for (const resumeAt of [undefined, Date.now() + 60_000]) {
        const goal = {
          ...createGoal("finish", 2_000, 0),
          automaticModelTurns: 123,
          waiting: { reason, ...(resumeAt === undefined ? {} : { resumeAt }) },
        };
        const before = structuredClone(goal);
        assert.equal(formatStatus(goal, limit), "waiting");
        assert.deepEqual(goal, before);
      }
    }
  }
});

for (const { language, reason } of reasons) {
  for (const { label, settings, automatic } of limits) {
    test.each([undefined, 60_000])(
      `long ${language} waiting stays compact with ${label} work and delay %s through restore and resume`,
      async (delay) => {
        const original = await startGoalForTest({}, "finish", settings);
        fixtures.push(original);
        const goal = requireLastGoal(original.mock);
        const result = await requireGoalTool(original.mock, "goal_wait").execute(
          "compact-wait",
          { goal_id: goal.id, reason, ...(delay === undefined ? {} : { resume_after_ms: delay }) },
          new AbortController().signal,
          () => undefined,
          original.ctx,
        );
        const expectedWait = { reason, ...(delay === undefined ? {} : { resumeAt: Date.now() + delay }) };
        assert.equal(result.terminate, true);
        assert.equal(result.details?.reason, reason);
        assert.equal(result.details?.resume_at, expectedWait.resumeAt);
        assert.equal(original.statuses.get("goal"), "waiting");
        assert.deepEqual(requireLastGoal(original.mock).waiting, expectedWait);
        const stored = structuredClone(requireLastGoal(original.mock));

        await original.mock.commands.get("goal")?.handler("status", original.ctx);
        const fullStatus = original.notifications.at(-1)?.message ?? "";
        assert.ok(fullStatus.includes(`Waiting: ${reason}`), "full status retains the complete reason");
        if (expectedWait.resumeAt === undefined) assert.doesNotMatch(fullStatus, /Resume deadline:/);
        else assert.ok(fullStatus.includes(`Resume deadline: ${new Date(expectedWait.resumeAt).toISOString()}`));
        assert.deepEqual(requireLastGoal(original.mock), stored);
        assert.equal(original.statuses.get("goal"), "waiting");

        await original.mock.events.get("session_shutdown")?.[0]?.({}, original.ctx);
        assert.equal(original.statuses.get("goal"), undefined);
        assert.deepEqual(requireLastGoal(original.mock).waiting, expectedWait);
        const restored = restoreStoredGoalForTest(stored, [], {}, settings);
        fixtures.push(restored);
        assert.equal(restored.statuses.get("goal"), "waiting");
        assert.deepEqual(requireLastGoal(restored.mock).waiting, expectedWait);
        assert.equal(restored.mock.sentUserMessages.length, 0);
        await restored.mock.commands.get("goal")?.handler("status", restored.ctx);
        assert.equal(restored.notifications.at(-1)?.message, fullStatus);

        await restored.mock.commands.get("goal")?.handler("resume", restored.ctx);
        const resumed = requireLastGoal(restored.mock);
        assert.equal(resumed.id, stored.id);
        assert.equal(resumed.status, "active");
        assert.equal(resumed.waiting, undefined);
        assert.equal(resumed.automaticModelTurns, stored.automaticModelTurns);
        assert.equal(resumed.toolFreeRepeatCount, stored.toolFreeRepeatCount);
        assert.equal(resumed.timeUsedSeconds, stored.timeUsedSeconds);
        assert.equal(restored.statuses.get("goal"), `active 0s · ${automatic}`);
        assert.equal(restored.mock.sentUserMessages.length, 1);
        await vi.advanceTimersByTimeAsync(60_000);
        assert.equal(restored.mock.sentUserMessages.length, 1, "resume cancels the previous wait deadline");
        await restored.mock.events.get("session_shutdown")?.[0]?.({}, restored.ctx);
        assert.equal(restored.statuses.get("goal"), undefined);
      },
    );
  }
}
