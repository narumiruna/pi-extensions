import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { build } from "esbuild";
import { test, vi } from "vitest";
import { withLock } from "../src/state/lock.js";
import { migrateLegacyStateDirectory, withStateDirectoryAccess } from "../src/state/state-directory.js";
import { acquireContinuousLease } from "../src/sync/continuous-lease.js";
import { readContinuousRecord, reserveContinuousRequest } from "../src/sync/continuous-record.js";
import { continuousRoot, hashContinuous } from "../src/sync/continuous-storage.js";
import { withTempHome } from "./helpers.js";

const binding = hashContinuous("lease-test");

test("local sessions exclude one another and lease release does not need the operation lock", async () =>
  withTempHome(async () =>
    withStateDirectoryAccess(async () => {
      const first = await acquireContinuousLease(binding);
      assert.ok(first);
      try {
        assert.equal(await acquireContinuousLease(binding), undefined);
        first.assert();
        await withLock("foreground", async () => {
          await first.release();
        });
        await first.release();
        const next = await acquireContinuousLease(binding);
        assert.ok(next);
        try {
          next.assert();
        } finally {
          await next.release();
        }
      } finally {
        await first.release();
      }
    }),
  ));

test("ownership changes fence old work and old release preserves a successor guard", async () =>
  withTempHome(async () =>
    withStateDirectoryAccess(async () => {
      const first = await acquireContinuousLease(binding);
      assert.ok(first);
      const guard = path.join(continuousRoot(), "scheduler.lock");
      try {
        // Move the old inode aside so the replacement cannot reuse its identity.
        await fs.rename(guard, `${guard}.old`);
        await fs.mkdir(guard);
        await fs.writeFile(
          path.join(continuousRoot(), "owner.json"),
          JSON.stringify({ version: 1, id: randomUUID(), pid: process.pid, binding }),
          { mode: 0o600 },
        );
        assert.throws(() => first.assert(), /ownership lost/);
        assert.equal(first.signal.aborted, true);
        await first.release();
        assert.equal((await fs.stat(guard)).isDirectory(), true);
      } finally {
        await first.release();
      }
    }),
  ));

test("partial owner publication releases timers and guards and permits retry", async () =>
  withTempHome(async () =>
    withStateDirectoryAccess(async () => {
      const rename = vi.spyOn(fs, "rename").mockRejectedValueOnce(new Error("publication failed"));
      try {
        await assert.rejects(acquireContinuousLease(binding), /publication failed/);
      } finally {
        rename.mockRestore();
      }
      await assert.rejects(fs.stat(path.join(continuousRoot(), "scheduler.lock")), /ENOENT/);
      const next = await acquireContinuousLease(binding);
      assert.ok(next);
      await next.release();
    }),
  ));

test("invalid ownership evidence is not replaced even for a reused live PID", async () =>
  withTempHome(async () =>
    withStateDirectoryAccess(async () => {
      const first = await acquireContinuousLease(binding);
      assert.ok(first);
      await first.release();
      const file = path.join(continuousRoot(), "owner.json");
      await fs.writeFile(file, '{"version":1,"pid":1}', { mode: 0o600 });
      await assert.rejects(acquireContinuousLease(binding), /Invalid continuous/);
      assert.equal(await fs.readFile(file, "utf8"), '{"version":1,"pid":1}');
    }),
  ));

test("idle monitoring blocks migration without retaining its exclusive guard", async () =>
  withTempHome(async (agentDir) => {
    await fs.mkdir(path.join(agentDir, ".pisync"), { recursive: true });
    const lease = await withStateDirectoryAccess(() => acquireContinuousLease(binding));
    assert.ok(lease);
    try {
      await assert.rejects(fs.stat(path.join(agentDir, ".pi-sync-state-migration.lock")), /ENOENT/);
      assert.equal((await migrateLegacyStateDirectory()).status, "deferred");
    } finally {
      await lease.release();
    }
    assert.equal((await migrateLegacyStateDirectory()).status, "migrated");
  }));

test("a future-dated orphan guard expires after one observed renewal window", async () =>
  withTempHome(async () =>
    withStateDirectoryAccess(async () => {
      const first = await acquireContinuousLease(binding);
      assert.ok(first);
      await first.release();
      const guard = path.join(continuousRoot(), "scheduler.lock");
      await fs.mkdir(guard);
      const future = new Date(Date.now() + 86400000);
      await fs.utimes(guard, future, future);
      const elapsed = vi.spyOn(performance, "now").mockReturnValue(0);
      try {
        assert.equal(await acquireContinuousLease(binding), undefined);
        elapsed.mockReturnValue(31001);
        const next = await acquireContinuousLease(binding);
        assert.ok(next);
        try {
          next.assert();
        } finally {
          await next.release();
        }
      } finally {
        elapsed.mockRestore();
      }
    }),
  ));

test("separate processes allow legacy foreground access and retain budgets across crashed-owner takeover", async () =>
  withTempHome(async (agentDir) => {
    await fs.mkdir(path.join(agentDir, ".pisync"), { recursive: true });
    const directory = path.resolve("node_modules/.cache/pi-sync-continuous-process");
    await fs.mkdir(directory, { recursive: true });
    const output = path.join(directory, `${randomUUID()}.mjs`);
    await build({
      stdin: {
        contents: `import "./packages/pi-sync/test/engine-process-host.js";
          import { acquireContinuousLease } from "./packages/pi-sync/src/sync/continuous-lease.js";
          import { withStateDirectoryAccess } from "./packages/pi-sync/src/state/state-directory.js";
          import { reserveContinuousRequest } from "./packages/pi-sync/src/sync/continuous-record.js";
          const binding = JSON.parse(process.argv[2]);
          await withStateDirectoryAccess(async () => {
            const lease = await acquireContinuousLease(binding);
            if (!lease) throw Error("no lease");
            await reserveContinuousRequest(binding, lease, "d".repeat(64));
            await reserveContinuousRequest(binding, lease, "d".repeat(64));
          });
          process.on("message", () => {});
          process.send({ ready: true });
          await new Promise(() => {});`,
        resolveDir: process.cwd(),
      },
      outfile: output,
      bundle: true,
      platform: "node",
      format: "esm",
      packages: "external",
      logLevel: "silent",
    });
    const child = fork(output, [JSON.stringify(binding)], {
      env: { ...process.env, PI_CODING_AGENT_DIR: agentDir },
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    });
    let stderr = "";
    child.stderr?.on("data", (data) => {
      stderr += data;
    });
    const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
    try {
      await new Promise<void>((resolve, reject) => {
        child.once("message", () => resolve());
        child.once("error", reject);
        child.once("exit", (code) => reject(new Error(`child exited ${code}: ${stderr}`)));
      });
      // Only after readiness may the test start its contention/expiry actions.
      await withStateDirectoryAccess(async () => {
        assert.equal(await acquireContinuousLease(binding), undefined);
        await withLock("foreground-probe", async () => {});
      });
      child.kill("SIGKILL");
      await exited;
      const guard = path.join(continuousRoot(), "scheduler.lock");
      const old = new Date(Date.now() - 31_000);
      await fs.utimes(guard, old, old);
      await withStateDirectoryAccess(async () => {
        const next = await acquireContinuousLease(binding);
        assert.ok(next);
        try {
          next.assert();
          assert.equal((await readContinuousRecord(binding)).attempts["d".repeat(64)], 2);
          await assert.rejects(reserveContinuousRequest(binding, next, "d".repeat(64)), /limit reached/);
        } finally {
          await next.release();
        }
      });
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await exited;
      await fs.rm(output, { force: true });
    }
  }));
