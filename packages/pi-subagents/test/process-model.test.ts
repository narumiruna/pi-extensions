import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, test, vi } from "vitest";
import { buildPiArgs, childReadinessProbePath, runChild } from "../src/process.js";
import type { ChildRequest } from "../src/types.js";
import { installFakePi } from "./child-process-fixture.js";

let directory: string;
let previousPackageDirectory: string | undefined;
beforeEach(() => {
  directory = mkdtempSync(path.join(os.tmpdir(), "pi-subagents-model-process-"));
  previousPackageDirectory = process.env.PI_PACKAGE_DIR;
});
afterEach(() => {
  if (previousPackageDirectory === undefined) delete process.env.PI_PACKAGE_DIR;
  else process.env.PI_PACKAGE_DIR = previousPackageDirectory;
  rmSync(directory, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function request(overrides: Partial<ChildRequest> = {}): ChildRequest {
  return {
    task: "private task",
    tools: [],
    skills: [],
    extensions: [],
    toolSources: {},
    provider: "literal-provider",
    model: "raw/model:high",
    thinkingLevel: "medium",
    cwd: directory,
    projectTrusted: false,
    communication: { host: "127.0.0.1", port: 31337, token: "a".repeat(64) },
    signal: new AbortController().signal,
    ...overrides,
  };
}

for (const { name, tools, extensions, expected } of [
  { name: "empty", tools: [], extensions: [], expected: ["subagent_send", "subagent_wait"] },
  {
    name: "core",
    tools: ["read", "grep"],
    extensions: [],
    expected: ["read", "grep", "subagent_send", "subagent_wait"],
  },
  {
    name: "duplicates",
    tools: ["read", "read", "subagent_send"],
    extensions: [{ path: "/fixture.ts", tools: ["search", "search"] }],
    expected: ["read", "subagent_send", "subagent_wait", "search"],
  },
  {
    name: "encoded names",
    tools: [],
    extensions: [{ path: "/fixture.ts", tools: ['quoted"tool', "界"] }],
    expected: ["subagent_send", "subagent_wait", 'quoted"tool', "界"],
  },
  {
    name: "multiple attachments",
    tools: ["codemode", "read"],
    extensions: [
      { path: "/search.ts", tools: ["search"] },
      { path: "/write.ts", tools: ["rewrite"] },
    ],
    expected: ["codemode", "read", "subagent_send", "subagent_wait", "search", "rewrite"],
  },
]) {
  test(`child tool ordering is stable for ${name}`, () => {
    const args = buildPiArgs(request({ tools, extensions }));
    assert.equal(args[args.indexOf("--tools") + 1], expected.join(","));
  });
}

for (const model of [
  "raw/model",
  "raw:model",
  "provider-looking/model:high",
  "literal:off",
  " raw/model ",
  "--model",
]) {
  test(`private bootstrap preserves the raw model without CLI parsing: ${model}`, async () => {
    const child = request({ model });
    const args = buildPiArgs(child);
    assert.equal(args.includes("--provider"), false);
    assert.equal(args.includes("--model"), false);
    assert.equal(args.includes("literal-provider"), false);
    assert.equal(args[args.indexOf("--thinking") + 1], "medium");
    assert.ok(args.includes(childReadinessProbePath()));
    assert.equal(args.includes("private task"), false);
    installFakePi(
      directory,
      `
async function handle(command) {
  respond(command);
  event(message(JSON.stringify(selection)));
  event({ type: "agent_settled" });
}
`,
    );
    const result = await runChild(child);
    assert.equal(result.state, "completed");
    assert.deepEqual(JSON.parse(result.result ?? "{}"), { provider: child.provider, model, thinkingLevel: "medium" });
  });
}

test("a child with no core tools attests a model and answers ordered get_state before any task", async () => {
  installFakePi(
    directory,
    `
let states = 0;
globalThis.fakeStateHandler = async (command) => { states++; respond(command); };
async function handle(command) {
  if (command.type !== "prompt") throw new Error("Unexpected command: " + command.type);
  respond(command);
  event(message(JSON.stringify({ states, selectedModel, selection, expectedTools, task: command.message })));
  event({ type: "agent_settled" });
}
`,
  );
  const result = await runChild(request());
  assert.equal(result.state, "completed");
  assert.deepEqual(JSON.parse(result.result ?? "{}"), {
    states: 1,
    selectedModel: { provider: "literal-provider", id: "raw/model:high" },
    selection: { provider: "literal-provider", model: "raw/model:high", thinkingLevel: "medium" },
    expectedTools: ["subagent_send", "subagent_wait"],
    task: "Task: private task",
  });
});

for (const model of [
  { provider: "LITERAL-PROVIDER", id: "raw/model:high" },
  { provider: "other-provider", id: "raw/model:high" },
  { provider: "literal-provider", id: "raw/model" },
  { provider: "literal-provider", id: "RAW/MODEL:HIGH" },
]) {
  test(`rejects readiness pair mismatch before sending a task: ${JSON.stringify(model)}`, async () => {
    const marker = path.join(directory, "task");
    installFakePi(
      directory,
      `
signalReadiness(JSON.stringify({ ok: true, sources: expectedTools.map(() => sourceId("/bridge.ts")), model: ${JSON.stringify(model)} }) + "\\n");
async function handle(command) { fs.writeFileSync(${JSON.stringify(marker)}, command.type); }
`,
      { readiness: "manual" },
    );
    const result = await runChild(request());
    assert.equal(result.state, "failed");
    assert.match(result.error ?? "", /does not match the requested provider and model/);
    assert.equal(existsSync(marker), false);
  });
}

const stateFailures = [
  ["missing", "globalThis.fakeState = {};", /invalid model/],
  ["null", "globalThis.fakeState = null;", /invalid state/],
  ["wrong-provider", 'globalThis.fakeState = { model: { ...selectedModel, provider: "other" } };', /does not match/],
  [
    "fuzzy-model",
    'globalThis.fakeState = { model: { ...selectedModel, id: "raw/model:high-latest" } };',
    /does not match/,
  ],
  ["invalid-id", 'globalThis.fakeState = { model: { ...selectedModel, id: "\\u001bmalicious" } };', /invalid model/],
  [
    "rejected",
    'globalThis.fakeStateHandler = async (command) => respond(command, false, "state rejected");',
    /state rejected/,
  ],
  [
    "wrong-command",
    'globalThis.fakeStateHandler = async (command) => event({ id: command.id, type: "response", command: "get_available_models", success: true, data: { model: selectedModel } });',
    /invalid command/,
  ],
  [
    "malformed",
    'globalThis.fakeStateHandler = async () => process.stdout.write("not-json\\n");',
    /malformed or oversized/,
  ],
  [
    "invalid-utf8",
    "globalThis.fakeStateHandler = async () => process.stdout.write(Buffer.from([0xff, 0x0a]));",
    /malformed or oversized/,
  ],
  [
    "oversized",
    'globalThis.fakeStateHandler = async () => process.stdout.write("x".repeat(256 * 1024 + 1) + "\\n");',
    /malformed or oversized/,
  ],
] as const;
for (const [name, setup, expected] of stateFailures) {
  test(`rejects ${name} get_state before sending a task`, async () => {
    const marker = path.join(directory, "task");
    let controls = 0;
    installFakePi(
      directory,
      `${setup}
async function handle(command) { fs.writeFileSync(${JSON.stringify(marker)}, command.type); }
`,
    );
    const result = await runChild(
      request({
        onControl: () => {
          controls++;
        },
      }),
    );
    assert.equal(result.state, "failed");
    assert.match(result.error ?? "", expected);
    assert.equal(existsSync(marker), false);
    assert.equal(controls, 0);
  });
}

for (const position of ["before", "after"] as const) {
  test(`malformed output ${position} model state remains a startup failure`, async () => {
    const marker = path.join(directory, "task");
    let controls = 0;
    installFakePi(
      directory,
      `
globalThis.fakeStateHandler = async (command) => {
  if (${position === "before"}) process.stdout.write(Buffer.from([0xff, 0x0a]));
  respond(command);
  if (${position === "after"}) process.stdout.write(Buffer.from([0xff, 0x0a]));
};
async function handle(command) { fs.writeFileSync(${JSON.stringify(marker)}, command.type); }
`,
    );
    const result = await runChild(
      request({
        onControl: () => {
          controls++;
        },
      }),
    );
    assert.equal(result.state, "failed");
    assert.match(result.error ?? "", /startup emitted malformed or oversized RPC output/);
    assert.equal(existsSync(marker), false);
    assert.equal(controls, 0);
  });
}

for (const hook of ["model_select", "thinking_level_select"]) {
  test(`${hook} errors reported before state acceptance prevent task publication`, async () => {
    const marker = path.join(directory, "task");
    installFakePi(
      directory,
      `
  globalThis.fakeStateHandler = async (command) => {
    event({ type: "extension_error", event: ${JSON.stringify(hook)}, error: "selection hook failed" });
    respond(command);
  };
  async function handle(command) { fs.writeFileSync(${JSON.stringify(marker)}, command.type); }
  `,
    );
    const result = await runChild(request());
    assert.equal(result.state, "failed");
    assert.match(result.error ?? "", new RegExp(`startup failed during ${hook}`));
    assert.equal(existsSync(marker), false);
  });
}

test("get_state rejection diagnostics are bounded, sanitized, and attachment-redacted", async () => {
  const marker = path.join(directory, "task");
  installFakePi(
    directory,
    `
globalThis.fakeStateHandler = async (command) => respond(command, false, "\\u001b[31m/private/fixture.ts " + "x".repeat(20 * 1024));
async function handle(command) { fs.writeFileSync(${JSON.stringify(marker)}, command.type); }
`,
  );
  const result = await runChild(request({ extensions: [{ path: "/private/fixture.ts", tools: [] }] }));
  assert.equal(result.state, "failed");
  assert.equal(result.truncated, true);
  assert.match(result.error ?? "", /\[attachment path\]/);
  assert.doesNotMatch(result.error ?? "", /\/private\/fixture\.ts/);
  assert.equal((result.error ?? "").includes(String.fromCharCode(27)), false);
  assert.ok(Buffer.byteLength(result.error ?? "") <= 8 * 1024);
  assert.equal(existsSync(marker), false);
});

for (const phase of ["readiness", "state", "prompt"] as const) {
  test(`cancellation during ${phase} prevents stale prompt acceptance and cleans up once`, async () => {
    const controller = new AbortController();
    const server = createServer((socket) => {
      socket.once("data", () => controller.abort());
      socket.on("error", () => undefined);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const marker = path.join(directory, "prompt");
    const terminal = path.join(directory, "terminal");
    installFakePi(
      directory,
      `
const net = await import("node:net");
const notify = () => { const socket = net.connect(${address.port}, "127.0.0.1", () => socket.write("${phase}")); socket.on("error", () => undefined); };
process.on("SIGTERM", () => { fs.appendFileSync(${JSON.stringify(terminal)}, "terminated\\n"); process.exit(0); });
${phase === "readiness" ? "notify();" : ""}
globalThis.fakeStateHandler = async (command) => {
  ${phase === "state" ? "notify();" : "respond(command);"}
};
async function handle(command) {
  fs.appendFileSync(${JSON.stringify(marker)}, command.type + "\\n");
  if (command.type === "prompt") notify();
}
`,
      { readiness: phase === "readiness" ? "manual" : "success" },
    );
    let completions = 0;
    let controls = 0;
    try {
      const result = await runChild(
        request({
          signal: controller.signal,
          onControl: () => {
            controls++;
          },
        }),
      ).then((value) => {
        completions++;
        return value;
      });
      assert.equal(result.state, "cancelled");
      assert.equal(controls, 0);
      assert.equal(completions, 1);
      assert.equal(existsSync(marker), phase === "prompt");
      if (phase === "prompt") assert.equal(readFileSync(marker, "utf8"), "prompt\n");
      if (process.platform !== "win32") assert.equal(readFileSync(terminal, "utf8"), "terminated\n");
      controller.abort();
    } finally {
      controller.abort();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
}
