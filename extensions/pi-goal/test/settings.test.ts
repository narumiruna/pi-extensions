import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DEFAULT_GOAL_SETTINGS, normalizeGoalSettings, readGoalSettings } from "../src/settings.js";

test("normalizeGoalSettings defaults visibility and experimental goals", () => {
	assert.deepEqual(normalizeGoalSettings({}), DEFAULT_GOAL_SETTINGS);
	assert.deepEqual(normalizeGoalSettings({ futureOption: true }), DEFAULT_GOAL_SETTINGS);
	assert.deepEqual(normalizeGoalSettings({ toolVisibility: "always" }), {
		toolVisibility: "always",
		experimental: { goals: false },
	});
	assert.deepEqual(normalizeGoalSettings({ toolVisibility: "after-first-goal" }), {
		toolVisibility: "after-first-goal",
		experimental: { goals: false },
	});
	assert.deepEqual(
		normalizeGoalSettings({ experimental: { goals: true, futureOption: "kept-compatible" } }),
		{
			toolVisibility: "always",
			experimental: { goals: true },
		},
	);

	for (const value of [
		null,
		[],
		"always",
		{ toolVisibility: "sometimes" },
		{ experimental: true },
		{ experimental: { goals: "yes" } },
	]) {
		assert.equal(normalizeGoalSettings(value), undefined);
	}
});

test("readGoalSettings distinguishes missing, loaded, malformed, and unreadable files", async (t) => {
	const directory = await mkdtemp(join(tmpdir(), "pi-goal-settings-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const settingsPath = join(directory, "pi-goal.json");

	assert.deepEqual(readGoalSettings(settingsPath), { kind: "missing" });

	await writeFile(
		settingsPath,
		'{"toolVisibility":"after-first-goal","experimental":{"goals":true}}\n',
		"utf8",
	);
	assert.deepEqual(readGoalSettings(settingsPath), {
		kind: "loaded",
		settings: {
			toolVisibility: "after-first-goal",
			experimental: { goals: true },
		},
	});

	await writeFile(settingsPath, "{invalid", "utf8");
	const malformed = readGoalSettings(settingsPath);
	assert.equal(malformed.kind, "invalid");
	assert.match(malformed.kind === "invalid" ? malformed.reason : "", /pi-goal\.json/);

	await mkdir(join(directory, "not-a-file"));
	const unreadable = readGoalSettings(join(directory, "not-a-file"));
	assert.equal(unreadable.kind, "invalid");
	assert.match(unreadable.kind === "invalid" ? unreadable.reason : "", /not-a-file/);
});
