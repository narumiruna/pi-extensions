import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { spawnHcPeer } from "../src/hc-peer.mjs";
import { requestHc, subscribeHc, withHcConnection } from "../src/hc-rpc.mjs";

// Repository-only, provider-free contract smoke. Never discover or control a default user core.
assert.equal(process.platform, "linux", "This isolated smoke currently supports Linux only");
assert.ok(isAbsolute(process.argv[2] ?? ""), "Pass an explicitly trusted absolute hc executable");
const hc = await realpath(process.argv[2]);
const root = await mkdtemp(join(tmpdir(), "pi-hc-probe-"));
const endpoint = join(root, "run/core.sock");
const env = {
  HOME: join(root, "home"),
  PATH: "/usr/bin:/bin",
  SHELL: "/bin/sh",
  TERM: "xterm-256color",
  HC_SESSION: `pi-probe-${randomUUID().slice(0, 8)}`,
  HC_SOCKET: endpoint,
  XDG_RUNTIME_DIR: join(root, "run"),
  XDG_STATE_HOME: join(root, "state"),
  XDG_CONFIG_HOME: join(root, "config"),
  PI_CODING_AGENT_DIR: join(root, "pi"),
  PI_OFFLINE: "1",
  // Harmless canaries verify that explicit peer env overrides the core's startup environment.
  NODE_OPTIONS: "--no-warnings",
  NODE_PATH: join(root, "nonexistent-module-canary"),
};
for (const key of ["HOME", "XDG_RUNTIME_DIR", "XDG_STATE_HOME", "XDG_CONFIG_HOME", "PI_CODING_AGENT_DIR"])
  await mkdir(env[key], { mode: 0o700 });
const exec = promisify(execFile);
const owned = new Set();
const operation = new AbortController();
const cancel = () => operation.abort();
process.on("SIGINT", cancel);
process.on("SIGTERM", cancel);
const call = (socket, method, params, options = {}) =>
  requestHc(socket, method, params, { ...options, signal: operation.signal });
let startAttempted = false;
let subscription;
let coreId;
const failures = [];
const events = [];
try {
  startAttempted = true;
  // Let the launcher's bounded readiness check settle even after cancellation, then clean up its partial core.
  await exec(hc, ["server", "start", "--json"], { env, timeout: 30_000, maxBuffer: 64 * 1024 });
  const hello = await call(endpoint, "hello", { generation: 1 });
  assert.equal(hello.generation, 1);
  coreId = hello.core.id;
  subscription = await subscribeHc(endpoint, { signal: operation.signal, onEvent: (frame) => events.push(frame) });
  assert.ok(Array.isArray(subscription.snapshot.terminals));
  console.error(JSON.stringify({ event: "probe_ready", root, endpoint }));
  const fixture = join(root, "inert-pi.mjs");
  await writeFile(
    fixture,
    [
      'import readline from "node:readline";',
      'const status = (state) => process.stdout.write("\\x1b]7501;state=" + state + ":app=pi\\x1b\\\\");',
      'status("idle");',
      'readline.createInterface({input:process.stdin}).on("line", line => {',
      '  if (line.includes("HC_PROBE_TASK")) {',
      '    status("working"); console.log("HC_FIXTURE_RECEIVED");',
      '    console.log(process.env.NODE_OPTIONS === "" && process.env.NODE_PATH === "" ? "HC_ENV_CLEAN" : "HC_ENV_UNCLEARED");',
      '    status("done");',
      "  }",
      "});",
      "",
    ].join("\n"),
  );
  const origin = await call(endpoint, "terminal.run", {
    argv: [process.execPath, fixture],
    cwd: process.cwd(),
    name: "probe-origin",
    no_parent: true,
    outlive_parent: true,
    wait: false,
    keep: false,
    rm: false,
  });
  owned.add(origin.address);
  const ready = await call(endpoint, "terminal.wait", { terminal: origin.address, timeout: 15 }, { timeoutMs: 20_000 });
  assert.equal(ready.status, "idle");
  let sends = 0;
  const packageRoot = fileURLToPath(new URL("../", import.meta.url));
  const peer = await withHcConnection(
    endpoint,
    (request, disconnected) =>
      spawnHcPeer(
        {
          name: "probe-peer",
          text: "HC_PROBE_TASK: inert local fixture only; no provider or Pi agent.",
          piCli: fixture,
        },
        {
          originId: origin.address,
          signal: AbortSignal.any([operation.signal, disconnected]),
          root: packageRoot,
          skill: resolve(packageRoot, "skills/pi-herdr"),
          // This fixture owns the scratch core and its pre-spawn environment.
          approve: async () => true,
          request: async (method, params, options) => {
            if (method === "terminal.send") sends += 1;
            const result = await request(method, params, options);
            if (method === "terminal.run" && typeof result?.address === "string") owned.add(result.address);
            return result;
          },
        },
      ),
    { signal: operation.signal },
  );
  console.error(JSON.stringify({ event: "peer_ready", root, endpoint }));
  assert.equal(peer.submitted, true);
  assert.equal(sends, 1);
  await call(
    endpoint,
    "terminal.wait",
    { terminal: peer.address, caller: origin.address, timeout: 15 },
    { timeoutMs: 20_000 },
  );
  const output = await call(endpoint, "terminal.read", { terminal: peer.address, lines: 20 });
  assert.match(output.text, /HC_FIXTURE_RECEIVED/u);
  assert.match(output.text, /HC_ENV_CLEAN/u);
  assert.doesNotMatch(output.text, /HC_ENV_UNCLEARED/u);
  const facts = await call(endpoint, "terminal.get", { terminal: peer.address });
  assert.equal(facts.parent, origin.address);
  assert.equal(facts.die_with_parent, false);
  await call(endpoint, "terminal.kill", { terminal: origin.address });
  const after = await call(endpoint, "terminal.get", { terminal: peer.address });
  assert.equal(after.state, "live");
  const all = await call(endpoint, "terminal.list", { all: true });
  assert.ok(all.terminals.some((terminal) => terminal.address === origin.address && terminal.state === "finished"));
  assert.ok(events.some((frame) => frame.method === "event" && frame.params.type === "status"));
  console.log(
    JSON.stringify(
      {
        core: coreId,
        passed: [
          "isolated core handshake",
          "subscription snapshot and native status events",
          "absolute argv fixture startup/readiness",
          "one idle-conditional task send",
          "Node preload environment cleared for the peer",
          "fixture receipt",
          "native parent provenance",
          "peer outlives initiator",
          "finished ancestor retained",
        ],
      },
      null,
      2,
    ),
  );
} catch (error) {
  failures.push(error);
} finally {
  try {
    await subscription?.close();
  } catch (error) {
    failures.push(error);
  }
  if (startAttempted) {
    let sameCore = true;
    try {
      const hello = await requestHc(endpoint, "hello", { generation: 1 });
      if (coreId !== undefined && hello.core.id !== coreId) {
        sameCore = false;
        failures.push(new Error("Scratch core identity changed; refusing cleanup of a replacement core"));
      }
      for (const terminal of sameCore ? owned : []) {
        try {
          const facts = await requestHc(endpoint, "terminal.get", { terminal });
          if (facts.state === "live") await requestHc(endpoint, "terminal.kill", { terminal });
          await requestHc(endpoint, "terminal.rm", { terminal });
        } catch (error) {
          failures.push(error);
        }
      }
    } catch (error) {
      failures.push(error);
    }
    if (sameCore) {
      // Stop only the private scratch endpoint, including after partial startup or launcher failure.
      try {
        await exec(hc, ["server", "stop", "--json"], { env, timeout: 10_000, maxBuffer: 64 * 1024 });
      } catch (error) {
        failures.push(error);
      }
    }
  }
  process.removeListener("SIGINT", cancel);
  process.removeListener("SIGTERM", cancel);
  if (failures.length === 0) await rm(root, { recursive: true, force: true });
}
if (failures.length) throw new AggregateError(failures, `Isolated hc probe or cleanup failed; inspect ${root}`);
