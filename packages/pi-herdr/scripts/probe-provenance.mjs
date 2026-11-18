import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { resolveHerdrExecutable } from "./resolve-herdr-executable.mjs";

const exec = promisify(execFile);
assert.equal(process.env.HERDR_ENV, "1");
assert.notEqual(process.platform, "win32", "This repository-only probe requires a Unix shell fixture");
const herdr = await resolveHerdrExecutable();
const name = `pi-herdr-probe-${randomUUID().slice(0, 8)}`;
const directory = await mkdtemp(join(tmpdir(), "pi-herdr-contract-"));
const env = { ...process.env };
for (const key of ["HERDR_SOCKET_PATH", "HERDR_PANE_ID", "HERDR_WORKSPACE_ID", "HERDR_TAB_ID"]) delete env[key];
const server = spawn(herdr, ["--session", name, "server"], { env, stdio: ["ignore", "pipe", "pipe"] });
let logs = "";
server.stdout.on("data", (b) => {
  logs = `${logs}${b}`.slice(-4096);
});
server.stderr.on("data", (b) => {
  logs = `${logs}${b}`.slice(-4096);
});
let serverError;
server.on("error", (error) => {
  serverError = error;
});
async function cli(...args) {
  const r = await exec(herdr, ["--session", name, ...args], { env, timeout: 5000, maxBuffer: 512000 });
  return r.stdout.trim() ? JSON.parse(r.stdout) : undefined;
}
async function until(read, predicate, label) {
  const deadline = Date.now() + 8000;
  do {
    const result = await read();
    if (predicate(result)) return result;
    await delay(25);
  } while (Date.now() < deadline);
  throw Error(`Timeout: ${label}`);
}
let socket;
const failures = [];
try {
  await until(
    async () => {
      if (serverError) throw serverError;
      try {
        return await cli("workspace", "list");
      } catch {
        return undefined;
      }
    },
    (x) => x !== undefined,
    `server readiness (${name}; ${logs})`,
  );
  const created = await cli("workspace", "create", "--cwd", directory, "--no-focus");
  let p = created.result.root_pane.pane_id;
  const terminal = created.result.root_pane.terminal_id;
  await writeFile(
    join(directory, "pi"),
    "#!/bin/sh\nprintf 'PEER_PROBE_READY\\n'\nwhile IFS= read -r line; do :; done\n",
  );
  const fixture = `'${join(directory, "pi").replaceAll("'", "'\\''")}'`;
  await cli("pane", "run", p, `/bin/sh ${fixture}`);
  await cli("pane", "wait-output", p, "--match", "PEER_PROBE_READY", "--timeout", "5000");
  await until(
    () => cli("pane", "get", p),
    (x) => x.result.pane.agent === "pi",
    "foreground Pi fixture detection",
  );
  const sessions = JSON.parse(
    (await exec(herdr, ["session", "list", "--json"], { env, timeout: 5000 })).stdout,
  ).sessions;
  const socketPath = sessions.find((s) => s.name === name).socket_path;
  socket = net.createConnection(socketPath);
  let pending = "";
  const events = [];
  socket.on("data", (b) => {
    pending += b;
    let i = pending.indexOf("\n");
    while (i >= 0) {
      events.push(JSON.parse(pending.slice(0, i)));
      pending = pending.slice(i + 1);
      i = pending.indexOf("\n");
    }
  });
  await new Promise((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  });
  socket.write(
    `${JSON.stringify({
      id: "probe-events",
      method: "events.subscribe",
      params: { subscriptions: [{ type: "pane.updated" }, { type: "pane.moved" }] },
    })}\n`,
  );
  await until(
    async () => events,
    (x) => x.some((f) => f.id === "probe-events" && f.result),
    "subscription readiness",
  );
  await cli(
    "pane",
    "report-agent-session",
    p,
    "--source",
    "herdr:pi",
    "--agent",
    "pi",
    "--agent-session-path",
    join(directory, "original.jsonl"),
    "--session-start-source",
    "new",
    "--seq",
    "1",
  );
  const original = await until(
    () => cli("pane", "get", p),
    (x) => !!x.result.pane.agent_session,
    "session acquisition",
  );
  assert.equal(original.result.pane.agent_session.value, join(directory, "original.jsonl"));
  await cli(
    "pane",
    "report-metadata",
    p,
    "--source",
    "pi-herdr:spawn:v1",
    "--token",
    "pi_spawn_v=1",
    "--token",
    "pi_spawn_origin=term_test",
  );
  await until(
    async () => events,
    (x) => x.some((f) => f.event === "pane_updated" && f.data?.pane?.tokens?.pi_spawn_v === "1"),
    "metadata invalidation",
  );
  await cli(
    "pane",
    "report-metadata",
    p,
    "--source",
    "herdr:pi",
    "--token",
    "model=temporary",
    "--token",
    "expires=1",
    "--ttl-ms",
    "50",
  );
  await cli("pane", "report-metadata", p, "--source", "different:source", "--token", "model=durable");
  const expired = await until(
    () => cli("pane", "get", p),
    (x) => !x.result.pane.tokens?.expires,
    "TTL expiry",
  );
  assert.equal(expired.result.pane.tokens.pi_spawn_v, "1");
  assert.equal(expired.result.pane.tokens.model, "durable");
  await cli(
    "pane",
    "report-agent-session",
    p,
    "--source",
    "herdr:pi",
    "--agent",
    "pi",
    "--agent-session-path",
    join(directory, "replacement.jsonl"),
    "--session-start-source",
    "resume",
    "--seq",
    "2",
  );
  const replacement = await cli("pane", "get", p);
  assert.equal(replacement.result.pane.agent_session.value, join(directory, "replacement.jsonl"));
  assert.equal(replacement.result.pane.tokens.pi_spawn_v, "1");
  const moved = await cli("pane", "move", p, "--new-workspace", "--no-focus");
  p = moved.result.move_result.pane.pane_id;
  assert.equal(moved.result.move_result.pane.terminal_id, terminal);
  assert.equal(moved.result.move_result.pane.tokens.pi_spawn_v, "1");
  const beforeRename = events.length;
  await cli("agent", "rename", p, "probe-peer");
  await until(
    async () => events.slice(beforeRename),
    (x) => x.some((f) => f.event === "pane_updated"),
    "rename invalidation",
  );
  await cli(
    "pane",
    "report-agent-session",
    p,
    "--source",
    "herdr:pi",
    "--agent",
    "pi",
    "--agent-session-path",
    join(directory, "replacement.jsonl"),
    "--session-start-source",
    "startup",
    "--seq",
    "3",
  );
  assert.equal((await cli("pane", "get", p)).result.pane.tokens.pi_spawn_v, "1");
  await cli(
    "pane",
    "report-metadata",
    p,
    "--source",
    "pi-herdr:spawn:v1",
    "--clear-token",
    "pi_spawn_v",
    "--clear-token",
    "pi_spawn_origin",
  );
  const cleared = await cli("pane", "get", p);
  assert.equal(cleared.result.pane.tokens.pi_spawn_v, undefined);
  assert.equal(cleared.result.pane.tokens.model, "durable");
  await cli("pane", "report-metadata", p, "--source", "probe:limits", "--token", `limit=${"測".repeat(81)}`);
  assert.equal([...(await cli("pane", "get", p)).result.pane.tokens.limit].length, 80);
  await assert.rejects(cli("pane", "report-metadata", p, "--source", "probe:limits", "--token", "invalid.key=value"));
  await assert.rejects(
    cli(
      "pane",
      "report-metadata",
      p,
      "--source",
      "probe:limits",
      ...Array.from({ length: 17 }, (_, i) => ["--token", `limit_${i}=1`]).flat(),
    ),
  );
  console.log(
    JSON.stringify(
      {
        session: name,
        passed: [
          "Pi fixture identity acquisition",
          "pane.updated metadata event",
          "shared token map across sources",
          "omitted TTL persists",
          "patch without TTL cancels expiry",
          "identity replacement preserves tokens (digest gating required)",
          "move preserves terminal and tokens",
          "rename emits pane.updated",
          "same identity re-report preserves tokens",
          "clear only owned keys",
          "token value truncation and invalid key/patch bounds",
        ],
        eventCount: events.length,
      },
      null,
      2,
    ),
  );
} catch (error) {
  failures.push(error);
} finally {
  socket?.destroy();
  try {
    await exec(herdr, ["session", "stop", name, "--json"], { env, timeout: 5000 });
  } catch (error) {
    failures.push(error);
    // This PID belongs only to the uniquely named probe server, never the caller's Herdr server.
    server.kill("SIGTERM");
  }
  if (server.pid !== undefined && server.exitCode === null && server.signalCode === null) {
    await new Promise((resolve) => server.once("exit", resolve));
  }
  try {
    await exec(herdr, ["session", "delete", name, "--json"], { env, timeout: 5000 });
  } catch (error) {
    failures.push(error);
  }
  await rm(directory, { recursive: true, force: true });
}
if (failures.length > 0) throw new AggregateError(failures, `Provenance probe or cleanup failed: ${name}`);
