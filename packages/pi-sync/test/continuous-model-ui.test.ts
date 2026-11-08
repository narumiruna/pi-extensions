import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { createTuiHarness } from "@narumitw/pi-tui-kit/testing";
import { test, vi } from "vitest";
import { createMockContext } from "../../../test/support.js";
import { loadConfig } from "../src/settings/config.js";
import { localConfigPath } from "../src/settings/config-file.js";
import { runAgentResolver } from "../src/sync/agent-runner.js";
import { ContinuousError } from "../src/sync/continuous-errors.js";
import { acquireContinuousLease } from "../src/sync/continuous-lease.js";
import {
  continuousStatusLines,
  readContinuousRecord,
  reserveContinuousRequest,
} from "../src/sync/continuous-record.js";
import { continuousBinding } from "../src/sync/continuous-storage.js";
import { saveContinuousMode } from "../src/ui/agent-mode-setting.js";
import { showSyncSettings } from "../src/ui/settings-ui.js";
import { agentContext, selectRemote } from "./agent-test-helpers.js";
import { v3S3Settings, withTempHome } from "./helpers.js";

initTheme("dark", false);
const evidence = {
  files: [],
  unsupported: [],
  units: [{ id: "0", path: "AGENTS.md", kind: "text" as const, base: "base", local: "left", remote: "right" }],
};

test("SDK dispatch is reserved durably; exhausted budgets disclose nothing and Status is read-only", async () =>
  withTempHome(async (agentDir) => {
    await fs.mkdir(agentDir, { recursive: true });
    const settings = v3S3Settings();
    Object.assign(settings.syncSetups.home.sync, { agentMode: true, continuous: true });
    await fs.writeFile(localConfigPath(), JSON.stringify(settings));
    const config = await loadConfig();
    // The lease prepares the private root; binding then uses its canonical state path.
    const { prepareContinuousRoot } = await import("../src/sync/continuous-storage.js");
    await prepareContinuousRoot();
    const binding = await continuousBinding(config);
    const lease = await acquireContinuousLease(binding);
    assert.ok(lease);
    const key = "a".repeat(64);
    try {
      const mock = agentContext(selectRemote);
      let sawReservation = false;
      mock.ctx.modelRegistry.streamSimple = new Proxy(mock.ctx.modelRegistry.streamSimple, {
        apply(target, receiver, args) {
          // The async check below ran before this synchronous public transport boundary.
          assert.equal(sawReservation, true);
          return Reflect.apply(target, receiver, args);
        },
      });
      const reserve = async () => {
        await reserveContinuousRequest(binding, lease, key);
        assert.equal((await readContinuousRecord(binding)).attempts[key], 1);
        sawReservation = true;
      };
      await runAgentResolver(mock.ctx, evidence, async () => lease.assert(), undefined, reserve);
      assert.equal(mock.requests.length, 1);
      await reserveContinuousRequest(binding, lease, key);
      const before = JSON.stringify(await readContinuousRecord(binding));
      await continuousStatusLines(config);
      assert.equal(JSON.stringify(await readContinuousRecord(binding)), before);
      await assert.rejects(
        runAgentResolver(
          mock.ctx,
          evidence,
          async () => lease.assert(),
          undefined,
          () => reserveContinuousRequest(binding, lease, key),
        ),
        /limit reached/,
      );
      assert.equal(mock.requests.length, 1);
    } finally {
      await lease.release();
    }
  }));

test("typed synchronous transport failures retain their safe retry category through the SDK", async () => {
  const mock = agentContext(selectRemote);
  mock.ctx.modelRegistry.streamSimple = () => {
    throw Object.assign(new Error("provider secret payload"), { code: "ECONNRESET" });
  };
  let reservations = 0;
  await assert.rejects(
    runAgentResolver(
      mock.ctx,
      evidence,
      async () => {},
      undefined,
      async () => {
        reservations++;
      },
    ),
    (error) => {
      assert.ok(error instanceof ContinuousError);
      assert.equal(error.kind, "transient");
      assert.doesNotMatch(error.message, /secret payload/);
      return true;
    },
  );
  assert.equal(reservations, 1);
});

test("failed continuous save retains bytes and request to enable can be retried", async () =>
  withTempHome(async (agentDir) => {
    await fs.mkdir(agentDir, { recursive: true });
    const settings = v3S3Settings();
    Object.assign(settings.syncSetups.home.sync, { agentMode: true });
    const before = JSON.stringify(settings);
    await fs.writeFile(localConfigPath(), before);
    const mock = createMockContext({ mode: "rpc", select: async () => "Yes, Enable Continuous sync" });
    const rename = vi.spyOn(fs, "rename").mockRejectedValueOnce(new Error("disk failed"));
    try {
      await assert.rejects(saveContinuousMode(mock.ctx, "home", true), /disk failed/);
    } finally {
      rename.mockRestore();
    }
    assert.equal(await fs.readFile(localConfigPath(), "utf8"), before);
    assert.equal(await saveContinuousMode(mock.ctx, "home", true), true);
    assert.equal((await loadConfig()).continuous, true);
  }));

for (const enabled of [false, true])
  test(`Continuous sync ${enabled ? "On" : "Off"} shows the saved value and message with non-default keys`, async () =>
    withTempHome(async (agentDir) => {
      await fs.mkdir(agentDir, { recursive: true });
      const settings = v3S3Settings();
      Object.assign(settings.syncSetups.home.sync, { agentMode: enabled, continuous: !enabled });
      await fs.writeFile(localConfigPath(), JSON.stringify(settings));
      const keys: Record<string, string> = {
        "tui.select.confirm": "x",
        "tui.select.cancel": "q",
        "tui.select.down": "j",
        "tui.select.up": "k",
      };
      const tui = createTuiHarness({
        width: 40,
        rows: 24,
        keybindings: {
          matches: (data, action) => data === keys[action],
          getKeys: (action) => {
            const key = keys[action];
            return key ? ([key] as never) : [];
          },
        },
      });
      const confirmation = createTuiHarness({ width: 100, rows: 200 });
      const custom: typeof tui.custom = (factory, options) =>
        tui.isOpen ? confirmation.custom(factory, options) : tui.custom(factory, options);
      const mock = createMockContext({ mode: "tui", hasUI: true, custom });
      const owner = new AbortController();
      try {
        const running = showSyncSettings(mock.ctx, async () => undefined, owner.signal);
        await tui.waitForOpen();
        tui.send("\u001b[200~Continuous sync\u001b[201~");
        assert.match(tui.render().join("\n"), new RegExp(`Continuous sync.*${enabled ? "Off" : "On"}`));
        tui.send("x");
        if (enabled) {
          await confirmation.waitForOpen();
          assert.match(confirmation.render().join("\n"), /Enable experimental Continuous sync/);
          confirmation.press("tui.select.down");
          confirmation.press("tui.select.confirm");
        }
        await tui.waitForPending();
        await tui.waitForOpen();
        assert.match(tui.render().join("\n"), new RegExp(`Continuous sync.*${enabled ? "On" : "Off"}`));
        assert.equal((await loadConfig()).continuous, enabled);
        assert.ok(
          mock.notifications.some((item) =>
            enabled
              ? /Continuous sync enabled\. Monitoring starts after the \/sync command or manager closes/.test(
                  item.message,
                )
              : item.message === "Continuous sync disabled. Completed work is not undone.",
          ),
        );
        if (!enabled) assert.ok(mock.notifications.every((item) => !item.message.includes("Monitoring starts")));
        tui.send("q");
        await running;
      } finally {
        owner.abort();
        confirmation.dispose();
        tui.dispose();
      }
    }));
