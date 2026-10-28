import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { test, vi } from "vitest";
import { createMockContext } from "../../../test/support.js";
import { expectedRemoteHead } from "../src/backends/sync-backend.js";
import { loadConfig } from "../src/settings/config.js";
import { localConfigPath } from "../src/settings/config-file.js";
import { readMergeAncestor } from "../src/state/merge-baseline-store.js";
import { readStateForConfig, statePathForConfig, syncStateFingerprint } from "../src/state/sync-state-store.js";
import { pull, push, rollback } from "../src/sync/sync-mutations.js";
import { snapshot, v3S3Settings, withTempHome } from "./helpers.js";
import { MemorySyncBackend } from "./memory-sync-backend.js";
import { mergeOptions as options } from "./merge-options.js";

for (const route of ["push", "pull", "rollback-local", "rollback-remote"] as const) {
  test(`${route} completes acceptance and prunes before returning after post-commit cancellation`, async () =>
    withTempHome(async (root) => {
      await fs.mkdir(root, { recursive: true });
      await fs.writeFile(localConfigPath(), JSON.stringify(v3S3Settings()));
      await fs.writeFile(path.join(root, "settings.json"), '{"theme":"base"}');
      const { ctx } = createMockContext({ hasUI: true });
      const backend = new MemorySyncBackend();
      await push(ctx, options, undefined, () => backend);
      const config = await loadConfig();
      const directory = `${statePathForConfig(config)}.ancestors`;
      const unknown = `${"f".repeat(64)}.json`;
      await fs.writeFile(path.join(directory, unknown), "unknown evidence");
      for (let index = 0; index < 3; index++) {
        const previous = await readStateForConfig(config);
        const text = JSON.stringify({ theme: `next-${index}` });
        let target: string | undefined;
        if (route === "push") await fs.writeFile(path.join(root, "settings.json"), text);
        else {
          const result = await backend.publishSnapshot(
            { ...snapshot([{ path: "settings.json", content: Buffer.from(text) }]), id: `target-${index}` },
            expectedRemoteHead(await backend.readHead()),
          );
          target = result.head.snapshotRef;
        }
        const controller = new AbortController();
        let interrupted = false;
        const publish = backend.publishSnapshot.bind(backend);
        const rm = fs.rm.bind(fs);
        const publicationSpy = vi.spyOn(backend, "publishSnapshot").mockImplementation(async (...args) => {
          const result = await publish(...args);
          if (route === "push" || route === "rollback-remote") {
            interrupted = true;
            controller.abort();
          }
          return result;
        });
        const retirementSpy = vi.spyOn(fs, "rm").mockImplementation(async (...args) => {
          await rm(...args);
          if (
            !interrupted &&
            (route === "pull" || route === "rollback-local") &&
            /[\\/]transactions[\\/][a-f0-9-]{36}$/u.test(String(args[0]))
          ) {
            interrupted = true;
            controller.abort();
          }
        });
        try {
          const command = { ...options, signal: controller.signal };
          if (route === "push") await push(ctx, command, undefined, () => backend);
          else if (route === "pull") await pull(ctx, command, () => backend);
          else {
            assert.ok(target);
            await rollback(ctx, { ...command, args: [target] }, () => backend);
          }
        } finally {
          publicationSpy.mockRestore();
          retirementSpy.mockRestore();
        }
        assert.equal(interrupted, true);
        const state = await readStateForConfig(config);
        const head = await backend.readHead();
        assert.equal(state.lastRemoteRevision, head?.revision);
        assert.equal(await fs.readFile(path.join(root, "settings.json"), "utf8"), text);
        assert.ok(await readMergeAncestor(config, state, "settings.json"));
        assert.equal(await readMergeAncestor(config, previous, "settings.json"), undefined);
        assert.deepEqual((await fs.readdir(directory)).sort(), [unknown, `${syncStateFingerprint(state)}.json`].sort());
        assert.equal(await fs.readFile(path.join(directory, unknown), "utf8"), "unknown evidence");
      }
    }));
}

test("rollback post-local-commit continuation still rejects session replacement", async () =>
  withTempHome(async (root) => {
    await fs.mkdir(root, { recursive: true });
    await fs.writeFile(localConfigPath(), JSON.stringify(v3S3Settings()));
    await fs.writeFile(path.join(root, "settings.json"), '{"theme":"base"}');
    const { ctx } = createMockContext({ hasUI: true });
    const backend = new MemorySyncBackend();
    await push(ctx, options, undefined, () => backend);
    const config = await loadConfig();
    const state = await readStateForConfig(config);
    const target = (
      await backend.publishSnapshot(
        { ...snapshot([{ path: "settings.json", content: Buffer.from('{"theme":"old"}') }]), id: "old" },
        expectedRemoteHead(await backend.readHead()),
      )
    ).head;
    const rm = fs.rm.bind(fs);
    const spy = vi.spyOn(fs, "rm").mockImplementation(async (...args) => {
      await rm(...args);
      if (/[\\/]transactions[\\/][a-f0-9-]{36}$/u.test(String(args[0]))) {
        Object.assign(ctx, { sessionManager: { ...(ctx as ExtensionCommandContext).sessionManager } });
      }
    });
    const publication = vi.spyOn(backend, "publishSnapshot");
    try {
      await assert.rejects(
        rollback(ctx, { ...options, args: [target.snapshotRef] }, () => backend),
        /Session changed/,
      );
      assert.equal(publication.mock.calls.length, 0);
      assert.deepEqual(await readStateForConfig(config), state);
      assert.deepEqual(await backend.readHead(), target);
    } finally {
      spy.mockRestore();
      publication.mockRestore();
    }
  }));
