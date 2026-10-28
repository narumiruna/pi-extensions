import assert from "node:assert/strict";
import { type ChildProcess, fork } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, test } from "vitest";
import type { RestartRequest, RestartResult } from "./progress-restart-worker.js";

let root: string;
let children: ChildProcess[];

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "pi-progress-restart-"));
  children = [];
  // Cold imports/Jiti loading happen in the hook; each test starts after readiness.
  // No branch entries or extension state cross IPC, only a session file path.
  await Promise.all(
    Array.from({ length: 3 }, async () => {
      const child = fork(
        resolve("node_modules/.cache/pi-extensions-test/packages/pi-progress/test/progress-restart-worker.js"),
        [root],
        {
          env: { ...process.env, PI_CODING_AGENT_DIR: root },
          stdio: ["ignore", "pipe", "pipe", "ipc"],
        },
      );
      children.push(child);
      let diagnostics = "";
      child.stdout?.on("data", (chunk) => {
        diagnostics += chunk;
      });
      child.stderr?.on("data", (chunk) => {
        diagnostics += chunk;
      });
      await new Promise<void>((resolveReady, reject) => {
        const exit = () => reject(new Error(`Worker exited before ready: ${diagnostics}`));
        child.once("error", reject);
        child.once("exit", exit);
        child.once("message", (message) => {
          assert.deepEqual(message, { ready: true });
          child.off("exit", exit);
          resolveReady();
        });
      });
    }),
  );
});

afterEach(async () => {
  await Promise.all(
    children.map(async (child) => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      const closed = once(child, "close");
      child.kill();
      await closed;
    }),
  );
  await rm(root, { recursive: true, force: true });
});

async function request(child: ChildProcess | undefined, command: RestartRequest): Promise<RestartResult> {
  assert.ok(child);
  const closed = once(child, "close");
  const response = new Promise<RestartResult>((resolveResponse, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => {
      reject(new Error(`Worker exited before returning a result: ${code}`));
    });
    child.once("message", (message: { result?: RestartResult; error?: string }) => {
      if (message.error) reject(new Error(message.error));
      else if (message.result) resolveResponse(message.result);
      else reject(new Error("Missing worker result"));
    });
    child.send(command);
  });
  // Wait for a clean process exit before asking the next process to read the file.
  const [result, [code, signal]] = await Promise.all([response, closed]);
  assert.equal(code, 0);
  assert.equal(signal, null);
  return result;
}

for (const scenario of [
  { status: "completed", mode: "rpc", compacted: false },
  { status: "completed", mode: "tui", compacted: true },
  { status: "pending", mode: "rpc", compacted: true },
  { status: "in_progress", mode: "tui", compacted: false },
  { status: "blocked", mode: "rpc", compacted: false },
] as const) {
  test(`disk restart: ${scenario.status}, ${scenario.mode}, compacted=${scenario.compacted}`, async () => {
    const seeded = await request(children[0], { operation: "seed", ...scenario });
    const saved = await readFile(seeded.file, "utf8");
    const resumed = await request(children[1], { operation: "resume", file: seeded.file, ...scenario });
    assert.notEqual(resumed.pid, seeded.pid);
    assert.equal(resumed.file, seeded.file);
    assert.ok((await readFile(seeded.file, "utf8")).startsWith(saved));
    // A third fresh process must see the follow-up written by the resumed session.
    // It also reuses any restored context boundary persisted by the second process.
    const inspected = await request(children[2], { operation: "inspect", file: seeded.file, ...scenario });
    assert.notEqual(inspected.pid, resumed.pid);
    assert.notEqual(inspected.pid, seeded.pid);
  });
}
