// Test-only IPC entry. The driver compiles this file with package imports left external.
import path from "node:path";
import type { JsonValue } from "@earendil-works/chord";
import { awaitWithContext, type Context, withCancel } from "@earendil-works/chord/context";
import { DurableFixture, fixturePolicy, type Policy } from "./durable-fixture.js";

type Command = {
  id: number;
  op: string;
  agentId?: string;
  task?: string;
  requestId?: string;
  questionId?: string;
  answer?: string;
  checkpoint?: string;
  reportId?: string;
  sessionFile?: string;
};
const directory = process.argv[2];
if (!directory || !process.send) throw new Error("Fixture worker requires a directory and IPC");
const policy: Policy = { ...fixturePolicy, ...JSON.parse(process.argv[3] ?? "{}") };
const blocks = new Set<string>(JSON.parse(process.argv[4] ?? "[]"));
const releases = new Map<string, Set<() => void>>();
const send = (value: unknown) => {
  if (process.connected) process.send?.(value, () => {});
};
async function checkpoint(name: string, data: JsonValue, context: Context): Promise<void> {
  let blocked: Promise<void> | undefined;
  let release: (() => void) | undefined;
  if (blocks.has(name)) {
    const waiters = releases.get(name) ?? new Set<() => void>();
    releases.set(name, waiters);
    blocked = new Promise<void>((done) => {
      release = done;
      waiters.add(done);
    });
  }
  send({ event: name, data });
  if (blocked) {
    try {
      await awaitWithContext(blocked, context);
    } finally {
      if (release) releases.get(name)?.delete(release);
      if (releases.get(name)?.size === 0) releases.delete(name);
    }
  }
}

const fixture = await DurableFixture.open(directory, policy, checkpoint);
let stopped = false;
type WorkerHost = Awaited<ReturnType<typeof import("./durable-worker-host.js")["openWorkerHost"]>>;
let host: WorkerHost | undefined;
let hostOpening: Promise<WorkerHost> | undefined;
async function stopWorker(): Promise<void> {
  stopped = true;
  host?.dispose();
  await Promise.all([fixture.shutdown(), hostOpening?.catch(() => undefined)]);
}
process.on("message", (raw: Command) => {
  void (async () => {
    const id = raw.agentId ?? "agent";
    switch (raw.op) {
      case "spawn":
        return fixture.spawn(id, raw.task ?? "A");
      case "assign":
        return fixture.assign(id, raw.requestId ?? "2", raw.task ?? "B");
      case "state":
        return fixture.state();
      case "wait":
        return fixture.wait(id);
      case "cancel-wait": {
        const pending = withCancel(fixture.stopping.context);
        const wait = fixture.wait(id, pending.context);
        pending.cancel(new Error("Caller stopped waiting"));
        return wait;
      }
      case "close":
        return fixture.close(id);
      case "cancel":
        return fixture.cancel(id);
      case "timeout":
        return fixture.cancel(id, true);
      case "answer":
        return fixture.answer(id, raw.questionId ?? "", raw.answer ?? "answer");
      case "main-send":
        return fixture.send(id, raw.requestId ?? "main-question", raw.task ?? "Main question");
      case "main-wait":
        return fixture.waitMessage(id, raw.requestId ?? "main-question");
      case "transcript": {
        const agent = await fixture.agent(id);
        const child = await fixture.harness.conversation(agent.conversationId, fixture.stopping.context);
        if (!child) throw new Error("Missing child");
        return child.context(fixture.stopping.context);
      }
      case "ack":
        return fixture.acknowledge(raw.reportId ?? "");
      case "host-open": {
        if (host || hostOpening) throw new Error("Host already open or initializing");
        if (stopped) throw new Error("Worker stopped");
        process.env.PI_CODING_AGENT_DIR = path.join(directory, "host-agent");
        hostOpening = (async () => {
          await checkpoint("host-initializing", {}, fixture.stopping.context);
          const { openWorkerHost } = await import("./durable-worker-host.js");
          const opened = await openWorkerHost(directory, raw.sessionFile);
          try {
            await checkpoint("host-created", {}, fixture.stopping.context);
            if (stopped) throw new Error("Worker stopped during host initialization");
            host = opened;
            return opened;
          } catch (error) {
            opened.dispose();
            throw error;
          }
        })();
        try {
          return (await hostOpening).info();
        } finally {
          hostOpening = undefined;
        }
      }
      case "host-info": {
        if (!host) throw new Error("Host not open");
        return host.info();
      }
      case "host-admit": {
        if (!host) throw new Error("Host not open");
        return host.admit(id, raw.task ?? "A");
      }
      case "host-deliver": {
        if (!host) throw new Error("Host not open");
        const receipt = await host.deliver(fixture, raw.reportId ?? "");
        await checkpoint("host-appended", { receipt }, fixture.stopping.context);
        await fixture.acknowledge(raw.reportId ?? "");
        return receipt;
      }
      case "resume":
        fixture.harness.resume();
        return null;
      case "release": {
        const name = raw.checkpoint ?? "";
        blocks.delete(name);
        for (const release of releases.get(name) ?? []) release();
        return null;
      }
      case "shutdown":
        await stopWorker();
        return process.getActiveResourcesInfo();
      default:
        throw new Error("Unknown fixture operation");
    }
  })().then(
    (value) => send({ id: raw.id, value: value ?? null }),
    (error: unknown) => send({ id: raw.id, error: error instanceof Error ? error.message : String(error) }),
  );
});
process.once("disconnect", () => {
  void stopWorker().finally(() => {
    process.exitCode = 0;
  });
});
send({ event: "ready", data: { token: fixture.token, pid: process.pid, rss: process.memoryUsage().rss } });
