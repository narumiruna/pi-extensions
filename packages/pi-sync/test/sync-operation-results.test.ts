import assert from "node:assert/strict";
import { test, vi } from "vitest";
import { createMockContext } from "../../../test/support.js";
import { executeCommand } from "../src/commands/command-execution.js";
import { remoteOperation } from "../src/daemon/pi-client.js";
import { createSyncLoaders } from "../src/sync/sync-loaders.js";
import { pull, push, syncBoth } from "../src/sync/sync-operations.js";
import { mergeOptions } from "./merge-options.js";

const foreground = vi.hoisted(() => ({ run: vi.fn(), canReportDirectionalResult: () => true }));
vi.mock("../src/daemon/pi-client.js", () => ({
  piDaemonClient: () => foreground,
  remoteOperation: vi.fn(),
}));

for (const [direction, outcome] of [
  ["push", "applied"],
  ["pull", "cancelled"],
] as const) {
  test(`only the bound ${direction} action uses the foreground RPC contract`, async () => {
    const message = "Directional transfer result.";
    const run = foreground.run.mockReset().mockResolvedValue({ outcome, message });
    const legacy = vi.mocked(remoteOperation).mockReset().mockResolvedValue("cancelled");
    const context = createMockContext({ mode: "rpc" });
    const loaders = createSyncLoaders({});
    const signal = new AbortController().signal;
    const onCommit = () => {};
    const fingerprint = "f".repeat(64);
    const result = await executeCommand(
      direction,
      context.ctx,
      signal,
      loaders,
      onCommit,
      "home",
      undefined,
      false,
      fingerprint,
    );
    assert.deepEqual(result, { kind: "completed", outcome });
    assert.deepEqual(run.mock.calls, [
      [`${direction}.foreground`, { setup: "home", fingerprint }, signal, context.ctx, onCommit],
    ]);
    assert.deepEqual(legacy.mock.calls, []);
    assert.deepEqual(context.notifications, [{ message, level: "info" }]);

    const direct = await executeCommand(
      `${direction} --setup work --force --yes`,
      context.ctx,
      signal,
      loaders,
      onCommit,
    );
    assert.deepEqual(direct, { kind: "completed", outcome: "cancelled" });
    assert.equal(run.mock.calls.length, 1);
    assert.deepEqual(legacy.mock.calls, [
      [context.ctx, direction, { ...mergeOptions, setup: "work", force: true, reload: true, signal, onCommit }],
    ]);
    assert.deepEqual(context.notifications, [{ message, level: "info" }]);
  });
}

test("only interactive foreground Sync now accepts an archived journal result", async () => {
  const remote = vi.mocked(remoteOperation).mockResolvedValue("archived");
  const options = { ...mergeOptions, yes: false };
  const { ctx } = createMockContext({ mode: "rpc", hasUI: true });
  assert.equal(await syncBoth(ctx, options), "archived");
  assert.deepEqual(remote.mock.calls, [[ctx, "sync", options]]);

  const automatic = { ...options, auto: true };
  await assert.rejects(syncBoth(ctx, automatic), /Invalid transfer result/);
  assert.deepEqual(remote.mock.lastCall, [ctx, "startup-transfer", automatic]);

  const headless = createMockContext({ mode: "json", hasUI: false }).ctx;
  for (const run of [
    () => push(ctx, options),
    () => pull(ctx, options),
    () => syncBoth(ctx, { ...options, yes: true }),
    () => syncBoth(ctx, { ...options, agentRetryRefusal: true }),
    () => syncBoth(headless, options),
  ]) {
    await assert.rejects(run(), /Invalid transfer result/);
  }
});
