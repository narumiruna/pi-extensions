import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { test } from "vitest";
import { createMockContext, createMockPi } from "../../../test/support.js";
import sync, { type SyncDependencies } from "../src/sync-extension.js";
import { withTempHome } from "./helpers.js";

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for Sync loader readiness");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function emit(mock: ReturnType<typeof createMockPi>, name: string, event: unknown, ctx: unknown): Promise<void> {
  for (const handler of mock.events.get(name) ?? []) await handler(event, ctx);
}

test("Sync setup switching loads only for the use route and caches the module", async () => {
  await withTempHome(async (agentDir) => {
    await mkdir(agentDir, { recursive: true });
    const mock = createMockPi();
    let loads = 0;
    let uses = 0;
    let snapshotLoads = 0;
    let stateLoads = 0;
    let operationLoads = 0;
    sync(mock.pi, {
      loadSetupSwitch: async () => {
        loads += 1;
        return {
          useSyncSetup: async () => {
            uses += 1;
            return { pullApplied: false };
          },
        };
      },
      loadSnapshot: async () => {
        snapshotLoads += 1;
        return import("../src/snapshot/snapshot.js");
      },
      loadSyncState: async () => {
        stateLoads += 1;
        return import("../src/sync/sync-state.js");
      },
      loadSyncOperations: async () => {
        operationLoads += 1;
        return import("../src/sync/sync-operations.js");
      },
    });
    const context = createMockContext({ hasUI: true, mode: "rpc" });
    await emit(mock, "session_start", { reason: "startup" }, context.ctx);
    assert.equal(loads, 0);
    assert.equal(snapshotLoads, 0);
    assert.equal(stateLoads, 0);
    assert.equal(operationLoads, 0);

    const command = mock.commands.get("sync");
    assert.ok(command);
    await command.handler("help", context.ctx);
    assert.equal(loads, 0);
    assert.equal(snapshotLoads, 0);
    assert.equal(stateLoads, 0);
    assert.equal(operationLoads, 0);
    await command.handler("use work", context.ctx);
    await command.handler("use home", context.ctx);
    assert.equal(loads, 1);
    assert.equal(uses, 2);
    assert.equal(snapshotLoads, 0);
    assert.equal(stateLoads, 0);
    assert.equal(operationLoads, 0);
  });
});

test("Sync operation loading rechecks cancellation before invoking a route", async () => {
  await withTempHome(async (agentDir) => {
    await mkdir(agentDir, { recursive: true });
    const mock = createMockPi();
    let releaseLoad: (() => void) | undefined;
    let statusCalls = 0;
    const operations = {
      status: async () => {
        statusCalls += 1;
      },
    } as unknown as Awaited<ReturnType<SyncDependencies["loadSyncOperations"]>>;
    sync(mock.pi, {
      loadSyncOperations: async () => {
        await new Promise<void>((resolve) => {
          releaseLoad = resolve;
        });
        return operations;
      },
    });
    const first = createMockContext({ hasUI: true, mode: "rpc" });
    await emit(mock, "session_start", { reason: "startup" }, first.ctx);
    const command = mock.commands.get("sync");
    assert.ok(command);

    const pending = command.handler("status", first.ctx);
    await waitFor(() => releaseLoad !== undefined);
    const replacement = createMockContext({ hasUI: true, mode: "rpc" });
    await emit(mock, "session_start", { reason: "new" }, replacement.ctx);
    assert.ok(releaseLoad);
    releaseLoad();
    await pending;
    assert.equal(statusCalls, 0);
  });
});

test("Sync setup-switch loader failure is observable and can retry", async () => {
  await withTempHome(async (agentDir) => {
    await mkdir(agentDir, { recursive: true });
    const mock = createMockPi();
    let loads = 0;
    let uses = 0;
    sync(mock.pi, {
      loadSetupSwitch: async () => {
        loads += 1;
        if (loads === 1) throw new Error("temporary setup loader failure");
        return {
          useSyncSetup: async () => {
            uses += 1;
            return { pullApplied: false };
          },
        };
      },
    });
    const context = createMockContext({ hasUI: true, mode: "rpc" });
    const command = mock.commands.get("sync");
    assert.ok(command);

    await command.handler("use work", context.ctx);
    assert.match(context.notifications.map(({ message }) => message).join("\n"), /temporary setup loader failure/u);
    await command.handler("use work", context.ctx);
    assert.equal(loads, 2);
    assert.equal(uses, 1);
  });
});
