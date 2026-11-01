import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { test, vi } from "vitest";
import { createMockContext, createMockPi } from "../../../test/support.js";
import { loadConfig, loadConfigForCheck, syncCheckConfigFingerprint } from "../src/settings/config.js";
import { localConfigPath } from "../src/settings/config-file.js";
import { localConfigTemplate, updateLocalConfig } from "../src/settings/settings-store.js";
import { validateSettingsDocument } from "../src/settings/settings-validation.js";
import { createStartupTimings } from "../src/sync/startup-timings.js";
import { inspectSync } from "../src/sync/sync-inspection.js";
import { STARTUP_TIMING_ENTRY, type StartupTimingEntry } from "../src/ui/startup-timings-entry.js";
import { v3S3Settings, withTempHome } from "./helpers.js";
import { contextUi, deferred, inspectionFixture } from "./startup-check-helpers.js";

function reports(context: ReturnType<typeof createMockContext>, mock?: ReturnType<typeof createMockPi>) {
  return [
    ...context.notifications.filter((entry) => entry.message.startsWith("pi-sync debug:")),
    ...(mock?.entries
      .filter((entry) => entry.customType === STARTUP_TIMING_ENTRY)
      .map((entry) => ({ message: (entry.data as StartupTimingEntry).report })) ?? []),
  ];
}

async function configured(debug: boolean | undefined, run: () => Promise<void>, transfer = false) {
  await withTempHome(async (root) => {
    await fs.mkdir(root, { recursive: true });
    const settings = { ...v3S3Settings({ automatic: true }), debug };
    Object.assign(settings.syncSetups.home.sync, { automaticTransfer: transfer });
    await fs.writeFile(localConfigPath(), JSON.stringify(settings));
    await fs.writeFile(path.join(root, "settings.json"), "{}\n");
    await run();
  });
}

test("debug defaults false, accepts only booleans, and preserves unknown fields on save", async () => {
  assert.equal(localConfigTemplate().debug, false);
  for (const value of ["true", 1, null, {}, []]) {
    assert.throws(() => validateSettingsDocument({ ...v3S3Settings(), debug: value }), /debug must be boolean/u);
  }
  await configured(undefined, async () => {
    const before = await loadConfig();
    assert.equal(before.debug, false);
    await updateLocalConfig((settings) => ({ ...settings, debug: true, futureField: { keep: true } }));
    const enabled = await loadConfigForCheck();
    assert.equal(enabled.debug, true);
    assert.equal(syncCheckConfigFingerprint(enabled), syncCheckConfigFingerprint(before));
    await updateLocalConfig((settings) => ({ ...settings, debug: false }));
    assert.equal((await loadConfig()).debug, false);
    assert.deepEqual(JSON.parse(await fs.readFile(localConfigPath(), "utf8")).futureField, { keep: true });
  });
});

test("monotonic timings retain the original error but publish no error text", async () => {
  let now = 100;
  const clock = vi.spyOn(performance, "now").mockImplementation(() => now);
  try {
    const timings = createStartupTimings();
    const error = new Error("secret-key https://private.example/path\u001b[2J");
    await assert.rejects(
      timings.measure("remote head", () => {
        now = 125;
        throw error;
      }),
      (caught) => caught === error,
    );
    now = 140;
    const context = createMockContext({ mode: "rpc" });
    timings.publish(context.ctx, true, new AbortController().signal, "background startup", "stopped");
    assert.equal(reports(context).length, 1);
    assert.match(reports(context)[0]?.message ?? "", /remote head: 25\.0 ms \(interrupted\).*total: 40\.0 ms/su);
    assert.doesNotMatch(reports(context)[0]?.message ?? "", /secret|private/u);
    assert.equal(reports(context)[0]?.message.includes("\u001b"), false);
    contextUi(context.ctx).notify = () => {
      throw new Error("UI disposed");
    };
    assert.doesNotThrow(() => timings.publish(context.ctx, true, new AbortController().signal, "background startup"));
  } finally {
    clock.mockRestore();
  }
});

test("repeated transfer stages aggregate durations and counts without losing interruption", async () => {
  let now = 0;
  const clock = vi.spyOn(performance, "now").mockImplementation(() => now);
  try {
    const timings = createStartupTimings();
    for (let index = 0; index < 100; index++) {
      await timings.measure("transfer remote head", () => {
        now += 2;
      });
    }
    await assert.rejects(
      timings.measure("transfer remote head", () => {
        now += 3;
        throw new Error("private");
      }),
    );
    const context = createMockContext({ mode: "rpc" });
    timings.publish(context.ctx, true, new AbortController().signal, "background startup", "stopped");
    const report = reports(context)[0]?.message ?? "";
    assert.match(report, /transfer remote head: 203\.0 ms \(101 calls\) \(interrupted\)/u);
    assert.equal(report.split("\n").length, 3, "retries do not produce unbounded output");
    assert.doesNotMatch(report, /private/u);
  } finally {
    clock.mockRestore();
  }
});

for (const debug of [undefined, false, true]) {
  for (const mode of ["tui", "rpc", "print", "json"] as const) {
    test(`startup debug=${debug} in ${mode} only reports through supported UI`, async () => {
      await configured(debug, async () => {
        const { default: sync } = await import("../src/sync-extension.js");
        const mock = createMockPi();
        const context = createMockContext({ mode });
        sync(mock.pi, { loadSyncInspection: async () => ({ inspectSync: (config) => inspectionFixture(config) }) });
        await mock.events.get("session_start")?.[0]?.({}, context.ctx);
        const enabled = debug === true && (mode === "tui" || mode === "rpc");
        if (enabled) await vi.waitFor(() => assert.equal(reports(context, mock).length, 2), { interval: 5 });
        await mock.events.get("session_shutdown")?.[0]?.({ reason: "reload" }, context.ctx);
        assert.equal(reports(context, mock).length, enabled ? 2 : 0);
        assert.equal(mock.entries.length, enabled && mode === "tui" ? 2 : 0);
        if (enabled) {
          assert.match(
            reports(context, mock)[0]?.message ?? "",
            /transaction recovery:.*settings read:.*config resolution:/su,
          );
          assert.match(
            reports(context, mock)[1]?.message ?? "",
            /inspection import:.*inspection and guards:.*total:/su,
          );
          assert.doesNotMatch(
            reports(context, mock)
              .map((entry) => entry.message)
              .join("\n"),
            /access-key|secret-key|example\.r2|settings\.json/u,
          );
        }
      });
    });
  }
}

test("inspection measures backend, snapshot, state, and remote head separately without writing files", async () => {
  await configured(true, async () => {
    const config = await loadConfig();
    const timings = createStartupTimings();
    await inspectSync(
      config,
      { include: config.include },
      undefined,
      async () =>
        ({
          readHead: async () => undefined,
          destination: "private destination",
          capability: "read-check-write-verify",
        }) as never,
      timings,
    );
    const context = createMockContext({ mode: "rpc" });
    timings.publish(context.ctx, true, new AbortController().signal, "background startup");
    const report = reports(context)[0]?.message ?? "";
    for (const label of ["backend initialization", "local snapshot", "sync state read", "remote head"]) {
      assert.ok(report.includes(`${label}:`), report);
    }
    assert.doesNotMatch(report, /private destination/u);
  });
});

for (const boundary of ["replacement", "shutdown"] as const) {
  test(`late startup report is suppressed after ${boundary}`, async () => {
    await configured(true, async () => {
      const { default: sync } = await import("../src/sync-extension.js");
      const entered = deferred();
      const release = deferred();
      const mock = createMockPi();
      sync(mock.pi, {
        loadSyncInspection: async () => ({
          inspectSync: async (config) => {
            entered.resolve();
            await release.promise;
            return inspectionFixture(config);
          },
        }),
      });
      const old = createMockContext({ mode: "rpc" });
      await mock.events.get("session_start")?.[0]?.({}, old.ctx);
      await entered.promise;
      assert.equal(reports(old).length, 1);
      const next = createMockContext({ mode: "rpc" });
      const ending =
        boundary === "shutdown"
          ? mock.events.get("session_shutdown")?.[0]?.({ reason: "reload" }, old.ctx)
          : mock.events.get("session_start")?.[0]?.({}, next.ctx);
      release.resolve();
      await ending;
      assert.equal(reports(old).length, 1, "no background report reaches the old session");
      await mock.events.get("session_shutdown")?.[0]?.({ reason: "reload" }, next.ctx);
    });
  });
}

for (const fail of [false, true]) {
  test(`automatic transfer ${fail ? "failure" : "completion"} includes its lazy import and duration`, async () => {
    await configured(
      true,
      async () => {
        const { default: sync } = await import("../src/sync-extension.js");
        const mock = createMockPi();
        const context = createMockContext({ mode: "rpc" });
        const completed = deferred();
        const ui = contextUi(context.ctx);
        const notify = ui.notify.bind(ui);
        ui.notify = (message, type) => {
          notify(message, type);
          if (message.startsWith("pi-sync debug: background")) completed.resolve();
        };
        sync(mock.pi, {
          loadSyncInspection: async () => ({ inspectSync: (config) => inspectionFixture(config) }),
          loadSyncOperations: async () =>
            ({
              syncBoth: async () => {
                if (fail) throw new Error("transfer failed");
              },
            }) as never,
        });
        await mock.events.get("session_start")?.[0]?.({}, context.ctx);
        await completed.promise;
        const report = reports(context)[1]?.message ?? "";
        assert.match(report, /operations import:.*automatic transfer:/su);
        assert.ok(report.includes(fail ? "(stopped)" : "(completed)"), report);
        assert.equal(report.includes("(interrupted)"), fail);
        await mock.events.get("session_shutdown")?.[0]?.({ reason: "reload" }, context.ctx);
      },
      true,
    );
  });
}

test("missing settings with debug absent create no files", async () => {
  await withTempHome(async (root) => {
    const { default: sync } = await import("../src/sync-extension.js");
    const mock = createMockPi();
    sync(mock.pi);
    const context = createMockContext({ mode: "rpc" });
    await mock.events.get("session_start")?.[0]?.({}, context.ctx);
    assert.deepEqual(reports(context), []);
    await assert.rejects(fs.access(root), { code: "ENOENT" });
    await mock.events.get("session_shutdown")?.[0]?.({ reason: "reload" }, context.ctx);
  });
});
