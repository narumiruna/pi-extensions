import { type ChildProcess, fork } from "node:child_process";
import { EventEmitter } from "node:events";
import { chmod, lstat, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { awaitWithContext, type Context } from "@earendil-works/chord/context";
import { build } from "esbuild";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { type DurableProfile, type DurableRuntimeOptions, DurableSubagentRuntime } from "../src/durable-runtime.js";
import type { DurableState } from "../src/durable-state.js";
import { runtimeModels } from "./durable-runtime-worker.js";

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  const errors: unknown[] = [];
  for (const close of cleanup.splice(0).reverse()) {
    try {
      await close();
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length) throw new AggregateError(errors, "Production durable test cleanup failed");
});

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
class Gates {
  readonly events = new EventEmitter();
  private readonly entered = new Set<string>();
  private readonly blocked = new Map<string, ReturnType<typeof deferred>>();
  constructor(...names: string[]) {
    for (const name of names) this.blocked.set(name, deferred());
  }
  checkpoint = async (name: string, context: Context) => {
    this.entered.add(name);
    this.events.emit(name);
    const blocked = this.blocked.get(name);
    if (blocked) await awaitWithContext(blocked.promise, context);
  };
  reached(name: string): Promise<void> {
    if (this.entered.has(name)) return Promise.resolve();
    return new Promise((resolve) => this.events.once(name, resolve));
  }
  release(name: string) {
    this.blocked.get(name)?.resolve(undefined);
    this.blocked.delete(name);
  }
}
async function directory() {
  const root = await mkdtemp(join(tmpdir(), "subagents-runtime-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  return root;
}
async function fixture(options: Partial<DurableRuntimeOptions> = {}, gates = new Gates()) {
  const source = runtimeModels(gates.checkpoint);
  const root = options.directory ?? (await directory());
  const runtime = await DurableSubagentRuntime.open({
    directory: root,
    binding: "main:branch",
    models: source.models,
    authorize: async () => {},
    checkpoint: gates.checkpoint,
    ...options,
  });
  cleanup.push(() => runtime.shutdown());
  const profile: DurableProfile = {
    model: source.model,
    thinkingLevel: "off",
    tools: ["read"],
    cwd: root,
    trusted: true,
  };
  return { runtime, profile, root, gates, ...source };
}
async function acknowledge(runtime: DurableSubagentRuntime) {
  for (const report of await runtime.reports()) await runtime.acknowledge(report.id);
}
async function settled(runtime: DurableSubagentRuntime, id: string) {
  const result = await runtime.wait(id, 1000);
  expect(result.timedOut).toBe(false);
  return result;
}

// These tests exercise production classes, native tools, actual JSONL storage and parent-FD flock ownership.
describe.skipIf(process.platform !== "linux")("production durable subagent runtime", () => {
  it("reuses isolated conversations and retains their normalized model context", async () => {
    const f = await fixture();
    const first = await f.runtime.spawn("pi-call/spawn:1", "private-alpha", f.profile, null);
    expect(first).toEqual({ conversationId: expect.stringMatching(/^[1-9]\d*$/u), requestId: "pi-call/spawn:1" });
    expect(await settled(f.runtime, first.conversationId)).toMatchObject({
      outcome: "completed",
      result: "answer:private-alpha",
      state: "running",
    });
    await acknowledge(f.runtime);
    expect(await f.runtime.status(first.conversationId)).toMatchObject({ conversations: [{ state: "idle" }] });
    await f.runtime.send(first.conversationId, "pi-call/send:2", "remember-alpha", "followUp");
    expect(await settled(f.runtime, first.conversationId)).toMatchObject({
      requestId: "pi-call/send:2",
      result: "answer:remember-alpha",
    });
    const second = await f.runtime.spawn("pi-call/spawn:3", "private-beta", f.profile, null);
    await settled(f.runtime, second.conversationId);
    expect(second.conversationId).not.toBe(first.conversationId);
    const [before, after, isolated] = f.requests;
    expect(after?.systemPrompt).toBe(before?.systemPrompt);
    expect(after?.tools).toEqual(before?.tools);
    expect(after?.messages.slice(0, before?.messages.length)).toEqual(before?.messages);
    expect(JSON.stringify(after?.messages)).toContain("answer:private-alpha");
    expect(JSON.stringify(isolated?.messages)).not.toContain("private-alpha");
    expect(Object.keys((await f.runtime.state()).agents)).toHaveLength(2);
  });

  it("deduplicates concurrent exact spawn/send retries using the original Pi call ID", async () => {
    const f = await fixture();
    const receipts = await Promise.all(
      Array.from({ length: 3 }, () => f.runtime.spawn("exact:spawn", "A", f.profile, null)),
    );
    expect(receipts[1]).toEqual(receipts[0]);
    const id = receipts[0]?.conversationId ?? "";
    await settled(f.runtime, id);
    await Promise.all(Array.from({ length: 3 }, () => f.runtime.send(id, "exact:send", "B", "followUp")));
    await settled(f.runtime, id);
    expect(f.faux.state.callCount).toBe(2);
    expect(Object.keys((await f.runtime.state()).requests)).toEqual(["exact:spawn", "exact:send"]);
    await expect(f.runtime.spawn("exact:spawn", "different", f.profile, null)).rejects.toThrow(/conflict/i);
    await expect(f.runtime.send(id, "exact:send", "different", "followUp")).rejects.toThrow(/conflict/i);
    await expect(f.runtime.send(id, "exact:send", "B", "steer")).rejects.toThrow(/conflict/i);
    const other = await f.runtime.spawn("other", "C", f.profile, null);
    await expect(f.runtime.send(other.conversationId, "exact:send", "B", "followUp")).rejects.toThrow(/conflict/i);
  });

  it.each(["timeout", "model", "tools", "trust", "cwd"] as const)(
    "rejects a spawn retry with changed %s",
    async (field) => {
      const f = await fixture();
      await f.runtime.spawn("spawn", "A", f.profile, null);
      const profile = { ...f.profile };
      if (field === "model") profile.model = { ...profile.model, modelId: "different" };
      if (field === "tools") profile.tools = ["write"];
      if (field === "trust") profile.trusted = false;
      if (field === "cwd") profile.cwd = join(f.root, "different");
      await expect(f.runtime.spawn("spawn", "A", profile, field === "timeout" ? 1000 : null)).rejects.toThrow(
        /conflict/i,
      );
      expect(Object.keys((await f.runtime.state()).agents)).toHaveLength(1);
    },
  );

  it("does not reuse a send receipt as a spawn receipt", async () => {
    const f = await fixture();
    const agent = await f.runtime.spawn("spawn", "A", f.profile, null);
    await f.runtime.send(agent.conversationId, "send", "B", "followUp");
    await expect(f.runtime.spawn("send", "B", f.profile, null)).rejects.toThrow(/conflict/i);
    await expect(f.runtime.send(agent.conversationId, "spawn", "A", "followUp")).rejects.toThrow(/conflict/i);
  });

  it("executes native read and exposes only the selected native coding tools", async () => {
    const f = await fixture();
    await writeFile(join(f.root, "input.txt"), "native file contents\n");
    const agent = await f.runtime.spawn("read", "read:input.txt", f.profile, null);
    expect(await settled(f.runtime, agent.conversationId)).toMatchObject({
      outcome: "completed",
      result: expect.stringContaining("native file contents"),
    });
    expect(f.requests[0]?.tools).toEqual([expect.objectContaining({ name: "read" })]);
    const all = { ...f.profile, tools: ["read", "write", "edit", "bash", "powershell"] };
    const other = await f.runtime.spawn("all", "list-tools", all, null);
    await settled(f.runtime, other.conversationId);
    expect(((f.requests.at(-1)?.tools ?? []) as { name: string }[]).map((tool) => tool.name).sort()).toEqual(
      [...all.tools].sort(),
    );
  });

  it.each(["followUp", "steer"] as const)(
    "keeps queued %s work and pending reports running until acknowledgement",
    async (mode) => {
      const gates = new Gates("generation:A", "generation:B");
      const f = await fixture({}, gates);
      const agent = await f.runtime.spawn("spawn", "A", f.profile, null);
      await gates.reached("generation:A");
      await f.runtime.send(agent.conversationId, "send", "B", mode);
      expect(await f.runtime.status(agent.conversationId)).toMatchObject({
        conversations: [{ state: "running", requestId: "send" }],
      });
      gates.release("generation:A");
      await gates.reached("generation:B");
      await acknowledge(f.runtime);
      expect(await f.runtime.status(agent.conversationId)).toMatchObject({ conversations: [{ state: "running" }] });
      gates.release("generation:B");
      const result = await settled(f.runtime, agent.conversationId);
      expect(result).toMatchObject({ state: "running", requestId: "send", outcome: "completed" });
      const pending = await f.runtime.reports();
      expect(pending.length).toBeGreaterThan(0);
      expect(result.reportIds).toEqual([(await f.runtime.state()).requests.send?.reportId]);
      for (const report of pending) expect(await f.runtime.report(report.id)).toMatchObject({ acknowledged: false });
      for (const id of result.reportIds) {
        await f.runtime.acknowledge(id);
        await f.runtime.acknowledge(id);
      }
      // A distinct earlier answer can arrive after the first acknowledgement.
      // The latest-only wait did not display it, so automatic delivery is still required.
      if ((await f.runtime.reports()).length)
        expect(await f.runtime.status(agent.conversationId)).toMatchObject({ conversations: [{ state: "running" }] });
      await acknowledge(f.runtime);
      expect(await f.runtime.reports()).toEqual([]);
      expect(await f.runtime.status(agent.conversationId)).toMatchObject({ conversations: [{ state: "idle" }] });
    },
  );

  it("does not acknowledge earlier distinct answers that a latest-only wait did not display", async () => {
    const f = await fixture();
    const agent = await f.runtime.spawn("first", "A", f.profile, null);
    await settled(f.runtime, agent.conversationId);
    await f.runtime.send(agent.conversationId, "second", "B", "followUp");
    const waited = await settled(f.runtime, agent.conversationId);
    const state = await f.runtime.state();
    expect(waited.result).toBe("answer:B");
    expect(state.requests.first?.reportId).not.toBe(state.requests.second?.reportId);
    expect(waited.reportIds).toEqual([state.requests.second?.reportId]);
    for (const id of waited.reportIds) await f.runtime.acknowledge(id);
    expect(await f.runtime.reports()).toEqual([expect.objectContaining({ requestId: "first", result: "answer:A" })]);
    expect(await f.runtime.status(agent.conversationId)).toMatchObject({ conversations: [{ state: "running" }] });
    await acknowledge(f.runtime);
    expect(await f.runtime.status(agent.conversationId)).toMatchObject({ conversations: [{ state: "idle" }] });
  });

  it("times out or cancels only the waiter, not its durable assignment", async () => {
    const gates = new Gates("generation:A");
    const f = await fixture({}, gates);
    const agent = await f.runtime.spawn("spawn", "A", f.profile, null);
    await gates.reached("generation:A");
    expect(await f.runtime.wait(agent.conversationId, 0)).toMatchObject({
      timedOut: true,
      state: "running",
      reportIds: [],
    });
    const abort = new AbortController();
    const waiting = f.runtime.wait(agent.conversationId, undefined, abort.signal);
    const rejected = expect(waiting).rejects.toThrow();
    abort.abort(new Error("caller cancelled"));
    await rejected;
    expect((await f.runtime.state()).requests.spawn).toMatchObject({ outcome: null, cancelOutcome: null });
    gates.release("generation:A");
    expect(await settled(f.runtime, agent.conversationId)).toMatchObject({ outcome: "completed" });
  });

  it("persists an execution deadline and stops work without requiring a waiter", async () => {
    const f = await fixture();
    const agent = await f.runtime.spawn("spawn", "never dispatched", f.profile, 0);
    expect(await settled(f.runtime, agent.conversationId)).toMatchObject({ outcome: "timed_out", state: "idle" });
    const request = (await f.runtime.state()).requests.spawn;
    expect(request?.deadline).toBe(request?.startedAt);
    expect(f.faux.state.callCount).toBe(0);
    expect(await f.runtime.reports()).toEqual([]);
    await f.runtime.send(agent.conversationId, "new", "B", "followUp");
    expect(await settled(f.runtime, agent.conversationId)).toMatchObject({ outcome: "completed" });
  });

  it("enforces the persistent execution deadline during an active generation", async () => {
    const gates = new Gates("generation:A");
    const finished = deferred();
    const f = await fixture({ changed: () => finished.resolve() }, gates);
    const agent = await f.runtime.spawn("spawn", "A", f.profile, 500);
    await gates.reached("generation:A");
    await finished.promise;
    expect((await f.runtime.state()).requests.spawn).toMatchObject({ outcome: "timed_out" });
    expect(await settled(f.runtime, agent.conversationId)).toMatchObject({ outcome: "timed_out", state: "idle" });
    await f.runtime.send(agent.conversationId, "new", "B", "followUp");
    expect(await settled(f.runtime, agent.conversationId)).toMatchObject({ outcome: "completed" });
  });

  it("reports a provider failure without destroying the reusable conversation", async () => {
    const f = await fixture();
    const agent = await f.runtime.spawn("spawn", "fail", f.profile, null);
    expect(await settled(f.runtime, agent.conversationId)).toMatchObject({ outcome: "failed", state: "running" });
    expect(await f.runtime.reports()).toEqual([expect.objectContaining({ outcome: "failed", suppressed: false })]);
    await acknowledge(f.runtime);
    await f.runtime.send(agent.conversationId, "new", "B", "followUp");
    expect(await settled(f.runtime, agent.conversationId)).toMatchObject({ outcome: "completed" });
  });

  it("stops captured work, rejects admission while stopping and cannot replay stop against new work", async () => {
    const gates = new Gates("generation:A", "before-stop", "generation:B");
    const f = await fixture({}, gates);
    const agent = await f.runtime.spawn("spawn", "A", f.profile, null);
    await gates.reached("generation:A");
    const stopping = f.runtime.stop(agent.conversationId, "stop-call");
    await gates.reached("before-stop");
    await expect(f.runtime.send(agent.conversationId, "too-early", "B", "followUp")).rejects.toThrow(/stopping/i);
    gates.release("before-stop");
    expect(await stopping).toEqual({ conversationId: agent.conversationId, state: "idle" });
    expect(await settled(f.runtime, agent.conversationId)).toMatchObject({ outcome: "cancelled", state: "idle" });
    await f.runtime.send(agent.conversationId, "new", "B", "followUp");
    await gates.reached("generation:B");
    await f.runtime.stop(agent.conversationId, "stop-call");
    expect((await f.runtime.state()).requests.new).toMatchObject({ outcome: null, cancelOutcome: null });
    gates.release("generation:B");
    expect(await settled(f.runtime, agent.conversationId)).toMatchObject({ outcome: "completed", result: "answer:B" });
    expect(JSON.stringify(f.requests.at(-1)?.messages)).toContain("A");
    await f.runtime.stop(agent.conversationId, "stop-call");
    expect(await f.runtime.reports()).toEqual([expect.objectContaining({ requestId: "new", suppressed: false })]);
  });

  it("rejects unavailable capabilities without poisoning saved recovery policy", async () => {
    const f = await fixture();
    const agent = await f.runtime.spawn("spawn", "A", f.profile, null);
    await settled(f.runtime, agent.conversationId);
    const policy = await readFile(join(f.root, "policy.json"), "utf8");
    await expect(f.runtime.spawn("invalid", "B", { ...f.profile, tools: ["unavailable"] }, null)).rejects.toThrow(
      /unavailable/i,
    );
    expect(await readFile(join(f.root, "policy.json"), "utf8")).toBe(policy);
    expect(Object.keys((await f.runtime.state()).requests)).toEqual(["spawn"]);
    await f.runtime.shutdown();
    const next = await fixture({ directory: f.root });
    expect(Object.keys((await next.runtime.state()).agents)).toEqual([agent.conversationId]);
  });

  it("retains running status until a settled request publishes its report", async () => {
    const gates = new Gates("settled");
    const f = await fixture({}, gates);
    const agent = await f.runtime.spawn("spawn", "A", f.profile, null);
    await gates.reached("settled");
    expect(await f.runtime.reports()).toEqual([]);
    expect(await f.runtime.status(agent.conversationId)).toMatchObject({
      conversations: [{ state: "running", outcome: null }],
    });
    gates.release("settled");
    await settled(f.runtime, agent.conversationId);
    expect(await f.runtime.status(agent.conversationId)).toMatchObject({
      conversations: [{ state: "running", outcome: "completed" }],
    });
    await acknowledge(f.runtime);
    expect(await f.runtime.status(agent.conversationId)).toMatchObject({ conversations: [{ state: "idle" }] });
  });

  it("stop receipts reject conflicting targets and other operation kinds", async () => {
    const f = await fixture();
    const first = await f.runtime.spawn("spawn", "A", f.profile, null);
    const other = await f.runtime.spawn("other", "B", f.profile, null);
    await settled(f.runtime, first.conversationId);
    await settled(f.runtime, other.conversationId);
    await expect(f.runtime.stop(first.conversationId, "spawn")).rejects.toThrow(/conflict/i);
    await f.runtime.stop(first.conversationId, "stop");
    expect(await f.runtime.reports()).toEqual([expect.objectContaining({ conversationId: other.conversationId })]);
    await expect(f.runtime.stop(other.conversationId, "stop")).rejects.toThrow(/conflict/i);
    await expect(f.runtime.spawn("stop", "A", f.profile, null)).rejects.toThrow(/conflict/i);
    await expect(f.runtime.send(first.conversationId, "stop", "A", "followUp")).rejects.toThrow(/conflict/i);
  });

  it("suspends rather than cancels, releases waits and resumes the same request on reopen", async () => {
    const gates = new Gates("generation:A");
    const f = await fixture({}, gates);
    const agent = await f.runtime.spawn("spawn", "A", f.profile, null);
    await gates.reached("generation:A");
    const wait = f.runtime.wait(agent.conversationId, undefined);
    const cancelled = expect(wait).rejects.toThrow();
    await Promise.all([f.runtime.shutdown(), f.runtime.shutdown()]);
    await cancelled;
    await expect(f.runtime.status()).rejects.toThrow(/suspended/i);
    const reopened = await fixture({ directory: f.root });
    expect((await reopened.runtime.state()).requests.spawn).toMatchObject({ outcome: null, cancelOutcome: null });
    expect(await reopened.runtime.spawn("spawn", "A", reopened.profile, null)).toEqual(agent);
    expect(await settled(reopened.runtime, agent.conversationId)).toMatchObject({ outcome: "completed" });
    expect(Object.keys((await reopened.runtime.state()).agents)).toHaveLength(1);
  });

  it("preserves pending report identity and acknowledgement across reopen", async () => {
    const f = await fixture();
    const agent = await f.runtime.spawn("spawn", "A", f.profile, null);
    const result = await settled(f.runtime, agent.conversationId);
    const reports = await f.runtime.reports();
    await f.runtime.shutdown();
    const next = await fixture({ directory: f.root });
    expect(await next.runtime.reports()).toEqual(reports);
    expect((await settled(next.runtime, agent.conversationId)).reportIds).toEqual(result.reportIds);
    await acknowledge(next.runtime);
    await next.runtime.shutdown();
    const last = await fixture({ directory: f.root });
    expect(await last.runtime.reports()).toEqual([]);
    expect(await last.runtime.report(reports[0]?.id ?? "")).toMatchObject({ acknowledged: true });
    expect(await last.runtime.status()).toMatchObject({ conversations: [{ state: "idle" }] });
  });

  it.each(["binding", "runtime", "trust", "credentials"] as const)(
    "blocks %s mismatch before recovery and preserves stored execution bytes",
    async (kind) => {
      const gates = new Gates("generation:A");
      const f = await fixture({}, gates);
      await f.runtime.spawn("spawn", "A", f.profile, null);
      await gates.reached("generation:A");
      await f.runtime.shutdown();
      const policyFile = join(f.root, "policy.json");
      const original = await readFile(policyFile, "utf8");
      if (kind === "runtime") {
        const policy = JSON.parse(original);
        policy.runtime = "incompatible";
        await writeFile(policyFile, JSON.stringify(policy));
      }
      const snapshot = await storedBytes(f.root);
      const source = runtimeModels();
      const profiles: (DurableProfile | undefined)[] = [];
      await expect(
        DurableSubagentRuntime.open({
          directory: f.root,
          binding: kind === "binding" ? "other:branch" : "main:branch",
          models: source.models,
          authorize: async (profile) => {
            profiles.push(profile);
            if (kind === "credentials" || (kind === "trust" && profile)) throw new Error("Authorization denied");
          },
        }),
      ).rejects.toThrow();
      expect(source.faux.state.callCount).toBe(0);
      expect(await storedBytes(f.root)).toEqual(snapshot);
      if (kind === "trust") expect(profiles.some((profile) => profile?.trusted)).toBe(true);
      await writeFile(policyFile, original);
      const next = await fixture({ directory: f.root });
      expect(Object.keys((await next.runtime.state()).requests)).toEqual(["spawn"]);
    },
  );

  it("rejects unsafe paths and duplicate owners without replacing the existing lock", async () => {
    const f = await fixture();
    const lock = join(f.root, "owner.lock");
    const inode = (await lstat(lock)).ino;
    expect((await lstat(f.root)).mode & 0o777).toBe(0o700);
    expect((await lstat(lock)).mode & 0o777).toBe(0o600);
    expect((await lstat(join(f.root, "policy.json"))).mode & 0o777).toBe(0o600);
    await expect(fixture({ directory: f.root })).rejects.toThrow(/live owner/i);
    expect((await lstat(lock)).ino).toBe(inode);
    const root = await directory();
    const alias = join(root, "alias");
    await symlink(f.root, alias);
    await expect(fixture({ directory: alias })).rejects.toThrow();
    const unsafe = await directory();
    await chmod(unsafe, 0o755);
    await expect(fixture({ directory: unsafe })).rejects.toThrow(/private 0700/i);
    expect(await readdir(unsafe)).toEqual([]);
  });

  it.each(["0", "01", "-1", "1.0", "9007199254740992", "1\u001b[2J"])(
    "rejects noncanonical conversation ID %j",
    async (id) => {
      const f = await fixture();
      await expect(f.runtime.status(id)).rejects.toThrow(/Invalid/);
      await expect(f.runtime.wait(id, 0)).rejects.toThrow(/Invalid/);
      await expect(f.runtime.send(id, "send", "A", "followUp")).rejects.toThrow(/Invalid/);
      await expect(f.runtime.stop(id, "stop")).rejects.toThrow(/Invalid/);
    },
  );
});

async function storedBytes(root: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  async function walk(directory: string, prefix = "") {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const name = join(prefix, entry.name);
      if (entry.isDirectory()) await walk(join(directory, entry.name), name);
      else result[name] = await readFile(join(directory, entry.name), "base64");
    }
  }
  await walk(root);
  return result;
}

// Worker commands and checkpoint deadlines start only after the ready handshake.
class Worker {
  readonly child: ChildProcess;
  readonly exited: Promise<void>;
  private readonly events = new EventEmitter();
  private readonly seen = new Set<string>();
  private readonly pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
  private nextId = 0;
  private ended = false;
  private stderr = "";
  constructor(entry: string, root: string, blocks: string[]) {
    this.child = fork(entry, ["--durable-runtime-worker", root, JSON.stringify(blocks)], {
      execArgv: [],
      env: { PATH: process.env.PATH },
      stdio: ["ignore", "ignore", "pipe", "ipc"],
    });
    this.child.stderr?.on("data", (data) => {
      this.stderr = `${this.stderr}${data}`.slice(-4000);
    });
    this.exited = new Promise((resolve) => {
      this.child.once("exit", () => {
        this.ended = true;
        const error = new Error(`Runtime worker exited: ${this.stderr}`);
        for (const pending of this.pending.values()) pending.reject(error);
        this.pending.clear();
        this.events.emit("exit", error);
        resolve();
      });
    });
    this.child.on("error", (error) => this.events.emit("exit", error));
    this.child.on("message", (frame: { event?: string; id?: number; value?: unknown; error?: string }) => {
      if (frame.event) {
        this.seen.add(frame.event);
        this.events.emit(frame.event);
      } else if (frame.id !== undefined) {
        const pending = this.pending.get(frame.id);
        this.pending.delete(frame.id);
        if (frame.error) pending?.reject(new Error(frame.error));
        else pending?.resolve(frame.value);
      }
    });
  }
  event(name: string, timed = true): Promise<void> {
    if (this.seen.has(name)) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const finish = (error?: Error) => {
        clearTimeout(timer);
        this.events.off(name, arrived);
        this.events.off("exit", failed);
        if (error) reject(error);
        else resolve();
      };
      const arrived = () => finish();
      const failed = (error: Error) => finish(error);
      const timer = timed
        ? setTimeout(() => finish(new Error(`Missing runtime checkpoint ${name}: ${this.stderr}`)), 1500)
        : undefined;
      this.events.once(name, arrived);
      this.events.once("exit", failed);
      if (this.ended) finish(new Error(`Runtime worker exited: ${this.stderr}`));
    });
  }
  request<T = unknown>(op: string, fields: Record<string, unknown> = {}): Promise<T> {
    const id = ++this.nextId;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Runtime command timed out: ${op}: ${this.stderr}`));
      }, 1500);
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value as T);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      this.child.send({ ...fields, op, id }, (error) => {
        if (error) {
          this.pending.get(id)?.reject(error);
          this.pending.delete(id);
        }
      });
    });
  }
  async kill() {
    if (!this.ended) {
      this.child.kill("SIGKILL");
      await this.exited;
    }
  }
}
let workerDirectory: string;
let workerEntry: string;
beforeAll(async () => {
  await mkdir(join(process.cwd(), "node_modules/.cache"), { recursive: true });
  workerDirectory = await mkdtemp(join(process.cwd(), "node_modules/.cache/subagents-runtime-"));
  workerEntry = join(workerDirectory, "worker.mjs");
  await build({
    entryPoints: ["packages/pi-subagents/test/durable-runtime-worker.ts"],
    outfile: workerEntry,
    bundle: true,
    packages: "external",
    platform: "node",
    format: "esm",
    target: "es2022",
    logLevel: "silent",
  });
});
afterAll(async () => {
  if (workerDirectory) await rm(workerDirectory, { recursive: true, force: true });
});
async function worker(root: string, ...blocks: string[]) {
  const child = new Worker(workerEntry, root, blocks);
  cleanup.push(() => child.kill());
  await child.event("ready", false);
  return child;
}

describe.skipIf(process.platform !== "linux")("production durable runtime cold-process recovery", () => {
  // Arrange the real crash and cold reopen in separate hooks. Only ready-worker
  // commands and recovery assertions use the unchanged five-second test budget.
  // The shared afterEach cleanup also reaps workers when either setup hook fails.
  describe.each(["admitted", "submitted", "settled"])("SIGKILL at %s", (stage) => {
    let root: string;
    let conversationId: string;
    let inode: number;
    let second: Worker;
    beforeEach(async () => {
      root = await directory();
      const first = await worker(root, stage);
      const spawn = first.request<{ conversationId: string; requestId: string }>("spawn").catch(() => undefined);
      await first.event(stage);
      const snapshot = await first.request<DurableState>("state");
      conversationId = String(snapshot.requests["tool-spawn"]?.conversationId);
      inode = (await lstat(join(root, "owner.lock"))).ino;
      await first.kill();
      await spawn;
    });
    beforeEach(async () => {
      second = await worker(root);
    });
    it("recovers without duplicate admissions or reports", async () => {
      expect((await lstat(join(root, "owner.lock"))).ino).toBe(inode);
      expect(await second.request("spawn")).toEqual({ conversationId, requestId: "tool-spawn" });
      const result = await second.request("wait", { conversationId });
      expect(result).toMatchObject({ timedOut: false, outcome: "completed", result: "answer:A" });
      const state = await second.request<DurableState>("state");
      expect(Object.keys(state.agents)).toEqual([conversationId]);
      expect(Object.keys(state.requests)).toEqual(["tool-spawn"]);
      expect(Object.values(state.reports)).toHaveLength(1);
    });
  });

  describe.each(["before-stop", "stop-intent"])("accepted stop at %s", (stage) => {
    let root: string;
    let conversationId: string;
    let second: Worker;
    beforeEach(async () => {
      root = await directory();
      const first = await worker(root, "generation:A", stage);
      ({ conversationId } = await first.request<{ conversationId: string }>("spawn"));
      await first.event("generation:A");
      const stop = first.request("stop", { conversationId }).catch(() => undefined);
      await first.event(stage);
      await first.kill();
      await stop;
    });
    beforeEach(async () => {
      second = await worker(root, "generation:A", "generation:B");
    });
    it("recovers before generation can restart", async () => {
      expect(await second.request("wait", { conversationId })).toMatchObject({
        timedOut: false,
        outcome: "cancelled",
        state: "idle",
      });
      expect(await second.request("model-calls")).toBe(0);
      await second.request("send", { conversationId, requestId: "new", task: "B" });
      await second.event("generation:B");
      await second.request("stop", { conversationId });
      expect((await second.request<DurableState>("state")).requests.new).toMatchObject({
        outcome: null,
        cancelOutcome: null,
      });
      await second.request("release", { checkpoint: "generation:B" });
      expect(await second.request("wait", { conversationId })).toMatchObject({
        outcome: "completed",
        result: "answer:B",
      });
    });
  });

  describe("expired deadline recovery", () => {
    let root: string;
    let conversationId: string;
    let deadline: number | null | undefined;
    let second: Worker;
    beforeEach(async () => {
      root = await directory();
      const first = await worker(root, "submitted", "generation:A");
      ({ conversationId } = await first.request<{ conversationId: string }>("spawn", { timeoutMs: 1000 }));
      // A real backend waiter times out while submit is blocked. No polling or test sleep.
      await first.event("submitted");
      const before = await first.request<DurableState>("state");
      deadline = before.requests["tool-spawn"]?.deadline;
      expect(deadline).not.toBeNull();
      expect(await first.request("wait", { conversationId })).toMatchObject({ timedOut: true });
      expect(deadline).toBeLessThanOrEqual(Date.now());
      await first.kill();
    });
    beforeEach(async () => {
      second = await worker(root, "generation:A");
    });
    it("honors a persisted expired deadline before scheduling recovered model work", async () => {
      expect(await second.request("wait", { conversationId })).toMatchObject({
        timedOut: false,
        outcome: "timed_out",
        state: "idle",
      });
      expect(await second.request("model-calls")).toBe(0);
      const state = await second.request<DurableState>("state");
      expect(state.requests["tool-spawn"]?.deadline).toBe(deadline);
    });
  });
});
