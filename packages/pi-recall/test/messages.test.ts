import assert from "node:assert/strict";
import { test } from "vitest";
import {
  extractMessageCandidates,
  filterRecallMessages,
  formatRecallQuote,
  MAX_MESSAGE_TEXT_BYTES,
  messagePreview,
  normalizeCwd,
  type RecallMessageRecord,
} from "../src/messages.js";

const source = { sessionId: "session-a", sessionName: "Named", cwd: "/work/project" };

function record(overrides: Partial<RecallMessageRecord> = {}): RecallMessageRecord {
  return {
    type: "recall_message",
    version: 1,
    id: "saved-a",
    savedAt: "2026-08-04T13:00:00.000Z",
    source: {
      sessionId: "session-a",
      entryId: "entry-a",
      sessionName: "Named",
      cwd: "/work/project",
      messageTimestamp: Date.parse("2026-08-04T12:34:56.000Z"),
    },
    role: "assistant",
    text: "answer",
    ...overrides,
  };
}

test("extracts active-branch user and assistant text newest first without hidden content", () => {
  const entries = [
    {
      type: "message",
      id: "user-1",
      message: {
        role: "user",
        content: [
          { type: "text", text: "first" },
          { type: "image", data: "base64-secret", mimeType: "image/png" },
          { type: "text", text: "second" },
        ],
        timestamp: 100,
      },
    },
    {
      type: "message",
      id: "assistant-1",
      message: {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "private" },
          { type: "text", text: "visible\n  indented" },
          { type: "toolCall", id: "call", name: "read", arguments: {} },
        ],
        timestamp: 200,
      },
    },
    { type: "message", id: "tool", message: { role: "toolResult", content: [] } },
    { type: "custom", id: "custom", data: { text: "not a message" } },
  ];

  assert.deepEqual(extractMessageCandidates(entries, source), [
    {
      entryId: "assistant-1",
      role: "assistant",
      text: "visible\n  indented",
      messageTimestamp: 200,
      source,
    },
    {
      entryId: "user-1",
      role: "user",
      text: "first\nsecond",
      messageTimestamp: 100,
      source,
    },
  ]);
});

test("excludes empty, image-only, non-finite timestamp, and oversized messages", () => {
  const entries = [
    { type: "message", id: "empty", message: { role: "user", content: "  ", timestamp: 1 } },
    {
      type: "message",
      id: "image",
      message: { role: "user", content: [{ type: "image", data: "x" }], timestamp: 2 },
    },
    {
      type: "message",
      id: "time",
      message: { role: "assistant", content: [{ type: "text", text: "x" }], timestamp: NaN },
    },
    {
      type: "message",
      id: "range",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "x" }],
        timestamp: Number.MAX_VALUE,
      },
    },
    {
      type: "message",
      id: "large",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "界".repeat(MAX_MESSAGE_TEXT_BYTES) }],
        timestamp: 3,
      },
    },
  ];
  assert.deepEqual(extractMessageCandidates(entries, source), []);
});

test("scope filtering uses exact session ids and normalized cwd identity", () => {
  const records = [
    record(),
    record({
      id: "saved-b",
      source: { ...record().source, sessionId: "session-b", entryId: "entry-b" },
    }),
    record({
      id: "saved-c",
      source: {
        ...record().source,
        sessionId: "session-c",
        cwd: "/other",
        entryId: "entry-c",
      },
    }),
  ];
  const current = { sessionId: "session-a", cwd: "/work/./project" };
  assert.deepEqual(
    filterRecallMessages(records, "all", current).map(({ id }) => id),
    ["saved-a", "saved-b", "saved-c"],
  );
  assert.deepEqual(
    filterRecallMessages(records, "cwd", current).map(({ id }) => id),
    ["saved-a", "saved-b"],
  );
  assert.deepEqual(
    filterRecallMessages(records, "session", current).map(({ id }) => id),
    ["saved-a"],
  );
  assert.equal(normalizeCwd("C:\\Work\\Project", "win32"), "c:\\work\\project");
});

test("formats a bounded preview without mutating Unicode text", () => {
  assert.equal(messagePreview(" first\nsecond\tline ", 18), "first second line");
  assert.equal(messagePreview("😀😀😀😀", 3), "😀😀…");
});

test("formats an XML-safe quote without local source identifiers", () => {
  const quoted = formatRecallQuote(record({ text: '<tag attr="x">A & B\'s</tag>' }));
  assert.equal(
    quoted,
    '<recalled_message role="assistant" message_timestamp="2026-08-04T12:34:56.000Z">\n&lt;tag attr=&quot;x&quot;&gt;A &amp; B&apos;s&lt;/tag&gt;\n</recalled_message>\n\nThe user intentionally recalled and quoted the saved message above.\n\n',
  );
  assert.doesNotMatch(quoted, /session-a|entry-a|work\/project|Named/);
});
