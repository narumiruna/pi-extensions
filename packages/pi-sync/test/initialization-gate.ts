import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { stopDaemon } from "@narumitw/pi-sync-daemon";

/** A real isolated engine paused before startup recovery, not a parent-process fs mock. */
export async function initializationGate(root: string) {
  assert.match(root, /\/tmp\//u);
  await stopDaemon(root);
  let ready!: () => void;
  let failReady!: (error: Error) => void;
  let entered!: () => void;
  let failEntered!: (error: Error) => void;
  const booted = new Promise<void>((resolve, reject) => {
    ready = resolve;
    failReady = reject;
  });
  const initializing = new Promise<void>((resolve, reject) => {
    entered = resolve;
    failEntered = reject;
  });
  void booted.catch(() => {});
  void initializing.catch(() => {});
  let stderr = "";
  const child = fork(new URL("../../pi-sync-daemon/test/fixtures/initialization-gate.mjs", import.meta.url), [root], {
    execArgv: [],
    stdio: ["ignore", "ignore", "pipe", "ipc"],
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      NODE_OPTIONS: process.env.NODE_OPTIONS,
      PI_CODING_AGENT_DIR: root,
      PI_OFFLINE: "1",
      PI_TELEMETRY: "0",
    },
  });
  child.stderr?.setEncoding("utf8").on("data", (value: string) => {
    stderr = (stderr + value).slice(-8192);
  });
  const fail = (error: Error) => {
    failReady(error);
    failEntered(error);
  };
  child.once("error", fail);
  const exited = new Promise<void>((resolve) =>
    child.once("close", (code, signal) => {
      fail(new Error(`Controlled engine exited (${code ?? signal}): ${stderr}`));
      resolve();
    }),
  );
  child.on("message", (message) => {
    if (typeof message !== "object" || message === null || !("type" in message)) return;
    if (message.type === "ready") ready();
    if (message.type === "initializing") entered();
  });
  const release = () => {
    if (child.connected) child.send({ type: "release" });
  };
  try {
    await booted;
  } catch (error) {
    release();
    child.disconnect();
    await exited;
    throw error;
  }
  return {
    initializing,
    release,
    async close() {
      release();
      await stopDaemon(root);
      await exited;
    },
  };
}
