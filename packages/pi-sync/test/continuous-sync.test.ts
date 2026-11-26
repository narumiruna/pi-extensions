import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { test } from "vitest";
import { loadConfigForCheck } from "../src/settings/config.js";
import { continuousEnabled, createContinuousSync } from "../src/sync/continuous-sync.js";
import { agentContext, selectRemote } from "./agent-test-helpers.js";
import { continuousLoaders, enableContinuous } from "./continuous-test-helpers.js";
import { withTempHome } from "./helpers.js";
import { createMergeFixture } from "./merged-sync-fixture.js";

for (const mode of ["print", "json", "rpc", "tui"] as const)
  test(`legacy flags do not start a scheduler in ${mode}`, () =>
    withTempHome(async (root) => {
      const f = await createMergeFixture(root);
      await enableContinuous();
      const config = await loadConfigForCheck();
      assert.equal(config.agentMode, false);
      assert.equal(config.continuous, false);
      assert.equal(continuousEnabled(config), false);
      const mock = agentContext(selectRemote, { mode, hasUI: mode === "tui" || mode === "rpc" });
      const service = createContinuousSync(continuousLoaders(f.backend));
      service.start(mock.ctx, new AbortController().signal);
      await service.stop();
      await assert.rejects(fs.stat(path.join(root, "pi-sync", "continuous")), { code: "ENOENT" });
      assert.equal(mock.requests.length, 0);
    }));
