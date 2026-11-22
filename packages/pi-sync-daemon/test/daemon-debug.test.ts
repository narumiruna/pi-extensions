import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setImmediate } from "node:timers/promises";
import { test, vi } from "vitest";
import { createDaemonDebug } from "../src/daemon-debug.js";
import type { DebugEvent } from "../src/engine/debug-log.js";
import { DEBUG_LOG_FILENAME } from "../src/engine/paths.js";
import * as configFile from "../src/engine/settings/config-file.js";
import { validateSettingsDocument } from "../src/engine/settings/settings-validation.js";
import { createEngineService } from "../src/engine-service.js";
import { publishIdentity, runtimePaths } from "../src/identity.js";
import type { ClientFacts } from "../src/protocol.js";
import { withRpcServer } from "./rpc-server-fixture.js";

async function fixture(run: (root: string) => Promise<void>) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "pi-sync-debug-daemon-")));
  try {
    await run(root);
  } finally {
    await fs.rm((await runtimePaths(root)).directory, { recursive: true, force: true });
    await fs.rm(root, { recursive: true, force: true });
  }
}

const settings = (debug: unknown) => ({
  version: 3,
  onSwitch: "ask-before-pull",
  storageConnections: {},
  syncSetups: {},
  debug,
});

async function save(root: string, debug: unknown) {
  const temporary = path.join(root, `.${randomUUID()}.tmp`);
  await fs.writeFile(temporary, JSON.stringify(settings(debug)), { mode: 0o600 });
  await fs.rename(temporary, path.join(root, configFile.CONFIG_FILE_NAME));
}

async function events(root: string): Promise<DebugEvent[]> {
  const text = await fs.readFile(path.join(root, DEBUG_LOG_FILENAME), "utf8");
  return text
    .trimEnd()
    .split("\n")
    .map((line): DebugEvent => {
      const event = JSON.parse(line);
      assert.equal(event.source, "pi-sync-daemon");
      assert.equal(event.pid, process.pid);
      return event;
    });
}

function facts(root: string, hasUI: boolean): ClientFacts {
  return {
    id: randomUUID(),
    pid: process.pid,
    generation: randomUUID(),
    cwd: root,
    mode: hasUI ? "rpc" : "print",
    hasUI,
    startupDebug: hasUI,
    idle: true,
  };
}

test("only the published owner emits lifecycle records; initialization timing does not need an observable Pi", () =>
  fixture(async (root) => {
    await save(root, true);
    const service = createEngineService(root);
    const diagnostic = service.hooks.diagnostic;
    const loser = vi.fn(diagnostic);
    await withRpcServer(
      root,
      service.execute,
      async ({ server, createConnection }) => {
        server.recordBootOutcome("ready");
        await vi.waitFor(async () => {
          const entries = await events(root);
          assert.deepEqual(
            entries.filter((entry) => entry.event === "lifecycle").map(({ outcome }) => outcome),
            ["starting", "ready"],
          );
        });
        await assert.rejects(
          withRpcServer(
            root,
            async () => null,
            async () => {},
            { diagnostic: loser },
          ),
          /owner is still alive/u,
        );
        assert.equal(loser.mock.calls.length, 0);

        const foreground = await createConnection(facts(root, true), { callback: async () => true }).attach();
        await foreground.run("daemon.handover", {});
        await foreground.dispose();
        const observed = vi.fn();
        const passive = await createConnection(facts(root, false), {
          callback: async () => null,
          event: observed,
        }).attach();
        await passive.run("initialize", {});
        await vi.waitFor(async () => {
          const entries = await events(root);
          const timings = entries.filter((entry) => entry.event === "startup-timings");
          assert.equal(timings.length, 1);
          assert.match(timings[0].report, /^pi-sync debug: local initialization \(stopped\)/u);
          assert.ok(
            entries.some(
              (entry) => entry.event === "job" && entry.operation === "initialize" && entry.outcome === "completed",
            ),
          );
        });
        assert.ok(!observed.mock.calls.some(([event]) => event.kind === "timings"));
        await passive.dispose();
        await server.close();
        await vi.waitFor(async () => {
          const entries = await events(root);
          assert.deepEqual(
            entries.filter((entry) => entry.event === "lifecycle").map(({ outcome }) => outcome),
            ["starting", "ready", "drained"],
          );
        });
      },
      { diagnostic },
    );
  }));

test("the same owner samples settings at job boundaries and logs only fixed outcomes and opaque IDs", () =>
  fixture(async (root) => {
    await save(root, true);
    const sink = createDaemonDebug(root);
    const pending = new Set<Promise<unknown>>();
    const readSettings = configFile.readLocalConfigForDiagnostics;
    const spy = vi.spyOn(configFile, "readLocalConfigForDiagnostics").mockImplementation((root) => {
      const read = readSettings(root);
      pending.add(read);
      return read;
    });
    const diagnostic = vi.fn(sink);
    try {
      await withRpcServer(
        root,
        async (operation, _payload, execution) => {
          if (operation === "push") return "cancelled";
          if (operation === "pull") {
            execution.noteDebugOutcome?.("blocked");
            throw new Error("sensitive raw failure");
          }
          return "result";
        },
        async ({ createConnection }) => {
          const client = await createConnection(facts(root, true), { callback: async () => true }).attach();
          await client.run("push", {});
          await assert.rejects(client.run("pull", {}), /sensitive raw failure/u);
          await vi.waitFor(async () => {
            const job = (await events(root)).filter((entry) => entry.event === "job");
            assert.deepEqual(
              job.map(({ operation, outcome }) => [operation, outcome]),
              [
                ["push", "started"],
                ["push", "cancelled"],
                ["pull", "started"],
                ["pull", "blocked"],
              ],
            );
            assert.equal(job[0].operationId, job[1].operationId);
            assert.notEqual(job[0].operationId, job[2].operationId);
            assert.doesNotMatch(JSON.stringify(job), /sensitive/u);
          });

          for (const value of [false, "not a boolean"]) {
            await save(root, value);
            pending.clear();
            const before = await events(root);
            await client.run("status", {});
            await vi.waitFor(() => assert.ok(pending.size > 0));
            await Promise.allSettled(pending);
            await setImmediate();
            assert.deepEqual(await events(root), before);
          }

          await save(root, true);
          await client.run("history", {});
          await vi.waitFor(async () =>
            assert.ok(
              (await events(root)).some(
                (entry) => entry.event === "job" && entry.operation === "history" && entry.outcome === "completed",
              ),
            ),
          );
          assert.ok(diagnostic.mock.calls.some(([entry]) => entry.event === "job" && entry.operation === "status"));
        },
        { diagnostic },
      );
    } finally {
      spy.mockRestore();
    }
  }));

test("diagnostics reject stale reads before append and do not acquire settings locks", () =>
  fixture(async (root) => {
    assert.equal(await configFile.readLocalConfigForDiagnostics(root), undefined);
    assert.deepEqual(await fs.readdir(root), []);
    await save(root, true);
    const file = path.join(root, configFile.CONFIG_FILE_NAME);
    const snapshot = await configFile.readLocalConfigForDiagnostics(root);
    assert.ok(snapshot);
    assert.equal(validateSettingsDocument(snapshot.document.parsed).debug, true);
    assert.equal(snapshot.stillCurrent(), true);
    createEngineService(root);
    await configFile.withLockedLocalConfigDocument(async () => {
      const duringRead = await configFile.readLocalConfigForDiagnostics(root);
      assert.equal(duringRead?.stillCurrent(), true);
    });
    await fs.mkdir(`${file}.mutation-lock`);
    assert.equal(snapshot.stillCurrent(), false);
    await fs.rmdir(`${file}.mutation-lock`);

    const checked = Promise.withResolvers<void>();
    createDaemonDebug(root)({ event: "lifecycle", outcome: "ready" }, () => {
      writeFileSync(file, JSON.stringify(settings(false)));
      checked.resolve();
      return true;
    });
    await checked.promise;
    assert.throws(() => snapshot.stillCurrent());
    await assert.rejects(fs.access(path.join(root, DEBUG_LOG_FILENAME)), { code: "ENOENT" });
  }));

test("a queued lifecycle record cannot write after the current identity changes", () =>
  fixture(async (root) => {
    const diagnostic = vi.fn<(event: DebugEvent, current?: () => boolean) => void>();
    await withRpcServer(
      root,
      async () => null,
      async ({ server }) => {
        server.recordBootOutcome("ready");
        const ready = diagnostic.mock.calls.find(([event]) => event.event === "lifecycle" && event.outcome === "ready");
        assert.equal(ready?.[1]?.(), true);
        try {
          await publishIdentity(server.paths, { ...server.identity, token: "0".repeat(64) });
          assert.equal(ready?.[1]?.(), false);
        } finally {
          await publishIdentity(server.paths, server.identity);
        }
        assert.equal(ready?.[1]?.(), true);
        await server.close();
        assert.equal(ready?.[1]?.(), false);
      },
      { diagnostic },
    );
  }));
