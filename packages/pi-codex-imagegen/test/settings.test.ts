import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { defaultSettings, type ImagegenSettings, SettingsStore } from "../src/settings.js";

let directory: string;
let agentDir: string;
let store: SettingsStore;

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function seed(bytes: string) {
  await fs.mkdir(agentDir, { recursive: true });
  await fs.writeFile(store.path, bytes);
}

async function document() {
  return JSON.parse(await fs.readFile(store.path, "utf8"));
}

beforeEach(async () => {
  directory = await fs.mkdtemp(join(tmpdir(), "pi-codex-imagegen-settings-"));
  agentDir = join(directory, "custom-agent");
  store = new SettingsStore(agentDir);
});

afterEach(async () => {
  await store.flush();
  vi.restoreAllMocks();
  await fs.rm(directory, { recursive: true, force: true });
});

it("uses the supplied agent directory and loads missing defaults without filesystem changes", async () => {
  const expected = {
    toolEnabled: true,
    transparentBackground: false,
  };
  expect(defaultSettings()).toEqual(expected);
  expect(store.path).toBe(join(agentDir, "pi-codex-imagegen.json"));
  expect(store.settings).toEqual(expected);
  expect(await fs.readdir(directory)).toEqual([]);
  expect(await store.load()).toEqual({ settings: expected });
  expect(await fs.readdir(directory)).toEqual([]);
  const copy = store.settings;
  copy.toolEnabled = false;
  expect(store.settings.toolEnabled).toBe(true);
});

it.each([
  { overrides: {}, enabled: true },
  { overrides: { transparentBackground: true }, enabled: true },
  { overrides: { toolEnabled: false }, enabled: false },
  { overrides: { toolEnabled: true }, enabled: true },
])("applies defaults only to omitted settings: $overrides", async ({ overrides, enabled }) => {
  const bytes = JSON.stringify(overrides);
  await seed(bytes);
  expect((await store.load()).settings.toolEnabled).toBe(enabled);
  expect(await fs.readFile(store.path, "utf8")).toBe(bytes);
});

it("creates private settings only on first save and stores only explicit overrides", async () => {
  expect(await store.save({ toolEnabled: false })).toEqual({ ...defaultSettings(), toolEnabled: false });
  expect(await document()).toEqual({ toolEnabled: false });
  expect((await new SettingsStore(agentDir).load()).settings.toolEnabled).toBe(false);
  expect(await fs.readdir(agentDir)).toEqual(["pi-codex-imagegen.json"]);
  if (process.platform !== "win32") {
    expect((await fs.stat(store.path)).mode & 0o777).toBe(0o600);
    expect((await fs.stat(agentDir)).mode & 0o777).toBe(0o700);
  }
  await store.save({ transparentBackground: false });
  expect(await document()).toEqual({ toolEnabled: false, transparentBackground: false });
});

it("reloads manual edits and preserves unknown fields including prototype-like names", async () => {
  const bytes = '{"toolEnabled":false,"future":{"nested":[1,2]},"__proto__":{"keep":true}}';
  await seed(bytes);
  expect((await store.load()).settings.toolEnabled).toBe(false);
  await store.save({ transparentBackground: true });
  expect(await document()).toEqual({
    ...JSON.parse(bytes),
    transparentBackground: true,
  });
  await fs.writeFile(store.path, '{"transparentBackground":true,"future":42}');
  expect((await store.load()).settings).toEqual({ ...defaultSettings(), transparentBackground: true });
  await store.save({ toolEnabled: true });
  expect(await document()).toEqual({ transparentBackground: true, future: 42, toolEnabled: true });
});

it.each([
  "{broken-secret",
  "[]",
  "null",
  '"raw-secret"',
  "42",
  '{"toolEnabled":"raw-secret"}',
  '{"transparentBackground":1}',
])("warns on invalid loads and protects existing invalid bytes: %s", async (bytes) => {
  await seed(bytes);
  const loaded = await store.load();
  expect(loaded.settings).toEqual({ ...defaultSettings(), toolEnabled: false });
  expect(loaded.warning).toMatch(/Repair/);
  expect(loaded.warning).not.toContain("raw-secret");
  await expect(store.save({ toolEnabled: true })).rejects.toThrow("Repair");
  expect(await fs.readFile(store.path, "utf8")).toBe(bytes);
  expect(await fs.readdir(agentDir)).toEqual(["pi-codex-imagegen.json"]);
  await fs.writeFile(store.path, "{}");
  await store.save({ toolEnabled: true });
  expect(store.settings.toolEnabled).toBe(true);
});

it.each([
  { toolEnabled: "raw-secret" },
  { transparentBackground: null },
  { toolEnabled: undefined },
  { unknown: "raw-secret" },
])("rejects invalid patches without writing or leaking values: %j", async (patch) => {
  const task = store.save(patch as Partial<ImagegenSettings>);
  await expect(task).rejects.toThrow("Invalid");
  await expect(task).rejects.not.toThrow("raw-secret");
  expect(await fs.readdir(directory)).toEqual([]);
});

it("captures queued patches and orders saves and reloads across the same path", async () => {
  const other = new SettingsStore(agentDir);
  const entered = deferred();
  const release = deferred();
  const blocker = withFileMutationQueue(store.path, async () => {
    entered.resolve();
    await release.promise;
  });
  await entered.promise;
  const seen: boolean[] = [];
  const patch = { toolEnabled: true };
  const first = store.save(patch, { apply: (next) => seen.push(next.toolEnabled) });
  patch.toolEnabled = false;
  const second = store.save({ transparentBackground: true });
  const third = other.save({ toolEnabled: false }, { apply: (next) => seen.push(next.toolEnabled) });
  const reload = store.load();
  const last = other.save({ transparentBackground: false });
  release.resolve();
  await Promise.all([blocker, first, second, third, last]);
  expect((await reload).settings).toEqual({ toolEnabled: false, transparentBackground: true });
  expect(seen).toEqual([true, false]);
  expect(await document()).toEqual({ toolEnabled: false, transparentBackground: false });
});

it("holds dependent reloads until persistence and runtime application complete", async () => {
  const entered = deferred();
  const release = deferred();
  const rename = fs.rename.bind(fs);
  vi.spyOn(fs, "rename").mockImplementationOnce(async (source, destination) => {
    entered.resolve();
    await release.promise;
    await rename(source, destination);
  });
  let applied = false;
  const write = store.save(
    { toolEnabled: false },
    {
      apply: () => {
        applied = true;
      },
    },
  );
  await entered.promise;
  let reloaded = false;
  const reload = new SettingsStore(agentDir).load().then((result) => {
    reloaded = true;
    expect(applied).toBe(true);
    return result;
  });
  const flush = store.flush();
  expect(reloaded).toBe(false);
  release.resolve();
  await Promise.all([write, flush]);
  expect((await reload).settings.toolEnabled).toBe(false);
});

it("keeps the old runtime and bytes after rename failure and recovers the queue", async () => {
  const bytes = '{ "toolEnabled": false, "future": 7 }\n';
  await seed(bytes);
  await store.load();
  const apply = vi.fn();
  vi.spyOn(fs, "rename").mockRejectedValueOnce(new Error("raw-secret"));
  const failed = store.save({ toolEnabled: true }, { apply });
  const reload = new SettingsStore(agentDir).load();
  await expect(failed).rejects.toThrow("not saved");
  expect(apply).not.toHaveBeenCalled();
  expect(store.settings.toolEnabled).toBe(false);
  expect((await reload).settings.toolEnabled).toBe(false);
  expect(await fs.readFile(store.path, "utf8")).toBe(bytes);
  expect(await fs.readdir(agentDir)).toEqual(["pi-codex-imagegen.json"]);
  await store.save({ transparentBackground: true });
  await store.flush();
  expect(await document()).toEqual({ toolEnabled: false, future: 7, transparentBackground: true });
});

it.each([false, true])("rolls back partially applied runtime and exact prior file (existing: %s)", async (exists) => {
  const bytes = '{ "future": {"retain":true}, "transparentBackground": false }\n';
  if (exists) await seed(bytes);
  await store.load();
  const previous = store.settings;
  let runtime = previous;
  const calls: boolean[] = [];
  const failed = store.save(
    { toolEnabled: false },
    {
      apply: (next, old) => {
        expect(store.settings).toEqual(previous);
        calls.push(next.toolEnabled);
        runtime = next;
        if (!next.toolEnabled) {
          expect(old).toEqual(previous);
          throw new Error("raw-secret");
        }
      },
    },
  );
  await expect(failed).rejects.toThrow("not saved");
  await expect(failed).rejects.not.toThrow("raw-secret");
  expect(calls).toEqual([false, true]);
  expect(runtime).toEqual(previous);
  expect(store.settings).toEqual(previous);
  if (exists) expect(await fs.readFile(store.path, "utf8")).toBe(bytes);
  else await expect(fs.stat(store.path)).rejects.toMatchObject({ code: "ENOENT" });
  expect(await fs.readdir(agentDir)).toEqual(exists ? ["pi-codex-imagegen.json"] : []);
  await store.save({ transparentBackground: true });
  expect(store.settings.transparentBackground).toBe(true);
});

it("rejects asynchronous apply callbacks and restores the previous file", async () => {
  const apply = vi.fn(async () => {});
  await expect(store.save({ toolEnabled: false }, { apply })).rejects.toThrow(/synchronous|rollback/);
  expect(store.settings.toolEnabled).toBe(true);
  await expect(fs.stat(store.path)).rejects.toMatchObject({ code: "ENOENT" });
});

it.each(["signal", "ownership"])("rejects queued stale changes before creating files: %s", async (kind) => {
  const controller = new AbortController();
  let current = true;
  const entered = deferred();
  const release = deferred();
  const blocker = withFileMutationQueue(store.path, async () => {
    entered.resolve();
    await release.promise;
  });
  await entered.promise;
  const apply = vi.fn();
  const failed = store.save({ toolEnabled: true }, { signal: controller.signal, isCurrent: () => current, apply });
  if (kind === "signal") controller.abort(new Error("raw-secret"));
  else current = false;
  release.resolve();
  await blocker;
  await expect(failed).rejects.toThrow("cancelled");
  expect(apply).not.toHaveBeenCalled();
  expect(await fs.readdir(directory)).toEqual([]);
  await store.save({ toolEnabled: true });
  expect(store.settings.toolEnabled).toBe(true);
});

it.each([false, true])("undoes late cancellation immediately after rename (existing: %s)", async (exists) => {
  const bytes = '{ "future":true }\n';
  if (exists) await seed(bytes);
  const controller = new AbortController();
  const rename = fs.rename.bind(fs);
  vi.spyOn(fs, "rename").mockImplementationOnce(async (source, destination) => {
    await rename(source, destination);
    controller.abort();
  });
  const apply = vi.fn();
  await expect(store.save({ toolEnabled: false }, { signal: controller.signal, apply })).rejects.toThrow("cancelled");
  expect(apply).not.toHaveBeenCalled();
  expect(store.settings).toEqual(defaultSettings());
  if (exists) expect(await fs.readFile(store.path, "utf8")).toBe(bytes);
  else await expect(fs.stat(store.path)).rejects.toMatchObject({ code: "ENOENT" });
  expect(await fs.readdir(dirname(store.path))).toEqual(exists ? ["pi-codex-imagegen.json"] : []);
});

it("checks ownership after synchronous runtime application and rolls back both states", async () => {
  let current = true;
  let runtime = true;
  await expect(
    store.save(
      { toolEnabled: false },
      {
        isCurrent: () => current,
        apply: (next) => {
          runtime = next.toolEnabled;
          current = false;
        },
      },
    ),
  ).rejects.toThrow("cancelled");
  expect(runtime).toBe(true);
  expect(store.settings.toolEnabled).toBe(true);
  await expect(fs.stat(store.path)).rejects.toMatchObject({ code: "ENOENT" });
});

it("reloads invalid manual edits before saving instead of replacing them from cached settings", async () => {
  await store.save({ toolEnabled: true });
  await fs.writeFile(store.path, '{"transparentBackground":"invalid"}');
  await expect(store.save({ toolEnabled: false })).rejects.toThrow("Repair");
  expect(await fs.readFile(store.path, "utf8")).toBe('{"transparentBackground":"invalid"}');
  expect(store.settings.toolEnabled).toBe(true);
});

it("returns read warnings and sanitized save errors, then recovers", async () => {
  vi.spyOn(fs, "readFile").mockRejectedValueOnce(new Error("raw-secret"));
  const loaded = await store.load();
  expect(loaded.settings.toolEnabled).toBe(false);
  expect(loaded.warning).toMatch(/Repair/);
  expect(loaded.warning).not.toContain("raw-secret");
  vi.spyOn(fs, "readFile").mockRejectedValueOnce(new Error("raw-secret"));
  const failed = store.save({ toolEnabled: true });
  await expect(failed).rejects.toThrow("cannot be read");
  await expect(failed).rejects.not.toThrow("raw-secret");
  expect(await fs.readdir(directory)).toEqual([]);
  await store.save({ toolEnabled: true });
  expect(store.settings.toolEnabled).toBe(true);
});

it("checks ownership after reading and before creating directories", async () => {
  const readFile = fs.readFile.bind(fs);
  let current = true;
  vi.spyOn(fs, "readFile").mockImplementationOnce(async (...args) => {
    try {
      return await readFile(...args);
    } finally {
      current = false;
    }
  });
  await expect(store.save({ toolEnabled: true }, { isCurrent: () => current })).rejects.toThrow("cancelled");
  expect(await fs.readdir(directory)).toEqual([]);
});

it("closes and removes a staged file when cancellation happens during open", async () => {
  const open = fs.open.bind(fs);
  const controller = new AbortController();
  const close = vi.fn();
  vi.spyOn(fs, "open").mockImplementationOnce(async (...args) => {
    const handle = await open(...args);
    const originalClose = handle.close.bind(handle);
    vi.spyOn(handle, "close").mockImplementation(async () => {
      close();
      await originalClose();
    });
    controller.abort();
    return handle;
  });
  await expect(store.save({ toolEnabled: false }, { signal: controller.signal })).rejects.toThrow("cancelled");
  expect(close).toHaveBeenCalledOnce();
  expect(await fs.readdir(agentDir)).toEqual([]);
  expect(store.settings.toolEnabled).toBe(true);
});

it("publishes from the same directory with private permissions even when replacing a public file", async () => {
  await seed("{}");
  await fs.chmod(store.path, 0o644);
  const rename = fs.rename.bind(fs);
  vi.spyOn(fs, "rename").mockImplementationOnce(async (source, destination) => {
    expect(dirname(String(source))).toBe(dirname(String(destination)));
    if (process.platform !== "win32") expect((await fs.stat(source)).mode & 0o777).toBe(0o600);
    await rename(source, destination);
  });
  await store.save({ toolEnabled: true });
  if (process.platform !== "win32") expect((await fs.stat(store.path)).mode & 0o777).toBe(0o600);
  expect(await fs.readdir(agentDir)).toEqual(["pi-codex-imagegen.json"]);
});

it("cleans owned staged files and recovers after staging failure", async () => {
  vi.spyOn(fs, "open").mockRejectedValueOnce(new Error("raw-secret"));
  const failure = store.save({ toolEnabled: false });
  await expect(failure).rejects.toThrow("not saved");
  await expect(failure).rejects.not.toThrow("raw-secret");
  expect(store.settings.toolEnabled).toBe(true);
  expect(await fs.readdir(agentDir)).toEqual([]);
  await store.save({ toolEnabled: false });
  expect(await document()).toEqual({ toolEnabled: false });
});
