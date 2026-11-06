import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { test } from "vitest";
import { createMockContext } from "../../../test/support.js";
import { loadConfig } from "../src/settings/config.js";
import { localConfigPath } from "../src/settings/config-file.js";
import { regenerateSnapshotIdentity } from "../src/snapshot/snapshot.js";
import { readStateForConfig, syncStateFingerprint } from "../src/state/sync-state-store.js";
import { applyMergedSnapshot, preflightMergedTargets } from "../src/sync/merge-apply.js";
import { readMergeJournal } from "../src/sync/merge-journal.js";
import { push, syncBoth } from "../src/sync/sync-mutations.js";
import { snapshot, v3S3Settings } from "./helpers.js";
import { MemorySyncBackend } from "./memory-sync-backend.js";
import { mergeOptions } from "./merge-options.js";
import { withSnapshotQueueRoot } from "./snapshot-queue-fixture.js";

for (const operation of ["preflight", "apply"] as const)
  test(`merged ${operation} refuses aliased local targets without changing bytes`, async () =>
    withSnapshotQueueRoot(true, async (root) => {
      const target = path.join(root, "AGENTS.md");
      await fs.writeFile(target, "before");
      const before = snapshot([{ path: "AGENTS.md", content: Buffer.from("before") }]);
      const after = snapshot([{ path: "AGENTS.md", content: Buffer.from("after") }]);
      const options = { include: ["AGENTS.md"] };
      await assert.rejects(
        operation === "preflight"
          ? preflightMergedTargets(before, after, options)
          : applyMergedSnapshot(before, after, new Set(), options, async () => {}),
        /aliased parent.*canonical agent\/session path/u,
      );
      assert.equal(await fs.readFile(target, "utf8"), "before");
    }));

test("autonomous merged sync rejects an aliased local apply before remote publication", async () =>
  withSnapshotQueueRoot(true, async (root) => {
    await fs.mkdir(path.join(root, "prompts"));
    const settings = v3S3Settings({ include: ["AGENTS.md", "prompts"] });
    Object.assign(settings.syncSetups.home.sync, { agentMode: true });
    await fs.writeFile(localConfigPath(), JSON.stringify(settings), { mode: 0o600 });
    await fs.writeFile(path.join(root, "AGENTS.md"), "base instructions");
    await fs.writeFile(path.join(root, "prompts/demo.md"), "base prompt");
    const { ctx } = createMockContext({ mode: "rpc" });
    const backend = new MemorySyncBackend();
    await push(ctx, mergeOptions, undefined, () => backend);
    const baselineHead = await backend.readHead();
    assert.ok(baselineHead);
    const current = await backend.readSnapshot(baselineHead.snapshotRef);
    await backend.publishSnapshot(
      regenerateSnapshotIdentity({
        ...current,
        files: [
          ...current.files.filter((file) => file.path !== "prompts/demo.md"),
          ...snapshot([{ path: "prompts/demo.md", content: Buffer.from("remote prompt") }]).files,
        ],
      }),
      { kind: "revision", revision: baselineHead.revision },
    );
    await fs.writeFile(path.join(root, "AGENTS.md"), "local instructions");
    const config = await loadConfig();
    const head = await backend.readHead();
    const state = syncStateFingerprint(await readStateForConfig(config));

    await assert.rejects(
      syncBoth(ctx, mergeOptions, () => backend),
      /aliased parent/u,
    );

    assert.deepEqual(await backend.readHead(), head);
    assert.equal(syncStateFingerprint(await readStateForConfig(config)), state);
    assert.equal(await readMergeJournal(config), undefined);
    assert.equal(await fs.readFile(path.join(root, "AGENTS.md"), "utf8"), "local instructions");
    assert.equal(await fs.readFile(path.join(root, "prompts/demo.md"), "utf8"), "base prompt");
  }));
