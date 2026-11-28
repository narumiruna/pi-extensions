import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { test, vi } from "vitest";
import { createMockContext } from "../../../test/support.js";
import { updateSyncSetup } from "../src/settings/settings-management.js";
import { readStateForConfig, writeStateForConfig } from "../src/state/sync-state-store.js";
import { inspectCaseCleanup } from "../src/sync/apply-review.js";
import { pull, push, rollback } from "../src/sync/sync-mutations.js";
import { history } from "../src/sync/sync-queries.js";
import { describeManagerState } from "../src/ui/manager-state.js";
import { formatApplyPreview, formatPublicationPreview, formatPushSummary } from "../src/ui/sync-format.js";
import { transferChanges, transferCounts } from "../src/ui/transfer-changes.js";
import { snapshot, withTempHome } from "./helpers.js";
import { createMergeFixture, mergeOptions } from "./merged-sync-fixture.js";

test("Last applied uses an opaque compact ID and History retains the full ID even without remote history", async () =>
  withTempHome(async (root) => {
    const f = await createMergeFixture(root);
    const full = `opaque-${"reference-".repeat(10)}`;
    await writeStateForConfig(f.config, { ...(await readStateForConfig(f.config)), lastAppliedSnapshot: full });
    const summary = await describeManagerState();
    assert.ok(summary.title.split("\n").includes(`Last applied snapshot: ${full.slice(0, 39)}…`));
    const context = createMockContext({ mode: "rpc" });
    const listing = vi.spyOn(f.backend, "listHistory").mockResolvedValue([]);
    try {
      await history(context.ctx, mergeOptions, () => f.backend);
      assert.ok(context.notifications.some((entry) => entry.message.includes(full)));
      assert.match(context.notifications[0]?.message ?? "", /Application time: unavailable/);
    } finally {
      listing.mockRestore();
    }
  }));

for (const direction of ["pull", "rollback"] as const) {
  for (const change of ["cancel", "edit", "new alias", "remove alias", "symlink"] as const) {
    test(`${direction} reviews and revalidates case cleanup: ${change}`, async ({ skip }) =>
      withTempHome(async (root) => {
        if (process.platform === "win32") {
          skip();
          return;
        }
        const f = await createMergeFixture(root);
        const alias = path.join(root, "SETTINGS.JSON");
        try {
          if (change === "symlink") await fs.symlink("private-target-value", alias);
          else await fs.writeFile(alias, "private alias bytes", { flag: "wx" });
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "EEXIST") {
            skip();
            return;
          }
          throw error;
        }
        if (!(await fs.readdir(root)).includes("SETTINGS.JSON")) {
          skip();
          return;
        }
        const stateBefore = await readStateForConfig(f.config);
        const beforeHead = await f.backend.readHead();
        let body = "";
        const context = createMockContext({
          mode: "rpc",
          confirm: async (_title: string, value: string) => {
            body = value;
            if (change === "edit") await fs.writeFile(alias, "newer alias bytes");
            if (change === "new alias") await fs.writeFile(path.join(root, "Settings.Json"), "new alias");
            if (change === "remove alias") await fs.unlink(alias);
            return change !== "cancel" && change !== "symlink";
          },
        });
        const options = { ...mergeOptions, yes: false, force: true, args: [f.baseHead.snapshotRef] };
        const operation =
          direction === "pull"
            ? pull(context.ctx, options, () => f.backend)
            : rollback(context.ctx, options, () => f.backend);
        if (change === "cancel" || change === "symlink") await operation;
        else await assert.rejects(operation, /Case-variant paths changed during transfer review/);
        assert.match(body, /Changes: 0 add · 0 update · 1 remove/);
        assert.match(body, /Remove locally: SETTINGS.JSON/);
        assert.match(body, /Case-variant aliases/);
        assert.doesNotMatch(body, /private alias bytes|private-target-value/);
        assert.deepEqual(await f.backend.readHead(), beforeHead);
        assert.deepEqual(await readStateForConfig(f.config), stateBefore);
        assert.equal(await fs.readFile(path.join(root, "settings.json"), "utf8"), '{"theme":"original"}\n');
      }));
  }
}

test("case-cleanup inspection closes its file handle after cancellation", async ({ skip }) =>
  withTempHome(async (root) => {
    const f = await createMergeFixture(root);
    try {
      await fs.writeFile(path.join(root, "SETTINGS.JSON"), "alias", { flag: "wx" });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        skip();
        return;
      }
      throw error;
    }
    const owner = new AbortController();
    const open = fs.open.bind(fs);
    let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
    const opening = vi.spyOn(fs, "open").mockImplementation(async (...args) => {
      handle = await open(...args);
      owner.abort(new DOMException("Session replaced", "AbortError"));
      return handle;
    });
    try {
      await assert.rejects(inspectCaseCleanup(f.base, { signal: owner.signal }), { name: "AbortError" });
      assert.ok(handle);
      await assert.rejects(handle.stat(), /closed|bad file descriptor|EBADF/iu);
    } finally {
      opening.mockRestore();
    }
  }));

const image = (files: Record<string, string>) =>
  snapshot(Object.entries(files).map(([path, content]) => ({ path, content: Buffer.from(content) })));

for (const [name, before, after, protectedPaths, expected] of [
  ["unchanged", { a: "same" }, { a: "same" }, [], { add: 0, update: 0, remove: 0 }],
  ["empty remote", undefined, { a: "new" }, [], { add: 1, update: 0, remove: 0 }],
  [
    "all directions",
    { a: "old", b: "gone", keep: "same" },
    { a: "new", c: "added", keep: "same" },
    [],
    { add: 1, update: 1, remove: 1 },
  ],
  [
    "protected replacement",
    { live: "old", a: "old" },
    { live: "new", a: "new" },
    ["live"],
    { add: 0, update: 1, remove: 0 },
  ],
  ["protected deletion", { live: "keep" }, {}, ["live"], { add: 0, update: 0, remove: 0 }],
  ["protected addition", {}, { live: "remote" }, ["live"], { add: 0, update: 0, remove: 0 }],
  [
    "preserved or withheld",
    { preserved: "same", withheld: "remote" },
    { preserved: "same", withheld: "remote", accepted: "merged" },
    [],
    { add: 1, update: 0, remove: 0 },
  ],
] as const) {
  test(`directional preview counts ${name}`, () => {
    const changes = transferChanges(before ? image(before) : undefined, image(after), new Set(protectedPaths));
    assert.deepEqual(transferCounts(changes), expected);
    assert.equal(changes.length, expected.add + expected.update + expected.remove);
    for (const protectedPath of protectedPaths)
      assert.equal(
        changes.some((change) => change.path === protectedPath),
        false,
      );
  });
}

test("directional details distinguish local removals from active-snapshot publication", () => {
  const before = image({ "old.md": "gone", "sessions/live.jsonl": "local" });
  const after = image({ "new.md": "added", "sessions/live.jsonl": "remote" });
  const local = formatApplyPreview(before, after, new Set(["sessions/live.jsonl"]));
  assert.match(local, /Changes: 1 add · 0 update · 1 remove/);
  assert.match(local, /Remove locally: old.md/);
  assert.doesNotMatch(local, /sessions\/live/);
  assert.match(formatPublicationPreview(before, after), /Changes: 1 add · 1 update · 1 remove/);
});

test("push review does not claim disabled secret scanning ran or history was erased", async () =>
  withTempHome(async (root) => {
    const f = await createMergeFixture(root);
    const text = formatPushSummary(
      { ...f.config, skipSecretScan: true },
      "exact destination",
      image({}),
      f.baseHead,
      0,
      f.base,
    );
    assert.match(text, /Direction: Local → Remote/);
    assert.match(text, /possible-secret scanning is disabled/);
    assert.match(text, /retained history is not erased/);
    assert.doesNotMatch(text, /secrets were scanned/);
  }));

for (const direction of ["push", "pull", "rollback"] as const) {
  for (const mutation of ["local bytes", "settings", "baseline", "remote head", "cancel"] as const) {
    test(`${direction} does not reuse review after ${mutation}`, async () =>
      withTempHome(async (root) => {
        const f = await createMergeFixture(root);
        await fs.writeFile(path.join(root, "AGENTS.md"), "reviewed local\n");
        if (direction === "pull") await f.remoteEdit("AGENTS.md", "reviewed remote\n");
        const stateBefore = await readStateForConfig(f.config);
        let expectedHead = await f.backend.readHead();
        let expectedBytes = "reviewed local\n";
        let reviews = 0;
        const context = createMockContext({
          mode: "rpc",
          confirm: async (_title: string, body: string) => {
            reviews++;
            assert.match(body, /Direction:/);
            assert.match(body, /Changes:/);
            if (mutation === "cancel") return false;
            if (mutation === "local bytes") {
              expectedBytes = "newer local edit\n";
              await fs.writeFile(path.join(root, "AGENTS.md"), expectedBytes);
            } else if (mutation === "settings") {
              await updateSyncSetup("home", (setup) => ({
                ...setup,
                sync: { ...setup.sync, automatic: !setup.sync.automatic },
              }));
            } else if (mutation === "baseline") {
              await writeStateForConfig(f.config, { ...stateBefore, lastAppliedSnapshot: "different-baseline" });
            } else {
              // Force push must show the refreshed plan, not reuse the first approval.
              if (reviews > 1) return false;
              await f.remoteEdit("AGENTS.md", "newer remote edit\n");
              expectedHead = await f.backend.readHead();
            }
            return true;
          },
        });
        const options = {
          ...mergeOptions,
          yes: false,
          force: true,
          args: direction === "rollback" ? [f.baseHead.snapshotRef] : [],
        };
        const operation =
          direction === "push"
            ? push(context.ctx, options, undefined, () => f.backend)
            : direction === "pull"
              ? pull(context.ctx, options, () => f.backend)
              : rollback(context.ctx, options, () => f.backend);
        if (mutation === "cancel" || (direction === "push" && mutation === "remote head")) await operation;
        else
          await assert.rejects(
            operation,
            /changed during .*review|Local bytes changed|Remote changed|Baseline changed/iu,
          );
        assert.equal(await fs.readFile(path.join(root, "AGENTS.md"), "utf8"), expectedBytes);
        assert.deepEqual(await f.backend.readHead(), expectedHead);
        assert.deepEqual(
          await readStateForConfig(f.config),
          mutation === "baseline" ? { ...stateBefore, lastAppliedSnapshot: "different-baseline" } : stateBefore,
        );
        assert.equal(reviews, direction === "push" && mutation === "remote head" ? 2 : 1);
      }));
  }
}

test("interactive push previews the actual remote before-image even when baseline matches", async () =>
  withTempHome(async (root) => {
    const f = await createMergeFixture(root);
    await fs.writeFile(path.join(root, "AGENTS.md"), "updated\n");
    let body = "";
    const context = createMockContext({
      mode: "rpc",
      confirm: async (_title: string, value: string) => {
        body = value;
        return false;
      },
    });
    assert.equal(await push(context.ctx, { ...mergeOptions, yes: false }, undefined, () => f.backend), "cancelled");
    assert.match(body, /Changes: 0 add · 1 update · 0 remove/);
    assert.match(body, /Update remotely: AGENTS.md/);
    assert.doesNotMatch(body, /Add remotely:/);
  }));
