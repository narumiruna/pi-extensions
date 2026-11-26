import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { test } from "vitest";
import { createMockPi } from "../../../test/support.js";
import { piDaemonClient } from "../src/daemon/pi-client.js";
import { agentContext, selectRemote } from "./agent-test-helpers.js";
import { enableContinuous } from "./continuous-test-helpers.js";
import { withTempHome } from "./helpers.js";
import { createMergeFixture } from "./merged-sync-fixture.js";

test("Help cannot bypass a failed startup recovery barrier or mark its IPC client ready", async () =>
  withTempHome(async (agentDir) => {
    await createMergeFixture(agentDir);
    await enableContinuous();
    await fs.mkdir(path.join(agentDir, ".pisync"));
    const context = agentContext(selectRemote);
    const mock = createMockPi();
    const { default: extension } = await import("../src/sync-extension.js");
    extension(mock.pi);
    try {
      await mock.events.get("session_start")?.[0]?.({ reason: "startup" }, context.ctx);
      assert.ok(context.notifications.some((item) => item.message.startsWith("pi-sync recovery required")));
      await mock.commands.get("sync")?.handler("help", context.ctx);
      assert.equal((await piDaemonClient(context.ctx).connect()).facts.ready, false);
      assert.equal(context.requests.length, 0);
      await assert.rejects(fs.stat(path.join(agentDir, "pi-sync/continuous/scheduler.lock")), /ENOENT/u);
    } finally {
      await mock.events.get("session_shutdown")?.[0]?.({ reason: "reload" }, context.ctx);
    }
  }));
