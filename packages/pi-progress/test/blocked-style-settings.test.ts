import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import {
  DEFAULT_PROGRESS_SETTINGS,
  loadProgressSettings,
  normalizeProgressSettings,
  saveProgressSettings,
} from "../src/settings.js";

const defaultStyle = { icon: "⚠", color: "warning" };

async function settingsPath(t: { onTestFinished(callback: () => Promise<void>): void }) {
  const directory = await mkdtemp(join(tmpdir(), "pi-progress-blocked-style-"));
  t.onTestFinished(() => rm(directory, { recursive: true, force: true }));
  return join(directory, "pi-progress.json");
}

test("blockedStyle defaults and partial fields are independent", () => {
  assert.deepEqual(normalizeProgressSettings({})?.blockedStyle, defaultStyle);
  for (const [blockedStyle, expected] of [
    [{}, defaultStyle],
    [{ icon: "◆" }, { ...defaultStyle, icon: "◆" }],
    [{ color: "thinkingHigh" }, { ...defaultStyle, color: "thinkingHigh" }],
    [
      { icon: "◆", color: "thinkingHigh" },
      { icon: "◆", color: "thinkingHigh" },
    ],
    [
      { icon: "⚠️", color: "thinkingHigh" },
      { ...defaultStyle, color: "thinkingHigh" },
    ],
    [
      { icon: "◆", color: false },
      { ...defaultStyle, icon: "◆" },
    ],
  ]) {
    assert.deepEqual(normalizeProgressSettings({ blockedStyle })?.blockedStyle, expected);
  }
  for (const blockedStyle of [null, [], false, "!"]) {
    assert.deepEqual(normalizeProgressSettings({ blockedStyle, showProgress: false }), {
      ...DEFAULT_PROGRESS_SETTINGS,
      showProgress: false,
      blockedStyle: defaultStyle,
    });
  }
});

test("accepts safe single-cell icons and rejects unsafe or non-icon strings", () => {
  for (const icon of ["⚠", "⚠︎", "◆", "!", "é", "\ue0b0"]) {
    assert.equal(normalizeProgressSettings({ blockedStyle: { icon } })?.blockedStyle.icon, icon);
  }
  for (const icon of [
    null,
    1,
    "",
    " ",
    "\t",
    "ab",
    "界",
    "⚠️",
    "👩‍💻",
    "🇯🇵",
    "1️⃣",
    "́",
    "\u093e",
    "!\n",
    "!\r",
    "!\u0000",
    "!\u0007",
    "!\u0085",
    "!\u2028",
    "!\u2029",
    "\u001b[31m!\u001b[0m",
    "\u001b]8;;https://example.com\u0007!\u001b]8;;\u0007",
    "\u001b_!\u001b\\",
    "\u001bP!\u001b\\",
    "!\u001b",
    "!\u202e",
    "!\u200b",
    "!\u200c",
    "!\u200d",
    "\ud800",
  ]) {
    assert.equal(normalizeProgressSettings({ blockedStyle: { icon } })?.blockedStyle.icon, "⚠", JSON.stringify(icon));
  }
});

test("retains legacy widget settings and top-level blockedStyle precedence", () => {
  const nested = { enabled: false, blockedStyle: { icon: "◆", color: "thinkingHigh" } };
  assert.deepEqual(normalizeProgressSettings({ widget: nested })?.blockedStyle, nested.blockedStyle);
  assert.deepEqual(normalizeProgressSettings({ widget: nested, blockedStyle: { icon: "!" } })?.blockedStyle, {
    icon: "!",
    color: "warning",
  });
  assert.deepEqual(normalizeProgressSettings({ widget: nested, blockedStyle: null })?.blockedStyle, defaultStyle);
});

test("loads fallback diagnostics without changing valid settings or raw bytes", async (t) => {
  const path = await settingsPath(t);
  const source = JSON.stringify({ blockedStyle: { icon: "!\u001b", color: false }, showProgress: false });
  await writeFile(path, source);
  const loaded = await loadProgressSettings(path);
  assert.equal(loaded.kind, "loaded");
  assert.deepEqual(loaded.settings.blockedStyle, defaultStyle);
  assert.equal(loaded.settings.showProgress, false);
  assert.ok(loaded.kind === "loaded");
  assert.equal(loaded.warnings?.length, 2);
  assert.match(loaded.warnings?.join(" ") ?? "", /blockedStyle.icon.*blockedStyle.color/u);
  assert.ok(!loaded.warnings?.join(" ").includes("\u001b"));
  assert.equal(await readFile(path, "utf8"), source);
});

test("unrelated saves preserve custom style, unknown nested fields, and fallback source values", async (t) => {
  const path = await settingsPath(t);
  for (const icon of ["◆", "⚠️"]) {
    const blockedStyle = { icon, color: "thinkingHigh", future: { retain: true } };
    await writeFile(path, JSON.stringify({ blockedStyle, future: true }));
    const saved = await saveProgressSettings({ showProgress: false }, path);
    assert.deepEqual(saved.blockedStyle, { icon: icon === "◆" ? icon : "⚠", color: "thinkingHigh" });
    assert.deepEqual(JSON.parse(await readFile(path, "utf8")), { blockedStyle, future: true, showProgress: false });
    assert.deepEqual((await loadProgressSettings(path)).settings, saved);
  }
  await saveProgressSettings({ blockedStyle: { icon: "!", color: "muted" } }, path);
  assert.deepEqual(JSON.parse(await readFile(path, "utf8")).blockedStyle, {
    icon: "!",
    color: "muted",
    future: { retain: true },
  });
});
