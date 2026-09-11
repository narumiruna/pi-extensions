import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import { DEFAULT_GOAL_SETTINGS, normalizeGoalSettings, readGoalSettings, saveGoalSettings } from "../src/settings.js";

const DEFAULT_GOAL_SETTINGS_DOCUMENT = `${JSON.stringify(DEFAULT_GOAL_SETTINGS, null, 2)}\n`;

test("normalizeGoalSettings applies defaults and ignores retired tool visibility", () => {
  assert.equal("toolVisibility" in DEFAULT_GOAL_SETTINGS, false);
  assert.equal(DEFAULT_GOAL_SETTINGS.continuationLimits.automaticTurns, 25);
  assert.deepEqual(DEFAULT_GOAL_SETTINGS.rpc, { enabled: false });
  assert.deepEqual(normalizeGoalSettings({}), DEFAULT_GOAL_SETTINGS);
  assert.deepEqual(normalizeGoalSettings({ futureOption: true }), DEFAULT_GOAL_SETTINGS);
  assert.deepEqual(normalizeGoalSettings({ toolVisibility: "always" }), DEFAULT_GOAL_SETTINGS);
  assert.deepEqual(normalizeGoalSettings({ toolVisibility: "after-first-goal" }), DEFAULT_GOAL_SETTINGS);
  assert.deepEqual(normalizeGoalSettings({ toolVisibility: "sometimes" }), DEFAULT_GOAL_SETTINGS);
  assert.deepEqual(
    normalizeGoalSettings({ experimental: { goals: true, futureOption: "kept-compatible" } }),
    DEFAULT_GOAL_SETTINGS,
  );
  assert.deepEqual(normalizeGoalSettings({ experimental: true }), DEFAULT_GOAL_SETTINGS);
  assert.deepEqual(normalizeGoalSettings({ experimental: { goals: "yes" } }), DEFAULT_GOAL_SETTINGS);
  assert.deepEqual(normalizeGoalSettings({ rpc: {} }), DEFAULT_GOAL_SETTINGS);
  assert.deepEqual(normalizeGoalSettings({ rpc: { enabled: true } }), {
    ...DEFAULT_GOAL_SETTINGS,
    rpc: { enabled: true },
  });
  assert.deepEqual(normalizeGoalSettings({ rpc: { enabled: false, future: true } }), {
    ...DEFAULT_GOAL_SETTINGS,
    rpc: { enabled: false },
  });
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
    { rpc: true },
    { rpc: [] },
    { rpc: { enabled: "yes" } },
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

test("saveGoalSettings creates a complete document only on explicit save", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "pi-goal-settings-create-"));
  t.onTestFinished(() => rm(directory, { recursive: true, force: true }));
  const parent = join(directory, "nested");
  const settingsPath = join(parent, "pi-goal.json");

  assert.deepEqual(readGoalSettings(settingsPath), {
    kind: "missing",
    legacyExperimentalGoals: false,
  });
  assert.equal(existsSync(parent), false);

  saveGoalSettings(DEFAULT_GOAL_SETTINGS, settingsPath);

  assert.equal(readFileSync(settingsPath, "utf8"), DEFAULT_GOAL_SETTINGS_DOCUMENT);
  assert.deepEqual(readdirSync(parent), ["pi-goal.json"]);
});

test("saveGoalSettings atomically preserves unknown top-level and nested fields", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "pi-goal-settings-save-"));
  t.onTestFinished(() => rm(directory, { recursive: true, force: true }));
  const settingsPath = join(directory, "pi-goal.json");
  writeFileSync(
    settingsPath,
    JSON.stringify({
      future: { enabled: true },
      toolVisibility: "after-first-goal",
      experimental: { goals: true, futureQueue: "keep" },
      rpc: { enabled: true, futureRpc: "keep" },
      continuationLimits: { automaticTurns: 25, noProgressTurns: 3, futureLimit: 9 },
    }),
  );

  saveGoalSettings(
    {
      rpc: { enabled: false },
      continuationLimits: { automaticTurns: 40, noProgressTurns: null },
    },
    settingsPath,
  );

  assert.deepEqual(JSON.parse(readFileSync(settingsPath, "utf8")), {
    future: { enabled: true },
    toolVisibility: "after-first-goal",
    experimental: { goals: true, futureQueue: "keep" },
    rpc: { enabled: false, futureRpc: "keep" },
    continuationLimits: { automaticTurns: 40, noProgressTurns: null, futureLimit: 9 },
  });
  assert.deepEqual(readdirSync(directory), ["pi-goal.json"]);
});

test("saveGoalSettings refuses malformed files and cleans a failed atomic write", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "pi-goal-settings-save-failure-"));
  t.onTestFinished(() => rm(directory, { recursive: true, force: true }));
  const settingsPath = join(directory, "pi-goal.json");
  writeFileSync(settingsPath, "{invalid");
  assert.throws(() => saveGoalSettings(DEFAULT_GOAL_SETTINGS, settingsPath), /invalid settings/i);
  assert.equal(readFileSync(settingsPath, "utf8"), "{invalid");

  writeFileSync(settingsPath, DEFAULT_GOAL_SETTINGS_DOCUMENT);
  assert.throws(
    () =>
      saveGoalSettings(DEFAULT_GOAL_SETTINGS, settingsPath, {
        renameSync() {
          throw new Error("rename failed");
        },
      }),
    /rename failed/,
  );
  assert.equal(readFileSync(settingsPath, "utf8"), DEFAULT_GOAL_SETTINGS_DOCUMENT);
  assert.deepEqual(readdirSync(directory), ["pi-goal.json"]);
});

test("readGoalSettings distinguishes missing, loaded, legacy, malformed, and unreadable files", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "pi-goal-settings-"));
  t.onTestFinished(() => rm(directory, { recursive: true, force: true }));
  const settingsPath = join(directory, "pi-goal.json");

  assert.deepEqual(readGoalSettings(settingsPath), {
    kind: "missing",
    legacyExperimentalGoals: false,
  });

  await writeFile(settingsPath, '{"toolVisibility":"after-first-goal","experimental":{"goals":true}}\n', "utf8");
  assert.deepEqual(readGoalSettings(settingsPath), {
    kind: "loaded",
    settings: {
      rpc: { enabled: false },
      continuationLimits: { automaticTurns: 25, noProgressTurns: 3 },
    },
    legacyExperimentalGoals: true,
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
