import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test, vi } from "vitest";
import { configureEngineHost, type ReviewRequest } from "../src/engine/host.js";
import { migrateIgnoreSetup, newIgnoreFilename, switchIgnoreFile } from "../src/engine/ignore/ignore-settings.js";
import { DEFAULT_IGNORE_RULES } from "../src/engine/ignore/ignore-source.js";
import type { PiSyncSettingsV3 } from "../src/engine/settings/settings-types.js";
import type { ClientFacts, Execution } from "../src/protocol.js";

const { headRead, remote, publish } = vi.hoisted(() => ({
  headRead: vi.fn(),
  remote: vi.fn(),
  publish: vi.fn(),
}));
vi.mock("../src/consent.js", () => ({ requireHandover: async () => {} }));
vi.mock("../src/engine/backends/backend-factory.js", () => ({
  createSyncBackend: async () => ({
    destination: "local fixture",
    identity: "fixture",
    readHead: headRead,
    readSnapshot: remote,
    publishSnapshot: publish,
    sameRevision: (a: string, b: string) => a === b,
  }),
}));

const fixtureSettings: PiSyncSettingsV3 = {
  version: 7,
  activeSyncSetup: "home",
  onSwitch: "switch-only",
  storageConnections: { test: { type: "git", remote: "https://example.invalid/group/repo.git" } },
  syncSetups: {
    home: {
      storage: { connection: "test", branch: "home", path: "./" },
      sync: { include: ["settings.json"], automatic: false },
      extra: "keep",
    },
    other: {
      storage: { connection: "test", branch: "other", path: "./" },
      sync: { scope: "agent-directory", exclude: ["tmp"], automatic: false },
    },
  },
};
const file = ".syncignore";

async function fixture(
  run: (
    root: string,
    execution: Execution,
    proposal: (review: (request: ReviewRequest) => Promise<boolean>) => void,
  ) => Promise<void>,
) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "pi-sync-ignore-migration-")));
  try {
    headRead.mockReset();
    remote.mockReset();
    publish.mockReset();
    await fs.writeFile(path.join(root, "pi-sync.json"), JSON.stringify(fixtureSettings), { mode: 0o600 });
    await fs.writeFile(path.join(root, "settings.json"), "{}\n");
    await fs.writeFile(path.join(root, "new-file.md"), "line\n");
    let review: (request: ReviewRequest) => Promise<boolean> = async () => assert.fail("Unexpected review");
    configureEngineHost({
      root: () => root,
      mutate: async (_target, action) => action(),
      review: (_ctx, request) => review(request),
    });
    const facts: ClientFacts = {
      id: "fixture",
      generation: "fixture",
      pid: process.pid,
      cwd: root,
      mode: "rpc",
      hasUI: true,
      idle: true,
    };
    const execution: Execution = {
      root,
      clientId: facts.id,
      signal: new AbortController().signal,
      facts: () => facts,
      participants: () => [facts],
      liveClients: () => [facts],
      withParticipants: (action) => action([facts]),
      validate() {},
      request: async () => assert.fail("Unexpected callback"),
      emit() {},
      committed() {},
    };
    await run(root, execution, (next) => {
      review = next;
    });
    assert.equal(publish.mock.calls.length, 0);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

async function readSettings(root: string): Promise<PiSyncSettingsV3> {
  return JSON.parse(await fs.readFile(path.join(root, "pi-sync.json"), "utf8"));
}

test.skipIf(process.platform !== "linux")(
  "confirmed migration initializes defaults and keeps other setups and legacy bytes",
  () =>
    fixture(async (root, execution, proposal) => {
      proposal(async ({ content }) => {
        assert.match(content, /Local — enters scope:\n {2}new-file.md/u);
        assert.match(content, /Remote: no published snapshot/u);
        await assert.rejects(fs.lstat(path.join(root, file)), { code: "ENOENT" });
        return true;
      });
      assert.equal(await migrateIgnoreSetup(execution, "home"), "saved");
      assert.equal(await fs.readFile(path.join(root, file), "utf8"), DEFAULT_IGNORE_RULES);
      const saved = await readSettings(root);
      assert.equal(saved.version, 8);
      assert.deepEqual(saved.syncSetups.other, fixtureSettings.syncSetups.other);
      assert.deepEqual(saved.syncSetups.home.sync, {
        scope: "agent-directory",
        pathPolicy: "ignore-file",
        sessions: false,
        automatic: false,
      });
      assert.equal(saved.syncSetups.home.extra, "keep");
      const backup = (await fs.readdir(path.join(root, "pi-sync"))).find((name) =>
        name.startsWith("settings-before-ignore-"),
      );
      assert.ok(backup);
      assert.equal(await fs.readFile(path.join(root, "pi-sync", backup), "utf8"), JSON.stringify(fixtureSettings));
    }),
);

test("cancelled migration does not create the default or change settings", () =>
  fixture(async (root, execution, proposal) => {
    proposal(async () => false);
    assert.equal(await migrateIgnoreSetup(execution, "home"), "cancelled");
    await assert.rejects(fs.lstat(path.join(root, file)), { code: "ENOENT" });
    assert.deepEqual(await readSettings(root), fixtureSettings);
  }));

test("migration refuses scope or remote changes while the review is open", () =>
  fixture(async (root, execution, proposal) => {
    proposal(async () => {
      await fs.writeFile(path.join(root, "another.md"), "new\n");
      return true;
    });
    await assert.rejects(migrateIgnoreSetup(execution, "home"), /Reopen/u);
    proposal(async () => {
      headRead.mockResolvedValue({ snapshotId: "foreign", revision: "changed" });
      return true;
    });
    await assert.rejects(migrateIgnoreSetup(execution, "home"), /Reopen/u);
    await assert.rejects(fs.lstat(path.join(root, file)), { code: "ENOENT" });
    assert.deepEqual(await readSettings(root), fixtureSettings);
  }));

test("ordinary settings proposals cannot migrate or silently switch an existing rule file", () => {
  const next = structuredClone(fixtureSettings);
  next.version = 8;
  next.syncSetups.home.sync = { scope: "agent-directory", pathPolicy: "ignore-file", automatic: false };
  assert.throws(() => newIgnoreFilename(fixtureSettings, next), /reviewed/u);
  const switched = structuredClone(next);
  switched.syncSetups.home.sync.ignoreFile = "another.ignore";
  assert.throws(() => newIgnoreFilename(next, switched), /reviewed/u);
  assert.equal(newIgnoreFilename(undefined, next), file);
});

test("the pointer editor does not recreate an absent default", () =>
  fixture(async (root, execution) => {
    const next = structuredClone(fixtureSettings);
    next.version = 8;
    next.syncSetups.home.sync = {
      scope: "agent-directory",
      pathPolicy: "ignore-file",
      ignoreFile: "per-setup.ignore",
      automatic: false,
    };
    await fs.writeFile(path.join(root, "pi-sync.json"), JSON.stringify(next));
    await assert.rejects(switchIgnoreFile(execution, "home", file, "per-setup.ignore"), /does not exist/u);
    await assert.rejects(fs.lstat(path.join(root, file)), { code: "ENOENT" });
    assert.deepEqual(await readSettings(root), next);
  }));
