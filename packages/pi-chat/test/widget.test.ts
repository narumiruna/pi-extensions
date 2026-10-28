import assert from "node:assert/strict";
import { visibleWidth } from "@earendil-works/pi-tui";
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
      assert.equal(lines[0], "─".repeat(normalized));
      assert.ok(lines.length > 1);
      assert.ok(
        lines.every((line) => visibleWidth(line) <= normalized),
        `${mode} at ${width}`,
      );
      if (normalized > 0) assert.ok(calls.some(([role, text]) => role === "borderMuted" && text === lines[0]));
      else assert.ok(lines.every((line) => line === ""));
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

test("dock retains local preview thresholds and split header policy beneath the rule", () => {
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
    assert.match(wide[1] ?? "", /^ROOM /u);
    assert.match(wide.at(-1) ?? "", /^Input → Pi\/LLM/u);
    const shown = wide.filter((line) => /^Peer~/u.test(line));
    assert.equal(shown.length, previews);
    assert.doesNotMatch(wide.join("\n"), /old/u);
    const narrow = component.render(20);
    assert.equal(narrow.length, 4 + previews);
    assert.ok(narrow.every((line) => visibleWidth(line) <= 20));
  }
});
