import assert from "node:assert/strict";
import { lstat, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import { readToolSettings, TOOL_SETTINGS_FILE, updateToolSettings } from "../src/settings.js";

async function withSettings(run: (path: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "pi-tool-settings-"));
  try {
    await run(join(root, "nested", TOOL_SETTINGS_FILE));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("missing settings are side-effect free and default the widget to off", async () => {
  await withSettings(async (path) => {
    assert.deepEqual(await readToolSettings(path), {
      kind: "missing",
      settings: { activeToolStatus: false },
    });
    await assert.rejects(lstat(path), { code: "ENOENT" });
  });
});

test("loads explicit booleans and treats an absent field as off", async () => {
  await withSettings(async (path) => {
    await updateToolSettings({ activeToolStatus: true }, { settingsPath: path });
    assert.deepEqual(await readToolSettings(path), {
      kind: "loaded",
      settings: { activeToolStatus: true },
    });
    await writeFile(path, JSON.stringify({ future: { keep: true } }), "utf8");
    assert.deepEqual(await readToolSettings(path), {
      kind: "loaded",
      settings: { activeToolStatus: false },
    });
  });
});

test("ordered atomic saves preserve unknown fields", async () => {
  await withSettings(async (path) => {
    await updateToolSettings({ activeToolStatus: false }, { settingsPath: path });
    await writeFile(path, JSON.stringify({ activeToolStatus: false, future: { keep: true } }), "utf8");
    const first = updateToolSettings({ activeToolStatus: true }, { settingsPath: path });
    const second = updateToolSettings({ activeToolStatus: false }, { settingsPath: path });
    await Promise.all([first, second]);
    const document = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
    assert.equal(document.activeToolStatus, false);
    assert.deepEqual(document.future, { keep: true });
    if (process.platform !== "win32") assert.equal((await lstat(path)).mode & 0o777, 0o600);
  });
});

test("reads wait for earlier writes to publish the latest snapshot", async () => {
  await withSettings(async (path) => {
    await updateToolSettings({ activeToolStatus: false }, { settingsPath: path });
    let releaseRename!: () => void;
    const renameGate = new Promise<void>((resolve) => {
      releaseRename = resolve;
    });
    const update = updateToolSettings(
      { activeToolStatus: true },
      { settingsPath: path, beforeRename: async () => renameGate },
    );
    const read = readToolSettings(path);
    releaseRename();
    await update;
    assert.equal((await read).settings.activeToolStatus, true);
  });
});

test("malformed and invalid files stay untouched and block saves", async () => {
  await withSettings(async (path) => {
    await updateToolSettings({ activeToolStatus: false }, { settingsPath: path });
    for (const contents of ["{broken", '{"activeToolStatus":"yes"}']) {
      await writeFile(path, contents, "utf8");
      const loaded = await readToolSettings(path);
      assert.equal(loaded.kind, "invalid");
      assert.equal(loaded.settings.activeToolStatus, false);
      await assert.rejects(updateToolSettings({ activeToolStatus: true }, { settingsPath: path }), /invalid/u);
      assert.equal(await readFile(path, "utf8"), contents);
    }
  });
});

test("publication failure preserves the previous valid document and queue recovery", async () => {
  await withSettings(async (path) => {
    await updateToolSettings({ activeToolStatus: false }, { settingsPath: path });
    const before = await readFile(path, "utf8");
    await assert.rejects(
      updateToolSettings(
        { activeToolStatus: true },
        {
          settingsPath: path,
          beforeRename: async () => Promise.reject(new Error("injected stop")),
        },
      ),
      /injected stop/u,
    );
    assert.equal(await readFile(path, "utf8"), before);
    await updateToolSettings({ activeToolStatus: true }, { settingsPath: path });
    assert.equal((await readToolSettings(path)).settings.activeToolStatus, true);
  });
});
