import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { pushSessionsOnShutdown } from "@narumitw/pi-sync-daemon/engine/sync/session-push";
import { test, vi } from "vitest";
import { loadConfig } from "../src/settings/config.js";
import { localConfigPath } from "../src/settings/config-file.js";
import { readStateForConfig, writeStateForConfig } from "../src/state/sync-state-store.js";
import { conflictDirectory } from "../src/sync/conflict-artifacts.js";
import { mergeSync } from "../src/sync/merged-sync.js";
import { pull, push, rollback } from "../src/sync/sync-mutations.js";
import { createEngineTestLoaders as createSyncLoaders } from "./engine-loaders.js";
import { withTempHome } from "./helpers.js";
import { fixture, options } from "./partial-sync-fixture.js";

async function pendingFixture(root: string) {
  const f = await fixture(root);
  const settings = JSON.parse(await fs.readFile(localConfigPath(), "utf8"));
  Object.assign(settings.syncSetups.home.sync, {
    automatic: true,
    include: ["settings.json", "AGENTS.md", "prompts", "sessions"],
  });
  await fs.writeFile(localConfigPath(), JSON.stringify(settings));
  await fs.mkdir(path.join(root, "sessions/project"), { recursive: true });
  await fs.writeFile(path.join(root, "sessions/project/session.jsonl"), "session bytes\n");
  await push(f.context.ctx, { ...options, force: true }, undefined, () => f.backend);
  const config = await loadConfig();
  await mergeSync(f.context.ctx, options, () => f.backend);
  const baseline = await readStateForConfig(config);
  // A local-only collision leaves the complete remote hash map equal to the old baseline.
  await fs.writeFile(path.join(root, "prompts/Foo.md"), "upper private version\n");
  await fs.writeFile(path.join(root, "prompts/foo.md"), "lower private version\n");
  await mergeSync(f.context.ctx, options, () => f.backend);
  const state = await readStateForConfig(config);
  assert.ok(state.unresolved?.length);
  assert.deepEqual(state.lastFileHashes, baseline.lastFileHashes);
  return { ...f, config, state };
}

for (const route of ["push", "pull", "rollback"] as const)
  for (const force of [false, true])
    test(`${route} ${force ? "force" : "non-force"} retains unresolved progress unless it is an explicit supported direction`, async ({
      skip,
    }) =>
      withTempHome(async (root) => {
        // Real alias layout only applies to case-sensitive filesystems.
        const probe = path.join(root, "CaseProbe");
        await fs.mkdir(root, { recursive: true });
        await fs.writeFile(probe, "probe");
        if (
          await fs.access(path.join(root, "caseprobe")).then(
            () => true,
            () => false,
          )
        )
          return skip();
        await fs.rm(probe);
        const f = await pendingFixture(root);
        const head = await f.backend.readHead();
        const evidence = await fs.readdir(conflictDirectory(f.config));
        const publish = vi.spyOn(f.backend, "publishSnapshot");
        const command = { ...options, force, args: route === "rollback" ? [f.state.lastAppliedSnapshot ?? ""] : [] };
        const run = () =>
          route === "push"
            ? push(f.context.ctx, command, undefined, () => f.backend)
            : route === "pull"
              ? pull(f.context.ctx, command, () => f.backend)
              : rollback(f.context.ctx, command, () => f.backend);
        if (force && route !== "rollback") {
          await run();
          assert.equal((await readStateForConfig(f.config)).unresolved, undefined);
        } else {
          await assert.rejects(run(), /Unresolved partial conflicts/);
          assert.deepEqual(await f.backend.readHead(), head);
          assert.equal(publish.mock.calls.length, 0);
          assert.deepEqual(await readStateForConfig(f.config), f.state);
          assert.deepEqual(await fs.readdir(conflictDirectory(f.config)), evidence);
          assert.equal(await fs.readFile(path.join(root, "prompts/Foo.md"), "utf8"), "upper private version\n");
          assert.equal(await fs.readFile(path.join(root, "prompts/foo.md"), "utf8"), "lower private version\n");
        }
      }));

for (const force of [false, true])
  test(`automatic push cannot clear unresolved progress with force=${force}`, async () =>
    withTempHome(async (root) => {
      const f = await fixture(root);
      const state = {
        ...f.state,
        version: 3,
        unresolved: [{ paths: ["AGENTS.md"], artifact: "00000000-0000-0000-0000-000000000000" }],
      };
      await writeStateForConfig(f.config, state);
      const publish = vi.spyOn(f.backend, "publishSnapshot");
      await assert.rejects(
        push(f.context.ctx, { ...options, auto: true, force }, undefined, () => f.backend),
        /Unresolved partial conflicts/,
      );
      assert.equal(publish.mock.calls.length, 0);
      assert.deepEqual(await readStateForConfig(f.config), state);
    }));

test("shutdown session push keeps local-only conflicts even when remote accepted hashes match", async ({ skip }) =>
  withTempHome(async (root) => {
    await fs.mkdir(root, { recursive: true });
    await fs.writeFile(path.join(root, "CaseProbe"), "probe");
    if (
      await fs.access(path.join(root, "caseprobe")).then(
        () => true,
        () => false,
      )
    )
      return skip();
    await fs.rm(path.join(root, "CaseProbe"));
    const f = await pendingFixture(root);
    const head = await f.backend.readHead();
    const publish = vi.spyOn(f.backend, "publishSnapshot");
    const operations = await import("@narumitw/pi-sync-daemon/engine/sync/sync-operations");
    const loaders = createSyncLoaders({
      loadSyncOperations: async () => ({
        ...operations,
        push: (ctx, command, input) =>
          push(ctx, command, input ? { ...input, backend: f.backend } : undefined, () => f.backend),
      }),
    });
    await assert.rejects(
      pushSessionsOnShutdown(f.context.ctx, { ...options, signal: new AbortController().signal }, loaders),
      /Unresolved partial conflicts/u,
    );
    assert.equal(publish.mock.calls.length, 0);
    assert.deepEqual(await f.backend.readHead(), head);
    assert.deepEqual(await readStateForConfig(f.config), f.state);
  }));

test("push rechecks unresolved progress added during its remote observation", async () =>
  withTempHome(async (root) => {
    const f = await fixture(root);
    await fs.writeFile(path.join(root, "AGENTS.md"), "local edit\n");
    const state = {
      ...f.state,
      version: 3,
      unresolved: [{ paths: ["AGENTS.md"], artifact: "00000000-0000-0000-0000-000000000000" }],
    };
    const read = f.backend.readHead.bind(f.backend);
    const observer = vi.spyOn(f.backend, "readHead").mockImplementation(async (...args) => {
      const head = await read(...args);
      await writeStateForConfig(f.config, state);
      return head;
    });
    const publish = vi.spyOn(f.backend, "publishSnapshot");
    try {
      await assert.rejects(
        push(f.context.ctx, options, undefined, () => f.backend),
        /Unresolved partial conflicts/,
      );
    } finally {
      observer.mockRestore();
    }
    assert.equal(publish.mock.calls.length, 0);
    assert.deepEqual(await readStateForConfig(f.config), state);
  }));
