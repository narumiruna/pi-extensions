import assert from "node:assert/strict";
import type { ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import { test, vi } from "vitest";
import { createMockContext, createMockPi } from "../../../test/support.js";
import type { PiDaemonClient } from "../src/daemon/pi-client.js";
import { validateSettingsDocument } from "../src/settings/settings-validation.js";
import { registerPiSyncDebug } from "../src/sync/debug-tool.js";
import { v3WebDavSettings } from "./data-fixtures.js";

function fixture(mode: "tui" | "rpc" | "print") {
  const pi = createMockPi({ activeTools: ["read", "edit"] });
  const { ctx } = createMockContext({ hasUI: mode !== "print", mode });
  const context = ctx as ExtensionToolContext;
  let settings = validateSettingsDocument({ ...v3WebDavSettings(), debug: true });
  const controller = new AbortController();
  const run = vi.fn();
  const client = {
    validateDebugTool() {},
    readStartupSettings: async () => ({ settings }),
    run,
  } as unknown as PiDaemonClient;
  let owner: { client: PiDaemonClient; signal: AbortSignal } | undefined = { client, signal: controller.signal };
  const expose = registerPiSyncDebug(pi.pi, () => owner);
  const tool = pi.tools.find(({ name }) => name === "pi_sync_debug");
  assert.ok(tool);
  const execute = tool.execute as (
    id: string,
    params: unknown,
    signal: AbortSignal | undefined,
    update: undefined,
    ctx: ExtensionToolContext,
  ) => Promise<unknown>;
  return {
    pi,
    context,
    expose,
    run,
    controller,
    setSettings(value: Record<string, unknown>) {
      settings = validateSettingsDocument(value);
    },
    replaceOwner() {
      owner = undefined;
    },
    recheck: () => execute("test", { action: "recheck" }, undefined, undefined, context),
  };
}

test("tool activation changes only the owned name at the session boundary", () => {
  const harness = fixture("tui");
  assert.deepEqual(harness.pi.rawPi.getActiveTools(), ["read", "edit"]);
  harness.expose(true);
  harness.expose(true);
  assert.deepEqual(harness.pi.rawPi.getActiveTools(), ["read", "edit", "pi_sync_debug"]);
  harness.pi.rawPi.setActiveTools(["edit", "pi_sync_debug", "read"]);
  harness.expose(false);
  assert.deepEqual(harness.pi.rawPi.getActiveTools(), ["edit", "read"]);
});

test.each(["setup", "owner", "cancelled"] as const)(
  "a %s change during TUI review prevents remote reads",
  async (changed) => {
    const harness = fixture("tui");
    harness.context.ui.confirm = async (title, message) => {
      assert.equal(title, "Recheck Pi Sync?");
      assert.ok(message.includes("Setup: home"));
      if (changed === "setup") {
        const settings = v3WebDavSettings();
        settings.syncSetups.home.storage.path = "another/path";
        harness.setSettings({ ...settings, debug: true });
      } else if (changed === "owner") harness.replaceOwner();
      else harness.controller.abort();
      return true;
    };
    await assert.rejects(harness.recheck(), /changed|replaced|aborted/iu);
    assert.equal(harness.run.mock.calls.length, 0);
  },
);

test("a forced call in print mode does not read settings or open a confirmation", async () => {
  const harness = fixture("print");
  const confirm = vi.fn();
  harness.context.ui.confirm = confirm;
  await assert.rejects(harness.recheck(), /requires an interactive session/u);
  assert.equal(confirm.mock.calls.length, 0);
  assert.equal(harness.run.mock.calls.length, 0);
});
