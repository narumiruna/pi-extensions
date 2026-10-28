import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { test, vi } from "vitest";
import { SyncBackendConflictError } from "../src/backends/sync-backend.js";
import { loadConfig } from "../src/settings/config.js";
import { localConfigPath } from "../src/settings/config-file.js";
import { createSnapshot } from "../src/snapshot/snapshot.js";
import { stageMergeBaseline } from "../src/state/merge-baseline-store.js";
import { withStateDirectoryAccess } from "../src/state/state-directory.js";
import { lockPath, readStateForConfig } from "../src/state/sync-state-store.js";
import { withAgentSyncLock } from "../src/sync/agent-sync.js";
import { readMergeJournal } from "../src/sync/merge-journal.js";
import { push, syncBoth } from "../src/sync/sync-mutations.js";
import { agentContext, selectRemote } from "./agent-test-helpers.js";
import { v3S3Settings, withTempHome } from "./helpers.js";
import { MemorySyncBackend } from "./memory-sync-backend.js";
import { createMergeFixture, mergeOptions } from "./merged-sync-fixture.js";

async function enabled() {
  const settings = JSON.parse(await fs.readFile(localConfigPath(), "utf8"));
  settings.syncSetups.home.sync.agentMode = true;
  await fs.writeFile(localConfigPath(), JSON.stringify(settings));
  const config = await loadConfig();
  await stageMergeBaseline(
    config,
    await createSnapshot(config.snapshotIdentity, { include: config.include }),
    await readStateForConfig(config),
  );
}

for (const auto of [false, true])
  test(`agent resolves and commits without review (startup=${auto})`, async () =>
    withTempHome(async (agentDir) => {
      const fixture = await createMergeFixture(agentDir);
      await enabled();
      await fs.writeFile(path.join(agentDir, "AGENTS.md"), "local instructions\n");
      await fixture.remoteEdit("AGENTS.md", "remote instructions\n");
      const mock = agentContext(async (units, context) => {
        await assert.rejects(fs.stat(lockPath()), /ENOENT/, "inference must not hold the operation lock");
        assert.deepEqual(context.tools ?? [], []);
        assert.equal(context.messages.filter((message) => message.role === "user").length, 1);
        assert.doesNotMatch(JSON.stringify(context), /secret-key|access-key|original.*theme/);
        return selectRemote(units);
      });
      const options = { ...mergeOptions, yes: false, auto };
      const result = await withStateDirectoryAccess(() =>
        withAgentSyncLock(mock.ctx, options, (current) => syncBoth(mock.ctx, current, () => fixture.backend)),
      );
      assert.equal(result, "applied");
      assert.equal(mock.requests.length, 1);
      assert.equal(await fs.readFile(path.join(agentDir, "AGENTS.md"), "utf8"), "remote instructions\n");
      assert.equal(await readMergeJournal(await loadConfig()), undefined);
      assert.equal(mock.statuses.get("sync"), undefined);
      const claimDir = path.join(agentDir, "pi-sync", "agent-resolver");
      await assert.rejects(fs.stat(path.join(claimDir, "claim.json")), /ENOENT/);
      const records = await fs.readdir(claimDir);
      assert.equal(records.length, 1);
      assert.equal((await fs.stat(path.join(claimDir, records[0] ?? ""))).mode & 0o077, 0);
    }));

for (const [localVersion, remoteVersion] of [
  ["2.0.0", "3.0.0"],
  ["1.0.0", "2.0.0"],
  ["2.0.0", "1.0.0"],
] as const)
  test(`agent sync keeps higher package version without inference: ${localVersion}/${remoteVersion}`, async () =>
    withTempHome(async (agentDir) => {
      const f = await createMergeFixture(agentDir);
      const settingsPath = path.join(agentDir, "settings.json");
      const content = (version: string) => JSON.stringify({ packages: [`npm:example@${version}`] });
      await fs.writeFile(settingsPath, content("2.0.0"));
      await push(f.ctx, mergeOptions, undefined, () => f.backend);
      await enabled();
      await fs.writeFile(settingsPath, content(localVersion));
      await f.remoteEdit("settings.json", content(remoteVersion));
      const mock = agentContext(() => {
        throw new Error("no inference expected");
      });
      await withStateDirectoryAccess(() =>
        withAgentSyncLock(mock.ctx, mergeOptions, (current) => syncBoth(mock.ctx, current, () => f.backend)),
      );
      assert.equal(mock.requests.length, 0);
      const expected = content(remoteVersion === "3.0.0" ? "3.0.0" : "2.0.0");
      assert.deepEqual(JSON.parse(await fs.readFile(settingsPath, "utf8")), JSON.parse(expected));
      const head = await f.backend.readHead();
      assert.ok(head);
      const published = await f.backend.readSnapshot(head.snapshotRef);
      const file = published.files.find((file) => file.path === "settings.json");
      assert.ok(file);
      assert.deepEqual(JSON.parse(Buffer.from(file.contentBase64, "base64").toString()), JSON.parse(expected));
    }));

for (const [name, base, local, remote, expected, requests] of [
  [
    "remote-only reorder",
    ["npm:a@1.0.0", "npm:b@1.0.0"],
    ["npm:a@1.0.0", "npm:b@1.0.0"],
    ["npm:b@1.0.0", "npm:a@1.0.0"],
    ["npm:b@1.0.0", "npm:a@1.0.0"],
    0,
  ],
  [
    "remote reorder with local upgrade",
    ["npm:a@1.0.0", "npm:b@1.0.0"],
    ["npm:a@2.0.0", "npm:b@1.0.0"],
    ["npm:b@1.0.0", "npm:a@1.0.0"],
    ["npm:b@1.0.0", "npm:a@2.0.0"],
    0,
  ],
  ["remote-only build metadata", ["npm:x@1.0.0"], ["npm:x@1.0.0"], ["npm:x@1.0.0+remote"], ["npm:x@1.0.0+remote"], 0],
  [
    "conflicting build metadata",
    ["npm:x@1.0.0"],
    ["npm:x@1.0.0+local"],
    ["npm:x@1.0.0+remote"],
    ["npm:x@1.0.0+remote"],
    1,
  ],
  [
    "Git ref conflict",
    ["git:github.com/example/repo@base"],
    ["git:github.com/example/repo@local"],
    ["https://github.com/example/repo.git@remote"],
    ["https://github.com/example/repo.git@remote"],
    1,
  ],
] satisfies [string, string[], string[], string[], string[], number][]) {
  test(`agent publishes safe package selection: ${name}`, async () =>
    withTempHome(async (agentDir) => {
      const f = await createMergeFixture(agentDir);
      const settingsPath = path.join(agentDir, "settings.json");
      const content = (packages: string[]) => JSON.stringify({ packages });
      await fs.writeFile(settingsPath, content(base));
      await push(f.ctx, mergeOptions, undefined, () => f.backend);
      await enabled();
      await fs.writeFile(settingsPath, content(local));
      await f.remoteEdit("settings.json", content(remote));
      const mock = agentContext(selectRemote);
      await withStateDirectoryAccess(() =>
        withAgentSyncLock(mock.ctx, mergeOptions, (current) => syncBoth(mock.ctx, current, () => f.backend)),
      );
      assert.equal(mock.requests.length, requests);
      assert.deepEqual(JSON.parse(await fs.readFile(settingsPath, "utf8")), { packages: expected });
      const head = await f.backend.readHead();
      assert.ok(head);
      const published = await f.backend.readSnapshot(head.snapshotRef);
      const file = published.files.find((file) => file.path === "settings.json");
      assert.ok(file);
      assert.deepEqual(JSON.parse(Buffer.from(file.contentBase64, "base64").toString()), { packages: expected });
    }));
}

for (const [name, base, changed, expected] of [
  ["root order", '{"packages":["npm:x@2.0.0"],"number":1}', '{"number":1,"packages":["npm:x@2.0.0"]}', undefined],
  [
    "whitespace and line endings",
    '{"packages":["npm:x@2.0.0"]}',
    '{\r\n  "packages" : [ "npm:x@2.0.0" ]\r\n}\r\n',
    undefined,
  ],
  ["numeric spelling without packages", '{"number":1}', '{"number":1.00e0}', undefined],
  ["escaped key and source", '{"packages":["npm:x@2.0.0"]}', '{"\\u0070ackages":["\\u006epm:x@2.0.0"]}', undefined],
  [
    "non-exact package versions",
    '{"packages":["npm:x@latest"],"number":1}',
    '{"number":1.0,"packages" : [ "npm:x@latest" ]}',
    undefined,
  ],
  [
    "package upgrade with other spelling",
    '{"packages":["npm:x@2.0.0"],"number":1}',
    '{"number":1.00e0,"packages" : [ "npm:x@3.0.0" ]}',
    undefined,
  ],
  [
    "package downgrade with other spelling",
    '{"packages":["npm:x@2.0.0"],"number":1}',
    '{"number":1.00e0,"packages" : ["npm:x@1.0.0"]}',
    '{"number":1.00e0,"packages" : ["npm:x@2.0.0"]}',
  ],
] as const) {
  for (const side of ["local", "remote"] as const) {
    test(`accepted ${side} settings keep document bytes: ${name}`, async () =>
      withTempHome(async (agentDir) => {
        const f = await createMergeFixture(agentDir);
        const settingsPath = path.join(agentDir, "settings.json");
        await fs.writeFile(settingsPath, base);
        await push(f.ctx, mergeOptions, undefined, () => f.backend);
        await enabled();
        await fs.writeFile(settingsPath, side === "local" ? changed : base);
        await f.remoteEdit("settings.json", side === "remote" ? changed : base);
        const mock = agentContext(selectRemote);
        await withStateDirectoryAccess(() =>
          withAgentSyncLock(mock.ctx, mergeOptions, (current) => syncBoth(mock.ctx, current, () => f.backend)),
        );
        assert.equal(mock.requests.length, 0);
        assert.equal(await fs.readFile(settingsPath, "utf8"), expected ?? changed);
        const head = await f.backend.readHead();
        assert.ok(head);
        const published = await f.backend.readSnapshot(head.snapshotRef);
        const file = published.files.find((file) => file.path === "settings.json");
        assert.ok(file);
        assert.equal(Buffer.from(file.contentBase64, "base64").toString(), expected ?? changed);
      }));
  }
}

test("unrelated sync preserves unchanged package bytes locally and remotely", async () =>
  withTempHome(async (agentDir) => {
    const f = await createMergeFixture(agentDir);
    const settingsPath = path.join(agentDir, "settings.json");
    const original = '{\n  "packages" : [\n    "npm:x@1.0.0"\n  ]\n}\n';
    await fs.writeFile(settingsPath, original);
    await push(f.ctx, mergeOptions, undefined, () => f.backend);
    await enabled();
    await f.remoteEdit("AGENTS.md", "remote instructions\n");
    const mock = agentContext(selectRemote);
    await withStateDirectoryAccess(() =>
      withAgentSyncLock(mock.ctx, mergeOptions, (current) => syncBoth(mock.ctx, current, () => f.backend)),
    );
    assert.equal(mock.requests.length, 0);
    assert.equal(await fs.readFile(settingsPath, "utf8"), original);
    const head = await f.backend.readHead();
    assert.ok(head);
    const published = await f.backend.readSnapshot(head.snapshotRef);
    const file = published.files.find((file) => file.path === "settings.json");
    assert.ok(file);
    assert.equal(Buffer.from(file.contentBase64, "base64").toString(), original);
  }));

for (const mutation of ["local", "remote", "settings", "model"] as const)
  test(`reject stale candidate after ${mutation} changes during inference`, async () =>
    withTempHome(async (agentDir) => {
      const f = await createMergeFixture(agentDir);
      await enabled();
      await fs.writeFile(path.join(agentDir, "AGENTS.md"), "local\n");
      await f.remoteEdit("AGENTS.md", "remote\n");
      const state = await readStateForConfig(await loadConfig());
      const mock = agentContext(async (units) => {
        if (mutation === "local") await fs.writeFile(path.join(agentDir, "AGENTS.md"), "new user edits\n");
        if (mutation === "remote") await f.remoteEdit("AGENTS.md", "new remote\n");
        if (mutation === "settings") {
          const settings = JSON.parse(await fs.readFile(localConfigPath(), "utf8"));
          settings.syncSetups.home.sync.agentMode = false;
          await fs.writeFile(localConfigPath(), JSON.stringify(settings));
        }
        if (mutation === "model") {
          assert.ok(mock.ctx.model);
          mock.ctx.model = { ...mock.ctx.model, id: "changed" };
        }
        return selectRemote(units);
      });
      const publish = vi.spyOn(f.backend, "publishSnapshot");
      await assert.rejects(
        withStateDirectoryAccess(() =>
          withAgentSyncLock(mock.ctx, mergeOptions, (current) => syncBoth(mock.ctx, current, () => f.backend)),
        ),
      );
      assert.equal(publish.mock.calls.length, mutation === "remote" ? 1 : 0);
      assert.deepEqual(await readStateForConfig(await loadConfig()), state);
      assert.equal(
        await fs.readFile(path.join(agentDir, "AGENTS.md"), "utf8"),
        mutation === "local" ? "new user edits\n" : "local\n",
      );
      assert.equal(await readMergeJournal(await loadConfig()), undefined);
    }));

for (const failure of ["refuse", "malformed", "secret", "unsupported", "delete"] as const)
  test(`agent fails closed for ${failure}`, async () =>
    withTempHome(async (agentDir) => {
      const f = await createMergeFixture(agentDir);
      await enabled();
      await fs.writeFile(
        path.join(agentDir, "AGENTS.md"),
        failure === "secret" ? "sk-ant-abcdefghijklmnopqrstuvwxyz" : "local\n",
      );
      await f.remoteEdit("AGENTS.md", failure === "delete" ? undefined : "remote\n");
      if (failure === "unsupported") {
        await fs.writeFile(path.join(agentDir, "settings.json"), '{"bad":9007199254740993}');
        await f.remoteEdit("settings.json", '{"bad":2}');
      }
      const mock = agentContext((units) =>
        failure === "malformed"
          ? '{"version":1,"results":[]}'
          : JSON.stringify({ version: 1, results: units.map((unit) => ({ id: unit.id, refuse: true })) }),
      );
      const head = await f.backend.readHead();
      await assert.rejects(
        withStateDirectoryAccess(() =>
          withAgentSyncLock(mock.ctx, mergeOptions, (current) => syncBoth(mock.ctx, current, () => f.backend)),
        ),
      );
      assert.deepEqual(await f.backend.readHead(), head);
      assert.equal(mock.requests.length, ["secret", "delete", "unsupported"].includes(failure) ? 0 : 1);
    }));

test("off preserves reviewed behavior and does not call model", async () =>
  withTempHome(async (agentDir) => {
    const f = await createMergeFixture(agentDir);
    await fs.writeFile(path.join(agentDir, "AGENTS.md"), "local\n");
    await f.remoteEdit("AGENTS.md", "remote\n");
    const mock = agentContext(selectRemote);
    await assert.rejects(
      withStateDirectoryAccess(() =>
        withAgentSyncLock(mock.ctx, mergeOptions, (current) => syncBoth(mock.ctx, current, () => f.backend)),
      ),
      /review/,
    );
    assert.equal(mock.requests.length, 0);
    await assert.rejects(fs.stat(path.join(agentDir, "pi-sync/agent-resolver")), /ENOENT/);
  }));

test("uncertain committed publication reconciles without another model call or publication", async () =>
  withTempHome(async (agentDir) => {
    const f = await createMergeFixture(agentDir);
    await enabled();
    await fs.writeFile(path.join(agentDir, "AGENTS.md"), "local\n");
    await f.remoteEdit("AGENTS.md", "remote\n");
    const mock = agentContext((units) =>
      JSON.stringify({ version: 1, results: units.map((unit) => ({ id: unit.id, content: "combined\n" })) }),
    );
    f.backend.failNextPublicationAfterCommit = true;
    const run = () =>
      withStateDirectoryAccess(() =>
        withAgentSyncLock(mock.ctx, mergeOptions, (current) => syncBoth(mock.ctx, current, () => f.backend)),
      );
    await assert.rejects(run());
    assert.ok(await readMergeJournal(await loadConfig()));
    assert.equal(await fs.readFile(path.join(agentDir, "AGENTS.md"), "utf8"), "local\n");
    const head = await f.backend.readHead();
    const publication = vi.spyOn(f.backend, "publishSnapshot");
    assert.equal(await run(), "applied");
    assert.equal(publication.mock.calls.length, 0);
    assert.deepEqual(await f.backend.readHead(), head);
    assert.equal(mock.requests.length, 1);
    assert.equal(await fs.readFile(path.join(agentDir, "AGENTS.md"), "utf8"), "combined\n");
    assert.equal(await readMergeJournal(await loadConfig()), undefined);
  }));

test("competing remote commits bound inference to two candidates without force overwrite", async () =>
  withTempHome(async (agentDir) => {
    const f = await createMergeFixture(agentDir);
    await enabled();
    await fs.writeFile(path.join(agentDir, "AGENTS.md"), "local\n");
    await f.remoteEdit("AGENTS.md", "remote\n");
    const original = f.backend.publishSnapshot.bind(f.backend);
    let competitions = 0;
    vi.spyOn(f.backend, "publishSnapshot").mockImplementation(async (snapshot, expected, options) => {
      if (!options) return original(snapshot, expected);
      await f.remoteEdit("AGENTS.md", `competitor ${++competitions}\n`);
      throw new SyncBackendConflictError("competing device");
    });
    const mock = agentContext((units) =>
      JSON.stringify({ version: 1, results: units.map((unit) => ({ id: unit.id, content: "combined\n" })) }),
    );
    await assert.rejects(
      withStateDirectoryAccess(() =>
        withAgentSyncLock(mock.ctx, mergeOptions, (current) => syncBoth(mock.ctx, current, () => f.backend)),
      ),
      /changed repeatedly/,
    );
    assert.equal(mock.requests.length, 2);
    assert.equal(competitions, 2);
    assert.equal(await fs.readFile(path.join(agentDir, "AGENTS.md"), "utf8"), "local\n");
    assert.equal(await readMergeJournal(await loadConfig()), undefined);
  }));

test("portable settings disclose only conflicting units and retain newer local-only values", async () =>
  withTempHome(async (agentDir) => {
    await fs.mkdir(agentDir, { recursive: true });
    const settings = { ...v3S3Settings(), version: 4 };
    Object.assign(settings.syncSetups.home.sync, { agentMode: true, localFields: ["shellPath"] });
    await fs.writeFile(localConfigPath(), JSON.stringify(settings));
    await fs.writeFile(path.join(agentDir, "settings.json"), '{"theme":"base","shellPath":"/private/base"}');
    const backend = new MemorySyncBackend();
    const mock = agentContext((units, context) => {
      assert.doesNotMatch(JSON.stringify(context), /shellPath|private/);
      return selectRemote(units);
    });
    await push(mock.ctx, mergeOptions, undefined, () => backend);
    const head = await backend.readHead();
    assert.ok(head);
    const remote = await backend.readSnapshot(head.snapshotRef);
    const { regenerateSnapshotIdentity } = await import("../src/snapshot/snapshot.js");
    const { snapshotFile } = await import("../src/sync/content-conflicts.js");
    await backend.publishSnapshot(
      regenerateSnapshotIdentity({
        ...remote,
        files: [snapshotFile("settings.json", Buffer.from('{"theme":"remote"}'))],
      }),
      { kind: "revision", revision: head.revision },
    );
    await fs.writeFile(path.join(agentDir, "settings.json"), '{"theme":"local","shellPath":"/private/newer"}');
    await withStateDirectoryAccess(() =>
      withAgentSyncLock(mock.ctx, mergeOptions, (current) => syncBoth(mock.ctx, current, () => backend)),
    );
    assert.equal(mock.requests.length, 1);
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(agentDir, "settings.json"), "utf8")), {
      theme: "remote",
      shellPath: "/private/newer",
    });
  }));

test("unchanged refused candidates are reused without another provider request", async () =>
  withTempHome(async (agentDir) => {
    const f = await createMergeFixture(agentDir);
    await enabled();
    await fs.writeFile(path.join(agentDir, "AGENTS.md"), "local\n");
    await f.remoteEdit("AGENTS.md", "remote\n");
    const mock = agentContext((units) =>
      JSON.stringify({ version: 1, results: units.map((unit) => ({ id: unit.id, refuse: true })) }),
    );
    for (let index = 0; index < 2; index++)
      await assert.rejects(
        withStateDirectoryAccess(() =>
          withAgentSyncLock(mock.ctx, mergeOptions, (current) => syncBoth(mock.ctx, current, () => f.backend)),
        ),
        /refused/,
      );
    assert.equal(mock.requests.length, 1);
  }));

test("explicit partial policy alone permits progress around unsupported groups", async () =>
  withTempHome(async (agentDir) => {
    const f = await createMergeFixture(agentDir);
    await enabled();
    const settings = JSON.parse(await fs.readFile(localConfigPath(), "utf8"));
    settings.version = 5;
    settings.syncSetups.home.sync.partialSync = true;
    await fs.writeFile(localConfigPath(), JSON.stringify(settings));
    await fs.writeFile(path.join(agentDir, "AGENTS.md"), "local\n");
    await f.remoteEdit("AGENTS.md", "remote\n");
    await f.remoteEdit("settings.json", '{"theme":"remote"}');
    const mock = agentContext((units) =>
      JSON.stringify({ version: 1, results: units.map((unit) => ({ id: unit.id, refuse: true })) }),
    );
    await withStateDirectoryAccess(() =>
      withAgentSyncLock(mock.ctx, { ...mergeOptions, auto: true }, (current) =>
        syncBoth(mock.ctx, current, () => f.backend),
      ),
    );
    assert.equal(await fs.readFile(path.join(agentDir, "AGENTS.md"), "utf8"), "local\n");
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(agentDir, "settings.json"), "utf8")), { theme: "remote" });
    assert.ok((await readStateForConfig(await loadConfig())).unresolved?.length);
  }));

test("model changes after candidate acceptance invalidate the commit boundary", async () =>
  withTempHome(async (agentDir) => {
    const f = await createMergeFixture(agentDir);
    await enabled();
    await fs.writeFile(path.join(agentDir, "AGENTS.md"), "local\n");
    await f.remoteEdit("AGENTS.md", "remote\n");
    const mock = agentContext(selectRemote);
    const readHead = f.backend.readHead.bind(f.backend);
    let postResponseReads = 0;
    vi.spyOn(f.backend, "readHead").mockImplementation(async (signal) => {
      const head = await readHead(signal);
      if (mock.requests.length && ++postResponseReads === 4) {
        assert.ok(mock.ctx.model);
        mock.ctx.model = { ...mock.ctx.model, id: "changed-before-commit" };
      }
      return head;
    });
    await assert.rejects(
      withStateDirectoryAccess(() =>
        withAgentSyncLock(mock.ctx, mergeOptions, (current) => syncBoth(mock.ctx, current, () => f.backend)),
      ),
      /selected model changed/,
    );
    assert.equal(postResponseReads, 4);
    assert.equal(await fs.readFile(path.join(agentDir, "AGENTS.md"), "utf8"), "local\n");
    assert.equal(await readMergeJournal(await loadConfig()), undefined);
  }));
