import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { beforeAll, test } from "vitest";
import { loadConfig } from "../src/settings/config.js";
import { withStateDirectoryAccess } from "../src/state/state-directory.js";
import { readStateForConfig } from "../src/state/sync-state-store.js";
import { withAgentSyncLock } from "../src/sync/agent-sync.js";
import { syncBoth } from "../src/sync/sync-mutations.js";
import { enableAgentMode } from "./agent-refusal-test-helpers.js";
import { agentContext, selectRemote } from "./agent-test-helpers.js";
import { withTempHome } from "./helpers.js";
import { createMergeFixture, mergeOptions } from "./merged-sync-fixture.js";

beforeAll(async () => {
  await import("../src/sync/agent-runner.js");
});

test("retry with only unsupported partial conflicts cannot transfer independent changes without review", async () =>
  withTempHome(async (agentDir) => {
    const fixture = await createMergeFixture(agentDir);
    await enableAgentMode(true);
    await fs.mkdir(path.join(agentDir, "prompts"), { recursive: true });
    await fs.writeFile(path.join(agentDir, "prompts", "script.ts"), "local script\n");
    await fixture.remoteEdit("prompts/script.ts", "remote script\n");
    await fixture.remoteEdit("settings.json", '{"theme":"remote"}');
    const config = await loadConfig();
    const state = await readStateForConfig(config);
    const head = await fixture.backend.readHead();
    const mock = agentContext(selectRemote);
    let reviews = 0;
    mock.ctx.ui.select = async () => {
      reviews++;
      return "Yes, Send one fresh request";
    };
    await assert.rejects(
      withStateDirectoryAccess(() =>
        withAgentSyncLock(mock.ctx, { ...mergeOptions, agentRetryRefusal: true }, (options) =>
          syncBoth(mock.ctx, options, () => fixture.backend),
        ),
      ),
      /No eligible cached refusal/,
    );
    assert.equal(reviews, 0);
    assert.equal(mock.requests.length, 0);
    assert.deepEqual(await readStateForConfig(config), state);
    assert.deepEqual(await fixture.backend.readHead(), head);
    assert.equal(await fs.readFile(path.join(agentDir, "settings.json"), "utf8"), '{"theme":"original"}\n');
  }));

for (const unsupported of ["unsafe settings", "script"] as const)
  for (const partial of [false, true])
    test(`preflight mixed text/${unsupported}, partial sync ${partial}`, async () =>
      withTempHome(async (agentDir) => {
        const fixture = await createMergeFixture(agentDir);
        await enableAgentMode(partial);
        await fs.writeFile(path.join(agentDir, "AGENTS.md"), "local\n");
        await fixture.remoteEdit("AGENTS.md", "remote\n");
        if (unsupported === "unsafe settings") {
          await fs.writeFile(path.join(agentDir, "settings.json"), '{"x":9007199254740993}');
          await fixture.remoteEdit("settings.json", '{"x":2}');
        } else {
          await fs.mkdir(path.join(agentDir, "prompts"), { recursive: true });
          await fs.writeFile(path.join(agentDir, "prompts", "script.ts"), "local script\n");
          await fixture.remoteEdit("prompts/script.ts", "remote script\n");
        }
        const head = await fixture.backend.readHead();
        const state = await readStateForConfig(await loadConfig());
        let reservations = 0;
        const mock = agentContext(selectRemote);
        const run = () =>
          withStateDirectoryAccess(() =>
            withAgentSyncLock(
              mock.ctx,
              {
                ...mergeOptions,
                auto: true,
                background: {
                  validate: () => {},
                  reserve: async () => {
                    reservations++;
                  },
                },
              },
              (options) => syncBoth(mock.ctx, options, () => fixture.backend),
            ),
          );
        if (partial) {
          assert.equal(await run(), "applied");
          assert.equal(mock.requests.length, 1);
          assert.equal(reservations, 1);
          assert.equal(await fs.readFile(path.join(agentDir, "AGENTS.md"), "utf8"), "remote\n");
          assert.ok((await readStateForConfig(await loadConfig())).unresolved?.length);
        } else {
          await assert.rejects(run(), /unsupported/);
          assert.equal(mock.requests.length, 0);
          assert.equal(reservations, 0);
          assert.equal(await fs.readFile(path.join(agentDir, "AGENTS.md"), "utf8"), "local\n");
          assert.deepEqual(await fixture.backend.readHead(), head);
          assert.deepEqual(await readStateForConfig(await loadConfig()), state);
        }
      }));
