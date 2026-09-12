import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { stripVTControlCharacters } from "node:util";
import { visibleWidth } from "@earendil-works/pi-tui";
import { test, vi } from "vitest";
import { createMockContext, createMockPi } from "../../../test/support.js";
import { loadConfig, syncCheckConfigFingerprint } from "../src/settings/config.js";
import { localConfigPath } from "../src/settings/config-file.js";
import { describeManagerState } from "../src/ui/manager-state.js";
import { createSyncAttentionController } from "../src/ui/sync-attention.js";
import { v3S3Settings, withTempHome } from "./helpers.js";
import { contextUi, deferred, inspectionFixture, observeCheckCompletion } from "./startup-check-helpers.js";

test("advisory widget is read-only, sanitized, narrow, themed at render time, and lower priority than selection review", async () => {
  await withTempHome(async (agentDir) => {
    await fs.mkdir(agentDir, { recursive: true });
    await fs.writeFile(localConfigPath(), JSON.stringify(v3S3Settings({ automatic: true })));
    const config = await loadConfig();
    const attention = createSyncAttentionController();
    const observation = {
      setupName: "測試\u001b]8;;spoof",
      configIdentity: syncCheckConfigFingerprint(config),
      checkedAt: "2026-09-06T12:00:00.000Z",
      inspection: await inspectionFixture(config, { localChanged: true, remoteChanged: true }),
    };
    const context = createMockContext({ mode: "tui" });
    attention.observe(observation);
    await attention.publish(context.ctx);
    const factory = context.widgets.get("sync:attention") as (
      _tui: unknown,
      theme: { fg: (role: string, text: string) => string },
    ) => { render(width: number): string[]; invalidate(): void; handleInput?: unknown };
    let themePass = 0;
    const roles: string[] = [];
    const component = factory(
      {},
      {
        fg: (role, text) => {
          roles.push(role);
          return `${themePass}${text}`;
        },
      },
    );
    assert.equal(component.handleInput, undefined);
    for (const width of [1, 2, 12, 32, 80]) {
      const lines = component.render(width);
      assert.ok(lines.every((line) => visibleWidth(line) <= width));
      assert.ok(lines.every((line) => !line.includes("\u001b]8") && !/^[→›]/u.test(stripVTControlCharacters(line))));
    }
    themePass = 1;
    component.invalidate();
    assert.match(component.render(80)[0] ?? "", /^1/u);
    assert.ok(roles.includes("muted"));
    attention.set(
      {
        setupName: config.setupName,
        configIdentity: "review",
        localInclude: config.include,
        remoteInclude: ["AGENTS.md"],
      },
      "sync",
    );
    await attention.publish(context.ctx);
    assert.equal(context.statuses.get("sync"), "review needed");
    attention.reset(context.ctx);
    assert.equal(attention.observation(), undefined);
    assert.equal(context.widgets.get("sync:attention"), undefined);
  });
});

test("manager uses local observation without remote requests and drops it after configuration changes", async () => {
  await withTempHome(async (agentDir) => {
    await fs.mkdir(agentDir, { recursive: true });
    await fs.writeFile(localConfigPath(), JSON.stringify(v3S3Settings({ automatic: true })));
    const config = await loadConfig();
    const observation = {
      setupName: config.setupName,
      configIdentity: syncCheckConfigFingerprint(config),
      checkedAt: "2026-09-06T12:00:00.000Z",
      inspection: await inspectionFixture(config),
    };
    const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("manager must stay local"));
    try {
      const manager = await describeManagerState(undefined, undefined, undefined, observation);
      assert.equal(manager.observation, observation);
      assert.match(manager.title, /Check-time observation only/u);
      assert.match(manager.title, /No changes detected since last sync/u);
      await fs.writeFile(localConfigPath(), JSON.stringify(v3S3Settings({ automatic: false })));
      assert.equal((await describeManagerState(undefined, undefined, undefined, observation)).observation, undefined);
      assert.equal(fetch.mock.calls.length, 0);
    } finally {
      fetch.mockRestore();
    }
  });
});

for (const route of ["", "status", "sync --yes", "files", "use work", "migrate-state --yes"]) {
  test(`foreground ${route || "manager"} preempts background checking without racing its lock`, async () => {
    await withTempHome(async (agentDir) => {
      await fs.mkdir(agentDir, { recursive: true });
      await fs.writeFile(localConfigPath(), JSON.stringify(v3S3Settings({ automatic: true })));
      const { default: sync } = await import("../src/sync-extension.js");
      const entered = deferred();
      let aborted = false;
      let runs = 0;
      const mock = createMockPi();
      sync(mock.pi, {
        loadSyncInspection: async () => ({
          inspectSync: async (config, _options, signal) => {
            entered.resolve();
            await new Promise<void>((resolve) =>
              signal?.addEventListener(
                "abort",
                () => {
                  aborted = true;
                  resolve();
                },
                { once: true },
              ),
            );
            return inspectionFixture(config, { localChanged: true });
          },
        }),
        loadSyncOperations: async () =>
          ({
            status: async () => {
              assert.ok(aborted);
              runs++;
            },
            syncBoth: async () => {
              assert.ok(aborted);
              runs++;
            },
          }) as never,
        loadSetupSwitch: async () => ({
          useSyncSetup: async () => {
            assert.ok(aborted);
            runs++;
            return { pullApplied: false };
          },
        }),
      });
      const context = createMockContext({ mode: "rpc" });
      await mock.events.get("session_start")?.[0]?.({}, context.ctx);
      await entered.promise;
      await mock.commands.get("sync")?.handler(route, context.ctx);
      assert.ok(aborted);
      assert.equal(runs, ["status", "sync --yes", "use work"].includes(route) ? 1 : 0);
      assert.equal(context.widgets.get("sync:attention"), undefined);
      assert.ok(context.notifications.every((n) => !/already running|currently running/iu.test(n.message)));
      await mock.events.get("session_shutdown")?.[0]?.({ reason: "reload" }, context.ctx);
    });
  });
}

test("replacement sessions sharing a UI cannot inherit a late failure or clear newer attention", async () => {
  await withTempHome(async (agentDir) => {
    await fs.mkdir(agentDir, { recursive: true });
    await fs.writeFile(localConfigPath(), JSON.stringify(v3S3Settings({ automatic: true })));
    const { default: sync } = await import("../src/sync-extension.js");
    const entered = deferred();
    let calls = 0;
    const mock = createMockPi();
    sync(mock.pi, {
      loadSyncInspection: async () => ({
        inspectSync: async (config, _options, signal) => {
          if (++calls === 1) {
            entered.resolve();
            await new Promise<void>((resolve) => signal?.addEventListener("abort", () => resolve(), { once: true }));
            throw new Error("obsolete failure");
          }
          return inspectionFixture(config, { localChanged: true });
        },
      }),
    });
    const first = createMockContext({ mode: "rpc" });
    const second = createMockContext({ mode: "rpc" });
    Object.assign(second.ctx, { ui: contextUi(first.ctx) });
    await mock.events.get("session_start")?.[0]?.({}, first.ctx);
    await entered.promise;
    const completion = observeCheckCompletion(second.ctx);
    await mock.events.get("session_start")?.[0]?.({}, second.ctx);
    await completion.completed;
    assert.equal(first.statuses.get("sync"), "local changes pending");
    assert.equal(first.widgets.get("sync:attention"), undefined);
    assert.deepEqual(first.notifications, []);
    await mock.events.get("session_shutdown")?.[0]?.({ reason: "reload" }, second.ctx);
  });
});
