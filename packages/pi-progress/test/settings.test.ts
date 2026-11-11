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

test("normalizes partial flat Progress settings and rejects invalid values", () => {
  assert.deepEqual(normalizeProgressSettings({}), DEFAULT_PROGRESS_SETTINGS);
  assert.deepEqual(normalizeProgressSettings({ future: true }), DEFAULT_PROGRESS_SETTINGS);
  const settings = {
    enabled: false,
    displayMode: "collapsed",
    showCompleted: false,
    maxVisibleItems: 7,
    showProgress: false,
  };
  assert.deepEqual(normalizeProgressSettings(settings), { ...DEFAULT_PROGRESS_SETTINGS, ...settings });
  for (const displayMode of ["adaptive", "expanded", "collapsed"]) {
    assert.equal(normalizeProgressSettings({ displayMode })?.displayMode, displayMode);
  }
  for (const maxVisibleItems of [null, 1, 50]) {
    assert.equal(normalizeProgressSettings({ maxVisibleItems })?.maxVisibleItems, maxVisibleItems);
  }

  for (const value of [
    null,
    [],
    { enabled: "yes" },
    { displayMode: "compact" },
    { showCompleted: 1 },
    { showProgress: null },
    { maxVisibleItems: 0 },
    { maxVisibleItems: 51 },
    { maxVisibleItems: 1.5 },
  ]) {
    assert.equal(normalizeProgressSettings(value), undefined);
  }
});

test("retains nested canonical settings with field-level top-level precedence", () => {
  const nested = { enabled: false, displayMode: "expanded", maxVisibleItems: 7, future: true };
  assert.deepEqual(normalizeProgressSettings({ widget: nested }), {
    ...DEFAULT_PROGRESS_SETTINGS,
    enabled: false,
    displayMode: "expanded",
    maxVisibleItems: 7,
  });
  assert.deepEqual(normalizeProgressSettings({ widget: nested, enabled: true, maxVisibleItems: null }), {
    ...DEFAULT_PROGRESS_SETTINGS,
    displayMode: "expanded",
  });
  assert.equal(normalizeProgressSettings({ widget: { enabled: "invalid" }, enabled: true })?.enabled, true);
  for (const widget of [null, true, [], { enabled: "yes" }, { displayMode: "compact" }]) {
    assert.equal(normalizeProgressSettings({ widget }), undefined);
  }
  assert.equal(normalizeProgressSettings({ widget: { enabled: false }, enabled: "invalid" }), undefined);
});

test("loads flat canonical settings without changing either settings file", async (t) => {
  const directory = await temporaryDirectory(t);
  const canonical = join(directory, "pi-progress.json");
  const legacy = join(directory, "pi-todo.json");
  const canonicalSource = '{"showProgress":false,"future":true}\n';
  const legacySource = '{"widget":{"enabled":false}}\n';
  await writeFile(canonical, canonicalSource, "utf8");
  await writeFile(legacy, legacySource, "utf8");

  assert.deepEqual(await loadProgressSettings(canonical), {
    kind: "loaded",
    path: canonical,
    settings: { ...DEFAULT_PROGRESS_SETTINGS, showProgress: false },
  });
  assert.equal(await readFile(canonical, "utf8"), canonicalSource);
  assert.equal(await readFile(legacy, "utf8"), legacySource);
});

test("loads nested canonical settings read-only", async (t) => {
  const directory = await temporaryDirectory(t);
  const canonical = join(directory, "pi-progress.json");
  const source = '{"widget":{"displayMode":"expanded","maxVisibleItems":null},"future":true}\n';
  await writeFile(canonical, source, "utf8");
  assert.deepEqual(await loadProgressSettings(canonical), {
    kind: "loaded",
    path: canonical,
    settings: { ...DEFAULT_PROGRESS_SETTINGS, displayMode: "expanded" },
  });
  assert.equal(await readFile(canonical, "utf8"), source);
});

test("ignores valid and invalid pi-todo.json files when canonical settings are absent", async (t) => {
  const directory = await temporaryDirectory(t);
  const canonical = join(directory, "pi-progress.json");
  const legacy = join(directory, "pi-todo.json");
  for (const source of ['{"widget":{"enabled":false}}', "{invalid"]) {
    await writeFile(legacy, source, "utf8");
    assert.deepEqual(await loadProgressSettings(canonical), {
      kind: "missing",
      path: canonical,
      settings: { ...DEFAULT_PROGRESS_SETTINGS },
    });
    assert.equal(await readFile(legacy, "utf8"), source);
    await assert.rejects(access(canonical));
    assert.deepEqual(await readdir(directory), ["pi-todo.json"]);
  }
});

test("an invalid canonical file reports its error without reading pi-todo.json", async (t) => {
  const directory = await temporaryDirectory(t);
  const canonical = join(directory, "pi-progress.json");
  const legacy = join(directory, "pi-todo.json");
  await writeFile(canonical, "{invalid", "utf8");
  await writeFile(legacy, '{"widget":{"enabled":false}}', "utf8");

  const result = await loadProgressSettings(canonical);
  assert.equal(result.kind, "invalid");
  assert.equal(result.path, canonical);
  assert.deepEqual(result.settings, DEFAULT_PROGRESS_SETTINGS);
  assert.match(result.kind === "invalid" ? result.issue : "", /invalid JSON/u);
  assert.equal(await readFile(canonical, "utf8"), "{invalid");
  assert.equal(await readFile(legacy, "utf8"), '{"widget":{"enabled":false}}');
});

test("missing settings are side-effect free", async (t) => {
  const directory = await temporaryDirectory(t);
  const parent = join(directory, "missing-parent");
  const canonical = join(parent, "pi-progress.json");
  assert.deepEqual(await loadProgressSettings(canonical), {
    kind: "missing",
    path: canonical,
    settings: { ...DEFAULT_PROGRESS_SETTINGS },
  });
  await assert.rejects(access(parent));
  assert.deepEqual(await readdir(directory), []);
});

test("loads canonical UTF-8 BOM settings without rewriting bytes", async (t) => {
  const directory = await temporaryDirectory(t);
  const canonical = join(directory, "pi-progress.json");
  const document = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('{"showProgress":false}', "utf8")]);
  await writeFile(canonical, document);
  assert.deepEqual(await loadProgressSettings(canonical), {
    kind: "loaded",
    path: canonical,
    settings: { ...DEFAULT_PROGRESS_SETTINGS, showProgress: false },
  });
  assert.deepEqual(await readFile(canonical), document);
});

test("rejects malformed, invalid, oversized, non-regular, symlink, and non-UTF-8 canonical files", async (t) => {
  const directory = await temporaryDirectory(t);
  const canonical = join(directory, "pi-progress.json");

  const cases: Array<{ source: string | Buffer; pattern: RegExp }> = [
    { source: "{invalid", pattern: /invalid JSON/u },
    { source: '{"maxVisibleItems":0}', pattern: /shape or values/u },
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

test("ignores symlinked pi-todo.json without creating canonical settings", async (t) => {
  const directory = await temporaryDirectory(t);
  const canonical = join(directory, "pi-progress.json");
  const target = join(directory, "target.json");
  const legacy = join(directory, "pi-todo.json");
  await writeFile(target, '{"widget":{"enabled":false}}', "utf8");
  await symlink(target, legacy);

  assert.deepEqual(await loadProgressSettings(canonical), {
    kind: "missing",
    path: canonical,
    settings: { ...DEFAULT_PROGRESS_SETTINGS },
  });
  await assert.rejects(access(canonical));
});

test("honors cancellation before canonical reads", async (t) => {
  const directory = await temporaryDirectory(t);
  const canonical = join(directory, "pi-progress.json");
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(loadProgressSettings(canonical, controller.signal), /abort/iu);
  assert.deepEqual(await readdir(directory), []);
});
