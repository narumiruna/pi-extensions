import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { DaemonConnection, findDaemon, inspectDaemonStatus, stopDaemon } from "@narumitw/pi-sync-daemon";
import { beforeEach, describe, type TestContext, test } from "vitest";
import { WebDavSyncBackend } from "../src/backends/webdav/webdav-backend.js";
import { configFromSettings } from "../src/settings/config.js";
import { validateSettingsDocument } from "../src/settings/settings-validation.js";
import { createRpcFixture } from "./daemon-rpc-fixture.js";
import type { SyncRpc } from "./daemon-rpc-helpers.js";
import { snapshot } from "./data-fixtures.js";

const exec = promisify(execFile);
const source = path.resolve("packages/pi-sync");
const daemonManifest = "dist/daemon/package.json";
const daemonBuildId = "dist/daemon/dist/build-id.json";
const oldVersion = "0.0.0";
const oldId = "0".repeat(64);
async function setup(context: TestContext, older: boolean, includeSessions = false) {
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
        if (includeSessions) {
          const transfers = pathToFileURL(path.join(installation, "dist/daemon/dist/engine/sync/sync-operations.js"));
          const env = { ...process.env, NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --import=${transfers.href}` };
          await exec(process.execPath, [cli, "start", "--root", root], { env });
        } else await run("start", root);
        return () => stopDaemon(root);
      } catch (error) {
        await stopDaemon(root);
        throw error;
      }
    },
  );
  const { agent, requests, cwd } = fixture;
  if (includeSessions) {
    const file = path.join(agent, "pi-sync.json");
    const settings = JSON.parse(await fs.readFile(file, "utf8"));
    settings.syncSetups.home.sync.include.push("sessions");
    await fs.writeFile(file, JSON.stringify(settings));
  }
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
  return {
    agent,
    cwd,
    client,
    original,
    requests,
    storage: fixture.storage,
    connect: fixture.connect,
    installNewBuild,
    restart: () => run("restart", agent),
  };
}

describe("diagnostics without an attached owner", () => {
  let agent: string;
  let client: SyncRpc;
  beforeEach(async (context) => {
    const fixture = await createRpcFixture(context, source, async (root) => () => stopDaemon(root));
    agent = fixture.agent;
    await fs.rm(path.join(agent, "pi-sync.json"));
    client = await fixture.connect();
    await client.start();
  });
  test("real Pi daemon status never launches an owner for an unconfigured root", async () => {
    assert.equal((await inspectDaemonStatus(agent)).running, false);
    const from = client.records.length;
    await client.command("/sync daemon status", () => false);
    assert.equal((await inspectDaemonStatus(agent)).running, false);
    assert.ok(
      client.records.slice(from).some(({ message }) => String(message).includes("pi-sync-daemon: not running")),
    );
  });
});

function replacementNotices(client: SyncRpc, from: number) {
  return client.records
    .slice(from)
    .map(({ message }) => message)
    .filter((message) => typeof message === "string" && message.startsWith("Pi Sync daemon replaced."));
}

describe("after an ordered version update", () => {
  let staged: Awaited<ReturnType<typeof setup>>;
  let peer: SyncRpc;
  let peerFile: unknown;
  beforeEach(async (context) => {
    staged = await setup(context, true);
    peer = await staged.connect(path.join(staged.agent, "other-sessions"));
    await peer.start();
    await peer.call({ type: "new_session" });
    peerFile = (await peer.call({ type: "get_state" })).sessionFile;
    assert.equal(typeof peerFile, "string");
  });
  test("real Pi reload replaces the older daemon and reports the verified new build once", async () => {
    const { agent, client, original, requests, storage, installNewBuild } = staged;
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
    assert.deepEqual(storage.requests, []);
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
    const current = await findDaemon(agent);
    assert.ok(current);
    const peers = JSON.parse(await fs.readFile(path.join(current.paths.directory, "clients.json"), "utf8")) as {
      clients: { pid: number; sessionFile?: string }[];
    };
    assert.ok(peers.clients.some((facts) => facts.pid === peer.child.pid && facts.sessionFile === peerFile));
  });
});

describe("when an updated Pi opens a session during a pull review", () => {
  let staged: Awaited<ReturnType<typeof setup>>;
  let target: string;
  let local: string;
  let peer: SyncRpc;
  let pull: Promise<unknown>;
  let answer: (approved: boolean) => void;

  beforeEach(async (context) => {
    staged = await setup(context, true, true);
    const { agent, cwd, installNewBuild, connect } = staged;
    target = path.join(agent, "sessions", "fixture", "reviewed.jsonl");
    await fs.mkdir(path.dirname(target), { recursive: true });
    const timestamp = "2026-01-01T00:00:00.000Z";
    const session = (content: string) =>
      [
        { type: "session", version: 3, id: "reviewed", cwd },
        { type: "model_change", id: "model", parentId: null, provider: "sync-rpc-fixture", modelId: "fixture" },
        { type: "thinking_level_change", id: "level", parentId: "model", thinkingLevel: "off" },
        { type: "message", id: "user", parentId: "level", message: { role: "user", content, timestamp: 0 } },
      ]
        .map((entry) => `${JSON.stringify({ ...entry, timestamp })}\n`)
        .join("");
    const config = configFromSettings(
      validateSettingsDocument(JSON.parse(await fs.readFile(path.join(agent, "pi-sync.json"), "utf8"))),
    );
    assert.equal(config.backend.type, "webdav");
    const remote = {
      ...snapshot([
        { path: "AGENTS.md", content: Buffer.from("Test-owned parent instructions.\n") },
        { path: "sessions/fixture/reviewed.jsonl", content: Buffer.from(session("Remote transcript")) },
      ]),
      profile: config.snapshotIdentity,
      selection: { version: 1 as const, include: ["AGENTS.md", "sessions"] },
    };
    await new WebDavSyncBackend(config.backend).publishSnapshot(remote, { kind: "missing" });
    local = session("Live local transcript");
    await fs.writeFile(target, local);
    await fs.writeFile(path.join(agent, "AGENTS.md"), "Local edit before pull.\n");

    const owner = await findDaemon(agent);
    assert.ok(owner);
    const review = Promise.withResolvers<void>();
    const approval = Promise.withResolvers<boolean>();
    answer = approval.resolve;
    const actor = new DaemonConnection(
      owner.paths,
      owner.identity,
      { id: randomUUID(), generation: randomUUID(), pid: process.pid, cwd, mode: "rpc", hasUI: true, idle: true },
      {
        callback: async ({ kind, payload }) => {
          if (kind === "confirm" && (payload as { title: string }).title === "Pull pi settings and sessions?") {
            review.resolve();
            return approval.promise;
          }
          return true;
        },
      },
    );
    context.onTestFinished(async () => {
      approval.resolve(false);
      await actor.dispose();
    });
    await actor.attach(context.signal);
    await actor.run("daemon.handover", {}, context.signal);
    pull = actor.run("pull", { force: true, args: [] }, context.signal);
    await Promise.race([review.promise, pull.then(() => assert.fail("Expected pull review."))]);
    await installNewBuild();
    peer = await connect(undefined, context.signal, target);
    const state = await peer.start();
    assert.equal(await fs.realpath(String(state.sessionFile)), await fs.realpath(target));
  });

  test("the old owner completes the approved pull without replacing the live transcript", async () => {
    const { agent, original, requests } = staged;
    assert.deepEqual(await inspectDaemonStatus(agent), original);
    assert.ok(peer.records.some(({ message }) => String(message).includes("Daemon update deferred")));
    answer(true);
    assert.equal(await pull, "applied");
    assert.equal(await fs.readFile(target, "utf8"), local);
    assert.equal(await fs.readFile(path.join(agent, "AGENTS.md"), "utf8"), "Test-owned parent instructions.\n");
    assert.equal(requests.length, 0);
  });
});

describe("while a second client is reviewing daemon handover", () => {
  let staged: Awaited<ReturnType<typeof setup>>;
  let review: PromiseWithResolvers<boolean>;
  let pending: Promise<unknown>;
  beforeEach(async (context) => {
    staged = await setup(context, true);
    const owner = await findDaemon(staged.agent);
    assert.ok(owner);
    const entered = Promise.withResolvers<void>();
    review = Promise.withResolvers<boolean>();
    const peer = new DaemonConnection(
      owner.paths,
      owner.identity,
      {
        id: randomUUID(),
        generation: randomUUID(),
        pid: process.pid,
        cwd: owner.paths.root,
        mode: "rpc",
        hasUI: true,
        idle: true,
      },
      {
        callback: async ({ kind }) => {
          assert.equal(kind, "confirm");
          entered.resolve();
          return review.promise;
        },
      },
    );
    context.onTestFinished(async () => {
      review.resolve(false);
      await peer.dispose().catch(() => {});
    });
    await peer.attach(context.signal);
    pending = peer.run("daemon.handover", {});
    void pending.catch(() => {});
    await Promise.race([entered.promise, pending.then(() => assert.fail("expected review"))]);
    await staged.installNewBuild();
  });
  test("reload defers safely and status cannot restart a busy owner", async () => {
    const { agent, client, original, requests, storage } = staged;
    const from = client.records.length;
    try {
      await client.call({ type: "prompt", message: "/test-sync-reload" });
      assert.deepEqual(await inspectDaemonStatus(agent), original);
      assert.deepEqual(replacementNotices(client, from), []);
      await client.command("/sync daemon status", () => false);
      assert.ok(
        client.records
          .slice(from)
          .some(({ message }) =>
            String(message).includes("Upgrade blocked: Daemon update deferred while sync work is active"),
          ),
      );
    } finally {
      review.resolve(false);
    }
    await assert.rejects(pending, /handover was not approved/u);
    assert.equal(requests.length, 0);
    assert.deepEqual(storage.requests, []);
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
