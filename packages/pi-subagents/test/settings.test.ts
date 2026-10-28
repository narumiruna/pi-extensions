import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { getAgentDir, withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, test, vi } from "vitest";
import {
  DEFAULT_SUBAGENT_SETTINGS,
  type SubagentSettings,
  SubagentSettingsStore,
  subagentSettingsPath,
} from "../src/settings.js";

const keys = ["showWidget", "showJobId", "showTools", "showTiming"] as const;
const signal = () => new AbortController().signal;
let directory: string;
let path: string;
let store: SubagentSettingsStore;

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function writeDocument(document: unknown) {
  await fs.mkdir(dirname(path), { recursive: true });
  await fs.writeFile(path, JSON.stringify(document));
}

async function diskDocument() {
  return JSON.parse(await fs.readFile(path, "utf8")) as Record<string, unknown>;
}

beforeEach(async () => {
  directory = await fs.mkdtemp(join(tmpdir(), "pi-subagents-settings-"));
  path = join(directory, "agent", "pi-subagents.json");
  store = new SubagentSettingsStore(path);
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await store.flush();
  await fs.rm(directory, { recursive: true, force: true });
});

test("settings path uses Pi's user agent directory", () => {
  vi.stubEnv("PI_CODING_AGENT_DIR", join(directory, "custom-agent"));
  assert.equal(subagentSettingsPath(), join(getAgentDir(), "pi-subagents.json"));
  assert.equal(subagentSettingsPath(), join(directory, "custom-agent", "pi-subagents.json"));
});

test("defaults and missing loads do not create files or directories", async () => {
  assert.deepEqual(DEFAULT_SUBAGENT_SETTINGS, {
    showWidget: true,
    showJobId: false,
    showTools: false,
    showTiming: true,
  });
  assert.deepEqual(store.settings, DEFAULT_SUBAGENT_SETTINGS);
  assert.deepEqual(await store.load(), { settings: DEFAULT_SUBAGENT_SETTINGS, diagnostics: [] });
  await store.flush();
  assert.deepEqual(await fs.readdir(directory), []);
  const snapshot = store.settings;
  snapshot.showWidget = false;
  assert.equal(store.settings.showWidget, true);
});

test("reads only the user document and ignores project settings", async () => {
  await fs.mkdir(join(directory, "project", ".pi"), { recursive: true });
  await fs.writeFile(join(directory, "project", ".pi", "pi-subagents.json"), '{"showWidget":false}');
  const reads = vi.spyOn(fs, "readFile");
  assert.deepEqual(await store.load(), { settings: DEFAULT_SUBAGENT_SETTINGS, diagnostics: [] });
  assert.deepEqual(reads.mock.calls, [[path, "utf8"]]);
  assert.deepEqual(await fs.readdir(directory), ["project"]);
});

test("first explicit save creates only the requested override and reloads it", async () => {
  const saved = await store.save("showWidget", false, signal());
  assert.deepEqual(saved, { ...DEFAULT_SUBAGENT_SETTINGS, showWidget: false });
  assert.deepEqual(store.settings, saved);
  assert.deepEqual(await diskDocument(), { showWidget: false });
  assert.deepEqual(await fs.readdir(dirname(path)), ["pi-subagents.json"]);
  const reloaded = new SubagentSettingsStore(path);
  assert.deepEqual(await reloaded.load(), { settings: saved, diagnostics: [] });
});

test.each(keys)("loads and saves both boolean values for %s", async (key) => {
  for (const value of [false, true]) {
    await writeDocument({ [key]: value });
    const expected = { ...DEFAULT_SUBAGENT_SETTINGS, [key]: value };
    assert.deepEqual(await store.load(), { settings: expected, diagnostics: [] });
    assert.deepEqual(await store.save(key, !value, signal()), { ...expected, [key]: !value });
    assert.deepEqual(await diskDocument(), { [key]: !value });
  }
});

test.each(keys)("ignores invalid %s values individually and reports diagnostics", async (key) => {
  const otherKey = key === "showTiming" ? "showTools" : "showTiming";
  const otherValue = !DEFAULT_SUBAGENT_SETTINGS[otherKey];
  for (const value of [null, 0, 1, "true", "false", [], {}]) {
    await writeDocument({ [key]: value, [otherKey]: otherValue });
    const loaded = await store.load();
    assert.deepEqual(loaded.settings, { ...DEFAULT_SUBAGENT_SETTINGS, [otherKey]: otherValue });
    assert.equal(loaded.diagnostics.length, 1);
    assert.match(loaded.diagnostics[0] ?? "", new RegExp(`${key}.*boolean`, "u"));
    assert.deepEqual(await diskDocument(), { [key]: value, [otherKey]: otherValue });
  }
});

test("reports all invalid fields, not only the first one", async () => {
  await writeDocument(Object.fromEntries(keys.map((key) => [key, "false"])));
  const loaded = await store.load();
  assert.deepEqual(loaded.settings, DEFAULT_SUBAGENT_SETTINGS);
  assert.equal(loaded.diagnostics.length, keys.length);
  for (const key of keys) assert.ok(loaded.diagnostics.some((diagnostic) => diagnostic.includes(key)));
});

test.each(["{bad", "[]", "null", '"text"', "42", "true", ""])(
  "malformed or non-object documents report diagnostics and block saves: %j",
  async (text) => {
    await store.save("showWidget", false, signal());
    const previous = store.settings;
    await fs.writeFile(path, text);
    await assert.rejects(store.save("showTools", true, signal()), /Cannot save/u);
    assert.deepEqual(store.settings, previous);
    assert.equal(await fs.readFile(path, "utf8"), text);
    const loaded = await store.load();
    assert.deepEqual(loaded.settings, DEFAULT_SUBAGENT_SETTINGS);
    assert.equal(loaded.diagnostics.length, 1);
    assert.match(loaded.diagnostics[0] ?? "", /invalid JSON|JSON object/u);
    assert.deepEqual(await fs.readdir(dirname(path)), ["pi-subagents.json"]);
  },
);

test("read errors are returned as diagnostics and block writes without replacing runtime settings", async () => {
  await store.save("showTools", true, signal());
  const before = await fs.readFile(path, "utf8");
  const previous = store.settings;
  const error = Object.assign(new Error("read denied"), { code: "EACCES" });
  const reads = vi.spyOn(fs, "readFile").mockRejectedValue(error);
  await assert.rejects(store.save("showWidget", false, signal()), /read denied/u);
  assert.deepEqual(store.settings, previous);
  const loaded = await store.load();
  assert.deepEqual(loaded.settings, DEFAULT_SUBAGENT_SETTINGS);
  assert.match(loaded.diagnostics[0] ?? "", /read denied/u);
  reads.mockRestore();
  assert.equal(await fs.readFile(path, "utf8"), before);
  await store.save("showTiming", false, signal());
  assert.deepEqual(await diskDocument(), { showTools: true, showTiming: false });
});

test("saves patch only one key in the latest document and preserve unknown and invalid fields", async () => {
  await writeDocument({ showWidget: false, future: { nested: [1, true, null] } });
  await store.load();
  const latest = JSON.parse(
    '{"showWidget":true,"showTools":"invalid","future":{"nested":[2,false]},"__proto__":{"keep":true}}',
  ) as Record<string, unknown>;
  await writeDocument(latest);
  assert.deepEqual(await store.save("showJobId", true, signal()), {
    ...DEFAULT_SUBAGENT_SETTINGS,
    showJobId: true,
  });
  assert.deepEqual(await diskDocument(), { ...latest, showJobId: true });
  await store.save("showTools", true, signal());
  assert.deepEqual(await diskDocument(), { ...latest, showJobId: true, showTools: true });
});

test("serializes requested changes and reads in the same store", async () => {
  const first = store.save("showWidget", false, signal());
  const second = store.save("showTools", true, signal());
  const reading = store.load();
  const third = store.save("showWidget", true, signal());
  assert.equal((await first).showWidget, false);
  assert.equal((await second).showTools, true);
  assert.deepEqual((await reading).settings, {
    ...DEFAULT_SUBAGENT_SETTINGS,
    showWidget: false,
    showTools: true,
  });
  assert.deepEqual(await third, { ...DEFAULT_SUBAGENT_SETTINGS, showTools: true });
  await store.flush();
  assert.deepEqual(await diskDocument(), { showWidget: true, showTools: true });
});

test("orders writes and reads across stores sharing a path", async () => {
  const other = new SubagentSettingsStore(path);
  const first = store.save("showWidget", false, signal());
  const reading = other.load();
  const second = other.save("showTiming", false, signal());
  const finalRead = store.load();
  await first;
  assert.deepEqual((await reading).settings, { ...DEFAULT_SUBAGENT_SETTINGS, showWidget: false });
  await second;
  assert.deepEqual((await finalRead).settings, {
    ...DEFAULT_SUBAGENT_SETTINGS,
    showWidget: false,
    showTiming: false,
  });
  await other.flush();
});

test("coordinates loads and saves with Pi's public file mutation queue", async () => {
  const entered = deferred();
  const release = deferred();
  const writer = withFileMutationQueue(path, async () => {
    entered.resolve();
    await release.promise;
    await writeDocument({ showJobId: true, external: true });
  });
  await entered.promise;
  const reading = store.load();
  const saving = store.save("showTiming", false, signal());
  release.resolve();
  await writer;
  assert.deepEqual((await reading).settings, { ...DEFAULT_SUBAGENT_SETTINGS, showJobId: true });
  assert.deepEqual(await saving, { ...DEFAULT_SUBAGENT_SETTINGS, showJobId: true, showTiming: false });
  assert.deepEqual(await diskDocument(), { showJobId: true, showTiming: false, external: true });
});

test("pre-aborted saves leave missing parent directories absent", async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(store.save("showWidget", false, controller.signal), /abort/iu);
  assert.deepEqual(store.settings, DEFAULT_SUBAGENT_SETTINGS);
  assert.deepEqual(await fs.readdir(directory), []);
  await store.save("showJobId", true, signal());
  assert.equal(store.settings.showJobId, true);
});

test("checks cancellation after waiting for the path queue", async () => {
  const entered = deferred();
  const release = deferred();
  const blocker = withFileMutationQueue(path, async () => {
    entered.resolve();
    await release.promise;
  });
  await entered.promise;
  const controller = new AbortController();
  const saving = store.save("showWidget", false, controller.signal);
  const rejected = assert.rejects(saving, /abort/iu);
  controller.abort();
  release.resolve();
  await blocker;
  await rejected;
  assert.deepEqual(await fs.readdir(directory), []);
});

test("aborted staged writes do not publish and remove temporary files", async () => {
  await store.save("showWidget", false, signal());
  const previous = store.settings;
  const before = await fs.readFile(path, "utf8");
  const controller = new AbortController();
  const writeFile = fs.writeFile;
  vi.spyOn(fs, "writeFile").mockImplementationOnce(async (...args) => {
    await writeFile(...args);
    controller.abort();
  });
  await assert.rejects(store.save("showTools", true, controller.signal), /abort/iu);
  assert.deepEqual(store.settings, previous);
  assert.equal(await fs.readFile(path, "utf8"), before);
  assert.deepEqual(await fs.readdir(dirname(path)), ["pi-subagents.json"]);
  await store.save("showTools", true, signal());
  assert.equal(store.settings.showTools, true);
});

test("rename failure preserves disk and runtime, cleans staging, and does not poison queued operations", async () => {
  await store.save("showWidget", false, signal());
  const previous = store.settings;
  const before = await fs.readFile(path, "utf8");
  vi.spyOn(fs, "rename").mockRejectedValueOnce(new Error("rename failed"));
  const failed = assert.rejects(store.save("showTools", true, signal()), /rename failed/u);
  const reading = store.load();
  await failed;
  assert.deepEqual(store.settings, previous);
  assert.deepEqual((await reading).settings, previous);
  assert.equal(await fs.readFile(path, "utf8"), before);
  assert.deepEqual(await fs.readdir(dirname(path)), ["pi-subagents.json"]);
  await store.save("showTiming", false, signal());
  await store.flush();
  assert.deepEqual(store.settings, { ...previous, showTiming: false });
  assert.deepEqual(await diskDocument(), { showWidget: false, showTiming: false });
});

test("write failure cleans staging and permits the next queued save", async () => {
  await store.save("showWidget", false, signal());
  const previous = store.settings;
  const before = await fs.readFile(path, "utf8");
  vi.spyOn(fs, "writeFile").mockRejectedValueOnce(new Error("write failed"));
  const failed = assert.rejects(store.save("showWidget", true, signal()), /write failed/u);
  const next = store.save("showTools", true, signal());
  await failed;
  await next;
  assert.deepEqual(store.settings, { ...previous, showTools: true });
  assert.notEqual(await fs.readFile(path, "utf8"), before);
  assert.deepEqual(await diskDocument(), { showWidget: false, showTools: true });
  assert.deepEqual(await fs.readdir(dirname(path)), ["pi-subagents.json"]);
});

test("settings publish only after rename and flush waits for pending writes", async () => {
  const entered = deferred();
  const release = deferred();
  const rename = fs.rename;
  vi.spyOn(fs, "rename").mockImplementationOnce(async (...args) => {
    entered.resolve();
    await release.promise;
    await rename(...args);
  });
  const saving = store.save("showWidget", false, signal());
  await entered.promise;
  const previous = store.settings;
  let flushed = false;
  const flushing = store.flush().then(() => {
    flushed = true;
  });
  const unchanged = previous.showWidget;
  await Promise.resolve();
  const pending = !flushed;
  release.resolve();
  await saving;
  await flushing;
  assert.equal(unchanged, true);
  assert.equal(pending, true);
  assert.equal(store.settings.showWidget, false);
  assert.equal(flushed, true);
});

test("cancellation and cleanup failure after commit do not report a successful save as failed", async () => {
  const controller = new AbortController();
  const rename = fs.rename;
  vi.spyOn(fs, "rename").mockImplementationOnce(async (...args) => {
    await rename(...args);
    controller.abort();
  });
  const remove = fs.rm;
  vi.spyOn(fs, "rm").mockImplementationOnce(async (...args) => {
    await remove(...args);
    throw new Error("cleanup failed after removal");
  });
  const saved = await store.save("showWidget", false, controller.signal);
  assert.deepEqual(saved, { ...DEFAULT_SUBAGENT_SETTINGS, showWidget: false });
  assert.deepEqual(store.settings, saved);
  assert.deepEqual(await diskDocument(), { showWidget: false });
  assert.deepEqual(await fs.readdir(dirname(path)), ["pi-subagents.json"]);
});

test("invalid runtime updates fail without disk or runtime changes and the queue recovers", async () => {
  await assert.rejects(store.save("unknown" as keyof SubagentSettings, false, signal()), /Invalid/u);
  await assert.rejects(store.save("showWidget", "false" as unknown as boolean, signal()), /Invalid/u);
  assert.deepEqual(store.settings, DEFAULT_SUBAGENT_SETTINGS);
  assert.deepEqual(await fs.readdir(directory), []);
  await store.save("showWidget", false, signal());
  assert.equal(store.settings.showWidget, false);
});
