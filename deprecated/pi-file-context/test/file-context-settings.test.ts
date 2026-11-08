import assert from "node:assert/strict";
import { access, lstat, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import {
  DEFAULT_FILE_CONTEXT_SETTINGS,
  loadFileContextSettings,
  normalizeKeyId,
  updateFileContextSettings,
} from "../src/file-context-settings.js";

async function withTempSettings(run: (settingsPath: string, directory: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "pi-file-context-settings-test-"));
  try {
    await run(join(root, "pi-file-context.json"), root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("missing settings use Ctrl+Shift+X without creating a file", async () => {
  await withTempSettings(async (settingsPath) => {
    const result = await loadFileContextSettings(settingsPath);
    assert.deepEqual(result, { settings: { openShortcut: "ctrl+shift+x" } });
    await assert.rejects(access(settingsPath), { code: "ENOENT" });
  });
});

test("settings normalize a custom shortcut and allow disabling it", async () => {
  await withTempSettings(async (settingsPath) => {
    await writeFile(settingsPath, JSON.stringify({ openShortcut: "Ctrl+Alt+R", future: true }));
    assert.deepEqual(await loadFileContextSettings(settingsPath), {
      settings: { openShortcut: "ctrl+alt+r" },
    });

    await writeFile(settingsPath, JSON.stringify({ openShortcut: null }));
    assert.deepEqual(await loadFileContextSettings(settingsPath), {
      settings: { openShortcut: null },
    });
    assert.equal(normalizeKeyId(" Ctrl+Shift+P "), "ctrl+shift+p");
    assert.equal(normalizeKeyId("ctrl+f1"), undefined);
    assert.equal(normalizeKeyId("ctrl+not-a-key"), undefined);
  });
});

test("accepts a UTF-8 BOM without weakening strict decoding", async () => {
  await withTempSettings(async (settingsPath) => {
    await writeFile(
      settingsPath,
      Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('{"openShortcut":"f8"}')]),
    );
    assert.deepEqual(await loadFileContextSettings(settingsPath), {
      settings: { openShortcut: "f8" },
    });
  });
});

test("malformed or invalid settings keep the default and block writes", async () => {
  await withTempSettings(async (settingsPath) => {
    for (const contents of ["{broken", JSON.stringify({ openShortcut: "ctrl+not-a-key" })]) {
      await writeFile(settingsPath, contents);
      const invalid = await loadFileContextSettings(settingsPath);
      assert.deepEqual(invalid.settings, DEFAULT_FILE_CONTEXT_SETTINGS);
      assert.ok(invalid.invalidReason);
      assert.ok(invalid.warning);
      await assert.rejects(updateFileContextSettings("ctrl+y", { settingsPath }), /settings are invalid/i);
      assert.equal(await readFile(settingsPath, "utf8"), contents);
    }
  });
});

test("explicit saves create a private file and preserve unknown fields", async () => {
  await withTempSettings(async (settingsPath) => {
    await updateFileContextSettings("ctrl+y", { settingsPath });
    assert.deepEqual(JSON.parse(await readFile(settingsPath, "utf8")), {
      openShortcut: "ctrl+y",
    });
    assert.equal((await lstat(settingsPath)).mode & 0o777, 0o600);

    await writeFile(settingsPath, JSON.stringify({ openShortcut: "f8", future: { enabled: true } }));
    await updateFileContextSettings(null, { settingsPath });
    assert.deepEqual(JSON.parse(await readFile(settingsPath, "utf8")), {
      openShortcut: null,
      future: { enabled: true },
    });
  });
});

test("failed atomic publication keeps the previous file and does not poison later saves", async () => {
  await withTempSettings(async (settingsPath, directory) => {
    const original = '{"openShortcut":"f8","future":true}\n';
    await writeFile(settingsPath, original);
    await assert.rejects(
      updateFileContextSettings("ctrl+y", {
        settingsPath,
        beforeRename: async () => {
          throw new Error("rename blocked");
        },
      }),
      /rename blocked/,
    );
    assert.equal(await readFile(settingsPath, "utf8"), original);
    assert.deepEqual((await readdir(directory)).sort(), ["pi-file-context.json"]);

    const controller = new AbortController();
    await assert.rejects(
      updateFileContextSettings("ctrl+y", {
        settingsPath,
        signal: controller.signal,
        beforeRename: async () => controller.abort(),
      }),
      (error: unknown) => error instanceof Error && error.name === "AbortError",
    );
    assert.equal(await readFile(settingsPath, "utf8"), original);
    assert.deepEqual((await readdir(directory)).sort(), ["pi-file-context.json"]);

    await updateFileContextSettings("ctrl+z", { settingsPath });
    assert.equal((await loadFileContextSettings(settingsPath)).settings.openShortcut, "ctrl+z");
  });
});

test("reads wait for serialized writes and observe the latest requested value", async () => {
  await withTempSettings(async (settingsPath) => {
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = updateFileContextSettings("ctrl+a", {
      settingsPath,
      beforeRename: async () => {
        markStarted();
        await gate;
      },
    });
    await started;
    const second = updateFileContextSettings("ctrl+b", { settingsPath });
    const coordinatedRead = loadFileContextSettings(settingsPath);
    release();
    await Promise.all([first, second]);
    assert.equal((await coordinatedRead).settings.openShortcut, "ctrl+b");
  });
});

test("symbolic-link settings are invalid and never overwrite their target", async () => {
  await withTempSettings(async (settingsPath, directory) => {
    const target = join(directory, "target.json");
    const original = '{"openShortcut":"f8"}\n';
    await writeFile(target, original);
    await symlink(target, settingsPath);
    const loaded = await loadFileContextSettings(settingsPath);
    assert.ok(loaded.invalidReason);
    await assert.rejects(updateFileContextSettings("ctrl+y", { settingsPath }), /invalid/i);
    assert.equal(await readFile(target, "utf8"), original);
  });
});
