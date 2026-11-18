import { type ChildProcess, fork } from "node:child_process";
import path from "node:path";
import type { RpcCommand } from "@earendil-works/pi-coding-agent";

type RecordValue = {
  type: string;
  id?: string;
  success?: boolean;
  data?: unknown;
  error?: string;
  [key: string]: unknown;
};
type ResponseWaiter = { resolve(value: RecordValue): void; reject(error: Error): void };

/** Real Pi main/RPC; all resources and network configuration belong to the test. */
export class SyncRpc {
  readonly child: ChildProcess;
  readonly records: RecordValue[] = [];
  readonly exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  sessionStarts = 0;
  private ready: Promise<void>;
  private pending = new Map<string, ResponseWaiter>();
  private listeners = new Set<(record: RecordValue) => void>();
  private sequence = 0;
  private closing = false;
  private closed = false;
  private cancelled = false;
  private disposal: Promise<void> | undefined;
  private fail!: (error: Error) => void;
  private stderr = "";
  private partial = "";

  constructor(
    root: string,
    cwd: string,
    extension: string,
    sessionDir?: string,
    private readonly signal?: AbortSignal,
  ) {
    signal?.throwIfAborted();
    let ready!: () => void;
    let failReady!: (error: Error) => void;
    this.ready = new Promise<void>((resolve, reject) => {
      ready = resolve;
      failReady = reject;
    });
    void this.ready.catch(() => {});
    this.child = fork(
      new URL("./fixtures/rpc-client.mjs", import.meta.url),
      [
        "--mode",
        "rpc",
        "--offline",
        "--no-extensions",
        "--no-skills",
        "--no-prompt-templates",
        "--no-themes",
        "--tools",
        "read,edit",
        "--provider",
        "sync-rpc-fixture",
        "--model",
        "fixture",
        ...(sessionDir ? ["--session-dir", sessionDir] : []),
        "-e",
        extension,
      ],
      {
        cwd,
        execArgv: [],
        stdio: ["pipe", "pipe", "pipe", "ipc"],
        env: {
          PATH: process.env.PATH,
          HOME: path.join(root, "home"),
          XDG_CONFIG_HOME: path.join(root, "config"),
          XDG_CACHE_HOME: path.join(root, "cache"),
          XDG_DATA_HOME: path.join(root, "data"),
          PI_CODING_AGENT_DIR: path.join(root, "agent"),
          PI_OFFLINE: "1",
          PI_TELEMETRY: "0",
          // Share bytecode only; every child still owns fresh modules and session state.
          NODE_COMPILE_CACHE: process.env.NODE_COMPILE_CACHE,
          NODE_DISABLE_COMPILE_CACHE: process.env.NODE_DISABLE_COMPILE_CACHE,
        },
      },
    );
    const fail = (error: Error) => {
      failReady(error);
      for (const waiter of this.pending.values()) waiter.reject(error);
      this.pending.clear();
      for (const listener of this.listeners) listener({ type: "fixture_error", error: error.message });
    };
    this.fail = fail;
    const cancel = () => {
      this.cancelled = true;
      this.terminate(new Error("Pi RPC fixture cancelled", { cause: signal?.reason }));
    };
    this.child.once("error", fail);
    this.child.stdin?.on("error", fail);
    this.child.on("message", (message) => {
      if (typeof message === "object" && message !== null && "type" in message && message.type === "ready") {
        this.sessionStarts++;
        ready();
      }
    });
    this.child.stderr?.setEncoding("utf8").on("data", (data: string) => {
      this.stderr = (this.stderr + data).slice(-16_384);
    });
    this.child.stdout?.setEncoding("utf8").on("data", (data: string) => {
      this.partial += data;
      for (;;) {
        const index = this.partial.indexOf("\n");
        if (index < 0) break;
        const line = this.partial.slice(0, index).replace(/\r$/u, "");
        this.partial = this.partial.slice(index + 1);
        if (!line) continue;
        try {
          const record = JSON.parse(line) as RecordValue;
          this.records.push(record);
          if (record.type === "response" && record.id) this.pending.get(record.id)?.resolve(record);
          for (const listener of this.listeners) listener(record);
        } catch (error) {
          fail(new Error(`Invalid RPC output: ${String(error)}; ${this.stderr}`));
        }
      }
    });
    this.exited = new Promise((resolve) =>
      this.child.once("close", (code, signal) => {
        this.closed = true;
        this.signal?.removeEventListener("abort", cancel);
        fail(new Error(`Pi exited (${code ?? signal}): ${this.stderr}`));
        resolve({ code, signal });
      }),
    );
    signal?.addEventListener("abort", cancel, { once: true });
  }
  async start() {
    await this.ready;
    return this.call({ type: "get_state" });
  }
  async call(command: RpcCommand) {
    await this.ready;
    this.signal?.throwIfAborted();
    if (this.closed || this.closing) throw new Error(`Pi is closed: ${this.stderr}`);
    const id = `fixture-${++this.sequence}`;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    const response = new Promise<RecordValue>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      // The child reports session startup before any request deadline begins.
      deadline = setTimeout(
        () => this.terminate(new Error(`RPC ${command.type} deadline exceeded: ${this.stderr}`)),
        4_000,
      );
    });
    void response.catch(() => {});
    try {
      const written = new Promise<void>((resolve, reject) =>
        this.child.stdin?.write(`${JSON.stringify({ ...command, id })}\n`, (error) =>
          error ? reject(error) : resolve(),
        ),
      );
      const [, reply] = await Promise.all([written, response]);
      if (!reply.success) throw new Error(reply.error ?? `RPC ${command.type} failed`);
      return reply.data as Record<string, unknown>;
    } finally {
      clearTimeout(deadline);
      this.pending.delete(id);
    }
  }
  async command(message: string, confirm: (title: string) => boolean) {
    const listener = (record: RecordValue) => {
      if (record.type !== "extension_ui_request" || record.method !== "confirm" || typeof record.id !== "string")
        return;
      this.child.stdin?.write(
        `${JSON.stringify({ type: "extension_ui_response", id: record.id, confirmed: confirm(String(record.title)) })}\n`,
      );
    };
    this.listeners.add(listener);
    try {
      return await this.call({ type: "prompt", message });
    } finally {
      this.listeners.delete(listener);
    }
  }
  async prompt(message: string) {
    let cancel!: () => void;
    const settled = new Promise<void>((resolve, reject) => {
      const listener = (record: RecordValue) => {
        if (record.type === "agent_settled") resolve();
        if (record.type === "fixture_error") reject(new Error(record.error));
      };
      cancel = () => {
        this.listeners.delete(listener);
      };
      this.listeners.add(listener);
    });
    void settled.catch(() => {});
    try {
      await this.call({ type: "prompt", message });
      await settled;
    } finally {
      cancel();
    }
  }
  async close() {
    if (this.cancelled) {
      await this.exited;
      return;
    }
    await this.ready;
    if (!this.closing && !this.closed) {
      this.closing = true;
      this.child.stdin?.end();
    }
    let deadline: ReturnType<typeof setTimeout> | undefined;
    try {
      const timeout = new Promise<never>((_, reject) => {
        deadline = setTimeout(() => reject(new Error(`Pi shutdown deadline exceeded: ${this.stderr}`)), 4_000);
      });
      const result = await Promise.race([this.exited, timeout]);
      if (result.code !== 0) throw new Error(`Pi shutdown failed (${result.code ?? result.signal}): ${this.stderr}`);
    } catch (error) {
      this.terminate(error instanceof Error ? error : new Error(String(error)));
      await this.exited;
      throw error;
    } finally {
      clearTimeout(deadline);
    }
  }
  dispose(): Promise<void> {
    this.disposal ??= (async () => {
      this.terminate(new Error("Pi RPC fixture disposed"));
      await this.exited;
    })();
    return this.disposal;
  }
  private terminate(error: Error) {
    this.closing = true;
    this.fail(error);
    if (!this.closed) this.child.kill("SIGKILL");
  }
}
