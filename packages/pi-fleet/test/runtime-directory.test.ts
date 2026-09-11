import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, readFile, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { dirname, join } from "node:path";
import { test } from "vitest";
import { createGroup, createSignedEndpointManifest } from "../src/protocol.js";
import {
  cleanupStaleRuntimeEntries,
  createEndpointPaths,
  defaultRuntimeBaseDirectory,
  ensureGroupRuntimeDirectory,
  ORPHAN_GRACE_MS,
  publishManifest,
} from "../src/runtime-directory.js";

const posixTest = process.platform === "win32" ? test.skip : test;

if (process.platform === "darwin") {
  test("default macOS runtime path leaves room for Unix socket names", () => {
    const base = defaultRuntimeBaseDirectory();
    assert.match(base, /^\/tmp\/pi-fleet-/u);
    assert.equal(Buffer.byteLength(join(base, "0".repeat(32), `${"x".repeat(24)}.sock`)) <= 103, true);
  });
}

async function fixture(run: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp("/tmp/pi-fleet-runtime-test-");
  try {
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

posixTest(
  "runtime directories and authenticated manifests are private, regular, and atomically published",
  async () => {
    await fixture(async (base) => {
      const group = createGroup(Buffer.alloc(32, 4));
      const directory = await ensureGroupRuntimeDirectory(group.id, { baseDirectory: base });
      assert.equal((await stat(directory)).mode & 0o777, 0o700);
      const paths = createEndpointPaths(directory, "a".repeat(24));
      const manifest = createSignedEndpointManifest(
        {
          groupId: group.id,
          endpointId: paths.endpointId,
          sessionId: "session-a",
          socketName: `${paths.endpointId}.sock`,
          pid: process.pid,
          publishedAt: Date.now(),
        },
        group.secret,
      );
      await publishManifest(paths.manifestPath, manifest);
      assert.equal((await stat(paths.manifestPath)).mode & 0o777, 0o600);
      assert.equal((await lstat(paths.manifestPath)).isFile(), true);
      assert.deepEqual(JSON.parse(await readFile(paths.manifestPath, "utf8")), manifest);
    });
  },
);

posixTest("runtime setup rejects symlinked roots and socket paths beyond the POSIX budget", async () => {
  await fixture(async (base) => {
    const target = join(base, "target");
    const linked = join(base, "linked");
    await mkdir(target, { mode: 0o700 });
    await symlink(target, linked);
    await assert.rejects(ensureGroupRuntimeDirectory("0".repeat(32), { baseDirectory: linked }), /symbolic link/u);
    const longBase = join(base, "x".repeat(90));
    await assert.rejects(ensureGroupRuntimeDirectory("0".repeat(32), { baseDirectory: longBase }), /socket path/u);
  });
});

posixTest("old orphan sockets and temporary launch files are removed while fresh entries survive", async () => {
  await fixture(async (base) => {
    const group = createGroup(Buffer.alloc(32, 6));
    const directory = await ensureGroupRuntimeDirectory(group.id, { baseDirectory: base });
    const orphanSocket = join(directory, `${"b".repeat(24)}.sock`);
    await createOrphanSocket(orphanSocket);
    const oldTemporary = join(directory, `.${"c".repeat(24)}.json.${"d".repeat(16)}.tmp`);
    await writeFile(oldTemporary, "old", { mode: 0o600 });
    const oldLauncher = join(directory, `launch-${"a".repeat(16)}.sh`);
    await writeFile(oldLauncher, "private launch values", { mode: 0o700 });
    const unrelatedScript = join(directory, "launch-not-owned.sh");
    await writeFile(unrelatedScript, "keep", { mode: 0o700 });
    const pairedSocket = join(directory, `${"7".repeat(24)}.sock`);
    await createOrphanSocket(pairedSocket);
    await writeFile(join(directory, `${"7".repeat(24)}.json`), "paired", { mode: 0o600 });
    const oldResult = await cleanupStaleRuntimeEntries(directory, Date.now() + ORPHAN_GRACE_MS + 1);
    assert.deepEqual(oldResult, {
      removedSockets: 1,
      removedTemporaryFiles: 2,
      saturated: false,
    });
    await assert.rejects(lstat(orphanSocket));
    await assert.rejects(lstat(oldTemporary));
    await assert.rejects(lstat(oldLauncher));
    assert.equal((await lstat(unrelatedScript)).isFile(), true);
    assert.equal((await lstat(pairedSocket)).isSocket(), true);

    const freshSocket = join(directory, `${"8".repeat(24)}.sock`);
    await createOrphanSocket(freshSocket);
    const freshTemporary = join(directory, `.${"e".repeat(24)}.json.${"f".repeat(16)}.tmp`);
    await writeFile(freshTemporary, "fresh", { mode: 0o600 });
    const freshLauncher = join(directory, `launch-${"b".repeat(16)}.sh`);
    await writeFile(freshLauncher, "fresh", { mode: 0o700 });
    assert.deepEqual(await cleanupStaleRuntimeEntries(directory, Date.now()), {
      removedSockets: 0,
      removedTemporaryFiles: 0,
      saturated: false,
    });
    assert.equal((await lstat(freshSocket)).isSocket(), true);
    assert.equal((await lstat(freshTemporary)).isFile(), true);
    assert.equal((await lstat(freshLauncher)).isFile(), true);
  });
});

async function createOrphanSocket(path: string): Promise<void> {
  const original = join(dirname(path), `${"9".repeat(24)}.sock`);
  const server = createServer();
  await listen(server, original);
  await rename(original, path);
  await close(server);
  assert.equal((await lstat(path)).isSocket(), true);
}

function listen(server: Server, path: string): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(path, () => {
      server.off("error", reject);
      resolve();
    });
  });
}

function close(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}
