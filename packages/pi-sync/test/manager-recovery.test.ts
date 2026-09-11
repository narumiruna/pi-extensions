import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import fs from "node:fs/promises";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { createRpcHarness, createTuiHarness } from "@narumitw/pi-tui-kit/testing";
import { test } from "vitest";
import { createMockContext } from "../../../test/support.js";
import type { CommandOptions } from "../src/commands/command-types.js";
import { localConfigPath } from "../src/settings/config-file.js";
import { isLockGuardHeld, unlock } from "../src/state/lock.js";
import { classifyOperationAvailability, inspectOperationAvailability } from "../src/state/operation-availability.js";
import { ensureStateDir, lockPath } from "../src/state/sync-state-store.js";
import { describeManagerState } from "../src/ui/manager-state.js";
import { showSyncManager } from "../src/ui/manager-ui.js";
import { v3S3Settings, withTempHome } from "./helpers.js";

initTheme("dark", false);

const unlockOptions: CommandOptions = {
  yes: false,
  force: false,
  stale: true,
  silent: false,
  reload: true,
  auto: false,
  args: [],
};

test("operation availability keeps guarded and inspection-error states distinct", async () => {
  const deadLock = {
    id: "dead-owner",
    pid: 2_147_483_647,
    command: "sync",
    startedAt: new Date().toISOString(),
  };
  assert.equal(classifyOperationAvailability({ status: "valid", lock: deadLock }, true).kind, "busy");
  assert.equal(classifyOperationAvailability({ status: "unreadable" }, false).kind, "recoverable-unreadable");
  const failed = await inspectOperationAvailability({
    inspectMetadata: async () => {
      throw new Error("permission denied");
    },
    inspectGuard: async () => false,
  });
  assert.deepEqual(failed, { kind: "inspection-error", message: "permission denied" });
});

test("operation inspection failures are not mislabeled as settings errors", async () => {
  await withTempHome(async (agentDir) => {
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(localConfigPath(), JSON.stringify(v3S3Settings()), { mode: 0o600 });
    const manager = await describeManagerState(undefined, undefined, async () => ({
      kind: "inspection-error",
      message: "permission denied",
    }));
    assert.match(manager.title, /Lock check failed/iu);
    assert.doesNotMatch(manager.title, /Settings need attention/iu);
    assert.equal(manager.actions[0], "Refresh operation status");
  });
});

async function renderManagerWithLock(contents: string) {
  return withTempHome(async (agentDir) => {
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(localConfigPath(), JSON.stringify(v3S3Settings()), { mode: 0o600 });
    await ensureStateDir();
    writeFileSync(lockPath(), contents);
    const titles: string[] = [];
    const optionsSeen: string[][] = [];
    const { ctx } = createMockContext({
      hasUI: true,
      mode: "tui",
      select: async (title: string, options: string[]) => {
        titles.push(title);
        optionsSeen.push(options);
        return undefined;
      },
    });
    await showSyncManager(ctx, async () => ({ kind: "completed" }));
    return { rendered: titles.join("\n"), options: optionsSeen[0] ?? [] };
  });
}

test("stale operation recovery is the first visible manager action", async () => {
  const { rendered, options } = await renderManagerWithLock(
    JSON.stringify({
      id: "dead-owner",
      pid: 2_147_483_647,
      command: "sync",
      startedAt: new Date().toISOString(),
    }),
  );
  assert.match(rendered, /Sync paused/u);
  assert.match(rendered, /Settings and More.*return/u);
  assert.equal(options[0], "Restore sync access… (recommended)");
});

test("unreadable operation recovery explains that ownership cannot be verified", async () => {
  const { rendered, options } = await renderManagerWithLock("{broken");
  assert.match(rendered, /owner unknown/iu);
  assert.match(rendered, /close other Pi sessions/iu);
  assert.equal(options[0], "Restore sync access… (recommended)");
});

test("a live operation offers refresh without exposing lock removal", async () => {
  const { rendered, options } = await renderManagerWithLock(
    JSON.stringify({
      id: "live-owner",
      pid: process.pid,
      command: "sync\u0007",
      startedAt: new Date().toISOString(),
    }),
  );
  assert.match(rendered, /Running: sync.*\(pid/u);
  assert.equal(rendered.includes("\u0007"), false);
  assert.equal(options[0], "Refresh operation status");
  assert.equal(
    options.some((option) => /Restore sync access/u.test(option)),
    false,
  );
});

test("guard-only operation state asks the user to wait instead of looking free", async () => {
  await withTempHome(async (agentDir) => {
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(localConfigPath(), JSON.stringify(v3S3Settings()), { mode: 0o600 });
    await ensureStateDir();
    mkdirSync(`${lockPath()}.guard`);
    const titles: string[] = [];
    const optionsSeen: string[][] = [];
    const { ctx } = createMockContext({
      hasUI: true,
      mode: "tui",
      select: async (title: string, options: string[]) => {
        titles.push(title);
        optionsSeen.push(options);
        return undefined;
      },
    });
    await showSyncManager(ctx, async () => ({ kind: "completed" }));
    assert.match(titles.join("\n"), /starting or finishing/iu);
    assert.equal(optionsSeen[0]?.[0], "Refresh operation status");
    assert.equal(
      optionsSeen[0]?.some((option) => /Restore sync access/u.test(option)),
      false,
    );
  });
});

test("RPC stale recovery confirms the local-only effect and returns directly to the normal manager", async () => {
  await withTempHome(async (agentDir) => {
    mkdirSync(agentDir, { recursive: true });
    const settingsBytes = Buffer.from(JSON.stringify(v3S3Settings()));
    writeFileSync(localConfigPath(), settingsBytes, { mode: 0o600 });
    await ensureStateDir();
    writeFileSync(
      lockPath(),
      JSON.stringify({
        id: "dead-owner",
        pid: 2_147_483_647,
        command: "sync",
        startedAt: new Date().toISOString(),
      }),
    );
    const rpc = createRpcHarness([
      { kind: "select", response: "Restore sync access… (recommended)" },
      { kind: "select", response: "Remove local lock and continue" },
      { kind: "select", response: undefined },
    ]);
    const base = createMockContext({ hasUI: true, mode: "rpc" });
    const ctx = withRpcUi(base.ctx, rpc);
    const routes: string[] = [];
    await showSyncManager(ctx, async (route) => {
      routes.push(route);
      if (route === "unlock") await fs.rm(lockPath(), { force: true });
      return { kind: "completed" };
    });
    rpc.assertConsumed();
    assert.deepEqual(routes, ["unlock"]);
    assert.equal(await fileExists(lockPath()), false);
    assert.deepEqual(readFileSync(localConfigPath()), settingsBytes);
    assert.match(rpc.dialogs[1]?.title ?? "", /only the local operation lock/iu);
    assert.ok(rpc.dialogs[2]?.options?.includes("More…"));
  });
});

test("RPC unreadable recovery uses explicit stale authorization", async () => {
  await withTempHome(async (agentDir) => {
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(localConfigPath(), JSON.stringify(v3S3Settings()), { mode: 0o600 });
    await ensureStateDir();
    writeFileSync(lockPath(), "{broken");
    const rpc = createRpcHarness([
      { kind: "select", response: "Restore sync access… (recommended)" },
      { kind: "select", response: "Remove local lock and continue" },
      { kind: "select", response: undefined },
    ]);
    const base = createMockContext({ hasUI: true, mode: "rpc" });
    const ctx = withRpcUi(base.ctx, rpc);
    const routes: string[] = [];
    await showSyncManager(ctx, async (route) => {
      routes.push(route);
      if (route === "unlock --stale") await fs.rm(lockPath(), { force: true });
      return { kind: "completed" };
    });
    rpc.assertConsumed();
    assert.deepEqual(routes, ["unlock --stale"]);
    assert.match(rpc.dialogs[1]?.title ?? "", /cannot verify who owns/iu);
  });
});

test("recovery cancellation preserves the lock and returns to the paused manager", async () => {
  await withTempHome(async (agentDir) => {
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(localConfigPath(), JSON.stringify(v3S3Settings()), { mode: 0o600 });
    await ensureStateDir();
    const bytes = Buffer.from("{broken");
    writeFileSync(lockPath(), bytes);
    const rpc = createRpcHarness([
      { kind: "select", response: "Restore sync access… (recommended)" },
      { kind: "select", response: "Cancel" },
      { kind: "select", response: undefined },
    ]);
    const base = createMockContext({ hasUI: true, mode: "rpc" });
    const ctx = withRpcUi(base.ctx, rpc);
    let routeCalled = false;
    await showSyncManager(ctx, async () => {
      routeCalled = true;
      return { kind: "completed" };
    });
    rpc.assertConsumed();
    assert.equal(routeCalled, false);
    assert.deepEqual(readFileSync(lockPath()), bytes);
    assert.match(base.notifications.at(-1)?.message ?? "", /cancelled.*not changed/iu);
    assert.equal(rpc.dialogs[2]?.options?.[0], "Restore sync access… (recommended)");
  });
});

test("refresh returns a finished live operation directly to the normal manager", async () => {
  await withTempHome(async (agentDir) => {
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(localConfigPath(), JSON.stringify(v3S3Settings()), { mode: 0o600 });
    await ensureStateDir();
    writeFileSync(
      lockPath(),
      JSON.stringify({
        id: "live-owner",
        pid: process.pid,
        command: "sync",
        startedAt: new Date().toISOString(),
      }),
    );
    const optionsSeen: string[][] = [];
    const { ctx } = createMockContext({
      hasUI: true,
      mode: "tui",
      select: async (_title: string, options: string[]) => {
        optionsSeen.push(options);
        if (options[0] === "Refresh operation status") {
          await fs.rm(lockPath(), { force: true });
          return "Refresh operation status";
        }
        return undefined;
      },
    });
    await showSyncManager(ctx, async () => ({ kind: "completed" }));
    assert.equal(optionsSeen[0]?.[0], "Refresh operation status");
    assert.ok(optionsSeen[1]?.includes("More…"));
  });
});

test("a lock that becomes live during recovery is not removed and refreshes to the live state", async () => {
  await withTempHome(async (agentDir) => {
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(localConfigPath(), JSON.stringify(v3S3Settings()), { mode: 0o600 });
    await ensureStateDir();
    writeFileSync(lockPath(), "{broken");
    const rpc = createRpcHarness([
      { kind: "select", response: "Restore sync access… (recommended)" },
      { kind: "select", response: "Remove local lock and continue" },
      { kind: "select", response: undefined },
    ]);
    const base = createMockContext({ hasUI: true, mode: "rpc" });
    const ctx = withRpcUi(base.ctx, rpc);
    await showSyncManager(ctx, async () => {
      writeFileSync(
        lockPath(),
        JSON.stringify({
          id: "new-live-owner",
          pid: process.pid,
          command: "pull",
          startedAt: new Date().toISOString(),
        }),
      );
      return { kind: "completed" };
    });
    rpc.assertConsumed();
    assert.equal(rpc.dialogs[2]?.options?.[0], "Refresh operation status");
    assert.equal(await fileExists(lockPath()), true);
  });
});

test("a guard acquired after confirmation blocks the real unlock path", async () => {
  await withTempHome(async (agentDir) => {
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(localConfigPath(), JSON.stringify(v3S3Settings()), { mode: 0o600 });
    await ensureStateDir();
    const bytes = Buffer.from("{broken");
    writeFileSync(lockPath(), bytes);
    const optionsSeen: string[][] = [];
    let selection = 0;
    const mock = createMockContext({
      hasUI: true,
      mode: "rpc",
      select: async (_title: string, options: string[]) => {
        optionsSeen.push(options);
        selection += 1;
        if (selection === 1) return "Restore sync access… (recommended)";
        if (selection === 2) {
          mkdirSync(`${lockPath()}.guard`);
          return "Remove local lock and continue";
        }
        return undefined;
      },
    });
    await showSyncManager(mock.ctx, async (route, signal) => {
      assert.equal(route, "unlock --stale");
      await unlock(mock.ctx, { ...unlockOptions, signal });
      return { kind: "completed" };
    });
    assert.deepEqual(readFileSync(lockPath()), bytes);
    assert.equal(optionsSeen[2]?.[0], "Refresh operation status");
    assert.match(mock.notifications.at(-1)?.message ?? "", /currently running/iu);
  });
});

test("recovery from History returns directly to the normal main manager", async () => {
  await withTempHome(async (agentDir) => {
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(localConfigPath(), JSON.stringify(v3S3Settings()), { mode: 0o600 });
    await ensureStateDir();
    writeFileSync(lockPath(), "{broken");
    const rpc = createRpcHarness([
      { kind: "select", response: "History & recovery…" },
      { kind: "select", response: "Recover stale operation" },
      { kind: "select", response: "Remove local lock and continue" },
      { kind: "select", response: undefined },
    ]);
    const base = createMockContext({ hasUI: true, mode: "rpc" });
    const ctx = withRpcUi(base.ctx, rpc);
    await showSyncManager(ctx, async (route) => {
      assert.equal(route, "unlock --stale");
      await fs.rm(lockPath(), { force: true });
      return { kind: "completed" };
    });
    rpc.assertConsumed();
    assert.ok(rpc.dialogs[3]?.options?.includes("More…"));
  });
});

test("cancelling recovery from History stays in recovery without calling unlock", async () => {
  await withTempHome(async (agentDir) => {
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(localConfigPath(), JSON.stringify(v3S3Settings()), { mode: 0o600 });
    await ensureStateDir();
    const bytes = Buffer.from("{broken");
    writeFileSync(lockPath(), bytes);
    const rpc = createRpcHarness([
      { kind: "select", response: "History & recovery…" },
      { kind: "select", response: "Recover stale operation" },
      { kind: "select", response: "Cancel" },
      { kind: "select", response: "Back" },
      { kind: "select", response: undefined },
    ]);
    const base = createMockContext({ hasUI: true, mode: "rpc" });
    const ctx = withRpcUi(base.ctx, rpc);
    let routeCalled = false;
    await showSyncManager(ctx, async () => {
      routeCalled = true;
      return { kind: "completed" };
    });
    rpc.assertConsumed();
    assert.equal(routeCalled, false);
    assert.deepEqual(readFileSync(lockPath()), bytes);
    assert.ok(rpc.dialogs[3]?.options?.includes("Recover stale operation"));
  });
});

test("an owner abort immediately after confirmation cannot start unlock routing", async () => {
  await withTempHome(async (agentDir) => {
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(localConfigPath(), JSON.stringify(v3S3Settings()), { mode: 0o600 });
    await ensureStateDir();
    const bytes = Buffer.from("{broken");
    writeFileSync(lockPath(), bytes);
    const owner = new AbortController();
    let selection = 0;
    const { ctx } = createMockContext({
      hasUI: true,
      mode: "rpc",
      select: async () => {
        selection += 1;
        if (selection === 1) return "Restore sync access… (recommended)";
        owner.abort(new DOMException("Session replaced", "AbortError"));
        return "Remove local lock and continue";
      },
    });
    let routeCalled = false;
    await showSyncManager(
      ctx,
      async () => {
        routeCalled = true;
        return { kind: "completed" };
      },
      owner.signal,
    );
    assert.equal(routeCalled, false);
    assert.deepEqual(readFileSync(lockPath()), bytes);
  });
});

test("abort after lock removal still releases the guard and suppresses stale success UI", async () => {
  await withTempHome(async (agentDir) => {
    mkdirSync(agentDir, { recursive: true });
    await ensureStateDir();
    writeFileSync(
      lockPath(),
      JSON.stringify({
        id: "dead-owner",
        pid: 2_147_483_647,
        command: "sync",
        startedAt: new Date().toISOString(),
      }),
    );
    const owner = new AbortController();
    const originalRm = fs.rm;
    fs.rm = (async (...args: Parameters<typeof fs.rm>) => {
      const result = await originalRm(...args);
      if (args[0] === lockPath()) {
        owner.abort(new DOMException("Session replaced", "AbortError"));
      }
      return result;
    }) as typeof fs.rm;
    const mock = createMockContext({ hasUI: true, mode: "tui" });
    try {
      await unlock(mock.ctx, { ...unlockOptions, signal: owner.signal });
      assert.equal(await fileExists(lockPath()), false);
      assert.equal(await isLockGuardHeld(), false);
      assert.equal(
        mock.notifications.some(({ message }) => /Removed stale/iu.test(message)),
        false,
      );
    } finally {
      fs.rm = originalRm;
    }
  });
});

test("operation frames stay bounded and actionable at supported terminal sizes", async () => {
  const scenarios = [
    {
      name: "unreadable",
      prepare: () => writeFileSync(lockPath(), "{broken"),
      action: /Restore sync access/iu,
    },
    {
      name: "stale",
      prepare: () =>
        writeFileSync(
          lockPath(),
          JSON.stringify({
            id: "dead-owner",
            pid: 2_147_483_647,
            command: "sync",
            startedAt: new Date().toISOString(),
          }),
        ),
      action: /Restore sync access/iu,
    },
    {
      name: "live",
      prepare: () =>
        writeFileSync(
          lockPath(),
          JSON.stringify({
            id: "live-owner",
            pid: process.pid,
            command: "a-very-long-sync-operation-name",
            startedAt: new Date().toISOString(),
          }),
        ),
      action: /Refresh operation status/iu,
    },
    {
      name: "guarded",
      prepare: () => mkdirSync(`${lockPath()}.guard`),
      action: /Refresh operation status/iu,
    },
  ];
  for (const scenario of scenarios) {
    for (const { width, rows } of [
      { width: 32, rows: 12 },
      { width: 60, rows: 16 },
      { width: 100, rows: 24 },
    ]) {
      await withTempHome(async (agentDir) => {
        mkdirSync(agentDir, { recursive: true });
        writeFileSync(localConfigPath(), JSON.stringify(v3S3Settings()), { mode: 0o600 });
        await ensureStateDir();
        scenario.prepare();
        const tui = createTuiHarness({ width, rows });
        const { ctx } = createMockContext({ hasUI: true, mode: "tui", custom: tui.custom });
        const running = showSyncManager(ctx, async () => ({ kind: "completed" }));
        await tui.waitForOpen();
        const frame = tui.render();
        assert.ok(frame.every((line) => visibleWidth(line) <= width));
        assert.ok(frame.length <= rows, `${scenario.name} rendered ${frame.length} rows into a ${rows}-row terminal`);
        assert.match(frame.join("\n"), scenario.action);
        tui.press("ctrl+c");
        await running;
      });
    }
  }
});

test("session replacement during recovery confirmation leaves the lock untouched", async () => {
  await withTempHome(async (agentDir) => {
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(localConfigPath(), JSON.stringify(v3S3Settings()), { mode: 0o600 });
    await ensureStateDir();
    const bytes = Buffer.from("{broken");
    writeFileSync(lockPath(), bytes);
    const owner = new AbortController();
    const tui = createTuiHarness({ width: 60, rows: 16 });
    const { ctx } = createMockContext({ hasUI: true, mode: "tui", custom: tui.custom });
    let routeCalled = false;
    const running = showSyncManager(
      ctx,
      async () => {
        routeCalled = true;
        return { kind: "completed" };
      },
      owner.signal,
    );
    await tui.waitForOpen();
    tui.press("tui.select.confirm");
    await waitForOpenCount(tui, 2);
    owner.abort(new DOMException("Session replaced", "AbortError"));
    await running;
    assert.equal(routeCalled, false);
    assert.deepEqual(readFileSync(lockPath()), bytes);
  });
});

function withRpcUi(context: unknown, rpc: ReturnType<typeof createRpcHarness>): never {
  const base = context as { ui: Record<string, unknown>; [key: string]: unknown };
  return { ...base, ui: { ...base.ui, ...rpc.ui } } as never;
}

async function fileExists(filePath: string) {
  try {
    await fs.stat(filePath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function waitForOpenCount(tui: ReturnType<typeof createTuiHarness>, count: number) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (tui.openCount >= count) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  assert.fail(`Timed out waiting for ${count} TUI interactions`);
}
