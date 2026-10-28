import assert from "node:assert/strict";
import { type ChildProcess, fork } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { build } from "esbuild";
import { afterAll, beforeAll, test, vi } from "vitest";
import { localConfigPath } from "../src/settings/config-file.js";
import { pull, push } from "../src/sync/sync-mutations.js";
import { agentContext, selectRemote } from "./agent-test-helpers.js";
import { v3WebDavSettings } from "./helpers.js";
import { mergeOptions } from "./merge-options.js";
import { MockWebDavServer } from "./mock-webdav-server.js";

type State = { status?: string; checks: number; requests: number };
class ReplicaProcess {
  child: ChildProcess;
  ready: Promise<void>;
  exited: Promise<void>;
  private pending = new Map<
    number,
    { resolve(value: State): void; reject(error: unknown): void; timer: ReturnType<typeof setTimeout> }
  >();
  private sequence = 0;
  stderr = "";
  constructor(
    entry: string,
    readonly root: string,
  ) {
    this.child = fork(entry, [], {
      env: { ...process.env, PI_CODING_AGENT_DIR: root },
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    });
    this.child.stderr?.on("data", (value) => {
      this.stderr += value;
    });
    this.exited = new Promise((resolve) => this.child.once("exit", () => resolve()));
    this.ready = new Promise((resolve, reject) => {
      this.child.on("error", reject);
      this.child.on("exit", (code) => {
        reject(new Error(`replica exited ${code}: ${this.stderr}`));
        for (const pending of this.pending.values()) {
          clearTimeout(pending.timer);
          pending.reject(new Error(`replica exited: ${this.stderr}`));
        }
        this.pending.clear();
      });
      this.child.on("message", (value) => {
        const result = value as State & { id?: number; event?: string; error?: string };
        if (result.event === "ready") resolve();
        if (result.id !== undefined) {
          const pending = this.pending.get(result.id);
          if (!pending) return;
          this.pending.delete(result.id);
          clearTimeout(pending.timer);
          if (result.error) pending.reject(new Error(result.error));
          else pending.resolve(result);
        }
      });
    });
  }
  async request(command: "state" | "advance" | "stop", ms = 0): Promise<State> {
    await this.ready; // Operation deadlines start after the child handshake.
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`replica ${command} deadline: ${this.stderr}`));
      }, 2500);
      this.pending.set(id, { resolve, reject, timer });
      this.child.send({ id, command, ms });
    });
  }
  async stop() {
    if (this.child.connected) await this.request("stop");
    await this.exited;
  }
  async kill() {
    if (this.child.exitCode === null && this.child.signalCode === null) this.child.kill("SIGKILL");
    await this.exited;
  }
}
let directory: string;
let roots: [string, string, string];
let previous: string | undefined;
let entry: string;
let server: MockWebDavServer;
const processes: ReplicaProcess[] = [];
const live = () => processes.filter((item) => item.child.connected);
const advance = async (ms: number) => {
  for (let elapsed = 0; elapsed < ms; elapsed += 5000)
    await Promise.all(live().map((item) => item.request("advance", Math.min(5000, ms - elapsed))));
};
const converged = async (text: string) => {
  await vi.waitFor(
    async () => {
      const states = await Promise.all(live().map((item) => item.request("state")));
      for (const root of roots)
        assert.equal(await fs.readFile(path.join(root, "AGENTS.md"), "utf8"), text, JSON.stringify(states));
    },
    { timeout: 1500, interval: 10 },
  );
};

beforeAll(async () => {
  previous = process.env.PI_CODING_AGENT_DIR;
  directory = await fs.mkdtemp(path.join(os.tmpdir(), "pi-continuous-convergence-"));
  roots = [path.join(directory, "a"), path.join(directory, "b"), path.join(directory, "c")];
  server = await new MockWebDavServer().start();
  for (const root of roots) {
    process.env.PI_CODING_AGENT_DIR = root;
    await fs.mkdir(root);
    const settings = v3WebDavSettings({ include: ["AGENTS.md"] });
    settings.storageConnections.dav.url = server.url;
    Object.assign(settings.syncSetups.home.sync, { agentMode: true, continuous: true });
    await fs.writeFile(localConfigPath(), JSON.stringify(settings));
    await fs.writeFile(path.join(root, "AGENTS.md"), "base\n");
    if (root === roots[0]) await push(agentContext(selectRemote).ctx, mergeOptions);
    else await pull(agentContext(selectRemote).ctx, mergeOptions);
  }
  const cache = path.resolve("node_modules/.cache/pi-continuous-convergence");
  await fs.mkdir(cache, { recursive: true });
  entry = path.join(cache, `${randomUUID()}.mjs`);
  await build({
    entryPoints: [path.resolve("packages/pi-sync/test/continuous-process-child.ts")],
    outfile: entry,
    bundle: true,
    platform: "node",
    format: "esm",
    packages: "external",
    logLevel: "silent",
  });
  for (const root of [roots[0], roots[0], roots[1], roots[2]]) processes.push(new ReplicaProcess(entry, root));
  await Promise.all(processes.map((item) => item.ready));
});

afterAll(async () => {
  try {
    await Promise.all(processes.map((item) => item.kill()));
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    await server?.close();
    if (entry) await fs.rm(entry, { force: true });
    if (directory) await fs.rm(directory, { recursive: true, force: true });
  }
});

test("two local Pi processes elect one scheduler for one replica", async () => {
  const states = await Promise.all(processes.slice(0, 2).map((item) => item.request("state")));
  assert.equal(states.filter((state) => state.checks > 0).length, 1);
  assert.equal(states.filter((state) => state.status?.includes("another local owner")).length, 1);
});

test("three replicas converge from local and remote-only edits without manual commands", async () => {
  await fs.writeFile(path.join(roots[0], "AGENTS.md"), "from replica A\n");
  await advance(140_000);
  await converged("from replica A\n");
  await fs.writeFile(path.join(roots[1], "AGENTS.md"), "from replica B\n");
  await advance(140_000);
  await converged("from replica B\n");
  assert.ok((await Promise.all(live().map((item) => item.request("state")))).every((state) => state.requests === 0));
});

test("all replicas recover and converge after a server-observed temporary outage", async () => {
  const requestsBefore = server.requests.length;
  server.options.unavailable = true;
  await fs.writeFile(path.join(roots[2], "AGENTS.md"), "saved during outage\n");
  await advance(70_000);
  assert.ok(server.requests.length > requestsBefore, "the server observed the failing checks");
  const failed = await Promise.all(live().map((item) => item.request("state")));
  assert.equal(failed.filter((state) => state.status?.includes("retry scheduled")).length, 3, JSON.stringify(failed));
  server.options.unavailable = false;
  await advance(450_000);
  await converged("saved during outage\n");
  assert.ok((await Promise.all(live().map((item) => item.request("state")))).every((state) => state.requests === 0));
});

test("an idle standby takes ownership after the elected local session exits", async () => {
  const pair = processes.slice(0, 2);
  const states = await Promise.all(pair.map((item) => item.request("state")));
  const owner = states.findIndex((state) => !state.status?.includes("another local owner"));
  assert.ok(owner >= 0);
  const current = pair[owner];
  assert.ok(current);
  await current.stop();
  const successor = pair[owner === 0 ? 1 : 0];
  assert.ok(successor);
  await successor.request("advance", 6000);
  await vi.waitFor(async () => {
    const state = await successor.request("state");
    assert.ok(state.checks > 0, JSON.stringify(state));
  });
  const record = JSON.parse(await fs.readFile(path.join(roots[0], "pi-sync/continuous/owner.json"), "utf8"));
  assert.equal(record.pid, successor.child.pid);
});
