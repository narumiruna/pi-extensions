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
import { onTestFinished, type TestContext, test } from "vitest";
import { DEFAULT_STAMP_SETTINGS } from "../src/format.js";
import {
  LEGACY_METADATA_MODES,
  legacyMetadataSettings,
  METADATA_BOOLEAN_FIELDS,
  METADATA_LAYOUTS,
  METADATA_SETTING_FIELDS,
  STOP_REASON_MODES,
  type StampMetadataSettings,
} from "../src/metadata-settings.js";
import {
  createStampSettingsRuntime,
  loadStampSettings,
  normalizeStampSettingsDocument,
  type StampSettingsPatch,
} from "../src/settings.js";

const LEGACY_FIELDS = ["assistantMetadata", "showThinkingLevel", "showCompactAbnormalOutcome"] as const;
const legacyCases = [undefined, ...LEGACY_METADATA_MODES].flatMap((mode) =>
  [undefined, false, true].flatMap((thinking) =>
    [undefined, false, true].map((abnormal) => ({
      name: `${mode ?? "missing"}/${thinking ?? "missing"}/${abnormal ?? "missing"}`,
      document: {
        ...(mode === undefined ? {} : { assistantMetadata: mode }),
        ...(thinking === undefined ? {} : { showThinkingLevel: thinking }),
        ...(abnormal === undefined ? {} : { showCompactAbnormalOutcome: abnormal }),
      },
      expected: legacyMetadataSettings(mode ?? "off", thinking ?? true, abnormal ?? true),
    })),
  ),
);
const metadataOverrides = [
  ...METADATA_BOOLEAN_FIELDS.flatMap(
    (field) =>
      [
        [field, false],
        [field, true],
      ] as const,
  ),
  ...METADATA_LAYOUTS.map((layout) => ["metadataLayout", layout] as const),
  ...STOP_REASON_MODES.map((reason) => ["stopReason", reason] as const),
];

function temporarySettings(t: Pick<TestContext, "onTestFinished"> = { onTestFinished }) {
  const directory = mkdtempSync(path.join(os.tmpdir(), "pi-stamp-settings-"));
  t.onTestFinished(() => rmSync(directory, { recursive: true, force: true }));
  return { directory, settingsPath: path.join(directory, "agent", "pi-stamp.json") };
}

test("missing settings load defaults without materializing the parent", async (t) => {
  const { directory, settingsPath } = temporarySettings(t);
  const loaded = await loadStampSettings(settingsPath);
  assert.equal(loaded.kind, "missing");
  assert.deepEqual(loaded.settings, DEFAULT_STAMP_SETTINGS);
  assert.deepEqual(Object.keys(loaded.sources).sort(), Object.keys(DEFAULT_STAMP_SETTINGS).sort());
  assert.ok(Object.values(loaded.sources).every((source) => source === "built-in"));
  assert.equal(statExists(path.join(directory, "agent")), false);
});

test("normalization uses metadata-off defaults and tracks every canonical field", () => {
  const normalized = normalizeStampSettingsDocument({});
  assert.ok(normalized);
  assert.deepEqual(normalized.settings, DEFAULT_STAMP_SETTINGS);
  assert.deepEqual(Object.keys(normalized.sources).sort(), Object.keys(DEFAULT_STAMP_SETTINGS).sort());
  assert.ok(Object.values(normalized.sources).every((source) => source === "built-in"));
  assert.equal(normalized.settings.metadataLayout, "compact");
  assert.equal(normalized.settings.stopReason, "hidden");
  for (const field of METADATA_BOOLEAN_FIELDS) assert.equal(normalized.settings[field], false, field);
  for (const field of LEGACY_FIELDS) {
    assert.equal(Object.hasOwn(normalized.settings, field), false);
    assert.equal(Object.hasOwn(normalized.sources, field), false);
  }
});

test("normalization accepts partial settings and canonicalizes locale and zone", () => {
  const patch: StampSettingsPatch = {
    hourCycle: "12h",
    showSeconds: false,
    dateContext: "always",
    locale: "EN-us",
    timeZone: "utc",
    responseTiming: "detailed",
    metadataLayout: "expanded",
    showRequestedModel: true,
    showPiThinkingLevel: false,
    stopReason: "all",
    showResponseId: true,
    showDiagnostics: true,
    showExactTimeline: false,
    showCostSinceUser: true,
    showTimeSinceUser: true,
    toolStamps: true,
  };
  const normalized = normalizeStampSettingsDocument({ ...patch, future: { retained: true } });
  assert.ok(normalized);
  assert.deepEqual(normalized.settings, {
    ...DEFAULT_STAMP_SETTINGS,
    ...patch,
    locale: "en-US",
    timeZone: "UTC",
  });
  for (const field of Object.keys(DEFAULT_STAMP_SETTINGS) as (keyof typeof DEFAULT_STAMP_SETTINGS)[]) {
    assert.equal(normalized.sources[field], Object.hasOwn(patch, field) ? "user" : "built-in", field);
  }
});

test("normalization rejects invalid canonical values and accepts all boolean and enum choices", () => {
  for (const value of [
    null,
    [],
    true,
    "settings",
    { hourCycle: "wide" },
    { showSeconds: "yes" },
    { dateContext: "sometimes" },
    { locale: "not_a_locale" },
    { timeZone: "Moon/Base" },
    { responseTiming: "sometimes" },
    { responseTiming: false },
    { showExactTimeline: "yes" },
    { showCostSinceUser: "yes" },
    { showTimeSinceUser: "yes" },
    { showOutputThroughput: "yes" },
    { toolStamps: "yes" },
  ]) {
    assert.equal(normalizeStampSettingsDocument(value), undefined);
  }
  for (const responseTiming of ["off", "duration", "detailed"] as const) {
    assert.equal(normalizeStampSettingsDocument({ responseTiming })?.settings.responseTiming, responseTiming);
  }
  for (const hourCycle of ["12h", "24h"] as const) {
    assert.equal(normalizeStampSettingsDocument({ hourCycle })?.settings.hourCycle, hourCycle);
  }
  for (const dateContext of ["always", "never", "day-change"] as const) {
    assert.equal(normalizeStampSettingsDocument({ dateContext })?.settings.dateContext, dateContext);
  }
  for (const field of [
    "showSeconds",
    "showExactTimeline",
    "showCostSinceUser",
    "showTimeSinceUser",
    "showOutputThroughput",
    "toolStamps",
    ...METADATA_BOOLEAN_FIELDS,
  ] as const) {
    for (const value of [false, true]) {
      const normalized = normalizeStampSettingsDocument({ [field]: value });
      assert.equal(normalized?.settings[field], value, field);
      assert.equal(normalized?.sources[field], "user", field);
    }
    for (const value of [undefined, null, 0, 1, "true", "false", [], {}]) {
      assert.equal(normalizeStampSettingsDocument({ assistantMetadata: "off", [field]: value }), undefined, field);
    }
  }
  for (const metadataLayout of METADATA_LAYOUTS) {
    assert.equal(normalizeStampSettingsDocument({ metadataLayout })?.settings.metadataLayout, metadataLayout);
    assert.equal(normalizeStampSettingsDocument({ metadataLayout })?.sources.metadataLayout, "user");
  }
  for (const stopReason of STOP_REASON_MODES) {
    assert.equal(normalizeStampSettingsDocument({ stopReason })?.settings.stopReason, stopReason);
    assert.equal(normalizeStampSettingsDocument({ stopReason })?.sources.stopReason, "user");
  }
  for (const value of [undefined, null, true, false, 0, [], {}, "off", "wide", "Compact"]) {
    assert.equal(normalizeStampSettingsDocument({ metadataLayout: value }), undefined);
    assert.equal(normalizeStampSettingsDocument({ stopReason: value }), undefined);
  }
});

test.each(legacyCases)(
  "legacy $name translates per field and accepts independent canonical overrides",
  ({ document, expected }) => {
    const normalized = normalizeStampSettingsDocument(document);
    assert.ok(normalized);
    assert.deepEqual(normalized.settings, { ...DEFAULT_STAMP_SETTINGS, ...expected });
    for (const field of METADATA_SETTING_FIELDS) {
      assert.equal(
        normalized.sources[field],
        Object.hasOwn(document, "assistantMetadata") ? "user" : "built-in",
        field,
      );
    }
    for (const field of LEGACY_FIELDS) {
      assert.equal(Object.hasOwn(normalized.settings, field), false);
      assert.equal(Object.hasOwn(normalized.sources, field), false);
    }
    for (const [field, value] of metadataOverrides) {
      const overridden = normalizeStampSettingsDocument({ ...document, [field]: value });
      assert.ok(overridden);
      assert.deepEqual(overridden.settings, { ...DEFAULT_STAMP_SETTINGS, ...expected, [field]: value });
      assert.deepEqual(overridden.sources, { ...normalized.sources, [field]: "user" });
    }
  },
);

test("normalization ignores inherited legacy values and validates inactive own values", () => {
  const inherited = Object.create({
    assistantMetadata: "expanded",
    showThinkingLevel: "invalid",
    showCompactAbnormalOutcome: "invalid",
  });
  assert.deepEqual(normalizeStampSettingsDocument(inherited), normalizeStampSettingsDocument({}));
  for (const assistantMetadata of [undefined, null, true, 0, [], {}, "verbose", "none"]) {
    assert.equal(normalizeStampSettingsDocument({ assistantMetadata }), undefined);
  }
  for (const assistantMetadata of [undefined, ...LEGACY_METADATA_MODES]) {
    const mode = assistantMetadata === undefined ? {} : { assistantMetadata };
    for (const field of ["showThinkingLevel", "showCompactAbnormalOutcome"] as const) {
      for (const value of [undefined, null, 0, "yes", [], {}]) {
        assert.equal(
          normalizeStampSettingsDocument({ ...mode, [field]: value, showPiThinkingLevel: false, stopReason: "hidden" }),
          undefined,
        );
      }
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
  await runtime.update({ metadataLayout: "expanded" });
  await runtime.update({ showRequestedModel: true });
  await runtime.update({ showExactTimeline: false });
  await runtime.update({ showPiThinkingLevel: false });
  await runtime.update({ stopReason: "abnormal" });
  await runtime.update({ showCostSinceUser: true });
  await runtime.update({ showTimeSinceUser: true });
  await runtime.update({ toolStamps: true });

  assert.deepEqual(JSON.parse(readFileSync(settingsPath, "utf8")), {
    showSeconds: false,
    future: { retained: true },
    hourCycle: "12h",
    responseTiming: "duration",
    metadataLayout: "expanded",
    showRequestedModel: true,
    showExactTimeline: false,
    showPiThinkingLevel: false,
    stopReason: "abnormal",
    showCostSinceUser: true,
    showTimeSinceUser: true,
    toolStamps: true,
  });
  assert.deepEqual(runtime.get().settings, {
    ...DEFAULT_STAMP_SETTINGS,
    showSeconds: false,
    hourCycle: "12h",
    responseTiming: "duration",
    metadataLayout: "expanded",
    showRequestedModel: true,
    showExactTimeline: false,
    showPiThinkingLevel: false,
    stopReason: "abnormal",
    showCostSinceUser: true,
    showTimeSinceUser: true,
    toolStamps: true,
  });
  assert.equal(runtime.get().sources.responseTiming, "user");
  assert.equal(runtime.get().sources.metadataLayout, "user");
  assert.equal(runtime.get().sources.showRequestedModel, "user");
  assert.equal(runtime.get().sources.showExactTimeline, "user");
  assert.equal(runtime.get().sources.showPiThinkingLevel, "user");
  assert.equal(runtime.get().sources.stopReason, "user");
  assert.equal(runtime.get().sources.showCostSinceUser, "user");
  assert.equal(runtime.get().sources.showTimeSinceUser, "user");
  assert.equal(runtime.get().sources.toolStamps, "user");
  if (process.platform !== "win32") {
    assert.equal(statSync(settingsPath).mode & 0o777, 0o600);
  }
  assert.deepEqual(listTemporaryFiles(settingsPath), []);
});

test("updates accept every canonical metadata field without applying a preset", async (t) => {
  const { settingsPath } = temporarySettings(t);
  const runtime = createStampSettingsRuntime({ path: settingsPath });
  const expected: Record<string, unknown> = {};
  for (const field of METADATA_BOOLEAN_FIELDS) {
    await runtime.update({ [field]: true });
    expected[field] = true;
    assert.equal(runtime.get().settings[field], true, field);
    assert.equal(runtime.get().sources[field], "user", field);
  }
  for (const metadataLayout of METADATA_LAYOUTS) {
    await runtime.update({ metadataLayout });
    expected.metadataLayout = metadataLayout;
    assert.deepEqual(JSON.parse(readFileSync(settingsPath, "utf8")), expected);
  }
  for (const stopReason of STOP_REASON_MODES) {
    await runtime.update({ stopReason });
    expected.stopReason = stopReason;
    assert.deepEqual(JSON.parse(readFileSync(settingsPath, "utf8")), expected);
  }
  assert.deepEqual(runtime.get().settings, { ...DEFAULT_STAMP_SETTINGS, ...expected });
  for (const field of METADATA_SETTING_FIELDS) assert.equal(runtime.get().sources[field], "user", field);
});

test("updates reject legacy and unknown patches without writes and recover for canonical patches", async (t) => {
  const { directory, settingsPath } = temporarySettings(t);
  const runtime = createStampSettingsRuntime({ path: settingsPath });
  for (const patch of [
    { assistantMetadata: "compact" },
    { showThinkingLevel: false },
    { showCompactAbnormalOutcome: false },
    { showProvider: true, showThinkingLevel: false },
    { future: "retained" },
  ]) {
    await assert.rejects(runtime.update(patch as unknown as StampSettingsPatch), /unknown/u);
  }
  for (const patch of [{ showProvider: "yes" }, { metadataLayout: "off" }, { stopReason: "none" }]) {
    await assert.rejects(runtime.update(patch as unknown as StampSettingsPatch), /invalid/u);
  }
  assert.deepEqual(runtime.get().settings, DEFAULT_STAMP_SETTINGS);
  assert.equal(statExists(path.join(directory, "agent")), false);
  await runtime.update({ showProvider: true });
  assert.deepEqual(JSON.parse(readFileSync(settingsPath, "utf8")), { showProvider: true });
});

test.each(legacyCases.filter(({ document }) => Object.keys(document).length > 0))(
  "first unrelated save migrates legacy $name without changing behavior or unknown fields",
  async ({ document: legacy, expected }) => {
    const { settingsPath } = temporarySettings();
    const retained = {
      showSeconds: false,
      assistantMetadataHint: "retained",
      future: { assistantMetadata: "expanded", showThinkingLevel: false, showCompactAbnormalOutcome: false },
    };
    const contents = `${JSON.stringify({ ...legacy, ...retained }, null, 2)}\n`;
    mkdirSync(path.dirname(settingsPath), { recursive: true });
    writeFileSync(settingsPath, contents);
    const runtime = createStampSettingsRuntime({ path: settingsPath });
    const loaded = await loadStampSettings(settingsPath);
    assert.equal(loaded.kind, "loaded");
    assert.deepEqual((await runtime.reload()).settings, { ...DEFAULT_STAMP_SETTINGS, ...expected, showSeconds: false });
    assert.equal(readFileSync(settingsPath, "utf8"), contents);
    assert.deepEqual(listTemporaryFiles(settingsPath), []);

    const state = await runtime.update({ hourCycle: "12h" });
    assert.deepEqual(JSON.parse(readFileSync(settingsPath, "utf8")), { ...retained, ...expected, hourCycle: "12h" });
    assert.deepEqual(state.settings, { ...DEFAULT_STAMP_SETTINGS, ...expected, showSeconds: false, hourCycle: "12h" });
    for (const field of METADATA_SETTING_FIELDS) assert.equal(state.sources[field], "user", field);
    assert.deepEqual((await runtime.reload()).settings, state.settings);
  },
);

test("migration uses the latest valid document, keeps canonical overrides, and applies patches last", async (t) => {
  const { settingsPath } = temporarySettings(t);
  mkdirSync(path.dirname(settingsPath), { recursive: true });
  writeFileSync(settingsPath, JSON.stringify({ assistantMetadata: "compact" }));
  const runtime = createStampSettingsRuntime({ path: settingsPath });
  await runtime.reload();

  const overrides = {
    metadataLayout: "compact",
    showProvider: false,
    showPiThinkingLevel: true,
    stopReason: "abnormal",
    showResponseId: false,
    showDiagnostics: false,
  } as const;
  const retained = { toolStamps: true, future: { retained: true } };
  writeFileSync(
    settingsPath,
    JSON.stringify({
      assistantMetadata: "expanded",
      showThinkingLevel: false,
      showCompactAbnormalOutcome: false,
      ...overrides,
      ...retained,
    }),
  );
  const metadata: StampMetadataSettings = { ...legacyMetadataSettings("expanded", false, false), ...overrides };
  const patch = { showPiThinkingLevel: false, showRequestedModel: false, stopReason: "hidden" } as const;
  await runtime.update(patch);
  assert.deepEqual(JSON.parse(readFileSync(settingsPath, "utf8")), { ...retained, ...metadata, ...patch });
  assert.deepEqual(runtime.get().settings, { ...DEFAULT_STAMP_SETTINGS, toolStamps: true, ...metadata, ...patch });

  await runtime.update({ metadataLayout: "expanded" });
  await runtime.update({ showSeconds: false });
  assert.deepEqual(runtime.get().settings, {
    ...DEFAULT_STAMP_SETTINGS,
    toolStamps: true,
    ...metadata,
    ...patch,
    metadataLayout: "expanded",
    showSeconds: false,
  });
  assert.equal(runtime.get().settings.showInputTokens, true);
  assert.equal(runtime.get().settings.showProvider, false);
  assert.equal(runtime.get().settings.showResponseId, false);
  assert.equal(runtime.get().settings.showDiagnostics, false);
});

test("canonical-only documents stay partial on unrelated saves", async (t) => {
  const { settingsPath } = temporarySettings(t);
  const document = { metadataLayout: "expanded", showProvider: true, stopReason: "all", future: { retained: true } };
  mkdirSync(path.dirname(settingsPath), { recursive: true });
  writeFileSync(settingsPath, JSON.stringify(document));
  const runtime = createStampSettingsRuntime({ path: settingsPath });
  await runtime.update({ showSeconds: false });
  assert.deepEqual(JSON.parse(readFileSync(settingsPath, "utf8")), { ...document, showSeconds: false });
  assert.equal(runtime.get().sources.showRequestedModel, "built-in");
  assert.equal(runtime.get().sources.showProvider, "user");
});

test.each(["write", "rename"] as const)("failed %s leaves legacy migration and runtime unchanged", async (failure) => {
  const { settingsPath } = temporarySettings();
  const legacy = { assistantMetadata: "expanded", showThinkingLevel: false, showCompactAbnormalOutcome: false };
  const retained = { future: { retained: true } };
  const contents = `${JSON.stringify({ ...legacy, ...retained }, null, 2)}\n`;
  mkdirSync(path.dirname(settingsPath), { recursive: true });
  writeFileSync(settingsPath, contents);
  let rejectPublication = true;
  const runtime = createStampSettingsRuntime({
    path: settingsPath,
    operations: {
      writeFile: async (
        file: Parameters<typeof writeFile>[0],
        data: Parameters<typeof writeFile>[1],
        options: Parameters<typeof writeFile>[2],
      ) => {
        await writeFile(file, data, options);
        if (rejectPublication && failure === "write") throw new Error("write rejected");
      },
      rename: async (source: Parameters<typeof rename>[0], destination: Parameters<typeof rename>[1]) => {
        if (rejectPublication && failure === "rename") throw new Error("rename rejected");
        await rename(source, destination);
      },
    },
  });
  const before = await runtime.reload();
  await assert.rejects(runtime.update({ hourCycle: "12h" }), /rejected/u);
  await runtime.flush();
  assert.equal(readFileSync(settingsPath, "utf8"), contents);
  assert.deepEqual(runtime.get(), before);
  assert.deepEqual(listTemporaryFiles(settingsPath), []);
  assert.deepEqual(await runtime.reload(), before);

  rejectPublication = false;
  await runtime.update({ hourCycle: "12h" });
  const metadata = legacyMetadataSettings("expanded", false, false);
  assert.deepEqual(JSON.parse(readFileSync(settingsPath, "utf8")), { ...retained, ...metadata, hourCycle: "12h" });
  assert.deepEqual(runtime.get().settings, { ...DEFAULT_STAMP_SETTINGS, ...metadata, hourCycle: "12h" });
});

test("malformed and invalid files stay byte-for-byte unchanged and block updates", async (t) => {
  for (const contents of [
    "{bad json\n",
    '{"showSeconds":"yes"}\n',
    '{"assistantMetadata":"none"}\n',
    '{"assistantMetadata":"off","showThinkingLevel":"yes","showPiThinkingLevel":false}\n',
    '{"assistantMetadata":"expanded","showCompactAbnormalOutcome":"yes","stopReason":"all"}\n',
    '{"assistantMetadata":"off","showProvider":"true"}\n',
    '{"metadataLayout":"off"}\n',
    '{"stopReason":"none"}\n',
  ]) {
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
