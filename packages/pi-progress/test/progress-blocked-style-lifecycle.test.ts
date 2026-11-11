import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { type ExtensionCommandContext, initTheme } from "@earendil-works/pi-coding-agent";
import { createTuiHarness } from "@narumitw/pi-tui-kit/testing";
import { test } from "vitest";
import { loadProgressSettings, type ProgressSettingsLoadResult, saveProgressSettings } from "../src/settings.js";
import { createContext, createHarness, loadedSettings, setProgress, toolResultEntry } from "./progress-harness.js";
import { createProgressTheme } from "./progress-theme.js";

initTheme("dark", false);

async function settingsPath(t: { onTestFinished(callback: () => Promise<void>): void }) {
  const directory = await mkdtemp(join(tmpdir(), "pi-progress-blocked-lifecycle-"));
  t.onTestFinished(() => rm(directory, { recursive: true, force: true }));
  return join(directory, "pi-progress.json");
}

function harnessFor(path: string) {
  return createHarness({
    loadSettings: (_path, signal) => loadProgressSettings(path, signal),
    saveSettings: (patch, _path, signal) => saveProgressSettings(patch, path, signal),
  });
}

const steps = [{ text: "approval", status: "blocked" as const }];
const branch = () => [toolResultEntry({ version: 5, steps })];

for (const mode of ["tui", "rpc", "print", "json"] as const) {
  test(`${mode}: invalid style fields warn only in UI modes and retain valid preferences and source bytes`, async (t) => {
    const path = await settingsPath(t);
    const source = JSON.stringify({ blockedStyle: { icon: "⚠️", color: "selectedBg" }, showProgress: false });
    await writeFile(path, source);
    const current = createContext({ mode, branch: branch() });
    const theme = createProgressTheme();
    current.setTheme(theme);
    const harness = harnessFor(path);
    try {
      await harness.emit("session_start", current.ctx);
      if (mode === "tui" || mode === "rpc") {
        assert.equal(current.notifications.length, 1);
        assert.equal(current.notifications[0]?.type, "warning");
        assert.match(current.notifications[0]?.message ?? "", /blockedStyle.icon.*blockedStyle.color/u);
        if (mode === "tui") {
          assert.deepEqual(current.renderWidget(), [
            theme.fg("borderMuted", "─") +
              " " +
              theme.fg("muted", "▾ Progress · ⚠ 1 blocked") +
              " " +
              theme.fg("borderMuted", "─".repeat(53)),
            theme.fg("warning", "⚠ ") + theme.fg("warning", "approval"),
          ]);
        } else {
          assert.deepEqual(current.renderWidget(), [
            theme.fg("borderMuted", "─".repeat(80)),
            theme.fg("muted", "Progress"),
            theme.fg("warning", "⚠ ") + theme.fg("warning", "approval"),
          ]);
        }
      } else {
        assert.deepEqual(current.notifications, []);
        assert.deepEqual(current.widgets, []);
      }
      assert.equal(await readFile(path, "utf8"), source);
    } finally {
      await harness.emit("session_shutdown", current.ctx);
    }
  });
}

test("session restart reads changed style without rewriting stored progress or publishing through the old owner", async (t) => {
  const path = await settingsPath(t);
  await writeFile(path, JSON.stringify({ blockedStyle: { icon: "◆", color: "thinkingHigh" } }));
  const harness = harnessFor(path);
  const current = createContext({ branch: branch() });
  const replacement = createContext({ branch: branch() });
  const theme = createProgressTheme();
  current.setTheme(theme);
  replacement.setTheme(theme);
  try {
    await harness.emit("session_start", current.ctx);
    assert.equal(current.renderWidget()[1], theme.fg("thinkingHigh", "◆ ") + theme.fg("thinkingHigh", "approval"));
    assert.deepEqual(current.notifications, []);
    const mounted = current.component;
    await writeFile(path, JSON.stringify({ blockedStyle: { icon: "!", color: "error" } }));
    await harness.emit("session_start", replacement.ctx);
    assert.deepEqual(mounted?.render(80), []);
    assert.equal(replacement.renderWidget()[1], theme.fg("error", "! ") + theme.fg("error", "approval"));
    assert.deepEqual(replacement.notifications, []);
    assert.deepEqual(harness.entries, []);
    assert.deepEqual(replacement.branch, branch());
  } finally {
    await harness.emit("session_shutdown", replacement.ctx);
  }
});

for (const boundary of ["replacement", "shutdown"] as const) {
  test(`${boundary}: a stale style load cannot warn or publish`, async () => {
    let resolve!: (result: ProgressSettingsLoadResult) => void;
    const waiting = new Promise<ProgressSettingsLoadResult>((complete) => {
      resolve = complete;
    });
    let reads = 0;
    const harness = createHarness({
      loadSettings: () => (++reads === 1 ? waiting : Promise.resolve(loadedSettings({}))),
    });
    const current = createContext({ branch: branch() });
    const replacement = createContext();
    const starting = harness.emit("session_start", current.ctx);
    try {
      if (boundary === "replacement") await harness.emit("session_start", replacement.ctx);
      else await harness.emit("session_shutdown", current.ctx);
      const count = current.widgets.length;
      resolve({
        ...loadedSettings({ blockedStyle: { icon: "!", color: "unknown" } }),
        kind: "loaded",
        warnings: ["blockedStyle.icon ignored"],
      });
      await starting;
      assert.equal(current.widgets.length, count);
      assert.deepEqual(current.notifications, []);
      assert.deepEqual(replacement.notifications, []);
    } finally {
      resolve(loadedSettings({}));
      await starting;
      await harness.emit("session_shutdown", replacement.ctx);
    }
  });
}

test("the existing settings screen saves display preferences without losing file-only style or nested unknown fields", async (t) => {
  const path = await settingsPath(t);
  const blockedStyle = { icon: "◆", color: "thinkingHigh", future: { retain: true } };
  await writeFile(path, JSON.stringify({ blockedStyle }));
  const current = createContext();
  const theme = createProgressTheme();
  current.setTheme(theme);
  const harness = harnessFor(path);
  const screen = createTuiHarness();
  Object.assign(current.ctx.ui, { custom: screen.custom });
  let command: Promise<void> | undefined;
  try {
    await harness.emit("session_start", current.ctx);
    await setProgress(harness, current.ctx, steps);
    const handler = harness.commands.get("progress")?.handler;
    assert.ok(handler);
    command = handler("settings", current.ctx as ExtensionCommandContext);
    await screen.waitForOpen();
    assert.doesNotMatch(screen.render().join("\n"), /Blocked style|Blocked icon|Blocked color/u);
    screen.press("tui.select.down");
    screen.press("tui.select.confirm");
    await screen.waitForPending();
    screen.press("ctrl+c");
    await command;
    assert.deepEqual(JSON.parse(await readFile(path, "utf8")), { blockedStyle, displayMode: "expanded" });
    assert.equal(current.renderWidget()[1], theme.fg("thinkingHigh", "◆ ") + theme.fg("thinkingHigh", "approval"));
    assert.deepEqual(current.notifications, []);
    assert.equal(stripVTControlCharacters(current.renderWidget()[1] ?? ""), "◆ approval");
  } finally {
    screen.dispose();
    await command;
    await harness.emit("session_shutdown", current.ctx);
  }
});
