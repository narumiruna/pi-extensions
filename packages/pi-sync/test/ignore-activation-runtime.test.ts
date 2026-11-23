import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { appendFileSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { DaemonConnection, type DocumentView, documentFingerprint, findDaemon } from "@narumitw/pi-sync-daemon";
import { beforeEach, test } from "vitest";
import { WebDavSyncBackend } from "../src/backends/webdav/webdav-backend.js";
import { configFromSettings, syncCheckConfigFingerprint } from "../src/settings/config.js";
import type { AnySyncConfig } from "../src/settings/settings-types.js";
import { validateSettingsDocument } from "../src/settings/settings-validation.js";
import { createRpcFixture, type RpcFixture } from "./daemon-rpc-fixture.js";
import type { SyncRpc } from "./daemon-rpc-helpers.js";

let first: RpcFixture;
let second: RpcFixture;
let writer: SyncRpc;
let reader: SyncRpc;
let remote: WebDavSyncBackend;
const rules = "/sessions/\n/models.json\n/settings.json\n/private.txt\n";
const bytes = "selected loopback text\n";
const localFile = (fixture: RpcFixture, name: string) => path.join(fixture.agent, name);

async function attach(fixture: RpcFixture, automatic = false) {
  await fixture.startDaemon();
  const daemon = await findDaemon(fixture.agent);
  assert.ok(daemon);
  return new DaemonConnection(
    daemon.paths,
    daemon.identity,
    {
      id: randomUUID(),
      generation: randomUUID(),
      pid: process.pid,
      cwd: fixture.cwd,
      mode: "rpc",
      hasUI: true,
      idle: automatic,
      ready: automatic,
    },
    {
      callback: async ({ kind, payload }) => {
        assert.ok(kind === "confirm" || kind === "merge-review");
        if (kind === "merge-review")
          assert.match((payload as { content: string }).content, /(?:Rules|Ignore file): .*\.(?:syncignore|rules)/u);
        return true;
      },
    },
  ).attach();
}

async function configure(fixture: RpcFixture, original: Record<string, unknown>) {
  const client = await attach(fixture);
  try {
    assert.deepEqual(await client.run("ignore.capabilities", {}), { available: true, portableRules: 1 });
    const document = (await client.run("settings.read", {})) as DocumentView | null;
    if (document) {
      assert.equal(await client.run("ignore.migrate", { setup: "home" }), "saved");
      return;
    }
    const before = validateSettingsDocument(original);
    const setup = before.syncSetups.home;
    assert.ok(setup);
    const next = {
      ...before,
      version: 8,
      activeSyncSetup: "reviewed",
      syncSetups: {
        reviewed: {
          ...setup,
          sync: { scope: "agent-directory", pathPolicy: "ignore-file", automatic: false },
        },
      },
    };
    await client.run("settings.cas", { expected: documentFingerprint(undefined), next });
    const created = (await client.run("settings.read", {})) as DocumentView;
    await client.run("settings.cas", {
      expected: documentFingerprint(created),
      next: {
        ...next,
        syncSetups: {
          ...next.syncSetups,
          alternate: {
            ...setup,
            storage: { ...setup.storage, path: "alternate" },
            sync: {
              scope: "agent-directory",
              pathPolicy: "ignore-file",
              ignoreFile: "alternate.rules",
              automatic: false,
            },
          },
        },
      },
    });
  } finally {
    await client.dispose();
  }
}

beforeEach(async (context) => {
  const extension = path.resolve("packages/pi-sync");
  first = await createRpcFixture(context, extension);
  second = await createRpcFixture(context, extension);
  const settings = validateSettingsDocument(JSON.parse(await fs.readFile(localFile(first, "pi-sync.json"), "utf8")));
  const configured = configFromSettings(settings);
  assert.equal(configured.backend.type, "webdav");
  remote = new WebDavSyncBackend(configured.backend);
  await Promise.all([
    fs.rm(localFile(first, "pi-sync.json")),
    fs.writeFile(localFile(second, "pi-sync.json"), JSON.stringify(settings), { mode: 0o600 }),
    fs.writeFile(localFile(first, ".syncignore"), rules),
    fs.writeFile(localFile(second, ".syncignore"), rules),
    fs.writeFile(localFile(first, "selected.txt"), bytes),
    fs.writeFile(localFile(first, "private.txt"), "sender-only\n"),
    fs.writeFile(localFile(first, "alternate.rules"), "/skills/\n"),
    fs.writeFile(localFile(first, "trust.json"), "{}\n"),
    fs.writeFile(localFile(second, "private.txt"), "receiver-only\n"),
  ]);
  await configure(first, settings);
  const legacy = await attach(second);
  try {
    await legacy.run("daemon.handover", {});
  } finally {
    await legacy.dispose();
  }
  assert.deepEqual(first.storage.requests, []);
  [writer, reader] = await Promise.all([first.connect(), second.connect()]);
  await Promise.all([writer.start(), reader.start()]);
});

test("the packaged daemon does not publish on cancellation or rule edits during review", async () => {
  let cancelled = false;
  await writer.command("/sync push", () => {
    cancelled = true;
    return false;
  });
  assert.equal(cancelled, true);
  assert.equal(await remote.readHead(), undefined);

  let changed = false;
  await writer.command("/sync push", () => {
    changed = true;
    appendFileSync(localFile(first, ".syncignore"), "/selected.txt\n");
    return true;
  });
  assert.equal(changed, true);
  assert.equal(await remote.readHead(), undefined);
});

test("packaged Pi clients exchange v7 rules and preserve excluded local files", async () => {
  await writer.command("/sync push --yes", () => true);
  const head = await remote.readHead();
  assert.ok(head);
  const published = await remote.readSnapshot(head.snapshotRef);
  assert.equal(published.version, 7);
  assert.deepEqual(published.files.map(({ path }) => path).sort(), ["AGENTS.md", "selected.txt"]);
  assert.equal(published.selection?.version, 4);
  assert.deepEqual(Object.keys(published.selection ?? {}).sort(), ["fingerprint", "scope", "sessions", "version"]);
  assert.deepEqual(published.ignoreRules, { filename: ".syncignore", text: rules });
  assert.doesNotMatch(JSON.stringify(head), /private\.txt|\.syncignore|sourceDigest/u);
  assert.doesNotMatch(JSON.stringify(published), /sourceDigest|alternate\.rules|trust\.json/u);

  await reader.command("/sync pull --force --yes", () => true);
  await assert.rejects(fs.lstat(localFile(second, "selected.txt")), { code: "ENOENT" });
  assert.equal((await remote.readHead())?.snapshotId, head.snapshotId);
  const before = JSON.parse(await fs.readFile(localFile(second, "pi-sync.json"), "utf8"));
  await configure(second, before);
  await reader.command("/sync pull --force --yes", () => false);
  assert.equal(await fs.readFile(localFile(second, "selected.txt"), "utf8"), bytes);
  assert.equal(await fs.readFile(localFile(second, "private.txt"), "utf8"), "receiver-only\n");
  assert.equal(await fs.readFile(localFile(second, ".syncignore"), "utf8"), rules);
  assert.equal((await remote.readHead())?.snapshotId, head.snapshotId);
  assert.deepEqual([...first.requests, ...second.requests], []);
});

test("the packaged daemon applies an approved startup policy but refuses a stale ticket", async () => {
  await writer.command("/sync push --yes", () => true);
  await writer.close();
  const head = await remote.readHead();
  assert.ok(head);
  const client = await attach(first, true);
  try {
    const document = (await client.run("settings.read", {})) as DocumentView;
    const next = validateSettingsDocument(document.parsed);
    next.syncSetups.reviewed.sync.automaticTransfer = true;
    await client.run("settings.cas", { expected: documentFingerprint(document), next });
    const policy = (await client.run("daemon.policy", {})) as { fingerprint: string; automatic: boolean };
    assert.equal(policy.automatic, false);
    const ticket = async () => {
      const { config } = (await client.run("initialize", {})) as { config: AnySyncConfig };
      return { args: [], automaticFingerprint: syncCheckConfigFingerprint(config) };
    };
    await assert.rejects(client.run("startup-transfer", await ticket()), /separate approval/u);
    assert.equal(await client.run("daemon.authorize-connected", { fingerprint: policy.fingerprint }), true);
    await fs.writeFile(localFile(first, "selected.txt"), "changed by approved startup\n");
    const accepted = await ticket();
    await client.run("startup-transfer", accepted);
    const published = await remote.readHead();
    assert.ok(published && published.snapshotId !== head.snapshotId);
    const snapshot = await remote.readSnapshot(published.snapshotRef);
    assert.equal(
      Buffer.from(snapshot.files.find(({ path }) => path === "selected.txt")?.contentBase64 ?? "", "base64").toString(),
      "changed by approved startup\n",
    );
    await fs.appendFile(localFile(first, ".syncignore"), "# changed\n");
    await assert.rejects(client.run("startup-transfer", accepted), /Settings changed/u);
    assert.equal((await remote.readHead())?.snapshotId, published.snapshotId);
  } finally {
    await client.dispose();
  }
});
