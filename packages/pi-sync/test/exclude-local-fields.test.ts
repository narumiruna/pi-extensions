import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { test, vi } from "vitest";
import { createMockContext } from "../../../test/support.js";
import { loadConfig } from "../src/settings/config.js";
import { localConfigPath } from "../src/settings/config-file.js";
import { applySnapshot } from "../src/snapshot/snapshot-apply.js";
import { readStateForConfig } from "../src/state/sync-state-store.js";
import { pull, rollback } from "../src/sync/sync-mutations.js";
import { selectionForSnapshot } from "../src/sync/sync-policy.js";
import { snapshot, v3S3Settings, withTempHome } from "./helpers.js";
import { MemorySyncBackend } from "./memory-sync-backend.js";
import { mergeOptions } from "./merge-options.js";

for (const operation of ["pull", "forced pull", "rollback"] as const)
  for (const rule of ["settings.json", "**/settings.json", "SETTINGS.JSON"])
    test(`${operation} keeps excluded settings outside local-field preimage checks: ${rule}`, async () =>
      withTempHome(async (root) => {
        await fs.mkdir(root, { recursive: true });
        const include = ["settings.json", "AGENTS.md"];
        const settings = v3S3Settings({ include });
        settings.version = 6;
        Object.assign(settings.syncSetups.home.sync, { exclude: [rule], localFields: ["shellPath"] });
        await fs.writeFile(localConfigPath(), JSON.stringify(settings), { mode: 0o600 });
        // Pi can still read session-root metadata. Sync must not change these excluded bytes.
        const excludedBytes = '{ "shellPath" : "/private/bin/sh", "private" : "unchanged" }\n';
        const excludedPath = path.join(root, "settings.json");
        await fs.writeFile(excludedPath, excludedBytes);
        await fs.writeFile(path.join(root, "AGENTS.md"), "local instructions\n");
        const backend = new MemorySyncBackend();
        const remote = {
          ...snapshot([{ path: "AGENTS.md", content: Buffer.from("remote instructions\n") }]),
          version: 4,
          selection: selectionForSnapshot(include, [rule]),
          localFields: ["shellPath"],
        };
        await backend.publishSnapshot(remote, { kind: "missing" });
        const { ctx } = createMockContext({ mode: "rpc", hasUI: true });
        if (operation === "rollback") await rollback(ctx, { ...mergeOptions, args: [remote.id] }, () => backend);
        else await pull(ctx, { ...mergeOptions, force: operation === "forced pull" }, () => backend);
        assert.equal(await fs.readFile(excludedPath, "utf8"), excludedBytes);
        assert.equal(await fs.readFile(path.join(root, "AGENTS.md"), "utf8"), "remote instructions\n");
        const state = await readStateForConfig(await loadConfig());
        assert.equal(Object.hasOwn(state.lastFileHashes, "settings.json"), false);
        assert.deepEqual(state.exclude, [rule]);
      }));

for (const stale of [false, true])
  test(`included-file preimages remain enforced when an excluded preimage is present: stale=${stale}`, async () =>
    withTempHome(async (root) => {
      await fs.mkdir(root, { recursive: true });
      const privatePath = path.join(root, "settings.json");
      await fs.writeFile(privatePath, "excluded bytes\n");
      const original = snapshot([{ path: "AGENTS.md", content: Buffer.from("reviewed instructions\n") }]);
      await fs.writeFile(path.join(root, "AGENTS.md"), "reviewed instructions\n");
      const incoming = snapshot([{ path: "AGENTS.md", content: Buffer.from("new instructions\n") }]);
      const read = vi.spyOn(fs, "readFile");
      try {
        const run = () =>
          applySnapshot(incoming, new Set(), {
            include: ["settings.json", "AGENTS.md"],
            exclude: ["*.json"],
            expectedFileHashes: {
              "settings.json": null,
              "AGENTS.md": stale ? null : (original.files[0]?.sha256 ?? null),
            },
          });
        if (stale) await assert.rejects(run(), /Reviewed file preimage changed before apply/);
        else await run();
        assert.ok(read.mock.calls.every(([file]) => String(file) !== privatePath));
      } finally {
        read.mockRestore();
      }
      assert.equal(await fs.readFile(privatePath, "utf8"), "excluded bytes\n");
      assert.equal(
        await fs.readFile(path.join(root, "AGENTS.md"), "utf8"),
        stale ? "reviewed instructions\n" : "new instructions\n",
      );
    }));
