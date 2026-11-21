import assert from "node:assert/strict";
import { test, vi } from "vitest";
import { createMockContext } from "../../../test/support.js";
import { remoteOperation } from "../src/daemon/pi-client.js";
import { pull, push, syncBoth } from "../src/sync/sync-operations.js";
import { mergeOptions } from "./merge-options.js";

vi.mock("../src/daemon/pi-client.js", () => ({ remoteOperation: vi.fn() }));

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
