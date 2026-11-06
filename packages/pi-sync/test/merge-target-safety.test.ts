import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { CURRENT_SESSION_VERSION, SessionManager } from "@earendil-works/pi-coding-agent";
import { test, vi } from "vitest";
import { createMockContext } from "../../../test/support.js";
import type { CommandOptions } from "../src/commands/command-types.js";
import { loadConfig } from "../src/settings/config.js";
import { localConfigPath } from "../src/settings/config-file.js";
import { createSnapshot, regenerateSnapshotIdentity } from "../src/snapshot/snapshot.js";
import { readStateForConfig, syncStateFingerprint } from "../src/state/sync-state-store.js";
import { preflightMergedTargets } from "../src/sync/merge-apply.js";
import {
  mergeJournalIdentity,
  mergeJournalPath,
  readMergeJournal,
  writeMergeJournal,
} from "../src/sync/merge-journal.js";
import { push, syncBoth } from "../src/sync/sync-mutations.js";
import { snapshot, v3S3Settings, withTempHome } from "./helpers.js";
import { MemorySyncBackend } from "./memory-sync-backend.js";

const options: CommandOptions = {
  args: [],
  yes: true,
  force: false,
  stale: false,
  silent: false,
  reload: false,
  auto: false,
};

async function fixture(agentDir: string, sessionRoot: string, include: string[], activeFile?: string) {
  await fs.mkdir(agentDir, { recursive: true });
  const settings = v3S3Settings({ include });
  Object.assign(settings.syncSetups.home.sync, { automaticTransfer: true });
  await fs.writeFile(localConfigPath(), JSON.stringify(settings));
  await fs.writeFile(path.join(agentDir, "settings.json"), JSON.stringify({ sessionDir: sessionRoot }));
  await fs.writeFile(path.join(agentDir, "AGENTS.md"), "before instructions");
  const manager = activeFile ? SessionManager.create(agentDir) : undefined;
  if (manager && activeFile) {
    manager.setSessionFile(activeFile);
    assert.equal(manager.usesDefaultSessionDir(), true);
    assert.equal(manager.getSessionFile(), activeFile);
  }
  const { ctx } = createMockContext(manager ? { sessionManager: manager } : {});
  const backend = new MemorySyncBackend();
  await push(ctx, options, undefined, () => backend);
  const config = await loadConfig();
  const observedBaseHead = await backend.readHead();
  assert.ok(observedBaseHead);
  const baseHead = observedBaseHead;
  const before = await createSnapshot(config.snapshotIdentity, { include, sessionDir: sessionRoot });
  async function remoteEdit(relative: string, content?: string) {
    const head = await backend.readHead();
    assert.ok(head);
    const current = await backend.readSnapshot(head.snapshotRef);
    const changed = snapshot(content === undefined ? [] : [{ path: relative, content: Buffer.from(content) }]).files;
    return backend.publishSnapshot(
      regenerateSnapshotIdentity({
        ...current,
        files: [...current.files.filter((file) => file.path !== relative), ...changed],
      }),
      { kind: "revision", revision: head.revision },
    );
  }
  async function journalForHead() {
    const head = await backend.readHead();
    assert.ok(head);
    const after = await backend.readSnapshot(head.snapshotRef);
    await writeMergeJournal(config, {
      version: 1,
      identity: mergeJournalIdentity(config, backend.identity),
      before,
      after,
      upload: after,
      expectedHead: baseHead,
      committedHead: head,
      backup: "retained-private-backup",
      stateIdentity: syncStateFingerprint(await readStateForConfig(config)),
      sessionRoot,
    });
  }
  return { ctx, backend, config, remoteEdit, journalForHead };
}

test("reviewed directory replacement refuses untracked descendants before publication", async () =>
  withTempHome(async (agentDir) => {
    const target = path.join(agentDir, "prompts/parent");
    await fs.mkdir(target, { recursive: true });
    await fs.writeFile(path.join(target, "child.md"), "known");
    await fs.writeFile(path.join(target, "untracked.md"), "unmanaged");
    const before = snapshot([{ path: "prompts/parent/child.md", content: Buffer.from("known") }]);
    const after = snapshot([{ path: "prompts/parent", content: Buffer.from("replacement") }]);
    await assert.rejects(preflightMergedTargets(before, after, { include: ["prompts"] }), /unknown or changed files/);
    assert.equal(await fs.readFile(path.join(target, "untracked.md"), "utf8"), "unmanaged");
  }));

type ActiveLayout = "session" | "ordinary" | "symlink-session";

async function activeFixture(agentDir: string, layout: ActiveLayout) {
  const physicalRoot = layout === "ordinary" ? agentDir : path.join(path.dirname(agentDir), "external-sessions");
  await fs.mkdir(physicalRoot, { recursive: true });
  const sessionRoot =
    layout === "symlink-session" ? path.join(path.dirname(agentDir), "linked-sessions") : physicalRoot;
  if (sessionRoot !== physicalRoot) await fs.symlink(physicalRoot, sessionRoot, "dir");
  const currentFile = path.join(physicalRoot, "current.jsonl");
  const original = `${JSON.stringify({
    type: "session",
    version: CURRENT_SESSION_VERSION,
    id: "c4e24029-95c3-4fd1-9dde-4b2ec8ceec8f",
    timestamp: "2026-10-05T00:00:00.000Z",
    cwd: agentDir,
  })}\n`;
  await fs.writeFile(currentFile, original);
  const relative = layout === "ordinary" ? "current.jsonl" : "sessions/current.jsonl";
  const f = await fixture(
    agentDir,
    sessionRoot,
    ["settings.json", "AGENTS.md", layout === "ordinary" ? relative : "sessions"],
    currentFile,
  );
  return { ...f, currentFile, original, relative };
}

for (const layout of ["session", "ordinary", "symlink-session"] as const) {
  for (const auto of [false, true])
    for (const deletion of [false, true])
      test(`${auto ? "automatic" : "manual"} merge protects ${layout} active paths from ${deletion ? "deletion" : "replacement"}`, async () =>
        withTempHome(async (agentDir) => {
          const f = await activeFixture(agentDir, layout);
          await f.remoteEdit(f.relative, deletion ? undefined : "remote replacement\n");
          await fs.writeFile(path.join(agentDir, "AGENTS.md"), "independent local change");
          const state = await readStateForConfig(f.config);
          const head = await f.backend.readHead();
          const publish = vi.spyOn(f.backend, "publishSnapshot");
          try {
            await assert.rejects(
              syncBoth(f.ctx, { ...options, auto }, () => f.backend),
              /Conflicting or protected|current session/,
            );
            assert.equal(publish.mock.calls.length, 0);
            assert.equal(await fs.readFile(f.currentFile, "utf8"), f.original);
            assert.deepEqual(await readStateForConfig(f.config), state);
            assert.deepEqual(await f.backend.readHead(), head);
            assert.equal(await readMergeJournal(f.config), undefined);
          } finally {
            publish.mockRestore();
          }
        }));

  for (const deletion of [false, true])
    test(`committed-journal recovery protects ${layout} active paths from ${deletion ? "deletion" : "replacement"}`, async () =>
      withTempHome(async (agentDir) => {
        const f = await activeFixture(agentDir, layout);
        const state = await readStateForConfig(f.config);
        await f.remoteEdit(f.relative, deletion ? undefined : "remote replacement\n");
        await f.journalForHead();
        const head = await f.backend.readHead();
        const publish = vi.spyOn(f.backend, "publishSnapshot");
        try {
          await assert.rejects(
            syncBoth(f.ctx, options, () => f.backend),
            /current session/,
          );
          assert.equal(publish.mock.calls.length, 0);
          assert.equal(await fs.readFile(f.currentFile, "utf8"), f.original);
          assert.deepEqual(await readStateForConfig(f.config), state);
          assert.deepEqual(await f.backend.readHead(), head);
          assert.ok(await readMergeJournal(f.config));
        } finally {
          publish.mockRestore();
        }
      }));
}

for (const mode of ["one-changed", "both-changed", "missing", "deleted", "symlink-root-missing"] as const)
  test(`physical target aliases are rejected before publication: ${mode}`, async () =>
    withTempHome(async (agentDir) => {
      await fs.mkdir(agentDir, { recursive: true });
      const sessionRoot =
        mode === "symlink-root-missing" ? path.join(path.dirname(agentDir), "linked-sessions") : agentDir;
      if (sessionRoot !== agentDir) await fs.symlink(agentDir, sessionRoot, "dir");
      const missing = mode === "missing" || mode === "symlink-root-missing";
      const target = path.join(agentDir, "foo.jsonl");
      if (!missing) await fs.writeFile(target, "before conversation");
      const f = await fixture(agentDir, sessionRoot, ["settings.json", "AGENTS.md", "foo.jsonl", "sessions"]);
      await f.remoteEdit("sessions/foo.jsonl", mode === "deleted" ? undefined : "remote conversation");
      if (mode === "both-changed" || missing) await f.remoteEdit("foo.jsonl", "remote conversation");
      await fs.writeFile(path.join(agentDir, "AGENTS.md"), "independent local change");
      const state = await readStateForConfig(f.config);
      const head = await f.backend.readHead();
      const publish = vi.spyOn(f.backend, "publishSnapshot");
      try {
        await assert.rejects(
          syncBoth(f.ctx, options, () => f.backend),
          /resolve to the same file/,
        );
        assert.equal(publish.mock.calls.length, 0);
        assert.deepEqual(await readStateForConfig(f.config), state);
        assert.deepEqual(await f.backend.readHead(), head);
        assert.equal(await readMergeJournal(f.config), undefined);
        if (missing) await assert.rejects(fs.access(target), { code: "ENOENT" });
        else assert.equal(await fs.readFile(target, "utf8"), "before conversation");
      } finally {
        publish.mockRestore();
      }
    }));

test("an alias introduced during journal publication is refused before the backend attempt", async () =>
  withTempHome(async (agentDir) => {
    await fs.mkdir(agentDir, { recursive: true });
    const sessionRoot = path.join(path.dirname(agentDir), "sessions");
    const retainedSessions = path.join(path.dirname(agentDir), "retained-sessions");
    await fs.mkdir(sessionRoot);
    const target = path.join(agentDir, "foo.jsonl");
    await fs.writeFile(target, "before conversation");
    await fs.writeFile(path.join(sessionRoot, "foo.jsonl"), "before conversation");
    const f = await fixture(agentDir, sessionRoot, ["settings.json", "AGENTS.md", "foo.jsonl", "sessions"]);
    await f.remoteEdit("sessions/foo.jsonl", "remote conversation");
    await fs.writeFile(path.join(agentDir, "AGENTS.md"), "independent local change");
    const state = await readStateForConfig(f.config);
    const head = await f.backend.readHead();
    let changedRoot = false;
    const rename = fs.rename.bind(fs);
    const renameSpy = vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
      await rename(from, to);
      if (!changedRoot && to === mergeJournalPath(f.config)) {
        changedRoot = true;
        await fs.rename(sessionRoot, retainedSessions);
        await fs.symlink(agentDir, sessionRoot, "dir");
      }
    });
    const publish = vi.spyOn(f.backend, "publishSnapshot");
    try {
      await assert.rejects(
        syncBoth(f.ctx, options, () => f.backend),
        /resolve to the same file/,
      );
      assert.equal(changedRoot, true);
      assert.equal(publish.mock.calls.length, 0);
      assert.deepEqual(await f.backend.readHead(), head);
      assert.deepEqual(await readStateForConfig(f.config), state);
      assert.equal(await readMergeJournal(f.config), undefined);
      assert.equal(await fs.readFile(target, "utf8"), "before conversation");
    } finally {
      renameSpy.mockRestore();
      publish.mockRestore();
    }
  }));

test("journal recovery rejects aliases between a changed and unchanged virtual path", async () =>
  withTempHome(async (agentDir) => {
    await fs.mkdir(agentDir, { recursive: true });
    const target = path.join(agentDir, "foo.jsonl");
    await fs.writeFile(target, "before conversation");
    const f = await fixture(agentDir, agentDir, ["settings.json", "AGENTS.md", "foo.jsonl", "sessions"]);
    const state = await readStateForConfig(f.config);
    await f.remoteEdit("sessions/foo.jsonl", "remote conversation");
    await f.journalForHead();
    const head = await f.backend.readHead();
    await assert.rejects(
      syncBoth(f.ctx, options, () => f.backend),
      /resolve to the same file/,
    );
    assert.equal(await fs.readFile(target, "utf8"), "before conversation");
    assert.deepEqual(await readStateForConfig(f.config), state);
    assert.deepEqual(await f.backend.readHead(), head);
    assert.ok(await readMergeJournal(f.config));
  }));

test("distinct ordinary and session targets with the same basename remain mergeable", async () =>
  withTempHome(async (agentDir) => {
    const sessionRoot = path.join(path.dirname(agentDir), "external-sessions");
    await fs.mkdir(sessionRoot, { recursive: true });
    await fs.mkdir(agentDir, { recursive: true });
    await fs.writeFile(path.join(agentDir, "foo.jsonl"), "ordinary file");
    await fs.writeFile(path.join(sessionRoot, "foo.jsonl"), "before conversation");
    const f = await fixture(agentDir, sessionRoot, ["settings.json", "AGENTS.md", "foo.jsonl", "sessions"]);
    await f.remoteEdit("sessions/foo.jsonl", "remote conversation");
    await fs.writeFile(path.join(agentDir, "AGENTS.md"), "independent local change");
    await syncBoth(f.ctx, options, () => f.backend);
    assert.equal(await fs.readFile(path.join(sessionRoot, "foo.jsonl"), "utf8"), "remote conversation");
    assert.equal(await fs.readFile(path.join(agentDir, "foo.jsonl"), "utf8"), "ordinary file");
    assert.equal(await readMergeJournal(f.config), undefined);
  }));
