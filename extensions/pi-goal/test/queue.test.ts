import assert from "node:assert/strict";
import test from "node:test";
import type { ActiveGoal } from "../src/persistence.js";
import {
	activateQueuedGoal,
	appendGoal,
	createQueuedGoal,
	dropLastGoal,
	prioritizeGoal,
	skipGoal,
} from "../src/queue.js";

test("queue structural operations preserve array order", () => {
	const head = goal("head", "active");
	const second = goal("second", "queued");
	const third = goal("third", "queued");

	assert.deepEqual(
		appendGoal([second], third).map(({ text }) => text),
		["second", "third"],
	);
	const prioritized = prioritizeGoal(head, [second], third, 2_000);
	assert.ok(prioritized.goal);
	assert.equal(prioritized.goal.text, "third");
	assert.deepEqual(
		prioritized.queue.map(({ text }) => text),
		["head", "second"],
	);
	assert.equal(prioritized.queue[0]?.status, "queued");

	const dropped = dropLastGoal(head, [second, third]);
	assert.equal(dropped.removed?.text, "third");
	assert.equal(dropped.goal?.text, "head");
	assert.deepEqual(
		dropped.queue.map(({ text }) => text),
		["second"],
	);

	const skipped = skipGoal([second, third]);
	assert.equal(skipped.goal?.text, "second");
	assert.deepEqual(
		skipped.queue.map(({ text }) => text),
		["third"],
	);
});

test("dropping the only goal clears the head", () => {
	const dropped = dropLastGoal(goal("only", "active"), []);
	assert.equal(dropped.goal, undefined);
	assert.equal(dropped.removed?.text, "only");
	assert.deepEqual(dropped.queue, []);
});

test("queued goals activate with fresh ids and rebased independent accounting", () => {
	const queued = { ...createQueuedGoal("later", 2_000, 1_000), id: "old-id", tokensUsed: 75 };
	const activated = activateQueuedGoal(queued, 1_500, 2_000);
	assert.notEqual(activated.id, "old-id");
	assert.equal(activated.status, "active");
	assert.equal(activated.baselineTokens, 1_425);
	assert.equal(activated.tokensUsed, 75);
	assert.equal(activated.activeStartedAt, 2_000);
});

test("stopped queued heads keep their status until explicit resume", () => {
	for (const status of ["paused", "blocked", "usage_limited", "budget_limited"] as const) {
		const stopped = goal(status, status);
		const restored = activateQueuedGoal(stopped, 500, 2_000);
		assert.equal(restored.status, status);
		assert.equal(restored.id, stopped.id);
		assert.equal(restored.activeStartedAt, undefined);
	}
});

function goal(text: string, status: ActiveGoal["status"]): ActiveGoal {
	return {
		id: `${text}-id`,
		text,
		status,
		startedAt: 1_000,
		updatedAt: 1_000,
		iteration: 0,
		tokensUsed: 0,
		timeUsedSeconds: 0,
		baselineTokens: 0,
		...(status === "active" ? { activeStartedAt: 1_000 } : {}),
	};
}
