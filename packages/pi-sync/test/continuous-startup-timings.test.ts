import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { initializeSync } from "@narumitw/pi-sync-daemon/engine/sync/initialization";
import { test } from "vitest";
import { type createMockContext, createMockPi } from "../../../test/support.js";
import { localConfigPath } from "../src/settings/config-file.js";
import { localConfigTemplate, updateLocalConfig } from "../src/settings/settings-store.js";
import { type ContinuousClock, createContinuousSync } from "../src/sync/continuous-sync.js";
import {
  registerStartupTimings,
  STARTUP_TIMING_ENTRY,
  type StartupTimingEntry,
} from "../src/ui/startup-timings-entry.js";
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
function reporting(loaders: ReturnType<typeof continuousLoaders>, mock: ReturnType<typeof createMockPi>) {
  const publish = registerStartupTimings(mock.pi);
  const service = createContinuousSync(loaders, undefined, publish);
  return {
    service,
    initialize: (ctx: ReturnType<typeof agentContext>["ctx"], signal: AbortSignal) =>
      initializeSync(ctx, signal, publish),
  };
}

for (const [debug, mode] of [
  [true, "tui"],
  [true, "rpc"],
  [false, "tui"],
  [false, "rpc"],
  [true, "print"],
  [true, "json"],
] as const)
  test(`continuous startup debug=${debug} in ${mode} reports only through supported UI`, async () =>
    withTempHome(async (agentDir) => {
      const f = await createMergeFixture(agentDir);
      await enableContinuous();
      await updateLocalConfig((settings) => ({ ...settings, debug }));
      const before = await fs.readFile(localConfigPath());
      const mock = createMockPi();
      const context = agentContext(selectRemote, { mode });
      const fixture = reporting(continuousLoaders(f.backend), mock);
      const lifetime = new AbortController();
      try {
        const initialized = await fixture.initialize(context.ctx, lifetime.signal);
        fixture.service.start(context.ctx, lifetime.signal, false, initialized.debug);
        const supported = mode === "tui" || mode === "rpc";
        if (supported) await waitStatus(context.statuses, /waiting for changes/u);
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
        lifetime.abort();
        await fixture.service.stop();
      }
    }));

test("idle resumes and foreground pauses do not repeat a session's continuous startup report", async () =>
  withTempHome(async (agentDir) => {
    const f = await createMergeFixture(agentDir);
    await enableContinuous();
    await updateLocalConfig((settings) => ({ ...settings, debug: true }));
    const mock = createMockPi();
    const context = agentContext(selectRemote, { mode: "tui" });
    const fixture = reporting(continuousLoaders(f.backend), mock);
    const lifetime = new AbortController();
    try {
      const initialized = await fixture.initialize(context.ctx, lifetime.signal);
      for (let cycle = 0; cycle < 3; cycle++) {
        fixture.service.start(context.ctx, lifetime.signal, false, initialized.debug);
        await waitStatus(context.statuses, /waiting for changes/u);
        assert.equal(reports(context, mock).length, 1);
        await fixture.service.stop(context.ctx.sessionManager);
      }
    } finally {
      lifetime.abort();
      await fixture.service.stop();
    }
  }));

for (const initialDebug of [false, true])
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
      const fixture = reporting(continuousLoaders(f.backend), mock);
      const lifetime = new AbortController();
      try {
        const initialized = await fixture.initialize(context.ctx, lifetime.signal);
        assert.equal(context.notifications.length, initialDebug ? 1 : 0, "only local initialization runs while Off");
        await updateLocalConfig((settings) => {
          settings.debug = !initialDebug;
          Object.assign(requiredHome(settings).sync, { agentMode: true, continuous: true });
          return settings;
        });
        fixture.service.start(context.ctx, lifetime.signal, false, initialized.debug);
        await waitStatus(context.statuses, /waiting for changes/u);
        assert.equal(reports(context).length, initialDebug ? 1 : 0);
      } finally {
        lifetime.abort();
        await fixture.service.stop();
      }
    }));

for (const initialDebug of [false, true])
  test(`an empty startup catalog retains debug=${initialDebug} when its first Continuous setup is added`, async () =>
    withTempHome(async (agentDir) => {
      const f = await createMergeFixture(agentDir);
      await enableContinuous();
      const configured = JSON.parse(await fs.readFile(localConfigPath(), "utf8"));
      await updateLocalConfig(() => ({ ...localConfigTemplate(), debug: initialDebug }));
      const mock = createMockPi();
      const context = agentContext(selectRemote);
      const fixture = reporting(continuousLoaders(f.backend), mock);
      const lifetime = new AbortController();
      try {
        const initialized = await fixture.initialize(context.ctx, lifetime.signal);
        assert.equal(context.notifications.length, initialDebug ? 1 : 0);
        await updateLocalConfig(() => ({ ...configured, debug: !initialDebug }));
        fixture.service.start(context.ctx, lifetime.signal, false, initialized.debug);
        await waitStatus(context.statuses, /waiting for changes/u);
        assert.equal(reports(context).length, initialDebug ? 1 : 0);
      } finally {
        lifetime.abort();
        await fixture.service.stop();
      }
    }));

test("debug stays latched for idle resumes and a replacement session reads its new value", async () =>
  withTempHome(async (agentDir) => {
    const f = await createMergeFixture(agentDir);
    await enableContinuous();
    await updateLocalConfig((settings) => ({ ...settings, debug: false }));
    const mock = createMockPi();
    const first = agentContext(selectRemote);
    const next = agentContext(selectRemote);
    const fixture = reporting(continuousLoaders(f.backend), mock);
    const lifetime = new AbortController();
    const replacement = new AbortController();
    try {
      const initial = await fixture.initialize(first.ctx, lifetime.signal);
      fixture.service.start(first.ctx, lifetime.signal, false, initial.debug);
      await waitStatus(first.statuses, /waiting for changes/u);
      await fixture.service.stop();
      await updateLocalConfig((settings) => ({ ...settings, debug: true }));
      fixture.service.start(first.ctx, lifetime.signal, false, initial.debug);
      await waitStatus(first.statuses, /waiting for changes/u);
      assert.equal(reports(first).length, 0);
      lifetime.abort();
      await fixture.service.stop();
      const updated = await fixture.initialize(next.ctx, replacement.signal);
      fixture.service.start(next.ctx, replacement.signal, false, updated.debug);
      await waitStatus(next.statuses, /waiting for changes/u);
      assert.equal(reports(next).length, 1);
    } finally {
      lifetime.abort();
      replacement.abort();
      await fixture.service.stop();
    }
  }));

for (const fail of [false, true])
  test(`continuous startup transfer ${fail ? "failure" : "completion"} includes nested timings`, async () =>
    withTempHome(async (agentDir) => {
      const f = await createMergeFixture(agentDir);
      await enableContinuous();
      await updateLocalConfig((settings) => ({ ...settings, debug: true }));
      await f.remoteEdit("AGENTS.md", "remote edit\n");
      const mock = createMockPi();
      const context = agentContext(selectRemote);
      const fixture = reporting(
        continuousLoaders(
          f.backend,
          fail
            ? {
                loadSyncOperations: async () => ({
                  ...(await import("@narumitw/pi-sync-daemon/engine/sync/sync-operations")),
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
        mock,
      );
      const lifetime = new AbortController();
      try {
        const initialized = await fixture.initialize(context.ctx, lifetime.signal);
        fixture.service.start(context.ctx, lifetime.signal, false, initialized.debug);
        await waitStatus(context.statuses, fail ? /blocked|retry/u : /waiting for changes/u);
        const output = reports(context);
        assert.equal(output.length, 1);
        assert.match(output[0] ?? "", /operations import:.*automatic transfer:/su);
        assert.match(output[0] ?? "", /transfer remote head:/u);
        assert.ok(output[0]?.includes(fail ? "(stopped)" : "(completed)"));
        assert.equal(output[0]?.includes("(interrupted)"), fail);
        assert.doesNotMatch(output[0] ?? "", /private|credential/u);
        if (!fail) assert.equal(await fs.readFile(path.join(agentDir, "AGENTS.md"), "utf8"), "remote edit\n");
      } finally {
        lifetime.abort();
        await fixture.service.stop();
      }
    }));

for (const boundary of ["agent_start", "session_start", "session_shutdown", "foreground"] as const)
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
      const next = agentContext(selectRemote, { mode: "tui", isIdle: () => false });
      const dependencies = continuousDependencies(f.backend);
      const load = dependencies.loadSyncInspection;
      assert.ok(load);
      const fixture = reporting(
        continuousLoaders(f.backend, {
          loadSyncInspection: async () => {
            const module = await load();
            return {
              inspectSync: async (...args) => {
                entered.resolve();
                await release.promise;
                return module.inspectSync(...args);
              },
            };
          },
        }),
        mock,
      );
      const lifetime = new AbortController();
      try {
        const initialized = await fixture.initialize(context.ctx, lifetime.signal);
        fixture.service.start(context.ctx, lifetime.signal, false, initialized.debug);
        await entered.promise;
        idle = false;
        if (boundary === "session_start" || boundary === "session_shutdown") lifetime.abort();
        const ending = fixture.service.stop(context.ctx.sessionManager);
        release.resolve();
        await ending;
        if (boundary === "session_start") await fixture.initialize(next.ctx, new AbortController().signal);
        assert.equal(reports(context, mock).length, 0);
        assert.equal(
          mock.entries.length,
          boundary === "session_start" ? 2 : 1,
          "only local initialization entries remain",
        );
      } finally {
        release.resolve();
        lifetime.abort();
        await fixture.service.stop();
      }
    }));

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
