import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import {
  DirectionalDestinationConflict,
  DirectionalReviewChangedError,
  needsDirectionalForce,
} from "@narumitw/pi-sync-daemon/engine/sync/directional-conflict";
import { pull, push } from "@narumitw/pi-sync-daemon/engine/sync/sync-operations";
import { test, vi } from "vitest";
import { createMockContext } from "../../../test/support.js";
import { readStateForConfig } from "../src/state/sync-state-store.js";
import { snapshot, withTempHome } from "./helpers.js";
import { createMergeFixture, mergeOptions } from "./merged-sync-fixture.js";

const image = (paths: Record<string, string>) =>
  snapshot(Object.entries(paths).map(([path, text]) => ({ path, content: Buffer.from(text) })));

for (const [name, base, destination, candidate, protectedPaths, conflict] of [
  ["update at destination", { "AGENTS.md": "base" }, { "AGENTS.md": "changed" }, { "AGENTS.md": "base" }, [], true],
  ["addition at destination", {}, { "AGENTS.md": "new" }, {}, [], true],
  ["deletion at destination", { "AGENTS.md": "base" }, {}, { "AGENTS.md": "base" }, [], true],
  ["same concurrent edit", { "AGENTS.md": "base" }, { "AGENTS.md": "same" }, { "AGENTS.md": "same" }, [], false],
  ["source-only edit", { "AGENTS.md": "base" }, { "AGENTS.md": "base" }, { "AGENTS.md": "changed" }, [], false],
  ["protected destination", {}, { "AGENTS.md": "kept" }, {}, ["AGENTS.md"], false],
] as const) {
  test(`the destination guard distinguishes ${name}`, () =>
    withTempHome(async (root) => {
      const { config } = await createMergeFixture(root);
      const lastFileHashes = Object.fromEntries(image(base).files.map(({ path, sha256 }) => [path, sha256]));
      const state = { version: 1, profile: config.snapshotIdentity, lastFileHashes, lastAppliedSnapshot: "base" };
      const before = image(destination);
      const after = image(candidate);
      const protectedSet = new Set<string>(protectedPaths);
      assert.equal(needsDirectionalForce("reject-conflicts", config, state, before, after, protectedSet), conflict);
      if (conflict)
        assert.equal(needsDirectionalForce("review-force", config, state, before, after, protectedSet), true);
      else
        assert.throws(
          () => needsDirectionalForce("review-force", config, state, before, after, protectedSet),
          /no longer has a content conflict/u,
        );
    }));
}

test("first sync can seed an empty destination but cannot force an unaccepted one", () =>
  withTempHome(async (root) => {
    const { config } = await createMergeFixture(root);
    const state = { version: 1, profile: config.snapshotIdentity, lastFileHashes: {} };
    const proposed = image({ "AGENTS.md": "new" });
    const different = image({ "AGENTS.md": "not yet accepted" });
    const protectedPaths = new Set<string>();
    assert.equal(needsDirectionalForce("reject-conflicts", config, state, undefined, proposed, protectedPaths), false);
    assert.equal(needsDirectionalForce("reject-conflicts", config, state, proposed, proposed, protectedPaths), false);
    for (const intent of ["reject-conflicts", "review-force"] as const)
      assert.throws(
        () => needsDirectionalForce(intent, config, state, different, proposed, protectedPaths),
        /no accepted sync baseline/u,
      );
  }));

test("Force push requires a fresh preview if the remote head moves after approval", () =>
  withTempHome(async (root) => {
    const f = await createMergeFixture(root);
    await f.remoteEdit("AGENTS.md", "first remote change");
    const accepted = await readStateForConfig(f.config);
    let commits = 0;
    let moved = false;
    const { ctx } = createMockContext({
      mode: "rpc",
      select: async (_title: string, choices: string[]) => {
        const approve = choices.find((choice) => choice.startsWith("Yes, "));
        if (approve) {
          moved = true;
          await f.remoteEdit("AGENTS.md", "second remote change");
        }
        return approve;
      },
    });
    await assert.rejects(
      push(
        ctx,
        {
          ...mergeOptions,
          yes: false,
          reload: false,
          directionalAction: { intent: "review-force", validate() {} },
          onCommit: () => {
            commits += 1;
          },
        },
        undefined,
        () => f.backend,
      ),
      DirectionalReviewChangedError,
    );
    assert.equal(moved, true);
    assert.equal(commits, 0);
    assert.deepEqual(await readStateForConfig(f.config), accepted);
  }));

for (const direction of ["push", "pull"] as const) {
  test(`${direction} refuses to write or advance state on a destination-only change`, () =>
    withTempHome(async (root) => {
      const f = await createMergeFixture(root);
      const target = path.join(root, "AGENTS.md");
      if (direction === "push") await f.remoteEdit("AGENTS.md", "remote-only edit");
      else await fs.writeFile(target, "local-only edit");
      const bytes = await fs.readFile(target);
      const head = await f.backend.readHead();
      const state = await readStateForConfig(f.config);
      let commits = 0;
      const options = {
        ...mergeOptions,
        yes: false,
        reload: false,
        onCommit: () => {
          commits += 1;
        },
        directionalAction: { intent: "reject-conflicts" as const, validate() {} },
      };
      const run =
        direction === "push" ? push(f.ctx, options, undefined, () => f.backend) : pull(f.ctx, options, () => f.backend);
      await assert.rejects(run, DirectionalDestinationConflict);
      assert.equal(commits, 0);
      assert.deepEqual(await fs.readFile(target), bytes);
      assert.deepEqual(await f.backend.readHead(), head);
      assert.deepEqual(await readStateForConfig(f.config), state);
      await assert.rejects(fs.access(path.join(root, "pi-sync/backups")), { code: "ENOENT" });
    }));
}

for (const change of ["edit", "delete", "remote", "backup failure"] as const) {
  test(`reviewed Force pull refuses a late ${change} at the backup boundary`, () =>
    withTempHome(async (root) => {
      const f = await createMergeFixture(root);
      const target = path.join(root, "AGENTS.md");
      await fs.writeFile(target, "reviewed local content");
      const before = await readStateForConfig(f.config);
      const open = fs.open.bind(fs);
      let changed = false;
      let commits = 0;
      const opening = vi.spyOn(fs, "open").mockImplementation(async (...args) => {
        if (!changed && String(args[0]).endsWith(".json.gz")) {
          changed = true;
          if (change === "edit") await fs.writeFile(target, "late edit");
          else if (change === "delete") await fs.rm(target);
          else if (change === "remote") await f.remoteEdit("AGENTS.md", "late remote edit");
          else throw new Error("backup unavailable");
        }
        return open(...args);
      });
      try {
        const { ctx } = createMockContext({
          mode: "rpc",
          select: async (_title: string, choices: string[]) => choices.find((choice) => choice.startsWith("Yes, ")),
        });
        await assert.rejects(
          pull(
            ctx,
            {
              ...mergeOptions,
              yes: false,
              reload: false,
              directionalAction: { intent: "review-force", validate() {} },
              onCommit: () => {
                commits += 1;
              },
            },
            () => f.backend,
          ),
          /changed before apply|changed before local apply|backup unavailable/u,
        );
        assert.equal(changed, true);
        assert.equal(commits, 0);
        assert.deepEqual(await readStateForConfig(f.config), before);
        if (change === "delete") await assert.rejects(fs.access(target), { code: "ENOENT" });
        else
          assert.equal(await fs.readFile(target, "utf8"), change === "edit" ? "late edit" : "reviewed local content");
      } finally {
        opening.mockRestore();
      }
    }));
}
