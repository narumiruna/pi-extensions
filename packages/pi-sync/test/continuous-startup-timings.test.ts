import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { test } from "vitest";
import { createMockContext, createMockPi } from "../../../test/support.js";
import { localConfigPath } from "../src/settings/config-file.js";
import { localConfigTemplate, updateLocalConfig } from "../src/settings/settings-store.js";
import { type ContinuousClock, createContinuousSync } from "../src/sync/continuous-sync.js";
import { STARTUP_TIMING_ENTRY, type StartupTimingEntry } from "../src/ui/startup-timings-entry.js";
import { agentContext, selectRemote } from "./agent-test-helpers.js";
import {
  continuousDependencies,
  continuousLoaders,
  enableContinuous,
  requiredHome,
  waitStatus,
} from "./continuous-test-helpers.js";
import { withTempHome } from "./helpers.js";
import { createMergeFixture } from "./merged-sync-fixture.js";
import { deferred } from "./startup-check-helpers.js";

function reports(
  context: Pick<ReturnType<typeof createMockContext>, "notifications">,
  mock?: ReturnType<typeof createMockPi>,
) {
  return [
    ...context.notifications.map((item) => item.message),
    ...(mock?.entries
      .filter((entry) => entry.customType === STARTUP_TIMING_ENTRY)
      .map((entry) => (entry.data as StartupTimingEntry).report) ?? []),
  ].filter((message) => message.startsWith("pi-sync debug: continuous startup"));
}

for (const [debug, mode] of [
  [true, "tui"],
  [true, "rpc"],
  [false, "tui"],
  [false, "rpc"],
  [true, "print"],
  [true, "json"],
] as const) {
  test(`continuous startup debug=${debug} in ${mode} reports only through supported UI`, async () =>
    withTempHome(async (agentDir) => {
      const f = await createMergeFixture(agentDir);
      await enableContinuous();
      await updateLocalConfig((settings) => ({ ...settings, debug }));
      const before = await fs.readFile(localConfigPath());
      const mock = createMockPi();
      const context = agentContext(selectRemote, { mode });
      const { default: extension } = await import("../src/sync-extension.js");
      extension(mock.pi, continuousDependencies(f.backend));
      try {
        await mock.events.get("session_start")?.[0]?.({ reason: "reload" }, context.ctx);
        const supported = mode === "tui" || mode === "rpc";
        if (supported) await waitStatus(context.statuses, /waiting for changes/);
        const output = reports(context, mock);
        assert.equal(output.length, debug && supported ? 1 : 0);
        assert.equal(mock.entries.length, debug && mode === "tui" ? 2 : 0);
        if (debug && supported) {
          for (const stage of [
            "inspection import",
            "inspection and guards",
            "backend initialization",
            "local snapshot",
            "sync state read",
            "remote head",
          ])
            assert.ok(output[0]?.includes(`${stage}:`), output[0]);
          assert.match(output[0] ?? "", /\(completed\).*total:/su);
          assert.doesNotMatch(output[0] ?? "", /access-key|secret-key|settings\.json|example\.r2/u);
        }
        assert.deepEqual(await fs.readFile(localConfigPath()), before);
        assert.deepEqual(mock.sentMessages, []);
        assert.deepEqual(mock.sentUserMessages, []);
        assert.equal(context.requests.length, 0);
      } finally {
        await mock.events.get("session_shutdown")?.[0]?.({ reason: "reload" }, context.ctx);
      }
    }));
}

test("idle resumes and foreground pauses do not repeat a session's continuous startup report", async () =>
  withTempHome(async (agentDir) => {
    const f = await createMergeFixture(agentDir);
    await enableContinuous();
    await updateLocalConfig((settings) => ({ ...settings, debug: true }));
    const mock = createMockPi();
    const context = agentContext(selectRemote, { mode: "tui" });
    const { default: extension } = await import("../src/sync-extension.js");
    extension(mock.pi, continuousDependencies(f.backend));
    try {
      await mock.events.get("session_start")?.[0]?.({}, context.ctx);
      await waitStatus(context.statuses, /waiting for changes/);
      assert.equal(reports(context, mock).length, 1);
      await mock.events.get("agent_start")?.[0]?.({}, context.ctx);
      await mock.events.get("agent_settled")?.[0]?.({}, context.ctx);
      await waitStatus(context.statuses, /waiting for changes/);
      await mock.commands.get("sync")?.handler("help", context.ctx);
      await waitStatus(context.statuses, /waiting for changes/);
      assert.equal(reports(context, mock).length, 1);
    } finally {
      await mock.events.get("session_shutdown")?.[0]?.({ reason: "reload" }, context.ctx);
    }
  }));

for (const initialDebug of [false, true]) {
  test(`first same-session Continuous activation retains startup debug=${initialDebug}`, async () =>
    withTempHome(async (agentDir) => {
      const f = await createMergeFixture(agentDir);
      await enableContinuous();
      await updateLocalConfig((settings) => {
        settings.debug = initialDebug;
        Object.assign(requiredHome(settings).sync, {
          automatic: false,
          automaticTransfer: false,
          agentMode: false,
          continuous: false,
        });
        return settings;
      });
      const mock = createMockPi();
      const context = agentContext(selectRemote);
      const { default: extension } = await import("../src/sync-extension.js");
      extension(mock.pi, continuousDependencies(f.backend));
      try {
        await mock.events.get("session_start")?.[0]?.({}, context.ctx);
        assert.equal(context.notifications.length, initialDebug ? 1 : 0, "only local initialization runs while Off");
        await updateLocalConfig((settings) => {
          settings.debug = !initialDebug;
          Object.assign(requiredHome(settings).sync, { agentMode: true, continuous: true });
          return settings;
        });
        await mock.commands.get("sync")?.handler("help", context.ctx);
        await waitStatus(context.statuses, /waiting for changes/);
        assert.equal(reports(context).length, initialDebug ? 1 : 0);
      } finally {
        await mock.events.get("session_shutdown")?.[0]?.({ reason: "reload" }, context.ctx);
      }
    }));
}

for (const initialDebug of [false, true]) {
  test(`an empty startup catalog retains debug=${initialDebug} when its first Continuous setup is added`, async () =>
    withTempHome(async (agentDir) => {
      const f = await createMergeFixture(agentDir);
      await enableContinuous();
      const configured = JSON.parse(await fs.readFile(localConfigPath(), "utf8"));
      await updateLocalConfig(() => ({ ...localConfigTemplate(), debug: initialDebug }));
      const mock = createMockPi();
      const context = agentContext(selectRemote);
      const { default: extension } = await import("../src/sync-extension.js");
      extension(mock.pi, continuousDependencies(f.backend));
      try {
        await mock.events.get("session_start")?.[0]?.({}, context.ctx);
        assert.equal(context.notifications.length, initialDebug ? 1 : 0);
        await updateLocalConfig(() => ({ ...configured, debug: !initialDebug }));
        await mock.commands.get("sync")?.handler("help", context.ctx);
        await waitStatus(context.statuses, /waiting for changes/);
        assert.equal(reports(context).length, initialDebug ? 1 : 0);
      } finally {
        await mock.events.get("session_shutdown")?.[0]?.({ reason: "reload" }, context.ctx);
      }
    }));
}

test("debug stays latched for idle resumes and a replacement session reads its new value", async () =>
  withTempHome(async (agentDir) => {
    const f = await createMergeFixture(agentDir);
    await enableContinuous();
    await updateLocalConfig((settings) => ({ ...settings, debug: false }));
    const mock = createMockPi();
    const first = agentContext(selectRemote);
    const next = agentContext(selectRemote);
    const { default: extension } = await import("../src/sync-extension.js");
    extension(mock.pi, continuousDependencies(f.backend));
    try {
      await mock.events.get("session_start")?.[0]?.({}, first.ctx);
      await waitStatus(first.statuses, /waiting for changes/);
      await mock.events.get("agent_start")?.[0]?.({}, first.ctx);
      await updateLocalConfig((settings) => ({ ...settings, debug: true }));
      await mock.events.get("agent_settled")?.[0]?.({}, first.ctx);
      await waitStatus(first.statuses, /waiting for changes/);
      assert.equal(reports(first).length, 0);
      await mock.events.get("session_start")?.[0]?.({ reason: "new" }, next.ctx);
      await waitStatus(next.statuses, /waiting for changes/);
      assert.equal(reports(next).length, 1);
    } finally {
      await mock.events.get("session_shutdown")?.[0]?.({ reason: "reload" }, next.ctx);
    }
  }));

for (const fail of [false, true]) {
  test(`continuous startup transfer ${fail ? "failure" : "completion"} includes nested timings`, async () =>
    withTempHome(async (agentDir) => {
      const f = await createMergeFixture(agentDir);
      await enableContinuous();
      await updateLocalConfig((settings) => ({ ...settings, debug: true }));
      await f.remoteEdit("AGENTS.md", "remote edit\n");
      const mock = createMockPi();
      const context = agentContext(selectRemote);
      const { default: extension } = await import("../src/sync-extension.js");
      extension(
        mock.pi,
        continuousDependencies(
          f.backend,
          fail
            ? {
                loadSyncOperations: async () => ({
                  ...(await import("../src/sync/sync-operations.js")),
                  syncBoth: async (_ctx, options) => {
                    assert.ok(options.startupTimings);
                    return options.startupTimings.measure("transfer remote head", () => {
                      throw new Error("private credential https://private.example/path");
                    });
                  },
                }),
              }
            : {},
        ),
      );
      try {
        await mock.events.get("session_start")?.[0]?.({}, context.ctx);
        await waitStatus(context.statuses, fail ? /blocked|retry/ : /waiting for changes/);
        const output = reports(context);
        assert.equal(output.length, 1);
        assert.match(output[0] ?? "", /operations import:.*automatic transfer:/su);
        assert.match(output[0] ?? "", /transfer remote head:/u);
        assert.ok(output[0]?.includes(fail ? "(stopped)" : "(completed)"));
        assert.equal(output[0]?.includes("(interrupted)"), fail);
        assert.doesNotMatch(output[0] ?? "", /private|credential/u);
        if (!fail) assert.equal(await fs.readFile(path.join(agentDir, "AGENTS.md"), "utf8"), "remote edit\n");
      } finally {
        await mock.events.get("session_shutdown")?.[0]?.({ reason: "reload" }, context.ctx);
      }
    }));
}

for (const boundary of ["agent_start", "session_start", "session_shutdown", "foreground"] as const) {
  test(`late continuous startup reports are suppressed after ${boundary}`, async () =>
    withTempHome(async (agentDir) => {
      const f = await createMergeFixture(agentDir);
      await enableContinuous();
      await updateLocalConfig((settings) => ({ ...settings, debug: true }));
      const entered = deferred();
      const release = deferred();
      let idle = true;
      const mock = createMockPi();
      const context = agentContext(selectRemote, { mode: "tui", isIdle: () => idle });
      const next = createMockContext({ mode: "tui", isIdle: () => false });
      const { default: extension } = await import("../src/sync-extension.js");
      const dependencies = continuousDependencies(f.backend);
      const loadInspection = dependencies.loadSyncInspection;
      assert.ok(loadInspection);
      extension(mock.pi, {
        ...dependencies,
        loadSyncInspection: async () => {
          const inspection = await loadInspection();
          return {
            inspectSync: async (...args) => {
              entered.resolve();
              await release.promise;
              return inspection.inspectSync(...args);
            },
          };
        },
      });
      try {
        await mock.events.get("session_start")?.[0]?.({}, context.ctx);
        await entered.promise;
        idle = false;
        const ending =
          boundary === "foreground"
            ? mock.commands.get("sync")?.handler("help", context.ctx)
            : mock.events.get(boundary)?.[0]?.(
                { reason: "reload" },
                boundary === "session_start" ? next.ctx : context.ctx,
              );
        release.resolve();
        await ending;
        assert.equal(reports(context, mock).length, 0);
        assert.equal(
          mock.entries.length,
          boundary === "session_start" ? 2 : 1,
          "only local initialization entries remain",
        );
      } finally {
        release.resolve();
        await mock.events.get("session_shutdown")?.[0]?.(
          { reason: "reload" },
          boundary === "session_start" ? next.ctx : context.ctx,
        );
      }
    }));
}

test("a timed-out initial continuous check reports stopped once; subsequent polls stay silent", async () =>
  withTempHome(async (agentDir) => {
    const f = await createMergeFixture(agentDir);
    await enableContinuous();
    await updateLocalConfig((settings) => ({ ...settings, debug: true }));
    let now = Date.now();
    const tasks = new Set<{ at: number; run(): void }>();
    const clock: ContinuousClock = {
      now: () => now,
      random: () => 0,
      schedule: (ms, run) => {
        const task = { at: now + ms, run };
        tasks.add(task);
        return () => tasks.delete(task);
      },
    };
    const entered = deferred();
    let first = true;
    const dependencies = continuousDependencies(f.backend);
    const loadInspection = dependencies.loadSyncInspection;
    assert.ok(loadInspection);
    const service = createContinuousSync(
      continuousLoaders(f.backend, {
        loadSyncInspection: async () => {
          const inspection = await loadInspection();
          return {
            inspectSync: async (...args) => {
              if (!first) return inspection.inspectSync(...args);
              first = false;
              entered.resolve();
              const signal = args[2];
              assert.ok(signal);
              return new Promise<never>((_resolve, reject) => {
                signal.addEventListener("abort", () => reject(signal.reason), { once: true });
              });
            },
          };
        },
      }),
      clock,
    );
    const context = agentContext(selectRemote);
    try {
      service.start(context.ctx, new AbortController().signal, false, true);
      await entered.promise;
      const deadline = [...tasks].find((task) => task.at === now + 30_000);
      assert.ok(deadline);
      deadline.run();
      await waitStatus(context.statuses, /retry/);
      assert.equal(reports(context).length, 1);
      assert.match(reports(context)[0] ?? "", /\(stopped\).*inspection and guards:.*\(interrupted\)/su);
      context.statuses.clear();
      now += 67_000;
      for (const task of [...tasks]) {
        if (task.at > now) continue;
        tasks.delete(task);
        task.run();
      }
      await waitStatus(context.statuses, /waiting for changes/);
      assert.equal(reports(context).length, 1);
    } finally {
      await service.stop();
      assert.equal(tasks.size, 0);
    }
  }));
