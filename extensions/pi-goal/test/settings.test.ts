import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	DEFAULT_GOAL_SETTINGS,
	DEFAULT_GOAL_SETTINGS_DOCUMENT,
	loadOrCreateGoalSettings,
	normalizeGoalSettings,
	readGoalSettings,
} from "../src/settings.js";

test("normalizeGoalSettings applies defaults and accepts bounded continuation limits", () => {
	assert.deepEqual(normalizeGoalSettings({}), DEFAULT_GOAL_SETTINGS);
	assert.deepEqual(normalizeGoalSettings({ futureOption: true }), DEFAULT_GOAL_SETTINGS);
	assert.deepEqual(normalizeGoalSettings({ toolVisibility: "always" }), {
		...DEFAULT_GOAL_SETTINGS,
		toolVisibility: "always",
	});
	assert.deepEqual(normalizeGoalSettings({ toolVisibility: "after-first-goal" }), {
		...DEFAULT_GOAL_SETTINGS,
		toolVisibility: "after-first-goal",
	});
	assert.deepEqual(
		normalizeGoalSettings({ experimental: { goals: true, futureOption: "kept-compatible" } }),
		{
			...DEFAULT_GOAL_SETTINGS,
			experimental: { goals: true },
		},
	);
	assert.deepEqual(normalizeGoalSettings({ continuationLimits: {} }), DEFAULT_GOAL_SETTINGS);
	assert.deepEqual(normalizeGoalSettings({ continuationLimits: { automaticTurns: 7 } }), {
		...DEFAULT_GOAL_SETTINGS,
		continuationLimits: { automaticTurns: 7, noProgressTurns: 3 },
	});
	assert.deepEqual(normalizeGoalSettings({ continuationLimits: { noProgressTurns: 2 } }), {
		...DEFAULT_GOAL_SETTINGS,
		continuationLimits: { automaticTurns: 25, noProgressTurns: 2 },
	});
	assert.deepEqual(
		normalizeGoalSettings({
			continuationLimits: { automaticTurns: null, noProgressTurns: null, future: true },
		}),
		{
			...DEFAULT_GOAL_SETTINGS,
			continuationLimits: { automaticTurns: null, noProgressTurns: null },
		},
	);

	for (const value of [
		null,
		[],
		"always",
		{ toolVisibility: "sometimes" },
		{ experimental: true },
		{ experimental: { goals: "yes" } },
		{ continuationLimits: true },
		{ continuationLimits: [] },
		{ continuationLimits: { automaticTurns: 0 } },
		{ continuationLimits: { automaticTurns: -1 } },
		{ continuationLimits: { automaticTurns: 1.5 } },
		{ continuationLimits: { automaticTurns: Number.MAX_SAFE_INTEGER + 1 } },
		{ continuationLimits: { noProgressTurns: "3" } },
	]) {
		assert.equal(normalizeGoalSettings(value), undefined);
	}
});

test("loadOrCreateGoalSettings creates a readable complete default document", async (t) => {
	const directory = await mkdtemp(join(tmpdir(), "pi-goal-settings-create-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const settingsPath = join(directory, "nested", "pi-goal.json");

	assert.deepEqual(loadOrCreateGoalSettings(settingsPath), {
		kind: "loaded",
		settings: DEFAULT_GOAL_SETTINGS,
	});
	assert.equal(readFileSync(settingsPath, "utf8"), DEFAULT_GOAL_SETTINGS_DOCUMENT);
	assert.equal(
		DEFAULT_GOAL_SETTINGS_DOCUMENT,
		`${JSON.stringify(DEFAULT_GOAL_SETTINGS, null, 2)}\n`,
	);
});

test("loadOrCreateGoalSettings never overwrites existing valid or invalid settings", async (t) => {
	const directory = await mkdtemp(join(tmpdir(), "pi-goal-settings-existing-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const settingsPath = join(directory, "pi-goal.json");
	const validDocument = '{"toolVisibility":"after-first-goal"}\n';
	writeFileSync(settingsPath, validDocument);

	assert.deepEqual(loadOrCreateGoalSettings(settingsPath), {
		kind: "loaded",
		settings: {
			...DEFAULT_GOAL_SETTINGS,
			toolVisibility: "after-first-goal",
		},
	});
	assert.equal(readFileSync(settingsPath, "utf8"), validDocument);

	const invalidDocument = "{invalid";
	writeFileSync(settingsPath, invalidDocument);
	assert.equal(loadOrCreateGoalSettings(settingsPath).kind, "invalid");
	assert.equal(readFileSync(settingsPath, "utf8"), invalidDocument);
});

test("loadOrCreateGoalSettings reports creation failures and removes temporary files", async (t) => {
	const directory = await mkdtemp(join(tmpdir(), "pi-goal-settings-failure-"));
	t.after(() => rm(directory, { recursive: true, force: true }));

	for (const [name, overrides] of [
		[
			"directory",
			{
				mkdirSync() {
					throw new Error("mkdir failed");
				},
			},
		],
		[
			"temporary file",
			{
				writeFileSync() {
					throw new Error("write failed");
				},
			},
		],
		[
			"publish",
			{
				linkSync() {
					throw new Error("publish failed");
				},
			},
		],
	] as const) {
		const parent = join(directory, name);
		const settingsPath = join(parent, "pi-goal.json");
		const result = loadOrCreateGoalSettings(settingsPath, overrides);
		assert.equal(result.kind, "create-failed");
		assert.match(result.kind === "create-failed" ? result.reason : "", /failed/);
		assert.equal(existsSync(settingsPath), false);
		assert.deepEqual(existsSync(parent) ? readdirSync(parent) : [], []);
	}
});

test("loadOrCreateGoalSettings adopts a concurrent winner without overwriting it", async (t) => {
	const directory = await mkdtemp(join(tmpdir(), "pi-goal-settings-race-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const settingsPath = join(directory, "pi-goal.json");
	const winnerDocument = '{"experimental":{"goals":true}}\n';

	const result = loadOrCreateGoalSettings(settingsPath, {
		linkSync(_temporaryPath, targetPath) {
			writeFileSync(targetPath, winnerDocument);
			throw Object.assign(new Error("already exists"), { code: "EEXIST" });
		},
	});

	assert.deepEqual(result, {
		kind: "loaded",
		settings: {
			...DEFAULT_GOAL_SETTINGS,
			experimental: { goals: true },
		},
	});
	assert.equal(readFileSync(settingsPath, "utf8"), winnerDocument);
	assert.deepEqual(readdirSync(directory), ["pi-goal.json"]);
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
			continuationLimits: { automaticTurns: 25, noProgressTurns: 3 },
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
