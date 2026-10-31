import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { CURSOR_MARKER, KeybindingsManager, TUI_KEYBINDINGS, visibleWidth } from "@earendil-works/pi-tui";
import { createTuiHarness } from "@narumitw/pi-tui-kit/testing";
import { onTestFinished, test, vi } from "vitest";
import { createMockContext } from "../../../test/support.js";
import { showStampMenu } from "../src/menu.js";
import { METADATA_PRESET_NAMES, METADATA_PRESETS, type StampMetadataPreset } from "../src/metadata-settings.js";
import type { StampPresetPreview } from "../src/preset-preview.js";
import {
  currentOwner,
  mountedPreviewFixture,
  NONMETADATA_SETTINGS,
  PRESET_DESCRIPTIONS,
  PRESET_LABELS,
  RESPONSE_METADATA_ROWS,
  UTC_SETTINGS,
  waitForPresetSave,
} from "./menu-fixtures.js";

initTheme("dark", false);

type Fixture = Awaited<ReturnType<typeof mountedPreviewFixture>>;
const METADATA_ROWS: Record<StampMetadataPreset, readonly string[]> = {
  none: [],
  compact: ["recorded-request → recorded-response · thinking high · stop length · 880 tok · est $0.018"],
  detailed: [
    "api recorded-api · provider recorded-provider · requested recorded-request · response recorded-response · thinking high · stop length",
    "tokens in 600 · out 160 · reasoning 40 · cache read 80 · cache write 40 · total 880 · est cost $0.018",
  ],
  model: ["recorded-request → recorded-response · thinking high"],
  usage: ["tokens in 600 · out 160 · reasoning 40 · cache read 80 · cache write 40 · total 880"],
  cost: ["est $0.018"],
  abnormal: ["stop length"],
};

test.each(METADATA_PRESET_NAMES)(
  "%s changes the original mounted Stamp without picker details, canonical, file, or session writes",
  async (preset) => {
    const fixture = await fixtureForTest({ ...METADATA_PRESETS[preset] });
    const before = fixture.snapshot();
    const writes = runtimeWrites(fixture);
    const beginPreview = previewFactory(fixture);
    const getBranch = vi.fn(() => fixture.sessionManager.getBranch());
    const tui = createTuiHarness({ width: 160, rows: 40 });
    const context = createMockContext({ mode: "tui", custom: tui.custom, sessionManager: { getBranch } });
    const running = showStampMenu(context.ctx, fixture.runtime, { ...currentOwner(), beginPreview });
    await tui.waitForOpen();
    const beforeOpenCalls = beginPreview.mock.calls.length;
    tui.press("tui.select.confirm");
    await tui.waitForOpen();
    const initial = { menu: [...tui.render()], mounted: fixture.render(), state: fixture.snapshot() };
    tui.press("tui.select.down");
    const down = { menu: [...tui.render()], mounted: fixture.render(), state: fixture.snapshot() };
    tui.press("tui.select.up");
    const up = { menu: [...tui.render()], mounted: fixture.render(), state: fixture.snapshot() };
    tui.press("ctrl+c");
    const result = await running;

    const next = METADATA_PRESET_NAMES[(METADATA_PRESET_NAMES.indexOf(preset) + 1) % METADATA_PRESET_NAMES.length];
    assert.ok(next);
    assert.equal(result.kind, "closed");
    assert.equal(beforeOpenCalls, 0);
    assert.equal(beginPreview.mock.calls.length, 1);
    assert.equal(getBranch.mock.calls.length, 0, "The picker must not read the session branch");
    assertRecordedPreview(initial.menu, initial.mounted, preset);
    assertRecordedPreview(down.menu, down.mounted, next);
    assertRecordedPreview(up.menu, up.mounted, preset);
    assert.match(initial.menu.join("\n"), new RegExp(`→ ${capitalize(preset)} ✓ current`, "u"));
    assert.match(down.menu.join("\n"), new RegExp(`${capitalize(preset)} ✓ current`, "u"));
    assert.equal(down.menu.join("\n").includes(`${capitalize(next)} ✓ current`), false);
    assert.deepEqual(up.menu, initial.menu);
    assert.deepEqual(up.mounted, initial.mounted);
    for (const snapshot of [initial.state, down.state, up.state, fixture.snapshot()])
      assert.deepEqual(snapshot, before);
    for (const write of writes) assert.equal(write.mock.calls.length, 0);
    assert.deepEqual(context.notifications, []);
    assert.equal(context.statuses.size, 0);
    assert.equal(context.widgets.size, 0);
    assert.deepEqual(context.pastedEditorTexts, []);
    assert.equal(tui.openCount, 2);
    assert.ok(tui.requestRenderCount >= 2);
    assert.deepEqual(fixture.display.get(), fixture.runtime.get().settings);
  },
);

test("Custom starts on Compact without a false current marker or a Custom choice", async () => {
  const fixture = await fixtureForTest({ ...METADATA_PRESETS.compact, showProvider: true });
  const before = fixture.snapshot();
  const writes = runtimeWrites(fixture);
  const tui = createTuiHarness({ width: 160, rows: 40 });
  const { ctx } = createMockContext({ mode: "tui", custom: tui.custom, sessionManager: fixture.sessionManager });
  const running = showStampMenu(ctx, fixture.runtime, { ...currentOwner(), beginPreview: previewFactory(fixture) });
  await openPresets(tui);
  const menu = [...tui.render()];
  const mounted = fixture.render();
  tui.press("ctrl+c");
  await running;

  assert.match(menu.join("\n"), /Current preset: Custom/u);
  assert.doesNotMatch(menu.join("\n"), /✓ current|\(current\)|→ Custom/u);
  assertRecordedPreview(menu, mounted, "compact");
  assert.deepEqual(fixture.snapshot(), before);
  for (const write of writes) assert.equal(write.mock.calls.length, 0);
});

test("preview retains nonmetadata display preferences on recorded entries without changing them", async () => {
  const fixture = await fixtureForTest({ ...NONMETADATA_SETTINGS, locale: "invariant" });
  const before = fixture.snapshot();
  const writes = runtimeWrites(fixture);
  const tui = createTuiHarness({ width: 160, rows: 40 });
  const { ctx } = createMockContext({ mode: "tui", custom: tui.custom, sessionManager: fixture.sessionManager });
  const running = showStampMenu(ctx, fixture.runtime, { ...currentOwner(), beginPreview: previewFactory(fixture) });
  await openPresets(tui);
  tui.press("tui.select.down");
  const menu = [...tui.render()];
  const mounted = fixture.render();
  const during = fixture.snapshot();
  tui.press("ctrl+c");
  await running;

  assert.match(menu.join("\n"), /→ Compact/u);
  assertNoPickerPreview(menu);
  assert.deepEqual(mounted.assistant, [
    "2026-10-30 · 10:32 PM · first 0.8s · total 3.2s · 50 tok/s · since user 51.2s",
    `${METADATA_ROWS.compact[0]} · since user $0.039`,
  ]);
  assert.deepEqual(mounted.assistantExpanded, mounted.assistant);
  assert.deepEqual(mounted.tool, ["tool read · 1.3s · success"]);
  assert.doesNotMatch(mounted.assistantExpanded?.join("\n") ?? "", /timeline ·|debug ·/u);
  assert.deepEqual(during, before);
  assert.deepEqual(fixture.snapshot(), before);
  for (const write of writes) assert.equal(write.mock.calls.length, 0);
});

test.each(["off", "duration", "detailed"] as const)(
  "%s timing stays independent of metadata preview, including the since-user duration label",
  async (responseTiming) => {
    for (const showTimeSinceUser of [false, true]) {
      const fixture = await fixtureForTest({ responseTiming, showTimeSinceUser });
      const before = fixture.snapshot();
      const tui = createTuiHarness({ width: 160, rows: 40 });
      const { ctx } = createMockContext({ mode: "tui", custom: tui.custom, sessionManager: fixture.sessionManager });
      const running = showStampMenu(ctx, fixture.runtime, { ...currentOwner(), beginPreview: previewFactory(fixture) });
      await openPresets(tui);
      moveTo(tui, "model");
      const mounted = fixture.render();
      const during = fixture.snapshot();
      tui.press("ctrl+c");
      await running;

      const timing =
        responseTiming === "off"
          ? ""
          : responseTiming === "duration"
            ? ` · ${showTimeSinceUser ? "response " : ""}3.2s`
            : " · first 0.8s · total 3.2s";
      const since = showTimeSinceUser ? " · since user 51.2s" : "";
      assert.deepEqual(mounted.assistant, [`2026-10-30 · 14:32:08${timing}${since}`, ...METADATA_ROWS.model]);
      assert.deepEqual(during, before);
      assert.deepEqual(fixture.snapshot(), before);
    }
  },
);

test("an active preview follows a newer canonical base and cancellation cannot restore an old snapshot", async () => {
  const fixture = await fixtureForTest({ ...METADATA_PRESETS.compact, showDiagnostics: true });
  const original = fixture.snapshot();
  const tui = createTuiHarness({ width: 160, rows: 40 });
  const { ctx } = createMockContext({ mode: "tui", custom: tui.custom, sessionManager: fixture.sessionManager });
  const running = showStampMenu(ctx, fixture.runtime, { ...currentOwner(), beginPreview: previewFactory(fixture) });
  await openPresets(tui);
  moveTo(tui, "detailed");
  await fixture.runtime.update({
    ...NONMETADATA_SETTINGS,
    ...UTC_SETTINGS,
    ...METADATA_PRESETS.cost,
    showDiagnostics: true,
  });
  const latest = fixture.snapshot();
  const display = fixture.display.get();
  const mounted = fixture.render();
  tui.press("tui.select.up");
  tui.press("tui.select.down");
  const afterNavigation = fixture.snapshot();
  tui.press("tui.select.cancel");
  await tui.waitForOpen();
  const afterBack = fixture.display.get();
  const restored = fixture.render();
  const main = tui.render().join("\n");
  tui.press("ctrl+c");
  await running;

  assert.deepEqual(display, { ...latest.state.settings, ...METADATA_PRESETS.detailed });
  assert.equal(mounted.assistant?.[0], "2026-10-30 · 2:32 PM · first 0.8s · total 3.2s · 50 tok/s · since user 51.2s");
  assert.deepEqual(afterNavigation, latest);
  assert.deepEqual(afterBack, latest.state.settings);
  assert.deepEqual(fixture.snapshot(), latest);
  assert.notEqual(latest.file, original.file);
  assert.equal(latest.session, original.session);
  assert.match(main, /Metadata: Custom/u);
  assert.match(restored.assistantExpanded?.join("\n") ?? "", /debug · diagnostics 1/u);
});

test("confirmation disposes the preview before saving and reopens the accepted preset with canonical markers", async () => {
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const fixture = await fixtureForTest({}, async () => {
    started.resolve();
    await release.promise;
  });
  const before = fixture.snapshot();
  const leases: StampPresetPreview[] = [];
  const beginPreview = previewFactory(fixture, leases);
  const originalUpdate = fixture.runtime.update.bind(fixture.runtime);
  const atUpdate: {
    settings: ReturnType<Fixture["display"]["get"]>;
    disposed: number;
    mounted: ReturnType<Fixture["render"]>;
  }[] = [];
  const getBranch = vi.fn(() => fixture.sessionManager.getBranch());
  const update = vi.spyOn(fixture.runtime, "update").mockImplementation((patch) => {
    const lease = leases[0];
    atUpdate.push({
      settings: fixture.display.get(),
      disposed: lease ? vi.mocked(lease.dispose).mock.calls.length : 0,
      mounted: fixture.render(),
    });
    return originalUpdate(patch);
  });
  const tui = createTuiHarness({ width: 160, rows: 40 });
  const { ctx, notifications } = createMockContext({
    mode: "tui",
    custom: tui.custom,
    sessionManager: { getBranch },
  });
  const running = showStampMenu(ctx, fixture.runtime, { ...currentOwner(), beginPreview });
  await openPresets(tui);
  moveTo(tui, "detailed");
  const preview = {
    menu: [...tui.render()],
    mounted: fixture.render(),
    state: fixture.snapshot(),
    calls: update.mock.calls.length,
  };
  tui.press("tui.select.confirm");
  await started.promise;
  const pending = { state: fixture.snapshot(), display: fixture.display.get(), mounted: fixture.render() };
  release.resolve();
  await waitForPresetSave(tui);
  const saved = { menu: [...tui.render()], mounted: fixture.render(), state: fixture.snapshot() };
  tui.press("ctrl+c");
  await running;

  assertRecordedPreview(preview.menu, preview.mounted, "detailed");
  assert.equal(preview.calls, 0);
  assert.deepEqual(preview.state, before);
  assert.equal(atUpdate.length, 1);
  assert.equal(atUpdate[0]?.disposed, 1);
  assert.deepEqual(atUpdate[0]?.settings, before.state.settings);
  assert.deepEqual(atUpdate[0]?.mounted.assistant, ["2026-10-30 · 14:32:08"]);
  assert.deepEqual(pending.display, before.state.settings);
  assert.deepEqual(pending.mounted.assistant, ["2026-10-30 · 14:32:08"]);
  assert.deepEqual(pending.state.state, before.state);
  assert.equal(pending.state.file, before.file);
  assert.equal(pending.state.session, before.session);
  assert.deepEqual(update.mock.calls, [[METADATA_PRESETS.detailed]]);
  assert.deepEqual(saved.state.state.settings, { ...before.state.settings, ...METADATA_PRESETS.detailed });
  assert.deepEqual(JSON.parse(saved.state.file), { ...JSON.parse(before.file), ...METADATA_PRESETS.detailed });
  assert.equal(saved.state.session, before.session);
  assert.deepEqual(saved.state.files, before.files);
  assert.match(saved.menu.join("\n"), /→ Detailed ✓ current/u);
  assertRecordedPreview(saved.menu, saved.mounted, "detailed");
  assert.equal(beginPreview.mock.calls.length, 2);
  assert.equal(getBranch.mock.calls.length, 0, "Confirmation must not make the picker read the branch");
  for (const lease of leases) assert.equal(vi.mocked(lease.dispose).mock.calls.length, 1);
  assert.deepEqual(fixture.display.get(), fixture.runtime.get().settings);
  assert.deepEqual(notifications, [{ message: "Metadata preset: Detailed.", level: "info" }]);
});

test.each([
  { exit: "hard-cancel", fails: false },
  { exit: "hard-cancel", fails: true },
  { exit: "dispose", fails: false },
  { exit: "dispose", fails: true },
] as const)(
  "delayed preset save $exit (failure=$fails) drains without notifications or reopening",
  async ({ exit, fails }) => {
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const fixture = await fixtureForTest({}, async () => {
      started.resolve();
      await release.promise;
      if (fails) throw new Error("disk full after cancellation");
    });
    const before = fixture.snapshot();
    const update = vi.spyOn(fixture.runtime, "update");
    const beginPreview = previewFactory(fixture);
    const tui = createTuiHarness({ width: 160, rows: 40 });
    const context = createMockContext({
      mode: "tui",
      custom: tui.custom,
      sessionManager: fixture.sessionManager,
      editorText: "existing draft",
    });
    const running = showStampMenu(context.ctx, fixture.runtime, { ...currentOwner(), beginPreview });
    onTestFinished(async () => {
      release.resolve();
      tui.dispose();
      await running;
    });
    await openPresets(tui);
    moveTo(tui, "detailed");
    tui.press("tui.select.confirm");
    await started.promise;
    await tui.waitForOpen();
    const completion = tui.resultPromise;
    const loader = [...tui.render()];
    const pending = { state: fixture.snapshot(), display: fixture.display.get(), mounted: fixture.render() };
    if (exit === "hard-cancel") tui.press("ctrl+c");
    else tui.dispose();
    const callsAfterCancel = update.mock.calls.length;
    release.resolve();
    const taskResult = await completion;
    const result = await running;
    tui.press("tui.select.confirm");
    const saved = fixture.snapshot();

    assert.match(loader.join("\n"), /Saving Stamp preset…/u);
    assert.match(loader.join("\n"), /ctrl\+c cancel/u);
    assert.deepEqual(pending.state.state, before.state);
    assert.equal(pending.state.file, before.file);
    assert.deepEqual(pending.display, before.state.settings);
    assert.deepEqual(pending.mounted.assistant, ["2026-10-30 · 14:32:08"]);
    assert.equal(callsAfterCancel, 1);
    assert.deepEqual(update.mock.calls, [[METADATA_PRESETS.detailed]]);
    assert.deepEqual(taskResult, exit === "hard-cancel" ? { kind: "cancelled" } : undefined);
    assert.equal(result.kind, "closed");
    assert.deepEqual(
      saved.state.settings,
      fails ? before.state.settings : { ...before.state.settings, ...METADATA_PRESETS.detailed },
    );
    if (fails) assert.equal(saved.file, before.file);
    else assert.deepEqual(JSON.parse(saved.file), { ...JSON.parse(before.file), ...METADATA_PRESETS.detailed });
    assert.deepEqual(saved.files, before.files);
    assert.equal(saved.session, before.session);
    assert.equal(saved.branch, before.branch);
    assert.equal(saved.context, before.context);
    assert.deepEqual(fixture.display.get(), fixture.runtime.get().settings);
    assert.deepEqual(context.notifications, []);
    assert.equal(context.editorText, "existing draft");
    assert.equal(beginPreview.mock.calls.length, 1);
    assert.equal(tui.openCount, 3);
    assert.equal(tui.isOpen, false);
  },
);

test.each(["shutdown", "replacement"] as const)(
  "an accepted preset save drains after %s without restoring its preview or reopening stale UI",
  async (exit) => {
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const fixture = await fixtureForTest({}, async () => {
      started.resolve();
      await release.promise;
    });
    const before = fixture.snapshot();
    const update = vi.spyOn(fixture.runtime, "update");
    const beginPreview = previewFactory(fixture);
    const controller = new AbortController();
    let current = true;
    const tui = createTuiHarness({ width: 160, rows: 40 });
    const { ctx, notifications } = createMockContext({
      mode: "tui",
      custom: tui.custom,
      sessionManager: fixture.sessionManager,
    });
    const running = showStampMenu(ctx, fixture.runtime, {
      signal: controller.signal,
      isCurrent: () => current,
      beginPreview,
    });
    await openPresets(tui);
    moveTo(tui, "detailed");
    tui.press("tui.select.confirm");
    await started.promise;
    if (exit === "replacement") current = false;
    controller.abort();
    const pending = { settings: fixture.display.get(), mounted: fixture.render(), state: fixture.snapshot() };
    release.resolve();
    const result = await running;
    tui.press("tui.select.confirm");
    const saved = fixture.snapshot();

    assert.equal(result.kind, "stale");
    assert.deepEqual(pending.settings, before.state.settings);
    assert.deepEqual(pending.mounted.assistant, ["2026-10-30 · 14:32:08"]);
    assert.deepEqual(pending.state.state, before.state);
    assert.equal(pending.state.file, before.file);
    assert.deepEqual(update.mock.calls, [[METADATA_PRESETS.detailed]]);
    assert.deepEqual(saved.state.settings, { ...before.state.settings, ...METADATA_PRESETS.detailed });
    assert.deepEqual(JSON.parse(saved.file), { ...JSON.parse(before.file), ...METADATA_PRESETS.detailed });
    assert.deepEqual(saved.files, before.files);
    assert.equal(saved.session, before.session);
    assert.deepEqual(fixture.display.get(), saved.state.settings);
    assert.deepEqual(notifications, []);
    assert.equal(beginPreview.mock.calls.length, 1);
    assert.equal(tui.openCount, 3);
    assert.equal(tui.isOpen, false);
  },
);

test.each(["cancel", "hard-cancel", "dispose", "shutdown", "replacement"] as const)(
  "%s clears a moved preview and restores current Custom display without canonical, file, or session writes",
  async (exit) => {
    const fixture = await fixtureForTest({
      ...NONMETADATA_SETTINGS,
      ...UTC_SETTINGS,
      ...METADATA_PRESETS.compact,
      showDiagnostics: true,
    });
    const before = fixture.snapshot();
    const originalMounted = fixture.render();
    const writes = runtimeWrites(fixture);
    const controller = new AbortController();
    let current = true;
    const leases: StampPresetPreview[] = [];
    const tui = createTuiHarness({ width: 160, rows: 40 });
    const { ctx, notifications } = createMockContext({
      mode: "tui",
      custom: tui.custom,
      sessionManager: fixture.sessionManager,
    });
    const running = showStampMenu(ctx, fixture.runtime, {
      signal: controller.signal,
      isCurrent: () => current,
      beginPreview: previewFactory(fixture, leases),
    });
    await openPresets(tui);
    moveTo(tui, "detailed");
    const moved = fixture.render();
    const during = fixture.snapshot();
    let main = "";
    let immediatelyAfterAbort: ReturnType<Fixture["display"]["get"]> | undefined;
    if (exit === "cancel") {
      tui.press("tui.select.cancel");
      await tui.waitForOpen();
      main = tui.render().join("\n");
      tui.press("ctrl+c");
    } else if (exit === "hard-cancel") tui.press("ctrl+c");
    else if (exit === "dispose") tui.dispose();
    else {
      if (exit === "replacement") current = false;
      controller.abort();
      immediatelyAfterAbort = fixture.display.get();
    }
    const result = await running;
    const restored = fixture.render();
    tui.press("tui.select.confirm");
    tui.dispose();
    controller.abort();
    leases[0]?.set("usage");
    leases[0]?.dispose();

    assert.notDeepEqual(moved.assistant, originalMounted.assistant);
    assert.doesNotMatch(moved.assistantExpanded?.join("\n") ?? "", /debug ·/u);
    assert.deepEqual(restored, originalMounted);
    assert.match(restored.assistantExpanded?.join("\n") ?? "", /debug · diagnostics 1/u);
    assert.equal(result.kind, exit === "shutdown" || exit === "replacement" ? "stale" : "closed");
    if (exit === "cancel") {
      assert.match(main, /Metadata: Custom/u);
      assert.doesNotMatch(main, /Example|recorded-request/u);
    }
    if (immediatelyAfterAbort) assert.deepEqual(immediatelyAfterAbort, before.state.settings);
    assert.deepEqual(during, before);
    assert.deepEqual(fixture.snapshot(), before);
    assert.deepEqual(fixture.display.get(), before.state.settings);
    for (const write of writes) assert.equal(write.mock.calls.length, 0);
    assert.deepEqual(notifications, []);
    assert.equal(tui.isOpen, false);
    assert.equal(tui.openCount, exit === "cancel" ? 3 : 2);
  },
);

test("a failed confirmed save restores canonical display before retry and keeps the same focused preview", async () => {
  let fail = true;
  const fixture = await fixtureForTest({}, async () => {
    if (fail) throw new Error("disk full");
  });
  const before = fixture.snapshot();
  const atUpdate: ReturnType<Fixture["display"]["get"]>[] = [];
  const originalUpdate = fixture.runtime.update.bind(fixture.runtime);
  const update = vi.spyOn(fixture.runtime, "update").mockImplementation((patch) => {
    atUpdate.push(fixture.display.get());
    return originalUpdate(patch);
  });
  const leases: StampPresetPreview[] = [];
  const beginPreview = previewFactory(fixture, leases);
  const tui = createTuiHarness({ width: 160, rows: 40 });
  const { ctx, notifications } = createMockContext({
    mode: "tui",
    custom: tui.custom,
    sessionManager: fixture.sessionManager,
  });
  const running = showStampMenu(ctx, fixture.runtime, { ...currentOwner(), beginPreview });
  await openPresets(tui);
  moveTo(tui, "usage");
  const preview = { menu: [...tui.render()], mounted: fixture.render(), calls: update.mock.calls.length };
  tui.press("tui.select.confirm");
  await waitForPresetSave(tui);
  const rejected = {
    menu: [...tui.render()],
    mounted: fixture.render(),
    state: fixture.snapshot(),
    calls: update.mock.calls.length,
  };
  fail = false;
  tui.press("tui.select.confirm");
  await waitForPresetSave(tui);
  const saved = { menu: [...tui.render()], mounted: fixture.render() };
  tui.press("ctrl+c");
  await running;

  assert.equal(preview.calls, 0);
  assert.equal(rejected.calls, 1);
  assert.deepEqual(rejected.state, before);
  assert.deepEqual(rejected.menu, preview.menu);
  assert.deepEqual(rejected.mounted, preview.mounted);
  assert.match(rejected.menu.join("\n"), /None ✓ current/u);
  assertRecordedPreview(rejected.menu, rejected.mounted, "usage");
  assert.match(saved.menu.join("\n"), /→ Usage ✓ current/u);
  assertRecordedPreview(saved.menu, saved.mounted, "usage");
  assert.deepEqual(update.mock.calls, [[METADATA_PRESETS.usage], [METADATA_PRESETS.usage]]);
  assert.deepEqual(atUpdate, [before.state.settings, before.state.settings]);
  assert.deepEqual(fixture.runtime.get().settings, { ...before.state.settings, ...METADATA_PRESETS.usage });
  assert.equal(beginPreview.mock.calls.length, 3);
  for (const lease of leases) assert.equal(vi.mocked(lease.dispose).mock.calls.length, 1);
  assert.deepEqual(
    notifications.map(({ level }) => level),
    ["error", "info"],
  );
  assert.match(notifications[0]?.message ?? "", /previous value remains.*disk full/u);
});

test("configured navigation, confirmation, and cancel retain native hints and hard Ctrl+C", async () => {
  const fixture = await fixtureForTest();
  const before = fixture.snapshot();
  const update = vi.spyOn(fixture.runtime, "update");
  const tui = createTuiHarness({
    width: 160,
    rows: 40,
    keybindings: new KeybindingsManager(TUI_KEYBINDINGS, {
      "tui.select.up": "f1",
      "tui.select.down": "f2",
      "tui.select.confirm": "f3",
      "tui.select.cancel": "f4",
    }),
  });
  const { ctx } = createMockContext({ mode: "tui", custom: tui.custom, sessionManager: fixture.sessionManager });
  const running = showStampMenu(ctx, fixture.runtime, { ...currentOwner(), beginPreview: previewFactory(fixture) });
  await tui.waitForOpen();
  tui.send("\u001bOR");
  await tui.waitForOpen();
  const initial = { menu: [...tui.render()], mounted: fixture.render() };
  tui.send("\u001bOQ");
  const down = { menu: [...tui.render()], mounted: fixture.render() };
  tui.send("\u001bOP");
  const up = { menu: [...tui.render()], mounted: fixture.render() };
  const navigationCalls = update.mock.calls.length;
  const navigationState = fixture.snapshot();
  tui.send("\u001bOQ");
  tui.send("\u001bOR");
  await waitForPresetSave(tui);
  const saved = fixture.snapshot();
  tui.send("\u001bOQ");
  tui.send("\u001bOS");
  await tui.waitForOpen();
  const main = tui.render().join("\n");
  const afterBack = fixture.render();
  tui.send("\u001bOR");
  await tui.waitForOpen();
  const returned = { menu: [...tui.render()], mounted: fixture.render() };
  tui.send("\u001bOQ");
  tui.press("ctrl+c");
  const result = await running;

  assertRecordedPreview(initial.menu, initial.mounted, "none");
  assertRecordedPreview(down.menu, down.mounted, "compact");
  assertRecordedPreview(up.menu, up.mounted, "none");
  assert.equal(navigationCalls, 0);
  assert.deepEqual(navigationState, before);
  assert.match(initial.menu.join("\n"), /f1\/f2 preview.*f3 apply.*f4 back.*ctrl\+c close/u);
  assert.match(main, /Metadata: Compact/u);
  assertRecordedPreview(returned.menu, returned.mounted, "compact");
  assert.deepEqual(afterBack.assistant, returned.mounted.assistant);
  assert.match(returned.menu.join("\n"), /→ Compact ✓ current/u);
  assert.equal(result.kind, "closed");
  assert.deepEqual(update.mock.calls, [[METADATA_PRESETS.compact]]);
  assert.deepEqual(fixture.snapshot(), saved);
  assert.deepEqual(fixture.display.get(), saved.state.settings);
});

test.each(METADATA_PRESET_NAMES)("%s keeps the selector and mounted display bounded across resizes", async (preset) => {
  const fixture = await fixtureForTest();
  const before = fixture.snapshot();
  const writes = runtimeWrites(fixture);
  const themed: { role: string; text: string }[] = [];
  let renderZero: (() => string[]) | undefined;
  const tui = createTuiHarness({
    width: 80,
    rows: 24,
    theme: {
      fg: (role, text) => {
        themed.push({ role, text });
        return text;
      },
      bold: (text) => text,
    },
  });
  const custom: typeof tui.custom = (factory, options) =>
    tui.custom(async (host, theme, keybindings, done) => {
      const component = await factory(host, theme, keybindings, done);
      renderZero = () => component.render(0);
      return component;
    }, options);
  const { ctx } = createMockContext({ mode: "tui", custom, sessionManager: fixture.sessionManager });
  const running = showStampMenu(ctx, fixture.runtime, { ...currentOwner(), beginPreview: previewFactory(fixture) });
  await openPresets(tui);
  moveTo(tui, preset);
  const normal = [...tui.render()];
  const mounted = fixture.render(80);
  const frames: {
    width: number;
    rows: number;
    lines: readonly string[];
    zero: string[] | undefined;
    mounted: ReturnType<Fixture["render"]>;
  }[] = [];
  for (const rows of [3, 4, 7, 8, 14, 24, 40]) {
    for (const width of [1, 2, 16, 40, 80]) {
      const lines = [...tui.resize({ width, rows })];
      frames.push({ width, rows, lines, zero: renderZero?.(), mounted: fixture.render(width) });
    }
  }
  for (const component of Object.values(fixture.components)) component.invalidate();
  const mountedZero = Object.values(fixture.components).map((component) => component.render(0));
  const mountedRestored = fixture.render(80);
  tui.invalidate();
  const restored = [...tui.resize({ width: 80, rows: 24 })];
  tui.press("ctrl+c");
  await running;

  assert.equal(normal[0], "─".repeat(80));
  assert.equal(normal.at(-1), "─".repeat(80));
  assert.deepEqual(restored, normal);
  assert.deepEqual(mountedRestored, mounted);
  for (const zero of mountedZero) assert.deepEqual(zero, []);
  assert.equal(
    normalize(mounted.assistant?.join(" ") ?? ""),
    normalize(["2026-10-30 · 14:32:08", ...METADATA_ROWS[preset]].join(" ")),
  );
  for (const label of PRESET_LABELS)
    assert.ok(
      normal.some((line) => line.trim().startsWith(label) || line.startsWith(`→ ${label}`)),
      label,
    );
  for (const text of PRESET_DESCRIPTIONS)
    assert.ok(
      themed.some((call) => call.role === "muted" && call.text.includes(text)),
      text,
    );
  assert.ok(themed.every(({ text }) => !/^(?:Preview|No assistant response|No enabled fields)/u.test(text)));
  assert.ok(themed.every(({ text }) => !text.includes("actual-request")));
  assert.ok(themed.some(({ role }) => role === "border"));
  assert.ok(fixture.themeCalls.length > 0);
  assert.ok(fixture.themeCalls.every(({ role }) => role === "dim"));
  for (const { width, rows, lines, zero, mounted: recorded } of frames) {
    assert.deepEqual(zero, []);
    assert.ok(lines.length <= Math.max(1, rows - 3), `${width}×${rows}`);
    for (const line of [...lines, ...Object.values(recorded).flat()])
      assert.ok(visibleWidth(line) <= width, `${width}×${rows}: ${line}`);
    assert.equal(
      lines.filter((line) => /^→(?:\s|$)/u.test(stripVTControlCharacters(line))).length,
      1,
      `${width}×${rows}: ${JSON.stringify(lines)}`,
    );
    if (width >= 40) assert.ok(lines.some((line) => line.startsWith(`→ ${capitalize(preset)}`)));
    if (rows >= 8) {
      assert.equal(lines[0], "─".repeat(width));
      assert.equal(lines.at(-1), "─".repeat(width));
    }
    for (const line of Object.values(recorded).flat()) assert.equal(line.includes(CURSOR_MARKER), false);
  }
  assert.equal(normal.filter((line) => line.startsWith("→ ")).length, 1);
  assert.equal(normal.join("\n").includes(CURSOR_MARKER), false);
  assert.doesNotMatch(normal.join("\n"), /Example|recorded-request|tokens in 600|actual-sensitive-id|thinking max/u);
  assert.doesNotMatch(normal.join("\n"), /(?:^|\n)Preview(?: ·|\n)|No assistant response|No enabled fields/u);
  assert.deepEqual(fixture.snapshot(), before);
  for (const write of writes) assert.equal(write.mock.calls.length, 0);
});

test("mouse changes the original Stamp; header and frame cannot activate; choice clicks confirm", async () => {
  const fixture = await fixtureForTest();
  const before = fixture.snapshot();
  const update = vi.spyOn(fixture.runtime, "update");
  const tui = createTuiHarness({ width: 160, rows: 40 });
  const { ctx } = createMockContext({ mode: "tui", custom: tui.custom, sessionManager: fixture.sessionManager });
  const running = showStampMenu(ctx, fixture.runtime, { ...currentOwner(), beginPreview: previewFactory(fixture) });
  await openPresets(tui);
  const initial = tui.render();
  const usageRow = initial.findIndex((line) => line.trimStart().startsWith("Usage"));
  tui.mouse({ type: "press", x: 2, y: usageRow });
  const preview = {
    menu: [...tui.render()],
    mounted: fixture.render(),
    state: fixture.snapshot(),
    calls: update.mock.calls.length,
  };
  const headerRow = preview.menu.findIndex((line) => line.includes("Current preset:"));
  const readOnlyRows = [0, preview.menu.length - 1, preview.menu.findIndex((line) => line.includes("ctrl+c close"))];
  for (const y of [headerRow, ...readOnlyRows]) {
    tui.mouse({ type: "press", x: 2, y });
    tui.mouse({ type: "click", x: 2, y });
  }
  const afterHeader = {
    menu: [...tui.render()],
    mounted: fixture.render(),
    state: fixture.snapshot(),
    calls: update.mock.calls.length,
  };
  tui.mouse({ type: "click", x: 2, y: usageRow });
  await waitForPresetSave(tui);
  const saved = tui.render().join("\n");
  tui.press("ctrl+c");
  await running;

  assert.ok(usageRow >= 0);
  assert.ok(headerRow >= 0);
  assert.ok(readOnlyRows.every((row) => row >= 0));
  assertRecordedPreview(preview.menu, preview.mounted, "usage");
  assert.deepEqual(afterHeader, preview);
  assert.equal(preview.calls, 0);
  assert.deepEqual(preview.state, before);
  assert.deepEqual(update.mock.calls, [[METADATA_PRESETS.usage]]);
  assert.match(saved, /→ Usage ✓ current/u);
  assert.deepEqual(fixture.display.get(), fixture.runtime.get().settings);
});

test.each([
  { name: "timestamp-only Stamp", assistantMessage: "reported" as const, metadata: RESPONSE_METADATA_ROWS.detailed },
  { name: "response without usable metadata", assistantMessage: "no-data" as const, metadata: [] },
  { name: "session without an assistant response", assistantMessage: "none" as const, metadata: [] },
])(
  "$name changes only its original transcript Stamp and keeps confirmed fallback visible",
  async ({ assistantMessage, metadata }) => {
    const fixture = await fixtureForTest({}, undefined, { assistantStamp: "timestamp-only", assistantMessage });
    const before = fixture.snapshot();
    const original = fixture.render();
    const writes = runtimeWrites(fixture);
    const getBranch = vi.fn(() => {
      throw new Error("The picker must not inspect the branch; the mounted Stamp owns fallback reads");
    });
    const tui = createTuiHarness({ width: 160, rows: 40 });
    const context = createMockContext({ mode: "tui", custom: tui.custom, sessionManager: { getBranch } });
    const running = showStampMenu(context.ctx, fixture.runtime, {
      ...currentOwner(),
      beginPreview: previewFactory(fixture),
    });
    await openPresets(tui);
    moveTo(tui, "detailed");
    const menu = [...tui.render()];
    const during = { state: fixture.snapshot(), mounted: fixture.render(), raw: fixture.renderRaw() };
    moveTo(tui, "none");
    const hidden = fixture.render();
    const navigationWrites = writes.map((write) => write.mock.calls.length);
    moveTo(tui, "detailed");
    tui.press("tui.select.confirm");
    await waitForPresetSave(tui);
    const saved = { state: fixture.snapshot(), mounted: fixture.render() };
    tui.press("tui.select.cancel");
    await tui.waitForOpen();
    const afterBack = fixture.render();
    tui.press("ctrl+c");
    await running;

    assertNoPickerPreview(menu);
    assert.deepEqual(during.mounted.assistant, ["2026-10-30 · 14:32:08", ...metadata]);
    assert.match(
      during.mounted.assistantExpanded?.[1] ?? "",
      /^timeline · created 2026-10-30T14:32:08\.000Z · unix-ms \d+$/u,
    );
    assert.deepEqual(during.mounted.assistantExpanded?.slice(2), metadata);
    for (const name of ["assistant", "assistantExpanded"]) {
      for (const line of during.raw[name] ?? []) {
        assert.equal(visibleWidth(line), 160, "The original Stamp must stay right-aligned");
        assert.equal(line.trimEnd(), line, "Alignment must use left padding, not right padding");
      }
      assert.doesNotMatch(
        during.mounted[name]?.join("\n") ?? "",
        /thinking|debug|actual-sensitive-id|recorded-request/u,
      );
    }
    assert.deepEqual(hidden, original, "None must hide fallback metadata live");
    assert.deepEqual(during.state, before);
    assert.ok(navigationWrites.every((count) => count === 0));
    assert.deepEqual(saved.mounted, during.mounted);
    assert.deepEqual(afterBack, saved.mounted);
    assert.deepEqual(fixture.render(), saved.mounted, "Canonical rendering must retain fallback after preview cleanup");
    assert.deepEqual(saved.state.state.settings, { ...before.state.settings, ...METADATA_PRESETS.detailed });
    assert.deepEqual(JSON.parse(saved.state.file), { ...JSON.parse(before.file), ...METADATA_PRESETS.detailed });
    for (const field of ["session", "branch", "leaf", "context", "files"] as const)
      assert.deepEqual(saved.state[field], before[field], field);
    assert.equal(getBranch.mock.calls.length, 0);
    assert.equal(writes[0]?.mock.calls.length, 1);
    for (const write of writes.slice(1)) assert.equal(write.mock.calls.length, 0);
    assert.deepEqual(context.notifications, [{ message: "Metadata preset: Detailed.", level: "info" }]);
    assert.equal(context.statuses.size, 0);
    assert.equal(context.widgets.size, 0);
  },
);

async function fixtureForTest(...args: Parameters<typeof mountedPreviewFixture>) {
  const fixture = await mountedPreviewFixture(...args);
  onTestFinished(() => fixture.dispose());
  return fixture;
}

function runtimeWrites(fixture: Fixture) {
  return [
    vi.spyOn(fixture.runtime, "update"),
    vi.spyOn(fixture.runtime, "reload"),
    vi.spyOn(fixture.runtime, "flush"),
    vi.spyOn(fixture.sessionManager, "appendCustomEntry"),
    vi.spyOn(fixture.sessionManager, "appendMessage"),
  ];
}

function previewFactory(fixture: Fixture, leases: StampPresetPreview[] = []) {
  return vi.fn((signal: AbortSignal) => {
    const lease = fixture.display.begin(signal);
    vi.spyOn(lease, "dispose");
    leases.push(lease);
    return lease;
  });
}

async function openPresets(tui: ReturnType<typeof createTuiHarness>) {
  await tui.waitForOpen();
  tui.press("tui.select.confirm");
  await tui.waitForOpen();
}

function moveTo(tui: ReturnType<typeof createTuiHarness>, preset: StampMetadataPreset) {
  for (let index = 0; index < METADATA_PRESET_NAMES.length; index += 1) {
    if (tui.render().some((line) => stripVTControlCharacters(line).startsWith(`→ ${capitalize(preset)}`))) return;
    tui.press("tui.select.down");
  }
  assert.fail(`Preset ${preset} was not reachable`);
}

function assertRecordedPreview(
  menu: readonly string[],
  mounted: ReturnType<Fixture["render"]>,
  preset: StampMetadataPreset,
) {
  assert.ok(
    menu.some((line) => line.startsWith(`→ ${capitalize(preset)}`)),
    menu.join("\n"),
  );
  assertNoPickerPreview(menu);
  assert.deepEqual(mounted.assistant, ["2026-10-30 · 14:32:08", ...METADATA_ROWS[preset]]);
  assert.deepEqual(mounted.user, ["2026-10-30 · 14:31:20"]);
  assert.deepEqual(mounted.legacy, ["2026-10-30 · 14:32:12"]);
  const sparseMetadata =
    preset === "detailed"
      ? ["api sparse-api · provider sparse-provider · requested sparse-model · stop stop"]
      : preset === "compact" || preset === "model"
        ? ["sparse-model"]
        : [];
  assert.deepEqual(mounted.sparse, ["2026-10-30 · 14:32:13", ...sparseMetadata]);
  assert.deepEqual(mounted.tool, ["tool read · 1.3s · success"]);
  const expanded = mounted.assistantExpanded?.join("\n") ?? "";
  assert.match(expanded, /timeline · created 2026-10-30T14:32:08\.000Z/u);
  assert.match(expanded, /timeline · first content 2026-10-30T14:32:08\.800Z/u);
  assert.match(expanded, /timeline · completed 2026-10-30T14:32:11\.200Z/u);
  assert.doesNotMatch(expanded, /debug ·|recorded-id|recorded-diagnostic/u);
  for (const line of Object.values(mounted).flat()) assert.equal(line.includes(CURSOR_MARKER), false);
}

function assertNoPickerPreview(menu: readonly string[]) {
  const rows = menu.map((line) => stripVTControlCharacters(line).trim());
  assert.doesNotMatch(
    rows.join("\n"),
    /(?:^|\n)Preview(?: ·|\n)|No assistant response|No enabled fields|metadata is hidden|Example|recorded-request|actual-request|tokens in 600|actual-sensitive-id|thinking max/u,
  );
  assert.equal(rows.filter((line) => line.startsWith("→ ")).length, 1);
  const lastChoice = rows.findIndex((line) => /^(?:→ )?None(?: ✓ current)?\s/u.test(line));
  assert.ok(lastChoice >= 0, rows.join("\n"));
  assert.match(rows[lastChoice + 1] ?? "", /ctrl\+c close/u, "No empty detail block may follow the choices");
}

function capitalize(value: string) {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function normalize(value: string) {
  return value.replace(/\s+/gu, " ").trim();
}
