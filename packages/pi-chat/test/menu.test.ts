import assert from "node:assert/strict";
import { test } from "vitest";
import { createMockContext } from "../../../test/support.js";
import { type ChatMenuSource, createChatMenu } from "../src/menu.js";
import { createPrivateRoom } from "../src/protocol.js";
import type { PublicRoomBrowseResult } from "../src/public-room-directory.js";

function source(overrides: Partial<ChatMenuSource> = {}): ChatMenuSource {
  return {
    settingsPath: "/agent/pi-chat.json",
    getSettings: () => ({ nickname: "Mika", widgetMode: "count" }),
    getSnapshot: () => undefined,
    getRestoreError: () => undefined,
    createPrivateRoom: () => createPrivateRoom(Buffer.alloc(32, 1)),
    browsePublicRooms: async (): Promise<PublicRoomBrowseResult> => ({ rooms: [], partial: false }),
    joinRoom: async () => true,
    openChat: async () => undefined,
    retryRememberedRoom: async () => undefined,
    forgetRememberedRoom: async () => undefined,
    leaveRoom: async () => undefined,
    toggleMute: () => undefined,
    updateNickname: async () => undefined,
    updateWidgetMode: async () => undefined,
    getIdentityResetPreview: () => ({ current: "Mika~OLD", next: "Mika~NEW" }),
    resetIdentity: async () => undefined,
    ...overrides,
  };
}

const actionContext = (ctx: unknown, value?: string, itemId = "") =>
  ({
    ctx,
    state: {},
    signal: new AbortController().signal,
    itemId,
    value,
  }) as never;

test("manager keeps disconnected and connected primary actions shallow", async () => {
  const disconnected = createChatMenu(source());
  const disconnectedState = await disconnected.getState();
  const first = disconnected.menu.screens.main({ state: disconnectedState });
  assert.equal(first.kind, "actions");
  if (first.kind === "actions") {
    assert.deepEqual(
      first.items.map(({ label }) => label),
      [
        "Browse public rooms",
        "Join public room",
        "Join with invite",
        "Create private room",
        "Settings",
        "Status",
        "Help",
      ],
    );
  }
  const connected = createChatMenu(
    source({
      getSnapshot: () => ({
        state: "connected",
        room: createPrivateRoom(Buffer.alloc(32, 1)),
        localLabel: "Mika~AAAA-BBBB-CCCC",
        participants: [],
        directNeighbors: 0,
        participantCatalogFull: false,
        transcript: [],
        unread: 0,
        composerOpen: false,
      }),
    }),
  );
  const state = await connected.getState();
  const connectedScreen = connected.menu.screens.main({ state });
  assert.equal(connectedScreen.kind, "actions");
  if (connectedScreen.kind === "actions") {
    assert.equal(connectedScreen.items.length, 7);
    assert.match(connectedScreen.items[0]?.label ?? "", /^Open chat in private/u);
    assert.match(connectedScreen.items.at(-1)?.label ?? "", /^Leave room/u);
    assert.match(connectedScreen.lines?.join("\n") ?? "", /Current input: Pi\/LLM/u);
    assert.match(connectedScreen.lines?.join("\n") ?? "", /Restart: this room will not reconnect/u);
  }
  const inviteScreen = connected.menu.screens.invite({ state });
  assert.equal(inviteScreen.kind, "review");
  if (inviteScreen.kind === "review") assert.match(inviteScreen.content, /^pichat:v2:/u);
});

test("public-room browser sorts estimates, marks partial results, and joins a selected room", async () => {
  const joined: string[] = [];
  let opened = 0;
  const controller = createChatMenu(
    source({
      browsePublicRooms: async () => ({
        rooms: [
          { slug: "quiet", estimatedParticipants: 1 },
          { slug: "busy", estimatedParticipants: 9 },
          { slug: "alpha", estimatedParticipants: 1 },
        ],
        partial: true,
      }),
      joinRoom: async (room) => {
        joined.push(room.label);
        return true;
      },
      openChat: async () => void opened++,
    }),
  );
  const ctx = createMockContext({ hasUI: true, mode: "tui", confirm: async () => true });
  assert.deepEqual(await controller.menu.actions.browse(actionContext(ctx.ctx)), {
    kind: "to",
    screen: "publicRooms",
  });
  const screen = controller.menu.screens.publicRooms({ state: await controller.getState() });
  assert.equal(screen.kind, "choice");
  if (screen.kind === "choice") {
    assert.match(screen.lines?.join("\n") ?? "", /estimated.*partial/iu);
    assert.deepEqual(
      screen.items.slice(0, 3).map(({ label }) => label),
      ["#busy", "#alpha", "#quiet"],
    );
    assert.deepEqual(
      screen.items.slice(0, 3).map(({ description }) => description),
      ["~9 active", "~1 active", "~1 active"],
    );
  }
  assert.deepEqual(await controller.menu.actions.selectPublicRoom(actionContext(ctx.ctx, undefined, "room:busy")), {
    kind: "close",
  });
  assert.deepEqual(joined, ["#busy"]);
  assert.equal(opened, 1);
});

test("public-room browser keeps retry and manual recovery for empty and failed discovery", async () => {
  let attempts = 0;
  const controller = createChatMenu(
    source({
      browsePublicRooms: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error("directory unavailable");
        return { rooms: [], partial: false };
      },
    }),
  );
  const ctx = createMockContext({ hasUI: true, mode: "tui" });
  assert.equal((await controller.menu.actions.browse(actionContext(ctx.ctx)))?.kind, "to");
  let screen = controller.menu.screens.publicRooms({ state: await controller.getState() });
  assert.equal(screen.kind, "choice");
  if (screen.kind === "choice") {
    assert.match(screen.lines?.join("\n") ?? "", /directory unavailable/u);
    assert.deepEqual(
      screen.items.map(({ label }) => label),
      ["Retry discovery", "Enter room slug"],
    );
  }
  assert.equal(
    (await controller.menu.actions.selectPublicRoom(actionContext(ctx.ctx, undefined, "route:refresh")))?.kind,
    "to",
  );
  screen = controller.menu.screens.publicRooms({ state: await controller.getState() });
  if (screen.kind === "choice") assert.match(screen.lines?.join("\n") ?? "", /No active public rooms/u);
  assert.deepEqual(await controller.menu.actions.selectPublicRoom(actionContext(ctx.ctx, undefined, "route:manual")), {
    kind: "to",
    screen: "joinPublic",
  });
});

test("invite and public input actions validate payloads and successful joins open chat", async () => {
  const joined: string[] = [];
  let opened = 0;
  const controller = createChatMenu(
    source({
      joinRoom: async (room) => {
        joined.push(room.label);
        return true;
      },
      openChat: async () => {
        opened += 1;
      },
    }),
  );
  const ctx = createMockContext({ hasUI: true, mode: "tui", confirm: async () => true });
  const invite = createPrivateRoom(Buffer.alloc(32, 8)).invite;
  assert.ok(invite);
  assert.deepEqual(await controller.menu.actions.joinInvite(actionContext(ctx.ctx, invite)), {
    kind: "close",
  });
  assert.deepEqual(await controller.menu.actions.joinPublic(actionContext(ctx.ctx, "pi-dev")), {
    kind: "close",
  });
  assert.deepEqual(joined, [createPrivateRoom(Buffer.alloc(32, 8)).label, "#pi-dev"]);
  assert.equal(opened, 2);
  const rejected = await controller.menu.actions.joinInvite(actionContext(ctx.ctx, "bad"));
  assert.equal(rejected?.kind, "rejected");
  const cancelled = createChatMenu(
    source({
      joinRoom: async () => {
        throw new Error("cancelled public join must not start");
      },
      openChat: async () => {
        throw new Error("cancelled public join must not open chat");
      },
    }),
  );
  const cancelContext = createMockContext({
    hasUI: true,
    mode: "tui",
    confirm: async () => false,
  });
  assert.deepEqual(await cancelled.menu.actions.joinPublic(actionContext(cancelContext.ctx, "pi-dev")), {
    kind: "stay",
  });
});

test("remembered restore failures expose shallow retry, replacement, and forget recovery", async () => {
  const room = createPrivateRoom(Buffer.alloc(32, 3));
  const controller = createChatMenu(
    source({
      getSettings: () => ({
        resume: {
          rooms: [{ id: room.id, kind: "private", invite: room.invite ?? "" }],
          activeRoomId: room.id,
          surface: "chat",
        },
      }),
      getRestoreError: () => "network unavailable",
    }),
  );
  const state = await controller.getState();
  const screen = controller.menu.screens.main({ state });
  assert.equal(screen.kind, "actions");
  if (screen.kind === "actions") {
    assert.match(screen.title, /could not restore/u);
    assert.match(screen.lines?.join("\n") ?? "", /network unavailable/u);
    assert.deepEqual(
      screen.items.map(({ label }) => label),
      [`Retry ${room.label}`, "Join another room", `Forget ${room.label}…`, "Settings", "Status", "Help"],
    );
  }
  const replacement = controller.menu.screens.joinAnother({ state });
  assert.equal(replacement.kind, "actions");
  if (replacement.kind === "actions") {
    assert.deepEqual(
      replacement.items.map(({ label }) => label),
      ["Browse public rooms", "Join public room", "Join with invite", "Create private room"],
    );
  }
});

test("joined room display keeps four compatible choices in one flat group", async () => {
  const controller = createChatMenu(source({ getSettings: () => ({ widgetMode: "dock" }) }));
  const state = await controller.getState();
  const screen = controller.menu.screens.widget({ state });
  assert.equal(screen.kind, "choice");
  if (screen.kind === "choice") {
    assert.deepEqual(
      screen.items.map(({ label }) => label),
      ["Room dock", "Latest message", "Status only", "Hidden"],
    );
    assert.equal(screen.currentItemId, "dock");
  }
});

test("leaving, widget settings, and identity reset require explicit actions", async () => {
  let left = 0;
  let reset = 0;
  let mode = "";
  let toggled = "";
  const controller = createChatMenu(
    source({
      leaveRoom: async () => void left++,
      resetIdentity: async () => void reset++,
      toggleMute: (publicKey) => {
        toggled = publicKey;
        return true;
      },
      updateWidgetMode: async (value) => {
        mode = value;
      },
    }),
  );
  const ctx = createMockContext({ hasUI: true, mode: "tui" });
  await controller.menu.actions.leave(actionContext(ctx.ctx));
  await controller.menu.actions.setWidget(actionContext(ctx.ctx, undefined, "dock"));
  await controller.menu.actions.resetIdentity(actionContext(ctx.ctx));
  await controller.menu.actions.toggleMute(actionContext(ctx.ctx, undefined, "ab".repeat(32)));
  assert.equal(left, 1);
  assert.equal(mode, "dock");
  assert.equal(reset, 1);
  assert.equal(toggled, "ab".repeat(32));
});
