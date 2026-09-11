import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, test, vi } from "vitest";
import {
  buildPiArgs,
  childCommunicationBridgePath,
  resolveTimeoutMs,
  runChild,
  terminateWindowsProcessTree,
} from "../src/process.js";
import type { ChildControl, ChildRequest } from "../src/types.js";

let directory: string;
let previousPackageDirectory: string | undefined;
let previousExecPath: string;
let previousBunVersion: string | undefined;

beforeEach(() => {
  directory = mkdtempSync(path.join(os.tmpdir(), "pi-subagents-process-"));
  previousPackageDirectory = process.env.PI_PACKAGE_DIR;
  previousExecPath = process.execPath;
  previousBunVersion = process.versions.bun;
});

afterEach(() => {
  if (previousPackageDirectory === undefined) delete process.env.PI_PACKAGE_DIR;
  else process.env.PI_PACKAGE_DIR = previousPackageDirectory;
  process.execPath = previousExecPath;
  if (previousBunVersion === undefined) delete process.versions.bun;
  else process.versions.bun = previousBunVersion;
  rmSync(directory, { recursive: true, force: true });
  vi.useRealTimers();
  vi.restoreAllMocks();
});

test("buildPiArgs isolates the RPC child and preserves selected communication tools", () => {
  const args = buildPiArgs(childRequest());
  assert.deepEqual(args.slice(0, 7), [
    "--mode",
    "rpc",
    "--no-session",
    "--no-extensions",
    "--no-skills",
    "--no-prompt-templates",
    "-e",
  ]);
  assert.equal(args[7], childCommunicationBridgePath());
  assert.equal(args[args.indexOf("--model") + 1], "test-provider/test-model");
  assert.equal(args[args.indexOf("--thinking") + 1], "medium");
  assert.ok(args.includes("--no-approve"));
  assert.equal(args[args.indexOf("--tools") + 1], "read,grep,find,ls,subagent_send,subagent_wait");
  assert.doesNotMatch(args.join(" "), /\bbash\b|\bwrite\b|append-system-prompt/u);
  assert.equal(args.includes("Task: task"), false);

  const writable = buildPiArgs(
    childRequest({
      tools: ["read", "bash", "write", "subagent_send", "subagent_wait"],
      thinkingLevel: "xhigh",
      projectTrusted: true,
    }),
  );
  assert.ok(writable.includes("--approve"));
  assert.equal(writable[writable.indexOf("--thinking") + 1], "xhigh");
  assert.equal(writable[writable.indexOf("--tools") + 1], "read,bash,write,subagent_send,subagent_wait");

  const noWorkTools = buildPiArgs(childRequest({ tools: [] }));
  assert.equal(noWorkTools[noWorkTools.indexOf("--tools") + 1], "subagent_send,subagent_wait");
});

test("runChild uses a bundled Pi executable when its manifest CLI is absent", async () => {
  installFakePi(
    `
async function handle(command) {
  if (command.type !== "prompt") return;
  respond(command);
  event(message("bundled Pi child completed"));
  event({ type: "agent_settled" });
}
`,
    { bundled: true },
  );

  const result = await runChild(childRequest());
  assert.equal(result.state, "completed");
  assert.equal(result.result, "bundled Pi child completed");
});

test("runChild classifies completed and partial RPC output", async () => {
  installFakePi(`
async function handle(command) {
  if (command.type !== "prompt") return;
  respond(command);
  if (command.message.includes("partial")) {
    event(message("partial evidence", "error"));
    console.error("child failed");
  } else {
    event(message("completed evidence"));
  }
  event({ type: "agent_settled" });
}
`);
  const completed = await runChild(childRequest({ task: "complete" }));
  assert.equal(completed.state, "completed");
  assert.equal(completed.result, "completed evidence");

  const partial = await runChild(childRequest({ task: "partial" }));
  assert.equal(partial.state, "partial");
  assert.equal(partial.result, "partial evidence");
  assert.match(partial.error ?? "", /child failed/);
});

test("runChild requires a settled terminal result and preserves incomplete evidence", async () => {
  installFakePi(`
async function handle(command) {
  if (command.type !== "prompt") return;
  respond(command);
  if (command.message.includes("length")) event(message("cut-off evidence", "length"));
  else if (command.message.includes("nonterminal")) event(message("intermediate evidence", "toolUse"));
  else process.stdout.write("{malformed\\n");
  event({ type: "agent_settled" });
}
`);
  const lengthLimited = await runChild(childRequest({ task: "length" }));
  assert.equal(lengthLimited.state, "partial");
  assert.equal(lengthLimited.result, "cut-off evidence");
  assert.match(lengthLimited.error ?? "", /model limit/i);
  assert.match(lengthLimited.limitations.join("\n"), /model output limit/i);

  const nonterminal = await runChild(childRequest({ task: "nonterminal" }));
  assert.equal(nonterminal.state, "partial");
  assert.equal(nonterminal.result, "intermediate evidence");
  assert.match(nonterminal.error ?? "", /without a terminal assistant result/i);

  const missing = await runChild(childRequest({ task: "missing" }));
  assert.equal(missing.state, "failed");
  assert.match(missing.error ?? "", /without a terminal assistant result/i);
  assert.match(missing.limitations.join("\n"), /malformed/i);
});

test("runChild ignores an oversized RPC event and preserves later terminal output", async () => {
  installFakePi(`
async function handle(command) {
  if (command.type !== "prompt") return;
  respond(command);
  process.stdout.write("x".repeat(256 * 1024 + 1) + "\\n");
  event(message("usable output"));
  event({ type: "agent_settled" });
}
`);
  const result = await runChild(childRequest());
  assert.equal(result.state, "completed");
  assert.equal(result.result, "usable output");
  assert.match(result.limitations.join("\n"), /malformed or oversized/i);
});

test("runChild exposes RPC steering only after prompt acceptance", async () => {
  installFakePi(`
async function handle(command) {
  if (command.type === "prompt") {
    respond(command);
    return;
  }
  if (command.type === "steer") {
    respond(command);
    event(message("answered: " + command.message));
    event({ type: "agent_settled" });
  }
}
`);
  let resolveControl!: (control: ChildControl) => void;
  const controlReady = new Promise<ChildControl>((resolve) => {
    resolveControl = resolve;
  });
  const work = runChild(childRequest({ onControl: resolveControl }));
  const control = await controlReady;
  await control.send("question from main");
  const result = await work;
  assert.equal(result.state, "completed");
  assert.equal(result.result, "answered: question from main");
  await assert.rejects(() => control.send("late"), /no longer accepting|no longer active/i);
});

test("runChild surfaces an RPC steering rejection without terminating accepted work", async () => {
  installFakePi(`
async function handle(command) {
  if (command.type === "prompt") {
    respond(command);
    return;
  }
  if (command.type === "steer") {
    respond(command, false, "steer rejected");
  }
}
`);
  const controller = new AbortController();
  let resolveControl!: (control: ChildControl) => void;
  const controlReady = new Promise<ChildControl>((resolve) => {
    resolveControl = resolve;
  });
  const work = runChild(childRequest({ signal: controller.signal, onControl: resolveControl }));
  const control = await controlReady;
  await assert.rejects(() => control.send("question"), /steer rejected/i);
  controller.abort();
  assert.equal((await work).state, "cancelled");
});

test("runChild rejects asynchronous RPC stdin write errors without an unhandled error", async () => {
  installFakePi(`
async function handle(command) {
  if (command.type !== "prompt") return;
  process.stdin.on("error", () => undefined);
  fs.closeSync(0);
  respond(command);
}
setInterval(() => {}, 1000);
`);
  const controller = new AbortController();
  let resolveControl!: (control: ChildControl) => void;
  const controlReady = new Promise<ChildControl>((resolve) => {
    resolveControl = resolve;
  });
  const work = runChild(childRequest({ signal: controller.signal, onControl: resolveControl }));
  const control = await controlReady;
  await assert.rejects(() => control.send("question after stdin closed"), /EPIPE|stdin|write/iu);
  controller.abort();
  assert.equal((await work).state, "cancelled");
});

test("runChild aborts an in-flight RPC steering command", async () => {
  installFakePi(`
async function handle(command) {
  if (command.type === "prompt") respond(command);
}
setInterval(() => {}, 1000);
`);
  const processController = new AbortController();
  let resolveControl!: (control: ChildControl) => void;
  const controlReady = new Promise<ChildControl>((resolve) => {
    resolveControl = resolve;
  });
  const work = runChild(childRequest({ signal: processController.signal, onControl: resolveControl }));
  const control = await controlReady;
  const sendController = new AbortController();
  const pending = control.send("unacknowledged question", sendController.signal);
  sendController.abort();
  await assert.rejects(pending, (error: Error) => error.name === "AbortError");
  processController.abort();
  assert.equal((await work).state, "cancelled");
});

test("runChild bounds child result text below the complete tool-output budget", async () => {
  installFakePi(`
async function handle(command) {
  if (command.type !== "prompt") return;
  respond(command);
  event(message("x".repeat(40 * 1024)));
  event({ type: "agent_settled" });
}
`);
  const result = await runChild(childRequest());
  assert.equal(result.state, "completed");
  assert.equal(result.truncated, true);
  assert.ok(Buffer.byteLength(result.result ?? "", "utf8") <= 32 * 1024);
  assert.match(result.limitations.join("\n"), /truncated/i);
});

test("passes broker credentials through a private descriptor outside the initial environment", async () => {
  installFakePi(`
async function handle(command) {
  if (command.type !== "prompt") return;
  respond(command);
  const initialEnvironment = process.platform === "linux"
    ? fs.readFileSync("/proc/self/environ")
    : Buffer.from(Object.entries(process.env).map(([key, value]) => key + "=" + value).join("\\0"));
  const text = JSON.stringify({
    credentialsReceived: brokerCredentials.host === "127.0.0.1" && brokerCredentials.port === 31337,
    initialEnvironmentContainsToken: initialEnvironment.includes(Buffer.from(brokerCredentials.token)),
    descriptorMarker: process.env.PI_SUBAGENT_BROKER_FD,
  });
  event(message(text));
  event({ type: "agent_settled" });
}
`);
  const result = await runChild(childRequest());
  assert.equal(result.state, "completed");
  assert.deepEqual(JSON.parse(result.result ?? "{}"), {
    credentialsReceived: true,
    initialEnvironmentContainsToken: false,
    descriptorMarker: "3",
  });
});

test("handles late credential-pipe errors after child launch failure", async () => {
  installFakePi("async function handle() {}\n");
  const removedCwd = path.join(directory, "removed-cwd");
  mkdirSync(removedCwd);
  rmSync(removedCwd, { recursive: true });

  const result = await runChild(childRequest({ cwd: removedCwd }));
  assert.equal(result.state, "failed");
  assert.match(result.error ?? "", /ENOENT|not found/iu);
  await new Promise<void>((resolve) => setImmediate(resolve));
});

test("resolves optional execution timeouts with Pi bash semantics", () => {
  assert.equal(resolveTimeoutMs(undefined), undefined);
  assert.equal(resolveTimeoutMs(0.025), 25);
  assert.equal(resolveTimeoutMs(2_147_483.647), 2_147_483_647);
  assert.throws(() => resolveTimeoutMs(0), /finite number of seconds/);
  assert.throws(() => resolveTimeoutMs(Number.POSITIVE_INFINITY), /finite number of seconds/);
  assert.throws(() => resolveTimeoutMs(2_147_483.648), /maximum is 2147483\.647 seconds/);
});

test("runChild starts its deadline after RPC readiness and honors cancellation", async () => {
  installFakePi(`
async function handle(command) {
  if (command.type === "prompt") respond(command);
}
setInterval(() => {}, 1000);
`);
  let timeoutReady!: (control: ChildControl) => void;
  const timedOut = runChild(
    childRequest({
      timeout: 0.025,
      onControl: (control) => timeoutReady(control),
    }),
  );
  await new Promise<ChildControl>((resolve) => {
    timeoutReady = resolve;
  });
  assert.equal((await timedOut).state, "timed_out");

  const controller = new AbortController();
  let cancelReady!: (control: ChildControl) => void;
  const work = runChild(
    childRequest({
      signal: controller.signal,
      onControl: (control) => cancelReady(control),
    }),
  );
  await new Promise<ChildControl>((resolve) => {
    cancelReady = resolve;
  });
  controller.abort();
  assert.equal((await work).state, "cancelled");
});

test("runChild reuses one termination flow when timeout and cancellation race", {
  skip: process.platform === "win32",
}, async () => {
  installFakePi(`
process.on("SIGTERM", () => undefined);
async function handle(command) {
  if (command.type === "prompt") respond(command);
}
setInterval(() => {}, 1000);
`);
  const signals: Array<string | number | undefined> = [];
  const originalKill = process.kill.bind(process);
  vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
    if (pid < 0) signals.push(signal);
    return originalKill(pid, signal);
  });
  const controller = new AbortController();
  let resolveControl!: (control: ChildControl) => void;
  const ready = new Promise<ChildControl>((resolve) => {
    resolveControl = resolve;
  });
  const work = runChild(childRequest({ signal: controller.signal, timeout: 0.05, onControl: resolveControl }));
  await ready;
  setTimeout(() => controller.abort(), 60);
  const result = await work;
  assert.equal(result.state, "cancelled");
  assert.deepEqual(signals, ["SIGTERM", "SIGKILL"]);
});

test("Windows process-tree termination awaits taskkill completion", async () => {
  const childKill = vi.fn();
  const child = {
    pid: 4242,
    kill: childKill,
  } as unknown as ChildProcess;
  const treeKiller = new EventEmitter() as ChildProcess;
  treeKiller.kill = vi.fn();
  const spawnTreeKillerMock = vi.fn(() => treeKiller);
  const spawnTreeKiller = spawnTreeKillerMock as unknown as typeof import("node:child_process").spawn;
  let settled = false;
  const work = terminateWindowsProcessTree(child, spawnTreeKiller, "C:\\Windows\\System32\\taskkill.exe").then(() => {
    settled = true;
  });
  await Promise.resolve();
  assert.equal(settled, false);
  assert.deepEqual(spawnTreeKillerMock.mock.calls[0]?.slice(0, 2), [
    "C:\\Windows\\System32\\taskkill.exe",
    ["/PID", "4242", "/T", "/F"],
  ]);
  assert.equal(childKill.mock.calls.length, 0);
  treeKiller.emit("close", 0, null);
  await work;
  assert.equal(settled, true);
});

test("Windows process-tree termination bounds a hung taskkill helper", async () => {
  vi.useFakeTimers();
  const childKill = vi.fn();
  const child = {
    pid: 4242,
    kill: childKill,
  } as unknown as ChildProcess;
  const treeKiller = new EventEmitter() as ChildProcess;
  const treeKillerKill = vi.fn();
  treeKiller.kill = treeKillerKill;
  const spawnTreeKiller = vi.fn(() => treeKiller) as unknown as typeof import("node:child_process").spawn;
  let settled = false;
  const work = terminateWindowsProcessTree(child, spawnTreeKiller, "C:\\Windows\\System32\\taskkill.exe", 10).then(
    () => {
      settled = true;
    },
  );
  await vi.advanceTimersByTimeAsync(9);
  assert.equal(settled, false);
  await vi.advanceTimersByTimeAsync(1);
  await work;
  assert.equal(settled, true);
  assert.deepEqual(treeKillerKill.mock.calls, [["SIGKILL"]]);
  assert.deepEqual(childKill.mock.calls, [["SIGKILL"]]);
});

function childRequest(overrides: Partial<ChildRequest> = {}): ChildRequest {
  return {
    task: "task",
    tools: ["read", "grep", "find", "ls"],
    model: "test-provider/test-model",
    thinkingLevel: "medium",
    cwd: directory,
    projectTrusted: false,
    communication: {
      host: "127.0.0.1",
      port: 31_337,
      token: "a".repeat(64),
    },
    signal: new AbortController().signal,
    ...overrides,
  };
}

function installFakePi(source: string, options: { bundled?: boolean } = {}): void {
  const packageDirectory = path.join(directory, "pi-core");
  const executableName = options.bundled ? "pi" : "fake-pi.mjs";
  const executablePath = path.join(packageDirectory, executableName);
  mkdirSync(packageDirectory, { recursive: true });
  writeFileSync(
    executablePath,
    `${options.bundled ? "#!/usr/bin/env node\n" : ""}import fs from "node:fs";
const brokerCredentials = JSON.parse(fs.readFileSync(3, "utf8"));
const event = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
const respond = (command, success = true, error) => event({
  id: command.id,
  type: "response",
  command: command.type,
  success,
  ...(error ? { error } : {}),
});
const message = (text, stopReason = "stop") => ({
  type: "message_end",
  message: { role: "assistant", content: [{ type: "text", text }], stopReason },
});
${source}
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  input += chunk;
  while (true) {
    const newline = input.indexOf("\\n");
    if (newline < 0) break;
    const line = input.slice(0, newline);
    input = input.slice(newline + 1);
    if (line.trim()) void handle(JSON.parse(line));
  }
});
`,
  );
  if (options.bundled) chmodSync(executablePath, 0o755);
  writeFileSync(
    path.join(packageDirectory, "package.json"),
    JSON.stringify({
      name: "@earendil-works/pi-coding-agent",
      bin: { pi: options.bundled ? "./dist/bundle/cli.js" : "./fake-pi.mjs" },
    }),
  );
  process.env.PI_PACKAGE_DIR = packageDirectory;
  if (options.bundled) {
    process.execPath = executablePath;
    process.versions.bun = "1.3.0";
  }
}
