import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { test } from "vitest";
import { ensureDaemon, requestDaemon } from "../dist/client.js";
import { privateDirectory, publishIdentity, recordUpgradeOwner, runtimePaths, upgradeFile } from "../src/identity.js";

const exec = promisify(execFile);
const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));

test.skipIf(process.platform === "win32")(
  "the executable runs through npm-style symlinks without executing on import",
  async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "pi-sync-daemon-bin-"));
    try {
      const alias = path.join(directory, "pi-sync-daemon");
      await fs.symlink(cli, alias);
      const help = (await exec(alias, ["--help"])).stdout;
      assert.match(help, /^pi-sync-daemon <start\|status\|stop\|restart\|repair-upgrade\|serve>/u);
      assert.match(help, /status\/stop\/repair-upgrade never start/u);
      assert.equal(
        (
          await exec(process.execPath, [
            "--input-type=module",
            "--eval",
            "await import(process.argv[1]);",
            new URL("../dist/cli.js", import.meta.url).href,
          ])
        ).stdout,
        "",
      );
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  },
);

test("a losing explicit serve launch leaves the recognized owner and lifecycle log untouched", () =>
  fixture(async (root) => {
    const owner = await ensureDaemon(root);
    const target = path.join(owner.paths.directory, "lifecycle.log");
    const before = await fs.readFile(target, "utf8");
    await assert.rejects(exec(process.execPath, [cli, "serve", "--root", root]));
    assert.equal(await fs.readFile(target, "utf8"), before);
    assert.equal(
      ((await requestDaemon(owner.paths, owner.identity, "hello", {})) as { instance: string }).instance,
      owner.identity.instance,
    );
  }));

async function fixture(run: (root: string) => Promise<void>) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-sync-daemon-process-"));
  try {
    await run(await fs.realpath(root));
  } finally {
    await exec(process.execPath, [cli, "stop", "--root", root]).catch(() => {});
    const paths = await runtimePaths(root);
    await fs.rm(paths.directory, { recursive: true, force: true });
    await fs.rm(root, { recursive: true, force: true });
  }
}

test("simultaneous first clients share a detached owner that survives launcher exit", () =>
  fixture(async (root) => {
    const first = exec(process.execPath, [cli, "start", "--root", root]);
    const second = exec(process.execPath, [cli, "start", "--root", root]);
    const launched = await Promise.all([first, second]);
    const identities = launched.map((value) => JSON.parse(value.stdout) as { pid: number; instance: string });
    assert.equal(identities[0]?.pid, identities[1]?.pid);
    assert.equal(identities[0]?.instance, identities[1]?.instance);
    assert.notEqual(identities[0]?.pid, process.pid);
    const connected = await ensureDaemon(root);
    assert.equal(connected.identity.instance, identities[0]?.instance);
    const { stdout, stderr } = await exec(process.execPath, [cli, "status", "--root", root]);
    const status = JSON.parse(stdout);
    assert.equal(status.running, true);
    assert.equal(status.pid, connected.identity.pid);
    assert.equal(status.recordedPid, connected.identity.pid);
    assert.equal(Object.hasOwn(status, "token"), false);
    assert.equal(stdout.includes(connected.identity.token), false);
    assert.equal(stderr, "");
    assert.deepEqual(await fs.readdir(root), []); // No backend, credential, or sync data activity on connect.
  }));

for (const pending of [false, true]) {
  test(`status reports an unreachable owner as unknown ${pending ? "with" : "without"} a pending upgrade`, () =>
    fixture(async (root) => {
      const paths = await runtimePaths(root);
      await privateDirectory(paths.directory);
      const identity = {
        version: 1 as const,
        root,
        instance: randomUUID(),
        pid: process.pid,
        token: randomBytes(32).toString("hex"),
      };
      await publishIdentity(paths, identity); // Valid record for a live PID, but no hello endpoint.
      if (pending) await recordUpgradeOwner(paths, identity);
      const before = await fs.readFile(paths.identity);
      const { stdout, stderr } = await exec(process.execPath, [cli, "status", "--root", root]);
      assert.equal(stderr, "");
      assert.deepEqual(JSON.parse(stdout), {
        running: null,
        root,
        recordedPid: identity.pid,
        ...(pending && { pendingUpgradePid: identity.pid }),
      });
      assert.deepEqual(await fs.readFile(paths.identity), before);
      assert.deepEqual(
        (await fs.readdir(paths.directory)).sort(),
        [path.basename(paths.identity), ...(pending ? [path.basename(upgradeFile(paths))] : [])].sort(),
      );
    }));
}

test("status, stop, and repair-upgrade never start an absent daemon", () =>
  fixture(async (root) => {
    const run = async (command: string) =>
      JSON.parse((await exec(process.execPath, [cli, command, "--root", root])).stdout);
    assert.deepEqual(await run("repair-upgrade"), { repaired: false });
    for (const command of ["status", "stop"]) assert.equal((await run(command)).running, false);
    assert.deepEqual(await fs.readdir(root), []);
  }));

test("an idle service stops explicitly and refuses an old instance's handshake", () =>
  fixture(async (root) => {
    const old = await ensureDaemon(root);
    await exec(process.execPath, [cli, "stop", "--root", root]);
    const next = await ensureDaemon(root);
    assert.notEqual(next.identity.instance, old.identity.instance);
    await assert.rejects(requestDaemon(old.paths, old.identity, "hello", {}), { code: "ENOENT" });
  }));
