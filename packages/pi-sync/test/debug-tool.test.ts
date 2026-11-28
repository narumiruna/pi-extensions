import assert from "node:assert/strict";
import type { ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import { test, vi } from "vitest";
import { createMockContext, createMockPi } from "../../../test/support.js";
import type { PiDaemonClient } from "../src/daemon/pi-client.js";
import { validateSettingsDocument } from "../src/settings/settings-validation.js";
import { registerPiSyncDebug } from "../src/sync/debug-tool.js";
import { v3WebDavSettings } from "./data-fixtures.js";

function fixture(mode: "tui" | "print" | "json") {
  const pi = createMockPi({ activeTools: ["read", "edit"] });
  const { ctx } = createMockContext({ hasUI: mode === "tui", mode });
  const context = ctx as ExtensionToolContext;
  let settings = validateSettingsDocument({ ...v3WebDavSettings(), debug: true });
  const controller = new AbortController();
  const run = vi.fn();
  const readSettings = vi.fn(async () => ({ settings }));
  const client = { validateDebugTool() {}, readStartupSettings: readSettings, run } as unknown as PiDaemonClient;
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
    expose,
    run,
    readSettings,
    controller,
    changeSetup() {
      const changed = v3WebDavSettings();
      changed.syncSetups.home.storage.path = "another/path";
      settings = validateSettingsDocument({ ...changed, debug: true });
    },
    replaceOwner() {
      owner = undefined;
    },
    recheck: (signal?: AbortSignal) => execute("test", { action: "recheck" }, signal, undefined, context),
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

test.each(["owner", "cancelled"] as const)(
  "%s during the settings read prevents remote inspection",
  async (changed) => {
    const harness = fixture("tui");
    harness.readSettings.mockImplementationOnce(async () => {
      if (changed === "owner") harness.replaceOwner();
      else harness.controller.abort();
      return { settings: validateSettingsDocument(v3WebDavSettings()) };
    });
    await assert.rejects(harness.recheck(), changed === "owner" ? /session was replaced/u : { name: "AbortError" });
    assert.equal(harness.run.mock.calls.length, 0);
  },
);

test.each(["setup", "owner", "tool cancelled", "session shut down"] as const)(
  "%s during inspection prevents delivery of a stale result",
  async (changed) => {
    const harness = fixture("tui");
    const toolAbort = new AbortController();
    harness.run.mockImplementationOnce(async (operation: string, _payload: unknown, signal: AbortSignal) => {
      assert.equal(operation, "inspect");
      if (changed === "setup") harness.changeSetup();
      else if (changed === "owner") harness.replaceOwner();
      else {
        if (changed === "tool cancelled") toolAbort.abort();
        else harness.controller.abort();
        assert.equal(signal.aborted, true);
      }
    });
    const expected =
      changed === "setup"
        ? /setup changed during recheck/u
        : changed === "owner"
          ? /session was replaced/u
          : { name: "AbortError" };
    await assert.rejects(harness.recheck(toolAbort.signal), expected);
    assert.equal(harness.run.mock.calls.length, 1);
  },
);

test.each(["print", "json"] as const)("a forced call in %s mode does not read settings", async (mode) => {
  const harness = fixture(mode);
  await assert.rejects(harness.recheck(), /requires an interactive session/u);
  assert.equal(harness.readSettings.mock.calls.length, 0);
  assert.equal(harness.run.mock.calls.length, 0);
});
