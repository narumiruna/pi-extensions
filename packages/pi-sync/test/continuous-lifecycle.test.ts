import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { test, vi } from "vitest";
import { createMockContext, createMockPi } from "../../../test/support.js";
import { piDaemonClient } from "../src/daemon/pi-client.js";
import { createContinuousSync } from "../src/sync/continuous-sync.js";
import { agentContext, selectRemote } from "./agent-test-helpers.js";
import { continuousLoaders, enableContinuous, fakeContinuousTime, waitStatus } from "./continuous-test-helpers.js";
import { withTempHome } from "./helpers.js";
import { createMergeFixture } from "./merged-sync-fixture.js";
import { deferred } from "./startup-check-helpers.js";

for (const boundary of ["agent_start", "session_start", "session_shutdown", "foreground"] as const)
  test(`daemon controller drains and releases ownership at ${boundary}`, async () =>
    withTempHome(async (agentDir) => {
      const f = await createMergeFixture(agentDir);
      await enableContinuous();
      await fs.writeFile(path.join(agentDir, "AGENTS.md"), "local\n");
      await f.remoteEdit("AGENTS.md", "remote\n");
      let idle = true;
      const ready = deferred();
      const context = agentContext(
        async () => {
          ready.resolve();
          return new Promise<string>(() => {});
        },
        { isIdle: () => idle },
      );
      const service = createContinuousSync(continuousLoaders(f.backend));
      const lifetime = new AbortController();
      fakeContinuousTime();
      try {
        service.start(context.ctx, lifetime.signal);
        await ready.promise;
        const options = context.requestOptions[0] as { signal: AbortSignal };
        assert.equal(options.signal.aborted, false);
        const sibling = createMockContext({ mode: "rpc" });
        await service.stop((sibling.ctx as import("@earendil-works/pi-coding-agent").ExtensionContext).sessionManager);
        assert.equal(options.signal.aborted, false, "an unrelated manager cannot stop the owner");
        idle = false;
        if (boundary === "session_start" || boundary === "session_shutdown") lifetime.abort();
        await service.stop(context.ctx.sessionManager);
        assert.equal(options.signal.aborted, true);
        assert.equal(context.requests.length, 1);
        for (const owned of ["continuous/scheduler.lock", "agent-resolver/claim.json"])
          await assert.rejects(fs.stat(path.join(agentDir, "pi-sync", owned)), /ENOENT/u);
        assert.equal(await fs.readFile(path.join(agentDir, "AGENTS.md"), "utf8"), "local\n");
      } finally {
        lifetime.abort();
        await service.stop();
        vi.useRealTimers();
      }
    }));

test("one daemon cycle per start and fresh authorization on each idle resume", async () =>
  withTempHome(async (agentDir) => {
    const f = await createMergeFixture(agentDir);
    await enableContinuous();
    const context = agentContext(selectRemote);
    let checks = 0;
    const loaders = continuousLoaders(f.backend);
    const inspection = loaders.inspection;
    loaders.inspection = async () => {
      const module = await inspection();
      return {
        inspectSync: (...args) => {
          checks++;
          return module.inspectSync(...args);
        },
      };
    };
    const service = createContinuousSync(loaders);
    const signal = new AbortController().signal;
    fakeContinuousTime();
    try {
      for (let cycle = 1; cycle <= 3; cycle++) {
        service.start(context.ctx, signal);
        await waitStatus(context.statuses, /waiting for changes/u);
        assert.equal(checks, cycle);
        await service.stop(context.ctx.sessionManager);
        assert.equal(context.statuses.get("sync"), undefined);
      }
      assert.equal(context.requests.length, 0);
    } finally {
      await service.stop();
      assert.equal(vi.getTimerCount(), 0);
      vi.useRealTimers();
    }
  }));

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

test("lease loss aborts the actual provider request and rejects stale ownership", async () =>
  withTempHome(async (agentDir) => {
    const f = await createMergeFixture(agentDir);
    await enableContinuous();
    await fs.writeFile(path.join(agentDir, "AGENTS.md"), "local\n");
    await f.remoteEdit("AGENTS.md", "remote\n");
    const ready = deferred();
    const context = agentContext(async () => {
      ready.resolve();
      return new Promise<string>(() => {});
    });
    const { createContinuousSync } = await import("../src/sync/continuous-sync.js");
    const { continuousLoaders, advanceContinuous } = await import("./continuous-test-helpers.js");
    const service = createContinuousSync(continuousLoaders(f.backend));
    fakeContinuousTime();
    try {
      service.start(context.ctx, new AbortController().signal);
      await ready.promise;
      const guard = path.join(agentDir, "pi-sync/continuous/scheduler.lock");
      await fs.rename(guard, `${guard}.old`);
      await fs.mkdir(guard);
      const newTime = new Date(Date.now() + 1000);
      await fs.utimes(guard, newTime, newTime);
      await advanceContinuous(11_000);
      await vi.waitFor(() => assert.equal((context.requestOptions[0] as { signal: AbortSignal }).signal.aborted, true));
      await service.stop();
      assert.equal((await fs.stat(guard)).isDirectory(), true, "old cleanup retained the successor guard");
      assert.equal(await fs.readFile(path.join(agentDir, "AGENTS.md"), "utf8"), "local\n");
    } finally {
      await service.stop();
      vi.useRealTimers();
    }
  }));
