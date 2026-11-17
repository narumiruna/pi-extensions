import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { EventEmitter } from "node:events";
import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, test } from "vitest";
import { herdrSessionFingerprint, parseHerdrSpawnProvenance } from "../src/herdr-spawn-provenance.js";

type Json = Record<string, unknown>;
type Run = (args: string[], options?: { signal?: AbortSignal }) => Promise<string>;
type Options = { name: string; taskFile: string; direction?: string };
type Dependencies = {
  run?: Run;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  signal?: AbortSignal;
  readTask?: (path: string) => Promise<string>;
  assertResources?: (root: string, skill: string) => Promise<undefined | string>;
};
type Helper = {
  spawnPeer: (options: Options, dependencies?: Dependencies) => Promise<Json>;
  parseArguments: (args: string[]) => Options | { help: true } | { cliPath: true };
  createRunner: (options: Json) => Run;
  runCli: (args: string[], dependencies?: Json) => Promise<number>;
  packageRoot: string;
  skillDirectory: string;
  MAX_TASK_BYTES: number;
  MAX_OUTPUT_BYTES: number;
};
const script = resolve("packages/pi-herdr/skills/pi-herdr/scripts/spawn-peer.mjs");
const helper = (await import(pathToFileURL(script).href)) as Helper;
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

async function temporaryDirectory() {
  const directory = await mkdtemp(join(tmpdir(), "pi-herdr-spawn-"));
  cleanups.push(() => rm(directory, { force: true, recursive: true }));
  return directory;
}

const cwd = "/repo/space ' $(not-a-command); project";
const options = { name: "reviewer", taskFile: "/owned/task.txt" };
const task = "Task independent-a: audit owned /repo/a.ts only. Do not build or commit. $(touch /BAD); ' \" --wait";
function session(value: string) {
  return { source: "herdr:pi", agent: "pi", kind: "path", value };
}
function nativePane(id: number): Json {
  return {
    pane_id: `w1:p${id}`,
    terminal_id: `terminal-${id}`,
    focused: id === 1,
    cwd,
    agent: "pi",
    agent_status: "idle",
    agent_session: session(`/private/session-${id}.jsonl`),
  };
}

function fixture({ originId = "w1:p1", targetId = "w1:p2" } = {}) {
  const origin: Json = { ...nativePane(1), pane_id: originId };
  const target: Json = { ...nativePane(2), pane_id: targetId, name: "reviewer", interactive_ready: true };
  const fresh: Json = { pane_id: targetId, terminal_id: "terminal-2", focused: false, cwd, agent_status: "none" };
  const calls: string[][] = [];
  const state = {
    origin,
    target,
    fresh,
    originName: "initiator" as string | undefined,
    width: 160,
    height: 40,
    started: false,
    tokens: {} as Json,
    peers: [] as Json[],
    before: undefined as ((args: string[], number: number) => void) | undefined,
    after: undefined as ((args: string[], result: Json | undefined, number: number) => string | undefined) | undefined,
  };
  const run: Run = async (args) => {
    calls.push([...args]);
    state.before?.(args, calls.length);
    let result: Json | undefined;
    switch (`${args[0]} ${args[1]}`) {
      case "pane current":
        result = { type: "pane_current", pane: state.origin };
        break;
      case "agent list":
        result = { type: "agent_list", agents: state.peers };
        break;
      case "pane layout":
        result = {
          type: "pane_layout",
          layout: { panes: [{ pane_id: originId, rect: { width: state.width, height: state.height } }] },
        };
        break;
      case "pane split":
        result = { type: "pane_info", pane: state.fresh };
        break;
      case "pane get":
        result = {
          type: "pane_info",
          pane:
            args[2] === originId
              ? state.origin
              : state.started
                ? { ...state.target, tokens: state.tokens }
                : state.fresh,
        };
        break;
      case "agent get":
        result = {
          type: "agent_info",
          agent: args[2] === originId ? { ...state.origin, name: state.originName } : state.target,
        };
        break;
      case "agent start":
        state.started = true;
        result = { type: "agent_started", agent: { agent: "backend" } };
        break;
      case "pane report-metadata":
        Object.assign(
          state.tokens,
          Object.fromEntries(
            args.flatMap((arg, index) => {
              if (arg !== "--token") return [];
              const text = args[index + 1] ?? "";
              const equals = text.indexOf("=");
              return [[text.slice(0, equals), text.slice(equals + 1)]];
            }),
          ),
        );
        break;
      case "agent prompt":
        result = { type: "agent_prompted", agent: state.target };
        break;
      default:
        throw new Error(`Unexpected fake command ${args.slice(0, 2).join(" ")}`);
    }
    const overridden = state.after?.(args, result, calls.length);
    return overridden ?? (result ? JSON.stringify({ result }) : "");
  };
  const dependencies: Dependencies = {
    env: { HERDR_ENV: "1", HERDR_PANE_ID: "w1:p1", HERDR_SOCKET_PATH: "/tmp/herdr.sock" },
    cwd,
    run,
    readTask: async () => task,
    assertResources: async () => {},
  };
  return { state, calls, dependencies };
}

const commandNames = (calls: string[][]) => calls.map((args) => args.slice(0, 2).join(" "));
const mutations = (calls: string[][]) =>
  calls.filter((args) =>
    ["pane split", "agent start", "pane report-metadata", "agent prompt"].includes(args.slice(0, 2).join(" ")),
  );

async function failed(f: ReturnType<typeof fixture>, message?: RegExp) {
  let captured: (Error & { details: Json }) | undefined;
  try {
    await helper.spawnPeer(options, f.dependencies);
  } catch (error) {
    captured = error as Error & { details: Json };
  }
  assert.ok(captured, "must fail closed");
  if (message) assert.match(captured.message, message);
  assert.ok(!captured.message.includes(task));
  return captured.details;
}

test("orders fresh unfocused spawn, identity checks, exact provenance readback, and one non-waiting handoff", async () => {
  const f = fixture();
  assert.deepEqual(await helper.spawnPeer(options, f.dependencies), {
    paneId: "w1:p2",
    name: "reviewer",
    originPaneId: "w1:p1",
    submitted: true,
  });
  assert.deepEqual(commandNames(f.calls), [
    "pane current",
    "agent get",
    "agent list",
    "pane layout",
    "pane get",
    "agent get",
    "pane split",
    "pane get",
    "agent get",
    "pane get",
    "agent start",
    "agent get",
    "pane get",
    "agent get",
    "agent get",
    "pane get",
    "pane report-metadata",
    "pane get",
    "agent get",
    "agent get",
    "pane get",
    "agent prompt",
  ]);
  const writes = mutations(f.calls);
  assert.deepEqual(writes[0], ["pane", "split", "--pane", "w1:p1", "--direction", "right", "--cwd", cwd, "--no-focus"]);
  assert.deepEqual(writes[1], [
    "agent",
    "start",
    "reviewer",
    "--kind",
    "pi",
    "--pane",
    "w1:p2",
    "--timeout",
    "30000",
    "--",
    "-e",
    helper.packageRoot,
    "--skill",
    helper.skillDirectory,
  ]);
  assert.deepEqual(writes[2]?.slice(0, 5), ["pane", "report-metadata", "w1:p2", "--source", "pi-herdr:spawn:v1"]);
  assert.equal(writes[2]?.length, 15);
  assert.ok(!writes[2]?.includes("--ttl-ms"));
  assert.ok(!writes[2]?.includes("--seq"));
  const tokens = f.state.tokens;
  const targetDigest = herdrSessionFingerprint(f.state.target.terminal_id, f.state.target.agent_session);
  assert.deepEqual(parseHerdrSpawnProvenance(tokens, "terminal-2", targetDigest), {
    originTerminalId: "terminal-1",
    originSession: herdrSessionFingerprint(f.state.origin.terminal_id, f.state.origin.agent_session),
    targetSession: targetDigest,
    originLabel: "initiator",
  });
  assert.deepEqual(Object.keys(tokens).sort(), [
    "pi_spawn_from",
    "pi_spawn_label",
    "pi_spawn_origin",
    "pi_spawn_to",
    "pi_spawn_v",
  ]);
  assert.ok(!JSON.stringify(tokens).includes("/private/"));
  assert.ok(!JSON.stringify(tokens).includes(task));
  const prompt = writes[3];
  assert.equal(prompt?.length, 4);
  assert.equal(prompt?.[2], "w1:p2");
  assert.ok(prompt?.[3]?.endsWith(task));
  assert.match(prompt?.[3] ?? "", /reply identity: pane=w1:p1/u);
  assert.ok(prompt?.[3]?.includes(join(helper.skillDirectory, "SKILL.md")));
  assert.match(prompt?.[3] ?? "", /not additional user authorization/u);
  assert.ok(!prompt?.includes("--wait"));
  assert.ok(!/write.*markdown|temporary.*output/iu.test(prompt?.[3] ?? ""));
});

test("treats live public pane IDs as opaque and preserves allowed task whitespace exactly", async () => {
  const f = fixture({ originId: "pane.origin-A/opaque", targetId: "pane.peer-B/opaque" });
  const whitespaceTask = "Task:\tkeep indentation\r\n\nReturn evidence.\n";
  f.dependencies.readTask = async () => whitespaceTask;
  assert.deepEqual(await helper.spawnPeer(options, f.dependencies), {
    paneId: "pane.peer-B/opaque",
    name: "reviewer",
    originPaneId: "pane.origin-A/opaque",
    submitted: true,
  });
  assert.equal(f.calls.find((args) => args[1] === "split")?.[3], "pane.origin-A/opaque");
  assert.equal(f.calls.find((args) => args[1] === "prompt")?.[2], "pane.peer-B/opaque");
  assert.ok(f.calls.find((args) => args[1] === "prompt")?.[3]?.endsWith(whitespaceTask));
});

test("sanitizes and bounds the origin label, accepts id/path references, and preserves unrelated tokens", async () => {
  for (const name of [undefined, "\u001b[31munsafe\u001b[0m\u0007\u202ename", "😀".repeat(100)]) {
    const f = fixture();
    f.state.originName = name;
    (f.state.origin.agent_session as Json).kind = "id";
    f.state.tokens.other_extension = "untouched";
    await helper.spawnPeer(options, f.dependencies);
    const captured = f.calls.find((args) => args[1] === "report-metadata") ?? [];
    const value = captured.find((arg) => arg.startsWith("pi_spawn_label="))?.slice("pi_spawn_label=".length) ?? "";
    assert.ok([...value].length <= 80);
    assert.ok(!/[\p{Cc}\p{Cf}]/u.test(value));
    assert.equal(value, name === undefined ? "w1:p1" : name.startsWith("😀") ? "😀".repeat(80) : "unsafe name");
    assert.ok(!captured.some((arg) => arg.startsWith("other_extension=")));
    assert.equal(f.state.tokens.other_extension, "untouched");
  }
});

test.each([
  [200, 40, undefined, "right"],
  [79, 40, undefined, "down"],
  [80, 40, undefined, "right"],
  [200, 40, "down", "down"],
  [40, 80, "right", "right"],
])("chooses geometry %s x %s, override %s -> %s", async (width, height, direction, expected) => {
  const f = fixture();
  f.state.width = width as number;
  f.state.height = height as number;
  await helper.spawnPeer({ ...options, ...(direction ? { direction: direction as string } : {}) }, f.dependencies);
  assert.equal(f.calls.find((args) => args[1] === "split")?.[5], expected);
});

const invalidArguments: string[][] = [
  [],
  ["--name", "reviewer"],
  ["--name", "a", "--name", "b", "--task-file", "/task"],
  ["--name", "bad; touch /BAD", "--task-file", "/task"],
  ["--name", "Upper", "--task-file", "/task"],
  ["--name", "a".repeat(33), "--task-file", "/task"],
  ["--name", "a", "--task-file", "/task", "--direction", "left"],
  ["--name", "a", "--task-file", "/task", "--wait"],
  ["--help", "--name", "a"],
  ["--name", "a", "--task-file", "relative/task.txt"],
  ["--name", "a", "--task-file", "/task\u001b.txt"],
  ["--name", "a", "--task-file", "/task", "--direction", "right", "--direction", "down"],
];
test.each(invalidArguments.map((args) => ({ args })))(
  "rejects malformed arguments without echoing payload $args",
  ({ args }) => {
    assert.throws(() => helper.parseArguments(args));
  },
);

test("help is bounded JSON, needs no environment, and never spawns; CLI releases signal listeners", async () => {
  const signals = new EventEmitter();
  const chunks: string[] = [];
  const dependencies = {
    signals,
    stdout: { write: (value: string) => chunks.push(value) },
    spawn: async () => {
      throw new Error("must not spawn");
    },
  };
  assert.equal(await helper.runCli(["--help"], dependencies), 0);
  assert.equal(typeof JSON.parse(chunks[0] ?? "").usage, "string");
  assert.equal(await helper.runCli(["--secret", task], dependencies), 1);
  assert.ok(!chunks.join("").includes(task));
  assert.equal(signals.listenerCount("SIGINT"), 0);
  assert.equal(signals.listenerCount("SIGTERM"), 0);
});

test("standalone CLI returns JSON for help and environment rejection without contacting Herdr", async () => {
  const help = await new Promise<string>((resolveOutput, reject) => {
    execFile(process.execPath, [script, "--help"], { env: { ...process.env, HERDR_ENV: "0" } }, (error, stdout) =>
      error ? reject(error) : resolveOutput(stdout),
    );
  });
  assert.equal(typeof JSON.parse(help).usage, "string");
  const rejection = await new Promise<{ code: unknown; stdout: string; stderr: string }>((resolveOutput) => {
    execFile(
      process.execPath,
      [script, "--name", "reviewer", "--task-file", "/absent-task.txt"],
      { env: { ...process.env, HERDR_ENV: "0" } },
      (error, stdout, stderr) => resolveOutput({ code: error?.code, stdout, stderr }),
    );
  });
  assert.equal(rejection.code, 1);
  assert.equal(rejection.stderr, "");
  const report = JSON.parse(rejection.stdout) as Json;
  assert.equal(report.name, "reviewer");
  assert.match(String(report.error), /HERDR_ENV=1/u);
  assert.ok(Buffer.byteLength(rejection.stdout) < 1024);
});

test.each(["HERDR_PANE_ID", "HERDR_SOCKET_PATH"])(
  "missing or blank %s never falls back to a focused pane",
  async (key) => {
    for (const value of [undefined, "", "   "]) {
      const f = fixture();
      assert.ok(f.dependencies.env);
      if (value === undefined) delete f.dependencies.env[key];
      else f.dependencies.env[key] = value;
      await failed(f, /HERDR_PANE_ID.*HERDR_SOCKET_PATH/u);
      assert.equal(f.calls.length, 0);
    }
  },
);

test("environment, task, and resources fail before the first Herdr call", async () => {
  for (const mode of ["environment", "read", "empty", "large", "nul", "escape", "delete", "c1", "resources"]) {
    const f = fixture();
    if (mode === "environment") f.dependencies.env = {};
    if (mode === "read")
      f.dependencies.readTask = async () => {
        throw new Error(task);
      };
    if (["empty", "large", "nul"].includes(mode))
      f.dependencies.readTask = async () =>
        mode === "empty" ? " " : mode === "large" ? "a".repeat(helper.MAX_TASK_BYTES + 1) : "bad\0text";
    if (["escape", "delete", "c1"].includes(mode))
      f.dependencies.readTask = async () =>
        mode === "escape" ? "\u001b[201~malicious\u001b[200~" : mode === "delete" ? "bad\u007ftext" : "bad\u009btext";
    if (mode === "resources")
      f.dependencies.assertResources = async () => {
        throw new Error(task);
      };
    await failed(f);
    assert.equal(f.calls.length, 0, mode);
  }
});

test("rejects duplicate names, malformed identity, response, and geometry before split", async () => {
  for (const mode of [
    "duplicate",
    "agent",
    "session-agent",
    "source",
    "kind",
    "empty",
    "huge",
    "terminal",
    "long-terminal",
    "padded-terminal",
    "pane",
    "type",
    "geometry",
    "json",
    "oversized",
    "error",
  ]) {
    const f = fixture();
    const ref = f.state.origin.agent_session as Json;
    if (mode === "duplicate") f.state.peers = [{ name: "reviewer" }];
    if (mode === "agent") f.state.origin.agent = "other";
    if (mode === "session-agent") ref.agent = "other";
    if (mode === "source") ref.source = "extension:untrusted";
    if (mode === "kind") ref.kind = "unknown";
    if (mode === "empty") ref.value = "";
    if (mode === "huge") ref.value = "😀".repeat(1025);
    if (mode === "terminal") f.state.origin.terminal_id = "terminal\u001b[31m";
    if (mode === "long-terminal") f.state.origin.terminal_id = "😀".repeat(81);
    if (mode === "padded-terminal") f.state.origin.terminal_id = " terminal-1 ";
    if (mode === "pane") f.state.origin.pane_id = "--current";
    if (mode === "geometry") f.state.width = Number.NaN;
    if (["type", "json", "oversized", "error"].includes(mode))
      f.state.after = () => {
        if (mode === "type") return JSON.stringify({ result: { type: "unknown", pane: f.state.origin } });
        if (mode === "json") return "not JSON";
        if (mode === "oversized") return "x".repeat(helper.MAX_OUTPUT_BYTES + 1);
        return JSON.stringify({ error: { message: task } });
      };
    await failed(f);
    assert.equal(mutations(f.calls).length, 0, mode);
  }
});

test("bounds fallback pane labels even when an origin name sanitizes to empty", async () => {
  const f = fixture({ originId: "x".repeat(200) });
  f.state.originName = "\u001b[31m\u001b[0m";
  await helper.spawnPeer(options, f.dependencies);
  assert.equal(f.state.tokens.pi_spawn_label, "x".repeat(80));
});

test("rejects stale origins before every critical mutation and never closes the known pane", async () => {
  for (const point of ["before-split", "before-start", "before-report", "before-submit"]) {
    const f = fixture();
    f.state.before = (args) => {
      if (args[0] !== "pane" || args[1] !== "get" || args[2] !== "w1:p1") return;
      const names = commandNames(f.calls);
      const phase = names.includes("pane report-metadata")
        ? "before-submit"
        : names.includes("agent start")
          ? "before-report"
          : names.includes("pane split")
            ? "before-start"
            : "before-split";
      if (point === phase) f.state.origin.agent_session = session("replacement");
    };
    const details = await failed(f, /identity changed/u);
    assert.equal(details.paneId, point === "before-split" ? undefined : "w1:p2");
    assert.ok(!commandNames(f.calls).includes("agent prompt"));
    assert.ok(!f.calls.some((args) => args.includes("close") || args.includes("kill")));
  }
});

test("rejects malformed split, fresh-pane takeover, and missing post-start identity without submitting", async () => {
  for (const mode of ["split-id", "split-terminal", "fresh-focused", "fresh-agent", "fresh-cwd", "absent-session"]) {
    const f = fixture();
    if (mode === "split-id") f.state.fresh.pane_id = "\u001bunknown";
    if (mode === "split-terminal") f.state.fresh.terminal_id = "terminal-1";
    if (mode === "fresh-focused") f.state.fresh.focused = true;
    if (mode === "fresh-agent") f.state.fresh.agent = "pi";
    if (mode === "fresh-cwd") f.state.fresh.cwd = "/different";
    if (mode === "absent-session") delete f.state.target.agent_session;
    const details = await failed(f);
    assert.equal(details.paneId, mode === "split-id" ? undefined : "w1:p2");
    assert.ok(!commandNames(f.calls).includes("agent prompt"));
    assert.ok(!commandNames(f.calls).includes("pane report-metadata"));
  }
});

test("native startup requires explicit managed readiness and never falls back to manual launch", async () => {
  for (const mode of ["startup-error", "missing", "null", "false", "string"]) {
    const f = fixture();
    if (mode === "missing") delete f.state.target.interactive_ready;
    if (mode === "null") f.state.target.interactive_ready = null;
    if (mode === "false") f.state.target.interactive_ready = false;
    if (mode === "string") f.state.target.interactive_ready = "true";
    if (mode === "startup-error") {
      f.state.after = (args) => {
        if (args[0] === "agent" && args[1] === "start") throw new Error("native startup failed");
        return undefined;
      };
    }
    const details = await failed(f);
    assert.equal(details.paneId, "w1:p2");
    assert.equal(details.submissionAttempted, false);
    assert.deepEqual(commandNames(mutations(f.calls)), ["pane split", "agent start"]);
    assert.equal(commandNames(f.calls).filter((name) => name === "agent start").length, 1);
    assert.ok(!commandNames(f.calls).some((name) => ["pane run", "agent rename"].includes(name)));
  }
});

test("blocks unsafe readiness, focus, renames and identity replacement both before report and before submission", async () => {
  for (const afterReport of [false, true]) {
    for (const mode of [
      "blocked",
      "working",
      "unknown",
      "focused",
      "not-ready",
      "missing-ready",
      "null-ready",
      "string-ready",
      "launch-pending",
      "invalid-pending",
      "renamed",
      "replacement",
      "terminal",
      "pane",
    ]) {
      const f = fixture();
      f.state.before = (args) => {
        if (args[0] !== "agent" || args[1] !== "get" || args[2] !== "w1:p2") return;
        if (afterReport && !commandNames(f.calls).includes("pane report-metadata")) return;
        if (f.calls.filter((call) => call[0] === "agent" && call[1] === "get" && call[2] === "w1:p2").length < 2)
          return;
        if (["blocked", "working", "unknown"].includes(mode)) f.state.target.agent_status = mode;
        if (mode === "focused") f.state.target.focused = true;
        if (mode === "not-ready") f.state.target.interactive_ready = false;
        if (mode === "missing-ready") delete f.state.target.interactive_ready;
        if (mode === "null-ready") f.state.target.interactive_ready = null;
        if (mode === "string-ready") f.state.target.interactive_ready = "true";
        if (mode === "launch-pending") f.state.target.launch_pending = true;
        if (mode === "invalid-pending") f.state.target.launch_pending = "unknown";
        if (mode === "renamed") f.state.target.name = "other";
        if (mode === "replacement") f.state.target.agent_session = session("replacement");
        if (mode === "terminal") f.state.target.terminal_id = "other";
        if (mode === "pane") f.state.target.pane_id = "w1:p3";
      };
      await failed(f);
      assert.ok(!commandNames(f.calls).includes("agent prompt"), `${mode} after report ${afterReport}`);
    }
  }
});

test("requires exact metadata readback and does not overwrite a prior owned-key record", async () => {
  for (const mode of ["prior", "missing", "wrong", "invalid", "target-replaced"]) {
    const f = fixture();
    if (mode === "prior") f.state.tokens.pi_spawn_v = "old";
    f.state.before = (args) => {
      if (
        args[0] !== "pane" ||
        args[1] !== "get" ||
        args[2] !== "w1:p2" ||
        !commandNames(f.calls).includes("pane report-metadata")
      )
        return;
      if (mode === "missing") delete f.state.tokens.pi_spawn_to;
      if (mode === "wrong") f.state.tokens.pi_spawn_from = "0".repeat(64);
      if (mode === "target-replaced") f.state.target.agent_session = session("replacement");
    };
    if (mode === "invalid")
      f.state.after = (args, result) => {
        if (args[0] === "pane" && args[1] === "get" && args[2] === "w1:p2")
          return JSON.stringify({ result: { ...result, pane: { ...f.state.target, tokens: [] } } });
        return undefined;
      };
    await failed(f);
    assert.ok(!commandNames(f.calls).includes("agent prompt"));
    if (mode === "prior") assert.ok(!commandNames(f.calls).includes("pane report-metadata"));
  }
});

test("never retries startup, publication, blocked prompt, timeout, or ambiguous acknowledgement", async () => {
  for (const point of ["agent start", "pane report-metadata", "agent prompt", "ambiguous"]) {
    const f = fixture();
    f.state.after = (args) => {
      const name = args.slice(0, 2).join(" ");
      if (point === "ambiguous" && name === "agent prompt") return JSON.stringify({ result: { type: "ok" } });
      if (name === point) throw new Error(`timeout or blocked: ${task}`);
      return undefined;
    };
    const details = await failed(f);
    assert.equal(details.paneId, "w1:p2");
    assert.equal(details.name, "reviewer");
    assert.equal(details.submissionAttempted, point === "agent prompt" || point === "ambiguous");
    for (const name of ["pane split", "agent start", "pane report-metadata", "agent prompt"]) {
      assert.ok(commandNames(f.calls).filter((value) => value === name).length <= 1);
    }
  }
});

test("cancellation at every CLI await stops all later operations, retains known IDs, and never resubmits", async () => {
  const baseline = fixture();
  await helper.spawnPeer(options, baseline.dependencies);
  for (let stop = 1; stop <= baseline.calls.length; stop++) {
    const f = fixture();
    const controller = new AbortController();
    f.dependencies.signal = controller.signal;
    f.state.after = (_args, _result, count) => {
      if (count === stop) controller.abort();
      return undefined;
    };
    const details = await failed(f, /cancelled/u);
    assert.equal(f.calls.length, stop);
    assert.equal(details.paneId, stop >= 7 ? "w1:p2" : undefined);
    assert.equal(
      commandNames(f.calls).filter((value) => value === "agent prompt").length,
      stop === baseline.calls.length ? 1 : 0,
    );
  }
});

test("cancellation after task/resource awaits prevents all CLI calls; standalone signals abort the active seam", async () => {
  for (const point of ["task", "resources"]) {
    const f = fixture();
    const controller = new AbortController();
    f.dependencies.signal = controller.signal;
    if (point === "task")
      f.dependencies.readTask = async () => {
        controller.abort();
        return task;
      };
    else
      f.dependencies.assertResources = async () => {
        controller.abort();
      };
    await failed(f, /cancelled/u);
    assert.equal(f.calls.length, 0);
  }
  const signals = new EventEmitter();
  let aborted = false;
  const code = await helper.runCli(["--name", "reviewer", "--task-file", "/task"], {
    signals,
    stdout: { write: () => {} },
    spawn: async (_options: Options, dependencies: Dependencies) => {
      dependencies.signal?.addEventListener("abort", () => {
        aborted = true;
      });
      signals.emit("SIGTERM");
      throw new Error("cancelled");
    },
  });
  assert.equal(code, 1);
  assert.equal(aborted, true);
  assert.equal(signals.listenerCount("SIGTERM"), 0);
});

test("runner uses argument arrays with cwd, inherited environment, deadlines and maxBuffer; discards argv-bearing errors", async () => {
  const env = { HERDR_ENV: "1", INHERITED_AUTH: "not-forwarded-as-an-argument" };
  const received: Array<{ command: string; args: string[]; options: Json }> = [];
  const run = helper.createRunner({
    command: process.execPath,
    cwd,
    env,
    execFileImpl: (
      command: string,
      args: string[],
      execution: Json,
      done: (error: Error | null, stdout: string) => void,
    ) => {
      received.push({ command, args, options: execution });
      done(args[1] === "prompt" ? new Error(task) : null, "{}");
    },
  });
  await run(["agent", "start", "reviewer"]);
  await assert.rejects(run(["agent", "prompt", "w1:p2", task]), (error: Error) => !error.message.includes(task));
  assert.equal(received[0]?.command, process.execPath);
  assert.deepEqual(received[1]?.args, ["agent", "prompt", "w1:p2", task]);
  assert.equal(received[0]?.options.cwd, cwd);
  assert.equal(received[0]?.options.env, env);
  assert.equal(received[0]?.options.shell, false);
  assert.equal(received[0]?.options.timeout, 35000);
  assert.equal(received[1]?.options.timeout, 5000);
  assert.equal(received[0]?.options.maxBuffer, helper.MAX_OUTPUT_BYTES);
  assert.equal(received[0]?.options.killSignal, "SIGKILL");
});

test("real execFile runner bounds output and aborts its own child after a readiness handshake", async () => {
  const directory = await temporaryDirectory();
  const fake = join(directory, "fake-cli.mjs");
  await writeFile(fake, "process.stdout.write('ready'); setInterval(() => {}, 1000);\n");
  const controller = new AbortController();
  let observedReady = false;
  let closed: Promise<void> | undefined;
  const run = helper.createRunner({
    command: process.execPath,
    prefixArgs: [fake],
    timeoutMs: 1000,
    execFileImpl: (...args: Parameters<typeof execFile>) => {
      const child = execFile(...args);
      closed = new Promise<void>((resolveClosed) => child.once("close", () => resolveClosed()));
      child.stdout?.once("data", () => {
        observedReady = true;
        controller.abort();
      });
      return child;
    },
  });
  await assert.rejects(run(["pane", "get", "w1:p2"], { signal: controller.signal }), /cancelled/u);
  await closed;
  assert.equal(observedReady, true);
  await writeFile(fake, "process.stdout.write('x'.repeat(1024));\n");
  await assert.rejects(
    helper.createRunner({ command: process.execPath, prefixArgs: [fake], maxBuffer: 100 })([]),
    /CLI/u,
  );
});

test.skipIf(process.platform === "win32")(
  "rejects FIFO and device task inputs without waiting for a writer or making control calls",
  async () => {
    const directory = await temporaryDirectory();
    const fifo = join(directory, "task.fifo");
    await new Promise<void>((resolveCreated, reject) => {
      execFile("mkfifo", [fifo], { timeout: 1000 }, (error) => (error ? reject(error) : resolveCreated()));
    });
    for (const input of [fifo, "/dev/null", directory]) {
      const f = fixture();
      delete f.dependencies.readTask;
      await assert.rejects(helper.spawnPeer({ ...options, taskFile: input }, f.dependencies), /bounded UTF-8/u);
      assert.equal(f.calls.length, 0);
    }
  },
);

test("installed helper resolves its own package and skill resources, preserves task text, and rejects bad UTF-8 and oversized input", async () => {
  const directory = await temporaryDirectory();
  const root = join(directory, "node_modules/@example/pi-herdr");
  const installed = join(root, "skills/pi-herdr/scripts/spawn-peer.mjs");
  await mkdir(dirname(installed), { recursive: true });
  await mkdir(join(root, "dist"), { recursive: true });
  await copyFile(script, installed);
  await writeFile(join(root, "dist/index.ts"), "export default () => {};\n");
  const skill = resolve(dirname(installed), "..");
  await writeFile(join(skill, "SKILL.md"), "# Fixture\n");
  const imported = (await import(pathToFileURL(installed).href)) as Helper;
  const input = join(directory, "task with ' quotes.txt");
  await writeFile(input, task);
  const f = fixture();
  const deps = { ...f.dependencies };
  delete deps.readTask;
  delete deps.assertResources;
  await imported.spawnPeer({ ...options, taskFile: input }, deps);
  assert.deepEqual(f.calls.find((args) => args[1] === "start")?.slice(-5), ["--", "-e", root, "--skill", skill]);
  assert.equal(fileURLToPath(pathToFileURL(imported.packageRoot)), root);
  for (const content of [Buffer.from([0xff]), Buffer.alloc(helper.MAX_TASK_BYTES + 1)]) {
    await writeFile(input, content);
    const fresh = fixture();
    await assert.rejects(
      imported.spawnPeer({ ...options, taskFile: input }, { ...deps, run: fresh.dependencies.run }),
      /bounded UTF-8/u,
    );
    assert.equal(fresh.calls.length, 0);
  }
  await rm(join(root, "dist/index.ts"));
  await writeFile(input, task);
  await mkdir(join(root, "src"));
  const sourceEntry = join(root, "src/index.ts");
  await writeFile(sourceEntry, "export default () => {};\n");
  const sourceOnly = fixture();
  await imported.spawnPeer({ ...options, taskFile: input }, { ...deps, run: sourceOnly.dependencies.run });
  assert.deepEqual(sourceOnly.calls.find((args) => args[1] === "start")?.slice(-5), [
    "--",
    "-e",
    sourceEntry,
    "--skill",
    skill,
  ]);
  await rm(sourceEntry);
  const missing = fixture();
  await assert.rejects(
    imported.spawnPeer({ ...options, taskFile: input }, { ...deps, run: missing.dependencies.run }),
    /package entrypoint/u,
  );
  assert.equal(missing.calls.length, 0);
});
