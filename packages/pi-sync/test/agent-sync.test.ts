import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { test } from "vitest";
import { loadConfig } from "../src/settings/config.js";
import { localConfigPath } from "../src/settings/config-file.js";
import { withStateDirectoryAccess } from "../src/state/state-directory.js";
import { readStateForConfig } from "../src/state/sync-state-store.js";
import { readMergeJournal } from "../src/sync/merge-journal.js";
import { syncBoth } from "../src/sync/sync-mutations.js";
import { agentContext, selectRemote } from "./agent-test-helpers.js";
import { withTempHome } from "./helpers.js";
import { createMergeFixture, mergeOptions } from "./merged-sync-fixture.js";

for (const legacy of [false, true])
  test(`manual conflicts are reviewed without model work (legacy flags=${legacy})`, () =>
    withTempHome(async (root) => {
      const f = await createMergeFixture(root);
      const settings = JSON.parse(await fs.readFile(localConfigPath(), "utf8"));
      Object.assign(settings.syncSetups.home.sync, { agentMode: legacy, continuous: legacy });
      await fs.writeFile(localConfigPath(), JSON.stringify(settings));
      await fs.writeFile(path.join(root, "AGENTS.md"), "local\n");
      await f.remoteEdit("AGENTS.md", "remote\n");
      const config = await loadConfig();
      const before = await readStateForConfig(config);
      const head = await f.backend.readHead();
      const mock = agentContext(selectRemote);
      await assert.rejects(
        withStateDirectoryAccess(() => syncBoth(mock.ctx, mergeOptions, () => f.backend)),
        /review/u,
      );
      assert.equal(mock.requests.length, 0);
      assert.deepEqual(await f.backend.readHead(), head);
      assert.deepEqual(await readStateForConfig(config), before);
      assert.equal(await fs.readFile(path.join(root, "AGENTS.md"), "utf8"), "local\n");
      assert.equal(await readMergeJournal(config), undefined);
      await assert.rejects(fs.stat(path.join(root, "pi-sync/agent-resolver")), { code: "ENOENT" });
    }));
