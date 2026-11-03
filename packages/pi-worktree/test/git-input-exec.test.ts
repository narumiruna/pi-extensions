import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { test, vi } from "vitest";
import { worktreeInventory } from "../src/git.js";
import { result } from "./command-test-support.js";

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }));
vi.mock("node:child_process", () => ({ spawn: spawnMock }));

const cap = 8 * 1024 * 1024;
const keepPath = "keep€.txt";
const dropPath = "drop.txt";

function inventoryExecutor(calls: string[]): Pick<ExtensionAPI, "exec"> {
  return {
    exec: async (_command, args, options) => {
      calls.push(args.join(" "));
      assert.equal(options?.maxBuffer, args[0] === "config" ? 64 * 1024 : cap);
      if (args[0] === "ls-files") return result(`S ${keepPath}\0S ${dropPath}\0`);
      if (args[0] === "config") return result("true\n");
      return result();
    },
  };
}

function startCheck(signal?: AbortSignal) {
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: vi.fn(() => true),
  });
  let markReady!: () => void;
  const ready = new Promise<void>((resolve) => {
    markReady = resolve;
  });
  spawnMock.mockImplementationOnce((command, args, options) => {
    assert.equal(command, "git");
    assert.deepEqual(args, ["sparse-checkout", "check-rules", "-z"]);
    assert.deepEqual(options, { cwd: "/repo", stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    queueMicrotask(markReady);
    return child;
  });
  const calls: string[] = [];
  const pending = worktreeInventory(inventoryExecutor(calls), "/repo", signal);
  return {
    child,
    ready,
    pending,
    calls,
    dispose() {
      child.stdin.destroy();
      child.stdout.destroy();
      child.stderr.destroy();
    },
  };
}

test("stdin Git checks preserve argv, input, split UTF-8, and sparse-managed results", async () => {
  vi.useFakeTimers();
  const controller = new AbortController();
  const removeListener = vi.spyOn(controller.signal, "removeEventListener");
  const check = startCheck(controller.signal);
  try {
    await check.ready;
    assert.equal(check.child.stdin.read()?.toString(), `${keepPath}\0${dropPath}\0`);
    const output = Buffer.from(`${keepPath}\0`);
    const split = output.indexOf(0xe2) + 1;
    check.child.stdout.write(output.subarray(0, split));
    check.child.stdout.write(output.subarray(split));
    const diagnostic = Buffer.from("diagnostic €");
    check.child.stderr.write(diagnostic.subarray(0, diagnostic.length - 1));
    check.child.stderr.write(diagnostic.subarray(diagnostic.length - 1));
    check.child.emit("close", 0, null);
    assert.deepEqual(await check.pending, [`index flag skip-worktree: ${keepPath}`]);
    assert.equal(check.child.kill.mock.calls.length, 0);
    assert.equal(vi.getTimerCount(), 0);
    assert.ok(removeListener.mock.calls.some(([event]) => event === "abort"));
  } finally {
    check.dispose();
  }
});

for (const stream of ["stdout", "stderr", "combined"] as const) {
  test(`stdin Git checks reject ${stream} overflow before parsing, timeout, or old-Git fallback`, async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const removeListener = vi.spyOn(controller.signal, "removeEventListener");
    const check = startCheck(controller.signal);
    try {
      await check.ready;
      if (stream === "combined") {
        const prefix = Buffer.from(`${keepPath}\0`);
        check.child.stdout.write(prefix);
        check.child.stderr.write(Buffer.alloc(cap - prefix.length, 0x61));
        check.child.stderr.write(Buffer.from("€"));
      } else {
        check.child[stream].write(Buffer.alloc(cap, 0x61));
        check.child[stream].write(Buffer.from("€"));
      }
      assert.equal(check.child.kill.mock.calls.length, 1);
      assert.equal(check.child.stdout.destroyed, true);
      assert.equal(check.child.stderr.destroyed, true);
      // A close code of zero must not make the partial result safe to consume.
      check.child.emit("close", 0, null);
      await assert.rejects(check.pending, /output exceeded the 8388608-byte limit/i);
      assert.equal(
        check.calls.some((call) => call.startsWith("submodule")),
        false,
      );
      assert.equal(vi.getTimerCount(), 0);
      assert.ok(removeListener.mock.calls.some(([event]) => event === "abort"));
    } finally {
      check.dispose();
    }
  });
}

for (const reason of ["timeout", "abort"]) {
  test(`stdin Git checks preserve ${reason} and release timer and signal listeners`, async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const removeListener = vi.spyOn(controller.signal, "removeEventListener");
    const check = startCheck(controller.signal);
    try {
      await check.ready;
      if (reason === "abort") controller.abort();
      else vi.advanceTimersByTime(15_000);
      assert.equal(check.child.kill.mock.calls.length, 1);
      check.child.emit("close", null, "SIGTERM");
      await assert.rejects(check.pending, /timed out or was cancelled/i);
      assert.equal(vi.getTimerCount(), 0);
      assert.ok(removeListener.mock.calls.some(([event]) => event === "abort"));
    } finally {
      check.dispose();
    }
  });
}

for (const code of ["ENOENT", "EACCES"]) {
  test(`stdin Git checks preserve ${code} spawn diagnostics and cleanup`, async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const removeListener = vi.spyOn(controller.signal, "removeEventListener");
    const check = startCheck(controller.signal);
    try {
      await check.ready;
      check.child.emit("error", Object.assign(new Error(`spawn git ${code}`), { code }));
      await assert.rejects(
        check.pending,
        code === "ENOENT" ? /Git executable was not found/i : /Could not start git.*EACCES/i,
      );
      assert.equal(check.child.kill.mock.calls.length, 1);
      assert.equal(vi.getTimerCount(), 0);
      assert.ok(removeListener.mock.calls.some(([event]) => event === "abort"));
      check.child.emit("close", 1, null);
      assert.equal(check.child.kill.mock.calls.length, 1, "repeated cleanup must not kill another process");
    } finally {
      check.dispose();
    }
  });
}

test("stdin Git checks retain index flags when older Git lacks check-rules", async () => {
  const check = startCheck();
  try {
    await check.ready;
    check.child.stdin.emit("error", Object.assign(new Error("write EPIPE"), { code: "EPIPE" }));
    check.child.stderr.write("unsupported command\n");
    check.child.emit("close", 129, null);
    assert.deepEqual(await check.pending, [
      `index flag skip-worktree: ${keepPath}`,
      `index flag skip-worktree: ${dropPath}`,
    ]);
    assert.equal(check.child.kill.mock.calls.length, 0);
  } finally {
    check.dispose();
  }
});

test("stdin Git checks do not spawn after cancellation", async () => {
  const controller = new AbortController();
  controller.abort();
  const spawnCalls = spawnMock.mock.calls.length;
  await assert.rejects(worktreeInventory(inventoryExecutor([]), "/repo", controller.signal), /cancelled/i);
  assert.equal(spawnMock.mock.calls.length, spawnCalls);
});
