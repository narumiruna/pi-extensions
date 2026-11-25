import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "vitest";
import { appendDebugEvent, type DebugEvent, debugJobResult, debugOperation } from "../src/engine/debug-log.js";
import { DEBUG_LOG_FILENAME } from "../src/engine/paths.js";

const operationId = "0123456789abcdef-01234567-89ab-4def-89ab-0123456789ab";
const event = { event: "job", operation: "sync", outcome: "completed", operationId } as const;

async function fixture(run: (root: string, target: string) => Promise<void>) {
  const root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), "pi-sync-debug-log-"));
  try {
    await run(root, path.join(root, DEBUG_LOG_FILENAME));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

test("the shared log permits only bounded diagnostic fields", () =>
  fixture(async (root, target) => {
    const report = [
      "pi-sync debug: daemon transfer (stopped)",
      "transfer local snapshot: 19.2 ms (3 calls) (interrupted)",
      "total: 40.2 ms",
    ].join("\n");
    assert.equal(debugOperation("settings.cas"), undefined);
    for (const bad of [
      `${report}\n`,
      report.replace("transfer local snapshot", "/private/token"),
      report.replace("19.2 ms", "access-key"),
      report.replace("daemon transfer", "attacker text"),
      "x".repeat(4097),
    ])
      assert.equal(appendDebugEvent(root, "pi-sync-daemon", { event: "startup-timings", report: bad }), false);
    assert.equal(
      appendDebugEvent(root, "pi-sync", { ...event, operation: "untrusted-command" } as unknown as DebugEvent),
      false,
    );
    await assert.rejects(fs.stat(target), { code: "ENOENT" });
    const extra = { ...event, secret: "do not persist", error: "do not persist" };
    assert.equal(appendDebugEvent(root, "pi-sync", extra), true);
    assert.equal(appendDebugEvent(root, "pi-sync-daemon", { event: "startup-timings", report }), true);
    assert.equal(
      appendDebugEvent(root, "pi-sync-daemon", {
        event: "continuous-cycle",
        outcome: "failed",
        reason: "do not persist",
      }),
      true,
    );
    assert.equal(appendDebugEvent(root, "pi-sync", { ...event, operationId: "do not persist" }), true);
    const bytes = await fs.readFile(target, "utf8");
    assert.doesNotMatch(bytes, /do not persist|access-key|untrusted-command/u);
    const records = bytes
      .trimEnd()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.equal(records.length, 4);
    for (const { pid, time } of records) {
      assert.equal(pid, process.pid);
      assert.ok(Number.isFinite(Date.parse(time)));
    }
    assert.equal(records[0].source, "pi-sync");
    assert.equal(records[0].operationId, operationId);
    assert.equal(records[1].source, "pi-sync-daemon");
    assert.equal(records[1].report, report);
    assert.equal(records[2].reason, undefined);
    assert.equal(records[3].operationId, undefined);
    if (process.platform !== "win32") assert.equal((await fs.stat(target)).mode & 0o777, 0o600);
  }));

test.each([
  ["push.foreground", { outcome: "applied", message: "private backup path" }, "completed"],
  ["pull.foreground", { outcome: "cancelled" }, "cancelled"],
  ["pull.foreground", { foregroundQueueCleanup: "resume-adoption", journal: "a".repeat(64) }, "blocked"],
  ["push.foreground", { foregroundQueueCleanup: "before-mutation" }, "blocked"],
  ["pull.foreground", { foregroundQueueCleanup: "verified-result", result: { outcome: "applied" } }, "completed"],
  ["push.foreground", { foregroundQueueCleanup: "verified-result", result: { outcome: "cancelled" } }, "cancelled"],
  ["pull.foreground", { foregroundQueueCleanup: "resume-adoption", journal: "invalid" }, "failed"],
  ["pull.foreground", { outcome: "unknown" }, "failed"],
  ["pull", "cancelled", "cancelled"],
  ["sync", { outcome: "applied" }, undefined],
] as const)("%s classifies %j for diagnostics as %s", (operation, result, outcome) => {
  assert.equal(debugJobResult(operation, result), outcome);
});

test("missing root or a directory at the log path does not interfere with sync", () =>
  fixture(async (root, target) => {
    const unset = path.join(root, "missing");
    assert.equal(appendDebugEvent(unset, "pi-sync", event), false);
    await assert.rejects(fs.stat(unset), { code: "ENOENT" });
    await fs.mkdir(target);
    assert.equal(appendDebugEvent(root, "pi-sync", event), false);
    assert.deepEqual(await fs.readdir(target), []);
  }));

test.skipIf(process.platform === "win32")("aliased and non-private log paths retain their prior contents", () =>
  fixture(async (root, target) => {
    const foreign = path.join(root, "foreign");
    await fs.writeFile(foreign, "preserve", { mode: 0o600 });
    await fs.symlink(foreign, target);
    assert.equal(appendDebugEvent(root, "pi-sync", event), false);
    await fs.unlink(target);
    await fs.link(foreign, target);
    assert.equal(appendDebugEvent(root, "pi-sync-daemon", event), false);
    await fs.unlink(target);
    assert.equal(await fs.readFile(foreign, "utf8"), "preserve");
    await fs.writeFile(target, "preserve", { mode: 0o644 });
    await fs.chmod(target, 0o644);
    assert.equal(appendDebugEvent(root, "pi-sync-daemon", event), false);
    assert.equal(await fs.readFile(target, "utf8"), "preserve");
    const alias = path.join(root, "alias");
    await fs.symlink(root, alias, "dir");
    assert.equal(appendDebugEvent(alias, "pi-sync", event), false);
    assert.equal(await fs.readFile(target, "utf8"), "preserve");
  }),
);

test("Pi and daemon processes append whole records to the same file", () =>
  fixture(async (root, target) => {
    const moduleUrl = pathToFileURL(path.resolve("packages/pi-sync-daemon/dist/engine/debug-log.js")).href;
    const code = `
      import { appendDebugEvent } from ${JSON.stringify(moduleUrl)};
      const [root, source] = process.argv.slice(1);
      process.once('message', () => {
        for (let i = 0; i < 25; i++)
          if (!appendDebugEvent(root, source, ${JSON.stringify(event)})) process.exitCode = 1;
        process.disconnect();
      });
      process.send('ready');
    `;
    const children = ["pi-sync", "pi-sync-daemon"].map((source) =>
      spawn(process.execPath, ["--input-type=module", "--eval", code, root, source], {
        stdio: ["ignore", "ignore", "inherit", "ipc"],
      }),
    );
    const exits = children.map((child) => once(child, "close"));
    try {
      const acknowledgements = await Promise.all(
        children.map((child, index) =>
          Promise.race([
            once(child, "message").then(([message]) => message),
            exits[index].then(([code]) => {
              throw new Error(`Log writer exited before readiness: ${code}`);
            }),
          ]),
        ),
      );
      assert.deepEqual(acknowledgements, ["ready", "ready"]);
      for (const child of children) child.send("write");
      assert.deepEqual(await Promise.all(exits), [
        [0, null],
        [0, null],
      ]);
      const records = (await fs.readFile(target, "utf8"))
        .trimEnd()
        .split("\n")
        .map((line) => JSON.parse(line));
      assert.equal(records.length, 50);
      for (const source of ["pi-sync", "pi-sync-daemon"]) {
        const received = records.filter((record) => record.source === source);
        assert.equal(received.length, 25);
        assert.ok(received.every((record) => record.operationId === operationId));
      }
    } finally {
      for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill();
      await Promise.allSettled(exits);
    }
  }));
