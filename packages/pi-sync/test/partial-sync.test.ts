import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { test, vi } from "vitest";
import { createMockContext } from "../../../test/support.js";
import { expectedRemoteHead } from "../src/backends/sync-backend.js";
import { loadConfig } from "../src/settings/config.js";
import { localConfigPath } from "../src/settings/config-file.js";
import { readMergeAncestor } from "../src/state/merge-baseline-store.js";
import { readStateForConfig, statePathForConfig, syncStateFingerprint } from "../src/state/sync-state-store.js";
import {
  conflictArtifactFingerprint,
  conflictDirectory,
  readConflictArtifact,
  saveConflictArtifact,
} from "../src/sync/conflict-artifacts.js";
import { resolveReviewedGroup } from "../src/sync/conflict-resolution.js";
import { pruneCompletedConflicts } from "../src/sync/conflict-retention.js";
import { showConflicts } from "../src/sync/conflict-review.js";
import { snapshotFile } from "../src/sync/content-conflicts.js";
import { planFileMerge } from "../src/sync/file-merge-planner.js";
import { readMergeJournal, writeMergeJournal } from "../src/sync/merge-journal.js";
import { mergeSync } from "../src/sync/merged-sync.js";
import { push } from "../src/sync/sync-mutations.js";
import { fileHashMap } from "../src/sync/sync-state.js";
import { withTempHome } from "./helpers.js";
import { fixture, options, publish } from "./partial-sync-fixture.js";

test("verified text ancestor merges independent edits end to end", async () =>
  withTempHome(async (root) => {
    const f = await fixture(root);
    await fs.writeFile(path.join(root, "AGENTS.md"), "A\nb\nc\n");
    await publish(f, { "AGENTS.md": "a\nb\nC\n" });
    await mergeSync(f.context.ctx, options, () => f.backend);
    assert.equal(await fs.readFile(path.join(root, "AGENTS.md"), "utf8"), "A\nb\nC\n");
    const state = await readStateForConfig(f.config);
    assert.equal(state.unresolved, undefined);
    assert.equal((await readMergeAncestor(f.config, state, "AGENTS.md"))?.toString(), "A\nb\nC\n");
  }));
test("partial sync preserves both withheld versions, old base, durable artifact and repeated-restart state", async () =>
  withTempHome(async (root) => {
    const f = await fixture(root);
    await fs.writeFile(path.join(root, "AGENTS.md"), "LOCAL\nb\nc\n");
    await publish(f, { "AGENTS.md": "REMOTE\nb\nc\n", "prompts/safe.md": "incoming\n" });
    await mergeSync(f.context.ctx, options, () => f.backend);
    assert.equal(await fs.readFile(path.join(root, "AGENTS.md"), "utf8"), "LOCAL\nb\nc\n");
    assert.equal(await fs.readFile(path.join(root, "prompts/safe.md"), "utf8"), "incoming\n");
    const state = await readStateForConfig(f.config);
    assert.equal(state.lastAppliedSnapshot, f.state.lastAppliedSnapshot);
    assert.equal(state.lastFileHashes["AGENTS.md"], f.state.lastFileHashes["AGENTS.md"]);
    assert.equal(state.unresolved?.length, 1);
    assert.equal((await readMergeAncestor(f.config, state, "AGENTS.md"))?.toString(), "a\nb\nc\n");
    const token = state.unresolved?.[0]?.artifact;
    assert.ok(token);
    const artifact = await readConflictArtifact(f.config, f.backend.identity, token);
    assert.equal(artifact.ancestors?.[0]?.sha256, f.state.lastFileHashes["AGENTS.md"]);
    const stat = await fs.stat(path.join(conflictDirectory(f.config), `${token}.json`));
    if (process.platform !== "win32") assert.equal(stat.mode & 0o077, 0);
    const head = await f.backend.readHead();
    assert.ok(head);
    const remote = await f.backend.readSnapshot(head.snapshotRef);
    assert.equal(remote.version, 3);
    assert.equal(
      Buffer.from(remote.files.find((file) => file.path === "AGENTS.md")?.contentBase64 ?? "", "base64").toString(),
      "REMOTE\nb\nc\n",
    );
    await mergeSync(createMockContext({ hasUI: true }).ctx, options, () => f.backend);
    const restarted = await readStateForConfig(f.config);
    assert.equal(restarted.lastFileHashes["AGENTS.md"], f.state.lastFileHashes["AGENTS.md"]);
    assert.equal(restarted.unresolved?.length, 1);
  }));
test("a newly saved artifact contains only groups assigned its token", async () =>
  withTempHome(async (root) => {
    const f = await fixture(root);
    await fs.writeFile(path.join(root, "AGENTS.md"), "LOCAL\nb\nc\n");
    await fs.writeFile(path.join(root, "prompts/safe.md"), "local prompt\n");
    await publish(f, { "AGENTS.md": "REMOTE\nb\nc\n", "prompts/safe.md": "remote prompt\n" });
    await mergeSync(f.context.ctx, options, () => f.backend);
    const old = await readStateForConfig(f.config);
    assert.equal(old.unresolved?.length, 2);
    const unchanged = old.unresolved.find((group) => group.paths.includes("AGENTS.md"));
    assert.ok(unchanged);
    await fs.writeFile(path.join(root, "prompts/safe.md"), "new local prompt\n");
    await publish(f, { "settings.json": '{"theme":"dark"}\n' });
    await mergeSync(f.context.ctx, options, () => f.backend);
    const next = await readStateForConfig(f.config);
    const changed = next.unresolved?.find((group) => group.paths.includes("prompts/safe.md"));
    assert.ok(changed);
    assert.notEqual(changed.artifact, unchanged.artifact);
    assert.equal(next.unresolved?.find((group) => group.paths.includes("AGENTS.md"))?.artifact, unchanged.artifact);
    const artifact = await readConflictArtifact(f.config, f.backend.identity, changed.artifact);
    assert.deepEqual(
      artifact.groups.map((group) => group.paths),
      [changed.paths],
    );
    assert.ok(artifact.ancestors?.every((file) => changed.paths.includes(file.path)));
    assert.ok(artifact.local.files.every((file) => changed.paths.includes(file.path)));
    assert.ok(artifact.remote.files.every((file) => changed.paths.includes(file.path)));
  }));

test("group resolution revalidates current bytes and never applies stale artifacts", async () =>
  withTempHome(async (root) => {
    const f = await fixture(root);
    await fs.writeFile(path.join(root, "AGENTS.md"), "LOCAL\nb\nc\n");
    await publish(f, { "AGENTS.md": "REMOTE\nb\nc\n" });
    await mergeSync(f.context.ctx, options, () => f.backend);
    const state = await readStateForConfig(f.config);
    const token = state.unresolved?.[0]?.artifact;
    assert.ok(token);
    const resolution = {
      token,
      group: 0,
      source: "remote" as const,
      stateIdentity: syncStateFingerprint(state),
      artifactIdentity: conflictArtifactFingerprint(await readConflictArtifact(f.config, f.backend.identity, token)),
    };
    await fs.writeFile(path.join(root, "AGENTS.md"), "newer local\n");
    const publication = vi.spyOn(f.backend, "publishSnapshot");
    await assert.rejects(
      mergeSync(f.context.ctx, options, () => f.backend, resolution),
      /versions changed/,
    );
    assert.equal(publication.mock.calls.length, 0);
    await fs.writeFile(path.join(root, "AGENTS.md"), "LOCAL\nb\nc\n");
    await mergeSync(f.context.ctx, options, () => f.backend, resolution);
    assert.equal(await fs.readFile(path.join(root, "AGENTS.md"), "utf8"), "REMOTE\nb\nc\n");
    assert.equal((await readStateForConfig(f.config)).unresolved, undefined);
    assert.equal(
      (await readStateForConfig(f.config)).lastFileHashes["AGENTS.md"],
      snapshotFile("AGENTS.md", Buffer.from("REMOTE\nb\nc\n")).sha256,
    );
  }));
test("unresolved dependency group defers otherwise clean members without deleting local-only files", async () =>
  withTempHome(async (root) => {
    const f = await fixture(root);
    await fs.writeFile(path.join(root, "prompts/safe.md"), "local\n");
    await fs.writeFile(path.join(root, "prompts/new.md"), "local addition\n");
    await publish(f, { "prompts/safe.md": "remote\n", "AGENTS.md": "a\nb\nC\n" });
    await mergeSync(f.context.ctx, options, () => f.backend);
    assert.equal(await fs.readFile(path.join(root, "prompts/new.md"), "utf8"), "local addition\n");
    const state = await readStateForConfig(f.config);
    assert.ok(state.unresolved?.[0]?.paths.includes("prompts/new.md"));
    assert.equal(state.lastFileHashes["prompts/new.md"], undefined);
    assert.equal(await fs.readFile(path.join(root, "AGENTS.md"), "utf8"), "a\nb\nC\n");
  }));

test("partial accepted-state failure rolls forward once without republishing or losing the withheld base", async () =>
  withTempHome(async (root) => {
    const f = await fixture(root);
    await fs.writeFile(path.join(root, "AGENTS.md"), "LOCAL\nb\nc\n");
    await publish(f, { "AGENTS.md": "REMOTE\nb\nc\n", "prompts/safe.md": "incoming\n" });
    const rename = fs.rename.bind(fs);
    const failure = vi.spyOn(fs, "rename").mockImplementation(async (source, target) => {
      if (String(target) === statePathForConfig(f.config)) throw new Error("state persistence interrupted");
      return rename(source, target);
    });
    await assert.rejects(mergeSync(f.context.ctx, options, () => f.backend));
    failure.mockRestore();
    assert.ok(await readMergeJournal(f.config));
    const publication = vi.spyOn(f.backend, "publishSnapshot");
    await mergeSync(f.context.ctx, options, () => f.backend);
    assert.equal(publication.mock.calls.length, 0);
    assert.equal(await readMergeJournal(f.config), undefined);
    const state = await readStateForConfig(f.config);
    assert.equal(state.unresolved?.length, 1);
    assert.equal(state.lastFileHashes["AGENTS.md"], f.state.lastFileHashes["AGENTS.md"]);
    assert.equal((await readMergeAncestor(f.config, state, "AGENTS.md"))?.toString(), "a\nb\nc\n");
  }));

test("committed partial recovery preserves baseline-only equal deletions and rejects unpinned groups", async () =>
  withTempHome(async (root) => {
    const f = await fixture(root);
    await fs.writeFile(path.join(root, "prompts/deleted.md"), "old ancestor\n");
    await push(f.context.ctx, { ...options, force: true }, undefined, () => f.backend);
    const baseline = await readStateForConfig(f.config);
    await fs.unlink(path.join(root, "prompts/deleted.md"));
    await fs.writeFile(path.join(root, "prompts/safe.md"), "local conflict\n");
    const oldHead = await f.backend.readHead();
    assert.ok(oldHead);
    const before = await f.backend.readSnapshot(oldHead.snapshotRef);
    await f.backend.publishSnapshot(
      {
        ...before,
        id: "deleted-conflict",
        files: before.files
          .filter((file) => file.path !== "prompts/deleted.md")
          .map((file) =>
            file.path === "prompts/safe.md"
              ? snapshotFile(file.path, Buffer.from("remote conflict\n"))
              : file.path === "AGENTS.md"
                ? snapshotFile(file.path, Buffer.from("independent incoming\n"))
                : file,
          ),
      },
      expectedRemoteHead(oldHead),
    );
    const rename = fs.rename.bind(fs);
    const failure = vi.spyOn(fs, "rename").mockImplementation(async (source, target) => {
      if (String(target) === statePathForConfig(f.config)) throw new Error("state interrupted after commit");
      return rename(source, target);
    });
    try {
      await assert.rejects(mergeSync(f.context.ctx, options, () => f.backend));
    } finally {
      failure.mockRestore();
    }
    const journal = await readMergeJournal(f.config);
    assert.ok(journal?.progress);
    assert.ok(journal.progress.groups.some((group) => group.paths.includes("prompts/deleted.md")));
    assert.ok(
      [journal.before, journal.after, journal.upload].every(
        (image) => !image.files.some((file) => file.path === "prompts/deleted.md"),
      ),
    );
    const altered = structuredClone(journal);
    assert.ok(altered.progress);
    const group = altered.progress.groups[0];
    assert.ok(group);
    group.paths.push("settings.json");
    await writeMergeJournal(f.config, altered);
    await assert.rejects(readMergeJournal(f.config), /does not match retained artifact/);
    group.paths.pop();
    group.paths.push("prompts/unknown.md");
    await writeMergeJournal(f.config, altered);
    await assert.rejects(readMergeJournal(f.config), /Invalid partial acceptance metadata/);
    await writeMergeJournal(f.config, journal);
    const publication = vi.spyOn(f.backend, "publishSnapshot");
    await mergeSync(f.context.ctx, options, () => f.backend);
    assert.equal(publication.mock.calls.length, 0);
    assert.equal(await readMergeJournal(f.config), undefined);
    await assert.rejects(fs.access(path.join(root, "prompts/deleted.md")));
    const state = await readStateForConfig(f.config);
    assert.equal(state.lastFileHashes["prompts/deleted.md"], baseline.lastFileHashes["prompts/deleted.md"]);
    assert.ok(state.unresolved?.some((group) => group.paths.includes("prompts/deleted.md")));
    assert.equal(await fs.readFile(path.join(root, "AGENTS.md"), "utf8"), "independent incoming\n");
  }));

test("remote collision dependency group is retained while an independent path progresses", async () =>
  withTempHome(async (root) => {
    const f = await fixture(root);
    const head = await f.backend.readHead();
    assert.ok(head);
    const remote = await f.backend.readSnapshot(head.snapshotRef);
    await f.backend.publishSnapshot(
      {
        ...remote,
        id: "collision-head",
        files: [
          ...remote.files.filter((file) => file.path !== "AGENTS.md"),
          snapshotFile("AGENTS.md", Buffer.from("incoming\n")),
          snapshotFile("prompts/A.md", Buffer.from("upper\n")),
          snapshotFile("prompts/a.md", Buffer.from("lower\n")),
        ],
      },
      expectedRemoteHead(head),
    );
    await mergeSync(f.context.ctx, options, () => f.backend);
    assert.equal(await fs.readFile(path.join(root, "AGENTS.md"), "utf8"), "incoming\n");
    const state = await readStateForConfig(f.config);
    assert.ok(state.unresolved?.[0]?.paths.includes("prompts/A.md"));
    assert.ok(state.unresolved?.[0]?.paths.includes("prompts/a.md"));
    await assert.rejects(fs.access(path.join(root, "prompts/A.md")));
    const current = await f.backend.readHead();
    assert.ok(current);
    const retained = await f.backend.readSnapshot(current.snapshotRef);
    assert.equal(
      retained.files.find((file) => file.path === "prompts/A.md")?.sha256,
      snapshotFile("prompts/A.md", Buffer.from("upper\n")).sha256,
    );
    assert.equal(
      retained.files.find((file) => file.path === "prompts/a.md")?.sha256,
      snapshotFile("prompts/a.md", Buffer.from("lower\n")).sha256,
    );
  }));
for (const simulateAlias of [false, true])
  for (const [beforePath, afterPath] of [
    ["prompts/Foo.md", "prompts/foo.md"],
    ["prompts/foo.md", "prompts/Foo.md"],
  ])
    test(`reviewed remote case rename ${beforePath} to ${afterPath} deletes its preimage (${simulateAlias ? "simulated alias" : "native filesystem"})`, async () =>
      withTempHome(async (root) => {
        const f = await fixture(root);
        const upper = path.join(root, beforePath);
        if (simulateAlias) {
          const realpath = fs.realpath.bind(fs);
          vi.spyOn(fs, "realpath").mockImplementation(async (target, ...args) => {
            if (String(target) === path.join(root, afterPath)) {
              try {
                return await realpath(upper, ...args);
              } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
              }
            }
            return realpath(target, ...args);
          });
        }
        await fs.writeFile(upper, "base\n");
        await push(f.context.ctx, options, undefined, () => f.backend);
        await fs.writeFile(upper, "local\n");
        const head = await f.backend.readHead();
        assert.ok(head);
        const remote = await f.backend.readSnapshot(head.snapshotRef);
        await f.backend.publishSnapshot(
          {
            ...remote,
            id: "case-rename",
            files: [
              ...remote.files.filter((file) => file.path !== beforePath),
              snapshotFile(afterPath, Buffer.from("remote\n")),
            ],
          },
          expectedRemoteHead(head),
        );
        await mergeSync(f.context.ctx, options, () => f.backend);
        const state = await readStateForConfig(f.config);
        const group = state.unresolved?.find((item) => item.paths.includes(beforePath));
        assert.ok(group);
        const artifact = await readConflictArtifact(f.config, f.backend.identity, group.artifact);
        await mergeSync(f.context.ctx, options, () => f.backend, {
          token: group.artifact,
          group: artifact.groups.findIndex((item) => item.paths.includes(beforePath)),
          source: "remote",
          stateIdentity: syncStateFingerprint(state),
          artifactIdentity: conflictArtifactFingerprint(artifact),
        });
        const names = await fs.readdir(path.join(root, "prompts"));
        assert.ok(!names.includes(path.basename(beforePath)));
        assert.ok(names.includes(path.basename(afterPath)));
        assert.equal(await fs.readFile(path.join(root, afterPath), "utf8"), "remote\n");
      }));

test("reviewed file-to-directory transition installs its child after deleting the file", async () =>
  withTempHome(async (root) => {
    const f = await fixture(root);
    const parent = path.join(root, "prompts/parent");
    await fs.writeFile(parent, "base\n");
    await push(f.context.ctx, options, undefined, () => f.backend);
    await fs.writeFile(parent, "local\n");
    const head = await f.backend.readHead();
    assert.ok(head);
    const remote = await f.backend.readSnapshot(head.snapshotRef);
    await f.backend.publishSnapshot(
      {
        ...remote,
        id: "file-to-directory",
        files: [
          ...remote.files.filter((file) => file.path !== "prompts/parent"),
          snapshotFile("prompts/parent/child.md", Buffer.from("remote\n")),
        ],
      },
      expectedRemoteHead(head),
    );
    await mergeSync(f.context.ctx, options, () => f.backend);
    const state = await readStateForConfig(f.config);
    const group = state.unresolved?.find((item) => item.paths.includes("prompts/parent"));
    assert.ok(group);
    const artifact = await readConflictArtifact(f.config, f.backend.identity, group.artifact);
    await mergeSync(f.context.ctx, options, () => f.backend, {
      token: group.artifact,
      group: artifact.groups.findIndex((item) => item.paths.includes("prompts/parent")),
      source: "remote",
      stateIdentity: syncStateFingerprint(state),
      artifactIdentity: conflictArtifactFingerprint(artifact),
    });
    assert.equal(await fs.readFile(path.join(parent, "child.md"), "utf8"), "remote\n");
  }));

test("reviewed directory-to-file transition removes its old child before installing the file", async () =>
  withTempHome(async (root) => {
    const f = await fixture(root);
    const parent = path.join(root, "prompts/parent");
    await fs.mkdir(parent);
    await fs.writeFile(path.join(parent, "child.md"), "base\n");
    await push(f.context.ctx, options, undefined, () => f.backend);
    await fs.writeFile(path.join(parent, "child.md"), "local\n");
    const head = await f.backend.readHead();
    assert.ok(head);
    const remote = await f.backend.readSnapshot(head.snapshotRef);
    await f.backend.publishSnapshot(
      {
        ...remote,
        id: "directory-to-file",
        files: [
          ...remote.files.filter((file) => file.path !== "prompts/parent/child.md"),
          snapshotFile("prompts/parent", Buffer.from("remote\n")),
        ],
      },
      expectedRemoteHead(head),
    );
    await mergeSync(f.context.ctx, options, () => f.backend);
    const state = await readStateForConfig(f.config);
    const group = state.unresolved?.find((item) => item.paths.includes("prompts/parent/child.md"));
    assert.ok(group);
    const artifact = await readConflictArtifact(f.config, f.backend.identity, group.artifact);
    await mergeSync(f.context.ctx, options, () => f.backend, {
      token: group.artifact,
      group: artifact.groups.findIndex((item) => item.paths.includes("prompts/parent/child.md")),
      source: "remote",
      stateIdentity: syncStateFingerprint(state),
      artifactIdentity: conflictArtifactFingerprint(artifact),
    });
    assert.equal(await fs.readFile(parent, "utf8"), "remote\n");
  }));

test("three machines retain one conflict identity across unrelated publication and converge after resolution", async () =>
  withTempHome(async (root) => {
    const a = path.join(root, "a");
    const b = path.join(root, "b");
    const c = path.join(root, "c");
    process.env.PI_CODING_AGENT_DIR = a;
    const first = await fixture(a);
    process.env.PI_CODING_AGENT_DIR = b;
    const second = await fixture(b);
    process.env.PI_CODING_AGENT_DIR = c;
    const third = await fixture(c);
    // Establish all machines against the same accepted remote, retaining their own caches.
    process.env.PI_CODING_AGENT_DIR = b;
    await push(second.context.ctx, options, undefined, () => first.backend);
    process.env.PI_CODING_AGENT_DIR = c;
    await push(third.context.ctx, options, undefined, () => first.backend);
    process.env.PI_CODING_AGENT_DIR = a;
    await fs.writeFile(path.join(a, "AGENTS.md"), "A\nb\nc\n");
    await mergeSync(first.context.ctx, options, () => first.backend);
    process.env.PI_CODING_AGENT_DIR = b;
    await fs.writeFile(path.join(b, "AGENTS.md"), "B\nb\nc\n");
    await fs.writeFile(path.join(b, "prompts/safe.md"), "B prompt\n");
    await mergeSync(second.context.ctx, options, () => first.backend);
    const state = await readStateForConfig(second.config);
    const token = state.unresolved?.[0]?.artifact;
    assert.ok(token);
    process.env.PI_CODING_AGENT_DIR = c;
    await fs.writeFile(path.join(c, "prompts/third.md"), "third addition\n");
    await mergeSync(third.context.ctx, options, () => first.backend);
    process.env.PI_CODING_AGENT_DIR = b;
    await mergeSync(second.context.ctx, options, () => first.backend);
    const refreshed = await readStateForConfig(second.config);
    assert.equal(refreshed.unresolved?.[0]?.artifact, token);
    assert.equal((await fs.readdir(conflictDirectory(second.config))).length, 1);
    const artifact = await readConflictArtifact(second.config, first.backend.identity, token);
    await mergeSync(second.context.ctx, options, () => first.backend, {
      token,
      group: 0,
      source: "remote",
      stateIdentity: syncStateFingerprint(refreshed),
      artifactIdentity: conflictArtifactFingerprint(artifact),
    });
    for (const [directory, context] of [
      [a, first.context],
      [c, third.context],
    ] as const) {
      process.env.PI_CODING_AGENT_DIR = directory;
      await mergeSync(context.ctx, options, () => first.backend);
    }
    for (const directory of [a, b, c]) {
      assert.equal(await fs.readFile(path.join(directory, "AGENTS.md"), "utf8"), "A\nb\nc\n");
      assert.equal(await fs.readFile(path.join(directory, "prompts/third.md"), "utf8"), "third addition\n");
    }
  }));

test("reviewed remote deletion removes only the selected dependency group and does not resurrect it", async () =>
  withTempHome(async (root) => {
    const f = await fixture(root);
    await fs.writeFile(path.join(root, "AGENTS.md"), "local edit\n");
    const head = await f.backend.readHead();
    assert.ok(head);
    const original = await f.backend.readSnapshot(head.snapshotRef);
    await f.backend.publishSnapshot(
      { ...original, id: "remote-deletion", files: original.files.filter((file) => file.path !== "AGENTS.md") },
      expectedRemoteHead(head),
    );
    await mergeSync(f.context.ctx, options, () => f.backend);
    assert.equal(await fs.readFile(path.join(root, "AGENTS.md"), "utf8"), "local edit\n");
    const state = await readStateForConfig(f.config);
    const token = state.unresolved?.[0]?.artifact;
    assert.ok(token);
    const artifact = await readConflictArtifact(f.config, f.backend.identity, token);
    await mergeSync(f.context.ctx, options, () => f.backend, {
      token,
      group: 0,
      source: "remote",
      stateIdentity: syncStateFingerprint(state),
      artifactIdentity: conflictArtifactFingerprint(artifact),
    });
    await assert.rejects(fs.access(path.join(root, "AGENTS.md")));
    assert.equal((await readStateForConfig(f.config)).lastFileHashes["AGENTS.md"], undefined);
    await mergeSync(f.context.ctx, options, () => f.backend);
    await assert.rejects(fs.access(path.join(root, "AGENTS.md")));
  }));

test("changed private artifact invalidates a reviewed choice without overwriting newer local bytes", async () =>
  withTempHome(async (root) => {
    const f = await fixture(root);
    await fs.writeFile(path.join(root, "AGENTS.md"), "LOCAL\nb\nc\n");
    await publish(f, { "AGENTS.md": "REMOTE\nb\nc\n" });
    await mergeSync(f.context.ctx, options, () => f.backend);
    const state = await readStateForConfig(f.config);
    const token = state.unresolved?.[0]?.artifact;
    assert.ok(token);
    const artifact = await readConflictArtifact(f.config, f.backend.identity, token);
    const resolution = {
      token,
      group: 0,
      source: "remote" as const,
      stateIdentity: syncStateFingerprint(state),
      artifactIdentity: conflictArtifactFingerprint(artifact),
    };
    await fs.writeFile(path.join(root, "AGENTS.md"), "NEWER\n");
    artifact.local.files = artifact.local.files.map((file) =>
      file.path === "AGENTS.md" ? snapshotFile(file.path, Buffer.from("NEWER\n")) : file,
    );
    await fs.writeFile(path.join(conflictDirectory(f.config), `${token}.json`), JSON.stringify(artifact), {
      mode: 0o600,
    });
    await assert.rejects(
      mergeSync(f.context.ctx, options, () => f.backend, resolution),
      /stale/,
    );
    assert.equal(await fs.readFile(path.join(root, "AGENTS.md"), "utf8"), "NEWER\n");
  }));

test("unchanged heads still revalidate content and deduplicate conflict artifacts without scheduling watchers", async () =>
  withTempHome(async (root) => {
    const f = await fixture(root);
    await fs.writeFile(path.join(root, "AGENTS.md"), "LOCAL\nb\nc\n");
    await publish(f, { "AGENTS.md": "REMOTE\nb\nc\n" });
    await mergeSync(f.context.ctx, options, () => f.backend);
    const state = await readStateForConfig(f.config);
    const token = state.unresolved?.[0]?.artifact;
    const read = vi.spyOn(f.backend, "readSnapshot");
    const write = vi.spyOn(f.backend, "publishSnapshot");
    await mergeSync(f.context.ctx, options, () => f.backend);
    await mergeSync(f.context.ctx, options, () => f.backend);
    assert.equal(write.mock.calls.length, 0);
    assert.equal(read.mock.calls.length, 2);
    assert.equal((await readStateForConfig(f.config)).unresolved?.[0]?.artifact, token);
    assert.equal((await fs.readdir(conflictDirectory(f.config))).length, 1);
  }));

test("RPC private review cancellation keeps bytes, head and unresolved identity unchanged", async () =>
  withTempHome(async (root) => {
    const f = await fixture(root);
    await fs.writeFile(path.join(root, "AGENTS.md"), "LOCAL\nb\nc\n");
    await publish(f, { "AGENTS.md": "REMOTE\nb\nc\n" });
    await mergeSync(f.context.ctx, options, () => f.backend);
    const before = await readStateForConfig(f.config);
    const head = await f.backend.readHead();
    const context = createMockContext({
      hasUI: true,
      mode: "rpc",
      select: async (title: string, choices: string[]) =>
        title === "Review unresolved dependency group" ? choices[0] : undefined,
      confirm: async () => false,
    });
    await showConflicts(context.ctx, options, () => f.backend);
    assert.deepEqual(await readStateForConfig(f.config), before);
    assert.deepEqual(await f.backend.readHead(), head);
    assert.equal(await fs.readFile(path.join(root, "AGENTS.md"), "utf8"), "LOCAL\nb\nc\n");
  }));

test("bounded completed retention never prunes pinned unresolved or malformed evidence", async () =>
  withTempHome(async (root) => {
    const f = await fixture(root);
    await fs.writeFile(path.join(root, "AGENTS.md"), "finished\n");
    await push(f.context.ctx, options, undefined, () => f.backend);
    const head = await f.backend.readHead();
    assert.ok(head);
    const common = await f.backend.readSnapshot(head.snapshotRef);
    const tokens: string[] = [];
    for (let index = 0; index < 35; index++)
      tokens.push(
        await saveConflictArtifact(
          f.config,
          f.backend.identity,
          {
            state: f.state,
            local: common,
            remote: {
              ...common,
              files: common.files.map((file) =>
                file.path === "AGENTS.md" ? snapshotFile(file.path, Buffer.from(`divergent-${index}\n`)) : file,
              ),
            },
            groups: [{ paths: ["AGENTS.md"], reasons: ["both-changed"] }],
            observed: { snapshotId: head.snapshotId, revision: head.revision },
          },
          () => {},
        ),
      );
    const pinned = tokens[0];
    assert.ok(pinned);
    const malformed = "00000000-0000-0000-0000-000000000000.json";
    await fs.writeFile(path.join(conflictDirectory(f.config), malformed), "sensitive invalid evidence", {
      mode: 0o600,
    });
    const accepted = await readStateForConfig(f.config);
    await pruneCompletedConflicts(
      f.config,
      f.backend.identity,
      { ...accepted, unresolved: [{ paths: ["AGENTS.md"], artifact: pinned }] },
      common,
      common,
      () => {},
    );
    const retained = await fs.readdir(conflictDirectory(f.config));
    assert.equal(retained.length, 34);
    assert.ok(retained.includes(`${pinned}.json`));
    assert.ok(retained.includes(malformed));
  }));

test("missing ancestor withholds that conflict without inventing a base or blocking safe progress", async () =>
  withTempHome(async (root) => {
    const f = await fixture(root);
    await fs.rm(`${statePathForConfig(f.config)}.ancestors`, { recursive: true, force: true });
    await fs.writeFile(path.join(root, "AGENTS.md"), "A\nb\nc\n");
    await publish(f, { "AGENTS.md": "a\nb\nC\n", "prompts/safe.md": "incoming\n" });
    await mergeSync(f.context.ctx, options, () => f.backend);
    assert.equal(await fs.readFile(path.join(root, "AGENTS.md"), "utf8"), "A\nb\nc\n");
    const state = await readStateForConfig(f.config);
    assert.equal(state.unresolved?.length, 1);
    assert.equal(state.lastFileHashes["AGENTS.md"], f.state.lastFileHashes["AGENTS.md"]);
    assert.equal(await readMergeAncestor(f.config, state, "AGENTS.md"), undefined);
    assert.equal(await fs.readFile(path.join(root, "prompts/safe.md"), "utf8"), "incoming\n");
  }));

test("deleted managed collision participants remain represented in withheld baseline groups", async () =>
  withTempHome(async (root) => {
    const f = await fixture(root);
    await fs.writeFile(path.join(root, "prompts/OLD.md"), "ancestor\n");
    await push(f.context.ctx, { ...options, force: true }, undefined, () => f.backend);
    const baseline = await readStateForConfig(f.config);
    const oldHead = await f.backend.readHead();
    assert.ok(oldHead);
    const before = await f.backend.readSnapshot(oldHead.snapshotRef);
    await fs.unlink(path.join(root, "prompts/OLD.md"));
    await f.backend.publishSnapshot(
      {
        ...before,
        id: "managed-deleted-alias",
        files: [
          ...before.files.filter((file) => !["prompts/OLD.md", "AGENTS.md"].includes(file.path)),
          snapshotFile("prompts/old.md", Buffer.from("new alias\n")),
          snapshotFile("AGENTS.md", Buffer.from("incoming independent\n")),
        ],
      },
      expectedRemoteHead(oldHead),
    );
    await mergeSync(f.context.ctx, options, () => f.backend);
    const state = await readStateForConfig(f.config);
    assert.ok(
      state.unresolved?.some(
        (group) => group.paths.includes("prompts/OLD.md") && group.paths.includes("prompts/old.md"),
      ),
    );
    assert.equal(state.lastFileHashes["prompts/OLD.md"], baseline.lastFileHashes["prompts/OLD.md"]);
    assert.equal(await fs.readFile(path.join(root, "AGENTS.md"), "utf8"), "incoming independent\n");
    await assert.rejects(fs.access(path.join(root, "prompts/old.md")));
    const head = await f.backend.readHead();
    assert.ok(head);
    assert.ok((await f.backend.readSnapshot(head.snapshotRef)).files.some((file) => file.path === "prompts/old.md"));
  }));

async function artifactNames(config: Awaited<ReturnType<typeof loadConfig>>) {
  return fs.readdir(conflictDirectory(config)).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
}
test("cancelled partial transfer creates no unreferenced artifact and preserves existing evidence", async () =>
  withTempHome(async (root) => {
    const f = await fixture(root);
    await fs.writeFile(path.join(root, "AGENTS.md"), "LOCAL\nb\nc\n");
    await publish(f, { "AGENTS.md": "REMOTE\nb\nc\n", "prompts/safe.md": "incoming\n" });
    const rpc = createMockContext({ mode: "rpc", hasUI: true, select: async () => undefined });
    const state = syncStateFingerprint(await readStateForConfig(f.config));
    const head = await f.backend.readHead();
    const publication = vi.spyOn(f.backend, "publishSnapshot");
    for (const local of ["LOCAL", "CHANGED"]) {
      await fs.writeFile(path.join(root, "AGENTS.md"), `${local}\nb\nc\n`);
      assert.equal(await mergeSync(rpc.ctx, { ...options, yes: false }, () => f.backend), "cancelled");
      assert.deepEqual(await artifactNames(f.config), []);
      assert.equal(syncStateFingerprint(await readStateForConfig(f.config)), state);
      assert.deepEqual(await f.backend.readHead(), head);
      assert.equal(await readMergeJournal(f.config), undefined);
    }
    assert.equal(publication.mock.calls.length, 0);
    await mergeSync(f.context.ctx, options, () => f.backend);
    const retained = await artifactNames(f.config);
    const accepted = syncStateFingerprint(await readStateForConfig(f.config));
    await publish(f, { "AGENTS.md": "NEW REMOTE\nb\nc\n", "prompts/safe.md": "new incoming\n" });
    assert.equal(await mergeSync(rpc.ctx, { ...options, yes: false }, () => f.backend), "cancelled");
    assert.deepEqual(await artifactNames(f.config), retained);
    assert.equal(syncStateFingerprint(await readStateForConfig(f.config)), accepted);
  }));

for (const changed of ["local", "remote"] as const)
  test(`approved partial review rejects stale ${changed} before persisting artifacts`, async () =>
    withTempHome(async (root) => {
      const f = await fixture(root);
      await fs.writeFile(path.join(root, "AGENTS.md"), "LOCAL\nb\nc\n");
      await publish(f, { "AGENTS.md": "REMOTE\nb\nc\n", "prompts/safe.md": "incoming\n" });
      const state = syncStateFingerprint(await readStateForConfig(f.config));
      const rpc = createMockContext({
        mode: "rpc",
        hasUI: true,
        select: async (_title: string, choices: string[]) => {
          if (choices.includes("Next")) return "Next";
          if (changed === "local") await fs.writeFile(path.join(root, "AGENTS.md"), "newer local");
          else await publish(f, { "AGENTS.md": "newer remote" });
          return choices.find((choice) => choice.startsWith("Yes,"));
        },
      });
      await assert.rejects(
        mergeSync(rpc.ctx, { ...options, yes: false }, () => f.backend),
        /changed during review/,
      );
      assert.deepEqual(await artifactNames(f.config), []);
      assert.equal(syncStateFingerprint(await readStateForConfig(f.config)), state);
      assert.equal(await readMergeJournal(f.config), undefined);
    }));

test("automatic transfer refuses partial conflicts without publication, apply, state or artifacts", async () =>
  withTempHome(async (root) => {
    const f = await fixture(root);
    const settings = JSON.parse(await fs.readFile(localConfigPath(), "utf8"));
    settings.syncSetups.home.sync.automaticTransfer = true;
    await fs.writeFile(localConfigPath(), JSON.stringify(settings));
    await fs.writeFile(path.join(root, "AGENTS.md"), "LOCAL\nb\nc\n");
    await publish(f, { "AGENTS.md": "REMOTE\nb\nc\n", "prompts/safe.md": "incoming\n" });
    const head = await f.backend.readHead();
    const publication = vi.spyOn(f.backend, "publishSnapshot");
    await assert.rejects(
      mergeSync(f.context.ctx, { ...options, auto: true }, () => f.backend),
      /require review/,
    );
    assert.equal(publication.mock.calls.length, 0);
    assert.deepEqual(await f.backend.readHead(), head);
    assert.equal(syncStateFingerprint(await readStateForConfig(f.config)), syncStateFingerprint(f.state));
    assert.equal(await fs.readFile(path.join(root, "prompts/safe.md"), "utf8"), "base\n");
    assert.deepEqual(await artifactNames(f.config), []);
    assert.equal(await readMergeJournal(f.config), undefined);
  }));

for (const source of ["local", "remote"] as const)
  test(`effective external session root protects prefix merge and reviewed ${source} resolution`, async () =>
    withTempHome(async (root) => {
      const f = await fixture(root);
      const external = path.join(path.dirname(root), "external-sessions");
      await fs.mkdir(external, { recursive: true });
      const manager = SessionManager.inMemory(root);
      manager.appendMessage({ role: "system", content: "instructions", timestamp: 1 });
      manager.appendMessage({ role: "user", content: "base", timestamp: 2 });
      const log = () =>
        Buffer.from(`${[manager.getHeader(), ...manager.getEntries()].map((row) => JSON.stringify(row)).join("\n")}\n`);
      const base = log();
      manager.appendMessage({ role: "user", content: "remote suffix", timestamp: 3 });
      const remote = log();
      manager.appendMessage({ role: "user", content: "local suffix", timestamp: 4 });
      const local = log();
      const activeFile = path.join(external, "active.jsonl");
      await fs.writeFile(activeFile, base);
      await fs.writeFile(path.join(root, "settings.json"), JSON.stringify({ sessionDir: external }));
      const settings = JSON.parse(await fs.readFile(localConfigPath(), "utf8"));
      settings.syncSetups.home.sync.include.push("sessions");
      await fs.writeFile(localConfigPath(), JSON.stringify(settings));
      await push(f.context.ctx, { ...options, force: true }, undefined, () => f.backend);
      const config = await loadConfig();
      const baseline = await readStateForConfig(config);
      const oldHead = await f.backend.readHead();
      assert.ok(oldHead);
      const before = await f.backend.readSnapshot(oldHead.snapshotRef);
      assert.ok(before.files.some((file) => file.path === "sessions/active.jsonl"));
      await fs.writeFile(activeFile, local);
      await f.backend.publishSnapshot(
        {
          ...before,
          id: "active-both-changed",
          files: before.files.map((file) =>
            file.path === "sessions/active.jsonl" ? snapshotFile(file.path, remote) : file,
          ),
        },
        expectedRemoteHead(oldHead),
      );
      const loaded = SessionManager.create(root);
      loaded.setSessionFile(activeFile);
      assert.equal(loaded.usesDefaultSessionDir(), true);
      const ctx = createMockContext({ hasUI: true, sessionManager: loaded }).ctx;
      await mergeSync(ctx, options, () => f.backend);
      const state = await readStateForConfig(config);
      assert.equal(state.lastFileHashes["sessions/active.jsonl"], baseline.lastFileHashes["sessions/active.jsonl"]);
      assert.deepEqual(await fs.readFile(activeFile), local);
      const head = await f.backend.readHead();
      assert.ok(head);
      assert.equal(
        (await f.backend.readSnapshot(head.snapshotRef)).files.find((file) => file.path === "sessions/active.jsonl")
          ?.sha256,
        snapshotFile("sessions/active.jsonl", remote).sha256,
      );
      const group = state.unresolved?.find((item) => item.paths.includes("sessions/active.jsonl"));
      assert.ok(group);
      const artifact = await readConflictArtifact(config, f.backend.identity, group.artifact);
      const publication = vi.spyOn(f.backend, "publishSnapshot");
      await assert.rejects(
        mergeSync(ctx, options, () => f.backend, {
          token: group.artifact,
          group: artifact.groups.findIndex((item) => item.paths.includes("sessions/active.jsonl")),
          source,
          stateIdentity: syncStateFingerprint(state),
          artifactIdentity: conflictArtifactFingerprint(artifact),
        }),
        /Current session conflict/,
      );
      assert.equal(publication.mock.calls.length, 0);
      assert.deepEqual(await fs.readFile(activeFile), local);
      assert.deepEqual(await f.backend.readHead(), head);
      assert.equal(syncStateFingerprint(await readStateForConfig(config)), syncStateFingerprint(state));
    }));

for (const paths of [
  ["legacy/Foo.md", "legacy/foo.md"],
  ["legacy/item", "legacy/item/child.md"],
  ["AGENTS.md", "agents.md"],
] as const)
  test(`partial sync rejects unmanaged/cross-policy collision ${paths.join(" / ")} without deleting remote bytes`, async () =>
    withTempHome(async (root) => {
      const f = await fixture(root);
      const originalHead = await f.backend.readHead();
      assert.ok(originalHead);
      const original = await f.backend.readSnapshot(originalHead.snapshotRef);
      const remote = {
        ...original,
        id: "unmanaged-collision",
        files: [
          ...original.files.filter((file) => !new Set<string>(paths).has(file.path)),
          ...paths.map((filePath, index) => snapshotFile(filePath, Buffer.from(`retained ${index}\n`))),
        ],
      };
      const head = (await f.backend.publishSnapshot(remote, expectedRemoteHead(originalHead))).head;
      await fs.writeFile(path.join(root, "prompts/safe.md"), "independent local\n");
      const publication = vi.spyOn(f.backend, "publishSnapshot");
      await assert.rejects(
        mergeSync(f.context.ctx, options, () => f.backend),
        /path collisions/,
      );
      assert.equal(publication.mock.calls.length, 0);
      assert.deepEqual(await f.backend.readHead(), head);
      assert.deepEqual(await f.backend.readSnapshot(head.snapshotRef), remote);
      assert.equal(syncStateFingerprint(await readStateForConfig(f.config)), syncStateFingerprint(f.state));
      assert.deepEqual(await artifactNames(f.config), []);
      assert.equal(await readMergeJournal(f.config), undefined);
    }));

for (const source of ["local", "remote"] as const)
  test(`large reviewed group indexes selected ${source} versions once`, async () =>
    withTempHome(async (root) => {
      const f = await fixture(root);
      const head = await f.backend.readHead();
      assert.ok(head);
      const common = await f.backend.readSnapshot(head.snapshotRef);
      const paths = Array.from({ length: 4096 }, (_, index) => `prompts/${index}.md`);
      const versions = (value: string) => ({
        ...common,
        files: paths.map((path) => snapshotFile(path, Buffer.from(value))),
      });
      const base = versions("base\n");
      const local = versions("ours\n");
      const remote = versions("theirs\n");
      const previous = { ...f.state, lastFileHashes: fileHashMap(base) };
      const token = await saveConflictArtifact(
        f.config,
        f.backend.identity,
        {
          state: previous,
          local,
          remote,
          groups: [{ paths, reasons: ["both-changed"] }],
          observed: { snapshotId: head.snapshotId, revision: head.revision },
        },
        () => {},
      );
      const artifact = await readConflictArtifact(f.config, f.backend.identity, token);
      const state = {
        ...previous,
        lastObservedSnapshot: head.snapshotId,
        lastObservedRevision: head.revision,
        unresolved: [{ paths, artifact: token }],
      };
      const plan = planFileMerge({
        baseline: previous.lastFileHashes,
        local: local.files,
        remote: remote.files,
        selectionCompatible: true,
      });
      const selected = source === "local" ? local : remote;
      const find = vi.spyOn(selected.files, "find").mockImplementation(() => {
        throw new Error("per-decision array scan");
      });
      try {
        const result = await resolveReviewedGroup(
          f.config,
          f.backend,
          state,
          local,
          remote,
          head,
          plan,
          {
            token,
            group: 0,
            source,
            stateIdentity: syncStateFingerprint(state),
            artifactIdentity: conflictArtifactFingerprint(artifact),
          },
          new Set(),
        );
        assert.equal(result.kind, "planned");
        if (result.kind === "planned") {
          assert.equal(result.conflicts.length, 0);
          assert.equal(result.decisions.length, paths.length);
          for (const decision of result.decisions) {
            assert.equal(decision.kind, "accepted");
            if (decision.kind === "accepted") assert.equal(decision.file?.sha256, selected.files[0]?.sha256);
          }
        }
      } finally {
        find.mockRestore();
      }
    }));

test("partial sync preserves an absent portable-field policy across snapshot-v3 decoding", async () =>
  withTempHome(async (root) => {
    const f = await fixture(root, false);
    const config = await loadConfig();
    assert.equal(config.localFields, undefined);
    await fs.writeFile(path.join(root, "AGENTS.md"), "LOCAL\nb\nc\n");
    await publish(f, { "AGENTS.md": "REMOTE\nb\nc\n" });
    await mergeSync(f.context.ctx, options, () => f.backend);
    const head = await f.backend.readHead();
    assert.ok(head);
    const raw = await f.backend.readSnapshot(head.snapshotRef);
    assert.equal(raw.version, 3);
    assert.equal(raw.localFields, undefined);
    const { encodeSnapshot, decodeSnapshot } = await import("../src/snapshot/snapshot-codec.js");
    const decoded = await decodeSnapshot(await encodeSnapshot(raw));
    assert.equal(decoded.localFields, undefined);
    await mergeSync(f.context.ctx, options, () => f.backend);
    assert.equal((await readStateForConfig(config)).unresolved?.length, 1);
  }));
