import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { test } from "vitest";
import { createMockContext, createMockPi } from "../../../test/support.js";
import { withTempHome } from "./helpers.js";

for (const failure of ["coexisting", "symlink", "non-directory"] as const) {
  for (const mode of ["tui", "rpc"] as const) {
    test(`${mode} recovery help bypasses ${failure} roots without allowing stateful work`, async () => {
      await withTempHome(async (agentDir) => {
        await fs.mkdir(agentDir, { recursive: true });
        const canonical = path.join(agentDir, "pi-sync");
        const legacy = path.join(agentDir, ".pisync");
        if (failure === "coexisting") {
          await fs.mkdir(canonical);
          await fs.mkdir(legacy);
        } else if (failure === "symlink") {
          await fs.mkdir(legacy);
          await fs.symlink(legacy, canonical, "dir");
        } else await fs.writeFile(canonical, "not a directory");
        const before = await fs.readdir(agentDir);
        const { default: sync } = await import("../src/sync-extension.js");
        let loads = 0;
        const forbidden = async (): Promise<never> => {
          loads++;
          throw new Error("must not load");
        };
        const mock = createMockPi();
        sync(mock.pi, { loadSyncInspection: forbidden, loadSyncOperations: forbidden });
        const context = createMockContext({ mode });
        await mock.events.get("session_start")?.[0]?.({}, context.ctx);
        await mock.commands.get("sync")?.handler("push --yes", context.ctx);
        assert.match(context.notifications.at(-1)?.message ?? "", /Use \/sync help/u);
        await mock.commands.get("sync")?.handler("help", context.ctx);
        assert.match(context.notifications.at(-1)?.message ?? "", /Usage: \/sync/u);
        await mock.commands.get("sync")?.handler("help extra", context.ctx);
        assert.equal(context.notifications.at(-1)?.level, "error");
        await assert.rejects(async () => {
          await mock.commands.get("sync")?.handler("unlock --stale", context.ctx);
        });
        await mock.events.get("session_shutdown")?.[0]?.({ reason: "exit" }, context.ctx);
        assert.equal(loads, 0);
        assert.deepEqual(await fs.readdir(agentDir), before);
      });
    });
  }
}
