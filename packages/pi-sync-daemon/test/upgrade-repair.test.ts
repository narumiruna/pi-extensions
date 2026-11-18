import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { fstatSync, fsyncSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { onTestFinished, test, vi } from "vitest";
import { ensureDaemon } from "../src/client.js";
import {
  privateDirectory,
  publishIdentity,
  readUpgradeOwner,
  recordUpgradeOwner,
  runtimePaths,
  upgradeArchivePath,
  upgradeFile,
} from "../src/identity.js";
import { repairUpgrade } from "../src/upgrade-repair.js";

vi.mock("node:fs", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs")>();
  return { ...original, fsyncSync: vi.fn(original.fsyncSync) };
});

async function pendingUpgrade() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-sync-upgrade-repair-"));
  onTestFinished(() => fs.rm(root, { recursive: true, force: true }));
  const paths = await runtimePaths(root);
  await privateDirectory(paths.directory);
  onTestFinished(() => fs.rm(paths.directory, { recursive: true, force: true }));
  const oldOwner = {
    version: 1 as const,
    root: paths.root,
    instance: randomUUID(),
    pid: 2_147_483_647,
    token: "a".repeat(64),
  };
  const kill = process.kill.bind(process);
  vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
    if (pid === oldOwner.pid && signal === 0) throw Object.assign(new Error("Process exited"), { code: "ESRCH" });
    return kill(pid, signal);
  });
  await recordUpgradeOwner(paths, oldOwner);
  return { root: paths.root, paths, oldOwner, archive: upgradeArchivePath(paths, oldOwner) };
}

async function writeConsent(root: string, size?: number) {
  const target = path.join(root, "pi-sync", "daemon.json");
  const consent = {
    version: 1,
    root,
    handover: true,
    nonce: "a".repeat(64),
    setups: { home: { fingerprint: "b".repeat(64), afterExit: true, other: [1, 2] } },
    future: "keep",
  };
  const format = () => `${JSON.stringify(consent, null, "\t")}\n`;
  if (size !== undefined) consent.future += "x".repeat(size - Buffer.byteLength(format()));
  await fs.mkdir(path.dirname(target));
  await fs.writeFile(target, format(), { mode: 0o600 });
  return { target, consent };
}

test("offline repair revokes a grant in a formatted consent document at the byte limit", async () => {
  const { root } = await pendingUpgrade();
  const { target, consent } = await writeConsent(root, 65_536);
  assert.equal((await fs.stat(target)).size, 65_536);
  consent.setups.home.afterExit = false;
  assert.ok(Buffer.byteLength(`${JSON.stringify(consent, null, "\t")}\n`) > 65_536);
  assert.equal((await repairUpgrade(root)).revokedGrants, 1);
  assert.ok((await fs.stat(target)).size <= 65_536);
  assert.deepEqual(JSON.parse(await fs.readFile(target, "utf8")), consent);
});

test.skipIf(process.platform === "win32")(
  "repair retries keep the barrier until consent directory sync succeeds",
  async () => {
    const { root, paths, archive } = await pendingUpgrade();
    const { target, consent } = await writeConsent(root);
    const sync = vi.mocked(fsyncSync);
    const syncOriginal = sync.getMockImplementation();
    assert.ok(syncOriginal);
    let directoryAttempts = 0;
    sync.mockImplementation((fd) => {
      if (fstatSync(fd).isDirectory() && ++directoryAttempts <= 2) throw new Error("Directory sync failed");
      syncOriginal(fd);
    });
    try {
      await assert.rejects(repairUpgrade(root), /consent publication failed/u);
      consent.setups.home.afterExit = false;
      assert.deepEqual(JSON.parse(await fs.readFile(target, "utf8")), consent);
      assert.ok(await readUpgradeOwner(paths));
      await assert.rejects(ensureDaemon(root), /upgrade repair is incomplete/u);
      await assert.rejects(repairUpgrade(root), /Directory sync failed/u);
      assert.ok(await readUpgradeOwner(paths));
      assert.deepEqual(await repairUpgrade(root), { repaired: true, revokedGrants: 0, archive });
      assert.equal(directoryAttempts, 3);
      assert.equal(await readUpgradeOwner(paths), undefined);
    } finally {
      sync.mockImplementation(syncOriginal);
    }
  },
);

test("repair uses the same private archive after moving identity but not the barrier", async () => {
  const { root, paths, oldOwner, archive } = await pendingUpgrade();
  await publishIdentity(paths, oldOwner);
  const identityBytes = await fs.readFile(paths.identity);
  const barrier = upgradeFile(paths);
  const barrierBytes = await fs.readFile(barrier);
  const rename = fs.rename.bind(fs);
  const spy = vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
    if (from === barrier) throw new Error("Barrier move interrupted");
    await rename(from, to);
  });
  try {
    await assert.rejects(repairUpgrade(root), /Barrier move interrupted/u);
  } finally {
    spy.mockRestore();
  }
  await assert.rejects(fs.stat(paths.identity), { code: "ENOENT" });
  assert.ok(await readUpgradeOwner(paths));
  await assert.rejects(ensureDaemon(root), /upgrade repair is incomplete/u);
  assert.deepEqual(await repairUpgrade(root), { repaired: true, revokedGrants: 0, archive });
  assert.deepEqual(await fs.readdir(paths.directory), [path.basename(archive)]);
  assert.deepEqual(await fs.readFile(path.join(archive, "identity.json")), identityBytes);
  assert.deepEqual(await fs.readFile(path.join(archive, "upgrade-owner.json")), barrierBytes);
});
