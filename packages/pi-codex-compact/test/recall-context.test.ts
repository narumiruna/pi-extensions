import assert from "node:assert/strict";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { test } from "vitest";
import {
  CONTEXT_STATE_ENTRY_TYPE,
  createExperimentalContextDetails,
  createInitialContextState,
} from "../src/context-window.js";
import { NOTES_ENTRY_TYPE } from "../src/notes-state.js";
import { recallContext } from "../src/recall-context.js";

const windowId = "11111111-1111-4111-8111-111111111111";

function branch(): SessionEntry[] {
  return [
    {
      type: "message",
      id: "user",
      parentId: null,
      timestamp: "2026-01-01T00:00:00.000Z",
      message: {
        role: "user",
        content: [{ type: "text", text: "secret decision\u001b[31m" }],
        timestamp: 1,
      },
    },
    {
      type: "custom",
      customType: CONTEXT_STATE_ENTRY_TYPE,
      data: createInitialContextState(windowId),
      id: "state",
      parentId: "user",
      timestamp: "2026-01-01T00:00:01.000Z",
    },
    {
      type: "custom",
      customType: NOTES_ENTRY_TYPE,
      data: { version: 1, action: "write", note: "decision", content: "Use OAuth" },
      id: "note",
      parentId: "state",
      timestamp: "2026-01-01T00:00:02.000Z",
    },
  ];
}

function historyEntry(id: string, message: AgentMessage): SessionEntry {
  return {
    type: "message",
    id,
    parentId: "note",
    timestamp: "2026-01-01T00:00:03.000Z",
    message,
  };
}

function assistantMessage(content: unknown[]): AgentMessage {
  return {
    role: "assistant",
    content,
    api: "openai-responses",
    provider: "openai",
    model: "test",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: 2,
  } as AgentMessage;
}

test("lists and searches model-visible history without custom-entry payloads", () => {
  const entries = branch();
  const listed = recallContext(entries, { source: "history", action: "list" });
  assert.match(listed.text, /"id": "user"/);
  assert.match(listed.text, new RegExp(windowId));
  const searched = recallContext(entries, {
    source: "history",
    action: "search",
    query: "decision",
  });
  assert.match(searched.text, /"id": "user"/);
  assert.doesNotMatch(searched.text, /Use OAuth/);
  assert.equal(searched.text.includes("\u001b"), false);
});

test("does not attribute history to context details without their canonical summary", () => {
  const details = createExperimentalContextDetails({
    lineage: createInitialContextState(windowId),
    keptMessages: [],
    reason: "manual",
    windowId: "22222222-2222-4222-8222-222222222222",
  });
  const entries: SessionEntry[] = [
    {
      type: "compaction",
      id: "replaced",
      parentId: null,
      timestamp: "2026-01-01T00:00:00.000Z",
      summary: "Replacement summary",
      firstKeptEntryId: "later",
      tokensBefore: 100,
      details,
    },
    {
      type: "message",
      id: "later",
      parentId: "replaced",
      timestamp: "2026-01-01T00:00:01.000Z",
      message: {
        role: "user",
        content: [{ type: "text", text: "later message" }],
        timestamp: 1,
      },
    },
  ];
  const listed = recallContext(entries, { source: "history", action: "list" });
  const later = (listed.details.items as Array<{ id: string; windowId?: string }>).find((item) => item.id === "later");
  assert.ok(later);
  assert.equal(later.windowId, undefined);
  assert.doesNotMatch(listed.text, new RegExp(details.currentWindowId));
});

test("reads and searches notes separately from history", () => {
  const entries = branch();
  const listed = recallContext(entries, { source: "notes", action: "list" });
  assert.match(listed.text, /decision/);
  const read = recallContext(entries, { source: "notes", action: "read", id: "decision" });
  assert.match(read.text, /Use OAuth/);
  const searched = recallContext(entries, {
    source: "notes",
    action: "search",
    query: "oauth",
  });
  assert.match(searched.text, /decision/);
});

test("sanitizes note reads before paginating visible text", () => {
  const entries = branch();
  const note = entries[2];
  if (note.type !== "custom") assert.fail("Expected note entry");
  const content = `${"\u001b[31m".repeat(2_458)}meaningful decision`;
  note.data = { version: 1, action: "write", note: "decision", content };

  const read = recallContext(entries, { source: "notes", action: "read", id: "decision" });
  assert.equal(read.details.chunk, "meaningful decision");
  assert.equal(read.details.nextCursor, undefined);
  assert.match(read.text, /meaningful decision/);
  assert.doesNotMatch(read.text, /\[31m/);
  assert.equal((note.data as { content: string }).content, content);
});

test("sanitizes history payloads before serializing and paginating visible text", () => {
  const entries = branch();
  const user = entries[0];
  if (user.type !== "message" || user.message.role !== "user") {
    assert.fail("Expected user entry");
  }
  const text = `${"\u001b[31m".repeat(2_458)}meaningful history decision`;
  user.message.content = [{ type: "text", text }];

  const read = recallContext(entries, { source: "history", action: "read", id: "user" });
  assert.equal(read.details.chunk, '{"content":[{"type":"text","text":"meaningful history decision"}]}');
  assert.equal(read.details.nextCursor, undefined);
  assert.match(read.text, /meaningful history decision/);
  assert.doesNotMatch(read.text, /(?:\\u001b|\[31m)/);
  assert.equal((user.message.content[0] as { text: string }).text, text);
});

test("matches note and history queries against sanitized visible text", () => {
  const entries = branch();
  const user = entries[0];
  const note = entries[2];
  if (user.type !== "message" || user.message.role !== "user") {
    assert.fail("Expected user entry");
  }
  if (note.type !== "custom") assert.fail("Expected note entry");
  user.message.content = [{ type: "text", text: "auth\u001b[31mentication" }];
  note.data = {
    version: 1,
    action: "write",
    note: "decision",
    content: "author\u001b[31mization",
  };

  const history = recallContext(entries, {
    source: "history",
    action: "search",
    query: "AUTHENTICATION",
  });
  const notes = recallContext(entries, {
    source: "notes",
    action: "search",
    query: "authorization",
  });
  assert.match(history.text, /"id": "user"/);
  assert.match(notes.text, /"id": "decision"/);
  assert.equal(history.text.includes("\u001b"), false);
  assert.equal(notes.text.includes("\u001b"), false);
});

test("sanitizes history before applying the visible index limit", () => {
  const entries = branch();
  const user = entries[0];
  if (user.type !== "message" || user.message.role !== "user") {
    assert.fail("Expected user entry");
  }
  user.message.content = [
    {
      type: "text",
      text: `${"\u001b[31m".repeat(60_000)}meaningful visible decision`,
    },
  ];

  const listed = recallContext(entries, { source: "history", action: "list" });
  const searched = recallContext(entries, {
    source: "history",
    action: "search",
    query: "meaningful visible",
  });
  assert.match(listed.text, /meaningful visible decision/);
  assert.match(searched.text, /"id": "user"/);
  assert.doesNotMatch(listed.text, /\[31m/);
  assert.doesNotMatch(searched.text, /\[31m/);
});

test("history indexing skips image data before later text", () => {
  const entries = branch();
  entries.push(
    historyEntry("image-result", {
      role: "toolResult",
      toolCallId: "image-call",
      toolName: "screenshot",
      content: [
        { type: "image", data: "a".repeat(1_100_000), mimeType: "image/png" },
        { type: "text", text: "meaningful text after image" },
      ],
      isError: false,
      timestamp: 2,
    }),
  );

  const listed = recallContext(entries, { source: "history", action: "list" });
  const searched = recallContext(entries, {
    source: "history",
    action: "search",
    query: "meaningful text after image",
  });
  assert.match(listed.text, /meaningful text after image/);
  assert.match(listed.text, /image\/png/);
  assert.doesNotMatch(listed.text, /a{100}/);
  assert.match(searched.text, /"id": "image-result"/);
  const read = recallContext(entries, { source: "history", action: "read", id: "image-result" });
  assert.match(read.text, /data.*a{100}/s);
});

test("history indexing skips opaque provider signatures", () => {
  const opaque = "s".repeat(1_100_000);
  const cases = [
    {
      label: "text signature",
      block: { type: "text", text: "signed text", textSignature: opaque },
    },
    {
      label: "thinking signature",
      block: { type: "thinking", thinking: "visible thought", thinkingSignature: opaque },
    },
    {
      label: "tool-call signature",
      block: {
        type: "toolCall",
        id: "call",
        name: "read",
        arguments: { path: "README.md" },
        thoughtSignature: opaque,
      },
    },
  ];
  for (const { label, block } of cases) {
    const id = label.replaceAll(" ", "-");
    const entries = branch();
    entries.push(historyEntry(id, assistantMessage([block, { type: "text", text: `meaningful text after ${label}` }])));
    const listed = recallContext(entries, { source: "history", action: "list" });
    const searched = recallContext(entries, {
      source: "history",
      action: "search",
      query: `meaningful text after ${label}`,
    });
    assert.match(listed.text, new RegExp(`meaningful text after ${label}`), label);
    assert.doesNotMatch(listed.text, /s{100}/, label);
    assert.match(searched.text, new RegExp(`"id": "${id}"`), label);
  }
});

test("history search excludes completed recall call arguments", () => {
  const entries = branch();
  entries.push(
    historyEntry(
      "completed-recall",
      assistantMessage([
        {
          type: "toolCall",
          id: "completed-call",
          name: "codex_compact_recall_context",
          arguments: {
            source: "history",
            action: "search",
            query: "absent completed query",
          },
        },
      ]),
    ),
  );

  const searched = recallContext(entries, {
    source: "history",
    action: "search",
    query: "absent completed query",
  });
  assert.deepEqual(searched.details.items, []);
  assert.doesNotMatch(searched.text, /completed-recall/);
});

test("history search excludes completed recall tool results while exact reads remain available", () => {
  const entries = branch();
  entries.push(
    historyEntry("completed-recall-result", {
      role: "toolResult",
      toolCallId: "completed-call",
      toolName: "codex_compact_recall_context",
      content: [{ type: "text", text: "synthetic repeated query" }],
      isError: false,
      timestamp: 4,
    }),
  );

  const searched = recallContext(entries, {
    source: "history",
    action: "search",
    query: "synthetic repeated query",
  });
  assert.deepEqual(searched.details.items, []);
  const read = recallContext(entries, {
    source: "history",
    action: "read",
    id: "completed-recall-result",
  });
  assert.match(read.text, /synthetic repeated query/);
});

test("completed recall calls do not consume history search cursors", () => {
  const entries = branch();
  for (let index = 0; index < 25; index += 1) {
    entries.push(
      historyEntry(
        `completed-recall-${index}`,
        assistantMessage([
          {
            type: "toolCall",
            id: `completed-call-${index}`,
            name: "codex_compact_recall_context",
            arguments: { source: "history", action: "search", query: "cursor match" },
          },
        ]),
      ),
    );
  }
  for (let index = 0; index < 21; index += 1) {
    entries.push(
      historyEntry(`visible-${index}`, {
        role: "user",
        content: [{ type: "text", text: `cursor match ${index}` }],
        timestamp: index + 10,
      }),
    );
  }

  const searched = recallContext(entries, {
    source: "history",
    action: "search",
    query: "cursor match",
    cursor: "20",
  });
  assert.deepEqual(
    (searched.details.items as Array<{ id: string }>).map((item) => item.id),
    ["visible-20"],
  );
  assert.equal(searched.details.nextCursor, undefined);
});

test("bounds aggregate work across a history search", () => {
  const entries = branch();
  for (let index = 0; index < 5; index += 1) {
    entries.push(
      historyEntry(`large-${index}`, {
        role: "user",
        content: [{ type: "text", text: "x".repeat(1_100_000) }],
        timestamp: index + 10,
      }),
    );
  }
  assert.throws(() => recallContext(entries, { source: "history", action: "search", query: "absent" }), /scan limit/);
});

test("charges structural nodes to the aggregate history-search budget", () => {
  const entries = branch();
  for (let index = 0; index < 5; index += 1) {
    entries.push(
      historyEntry(
        `large-structure-${index}`,
        assistantMessage([
          {
            type: "toolCall",
            id: `large-structure-call-${index}`,
            name: "foreign_tool",
            arguments: { values: Array(900_000).fill(index === 4 ? {} : "") },
          },
        ]),
      ),
    );
  }
  assert.throws(() => recallContext(entries, { source: "history", action: "search", query: "absent" }), /scan limit/);
});

test("indexes deeply nested structures without recursive traversal", () => {
  let nested: unknown = "deep value";
  for (let index = 0; index < 20_000; index += 1) nested = [nested];
  const entries = branch();
  entries.push(
    historyEntry(
      "deep-structure",
      assistantMessage([
        {
          type: "toolCall",
          id: "deep-structure-call",
          name: "foreign_tool",
          arguments: nested,
        },
      ]),
    ),
  );

  const searched = recallContext(entries, { source: "history", action: "search", query: "deep value" });
  assert.deepEqual(
    (searched.details.items as Array<{ id: string }>).map((item) => item.id),
    ["deep-structure"],
  );
});

test("serializes full history content only for the selected read item", () => {
  const entries = branch();
  const user = entries[0];
  if (user.type !== "message" || user.message.role !== "user") {
    assert.fail("Expected user entry");
  }
  let serializations = 0;
  user.message.content = {
    visible: "bounded searchable text",
    toJSON() {
      serializations += 1;
      return [{ type: "text", text: "exact read text" }];
    },
  } as never;

  assert.match(recallContext(entries, { source: "history", action: "list" }).text, /bounded/);
  assert.match(
    recallContext(entries, {
      source: "history",
      action: "search",
      query: "searchable",
    }).text,
    /"id": "user"/,
  );
  assert.equal(serializations, 0);
  assert.match(recallContext(entries, { source: "history", action: "read", id: "user" }).text, /exact read text/);
  assert.equal(serializations, 1);
});

test("ignores note identifiers that would change at the display boundary", () => {
  const entries = branch();
  entries.push({
    type: "custom",
    customType: NOTES_ENTRY_TYPE,
    data: {
      version: 1,
      action: "write",
      note: "unsafe\u001b[31m",
      content: "hidden",
    },
    id: "unsafe-note",
    parentId: entries.at(-1)?.id ?? null,
    timestamp: "2026-01-01T00:00:03.000Z",
  });
  const listed = recallContext(entries, { source: "notes", action: "list" });
  assert.doesNotMatch(listed.text, /unsafe/);
  assert.throws(() => recallContext(entries, { source: "notes", action: "read", id: "unsafe\u001b[31m" }), /not found/);
});

test.each(["notes", "history"] as const)("sanitizes unknown %s identifiers in errors", (source) => {
  const unsafeId = "unknown\u009b";
  assert.throws(
    () => recallContext(branch(), { source, action: "read", id: unsafeId }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(error.message.includes("\u009b"), false);
      assert.match(error.message, /unknown/);
      return true;
    },
  );
});

test("paginates long history reads below the response ceiling", () => {
  const entries = branch();
  const user = entries[0];
  if (user.type !== "message" || user.message.role !== "user") assert.fail("Expected user entry");
  user.message.content = [{ type: "text", text: "x".repeat(40_000) }];
  const first = recallContext(entries, { source: "history", action: "read", id: "user" });
  assert.ok(Buffer.byteLength(first.text, "utf8") < 32 * 1024);
  assert.match(first.text, /nextCursor/);
});

test("chunks multibyte reads by UTF-8 bytes without splitting code points", () => {
  const entries = branch();
  const user = entries[0];
  if (user.type !== "message" || user.message.role !== "user") assert.fail("Expected user entry");
  user.message.content = [{ type: "text", text: "😀".repeat(9_000) }];
  const first = recallContext(entries, { source: "history", action: "read", id: "user" });
  assert.ok(Buffer.byteLength(first.text, "utf8") < 32 * 1024);
  const cursor = String(first.details.nextCursor);
  assert.match(cursor, /^\d+$/);
  assert.doesNotThrow(() => recallContext(entries, { source: "history", action: "read", id: "user", cursor }));
});

test("sanitizes note previews before truncating them", () => {
  const entries = branch();
  const note = entries[2];
  if (note.type !== "custom") assert.fail("Expected note entry");
  note.data = {
    version: 1,
    action: "write",
    note: "decision",
    content: `${"\u001b[31m".repeat(100)}meaningful decision`,
  };
  const searched = recallContext(entries, {
    source: "notes",
    action: "search",
    query: "MEANINGFUL",
  });
  assert.match(searched.text, /meaningful decision/);
  assert.doesNotMatch(searched.text, /\[31m/);
});

test.each(["notes", "history"] as const)(
  "rejects %s search queries with no visible text after sanitization",
  (source) => {
    for (const query of ["\u001b[31m", "\u0000\u0007", " \t\n"]) {
      assert.throws(() => recallContext(branch(), { source, action: "search", query }), /no visible text/);
    }
  },
);

test("validates action-specific inputs and cursors", () => {
  assert.throws(() => recallContext(branch(), { source: "history", action: "read" }), /requires id/);
  assert.throws(() => recallContext(branch(), { source: "notes", action: "search", query: "" }), /requires a query/);
  assert.throws(
    () =>
      recallContext(branch(), {
        source: "history",
        action: "list",
        cursor: "invalid",
      }),
    /cursor is invalid/,
  );
});
