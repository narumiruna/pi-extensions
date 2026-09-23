import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, test, vi } from "vitest";
import { toolSourceId } from "../src/attachment-utils.js";
import {
  assertChildCommandCapacity,
  buildPiArgs,
  childCommunicationBridgePath,
  childReadinessProbePath,
  resolveTimeoutMs,
  runChild,
  terminateWindowsProcessTree,
} from "../src/process.js";
import type { ChildControl, ChildRequest } from "../src/types.js";

let directory: string;
let previousPackageDirectory: string | undefined;
let previousExecPath: string;
let previousBunVersion: string | undefined;
let previousReadinessDescriptor: string | undefined;

beforeEach(() => {
  directory = mkdtempSync(path.join(os.tmpdir(), "pi-subagents-process-"));
  previousPackageDirectory = process.env.PI_PACKAGE_DIR;
  previousExecPath = process.execPath;
  previousBunVersion = process.versions.bun;
  previousReadinessDescriptor = process.env.PI_SUBAGENT_READINESS_FD;
});

afterEach(() => {
  if (previousPackageDirectory === undefined) delete process.env.PI_PACKAGE_DIR;
  else process.env.PI_PACKAGE_DIR = previousPackageDirectory;
  process.execPath = previousExecPath;
  if (previousBunVersion === undefined) delete process.versions.bun;
  else process.versions.bun = previousBunVersion;
  if (previousReadinessDescriptor === undefined) delete process.env.PI_SUBAGENT_READINESS_FD;
  else process.env.PI_SUBAGENT_READINESS_FD = previousReadinessDescriptor;
  rmSync(directory, { recursive: true, force: true });
  vi.useRealTimers();
  vi.restoreAllMocks();
});

test("buildPiArgs isolates the RPC child and preserves selected communication tools", () => {
  const args = buildPiArgs(childRequest());
  assert.deepEqual(args.slice(0, 7), [
    "--mode",
    "rpc",
    "--no-session",
    "--no-extensions",
    "--no-skills",
    "--no-prompt-templates",
    "-e",
  ]);
  assert.equal(args[7], childCommunicationBridgePath());
  assert.equal(args[args.indexOf("--model") + 1], "test-provider/test-model");
  assert.equal(args[args.indexOf("--thinking") + 1], "medium");
  assert.ok(args.includes("--no-approve"));
  assert.equal(args[args.indexOf("--tools") + 1], "read,grep,find,ls,subagent_send,subagent_wait");
  assert.doesNotMatch(args.join(" "), /\bbash\b|\bwrite\b|append-system-prompt/u);
  assert.equal(args.includes("Task: task"), false);

  const writable = buildPiArgs(
    childRequest({
      tools: ["read", "bash", "write", "subagent_send", "subagent_wait"],
      thinkingLevel: "xhigh",
      projectTrusted: true,
    }),
  );
  assert.ok(writable.includes("--approve"));
  assert.equal(writable[writable.indexOf("--thinking") + 1], "xhigh");
  assert.equal(writable[writable.indexOf("--tools") + 1], "read,bash,write,subagent_send,subagent_wait");

  const noWorkTools = buildPiArgs(childRequest({ tools: [] }));
  assert.equal(noWorkTools[noWorkTools.indexOf("--tools") + 1], "subagent_send,subagent_wait");

  const attached = buildPiArgs(
    childRequest({
      tools: ["read"],
      skills: ["/tmp/review-skill", "/tmp/test-skill"],
      extensions: [
        { path: "/tmp/search-extension.ts", tools: ["search_code"] },
        { path: "/tmp/provider-extension.ts", tools: [] },
      ],
    }),
  );
  assert.deepEqual(
    attached.filter((argument, index) => attached[index - 1] === "-e" || argument === "-e"),
    [
      "-e",
      childCommunicationBridgePath(),
      "-e",
      "/tmp/search-extension.ts",
      "-e",
      "/tmp/provider-extension.ts",
      "-e",
      childReadinessProbePath(),
    ],
  );
  assert.deepEqual(
    attached.filter((argument, index) => attached[index - 1] === "--skill" || argument === "--skill"),
    ["--skill", "/tmp/review-skill", "--skill", "/tmp/test-skill"],
  );
  assert.equal(attached[attached.indexOf("--tools") + 1], "read,subagent_send,subagent_wait,search_code");

  const skillOnly = buildPiArgs(childRequest({ skills: ["/tmp/review-skill"] }));
  assert.equal(skillOnly.filter((argument) => argument === "-e").length, 1);
  assert.equal(skillOnly.includes(childReadinessProbePath()), false);

  const lifecycleOnly = buildPiArgs(childRequest({ extensions: [{ path: "/tmp/provider-extension.ts", tools: [] }] }));
  assert.deepEqual(
    lifecycleOnly.filter((argument, index) => lifecycleOnly[index - 1] === "-e" || argument === "-e"),
    ["-e", childCommunicationBridgePath(), "-e", "/tmp/provider-extension.ts", "-e", childReadinessProbePath()],
  );
});

test("bounds the combined Windows child command line", () => {
  assert.doesNotThrow(() => assertChildCommandCapacity(childRequest(), "win32"));

  const paths = Array.from({ length: 16 }, (_, index) => `C:\\${"a".repeat(2_100)}-${index}`);
  assert.throws(
    () =>
      assertChildCommandCapacity(
        childRequest({
          skills: paths.slice(0, 8),
          extensions: paths.slice(8).map((path) => ({ path, tools: [] })),
        }),
        "win32",
      ),
    /command line exceeds the Windows process limit/i,
  );
});

test("runChild uses a bundled Pi executable when its manifest CLI is absent", async () => {
  installFakePi(
    `
async function handle(command) {
  if (command.type !== "prompt") return;
  respond(command);
  event(message("bundled Pi child completed"));
  event({ type: "agent_settled" });
}
`,
    { bundled: true },
  );

  const result = await runChild(childRequest());
  assert.equal(result.state, "completed");
  assert.equal(result.result, "bundled Pi child completed");
});

test("runChild classifies completed and partial RPC output", async () => {
  installFakePi(`
async function handle(command) {
  if (command.type !== "prompt") return;
  respond(command);
  if (command.message.includes("partial")) {
    event(message("partial evidence", "error"));
    console.error("child failed");
  } else {
    event(message("completed evidence"));
  }
  event({ type: "agent_settled" });
}
`);
  const completed = await runChild(childRequest({ task: "complete" }));
  assert.equal(completed.state, "completed");
  assert.equal(completed.result, "completed evidence");

  const partial = await runChild(childRequest({ task: "partial" }));
  assert.equal(partial.state, "partial");
  assert.equal(partial.result, "partial evidence");
  assert.match(partial.error ?? "", /child failed/);
});

test("runChild requires a settled terminal result and preserves incomplete evidence", async () => {
  installFakePi(`
async function handle(command) {
  if (command.type !== "prompt") return;
  respond(command);
  if (command.message.includes("length")) event(message("cut-off evidence", "length"));
  else if (command.message.includes("nonterminal")) event(message("intermediate evidence", "toolUse"));
  else process.stdout.write("{malformed\\n");
  event({ type: "agent_settled" });
}
`);
  const lengthLimited = await runChild(childRequest({ task: "length" }));
  assert.equal(lengthLimited.state, "partial");
  assert.equal(lengthLimited.result, "cut-off evidence");
  assert.match(lengthLimited.error ?? "", /model limit/i);
  assert.match(lengthLimited.limitations.join("\n"), /model output limit/i);

  const nonterminal = await runChild(childRequest({ task: "nonterminal" }));
  assert.equal(nonterminal.state, "partial");
  assert.equal(nonterminal.result, "intermediate evidence");
  assert.match(nonterminal.error ?? "", /without a terminal assistant result/i);

  const missing = await runChild(childRequest({ task: "missing" }));
  assert.equal(missing.state, "failed");
  assert.match(missing.error ?? "", /without a terminal assistant result/i);
  assert.match(missing.limitations.join("\n"), /malformed/i);
});

test("runChild ignores an oversized RPC event and preserves later terminal output", async () => {
  installFakePi(`
async function handle(command) {
  if (command.type !== "prompt") return;
  respond(command);
  process.stdout.write("x".repeat(256 * 1024 + 1) + "\\n");
  event(message("usable output"));
  event({ type: "agent_settled" });
}
`);
  const result = await runChild(childRequest());
  assert.equal(result.state, "completed");
  assert.equal(result.result, "usable output");
  assert.match(result.limitations.join("\n"), /malformed or oversized/i);
});

test("runChild exposes RPC steering only after prompt acceptance", async () => {
  installFakePi(`
async function handle(command) {
  if (command.type === "prompt") {
    respond(command);
    return;
  }
  if (command.type === "steer") {
    respond(command);
    event(message("answered: " + command.message));
    event({ type: "agent_settled" });
  }
}
`);
  let resolveControl!: (control: ChildControl) => void;
  const controlReady = new Promise<ChildControl>((resolve) => {
    resolveControl = resolve;
  });
  const work = runChild(childRequest({ onControl: resolveControl }));
  const control = await controlReady;
  await control.send("question from main");
  const result = await work;
  assert.equal(result.state, "completed");
  assert.equal(result.result, "answered: question from main");
  await assert.rejects(() => control.send("late"), /no longer accepting|no longer active/i);
});

test("runChild surfaces an RPC steering rejection without terminating accepted work", async () => {
  installFakePi(`
async function handle(command) {
  if (command.type === "prompt") {
    respond(command);
    return;
  }
  if (command.type === "steer") {
    respond(command, false, "steer rejected");
  }
}
`);
  const controller = new AbortController();
  let resolveControl!: (control: ChildControl) => void;
  const controlReady = new Promise<ChildControl>((resolve) => {
    resolveControl = resolve;
  });
  const work = runChild(childRequest({ signal: controller.signal, onControl: resolveControl }));
  const control = await controlReady;
  await assert.rejects(() => control.send("question"), /steer rejected/i);
  controller.abort();
  assert.equal((await work).state, "cancelled");
});

test("runChild rejects asynchronous RPC stdin write errors without an unhandled error", async () => {
  installFakePi(`
async function handle(command) {
  if (command.type !== "prompt") return;
  process.stdin.on("error", () => undefined);
  fs.closeSync(0);
  respond(command);
}
setInterval(() => {}, 1000);
`);
  const controller = new AbortController();
  let resolveControl!: (control: ChildControl) => void;
  const controlReady = new Promise<ChildControl>((resolve) => {
    resolveControl = resolve;
  });
  const work = runChild(childRequest({ signal: controller.signal, onControl: resolveControl }));
  const control = await controlReady;
  await assert.rejects(() => control.send("question after stdin closed"), /EPIPE|stdin|write/iu);
  controller.abort();
  assert.equal((await work).state, "cancelled");
});

test("runChild aborts an in-flight RPC steering command", async () => {
  installFakePi(`
async function handle(command) {
  if (command.type === "prompt") respond(command);
}
setInterval(() => {}, 1000);
`);
  const processController = new AbortController();
  let resolveControl!: (control: ChildControl) => void;
  const controlReady = new Promise<ChildControl>((resolve) => {
    resolveControl = resolve;
  });
  const work = runChild(childRequest({ signal: processController.signal, onControl: resolveControl }));
  const control = await controlReady;
  const sendController = new AbortController();
  const pending = control.send("unacknowledged question", sendController.signal);
  sendController.abort();
  await assert.rejects(pending, (error: Error) => error.name === "AbortError");
  processController.abort();
  assert.equal((await work).state, "cancelled");
});

test("runChild bounds child result text below the complete tool-output budget", async () => {
  installFakePi(`
async function handle(command) {
  if (command.type !== "prompt") return;
  respond(command);
  event(message("x".repeat(40 * 1024)));
  event({ type: "agent_settled" });
}
`);
  const result = await runChild(childRequest());
  assert.equal(result.state, "completed");
  assert.equal(result.truncated, true);
  assert.ok(Buffer.byteLength(result.result ?? "", "utf8") <= 32 * 1024);
  assert.match(result.limitations.join("\n"), /truncated/i);
});

test("passes broker credentials through a private descriptor outside the initial environment", async () => {
  process.env.PI_SUBAGENT_READINESS_FD = "stale-parent-value";
  installFakePi(`
async function handle(command) {
  if (command.type !== "prompt") return;
  respond(command);
  const initialEnvironment = process.platform === "linux"
    ? fs.readFileSync("/proc/self/environ")
    : Buffer.from(Object.entries(process.env).map(([key, value]) => key + "=" + value).join("\\0"));
  const text = JSON.stringify({
    credentialsReceived: brokerCredentials.host === "127.0.0.1" && brokerCredentials.port === 31337,
    initialEnvironmentContainsToken: initialEnvironment.includes(Buffer.from(brokerCredentials.token)),
    descriptorMarker: process.env.PI_SUBAGENT_BROKER_FD,
    readinessMarker: process.env.PI_SUBAGENT_READINESS_FD ?? null,
  });
  event(message(text));
  event({ type: "agent_settled" });
}
`);
  const result = await runChild(childRequest());
  assert.equal(result.state, "completed");
  assert.deepEqual(JSON.parse(result.result ?? "{}"), {
    credentialsReceived: true,
    initialEnvironmentContainsToken: false,
    descriptorMarker: "3",
    readinessMarker: null,
  });
  delete process.env.PI_SUBAGENT_READINESS_FD;
});

test("handles late credential-pipe errors after child launch failure", async () => {
  installFakePi("async function handle() {}\n");
  const removedCwd = path.join(directory, "removed-cwd");
  mkdirSync(removedCwd);
  rmSync(removedCwd, { recursive: true });

  const result = await runChild(childRequest({ cwd: removedCwd }));
  assert.equal(result.state, "failed");
  assert.match(result.error ?? "", /ENOENT|not found/iu);
  await new Promise<void>((resolve) => setImmediate(resolve));
});

test("resolves optional execution timeouts with Pi bash semantics", () => {
  assert.equal(resolveTimeoutMs(undefined), undefined);
  assert.equal(resolveTimeoutMs(0.025), 25);
  assert.equal(resolveTimeoutMs(2_147_483.647), 2_147_483_647);
  for (const invalid of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(() => resolveTimeoutMs(invalid), /^Error: Invalid timeout: must be a finite number of seconds$/);
  }
  assert.throws(() => resolveTimeoutMs(2_147_483.648), /^Error: Invalid timeout: maximum is 2147483\.647 seconds$/);
});

test("runChild starts its deadline after RPC readiness and honors cancellation", async () => {
  installFakePi(`
async function handle(command) {
  if (command.type === "prompt") respond(command);
}
setInterval(() => {}, 1000);
`);
  let timeoutReady!: (control: ChildControl) => void;
  const timedOut = runChild(
    childRequest({
      timeout: 0.025,
      onControl: (control) => timeoutReady(control),
    }),
  );
  await new Promise<ChildControl>((resolve) => {
    timeoutReady = resolve;
  });
  assert.equal((await timedOut).state, "timed_out");

  const controller = new AbortController();
  let cancelReady!: (control: ChildControl) => void;
  const work = runChild(
    childRequest({
      signal: controller.signal,
      onControl: (control) => cancelReady(control),
    }),
  );
  await new Promise<ChildControl>((resolve) => {
    cancelReady = resolve;
  });
  controller.abort();
  assert.equal((await work).state, "cancelled");
});

test("runChild sends an attached task only after readiness and starts its deadline after prompt acceptance", async () => {
  installFakePi(
    `
let readinessSent = false;
setTimeout(() => {
  readinessSent = true;
  signalReadiness(JSON.stringify({ ok: true, sources: expectedTools.map(() => sourceId("/tmp/search-extension.ts")) }) + "\\n");
}, 50);
async function handle(command) {
  if (command.type !== "prompt") return;
  respond(command);
  event(message(JSON.stringify({ readinessSent, task: command.message })));
  event({ type: "agent_settled" });
}
`,
    { readiness: "manual" },
  );
  const result = await runChild(
    childRequest({
      extensions: [{ path: "/tmp/search-extension.ts", tools: ["custom_search"] }],
      timeout: 0.025,
    }),
  );
  assert.equal(result.state, "completed");
  assert.deepEqual(JSON.parse(result.result ?? "{}"), {
    readinessSent: true,
    task: "Task: task",
  });
});

test("runChild rejects hook-loaded project skills and prompts before sending the task", async () => {
  const project = path.join(directory, "project");
  mkdirSync(project);
  const projectSkill = path.join(project, "SKILL.md");
  writeFileSync(projectSkill, "---\nname: injected\ndescription: Injected\n---\n");
  const outsideLink = path.join(directory, "outside-link.md");
  symlinkSync(projectSkill, outsideLink);
  for (const [resource, resourcePath] of [
    ["skill", projectSkill],
    ["prompt", projectSkill],
    ["skill", outsideLink],
  ] as const) {
    const marker = path.join(directory, `prompt-${resource}-${resourcePath === outsideLink ? "symlink" : "direct"}`);
    installFakePi(`
globalThis.fakeCommands = [{ source: ${JSON.stringify(resource)}, sourceInfo: { path: ${JSON.stringify(resourcePath)} } }];
async function handle(command) {
  if (command.type !== "prompt") return;
  fs.writeFileSync(${JSON.stringify(marker)}, command.message);
}
setInterval(() => {}, 1000);
`);
    const result = await runChild(
      childRequest({ cwd: project, extensions: [{ path: "/tmp/lifecycle-extension.ts", tools: [] }] }),
    );
    assert.equal(result.state, "failed");
    assert.match(result.error ?? "", /cannot load project resources.*not trusted/i);
    assert.equal(existsSync(marker), false);
  }
});

test("runChild fails closed when loaded resource provenance is missing", async () => {
  const marker = path.join(directory, "prompt-without-provenance");
  installFakePi(`
globalThis.fakeCommands = [{ source: "skill" }];
async function handle(command) {
  if (command.type === "prompt") fs.writeFileSync(${JSON.stringify(marker)}, command.message);
}
setInterval(() => {}, 1000);
`);
  const result = await runChild(childRequest({ extensions: [{ path: "/tmp/lifecycle-extension.ts", tools: [] }] }));
  assert.equal(result.state, "failed");
  assert.match(result.error ?? "", /resource attestation returned invalid commands/i);
  assert.equal(existsSync(marker), false);
});

test("runChild permits hook-loaded project resources only in a trusted project", async () => {
  const projectSkill = path.join(directory, "SKILL.md");
  writeFileSync(projectSkill, "---\nname: approved\ndescription: Approved\n---\n");
  installFakePi(`
globalThis.fakeCommands = [{ source: "skill", sourceInfo: { path: ${JSON.stringify(projectSkill)} } }];
async function handle(command) {
  if (command.type !== "prompt") return;
  respond(command);
  event(message("trusted resource accepted"));
  event({ type: "agent_settled" });
}
`);
  const result = await runChild(
    childRequest({ extensions: [{ path: "/tmp/lifecycle-extension.ts", tools: [] }], projectTrusted: true }),
  );
  assert.equal(result.state, "completed");
  assert.equal(result.result, "trusted resource accepted");
});

test("runChild allows hook-loaded resources outside the untrusted project", async () => {
  installFakePi(`
globalThis.fakeCommands = [{ source: "skill", sourceInfo: { path: ${JSON.stringify(os.tmpdir())} } }];
async function handle(command) {
  if (command.type !== "prompt") return;
  respond(command);
  event(message("accepted outside resource"));
  event({ type: "agent_settled" });
}
`);
  const result = await runChild(childRequest({ extensions: [{ path: "/tmp/lifecycle-extension.ts", tools: [] }] }));
  assert.equal(result.state, "completed");
  assert.equal(result.result, "accepted outside resource");
});

test("runChild rejects a tool registered by a different attachment before prompting", async () => {
  const promptMarker = path.join(directory, "wrong-tool-owner-prompt");
  installFakePi(`
async function handle(command) {
  if (command.type !== "prompt") return;
  fs.writeFileSync(${JSON.stringify(promptMarker)}, command.message);
}
setInterval(() => {}, 1000);
`);
  const result = await runChild(
    childRequest({
      extensions: [
        { path: "/tmp/first-extension.ts", tools: [] },
        { path: "/tmp/second-extension.ts", tools: ["custom_search"] },
      ],
    }),
  );
  assert.equal(result.state, "failed");
  assert.match(result.error ?? "", /tool custom_search was not provided by its requested attachment/i);
  assert.equal(existsSync(promptMarker), false);
});

test("runChild rejects attachment startup hook errors before sending the task", async () => {
  for (const tools of [[], ["custom_search"]] as const) {
    for (const hook of ["session_start", "resources_discover"] as const) {
      const promptMarker = path.join(directory, `prompt-${tools.length}-${hook}`);
      installFakePi(`
event({
  type: "extension_error",
  extensionPath: "/tmp/search-extension.ts",
  event: ${JSON.stringify(hook)},
  error: "fixture hook failed at /tmp/search-extension.ts",
});
async function handle(command) {
  if (command.type !== "prompt") return;
  fs.writeFileSync(${JSON.stringify(promptMarker)}, command.message);
}
setInterval(() => {}, 1000);
`);
      const result = await runChild(
        childRequest({ extensions: [{ path: "/tmp/search-extension.ts", tools: [...tools] }] }),
      );
      assert.equal(result.state, "failed");
      assert.match(result.error ?? "", new RegExp(`startup failed during ${hook}.*fixture hook failed`, "i"));
      assert.match(result.error ?? "", /\[attachment path\]/u);
      assert.doesNotMatch(result.error ?? "", /\/tmp\/search-extension\.ts/u);
      assert.equal(existsSync(promptMarker), false);
    }
  }
});

test("runChild redacts attachment paths from child stderr", async () => {
  const attachmentPath = "/tmp/private-extension";
  installFakePi(`
console.error("Failed to load extension \\"/tmp/private-extension/index.ts\\"");
process.exit(1);
async function handle() {}
`);
  const result = await runChild(childRequest({ extensions: [{ path: attachmentPath, tools: [] }] }));
  assert.equal(result.state, "failed");
  assert.match(result.error ?? "", /Failed to load extension.*\[attachment path\]\/index\.ts/iu);
  assert.doesNotMatch(result.error ?? "", /\/tmp\/private-extension/u);

  const longAttachmentPath = `/tmp/${"nested/".repeat(400)}private-attachment-root`;
  const repeatedDiagnostic = Array.from(
    { length: 8 },
    () => `Failed to load extension "${longAttachmentPath}/index.ts"`,
  ).join("\n");
  installFakePi(`
process.stderr.write(${JSON.stringify(repeatedDiagnostic)});
process.exit(1);
async function handle() {}
`);
  const repeated = await runChild(childRequest({ extensions: [{ path: longAttachmentPath, tools: [] }] }));
  assert.equal(repeated.state, "failed");
  assert.match(repeated.error ?? "", /\[attachment path\]\/index\.ts/u);
  assert.doesNotMatch(repeated.error ?? "", /private-attachment-root/u);

  installFakePi(`
process.stderr.write(${JSON.stringify(longAttachmentPath.slice(0, -4))});
process.exit(1);
async function handle() {}
`);
  const partial = await runChild(childRequest({ extensions: [{ path: longAttachmentPath, tools: [] }] }));
  assert.equal(partial.state, "failed");
  assert.match(partial.error ?? "", /\[attachment path\]/u);
  assert.doesNotMatch(partial.error ?? "", /\/tmp\/nested/u);
});

test("runChild fails closed on oversized RPC output during attachment startup", async () => {
  const promptMarker = path.join(directory, "prompt-oversized-startup-event");
  installFakePi(`
event({
  type: "extension_error",
  extensionPath: "/tmp/lifecycle-extension.ts",
  event: "session_start",
  error: "x".repeat(300 * 1024),
});
async function handle(command) {
  if (command.type !== "prompt") return;
  fs.writeFileSync(${JSON.stringify(promptMarker)}, command.message);
}
setInterval(() => {}, 1000);
`);
  const result = await runChild(childRequest({ extensions: [{ path: "/tmp/lifecycle-extension.ts", tools: [] }] }));
  assert.equal(result.state, "failed");
  assert.match(result.error ?? "", /startup emitted malformed or oversized RPC output/i);
  assert.equal(existsSync(promptMarker), false);
});

test("runChild rejects an oversized tool bootstrap before child launch", async () => {
  const launchMarker = path.join(directory, "oversized-bootstrap-launch");
  installFakePi(`
fs.writeFileSync(${JSON.stringify(launchMarker)}, "launched");
async function handle() {}
`);
  const result = await runChild(
    childRequest({
      tools: [],
      extensions: [
        {
          path: "/tmp/search-extension.ts",
          tools: Array.from({ length: 64 }, (_, index) => `${String(index).padStart(2, "0")}${"界".repeat(126)}`),
        },
      ],
    }),
  );
  assert.equal(result.state, "failed");
  assert.match(result.error ?? "", /child bootstrap size limit/i);
  assert.equal(existsSync(launchMarker), false);
});

test("runChild rejects invalid attachment readiness without sending the task", async () => {
  const cases = [
    ["failure", /requested extension tool is unavailable/i],
    ["malformed", /malformed JSON/i],
    ["missingSources", /invalid result/i],
    ["wrongCount", /invalid result/i],
    ["invalidFingerprint", /invalid result/i],
    ["oversized", /size limit/i],
    ["close", /closed without a result/i],
  ] as const;
  for (const [readiness, expectedError] of cases) {
    const promptMarker = path.join(directory, `prompt-${readiness}`);
    installFakePi(
      `
async function handle(command) {
  if (command.type !== "prompt") return;
  fs.writeFileSync(${JSON.stringify(promptMarker)}, command.message);
}
setInterval(() => {}, 1000);
`,
      { readiness },
    );
    const result = await runChild(
      childRequest({
        extensions: [{ path: "/tmp/search-extension.ts", tools: ["custom_search"] }],
      }),
    );
    assert.equal(result.state, "failed");
    assert.match(result.error ?? "", expectedError);
    assert.equal(existsSync(promptMarker), false);
  }
});

test("runChild fails an attached job when the child exits before readiness", async () => {
  installFakePi(
    `
console.error("Unable to load attached extension fixture.");
process.exit(7);
async function handle() {}
`,
    { readiness: "manual" },
  );
  const result = await runChild(
    childRequest({ extensions: [{ path: "/tmp/broken-extension.ts", tools: ["broken_tool"] }] }),
  );
  assert.equal(result.state, "failed");
  assert.match(result.error ?? "", /readiness pipe closed without a result/i);
  assert.match(result.error ?? "", /unable to load attached extension fixture/i);
});

test("runChild sanitizes a child-provided readiness failure", async () => {
  installFakePi(
    `
signalReadiness(JSON.stringify({ ok: false, error: "Missing tool.\\u001b[31m" }) + "\\n");
async function handle() {}
`,
    { readiness: "manual" },
  );
  const result = await runChild(
    childRequest({ extensions: [{ path: "/tmp/search-extension.ts", tools: ["custom_search"] }] }),
  );
  assert.equal(result.state, "failed");
  assert.match(result.error ?? "", /missing tool/i);
  assert.equal((result.error ?? "").includes(String.fromCharCode(27)), false);
});

test("runChild cancels while waiting for attachment readiness", async () => {
  const startedMarker = path.join(directory, "readiness-started");
  installFakePi(
    `
fs.writeFileSync(${JSON.stringify(startedMarker)}, "started");
async function handle() {}
setInterval(() => {}, 1000);
`,
    { readiness: "manual" },
  );
  const controller = new AbortController();
  const work = runChild(
    childRequest({
      signal: controller.signal,
      extensions: [{ path: "/tmp/search-extension.ts", tools: ["custom_search"] }],
    }),
  );
  await waitForFile(startedMarker);
  controller.abort();
  assert.equal((await work).state, "cancelled");
});

test("runChild reuses one termination flow when timeout and cancellation race", {
  skip: process.platform === "win32",
}, async () => {
  installFakePi(`
process.on("SIGTERM", () => undefined);
async function handle(command) {
  if (command.type === "prompt") respond(command);
}
setInterval(() => {}, 1000);
`);
  const signals: Array<string | number | undefined> = [];
  const originalKill = process.kill.bind(process);
  vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
    if (pid < 0) signals.push(signal);
    return originalKill(pid, signal);
  });
  const controller = new AbortController();
  let resolveControl!: (control: ChildControl) => void;
  const ready = new Promise<ChildControl>((resolve) => {
    resolveControl = resolve;
  });
  const work = runChild(childRequest({ signal: controller.signal, timeout: 0.05, onControl: resolveControl }));
  await ready;
  setTimeout(() => controller.abort(), 60);
  const result = await work;
  assert.equal(result.state, "cancelled");
  assert.deepEqual(signals, ["SIGTERM", "SIGKILL"]);
});

test("Windows process-tree termination awaits taskkill completion", async () => {
  const childKill = vi.fn();
  const child = {
    pid: 4242,
    kill: childKill,
  } as unknown as ChildProcess;
  const treeKiller = new EventEmitter() as ChildProcess;
  treeKiller.kill = vi.fn();
  const spawnTreeKillerMock = vi.fn(() => treeKiller);
  const spawnTreeKiller = spawnTreeKillerMock as unknown as typeof import("node:child_process").spawn;
  let settled = false;
  const work = terminateWindowsProcessTree(child, spawnTreeKiller, "C:\\Windows\\System32\\taskkill.exe").then(() => {
    settled = true;
  });
  await Promise.resolve();
  assert.equal(settled, false);
  assert.deepEqual(spawnTreeKillerMock.mock.calls[0]?.slice(0, 2), [
    "C:\\Windows\\System32\\taskkill.exe",
    ["/PID", "4242", "/T", "/F"],
  ]);
  assert.equal(childKill.mock.calls.length, 0);
  treeKiller.emit("close", 0, null);
  await work;
  assert.equal(settled, true);
});

test("Windows process-tree termination bounds a hung taskkill helper", async () => {
  vi.useFakeTimers();
  const childKill = vi.fn();
  const child = {
    pid: 4242,
    kill: childKill,
  } as unknown as ChildProcess;
  const treeKiller = new EventEmitter() as ChildProcess;
  const treeKillerKill = vi.fn();
  treeKiller.kill = treeKillerKill;
  const spawnTreeKiller = vi.fn(() => treeKiller) as unknown as typeof import("node:child_process").spawn;
  let settled = false;
  const work = terminateWindowsProcessTree(child, spawnTreeKiller, "C:\\Windows\\System32\\taskkill.exe", 10).then(
    () => {
      settled = true;
    },
  );
  await vi.advanceTimersByTimeAsync(9);
  assert.equal(settled, false);
  await vi.advanceTimersByTimeAsync(1);
  await work;
  assert.equal(settled, true);
  assert.deepEqual(treeKillerKill.mock.calls, [["SIGKILL"]]);
  assert.deepEqual(childKill.mock.calls, [["SIGKILL"]]);
});

async function waitForFile(file: string): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!existsSync(file)) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${file}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function childRequest(overrides: Partial<ChildRequest> = {}): ChildRequest {
  const extensions = overrides.extensions ?? [];
  return {
    task: "task",
    tools: ["read", "grep", "find", "ls"],
    skills: [],
    extensions: [],
    toolSources: Object.fromEntries(
      extensions.flatMap((extension) => extension.tools.map((tool) => [tool, [toolSourceId(extension.path)]])),
    ),
    model: "test-provider/test-model",
    thinkingLevel: "medium",
    cwd: directory,
    projectTrusted: false,
    communication: {
      host: "127.0.0.1",
      port: 31_337,
      token: "a".repeat(64),
    },
    signal: new AbortController().signal,
    ...overrides,
  };
}

function installFakePi(
  source: string,
  options: {
    bundled?: boolean;
    readiness?:
      | "success"
      | "manual"
      | "failure"
      | "malformed"
      | "missingSources"
      | "wrongCount"
      | "invalidFingerprint"
      | "oversized"
      | "close";
  } = {},
): void {
  const packageDirectory = path.join(directory, "pi-core");
  const executableName = options.bundled ? "pi" : "fake-pi.mjs";
  const executablePath = path.join(packageDirectory, executableName);
  const readinessSetup = {
    success:
      'signalReadiness(JSON.stringify({ ok: true, sources: expectedTools.map(() => sourceId(firstExtension)) }) + "\\n");',
    manual: "",
    failure:
      'signalReadiness(JSON.stringify({ ok: false, error: "Requested extension tool is unavailable." }) + "\\n");',
    malformed: 'signalReadiness("not-json\\n");',
    missingSources: 'signalReadiness(JSON.stringify({ ok: true }) + "\\n");',
    wrongCount: 'signalReadiness(JSON.stringify({ ok: true, sources: [] }) + "\\n");',
    invalidFingerprint:
      'signalReadiness(JSON.stringify({ ok: true, sources: expectedTools.map(() => "wrong") }) + "\\n");',
    oversized: 'signalReadiness("x".repeat(16 * 1024 + 1));',
    close: "closeReadiness();",
  }[options.readiness ?? "success"];
  mkdirSync(packageDirectory, { recursive: true });
  writeFileSync(
    executablePath,
    `${options.bundled ? "#!/usr/bin/env node\n" : ""}import fs from "node:fs";
import { createHash } from "node:crypto";
const childBootstrap = JSON.parse(fs.readFileSync(3, "utf8"));
const brokerCredentials = childBootstrap.communication;
const expectedTools = childBootstrap.expectedTools;
const sourceId = (value) => createHash("sha256").update(value).digest("hex");
const firstExtensionFlag = process.argv.indexOf("-e", process.argv.indexOf("-e") + 1);
const firstExtension = firstExtensionFlag < 0 ? "" : process.argv[firstExtensionFlag + 1];
const closeReadiness = () => {
  if (expectedTools.length > 0) fs.closeSync(4);
};
const signalReadiness = (frame) => {
  if (expectedTools.length === 0) return;
  try {
    fs.writeFileSync(4, frame, "utf8");
  } finally {
    fs.closeSync(4);
  }
};
${readinessSetup}
const event = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
const respond = (command, success = true, error) => event({
  id: command.id,
  type: "response",
  command: command.type,
  success,
  ...(error ? { error } : {}),
});
const message = (text, stopReason = "stop") => ({
  type: "message_end",
  message: { role: "assistant", content: [{ type: "text", text }], stopReason },
});
${source}
const dispatch = async (command) => {
  if (command.type === "get_state") {
    respond(command);
    return;
  }
  if (command.type === "get_commands") {
    event({ id: command.id, type: "response", command: command.type, success: true, data: { commands: globalThis.fakeCommands ?? [] } });
    return;
  }
  await handle(command);
};
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  input += chunk;
  while (true) {
    const newline = input.indexOf("\\n");
    if (newline < 0) break;
    const line = input.slice(0, newline);
    input = input.slice(newline + 1);
    if (line.trim()) void dispatch(JSON.parse(line));
  }
});
`,
  );
  if (options.bundled) chmodSync(executablePath, 0o755);
  writeFileSync(
    path.join(packageDirectory, "package.json"),
    JSON.stringify({
      name: "@earendil-works/pi-coding-agent",
      bin: { pi: options.bundled ? "./dist/bundle/cli.js" : "./fake-pi.mjs" },
    }),
  );
  process.env.PI_PACKAGE_DIR = packageDirectory;
  if (options.bundled) {
    process.execPath = executablePath;
    process.versions.bun = "1.3.0";
  }
}
