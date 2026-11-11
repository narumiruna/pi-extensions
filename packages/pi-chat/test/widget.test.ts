import assert from "node:assert/strict";
import { type Component, type TuiMouseEvent, visibleWidth } from "@earendil-works/pi-tui";
import { test } from "vitest";
import type { ChatSnapshot } from "../src/chat-session.js";
import { createPrivateRoom } from "../src/protocol.js";
import type { WidgetMode } from "../src/settings.js";
import { createChatWidget } from "../src/widget.js";

function snapshot(overrides: Partial<ChatSnapshot> = {}): ChatSnapshot {
  return {
    state: "connected",
    room: createPrivateRoom(Buffer.alloc(32, 4)),
    localLabel: "Me~AAAA-BBBB-CCCC",
    participants: [],
    directNeighbors: 0,
    participantCatalogFull: false,
    transcript: [
      {
        id: "1",
        author: "remote",
        label: "開發者👩‍💻é~AAAA-BBBB-CCCC",
        publicKey: "1",
        text: "private 開發者👩‍💻é text",
        sentAt: 1,
      },
    ],
    unread: 2,
    composerOpen: false,
    ...overrides,
  };
}

function widget(state: ChatSnapshot, mode: WidgetMode, fg = (_role: string, text: string) => text) {
  return createChatWidget({
    theme: { fg } as never,
    getSnapshot: () => state,
    getMode: () => mode,
    getTerminalRows: () => 30,
  });
}

for (const mode of ["count", "latest", "dock"] as const) {
  test(`${mode} widget uses the shared full-width muted rule and normalized widths`, () => {
    const calls: [string, string][] = [];
    const component = widget(snapshot(), mode, (role, text) => {
      calls.push([role, text]);
      return text;
    });
    for (const width of [100, 40, 8, 2, 1, 0, -1, Number.NaN, Number.POSITIVE_INFINITY, 12.9, 80]) {
      const normalized = Number.isFinite(width) ? Math.max(0, Math.floor(width)) : 0;
      calls.length = 0;
      const lines = component.render(width);
      assert.equal(visibleWidth(lines[0] ?? ""), normalized);
      if (normalized >= 40) assert.match(lines[0] ?? "", /^─ ▾ Chat ·/u);
      assert.ok(lines.length > 1);
      assert.ok(
        lines.every((line) => visibleWidth(line) <= normalized),
        `${mode} at ${width}`,
      );
      if (normalized > 2) assert.ok(calls.some(([role]) => role === "borderMuted"));
      if (normalized === 0) assert.ok(lines.every((line) => line === ""));
    }
    const body = component.render(100).slice(1).join("\n");
    if (mode === "count") assert.doesNotMatch(body, /private 開發者/u);
    else assert.match(body, /private 開發者👩‍💻é text/u);
  });
}

test("widget sanitizes raw values before styling and preserves snapshots", () => {
  const hostile = "開發者\u001b]8;;https://evil\u0007link\u001b]8;;\u0007\n👩‍💻é\u001b[2J\u202e\u009b\u0000";
  const state = snapshot();
  state.room = { ...state.room, label: hostile };
  const entry = state.transcript[0];
  assert.ok(entry);
  entry.label = hostile;
  entry.text = hostile;
  const original = {
    ...structuredClone(state),
    room: { ...state.room, topic: Buffer.from(state.room.topic), key: Buffer.from(state.room.key) },
  };
  for (const mode of ["count", "latest", "dock"] as const) {
    const styled: string[] = [];
    const component = widget(state, mode, (_role, text) => {
      styled.push(text);
      return text;
    });
    const lines = component.render(120);
    assert.ok(lines.every((line) => visibleWidth(line) <= 120));
    assert.match(lines.join("\n"), /開發者/u);
    for (const value of [...styled, ...lines]) {
      assert.ok(
        [...value].every((character) => {
          const code = character.codePointAt(0) ?? 0;
          return code >= 32 && (code < 127 || code > 159) && code !== 0x202e;
        }),
      );
    }
  }
  assert.deepEqual(state, original);
});

test("one frame reads live snapshots, modes, row budgets, and callback theme after invalidation", () => {
  let current: ChatSnapshot | undefined = snapshot();
  let mode: WidgetMode = "dock";
  let rows = 30;
  let color = 31;
  const component = createChatWidget({
    theme: { fg: (_role: string, text: string) => `\u001b[${color}m${text}\u001b[0m` } as never,
    getSnapshot: () => current,
    getMode: () => mode,
    getTerminalRows: () => rows,
  });
  const first = component.render(100);
  assert.ok(first.every((line) => line.includes("\u001b[31m")));
  assert.match(first.join("\n"), /private 開發者/u);
  color = 32;
  rows = 8;
  current = { ...snapshot(), state: "degraded", composerOpen: true };
  component.invalidate();
  const changed = component.render(100);
  assert.ok(changed.every((line) => line.includes("\u001b[32m")));
  assert.ok(changed.every((line) => !line.includes("\u001b[31m")));
  assert.doesNotMatch(changed.join("\n"), /private 開發者/u);
  assert.match(changed.join("\n"), /reconnecting/u);
  assert.match(changed.at(-1) ?? "", /Input → CHAT/u);
  mode = "count";
  assert.doesNotMatch(component.render(100).join("\n"), /Input →|private 開發者/u);
  mode = "off";
  assert.deepEqual(component.render(100), []);
  mode = "dock";
  current = snapshot({ state: "disconnected" });
  assert.deepEqual(component.render(100), []);
  current = undefined;
  assert.deepEqual(component.render(100), []);
});

test("dock retains local preview thresholds, participant counts, and the input target beneath the rule", () => {
  const state = snapshot({
    transcript: ["old", "one", "two", "three"].map((text, index) => ({
      id: String(index),
      author: "remote",
      label: "Peer~AAAA-BBBB-CCCC",
      publicKey: "1",
      text,
      sentAt: index,
    })),
  });
  let rows = 8;
  const component = createChatWidget({
    theme: { fg: (_role: string, text: string) => text } as never,
    getSnapshot: () => state,
    getMode: () => "dock",
    getTerminalRows: () => rows,
  });
  for (const [height, previews] of [
    [8, 0],
    [9, 0],
    [10, 1],
    [17, 1],
    [18, 2],
    [25, 2],
    [26, 3],
    [30, 3],
  ]) {
    assert.ok(height !== undefined && previews !== undefined);
    rows = height;
    const wide = component.render(100);
    assert.equal(wide.length, 3 + previews);
    assert.match(wide[0] ?? "", /Chat · private .* · 2 unread/u);
    assert.equal(wide[1], "0 active · 0 direct neighbors · waiting for neighbors");
    assert.doesNotMatch(wide.join("\n"), /ROOM /u);
    assert.match(wide.at(-1) ?? "", /^Input → Pi\/LLM/u);
    const shown = wide.filter((line) => /^Peer~/u.test(line));
    assert.equal(shown.length, previews);
    assert.doesNotMatch(wide.join("\n"), /old/u);
    const narrow = component.render(20);
    assert.equal(narrow.length, 3 + previews);
    assert.ok(narrow.every((line) => visibleWidth(line) <= 20));
  }
});

function clickWidget(component: Component, event: TuiMouseEvent) {
  component.handleMouse?.({ ...event, type: "press" });
  component.render(event.width);
  component.handleMouse?.({ ...event, type: "release" });
  return component.handleMouse?.({ ...event, type: "click" });
}

test("Chat forwards full-body blank-column clicks and restores the latest snapshot after remount", () => {
  let current = snapshot();
  const state = { collapsed: false };
  const create = () =>
    createChatWidget({
      theme: { fg: (_role: string, text: string) => text } as never,
      state,
      getSnapshot: () => current,
      getMode: () => "latest",
      getTerminalRows: () => 30,
    });
  const first = create();
  const lines = first.render(100);
  const event: TuiMouseEvent = {
    type: "press",
    button: "left",
    x: 99,
    y: lines.length - 1,
    screenX: 99,
    screenY: lines.length - 1,
    width: 100,
    height: lines.length,
    shift: false,
    alt: false,
    ctrl: false,
  };
  assert.equal(clickWidget(first, { ...event, ctrl: true }), undefined);
  first.handleMouse(event);
  assert.equal(state.collapsed, false);
  first.handleMouse({ ...event, type: "release" });
  assert.deepEqual(first.handleMouse({ ...event, type: "click" }), { handled: true, render: true });
  assert.match(first.render(100)[0] ?? "", /▸ Chat/u);
  assert.equal(first.render(100).length, 1);
  current = snapshot({ unread: 7, state: "degraded" });
  const refreshed = first.render(100);
  assert.equal(refreshed.length, 1);
  assert.match(refreshed[0] ?? "", /▸ Chat · reconnecting · private .* · 7 unread/u);
  assert.doesNotMatch(refreshed[0] ?? "", /2 unread|private 開發者/u);
  first.dispose();
  first.dispose();
  assert.equal(clickWidget(first, event), undefined);
  assert.deepEqual(first.render(100), []);
  const replacement = create();
  assert.equal(replacement.render(100).length, 1);
  const collapsed = { ...event, y: 0, screenY: 0, height: replacement.render(100).length };
  assert.deepEqual(clickWidget(replacement, collapsed), { handled: true, render: true });
  const restored = replacement.render(100).join("\n");
  assert.match(restored, /7 unread/u);
  assert.match(restored, /reconnecting/u);
  assert.match(restored, /private 開發者/u);
  current = snapshot({ state: "disconnected" });
  assert.deepEqual(replacement.render(100), []);
  assert.equal(clickWidget(replacement, { ...collapsed, height: 0 }), undefined);
  replacement.dispose();
});

for (const mode of ["count", "latest", "dock"] as const) {
  test.each([
    ["connecting", 0, 0, " · joining…"],
    ["connected", 1, 2, ""],
    ["degraded", 2, 7, " · reconnecting"],
  ] as const)(
    `${mode} moves room and %s state before unread counts into the divider`,
    (state, neighbors, unread, status) => {
      const current = snapshot({
        state,
        directNeighbors: neighbors,
        unread,
        participants: [{ publicKey: "1", label: "Peer", nickname: "Peer", muted: false }],
      });
      const component = widget(current, mode);
      const lines = component.render(120);
      const summary = `Chat${status} · ${current.room.label}${unread > 0 ? ` · ${unread} unread` : ""}`;
      assert.ok(lines[0]?.includes(summary));
      assert.equal(lines[1], `1 active · ${neighbors} direct neighbor${neighbors === 1 ? "" : "s"}`);
      assert.doesNotMatch(lines.slice(1).join("\n"), /ROOM |unread|joining|reconnecting/u);
      if (mode === "count") assert.doesNotMatch(lines.join("\n"), /private 開發者/u);
      if (mode === "latest") assert.match(lines.at(-1) ?? "", /private 開發者/u);
      if (mode === "dock") assert.match(lines.at(-1) ?? "", /Input → Pi\/LLM/u);
      if (mode !== "dock") assert.equal(lines[2], "/chat to open");
      component.dispose();
    },
  );
}

test("latest without a transcript has no preview and mode changes keep collapsed summaries current", () => {
  let current = snapshot({ transcript: [], unread: 0 });
  let mode: WidgetMode = "latest";
  const state = { collapsed: false };
  const component = createChatWidget({
    theme: { fg: (_role: string, text: string) => text } as never,
    state,
    getSnapshot: () => current,
    getMode: () => mode,
    getTerminalRows: () => 30,
  });
  const lines = component.render(100);
  assert.equal(lines.length, 3);
  assert.doesNotMatch(lines[0] ?? "", /unread/u);
  const event: TuiMouseEvent = {
    type: "press",
    button: "left",
    x: 99,
    y: 2,
    screenX: 99,
    screenY: 2,
    width: 100,
    height: lines.length,
    shift: false,
    alt: false,
    ctrl: false,
  };
  component.handleMouse(event);
  current = snapshot();
  assert.equal(component.render(100).length, 4);
  component.handleMouse({ ...event, type: "release" });
  assert.equal(component.handleMouse({ ...event, type: "click" }), undefined, "changed rows cancel the old press");
  assert.deepEqual(clickWidget(component, { ...event, height: 4, y: 3, screenY: 3 }), { handled: true, render: true });
  current = { ...snapshot({ state: "connecting", unread: 4 }), room: { ...current.room, label: "#new-room" } };
  mode = "count";
  const collapsed = component.render(100);
  assert.equal(collapsed.length, 1);
  assert.match(collapsed[0] ?? "", /▸ Chat · joining… · #new-room · 4 unread/u);
  assert.doesNotMatch(collapsed.join("\n"), /private 開發者/u);
  assert.deepEqual(clickWidget(component, { ...event, height: 1, y: 0, screenY: 0 }), { handled: true, render: true });
  assert.equal(component.render(100).length, 3);
  assert.doesNotMatch(component.render(100).join("\n"), /private 開發者/u);
  component.dispose();
});

test.each([
  ["connecting", "joining…"],
  ["degraded", "reconnecting"],
] as const)("a long room label cannot hide %s attention at narrow widths", (state, attention) => {
  const current = snapshot({ state, room: { ...snapshot().room, label: `#${"long-room-".repeat(20)}` } });
  for (const mode of ["count", "latest", "dock"] as const) {
    const component = widget(current, mode);
    for (const width of [32, 40]) {
      const lines = component.render(width);
      assert.ok(lines[0]?.includes(`Chat · ${attention} ·`));
      assert.doesNotMatch(lines[0] ?? "", /unread/u);
      assert.ok(lines.every((line) => visibleWidth(line) <= width));
    }
    component.dispose();
  }
});

test("each render pins one coherent snapshot for the divider and body, including while collapsed", () => {
  const first = snapshot({
    state: "connecting",
    unread: 1,
    directNeighbors: 1,
    room: { ...snapshot().room, label: "#first" },
  });
  const second = snapshot({
    state: "degraded",
    unread: 9,
    directNeighbors: 4,
    transcript: [],
    room: { ...snapshot().room, label: "#second" },
  });
  let reads = 0;
  const state = { collapsed: false };
  const component = createChatWidget({
    theme: { fg: (_role: string, text: string) => text } as never,
    state,
    getSnapshot: () => (++reads % 2 === 1 ? first : second),
    getMode: () => "latest",
    getTerminalRows: () => 30,
  });
  const firstFrame = component.render(120);
  assert.equal(reads, 1);
  assert.match(firstFrame[0] ?? "", /Chat · joining… · #first · 1 unread/u);
  assert.equal(firstFrame[1], "0 active · 1 direct neighbor");
  assert.match(firstFrame.at(-1) ?? "", /private 開發者/u);
  const secondFrame = component.render(120);
  assert.equal(reads, 2);
  assert.match(secondFrame[0] ?? "", /Chat · reconnecting · #second · 9 unread/u);
  assert.equal(secondFrame[1], "0 active · 4 direct neighbors");
  assert.equal(secondFrame.length, 3);
  assert.doesNotMatch(secondFrame.join("\n"), /private 開發者/u);
  state.collapsed = true;
  const collapsed = component.render(120);
  assert.equal(reads, 3);
  assert.equal(collapsed.length, 1);
  assert.match(collapsed[0] ?? "", /▸ Chat · joining… · #first · 1 unread/u);
  component.dispose();
});
