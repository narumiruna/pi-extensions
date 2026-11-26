import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test, vi } from "vitest";
import { requestDaemon } from "../src/client.js";
import { privateDirectory, recordUpgradeOwner, runtimePaths, upgradeFile } from "../src/identity.js";
import type { ClientFacts, Execute } from "../src/protocol.js";
import type { ServerHooks } from "../src/server.js";
import { withRpcServer } from "./rpc-server-fixture.js";

async function fixture(execute: Execute, run: Parameters<typeof withRpcServer>[2], hooks?: ServerHooks) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "sync-guarded-upgrade-"));
  const paths = await runtimePaths(root);
  try {
    await privateDirectory(paths.directory);
    await withRpcServer(paths.root, execute, run, hooks);
  } finally {
    await fs.rm(paths.directory, { recursive: true, force: true });
    await fs.rm(root, { recursive: true, force: true });
  }
}

function clientFacts(cwd: string): ClientFacts {
  return { id: randomUUID(), generation: randomUUID(), pid: process.pid, cwd, mode: "rpc", hasUI: true, idle: true };
}

test.each(["review", "committed", "release"] as const)("guarded upgrade leaves %s work intact", (phase) => {
  const entered = Promise.withResolvers<void>();
  const finish = Promise.withResolvers<boolean>();
  const reservation = randomUUID();
  return fixture(
    async (_operation, _payload, execution) => {
      if (phase === "review") return execution.request("confirm", {});
      await execution.request("queue-acquire", { reservation });
      execution.committed();
      if (phase === "committed") {
        entered.resolve();
        await finish.promise;
      }
      return execution.request("queue-release", { reservation });
    },
    async ({ server, createConnection }) => {
      const client = await createConnection(clientFacts(server.paths.root), {
        callback: async ({ kind }) => {
          if (kind === "confirm" || (kind === "queue-release" && phase === "release")) {
            entered.resolve();
            return finish.promise;
          }
          return true;
        },
      }).attach();
      const job = client.run("fixture", {});
      void job.catch(() => {});
      try {
        await entered.promise;
        await recordUpgradeOwner(server.paths, server.identity);
        assert.deepEqual(await requestDaemon(server.paths, server.identity, "upgrade-stop", {}), { deferred: "busy" });
        assert.equal(server.closed, false);
      } finally {
        finish.resolve(true);
        assert.equal(await job, true);
      }
      await client.dispose();
      assert.deepEqual(await requestDaemon(server.paths, server.identity, "upgrade-stop", {}), { stopping: true });
      await assert.rejects(requestDaemon(server.paths, server.identity, "hello", {}));
    },
  );
});

test("the final guard rejects a stop if another admission is committing", () => {
  const entered = Promise.withResolvers<void>();
  const finish = Promise.withResolvers<void>();
  return fixture(
    async () => assert.fail("unexpected job"),
    async ({ server, createConnection }) => {
      const client = createConnection(clientFacts(server.paths.root), { callback: async () => false });
      const attach = client.attach();
      void attach.catch(() => {});
      try {
        await entered.promise;
        await recordUpgradeOwner(server.paths, server.identity);
        assert.deepEqual(await requestDaemon(server.paths, server.identity, "upgrade-stop", {}), { deferred: "busy" });
      } finally {
        finish.resolve();
        await attach;
      }
      assert.equal(client.contactState, "active");
    },
    {
      factsChanged: () => {
        entered.resolve();
        return finish.promise;
      },
    },
  );
});

test("new work during final validation cannot slip between the activity check and stop", () => {
  const checking = Promise.withResolvers<void>();
  const recheck = Promise.withResolvers<void>();
  const running = Promise.withResolvers<void>();
  const finish = Promise.withResolvers<void>();
  return fixture(
    async () => {
      running.resolve();
      await finish.promise;
    },
    async ({ server, createConnection }) => {
      const client = await createConnection(clientFacts(server.paths.root), { callback: async () => false }).attach();
      await recordUpgradeOwner(server.paths, server.identity);
      const open = fs.open.bind(fs);
      let checks = 0;
      const spy = vi.spyOn(fs, "open").mockImplementation(async (...args) => {
        if (args[0] === upgradeFile(server.paths) && ++checks === 2) {
          checking.resolve();
          await recheck.promise;
        }
        return open(...args);
      });
      const stop = requestDaemon(server.paths, server.identity, "upgrade-stop", {});
      void stop.catch(() => {});
      let job: Promise<unknown> | undefined;
      try {
        await Promise.race([checking.promise, stop.then(() => assert.fail("stop skipped the final check"))]);
        job = client.run("fixture", {});
        void job.catch(() => {});
        await running.promise;
        recheck.resolve();
        assert.deepEqual(await stop, { deferred: "busy" });
      } finally {
        spy.mockRestore();
        recheck.resolve();
        finish.resolve();
        await job;
        await stop.catch(() => {});
      }
      assert.equal(server.closed, false);
    },
  );
});

test("guarded upgrade rejects missing, wrong-purpose, or uncertain ownership evidence", () =>
  fixture(
    async () => assert.fail("unexpected job"),
    async ({ server }) => {
      const stop = () => requestDaemon(server.paths, server.identity, "upgrade-stop", {});
      await assert.rejects(stop(), /upgrade record changed/u);
      await recordUpgradeOwner(server.paths, { ...server.identity, purpose: "cleanup" });
      await assert.rejects(stop(), /upgrade record changed/u);
      await recordUpgradeOwner(server.paths, server.identity);
      assert.deepEqual(await stop(), { deferred: "repair" });
      assert.equal(server.closed, false);
    },
    { upgradeAllowed: () => false },
  ));

test("the owner rechecks unattended grants independently of the launcher", () =>
  fixture(
    async () => assert.fail("unexpected job"),
    async ({ server }) => {
      const { root } = server.paths;
      const state = path.join(root, "pi-sync");
      await fs.mkdir(state);
      const consent = JSON.stringify({
        version: 1,
        root,
        handover: true,
        nonce: "a".repeat(64),
        setups: { inactive: { fingerprint: "b".repeat(64), afterExit: true } },
      });
      const file = path.join(state, "daemon.json");
      await fs.writeFile(file, consent, { mode: 0o600 });
      await recordUpgradeOwner(server.paths, server.identity);
      assert.deepEqual(await requestDaemon(server.paths, server.identity, "upgrade-stop", {}), {
        deferred: "unattended",
      });
      assert.equal(await fs.readFile(file, "utf8"), consent);
      assert.equal(server.closed, false);
    },
  ));
