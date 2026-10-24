import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { build } from "esbuild";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import { DurableDriver } from "./durable-driver.js";
import type { Agent } from "./durable-fixture.js";

let directory: string;
let entry: string;
let buildDirectory: string;
const drivers: DurableDriver[] = [];
beforeAll(async () => {
  buildDirectory = await mkdtemp(path.join(process.cwd(), "node_modules/.cache/subagents-durable-"));
  entry = path.join(buildDirectory, "worker.mjs");
  await build({
    entryPoints: ["packages/pi-subagents/test/durable-worker.ts"],
    outdir: buildDirectory,
    entryNames: "worker",
    outExtension: { ".js": ".mjs" },
    splitting: true,
    bundle: true,
    packages: "external",
    platform: "node",
    format: "esm",
    target: "es2022",
    logLevel: "silent",
  });
});
afterAll(async () => {
  await rm(buildDirectory, { recursive: true, force: true });
});
beforeEach(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), "subagents-durable-"));
});
afterEach(async () => {
  await Promise.all(drivers.splice(0).map((driver) => driver.stop(true)));
  await rm(directory, { recursive: true, force: true });
});
async function launch(blocks: string[] = [], policy = {}): Promise<DurableDriver> {
  const driver = await DurableDriver.launch(entry, directory, blocks, policy);
  drivers.push(driver);
  return driver;
}
async function finish(driver: DurableDriver, task = "A"): Promise<Agent> {
  await driver.spawn(task);
  return driver.wait();
}

it("reuses a fresh child conversation and keeps each run and report identity", async () => {
  const driver = await launch();
  const first = await finish(driver);
  expect(first.state).toBe("standby");
  expect(first.runs["agent:1"]?.result).toContain("answer:A");
  await driver.request({ op: "assign", requestId: "2", task: "B" });
  const second = await driver.wait();
  expect(second.conversationId).toBe(first.conversationId);
  expect(second.anchorId).toBe(first.anchorId);
  expect(Object.keys(second.runs)).toEqual(["agent:1", "agent:2"]);
  const requests = [await driver.event("provider-request"), await driver.event("provider-request")];
  expect(JSON.stringify(requests)).not.toContain("Main context must not be inherited");
  expect(JSON.stringify(requests[1])).toContain("answer:A");
  const [before, after] = requests as { messages: unknown[]; systemPrompt: string; tools: unknown[] }[];
  expect(after?.systemPrompt).toBe(before?.systemPrompt);
  expect(after?.tools).toEqual(before?.tools);
  expect(after?.messages.slice(0, before?.messages.length)).toEqual(before?.messages);
  expect(Object.keys((await driver.state()).reports)).toEqual(["report:agent:1", "report:agent:2"]);
});

it.each(["before-admission", "admitted", "submitted"])(
  "recovers admission ambiguity at %s without a second child",
  async (stage) => {
    let driver = await launch([stage, "generation"]);
    const pending = driver.spawn("generation").catch(() => null);
    await driver.event(stage);
    await driver.stop(true);
    await pending;
    driver = await launch(["generation"]);
    const agent = await driver.spawn("generation");
    expect(Object.keys((await driver.state()).agents)).toEqual(["agent"]);
    await driver.event("generation");
    expect((await driver.state()).agents.agent?.conversationId).toBe(agent.conversationId);
    await driver.request({ op: "release", checkpoint: "generation" });
    expect((await driver.wait()).runs["agent:1"]?.status).toBe("completed");
    expect(Object.keys((await driver.state()).reports)).toEqual(["report:agent:1"]);
  },
);

it.each([false, true])("recovers a generation after shutdown (hard=%s)", async (hard) => {
  let driver = await launch(["generation"]);
  const original = await driver.spawn("generation");
  await driver.event("generation");
  await driver.stop(hard);
  driver = await launch(["generation"]);
  expect((await driver.state()).agents.agent?.state).toBe("running");
  await driver.request({ op: "resume" });
  await driver.event("generation");
  await driver.request({ op: "release", checkpoint: "generation" });
  const restored = await driver.wait();
  expect(restored.conversationId).toBe(original.conversationId);
  expect(restored.runs["agent:1"]?.status).toBe("completed");
});

it.each([false, true])("restores standby without another model request (hard=%s)", async (hard) => {
  let driver = await launch();
  const original = await finish(driver);
  await driver.stop(hard);
  driver = await launch();
  await driver.request({ op: "resume" });
  expect((await driver.state()).agents.agent?.state).toBe("standby");
  expect(driver.events.some((event) => event.event === "provider-request")).toBe(false);
  await driver.request({ op: "assign", requestId: "2", task: "B" });
  expect((await driver.wait()).conversationId).toBe(original.conversationId);
  expect(JSON.stringify(await driver.event("provider-request"))).toContain("answer:A");
});

it("rejects busy or conflicting requests but accepts idempotent replay", async () => {
  const driver = await launch(["generation"]);
  const agent = await driver.spawn("generation");
  await driver.event("generation");
  expect((await driver.spawn("generation")).conversationId).toBe(agent.conversationId);
  await expect(driver.spawn("different")).rejects.toThrow("payload conflict");
  await expect(driver.request({ op: "assign", requestId: "2", task: "B" })).rejects.toThrow("busy");
  await driver.request({ op: "release", checkpoint: "generation" });
  await driver.wait();
  await driver.request({ op: "assign", requestId: "2", task: "B" });
  await driver.wait();
  await driver.request({ op: "assign", requestId: "2", task: "B" });
  expect(Object.keys((await driver.state()).agents.agent?.runs ?? {})).toHaveLength(2);
});

it("cancels only the wait, not the running assignment", async () => {
  const driver = await launch(["generation"]);
  await driver.spawn("generation");
  await driver.event("generation");
  await expect(driver.request({ op: "cancel-wait" })).rejects.toThrow("Caller stopped waiting");
  expect((await driver.state()).agents.agent?.state).toBe("running");
  await driver.request({ op: "release", checkpoint: "generation" });
  expect((await driver.wait()).state).toBe("standby");
});

it.each(["cancel", "timeout"])("%s stops a run without closing its reusable agent", async (op) => {
  const driver = await launch(["generation"]);
  await driver.spawn("generation");
  await driver.event("generation");
  const cancelled = await driver.request<Agent>({ op });
  expect(cancelled.state).toBe("standby");
  expect(cancelled.runs["agent:1"]?.status).toBe(op === "timeout" ? "timed_out" : "cancelled");
  await driver.request({ op: "assign", requestId: "2", task: "B" });
  expect((await driver.wait()).runs["agent:2"]?.status).toBe("completed");
});

it("cancels admitted work before dispatch without making a provider request", async () => {
  const driver = await launch(["admitted"]);
  const spawning = driver.spawn();
  await driver.event("admitted");
  expect((await driver.request<Agent>({ op: "cancel" })).runs["agent:1"]?.status).toBe("cancelled");
  await driver.request({ op: "release", checkpoint: "admitted" });
  expect((await spawning).state).toBe("standby");
  expect(driver.events.some((event) => event.event === "provider-request")).toBe(false);
});

it("releases worker resources on orderly shutdown instead of hiding a forced kill", async () => {
  const driver = await launch(["generation"]);
  await driver.spawn("generation");
  await driver.event("generation");
  expect(driver.readyRss).toBeGreaterThan(0);
  await driver.stop();
  expect(driver.child.exitCode).toBe(0);
  expect(driver.child.signalCode).toBeNull();
  expect(driver.shutdownResources).not.toContain("Timeout");
  expect(driver.shutdownResources).not.toContain("TCPServerWrap");
  expect(driver.shutdownResources).not.toContain("FSEventWrap");
});

it.each(["generation", "safe", "unsafe"])(
  "honors persisted cancellation before resuming %s after a crash",
  async (task) => {
    let driver = await launch([task === "generation" ? "generation" : "effect", "cancel-intent", "before-cancel"]);
    await driver.spawn(task);
    await driver.event(task === "generation" ? "generation" : "effect");
    const cancelling = driver.request({ op: "cancel" }).catch(() => null);
    await driver.event("cancel-intent");
    await driver.event("before-cancel");
    await driver.stop(true);
    await cancelling;
    driver = await launch();
    await driver.request({ op: "resume" });
    const agent = await driver.wait();
    expect(agent.runs["agent:1"]?.status).toBe("cancelled");
    expect(driver.events.some((event) => event.event === "provider-request" || event.event === "effect")).toBe(false);
  },
);

it("a delayed cancellation caller cannot abort a newer assignment", async () => {
  const driver = await launch(["generation", "cancel-intent"]);
  await driver.spawn("generation");
  await driver.event("generation");
  const cancelling = driver.request<Agent>({ op: "cancel" });
  await driver.event("cancel-intent");
  expect((await driver.wait()).runs["agent:1"]?.status).toBe("cancelled");
  await driver.request({ op: "assign", requestId: "2", task: "generation" });
  await driver.event("generation");
  await driver.request({ op: "release", checkpoint: "cancel-intent" });
  expect((await cancelling).runs["agent:2"]?.status).toBe("pending");
  expect((await driver.state()).agents.agent?.state).toBe("running");
  await driver.request({ op: "release", checkpoint: "generation" });
  expect((await driver.wait()).runs["agent:2"]?.status).toBe("completed");
});

it("releases every agent waiting at a shared checkpoint", async () => {
  const driver = await launch(["generation"]);
  await driver.request({ op: "spawn", agentId: "one", task: "generation" });
  await driver.event("generation");
  await driver.request({ op: "spawn", agentId: "two", task: "generation" });
  await driver.event("generation");
  await driver.request({ op: "release", checkpoint: "generation" });
  const agents = await Promise.all([
    driver.request<Agent>({ op: "wait", agentId: "one" }),
    driver.request<Agent>({ op: "wait", agentId: "two" }),
  ]);
  expect(agents.map((agent) => agent.state)).toEqual(["standby", "standby"]);
});

it("rejects concurrent host initialization instead of losing the first owned host", async () => {
  const driver = await launch(["host-initializing"]);
  const opening = driver.request({ op: "host-open" });
  await driver.event("host-initializing");
  await expect(driver.request({ op: "host-open" })).rejects.toThrow("already open or initializing");
  await driver.request({ op: "release", checkpoint: "host-initializing" });
  await opening;
  expect(await readdir(path.join(directory, "main-sessions"))).toHaveLength(1);
});

it.each(["host-initializing", "host-created"])(
  "joins and releases host initialization during shutdown at %s",
  async (checkpoint) => {
    const driver = await launch([checkpoint]);
    const opening = driver.request({ op: "host-open" }).catch((error: Error) => error.message);
    await driver.event(checkpoint);
    await driver.request({ op: "shutdown" });
    expect(await opening).toContain("Fixture shutdown");
    await driver.stop();
    expect(driver.child.exitCode).toBe(0);
    expect(driver.child.signalCode).toBeNull();
  },
);

it("retains a failed outcome while allowing the next assignment", async () => {
  const driver = await launch();
  expect((await finish(driver, "fail")).runs["agent:1"]?.status).toBe("failed");
  await driver.request({ op: "assign", requestId: "2", task: "B" });
  expect((await driver.wait()).runs["agent:2"]?.status).toBe("completed");
});

it.each(["running", "standby"])("closes %s permanently across reopen and repeated close", async (state) => {
  let driver = await launch(["generation"]);
  if (state === "running") {
    await driver.spawn("generation");
    await driver.event("generation");
  } else await finish(driver);
  expect((await driver.request<Agent>({ op: "close" })).state).toBe("closed");
  await driver.stop();
  driver = await launch();
  expect((await driver.request<Agent>({ op: "close" })).state).toBe("closed");
  await expect(driver.request({ op: "assign", task: "B" })).rejects.toThrow("closed");
  await expect(driver.spawn()).rejects.toThrow("closed");
  expect(driver.events.some((event) => event.event === "provider-request")).toBe(false);
});

it("recovers close intent before scheduling any pending user work", async () => {
  let driver = await launch(["generation", "close-intent"]);
  await driver.spawn("generation");
  await driver.event("generation");
  const closing = driver.request({ op: "close" }).catch(() => null);
  await driver.event("close-intent");
  await driver.stop(true);
  await closing;
  driver = await launch();
  await driver.request({ op: "resume" });
  const agent = await driver.wait();
  expect(agent.state).toBe("closed");
  expect(driver.events.some((event) => event.event === "provider-request")).toBe(false);
  await expect(driver.request({ op: "assign", task: "B" })).rejects.toThrow("closed");
});

it("lets committed close intent win over late completion and reassignment", async () => {
  const driver = await launch(["settled", "close-intent"]);
  await driver.spawn();
  await driver.event("settled");
  const closing = driver.request<Agent>({ op: "close" });
  await driver.event("close-intent");
  await expect(driver.request({ op: "assign", task: "B" })).rejects.toThrow("closed");
  await driver.request({ op: "release", checkpoint: "settled" });
  await driver.request({ op: "release", checkpoint: "close-intent" });
  expect((await closing).state).toBe("closed");
  expect((await driver.state()).agents.agent?.state).toBe("closed");
});

it("rebuilds the outbox after result commit before report publication", async () => {
  let driver = await launch(["settled"]);
  await driver.spawn();
  await driver.event("settled");
  expect(Object.keys((await driver.state()).reports)).toHaveLength(0);
  await driver.stop(true);
  driver = await launch();
  await driver.request({ op: "resume" });
  expect((await driver.wait()).state).toBe("standby");
  expect(Object.keys((await driver.state()).reports)).toEqual(["report:agent:1"]);
  expect(driver.events.some((event) => event.event === "provider-request")).toBe(false);
});

it.each([false, true])("persists pending/acknowledged report state (ack=%s)", async (ack) => {
  let driver = await launch();
  await finish(driver);
  if (ack) await driver.request({ op: "ack", reportId: "report:agent:1" });
  await driver.stop(true);
  driver = await launch();
  expect((await driver.state()).reports["report:agent:1"]?.acknowledged).toBe(ack);
});

it.each([
  { task: "safe", hard: false },
  { task: "safe", hard: true },
  { task: "unsafe", hard: false },
  { task: "unsafe", hard: true },
])(
  "recovers $task external tool execution (hard=$hard) without silently repeating an unsafe effect",
  async ({ task, hard }) => {
    let driver = await launch(["effect"]);
    await driver.spawn(task);
    const effect = (await driver.event("effect")) as { file: string };
    await driver.stop(hard);
    driver = await launch();
    await driver.request({ op: "resume" });
    const agent = await driver.wait();
    expect(agent.state).toBe("standby");
    expect(await readFile(effect.file, "utf8")).toBe("effect\n");
    const requestText = JSON.stringify(await driver.event("provider-request"));
    expect(requestText).toContain(task === "safe" ? "effect completed" : "interrupted");
  },
);

it("recovers a child question and preserves the first accepted answer", async () => {
  let driver = await launch();
  await driver.spawn("question");
  const question = (await driver.event("question")) as { id: string };
  await driver.stop(true);
  driver = await launch();
  await driver.request({ op: "resume" });
  await driver.event("question");
  expect((await driver.state()).agents.agent?.state).toBe("running");
  await driver.request({ op: "answer", questionId: question.id, answer: "first" });
  await driver.request({ op: "answer", questionId: question.id, answer: "second" });
  expect((await driver.wait()).questions[question.id]?.answer).toBe("first");
  await expect(driver.request({ op: "answer", questionId: "unknown" })).rejects.toThrow("unavailable");
});

it("rejects a competing worker before opening its store and permits supervised recovery", async () => {
  const driver = await launch(["generation"]);
  await driver.spawn("generation");
  await driver.event("generation");
  const before = await readdir(path.join(directory, "store"));
  await expect(launch()).rejects.toThrow("EEXIST");
  expect(await readdir(path.join(directory, "store"))).toEqual(before);
  await driver.stop(true);
  expect((await launch()).child.pid).not.toBe(driver.child.pid);
});

it.each([
  { session: "other" },
  { branch: "fork" },
  { capabilities: "expanded" },
  { code: "changed" },
  { trusted: false },
  { credentials: false },
])("blocks unauthorized recovery before store mutation: %j", async (policy) => {
  const driver = await launch();
  await finish(driver);
  await driver.stop();
  const files = await readdir(path.join(directory, "store"));
  const snapshots = await Promise.all(
    files.map(async (file) => [file, await readFile(path.join(directory, "store", file), "utf8")]),
  );
  await expect(launch([], policy)).rejects.toThrow("Recovery blocked");
  expect(
    await Promise.all(files.map(async (file) => [file, await readFile(path.join(directory, "store", file), "utf8")])),
  ).toEqual(snapshots);
  expect((await (await launch()).state()).agents.agent?.state).toBe("standby");
});

it("refuses an unverified stale lease instead of guessing by PID", async () => {
  await writeFile(path.join(directory, "owner.lock"), "unknown-owner");
  await expect(launch()).rejects.toThrow("EEXIST");
  expect(await readFile(path.join(directory, "owner.lock"), "utf8")).toBe("unknown-owner");
});

it.each(["before-delivery", "append-before-ack", "after-ack"])(
  "reconciles a persistent outbox with a real Pi host after a process kill at %s",
  async (stage) => {
    let driver = await launch(stage === "append-before-ack" ? ["host-appended"] : []);
    const host = await driver.request<{ sessionFile: string; sessionId: string }>({ op: "host-open" });
    await driver.request({ op: "host-admit", task: "A" });
    await finish(driver);
    let pending: Promise<unknown> | undefined;
    if (stage === "append-before-ack") {
      pending = driver.request({ op: "host-deliver", reportId: "report:agent:1" }).catch(() => null);
      await driver.event("host-appended");
      expect((await driver.state()).reports["report:agent:1"]?.acknowledged).toBe(false);
    } else if (stage === "after-ack") {
      await driver.request({ op: "host-deliver", reportId: "report:agent:1" });
    }
    await driver.stop(true);
    await pending;
    driver = await launch();
    const restored = await driver.request<{ sessionId: string; intents: { intent: { agentId: string } }[] }>({
      op: "host-open",
      sessionFile: host.sessionFile,
    });
    expect(restored.sessionId).toBe(host.sessionId);
    expect(restored.intents.map(({ intent }) => intent.agentId)).toEqual(["agent"]);
    const report = (await driver.state()).reports["report:agent:1"];
    expect(report?.acknowledged).toBe(stage === "after-ack");
    if (!report?.acknowledged) await driver.request({ op: "host-deliver", reportId: "report:agent:1" });
    expect((await driver.request<{ reports: unknown[] }>({ op: "host-info" })).reports).toHaveLength(1);
    expect((await driver.state()).reports["report:agent:1"]?.acknowledged).toBe(true);
  },
);

it.each(["complete", "cancel", "restart"])(
  "drains main-request work before standby and reassignment (%s)",
  async (action) => {
    let driver = await launch(["settled", "generation"]);
    await driver.spawn("A");
    await driver.event("settled");
    await driver.request({ op: "main-send", requestId: "request-one", task: "generation" });
    await driver.event("generation");
    await driver.request({ op: "release", checkpoint: "settled" });
    await driver.event("draining");
    expect((await driver.state()).agents.agent?.state).toBe("running");
    await expect(driver.request({ op: "assign", requestId: "2", task: "B" })).rejects.toThrow("busy");
    await expect(driver.request({ op: "main-send", requestId: "too-late", task: "More work" })).rejects.toThrow(
      "unavailable",
    );
    if (action === "restart") {
      await driver.stop(true);
      driver = await launch(["generation"]);
      await driver.request({ op: "resume" });
      await driver.event("generation");
    }
    if (action === "cancel") {
      expect((await driver.request<Agent>({ op: "cancel" })).runs["agent:1"]?.status).toBe("cancelled");
      expect((await driver.request<{ status: string }>({ op: "main-wait", requestId: "request-one" })).status).toBe(
        "cancelled",
      );
    } else {
      await driver.request({ op: "release", checkpoint: "generation" });
      expect((await driver.request<{ status: string }>({ op: "main-wait", requestId: "request-one" })).status).toBe(
        "answered",
      );
    }
    expect((await driver.wait()).state).toBe("standby");
    await driver.request({ op: "assign", requestId: "2", task: "B" });
    expect((await driver.wait()).runs["agent:2"]?.status).toBe("completed");
  },
);

it("recovers a main request delivered before a crash without submitting it twice", async () => {
  let driver = await launch(["effect", "main-delivered"]);
  await driver.spawn("unsafe");
  await driver.event("effect");
  await driver.request({ op: "main-send", requestId: "request-one", task: "Check progress" });
  await driver.event("main-delivered");
  await driver.stop(true);
  driver = await launch();
  await driver.request({ op: "resume" });
  const reply = await driver.request<{ status: string; result: string }>({ op: "main-wait", requestId: "request-one" });
  expect(reply.status).toBe("answered");
  expect(reply.result).toContain("answer:Check progress");
  await driver.wait();
  await driver.request({ op: "main-send", requestId: "request-one", task: "Check progress" });
  await expect(driver.request({ op: "main-send", requestId: "request-one", task: "replacement" })).rejects.toThrow(
    "conflict",
  );
  const transcript = await driver.request<{ messages: { role: string; content: unknown }[] }>({ op: "transcript" });
  expect(
    transcript.messages.filter((message) => message.role === "user" && message.content === "Check progress"),
  ).toHaveLength(1);
});

it("interrupts a child wait to receive main steering and records unanswered questions explicitly", async () => {
  const driver = await launch();
  await driver.spawn("question");
  const question = (await driver.event("question")) as { id: string };
  await driver.request({ op: "main-send", requestId: "request-one", task: "Check progress" });
  expect((await driver.request<{ status: string }>({ op: "main-wait", requestId: "request-one" })).status).toBe(
    "answered",
  );
  const agent = await driver.wait();
  expect(agent.questions[question.id]?.status).toBe("cancelled");
  await expect(driver.request({ op: "answer", questionId: question.id, answer: "late" })).rejects.toThrow(
    "unavailable",
  );
  await expect(driver.request({ op: "main-wait", requestId: "missing" })).rejects.toThrow("Unknown main request");
});

it("closes pending requests in both directions with explicit cancellation outcomes", async () => {
  const driver = await launch(["main-delivered"]);
  await driver.spawn("question");
  const question = (await driver.event("question")) as { id: string };
  await driver.request({ op: "main-send", requestId: "request-one", task: "Check progress" });
  await driver.event("main-delivered");
  const agent = await driver.request<Agent>({ op: "close" });
  expect(agent.questions[question.id]?.status).toBe("cancelled");
  expect(agent.mainRequests["request-one"]?.status).toBe("cancelled");
  await expect(driver.request({ op: "main-send", task: "Check progress" })).rejects.toThrow("unavailable");
});

it("preserves the normalized child request prefix across reopen and redispatch", async () => {
  let driver = await launch();
  await finish(driver);
  const original = (await driver.event("provider-request")) as {
    messages: unknown[];
    systemPrompt: string;
    tools: unknown[];
  };
  await driver.stop(true);
  driver = await launch();
  await driver.request({ op: "assign", requestId: "2", task: "B" });
  await driver.wait();
  const restored = (await driver.event("provider-request")) as typeof original;
  expect(restored.systemPrompt).toBe(original.systemPrompt);
  expect(restored.tools).toEqual(original.tools);
  expect(restored.messages.slice(0, original.messages.length)).toEqual(original.messages);
});
