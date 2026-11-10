import assert from "node:assert/strict";
import {
  type ExtensionCommandContext,
  type SessionEntry,
  SessionManager,
  type SessionTreeNode,
} from "@earendil-works/pi-coding-agent";
import { createTuiHarness } from "@narumitw/pi-tui-kit/testing";
import { test, vi } from "vitest";
import { createMockContext } from "../../../test/support.js";
import { type MainThreadTreeSelectorOptions, pickMainEntry } from "../src/main-tree-picker.js";

function node(entry: Record<string, unknown>): SessionTreeNode {
  return {
    entry: { id: "entry", parentId: null, timestamp: "2026-01-01T00:00:00.000Z", ...entry } as SessionEntry,
    children: [],
  };
}

const text = (value: string) => ({ type: "text" as const, text: value });
const message = (content: unknown, role = "user", errorMessage?: string) => ({
  type: "message",
  message: { role, content, errorMessage, timestamp: 0 },
});

async function openPicker(
  nodes: SessionTreeNode[],
  options: {
    manager?: ExtensionCommandContext["sessionManager"];
    setLabel?: (entryId: string, label: string | undefined) => void;
    copy?: (value: string, signal: AbortSignal) => Promise<void>;
    signal?: AbortSignal;
    entryExists?: boolean;
  } = {},
) {
  const tui = createTuiHarness({ width: 80, rows: 24 });
  let selector: MainThreadTreeSelectorOptions | undefined;
  const copied: string[] = [];
  const labels: Array<{ entryId: string; label: string | undefined; timestamp: string | undefined }> = [];
  const mock = createMockContext({
    mode: "tui",
    custom: tui.custom,
    signal: options.signal,
    editorText: "main draft",
    sessionManager: options.manager ?? {
      getTree: () => nodes,
      getLeafId: () => nodes[0]?.entry.id ?? null,
      getEntry: (id: string) =>
        options.entryExists === false ? undefined : nodes.find((item) => item.entry.id === id)?.entry,
    },
  });
  const running = pickMainEntry({ setLabel: options.setLabel ?? (() => {}) } as never, mock.ctx, {
    createSelector: (value) => {
      selector = value;
      return {
        focused: false,
        render: () => ["tree"],
        invalidate() {},
        setViewLabel(entryId, label, timestamp) {
          labels.push({ entryId, label, timestamp });
        },
      };
    },
    copyToClipboard:
      options.copy ??
      (async (value) => {
        copied.push(value);
      }),
  });
  try {
    await Promise.race([
      tui.waitForOpen(),
      running.then(() => {
        throw new Error("Picker ended before opening");
      }),
    ]);
    assert.ok(selector);
  } catch (error) {
    tui.dispose();
    await Promise.allSettled([running]);
    throw error;
  }
  return {
    ...mock,
    selector,
    copied,
    labels,
    tui,
    running,
    async close() {
      selector?.onCancel();
      tui.dispose();
      await running;
    },
  };
}

const copyCases: Array<{ name: string; entry: Record<string, unknown>; expected?: string }> = [
  { name: "raw string", entry: message("  raw\u001b[2J\ntext  "), expected: "  raw\u001b[2J\ntext  " },
  { name: "multiple text blocks", entry: message([text("one "), text("two")]), expected: "one two" },
  { name: "empty blocks between text", entry: message([text(""), text("answer"), text("")]), expected: "answer" },
  {
    name: "invalid and non-text blocks",
    entry: message([null, 1, {}, { type: "image", data: "x" }, { type: "text", text: 1 }, text("x")]),
    expected: "x",
  },
  { name: "empty content array", entry: message([]) },
  { name: "null content", entry: message(null) },
  { name: "string whitespace", entry: message(" \t\n\u00a0\ufeff") },
  { name: "block whitespace", entry: message([text(" \t"), text("\n\u00a0\ufeff")]) },
  {
    name: "empty assistant fallback",
    entry: message("", "assistant", "raw error\u001b[2J"),
    expected: "raw error\u001b[2J",
  },
  {
    name: "empty assistant blocks fallback",
    entry: message([text(""), text("")], "assistant", "fallback"),
    expected: "fallback",
  },
  { name: "null assistant fallback", entry: message(null, "assistant", "fallback"), expected: "fallback" },
  {
    name: "assistant tool-only fallback",
    entry: message([{ type: "toolCall", name: "read", arguments: {} }], "assistant", "fallback"),
    expected: "fallback",
  },
  { name: "assistant whitespace does not fall back", entry: message("  ", "assistant", "must not copy") },
  {
    name: "assistant blank blocks do not fall back",
    entry: message([text(" "), text("")], "assistant", "must not copy"),
  },
  {
    name: "assistant answer wins over error",
    entry: message([text("answer"), text(" text")], "assistant", "must not copy"),
    expected: "answer text",
  },
  {
    name: "assistant missing content does not fall back",
    entry: { type: "message", message: { role: "assistant", errorMessage: "must not copy" } },
  },
  { name: "assistant empty error", entry: message([], "assistant", "") },
  { name: "assistant blank error", entry: message([], "assistant", " \n") },
  { name: "assistant without error", entry: message([], "assistant") },
  { name: "tool result", entry: message([text("tool "), text("result")], "toolResult"), expected: "tool result" },
  {
    name: "bash command",
    entry: { type: "message", message: { role: "bashExecution", command: "  echo raw\u001b[2J  " } },
    expected: "  echo raw\u001b[2J  ",
  },
  { name: "blank bash command", entry: { type: "message", message: { role: "bashExecution", command: " \n" } } },
  {
    name: "custom string",
    entry: { type: "custom_message", customType: "test", content: "custom" },
    expected: "custom",
  },
  {
    name: "custom blocks",
    entry: { type: "custom_message", customType: "test", content: [text("custom "), text("blocks")] },
    expected: "custom blocks",
  },
  {
    name: "custom non-text content",
    entry: { type: "custom_message", customType: "test", content: [{ type: "image", data: "x" }] },
  },
  {
    name: "compaction",
    entry: { type: "compaction", summary: "raw compaction\u001b[2J" },
    expected: "raw compaction\u001b[2J",
  },
  {
    name: "branch summary",
    entry: { type: "branch_summary", summary: "raw branch\u001b[2J" },
    expected: "raw branch\u001b[2J",
  },
  { name: "blank summary", entry: { type: "branch_summary", summary: " \t" } },
  { name: "model change", entry: { type: "model_change", provider: "test", modelId: "test" } },
  { name: "thinking change", entry: { type: "thinking_level_change", thinkingLevel: "off" } },
  { name: "custom metadata", entry: { type: "custom", customType: "test" } },
  { name: "context edit", entry: { type: "context_edit", targetId: "target", replacement: null } },
  { name: "label entry", entry: { type: "label", targetId: "target", label: "saved" } },
  { name: "session info", entry: { type: "session_info", name: "session" } },
  { name: "usage", entry: { type: "usage", kind: "test", provider: "test", model: "test" } },
];

for (const { name, entry, expected } of copyCases) {
  test(`tree copy preserves ${name}`, async () => {
    const app = await openPicker([node(entry)]);
    try {
      app.selector.onCopy("entry", "display fallback must not replace a known ID");
      app.selector.onCancel();
      await app.running;
      assert.deepEqual(app.copied, expected === undefined ? [] : [expected]);
      assert.equal(
        app.notifications.some(({ message }) => message === "Selected entry has no text to copy"),
        expected === undefined,
      );
    } finally {
      await app.close();
    }
  });
}

test("tree copy preserves its snapshot after raw mutation and new main entries", async () => {
  const blocks = [text("snapshot\u001b[2J "), text("text")];
  const manager = SessionManager.inMemory();
  const entryId = manager.appendMessage({ role: "user", content: blocks, timestamp: 0 });
  const app = await openPicker([], { manager });
  try {
    blocks[0].text = "changed";
    blocks.push(text("new block"));
    manager.appendMessage({ role: "user", content: "later progress", timestamp: 1 });
    app.selector.onCopy(entryId, "display text");
    app.selector.onCopy(entryId, "display text");
    app.selector.onCancel();
    await app.running;
    assert.deepEqual(app.copied, ["snapshot\u001b[2J text", "snapshot\u001b[2J text"]);
    assert.equal(manager.getEntries().length, 2);
    assert.equal(app.editorText, "main draft");
  } finally {
    await app.close();
  }
});

test("copy materialization failure is observable without starting clipboard work", async () => {
  const app = await openPicker([node(message([text("raw "), text("text")]))]);
  try {
    const join = vi.spyOn(Array.prototype, "join").mockImplementationOnce(() => {
      throw new RangeError("copy text too long\u001b[2J");
    });
    try {
      app.selector.onCopy("entry", "display");
    } finally {
      join.mockRestore();
    }
    app.selector.onCancel();
    await app.running;
    assert.deepEqual(app.copied, []);
    assert.deepEqual(app.notifications, [
      { message: "Could not copy selected message: copy text too long[2J", level: "error" },
    ]);
  } finally {
    await app.close();
  }
});

test("missing copy IDs do not read live entries, while absent IDs keep display fallback", async () => {
  const app = await openPicker([node(message("snapshot"))]);
  try {
    app.selector.onCopy("missing", "must not copy");
    app.selector.onCopy(undefined, "raw fallback\u001b[2J");
    app.selector.onCopy("", "empty ID fallback");
    app.selector.onCopy(undefined, undefined);
    app.selector.onCancel();
    await app.running;
    assert.deepEqual(app.copied, ["raw fallback\u001b[2J", "empty ID fallback"]);
    assert.equal(app.notifications.filter(({ message }) => message === "Selected entry has no text to copy").length, 2);
  } finally {
    await app.close();
  }
});

for (const saved of [
  {},
  { labelTimestamp: "time\u001b" },
  { label: "", labelTimestamp: "" },
  { label: "saved\u001b[2J", labelTimestamp: "time\u001b" },
]) {
  test(`failed label write restores sparse snapshot ${JSON.stringify(saved)}`, async () => {
    const raw = { ...node(message("text")), ...saved };
    const app = await openPicker([raw], {
      setLabel: () => {
        throw new Error("read only");
      },
    });
    try {
      app.selector.onLabelChange("entry", "unsaved");
      app.selector.onCancel();
      await app.running;
      assert.deepEqual(app.labels, [
        {
          entryId: "entry",
          label: saved.label?.replaceAll("\u001b", ""),
          timestamp: saved.labelTimestamp?.replaceAll("\u001b", ""),
        },
      ]);
      assert.ok(app.notifications.some(({ message }) => message === "Could not update tree label: read only"));
      assert.deepEqual(
        { ...raw, entry: undefined, children: undefined },
        { ...saved, entry: undefined, children: undefined },
      );
    } finally {
      await app.close();
    }
  });
}

test("label rollback follows successful updates and clearing instead of the initial snapshot", async () => {
  let fail = false;
  const writes: Array<string | undefined> = [];
  const raw = { ...node(message("text")), label: "initial", labelTimestamp: "initial time" };
  const app = await openPicker([raw], {
    setLabel: (_id, label) => {
      if (fail) throw new Error("read only");
      writes.push(label);
    },
  });
  try {
    app.selector.onLabelChange("entry", "updated\u001b[2J");
    fail = true;
    app.selector.onLabelChange("entry", "unsaved");
    fail = false;
    app.selector.onLabelChange("entry", undefined);
    fail = true;
    app.selector.onLabelChange("entry", "unsaved again");
    app.selector.onCancel();
    await app.running;
    assert.deepEqual(writes, ["updated[2J", undefined]);
    assert.deepEqual(
      app.labels.map(({ label, timestamp }) => [label, timestamp]),
      [
        ["updated[2J", undefined],
        ["updated[2J", undefined],
        [undefined, undefined],
        [undefined, undefined],
      ],
    );
    assert.equal(raw.label, "initial");
    assert.equal(raw.labelTimestamp, "initial time");
  } finally {
    await app.close();
  }
});

test("a missing entry restores its sparse label without attempting persistence", async () => {
  let writes = 0;
  const app = await openPicker([node(message("text"))], {
    entryExists: false,
    setLabel: () => {
      writes++;
    },
  });
  try {
    app.selector.onLabelChange("entry", "unsaved");
    app.selector.onCancel();
    await app.running;
    assert.equal(writes, 0);
    assert.deepEqual(app.labels, [{ entryId: "entry", label: undefined, timestamp: undefined }]);
    assert.ok(
      app.notifications.some(({ message }) => message === "The selected main-thread entry is no longer available"),
    );
  } finally {
    await app.close();
  }
});

for (const boundary of ["cancel", "dispose", "replacement", "shutdown"] as const) {
  test(`${boundary} aborts pending copy and rejects stale copy callbacks`, async () => {
    const owner = new AbortController();
    let calls = 0;
    let aborted = false;
    const app = await openPicker([node(message([text("raw "), text("text")]))], {
      signal: owner.signal,
      copy: async (_value, signal) => {
        calls++;
        await new Promise<void>((_resolve, reject) =>
          signal.addEventListener(
            "abort",
            () => {
              aborted = true;
              reject(signal.reason);
            },
            { once: true },
          ),
        );
      },
    });
    try {
      app.selector.onCopy("entry", "display");
      if (boundary === "cancel") app.selector.onCancel();
      else if (boundary === "dispose") app.tui.dispose();
      else owner.abort(new Error(boundary));
      await app.running;
      app.selector.onCopy("entry", "stale display");
      assert.equal(calls, 1);
      assert.equal(aborted, true);
      assert.deepEqual(app.notifications, []);
      assert.equal(app.editorText, "main draft");
    } finally {
      await app.close();
    }
  });
}
