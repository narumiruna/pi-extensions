import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { test } from "vitest";
import { createContinuousSync } from "../src/sync/continuous-sync.js";
import { agentContext, selectRemote } from "./agent-test-helpers.js";
import { continuousLoaders, enableContinuous } from "./continuous-test-helpers.js";
import { withTempHome } from "./helpers.js";
import { createMergeFixture } from "./merged-sync-fixture.js";

for (const mode of ["print", "json", "rpc", "tui"] as const)
  test(`legacy flags do not start a scheduler in ${mode}`, () =>
    withTempHome(async (root) => {
      const f = await createMergeFixture(root);
      await enableContinuous();
      const mock = agentContext(selectRemote, { mode, hasUI: mode === "tui" || mode === "rpc" });
      const service = createContinuousSync(continuousLoaders(f.backend));
      service.start(mock.ctx, new AbortController().signal);
      await new Promise<void>((resolve) => setImmediate(resolve));
      await service.stop();
      await assert.rejects(fs.stat(path.join(root, "pi-sync", "continuous")), { code: "ENOENT" });
      assert.equal(mock.requests.length, 0);
    }));
