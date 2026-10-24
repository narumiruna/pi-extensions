import assert from "node:assert/strict";
import { type ChildProcess, fork } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, readdir, readFile, readlink, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { build } from "esbuild";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { PackageCommand, PackageEvidence, PackageRequest, PackageToolResult } from "./durable-package-worker.js";

type Frame = { event?: string; data?: unknown; id?: number; value?: unknown; error?: string };
interface DiskEntry {
  id: string;
  type: string;
  customType?: string;
  details?: unknown;
  message?: { role: string; toolName?: string; toolCallId?: string; details?: unknown; isError?: boolean };
}

// This supervisor never reads, removes or repairs a lease. Only kernel FD closure releases ownership.
class PackageDriver {
  readonly child: ChildProcess;
  readonly exited: Promise<void>;
  readonly frames: Frame[] = [];
  readonly events = new EventEmitter();
  private readonly pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
  private nextId = 0;
  private ended = false;
  private stderr = "";
  private ready = false;
  private constructor(entry: string, root: string, packageEntry: string, sessionFile: string, blocks: string[]) {
    this.child = fork(entry, ["--durable-package-worker", root, packageEntry, sessionFile, JSON.stringify(blocks)], {
      // Do not inherit credentials, HOME, provider environment variables or the caller's Pi settings.
      env: { PATH: process.env.PATH, PI_CODING_AGENT_DIR: join(root, "agent") },
      execArgv: [],
      stdio: ["ignore", "ignore", "pipe", "ipc"],
    });
    this.child.stderr?.on("data", (chunk) => {
      this.stderr = `${this.stderr}${chunk}`.slice(-8000);
    });
    this.exited = new Promise<void>((resolveExit) => {
      const finish = () => {
        if (this.ended) return;
        this.ended = true;
        this.child.stderr?.destroy();
        const error = new Error(`Package worker exited: ${this.stderr}`);
        for (const waiter of this.pending.values()) waiter.reject(error);
        this.pending.clear();
        this.events.emit("exit", error);
        resolveExit();
      };
      this.child.once("exit", finish);
      this.child.once("error", () => {
        if (this.child.pid) this.child.kill("SIGKILL");
        else finish();
      });
    });
    this.child.on("message", (frame: Frame) => {
      if (frame.event) {
        this.frames.push(frame);
        this.events.emit("frame");
      } else if (frame.id !== undefined) {
        const waiter = this.pending.get(frame.id);
        this.pending.delete(frame.id);
        if (frame.error) waiter?.reject(new Error(`${frame.error}; ${this.stderr}`));
        else waiter?.resolve(frame.value);
      }
    });
  }
  static async launch(entry: string, root: string, packageEntry: string, sessionFile = "", blocks = ["alpha", "beta"]) {
    const driver = new PackageDriver(entry, root, packageEntry, sessionFile, blocks);
    cleanup.push(() => driver.close(true));
    // Startup has its own handshake; command/recovery deadlines do not run before readiness.
    await driver.event("booted", 2000);
    const ready = (await driver.event("ready", 2000)) as { sessionFile: string; sessionId: string };
    driver.ready = true;
    return { driver, ...ready };
  }
  event(name: string, timeout = 1500): Promise<unknown> {
    return new Promise((resolveEvent, reject) => {
      const cleanupWait = () => {
        clearTimeout(deadline);
        this.events.off("frame", check);
        this.events.off("exit", fail);
      };
      const fail = (error: Error) => {
        cleanupWait();
        reject(error);
      };
      const check = () => {
        const index = this.frames.findIndex((frame) => frame.event === name);
        if (index < 0) return;
        const [frame] = this.frames.splice(index, 1);
        cleanupWait();
        resolveEvent(frame?.data);
      };
      const deadline = setTimeout(() => fail(new Error(`Missing package checkpoint ${name}; ${this.stderr}`)), timeout);
      this.events.on("frame", check);
      this.events.once("exit", fail);
      if (this.ended) fail(new Error(`Package worker exited: ${this.stderr}`));
      else check();
    });
  }
  request<T = unknown>(command: PackageCommand): Promise<T> {
    assert.ok(this.ready && !this.ended, "Package worker must be ready");
    const id = ++this.nextId;
    return new Promise<T>((fulfill, reject) => {
      const deadline = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Package command timed out: ${command.op}; ${this.stderr}`));
      }, 1500);
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(deadline);
          fulfill(value as T);
        },
        reject: (error) => {
          clearTimeout(deadline);
          reject(error);
        },
      });
      this.child.send({ ...command, id }, (error) => {
        if (!error) return;
        this.pending.get(id)?.reject(error);
        this.pending.delete(id);
      });
    });
  }
  invoke(name: string, params = {}) {
    return this.request<PackageToolResult>({ op: "invoke", name, params });
  }
  evidence() {
    return this.request<PackageEvidence>({ op: "evidence" });
  }
  async close(hard = false) {
    if (this.ended) return;
    try {
      if (hard) this.child.kill("SIGKILL");
      else {
        await this.request({ op: "shutdown" });
        if (this.child.connected) this.child.disconnect();
      }
    } finally {
      if (hard || this.child.connected) this.child.kill("SIGKILL");
      await this.exited;
    }
  }
}

let workerDirectory: string;
let workerEntry: string;
const packageEntry = resolve("packages/pi-subagents");
const cleanup: (() => Promise<unknown>)[] = [];
beforeAll(async () => {
  await mkdir(resolve("node_modules/.cache"), { recursive: true });
  workerDirectory = await mkdtemp(resolve("node_modules/.cache/subagents-package-"));
  workerEntry = join(workerDirectory, "worker.mjs");
  await build({
    entryPoints: [resolve("packages/pi-subagents/test/durable-package-worker.ts")],
    outfile: workerEntry,
    bundle: true,
    packages: "external",
    platform: "node",
    format: "esm",
    target: "node22",
  });
});
afterEach(async () => {
  const errors: unknown[] = [];
  for (const close of cleanup.splice(0).reverse()) {
    try {
      await close();
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length) throw new AggregateError(errors, "Package worker cleanup failed");
});
afterAll(async () => {
  if (workerDirectory) await rm(workerDirectory, { recursive: true, force: true });
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "subagents-package-restart-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "agent"), { mode: 0o700 });
  await writeFile(join(root, "agent", "pi-subagents.json"), JSON.stringify({ durable: true }));
  return root;
}
async function disk(path: string): Promise<DiskEntry[]> {
  return (await readFile(path, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
}
async function lockFor(driver: PackageDriver) {
  const directory = `/proc/${driver.child.pid}/fd`;
  const targets = await Promise.all(
    (await readdir(directory)).map(async (fd) => {
      try {
        return await readlink(join(directory, fd));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
        throw error;
      }
    }),
  );
  const locks = targets.filter((target) => target.endsWith("/owner.lock"));
  expect(locks).toHaveLength(1);
  const path = locks[0] as string;
  const inode = await stat(path);
  return { path, ino: inode.ino, dev: inode.dev };
}
function prefix(before: PackageRequest, after: PackageRequest) {
  expect(after.system).toEqual(before.system);
  expect(after.tools).toEqual(before.tools);
  expect(after.messages.slice(0, before.messages.length)).toEqual(before.messages);
}
async function waitAndRelease(driver: PackageDriver, conversationId: string, task: string) {
  const waiting = driver.invoke("subagent_wait", { conversationId, timeout: 1 });
  await driver.event("tool:subagent_wait");
  await driver.request({ op: "release", task });
  return waiting;
}

// Uses the already-built package. The root check/build gate owns dist; this test never publishes it.
describe.skipIf(process.platform !== "linux")("actual generated Pi package cold restart", () => {
  it("reopens the original Pi main file after SIGKILL, recovers its child and reuses retained history", async () => {
    const root = await fixture();
    const a = await PackageDriver.launch(workerEntry, root, packageEntry);
    const spawned = await a.driver.invoke("subagent_spawn", { task: "alpha" });
    const conversationId = spawned.value.conversationId as string;
    expect(conversationId).toMatch(/^[1-9]\d*$/u);
    const originalChild = (await a.driver.event("child:alpha")) as PackageRequest;
    const before = await a.driver.evidence();
    const owner = await lockFor(a.driver);
    expect(before.originalAgentSession).toBe(true);
    expect(JSON.stringify(before.entries)).toContain("original-main-user");
    expect(JSON.stringify(before.entries)).toContain("Original package main answer");
    await a.driver.close(true);
    // Do not unlink owner.lock: B must acquire a fresh native descriptor for the SAME inode.
    const b = await PackageDriver.launch(workerEntry, root, packageEntry, a.sessionFile);
    expect(b.sessionFile).toBe(a.sessionFile);
    expect(b.sessionId).toBe(a.sessionId);
    expect(await lockFor(b.driver)).toEqual(owner);
    const recoveredChild = (await b.driver.event("child:alpha")) as PackageRequest;
    prefix(originalChild, recoveredChild);
    expect((await b.driver.invoke("subagent_status", {})).value).toMatchObject({
      conversations: [{ conversationId, state: "running" }],
    });
    const waited = await waitAndRelease(b.driver, conversationId, "alpha");
    expect(waited.value).toMatchObject({
      conversationId,
      timedOut: false,
      outcome: "completed",
      result: "child:alpha",
    });
    const saved = await disk(a.sessionFile);
    expect(saved).toContainEqual(
      expect.objectContaining({
        type: "message",
        message: expect.objectContaining({ toolCallId: waited.toolCallId, details: waited.details }),
      }),
    );
    await b.driver.invoke("subagent_send", { conversationId, message: "beta", whenBusy: "followUp" });
    const secondChild = (await b.driver.event("child:beta")) as PackageRequest;
    prefix(recoveredChild, secondChild);
    expect(JSON.stringify(secondChild.messages)).toContain("child:alpha");
    expect((await waitAndRelease(b.driver, conversationId, "beta")).value).toMatchObject({
      conversationId,
      outcome: "completed",
      result: "child:beta",
    });
    expect((await b.driver.invoke("subagent_status", { conversationId })).value).toMatchObject({
      conversations: [{ conversationId, state: "idle" }],
    });
    const after = await b.driver.evidence();
    expect(after.originalAgentSession).toBe(true);
    expect(after.entries.slice(0, before.entries.length)).toEqual(before.entries);
    prefix(before.mainRequests.at(-1) as PackageRequest, after.mainRequests[0] as PackageRequest);
    expect(JSON.stringify(after.childRequests)).not.toMatch(/original-main-user|Original package main|action-\d/u);
    expect(after.errors).toEqual([]);
    // Both completions were received by persisted wait results; no duplicate automatic model-visible report.
    expect(
      (await disk(a.sessionFile)).filter((entry) => entry.customType === "pi-subagents.durable-report.v1"),
    ).toEqual([]);
    expect(await readdir(join(root, "agent"))).not.toContain("auth.json");
    expect(await readdir(join(root, "agent"))).not.toContain("models.json");
    await b.driver.close();
  });

  it("deduplicates an actual persisted Pi report after death between append and durable acknowledgement", async () => {
    const root = await fixture();
    const a = await PackageDriver.launch(workerEntry, root, packageEntry);
    const conversationId = (await a.driver.invoke("subagent_spawn", { task: "alpha" })).value.conversationId as string;
    await a.driver.event("child:alpha");
    const before = await a.driver.evidence();
    const owner = await lockFor(a.driver);
    await a.driver.request({ op: "arm-report-crash" });
    await a.driver.request({ op: "release", task: "alpha" });
    const appended = (await a.driver.event("report:appended")) as { entryId: string };
    const crashDisk = await disk(a.sessionFile);
    expect(crashDisk.filter((entry) => entry.id === appended.entryId)).toHaveLength(1);
    expect(crashDisk.at(-1)?.customType).toBe("pi-subagents.durable-report.v1");
    await a.driver.close(true);
    const b = await PackageDriver.launch(workerEntry, root, packageEntry, a.sessionFile);
    expect(await lockFor(b.driver)).toEqual(owner);
    expect((await b.driver.invoke("subagent_status", {})).value).toMatchObject({
      conversations: [{ conversationId, state: "idle", outcome: "completed" }],
    });
    expect((await b.driver.invoke("subagent_wait", { conversationId, timeout: 1 })).value).toMatchObject({
      conversationId,
      timedOut: false,
      outcome: "completed",
      result: "child:alpha",
    });
    const after = await b.driver.evidence();
    expect(after.sessionId).toBe(before.sessionId);
    expect(after.entries.slice(0, crashDisk.length)).toEqual(crashDisk);
    expect(after.childRequests).toEqual([]); // Saved result, not another child generation.
    const reports = (await disk(a.sessionFile)).filter(
      (entry) => entry.customType === "pi-subagents.durable-report.v1",
    );
    expect(reports).toEqual([crashDisk.at(-1)]);
    expect(after.errors).toEqual([]);
    await b.driver.close();
  });
});
