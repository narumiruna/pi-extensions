import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { constants, existsSync } from "node:fs";
import fs, { lstat, mkdir, mkdtemp, open, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { getAgentDir, withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { afterAll, afterEach, beforeAll, beforeEach, describe, test, vi } from "vitest";
import {
  DEFAULT_SUBAGENT_SETTINGS,
  type SubagentSettings,
  SubagentSettingsStore,
  subagentSettingsPath,
} from "../src/settings.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, open: vi.fn(actual.open) };
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const signal = () => new AbortController().signal;

describe("widget settings", () => {
  const keys = ["showWidget", "showJobId", "showTools", "showTiming"] as const;
  let directory: string;
  let path: string;
  let store: SubagentSettingsStore;

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
    vi.mocked(open).mockClear();
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
      showJobId: true,
      showTools: true,
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
    assert.deepEqual(await store.load(), { settings: DEFAULT_SUBAGENT_SETTINGS, diagnostics: [] });
    assert.deepEqual(vi.mocked(open).mock.calls, []);
    assert.deepEqual(await fs.readdir(directory), ["project"]);
  });

  test.each(["directory", "symlink", "dangling symlink"])(
    "rejects a %s settings path and blocks saves",
    async (kind) => {
      await fs.mkdir(dirname(path), { recursive: true });
      if (kind === "directory") await fs.mkdir(path);
      else {
        const target = join(directory, "target.json");
        if (kind === "symlink") await fs.writeFile(target, '{"durable":true}');
        await fs.symlink(target, path);
      }
      const loaded = await store.load();
      assert.deepEqual(loaded.settings, DEFAULT_SUBAGENT_SETTINGS);
      assert.match(loaded.diagnostics[0] ?? "", /symlink or special file/u);
      assert.equal(vi.mocked(open).mock.calls.length, 0);
      await assert.rejects(store.save("showWidget", false, signal()), /Cannot save/u);
    },
  );

  test.skipIf(process.platform === "win32")("rejects a settings FIFO without opening or replacing it", async () => {
    await fs.mkdir(dirname(path), { recursive: true });
    execFileSync("mkfifo", [path]);
    const loaded = await store.load();
    assert.match(loaded.diagnostics[0] ?? "", /special file/u);
    assert.equal(vi.mocked(open).mock.calls.length, 0);
    await assert.rejects(store.save("showWidget", false, signal()), /Cannot save/u);
    assert.equal((await fs.lstat(path)).isFIFO(), true);
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
    for (const value of [null, 0, 1, "true", "false", [], {}]) {
      await writeDocument({ [key]: value, [otherKey]: false });
      const loaded = await store.load();
      assert.deepEqual(loaded.settings, { ...DEFAULT_SUBAGENT_SETTINGS, [otherKey]: false });
      assert.equal(loaded.diagnostics.length, 1);
      assert.match(loaded.diagnostics[0] ?? "", new RegExp(`${key}.*boolean`, "u"));
      assert.deepEqual(await diskDocument(), { [key]: value, [otherKey]: false });
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
      await assert.rejects(store.save("showTools", false, signal()), /Cannot save/u);
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
    await store.save("showTools", false, signal());
    const before = await fs.readFile(path, "utf8");
    const previous = store.settings;
    const error = Object.assign(new Error("read denied"), { code: "EACCES" });
    vi.mocked(open).mockRejectedValueOnce(error).mockRejectedValueOnce(error);
    await assert.rejects(store.save("showWidget", false, signal()), /read denied/u);
    assert.deepEqual(store.settings, previous);
    const loaded = await store.load();
    assert.deepEqual(loaded.settings, DEFAULT_SUBAGENT_SETTINGS);
    assert.match(loaded.diagnostics[0] ?? "", /read denied/u);
    assert.equal(await fs.readFile(path, "utf8"), before);
    await store.save("showTiming", false, signal());
    assert.deepEqual(await diskDocument(), { showTools: false, showTiming: false });
  });

  test("saves patch only one key in the latest document and preserve unknown and invalid fields", async () => {
    await writeDocument({ showWidget: false, future: { nested: [1, true, null] } });
    await store.load();
    const latest = JSON.parse(
      '{"showWidget":true,"showTools":"invalid","future":{"nested":[2,false]},"__proto__":{"keep":true}}',
    ) as Record<string, unknown>;
    await writeDocument(latest);
    assert.deepEqual(await store.save("showJobId", false, signal()), {
      ...DEFAULT_SUBAGENT_SETTINGS,
      showJobId: false,
    });
    assert.deepEqual(await diskDocument(), { ...latest, showJobId: false });
    await store.save("showTools", false, signal());
    assert.deepEqual(await diskDocument(), { ...latest, showJobId: false, showTools: false });
  });

  test("serializes requested changes and reads in the same store", async () => {
    const first = store.save("showWidget", false, signal());
    const second = store.save("showTools", false, signal());
    const reading = store.load();
    const third = store.save("showWidget", true, signal());
    assert.equal((await first).showWidget, false);
    assert.equal((await second).showTools, false);
    assert.deepEqual((await reading).settings, {
      ...DEFAULT_SUBAGENT_SETTINGS,
      showWidget: false,
      showTools: false,
    });
    assert.deepEqual(await third, { ...DEFAULT_SUBAGENT_SETTINGS, showTools: false });
    await store.flush();
    assert.deepEqual(await diskDocument(), { showWidget: true, showTools: false });
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
      await writeDocument({ showJobId: false, external: true });
    });
    await entered.promise;
    const reading = store.load();
    const saving = store.save("showTiming", false, signal());
    release.resolve();
    await writer;
    assert.deepEqual((await reading).settings, { ...DEFAULT_SUBAGENT_SETTINGS, showJobId: false });
    assert.deepEqual(await saving, { ...DEFAULT_SUBAGENT_SETTINGS, showJobId: false, showTiming: false });
    assert.deepEqual(await diskDocument(), { showJobId: false, showTiming: false, external: true });
  });

  test("pre-aborted saves leave missing parent directories absent", async () => {
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(store.save("showWidget", false, controller.signal), /abort/iu);
    assert.deepEqual(store.settings, DEFAULT_SUBAGENT_SETTINGS);
    assert.deepEqual(await fs.readdir(directory), []);
    await store.save("showJobId", false, signal());
    assert.equal(store.settings.showJobId, false);
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
    await assert.rejects(store.save("showTools", false, controller.signal), /abort/iu);
    assert.deepEqual(store.settings, previous);
    assert.equal(await fs.readFile(path, "utf8"), before);
    assert.deepEqual(await fs.readdir(dirname(path)), ["pi-subagents.json"]);
    await store.save("showTools", false, signal());
    assert.equal(store.settings.showTools, false);
  });

  test("rename failure preserves disk and runtime, cleans staging, and does not poison queued operations", async () => {
    await store.save("showWidget", false, signal());
    const previous = store.settings;
    const before = await fs.readFile(path, "utf8");
    vi.spyOn(fs, "rename").mockRejectedValueOnce(new Error("rename failed"));
    const failed = assert.rejects(store.save("showTools", false, signal()), /rename failed/u);
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
    const next = store.save("showTools", false, signal());
    await failed;
    await next;
    assert.deepEqual(store.settings, { ...previous, showTools: false });
    assert.notEqual(await fs.readFile(path, "utf8"), before);
    assert.deepEqual(await diskDocument(), { showWidget: false, showTools: false });
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
});

describe("durable settings", () => {
  let root: string;
  let agentDir: string;
  let cwd: string;
  let userPath: string;
  let projectPath: string;
  let loadSubagentsSettings: typeof import("../src/settings.js").loadSubagentsSettings;
  let WidgetSettingsStore: typeof SubagentSettingsStore;
  let queueFileMutation: typeof withFileMutationQueue;
  const originalAgentDir = process.env.PI_CODING_AGENT_DIR;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "pi-subagents-settings-"));
    agentDir = join(root, "agent");
    cwd = join(root, "workspace");
    process.env.PI_CODING_AGENT_DIR = agentDir;
    // Set the isolated agent directory before fresh imports, including Pi's cached modules.
    vi.resetModules();
    ({ loadSubagentsSettings, SubagentSettingsStore: WidgetSettingsStore } = await import("../src/settings.js"));
    const { CONFIG_DIR_NAME, getAgentDir, withFileMutationQueue } = await import("@earendil-works/pi-coding-agent");
    queueFileMutation = withFileMutationQueue;
    assert.equal(getAgentDir(), agentDir);
    userPath = join(agentDir, "pi-subagents.json");
    projectPath = join(cwd, CONFIG_DIR_NAME, "pi-subagents.json");
  });

  beforeEach(async () => {
    await rm(agentDir, { recursive: true, force: true });
    await rm(cwd, { recursive: true, force: true });
    await mkdir(cwd);
    vi.mocked(open).mockClear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  afterAll(async () => {
    if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
    await rm(root, { recursive: true, force: true });
  });

  async function put(path: string, source: unknown): Promise<void> {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, typeof source === "string" ? source : JSON.stringify(source));
  }

  test("missing settings default to legacy without creating directories or files", async () => {
    assert.deepEqual(await loadSubagentsSettings(cwd, true), { durable: false, warnings: [] });
    assert.deepEqual(await loadSubagentsSettings(cwd, false), { durable: false, warnings: [] });
    assert.equal(existsSync(agentDir), false);
    assert.deepEqual(await readdir(cwd), []);
    assert.deepEqual((await readdir(root)).sort(), ["workspace"]);
    assert.equal(vi.mocked(open).mock.calls.length, 0);
  });

  test.each([false, true])("user durable=%s applies without project trust", async (durable) => {
    await put(userPath, { durable });
    assert.deepEqual(await loadSubagentsSettings(cwd, false), { durable, warnings: [] });
  });

  test.each([false, true])("trusted project durable=%s applies", async (durable) => {
    await put(projectPath, { durable });
    assert.deepEqual(await loadSubagentsSettings(cwd, true), { durable, warnings: [] });
  });

  test.each([
    [false, true],
    [true, false],
  ])("project %s overrides user %s by field", async (projectValue, userValue) => {
    await put(userPath, { durable: userValue });
    await put(projectPath, { durable: projectValue });
    assert.deepEqual(await loadSubagentsSettings(cwd, true), { durable: projectValue, warnings: [] });
  });

  test.each([{}, { future: { version: 2 } }])(
    "absent project field inherits user value and ignores unknown fields: %j",
    async (project) => {
      await put(userPath, { durable: true, future: [1, 2] });
      await put(projectPath, project);
      assert.deepEqual(await loadSubagentsSettings(cwd, true), { durable: true, warnings: [] });
    },
  );

  test.each(['{"durable":true}', "malformed", '"invalid object"'])(
    "untrusted project is not read or warned about: %s",
    async (source) => {
      await put(projectPath, source);
      assert.deepEqual(await loadSubagentsSettings(cwd, false), { durable: false, warnings: [] });
      assert.equal(vi.mocked(open).mock.calls.length, 0);
    },
  );

  test("untrusted project cannot override an enabled user setting", async () => {
    await put(userPath, { durable: true });
    await put(projectPath, { durable: false });
    assert.deepEqual(await loadSubagentsSettings(cwd, false), { durable: true, warnings: [] });
    assert.deepEqual(
      vi.mocked(open).mock.calls.map(([path]) => path),
      [userPath],
    );
  });

  test.each(["{", "", "null", "[]", "true", "42", '"settings"'])(
    "malformed or non-object user settings are ignored: %j",
    async (source) => {
      await put(userPath, source);
      const loaded = await loadSubagentsSettings(cwd, true);
      assert.equal(loaded.durable, false);
      assert.equal(loaded.warnings.length, 1);
      assert.match(loaded.warnings[0] ?? "", /user settings ignored/);
      assert.equal(await readFile(userPath, "utf8"), source);
      await put(userPath, { durable: true });
      await put(projectPath, source);
      const projectLoaded = await loadSubagentsSettings(cwd, true);
      assert.equal(projectLoaded.durable, true);
      assert.equal(projectLoaded.warnings.length, 1);
    },
  );

  test.each([null, "true", "false", 0, 1, [], {}, [true]])("invalid durable value is ignored: %j", async (durable) => {
    await put(userPath, { durable });
    const userLoaded = await loadSubagentsSettings(cwd, false);
    assert.equal(userLoaded.durable, false);
    assert.equal(userLoaded.warnings.length, 1);
    await put(userPath, { durable: true });
    await put(projectPath, { durable });
    const loaded = await loadSubagentsSettings(cwd, true);
    assert.equal(loaded.durable, true);
    assert.equal(loaded.warnings.length, 1);
    assert.match(loaded.warnings[0] ?? "", /project settings ignored: "durable" must be a boolean/);
  });

  test("unknown fields alone do not enable durable mode", async () => {
    await put(userPath, '{"future":true,"__proto__":{"durable":true}}');
    assert.deepEqual(await loadSubagentsSettings(cwd, true), { durable: false, warnings: [] });
  });

  test("invalid user settings do not block a valid project override", async () => {
    await put(userPath, { durable: "true" });
    await put(projectPath, { durable: true });
    const loaded = await loadSubagentsSettings(cwd, true);
    assert.equal(loaded.durable, true);
    assert.equal(loaded.warnings.length, 1);
  });

  test("invalid JSON in project settings preserves the user override", async () => {
    await put(userPath, { durable: true });
    await put(projectPath, "{");
    const loaded = await loadSubagentsSettings(cwd, true);
    assert.equal(loaded.durable, true);
    assert.equal(loaded.warnings.length, 1);
  });

  test("I/O failures return bounded warning data without raw errors", async () => {
    await put(userPath, { durable: true });
    await put(projectPath, { durable: true });
    const secret = "\u001b[31mprivate-file-content".repeat(1_000);
    vi.mocked(open).mockRejectedValueOnce(Object.assign(new Error(secret), { code: "EACCES" }));
    vi.mocked(open).mockRejectedValueOnce(Object.assign(new Error(secret), { code: "EIO" }));
    const loaded = await loadSubagentsSettings(cwd, true);
    assert.equal(loaded.durable, false);
    assert.equal(loaded.warnings.length, 2);
    for (const warning of loaded.warnings) {
      assert.ok(warning.length < 160);
      assert.equal(warning.includes(secret), false);
      assert.equal(warning.includes(root), false);
      assert.equal(warning.includes("\u001b"), false);
    }
  });

  test("read failure closes the file and returns warning data", async () => {
    await put(userPath, { durable: true });
    const close = vi.fn(async () => undefined);
    vi.mocked(open).mockResolvedValueOnce({
      stat: async () => ({ isFile: () => true }),
      readFile: async () => {
        throw new Error("read failure");
      },
      close,
    } as unknown as Awaited<ReturnType<typeof open>>);
    const loaded = await loadSubagentsSettings(cwd, false);
    assert.equal(loaded.durable, false);
    assert.equal(loaded.warnings.length, 1);
    assert.equal(close.mock.calls.length, 1);
  });

  test.each([false, true])("a changed file type or stat failure closes the handle: stat fails=%s", async (fails) => {
    await put(userPath, { durable: true });
    const close = vi.fn(async () => undefined);
    const read = vi.fn();
    vi.mocked(open).mockResolvedValueOnce({
      stat: async () => {
        if (fails) throw new Error("stat failure");
        return { isFile: () => false };
      },
      readFile: read,
      close,
    } as unknown as Awaited<ReturnType<typeof open>>);
    const loaded = await loadSubagentsSettings(cwd, false);
    assert.equal(loaded.durable, false);
    assert.equal(loaded.warnings.length, 1);
    assert.equal(close.mock.calls.length, 1);
    assert.equal(read.mock.calls.length, 0);
  });

  test("close failure returns warning data instead of rejecting", async () => {
    await put(userPath, { durable: true });
    vi.mocked(open).mockResolvedValueOnce({
      stat: async () => ({ isFile: () => true }),
      readFile: async () => '{"durable":true}',
      close: async () => {
        throw new Error("close failure");
      },
    } as unknown as Awaited<ReturnType<typeof open>>);
    const loaded = await loadSubagentsSettings(cwd, false);
    assert.equal(loaded.durable, false);
    assert.equal(loaded.warnings.length, 1);
  });

  test("file disappearance between inspection and open is a missing-file default", async () => {
    await put(userPath, { durable: true });
    vi.mocked(open).mockRejectedValueOnce(Object.assign(new Error("removed"), { code: "ENOENT" }));
    assert.deepEqual(await loadSubagentsSettings(cwd, false), { durable: false, warnings: [] });
  });

  test("non-directory parent is an I/O warning, not a missing file", async () => {
    await writeFile(agentDir, "not a directory");
    const loaded = await loadSubagentsSettings(cwd, false);
    assert.equal(loaded.durable, false);
    assert.equal(loaded.warnings.length, 1);
  });

  test("directory settings paths are rejected without opening them", async () => {
    await mkdir(userPath, { recursive: true });
    const loaded = await loadSubagentsSettings(cwd, false);
    assert.equal(loaded.durable, false);
    assert.equal(loaded.warnings.length, 1);
    assert.equal(vi.mocked(open).mock.calls.length, 0);
  });

  test.each([false, true])("final-component symlinks are rejected, dangling=%s", async (dangling) => {
    const target = join(root, "target.json");
    if (!dangling) await put(target, { durable: true });
    await mkdir(agentDir);
    await symlink(dangling ? join(root, "missing.json") : target, userPath);
    const loaded = await loadSubagentsSettings(cwd, false);
    assert.equal(loaded.durable, false);
    assert.equal(loaded.warnings.length, 1);
    assert.equal((await lstat(userPath)).isSymbolicLink(), true);
    assert.equal(vi.mocked(open).mock.calls.length, 0);
  });

  test("ancestor symlinks follow normal filesystem semantics", async () => {
    const targetDir = join(root, "actual-agent");
    await put(join(targetDir, "pi-subagents.json"), { durable: true });
    await symlink(targetDir, agentDir, "dir");
    assert.deepEqual(await loadSubagentsSettings(cwd, false), { durable: true, warnings: [] });
  });

  test("extension environment variables and alternate filenames do not select settings", async () => {
    const alternate = join(root, "alternate.json");
    await put(alternate, { durable: true });
    await put(join(agentDir, "pi-subagents-settings.json"), { durable: true });
    await put(join(agentDir, "settings.json"), { durable: true });
    vi.stubEnv("HOME", join(root, "unrelated-home"));
    vi.stubEnv("XDG_CONFIG_HOME", join(root, "unrelated-config"));
    vi.stubEnv("PI_SUBAGENTS_DURABLE", "true");
    vi.stubEnv("PI_SUBAGENTS_CONFIG", alternate);
    vi.stubEnv("PI_SUBAGENTS_SETTINGS", alternate);
    vi.stubEnv("PI_SUBAGENTS_SETTINGS_PATH", alternate);
    assert.deepEqual(await loadSubagentsSettings(cwd, true), { durable: false, warnings: [] });
    await put(userPath, { durable: false });
    assert.deepEqual(await loadSubagentsSettings(cwd, true), { durable: false, warnings: [] });
  });

  test("loads do not write settings, locks, temporary files, or console output", async () => {
    const userSource = '{ "durable": true, "unknown": {"keep": [1,2]} }\n';
    const projectSource = '{"durable":"invalid","unknown":true}\n';
    await put(userPath, userSource);
    await put(projectPath, projectSource);
    const before = [await readdir(agentDir), await readdir(dirname(projectPath))];
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    assert.equal((await loadSubagentsSettings(cwd, true)).durable, true);
    assert.equal((await loadSubagentsSettings(cwd, true)).warnings.length, 1);
    assert.deepEqual([await readdir(agentDir), await readdir(dirname(projectPath))], before);
    assert.equal(await readFile(userPath, "utf8"), userSource);
    assert.equal(await readFile(projectPath, "utf8"), projectSource);
    for (const [, flags] of vi.mocked(open).mock.calls) {
      assert.equal(typeof flags, "number");
      assert.equal(
        (flags as number) &
          (constants.O_WRONLY | constants.O_RDWR | constants.O_CREAT | constants.O_TRUNC | constants.O_APPEND),
        0,
      );
    }
    assert.equal(warn.mock.calls.length + error.mock.calls.length + log.mock.calls.length, 0);
  });

  test("a new load sees manual edits without rewriting either scope", async () => {
    await put(userPath, { durable: true });
    assert.equal((await loadSubagentsSettings(cwd, false)).durable, true);
    await put(userPath, { durable: false });
    assert.equal((await loadSubagentsSettings(cwd, false)).durable, false);
    await put(projectPath, { durable: true });
    assert.equal((await loadSubagentsSettings(cwd, true)).durable, true);
  });

  test.each([false, true, "invalid"])("widget saves preserve durable=%j and unknown fields", async (durable) => {
    const original = { durable, future: { nested: [1, true, null] }, showWidget: true };
    await put(userPath, original);
    await put(projectPath, { durable: false, showWidget: false });
    const store = new WidgetSettingsStore(userPath);
    assert.deepEqual(await store.load(), { settings: DEFAULT_SUBAGENT_SETTINGS, diagnostics: [] });
    const saved = await store.save("showTiming", false, signal());
    assert.deepEqual(saved, { ...DEFAULT_SUBAGENT_SETTINGS, showTiming: false });
    assert.deepEqual(JSON.parse(await readFile(userPath, "utf8")), { ...original, showTiming: false });
    const loaded = await loadSubagentsSettings(cwd, false);
    assert.equal(loaded.durable, durable === true);
    assert.equal(loaded.warnings.length, typeof durable === "boolean" ? 0 : 1);
    await assert.rejects(store.save("durable" as keyof SubagentSettings, false, signal()), /Invalid/u);
    assert.deepEqual(JSON.parse(await readFile(userPath, "utf8")), { ...original, showTiming: false });
    assert.deepEqual(JSON.parse(await readFile(projectPath, "utf8")), { durable: false, showWidget: false });
    await store.flush();
  });

  test("durable user reads wait until a queued widget save publishes", async () => {
    await put(userPath, { durable: true, future: "keep" });
    const store = new WidgetSettingsStore(userPath);
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
    const previousOpenCount = vi.mocked(open).mock.calls.length;
    let settled = false;
    const reading = loadSubagentsSettings(cwd, false).then((settings) => {
      settled = true;
      return settings;
    });
    let earlyRead: boolean;
    let earlySettlement: boolean;
    try {
      // A separate path can run only after the earlier read has registered with Pi's queue.
      await queueFileMutation(join(root, "unrelated.json"), async () => {});
      earlyRead = vi.mocked(open).mock.calls.length > previousOpenCount;
      earlySettlement = settled;
    } finally {
      release.resolve();
    }
    await saving;
    assert.deepEqual(await reading, { durable: true, warnings: [] });
    await store.flush();
    assert.equal(earlyRead, false);
    assert.equal(earlySettlement, false);
    assert.deepEqual(JSON.parse(await readFile(userPath, "utf8")), {
      durable: true,
      future: "keep",
      showWidget: false,
    });
  });

  test("durable reads and widget saves share request order with external queued writes", async () => {
    await put(userPath, { durable: false });
    const store = new WidgetSettingsStore(userPath);
    const entered = deferred();
    const release = deferred();
    const writing = queueFileMutation(userPath, async () => {
      entered.resolve();
      await release.promise;
      await put(userPath, { durable: true, external: { keep: true } });
    });
    await entered.promise;
    const firstRead = loadSubagentsSettings(cwd, false);
    const saving = store.save("showTools", false, signal());
    const finalRead = loadSubagentsSettings(cwd, false);
    release.resolve();
    await writing;
    assert.deepEqual(await firstRead, { durable: true, warnings: [] });
    assert.deepEqual(await saving, { ...DEFAULT_SUBAGENT_SETTINGS, showTools: false });
    assert.deepEqual(await finalRead, { durable: true, warnings: [] });
    await store.flush();
    assert.deepEqual(JSON.parse(await readFile(userPath, "utf8")), {
      durable: true,
      external: { keep: true },
      showTools: false,
    });
  });

  test.each([false, true])("failed widget saves do not poison durable reads: aborted=%s", async (aborted) => {
    await put(userPath, { durable: true, future: "keep" });
    const store = new WidgetSettingsStore(userPath);
    const controller = new AbortController();
    if (aborted) controller.abort();
    else vi.spyOn(fs, "rename").mockRejectedValueOnce(new Error("rename failed"));
    const failed = assert.rejects(store.save("showWidget", false, controller.signal), /abort|rename failed/iu);
    const reading = loadSubagentsSettings(cwd, false);
    const saving = store.save("showJobId", false, signal());
    await failed;
    assert.deepEqual(await reading, { durable: true, warnings: [] });
    assert.deepEqual(await saving, { ...DEFAULT_SUBAGENT_SETTINGS, showJobId: false });
    await store.flush();
    assert.deepEqual(JSON.parse(await readFile(userPath, "utf8")), {
      durable: true,
      future: "keep",
      showJobId: false,
    });
  });

  test("queue registration failures keep durable warnings private and allow later reads", async () => {
    await put(userPath, { durable: true });
    await put(projectPath, { durable: true });
    await rm(userPath);
    // A self-referencing symlink makes Pi's actual queue registration fail with ELOOP.
    await symlink(userPath, userPath);
    assert.deepEqual(await loadSubagentsSettings(cwd, true), {
      durable: true,
      warnings: ["pi-subagents user settings ignored: could not read the file."],
    });
    await rm(userPath);
    await put(userPath, { durable: true });
    assert.deepEqual(await loadSubagentsSettings(cwd, false), { durable: true, warnings: [] });
  });
});
