import assert from "node:assert/strict";
import { visibleWidth } from "@earendil-works/pi-tui";
import { test } from "vitest";
import type { ChatSnapshot } from "../src/chat-session.js";
import { ChatView } from "../src/chat-view.js";
import { createPrivateRoom } from "../src/protocol.js";
import { sanitizeChatText, sanitizeSingleLine } from "../src/text.js";
import { renderChatWidget } from "../src/widget.js";

const room = createPrivateRoom(Buffer.alloc(32, 4));

function snapshot(overrides: Partial<ChatSnapshot> = {}): ChatSnapshot {
  return {
    state: "connected",
    room,
    localLabel: "Me~AAAA-BBBB-CCCC",
    participants: [],
    directNeighbors: 0,
    participantCatalogFull: false,
    transcript: [],
    unread: 0,
    composerOpen: false,
    ...overrides,
  };
}

const theme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
};

test("sanitizes terminal and bidi controls before line handling", () => {
  const hostile = "safe\u001b]8;;https://evil\u0007link\u001b]8;;\u0007\nred\u001b[31m!\u202e";
  const rendered = sanitizeChatText(hostile);
  assert.equal(rendered.includes("\u001b"), false);
  assert.equal(rendered.includes("\u0007"), false);
  assert.equal(rendered.includes("\u202e"), false);
  assert.equal(rendered.includes("\n"), true);
  assert.equal(sanitizeSingleLine("a\nb\u001b[2J"), "a b�");
});

test("privacy-safe widget hides message text by default and bounds every line", () => {
  const state = snapshot({
    unread: 2,
    participants: [{ publicKey: "1", label: "Other~AAAA-BBBB-CCCC", nickname: "Other", muted: false }],
    directNeighbors: 1,
    transcript: [
      {
        id: "1",
        author: "remote",
        label: "Other~AAAA-BBBB-CCCC",
        publicKey: "1",
        text: "private message",
        sentAt: 1,
      },
    ],
  });
  const count = renderChatWidget(state, "count", 28, theme as never);
  assert.equal(count.join("\n").includes("private message"), false);
  assert.match(count.join("\n"), /2 unread/u);
  const latest = renderChatWidget(state, "latest", 28, theme as never);
  assert.match(latest.join("\n"), /private message/u);
  assert.equal(
    latest.every((line) => visibleWidth(line) <= 28),
    true,
  );
  assert.deepEqual(renderChatWidget(state, "off", 28, theme as never), []);
});

test("room dock keeps status, bounded recent messages, and the real input target visible", () => {
  const transcript = ["old", "one", "two", "three"].map((text, index) => ({
    id: String(index),
    author: "remote" as const,
    label: `開發者${index}~AAAA-BBBB-CCCC`,
    publicKey: String(index),
    text: `${text}\u001b[2J`,
    sentAt: index,
  }));
  const renderDock = (state: ChatSnapshot, width: number, rows: number) =>
    (
      renderChatWidget as unknown as (
        snapshot: ChatSnapshot,
        mode: "dock",
        width: number,
        theme: unknown,
        rows: number,
      ) => string[]
    )(state, "dock", width, theme, rows);
  const state = snapshot({
    participants: [{ publicKey: "1", label: "Other~AAAA-BBBB-CCCC", nickname: "Other", muted: false }],
    directNeighbors: 1,
    transcript,
  });
  const wide = renderDock(state, 64, 30);
  assert.match(wide[0] ?? "", /ROOM.*private/u);
  assert.doesNotMatch(wide.join("\n"), /old/u);
  assert.match(wide.join("\n"), /one/u);
  assert.match(wide.join("\n"), /three/u);
  assert.match(wide.at(-1) ?? "", /Input → Pi\/LLM/u);
  assert.equal(wide.join("\n").includes("\u001b[2J"), false);

  const composing = renderDock({ ...state, composerOpen: true } as ChatSnapshot, 40, 18);
  assert.match(composing.at(-1) ?? "", /Input → CHAT/u);
  assert.equal(
    composing.every((line) => visibleWidth(line) <= 40),
    true,
  );
  const low = renderDock(state, 20, 8);
  assert.equal(low.length <= 3, true);
  assert.equal(
    low.every((line) => visibleWidth(line) <= 20),
    true,
  );
  for (const width of [20, 40, 60, 80, 100, 160]) {
    for (const rows of [8, 18, 30]) {
      const rendered = renderDock(state, width, rows);
      assert.equal(
        rendered.every((line) => visibleWidth(line) <= width),
        true,
        `${width}x${rows}`,
      );
    }
  }
});

test("room dock distinguishes joining, waiting, and degraded partial connectivity", () => {
  const joining = renderChatWidget(snapshot({ state: "connecting" }), "dock" as never, 48, theme as never);
  assert.match(joining.join("\n"), /joining/u);
  const waiting = renderChatWidget(snapshot(), "dock" as never, 48, theme as never);
  assert.match(waiting.join("\n"), /waiting for neighbors/u);
  const degraded = renderChatWidget(
    snapshot({
      state: "degraded",
      participants: [{ publicKey: "1", label: "Other~AAAA", nickname: "Other", muted: false }],
      directNeighbors: 1,
    }),
    "dock" as never,
    48,
    theme as never,
  );
  assert.match(degraded.join("\n"), /reconnecting[\s\S]*1 direct neighbor/u);
});

test("chat composer makes its target explicit, preserves failed drafts, and clears successful sends", () => {
  let current = snapshot();
  let relayedTo = 0;
  let sendError: Error | undefined;
  const sent: string[] = [];
  const drafts: string[] = [];
  const viewStates: boolean[] = [];
  let closed = 0;
  let returnedToPi = 0;
  let renders = 0;
  let subscription: (() => void) | undefined;
  let unsubscribed = 0;
  const view = new ChatView({
    tui: { terminal: { rows: 30 }, requestRender: () => renders++ } as never,
    theme: theme as never,
    getSnapshot: () => current,
    send: (text) => {
      if (sendError) throw sendError;
      sent.push(text);
      return { id: "sent", relayedTo };
    },
    initialDraft: "",
    onDraftChange: (text) => drafts.push(text),
    setViewOpen: (open) => viewStates.push(open),
    subscribe: (listener) => {
      subscription = listener;
      return () => unsubscribed++;
    },
    onReturnToPi: () => returnedToPi++,
    onClose: () => closed++,
  });
  view.focused = true;
  assert.equal(view.focused, true);
  subscription?.();
  assert.match(view.render(48).join("\n"), /CHAT INPUT → private/u);
  view.handleInput("hello");
  view.handleInput("\r");
  assert.deepEqual(sent, []);
  assert.equal(drafts.at(-1), "hello");
  assert.match(view.render(48).join("\n"), /message kep/i);

  current = snapshot({
    participants: [{ publicKey: "1", label: "開發者~AAAA-BBBB-CCCC", nickname: "開發者", muted: false }],
    directNeighbors: 1,
    transcript: [
      {
        id: "1",
        author: "remote",
        label: "開發者~AAAA-BBBB-CCCC",
        publicKey: "1",
        text: `  code\n    indented\n${"long ".repeat(30)}`,
        sentAt: 1,
      },
    ],
  });
  view.handleInput("\r");
  assert.deepEqual(sent, ["hello"]);
  assert.equal(drafts.at(-1), "hello");
  assert.match(view.render(48).join("\n"), /message kep/i);
  sendError = new Error("Message is too large");
  view.handleInput("\r");
  assert.deepEqual(sent, ["hello"]);
  assert.equal(drafts.at(-1), "hello");
  assert.match(view.render(48).join("\n"), /too large/i);
  sendError = undefined;
  relayedTo = 1;
  view.handleInput("\r");
  assert.deepEqual(sent, ["hello", "hello"]);
  assert.equal(drafts.at(-1), "");

  view.handleInput("保留草稿");
  const narrow = view.render(24);
  assert.equal(
    narrow.every((line) => visibleWidth(line) <= 24),
    true,
  );
  assert.equal(
    narrow.some((line) => line.includes("    code")),
    true,
  );
  view.handleInput("\u001b");
  assert.equal(drafts.at(-1), "保留草稿");
  assert.equal(closed, 1);
  assert.equal(returnedToPi, 1);
  assert.deepEqual(viewStates, [true, false]);
  assert.equal(unsubscribed, 1);
  assert.ok(renders > 0);
});

test("owner abort closes the composer without recording a user return", () => {
  const controller = new AbortController();
  const viewStates: boolean[] = [];
  let returnedToPi = 0;
  let closed = 0;
  const view = new ChatView({
    tui: { terminal: { rows: 20 }, requestRender() {} } as never,
    theme: theme as never,
    getSnapshot: () => snapshot(),
    send: () => ({ id: "sent", relayedTo: 0 }),
    setViewOpen: (open) => viewStates.push(open),
    signal: controller.signal,
    onReturnToPi: () => returnedToPi++,
    onClose: () => closed++,
  });
  controller.abort(new DOMException("Session replaced", "AbortError"));
  view.dispose();
  assert.deepEqual(viewStates, [true, false]);
  assert.equal(returnedToPi, 0);
  assert.equal(closed, 1);
});

test("chat composer restores retained drafts and host disposal does not record a user return", () => {
  let draft = "之前的草稿";
  let returnedToPi = 0;
  const view = new ChatView({
    tui: { terminal: { rows: 8 }, requestRender() {} } as never,
    theme: theme as never,
    getSnapshot: () => snapshot(),
    send: () => ({ id: "sent", relayedTo: 0 }),
    initialDraft: draft,
    onDraftChange: (text) => {
      draft = text;
    },
    setViewOpen() {},
    onReturnToPi: () => returnedToPi++,
    onClose() {},
  });
  view.focused = true;
  const lines = view.render(20);
  assert.match(lines.join("\n"), /之前的草稿/u);
  assert.equal(lines.length <= 6, true);
  assert.equal(
    lines.every((line) => visibleWidth(line) <= 20),
    true,
  );
  view.dispose();
  assert.equal(draft, "之前的草稿");
  assert.equal(returnedToPi, 0);
});
