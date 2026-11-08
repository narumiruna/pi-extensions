#!/usr/bin/env node
// Native CLI smoke only: no TUI, provider requests, test commands, or production hooks.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const packageDir = fileURLToPath(new URL("..", import.meta.url));
const entrypoint = join(packageDir, "dist", "index.ts");
const cli = fileURLToPath(new URL("./bundle/cli.js", import.meta.resolve("@earendil-works/pi-coding-agent")));
const root = await mkdtemp(join(tmpdir(), "pi-scope-cli-"));
const commandNames = ["edit-scope", "scope"];
const expectedErrors = new Set(
  commandNames.flatMap((name) => [`/${name} requires Pi TUI mode`, `Usage: /${name} or /${name} off`]),
);
// Parent-agent diagnostics and session controls must not alter these isolated CLI runs.
const inheritedEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("PI_")));

class RpcProcess {
  #child;
  #exit;
  #pending = new Map();
  #waiters = new Set();
  #nextId = 0;
  #ready = false;
  #closed = false;
  #parseError;
  records = [];
  stderr = "";

  constructor(cwd, agentDir, home, explicit, approved) {
    this.#child = spawn(
      process.execPath,
      [
        cli,
        "--mode",
        "rpc",
        "--offline",
        approved ? "--approve" : "--no-approve",
        "--no-session",
        "--no-context-files",
        "--no-skills",
        "--no-prompt-templates",
        "--no-themes",
        "--no-mcp",
        ...(explicit ? ["--no-extensions", "-e", packageDir] : []),
      ],
      {
        cwd,
        env: {
          ...inheritedEnv,
          HOME: home,
          USERPROFILE: home,
          PI_CODING_AGENT_DIR: agentDir,
          PI_OFFLINE: "1",
        },
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    const fail = (error) => {
      this.#parseError ??= error;
      for (const pending of this.#pending.values()) pending.reject(error);
      for (const waiter of this.#waiters) waiter.reject(error);
    };
    this.#child.once("error", fail);
    this.#child.stdin.on("error", fail);
    this.#exit = new Promise((resolve) => {
      this.#child.once("close", (code, signal) => {
        this.#closed = true;
        const error = new Error(`Pi RPC closed (${code ?? signal}): ${this.stderr}`);
        for (const pending of this.#pending.values()) pending.reject(error);
        for (const waiter of this.#waiters) waiter.reject(error);
        resolve({ code, signal });
      });
    });
    this.#child.stderr.setEncoding("utf8");
    this.#child.stderr.on("data", (chunk) => {
      this.stderr += chunk;
    });
    this.#child.stdout.setEncoding("utf8");
    let buffer = "";
    this.#child.stdout.on("data", (chunk) => {
      buffer += chunk;
      let end = buffer.indexOf("\n");
      // Pi uses LF framing. Do not use readline, which also splits Unicode separators.
      while (end >= 0) {
        const line = buffer.slice(0, end).replace(/\r$/, "");
        buffer = buffer.slice(end + 1);
        if (line) {
          try {
            const record = JSON.parse(line);
            this.records.push(record);
            if (record.type === "response") this.#pending.get(record.id)?.resolve(record);
            for (const waiter of this.#waiters) if (waiter.matches(record)) waiter.resolve(record);
          } catch (error) {
            fail(error);
          }
        }
        end = buffer.indexOf("\n");
      }
    });
    this.#child.stdout.on("end", () => {
      if (buffer.trim()) this.#parseError = new Error(`Unterminated RPC record: ${buffer}`);
    });
  }

  async ready() {
    // Do not start a subprocess timing deadline before Pi answers its readiness handshake.
    const state = await this.request("get_state");
    assert.equal(state.success, true, JSON.stringify(state));
    assert.equal(state.data.isStreaming, false);
    this.#ready = true;
  }

  async #deadline(promise, label) {
    if (!this.#ready) return promise;
    let timer;
    try {
      return await Promise.race([
        promise,
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error(`RPC timeout: ${label}`)), 10_000);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  async request(type, args = {}) {
    if (this.#closed) throw new Error("Pi RPC is closed");
    if (this.#parseError) throw this.#parseError;
    const id = `scope-smoke-${++this.#nextId}`;
    const response = new Promise((resolve, reject) => this.#pending.set(id, { resolve, reject }));
    try {
      if (!this.#child.stdin.write(`${JSON.stringify({ id, type, ...args })}\n`))
        await once(this.#child.stdin, "drain");
      return await this.#deadline(response, type);
    } finally {
      this.#pending.delete(id);
    }
  }

  async eventSince(offset, matches) {
    const found = this.records.slice(offset).find(matches);
    if (found) return found;
    if (this.#parseError) throw this.#parseError;
    if (this.#closed) throw new Error("Pi RPC is closed");
    let waiter;
    try {
      return await this.#deadline(
        new Promise((resolve, reject) => {
          waiter = { matches, resolve, reject };
          this.#waiters.add(waiter);
        }),
        "extension event",
      );
    } finally {
      this.#waiters.delete(waiter);
    }
  }

  async close() {
    if (!this.#closed) this.#child.stdin.end();
    let exited;
    try {
      exited = await this.#deadline(this.#exit, "orderly shutdown");
    } catch (error) {
      this.#child.kill("SIGKILL");
      await this.#exit;
      throw error;
    }
    assert.equal(exited.code, 0, this.stderr);
    assert.equal(this.#parseError, undefined);
  }
}

async function fixture(name, discovery) {
  const cwd = join(root, name, "workspace");
  const agentDir = join(root, name, "agent");
  const home = join(root, name, "home");
  await Promise.all([
    mkdir(join(cwd, ".pi", "extensions"), { recursive: true }),
    mkdir(agentDir, { recursive: true }),
    mkdir(home, { recursive: true }),
  ]);
  if (discovery) {
    // Jiti resolves generated imports from the lexical discovery path. Model a
    // project's dependency ancestry instead of relying on the symlink target's parents.
    const dependencyScope = join(cwd, "node_modules", "@narumitw");
    await mkdir(dependencyScope, { recursive: true });
    await symlink(join(packageDir, "..", "pi-tui-kit"), join(dependencyScope, "pi-tui-kit"), "dir");
    await symlink(packageDir, join(cwd, ".pi", "extensions", "files"), "dir");
  }
  // Auto-discovery must not load unrelated CLI built-ins, packages, or user resources.
  await writeFile(
    join(agentDir, "settings.json"),
    JSON.stringify({
      extensions: ["-builtin:codemode", "-builtin:tool-search", "-builtin:mcp", "-builtin:llama.cpp"],
      cacheWarming: "off",
      compaction: { enabled: false },
      retry: { enabled: false },
      enableInstallTelemetry: false,
      enableAnalytics: false,
    }),
  );
  return { cwd, agentDir, home };
}

async function smoke(name, explicit, approved) {
  const { cwd, agentDir, home } = await fixture(name, !explicit);
  const rpc = new RpcProcess(cwd, agentDir, home, explicit, approved);
  try {
    await rpc.ready();
    const commands = await rpc.request("get_commands");
    assert.equal(commands.success, true, JSON.stringify(commands));
    if (!approved && !explicit) {
      assert.deepEqual(commands.data.commands, []);
      assert.equal(
        rpc.records.some((record) => record.type === "extension_error"),
        false,
      );
      console.log("PASS native CLI trust denial: neither Edit Scope command is loaded");
      return;
    }
    assert.deepEqual(
      commands.data.commands
        .filter(({ name }) => commandNames.includes(name))
        .map(({ name, source }) => ({ name, source })),
      commandNames.map((name) => ({ name, source: "extension" })),
    );
    const sourceInfo = commands.data.commands[0].sourceInfo;
    assert.equal(await realpath(sourceInfo.path), await realpath(entrypoint));
    assert.equal(sourceInfo.source, explicit ? "cli" : "auto");
    assert.equal(sourceInfo.scope, explicit ? "temporary" : "project");

    for (const name of commandNames) {
      for (const args of ["", " off", " status", " off trailing"]) {
        const offset = rpc.records.length;
        const response = await rpc.request("prompt", { message: `/${name}${args}` });
        assert.equal(response.success, true, JSON.stringify(response));
        assert.equal(response.data.disposition, "handled");
        const error = await rpc.eventSince(
          offset,
          (record) => record.type === "extension_error" && record.extensionPath === `command:${name}`,
        );
        assert.equal(error.event, "command");
        assert.equal(
          error.error,
          args === "" || args === " off" ? `/${name} requires Pi TUI mode` : `Usage: /${name} or /${name} off`,
        );
      }
    }
    assert.deepEqual((await rpc.request("get_commands")).data.commands, commands.data.commands);
    assert.equal(
      rpc.records.some((record) => record.type === "agent_start" || record.type === "message_update"),
      false,
      "A slash command must not start a provider request",
    );
    assert.equal(
      rpc.records.some(
        (record) =>
          record.type === "extension_ui_request" &&
          ["custom", "select", "input", "confirm", "editor"].includes(record.method),
      ),
      false,
    );
    assert.equal(
      rpc.records
        .filter((record) => record.type === "extension_error")
        .every(
          (record) =>
            commandNames.some((name) => record.extensionPath === `command:${name}`) && expectedErrors.has(record.error),
        ),
      true,
    );
    assert.equal((await rpc.request("get_state")).data.isStreaming, false);
    console.log(
      `PASS native CLI ${explicit ? "explicit package --no-extensions -e" : "trusted-project package discovery"}: both commands; eight observable non-TUI rejections; no model run`,
    );
  } finally {
    await rpc.close();
  }
}

async function smokeOneShot(mode) {
  const { cwd, agentDir, home } = await fixture(mode, false);
  const child = spawn(
    process.execPath,
    [
      cli,
      "--mode",
      mode,
      "--print",
      "--offline",
      "--approve",
      "--no-session",
      "--no-extensions",
      "--no-context-files",
      "--no-skills",
      "--no-prompt-templates",
      "--no-themes",
      "--no-mcp",
      "-e",
      packageDir,
      ...commandNames.flatMap((name) => ["", " off", " status", " off trailing"].map((args) => `/${name}${args}`)),
    ],
    {
      cwd,
      env: { ...inheritedEnv, HOME: home, USERPROFILE: home, PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1" },
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const exit = once(child, "close");
  child.stdin.end();
  const [code] = await exit;
  assert.equal(code, 0, stderr);
  assert.deepEqual(
    stderr.trim().split("\n"),
    commandNames.flatMap((name) => [
      `Extension error (command:${name}): /${name} requires Pi TUI mode`,
      `Extension error (command:${name}): /${name} requires Pi TUI mode`,
      `Extension error (command:${name}): Usage: /${name} or /${name} off`,
      `Extension error (command:${name}): Usage: /${name} or /${name} off`,
    ]),
  );
  if (mode === "json") {
    const records = stdout
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.deepEqual(
      records.map((record) => record.type),
      ["session"],
    );
  } else {
    assert.equal(stdout, "");
  }
  console.log(
    `PASS native CLI ${mode === "json" ? "JSON" : "print"}: eight stderr rejections; no provider run or protocol corruption`,
  );
}

try {
  await smoke("explicit", true, true);
  await smoke("discovery", false, true);
  await smoke("untrusted", false, false);
  await smokeOneShot("text");
  await smokeOneShot("json");
  console.log(
    "NOTE /reload is a TUI-only built-in, not an RPC prompt command; native SDK reload is covered by test/runtime.test.ts.",
  );
  console.log("UNVERIFIED physical-terminal keys, IME, and the interactive /reload route.");
} finally {
  await rm(root, { recursive: true, force: true });
}
