import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { findDaemon, stopDaemon, waitForDaemonExit } from "@narumitw/pi-sync-daemon";
import { createRpcFixture } from "./daemon-rpc-fixture.js";

// Real packaged Pi/daemon smoke with loopback storage and no model prompts.
const controller = new AbortController();
const cleanups: Array<() => Promise<void>> = [];
const cancel = () => controller.abort(new Error("Debug log smoke cancelled"));
process.once("SIGINT", cancel);
process.once("SIGTERM", cancel);

interface Record {
  source: "pi-sync" | "pi-sync-daemon";
  event: string;
  outcome?: string;
  operation?: string;
  operationId?: string;
  pid: number;
}

async function until<T>(label: string, check: () => Promise<T | undefined>) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const result = await check();
    if (result !== undefined) return result;
    await delay(100, undefined, { signal: controller.signal });
  }
  throw new Error(`Debug log smoke timed out waiting for ${label}.`);
}

try {
  const fixture = await createRpcFixture(
    { signal: controller.signal, onTestFinished: (cleanup) => cleanups.push(cleanup) },
    path.resolve("packages/pi-sync"),
  );
  const settings = path.join(fixture.agent, "pi-sync.json");
  const target = path.join(fixture.agent, "pi-sync.log");
  const input = path.join(fixture.agent, "AGENTS.md");
  async function preference(debug: boolean, legacy = false) {
    const next = JSON.parse(await fs.readFile(settings, "utf8"));
    next.debug = debug;
    if (legacy) Object.assign(next.syncSetups.home.sync, { agentMode: true, continuous: true });
    const temporary = `${settings}.smoke`;
    await fs.writeFile(temporary, JSON.stringify(next), { mode: 0o600 });
    await fs.rename(temporary, settings);
  }
  async function records(): Promise<Record[]> {
    const read = await fs.readFile(target, "utf8").catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return "";
      throw error;
    });
    return read
      .trimEnd()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  }
  const latest = () => [...fixture.storage.resources].find(([name]) => name.endsWith("/latest.json"))?.[1];
  await preference(true);
  const first = await fixture.connect();
  await first.start();
  assert.ok(await first.call({ type: "get_commands" }));
  await first.command("/sync daemon handover", () => true);
  await first.command("/sync push --yes", () => true);
  const baseline = latest();
  assert.ok(baseline, "the push seeds an accepted baseline");
  const owner = await findDaemon(fixture.agent);
  assert.ok(owner);
  await until("correlated client and daemon push", async () => {
    const all = await records();
    const client = all.find(
      (record) => record.source === "pi-sync" && record.operation === "push" && record.outcome === "completed",
    );
    return client?.operationId &&
      all.some(
        (record) =>
          record.source === "pi-sync-daemon" &&
          record.pid === owner.identity.pid &&
          record.operationId === client.operationId &&
          record.outcome === "completed",
      )
      ? all
      : undefined;
  }).catch(async (error: unknown) => {
    throw new Error(`Correlated records missing: ${JSON.stringify(await records())}`, { cause: error });
  });
  await first.close();

  await preference(true, true);
  const second = await fixture.connect();
  await second.start();
  await second.command("/sync daemon allow-after-exit", () => {
    throw new Error("A retired grant must not ask for approval.");
  });
  assert.ok(second.records.some((record) => String(record.message).includes("Continuous sync was retired")));
  const consent = JSON.parse(await fs.readFile(path.join(fixture.agent, "pi-sync", "daemon.json"), "utf8"));
  assert.deepEqual(consent.setups, {});
  assert.ok(
    second.records.some(
      (record) =>
        record.type === "extension_ui_request" &&
        record.method === "notify" &&
        String(record.message).startsWith("pi-sync debug:"),
    ),
  );
  await second.close();
  await fs.writeFile(input, "after Pi disconnected\n");
  assert.equal((await findDaemon(fixture.agent))?.identity.instance, owner.identity.instance);

  await preference(false);
  const disabledBytes = await fs.readFile(target);
  const third = await fixture.connect();
  await third.start();
  await third.command("/sync diff", () => true);
  await third.close();
  assert.equal((await findDaemon(fixture.agent))?.identity.instance, owner.identity.instance);
  assert.ok(await stopDaemon(fixture.agent));
  await waitForDaemonExit(owner.identity, controller.signal);
  assert.deepEqual(latest(), baseline);
  assert.ok((await records()).every((record) => record.event !== "continuous-cycle"));
  assert.deepEqual(await fs.readFile(target), disabledBytes);
  assert.equal(fixture.requests.length, 0);
  assert.doesNotMatch(disabledBytes.toString(), /after Pi disconnected|owned-loopback-fixture|\/latest\.json/u);
  console.log(
    JSON.stringify({
      result: "PASS",
      rpcFraming: true,
      correlatedRecords: true,
      retiredGrantRejected: true,
      disabledSameDaemon: true,
      providerRequests: 0,
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
