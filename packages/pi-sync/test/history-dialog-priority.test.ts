import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import {
  type ExtensionCommandContext,
  getSelectListTheme,
  initTheme,
  type TerminalInputHandler,
} from "@earendil-works/pi-coding-agent";
import {
  getKeybindings,
  KeybindingsManager,
  SelectList,
  setKeybindings,
  TUI_KEYBINDINGS,
} from "@earendil-works/pi-tui";
import { createTuiHarness } from "@narumitw/pi-tui-kit/testing";
import { test } from "vitest";
import { createMockContext } from "../../../test/support.js";
import { handleCommand } from "../src/commands/command-handler.js";
import { localConfigPath } from "../src/settings/config-file.js";
import { createSyncLoaders } from "../src/sync/sync-loaders.js";
import { runCancellableOperation } from "../src/ui/cancellable-operation.js";
import { trackOperationDialogs } from "../src/ui/operation-dialogs.js";
import { createSyncAttentionController } from "../src/ui/sync-attention.js";
import { v3S3Settings, withTempHome } from "./helpers.js";

initTheme("dark", false);

for (const [key, input, expected] of [
  ["enter", "\r", "first"],
  ["up", "\u001b[A", "third"],
  ["down", "\u001b[B", "second"],
  ["q", "q", "first"],
] as const) {
  test(`History defers colliding ${key} press to a Pi selector and resumes cancellation after it closes`, async () => {
    const previous = getKeybindings();
    const bindings = new KeybindingsManager(TUI_KEYBINDINGS, { "tui.select.cancel": key });
    setKeybindings(bindings);
    const listeners = new Set<TerminalInputHandler>();
    const tui = createTuiHarness({
      keybindings: {
        matches: (data, action) => bindings.matches(data, action as "tui.select.cancel"),
        getKeys: (action) => bindings.getKeys(action as "tui.select.cancel"),
      },
    });
    const context = createMockContext({
      mode: "tui",
      custom: tui.custom,
      onTerminalInput(handler: TerminalInputHandler) {
        listeners.add(handler);
        return () => {
          listeners.delete(handler);
        };
      },
    });
    const ctx = context.ctx as ExtensionCommandContext;
    const selector = new SelectList(
      ["first", "second", "third"].map((value) => ({ value, label: value })),
      3,
      getSelectListTheme(),
    );
    let selected: string | undefined;
    let dialogCancelled = false;
    selector.onSelect = (item) => {
      selected = item.value;
    };
    selector.onCancel = () => {
      dialogCancelled = true;
    };
    let opened!: () => void;
    const dialogOpened = new Promise<void>((resolve) => {
      opened = resolve;
    });
    let finishDialog!: () => void;
    ctx.ui.select = async () =>
      new Promise<string>((resolve) => {
        finishDialog = () => resolve("first");
        opened();
      });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let closed!: () => void;
    const dialogClosed = new Promise<void>((resolve) => {
      closed = resolve;
    });
    let signal: AbortSignal | undefined;
    const running = runCancellableOperation(
      ctx,
      "History",
      "history",
      async (_route, operationSignal, _onCommit, _target, onDialog) => {
        signal = operationSignal;
        await trackOperationDialogs(ctx, onDialog).ui.select("History", ["first"]);
        closed();
        await gate;
        return { kind: "completed" };
      },
      { cancelAcrossDialogs: true },
    );
    const dispatch = (data: string) => {
      for (const listener of listeners) if (listener(data)?.consume) return true;
      selector.handleInput(data);
      return false;
    };
    try {
      await dialogOpened;
      assert.equal(dispatch(input), false);
      assert.equal(signal?.aborted, false);
      assert.equal(dialogCancelled, key === "q");
      assert.equal(selector.getSelectedItem()?.value, expected);
      if (key === "enter") assert.equal(selected, "first");
      // All non-hard-cancel input belongs to the dialog, without reproducing
      // dialog-specific aliases, shortcuts, or priority in the raw listener.
      for (const data of ["j", "k", "\n"]) assert.equal(dispatch(data), false);
      finishDialog();
      await dialogClosed;
      assert.equal(dispatch(input), true);
      assert.equal(signal?.aborted, true);
      release();
      assert.deepEqual(await running, { kind: "cancelled" });
      assert.equal(listeners.size, 0);
    } finally {
      finishDialog?.();
      release();
      tui.dispose();
      await running;
      setKeybindings(previous);
    }
  });
}

for (const committed of [false, true]) {
  test(`History hard Ctrl+C owns root cancellation during a Pi confirmation (committed=${committed})`, async () => {
    const listeners = new Set<TerminalInputHandler>();
    const tui = createTuiHarness();
    const context = createMockContext({
      mode: "tui",
      custom: tui.custom,
      onTerminalInput(handler: TerminalInputHandler) {
        listeners.add(handler);
        return () => {
          listeners.delete(handler);
        };
      },
    });
    const ctx = context.ctx as ExtensionCommandContext;
    let opened!: () => void;
    const dialogOpened = new Promise<void>((resolve) => {
      opened = resolve;
    });
    let finishDialog!: () => void;
    ctx.ui.confirm = async () =>
      new Promise<boolean>((resolve) => {
        finishDialog = () => resolve(false);
        opened();
      });
    let signal: AbortSignal | undefined;
    const running = runCancellableOperation(
      ctx,
      "History",
      "history",
      async (_route, operationSignal, onCommit, _target, onDialog) => {
        signal = operationSignal;
        if (committed) onCommit?.();
        await trackOperationDialogs(ctx, onDialog).ui.confirm("Rollback", "Review");
        return { kind: "completed" };
      },
      { cancelAcrossDialogs: true, commitAware: true },
    );
    try {
      await dialogOpened;
      await tui.waitForOpen();
      const listener = [...listeners][0];
      assert.ok(listener);
      assert.equal(listener("\u001b[99;5:3u"), undefined);
      assert.deepEqual(listener("\u0003"), { consume: true });
      assert.equal(signal?.aborted, !committed);
      finishDialog();
      assert.deepEqual(await running, { kind: committed ? "completed" : "cancelled" });
      assert.equal(listeners.size, 0);
    } finally {
      finishDialog?.();
      tui.dispose();
      await running;
    }
  });
}

for (const end of ["resolve", "reject"] as const) {
  test(`dialog tracking balances nested confirmations on ${end} and forwards live session state`, async () => {
    const context = createMockContext({ mode: "tui" });
    const ctx = context.ctx as ExtensionCommandContext;
    const events: boolean[] = [];
    const tracked = trackOperationDialogs(ctx, (active) => events.push(active));
    const originalManager = ctx.sessionManager;
    ctx.ui.select = async () => {
      Object.assign(ctx, { sessionManager: { ...originalManager, getSessionId: () => "replacement" } });
      await tracked.ui.confirm("Nested", "Review");
      if (end === "reject") throw new Error("injected");
      return "first";
    };
    const task = tracked.ui.select("History", ["first"]);
    if (end === "reject") await assert.rejects(task, /injected/u);
    else assert.equal(await task, "first");
    assert.deepEqual(events, [true, true, false, false]);
    assert.notEqual(tracked.sessionManager, originalManager);
    assert.equal(tracked.sessionManager, ctx.sessionManager);
    assert.equal(trackOperationDialogs(ctx), ctx);
  });
}

test("real manager command forwards History dialog ownership through command execution", async () => {
  await withTempHome(async (agentDir) => {
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(localConfigPath(), JSON.stringify(v3S3Settings()), { mode: 0o600 });
    const listeners = new Set<TerminalInputHandler>();
    const context = createMockContext({
      mode: "tui",
      onTerminalInput(handler: TerminalInputHandler) {
        listeners.add(handler);
        return () => {
          listeners.delete(handler);
        };
      },
    });
    const ctx = context.ctx as ExtensionCommandContext;
    let finishDialog!: () => void;
    let opened!: () => void;
    const dialogOpened = new Promise<void>((resolve) => {
      opened = resolve;
    });
    ctx.ui.select = async () =>
      new Promise<undefined>((resolve) => {
        finishDialog = () => resolve(undefined);
        opened();
      });
    let mainVisits = 0;
    let deferred: boolean | undefined;
    ctx.ui.custom = (async (factory) => {
      const tui = createTuiHarness({ width: 100, rows: 28 });
      try {
        const result = tui.custom(factory);
        await tui.waitForOpen();
        if (tui.render().join("\n").split("\n").includes("Manage sync")) {
          mainVisits++;
          if (mainVisits === 1) {
            for (let index = 0; index < 6; index++) tui.press("tui.select.down");
            tui.press("tui.select.confirm");
          } else tui.press("ctrl+c");
        } else {
          await dialogOpened;
          deferred = [...listeners][0]?.("\u001b") === undefined;
          finishDialog();
        }
        return await result;
      } finally {
        tui.dispose();
      }
    }) as ExtensionCommandContext["ui"]["custom"];
    const loaders = createSyncLoaders({
      loadSyncOperations: async () => ({
        ...(await import("@narumitw/pi-sync-daemon/engine/sync/sync-operations")),
        history: async (routeCtx) => {
          await routeCtx.ui.select("History", ["snapshot"]);
        },
      }),
    });
    await handleCommand("", ctx, new AbortController().signal, loaders, createSyncAttentionController());
    assert.equal(deferred, true);
    assert.equal(mainVisits, 2);
    assert.deepEqual(context.notifications, []);
    assert.equal(listeners.size, 0);
  });
});
