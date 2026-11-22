import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { DaemonConnection, ensureDaemon, findDaemon } from "@narumitw/pi-sync-daemon";
import { test, vi } from "vitest";
import { createMockContext, createMockPi } from "../../../test/support.js";
import { readClientDebug } from "./client-debug-records.js";
import { v3S3Settings, withTempHome } from "./helpers.js";

const emptyCatalog = { version: 3, onSwitch: "switch-only", storageConnections: {}, syncSetups: {} };

async function writeSettings(root: string, settings: Record<string, unknown>) {
  await fs.mkdir(root, { recursive: true });
  await fs.writeFile(path.join(root, "pi-sync.json"), JSON.stringify(settings));
}

test("local diagnostics latch on session start and keep existing bytes after an off reload", () =>
  withTempHome(async (root) => {
    await writeSettings(root, { ...emptyCatalog, debug: false });
    const { default: sync } = await import("../src/sync-extension.js");
    const mock = createMockPi();
    const { ctx, notifications } = createMockContext({ mode: "rpc" });
    sync(mock.pi);
    const start = (reason: string) => mock.events.get("session_start")?.[0]?.({ reason }, ctx);
    const shutdown = () => mock.events.get("session_shutdown")?.[0]?.({ reason: "reload" }, ctx);
    const file = path.join(root, "pi-sync.log");
    try {
      await start("startup");
      await writeSettings(root, { ...emptyCatalog, debug: true });
      await shutdown();
      await assert.rejects(fs.stat(file), { code: "ENOENT" });

      await start("reload");
      const records = await readClientDebug(root);
      assert.deepEqual(
        records.map((record) => record.event),
        ["job", "startup-timings"],
      );
      assert.deepEqual(records[0], {
        ...records[0],
        event: "job",
        operation: "initialize",
        outcome: "skipped",
      });
      const expected = records[1];
      assert.equal(expected?.event, "startup-timings");
      assert.match(expected.report, /^pi-sync debug: local initialization \(completed\)\nsettings read: /u);
      assert.equal(notifications.filter(({ message }) => message === expected.report).length, 1);
      assert.deepEqual(mock.sentMessages, []);

      await writeSettings(root, { ...emptyCatalog, debug: false });
      const before = await fs.readFile(file);
      await shutdown();
      await start("reload");
      assert.deepEqual(await fs.readFile(file), before);
      assert.equal(await findDaemon(root), undefined);
    } finally {
      await shutdown();
    }
  }));

test("an invalid settings document cannot opt in to client diagnostics", () =>
  withTempHome(async (root) => {
    await writeSettings(root, { ...emptyCatalog, debug: true, version: 99 });
    const { default: sync } = await import("../src/sync-extension.js");
    const mock = createMockPi();
    const { ctx, notifications } = createMockContext({ mode: "rpc" });
    sync(mock.pi);
    try {
      await mock.events.get("session_start")?.[0]?.({ reason: "startup" }, ctx);
      assert.equal(await findDaemon(root), undefined);
      await assert.rejects(fs.stat(path.join(root, "pi-sync.log")), { code: "ENOENT" });
      assert.equal(
        notifications.some(({ message }) => message.startsWith("pi-sync recovery required")),
        true,
      );
    } finally {
      await mock.events.get("session_shutdown")?.[0]?.({ reason: "reload" }, ctx);
    }
  }));

test("startup logs attach and handover-blocked submission with the daemon's own job ID", () =>
  withTempHome(async (root) => {
    await writeSettings(root, { ...v3S3Settings(), debug: true });
    const { default: sync } = await import("../src/sync-extension.js");
    const { piDaemonClient } = await import("../src/daemon/pi-client.js");
    const mock = createMockPi();
    const { ctx } = createMockContext({ mode: "rpc", cwd: root });
    sync(mock.pi);
    try {
      await mock.events.get("session_start")?.[0]?.({ reason: "startup" }, ctx);
      const records = await readClientDebug(root);
      assert.deepEqual(
        records.map((record) => record.event),
        ["connection", "startup-timings", "job", "job"],
      );
      const [connection] = records.filter((record) => record.event === "connection");
      assert.equal(connection?.outcome, "completed");
      const jobs = records.filter((record) => record.event === "job");
      assert.deepEqual(
        jobs.map(({ operation, outcome }) => [operation, outcome]),
        [
          ["initialize", "started"],
          ["initialize", "blocked"],
        ],
      );
      assert.match(jobs[0]?.operationId ?? "", /^[a-f0-9]{16}-[a-f0-9-]{36}$/u);
      assert.equal(jobs[1]?.operationId, jobs[0]?.operationId);
      await vi.waitFor(async () => {
        const raw = await fs.readFile(path.join(root, "pi-sync.log"), "utf8");
        const all = raw
          .trimEnd()
          .split("\n")
          .map((line) => JSON.parse(line) as { source: string; operationId?: string; outcome?: string });
        assert.ok(
          all.some(
            (record) =>
              record.source === "pi-sync-daemon" &&
              record.operationId === jobs[0]?.operationId &&
              record.outcome === "blocked",
          ),
        );
      });

      const client = piDaemonClient(ctx);
      await client.run("settings.read", {});
      const controller = new AbortController();
      controller.abort(new Error("private cancellation reason"));
      await assert.rejects(client.run("push", {}, controller.signal), /private cancellation reason/u);
      const after = await readClientDebug(root);
      assert.equal(after.length, records.length + 1);
      const cancelled = after.at(-1);
      assert.equal(cancelled?.event, "job");
      assert.equal(cancelled.outcome, "cancelled");
      assert.equal(cancelled.operationId, undefined);
      assert.doesNotMatch(await fs.readFile(path.join(root, "pi-sync.log"), "utf8"), /private cancellation reason/u);
    } finally {
      await mock.events.get("session_shutdown")?.[0]?.({ reason: "reload" }, ctx);
    }
  }));

test.each(["abort", "replace"] as const)("%s fences a pending request's late diagnostic", (boundary) =>
  withTempHome(async (root) => {
    await fs.mkdir(root, { recursive: true });
    await ensureDaemon(root);
    const { bindPiDaemonClient } = await import("../src/daemon/pi-client.js");
    const { ctx } = createMockContext({ mode: "rpc", cwd: root });
    const controller = new AbortController();
    const client = bindPiDaemonClient(ctx, controller.signal);
    client.setDebugPreference(true);
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const run = vi.spyOn(DaemonConnection.prototype, "run").mockImplementation(async () => {
      entered.resolve();
      await release.promise;
      throw new Error("late request with private details");
    });
    let replacement: typeof client | undefined;
    const result = assert.rejects(client.run("status", {}), /late request/u);
    try {
      await Promise.race([entered.promise, result.then(() => assert.fail("Request did not reach the transport."))]);
      const before = await readClientDebug(root);
      assert.equal(before.length, 1);
      if (boundary === "replace") replacement = bindPiDaemonClient(ctx, new AbortController().signal);
      else controller.abort();
      release.resolve();
      await result;
      assert.deepEqual(await readClientDebug(root), before);
    } finally {
      release.resolve();
      await result;
      run.mockRestore();
      await client.dispose();
      await replacement?.dispose();
    }
  }),
);
