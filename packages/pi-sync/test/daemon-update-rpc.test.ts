import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { inspectDaemonStatus, stopDaemon } from "@narumitw/pi-sync-daemon";
import { beforeEach, describe, type TestContext, test } from "vitest";
import { createRpcFixture } from "./daemon-rpc-fixture.js";
import type { SyncRpc } from "./daemon-rpc-helpers.js";

const exec = promisify(execFile);
const source = path.resolve("packages/pi-sync");
const daemonManifest = "dist/daemon/package.json";
const daemonBuildId = "dist/daemon/dist/build-id.json";
const oldVersion = "0.0.0";
const oldId = "0".repeat(64);
async function setup(context: TestContext, older: boolean) {
  let cleanup: (() => Promise<void>) | undefined;
  const installation = await fs.mkdtemp(path.join(source, ".pi-sync-build-test-"));
  context.onTestFinished(async () => {
    try {
      await cleanup?.();
    } finally {
      await fs.rm(installation, { recursive: true, force: true });
    }
  });
  await fs.cp(path.join(source, "dist"), path.join(installation, "dist"), { recursive: true });
  await fs.copyFile(path.join(source, "package.json"), path.join(installation, "package.json"));
  if (older) await fs.writeFile(path.join(installation, daemonManifest), JSON.stringify({ version: oldVersion }));
  await fs.writeFile(path.join(installation, daemonBuildId), JSON.stringify(oldId));
  const cli = path.join(installation, "dist/daemon/dist/cli.js");
  const run = (command: string, root: string) => exec(process.execPath, [cli, command, "--root", root]);
  const fixture = await createRpcFixture(
    {
      signal: context.signal,
      onTestFinished: (dispose) => {
        cleanup = dispose;
      },
    },
    installation,
    async (root) => {
      try {
        await run("start", root);
        return () => stopDaemon(root);
      } catch (error) {
        await stopDaemon(root);
        throw error;
      }
    },
  );
  const { agent, requests } = fixture;
  const client = await fixture.connect();
  await client.start();
  const original = await inspectDaemonStatus(agent);
  assert.ok(original.running);
  assert.equal(original.buildVersion, older ? oldVersion : original.expectedBuildVersion);
  assert.equal(original.buildId, oldId);
  assert.equal(original.buildComparison, older ? "older" : "different");
  const installNewBuild = () =>
    Promise.all(
      [daemonManifest, daemonBuildId].map((file) =>
        fs.copyFile(path.join(source, file), path.join(installation, file)),
      ),
    );
  return { agent, client, original, requests, installNewBuild, restart: () => run("restart", agent) };
}

function replacementNotices(client: SyncRpc, from: number) {
  return client.records
    .slice(from)
    .map(({ message }) => message)
    .filter((message) => typeof message === "string" && message.startsWith("Pi Sync daemon replaced."));
}

describe("after an ordered version update", () => {
  let staged: Awaited<ReturnType<typeof setup>>;
  beforeEach(async (context) => {
    staged = await setup(context, true);
  });
  test("real Pi reload replaces the older daemon and reports the verified new build once", async () => {
    const { agent, client, original, requests, installNewBuild } = staged;
    await installNewBuild();
    assert.deepEqual(
      await inspectDaemonStatus(agent),
      original,
      "The running owner must not reread its changed build files.",
    );
    const from = client.records.length;
    await client.call({ type: "prompt", message: "/test-sync-reload" });
    const replacement = await inspectDaemonStatus(agent);
    assert.ok(original.running && replacement.running);
    assert.notEqual(replacement.instance, original.instance);
    assert.equal(replacement.buildComparison, "match");
    assert.equal(replacement.buildId, replacement.expectedBuildId);
    assert.equal(replacement.buildVersion, replacement.expectedBuildVersion);
    assert.deepEqual(replacementNotices(client, from), [
      `Pi Sync daemon replaced. Running version ${replacement.buildVersion}.`,
    ]);
    assert.equal(requests.length, 0);
    assert.equal((await client.command("/sync daemon status", () => false)).disposition, "handled");
    assert.ok(
      client.records
        .slice(from)
        .some(
          ({ message }) =>
            typeof message === "string" &&
            message.includes(`Running build: ${replacement.buildVersion} (${replacement.buildId?.slice(0, 12)})`),
        ),
    );
    assert.deepEqual(await inspectDaemonStatus(agent), replacement);
  });
});

describe("after a same-version build update", () => {
  let staged: Awaited<ReturnType<typeof setup>>;
  beforeEach(async (context) => {
    staged = await setup(context, false);
  });
  test("reload reports the mismatch without replacing the owner", async () => {
    const { agent, client, original, requests, installNewBuild } = staged;
    await installNewBuild();
    const from = client.records.length;
    await client.call({ type: "prompt", message: "/test-sync-reload" });
    assert.deepEqual(await inspectDaemonStatus(agent), original);
    assert.deepEqual(replacementNotices(client, from), []);
    assert.equal((await client.command("/sync daemon status", () => false)).disposition, "handled");
    assert.ok(
      client.records
        .slice(from)
        .some(({ message }) => typeof message === "string" && message.includes("Same version, different build.")),
    );
    assert.deepEqual(await inspectDaemonStatus(agent), original);
    assert.equal(requests.length, 0);
  });
});

describe("explicit same-version restart", () => {
  let staged: Awaited<ReturnType<typeof setup>>;
  beforeEach(async (context) => {
    staged = await setup(context, false);
    await staged.installNewBuild();
    await staged.client.close();
  });
  test("the intended CLI replaces the original build", async () => {
    const { agent, original, requests, restart } = staged;
    await restart();
    const replacement = await inspectDaemonStatus(agent);
    assert.ok(replacement.running);
    assert.notEqual(replacement.instance, original.instance);
    assert.equal(replacement.buildVersion, original.buildVersion);
    assert.equal(replacement.buildComparison, "match");
    assert.equal(requests.length, 0);
  });
});
