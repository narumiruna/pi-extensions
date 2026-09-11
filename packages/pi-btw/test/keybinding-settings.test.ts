import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import { normalizeBtwSettings, readBtwSettings, updateBtwSettings } from "../src/settings.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function withSettings(run: (path: string) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), "btw-keybindings-"));
  try {
    await run(join(directory, "pi-btw.json"));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test.each([
  null,
  [],
  "ctrl+q",
  { exit: [] },
  { exit: null },
  { exit: "meta+q" },
  { cycleThinkingLevel: "ctrl+f1" },
  { bringToMain: "\u001b" },
])("invalid keybindings protect the file from writes: %j", async (keybindings) => {
  assert.equal(normalizeBtwSettings({ keybindings }), undefined);
  await withSettings(async (path) => {
    const original = JSON.stringify({ keybindings, future: true });
    await writeFile(path, original);
    assert.equal((await readBtwSettings(path)).kind, "invalid");
    await assert.rejects(updateBtwSettings({ keybindings: { exit: "ctrl+q" } }, { settingsPath: path }), /invalid/);
    assert.equal(await readFile(path, "utf8"), original);
  });
});

test("keybinding writes normalize reads, preserve nested unknowns and reset only owned fields", async () => {
  await withSettings(async (path) => {
    assert.deepEqual(await readBtwSettings(path), { kind: "missing" });
    await assert.rejects(readFile(path), { code: "ENOENT" });
    await updateBtwSettings({ keybindings: { exit: "CTRL+Q", cycleThinkingLevel: "f6" } }, { settingsPath: path });
    assert.deepEqual(await readBtwSettings(path), {
      kind: "loaded",
      settings: { keybindings: { exit: "ctrl+q", cycleThinkingLevel: "f6" } },
    });
    await writeFile(
      path,
      JSON.stringify({
        future: { keep: true },
        thinkingLevel: "low",
        keybindings: { exit: "ctrl+q", cycleThinkingLevel: "f6", future: { keep: true } },
      }),
    );
    await updateBtwSettings({ keybindings: { exit: undefined, bringToMain: "f7" } }, { settingsPath: path });
    const saved = JSON.parse(await readFile(path, "utf8"));
    assert.deepEqual(saved, {
      future: { keep: true },
      thinkingLevel: "low",
      keybindings: { cycleThinkingLevel: "f6", bringToMain: "f7", future: { keep: true } },
    });
    await updateBtwSettings(
      { keybindings: { cycleThinkingLevel: undefined, bringToMain: undefined } },
      { settingsPath: path },
    );
    assert.deepEqual(JSON.parse(await readFile(path, "utf8")).keybindings, {
      future: { keep: true },
    });
  });
});

test("reset removes an empty override object without materializing default keys", async () => {
  await withSettings(async (path) => {
    await updateBtwSettings({ keybindings: { exit: "f6" } }, { settingsPath: path });
    await updateBtwSettings({ keybindings: { exit: undefined } }, { settingsPath: path });
    assert.deepEqual(JSON.parse(await readFile(path, "utf8")), {});
  });
});

test("queued key edits and resets merge against latest data, coordinate reads, and recover after failure", async () => {
  await withSettings(async (path) => {
    const reached = deferred();
    const release = deferred();
    const first = updateBtwSettings(
      { keybindings: { exit: "f6" } },
      {
        settingsPath: path,
        beforeRename: async () => {
          reached.resolve();
          await release.promise;
        },
      },
    );
    await reached.promise;
    const second = updateBtwSettings({ keybindings: { bringToMain: "f7" } }, { settingsPath: path });
    const reset = updateBtwSettings({ keybindings: { exit: undefined } }, { settingsPath: path });
    const reading = readBtwSettings(path);
    release.resolve();
    await Promise.all([first, second, reset]);
    assert.deepEqual(await reading, {
      kind: "loaded",
      settings: { keybindings: { bringToMain: "f7" } },
    });
    const original = await readFile(path, "utf8");
    await assert.rejects(
      updateBtwSettings(
        { keybindings: { exit: "f8" } },
        {
          settingsPath: path,
          beforeRename: async () => {
            throw new Error("disk failed");
          },
        },
      ),
      /disk failed/,
    );
    assert.equal(await readFile(path, "utf8"), original);
    await updateBtwSettings({ keybindings: { exit: "f9" } }, { settingsPath: path });
    assert.deepEqual(JSON.parse(await readFile(path, "utf8")).keybindings, {
      exit: "f9",
      bringToMain: "f7",
    });
    assert.deepEqual(await readdir(join(path, "..")), ["pi-btw.json"]);
  });
});
