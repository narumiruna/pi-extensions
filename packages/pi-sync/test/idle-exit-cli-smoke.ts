import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { findDaemon, type Identity } from "@narumitw/pi-sync-daemon";
import { createRpcFixture } from "./daemon-rpc-fixture.js";

// Standalone real-clock smoke, not a Vitest case. All providers and storage are owned loopback fixtures.
const grace = 30_000;
const controller = new AbortController();
const cleanups: Array<() => Promise<void>> = [];
const cancel = () => controller.abort(new Error("Lifetime smoke cancelled"));
process.once("SIGINT", cancel);
process.once("SIGTERM", cancel);
const exec = promisify(execFile);

function alive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}
async function waitForExit(identity: Identity, agent: string) {
  // This deadline starts only after the service readiness handshake (and Pi exit, if applicable).
  const deadline = Date.now() + grace + 10_000;
  while (alive(identity.pid)) {
    if (Date.now() >= deadline) throw new Error("Automatic owner exit deadline exceeded.");
    await delay(100, undefined, { signal: controller.signal });
  }
  assert.equal(await findDaemon(agent), undefined);
}
try {
  const fixture = await createRpcFixture(
    {
      signal: controller.signal,
      onTestFinished: (cleanup) => {
        cleanups.push(cleanup);
      },
    },
    path.resolve("packages/pi-sync"),
  );
  await fixture.startDaemon();
  const cli = path.resolve("packages/pi-sync-daemon/dist/cli.js");
  const started = JSON.parse((await exec(process.execPath, [cli, "start", "--root", fixture.agent])).stdout);
  const empty = await findDaemon(fixture.agent);
  assert.ok(empty);
  assert.equal(started.instance, empty.identity.instance);
  await waitForExit(empty.identity, fixture.agent);

  const first = await fixture.connect();
  await first.start();
  await first.command("/sync daemon handover", () => true);
  // This route crosses the generated package's lazy command boundary without sending a model prompt.
  await first.command("/sync daemon status", () => true);
  const ordinary = await findDaemon(fixture.agent);
  assert.ok(ordinary);
  assert.notEqual(ordinary.identity.instance, empty.identity.instance);
  const evidence = path.join(fixture.agent, "retained-lifetime-evidence");
  await fs.writeFile(evidence, "exact recovery bytes\r\n");
  const closingStarted = Date.now();
  await first.close();
  await waitForExit(ordinary.identity, fixture.agent);
  assert.ok(Date.now() - closingStarted >= grace, "live Pi protection must precede the full grace");
  assert.equal(await fs.readFile(evidence, "utf8"), "exact recovery bytes\r\n");

  const settingsFile = path.join(fixture.agent, "pi-sync.json");
  const settings = JSON.parse(await fs.readFile(settingsFile, "utf8"));
  Object.assign(settings.syncSetups.home.sync, { agentMode: true, continuous: true });
  await fs.writeFile(settingsFile, JSON.stringify(settings), { mode: 0o600 });
  const second = await fixture.connect();
  await second.start();
  await second.command("/sync daemon allow-after-exit", () => true);
  const permitted = await findDaemon(fixture.agent);
  assert.ok(permitted);
  assert.notEqual(permitted.identity.instance, ordinary.identity.instance);
  const consentFile = path.join(fixture.agent, "pi-sync", "daemon.json");
  const consentBytes = await fs.readFile(consentFile);
  assert.equal(JSON.parse(consentBytes.toString()).setups.home.afterExit, true);
  await second.close();
  const retainedUntil = Date.now() + grace + 2_000;
  while (Date.now() < retainedUntil) {
    const current = await findDaemon(fixture.agent);
    assert.equal(current?.identity.instance, permitted.identity.instance);
    assert.equal(alive(permitted.identity.pid), true);
    await delay(250, undefined, { signal: controller.signal });
  }
  assert.deepEqual(await fs.readFile(consentFile), consentBytes);
  assert.equal(await fs.readFile(evidence, "utf8"), "exact recovery bytes\r\n");
  assert.equal(fixture.requests.length, 0);
  console.log(
    JSON.stringify({
      result: "PASS",
      entry: "packages/pi-sync",
      noClientCliExit: true,
      lastPiExit: true,
      eligiblePiRestart: true,
      afterExitGrantRetained: true,
      lazyCommand: true,
      providerRequests: 0,
      recoveryBytesRetained: true,
    }),
  );
} finally {
  try {
    for (const cleanup of cleanups.toReversed()) await cleanup();
  } finally {
    process.off("SIGINT", cancel);
    process.off("SIGTERM", cancel);
  }
}
