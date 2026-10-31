import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import { test, vi } from "vitest";
import { DEFAULT_STAMP_SETTINGS, type StampSettings } from "../src/format.js";
import { METADATA_PRESET_NAMES, METADATA_PRESETS, METADATA_SETTING_FIELDS } from "../src/metadata-settings.js";
import { createStampDisplaySettings } from "../src/preset-preview.js";
import { memorySettingsRuntime, NONMETADATA_SETTINGS } from "./menu-fixtures.js";

test.each(METADATA_PRESET_NAMES)("%s overlays only metadata fields without runtime writes", (preset) => {
  const runtime = memorySettingsRuntime({
    settings: { ...NONMETADATA_SETTINGS, ...METADATA_PRESETS.detailed, showResponseId: true, showDiagnostics: true },
  });
  const before = runtime.get();
  Object.freeze(before.settings);
  Object.freeze(before.sources);
  Object.freeze(before);
  const writes = [vi.spyOn(runtime, "update"), vi.spyOn(runtime, "reload"), vi.spyOn(runtime, "flush")];
  const display = createStampDisplaySettings(() => runtime.get().settings);
  assert.equal(display.get(), before.settings);
  const lease = display.begin(new AbortController().signal);
  assert.equal(display.get(), before.settings);
  lease.set(preset);
  const preview = display.get();
  assert.notEqual(preview, before.settings);
  assert.deepEqual(preview, { ...before.settings, ...METADATA_PRESETS[preset] });
  for (const field of Object.keys(NONMETADATA_SETTINGS) as (keyof StampSettings)[])
    assert.equal(preview[field], before.settings[field], field);
  for (const field of METADATA_SETTING_FIELDS) assert.equal(preview[field], METADATA_PRESETS[preset][field], field);
  assert.equal(preview.showResponseId, false);
  assert.equal(preview.showDiagnostics, false);
  assert.deepEqual(display.get(), preview);
  lease.dispose();
  lease.dispose();
  assert.equal(display.get(), before.settings);
  assert.equal(runtime.get(), before);
  assert.deepEqual(runtime.patches, []);
  for (const write of writes) assert.equal(write.mock.calls.length, 0);
});

test("get uses the latest canonical settings during a preview and after disposal, not a saved snapshot", () => {
  let canonical: StampSettings = { ...DEFAULT_STAMP_SETTINGS };
  const display = createStampDisplaySettings(() => canonical);
  const lease = display.begin(new AbortController().signal);
  lease.set("model");
  canonical.hourCycle = "12h";
  canonical.showSeconds = false;
  assert.equal(display.get().hourCycle, "12h");
  assert.equal(display.get().showSeconds, false);
  canonical = {
    ...canonical,
    ...NONMETADATA_SETTINGS,
    ...METADATA_PRESETS.usage,
    showDiagnostics: true,
    showResponseId: true,
  };
  assert.deepEqual(display.get(), { ...canonical, ...METADATA_PRESETS.model });
  lease.set("none");
  assert.deepEqual(display.get(), { ...canonical, ...METADATA_PRESETS.none });
  lease.dispose();
  assert.equal(display.get(), canonical);
  assert.equal(canonical.showDiagnostics, true);
  assert.equal(canonical.showResponseId, true);
});

test("a new live lease supersedes prior selection, and stale set/dispose/abort cannot affect its owner", () => {
  const canonical = Object.freeze({ ...DEFAULT_STAMP_SETTINGS });
  const display = createStampDisplaySettings(() => canonical);
  const oldController = new AbortController();
  const previous = display.begin(oldController.signal);
  previous.set("detailed");
  const controller = new AbortController();
  const current = display.begin(controller.signal);
  assert.equal(display.get(), canonical);
  assert.equal(getEventListeners(oldController.signal, "abort").length, 0);
  current.set("usage");
  previous.set("cost");
  previous.dispose();
  oldController.abort();
  assert.deepEqual(display.get(), { ...canonical, ...METADATA_PRESETS.usage });
  current.set("abnormal");
  assert.deepEqual(display.get(), { ...canonical, ...METADATA_PRESETS.abnormal });
  current.dispose();
  assert.equal(display.get(), canonical);
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
});

test("current signal abort clears synchronously, releases its listener, and makes its lease inert", () => {
  const canonical = Object.freeze({ ...DEFAULT_STAMP_SETTINGS });
  const display = createStampDisplaySettings(() => canonical);
  const controller = new AbortController();
  const lease = display.begin(controller.signal);
  lease.set("compact");
  assert.equal(getEventListeners(controller.signal, "abort").length, 1);
  controller.abort();
  assert.equal(display.get(), canonical);
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
  lease.set("detailed");
  lease.dispose();
  const next = display.begin(new AbortController().signal);
  next.set("cost");
  lease.set("model");
  lease.dispose();
  assert.deepEqual(display.get(), { ...canonical, ...METADATA_PRESETS.cost });
  next.dispose();
});

test("an already-aborted begin is inert and cannot displace a live preview", () => {
  const canonical = Object.freeze({ ...DEFAULT_STAMP_SETTINGS });
  const display = createStampDisplaySettings(() => canonical);
  const liveController = new AbortController();
  const live = display.begin(liveController.signal);
  live.set("usage");
  const cancelledController = new AbortController();
  cancelledController.abort();
  const cancelled = display.begin(cancelledController.signal);
  cancelled.set("detailed");
  cancelled.dispose();
  assert.deepEqual(display.get(), { ...canonical, ...METADATA_PRESETS.usage });
  assert.equal(getEventListeners(cancelledController.signal, "abort").length, 0);
  assert.equal(getEventListeners(liveController.signal, "abort").length, 1);
  live.dispose();
  assert.equal(display.get(), canonical);
  cancelled.set("model");
  assert.equal(display.get(), canonical);
});

test("clear invalidates ownership, releases signal listeners, and cannot be reversed by stale leases", () => {
  const runtime = memorySettingsRuntime();
  const display = createStampDisplaySettings(() => runtime.get().settings);
  display.clear();
  const controller = new AbortController();
  const lease = display.begin(controller.signal);
  lease.set("detailed");
  runtime.replaceSettings({ ...NONMETADATA_SETTINGS, ...METADATA_PRESETS.cost });
  const latest = runtime.get().settings;
  display.clear();
  display.clear();
  assert.equal(display.get(), latest);
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
  lease.set("abnormal");
  lease.dispose();
  controller.abort();
  assert.equal(display.get(), latest);
  const next = display.begin(new AbortController().signal);
  next.set("compact");
  lease.dispose();
  assert.deepEqual(display.get(), { ...latest, ...METADATA_PRESETS.compact });
  next.dispose();
});

test.each(["dispose", "abort", "clear"] as const)("%s also releases an unselected lease", (exit) => {
  const canonical = Object.freeze({ ...DEFAULT_STAMP_SETTINGS });
  const display = createStampDisplaySettings(() => canonical);
  const controller = new AbortController();
  const lease = display.begin(controller.signal);
  assert.equal(getEventListeners(controller.signal, "abort").length, 1);
  if (exit === "dispose") lease.dispose();
  else if (exit === "abort") controller.abort();
  else display.clear();
  lease.set("detailed");
  assert.equal(display.get(), canonical);
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
});
