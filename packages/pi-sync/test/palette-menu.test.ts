import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { type ExtensionCommandContext, initTheme, type KeybindingsManager } from "@earendil-works/pi-coding-agent";
import { type Component, StdinBuffer, visibleWidth } from "@earendil-works/pi-tui";
import { createTuiHarness } from "@narumitw/pi-tui-kit/testing";
import { test } from "vitest";
import { createMockContext } from "../../../test/support.js";
import { localConfigPath } from "../src/settings/config-file.js";
import type { RunRoute, RunRouteResult } from "../src/ui/cancellable-operation.js";
import { showSyncManager } from "../src/ui/manager-ui.js";
import { v3S3Settings, withTempHome } from "./helpers.js";

initTheme("dark", false);

const ordinaryActions = [
  { label: "Sync…", rpcLabel: "Sync now", route: "sync", description: "Merge changes on both sides." },
  { label: "Pull from remote", route: "pull", description: "Remote → this device; replaces conflicting local files." },
  { label: "Push to remote", route: "push", description: "This device → remote; replaces conflicting remote files." },
  { label: "View differences", route: "diff", description: "Inspect changes; no transfer." },
  { label: "Settings", route: undefined, description: "Edit settings, setups, and storage connections." },
  { label: "History", route: "history", description: "Review snapshots and recovery options." },
] as const;

const pasteStart = "\u001b[200~";
const pasteEnd = "\u001b[201~";

type Harness = ReturnType<typeof createTuiHarness>;
type CustomComponent = Component & { dispose?(): void };
type RouteCall = {
  route: string;
  signal?: AbortSignal;
  onCommit?: () => void;
  target?: string;
  retry?: boolean;
};

async function configured(run: () => Promise<void>, alternateSetup = false) {
  await withTempHome(async (agentDir) => {
    mkdirSync(agentDir, { recursive: true });
    const settings = v3S3Settings();
    if (alternateSetup) {
      Object.assign(settings.syncSetups, {
        work: {
          ...settings.syncSetups.home,
          storage: { ...settings.syncSetups.home.storage, path: "pi-sync/work" },
        },
      });
    }
    writeFileSync(localConfigPath(), JSON.stringify(settings), { mode: 0o600 });
    const before = readFileSync(localConfigPath());
    await run();
    assert.deepEqual(readFileSync(localConfigPath()), before);
  });
}

async function withPalette(
  run: (fixture: {
    tui: Harness;
    owner: AbortController;
    running: Promise<void>;
    routes: RouteCall[];
    routeStarted: Promise<RouteCall>;
    completeRoute(result?: RunRouteResult): void;
    confirmations: Array<{ title: string; body: string; signal?: AbortSignal }>;
    notifications: ReturnType<typeof createMockContext>["notifications"];
    component(): CustomComponent;
  }) => Promise<void>,
  keybindings?: Pick<KeybindingsManager, "matches" | "getKeys">,
  alternateSetup = false,
) {
  await configured(async () => {
    const tui = createTuiHarness({ width: 80, rows: 28, keybindings });
    const owner = new AbortController();
    const started = deferred<RouteCall>();
    const release = deferred<RunRouteResult | undefined>();
    const routes: RouteCall[] = [];
    const confirmations: Array<{ title: string; body: string; signal?: AbortSignal }> = [];
    let component: CustomComponent | undefined;
    const custom: ExtensionCommandContext["ui"]["custom"] = (factory, options) =>
      tui.custom(async (...args) => {
        component = await factory(...args);
        return component;
      }, options);
    const context = createMockContext({
      mode: "tui",
      custom,
      confirm: async (title: string, body: string, options?: { signal?: AbortSignal }) => {
        confirmations.push({ title, body, signal: options?.signal });
        return true;
      },
    });
    const route: RunRoute = async (route, signal, onCommit, target, _onDialog, retry) => {
      const call = { route, signal, onCommit, target, retry };
      routes.push(call);
      started.resolve(call);
      return release.promise;
    };
    const running = showSyncManager(context.ctx, route, owner.signal);
    try {
      await tui.waitForOpen();
      await run({
        tui,
        owner,
        running,
        routes,
        routeStarted: started.promise,
        completeRoute: (result) => release.resolve(result),
        confirmations,
        notifications: context.notifications,
        component() {
          assert.ok(component);
          return component;
        },
      });
      assert.equal(
        context.notifications.some((entry) => entry.level === "error"),
        false,
      );
    } finally {
      owner.abort();
      release.resolve({ kind: "completed", outcome: "cancelled" });
      tui.dispose();
      await running;
    }
  }, alternateSetup);
}

function selectedLabel(frame: readonly string[]) {
  return frame
    .find((line) => line.startsWith("→ "))
    ?.slice(2)
    .trimEnd();
}

function choiceRows(frame: readonly string[]) {
  return frame.filter((line) => ordinaryActions.some(({ label }) => line === `→ ${label}` || line === `  ${label}`));
}

function assertSelectedDescription(frame: readonly string[], label: string) {
  assert.equal(selectedLabel(frame), label, frame.join("\n"));
  for (const action of ordinaryActions) {
    assert.equal(frame.includes(action.description), action.label === label, action.description);
  }
}

function remappedKeys(): Pick<KeybindingsManager, "matches" | "getKeys"> {
  const keys: Record<string, string> = {
    "tui.select.up": "k",
    "tui.select.down": "j",
    "tui.select.confirm": "x",
    "tui.select.cancel": "q",
  };
  return {
    matches: (data, action) => data === keys[action],
    getKeys: (action) => (keys[action] ? [keys[action] as never] : []),
  };
}

function deferred<Value>() {
  let resolve!: (value: Value) => void;
  const promise = new Promise<Value>((complete) => (resolve = complete));
  return { promise, resolve };
}

test("TUI manager shows all six standard choices without search and keeps the frame stable", async () => {
  await withPalette(async ({ tui, routes }) => {
    const frames: Array<readonly string[]> = [];
    for (const action of ordinaryActions) {
      const frame = tui.render();
      frames.push(frame);
      assertSelectedDescription(frame, action.label);
      assert.equal(choiceRows(frame).length, ordinaryActions.length, frame.join("\n"));
      assert.equal(frame[0], "─".repeat(80));
      assert.equal(frame.at(-1), "─".repeat(80));
      assert.ok(frame.length <= 25);
      assert.ok(frame.every((line) => visibleWidth(line) <= 80));
      assert.doesNotMatch(frame.join("\n"), /Search:/u);
      tui.press("tui.select.down");
    }
    assert.equal(new Set(frames.map((frame) => frame.length)).size, 1, "navigation must not resize the normal frame");
    assert.equal(selectedLabel(tui.render()), "Sync…");
    assert.equal(tui.isFocusable, false, "no focused text entry");
    assert.deepEqual(routes, []);
  });
});

test("an extra setup adds a reachable scrolling action without enabling search", async () => {
  await withPalette(
    async ({ tui, routes }) => {
      assert.equal(choiceRows(tui.render()).length, ordinaryActions.length);
      assert.ok(!tui.render().some((line) => line.includes("Switch sync setup")));
      tui.press("end");
      const frame = tui.render();
      assert.equal(selectedLabel(frame), "Switch sync setup");
      assert.doesNotMatch(frame.join("\n"), /Search:/u);
      assert.deepEqual(routes, []);
    },
    undefined,
    true,
  );
});

for (const action of ordinaryActions) {
  if (!action.route) continue;
  test(`TUI navigation activates ${action.label} through the existing ${action.route} handler`, async () => {
    await withPalette(async ({ tui, routeStarted, completeRoute, routes, confirmations }) => {
      for (let step = 0; step < ordinaryActions.indexOf(action); step++) tui.press("tui.select.down");
      assertSelectedDescription(tui.render(), action.label);
      assert.deepEqual(routes, []);
      tui.press("tui.select.confirm");
      const call = await routeStarted;
      await tui.waitForOpen();
      assert.equal(call.route, action.route);
      assert.equal(call.target, "home");
      assert.ok(call.signal instanceof AbortSignal);
      assert.equal(call.signal.aborted, false);
      assert.equal(call.retry, undefined);
      assert.equal(
        typeof call.onCommit,
        ["sync", "pull", "push", "history"].includes(action.route) ? "function" : "undefined",
      );
      assert.deepEqual(confirmations, []);
      completeRoute({ kind: "completed", outcome: "cancelled" });
      await tui.waitForPending();
      await tui.waitForOpen();
      const returned = tui.render();
      assertSelectedDescription(returned, action.label);
      assert.doesNotMatch(returned.join("\n"), /Search:/u);
      assert.equal(routes.length, 1);
    });
  });
}

test("Settings keeps its own search and returns to the same main-menu choice without writing", async () => {
  await withPalette(async ({ tui, routes }) => {
    tui.press("end");
    tui.press("tui.select.up");
    assertSelectedDescription(tui.render(), "Settings");
    tui.press("tui.select.confirm");
    await tui.waitForOpen();
    const settings = tui.render();
    assert.ok(settings.includes("Pi Sync Settings"), settings.join("\n"));
    assert.match(settings.join("\n"), /Type to search/u);
    tui.press("tui.select.cancel");
    await tui.waitForPending();
    await tui.waitForOpen();
    assertSelectedDescription(tui.render(), "Settings");
    assert.doesNotMatch(tui.render().join("\n"), /Search:/u);
    assert.deepEqual(routes, []);
  });
});

test("typing in the main menu does not filter, move, or activate a choice", async () => {
  await withPalette(async ({ tui, routes }) => {
    tui.press("tui.select.down");
    const frame = tui.render();
    for (const input of ["History", "storage connections", "Check remote status", "Diagnostics", "\u007f"]) {
      tui.type(input);
      assert.deepEqual(tui.render(), frame);
    }
    assert.deepEqual(routes, []);
  });
});

for (const chunked of [false, true]) {
  test(`${chunked ? "multi-chunk" : "single-chunk"} bracketed paste never activates navigation, confirm or cancel keys`, async () => {
    await withPalette(async ({ tui, routes, confirmations }) => {
      const buffer = new StdinBuffer();
      buffer.on("data", (data) => tui.send(data));
      buffer.on("paste", (data) => tui.send(`${pasteStart}${data}${pasteEnd}`));
      const initial = tui.render();
      try {
        const chunks = chunked
          ? [pasteStart, "x", "q", "j", "k", "\r", "\u0003", "\u001b[20", "1~"]
          : [`${pasteStart}xqjk\r\u0003${pasteEnd}`];
        for (const chunk of chunks) buffer.process(chunk);
        assert.equal(tui.isOpen, true);
        assert.equal(tui.openCount, 1);
        assert.deepEqual(tui.render(), initial);
        assert.deepEqual(routes, []);
        assert.deepEqual(confirmations, []);
        buffer.process("j");
        assertSelectedDescription(tui.render(), "Pull from remote");
      } finally {
        buffer.destroy();
      }
    }, remappedKeys());
  });
}

for (const remapped of [false, true]) {
  test(`cancelled read-only check retains selection with ${remapped ? "remapped" : "default"} keys`, async () => {
    await withPalette(
      async ({ tui, routeStarted, completeRoute, routes }) => {
        for (let step = 0; step < 3; step++) {
          if (remapped) tui.send("j");
          else tui.press("tui.select.down");
        }
        assertSelectedDescription(tui.render(), "View differences");
        if (remapped) tui.send("x");
        else tui.press("tui.select.confirm");
        const call = await routeStarted;
        await tui.waitForOpen();
        assert.equal(call.route, "diff");
        assert.match(tui.render().join("\n"), /Comparing local and remote/u);
        if (remapped) tui.send("q");
        else tui.press("tui.select.cancel");
        assert.equal(call.signal?.aborted, true);
        completeRoute({ kind: "completed", outcome: "cancelled" });
        await tui.waitForPending();
        await tui.waitForOpen();
        const returned = tui.render();
        assertSelectedDescription(returned, "View differences");
        assert.equal(choiceRows(returned).length, ordinaryActions.length);
        assert.equal(routes.length, 1);
      },
      remapped ? remappedKeys() : undefined,
    );
  });
}

for (const reason of ["remapped Back", "hard Ctrl+C", "session replacement", "disposal"] as const) {
  test(`${reason} releases an in-flight directional action without starting a second route`, async () => {
    await withPalette(async ({ tui, owner, running, routeStarted, completeRoute, routes, confirmations }) => {
      tui.send("j");
      tui.send("x");
      const call = await routeStarted;
      await tui.waitForOpen();
      assert.equal(call.route, "pull");
      assert.match(tui.render().join("\n"), /Pulling from remote…/u);
      assert.equal(call.signal?.aborted, false);
      if (reason === "remapped Back") tui.send("q");
      else if (reason === "hard Ctrl+C") tui.press("ctrl+c");
      else if (reason === "session replacement") owner.abort(new DOMException(reason, "AbortError"));
      else tui.dispose();
      assert.equal(call.signal?.aborted, true);
      // A late result cannot open a review or apply a second time.
      completeRoute({ kind: "completed", outcome: "applied" });
      if (reason === "remapped Back" || reason === "hard Ctrl+C") {
        await tui.waitForPending();
        await tui.waitForOpen();
        assert.equal(selectedLabel(tui.render()), "Pull from remote");
        tui.press("ctrl+c");
      }
      await running;
      assert.deepEqual(routes, [call]);
      assert.deepEqual(confirmations, []);
      assert.equal(tui.isOpen, false);
    }, remappedKeys());
  });
}

test("short menu keeps the active setup visible while navigating and closing", async () => {
  await withPalette(async ({ tui, running, routes }) => {
    let frame = tui.resize({ width: 36, rows: 16 });
    assert.ok(frame.includes("Manage sync · home"), frame.join("\n"));
    assertSelectedDescription(frame, "Sync…");
    tui.press("tui.select.down");
    tui.press("tui.select.down");
    frame = tui.render();
    assert.ok(frame.includes("Manage sync · home"), frame.join("\n"));
    assert.equal(selectedLabel(frame), "Push to remote");
    assert.ok(frame.length <= 13);
    assert.ok(frame.every((line) => visibleWidth(line) <= 36));
    tui.press("tui.select.down");
    assertSelectedDescription(tui.render(), "View differences");
    assert.doesNotMatch(tui.render().join("\n"), /Search:/u);
    tui.press("tui.select.cancel");
    await running;
    assert.equal(tui.isOpen, false);
    assert.deepEqual(routes, []);
  });
});

test("palette retains its selected row across normal, narrow, short and zero-width rendering", async () => {
  await withPalette(async ({ tui, component, routes }) => {
    tui.press("end");
    assertSelectedDescription(tui.render(), "History");
    for (const rows of [28, 12, 8, 6, 4]) {
      for (const width of [80, 20, 5, 1]) {
        const frame = tui.resize({ width, rows });
        assert.ok(frame.length <= Math.max(1, rows - 3), `${width}x${rows}: ${frame.join("\n")}`);
        assert.ok(
          frame.every((line) => visibleWidth(line) <= width),
          `${width}x${rows}`,
        );
        assert.ok(
          frame.some((line) => line.startsWith("→")),
          `${width}x${rows}: selected row lost`,
        );
        if (rows >= 8) {
          assert.equal(frame[0], "─".repeat(width));
          assert.equal(frame.at(-1), "─".repeat(width));
        } else
          assert.equal(
            frame.some((line) => line === "─".repeat(width)),
            false,
          );
        // The public harness requires positive dimensions; exercise zero at the display boundary.
        assert.deepEqual(component().render(0), []);
      }
    }
    tui.resize({ width: 80, rows: 28 });
    tui.invalidate();
    assertSelectedDescription(tui.render(), "History");
    assert.equal(choiceRows(tui.render()).length, ordinaryActions.length);
    assert.deepEqual(routes, []);
  });
});

for (const cancel of ["remapped Back", "hard Ctrl+C"] as const) {
  test(`${cancel} closes the main menu under non-default keybindings without routing`, async () => {
    await withPalette(async ({ tui, running, routes, notifications }) => {
      tui.send("j");
      assertSelectedDescription(tui.render(), "Pull from remote");
      tui.send("k");
      assertSelectedDescription(tui.render(), "Sync…");
      tui.press("end");
      const frame = tui.render();
      assertSelectedDescription(frame, "History");
      assert.match(frame.join("\n"), /k\/j navigate.*x select.*q close/u);
      if (cancel === "remapped Back") tui.send("q");
      else tui.press("ctrl+c");
      await running;
      assert.equal(tui.isOpen, false);
      assert.deepEqual(routes, []);
      assert.deepEqual(notifications, []);
    }, remappedKeys());
  });
}

for (const reason of ["session replacement", "shutdown", "disposal"] as const) {
  test(`palette ${reason} ignores stale input without activating a route`, async () => {
    await withPalette(async ({ tui, owner, running, component, routes, notifications }) => {
      tui.press("end");
      const stale = component();
      assertSelectedDescription(tui.render(), "History");
      if (reason === "disposal") tui.dispose();
      else owner.abort(new DOMException(reason, "AbortError"));
      await running;
      stale.handleInput?.(`${pasteStart}History${pasteEnd}`);
      stale.handleInput?.("\r");
      stale.dispose?.();
      assert.equal(tui.isOpen, false);
      assert.deepEqual(routes, []);
      assert.deepEqual(notifications, []);
    });
  });
}

test("RPC retains Sync now and all ordinary choices without opening the TUI palette", async () => {
  await configured(async () => {
    const menus: Array<{ title: string; choices: string[] }> = [];
    const routes: string[] = [];
    const context = createMockContext({
      mode: "rpc",
      select: async (title: string, choices: string[]) => {
        menus.push({ title, choices });
        return menus.length === 1 ? "Sync now" : undefined;
      },
      custom: async () => {
        throw new Error("RPC must not open custom UI");
      },
    });
    await showSyncManager(context.ctx, async (route) => {
      routes.push(route);
      return { kind: "completed", outcome: "cancelled" };
    });
    assert.equal(menus.length, 2);
    assert.deepEqual(menus[0]?.choices, [
      ...ordinaryActions.map((action) => ("rpcLabel" in action ? action.rpcLabel : action.label)),
      "Done",
    ]);
    assert.deepEqual(routes, ["sync"]);
    assert.deepEqual(context.notifications, []);
  });
});
