import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "vitest";
import { createSettingsWriter, loadSettings, parseSymbols, saveSymbols, saveWidgetEnabled } from "../src/settings.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })));
});

async function temporaryPath(): Promise<{
  directory: string;
  agentDirectory: string;
  path: string;
}> {
  const directory = await mkdtemp(join(tmpdir(), "pi-stock-ticker-"));
  temporaryDirectories.push(directory);
  const agentDirectory = join(directory, "agent");
  return {
    directory,
    agentDirectory,
    path: join(agentDirectory, "pi-ticker.json"),
  };
}

test("uses an empty list without creating a missing user settings path", async () => {
  const fixture = await temporaryPath();
  const loaded = await loadSettings(fixture.path);
  assert.deepEqual(loaded, { settings: { symbols: [], widgetEnabled: true } });
  await assert.rejects(stat(fixture.agentDirectory), { code: "ENOENT" });
});

test("normalizes, deduplicates, and validates symbols", () => {
  assert.deepEqual(parseSymbols(["nvda, aapl", "NVDA", "BRK-B"]), ["NVDA", "AAPL", "BRK-B"]);
  assert.throws(() => parseSymbols(["NVDA!"]), /Invalid stock symbol/);
  assert.throws(() => parseSymbols([]), /at least one/);
});

test("loads the persisted widget state and defaults an omitted state to enabled", async () => {
  const fixture = await temporaryPath();
  await mkdir(fixture.agentDirectory, { recursive: true });
  await writeFile(fixture.path, '{"symbols":["NVDA"],"widgetEnabled":false}\n');
  assert.deepEqual((await loadSettings(fixture.path)).settings, {
    symbols: ["NVDA"],
    widgetEnabled: false,
  });

  await writeFile(fixture.path, '{"symbols":["NVDA"]}\n');
  assert.equal((await loadSettings(fixture.path)).settings.widgetEnabled, true);
});

test("persists an explicitly empty ticker list", async () => {
  const fixture = await temporaryPath();
  await saveSymbols(fixture.path, []);
  assert.deepEqual(JSON.parse(await readFile(fixture.path, "utf8")), { symbols: [] });
});

test("preserves unknown fields during an atomic save", async () => {
  const fixture = await temporaryPath();
  await mkdir(fixture.agentDirectory, { recursive: true });
  await writeFile(
    fixture.path,
    JSON.stringify({
      symbols: ["MSFT"],
      widgetEnabled: false,
      futureOption: { enabled: true },
    }),
  );

  await saveSymbols(fixture.path, ["AAPL", "VOO"]);
  assert.deepEqual(JSON.parse(await readFile(fixture.path, "utf8")), {
    symbols: ["AAPL", "VOO"],
    widgetEnabled: false,
    futureOption: { enabled: true },
  });
});

test("persists widget state while preserving symbols and unknown fields", async () => {
  const fixture = await temporaryPath();
  await mkdir(fixture.agentDirectory, { recursive: true });
  await writeFile(fixture.path, JSON.stringify({ symbols: ["MSFT"], futureOption: { enabled: true } }));

  await saveWidgetEnabled(fixture.path, false);
  assert.deepEqual(JSON.parse(await readFile(fixture.path, "utf8")), {
    symbols: ["MSFT"],
    widgetEnabled: false,
    futureOption: { enabled: true },
  });
});

test("rejects invalid widget state without overwriting the settings file", async () => {
  const fixture = await temporaryPath();
  await mkdir(fixture.agentDirectory, { recursive: true });
  const invalid = '{"symbols":["NVDA"],"widgetEnabled":"yes"}\n';
  await writeFile(fixture.path, invalid);

  const loaded = await loadSettings(fixture.path);
  assert.equal(loaded.settings.widgetEnabled, true);
  assert.match(loaded.warning ?? "", /must be a boolean/);
  await assert.rejects(saveSymbols(fixture.path, ["AAPL"]), /must be a boolean/);
  assert.equal(await readFile(fixture.path, "utf8"), invalid);
});

test("does not overwrite malformed settings and keeps queued writes usable", async () => {
  const fixture = await temporaryPath();
  await mkdir(fixture.agentDirectory, { recursive: true });
  await writeFile(fixture.path, "{not json\n");
  await assert.rejects(saveSymbols(fixture.path, ["AAPL"]), /valid JSON/);
  assert.equal(await readFile(fixture.path, "utf8"), "{not json\n");

  await writeFile(fixture.path, "{}\n");
  const writer = createSettingsWriter();
  await Promise.all([
    writer.save(fixture.path, ["NET"]),
    writer.saveWidgetEnabled(fixture.path, false),
    writer.save(fixture.path, ["QQQ"]),
  ]);
  await writer.flush();
  assert.deepEqual(JSON.parse(await readFile(fixture.path, "utf8")), {
    symbols: ["QQQ"],
    widgetEnabled: false,
  });
});
