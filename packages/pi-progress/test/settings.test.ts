import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import {
  DEFAULT_PROGRESS_SETTINGS,
  loadProgressSettings,
  MAX_PROGRESS_SETTINGS_BYTES,
  normalizeProgressSettings,
} from "../src/settings.js";

async function temporaryDirectory(t: { onTestFinished(callback: () => Promise<void>): void }) {
  const directory = await mkdtemp(join(tmpdir(), "pi-progress-settings-"));
  t.onTestFinished(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

test("normalizes partial Progress widget settings and rejects invalid values", () => {
  assert.deepEqual(normalizeProgressSettings({}), DEFAULT_PROGRESS_SETTINGS);
  assert.deepEqual(normalizeProgressSettings({ future: true, widget: { future: "kept" } }), {
    widget: { ...DEFAULT_PROGRESS_SETTINGS.widget },
  });
  assert.deepEqual(
    normalizeProgressSettings({
      widget: {
        enabled: false,
        displayMode: "collapsed",
        showCompleted: false,
        maxVisibleItems: 7,
        showProgress: false,
      },
    }),
    {
      widget: {
        enabled: false,
        displayMode: "collapsed",
        showCompleted: false,
        maxVisibleItems: 7,
        showProgress: false,
      },
    },
  );

  for (const value of [
    null,
    [],
    { widget: true },
    { widget: { enabled: "yes" } },
    { widget: { displayMode: "compact" } },
    { widget: { showCompleted: 1 } },
    { widget: { showProgress: null } },
    { widget: { maxVisibleItems: 0 } },
    { widget: { maxVisibleItems: 51 } },
    { widget: { maxVisibleItems: 1.5 } },
  ]) {
    assert.equal(normalizeProgressSettings(value), undefined);
  }
});

test("canonical settings win when both canonical and legacy files exist", async (t) => {
  const directory = await temporaryDirectory(t);
  const canonical = join(directory, "pi-progress.json");
  const legacy = join(directory, "pi-todo.json");
  const canonicalSource = '{"widget":{"showProgress":false},"future":true}\n';
  const legacySource = '{"widget":{"enabled":false}}\n';
  await writeFile(canonical, canonicalSource, "utf8");
  await writeFile(legacy, legacySource, "utf8");

  assert.deepEqual(await loadProgressSettings(canonical), {
    kind: "loaded",
    path: canonical,
    settings: { widget: { ...DEFAULT_PROGRESS_SETTINGS.widget, showProgress: false } },
  });
  assert.equal(await readFile(canonical, "utf8"), canonicalSource);
  assert.equal(await readFile(legacy, "utf8"), legacySource);
});

test("uses the legacy settings file read-only only when canonical settings are absent", async (t) => {
  const directory = await temporaryDirectory(t);
  const canonical = join(directory, "pi-progress.json");
  const legacy = join(directory, "pi-todo.json");
  const source = '{"widget":{"displayMode":"expanded","maxVisibleItems":null},"future":true}\n';
  await writeFile(legacy, source, "utf8");

  assert.deepEqual(await loadProgressSettings(canonical), {
    kind: "loaded",
    path: legacy,
    settings: { widget: { ...DEFAULT_PROGRESS_SETTINGS.widget, displayMode: "expanded" } },
  });
  assert.equal(await readFile(legacy, "utf8"), source);
  await assert.rejects(access(canonical));
  assert.deepEqual(await readdir(directory), ["pi-todo.json"]);
});

test("an invalid canonical file warns through its result and never falls back", async (t) => {
  const directory = await temporaryDirectory(t);
  const canonical = join(directory, "pi-progress.json");
  const legacy = join(directory, "pi-todo.json");
  await writeFile(canonical, "{invalid", "utf8");
  await writeFile(legacy, '{"widget":{"enabled":false}}', "utf8");

  const result = await loadProgressSettings(canonical);
  assert.equal(result.kind, "invalid");
  assert.equal(result.path, canonical);
  assert.match(result.kind === "invalid" ? result.issue : "", /invalid JSON/u);
  assert.equal(await readFile(canonical, "utf8"), "{invalid");
  assert.equal(await readFile(legacy, "utf8"), '{"widget":{"enabled":false}}');
});

test("missing canonical and legacy settings are side-effect free", async (t) => {
  const directory = await temporaryDirectory(t);
  const parent = join(directory, "missing-parent");
  const canonical = join(parent, "pi-progress.json");
  assert.deepEqual(await loadProgressSettings(canonical), {
    kind: "missing",
    path: canonical,
    settings: { widget: { ...DEFAULT_PROGRESS_SETTINGS.widget } },
  });
  await assert.rejects(access(parent));
  assert.deepEqual(await readdir(directory), []);
});

test("loads canonical UTF-8 BOM settings without rewriting bytes", async (t) => {
  const directory = await temporaryDirectory(t);
  const canonical = join(directory, "pi-progress.json");
  const document = Buffer.concat([
    Buffer.from([0xef, 0xbb, 0xbf]),
    Buffer.from('{"widget":{"showProgress":false}}', "utf8"),
  ]);
  await writeFile(canonical, document);
  assert.deepEqual(await loadProgressSettings(canonical), {
    kind: "loaded",
    path: canonical,
    settings: { widget: { ...DEFAULT_PROGRESS_SETTINGS.widget, showProgress: false } },
  });
  assert.deepEqual(await readFile(canonical), document);
});

test("rejects malformed, invalid, oversized, non-regular, symlink, and non-UTF-8 canonical files", async (t) => {
  const directory = await temporaryDirectory(t);
  const canonical = join(directory, "pi-progress.json");

  const cases: Array<{ source: string | Buffer; pattern: RegExp }> = [
    { source: "{invalid", pattern: /invalid JSON/u },
    { source: '{"widget":{"maxVisibleItems":0}}', pattern: /shape or values/u },
    { source: "x".repeat(MAX_PROGRESS_SETTINGS_BYTES + 1), pattern: /exceeds/u },
    { source: Buffer.from([0xc3, 0x28]), pattern: /UTF-8/u },
  ];
  for (const fixture of cases) {
    await writeFile(canonical, fixture.source);
    const before = await readFile(canonical);
    const result = await loadProgressSettings(canonical);
    assert.equal(result.kind, "invalid");
    assert.match(result.kind === "invalid" ? result.issue : "", fixture.pattern);
    assert.deepEqual(await readFile(canonical), before);
  }

  const directoryPath = join(directory, "settings-directory");
  await mkdir(directoryPath);
  let result = await loadProgressSettings(directoryPath);
  assert.equal(result.kind, "invalid");
  assert.match(result.kind === "invalid" ? result.issue : "", /regular file/u);

  const target = join(directory, "target.json");
  const link = join(directory, "link.json");
  await writeFile(target, "{}", "utf8");
  await symlink(target, link);
  result = await loadProgressSettings(link);
  assert.equal(result.kind, "invalid");
  assert.match(result.kind === "invalid" ? result.issue : "", /symbolic links/u);
});

test("applies the same safety validation to the legacy fallback", async (t) => {
  const directory = await temporaryDirectory(t);
  const canonical = join(directory, "pi-progress.json");
  const target = join(directory, "target.json");
  const legacy = join(directory, "pi-todo.json");
  await writeFile(target, '{"widget":{"enabled":false}}', "utf8");
  await symlink(target, legacy);

  const result = await loadProgressSettings(canonical);
  assert.equal(result.kind, "invalid");
  assert.equal(result.path, legacy);
  assert.match(result.kind === "invalid" ? result.issue : "", /symbolic links/u);
  await assert.rejects(access(canonical));
});

test("honors cancellation before canonical reads and before legacy fallback publication", async (t) => {
  const directory = await temporaryDirectory(t);
  const canonical = join(directory, "pi-progress.json");
  await writeFile(join(directory, "pi-todo.json"), "{}", "utf8");
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(loadProgressSettings(canonical, controller.signal), /abort/iu);
  assert.deepEqual(await readdir(directory), ["pi-todo.json"]);
});
