import assert from "node:assert/strict";
import { chmod, lstat, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, test } from "vitest";
import { DEFAULTS, normalizeSettings, SettingsStore } from "../src/settings.js";

let root: string;
let path: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "web-search-settings-"));
  path = join(root, "agent", "pi-web-search.json");
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});
async function document(value: unknown) {
  await mkdir(join(root, "agent"), { recursive: true });
  await writeFile(path, JSON.stringify(value), { mode: 0o600 });
}

test("missing loads are side-effect free; explicit saves create a private canonical file", async () => {
  const store = new SettingsStore(path);
  assert.deepEqual(await store.load(), DEFAULTS);
  await assert.rejects(lstat(join(root, "agent")), { code: "ENOENT" });
  await store.save({ exposure: "direct" });
  assert.equal((await store.load()).exposure, "direct");
  assert.deepEqual(JSON.parse(await readFile(path, "utf8")), { exposure: "direct" });
  if (process.platform !== "win32") assert.equal((await lstat(path)).mode & 0o777, 0o600);
});

test.each([
  [],
  null,
  true,
  { limit: 0 },
  { limit: 1.2 },
  { exposure: "unknown" },
  { apiToken: "secret\n" },
  { accountId: "../escape" },
  { gatewayId: "" },
  { timeoutMs: 999 },
  { byokAlias: "bad alias" },
])("rejects invalid settings without value disclosure: %j", (value) => {
  assert.throws(() => normalizeSettings(value));
});

test("malformed, insecure, symlinked, nonregular and oversized files block reads and saves", async () => {
  await document({ apiToken: "TOP_SECRET" });
  await writeFile(path, '{"apiToken":"TOP_SECRET",');
  const store = new SettingsStore(path);
  await assert.rejects(store.load(), (error: Error) => !error.message.includes("TOP_SECRET"));
  await assert.rejects(store.save({ limit: 1 }));
  assert.equal(await readFile(path, "utf8"), '{"apiToken":"TOP_SECRET",');
  await writeFile(path, JSON.stringify({ apiToken: "TOP_SECRET" }));
  if (process.platform !== "win32") {
    await chmod(path, 0o644);
    await assert.rejects(store.load());
    await chmod(path, 0o600);
  }
  const target = join(root, "original.json");
  await writeFile(target, "{}", { mode: 0o600 });
  await rm(path);
  await symlink(target, path);
  await assert.rejects(store.save({ limit: 1 }));
  assert.equal(await readFile(target, "utf8"), "{}");
  await rm(path);
  await mkdir(path);
  await assert.rejects(store.load());
  await rm(path, { recursive: true });
  await writeFile(path, " ".repeat(65537), { mode: 0o600 });
  await assert.rejects(store.load());
});

test("patches preserve unknown fields and latest external values; replacing maintains permissions", async () => {
  await document({ future: { nested: true }, limit: 2, gatewayId: "initial" });
  const store = new SettingsStore(path);
  await store.load();
  await document({ future: { nested: false }, limit: 3, gatewayId: "external" });
  await store.save({ exposure: "hidden" });
  assert.deepEqual(JSON.parse(await readFile(path, "utf8")), {
    future: { nested: false },
    limit: 3,
    gatewayId: "external",
    exposure: "hidden",
  });
  if (process.platform !== "win32") assert.equal((await lstat(path)).mode & 0o777, 0o600);
});

test("save failures preserve the file, clean temporary files and do not poison queues", async () => {
  await document({ future: 42, limit: 2 });
  let fail = true;
  const { rename } = await import("node:fs/promises");
  const store = new SettingsStore(path, async (from, to) => {
    if (fail) throw new Error("TOP_SECRET");
    await rename(from, to);
  });
  await assert.rejects(store.save({ limit: 7 }), (error: Error) => !error.message.includes("TOP_SECRET"));
  assert.equal((await store.load()).limit, 2);
  assert.deepEqual(await readdir(join(root, "agent")), ["pi-web-search.json"]);
  fail = false;
  await store.save({ limit: 8 });
  assert.equal((await store.load()).limit, 8);
});

test("reads and flush wait for ordered saves, including other stores using the same path", async () => {
  let release!: () => void;
  let started!: () => void;
  const ready = new Promise<void>((resolve) => {
    started = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const { rename } = await import("node:fs/promises");
  const store = new SettingsStore(path, async (from, to) => {
    started();
    await gate;
    await rename(from, to);
  });
  const first = store.save({ limit: 1 });
  await ready;
  const second = store.save({ limit: 9 });
  const reading = new SettingsStore(path).load();
  let flushed = false;
  const flush = store.flush().then(() => {
    flushed = true;
  });
  await Promise.resolve();
  assert.equal(flushed, false);
  release();
  await first;
  const observed = await reading;
  await second;
  await flush;
  // Assert only after every owned operation settles, even on a regression failure.
  assert.equal(observed.limit, 9);
  assert.equal((await store.load()).limit, 9);
});

test("flush still waits for earlier work when a later shared-queue registration fails", async () => {
  if (process.platform === "win32" || process.getuid?.() === 0) return;
  let release!: () => void;
  let started!: () => void;
  const ready = new Promise<void>((resolve) => {
    started = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const { rename } = await import("node:fs/promises");
  const store = new SettingsStore(path, async (from, to) => {
    started();
    await gate;
    await rename(from, to);
  });
  const first = store.save({ limit: 1 });
  await ready;
  try {
    await chmod(join(root, "agent"), 0o000);
    await assert.rejects(store.save({ limit: 2 }), { code: "EACCES" });
    let flushed = false;
    const flush = store.flush().then(() => {
      flushed = true;
    });
    // Let flush continuations run without releasing publication or using sleeps.
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(flushed, false);
    await chmod(join(root, "agent"), 0o700);
    release();
    await first;
    await flush;
    assert.equal(flushed, true);
    assert.equal((await store.load()).limit, 1);
  } finally {
    await chmod(join(root, "agent"), 0o700);
    release();
    await first;
  }
});

test("cancellation while waiting for mutation ownership prevents publication", async () => {
  let release!: () => void;
  let started!: () => void;
  const ready = new Promise<void>((resolve) => {
    started = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const lock = withFileMutationQueue(path, async () => {
    started();
    await gate;
  });
  await ready;
  const controller = new AbortController();
  const pending = new SettingsStore(path).save({ limit: 1 }, controller.signal);
  const rejection = assert.rejects(pending);
  controller.abort();
  release();
  await lock;
  await rejection;
  await assert.rejects(lstat(join(root, "agent")), { code: "ENOENT" });
});

test.each([0o277, 0o477, 0o777])("POSIX saves enforce 0600 despite restrictive umask %s", async (mask) => {
  if (process.platform === "win32") return;
  await mkdir(join(root, "agent"), { mode: 0o700 });
  const previous = process.umask(mask);
  try {
    const store = new SettingsStore(path);
    await store.save({ limit: 3 });
    assert.equal((await lstat(path)).mode & 0o777, 0o600);
    assert.equal((await new SettingsStore(path).load()).limit, 3);
    await store.save({ exposure: "direct" });
    assert.equal((await lstat(path)).mode & 0o777, 0o600);
    assert.equal((await new SettingsStore(path).load()).exposure, "direct");
  } finally {
    process.umask(previous);
  }
});

test.each([0o177, 0o277, 0o477, 0o777])(
  "missing ancestors become private and usable despite umask %s",
  async (mask) => {
    const directories = [
      join(root, "missing"),
      join(root, "missing", "nested"),
      join(root, "missing", "nested", "agent"),
    ];
    const target = join(directories[2], "pi-web-search.json");
    const store = new SettingsStore(target);
    assert.deepEqual(await store.load(), DEFAULTS);
    await assert.rejects(lstat(directories[0]), { code: "ENOENT" });
    const previous = process.umask(mask);
    try {
      await store.save({ limit: 3 });
      for (const directory of directories)
        if (process.platform !== "win32") assert.equal((await lstat(directory)).mode & 0o777, 0o700);
      assert.equal((await store.load()).limit, 3);
      await store.save({ exposure: "direct" });
      assert.equal((await new SettingsStore(target).load()).exposure, "direct");
    } finally {
      process.umask(previous);
      // A failing old implementation may leave a masked ancestor; release test-owned paths.
      for (const directory of directories)
        await chmod(directory, 0o700).catch((error) => {
          if (error.code !== "ENOENT") throw error;
        });
    }
  },
);

test("existing directory permissions are unchanged, including read-only blockers", async () => {
  if (process.platform === "win32") return;
  const directory = join(root, "agent");
  await mkdir(directory, { mode: 0o750 });
  const store = new SettingsStore(path);
  await store.save({ limit: 2 });
  assert.equal((await lstat(directory)).mode & 0o777, 0o750);
  if (process.getuid?.() === 0) return;
  await chmod(directory, 0o500);
  try {
    await assert.rejects(store.save({ limit: 3 }));
    assert.equal((await lstat(directory)).mode & 0o777, 0o500);
    assert.equal((await store.load()).limit, 2);
  } finally {
    await chmod(directory, 0o700);
  }
});

test("non-directory ancestors block saves without modifying the blocker", async () => {
  await writeFile(join(root, "agent"), "do not change", { mode: 0o600 });
  await assert.rejects(new SettingsStore(path).save({ limit: 3 }));
  assert.equal(await readFile(join(root, "agent"), "utf8"), "do not change");
});

test("cancelled saves do not publish or create defaults", async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(new SettingsStore(path).save({ limit: 1 }, controller.signal));
  await assert.rejects(lstat(join(root, "agent")), { code: "ENOENT" });
});
