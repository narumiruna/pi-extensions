import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { type ExtensionCommandContext, initTheme } from "@earendil-works/pi-coding-agent";
import { createTuiHarness } from "@narumitw/pi-tui-kit/testing";
import { test } from "vitest";
import { createMockContext } from "../../../test/support.js";
import { loadConfig, syncConfigReviewIdentity } from "../src/settings/config.js";
import { localConfigPath } from "../src/settings/config-file.js";
import { removeSyncSetup } from "../src/settings/settings-management.js";
import { updateLocalConfig } from "../src/settings/settings-store.js";
import type { OperationAvailability } from "../src/state/operation-availability.js";
import { readStateForConfig, writeStateForConfig } from "../src/state/sync-state-store.js";
import { describeManagerState, MAIN_MENU_ACTIONS } from "../src/ui/manager-state.js";
import { showSyncManager } from "../src/ui/manager-ui.js";
import { showSyncSettings } from "../src/ui/settings-ui.js";
import { v3S3Settings, withTempHome } from "./helpers.js";

initTheme("dark", false);

async function configured(run: () => Promise<void>) {
  await withTempHome(async (agentDir) => {
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(localConfigPath(), JSON.stringify(v3S3Settings()), { mode: 0o600 });
    await run();
  });
}

test("ordinary main exposes transfers, inspection and management actions and advisory status/help without writes or routing", async () => {
  await configured(async () => {
    const before = readFileSync(localConfigPath());
    const manager = await describeManagerState();
    assert.deepEqual(manager.actions, [...MAIN_MENU_ACTIONS]);
    let choices: string[] = [];
    let title = "";
    const context = createMockContext({
      mode: "rpc",
      select: async (text: string, options: string[]) => {
        title = text;
        choices = options;
        return undefined;
      },
    });
    let routed = false;
    await showSyncManager(context.ctx, async () => {
      routed = true;
    });
    assert.deepEqual(choices, [...MAIN_MENU_ACTIONS]);
    assert.match(title, /Remote status: Not checked/u);
    assert.match(title, /Help: \/sync help/u);
    assert.match(title, /\/sync status.*\/sync diff/u);
    assert.equal(routed, false);
    assert.deepEqual(readFileSync(localConfigPath()), before);
  });
});

for (const [label, expected] of [
  ["Sync now", "sync"],
  ["Pull from remote…", "pull"],
  ["Push to remote…", "push"],
  ["View differences", "diff"],
  ["Check remote status", "status"],
  ["History", "history"],
  ["Diagnostics", "doctor"],
]) {
  test(`main ${label} dispatches ${expected} with owned cancellation and no force flags`, async () => {
    await configured(async () => {
      const choices = [label, undefined];
      const context = createMockContext({ mode: "rpc", select: async () => choices.shift() });
      const routes: string[] = [];
      const signals: (AbortSignal | undefined)[] = [];
      await showSyncManager(
        context.ctx,
        async (route, signal) => {
          routes.push(route);
          signals.push(signal);
          return { kind: "completed", outcome: "cancelled" };
        },
        new AbortController().signal,
      );
      assert.deepEqual(routes, [expected]);
      assert.ok(signals[0] instanceof AbortSignal);
    });
  });
}

for (const outcome of ["cancel", "setup-change", "shutdown"] as const) {
  test(`Diagnostics review ${outcome} does not run backend probes`, async () => {
    await configured(async () => {
      const owner = new AbortController();
      const choices = ["Diagnostics", undefined];
      let review = "";
      const context = createMockContext({
        mode: "rpc",
        select: async () => choices.shift(),
        confirm: async (_title: string, body: string) => {
          review = body;
          if (outcome === "setup-change")
            await updateLocalConfig((settings) => ({ ...settings, skipSecretScan: true }));
          if (outcome === "shutdown") owner.abort();
          return outcome !== "cancel";
        },
      });
      const routes: string[] = [];
      await showSyncManager(
        context.ctx,
        async (route) => {
          routes.push(route);
        },
        owner.signal,
      );
      assert.deepEqual(routes, []);
      assert.match(review, /Setup: home/);
      assert.match(review, /WebDAV probes conditional writes/);
      if (outcome === "setup-change")
        assert.ok(
          context.notifications.some((entry) => /Setup changed during diagnostics review/u.test(entry.message)),
        );
      else assert.deepEqual(context.notifications, []);
    });
  });
}

const operationStates: OperationAvailability[] = [
  { kind: "live", lock: { id: "live", pid: process.pid, command: "push", startedAt: new Date().toISOString() } },
  { kind: "busy", metadata: "missing" },
  { kind: "recoverable-stale", lock: { id: "old", pid: 1, command: "push", startedAt: "2000-01-01" } },
  { kind: "recoverable-unreadable" },
  { kind: "inspection-error", message: "injected" },
];
for (const operation of operationStates) {
  test(`main ${operation.kind} hides transfer and settings actions`, async () => {
    await configured(async () => {
      const manager = await describeManagerState(undefined, undefined, async () => operation);
      for (const action of ["Sync now", "Pull from remote…", "Push to remote…", "Settings", "Diagnostics"])
        assert.equal(manager.actions.includes(action), false, action);
      assert.equal(
        manager.actions[0],
        operation.kind.startsWith("recoverable") ? "Restore sync access… (recommended)" : "Refresh operation status",
      );
      assert.ok(manager.actions.includes("History"));
    });
  });
}

test("unresolved group review is conditional and does not replace content-list review", async () => {
  await configured(async () => {
    assert.equal((await describeManagerState()).actions.includes("Review unresolved conflicts"), false);
    const config = await loadConfig();
    await writeStateForConfig(config, {
      ...(await readStateForConfig(config)),
      unresolved: [{ paths: ["settings.json"], artifact: "fixture" }],
    });
    assert.equal((await describeManagerState()).actions[0], "Review unresolved conflicts");
  });
});

test("empty content retains Settings, History and Diagnostics without transfer shortcuts", async () => {
  await configured(async () => {
    await updateLocalConfig((settings) => {
      const home = settings.syncSetups.home;
      assert.ok(home);
      return {
        ...settings,
        syncSetups: {
          ...settings.syncSetups,
          home: { ...home, sync: { include: [], automatic: false } },
        },
      };
    });
    assert.deepEqual((await describeManagerState()).actions, ["Settings", "History", "Diagnostics"]);
  });
});

for (const row of ["Storage location", "Manage sync setups", "Manage storage connections"]) {
  test(`Settings ${row} returns to the setup-bound screen on cancellation`, async () => {
    await configured(async () => {
      const before = readFileSync(localConfigPath());
      const choices = [row, undefined, undefined, undefined];
      const titles: string[] = [];
      const context = createMockContext({
        mode: "tui",
        hasUI: true,
        select: async (title: string) => {
          titles.push(title);
          return choices.shift();
        },
        input: async () => undefined,
      });
      await showSyncSettings(context.ctx, async () => undefined);
      assert.equal(titles.filter((title) => title.split("\n").includes("Pi Sync Settings")).length, 2);
      assert.deepEqual(readFileSync(localConfigPath()), before);
      assert.deepEqual(context.notifications, []);
    });
  });
}

for (const mode of ["tui", "rpc"] as const) {
  for (const outcome of ["applied", "resolved-conflict"] as const) {
    test(`${mode} nested setup ${outcome} exits Settings and the owning manager`, async () => {
      await configured(async () => {
        await updateLocalConfig((settings) => ({
          ...settings,
          onSwitch: "pull-after-switch",
          syncSetups: {
            ...settings.syncSetups,
            work: {
              storage: { connection: "r2", bucket: "pi-sync-test", path: "work" },
              sync: { include: ["AGENTS.md"], automatic: false },
            },
          },
        }));
        const choices = [
          "Settings",
          "Manage sync setups",
          "work",
          "Make current…",
          ...(outcome === "resolved-conflict" ? ["Use remote content and replace local…"] : []),
        ];
        const titles: string[] = [];
        const context = createMockContext({
          mode,
          select: async (title: string) => {
            titles.push(title);
            return choices.shift();
          },
        });
        if (mode === "tui") {
          (context.ctx as ExtensionCommandContext).ui.custom = (async (factory) => {
            const tui = createTuiHarness({ width: 100, rows: 28 });
            try {
              const result = tui.custom(factory);
              try {
                await tui.waitForOpen();
              } catch (error) {
                // An immediately completed loader can settle before its host opens.
                if (error instanceof Error && error.message === "TUI custom component settled before opening")
                  return await result;
                throw error;
              }
              const frame = tui.render().join("\n");
              const title = frame
                .split("\n")
                .find((line) =>
                  /^(Manage sync|Pi Sync Settings|Sync setups|Sync setup “|Resolve sync conflict)/u.test(line),
                );
              if (title) {
                titles.push(title);
                const choice = choices.shift();
                if (!choice) tui.press("ctrl+c");
                else {
                  if (title === "Pi Sync Settings") tui.send(`\u001b[200~${choice}\u001b[201~`);
                  else {
                    for (let index = 0; index < 20; index++) {
                      if (tui.render().some((line) => line.includes(`→ ${choice}`))) break;
                      tui.press("tui.select.down");
                    }
                  }
                  tui.press("tui.select.confirm");
                }
              }
              return await result;
            } finally {
              tui.dispose();
            }
          }) as ExtensionCommandContext["ui"]["custom"];
        }
        const routes: string[] = [];
        await showSyncManager(context.ctx, async (route) => {
          routes.push(route);
          if (outcome === "resolved-conflict" && route === "pull") {
            const config = await loadConfig();
            return {
              kind: "decision-required",
              decision: {
                kind: "both-changed",
                setupName: "work",
                configIdentity: syncConfigReviewIdentity(config),
                causes: { localChanged: true, remoteChanged: true, policyChanged: false },
                currentInclude: config.include,
                review: "Both versions changed",
                directions: ["push", "pull"],
                directMessage: "Both local and remote changed.",
              },
            };
          }
          return { kind: "completed", outcome: "applied" };
        });
        assert.equal(choices.length, 0);
        assert.deepEqual(
          routes,
          outcome === "applied" ? ["pull"] : ["pull", "pull --force"],
          JSON.stringify({ titles, notifications: context.notifications }),
        );
        assert.equal(
          titles.filter((title) => title.split("\n").includes("Manage sync")).length,
          1,
          JSON.stringify({ titles, notifications: context.notifications }),
        );
        assert.equal(
          titles.length,
          outcome === "applied" ? 4 : 5,
          JSON.stringify({ titles, notifications: context.notifications }),
        );
        assert.equal((await loadConfig()).setupName, "work");
      });
    });
  }
}

for (const row of ["Storage location", "Manage sync setups", "Manage storage connections"]) {
  test(`repeated ${row} returns retain search and require only one remapped Back`, async () => {
    await configured(async () => {
      const frames: string[] = [];
      let visits = 0;
      let inputs = 0;
      const context = createMockContext({
        mode: "tui",
        input: async () => {
          inputs++;
          await updateLocalConfig((settings) => {
            const home = settings.syncSetups.home;
            assert.ok(home);
            return {
              ...settings,
              syncSetups: {
                ...settings.syncSetups,
                home: {
                  ...home,
                  storage: { ...home.storage, path: "refreshed" },
                },
              },
            };
          });
          return undefined;
        },
      });
      (context.ctx as ExtensionCommandContext).ui.custom = (async (factory) => {
        const tui = createTuiHarness({
          width: 100,
          rows: 28,
          keybindings: {
            matches: (data, action) =>
              data ===
              (
                { "tui.select.confirm": "x", "tui.select.cancel": "q", "tui.select.down": "j" } as Record<
                  string,
                  string
                >
              )[action],
            getKeys: (action) =>
              ((
                ({ "tui.select.confirm": ["x"], "tui.select.cancel": ["q"], "tui.select.down": ["j"] }) as Record<
                  string,
                  readonly string[]
                >
              )[action] as never) ?? [],
          },
        });
        try {
          const result = tui.custom(factory);
          await tui.waitForOpen();
          const frame = tui.render().join("\n");
          if (frame.split("\n").includes("Pi Sync Settings")) {
            visits++;
            if (visits === 1) tui.send(`\u001b[200~${row}\u001b[201~`);
            frames.push(tui.render().join("\n"));
            // A broken self-to will produce extra Settings visits after this single Back.
            tui.send(visits <= 2 ? "x" : "q");
          } else tui.send("q");
          return await result;
        } finally {
          tui.dispose();
        }
      }) as ExtensionCommandContext["ui"]["custom"];
      assert.equal(await showSyncSettings(context.ctx, async () => undefined), "back");
      assert.equal(visits, 3);
      for (const frame of frames) {
        assert.match(frame, new RegExp(row, "u"));
        assert.doesNotMatch(frame, /Included content|Automatic sync/u);
      }
      if (row === "Storage location") {
        assert.equal(inputs, 2);
        assert.match(frames[1] ?? "", /refreshed/u);
      }
      assert.deepEqual(context.notifications, []);
    });
  });
}

test("Settings closes after management switches the active setup instead of editing stale scope", async () => {
  await configured(async () => {
    await updateLocalConfig((settings) => ({
      ...settings,
      syncSetups: {
        ...settings.syncSetups,
        work: {
          storage: { connection: "r2", bucket: "pi-sync-test", path: "work" },
          sync: { include: ["AGENTS.md"], automatic: false },
        },
      },
    }));
    let screens = 0;
    const context = createMockContext({
      mode: "tui",
      hasUI: true,
      select: async (title: string) => {
        if (title.split("\n").includes("Pi Sync Settings")) {
          screens++;
          return "Manage sync setups";
        }
        await updateLocalConfig((settings) => ({ ...settings, activeSyncSetup: "work" }));
        return undefined;
      },
    });
    await showSyncSettings(context.ctx, async () => undefined);
    assert.equal(screens, 1);
    assert.equal((await loadConfig()).setupName, "work");
    assert.deepEqual((await loadConfig("home")).include, ["settings.json"]);
  });
});

for (const reason of ["Session replaced", "Shutdown", "Disposal"]) {
  test(`moved storage editor aborts pending input on ${reason}`, async () => {
    await configured(async () => {
      const before = readFileSync(localConfigPath());
      const owner = new AbortController();
      const tui = createTuiHarness({ width: 48, rows: 16 });
      const context = createMockContext({ mode: "tui", hasUI: true, custom: tui.custom });
      let started!: () => void;
      const inputStarted = new Promise<void>((resolve) => {
        started = resolve;
      });
      let inputSignal: AbortSignal | undefined;
      (context.ctx as ExtensionCommandContext).ui.input = async (_title, _placeholder, options) => {
        inputSignal = options?.signal;
        started();
        return new Promise((resolve) =>
          options?.signal?.addEventListener("abort", () => resolve(undefined), { once: true }),
        );
      };
      const running = showSyncSettings(context.ctx, async () => undefined, owner.signal);
      await tui.waitForOpen();
      tui.send("\u001b[200~Storage location\u001b[201~");
      tui.press("tui.select.confirm");
      await inputStarted;
      if (reason === "Disposal") tui.dispose();
      else owner.abort(new DOMException(reason, "AbortError"));
      await running;
      assert.equal(inputSignal?.aborted, true);
      assert.deepEqual(readFileSync(localConfigPath()), before);
      assert.deepEqual(context.notifications, []);
      tui.dispose();
    });
  });
}

test("Settings preserves a searched row and new value after save with remapped keys", async () => {
  await configured(async () => {
    const tui = createTuiHarness({
      width: 48,
      rows: 16,
      keybindings: {
        matches: (data, action) =>
          data ===
          (
            {
              "tui.select.confirm": "x",
              "tui.select.cancel": "q",
              "tui.select.down": "j",
              "tui.select.up": "k",
            } as Record<string, string>
          )[action],
        getKeys: (action) =>
          ((
            ({
              "tui.select.confirm": ["x"],
              "tui.select.cancel": ["q"],
              "tui.select.down": ["j"],
              "tui.select.up": ["k"],
            }) as Record<string, readonly string[]>
          )[action] as never) ?? [],
      },
    });
    const context = createMockContext({ mode: "tui", hasUI: true, custom: tui.custom });
    const running = showSyncSettings(context.ctx, async () => undefined);
    await tui.waitForOpen();
    tui.send("\u001b[200~Show sync status\u001b[201~");
    tui.send("x");
    await tui.waitForPending();
    await tui.waitForOpen();
    const frame = tui.render().join("\n");
    assert.match(frame, /Show sync status.*Off/u);
    assert.doesNotMatch(frame, /Included content|Automatic sync/u);
    assert.equal((await loadConfig()).showStatus, false);
    tui.send("q");
    await running;
    tui.dispose();
  });
});

test("Settings closes when management removes its owning setup", async () => {
  await configured(async () => {
    let screens = 0;
    const context = createMockContext({
      mode: "tui",
      hasUI: true,
      select: async (title: string) => {
        if (title.split("\n").includes("Pi Sync Settings")) {
          screens++;
          return "Manage sync setups";
        }
        await removeSyncSetup("home");
        return undefined;
      },
    });
    await showSyncSettings(context.ctx, async () => undefined);
    assert.equal(screens, 1);
    assert.match((await describeManagerState()).title, /No sync setups/u);
  });
});

test("History cancellation cannot interrupt a rollback after its commit boundary", async () => {
  await configured(async () => {
    const tui = createTuiHarness({ width: 60, rows: 20 });
    const context = createMockContext({ mode: "tui", hasUI: true, custom: tui.custom });
    let started!: () => void;
    const committed = new Promise<void>((resolve) => {
      started = resolve;
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let operationSignal: AbortSignal | undefined;
    const running = showSyncManager(context.ctx, async (route, signal, onCommit) => {
      assert.equal(route, "history");
      operationSignal = signal;
      onCommit?.();
      started();
      await gate;
      return { kind: "completed" };
    });
    try {
      await tui.waitForOpen();
      for (let index = 0; index < 6; index++) tui.press("tui.select.down");
      tui.press("tui.select.confirm");
      await committed;
      await tui.waitForOpen();
      tui.press("ctrl+c");
      assert.equal(operationSignal?.aborted, false);
      assert.match(context.notifications.at(-1)?.message ?? "", /cannot be cancelled safely/u);
      release();
      await tui.waitForPending();
      await tui.waitForOpen();
      tui.press("ctrl+c");
      await running;
    } finally {
      release();
      tui.dispose();
    }
  });
});

test("RPC Settings preserves setup catalog access without a TUI preference editor", async () => {
  await configured(async () => {
    const choices = ["Settings", "Manage sync setups", undefined, undefined, undefined];
    const titles: string[] = [];
    const context = createMockContext({
      mode: "rpc",
      select: async (title: string) => {
        titles.push(title);
        return choices.shift();
      },
      custom: async () => {
        throw new Error("TUI forbidden");
      },
    });
    await showSyncManager(context.ctx, async () => undefined);
    assert.ok(titles.some((title) => title.startsWith("Sync setups")));
    assert.match(context.notifications[0]?.message ?? "", /Edit pi-sync settings manually/u);
  });
});

test("RPC Settings reports the private settings path without opening a custom component", async () => {
  await configured(async () => {
    const context = createMockContext({
      mode: "rpc",
      custom: async () => {
        throw new Error("TUI forbidden");
      },
    });
    await showSyncSettings(context.ctx, async () => undefined);
    assert.match(context.notifications[0]?.message ?? "", /Edit pi-sync settings manually:/u);
  });
});
