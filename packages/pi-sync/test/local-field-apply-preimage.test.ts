import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { test, vi } from "vitest";
import { createMockContext } from "../../../test/support.js";
import { loadConfig } from "../src/settings/config.js";
import { localConfigPath } from "../src/settings/config-file.js";
import { regenerateSnapshotIdentity } from "../src/snapshot/snapshot.js";
import { readStateForConfig } from "../src/state/sync-state-store.js";
import { pull, push, rollback } from "../src/sync/sync-mutations.js";
import { snapshot, v3S3Settings, withTempHome } from "./helpers.js";
import { MemorySyncBackend } from "./memory-sync-backend.js";
import { mergeOptions as options } from "./merge-options.js";

for (const route of ["pull", "rollback"] as const)
  for (const change of ["unchanged", "edit", "delete"] as const)
    test(`${route} binds noncanonical settings spelling to its reviewed preimage: ${change}`, async () =>
      withTempHome(async (root) => {
        await fs.mkdir(root, { recursive: true });
        const settings = v3S3Settings({ include: ["settings.json"] });
        Object.assign(settings.syncSetups.home.sync, { localFields: ["machine"] });
        await fs.writeFile(localConfigPath(), JSON.stringify({ ...settings, version: 4 }));
        const canonical = path.join(root, "settings.json");
        const original = path.join(root, "Settings.json");
        await fs.writeFile(canonical, '{"theme":"base","machine":"private"}');
        const { ctx } = createMockContext({ hasUI: true });
        const backend = new MemorySyncBackend();
        await push(ctx, options, undefined, () => backend);
        await fs.rename(canonical, original);
        const config = await loadConfig();
        const state = await readStateForConfig(config);
        const previous = await backend.readHead();
        assert.ok(previous);
        const base = await backend.readSnapshot(previous.snapshotRef);
        const head = (
          await backend.publishSnapshot(
            regenerateSnapshotIdentity({
              ...base,
              files: snapshot([{ path: "settings.json", content: Buffer.from('{"theme":"remote"}') }]).files,
            }),
            { kind: "revision", revision: previous.revision },
          )
        ).head;
        const copy = fs.copyFile.bind(fs);
        let changed = false;
        const spy = vi.spyOn(fs, "copyFile").mockImplementation(async (...args) => {
          if (!changed && String(args[0]) === original && change !== "unchanged") {
            changed = true;
            if (change === "delete") await fs.rm(original);
            else await fs.writeFile(original, '{"theme":"base","machine":"newer-private"}');
          }
          return copy(...args);
        });
        try {
          const operation =
            route === "pull"
              ? pull(ctx, options, () => backend)
              : rollback(
                  ctx as Parameters<typeof rollback>[0],
                  { ...options, args: [head.snapshotRef] },
                  () => backend,
                );
          if (change === "unchanged") {
            await operation;
            assert.deepEqual(JSON.parse(await fs.readFile(canonical, "utf8")), { theme: "remote", machine: "private" });
            assert.equal((await fs.readdir(root)).includes("Settings.json"), false);
          } else {
            await assert.rejects(operation, /preimage|changed|newer|recovery/i);
            assert.equal(changed, true);
            if (change === "delete") await assert.rejects(fs.stat(original), { code: "ENOENT" });
            else assert.equal(await fs.readFile(original, "utf8"), '{"theme":"base","machine":"newer-private"}');
            assert.deepEqual(await readStateForConfig(config), state);
            assert.deepEqual(await backend.readHead(), head);
          }
        } finally {
          spy.mockRestore();
        }
      }));

for (const route of ["pull", "rollback"] as const)
  for (const boundary of ["backup", "commit", "before-copy", "after-copy", "journal"] as const)
    for (const change of ["edit", "delete", "create"] as const)
      test(`${route} refuses excluded-field ${change} at ${boundary}`, async () =>
        withTempHome(async (root) => {
          await fs.mkdir(root, { recursive: true });
          const settings = v3S3Settings({ include: ["settings.json", "AGENTS.md"] });
          Object.assign(settings.syncSetups.home.sync, { localFields: ["machine"] });
          await fs.writeFile(localConfigPath(), JSON.stringify({ ...settings, version: 4 }));
          const target = path.join(root, "settings.json");
          if (change !== "create") await fs.writeFile(target, '{"theme":"base","machine":"old-private"}');
          await fs.writeFile(path.join(root, "AGENTS.md"), "base instructions");
          const { ctx } = createMockContext({ hasUI: true });
          const backend = new MemorySyncBackend();
          await push(ctx, options, undefined, () => backend);
          const config = await loadConfig();
          const state = await readStateForConfig(config);
          const originalHead = await backend.readHead();
          assert.ok(originalHead);
          const original = await backend.readSnapshot(originalHead.snapshotRef);
          const remote = regenerateSnapshotIdentity({
            ...original,
            files: [
              ...original.files.filter((file) => file.path !== "settings.json"),
              ...snapshot([{ path: "settings.json", content: Buffer.from('{"theme":"remote"}\n') }]).files,
            ],
          });
          const head = (await backend.publishSnapshot(remote, { kind: "revision", revision: originalHead.revision }))
            .head;
          const newer = '{"theme":"base","machine":"newer-private"}';
          let changed = false;
          let committed = false;
          const mutate = async () => {
            if (changed) return;
            changed = true;
            if (change === "delete") await fs.rm(target);
            else await fs.writeFile(target, newer);
          };
          const open = fs.open.bind(fs);
          const copy = fs.copyFile.bind(fs);
          const rename = fs.rename.bind(fs);
          const openSpy = vi.spyOn(fs, "open").mockImplementation(async (...args) => {
            const handle = await open(...args);
            if (boundary === "backup" && String(args[0]).endsWith(".json.gz")) await mutate();
            return handle;
          });
          const copySpy = vi.spyOn(fs, "copyFile").mockImplementation(async (...args) => {
            if (committed && String(args[0]) === target && boundary === "before-copy") await mutate();
            await copy(...args);
            if (committed && String(args[0]) === target && boundary === "after-copy") await mutate();
          });
          // Missing files have no backup copy; inject their creation at transaction publication instead.
          const renameSpy = vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
            await rename(from, to);
            if (
              committed &&
              String(to).endsWith("/journal.json") &&
              (boundary === "journal" ||
                (change === "create" && (boundary === "before-copy" || boundary === "after-copy")))
            )
              await mutate();
          });
          const publish = vi.spyOn(backend, "publishSnapshot");
          try {
            const command = {
              ...options,
              onCommit: () => {
                committed = true;
              },
            };
            const lstat = fs.lstat.bind(fs);
            const statSpy = vi.spyOn(fs, "lstat").mockImplementation(async (...args) => {
              if (boundary === "commit" && committed && String(args[0]) === target) await mutate();
              return lstat(...args);
            });
            try {
              await assert.rejects(
                route === "pull"
                  ? pull(ctx, command, () => backend)
                  : rollback(
                      ctx as Parameters<typeof rollback>[0],
                      { ...command, args: [head.snapshotRef] },
                      () => backend,
                    ),
                /preimage|changed|newer|recovery/i,
              );
            } finally {
              statSpy.mockRestore();
            }
            assert.equal(changed, true);
            if (change === "delete") await assert.rejects(fs.stat(target), { code: "ENOENT" });
            else assert.equal(await fs.readFile(target, "utf8"), newer);
            assert.equal(publish.mock.calls.length, 0);
            assert.deepEqual(await readStateForConfig(config), state);
            assert.deepEqual(await backend.readHead(), head);
          } finally {
            openSpy.mockRestore();
            copySpy.mockRestore();
            renameSpy.mockRestore();
            publish.mockRestore();
          }
        }));
