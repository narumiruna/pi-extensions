import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import type { SyncLoaders } from "@narumitw/pi-sync-daemon/engine/sync/sync-loaders";
import { test } from "vitest";
import { createMockContext } from "../../../test/support.js";
import { loadConfig } from "../src/settings/config.js";
import { localConfigPath } from "../src/settings/config-file.js";
import { updateLocalConfig } from "../src/settings/settings-store.js";
import { withStateDirectoryAccess } from "../src/state/state-directory.js";
import { readStateForConfig } from "../src/state/sync-state-store.js";
import { withAgentSyncLock } from "../src/sync/agent-sync.js";
import { readMergeJournal } from "../src/sync/merge-journal.js";
import { pull, push, rollback, syncBoth } from "../src/sync/sync-mutations.js";
import { RemoteSelectionMismatchError, selectionForSnapshot } from "../src/sync/sync-policy.js";
import { agentContext, selectRemote } from "./agent-test-helpers.js";
import { snapshot, v3S3Settings, withTempHome } from "./helpers.js";
import { MemorySyncBackend } from "./memory-sync-backend.js";
import { mergeOptions } from "./merge-options.js";

const options = { ...mergeOptions, yes: true, force: true };
async function prepare(root: string) {
  await fs.mkdir(path.join(root, "skills/private"), { recursive: true });
  const base = v3S3Settings({ include: ["skills"] });
  const settings = {
    ...base,
    version: 6,
    syncSetups: {
      home: { ...base.syncSetups.home, sync: { ...base.syncSetups.home.sync, exclude: ["skills/private"] } },
    },
  };
  await fs.writeFile(localConfigPath(), JSON.stringify(settings), { mode: 0o600 });
  await fs.writeFile(path.join(root, "skills/private/a.md"), "local-private");
  await fs.writeFile(path.join(root, "skills/public.md"), "local-public");
  return createMockContext({ hasUI: true, mode: "rpc" });
}

test("excluding the entire sessions tree disables the legacy shutdown push before state/backend work", async () =>
  withTempHome(async (root) => {
    const { ctx, notifications } = await prepare(root);
    await updateLocalConfig((current) => {
      const setup = current.syncSetups.home;
      assert.ok(setup);
      Object.assign(setup.sync, {
        include: ["skills", "sessions"],
        exclude: ["skills/private", "sessions/**"],
        automatic: true,
      });
      return current;
    });
    const { pushSessionsOnShutdown } = await import("@narumitw/pi-sync-daemon/engine/sync/session-push");
    let loaded = 0;
    const loaders = new Proxy(
      {},
      {
        get: () => () => {
          loaded++;
          throw new Error("No transfer modules should load");
        },
      },
    ) as SyncLoaders;
    await pushSessionsOnShutdown(ctx, { ...mergeOptions, signal: new AbortController().signal }, loaders);
    assert.equal(loaded, 0);
    assert.deepEqual(notifications, []);
    await assert.rejects(fs.stat(path.join(root, "pi-sync")), { code: "ENOENT" });
  }));

test("force push omits old excluded bytes, pull and history rollback protect local exclusions", async () =>
  withTempHome(async (root) => {
    const { ctx } = await prepare(root);
    const backend = new MemorySyncBackend();
    const old = {
      ...snapshot([
        { path: "skills/private/a.md", content: Buffer.from("remote-private") },
        { path: "skills/public.md", content: Buffer.from("old-public") },
        { path: "unmanaged.toml", content: Buffer.from("retained") },
      ]),
      id: "legacy-history",
      selection: selectionForSnapshot(["skills"]),
    };
    await backend.publishSnapshot(old, { kind: "missing" });
    await push(ctx, options, undefined, () => backend);
    const first = await backend.readHead();
    assert.ok(first);
    const published = await backend.readSnapshot(first.snapshotRef);
    assert.equal(published.version, 4);
    assert.deepEqual(
      published.files.map((file) => file.path),
      ["skills/public.md", "unmanaged.toml"],
    );
    const incoming = {
      ...published,
      id: "remote-update",
      files: published.files.map((file) =>
        file.path === "skills/public.md"
          ? (snapshot([{ path: file.path, content: Buffer.from("remote-public") }]).files[0] ?? file)
          : file,
      ),
    };
    await backend.publishSnapshot(incoming, { kind: "revision", revision: first.revision });
    await pull(ctx, options, () => backend);
    assert.equal(await fs.readFile(path.join(root, "skills/public.md"), "utf8"), "remote-public");
    assert.equal(await fs.readFile(path.join(root, "skills/private/a.md"), "utf8"), "local-private");
    await rollback(ctx, { ...options, args: [old.id] }, () => backend);
    assert.equal(await fs.readFile(path.join(root, "skills/public.md"), "utf8"), "old-public");
    assert.equal(await fs.readFile(path.join(root, "skills/private/a.md"), "utf8"), "local-private");
    const final = await backend.readHead();
    assert.ok(final);
    assert.equal(
      (await backend.readSnapshot(final.snapshotRef)).files.some((file) => file.path.includes("private")),
      false,
    );
    assert.deepEqual((await readStateForConfig(await loadConfig())).exclude, ["skills/private"]);
    assert.ok(
      (await backend.readSnapshot(old.id)).files.some((file) => file.path.includes("private")),
      "History is retained, not erased",
    );
  }));

for (const mode of ["automatic", "pull-force", "push"])
  test(`exclude-only remote mismatch pauses ${mode} without mutation`, async () =>
    withTempHome(async (root) => {
      const { ctx } = await prepare(root);
      const backend = new MemorySyncBackend();
      const remote = {
        ...snapshot([{ path: "skills/public.md", content: Buffer.from("remote") }]),
        version: 4,
        selection: selectionForSnapshot(["skills"], ["skills/other"]),
      };
      const { head } = await backend.publishSnapshot(remote, { kind: "missing" });
      const operation =
        mode === "automatic"
          ? syncBoth(ctx, { ...options, force: false, auto: true }, () => backend)
          : mode === "pull-force"
            ? pull(ctx, options, () => backend)
            : push(ctx, { ...options, force: false }, undefined, () => backend);
      await assert.rejects(operation, RemoteSelectionMismatchError);
      assert.equal((await backend.readHead())?.revision, head.revision);
      assert.equal(await fs.readFile(path.join(root, "skills/public.md"), "utf8"), "local-public");
    }));

test("a delayed push cannot publish after an exclude edit", async () =>
  withTempHome(async (root) => {
    const { ctx } = await prepare(root);
    const backend = new MemorySyncBackend();
    const readHead = backend.readHead.bind(backend);
    let edited = false;
    backend.readHead = async (signal) => {
      if (!edited) {
        edited = true;
        await updateLocalConfig((current) => {
          const setup = current.syncSetups.home;
          assert.ok(setup);
          setup.sync.exclude = ["skills/private", "skills/public.md"];
          return current;
        });
      }
      return readHead(signal);
    };
    await assert.rejects(
      push(ctx, options, undefined, () => backend),
      /Settings changed/,
    );
    assert.equal(await readHead(), undefined);
    assert.equal(await fs.readFile(path.join(root, "skills/private/a.md"), "utf8"), "local-private");
  }));

test("merged and partial sync preserve exclude-enabled versions and managed baselines", async () =>
  withTempHome(async (root) => {
    const { ctx } = await prepare(root);
    await updateLocalConfig((current) => {
      const setup = current.syncSetups.home;
      assert.ok(setup);
      Object.assign(setup.sync, { mergeContent: true, partialSync: true });
      return current;
    });
    const backend = new MemorySyncBackend();
    await push(ctx, options, undefined, () => backend);
    await fs.writeFile(path.join(root, "skills/added.md"), "added");
    await fs.writeFile(path.join(root, "skills/private/a.md"), "changed-private");
    await syncBoth(ctx, { ...options, force: false }, () => backend);
    const head = await backend.readHead();
    assert.ok(head);
    const result = await backend.readSnapshot(head.snapshotRef);
    assert.equal(result.version, 4);
    assert.equal(
      result.files.some((file) => file.path.includes("private")),
      false,
    );
    assert.ok(result.files.some((file) => file.path === "skills/added.md"));
    assert.equal(await fs.readFile(path.join(root, "skills/private/a.md"), "utf8"), "changed-private");
  }));

test("version-4 partial progress withholds conflicts but advances an independent path", async () =>
  withTempHome(async (root) => {
    const { ctx } = await prepare(root);
    await updateLocalConfig((current) => {
      const setup = current.syncSetups.home;
      assert.ok(setup);
      Object.assign(setup.sync, { include: ["skills", "AGENTS.md"], partialSync: true, mergeContent: true });
      return current;
    });
    const backend = new MemorySyncBackend();
    await push(ctx, options, undefined, () => backend);
    const head = await backend.readHead();
    assert.ok(head);
    const base = await backend.readSnapshot(head.snapshotRef);
    await fs.writeFile(path.join(root, "skills/public.md"), "local conflict");
    await fs.writeFile(path.join(root, "AGENTS.md"), "independent addition");
    await backend.publishSnapshot(
      {
        ...base,
        id: "partial-remote",
        files: snapshot([{ path: "skills/public.md", content: Buffer.from("remote conflict") }]).files,
      },
      { kind: "revision", revision: head.revision },
    );
    await syncBoth(ctx, { ...options, force: false }, () => backend);
    const final = await backend.readHead();
    assert.ok(final);
    const published = await backend.readSnapshot(final.snapshotRef);
    assert.equal(published.version, 4);
    assert.equal(
      published.files.some((file) => file.path.includes("private")),
      false,
    );
    assert.ok(published.files.some((file) => file.path === "AGENTS.md"));
    assert.equal(await fs.readFile(path.join(root, "skills/public.md"), "utf8"), "local conflict");
    const state = await readStateForConfig(await loadConfig());
    assert.ok(state.unresolved?.some((group) => group.paths.includes("skills/public.md")));
    assert.deepEqual(state.exclude, ["skills/private"]);
  }));

for (const changedPolicy of [false, true])
  test(`version-4 merge recovery retains evidence across policy changes: ${changedPolicy}`, async () =>
    withTempHome(async (root) => {
      const { ctx } = await prepare(root);
      const backend = new MemorySyncBackend();
      await push(ctx, options, undefined, () => backend);
      const head = await backend.readHead();
      assert.ok(head);
      const base = await backend.readSnapshot(head.snapshotRef);
      await fs.writeFile(path.join(root, "skills/added.md"), "local addition");
      await backend.publishSnapshot(
        {
          ...base,
          id: "recovery-remote",
          files: snapshot([{ path: "skills/public.md", content: Buffer.from("remote update") }]).files,
        },
        { kind: "revision", revision: head.revision },
      );
      backend.failNextPublicationAfterCommit = true;
      await assert.rejects(
        syncBoth(ctx, { ...options, force: false }, () => backend),
        /interrupted/,
      );
      assert.ok(await readMergeJournal(await loadConfig()));
      const committed = await backend.readHead();
      const count = (await backend.listHistory()).length;
      if (changedPolicy) {
        await updateLocalConfig((current) => {
          const setup = current.syncSetups.home;
          assert.ok(setup);
          setup.sync.exclude = ["skills/private", "skills/public.md"];
          return current;
        });
        await assert.rejects(
          syncBoth(ctx, { ...options, force: false }, () => backend),
          /different setup|selection|policy/,
        );
        assert.ok(await readMergeJournal(await loadConfig()));
        assert.equal(await fs.readFile(path.join(root, "skills/public.md"), "utf8"), "local-public");
      } else {
        await syncBoth(ctx, { ...options, force: false }, () => backend);
        assert.equal(await readMergeJournal(await loadConfig()), undefined);
        assert.equal(await fs.readFile(path.join(root, "skills/public.md"), "utf8"), "remote update");
      }
      assert.deepEqual(await backend.readHead(), committed);
      assert.equal((await backend.listHistory()).length, count);
      assert.equal(await fs.readFile(path.join(root, "skills/private/a.md"), "utf8"), "local-private");
    }));

for (const stale of [false, true])
  test(`model evidence omits excluded text and policy edits invalidate authorization: ${stale}`, async () =>
    withTempHome(async (root) => {
      const { ctx } = await prepare(root);
      await updateLocalConfig((current) => {
        const setup = current.syncSetups.home;
        assert.ok(setup);
        setup.sync.agentMode = true;
        return current;
      });
      const privateText = "EXCLUDED-CONVERSATION-DO-NOT-SEND";
      await fs.writeFile(path.join(root, "skills/private/a.md"), privateText);
      const backend = new MemorySyncBackend();
      await push(ctx, options, undefined, () => backend);
      const head = await backend.readHead();
      assert.ok(head);
      const base = await backend.readSnapshot(head.snapshotRef);
      await fs.writeFile(path.join(root, "skills/public.md"), "conflicting local text");
      await backend.publishSnapshot(
        {
          ...base,
          id: "model-remote",
          files: snapshot([{ path: "skills/public.md", content: Buffer.from("conflicting remote text") }]).files,
        },
        { kind: "revision", revision: head.revision },
      );
      const remoteHead = await backend.readHead();
      const mock = agentContext(async (units) => {
        if (stale)
          await updateLocalConfig((current) => {
            const setup = current.syncSetups.home;
            assert.ok(setup);
            setup.sync.exclude = ["skills/private", "skills/public.md"];
            return current;
          });
        return selectRemote(units);
      });
      const run = () =>
        withStateDirectoryAccess(() =>
          withAgentSyncLock(mock.ctx, mergeOptions, (current) => syncBoth(mock.ctx, current, () => backend)),
        );
      if (stale) {
        await assert.rejects(run(), /changed|stale|resolver failed/i);
        assert.ok((await loadConfig()).exclude?.includes("skills/public.md"));
        assert.deepEqual(await backend.readHead(), remoteHead);
        assert.equal(await fs.readFile(path.join(root, "skills/public.md"), "utf8"), "conflicting local text");
      } else assert.equal(await run(), "applied");
      assert.equal(mock.requests.length, 1);
      assert.doesNotMatch(JSON.stringify(mock.requests), /EXCLUDED-CONVERSATION|skills\/private/);
      assert.equal(await fs.readFile(path.join(root, "skills/private/a.md"), "utf8"), privateText);
    }));
