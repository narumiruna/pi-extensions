import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, test, vi } from "vitest";
import { execWorkspaceCommand } from "../src/runtime/command.js";

vi.mock("node:child_process", () => ({ spawn: vi.fn() }));

afterEach(() => {
  vi.useRealTimers();
  vi.mocked(spawn).mockReset();
  vi.restoreAllMocks();
});

function command(maxOutputBytes: number, signal?: AbortSignal) {
  vi.useFakeTimers();
  const child = Object.assign(new EventEmitter(), {
    pid: undefined,
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: vi.fn(() => true),
  });
  vi.mocked(spawn).mockReturnValue(child as unknown as ReturnType<typeof spawn>);
  const removeAbortListener = signal ? vi.spyOn(signal, "removeEventListener") : undefined;
  const pending = execWorkspaceCommand("fixture-command", ["--version"], {
    cwd: "/workspace",
    timeout: 2_000,
    maxOutputBytes,
    environment: {},
    signal,
  });
  return { child, pending, removeAbortListener };
}

test.each(["stdout", "combined"] as const)(
  "workspace executor distinguishes exact-limit success from %s overflow",
  async (stream) => {
    for (const overflow of [false, true]) {
      const controller = new AbortController();
      const state = command(8, controller.signal);
      state.child.stdout.emit("data", Buffer.from("1234"));
      state.child[stream === "stdout" ? "stdout" : "stderr"].emit("data", Buffer.from(overflow ? "56789" : "5678"));
      // A zero exit after termination must not turn incomplete output into success.
      state.child.emit("close", 0);
      if (overflow) await vi.advanceTimersByTimeAsync(250);
      const result = await state.pending;
      assert.equal(result.truncated, overflow);
      assert.equal(result.killed, overflow);
      assert.equal(result.code, overflow ? 1 : 0);
      assert.equal(Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr), 8);
      assert.equal(result.stdout, stream === "stdout" ? "12345678" : "1234");
      assert.equal(result.stderr, stream === "stdout" ? "" : "5678");
      assert.equal(state.removeAbortListener?.mock.calls.length, 1);
      assert.equal(vi.getTimerCount(), 0);
      if (overflow) {
        assert.equal(state.child.stdout.destroyed, true);
        assert.equal(state.child.stderr.destroyed, true);
      }
    }
  },
);

test("workspace executor preserves UTF-8 characters split between complete output chunks", async () => {
  const state = command(64);
  const bytes = Buffer.from("v1.0.0 ✓");
  state.child.stdout.emit("data", bytes.subarray(0, bytes.length - 1));
  state.child.stdout.emit("data", bytes.subarray(bytes.length - 1));
  state.child.stderr.emit("data", Buffer.from("diagnostic"));
  state.child.emit("close", 0);
  assert.deepEqual(await state.pending, {
    stdout: "v1.0.0 ✓",
    stderr: "diagnostic",
    code: 0,
    killed: false,
    truncated: false,
  });
  assert.equal(vi.getTimerCount(), 0);
});

test("workspace executor preserves timeout and abort outcomes without marking them truncated", async () => {
  for (const reason of ["timeout", "abort"] as const) {
    const controller = new AbortController();
    const state = command(64, controller.signal);
    state.child.stdout.emit("data", Buffer.from("ready"));
    if (reason === "abort") controller.abort();
    else await vi.advanceTimersByTimeAsync(2_000);
    state.child.emit("close", 0);
    await vi.advanceTimersByTimeAsync(250);
    assert.deepEqual(await state.pending, {
      stdout: "ready",
      stderr: "",
      code: 1,
      killed: true,
      truncated: false,
    });
    assert.equal(state.removeAbortListener?.mock.calls.length, 1);
    assert.equal(state.child.stdout.destroyed, true);
    assert.equal(state.child.stderr.destroyed, true);
    assert.equal(vi.getTimerCount(), 0);
  }
});

test("workspace executor does not spawn an already cancelled command", async () => {
  const controller = new AbortController();
  controller.abort();
  const state = command(64, controller.signal);
  assert.deepEqual(await state.pending, { stdout: "", stderr: "", code: 1, killed: true, truncated: false });
  assert.equal(vi.mocked(spawn).mock.calls.length, 0);
  assert.equal(vi.getTimerCount(), 0);
});

test("workspace executor retains nonzero and spawn-error failures and removes owned listeners", async () => {
  for (const failure of ["nonzero", "spawn-event", "spawn-throw"] as const) {
    const controller = new AbortController();
    if (failure === "spawn-throw")
      vi.mocked(spawn).mockImplementationOnce(() => {
        throw new Error("spawn fixture-command ENOENT");
      });
    const state = command(64, controller.signal);
    if (failure === "nonzero") {
      state.child.stderr.emit("data", Buffer.from("command failed"));
      state.child.emit("close", 7);
    } else if (failure === "spawn-event") {
      state.child.emit("error", new Error("spawn fixture-command ENOENT"));
    }
    assert.deepEqual(await state.pending, {
      stdout: "",
      stderr: failure === "nonzero" ? "command failed" : "",
      code: failure === "nonzero" ? 7 : 1,
      killed: false,
      truncated: false,
    });
    // Synchronous spawn failure has no listener to remove.
    assert.equal(state.removeAbortListener?.mock.calls.length, failure === "spawn-throw" ? 0 : 1);
    assert.equal(vi.getTimerCount(), 0);
  }
});
