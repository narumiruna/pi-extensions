import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type {
  JsonAgentSessionEvent,
  ProjectTrustUpdate,
  RpcCommand,
  RpcExtensionUIRequest,
  RpcResponse,
} from "@earendil-works/pi-coding-agent";
import { type TrustObservation, trustObservationPrefix } from "./pi-project-trust-observer.js";

type WireRecord = RpcResponse | RpcExtensionUIRequest | JsonAgentSessionEvent | { type: "extension_error" };
type SavedDecision = { type: "saved_decision"; decision: boolean | null; requiresTrust: boolean };
type Waiter = { resolve: (response: RpcResponse) => void; reject: (error: Error) => void };

const packageRoot = resolve("node_modules/@earendil-works/pi-coding-agent");
const manifest = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")) as {
  bin: { pi: string };
};
const cli = resolve(packageRoot, manifest.bin.pi);
const observer = resolve("test/pi-project-trust-observer.ts");
const bootstrap = resolve("test/pi-project-trust-bootstrap.mjs");

function projectTrustEnvironment(root: string): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH,
    HOME: join(root, "home"),
    XDG_CONFIG_HOME: join(root, "config"),
    XDG_CACHE_HOME: join(root, "cache"),
    XDG_DATA_HOME: join(root, "data"),
    NODE_COMPILE_CACHE: join(root, "cache", "node"),
    PI_CODING_AGENT_DIR: join(root, "agent"),
    PI_OFFLINE: "1",
    PI_TELEMETRY: "0",
  };
}

/** A real, offline CLI process. The fixture owns every process even when startup or a test fails. */
export class ProjectTrustRpc {
  readonly child: ChildProcess;
  readonly records: WireRecord[] = [];
  savedDecision: SavedDecision | undefined;
  private readonly exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  private readonly failure: Promise<never>;
  private readonly booted: Promise<void>;
  private readonly pending = new Map<string, Waiter>();
  private stderr = "";
  private partial = "";
  private sequence = 0;
  private closing = false;
  private startupDeadline: ReturnType<typeof setTimeout> | undefined;

  constructor(root: string, cwd: string, updates: ProjectTrustUpdate[]) {
    let ready!: () => void;
    let failReady!: (error: Error) => void;
    let fail!: (error: Error) => void;
    this.booted = new Promise((resolveReady, rejectReady) => {
      ready = resolveReady;
      failReady = rejectReady;
    });
    this.failure = new Promise((_, reject) => {
      fail = reject;
    });
    void this.booted.catch(() => undefined);
    void this.failure.catch(() => undefined);
    const failProcess = (error: Error) => {
      failReady(error);
      fail(error);
    };
    this.child = spawn(
      process.execPath,
      [
        bootstrap,
        cli,
        JSON.stringify(updates),
        "--mode",
        "rpc",
        "--no-session",
        "--offline",
        "--no-extensions",
        "--no-skills",
        "--no-prompt-templates",
        "--no-themes",
        "--no-tools",
        "--provider",
        "project-trust-runtime",
        "--model",
        "unused",
        "-e",
        observer,
      ],
      {
        cwd,
        env: projectTrustEnvironment(root),
        stdio: ["pipe", "pipe", "pipe", "ipc"],
      },
    );
    this.child.once("error", failProcess);
    this.child.once("exit", (code, signal) => {
      const error = new Error(`Pi exited (${code ?? signal}): ${this.stderr}`);
      failReady(error);
      if (!this.closing) fail(error);
    });
    this.exited = new Promise((resolveExit) => {
      // close confirms that stdout/stderr have drained as well as that Pi exited.
      this.child.once("close", (code, signal) => resolveExit({ code, signal }));
    });
    this.child.on("message", (message) => {
      if (typeof message !== "object" || message === null || !("type" in message)) return;
      if (message.type === "ready") {
        this.startupDeadline = setTimeout(
          () => failProcess(new Error(`Pi startup deadline exceeded: ${this.stderr}`)),
          10_000,
        );
      } else if (message.type === "saved_decision") {
        this.savedDecision = message as SavedDecision;
        ready();
      }
    });
    this.child.stdin?.on("error", failProcess);
    this.child.stderr?.setEncoding("utf8").on("data", (data: string) => {
      this.stderr += data;
    });
    this.child.stdout?.setEncoding("utf8").on("data", (data: string) => {
      this.partial += data;
      while (true) {
        const newline = this.partial.indexOf("\n");
        if (newline < 0) break;
        const line = this.partial.slice(0, newline).replace(/\r$/u, "");
        this.partial = this.partial.slice(newline + 1);
        if (!line) continue;
        try {
          const record = JSON.parse(line) as WireRecord;
          this.records.push(record);
          if (record.type === "response" && record.id) {
            this.pending.get(record.id)?.resolve(record);
            this.pending.delete(record.id);
          }
        } catch (error) {
          failProcess(error instanceof Error ? error : new Error(String(error)));
        }
      }
    });
  }

  async ready(): Promise<void> {
    await Promise.race([this.booted, this.failure]);
    // get_commands is the real RPC readiness boundary; no sleeps or model prompts.
    const response = await this.request({ type: "get_commands" }, false);
    clearTimeout(this.startupDeadline);
    assert.ok(response.success && response.command === "get_commands", JSON.stringify(response));
    assert.deepEqual(
      response.data.commands.map((entry) => [entry.name, entry.source, resolve(entry.sourceInfo.path)]),
      [
        ["trust-runtime-observe", "extension", observer],
        ["trust-runtime-reload", "extension", observer],
      ],
    );
    assert.ok(this.savedDecision);
  }

  async request(command: RpcCommand, timed = true): Promise<RpcResponse> {
    const id = `trust-${++this.sequence}`;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    const result = new Promise<RpcResponse>((resolveResponse, rejectResponse) => {
      this.pending.set(id, { resolve: resolveResponse, reject: rejectResponse });
      if (timed) {
        deadline = setTimeout(
          () => rejectResponse(new Error(`Pi ${command.type} deadline exceeded: ${this.stderr}`)),
          2_000,
        );
      }
    });
    assert.ok(this.child.stdin);
    this.child.stdin.write(`${JSON.stringify({ ...command, id })}\n`);
    try {
      return await Promise.race([result, this.failure]);
    } finally {
      clearTimeout(deadline);
      this.pending.delete(id);
    }
  }

  observations(): TrustObservation[] {
    return this.records.flatMap((record) =>
      record.type === "extension_ui_request" &&
      record.method === "notify" &&
      record.message.startsWith(trustObservationPrefix)
        ? [JSON.parse(record.message.slice(trustObservationPrefix.length)) as TrustObservation]
        : [],
    );
  }

  assertNoModelRun(): void {
    assert.equal(
      this.records.some((record) => record.type === "agent_start"),
      false,
    );
    assert.equal(
      this.records.some((record) => record.type === "extension_error"),
      false,
    );
  }

  async close(): Promise<void> {
    this.closing = true;
    this.child.stdin?.end();
    let deadline: ReturnType<typeof setTimeout> | undefined;
    try {
      const timeout = new Promise<never>((_, reject) => {
        deadline = setTimeout(() => reject(new Error(`Pi EOF deadline exceeded: ${this.stderr}`)), 2_000);
      });
      assert.deepEqual(await Promise.race([this.exited, this.failure, timeout]), { code: 0, signal: null });
      assert.equal(this.partial, "");
      assert.equal(this.stderr, "");
      this.assertNoModelRun();
    } finally {
      clearTimeout(deadline);
    }
  }

  async dispose(): Promise<void> {
    this.closing = true;
    clearTimeout(this.startupDeadline);
    if (this.child.exitCode === null && this.child.signalCode === null) this.child.kill("SIGKILL");
    await this.exited;
    for (const waiter of this.pending.values()) waiter.reject(new Error("Project trust fixture disposed"));
    this.pending.clear();
  }
}

/** Local remove is a no-op for this unconfigured path; it cannot install or execute package code. */
export function removeUnconfiguredProjectPackage(root: string, cwd: string) {
  const child = spawn(process.execPath, [bootstrap, cli, "[]", "remove", "--local", "./never-configured"], {
    cwd,
    env: projectTrustEnvironment(root),
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  let stdout = "";
  let stderr = "";
  let savedDecision: SavedDecision | undefined;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  let finish!: (value: {
    code: number | null;
    signal: NodeJS.Signals | null;
    stdout: string;
    stderr: string;
    savedDecision: SavedDecision | undefined;
  }) => void;
  let fail!: (error: Error) => void;
  const result = new Promise<Parameters<typeof finish>[0]>((resolveResult, rejectResult) => {
    finish = resolveResult;
    fail = rejectResult;
  });
  void result.catch(() => undefined);
  const closed = new Promise<void>((resolveClose) => {
    child.once("close", (code, signal) => {
      clearTimeout(deadline);
      finish({ code, signal, stdout, stderr, savedDecision });
      resolveClose();
    });
  });
  child.once("error", fail);
  child.on("message", (message) => {
    if (typeof message !== "object" || message === null || !("type" in message)) return;
    if (message.type === "ready") {
      deadline = setTimeout(() => fail(new Error(`Pi local-remove deadline exceeded: ${stderr}`)), 3_000);
    } else if (message.type === "saved_decision") {
      savedDecision = message as SavedDecision;
    }
  });
  child.stdout?.setEncoding("utf8").on("data", (data: string) => {
    stdout += data;
  });
  child.stderr?.setEncoding("utf8").on("data", (data: string) => {
    stderr += data;
  });
  return {
    result,
    async dispose(): Promise<void> {
      clearTimeout(deadline);
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await closed;
    },
  };
}
