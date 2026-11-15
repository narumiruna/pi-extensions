import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { test, vi } from "vitest";
import { createMockContext } from "../../../test/support.js";
import { loadConfig } from "../src/settings/config.js";
import { localConfigPath } from "../src/settings/config-file.js";
import type { PiSyncSettingsV3 } from "../src/settings/settings-types.js";
import { readSyncIgnoreFile } from "../src/settings/sync-ignore-file.js";
import { applySnapshot } from "../src/snapshot/snapshot-apply.js";
import type { Snapshot } from "../src/snapshot/snapshot-types.js";
import { readStateForConfig } from "../src/state/sync-state-store.js";
import { inspectCaseCleanup } from "../src/sync/apply-review.js";
import { push, rollback } from "../src/sync/sync-mutations.js";
import { snapshot, v3S3Settings, withTempHome } from "./helpers.js";
import { MemorySyncBackend } from "./memory-sync-backend.js";
import { mergeOptions } from "./merge-options.js";
import { caseInsensitiveLookup } from "./snapshot-queue-fixture.js";

function policySnapshot(rules: string, files: Array<{ path: string; content: Buffer }> = []): Snapshot {
  return {
    ...snapshot([{ path: ".syncignore", content: Buffer.from(rules) }, ...files]),
    version: 4,
    selection: { version: 2, ignore: rules },
  };
}

for (const kind of ["legacy-absent", "legacy-selection", "different-ignore", "same-ignore"] as const)
  test(`rollback history ${kind} preserves the active policy before any refused mutation`, async () =>
    withTempHome(async (root) => {
      await fs.mkdir(root, { recursive: true });
      const settings = v3S3Settings() as unknown as PiSyncSettingsV3;
      settings.version = 6;
      delete settings.syncSetups.home?.sync.include;
      const rules = "/sessions/\n";
      await fs.writeFile(localConfigPath(), JSON.stringify(settings));
      await fs.writeFile(path.join(root, ".syncignore"), rules);
      await fs.writeFile(path.join(root, "settings.json"), '{"current":true}\n');
      const files = [{ path: "settings.json", content: Buffer.from('{"history":true}\n') }];
      const history: Snapshot =
        kind === "same-ignore" || kind === "different-ignore"
          ? policySnapshot(kind === "same-ignore" ? rules : "", files)
          : {
              ...snapshot(files),
              ...(kind === "legacy-selection"
                ? { selection: { version: 1 as const, include: ["settings.json"] } }
                : {}),
            };
      const backend = new MemorySyncBackend();
      await backend.publishSnapshot(history, { kind: "missing" });
      const { ctx } = createMockContext({ mode: "tui" });
      await push(ctx, { ...mergeOptions, force: true }, undefined, () => backend);
      const head = await backend.readHead();
      const state = await readStateForConfig(await loadConfig());
      if (kind === "same-ignore") {
        await rollback(ctx, { ...mergeOptions, args: [history.id] }, () => backend);
        assert.equal(await fs.readFile(path.join(root, "settings.json"), "utf8"), '{"history":true}\n');
      } else {
        await assert.rejects(
          rollback(ctx, { ...mergeOptions, args: [history.id], force: true }, () => backend),
          /historical .syncignore policy/,
        );
        assert.equal(await fs.readFile(path.join(root, "settings.json"), "utf8"), '{"current":true}\n');
        assert.deepEqual(await backend.readHead(), head);
        assert.deepEqual(await readStateForConfig(await loadConfig()), state);
      }
      assert.equal(await readSyncIgnoreFile(), rules);
    }));

for (const ignored of [true, false])
  test(`directional apply retains exact case-sensitive paths, ignored lower name=${ignored}`, async () =>
    withTempHome(async (root) => {
      await fs.mkdir(root, { recursive: true });
      const rules = ignored ? "/notes.md\n/sessions/\n" : "/sessions/\n";
      await fs.writeFile(path.join(root, ".syncignore"), rules);
      if (ignored) await fs.writeFile(path.join(root, "notes.md"), "private local");
      const files = [
        { path: "Notes.md", content: Buffer.from("remote upper") },
        ...(!ignored ? [{ path: "notes.md", content: Buffer.from("remote lower") }] : []),
      ];
      const remote = policySnapshot(rules, files);
      assert.deepEqual(await inspectCaseCleanup(remote), []);
      await applySnapshot(remote, new Set(), { syncIgnore: rules });
      assert.equal(await fs.readFile(path.join(root, "Notes.md"), "utf8"), "remote upper");
      assert.equal(await fs.readFile(path.join(root, "notes.md"), "utf8"), ignored ? "private local" : "remote lower");
    }));

test("directional apply refuses an ignored physical case alias on a case-insensitive filesystem", async () =>
  withTempHome(async (root) => {
    await fs.mkdir(root, { recursive: true });
    const rules = "/notes.md\n/sessions/\n";
    await fs.writeFile(path.join(root, ".syncignore"), rules);
    await fs.writeFile(path.join(root, "notes.md"), "private local");
    const restore = await caseInsensitiveLookup(root);
    try {
      await assert.rejects(
        applySnapshot(policySnapshot(rules, [{ path: "Notes.md", content: Buffer.from("remote") }]), new Set(), {
          syncIgnore: rules,
        }),
        /preimage changed/,
      );
      assert.equal(await fs.readFile(path.join(root, "notes.md"), "utf8"), "private local");
      assert.equal(await readSyncIgnoreFile(), rules);
    } finally {
      restore();
    }
  }));

for (const extra of ["ignored-file", "denied-file", "symlink", "ignored-directory", "none"] as const)
  test(`directory replacement protects unselected descendants: ${extra}`, async () =>
    withTempHome(async (root) => {
      await fs.mkdir(path.join(root, "folder"), { recursive: true });
      const rules = "/sessions/\n/folder/private.txt\n/folder/empty-private/\n";
      await fs.writeFile(path.join(root, ".syncignore"), rules);
      await fs.writeFile(path.join(root, "folder/public.txt"), "selected");
      if (extra === "ignored-file") await fs.writeFile(path.join(root, "folder/private.txt"), "private");
      if (extra === "denied-file") await fs.writeFile(path.join(root, "folder/auth.json"), "credentials");
      if (extra === "symlink") await fs.symlink(path.join(root, "missing"), path.join(root, "folder/link"));
      if (extra === "ignored-directory") await fs.mkdir(path.join(root, "folder/empty-private"));
      const remote = policySnapshot(rules, [{ path: "folder", content: Buffer.from("replacement") }]);
      const apply = () => applySnapshot(remote, new Set(), { syncIgnore: rules });
      if (extra === "none") {
        await apply();
        assert.equal(await fs.readFile(path.join(root, "folder"), "utf8"), "replacement");
      } else {
        await assert.rejects(apply(), /ignored or unselected descendants/);
        assert.equal(await fs.readFile(path.join(root, "folder/public.txt"), "utf8"), "selected");
        if (extra === "ignored-file")
          assert.equal(await fs.readFile(path.join(root, "folder/private.txt"), "utf8"), "private");
        if (extra === "denied-file")
          assert.equal(await fs.readFile(path.join(root, "folder/auth.json"), "utf8"), "credentials");
      }
    }));

test("an ignored file added during transaction capture cannot be deleted with its ancestor", async () =>
  withTempHome(async (root) => {
    const folder = path.join(root, "folder");
    await fs.mkdir(folder, { recursive: true });
    const rules = "/sessions/\n/folder/private.txt\n";
    await fs.writeFile(path.join(root, ".syncignore"), rules);
    await fs.writeFile(path.join(folder, "public.txt"), "selected");
    const original = fs.cp;
    let raced = false;
    const spy = vi.spyOn(fs, "cp").mockImplementation(async (...args) => {
      if (String(args[0]) === folder && !raced) {
        raced = true;
        await fs.writeFile(path.join(folder, "private.txt"), "new private bytes");
      }
      return original(...args);
    });
    try {
      await assert.rejects(
        applySnapshot(policySnapshot(rules, [{ path: "folder", content: Buffer.from("replacement") }]), new Set(), {
          syncIgnore: rules,
        }),
        /preimage changed/,
      );
      assert.equal(raced, true);
      assert.equal(await fs.readFile(path.join(folder, "private.txt"), "utf8"), "new private bytes");
      assert.equal(await fs.readFile(path.join(folder, "public.txt"), "utf8"), "selected");
    } finally {
      spy.mockRestore();
    }
  }));
