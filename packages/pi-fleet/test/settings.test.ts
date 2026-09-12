import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { rename, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { type TestContext, test } from "vitest";
import {
  createFleetSettingsRuntime,
  DEFAULT_FLEET_SETTINGS,
  loadFleetSettings,
  normalizeFleetSettingsDocument,
} from "../src/settings.js";

function temporarySettings(t: TestContext) {
  const directory = mkdtempSync(path.join(os.tmpdir(), "pi-fleet-settings-"));
  t.onTestFinished(() => rmSync(directory, { recursive: true, force: true }));
  return { directory, settingsPath: path.join(directory, "agent", "pi-fleet.json") };
}

test("missing settings stay side-effect free until the first explicit save", async (t) => {
  const { directory, settingsPath } = temporarySettings(t);
  const loaded = await loadFleetSettings(settingsPath);
  assert.equal(loaded.kind, "missing");
  assert.deepEqual(loaded.settings, DEFAULT_FLEET_SETTINGS);
  assert.equal(DEFAULT_FLEET_SETTINGS.defaultTerminal, "auto");
  assert.equal(exists(path.join(directory, "agent")), false);

  const runtime = createFleetSettingsRuntime({ path: settingsPath });
  await runtime.reload();
  assert.equal(exists(path.join(directory, "agent")), false);
  await runtime.update({ confirmSessionLaunch: false });
  assert.deepEqual(JSON.parse(readFileSync(settingsPath, "utf8")), {
    confirmSessionLaunch: false,
  });
});

test("normalization accepts partial settings and rejects invalid owned values", () => {
  assert.deepEqual(
    normalizeFleetSettingsDocument({
      defaultTerminal: "ghostty",
      confirmSessionLaunch: false,
      future: { retained: true },
    }),
    {
      settings: { defaultTerminal: "ghostty", confirmSessionLaunch: false },
      sources: { defaultTerminal: "user", confirmSessionLaunch: "user" },
    },
  );
  assert.deepEqual(normalizeFleetSettingsDocument({ defaultTerminal: "zellij" }), {
    settings: { defaultTerminal: "zellij", confirmSessionLaunch: true },
    sources: { defaultTerminal: "user", confirmSessionLaunch: "built-in" },
  });
  assert.deepEqual(normalizeFleetSettingsDocument({ defaultTerminal: "auto" }), {
    settings: { defaultTerminal: "auto", confirmSessionLaunch: true },
    sources: { defaultTerminal: "user", confirmSessionLaunch: "built-in" },
  });
  assert.deepEqual(normalizeFleetSettingsDocument({}), {
    settings: DEFAULT_FLEET_SETTINGS,
    sources: { defaultTerminal: "built-in", confirmSessionLaunch: "built-in" },
  });
  for (const value of [
    null,
    [],
    { defaultTerminal: "unknown" },
    { defaultTerminal: true },
    { confirmSessionLaunch: "yes" },
  ]) {
    assert.equal(normalizeFleetSettingsDocument(value), undefined);
  }
});

test("updates preserve unknown fields and publish private JSON atomically", async (t) => {
  const { settingsPath } = temporarySettings(t);
  mkdirSync(path.dirname(settingsPath), { recursive: true });
  writeFileSync(
    settingsPath,
    `${JSON.stringify({ confirmSessionLaunch: true, future: { retained: true } }, null, 2)}\n`,
  );
  const runtime = createFleetSettingsRuntime({ path: settingsPath });
  await runtime.reload();
  await runtime.update({ defaultTerminal: "ghostty" });
  await runtime.update({ confirmSessionLaunch: false });

  assert.deepEqual(JSON.parse(readFileSync(settingsPath, "utf8")), {
    confirmSessionLaunch: false,
    future: { retained: true },
    defaultTerminal: "ghostty",
  });
  assert.deepEqual(runtime.get().settings, {
    defaultTerminal: "ghostty",
    confirmSessionLaunch: false,
  });
  if (process.platform !== "win32") {
    assert.equal(statSync(settingsPath).mode & 0o777, 0o600);
  }
  assert.deepEqual(listTemporaryFiles(settingsPath), []);
});

test("malformed, invalid, and invalid UTF-8 files remain unchanged and block updates", async (t) => {
  for (const contents of [
    Buffer.from("{bad json\n"),
    Buffer.from('{"defaultTerminal":"unknown"}\n'),
    Buffer.from([0x7b, 0x22, 0x78, 0x22, 0x3a, 0x22, 0xff, 0x22, 0x7d]),
  ]) {
    const { settingsPath } = temporarySettings(t);
    mkdirSync(path.dirname(settingsPath), { recursive: true });
    writeFileSync(settingsPath, contents);
    const runtime = createFleetSettingsRuntime({ path: settingsPath });
    const state = await runtime.reload();
    assert.ok(state.issue);
    await assert.rejects(runtime.update({ defaultTerminal: "ghostty" }), /invalid|malformed|UTF-8/u);
    assert.deepEqual(readFileSync(settingsPath), contents);
    assert.deepEqual(runtime.get().settings, DEFAULT_FLEET_SETTINGS);
  }
});

test("publication failure retains effective state, cleans temporary files, and queue recovers", async (t) => {
  const { settingsPath } = temporarySettings(t);
  let rejectRename = true;
  const runtime = createFleetSettingsRuntime({
    path: settingsPath,
    operations: {
      rename: async (source: Parameters<typeof rename>[0], destination: Parameters<typeof rename>[1]) => {
        if (rejectRename) throw new Error("rename rejected");
        await rename(source, destination);
      },
    },
  });
  await runtime.reload();
  await assert.rejects(runtime.update({ defaultTerminal: "ghostty" }), /rename rejected/u);
  assert.deepEqual(runtime.get().settings, DEFAULT_FLEET_SETTINGS);
  assert.deepEqual(listTemporaryFiles(settingsPath), []);

  rejectRename = false;
  await runtime.update({ defaultTerminal: "ghostty" });
  assert.equal(runtime.get().settings.defaultTerminal, "ghostty");
});

test("concurrent updates serialize in call order and reload waits for pending publication", async (t) => {
  const { settingsPath } = temporarySettings(t);
  let releaseFirst!: () => void;
  const firstWrite = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  let writes = 0;
  const runtime = createFleetSettingsRuntime({
    path: settingsPath,
    operations: {
      writeFile: async (
        file: Parameters<typeof writeFile>[0],
        data: Parameters<typeof writeFile>[1],
        options: Parameters<typeof writeFile>[2],
      ) => {
        writes += 1;
        if (writes === 1) await firstWrite;
        await writeFile(file, data, options);
      },
    },
  });
  await runtime.reload();
  const first = runtime.update({ defaultTerminal: "ghostty" });
  const second = runtime.update({ confirmSessionLaunch: false });
  const reload = runtime.reload();
  await Promise.resolve();
  assert.deepEqual(runtime.get().settings, DEFAULT_FLEET_SETTINGS);
  releaseFirst();
  await Promise.all([first, second, reload, runtime.flush()]);
  assert.deepEqual(runtime.get().settings, {
    defaultTerminal: "ghostty",
    confirmSessionLaunch: false,
  });
});

function exists(target: string) {
  try {
    statSync(target);
    return true;
  } catch {
    return false;
  }
}

function listTemporaryFiles(settingsPath: string) {
  try {
    return readdirSync(path.dirname(settingsPath)).filter((name) => name.endsWith(".tmp"));
  } catch {
    return [];
  }
}
