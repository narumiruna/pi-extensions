import assert from "node:assert/strict";
import { lstat, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import { HERDR_SETTINGS_FILE, readHerdrSettings, updateHerdrSettings } from "../src/settings.js";

async function withSettings(run: (path: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "pi-herdr-settings-"));
  try {
    await run(join(root, "nested", HERDR_SETTINGS_FILE));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("missing settings are side-effect free and default the widget to on", async () => {
  await withSettings(async (path) => {
    assert.deepEqual(await readHerdrSettings(path), {
      kind: "missing",
      settings: { widget: true },
    });
    await assert.rejects(lstat(path), { code: "ENOENT" });
  });
});

test("loads explicit booleans and treats an absent field as on", async () => {
  await withSettings(async (path) => {
    await updateHerdrSettings({ widget: true }, { settingsPath: path });
    assert.deepEqual(await readHerdrSettings(path), {
      kind: "loaded",
      settings: { widget: true },
    });
    await writeFile(path, JSON.stringify({ future: { keep: true } }), "utf8");
    assert.deepEqual(await readHerdrSettings(path), {
      kind: "loaded",
      settings: { widget: true },
    });
  });
});

test("ordered atomic saves preserve unknown fields", async () => {
  await withSettings(async (path) => {
    await updateHerdrSettings({ widget: false }, { settingsPath: path });
    await writeFile(path, JSON.stringify({ widget: false, future: { keep: true } }), "utf8");
    const first = updateHerdrSettings({ widget: true }, { settingsPath: path });
    const second = updateHerdrSettings({ widget: false }, { settingsPath: path });
    await Promise.all([first, second]);
    const document = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
    assert.equal(document.widget, false);
    assert.deepEqual(document.future, { keep: true });
    if (process.platform !== "win32") assert.equal((await lstat(path)).mode & 0o777, 0o600);
  });
});

test("reads wait for earlier writes to publish the latest snapshot", async () => {
  await withSettings(async (path) => {
    await updateHerdrSettings({ widget: false }, { settingsPath: path });
    let releaseRename!: () => void;
    const renameGate = new Promise<void>((resolve) => {
      releaseRename = resolve;
    });
    const update = updateHerdrSettings({ widget: true }, { settingsPath: path, beforeRename: async () => renameGate });
    const read = readHerdrSettings(path);
    releaseRename();
    await update;
    assert.equal((await read).settings.widget, true);
  });
});

test("malformed and invalid files stay untouched and block saves", async () => {
  await withSettings(async (path) => {
    await updateHerdrSettings({ widget: false }, { settingsPath: path });
    for (const contents of ["{broken", '{"widget":"yes"}']) {
      await writeFile(path, contents, "utf8");
      const loaded = await readHerdrSettings(path);
      assert.equal(loaded.kind, "invalid");
      assert.equal(loaded.settings.widget, true);
      await assert.rejects(updateHerdrSettings({ widget: true }, { settingsPath: path }), /invalid/u);
      assert.equal(await readFile(path, "utf8"), contents);
    }
  });
});

test("publication failure preserves the previous valid document and queue recovery", async () => {
  await withSettings(async (path) => {
    await updateHerdrSettings({ widget: false }, { settingsPath: path });
    const before = await readFile(path, "utf8");
    await assert.rejects(
      updateHerdrSettings(
        { widget: true },
        {
          settingsPath: path,
          beforeRename: async () => Promise.reject(new Error("injected stop")),
        },
      ),
      /injected stop/u,
    );
    assert.equal(await readFile(path, "utf8"), before);
    await updateHerdrSettings({ widget: true }, { settingsPath: path });
    assert.equal((await readHerdrSettings(path)).settings.widget, true);
  });
});
