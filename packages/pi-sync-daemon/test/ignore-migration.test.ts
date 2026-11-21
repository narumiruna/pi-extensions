import assert from "node:assert/strict";
import { constants } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test, vi } from "vitest";
import { configureEngineHost, type ReviewRequest } from "../src/engine/host.js";
import { readIgnoreMigrationOffer } from "../src/engine/ignore/ignore-migration-prompt.js";
import { migrateIgnoreSetup, newIgnoreFilename, switchIgnoreFile } from "../src/engine/ignore/ignore-settings.js";
import { DEFAULT_IGNORE_CREATION_RECORD, DEFAULT_IGNORE_RULES } from "../src/engine/ignore/ignore-source.js";
import { withConfigPublicationReadyHookForTest } from "../src/engine/settings/config-file.js";
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

test.each([
  { include: ["settings.json", " Sessions "], automatic: false },
  { scope: "agent-directory", sessions: true, automatic: false },
] satisfies PiSyncSettingsV3["syncSetups"][string]["sync"][])("migration keeps resolved session opt-in: %j", (sync) =>
  fixture(async (root, execution, proposal) => {
    const original = structuredClone(fixtureSettings);
    original.syncSetups.home.sync = sync;
    await fs.writeFile(path.join(root, "pi-sync.json"), JSON.stringify(original));
    await fs.writeFile(path.join(root, file), "");
    await fs.mkdir(path.join(root, "sessions"));
    await fs.writeFile(path.join(root, "sessions", "history.jsonl"), "{}\n");
    proposal(async ({ content }) => {
      assert.doesNotMatch(content, /sessions\/history\.jsonl/u);
      return true;
    });
    assert.equal(await migrateIgnoreSetup(execution, "home"), "saved");
    assert.equal((await readSettings(root)).syncSetups.home.sync.sessions, true);
  }),
);

test("reviewed migration requires canonical settings and does not promote the legacy filename", () =>
  fixture(async (root, execution, proposal) => {
    const canonical = path.join(root, "pi-sync.json");
    const legacy = path.join(root, "pi-sync.local.json");
    const original = `${JSON.stringify(fixtureSettings)}\n\n`;
    await fs.writeFile(canonical, original);
    await fs.rename(canonical, legacy);
    proposal(async () => true);
    await assert.rejects(migrateIgnoreSetup(execution, "home"), /requires pi-sync\.json/u);
    await assert.rejects(fs.lstat(canonical), { code: "ENOENT" });
    await assert.rejects(fs.lstat(path.join(root, file)), { code: "ENOENT" });
    assert.equal(await fs.readFile(legacy, "utf8"), original);
    await fs.rename(legacy, canonical);
    await fs.writeFile(path.join(root, file), "");
    assert.equal(await migrateIgnoreSetup(execution, "home"), "saved");
    assert.equal((await readSettings(root)).syncSetups.home.sync.pathPolicy, "ignore-file");
    const backup = (await fs.readdir(path.join(root, "pi-sync"))).find((name) =>
      name.startsWith("settings-before-ignore-"),
    );
    assert.ok(backup);
    assert.equal(await fs.readFile(path.join(root, "pi-sync", backup), "utf8"), original);
  }));

test("cancelled migration does not create the default or change settings", () =>
  fixture(async (root, execution, proposal) => {
    proposal(async () => false);
    assert.equal(await migrateIgnoreSetup(execution, "home"), "cancelled");
    await assert.rejects(fs.lstat(path.join(root, file)), { code: "ENOENT" });
    assert.deepEqual(await readSettings(root), fixtureSettings);
  }));

test.skipIf(process.platform !== "linux")(
  "cancelling confirmed migration after starter creation begins does not save settings",
  () =>
    fixture(async (root, execution, proposal) => {
      const controller = new AbortController();
      const reason = new Error("client cancelled");
      const open = fs.open;
      const spy = vi.spyOn(fs, "open").mockImplementation(async (...args) => {
        const handle = await open(...args);
        if (
          path.basename(String(args[0])) === file &&
          typeof args[1] === "number" &&
          (args[1] & constants.O_EXCL) !== 0
        )
          controller.abort(reason);
        return handle;
      });
      proposal(async () => true);
      const running = {
        ...execution,
        signal: controller.signal,
        committed: () => assert.fail("Cancelled migration committed"),
      };
      try {
        await assert.rejects(migrateIgnoreSetup(running, "home"), (error) => error === reason);
      } finally {
        spy.mockRestore();
      }
      assert.deepEqual(await readSettings(root), fixtureSettings);
      assert.equal(await fs.readFile(path.join(root, file), "utf8"), DEFAULT_IGNORE_RULES);
      await assert.rejects(fs.lstat(path.join(root, DEFAULT_IGNORE_CREATION_RECORD)), { code: "ENOENT" });
      assert.equal(await migrateIgnoreSetup(execution, "home"), "saved");
    }),
);

test("accepting a valid offer opens the review without saving when that review is cancelled", () =>
  fixture(async (root, execution, proposal) => {
    const facts = execution.facts();
    assert.ok(facts);
    const tui = { ...execution, facts: () => ({ ...facts, mode: "tui" as const }) };
    const offer = await readIgnoreMigrationOffer({ setup: "home" }, tui);
    assert.ok(offer);
    let reviewed = false;
    proposal(async ({ title }) => {
      assert.match(title, /Review migration/u);
      reviewed = true;
      return false;
    });
    assert.equal(await migrateIgnoreSetup(tui, "home", offer.token), "cancelled");
    assert.equal(reviewed, true);
    assert.deepEqual(await readIgnoreMigrationOffer({ setup: "home" }, tui), offer);
    await assert.rejects(fs.lstat(path.join(root, file)), { code: "ENOENT" });
    assert.deepEqual(await readSettings(root), fixtureSettings);
  }));

test("changing the active setup after an offer refuses migration before opening a review", () =>
  fixture(async (root, execution) => {
    const facts = execution.facts();
    assert.ok(facts);
    const tui = { ...execution, facts: () => ({ ...facts, mode: "tui" as const }) };
    const offer = await readIgnoreMigrationOffer({ setup: "home" }, tui);
    assert.ok(offer);
    const next = { ...fixtureSettings, activeSyncSetup: "other" };
    await fs.writeFile(path.join(root, "pi-sync.json"), JSON.stringify(next), { mode: 0o600 });
    await assert.rejects(migrateIgnoreSetup(tui, "home", offer.token), /offer is stale/u);
    assert.equal(headRead.mock.calls.length, 0);
    await assert.rejects(fs.lstat(path.join(root, file)), { code: "ENOENT" });
    assert.deepEqual(await readSettings(root), next);
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

test("migration rechecks local scope after the pre-scan head lookup and settings preparation", () =>
  fixture(async (root, execution, proposal) => {
    await fs.writeFile(path.join(root, file), "");
    let stagingFinished = false;
    headRead
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined)
      .mockImplementationOnce(async () => {
        await fs.writeFile(path.join(root, "late.md"), "not reviewed\n");
        return undefined;
      });
    proposal(async ({ content }) => {
      assert.doesNotMatch(content, /late\.md/u);
      return true;
    });
    await assert.rejects(
      withConfigPublicationReadyHookForTest(
        async () => {
          stagingFinished = (await fs.readdir(root)).some((name) => name.endsWith(".migrate"));
        },
        () => migrateIgnoreSetup(execution, "home"),
      ),
      /Reopen/u,
    );
    assert.equal(stagingFinished, true);
    assert.equal(headRead.mock.calls.length, 3);
    assert.deepEqual(await readSettings(root), fixtureSettings);
  }));

test.each(["new head", "changed revision", "removed head"] as const)(
  "migration refuses a %s published during the final local scope scan",
  (change) =>
    fixture(async (root, execution, proposal) => {
      await fs.writeFile(path.join(root, file), "");
      const head = { snapshotId: "same", snapshotRef: "same", revision: "before" };
      const before = change === "new head" ? undefined : head;
      const after = change === "removed head" ? undefined : { ...head, revision: "after" };
      remote.mockResolvedValue({ id: head.snapshotId, files: [] });
      let scanned = false;
      headRead.mockImplementation(async () => (scanned ? after : before));
      const open = fs.open;
      const opened = vi.spyOn(fs, "open").mockImplementation(async (...args) => {
        if (args[0] === path.join(root, "new-file.md") && headRead.mock.calls.length === 3) scanned = true;
        return open(...args);
      });
      proposal(async () => true);
      try {
        await assert.rejects(
          migrateIgnoreSetup({ ...execution, committed: () => assert.fail("Stale migration committed") }, "home"),
          /Reopen/u,
        );
      } finally {
        opened.mockRestore();
      }
      assert.ok(scanned);
      assert.equal(headRead.mock.calls.length, 4);
      assert.deepEqual(await readSettings(root), fixtureSettings);
    }),
);

test.each(["head revision", "rule identity", "settings bytes", "abort"] as const)(
  "migration refuses a late %s change before publishing",
  (change) =>
    fixture(async (root, execution, proposal) => {
      const rules = path.join(root, file);
      const config = path.join(root, "pi-sync.json");
      const original = JSON.stringify(fixtureSettings);
      const controller = new AbortController();
      let committed = false;
      const running = {
        ...execution,
        signal: controller.signal,
        committed: () => {
          committed = true;
        },
      };
      await fs.writeFile(rules, "");
      const head = { snapshotId: "same", snapshotRef: "same", revision: "before" };
      remote.mockResolvedValue({ id: head.snapshotId, files: [] });
      headRead
        .mockResolvedValueOnce(head)
        .mockResolvedValueOnce(head)
        .mockResolvedValueOnce(head)
        .mockImplementationOnce(async () => {
          if (change === "rule identity") {
            await fs.writeFile(path.join(root, "incoming"), "");
            await fs.rename(path.join(root, "incoming"), rules);
          }
          if (change === "settings bytes") await fs.appendFile(config, "\n");
          if (change === "abort") controller.abort(new Error("client cancelled"));
          return change === "head revision" ? { ...head, revision: "after" } : head;
        });
      proposal(async () => true);
      const error = change === "abort" ? /client cancelled/u : /Reopen|settings changed/u;
      await assert.rejects(migrateIgnoreSetup(running, "home"), error);
      assert.equal(committed, false);
      assert.equal(headRead.mock.calls.length, 4);
      assert.equal(await fs.readFile(config, "utf8"), change === "settings bytes" ? `${original}\n` : original);
      assert.equal(await fs.readFile(rules, "utf8"), "");
    }),
);

test.skipIf(process.platform !== "linux")("migration neutralizes only a starter created by this operation", () =>
  fixture(async (root, execution, proposal) => {
    proposal(async ({ content }) => {
      assert.doesNotMatch(content, /Local — leaves scope:\n {2}\.syncignore/u);
      return true;
    });
    assert.equal(await migrateIgnoreSetup(execution, "other"), "saved");
    assert.equal(await fs.readFile(path.join(root, file), "utf8"), DEFAULT_IGNORE_RULES);
    assert.equal((await readSettings(root)).syncSetups.other.sync.pathPolicy, "ignore-file");
  }),
);

test.skipIf(process.platform !== "linux")("a recovered starter that already existed remains in the prior scope", () =>
  fixture(async (root, execution, proposal) => {
    await fs.writeFile(
      path.join(root, DEFAULT_IGNORE_CREATION_RECORD),
      `pi-sync-ignore-creation-v1\n${DEFAULT_IGNORE_RULES}`,
      { mode: 0o600 },
    );
    await fs.writeFile(path.join(root, file), DEFAULT_IGNORE_RULES, { mode: 0o600 });
    proposal(async ({ content }) => {
      assert.match(content, /Local — leaves scope:\n {2}\.syncignore/u);
      return true;
    });
    assert.equal(await migrateIgnoreSetup(execution, "other"), "saved");
    assert.equal((await readSettings(root)).syncSetups.other.sync.pathPolicy, "ignore-file");
    await assert.rejects(fs.lstat(path.join(root, DEFAULT_IGNORE_CREATION_RECORD)), { code: "ENOENT" });
  }),
);

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

test.each(["current", "legacy edited", "canonical appeared"] as const)(
  "rule-file switch from the legacy settings filename: %s",
  (change) =>
    fixture(async (root, execution, proposal) => {
      const canonical = path.join(root, "pi-sync.json");
      const legacy = path.join(root, "pi-sync.local.json");
      const original = structuredClone(fixtureSettings);
      original.version = 8;
      original.syncSetups.home.sync = { scope: "agent-directory", pathPolicy: "ignore-file", automatic: false };
      const bytes = `${JSON.stringify(original)}\n`;
      await fs.rm(canonical);
      await fs.writeFile(legacy, bytes, { mode: 0o600 });
      await fs.writeFile(path.join(root, "other.ignore"), "");
      proposal(async () => {
        if (change === "legacy edited") await fs.appendFile(legacy, "\n");
        if (change === "canonical appeared") await fs.writeFile(canonical, bytes, { mode: 0o600 });
        return true;
      });
      await assert.rejects(
        switchIgnoreFile(execution, "home", "other.ignore", file),
        change === "current" ? /requires pi-sync\.json/u : /Reopen/u,
      );
      if (change === "canonical appeared") assert.equal(await fs.readFile(canonical, "utf8"), bytes);
      else await assert.rejects(fs.lstat(canonical), { code: "ENOENT" });
      assert.equal(await fs.readFile(legacy, "utf8"), change === "legacy edited" ? `${bytes}\n` : bytes);
    }),
);

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
