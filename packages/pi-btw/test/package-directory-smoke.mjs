#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Standalone runtime smoke, not a Vitest test: cold CLI startup is host-dependent.
const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));
const cli = resolve(repositoryRoot, "node_modules/@earendil-works/pi-coding-agent/dist/cli.js");
const root = await mkdtemp(join(tmpdir(), "pi-btw-package-smoke-"));
const records = [];
let stderr = "";
let partial = "";
let deadline;
let child;
let expectedExit = false;
let resolveReady;
let rejectReady;
const ready = new Promise((resolve, reject) => {
  resolveReady = resolve;
  rejectReady = reject;
});
let rejectFailure;
const failure = new Promise((_, reject) => {
  rejectFailure = reject;
});
void failure.catch(() => undefined);
const pending = new Map();
const cancel = () => {
  const error = new Error("Package-directory smoke cancelled");
  rejectReady(error);
  rejectFailure(error);
};
process.once("SIGINT", cancel);
process.once("SIGTERM", cancel);

function request(id, type, values = {}) {
  const result = new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
  child.stdin.write(`${JSON.stringify({ id, type, ...values })}\n`);
  return Promise.race([result, failure]);
}

try {
  // The wrapper reports readiness before importing Pi. Start its deadline only then.
  child = spawn(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      'import { pathToFileURL } from "node:url"; process.send({ type: "ready" }); await import(pathToFileURL(process.argv[1]).href);',
      "--",
      cli,
      "--mode",
      "rpc",
      "--no-session",
      "--offline",
      "--no-approve",
      "--no-extensions",
      "--no-skills",
      "--no-prompt-templates",
      "--no-themes",
      "--no-context-files",
      "--no-tools",
      "-e",
      "./packages/pi-btw",
    ],
    {
      cwd: repositoryRoot,
      env: {
        PATH: process.env.PATH,
        HOME: root,
        XDG_CONFIG_HOME: join(root, "config"),
        XDG_CACHE_HOME: join(root, "cache"),
        PI_CODING_AGENT_DIR: join(root, "agent"),
        PI_OFFLINE: "1",
      },
      stdio: ["pipe", "pipe", "pipe", "ipc"],
    },
  );
  const exited = new Promise((resolve) => {
    child.once("error", (error) => {
      rejectReady(error);
      rejectFailure(error);
    });
    child.once("exit", (code, signal) => {
      const error = new Error(`Pi exited (${code ?? signal}): ${stderr}`);
      rejectReady(error);
      if (!expectedExit) rejectFailure(error);
    });
    // close follows exit and also confirms that stdout/stderr have drained.
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  child.once("message", (message) => {
    if (message?.type !== "ready") return;
    deadline = setTimeout(() => rejectFailure(new Error(`Pi smoke deadline exceeded: ${stderr}`)), 15_000);
    resolveReady();
  });
  child.stdin.on("error", rejectFailure);
  child.stderr.setEncoding("utf8").on("data", (data) => {
    stderr += data;
  });
  child.stdout.setEncoding("utf8").on("data", (data) => {
    partial += data;
    while (true) {
      const newline = partial.indexOf("\n");
      if (newline < 0) break;
      const line = partial.slice(0, newline).replace(/\r$/u, "");
      partial = partial.slice(newline + 1);
      if (!line) continue;
      try {
        const record = JSON.parse(line);
        records.push(record);
        if (record.type === "response" && pending.has(record.id)) {
          const waiter = pending.get(record.id);
          pending.delete(record.id);
          waiter.resolve(record);
        }
      } catch (error) {
        rejectFailure(error);
      }
    }
  });
  await ready;
  const registration = await request("registration", "get_commands");
  assert.equal(registration.success, true);
  const command = registration.data.commands.find((entry) => entry.name === "btw");
  assert.ok(command);
  assert.equal(command.source, "extension");
  assert.equal(resolve(command.sourceInfo.path), resolve(repositoryRoot, "packages/pi-btw/dist/index.ts"));
  for (const [id, message] of [
    ["menu", "/btw"],
    ["question", "/btw isolated smoke"],
  ]) {
    const response = await request(id, "prompt", { message });
    assert.equal(response.success, true);
    assert.equal(response.data.disposition, "handled");
  }
  assert.equal(
    records.filter((record) => record.method === "notify" && record.message === "/btw requires interactive TUI mode")
      .length,
    2,
  );
  assert.equal(
    records.some((record) => record.type === "agent_start"),
    false,
  );
  assert.equal(
    records.some((record) => record.type === "extension_error"),
    false,
  );
  const messages = await request("messages", "get_messages");
  assert.equal(messages.success, true);
  assert.deepEqual(messages.data.messages, []);
  expectedExit = true;
  child.stdin.end();
  const exit = await Promise.race([exited, failure]);
  assert.deepEqual(exit, { code: 0, signal: null });
  assert.equal(partial, "");
  assert.equal(stderr, "");
  console.log(
    "PASS: package-directory registration, RPC mode guards, unchanged transcript, orderly EOF shutdown; no provider or TUI.",
  );
} finally {
  process.removeListener("SIGINT", cancel);
  process.removeListener("SIGTERM", cancel);
  clearTimeout(deadline);
  if (child?.pid && child.exitCode === null && child.signalCode === null) {
    const closed = new Promise((resolve) => child.once("close", resolve));
    child.kill("SIGKILL");
    await closed;
  }
  for (const waiter of pending.values()) waiter.reject(new Error("Smoke closed"));
  await rm(root, { recursive: true, force: true });
}
