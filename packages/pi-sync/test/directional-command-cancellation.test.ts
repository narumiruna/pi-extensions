import assert from "node:assert/strict";
import { type ExtensionCommandContext, initTheme } from "@earendil-works/pi-coding-agent";
import type { DaemonConnection } from "@narumitw/pi-sync-daemon";
import { createTuiHarness } from "@narumitw/pi-tui-kit/testing";
import { test, vi } from "vitest";
import { createMockContext } from "../../../test/support.js";
import { withTempHome } from "./helpers.js";

initTheme("dark", false);

const fingerprint = "a".repeat(64);
const verified = { outcome: "applied", message: "Local backup: /test/restore.json" };

test.each([
  "action cancellation",
  "session cancellation",
  "replaced client",
  "paused for replacement",
  "retired SDK context",
] as const)("a verified Pull reports its backup only to the current owner: %s", (end) =>
  withTempHome(async () => {
    vi.resetModules();
    const { bindPiDaemonClient } = await import("../src/daemon/pi-client.js");
    const { executeCommand } = await import("../src/commands/command-execution.js");
    const { runDirectionalRecovery } = await import("../src/daemon/directional-recovery.js");
    const { createSyncLoaders } = await import("../src/sync/sync-loaders.js");
    const { runCancellableOperation } = await import("../src/ui/cancellable-operation.js");
    const tui = end === "action cancellation" ? createTuiHarness() : undefined;
    let active = true;
    const context = createMockContext({
      mode: tui ? "tui" : "rpc",
      ...(tui ? { custom: tui.custom } : {}),
      isIdle: () => {
        if (!active) throw new Error("The SDK context is retired.");
        return true;
      },
    });
    const ctx = context.ctx as ExtensionCommandContext;
    const session = new AbortController();
    const client = bindPiDaemonClient(ctx, session.signal);
    const entered = Promise.withResolvers<void>();
    const drain = Promise.withResolvers<void>();
    const run = vi.spyOn(client, "run").mockImplementation(async (_operation, _payload, signal) => {
      const owned = signal ? AbortSignal.any([session.signal, signal]) : session.signal;
      return runDirectionalRecovery(
        {} as DaemonConnection,
        owned,
        async (checkpoint) => {
          checkpoint.job = "verified-pull";
          return { foregroundQueueCleanup: "verified-result", result: verified };
        },
        async () => {
          entered.resolve();
          await drain.promise;
          owned.throwIfAborted();
          throw new Error("Recovery could not use the old owner.");
        },
        () => {},
      );
    });
    const route = (_route: string, signal?: AbortSignal) =>
      executeCommand("pull", ctx, signal, createSyncLoaders({}), undefined, "test", undefined, false, fingerprint);
    const running = tui
      ? runCancellableOperation(ctx, "Pulling…", "pull", route, { signal: session.signal, cancelledMessage: null })
      : route("pull", session.signal);
    let replacement: ReturnType<typeof bindPiDaemonClient> | undefined;
    try {
      await Promise.race([entered.promise, running.then(() => assert.fail("Pull did not reach recovery."))]);
      if (tui) {
        await tui.waitForOpen();
        tui.press("ctrl+c");
      } else if (end === "session cancellation") session.abort(new DOMException("Session changed", "AbortError"));
      else if (end === "replaced client") replacement = bindPiDaemonClient(ctx, new AbortController().signal);
      else if (end === "paused for replacement") await client.pauseForSessionChange();
      else active = false;
      drain.resolve();
      assert.deepEqual(await running, { kind: tui ? "cancelled" : "failed" });
      assert.equal(run.mock.calls.length, 1);
      if (tui) {
        assert.equal(context.notifications.length, 1);
        assert.equal(context.notifications[0]?.level, "error");
        assert.match(
          context.notifications[0]?.message ?? "",
          /recovery was cancelled.*Local backup: \/test\/restore\.json/u,
        );
      } else assert.deepEqual(context.notifications, []);
    } finally {
      drain.resolve();
      tui?.dispose();
      await Promise.allSettled([running, client.dispose(), replacement?.dispose()]);
    }
  }),
);
