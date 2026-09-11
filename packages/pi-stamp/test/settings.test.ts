import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { rename, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { type TestContext, test } from "vitest";
import { DEFAULT_STAMP_SETTINGS } from "../src/format.js";
import { createStampSettingsRuntime, loadStampSettings, normalizeStampSettingsDocument } from "../src/settings.js";

function temporarySettings(t: TestContext) {
  const directory = mkdtempSync(path.join(os.tmpdir(), "pi-stamp-settings-"));
  t.onTestFinished(() => rmSync(directory, { recursive: true, force: true }));
  return { directory, settingsPath: path.join(directory, "agent", "pi-stamp.json") };
}

test("missing settings load defaults without materializing the parent", async (t) => {
  const { directory, settingsPath } = temporarySettings(t);
  const loaded = await loadStampSettings(settingsPath);
  assert.equal(loaded.kind, "missing");
  assert.deepEqual(loaded.settings, DEFAULT_STAMP_SETTINGS);
  assert.equal(statExists(path.join(directory, "agent")), false);
});

test("normalization accepts partial settings, canonicalizes locale and zone, and rejects fields", () => {
  assert.deepEqual(
    normalizeStampSettingsDocument({
      hourCycle: "12h",
      locale: "EN-us",
      timeZone: "utc",
      responseTiming: "detailed",
      assistantMetadata: "expanded",
      showExactTimeline: false,
      showThinkingLevel: false,
      showCompactAbnormalOutcome: false,
      showCostSinceUser: true,
      toolStamps: true,
      future: { retained: true },
    }),
    {
      settings: {
        ...DEFAULT_STAMP_SETTINGS,
        hourCycle: "12h",
        locale: "en-US",
        timeZone: "UTC",
        responseTiming: "detailed",
        assistantMetadata: "expanded",
        showExactTimeline: false,
        showThinkingLevel: false,
        showCompactAbnormalOutcome: false,
        showCostSinceUser: true,
        toolStamps: true,
      },
      sources: {
        hourCycle: "user",
        showSeconds: "built-in",
        dateContext: "built-in",
        locale: "user",
        timeZone: "user",
        responseTiming: "user",
        assistantMetadata: "user",
        showExactTimeline: "user",
        showThinkingLevel: "user",
        showCompactAbnormalOutcome: "user",
        showCostSinceUser: "user",
        toolStamps: "user",
      },
    },
  );
  for (const value of [
    null,
    [],
    { hourCycle: "wide" },
    { showSeconds: "yes" },
    { dateContext: "sometimes" },
    { locale: "not_a_locale" },
    { timeZone: "Moon/Base" },
    { responseTiming: "sometimes" },
    { responseTiming: false },
    { assistantMetadata: "verbose" },
    { assistantMetadata: true },
    { showExactTimeline: "yes" },
    { showThinkingLevel: "yes" },
    { showCompactAbnormalOutcome: "yes" },
    { showCostSinceUser: "yes" },
    { toolStamps: "yes" },
  ]) {
    assert.equal(normalizeStampSettingsDocument(value), undefined);
  }
  for (const responseTiming of ["off", "duration", "detailed"] as const) {
    assert.equal(normalizeStampSettingsDocument({ responseTiming })?.settings.responseTiming, responseTiming);
  }
  for (const assistantMetadata of ["off", "compact", "expanded"] as const) {
    assert.equal(normalizeStampSettingsDocument({ assistantMetadata })?.settings.assistantMetadata, assistantMetadata);
  }
  for (const field of [
    "showExactTimeline",
    "showThinkingLevel",
    "showCompactAbnormalOutcome",
    "showCostSinceUser",
    "toolStamps",
  ] as const) {
    for (const value of [false, true]) {
      assert.equal(normalizeStampSettingsDocument({ [field]: value })?.settings[field], value);
    }
  }
});

test("updates preserve unknown and omitted fields and publish private JSON atomically", async (t) => {
  const { settingsPath } = temporarySettings(t);
  mkdirSync(path.dirname(settingsPath), { recursive: true });
  writeFileSync(settingsPath, `${JSON.stringify({ showSeconds: false, future: { retained: true } }, null, 2)}\n`);
  const runtime = createStampSettingsRuntime({ path: settingsPath });
  await runtime.reload();
  await runtime.update({ hourCycle: "12h" });
  await runtime.update({ responseTiming: "duration" });
  await runtime.update({ assistantMetadata: "compact" });
  await runtime.update({ showExactTimeline: false });
  await runtime.update({ showThinkingLevel: false });
  await runtime.update({ showCompactAbnormalOutcome: false });
  await runtime.update({ showCostSinceUser: true });
  await runtime.update({ toolStamps: true });

  assert.deepEqual(JSON.parse(readFileSync(settingsPath, "utf8")), {
    showSeconds: false,
    future: { retained: true },
    hourCycle: "12h",
    responseTiming: "duration",
    assistantMetadata: "compact",
    showExactTimeline: false,
    showThinkingLevel: false,
    showCompactAbnormalOutcome: false,
    showCostSinceUser: true,
    toolStamps: true,
  });
  assert.deepEqual(runtime.get().settings, {
    ...DEFAULT_STAMP_SETTINGS,
    showSeconds: false,
    hourCycle: "12h",
    responseTiming: "duration",
    assistantMetadata: "compact",
    showExactTimeline: false,
    showThinkingLevel: false,
    showCompactAbnormalOutcome: false,
    showCostSinceUser: true,
    toolStamps: true,
  });
  assert.equal(runtime.get().sources.responseTiming, "user");
  assert.equal(runtime.get().sources.assistantMetadata, "user");
  assert.equal(runtime.get().sources.showExactTimeline, "user");
  assert.equal(runtime.get().sources.showThinkingLevel, "user");
  assert.equal(runtime.get().sources.showCompactAbnormalOutcome, "user");
  assert.equal(runtime.get().sources.showCostSinceUser, "user");
  assert.equal(runtime.get().sources.toolStamps, "user");
  if (process.platform !== "win32") {
    assert.equal(statSync(settingsPath).mode & 0o777, 0o600);
  }
  assert.deepEqual(listTemporaryFiles(settingsPath), []);
});

test("malformed and invalid files stay byte-for-byte unchanged and block updates", async (t) => {
  for (const contents of ["{bad json\n", '{"showSeconds":"yes"}\n']) {
    const { settingsPath } = temporarySettings(t);
    mkdirSync(path.dirname(settingsPath), { recursive: true });
    writeFileSync(settingsPath, contents);
    const runtime = createStampSettingsRuntime({ path: settingsPath });
    const state = await runtime.reload();
    assert.ok(state.issue);
    await assert.rejects(runtime.update({ showSeconds: false }), /invalid|malformed/u);
    assert.equal(readFileSync(settingsPath, "utf8"), contents);
    assert.deepEqual(runtime.get().settings, DEFAULT_STAMP_SETTINGS);
  }
});

test("publication failure retains effective state, cleans temporary files, and queue recovers", async (t) => {
  const { settingsPath } = temporarySettings(t);
  let rejectRename = true;
  const runtime = createStampSettingsRuntime({
    path: settingsPath,
    operations: {
      rename: async (source: Parameters<typeof rename>[0], destination: Parameters<typeof rename>[1]) => {
        if (rejectRename) throw new Error("rename rejected");
        await rename(source, destination);
      },
    },
  });
  await runtime.reload();
  await assert.rejects(runtime.update({ showSeconds: false }), /rename rejected/u);
  assert.deepEqual(runtime.get().settings, DEFAULT_STAMP_SETTINGS);
  assert.deepEqual(listTemporaryFiles(settingsPath), []);

  rejectRename = false;
  await runtime.update({ showSeconds: false });
  assert.equal(runtime.get().settings.showSeconds, false);
});

test("concurrent updates serialize in call order and reload waits for pending publication", async (t) => {
  const { settingsPath } = temporarySettings(t);
  let releaseFirst!: () => void;
  const firstWrite = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  let writes = 0;
  const runtime = createStampSettingsRuntime({
    path: settingsPath,
    operations: {
      writeFile: async (
        file: Parameters<typeof writeFile>[0],
        data: Parameters<typeof writeFile>[1],
        options: Parameters<typeof writeFile>[2],
      ) => {
        writes += 1;
        if (writes === 1) await firstWrite;
        await writeFile(file, data, options);
      },
    },
  });
  await runtime.reload();
  const first = runtime.update({ hourCycle: "12h" });
  const second = runtime.update({ showSeconds: false });
  const reloadPromise = runtime.reload();
  await Promise.resolve();
  assert.equal(runtime.get().settings.hourCycle, "24h");
  releaseFirst();
  await Promise.all([first, second, reloadPromise, runtime.flush()]);
  assert.deepEqual(runtime.get().settings, {
    ...DEFAULT_STAMP_SETTINGS,
    hourCycle: "12h",
    showSeconds: false,
  });
});

test("oversized, directory, and symlink settings paths are invalid", async (t) => {
  const { directory, settingsPath } = temporarySettings(t);
  mkdirSync(path.dirname(settingsPath), { recursive: true });
  writeFileSync(settingsPath, " ".repeat(64 * 1024 + 1));
  assert.equal((await loadStampSettings(settingsPath)).kind, "invalid");

  const directoryPath = path.join(directory, "settings-dir");
  mkdirSync(directoryPath);
  assert.equal((await loadStampSettings(directoryPath)).kind, "invalid");

  if (process.platform !== "win32") {
    const target = path.join(directory, "target.json");
    writeFileSync(target, "{}\n");
    const symlink = path.join(directory, "settings-link.json");
    symlinkSync(target, symlink);
    assert.equal((await loadStampSettings(symlink)).kind, "invalid");
  }
});

function statExists(target: string) {
  try {
    statSync(target);
    return true;
  } catch {
    return false;
  }
}

function listTemporaryFiles(settingsPath: string) {
  try {
    return readdirSync(path.dirname(settingsPath)).filter((name) => name.endsWith(".tmp"));
  } catch {
    return [];
  }
}
