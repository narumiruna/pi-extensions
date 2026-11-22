import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "vitest";
import { DaemonConnection, DaemonError, requestDaemon } from "../src/client.js";
import { engineHost } from "../src/engine/host.js";
import {
  daemonPaths,
  processExists,
  publishIdentity,
  readIdentity,
  readUpgradeOwner,
  runtimePaths,
} from "../src/identity.js";
import {
  type ClientFacts,
  type Execute,
  OWNERSHIP_CLEANUP_REQUIRED,
  operationPrefix,
  record,
} from "../src/protocol.js";
import { installServiceHost } from "../src/service-host.js";
import { withRpcServer } from "./rpc-server-fixture.js";

function facts(root: string): ClientFacts {
  return {
    id: randomUUID(),
    generation: randomUUID(),
    pid: process.pid,
    cwd: root,
    mode: "rpc",
    hasUI: true,
    idle: false,
  };
}

async function withRoot(run: (root: string) => Promise<void>) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "pi-sync-foreground-recovery-")));
  try {
    await run(root);
  } finally {
    await fs.rm((await runtimePaths(root)).directory, { recursive: true, force: true });
    await fs.rm(root, { recursive: true, force: true });
  }
}

for (const stage of ["before-mutation", "verified-result", "bookkeeping failed"] as const) {
  test(`foreground queue failure preserves the actual boundary: ${stage}`, () =>
    withRoot(async (root) => {
      const host = installServiceHost(root);
      const target = path.join(root, "notes.md");
      const backup = path.join(root, "backup.md");
      await fs.writeFile(target, "before");
      await fs.copyFile(target, backup);
      let applies = 0;
      let releases = 0;
      let bookkeeping = false;
      const execute: Execute = (_, __, execution) =>
        host.run(execution, () =>
          host.runForeground(execution, async () => {
            await engineHost().reserveTargets?.([target], async () => {
              applies++;
              await fs.writeFile(target, "after");
              execution.committed();
            });
            assert.equal(engineHost().root(), root);
            if (stage === "bookkeeping failed") throw new Error("Local baseline persistence failed.");
            bookkeeping = true;
            return { backup, result: "applied" };
          }),
        );
      await withRpcServer(
        root,
        execute,
        async ({ server, createConnection }) => {
          const connection = await createConnection(facts(root), {
            callback: async ({ kind }) => {
              if (kind === "queue-acquire") {
                if (stage === "before-mutation") throw new Error("Did not acquire the writer grant.");
                return randomUUID();
              }
              assert.equal(kind, "queue-release");
              releases++;
              return false;
            },
          }).attach();
          let job: string | undefined;
          const operation = connection.run("pull.foreground", {}, undefined, undefined, (id) => {
            job = id;
          });
          if (stage === "bookkeeping failed") {
            await assert.rejects(
              operation,
              (error) => error instanceof DaemonError && error.remote.properties?.code === OWNERSHIP_CLEANUP_REQUIRED,
            );
          } else {
            const result = await operation;
            assert.deepEqual(
              result,
              stage === "before-mutation"
                ? { foregroundQueueCleanup: "before-mutation" }
                : { foregroundQueueCleanup: "verified-result", result: { backup, result: "applied" } },
            );
          }
          assert.ok(job);
          assert.equal(host.cleanupRequired(), true);
          assert.equal(applies, stage === "before-mutation" ? 0 : 1);
          assert.equal(releases, 1);
          assert.equal(bookkeeping, stage === "verified-result");
          assert.equal(await fs.readFile(target, "utf8"), stage === "before-mutation" ? "before" : "after");
          assert.equal(await fs.readFile(backup, "utf8"), "before");
          assert.equal(await readUpgradeOwner(server.paths), undefined);
          if (stage !== "bookkeeping failed") {
            await assert.rejects(
              connection.recoverForeground(randomUUID(), new AbortController().signal),
              /could not verify a completed transfer/u,
            );
            const params = { check: true, job, client: connection.facts.id, generation: connection.facts.generation };
            assert.deepEqual(await requestDaemon(server.paths, server.identity, "foreground-stop", params), {
              eligible: true,
            });
            assert.equal(server.closed, false);
            assert.equal(await readUpgradeOwner(server.paths), undefined);
          } else {
            await assert.rejects(
              connection.recoverForeground(job, new AbortController().signal),
              /could not verify a completed transfer/u,
            );
          }
        },
        { foregroundRecoveryAllowed: () => true },
      );
    }));
}

for (const blocker of ["queued job", "live peer", "authorization"] as const) {
  test(`queue recovery does not stop a daemon with a ${blocker} blocker`, () =>
    withRoot(async (root) => {
      const entered = Promise.withResolvers<void>();
      const finish = Promise.withResolvers<void>();
      const hold = Promise.withResolvers<void>();
      let unrelatedFinished = false;
      await withRpcServer(
        root,
        async (operation) => {
          if (operation === "pull.foreground") {
            entered.resolve();
            await finish.promise;
            return { foregroundQueueCleanup: "before-mutation" };
          }
          assert.equal(operation, "hold");
          await hold.promise;
          unrelatedFinished = true;
        },
        async ({ server, createConnection }) => {
          const connection = await createConnection(facts(root), { callback: async () => true }).attach();
          if (blocker === "live peer") await createConnection(facts(root), { callback: async () => true }).attach();
          let job: string | undefined;
          const original = connection.run("pull.foreground", {}, undefined, undefined, (id) => {
            job = id;
          });
          try {
            await entered.promise;
            if (blocker === "queued job") {
              await requestDaemon(server.paths, server.identity, "submit", {
                client: connection.facts.id,
                id: `${operationPrefix(server.identity)}${randomUUID()}`,
                operation: "hold",
                payload: {},
              });
            }
            finish.resolve();
            await original;
            assert.ok(job);
            const reason =
              blocker === "queued job"
                ? /Another daemon operation/u
                : blocker === "live peer"
                  ? /Another live Pi session/u
                  : /authorization or ownership evidence/u;
            const result = (await requestDaemon(server.paths, server.identity, "foreground-stop", {
              check: true,
              job,
              client: connection.facts.id,
              generation: connection.facts.generation,
            })) as { blocked: string };
            assert.match(result.blocked, reason);
            assert.equal(server.closed, false);
            assert.equal(unrelatedFinished, false);
            assert.equal(await readUpgradeOwner(server.paths), undefined);
          } finally {
            finish.resolve();
            hold.resolve();
            await original.catch(() => {});
          }
        },
        { foregroundRecoveryAllowed: () => blocker !== "authorization" },
      );
      assert.equal(unrelatedFinished, blocker === "queued job");
    }));
}

const recoveryDaemon = `
const { startServer } = await import(process.argv[2]);
const server = await startServer(process.argv[1], async () => ({
  foregroundQueueCleanup: "verified-result", result: { message: "verified result" },
}), {
  foregroundRecoveryAllowed: () => true,
  stopped: () => process.send({ type: "stopped" }),
});
process.on("message", async (type) => {
  if (type === "close") await server.close();
  if (type === "exit") process.disconnect();
});
process.send({ type: "ready" });
`;

async function childMessage(child: ChildProcess, type: string) {
  for (;;) {
    const [value] = await once(child, "message");
    if (record(value) && value.type === type) return;
  }
}

for (const state of ["draining", "already exited", "changed identity"] as const) {
  test(`automatic queue recovery accepts only the observed process exit: ${state}`, () =>
    withRoot(async (root) => {
      const child = spawn(
        process.execPath,
        ["--input-type=module", "--eval", recoveryDaemon, root, new URL("../dist/server.js", import.meta.url).href],
        {
          stdio: ["ignore", "ignore", "inherit", "ipc"],
        },
      );
      const exit = once(child, "exit");
      let connection: DaemonConnection | undefined;
      try {
        await Promise.race([
          childMessage(child, "ready"),
          exit.then(() => {
            throw new Error("Recovery fixture did not start.");
          }),
        ]);
        const paths = await runtimePaths(root);
        const identity = await readIdentity(paths);
        assert.ok(identity);
        connection = await new DaemonConnection(daemonPaths(paths, identity.instance), identity, facts(root), {
          callback: async () => true,
        }).attach();
        let job: string | undefined;
        assert.deepEqual(
          await connection.run("pull.foreground", {}, undefined, undefined, (id) => {
            job = id;
          }),
          {
            foregroundQueueCleanup: "verified-result",
            result: { message: "verified result" },
          },
        );
        assert.ok(job);
        if (state === "changed identity") {
          await publishIdentity(paths, { ...identity, token: "f".repeat(64) });
          await assert.rejects(
            connection.recoverForeground(job, AbortSignal.timeout(3_000)),
            /owner changed or could not be verified/u,
          );
          assert.equal(processExists(identity.pid), true);
          assert.equal(await readUpgradeOwner(paths), undefined);
          await publishIdentity(paths, identity);
          return;
        }
        const stopped = childMessage(child, "stopped");
        if (state === "already exited") {
          child.send("close");
          await stopped;
          child.send("exit");
          await exit;
          await connection.recoverForeground(job, AbortSignal.timeout(3_000));
        } else {
          let finished = false;
          const recovery = connection.recoverForeground(job, AbortSignal.timeout(3_000)).finally(() => {
            finished = true;
          });
          void recovery.catch(() => {});
          await Promise.race([stopped, recovery]);
          assert.equal(await readIdentity(paths), undefined);
          assert.equal((await readUpgradeOwner(paths))?.purpose, "cleanup");
          assert.equal(processExists(identity.pid), true);
          assert.equal(finished, false);
          child.send("exit");
          await recovery;
          await exit;
        }
        assert.equal(processExists(identity.pid), false);
        assert.equal(await readUpgradeOwner(paths), undefined);
        await assert.rejects(
          connection.recoverForeground(job, AbortSignal.timeout(100)),
          /could not verify a completed transfer/u,
        );
      } finally {
        try {
          await connection?.dispose();
        } finally {
          if (child.exitCode === null && child.signalCode === null) child.kill();
          await exit;
        }
      }
    }));
}
