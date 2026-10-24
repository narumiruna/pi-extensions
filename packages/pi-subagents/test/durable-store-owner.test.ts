import { type ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
import { constants } from "node:fs";
import {
  access,
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  readlink,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { acquireStoreOwner } from "../src/durable-store-owner.js";

const sourceUrl = new URL("../src/durable-store-owner.ts", import.meta.url).href;
const workerSource = `
const { acquireStoreOwner } = await import(${JSON.stringify(sourceUrl)});
let owner;
process.on('message', async ({id, directory, op}) => {
  try {
    if (op === 'acquire') owner = await acquireStoreOwner(directory);
    if (op === 'release') { await owner?.release(); owner = undefined; }
    process.send({ id, ok: true });
  } catch (error) { process.send({ id, error: error.message }); }
});
process.send({ready: true});
`;

describe.skipIf(process.platform !== "linux")("durable store kernel ownership", () => {
  let root: string;
  let realFlock: string;
  const releases: (() => Promise<void>)[] = [];
  const children: ChildProcess[] = [];

  beforeAll(async () => {
    for (const directory of (process.env.PATH ?? "").split(":")) {
      const candidate = join(directory, "flock");
      try {
        await access(candidate, constants.X_OK);
        realFlock = candidate;
        return;
      } catch {}
    }
    throw new Error("These Linux ownership tests require util-linux flock");
  });
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "durable-owner-"));
  });
  afterEach(async () => {
    vi.unstubAllEnvs();
    await Promise.all(releases.splice(0).map((release) => release()));
    await Promise.all(
      children.splice(0).map(async (child) => {
        if (child.exitCode !== null || child.signalCode !== null) return;
        const closed = once(child, "close");
        child.kill("SIGKILL");
        await closed;
      }),
    );
    await rm(root, { recursive: true, force: true });
  });

  async function own(directory = join(root, "store")) {
    const owner = await acquireStoreOwner(directory);
    releases.push(owner.release);
    return owner;
  }

  async function worker() {
    const child = spawn(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", workerSource], {
      stdio: ["ignore", "ignore", "pipe", "ipc"],
    });
    children.push(child);
    let stderr = "";
    child.stderr?.on("data", (data) => {
      stderr += data;
    });
    await new Promise<void>((resolve, reject) => {
      child.once("message", () => resolve());
      child.once("error", reject);
      child.once("exit", (code) => reject(new Error(`Worker exited ${code}: ${stderr}`)));
    });
    let nextId = 0;
    return {
      child,
      request: (op: string, directory = join(root, "store")) => {
        const id = ++nextId;
        return new Promise<{ ok?: boolean; error?: string }>((resolve, reject) => {
          const onMessage = (message: { id?: number; ok?: boolean; error?: string }) => {
            if (message.id !== id) return;
            child.off("message", onMessage);
            resolve(message);
          };
          child.on("message", onMessage);
          child.send({ id, op, directory }, (error) => {
            if (error) reject(error);
          });
        });
      },
    };
  }

  async function lockDescriptors(): Promise<string[]> {
    const paths = await Promise.all(
      (await readdir("/proc/self/fd")).map(async (fd) => {
        try {
          return await readlink(`/proc/self/fd/${fd}`);
        } catch {
          return "";
        }
      }),
    );
    return paths.filter((path) => path.startsWith(root));
  }

  // A ready-signalled helper gates either preflight or acquisition. The lock
  // branch invokes the real util-linux descriptor form before reporting ready.
  async function gatedFlock(
    phase: "version" | "lock",
    action: (ready: Promise<number>, finish: () => void) => Promise<void>,
  ) {
    const socketPath = join(root, "ready.sock");
    let connection: Socket | undefined;
    let readyResolve!: (pid: number) => void;
    const ready = new Promise<number>((resolve) => {
      readyResolve = resolve;
    });
    const server = createServer((socket) => {
      connection = socket;
      socket.once("data", (data) => readyResolve(Number(data.toString())));
    });
    server.listen(socketPath);
    await once(server, "listening");
    const bin = join(root, "bin");
    await mkdir(bin, { mode: 0o700 });
    await writeFile(
      join(bin, "flock"),
      `#!${process.execPath}
const { spawnSync } = require('node:child_process');
const { connect } = require('node:net');
const args = process.argv.slice(2);
const version = args[0] === '--version';
const result = spawnSync(${JSON.stringify(realFlock)}, args, { stdio: version ? 'inherit' : ['ignore', 'ignore', 'ignore', 3] });
if (result.status !== 0) process.exit(result.status ?? 2);
if ((version ? 'version' : 'lock') !== ${JSON.stringify(phase)}) process.exit(0);
const socket = connect(${JSON.stringify(socketPath)}, () => socket.write(String(process.pid)));
socket.on('data', () => { socket.destroy(); process.exit(0); });
`,
      { mode: 0o700 },
    );
    vi.stubEnv("PATH", bin);
    try {
      await action(ready, () => connection?.write("finish"));
    } finally {
      vi.unstubAllEnvs();
      connection?.destroy();
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
  }

  it("keeps ownership after the helper exits and releases idempotently without replacing the inode", async () => {
    const directory = join(root, "nested", "store");
    const owner = await own(directory);
    const file = join(directory, "owner.lock");
    const before = await lstat(file, { bigint: true });
    expect((await lstat(directory)).mode & 0o777).toBe(0o700);
    expect(before.mode & 0o777n).toBe(0o600n);
    expect((await lockDescriptors()).filter((path) => path === file)).toHaveLength(1);
    // Independent open-file descriptions conflict even in the same process.
    await expect(acquireStoreOwner(directory)).rejects.toThrow("live owner");
    expect((await lockDescriptors()).filter((path) => path === file)).toHaveLength(1);
    await Promise.all([owner.release(), owner.release(), owner.release()]);
    const reopened = await own(directory);
    expect((await lstat(file, { bigint: true })).ino).toBe(before.ino);
    expect(await readFile(file, "utf8")).toBe("");
    await reopened.release();
    expect(await lockDescriptors()).toEqual([]);
  });

  it("rejects a competing live process and recovers in a fresh process after owner SIGKILL", async () => {
    const first = await worker();
    expect(await first.request("acquire")).toMatchObject({ ok: true });
    const file = join(root, "store", "owner.lock");
    const inode = (await lstat(file, { bigint: true })).ino;
    const competitor = await worker();
    expect(await competitor.request("acquire")).toMatchObject({ error: expect.stringContaining("live owner") });
    const exited = once(first.child, "close");
    first.child.kill("SIGKILL");
    await exited;
    const fresh = await worker();
    expect(await fresh.request("acquire")).toMatchObject({ ok: true });
    expect((await lstat(file, { bigint: true })).ino).toBe(inode);
    expect(await competitor.request("acquire")).toMatchObject({ error: expect.stringContaining("live owner") });
    expect(await fresh.request("release")).toMatchObject({ ok: true });
    expect(await competitor.request("acquire")).toMatchObject({ ok: true });
  });

  it("admits exactly one concurrent cold-process owner", async () => {
    const [first, second] = await Promise.all([worker(), worker()]);
    const results = await Promise.all([first.request("acquire"), second.request("acquire")]);
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.filter((result) => result.error?.includes("live owner"))).toHaveLength(1);
  });

  it.each(["version", "lock"] as const)("cancels during %s and reaps the helper and descriptors", async (phase) => {
    const controller = new AbortController();
    const reason = new Error("cancel ownership");
    await gatedFlock(phase, async (ready) => {
      const acquiring = acquireStoreOwner(join(root, "store"), controller.signal);
      const rejected = expect(acquiring).rejects.toBe(reason);
      const pid = await ready;
      controller.abort(reason);
      await rejected;
      expect(() => process.kill(pid, 0)).toThrow();
      expect(await lockDescriptors()).toEqual([]);
      if (phase === "version") await expect(lstat(join(root, "store"))).rejects.toMatchObject({ code: "ENOENT" });
    });
    await own();
  });

  it("returns only after the helper exits, while retaining its descriptor lock", async () => {
    await gatedFlock("lock", async (ready, finish) => {
      const acquiring = acquireStoreOwner(join(root, "store"));
      const pid = await ready;
      finish();
      const owner = await acquiring;
      releases.push(owner.release);
      expect(() => process.kill(pid, 0)).toThrow();
      await expect(acquireStoreOwner(join(root, "store"))).rejects.toThrow("live owner");
      await owner.release();
    });
    await own();
  });

  it("does not tie an acquired owner to later signal cancellation", async () => {
    const controller = new AbortController();
    const owner = await acquireStoreOwner(join(root, "store"), controller.signal);
    releases.push(owner.release);
    controller.abort();
    await expect(acquireStoreOwner(join(root, "store"))).rejects.toThrow("live owner");
  });

  it("rejects pre-cancelled acquisition without creating storage", async () => {
    const controller = new AbortController();
    controller.abort(new Error("cancelled"));
    await expect(acquireStoreOwner(join(root, "store"), controller.signal)).rejects.toThrow("cancelled");
    expect(await readdir(root)).toEqual([]);
  });

  it("rejects missing flock before touching storage", async () => {
    vi.stubEnv("PATH", root);
    await expect(acquireStoreOwner(join(root, "store"))).rejects.toThrow("util-linux flock");
    expect(await readdir(root)).toEqual([]);
    expect(await lockDescriptors()).toEqual([]);
  });

  it.each(["foreign-version", "failed-version", "failed-lock"] as const)(
    "rejects %s without leaking resources",
    async (kind) => {
      const bin = join(root, "bin");
      await mkdir(bin, { mode: 0o700 });
      await writeFile(
        join(bin, "flock"),
        `#!/bin/sh
if [ "$1" = "--version" ]; then
  printf '${kind === "foreign-version" ? "BusyBox flock" : "flock from util-linux 2"}\\n'
  exit ${kind === "failed-version" ? 70 : 0}
fi
exit 70
`,
        { mode: 0o700 },
      );
      vi.stubEnv("PATH", bin);
      await expect(acquireStoreOwner(join(root, "store"))).rejects.toThrow(
        kind === "failed-lock" ? "flock exit 70" : "util-linux flock",
      );
      expect(await lockDescriptors()).toEqual([]);
      if (kind !== "failed-lock") await expect(lstat(join(root, "store"))).rejects.toMatchObject({ code: "ENOENT" });
      vi.unstubAllEnvs();
      await own();
    },
  );

  it("preserves existing owner.lock bytes and inode across successful ownership", async () => {
    const directory = join(root, "store");
    await mkdir(directory, { mode: 0o700 });
    const file = join(directory, "owner.lock");
    await writeFile(file, "persistent bytes", { mode: 0o600 });
    const inode = (await lstat(file, { bigint: true })).ino;
    const owner = await own(directory);
    await owner.release();
    expect((await lstat(file, { bigint: true })).ino).toBe(inode);
    expect(await readFile(file, "utf8")).toBe("persistent bytes");
  });

  it("rejects unsupported platforms before touching storage", async () => {
    const original = Object.getOwnPropertyDescriptor(process, "platform");
    if (!original) throw new Error("Missing process.platform descriptor");
    Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
    try {
      await expect(acquireStoreOwner(join(root, "store"))).rejects.toThrow("requires Linux");
      expect(await readdir(root)).toEqual([]);
    } finally {
      Object.defineProperty(process, "platform", original);
    }
  });

  it.each(["ancestor", "store", "lock"] as const)("does not follow a symlink at the %s", async (location) => {
    const real = join(root, "real");
    await mkdir(real, { mode: 0o700 });
    const target = join(real, "target");
    await writeFile(target, "unchanged", { mode: 0o600 });
    let directory = join(root, "store");
    if (location === "ancestor") {
      await symlink(real, join(root, "alias"));
      directory = join(root, "alias", "store");
    } else if (location === "store") {
      await symlink(real, directory);
    } else {
      await mkdir(directory, { mode: 0o700 });
      await symlink(target, join(directory, "owner.lock"));
    }
    await expect(acquireStoreOwner(directory)).rejects.toThrow();
    expect(await readFile(target, "utf8")).toBe("unchanged");
    expect(await lockDescriptors()).toEqual([]);
    expect(await readdir(real)).toEqual(["target"]);
  });

  it.each(["directory-mode", "lock-mode", "hard-link", "lock-directory"] as const)(
    "rejects unsafe %s without replacing existing data",
    async (kind) => {
      const directory = join(root, "store");
      await mkdir(directory, { mode: 0o700 });
      const file = join(directory, "owner.lock");
      if (kind === "lock-directory") await mkdir(file, { mode: 0o700 });
      else await writeFile(file, "retain", { mode: 0o600 });
      if (kind === "directory-mode") await chmod(directory, 0o755);
      if (kind === "lock-mode") await chmod(file, 0o644);
      if (kind === "hard-link") await link(file, join(root, "other-link"));
      const before = await lstat(file, { bigint: true });
      await expect(acquireStoreOwner(directory)).rejects.toThrow();
      expect((await lstat(file, { bigint: true })).ino).toBe(before.ino);
      if (kind !== "lock-directory") expect(await readFile(file, "utf8")).toBe("retain");
      expect(await lockDescriptors()).toEqual([]);
    },
  );

  it("rejects a writable non-sticky ancestor before creating the store", async () => {
    const shared = join(root, "shared");
    await mkdir(shared, { mode: 0o700 });
    await chmod(shared, 0o777);
    await expect(acquireStoreOwner(join(shared, "store"))).rejects.toThrow("safe ancestors");
    expect(await readdir(shared)).toEqual([]);
    expect(await lockDescriptors()).toEqual([]);
  });

  it.each(["lock-inode", "directory-inode", "lock-mode", "lock-link", "directory-mode"] as const)(
    "rejects a concurrent change to %s during acquisition",
    async (change) => {
      await gatedFlock("lock", async (ready, finish) => {
        const directory = join(root, "store");
        const acquiring = acquireStoreOwner(directory);
        const rejected = expect(acquiring).rejects.toThrow(/changed during ownership|Unsafe durable/);
        await ready;
        const file = join(directory, "owner.lock");
        if (change === "lock-inode") {
          await rename(file, join(root, "old-owner.lock"));
          await writeFile(file, "replacement", { mode: 0o600 });
        }
        if (change === "directory-inode") {
          await rename(directory, join(root, "old-store"));
          await mkdir(directory, { mode: 0o700 });
        }
        if (change === "lock-mode") await chmod(file, 0o644);
        if (change === "lock-link") await link(file, join(root, "other-lock"));
        if (change === "directory-mode") await chmod(directory, 0o755);
        finish();
        await rejected;
        expect(await lockDescriptors()).toEqual([]);
      });
    },
  );
});
