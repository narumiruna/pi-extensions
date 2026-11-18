import assert from "node:assert/strict";
import { fork } from "node:child_process";
import path from "node:path";
import type { ClientFacts, JobView } from "@narumitw/pi-sync-daemon";

interface WireRecord {
  method: string;
  id?: string;
  operation?: string;
  facts?: ClientFacts;
  contact?: string;
  job?: Pick<JobView, "id" | "phase" | "error">;
  error?: { name: string; message: string };
}

export async function startObservableRpcOwner(agent: string, signal: AbortSignal) {
  signal.throwIfAborted();
  const child = fork(new URL("../../pi-sync-daemon/test/fixtures/rpc-daemon.mjs", import.meta.url), [agent], {
    cwd: agent,
    execArgv: [],
    stdio: ["ignore", "ignore", "pipe", "ipc"],
    env: {
      PATH: process.env.PATH,
      HOME: path.join(path.dirname(agent), "home"),
      PI_CODING_AGENT_DIR: agent,
      PI_OFFLINE: "1",
      PI_TELEMETRY: "0",
      NODE_COMPILE_CACHE: process.env.NODE_COMPILE_CACHE,
      NODE_DISABLE_COMPILE_CACHE: process.env.NODE_DISABLE_COMPILE_CACHE,
    },
  });
  let stderr = "";
  child.stderr?.setEncoding("utf8").on("data", (chunk: string) => {
    stderr = (stderr + chunk).slice(-4_096);
  });
  const ready = Promise.withResolvers<void>();
  type Reply = { id?: number; data?: unknown; error?: string; ready?: boolean };
  const pending = new Map<number, ReturnType<typeof Promise.withResolvers<unknown>>>();
  const fail = (error: Error) => {
    ready.reject(error);
    for (const waiter of pending.values()) waiter.reject(error);
  };
  child.on("error", fail);
  child.on("message", (reply: Reply) => {
    if (reply.ready) ready.resolve();
    if (reply.id === undefined) return;
    const waiter = pending.get(reply.id);
    if (reply.error) waiter?.reject(new Error(reply.error));
    else waiter?.resolve(reply.data);
  });
  const exited = new Promise<number | null>((resolve) => {
    child.once("close", (code, signal) => {
      fail(new Error(`Fixture daemon exited (${code ?? signal}): ${stderr}`));
      resolve(code);
    });
  });
  const cancelStartup = () => child.kill("SIGKILL");
  signal.addEventListener("abort", cancelStartup, { once: true });
  try {
    if (signal.aborted) cancelStartup();
    await ready.promise;
    signal.throwIfAborted();
  } catch (error) {
    cancelStartup();
    await exited;
    throw error;
  } finally {
    signal.removeEventListener("abort", cancelStartup);
  }

  let sequence = 0;
  async function control<T>(command: string, gate?: boolean) {
    const id = ++sequence;
    const waiter = Promise.withResolvers<unknown>();
    pending.set(id, waiter);
    const timer = setTimeout(() => waiter.reject(new Error(`Daemon ${command} deadline exceeded: ${stderr}`)), 3_000);
    try {
      child.send({ id, command, gate }, (error) => {
        if (error) waiter.reject(error);
      });
      return (await waiter.promise) as T;
    } finally {
      clearTimeout(timer);
      pending.delete(id);
    }
  }
  return {
    pid: child.pid,
    expire: (holdIdlePolls = false) => control<ClientFacts[]>("expire", holdIdlePolls),
    release: () => control<void>("release"),
    inspect: () => control<WireRecord[]>("inspect"),
    async stop() {
      const deadline = setTimeout(() => child.kill("SIGKILL"), 4_000);
      try {
        await control("stop");
        assert.equal(await exited, 0, stderr);
      } finally {
        clearTimeout(deadline);
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
        await exited;
      }
    },
  };
}
