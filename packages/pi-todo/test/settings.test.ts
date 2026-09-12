import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import {
  DEFAULT_TODO_SETTINGS,
  loadTodoSettings,
  MAX_TODO_SETTINGS_BYTES,
  normalizeTodoSettings,
} from "../src/settings.js";

async function temporaryDirectory(t: { onTestFinished(callback: () => Promise<void>): void }) {
  const directory = await mkdtemp(join(tmpdir(), "pi-todo-settings-"));
  t.onTestFinished(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

test("normalizes partial widget settings and rejects invalid values", () => {
  assert.deepEqual(normalizeTodoSettings({}), DEFAULT_TODO_SETTINGS);
  assert.deepEqual(normalizeTodoSettings({ future: true, widget: { future: "kept" } }), {
    widget: { ...DEFAULT_TODO_SETTINGS.widget },
  });
  assert.deepEqual(
    normalizeTodoSettings({
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
    assert.equal(normalizeTodoSettings(value), undefined);
  }
});

test("missing settings load is side-effect free", async (t) => {
  const directory = await temporaryDirectory(t);
  const parent = join(directory, "missing-parent");
  const path = join(parent, "pi-todo.json");
  assert.deepEqual(await loadTodoSettings(path), {
    kind: "missing",
    path,
    settings: { widget: { ...DEFAULT_TODO_SETTINGS.widget } },
  });
  await assert.rejects(access(parent));
  assert.deepEqual(await readdir(directory), []);
});

test("loads valid settings without rewriting unknown fields", async (t) => {
  const directory = await temporaryDirectory(t);
  const path = join(directory, "pi-todo.json");
  const source = `${JSON.stringify({
    future: { enabled: true },
    widget: {
      displayMode: "expanded",
      maxVisibleItems: null,
      futureWidget: "untouched",
    },
  })}\n`;
  await writeFile(path, source, "utf8");
  assert.deepEqual(await loadTodoSettings(path), {
    kind: "loaded",
    path,
    settings: {
      widget: {
        ...DEFAULT_TODO_SETTINGS.widget,
        displayMode: "expanded",
      },
    },
  });
  assert.equal(await readFile(path, "utf8"), source);
});

test("loads UTF-8 BOM settings", async (t) => {
  const directory = await temporaryDirectory(t);
  const path = join(directory, "pi-todo.json");
  const document = Buffer.from('{"widget":{"showProgress":false}}', "utf8");
  await writeFile(path, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), document]));
  assert.deepEqual(await loadTodoSettings(path), {
    kind: "loaded",
    path,
    settings: {
      widget: {
        ...DEFAULT_TODO_SETTINGS.widget,
        showProgress: false,
      },
    },
  });
});

test("reports malformed, invalid, oversized, non-regular, and symlink settings", async (t) => {
  const directory = await temporaryDirectory(t);
  const path = join(directory, "pi-todo.json");

  await writeFile(path, "{invalid", "utf8");
  let result = await loadTodoSettings(path);
  assert.equal(result.kind, "invalid");
  assert.match(result.kind === "invalid" ? result.issue : "", /invalid JSON/u);
  assert.equal(await readFile(path, "utf8"), "{invalid");

  await writeFile(path, '{"widget":{"maxVisibleItems":0}}', "utf8");
  result = await loadTodoSettings(path);
  assert.equal(result.kind, "invalid");
  assert.match(result.kind === "invalid" ? result.issue : "", /shape or values/u);

  await writeFile(path, "x".repeat(MAX_TODO_SETTINGS_BYTES + 1), "utf8");
  result = await loadTodoSettings(path);
  assert.equal(result.kind, "invalid");
  assert.match(result.kind === "invalid" ? result.issue : "", /exceeds/u);

  const directoryPath = join(directory, "settings-directory");
  await mkdir(directoryPath);
  result = await loadTodoSettings(directoryPath);
  assert.equal(result.kind, "invalid");
  assert.match(result.kind === "invalid" ? result.issue : "", /regular file/u);

  const target = join(directory, "target.json");
  const link = join(directory, "link.json");
  await writeFile(target, "{}", "utf8");
  await symlink(target, link);
  result = await loadTodoSettings(link);
  assert.equal(result.kind, "invalid");
  assert.match(result.kind === "invalid" ? result.issue : "", /symbolic links/u);
});

test("rejects invalid UTF-8 and honors cancellation", async (t) => {
  const directory = await temporaryDirectory(t);
  const path = join(directory, "pi-todo.json");
  await writeFile(path, Buffer.from([0xc3, 0x28]));
  const invalid = await loadTodoSettings(path);
  assert.equal(invalid.kind, "invalid");
  assert.match(invalid.kind === "invalid" ? invalid.issue : "", /UTF-8/u);

  const controller = new AbortController();
  controller.abort();
  await assert.rejects(loadTodoSettings(path, controller.signal), /abort/iu);
});
