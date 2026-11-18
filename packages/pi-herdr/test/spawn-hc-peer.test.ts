import assert from "node:assert/strict";
import { chmod, copyFile, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve, win32 } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, test } from "vitest";

type Json = Record<string, unknown>;
type RequestOptions = { signal?: AbortSignal; timeoutMs?: number; maxBytes?: number };
type Request = (method: string, params: Json, options?: RequestOptions) => Promise<unknown>;
type Options = { name: string; text: string; piCli: string };
type FileInfo = { isFile(): boolean; size: number };
type Fs = {
  stat(path: string): Promise<FileInfo>;
  realpath(path: string): Promise<string>;
  access(path: string, mode?: number): Promise<void>;
};
type IoOptions = { signal?: AbortSignal; fs?: Partial<Fs> };
type Executables = { node: string; piCli: string };
type ResolveOptions = IoOptions & { cwd?: string; execPath?: string; platform?: NodeJS.Platform };
type Dependencies = {
  request?: Request;
  originId?: string;
  approve?: () => Promise<boolean>;
  cwd?: string;
  signal?: AbortSignal;
  assertResources?: (root: string, skill: string, options?: IoOptions) => Promise<string>;
  resolveExecutables?: (piCli: string, options?: ResolveOptions) => Promise<Executables>;
  root?: string;
  skill?: string;
};
type Helper = {
  spawnHcPeer(options: Options, dependencies?: Dependencies): Promise<Json>;
  checkResources(root: string, skill: string, options?: IoOptions): Promise<string>;
  resolveTrustedExecutables(piCli: string, options?: ResolveOptions): Promise<Executables>;
  MAX_TASK_BYTES: number;
  MAX_OUTPUT_BYTES: number;
  WAIT_TIMEOUT_MS: number;
  SEND_TIMEOUT_MS: number;
};
const script = resolve("packages/pi-herdr/src/hc-peer.mjs");
const helper = (await import(pathToFileURL(script).href)) as Helper;
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});
async function temporaryDirectory() {
  const directory = await mkdtemp(join(tmpdir(), "pi-hc-spawn-"));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  return realpath(directory);
}
const cwd = resolve(tmpdir(), "project with ' quotes $(not-executed); space");
const task = "Self-contained task: inspect only the owned file. Preserve punctuation: ' $ \".";
const options: Options = { name: "reviewer", text: task, piCli: resolve(tmpdir(), "trusted Pi/dist/cli.js") };
const packageRoot = resolve("packages/pi-herdr");
const skillDirectory = join(packageRoot, "skills/pi-herdr");
const launchArgv = (entry = packageRoot, skill = skillDirectory) => [
  process.execPath,
  options.piCli,
  "-e",
  entry,
  "--skill",
  skill,
];
type Call = { method: string; params: Json; options: RequestOptions };
function terminal(address: string, argv: string[]): Json {
  return {
    address,
    name: address === "t1" ? "initiator" : "reviewer",
    labels: {},
    argv,
    cwd,
    state: "live",
    pid: address === "t1" ? 101 : 102,
    created_ms: address === "t1" ? 1000 : 2000,
    screen: "exact",
    cols: 200,
    rows: 120,
    reported: true,
    status: { app: "pi", state: "idle" },
    parent: address === "t1" ? null : "t1",
    die_with_parent: false,
    keep: false,
    rm: false,
    foreground: { pid: 999, argv: ["observation only"], cwd },
  };
}
function fixture() {
  const calls: Call[] = [];
  const state = {
    origin: terminal("t1", ["/trusted/node", "/trusted/pi/dist/cli.js"]),
    target: terminal("t2", launchArgv()),
    hello: {
      generation: 1,
      framed: false,
      core: { id: "core-permanent-id", name: "machine" },
      methods: ["terminal.get", "terminal.run", "terminal.wait", "terminal.send"],
    },
    wait: { terminal: "t2", ended: true, reason: "status", status: "idle", turn: 0, children: [] } as Json,
    send: { status: "idle", turn: 0, started: false } as unknown,
    before: undefined as ((call: Call, count: number) => void) | undefined,
    after: undefined as ((call: Call, result: unknown, count: number) => unknown) | undefined,
  };
  const request: Request = async (method, params, requestOptions = {}) => {
    const call = { method, params: structuredClone(params), options: requestOptions };
    calls.push(call);
    state.before?.(call, calls.length);
    let result: unknown;
    if (method === "hello") result = state.hello;
    else if (method === "terminal.get") result = params.terminal === "t1" ? state.origin : state.target;
    else if (method === "terminal.run") result = state.target;
    else if (method === "terminal.wait") result = state.wait;
    else if (method === "terminal.send") result = state.send;
    else throw new Error(`Unexpected method: ${method}`);
    return structuredClone(state.after ? state.after(call, result, calls.length) : result);
  };
  const dependencies: Dependencies = {
    originId: "t1",
    approve: async () => true,
    root: packageRoot,
    skill: skillDirectory,
    cwd,
    request,
    assertResources: async () => packageRoot,
    resolveExecutables: async () => ({ node: process.execPath, piCli: options.piCli }),
  };
  return { calls, state, dependencies };
}
type Fixture = ReturnType<typeof fixture>;
const methods = (f: Fixture) => f.calls.map((call) => call.method);
const mutations = (f: Fixture) => f.calls.filter((call) => ["terminal.run", "terminal.send"].includes(call.method));
async function failed(f: Fixture, message?: RegExp, opts = options) {
  let captured: (Error & { details: Json }) | undefined;
  try {
    await helper.spawnHcPeer(opts, f.dependencies);
  } catch (error) {
    captured = error as Error & { details: Json };
  }
  assert.ok(captured, "must fail closed");
  if (message) assert.match(captured.message, message);
  assert.equal(captured.name, "SpawnHcPeerError");
  assert.ok(!JSON.stringify(captured.details).includes(task));
  assert.equal(captured.cause, undefined);
  assert.ok(
    f.calls.every((call) =>
      ["hello", "terminal.get", "terminal.run", "terminal.wait", "terminal.send"].includes(call.method),
    ),
  );
  return captured.details;
}

test("orders direct argv creation, one wait, fresh observations, and one conditional non-waiting send", async () => {
  const f = fixture();
  assert.deepEqual(await helper.spawnHcPeer(options, f.dependencies), {
    address: "t2",
    name: "reviewer",
    originAddress: "t1",
    submitted: true,
    started: false,
  });
  assert.deepEqual(methods(f), [
    "hello",
    "terminal.get",
    "hello",
    "terminal.get",
    "terminal.run",
    "terminal.wait",
    "terminal.get",
    "hello",
    "terminal.get",
    "terminal.get",
    "terminal.send",
  ]);
  for (const call of f.calls.filter((call) => call.method === "terminal.get")) {
    assert.deepEqual(Object.keys(call.params), ["terminal"]); // caller would mark news seen.
  }
  assert.deepEqual(f.calls[0]?.params, { generation: 1 });
  const run = mutations(f)[0];
  assert.deepEqual(run?.params, {
    argv: launchArgv(),
    cwd,
    name: "reviewer",
    parent: "t1",
    caller: "t1",
    outlive_parent: true,
    env: { NODE_OPTIONS: "", NODE_PATH: "" },
    keep: false,
    rm: false,
    wait: false,
  });
  assert.ok(!JSON.stringify(run).includes(task));
  assert.deepEqual(f.calls[5]?.params, { terminal: "t2", caller: "t1", timeout: 30 });
  assert.equal(f.calls[5]?.options.timeoutMs, helper.WAIT_TIMEOUT_MS);
  const send = mutations(f)[1];
  assert.ok(send);
  assert.equal(send.options.timeoutMs, helper.SEND_TIMEOUT_MS);
  assert.deepEqual(
    { ...send.params, text: undefined },
    {
      terminal: "t2",
      caller: "t1",
      text: undefined,
      if: "idle",
      wait: false,
      force: false,
    },
  );
  assert.ok(String(send.params.text).endsWith(task));
  assert.match(String(send.params.text), /not additional user authorization/u);
  assert.match(String(send.params.text), /Initiator reply terminal: t1/u);
  assert.match(String(send.params.text), /ancestry, not Pi session identity/u);
  assert.ok(String(send.params.text).includes(join(skillDirectory, "SKILL.md")));
  assert.ok(!/sessionDigest|interactive_ready|pi_spawn|temporary.*output/iu.test(String(send.params.text)));
});

test.each(["idle", "working", "done"])("origin %s is allowed, but the peer must report idle", async (status) => {
  const f = fixture();
  f.state.origin.status = { app: "pi", state: status };
  await helper.spawnHcPeer(options, f.dependencies);
  assert.equal(mutations(f).length, 2);
});

test("native startup need not have reported yet, and no pseudo interactive_ready field is required", async () => {
  const f = fixture();
  f.state.after = (call, result) =>
    call.method === "terminal.run" ? { ...f.state.target, reported: false, status: null } : result;
  await helper.spawnHcPeer(options, f.dependencies);
  assert.equal(methods(f).filter((method) => method === "terminal.wait").length, 1);
});

test.each([true, false, null, undefined])("SendResult started=%s is only an acknowledgement", async (started) => {
  const f = fixture();
  f.state.send = { turn: 0, ...(started === undefined ? {} : { started }), status: null };
  const result = await helper.spawnHcPeer(options, f.dependencies);
  assert.deepEqual(result, {
    address: "t2",
    name: "reviewer",
    originAddress: "t1",
    submitted: true,
    ...(typeof started === "boolean" ? { started } : {}),
  });
  assert.ok(!Object.hasOwn(result, "completed"));
});

test.each(["message", "timeout"])(
  "wait reason %s is not readiness; only current idle status permits one send",
  async (reason) => {
    for (const status of ["idle", "working", "done", "blocked", "error"]) {
      const f = fixture();
      Object.assign(f.state.wait, { reason, ended: false, status: "working", from: "t3" });
      f.state.target.status = { app: "pi", state: status };
      if (status === "idle") await helper.spawnHcPeer(options, f.dependencies);
      else await failed(f, /status report/u);
      assert.equal(methods(f).filter((method) => method === "terminal.wait").length, 1);
      assert.equal(methods(f).filter((method) => method === "terminal.send").length, status === "idle" ? 1 : 0);
    }
  },
);

test("bad task, controls, resources, and executable errors fail before any RPC and hide injected causes", async () => {
  const badTasks = [
    "",
    " \r\n\t",
    "x".repeat(helper.MAX_TASK_BYTES + 1),
    "x\0y",
    "x\u001b[31my",
    "x\u007fy",
    "x\u009by",
  ];
  for (const bad of badTasks) {
    const f = fixture();
    await failed(f, undefined, { ...options, text: bad });
    assert.equal(f.calls.length, 0);
  }
  for (const seam of ["assertResources", "resolveExecutables"] as const) {
    const f = fixture();
    f.dependencies[seam] = async () => {
      throw new Error(task);
    };
    const details = await failed(f);
    assert.equal(details.submissionAttempted, false);
    assert.equal(f.calls.length, 0);
  }
  const valid = fixture();
  const whitespace = "Task:\tkeep indentation\r\n\nReturn evidence.\n";
  await helper.spawnHcPeer({ ...options, text: whitespace }, valid.dependencies);
  assert.ok(String(mutations(valid)[1]?.params.text).endsWith(whitespace));
  const boundary = fixture();
  const fullTask = `x${"\t".repeat(helper.MAX_TASK_BYTES - 1)}`;
  await helper.spawnHcPeer({ ...options, text: fullTask }, boundary.dependencies);
  const send = mutations(boundary)[1];
  assert.ok(send && Buffer.byteLength(JSON.stringify(send.params)) < helper.MAX_OUTPUT_BYTES);
});

const malformedOrigin: [string, unknown][] = [
  ["address", "t9"],
  ["address", "bad\u001baddress"],
  ["state", "finished"],
  ["pid", 0],
  ["pid", null],
  ["pid", 1.5],
  ["created_ms", Number.MAX_SAFE_INTEGER + 1],
  ["created_ms", -1],
  ["argv", []],
  ["argv", [""]],
  ["argv", [1]],
  ["reported", false],
  ["status", null],
  ["status", { app: "other", state: "idle" }],
  ["status", { app: "pi", state: "blocked" }],
  ["status", { app: "pi", state: "error" }],
];
test.each(malformedOrigin)("rejects malformed/unsafe origin %s=%j before creating anything", async (key, value) => {
  const f = fixture();
  f.state.origin[key] = value;
  await failed(f);
  assert.equal(mutations(f).length, 0);
});

test("hello rejects unsupported generations, missing methods, and state-wipe core ID changes", async () => {
  for (const mode of ["generation", "framed", "methods", "missing-id", "before-run", "before-send"]) {
    const f = fixture();
    f.state.before = (call) => {
      if (call.method !== "hello") return;
      const count = f.calls.filter((item) => item.method === "hello").length;
      if (mode === "generation") f.state.hello.generation = 2;
      if (mode === "framed") f.state.hello.framed = true;
      if (mode === "methods") f.state.hello.methods = ["terminal.get"];
      if (mode === "missing-id") f.state.hello.core.id = "";
      if ((mode === "before-run" && count === 2) || (mode === "before-send" && count === 3))
        f.state.hello.core.id = "state-wiped";
    };
    const details = await failed(f, /hello|core identity/u);
    assert.equal(details.address, mode === "before-send" ? "t2" : undefined);
    assert.equal(methods(f).includes("terminal.run"), mode === "before-send");
    assert.ok(!methods(f).includes("terminal.send"));
  }
});

test("revalidates origin process identity and safe status before each mutation", async () => {
  for (const phase of ["run", "send"]) {
    for (const field of ["pid", "created_ms", "argv", "state", "reported", "status"]) {
      const f = fixture();
      f.state.before = (call) => {
        if (call.method !== "terminal.get" || call.params.terminal !== "t1") return;
        const count = f.calls.filter((item) => item.method === "terminal.get" && item.params.terminal === "t1").length;
        if (count !== (phase === "run" ? 2 : 3)) return;
        if (field === "pid") f.state.origin.pid = 999;
        if (field === "created_ms") f.state.origin.created_ms = 3000;
        if (field === "argv") (f.state.origin.argv as string[])[0] = "replacement";
        if (field === "state") f.state.origin.state = "finished";
        if (field === "reported") f.state.origin.reported = false;
        if (field === "status") f.state.origin.status = { app: "pi", state: "blocked" };
      };
      const details = await failed(f);
      assert.equal(details.address, phase === "send" ? "t2" : undefined);
      assert.equal(mutations(f).length, phase === "send" ? 1 : 0);
    }
  }
});

const changedTarget: [string, unknown][] = [
  ["address", "t3"],
  ["created_ms", 3001],
  ["pid", 103],
  ["argv", ["/unrelated/command"]],
  ["state", "finished"],
  ["name", "renamed"],
  ["cwd", "/other"],
  ["parent", "t9"],
  ["die_with_parent", true],
  ["keep", true],
  ["rm", true],
  ["reported", false],
  ["status", null],
  ["status", { app: "other", state: "idle" }],
  ["status", { app: "pi", state: "working" }],
  ["status", { app: "pi", state: "blocked" }],
  ["status", { app: "pi", state: "error" }],
];
test.each(changedTarget)("changed peer %s=%j fails after wait or immediately before send", async (key, value) => {
  for (const targetGet of [1, 2]) {
    const f = fixture();
    f.state.before = (call) => {
      const count = f.calls.filter((item) => item.method === "terminal.get" && item.params.terminal === "t2").length;
      if (call.method === "terminal.get" && call.params.terminal === "t2" && count === targetGet)
        f.state.target[key] = value;
    };
    const details = await failed(f);
    assert.equal(details.address, "t2");
    assert.equal(details.submissionAttempted, false);
    assert.equal(mutations(f).length, 1);
  }
});

test("creation requires full direct public Terminal, captures partial known addresses, and never retries names", async () => {
  for (const mode of [
    "partial",
    "short-cli",
    "nested",
    "same-origin",
    "wrong-parent",
    "wrong-argv",
    "dead",
    "name-taken",
  ]) {
    const f = fixture();
    f.state.after = (call, result) => {
      if (call.method !== "terminal.run") return result;
      if (mode === "partial") return { address: "t2" };
      if (mode === "short-cli") return { terminal: "t2", name: "reviewer", state: "live" };
      if (mode === "nested") return { terminal: f.state.target };
      if (mode === "same-origin") return { ...f.state.target, address: "t1" };
      if (mode === "wrong-parent") return { ...f.state.target, parent: null };
      if (mode === "wrong-argv") return { ...f.state.target, argv: ["pi"] };
      if (mode === "dead") return { ...f.state.target, state: "finished" };
      throw new Error(`name_taken ${task}`);
    };
    const details = await failed(f);
    assert.equal(
      details.address,
      ["short-cli", "nested", "name-taken"].includes(mode) ? undefined : mode === "same-origin" ? "t1" : "t2",
    );
    assert.deepEqual(methods(f).slice(-1), ["terminal.run"]);
    assert.equal(mutations(f).length, 1);
  }
});

test("malformed wait never authorizes a send; even blocked wait status requires fresh inspection", async () => {
  for (const value of [
    null,
    {},
    { terminal: "t2", ended: true },
    { terminal: "t3", ended: true, reason: "status", turn: 0, children: [] },
    { terminal: "t2", ended: true, reason: "exit", turn: 0, children: [] },
  ]) {
    const f = fixture();
    f.state.after = (call, result) => (call.method === "terminal.wait" ? value : result);
    await failed(f);
    assert.ok(!methods(f).includes("terminal.send"));
  }
  const blocked = fixture();
  blocked.state.wait.status = "blocked";
  blocked.state.target.status = { app: "pi", state: "blocked" };
  await failed(blocked, /status report/u);
  assert.equal(methods(blocked).at(-1), "terminal.get");
});

test("observed foreground is not an authenticated guard or Pi session identity", async () => {
  const f = fixture();
  f.state.before = (call) => {
    if (call.method === "terminal.get") {
      f.state.origin.foreground = null;
      f.state.target.foreground = { pid: 10001, argv: ["changed observation"] };
    }
  };
  await helper.spawnHcPeer(options, f.dependencies);
  assert.equal(mutations(f).length, 2);
  assert.ok(!Object.hasOwn(mutations(f)[1]?.params ?? {}, "pid"));
});

test("never retries ambiguous mutations, malformed acknowledgements, blocked native send, or RPC errors", async () => {
  for (const stage of ["terminal.run", "terminal.wait", "terminal.send", "malformed", "started-type", "no-turn"]) {
    const f = fixture();
    f.state.after = (call, result) => {
      if (call.method === stage) throw new Error(`blocked/timeout/argv/private-session: ${task}`);
      if (call.method === "terminal.send" && stage === "malformed") return null;
      if (call.method === "terminal.send" && stage === "started-type") return { turn: 0, started: "true" };
      if (call.method === "terminal.send" && stage === "no-turn") return { started: true };
      return result;
    };
    const details = await failed(f);
    assert.equal(details.name, "reviewer");
    assert.equal(details.address, stage === "terminal.run" ? undefined : "t2");
    assert.equal(details.submissionAttempted, !["terminal.run", "terminal.wait"].includes(stage));
    for (const method of ["terminal.run", "terminal.wait", "terminal.send"]) {
      assert.ok(methods(f).filter((value) => value === method).length <= 1);
    }
  }
});

test("cancellation after every RPC await stops further work and retains known partial creation", async () => {
  const baseline = fixture();
  await helper.spawnHcPeer(options, baseline.dependencies);
  for (let stop = 1; stop <= baseline.calls.length; stop++) {
    const f = fixture();
    const controller = new AbortController();
    f.dependencies.signal = controller.signal;
    f.state.after = (_call, result, count) => {
      if (count === stop) controller.abort();
      return result;
    };
    const details = await failed(f, /cancelled/u);
    assert.equal(f.calls.length, stop);
    assert.equal(details.address, stop >= 5 ? "t2" : undefined);
    assert.equal(details.submissionAttempted, stop === baseline.calls.length);
  }
});

test("cancels an active owned request at every RPC boundary without cleaning up the independent peer", async () => {
  const baseline = fixture();
  await helper.spawnHcPeer(options, baseline.dependencies);
  for (let stop = 1; stop <= baseline.calls.length; stop++) {
    const f = fixture();
    const request = f.dependencies.request;
    assert.ok(request);
    const controller = new AbortController();
    f.dependencies.signal = controller.signal;
    let aborted = false;
    f.dependencies.request = async (method, params, requestOptions) => {
      const result = await request(method, params, requestOptions);
      if (f.calls.length !== stop) return result;
      return new Promise((_resolve, reject) => {
        controller.signal.addEventListener(
          "abort",
          () => {
            aborted = true;
            reject(new Error(task));
          },
          { once: true },
        );
        controller.abort();
      });
    };
    await failed(f, /cancelled/u);
    assert.equal(aborted, true);
    assert.equal(f.calls.length, stop);
  }
});

test("resource/executable awaits honor cancellation before the first socket call", async () => {
  for (const seam of ["assertResources", "resolveExecutables"] as const) {
    const f = fixture();
    const controller = new AbortController();
    f.dependencies.signal = controller.signal;
    if (seam === "assertResources")
      f.dependencies.assertResources = async () => {
        controller.abort();
        return packageRoot;
      };
    if (seam === "resolveExecutables")
      f.dependencies.resolveExecutables = async () => {
        controller.abort();
        return { node: process.execPath, piCli: options.piCli };
      };
    await failed(f, /cancelled/u);
    assert.equal(f.calls.length, 0);
  }
  const preCancelled = fixture();
  preCancelled.dependencies.signal = AbortSignal.abort();
  await failed(preCancelled, /cancelled/u);
  assert.equal(preCancelled.calls.length, 0);
});

function resourceFs(stop = 0, controller = new AbortController()) {
  let count = 0;
  const checkpoint = () => {
    if (++count === stop) controller.abort();
  };
  const root = resolve(tmpdir(), "self-contained-package");
  const skill = join(root, "skills/pi-herdr");
  const fs: Partial<Fs> = {
    realpath: async (path) => {
      checkpoint();
      return path;
    },
    stat: async () => {
      checkpoint();
      return { isFile: () => true, size: 1 };
    },
  };
  return { fs, root, skill, controller, count: () => count };
}
test("resource validation cancels after each filesystem await before contacting hc", async () => {
  const baseline = resourceFs();
  await helper.checkResources(baseline.root, baseline.skill, { fs: baseline.fs });
  for (let stop = 1; stop <= baseline.count(); stop++) {
    const io = resourceFs(stop);
    const f = fixture();
    f.dependencies.signal = io.controller.signal;
    f.dependencies.root = io.root;
    f.dependencies.skill = io.skill;
    f.dependencies.assertResources = (root, skill, ioOptions) =>
      helper.checkResources(root, skill, { ...ioOptions, fs: io.fs });
    await failed(f, /cancelled/u);
    assert.equal(f.calls.length, 0);
    assert.equal(io.count(), stop);
  }
});

async function trustFixture() {
  const directory = await temporaryDirectory();
  const project = join(directory, "project");
  const nested = join(project, "nested", "cwd");
  const trusted = join(directory, "trusted with ' quotes");
  await mkdir(join(project, ".git"), { recursive: true });
  await mkdir(nested, { recursive: true });
  await writeFile(join(project, "nested", ".git"), "gitdir: inert-marker\n");
  await mkdir(trusted);
  const node = join(trusted, process.platform === "win32" ? "node.exe" : "node");
  const cli = join(trusted, "pi-cli.js");
  await writeFile(node, "INERT FILE: NEVER EXECUTE\n");
  await chmod(node, 0o700);
  await writeFile(cli, "INERT FILE: NEVER EXECUTE\n");
  return { directory, project, nested, trusted, node, cli };
}
test("resolves canonical external Node/Pi files without executing candidates or searching PATH", async () => {
  const t = await trustFixture();
  const result = await helper.resolveTrustedExecutables(t.cli, { cwd: t.nested, execPath: t.node });
  const slash = (path: string) => (process.platform === "win32" ? path.replaceAll("\\", "/") : path);
  assert.deepEqual(result, { node: slash(t.node), piCli: slash(t.cli) });
  assert.equal(await readFile(t.node, "utf8"), "INERT FILE: NEVER EXECUTE\n");
  assert.equal(await readFile(t.cli, "utf8"), "INERT FILE: NEVER EXECUTE\n");
  for (const [execPath, piCli] of [
    ["node", t.cli],
    [t.node, "pi"],
    [t.node, `${t.cli}\u001b`],
  ]) {
    await assert.rejects(helper.resolveTrustedExecutables(piCli ?? "", { cwd: t.nested, execPath }), /absolute/u);
  }
});

test("rejects candidates anywhere inside the topmost Git ancestor, including symlink targets and cwd symlinks", async () => {
  const t = await trustFixture();
  const local = join(t.project, "outside-nested-node");
  await writeFile(local, "INERT\n");
  await chmod(local, 0o700);
  for (const [execPath, piCli] of [
    [local, t.cli],
    [t.node, local],
  ]) {
    await assert.rejects(
      helper.resolveTrustedExecutables(piCli ?? "", { cwd: t.nested, execPath }),
      /topmost cwd Git ancestor/u,
    );
  }
  if (process.platform === "win32") return;
  const candidateLink = join(t.trusted, "external-looking-node");
  await symlink(local, candidateLink);
  const cwdLink = join(t.directory, "cwd-link");
  await symlink(t.nested, cwdLink);
  await assert.rejects(
    helper.resolveTrustedExecutables(t.cli, { cwd: cwdLink, execPath: candidateLink }),
    /Git ancestor/u,
  );
  await assert.rejects(
    helper.resolveTrustedExecutables(candidateLink, { cwd: cwdLink, execPath: t.node }),
    /Git ancestor/u,
  );
  const externalLink = join(t.project, "external-Pi-link");
  await symlink(t.cli, externalLink);
  assert.equal(
    (await helper.resolveTrustedExecutables(externalLink, { cwd: t.nested, execPath: t.node })).piCli,
    t.cli,
  );
});

test("without Git the cwd is the rejecting boundary; directories are not executable/script files", async () => {
  const directory = await temporaryDirectory();
  const local = join(directory, "node");
  await writeFile(local, "INERT\n");
  await assert.rejects(
    helper.resolveTrustedExecutables(local, { cwd: directory, execPath: process.execPath }),
    /cwd without Git/u,
  );
  const t = await trustFixture();
  await assert.rejects(
    helper.resolveTrustedExecutables(t.trusted, { cwd: t.nested, execPath: t.node }),
    /regular files/u,
  );
});

function executableFs(stop = 0, platform: NodeJS.Platform = "linux", executable = "node.exe") {
  const windows = platform === "win32";
  const cwdPath = windows ? "C:\\project\\work" : "/project/work";
  const node = windows ? `C:\\trusted\\${executable}` : "/trusted/node";
  const cli = windows ? "C:\\trusted\\Pi\\dist\\cli.js" : "/trusted/Pi/dist/cli.js";
  let count = 0;
  const controller = new AbortController();
  const checkpoint = () => {
    if (++count === stop) controller.abort();
  };
  const fs: Partial<Fs> = {
    realpath: async (path) => {
      checkpoint();
      return path;
    },
    stat: async (path) => {
      checkpoint();
      if (path.endsWith(".git")) throw Object.assign(new Error("inert missing marker"), { code: "ENOENT" });
      return { isFile: () => true, size: 10 };
    },
    access: async () => {
      checkpoint();
    },
  };
  return { cwd: cwdPath, execPath: node, cli, platform, fs, controller, count: () => count };
}
test("trusted-path verification honors cancellation after every filesystem await", async () => {
  const baseline = executableFs();
  await helper.resolveTrustedExecutables(baseline.cli, baseline);
  for (let stop = 1; stop <= baseline.count(); stop++) {
    const t = executableFs(stop);
    await assert.rejects(helper.resolveTrustedExecutables(t.cli, { ...t, signal: t.controller.signal }), /cancelled/u);
    assert.equal(t.count(), stop);
  }
});

test("Windows direct executable argv uses forward slashes to exclude native template lookup and rejects wrappers", async () => {
  const t = executableFs(0, "win32");
  assert.deepEqual(await helper.resolveTrustedExecutables(t.cli, t), {
    node: "C:/trusted/node.exe",
    piCli: "C:/trusted/Pi/dist/cli.js",
  });
  assert.ok(win32.isAbsolute(t.execPath));
  for (const wrapper of ["node.cmd", "node.bat", "node.ps1"]) {
    const candidate = executableFs(0, "win32", wrapper);
    await assert.rejects(helper.resolveTrustedExecutables(candidate.cli, candidate), /native executable/u);
  }
});

test("copied installed helper is self-contained and chooses dist package root or source-only Git entry", async () => {
  const directory = await temporaryDirectory();
  const root = join(directory, "node_modules/@example/pi-herdr");
  const skill = join(root, "skills/pi-herdr");
  const installed = join(root, "src/hc-peer.mjs");
  await mkdir(dirname(installed), { recursive: true });
  await mkdir(join(root, "dist"));
  await copyFile(script, installed);
  await mkdir(skill, { recursive: true });
  await writeFile(join(root, "dist/index.ts"), "INERT RESOURCE\n");
  await writeFile(join(skill, "SKILL.md"), "# Inert resource\n");
  const imported = (await import(pathToFileURL(installed).href)) as Helper;
  for (const source of [false, true]) {
    const f = fixture();
    Object.assign(f.dependencies, { root, skill });
    delete f.dependencies.assertResources;
    const entry = source ? join(root, "src/index.ts") : root;
    f.state.target.argv = launchArgv(entry, skill);
    await imported.spawnHcPeer(options, f.dependencies);
    assert.deepEqual(mutations(f)[0]?.params.argv, launchArgv(entry, skill));
    if (!source) {
      await rm(join(root, "dist"), { recursive: true });
      await mkdir(join(root, "src"), { recursive: true });
      await writeFile(join(root, "src/index.ts"), "INERT SOURCE\n");
    }
  }
  await rm(join(root, "src/index.ts"));
  const missing = fixture();
  delete missing.dependencies.assertResources;
  Object.assign(missing.dependencies, { root, skill });
  await assert.rejects(imported.spawnHcPeer(options, missing.dependencies), /package entrypoint/u);
  assert.equal(missing.calls.length, 0);
});

test.skipIf(process.platform === "win32")(
  "package and skill resources cannot escape to unrelated code through symlinks",
  async () => {
    const directory = await temporaryDirectory();
    const root = join(directory, "package");
    const skill = join(root, "skills/pi-herdr");
    await mkdir(join(root, "dist"), { recursive: true });
    await mkdir(skill, { recursive: true });
    const outside = join(directory, "external.ts");
    await writeFile(outside, "INERT\n");
    await writeFile(join(skill, "SKILL.md"), "# Resource\n");
    await symlink(outside, join(root, "dist/index.ts"));
    await assert.rejects(helper.checkResources(root, skill), /escaped/u);
    await rm(join(root, "dist/index.ts"));
    await writeFile(join(root, "dist/index.ts"), "INERT\n");
    await rm(join(skill, "SKILL.md"));
    await symlink(outside, join(skill, "SKILL.md"));
    await assert.rejects(helper.checkResources(root, skill), /escaped/u);
    await assert.rejects(helper.checkResources(root, directory), /belong/u);
  },
);
