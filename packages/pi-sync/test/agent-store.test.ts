import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { build } from "esbuild";
import { test, vi } from "vitest";
import { withLock } from "../src/state/lock.js";
import { migrateLegacyStateDirectory, withStateDirectoryAccess } from "../src/state/state-directory.js";
import { ensureStateDir } from "../src/state/sync-state-store.js";
import { readAgentCandidate, saveAgentCandidate, withAgentClaim } from "../src/sync/agent-store.js";
import { withTempHome } from "./helpers.js";

const key = "a".repeat(64);

for (const invalid of [
  { version: 2, id: randomUUID(), pid: process.pid },
  { version: 1, id: [randomUUID()], pid: process.pid },
  { version: 1, id: "-".repeat(36), pid: process.pid },
  { version: 1, id: randomUUID(), pid: 2_147_483_648 },
  { version: 1, id: randomUUID(), pid: process.pid, unexpected: true },
])
  test(`malformed claim remains untouched: ${JSON.stringify(invalid)}`, async () =>
    withTempHome(async (agentDir) => {
      const directory = path.join(agentDir, "pi-sync/agent-resolver");
      await fs.mkdir(directory, { recursive: true, mode: 0o700 });
      const file = path.join(directory, "claim.json");
      const original = JSON.stringify(invalid);
      await fs.writeFile(file, original, { mode: 0o600 });
      await assert.rejects(
        withStateDirectoryAccess(() => withAgentClaim(async () => {})),
        /Invalid agent resolver claim/,
      );
      assert.equal(await fs.readFile(file, "utf8"), original);
    }));

test("failed claim publication cleans partial initialization and permits retry", async () =>
  withTempHome(async () => {
    const rename = vi.spyOn(fs, "rename").mockRejectedValueOnce(new Error("claim disk failure"));
    try {
      await assert.rejects(
        withStateDirectoryAccess(() => withAgentClaim(async () => {})),
        /claim disk failure/,
      );
    } finally {
      rename.mockRestore();
    }
    await withStateDirectoryAccess(() => withAgentClaim(async (assertOwner) => assertOwner()));
  }));

test("resolver retains the legacy state migration guard throughout inference", async () =>
  withTempHome(async (agentDir) => {
    await fs.mkdir(path.join(agentDir, ".pisync"), { recursive: true });
    await withStateDirectoryAccess(() =>
      withAgentClaim(async (assertOwner) => {
        assert.equal((await migrateLegacyStateDirectory()).status, "deferred");
        await assertOwner();
        await assert.rejects(fs.stat(path.join(agentDir, "pi-sync")), /ENOENT/);
      }),
    );
    assert.equal((await migrateLegacyStateDirectory()).status, "migrated");
  }));

test("claim owns private atomic candidates and releases after failures", async () =>
  withTempHome(async (agentDir) => {
    await withStateDirectoryAccess(async () => {
      await withAgentClaim(async (assertOwner) => {
        await assertOwner();
        await withLock("test-cache", () => saveAgentCandidate(key, { version: 1, results: [] }));
        assert.deepEqual(await readAgentCandidate(key), { version: 1, results: [] });
        await assert.rejects(
          withAgentClaim(async () => {}),
          /another local resolver/,
        );
      });
      await assert.rejects(
        withAgentClaim(async () => {
          throw new Error("failure");
        }),
        /failure/,
      );
      await withAgentClaim(async () => {});
    });
    assert.equal((await fs.stat(path.join(agentDir, "pi-sync/agent-resolver", `${key}.json`))).mode & 0o077, 0);
  }));

for (const failed of [false, true])
  test(`claim cleanup does not wait for an ordinary operation lock (failed=${failed})`, async () =>
    withTempHome(async (agentDir) => {
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      let ready!: () => void;
      const held = new Promise<void>((resolve) => {
        ready = resolve;
      });
      let operation: Promise<void> | undefined;
      try {
        await withStateDirectoryAccess(async () => {
          const result = withAgentClaim(async () => {
            operation = withLock("other-foreground-sync", async () => {
              ready();
              await gate;
            });
            await held;
            if (failed) throw new Error("original transfer failure");
            return "committed";
          });
          if (failed) await assert.rejects(result, /original transfer failure/);
          else assert.equal(await result, "committed");
          // The other transfer still holds its lock. Cleanup must already be complete.
          await assert.rejects(fs.stat(path.join(agentDir, "pi-sync/agent-resolver/claim.json")), /ENOENT/);
          release();
          await operation;
          await withAgentClaim(async (assertOwner) => assertOwner());
        });
      } finally {
        release();
        await operation;
      }
    }));

test("old owner cannot erase successor claim", async () =>
  withTempHome(async (agentDir) => {
    const claimPath = path.join(agentDir, "pi-sync/agent-resolver/claim.json");
    const successor = { version: 1, id: randomUUID(), pid: process.pid };
    await withStateDirectoryAccess(() =>
      withAgentClaim(async (assertOwner) => {
        await fs.writeFile(claimPath, JSON.stringify(successor), { mode: 0o600 });
        await assert.rejects(assertOwner(), /ownership changed/);
      }),
    );
    assert.deepEqual(JSON.parse(await fs.readFile(claimPath, "utf8")), successor);
  }));

test("malformed candidate and symlinked state fail closed without erasing evidence", async () =>
  withTempHome(async (agentDir) => {
    await withStateDirectoryAccess(() =>
      withAgentClaim(async () => {
        const record = path.join(agentDir, "pi-sync/agent-resolver", `${key}.json`);
        await fs.writeFile(record, "{broken", { mode: 0o600 });
        await assert.rejects(readAgentCandidate(key), /Unreadable/);
        await assert.rejects(saveAgentCandidate(key, { version: 1, results: [] }), /Unreadable/);
        assert.equal(await fs.readFile(record, "utf8"), "{broken");
      }),
    );
    await fs.rm(path.join(agentDir, "pi-sync/agent-resolver"), { recursive: true });
    const outside = path.join(agentDir, "outside");
    await fs.mkdir(outside);
    await fs.symlink(outside, path.join(agentDir, "pi-sync/agent-resolver"));
    await assert.rejects(
      withStateDirectoryAccess(() => withAgentClaim(async () => {})),
      /Unsafe/,
    );
    assert.deepEqual(await fs.readdir(outside), []);
  }));

test("separate processes exclude duplicate inference and reclaim only a dead owner", async () =>
  withTempHome(async (agentDir) => {
    await fs.mkdir(agentDir, { recursive: true });
    await ensureStateDir();
    const directory = path.resolve("node_modules/.cache/pi-sync-agent-process");
    await fs.mkdir(directory, { recursive: true });
    const output = path.join(directory, `${randomUUID()}.mjs`);
    await build({
      stdin: {
        contents: `import "./packages/pi-sync/test/engine-process-host.js";
          import { withAgentClaim } from "./packages/pi-sync/src/sync/agent-store.js";
          import { withStateDirectoryAccess } from "./packages/pi-sync/src/state/state-directory.js";
          await withStateDirectoryAccess(() => withAgentClaim(async () => {
            process.on("message", () => {});
            process.send({ ready: true });
            await new Promise(() => {});
          }));`,
        resolveDir: process.cwd(),
      },
      outfile: output,
      bundle: true,
      platform: "node",
      format: "esm",
      packages: "external",
      logLevel: "silent",
    });
    const child = fork(output, [], {
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
        child.once("exit", (code) => reject(new Error(`Child exited ${code}: ${stderr}`)));
      });
      // Timing-sensitive actions start only after the readiness handshake.
      await assert.rejects(
        withStateDirectoryAccess(() => withAgentClaim(async () => {})),
        /another local resolver/,
      );
      child.kill("SIGKILL");
      await exited;
      await withStateDirectoryAccess(() => withAgentClaim(async (assertOwner) => assertOwner()));
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await exited;
      await fs.rm(output, { force: true });
    }
  }));
