// Test-only worker supervisor. It never takes over an unverified stale lease.
import { type ChildProcess, fork } from "node:child_process";
import { EventEmitter } from "node:events";
import { readFile, unlink } from "node:fs/promises";
import path from "node:path";
import type { JsonValue } from "@earendil-works/chord";
import type { Agent, FixtureState, Policy } from "./durable-fixture.js";

type Frame = { event?: string; data?: JsonValue; id?: number; value?: unknown; error?: string };
export type Request = {
  op: string;
  agentId?: string;
  requestId?: string;
  task?: string;
  questionId?: string;
  answer?: string;
  checkpoint?: string;
  reportId?: string;
  sessionFile?: string;
};
export class DurableDriver {
  readonly events: Frame[] = [];
  readonly child: ChildProcess;
  readonly exited: Promise<void>;
  readyRss = 0;
  shutdownResources: string[] = [];
  private readonly emitter = new EventEmitter();
  private readonly pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  private nextId = 0;
  private ended = false;
  private ready = false;
  private token?: string;
  private stderr = "";
  private constructor(
    entry: string,
    readonly directory: string,
    blocks: string[],
    policy: Partial<Policy>,
  ) {
    // Do not inherit provider credentials or the caller's Pi agent directory.
    this.child = fork(entry, [directory, JSON.stringify(policy), JSON.stringify(blocks)], {
      env: { PATH: process.env.PATH },
      stdio: ["ignore", "ignore", "pipe", "ipc"],
      execArgv: [],
    });
    this.child.stderr?.on("data", (chunk) => {
      this.stderr = `${this.stderr}${chunk}`.slice(-4000);
    });
    this.exited = new Promise<void>((resolve) => {
      const finish = () => {
        if (this.ended) return;
        this.ended = true;
        this.child.stderr?.destroy();
        if (this.child.connected) this.child.disconnect();
        const error = new Error(`Fixture exited: ${this.stderr}`);
        for (const waiter of this.pending.values()) waiter.reject(error);
        this.pending.clear();
        this.emitter.emit("exit", error);
        resolve();
      };
      this.child.once("exit", finish);
      this.child.once("error", () => {
        if (this.child.pid) this.child.kill("SIGKILL");
        else finish();
      });
    });
    this.child.on("message", (frame: Frame) => {
      if (frame.event) {
        this.events.push(frame);
        this.emitter.emit("frame");
      } else if (frame.id !== undefined) {
        const waiter = this.pending.get(frame.id);
        this.pending.delete(frame.id);
        if (frame.error) waiter?.reject(new Error(frame.error));
        else waiter?.resolve(frame.value);
      }
    });
  }
  static async launch(
    entry: string,
    directory: string,
    blocks: string[] = [],
    policy: Partial<Policy> = {},
  ): Promise<DurableDriver> {
    const driver = new DurableDriver(entry, directory, blocks, policy);
    try {
      const ready = await driver.event("ready", 2000);
      driver.token = (ready as { token: string }).token;
      driver.readyRss = (ready as { rss: number }).rss;
      driver.ready = true;
      return driver;
    } catch (error) {
      driver.child.kill("SIGKILL");
      await driver.exited;
      throw error;
    }
  }
  async event(name: string, timeout = 1500): Promise<JsonValue> {
    return new Promise<JsonValue>((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(deadline);
        this.emitter.off("frame", check);
        this.emitter.off("exit", fail);
      };
      const fail = (error: Error) => {
        cleanup();
        reject(error);
      };
      const check = () => {
        const index = this.events.findIndex((event) => event.event === name);
        if (index >= 0) {
          const [frame] = this.events.splice(index, 1);
          cleanup();
          resolve(frame?.data ?? null);
        }
      };
      // This startup deadline is distinct from command deadlines, which begin after ready.
      const deadline = setTimeout(
        () => fail(new Error(`Missing fixture checkpoint: ${name}; ${this.stderr}`)),
        timeout,
      );
      this.emitter.on("frame", check);
      this.emitter.once("exit", fail);
      if (this.ended) fail(new Error(`Fixture exited: ${this.stderr}`));
      else check();
    });
  }
  async request<T = unknown>(command: Request): Promise<T> {
    if (!this.ready || this.ended) throw new Error("Fixture not ready");
    const id = ++this.nextId;
    return new Promise<T>((resolve, reject) => {
      const deadline = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Fixture command timed out: ${command.op}`));
      }, 1500);
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(deadline);
          resolve(value as T);
        },
        reject: (error) => {
          clearTimeout(deadline);
          reject(error);
        },
      });
      this.child.send({ ...command, id }, (error) => {
        if (error) {
          this.pending.get(id)?.reject(error);
          this.pending.delete(id);
        }
      });
    });
  }
  spawn(task = "A"): Promise<Agent> {
    return this.request({ op: "spawn", task });
  }
  wait(): Promise<Agent> {
    return this.request({ op: "wait" });
  }
  state(): Promise<FixtureState> {
    return this.request({ op: "state" });
  }
  async stop(hard = false): Promise<void> {
    if (this.ended) return;
    let shutdownError: unknown;
    if (!hard) {
      try {
        this.shutdownResources = await this.request<string[]>({ op: "shutdown" });
      } catch (error) {
        hard = true;
        shutdownError = error;
      }
    }
    if (hard) this.child.kill("SIGKILL");
    else if (this.child.connected) this.child.disconnect();
    await this.exited;
    if (hard && this.token) {
      // Only the supervisor that observed THIS worker exit can remove its matching lease.
      const lease = path.join(this.directory, "owner.lock");
      try {
        if ((await readFile(lease, "utf8")) === this.token) await unlink(lease);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    if (shutdownError) throw shutdownError;
  }
}
