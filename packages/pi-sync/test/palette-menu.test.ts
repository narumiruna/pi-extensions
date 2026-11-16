import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { type ExtensionCommandContext, initTheme, type KeybindingsManager } from "@earendil-works/pi-coding-agent";
import { type Component, stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
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
  { label: "Pull from remote…", route: "pull", description: "Remote → this device." },
  { label: "Push to remote…", route: "push", description: "This device → remote snapshot." },
  { label: "View differences", route: "diff", description: "Inspect changes; no transfer." },
  { label: "Check remote status", route: "status", description: "Check remote; no transfer." },
  { label: "Settings", route: undefined, description: "Change sync settings." },
  { label: "History", route: "history", description: "Review snapshots and rollback." },
  { label: "Diagnostics", route: "doctor", description: "Review backend diagnostics." },
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

async function configured(run: () => Promise<void>) {
  await withTempHome(async (agentDir) => {
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(localConfigPath(), JSON.stringify(v3S3Settings()), { mode: 0o600 });
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
  });
}

function selectedLabel(frame: readonly string[]) {
  return frame
    .find((line) => line.startsWith("→ "))
    ?.slice(2)
    .trimEnd();
}

function searchQuery(frame: readonly string[]) {
  return frame
    .map(stripTerminalSequences)
    .find((line) => line.startsWith("Search: > "))
    ?.slice("Search: > ".length)
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

test("TUI palette shows five label-only choices and only the selected description in a stable normal frame", async () => {
  await withPalette(async ({ tui, routes }) => {
    const frames: Array<readonly string[]> = [];
    for (const action of ordinaryActions) {
      const frame = tui.render();
      frames.push(frame);
      assertSelectedDescription(frame, action.label);
      assert.equal(choiceRows(frame).length, 5, frame.join("\n"));
      assert.equal(frame[0], "─".repeat(80));
      assert.equal(frame.at(-1), "─".repeat(80));
      assert.ok(frame.length <= 25);
      assert.ok(frame.every((line) => visibleWidth(line) <= 80));
      assert.match(frame.join("\n"), /Search:.*\n8 choices/u);
      tui.press("tui.select.down");
    }
    assert.equal(new Set(frames.map((frame) => frame.length)).size, 1, "navigation must not resize the normal frame");
    assert.equal(selectedLabel(tui.render()), "Sync…");
    assert.equal(tui.isFocusable, true);
    tui.setFocused(true);
    assert.equal(tui.focused, true);
    tui.setFocused(false);
    assert.equal(tui.focused, false);
    assert.deepEqual(routes, []);
  });
});

for (const action of ordinaryActions) {
  if (!action.route) continue;
  test(`TUI search activates ${action.label} through the existing ${action.route} handler`, async () => {
    await withPalette(async ({ tui, routeStarted, completeRoute, routes, confirmations }) => {
      tui.type(action.description);
      assertSelectedDescription(tui.render(), action.label);
      // Fuzzy search can retain other matches; it must keep the intended action selected.
      assert.ok(choiceRows(tui.render()).length <= 5);
      tui.send("\u0015");
      // Keep the compatibility spelling searchable even though the TUI label is compact.
      const query = "rpcLabel" in action ? action.rpcLabel : action.label;
      tui.type(query);
      const searched = tui.render();
      assertSelectedDescription(searched, action.label);
      assert.equal(choiceRows(searched).length, 1);
      assert.match(searched.join("\n"), /1 of 8 choices/u);
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
      if (action.route === "doctor") {
        assert.equal(confirmations.length, 1);
        assert.equal(confirmations[0]?.title, "Run diagnostics?");
        assert.match(confirmations[0]?.body ?? "", /Setup: home/u);
        assert.ok(confirmations[0]?.signal instanceof AbortSignal);
      } else assert.deepEqual(confirmations, []);
      completeRoute({ kind: "completed", outcome: "cancelled" });
      await tui.waitForPending();
      await tui.waitForOpen();
      const returned = tui.render();
      assertSelectedDescription(returned, action.label);
      assert.equal(searchQuery(returned), query);
      assert.equal(routes.length, 1);
    });
  });
}

test("searched Settings opens its existing screen and returns to the same palette choice without writing", async () => {
  await withPalette(async ({ tui, routes }) => {
    tui.type("Change sync settings.");
    assertSelectedDescription(tui.render(), "Settings");
    tui.send("\u0015");
    tui.type("Settings");
    assertSelectedDescription(tui.render(), "Settings");
    tui.press("tui.select.confirm");
    await tui.waitForOpen();
    const settings = tui.render();
    assert.ok(settings.includes("Pi Sync Settings"), settings.join("\n"));
    tui.press("tui.select.cancel");
    await tui.waitForPending();
    await tui.waitForOpen();
    assertSelectedDescription(tui.render(), "Settings");
    assert.equal(searchQuery(tui.render()), "Settings");
    assert.deepEqual(routes, []);
  });
});

test("search includes ordinary descriptions and keeps native Backspace and query recovery", async () => {
  await withPalette(async ({ tui, routes }) => {
    tui.type("both sides");
    assertSelectedDescription(tui.render(), "Sync…");
    assert.match(tui.render().join("\n"), /1 of 8 choices/u);
    tui.type("z");
    assert.match(tui.render().join("\n"), /No matching choices; edit search/u);
    tui.send("\u007f");
    assertSelectedDescription(tui.render(), "Sync…");
    tui.send("\u0015");
    assert.equal(choiceRows(tui.render()).length, 5);
    assert.match(tui.render().join("\n"), /8 choices/u);
    assert.deepEqual(routes, []);
  });
});

for (const chunked of [false, true]) {
  test(`${chunked ? "multi-chunk" : "single-chunk"} bracketed paste never activates navigation, confirm or cancel keys`, async () => {
    await withPalette(async ({ tui, routes, confirmations }) => {
      const chunks = chunked
        ? [pasteStart, "x", "q", "j", "k", "\r", "\u0003", "\u001b[20", "1~"]
        : [`${pasteStart}xqjk\r\u0003${pasteEnd}`];
      for (const chunk of chunks) {
        tui.send(chunk);
        assert.equal(tui.isOpen, true, JSON.stringify(chunk));
        assert.equal(tui.openCount, 1);
        assert.deepEqual(routes, []);
        assert.deepEqual(confirmations, []);
      }
      const pasted = tui.render();
      assert.equal(searchQuery(pasted), "xqjk");
      assert.match(pasted.join("\n"), /0 of 8 choices/u);
      assert.match(pasted.join("\n"), /No matching choices; edit search/u);
      tui.send("\u0015");
      tui.send(`${pasteStart}View differences${pasteEnd}`);
      assertSelectedDescription(tui.render(), "View differences");
      assert.deepEqual(routes, []);
    }, remappedKeys());
  });
}

for (const remapped of [false, true]) {
  test(`cancelled read-only check retains search and selection with ${remapped ? "remapped" : "default"} keys`, async () => {
    await withPalette(
      async ({ tui, routeStarted, completeRoute, routes }) => {
        tui.send(`${pasteStart}no transfer${pasteEnd}`);
        for (let index = 0; index < 2 && selectedLabel(tui.render()) !== "Check remote status"; index += 1) {
          if (remapped) tui.send("j");
          else tui.press("tui.select.down");
        }
        assertSelectedDescription(tui.render(), "Check remote status");
        if (remapped) tui.send("x");
        else tui.press("tui.select.confirm");
        const call = await routeStarted;
        await tui.waitForOpen();
        assert.equal(call.route, "status");
        assert.match(tui.render().join("\n"), /Checking remote status/u);
        if (remapped) tui.send("q");
        else tui.press("tui.select.cancel");
        assert.equal(call.signal?.aborted, true);
        completeRoute({ kind: "completed", outcome: "cancelled" });
        await tui.waitForPending();
        await tui.waitForOpen();
        const returned = tui.render();
        assertSelectedDescription(returned, "Check remote status");
        assert.equal(searchQuery(returned), "no transfer");
        assert.match(returned.join("\n"), /2 of 8 choices/u);
        assert.equal(routes.length, 1);
      },
      remapped ? remappedKeys() : undefined,
    );
  });
}

test("palette retains its selected row across normal, narrow, short and zero-width rendering", async () => {
  await withPalette(async ({ tui, component, routes }) => {
    tui.press("end");
    assertSelectedDescription(tui.render(), "Diagnostics");
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
    assertSelectedDescription(tui.render(), "Diagnostics");
    assert.equal(choiceRows(tui.render()).length, 5);
    assert.deepEqual(routes, []);
  });
});

for (const cancel of ["remapped Back", "hard Ctrl+C"] as const) {
  test(`${cancel} closes the searched palette under non-default keybindings without routing`, async () => {
    await withPalette(async ({ tui, running, routes, notifications }) => {
      tui.send("j");
      assertSelectedDescription(tui.render(), "Pull from remote…");
      tui.send("k");
      assertSelectedDescription(tui.render(), "Sync…");
      tui.send(`${pasteStart}History${pasteEnd}`);
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
  test(`palette ${reason} disposes pending search input without activating a route`, async () => {
    await withPalette(async ({ tui, owner, running, component, routes, notifications }) => {
      tui.type("History");
      const stale = component();
      assertSelectedDescription(tui.render(), "History");
      tui.send(`${pasteStart}unfinished`);
      if (reason === "disposal") tui.dispose();
      else owner.abort(new DOMException(reason, "AbortError"));
      await running;
      stale.handleInput?.(`${pasteEnd}\r`);
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
