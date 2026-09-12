import assert from "node:assert/strict";
import { createRpcHarness, createTuiHarness } from "@narumitw/pi-tui-kit/testing";
import { test } from "vitest";
import { createMockContext } from "../../../test/support.js";
import type { SpawnSessionInput } from "../src/fleet-controller.js";
import { createFleetMenu, type FleetMenuSource, type FleetMenuState, showFleetMenu } from "../src/menu.js";
import { DEFAULT_FLEET_SETTINGS, type FleetSettingsPatch, type FleetSettingsState } from "../src/settings.js";

const defaultSettings: FleetSettingsState = {
  settings: { ...DEFAULT_FLEET_SETTINGS },
  sources: { defaultTerminal: "built-in", confirmSessionLaunch: "built-in" },
  canSave: true,
};
const disconnected: FleetMenuState = {
  connected: false,
  acceptsRequests: false,
  peers: [],
  ...defaultSettings,
  settingsPath: "/tmp/pi-fleet.json",
};
const connected: FleetMenuState = {
  connected: true,
  groupId: "a".repeat(32),
  invite: `pifleet:v1:${"A".repeat(43)}`,
  acceptsRequests: false,
  self: {
    protocolVersion: 2,
    sessionId: "self",
    endpointId: "a".repeat(24),
    name: "Main",
    cwd: "/tmp/main",
    pid: 123,
    acceptsRequests: false,
  },
  peers: [
    {
      protocolVersion: 2,
      sessionId: "peer",
      endpointId: "b".repeat(24),
      name: "Peer",
      cwd: "/tmp/peer",
      pid: 456,
      acceptsRequests: true,
    },
  ],
  ...defaultSettings,
  settingsPath: "/tmp/pi-fleet.json",
};

function source(overrides: Partial<FleetMenuSource> = {}) {
  const calls: unknown[] = [];
  const value: FleetMenuSource = {
    snapshot: async () => disconnected,
    spawn: async (_ctx, input) => {
      calls.push({ kind: "spawn", input });
    },
    start: async () => {
      calls.push({ kind: "start" });
    },
    join: async (_ctx, invite) => {
      calls.push({ kind: "join", invite });
    },
    send: async (_ctx, options) => {
      calls.push({ kind: "send", options });
    },
    updateSettings: async (patch) => {
      calls.push({ kind: "settings", patch });
    },
    setAcceptsRequests: (value) => {
      calls.push({ kind: "policy", value });
    },
    leave: async () => {
      calls.push({ kind: "leave" });
    },
    ...overrides,
  };
  return { source: value, calls };
}

test("main menu exposes New Pi session first plus Settings, Status, and Help", () => {
  const first = source({ snapshot: async () => disconnected });
  const firstMenu = createFleetMenu(first.source);
  assert.deepEqual(
    (
      firstMenu.menu.screens.main({ state: disconnected }) as unknown as {
        items: ReadonlyArray<{ label: string }>;
      }
    ).items.map(({ label }) => label),
    ["New Pi session…", "Join with invite", "Start local group", "Settings", "Status", "Help"],
  );
  const second = source({ snapshot: async () => connected });
  const secondMenu = createFleetMenu(second.source);
  assert.deepEqual(
    (
      secondMenu.menu.screens.main({ state: connected }) as unknown as {
        items: ReadonlyArray<{ label: string }>;
      }
    ).items.map(({ label }) => label),
    [
      "New Pi session…",
      "Send message",
      "Sessions",
      "Invite another session",
      "Request policy",
      "Settings",
      "Status",
      "Help",
      "Leave group…",
    ],
  );

  const settings = firstMenu.menu.screens.settings({ state: disconnected });
  assert.equal(settings.kind, "settings");
  if (settings.kind !== "settings") assert.fail("Expected settings screen");
  assert.deepEqual(
    settings.items.map((item) => [item.id, item.currentValue]),
    [
      ["defaultTerminal", "Automatic"],
      ["confirmSessionLaunch", "Ask"],
    ],
  );
  assert.deepEqual(settings.items[0]?.values, ["Automatic", "tmux", "Ghostty", "Zellij"]);
  assert.match((settings.lines ?? []).join("\n"), /\/tmp\/pi-fleet\.json/u);

  const invalidState: FleetMenuState = {
    ...disconnected,
    issue: { kind: "invalid", message: "invalid file" },
    canSave: false,
  };
  const invalidMain = firstMenu.menu.screens.main({ state: invalidState });
  assert.equal(invalidMain.kind, "actions");
  if (invalidMain.kind !== "actions") assert.fail("Expected actions screen");
  const invalidSettings = invalidMain.items.find((item) => item.id === "settings");
  assert.equal(invalidSettings && "to" in invalidSettings ? invalidSettings.to : undefined, "settingsInvalid");
});

test("setting actions persist exact patches and reject failed saves", async () => {
  const first = source();
  const firstMenu = createFleetMenu(first.source).menu;
  const context = createMockContext({ mode: "tui", hasUI: true });
  assert.deepEqual(
    await firstMenu.actions.setTerminal({
      ctx: context.ctx,
      state: disconnected,
      signal: new AbortController().signal,
      itemId: "defaultTerminal",
      value: "Automatic",
    }),
    { kind: "stay" },
  );
  assert.deepEqual(
    await firstMenu.actions.setTerminal({
      ctx: context.ctx,
      state: disconnected,
      signal: new AbortController().signal,
      itemId: "defaultTerminal",
      value: "Ghostty",
    }),
    { kind: "stay" },
  );
  assert.deepEqual(
    await firstMenu.actions.setTerminal({
      ctx: context.ctx,
      state: disconnected,
      signal: new AbortController().signal,
      itemId: "defaultTerminal",
      value: "Zellij",
    }),
    { kind: "stay" },
  );
  assert.deepEqual(
    await firstMenu.actions.setConfirmation({
      ctx: context.ctx,
      state: disconnected,
      signal: new AbortController().signal,
      itemId: "confirmSessionLaunch",
      value: "Skip",
    }),
    { kind: "stay" },
  );
  assert.deepEqual(first.calls, [
    { kind: "settings", patch: { defaultTerminal: "auto" } },
    { kind: "settings", patch: { defaultTerminal: "ghostty" } },
    { kind: "settings", patch: { defaultTerminal: "zellij" } },
    { kind: "settings", patch: { confirmSessionLaunch: false } },
  ]);
  assert.equal(context.notifications.at(-1)?.level, "info");

  const second = source({ updateSettings: async () => Promise.reject(new Error("save rejected")) });
  const failedContext = createMockContext({ mode: "tui", hasUI: true });
  assert.deepEqual(
    await createFleetMenu(second.source).menu.actions.setTerminal({
      ctx: failedContext.ctx,
      state: disconnected,
      signal: new AbortController().signal,
      itemId: "defaultTerminal",
      value: "Ghostty",
    }),
    { kind: "rejected" },
  );
  assert.match(failedContext.notifications.at(-1)?.message ?? "", /previous value remains/u);
});

test("spawn defers automatic backend resolution to the controller", async () => {
  const { source: menuSource, calls } = source({ snapshot: async () => disconnected });
  const { menu } = createFleetMenu(menuSource);
  const selectionTitles: string[] = [];
  const selectionOptions: string[][] = [];
  const context = createMockContext({
    mode: "tui",
    hasUI: true,
    select: async (title: string, options: string[]) => {
      selectionTitles.push(title);
      selectionOptions.push(options);
      return "Down";
    },
    input: async () => "Investigate tests",
  });
  const result = await menu.actions.spawn({
    ctx: context.ctx,
    state: disconnected,
    signal: new AbortController().signal,
    itemId: "spawn",
  });
  assert.deepEqual(result, { kind: "close" });
  assert.deepEqual(selectionTitles, ["Terminal split direction"]);
  assert.deepEqual(selectionOptions, [["Right", "Down", "Left", "Up"]]);
  assert.deepEqual(calls, [
    {
      kind: "spawn",
      input: {
        direction: "down",
        task: "Investigate tests",
      } satisfies SpawnSessionInput,
    },
  ]);
});

test("spawn uses Ghostty after it is selected in Settings", async () => {
  const ghosttyState: FleetMenuState = {
    ...disconnected,
    settings: { ...disconnected.settings, defaultTerminal: "ghostty" },
  };
  const { source: menuSource, calls } = source({ snapshot: async () => ghosttyState });
  const { menu } = createFleetMenu(menuSource);
  const context = createMockContext({
    mode: "rpc",
    hasUI: true,
    select: async () => "Left",
    input: async () => "",
  });
  const result = await menu.actions.spawn({
    ctx: context.ctx,
    state: ghosttyState,
    signal: new AbortController().signal,
    itemId: "spawn",
  });
  assert.deepEqual(result, { kind: "close" });
  assert.deepEqual(calls, [
    {
      kind: "spawn",
      input: { direction: "left" } satisfies SpawnSessionInput,
    },
  ]);
});

test("spawn uses Zellij after it is selected in Settings", async () => {
  const zellijState: FleetMenuState = {
    ...disconnected,
    settings: { ...disconnected.settings, defaultTerminal: "zellij" },
  };
  const { source: menuSource, calls } = source({ snapshot: async () => zellijState });
  const { menu } = createFleetMenu(menuSource);
  const titles: string[] = [];
  const context = createMockContext({
    mode: "tui",
    hasUI: true,
    select: async (title: string) => {
      titles.push(title);
      return "Up";
    },
    input: async () => "",
  });
  assert.deepEqual(
    await menu.actions.spawn({
      ctx: context.ctx,
      state: zellijState,
      signal: new AbortController().signal,
      itemId: "spawn",
    }),
    { kind: "close" },
  );
  assert.deepEqual(titles, ["Zellij split direction"]);
  assert.deepEqual(calls, [
    {
      kind: "spawn",
      input: { direction: "up" } satisfies SpawnSessionInput,
    },
  ]);
});

test("cancelled direction choice creates no spawn side effects", async () => {
  const { source: menuSource, calls } = source({ snapshot: async () => disconnected });
  const { menu } = createFleetMenu(menuSource);
  const context = createMockContext({
    mode: "tui",
    hasUI: true,
    select: async () => undefined,
  });
  assert.deepEqual(
    await menu.actions.spawn({
      ctx: context.ctx,
      state: disconnected,
      signal: new AbortController().signal,
      itemId: "spawn",
    }),
    { kind: "stay" },
  );
  assert.deepEqual(calls, []);
});

test("cancelled dialogs create no group or join side effects", async () => {
  const { source: menuSource, calls } = source();
  const { menu } = createFleetMenu(menuSource);
  const context = createMockContext({
    mode: "tui",
    hasUI: true,
    confirm: async () => false,
  });
  assert.deepEqual(
    await menu.actions.start({
      ctx: context.ctx,
      state: disconnected,
      signal: new AbortController().signal,
      itemId: "start",
    }),
    { kind: "stay" },
  );
  assert.deepEqual(
    await menu.actions.join({
      ctx: context.ctx,
      state: disconnected,
      signal: new AbortController().signal,
      itemId: "join",
      value: `pifleet:v1:${"A".repeat(43)}`,
    }),
    { kind: "stay" },
  );
  assert.deepEqual(calls, []);
});

test("request policy warns before enabling and leave requires its review action", async () => {
  const { source: menuSource, calls } = source({ snapshot: async () => connected });
  const { menu } = createFleetMenu(menuSource);
  const context = createMockContext({ mode: "tui", hasUI: true, confirm: async () => true });
  assert.deepEqual(
    await menu.actions.setPolicy({
      ctx: context.ctx,
      state: connected,
      signal: new AbortController().signal,
      itemId: "allow",
    }),
    { kind: "to", screen: "requestPolicy" },
  );
  assert.deepEqual(
    await menu.actions.leave({
      ctx: context.ctx,
      state: connected,
      signal: new AbortController().signal,
      itemId: "leave",
    }),
    { kind: "to", screen: "main" },
  );
  assert.deepEqual(calls, [{ kind: "policy", value: true }, { kind: "leave" }]);
});

test("TUI Settings changes apply immediately and failed saves restore the previous value", async () => {
  let state = disconnected;
  const patches: FleetSettingsPatch[] = [];
  const tui = createTuiHarness({ width: 70, rows: 24 });
  const successfulSource = source({
    snapshot: async () => state,
    updateSettings: async (patch) => {
      patches.push(patch);
      state = { ...state, settings: { ...state.settings, ...patch } };
    },
  }).source;
  const context = createMockContext({ mode: "tui", hasUI: true, custom: tui.custom });
  const running = showFleetMenu(context.ctx, successfulSource, {
    signal: new AbortController().signal,
    isCurrent: () => true,
  });
  await tui.waitForOpen();
  for (let index = 0; index < 3; index += 1) tui.press("tui.select.down");
  tui.press("tui.select.confirm");
  await waitForOpenCount(tui, 2);
  tui.press("tui.select.confirm");
  await tui.waitForPending();
  await waitForOpenCount(tui, 3);
  tui.press("tui.select.down");
  tui.press("tui.select.confirm");
  await tui.waitForPending();
  await waitForOpenCount(tui, 4);
  tui.press("tui.select.cancel");
  await waitForOpenCount(tui, 5);
  tui.press("ctrl+c");
  await running;
  assert.deepEqual(patches, [{ defaultTerminal: "tmux" }, { confirmSessionLaunch: false }]);

  const failingTui = createTuiHarness({ width: 70, rows: 24 });
  const failedContext = createMockContext({
    mode: "tui",
    hasUI: true,
    custom: failingTui.custom,
  });
  const failing = showFleetMenu(
    failedContext.ctx,
    source({ updateSettings: async () => Promise.reject(new Error("save rejected")) }).source,
    { signal: new AbortController().signal, isCurrent: () => true },
  );
  await failingTui.waitForOpen();
  for (let index = 0; index < 3; index += 1) failingTui.press("tui.select.down");
  failingTui.press("tui.select.confirm");
  await waitForOpenCount(failingTui, 2);
  failingTui.press("tui.select.confirm");
  await failingTui.waitForPending();
  assert.match(failingTui.render().join("\n"), /Default terminal\s+Automatic/u);
  failingTui.press("ctrl+c");
  await failing;
  assert.match(failedContext.notifications.at(-1)?.message ?? "", /previous value remains/u);
});

test("RPC Settings changes apply immediately through the shared menu", async () => {
  let state = disconnected;
  const patches: FleetSettingsPatch[] = [];
  const menuSource = source({
    snapshot: async () => state,
    updateSettings: async (patch) => {
      patches.push(patch);
      state = { ...state, settings: { ...state.settings, ...patch } };
    },
  }).source;
  const rpc = createRpcHarness([
    {
      kind: "select",
      options: ["New Pi session…", "Join with invite", "Start local group", "Settings", "Status", "Help"],
      response: "Settings",
    },
    {
      kind: "select",
      options: ["Default terminal (Automatic)", "Confirm new sessions (Ask)", "Back"],
      response: "Default terminal (Automatic)",
    },
    {
      kind: "select",
      options: ["Default terminal (tmux)", "Confirm new sessions (Ask)", "Back"],
      response: "Confirm new sessions (Ask)",
    },
    {
      kind: "select",
      options: ["Default terminal (tmux)", "Confirm new sessions (Skip)", "Back"],
      response: undefined,
    },
    {
      kind: "select",
      options: ["New Pi session…", "Join with invite", "Start local group", "Settings", "Status", "Help"],
      response: undefined,
    },
  ]);
  const context = createMockContext({ mode: "rpc", hasUI: true, ...rpc.ui });
  await showFleetMenu(context.ctx, menuSource, {
    signal: new AbortController().signal,
    isCurrent: () => true,
  });
  assert.deepEqual(patches, [{ defaultTerminal: "tmux" }, { confirmSessionLaunch: false }]);
  rpc.assertConsumed();
});

async function waitForOpenCount(tui: ReturnType<typeof createTuiHarness>, expected: number): Promise<void> {
  while (tui.openCount < expected) {
    if (tui.isOpen) await Promise.resolve();
    else await tui.waitForOpen();
  }
}
