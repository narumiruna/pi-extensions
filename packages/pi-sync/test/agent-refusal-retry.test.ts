import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { beforeAll, test, vi } from "vitest";
import { loadConfig } from "../src/settings/config.js";
import { localConfigPath } from "../src/settings/config-file.js";
import { withStateDirectoryAccess } from "../src/state/state-directory.js";
import { lockPath, readStateForConfig } from "../src/state/sync-state-store.js";
import { withAgentSyncLock } from "../src/sync/agent-sync.js";
import { acquireContinuousLease } from "../src/sync/continuous-lease.js";
import { readContinuousRecord, reserveContinuousRequest } from "../src/sync/continuous-record.js";
import { continuousBinding, prepareContinuousRoot } from "../src/sync/continuous-storage.js";
import { syncBoth } from "../src/sync/sync-mutations.js";
import { refusalFixture } from "./agent-refusal-test-helpers.js";
import { agentTestModel, selectRemote } from "./agent-test-helpers.js";
import { withTempHome } from "./helpers.js";
import { mergeOptions } from "./merged-sync-fixture.js";

beforeAll(async () => {
  await import("../src/sync/agent-runner.js");
});

test("confirmed retry replaces only the current refusal, retains history and leaves accounting unchanged", async () =>
  withTempHome(async (agentDir) => {
    const f = await refusalFixture(agentDir);
    const config = await loadConfig();
    await prepareContinuousRoot();
    const binding = await continuousBinding(config);
    const lease = await acquireContinuousLease(binding);
    assert.ok(lease);
    try {
      await reserveContinuousRequest(binding, lease, "a".repeat(64));
      await reserveContinuousRequest(binding, lease, "b".repeat(64));
    } finally {
      await lease.release();
    }
    const accounting = JSON.stringify(await readContinuousRecord(binding));
    await assert.rejects(f.run(), /refused/);
    assert.equal(f.mock.requests.length, 1, "ordinary sync reuses the refusal");
    f.answer();
    assert.equal(await f.run({ agentRetryRefusal: true }), "applied");
    assert.equal(f.mock.requests.length, 2);
    assert.equal(await fs.readFile(path.join(agentDir, "AGENTS.md"), "utf8"), "remote\n");
    const names = await fs.readdir(f.root);
    const archive = names.find((name) => name.includes(".refusal-"));
    assert.ok(archive);
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(f.root, archive), "utf8")), JSON.parse(f.original));
    assert.equal((await fs.stat(path.join(f.root, archive))).mode & 0o077, 0);
    assert.notEqual(await fs.readFile(f.file, "utf8"), f.original);
    assert.equal(JSON.stringify(await readContinuousRecord(binding)), accounting);
    await assert.rejects(fs.stat(path.join(f.root, "claim.json")), /ENOENT/);
    await assert.rejects(fs.stat(lockPath()), /ENOENT/);
  }));

test("cancelling a refusal review leaves bytes, baseline, cache, and remote unchanged", async () =>
  withTempHome(async (agentDir) => {
    const f = await refusalFixture(agentDir);
    const before = await readStateForConfig(await loadConfig());
    const head = await f.backend.readHead();
    f.mock.ctx.ui.select = async () => "No, cancel";
    f.answer();
    assert.equal(await f.run({ agentRetryRefusal: true }), "cancelled");
    assert.equal(f.mock.requests.length, 1);
    assert.equal(await fs.readFile(f.file, "utf8"), f.original);
    assert.equal(await fs.readFile(path.join(agentDir, "AGENTS.md"), "utf8"), "local\n");
    assert.deepEqual(await readStateForConfig(await loadConfig()), before);
    assert.deepEqual(await f.backend.readHead(), head);
    assert.equal((await fs.readdir(f.root)).length, 1);
  }));

for (const change of ["local", "remote", "model", "settings", "session", "cache", "cancel"] as const)
  test(`retry rejects stale ${change} during confirmation before disclosure`, async () =>
    withTempHome(async (agentDir) => {
      const f = await refusalFixture(agentDir);
      const controller = new AbortController();
      f.answer();
      f.mock.ctx.ui.select = async () => {
        if (change === "local") await fs.writeFile(path.join(agentDir, "AGENTS.md"), "new local\n");
        if (change === "remote") await f.remoteEdit("AGENTS.md", "new remote\n");
        if (change === "model") f.mock.ctx.model = { ...agentTestModel, id: "another-model" };
        if (change === "settings") {
          const settings = JSON.parse(await fs.readFile(localConfigPath(), "utf8"));
          settings.storageConnections.r2.credentials.secretAccessKey = "changed-private-key";
          await fs.writeFile(localConfigPath(), JSON.stringify(settings));
        }
        if (change === "session") f.mock.ctx.sessionManager = { ...f.mock.ctx.sessionManager };
        if (change === "cache") await fs.writeFile(f.file, '{"version":1,"results":[]}');
        if (change === "cancel") controller.abort();
        return "Yes, Send one fresh request";
      };
      await assert.rejects(f.run({ agentRetryRefusal: true, signal: controller.signal }));
      assert.equal(f.mock.requests.length, 1);
      if (change !== "cache") assert.equal(await fs.readFile(f.file, "utf8"), f.original);
      await assert.rejects(fs.stat(path.join(f.root, "claim.json")), /ENOENT/);
    }));

for (const result of ["invalid", "refuse", "changed evidence"] as const)
  test(`failed retry (${result}) retains the original refusal`, async () =>
    withTempHome(async (agentDir) => {
      const f = await refusalFixture(agentDir);
      f.answer(async (units) => {
        if (result === "invalid") return "not JSON";
        if (result === "refuse")
          return JSON.stringify({ version: 1, results: units.map((unit) => ({ id: unit.id, refuse: true })) });
        await fs.writeFile(path.join(agentDir, "AGENTS.md"), "new edit during response\n");
        return selectRemote(units);
      });
      await assert.rejects(f.run({ agentRetryRefusal: true }));
      assert.equal(f.mock.requests.length, 2);
      assert.equal(await fs.readFile(f.file, "utf8"), f.original);
      assert.equal((await fs.readdir(f.root)).length, 1);
    }));

test("a conflict disappearing before the acceptance rerun cannot publish a retry cache or baseline", async () =>
  withTempHome(async (agentDir) => {
    const f = await refusalFixture(agentDir);
    f.answer();
    const state = await readStateForConfig(await loadConfig());
    const head = await f.backend.readHead();
    let runs = 0;
    await assert.rejects(
      withStateDirectoryAccess(() =>
        withAgentSyncLock(f.mock.ctx, { ...mergeOptions, agentRetryRefusal: true }, async (options) => {
          if (++runs === 2) await fs.writeFile(path.join(agentDir, "AGENTS.md"), "remote\n");
          return syncBoth(f.mock.ctx, options, () => f.backend);
        }),
      ),
      /No eligible cached refusal/,
    );
    assert.equal(f.mock.requests.length, 2);
    assert.equal(await fs.readFile(f.file, "utf8"), f.original);
    assert.deepEqual(await readStateForConfig(await loadConfig()), state);
    assert.deepEqual(await f.backend.readHead(), head);
  }));

for (const failure of ["assembled bound", "upload secret"] as const)
  test(`schema-valid retry failing ${failure} preserves the active refusal`, async () =>
    withTempHome(async (agentDir) => {
      const prefix = failure === "assembled bound" ? `${"keep ".repeat(1500)}\n` : "";
      const f = await refusalFixture(agentDir, prefix);
      f.answer((units) =>
        JSON.stringify({
          version: 1,
          results: units.map((unit) => ({
            id: unit.id,
            content:
              failure === "assembled bound"
                ? "x".repeat(10000)
                : "OPENAI_API_KEY=abcdefghijklmnopqrstuvwxyz1234567890\n",
          })),
        }),
      );
      const head = await f.backend.readHead();
      await assert.rejects(f.run({ agentRetryRefusal: true }), /candidate refused or unsupported|possible secrets/);
      assert.equal(f.mock.requests.length, 2);
      assert.equal(await fs.readFile(f.file, "utf8"), f.original);
      assert.equal((await fs.readdir(f.root)).length, 1);
      assert.deepEqual(await f.backend.readHead(), head);
      assert.equal(await fs.readFile(path.join(agentDir, "AGENTS.md"), "utf8"), `${prefix}local\n`);
    }));

test("a competing retry cannot dispatch while the reviewed claim is live", async () =>
  withTempHome(async (agentDir) => {
    const f = await refusalFixture(agentDir);
    let entered!: () => void;
    let approve!: (value: string) => void;
    const review = new Promise<void>((resolve) => {
      entered = resolve;
    });
    f.mock.ctx.ui.select = () => {
      entered();
      return new Promise<string>((resolve) => {
        approve = resolve;
      });
    };
    f.answer();
    const first = f.run({ agentRetryRefusal: true });
    await review;
    try {
      await assert.rejects(
        f.run({ agentRetryRefusal: true }),
        /another local resolver|currently running|already running/,
      );
      assert.equal(f.mock.requests.length, 1);
    } finally {
      approve("Yes, Send one fresh request");
    }
    assert.equal(await first, "applied");
    assert.equal(f.mock.requests.length, 2);
  }));

test("atomic replacement failure retains both the active refusal and its private archive", async () =>
  withTempHome(async (agentDir) => {
    const f = await refusalFixture(agentDir);
    f.answer();
    const rename = fs.rename.bind(fs);
    vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
      if (String(to) === f.file) throw Object.assign(new Error("fixture rename failed"), { code: "EIO" });
      return rename(from, to);
    });
    await assert.rejects(f.run({ agentRetryRefusal: true }), /fixture rename failed/);
    assert.equal(await fs.readFile(f.file, "utf8"), f.original);
    const archive = (await fs.readdir(f.root)).find((name) => name.includes(".refusal-"));
    assert.ok(archive);
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(f.root, archive), "utf8")), JSON.parse(f.original));
    assert.equal(await fs.readFile(path.join(agentDir, "AGENTS.md"), "utf8"), "local\n");
  }));

for (const mismatch of ["missing", "accepted", "corrupt", "no conflict"] as const)
  test(`retry with ${mismatch} cache/evidence does not request or transfer`, async () =>
    withTempHome(async (agentDir) => {
      const f = await refusalFixture(agentDir);
      if (mismatch === "missing") await fs.rm(f.file);
      if (mismatch === "accepted")
        await fs.writeFile(f.file, JSON.stringify({ version: 1, results: [{ id: "0", content: "remote\n" }] }));
      if (mismatch === "corrupt") await fs.writeFile(f.file, "{broken");
      if (mismatch === "no conflict") await fs.writeFile(path.join(agentDir, "AGENTS.md"), "remote\n");
      const local = await fs.readFile(path.join(agentDir, "AGENTS.md"), "utf8");
      const head = await f.backend.readHead();
      const state = await readStateForConfig(await loadConfig());
      f.answer();
      await assert.rejects(f.run({ agentRetryRefusal: true }));
      assert.equal(f.mock.requests.length, 1);
      assert.deepEqual(await f.backend.readHead(), head);
      assert.deepEqual(await readStateForConfig(await loadConfig()), state);
      assert.equal(await fs.readFile(path.join(agentDir, "AGENTS.md"), "utf8"), local);
    }));
