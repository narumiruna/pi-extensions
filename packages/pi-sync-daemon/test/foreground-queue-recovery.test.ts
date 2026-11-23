import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test, vi } from "vitest";
import { DaemonConnection, DaemonError, requestDaemon } from "../src/client.js";
import * as transport from "../src/client-transport.js";
import { engineHost } from "../src/engine/host.js";
import * as ownerIdentity from "../src/identity.js";
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

test.each(["release after 4 seconds", "drain timeout"] as const)("same-job foreground drain: %s", (scenario) =>
  withRoot(async (root) => {
    const releaseStarted = Promise.withResolvers<void>();
    const release = Promise.withResolvers<boolean>();
    const cancelStarted = Promise.withResolvers<void>();
    const deadlines = new Map<AbortController, number>();
    const calls: { method: string; params: unknown }[] = [];
    let dispatches = 0;
    let job: string | undefined;
    const send = transport.requestDaemon;
    const fault = vi.spyOn(transport, "requestDaemon").mockImplementation(async (...args) => {
      const [, , method, params] = args;
      if (method === "submit" || method === "cancel" || (method === "poll" && record(params) && params.job))
        calls.push({ method, params });
      if (method === "poll" && record(params) && params.job) throw new Error("Lost job poll");
      if (method === "cancel") cancelStarted.resolve();
      const reply = await send(...args);
      return method === "attach" && record(reply) ? { ...reply, stateWait: undefined } : reply;
    });
    const clock = vi.spyOn(AbortSignal, "timeout").mockImplementation((ms) => {
      const controller = new AbortController();
      deadlines.set(controller, ms);
      return controller.signal;
    });
    try {
      await withRpcServer(
        root,
        async (_, __, execution) => {
          dispatches++;
          execution.committed();
          assert.equal(await execution.request("queue-release", {}), true);
          execution.signal.throwIfAborted();
          return "original result";
        },
        async ({ createConnection }) => {
          const connection = await createConnection(facts(root), {
            callback: async () => {
              releaseStarted.resolve();
              return release.promise;
            },
          }).attach();
          const original = connection.run("pull.foreground", {}, undefined, undefined, (id) => {
            job = id;
          });
          try {
            await Promise.race([
              Promise.all([releaseStarted.promise, cancelStarted.promise]),
              original.then(() => assert.fail("Job completed before the drain started.")),
            ]);
            const elapsed = scenario === "drain timeout" ? 30_000 : 4_000;
            for (const [controller, timeout] of deadlines)
              if (timeout <= elapsed) controller.abort(new DOMException("Test deadline", "TimeoutError"));
            if (scenario === "drain timeout") {
              await assert.rejects(original, /transfer result could not be verified/u);
              assert.equal(connection.hasPendingWork, true);
              await assert.rejects(connection.run("pull.foreground", {}), /unavailable/u);
            } else {
              release.resolve(true);
              assert.equal(await original, "original result");
              assert.equal(connection.hasPendingWork, false);
            }
            assert.equal(dispatches, 1);
            assert.ok(job);
            const expected = { client: connection.facts.id, id: job };
            assert.deepEqual(
              calls.map(({ method }) => method),
              ["submit", "poll", "poll", "cancel"],
            );
            assert.deepEqual(calls.at(-1)?.params, expected);
            assert.deepEqual(calls[0]?.params, { ...expected, operation: "pull.foreground", payload: {} });
            for (const call of calls.slice(1, 3)) {
              assert.ok(record(call.params));
              assert.equal(call.params.job, job);
              assert.equal(call.params.client, connection.facts.id);
            }
          } finally {
            release.resolve(true);
            await original.catch(() => {});
          }
        },
      );
    } finally {
      clock.mockRestore();
      fault.mockRestore();
    }
  }),
);

test.each(["before-mutation", "verified-result"] as const)(
  "queue recovery blocks already accepted work without hiding the %s result",
  (stage) =>
    withRoot(async (root) => {
      const entered = Promise.withResolvers<void>();
      const finish = Promise.withResolvers<void>();
      const result =
        stage === "before-mutation"
          ? { foregroundQueueCleanup: stage }
          : { foregroundQueueCleanup: stage, result: "original" };
      const dispatches: string[] = [];
      await withRpcServer(
        root,
        async (operation, _, execution) => {
          dispatches.push(operation);
          if (operation !== "pull.foreground") return "unexpected dispatch";
          if (stage === "verified-result") execution.committed();
          entered.resolve();
          await finish.promise;
          return result;
        },
        async ({ server: { paths, identity }, createConnection }) => {
          const connection = await createConnection(facts(root), { callback: async () => true }).attach();
          const client = connection.facts.id;
          const queued = `${operationPrefix(identity)}${randomUUID()}`;
          let job: string | undefined;
          const original = connection.run("pull.foreground", {}, undefined, undefined, (id) => {
            job = id;
          });
          try {
            await entered.promise;
            assert.deepEqual(
              await requestDaemon(paths, identity, "submit", { client, id: queued, operation: "queued", payload: {} }),
              { id: queued, phase: "queued" },
            );
            finish.resolve();
            assert.deepEqual(await original, result);
            assert.ok(job);
            await vi.waitFor(async () => {
              const reply = await requestDaemon(paths, identity, "poll", { client, cursor: 0, job: queued });
              assert.ok(record(reply) && record(reply.job) && record(reply.job.error));
              assert.equal(reply.job.phase, "failed");
              assert.deepEqual(reply.job.error.properties, { code: OWNERSHIP_CLEANUP_REQUIRED });
            });
            assert.deepEqual(dispatches, ["pull.foreground"]);
            const polled = await requestDaemon(paths, identity, "poll", { client, cursor: 0, job });
            assert.ok(record(polled));
            assert.deepEqual(polled.job, { id: job, phase: "done", result });
            assert.deepEqual(
              await requestDaemon(paths, identity, "submit", {
                client,
                id: job,
                operation: "pull.foreground",
                payload: {},
              }),
              { id: job, phase: "done", result },
            );
            await assert.rejects(
              requestDaemon(paths, identity, "submit", {
                client,
                id: `${operationPrefix(identity)}${randomUUID()}`,
                operation: "new",
                payload: {},
              }),
              (error) => error instanceof DaemonError && error.remote.properties?.code === OWNERSHIP_CLEANUP_REQUIRED,
            );
            assert.deepEqual(
              await requestDaemon(paths, identity, "foreground-stop", {
                check: true,
                job,
                client,
                generation: connection.facts.generation,
              }),
              { eligible: true },
            );
          } finally {
            finish.resolve();
            await original.catch(() => {});
          }
        },
        { foregroundRecoveryAllowed: () => true },
      );
    }),
);

for (const blocker of ["live peer", "authorization"] as const) {
  test(`queue recovery does not stop a daemon with a ${blocker} blocker`, () =>
    withRoot(async (root) => {
      const entered = Promise.withResolvers<void>();
      const finish = Promise.withResolvers<void>();
      await withRpcServer(
        root,
        async (operation) => {
          assert.equal(operation, "pull.foreground");
          entered.resolve();
          await finish.promise;
          return { foregroundQueueCleanup: "before-mutation" };
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
            finish.resolve();
            await original;
            assert.ok(job);
            const reason =
              blocker === "live peer" ? /Another live Pi session/u : /authorization or ownership evidence/u;
            const result = (await requestDaemon(server.paths, server.identity, "foreground-stop", {
              check: true,
              job,
              client: connection.facts.id,
              generation: connection.facts.generation,
            })) as { blocked: string };
            assert.match(result.blocked, reason);
            assert.equal(server.closed, false);
            assert.equal(await readUpgradeOwner(server.paths), undefined);
          } finally {
            finish.resolve();
            await original.catch(() => {});
          }
        },
        { foregroundRecoveryAllowed: () => blocker !== "authorization" },
      );
    }));
}

const recoveryDaemon = `
const { startServer } = await import(process.argv[2]);
const drain = Promise.withResolvers();
const server = await startServer(process.argv[1], async () => ({
  foregroundQueueCleanup: "verified-result", result: { message: "verified result" },
}), {
  foregroundRecoveryAllowed: () => true,
  close: () => process.argv[3] === "hold-close" ? drain.promise : Promise.resolve(),
  stopped: () => process.send({ type: "stopped" }),
});
process.on("message", async (type) => {
  if (type === "drain") drain.resolve();
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

for (const state of [
  "draining",
  "already exited",
  "changed identity",
  "lost reply",
  "lost reply cancelled",
  "lost reply with changed identity",
] as const) {
  test(`automatic queue recovery accepts only the observed process exit: ${state}`, () =>
    withRoot(async (root) => {
      const child = spawn(
        process.execPath,
        [
          "--input-type=module",
          "--eval",
          recoveryDaemon,
          root,
          new URL("../dist/server.js", import.meta.url).href,
          ...(state.startsWith("lost reply") ? ["hold-close"] : []),
        ],
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
        if (state.startsWith("lost reply")) {
          const send = transport.requestDaemon;
          let stopRequests = 0;
          let stopReply: unknown;
          const fault = vi.spyOn(transport, "requestDaemon").mockImplementation(async (...args) => {
            const [, , method, params] = args;
            if (method !== "foreground-stop" || !record(params) || params.check === true) return send(...args);
            stopRequests++;
            stopReply = await send(...args);
            if (state === "lost reply with changed identity")
              await publishIdentity(paths, { ...identity, token: "f".repeat(64) });
            throw new Error("Lost authenticated stop reply");
          });
          const checked = Promise.withResolvers<boolean>();
          const exited = ownerIdentity.processExited;
          const observer = vi.spyOn(ownerIdentity, "processExited").mockImplementation(async (...args) => {
            const value = await exited(...args);
            checked.resolve(value);
            return value;
          });
          const cancellation = new AbortController();
          const recovering = connection.recoverForeground(
            job,
            AbortSignal.any([cancellation.signal, AbortSignal.timeout(3_000)]),
          );
          try {
            if (state === "lost reply with changed identity") {
              await assert.rejects(recovering, /owner changed during recovery/u);
            } else {
              assert.equal(
                await Promise.race([
                  checked.promise,
                  recovering.then(() => assert.fail("Recovery finished before checking the recorded process.")),
                ]),
                false,
              );
              assert.deepEqual(await readIdentity(paths), identity);
              if (state === "lost reply cancelled") {
                const reason = new DOMException("Recovery cancelled", "AbortError");
                cancellation.abort(reason);
                await assert.rejects(
                  recovering,
                  (error) =>
                    error === reason ||
                    (error instanceof Error && error.name === "AbortError" && error.cause === reason),
                );
              } else {
                child.send("drain");
                await Promise.race([stopped, recovering]);
                assert.equal(await readIdentity(paths), undefined);
                assert.equal((await readUpgradeOwner(paths))?.purpose, "cleanup");
                child.send("exit");
                await recovering;
                await exit;
              }
            }
            assert.equal(stopRequests, 1);
            assert.deepEqual(stopReply, { stopping: true });
            if (state !== "lost reply") {
              assert.equal((await readUpgradeOwner(paths))?.purpose, "cleanup");
              assert.equal(processExists(identity.pid), true);
              await assert.rejects(
                connection.recoverForeground(job, AbortSignal.timeout(100)),
                /could not verify a completed transfer/u,
              );
              return;
            }
          } finally {
            cancellation.abort();
            await recovering.catch(() => {});
            fault.mockRestore();
            observer.mockRestore();
            if (state === "lost reply with changed identity") await publishIdentity(paths, identity);
          }
        } else if (state === "already exited") {
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
