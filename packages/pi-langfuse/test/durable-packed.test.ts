import { type ChildProcess, execFile, fork } from "node:child_process";
import { mkdir, mkdtemp, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, expect, it } from "vitest";

const exec = promisify(execFile);

let directory: string;
let child: ChildProcess | undefined;
let completed: Promise<{ code: number | null; stdout: string; stderr: string }>;
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "pi-langfuse-durable-consumer-"));
  const packed = await exec(
    "npm",
    ["pack", "--workspace", "@narumitw/pi-langfuse", "--ignore-scripts", "--json", "--pack-destination", directory],
    { cwd: process.cwd() },
  );
  const [{ filename }] = JSON.parse(packed.stdout) as Array<{ filename: string }>;
  const installed = join(directory, "node_modules", "@narumitw", "pi-langfuse");
  await mkdir(installed, { recursive: true });
  await exec("tar", ["-xzf", join(directory, filename), "--strip-components=1", "-C", installed]);
  // Use already-installed dependency packages; default tests never contact a registry.
  const rootModules = resolve("node_modules");
  for (const entry of await readdir(rootModules, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue;
    if (entry.name.startsWith("@")) {
      await mkdir(join(directory, "node_modules", entry.name), { recursive: true });
      for (const name of await readdir(join(rootModules, entry.name))) {
        if (entry.name === "@narumitw" && name === "pi-langfuse") continue;
        if (entry.name === "@earendil-works" && name === "pi-coding-agent") continue;
        const target = join(rootModules, entry.name, name);
        await symlink(target, join(directory, "node_modules", entry.name, name), "dir");
      }
    } else await symlink(join(rootModules, entry.name), join(directory, "node_modules", entry.name), "dir");
  }
  await writeFile(join(directory, "package.json"), JSON.stringify({ type: "module" }));
  await writeFile(
    join(directory, "deny-coding.mjs"),
    `
import { registerHooks } from "node:module";
registerHooks({ resolve(specifier, context, next) {
  if (specifier === "@earendil-works/pi-coding-agent" || specifier.startsWith("@earendil-works/pi-coding-agent/") || specifier === "@narumitw/pi-tui-kit") throw new Error("Coding-agent-only dependency loaded: " + specifier);
  return next(specifier, context);
}
, load(url, context, next) {
  const result = next(url, context);
  if (url.endsWith(".js") && /createPiLangfuseSessionController|registerLangfuseCommand/.test(String(result.source))) throw new Error("Coding-agent registration loaded: " + url);
  return result;
} });
`,
  );
  await writeFile(
    join(directory, "consumer.ts"),
    `
import assert from "node:assert/strict";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels, fauxProvider, fauxAssistantMessage } from "@earendil-works/pi-ai";
import { Harness, MemoryStorage, createRegistry } from "@earendil-works/pi-durable";
import { createLangfuseRuntime, createLangfuseRuntimeFromBackend, createPiLangfuseDurableConversation, type TraceBackend, type ObservationAttributes } from "@narumitw/pi-langfuse/durable";
const context = BACKGROUND_CONTEXT;
const records: Array<{ name: string; updates: ObservationAttributes[]; ended: boolean }> = [];
const backend: TraceBackend = {
  start(name) {
    const record = { name, updates: [] as ObservationAttributes[], ended: false };
    records.push(record);
    return { update(attrs) { record.updates.push(attrs); return this; }, end() { record.ended = true; return this; } };
  }, async forceFlush() {}, async shutdown() {},
};
await assert.rejects(createLangfuseRuntime({ env: false }), /publicKey is required/);
// Finish dependency/SDK loading before the parent starts its execution-test deadline.
process.send?.("ready");
await new Promise<void>((resolve) => process.once("message", () => resolve()));
process.disconnect?.();
const runtime = createLangfuseRuntimeFromBackend(backend);
const faux = fauxProvider();
const models = createModels(); models.setProvider(faux.provider);
faux.setResponses([fauxAssistantMessage("packed committed answer")]);
const harness = await Harness.open(new MemoryStorage(), { models, registry: createRegistry() }, context);
const conversation = await harness.root(context, { agent: { model: { provider: faux.provider.id, modelId: faux.getModel().id } } });
const tracing = await createPiLangfuseDurableConversation(runtime, { harness, conversationId: conversation.id, context, sessionId: "packed-session" });
const submission = await conversation.submit({ type: "input", content: "packed prompt", requestId: "packed-request" }, context);
await submission.wait(context);
await tracing.observeSubmission(submission.id);
assert.equal(records.filter((r) => r.name === "pi.durable.submission").length, 1);
assert.ok(JSON.stringify(records).includes("packed committed answer"));
await tracing.dispose(); await harness.close(context); await runtime.shutdown();
assert.ok(records.every((r) => r.ended));
console.log("packed durable consumer passed");

`,
  );
  await writeFile(
    join(directory, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        target: "ES2024",
        module: "NodeNext",
        moduleResolution: "NodeNext",
        strict: true,
        skipLibCheck: true,
        outDir: "out",
      },
      files: ["consumer.ts"],
    }),
  );
  await exec(process.execPath, [resolve("node_modules/typescript/lib/tsc.js"), "-p", join(directory, "tsconfig.json")]);
  child = fork(join(directory, "out", "consumer.js"), [], {
    execArgv: ["--import", join(directory, "deny-coding.mjs")],
    cwd: directory,
    silent: true,
  });
  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (data) => {
    stdout += String(data);
  });
  child.stderr?.on("data", (data) => {
    stderr += String(data);
  });
  completed = new Promise((resolve) => {
    child?.once("close", (code) => resolve({ code, stdout, stderr }));
  });
  await new Promise<void>((resolve, reject) => {
    let ready = false;
    child?.once("message", (message) => {
      if (message === "ready") {
        ready = true;
        resolve();
      }
    });
    child?.once("error", reject);
    child?.once("exit", (code) => {
      if (!ready) reject(new Error(`Consumer exited before readiness (${code}): ${stderr}`));
    });
  });
});
afterAll(async () => {
  if (child && child.exitCode === null && child.signalCode === null) child.kill();
  if (completed) await completed;
  if (directory) await rm(directory, { recursive: true, force: true });
});

it("a packed durable consumer compiles against public declarations", async () => {
  await exec(process.execPath, [resolve("node_modules/typescript/lib/tsc.js"), "-p", join(directory, "tsconfig.json")]);
});

it("a packed durable consumer exercises real execution and lazy runtime without coding-agent registration", async () => {
  child?.send("run");
  const result = await completed;
  expect(result.code, result.stderr).toBe(0);
  expect(result.stdout).toContain("packed durable consumer passed");
});
