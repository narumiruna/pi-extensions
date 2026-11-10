import assert from "node:assert/strict";
import { type ExtensionCommandContext, initTheme, type SessionTreeNode } from "@earendil-works/pi-coding-agent";
import { type Component, visibleWidth } from "@earendil-works/pi-tui";
import { test } from "vitest";
import { createCustomSelectorHarness, createMockContext } from "../../../test/support.js";
import { type MainThreadTreeSelectorOptions, pickMainEntry } from "../src/main-tree-picker.js";

// Kit accepts asynchronous custom factories; keep the package-local adapter
// asynchronous without changing the repository's synchronous selector harness.
async function createTreeHarness(factory: unknown, width = 80) {
  type TreeComponent = Component & { focused?: boolean; dispose?(): void; waitForPending?(): Promise<void> };
  let pending: Promise<TreeComponent> | undefined;
  let component: TreeComponent | undefined;
  const harness = createCustomSelectorHarness((...args: never[]) => {
    pending = Promise.resolve((factory as (...args: never[]) => TreeComponent | Promise<TreeComponent>)(...args));
    return {
      render: (columns: number) => component?.render(columns) ?? [],
      handleInput: (data: string) => component?.handleInput?.(data),
      invalidate: () => component?.invalidate(),
      dispose: () => component?.dispose?.(),
      waitForPending: () => component?.waitForPending?.() ?? Promise.resolve(),
      get focused() {
        return component?.focused ?? false;
      },
      set focused(value: boolean) {
        if (component) component.focused = value;
      },
    };
  }, width);
  component = await pending;
  return harness;
}

function userNode(id: string, parentId: string | null, text: string): SessionTreeNode {
  return {
    entry: {
      type: "message",
      id,
      parentId,
      timestamp: "2026-01-01T00:00:00.000Z",
      message: { role: "user", content: text, timestamp: 1 },
    },
    children: [],
  };
}

function linearTree(size: number): SessionTreeNode[] {
  const nodes = Array.from({ length: size }, (_, index) =>
    userNode(`entry-${index}`, index === 0 ? null : `entry-${index - 1}`, `message ${index}\u001b[2J`),
  );
  for (let index = 1; index < nodes.length; index++) {
    nodes[index - 1].children.push(nodes[index]);
  }
  return nodes;
}

function createFakeSelector(onCreate: (options: MainThreadTreeSelectorOptions) => void): (
  options: MainThreadTreeSelectorOptions,
) => {
  focused: boolean;
  render(width: number): string[];
  handleInput(data: string): void;
  invalidate(): void;
} {
  return (options) => {
    onCreate(options);
    return {
      focused: false,
      render: (width) => ["tree".slice(0, width)],
      handleInput(data) {
        if (data === "select") options.onSelect("branch-entry");
        if (data === "escape") options.onCancel();
        if (data === "copy") options.onCopy("branch-entry", "copied text");
        if (data === "copy-empty") options.onCopy("branch-entry", undefined);
        if (data === "label") options.onLabelChange("branch-entry", "check\u001b[2Jpoint");
      },
      invalidate() {},
    };
  };
}

test("main-thread tree picker passes the session snapshot and current leaf to the selector", async () => {
  const root = userNode("root", null, "root");
  const branch = userNode("branch-entry", "root", "branch");
  root.children.push(branch);
  let captured: MainThreadTreeSelectorOptions | undefined;
  const mock = createMockContext({
    mode: "tui",
    hasUI: true,
    editorText: "main draft",
    sessionManager: {
      getTree: () => [root],
      getLeafId: () => "active-leaf",
      getEntry: (id: string) => (id === "branch-entry" ? branch.entry : undefined),
    },
    custom: async (factory: unknown) => {
      const harness = await createTreeHarness(factory);
      (mock.ctx as ExtensionCommandContext).ui.setEditorText("newer main draft");
      harness.handleInput("select");
      return harness.resultPromise;
    },
  });

  const result = await pickMainEntry({ setLabel() {} } as never, mock.ctx, {
    createSelector: createFakeSelector((options) => {
      captured = options;
    }),
  });

  assert.deepEqual(result, { kind: "selected", entryId: "branch-entry" });
  assert.deepEqual(captured?.tree, [root]);
  assert.equal(captured?.currentLeafId, "active-leaf");
  assert.equal(mock.editorText, "newer main draft");
});

test("deep tree preprocessing preserves snapshots, ordering, raw copying, and saved labels", async () => {
  const nodes = linearTree(10_000);
  const leaf = nodes[nodes.length - 1];
  leaf.label = "saved\u001b[2J";
  leaf.labelTimestamp = "2026-01-01T00:00:00.000Z\u001b";
  const sibling = userNode("sibling", nodes[0].entry.id, "sibling\u001b[2J");
  const otherRoot = userNode("other-root", null, "other root");
  nodes[0].children.push(sibling);
  const rawTree = [nodes[0], otherRoot];
  let captured: MainThreadTreeSelectorOptions | undefined;
  const copied: string[] = [];
  const restored: Array<{ entryId: string; label: string | undefined; timestamp: string | undefined }> = [];
  const mock = createMockContext({
    mode: "tui",
    editorText: "main draft",
    sessionManager: {
      getTree: () => rawTree,
      getLeafId: () => leaf.entry.id,
      getEntry: (id: string) => (id === leaf.entry.id ? leaf.entry : undefined),
    },
    custom: async (factory: unknown) => {
      const harness = await createTreeHarness(factory);
      try {
        harness.handleInput("copy");
        harness.handleInput("label");
        harness.handleInput("escape");
        return await harness.resultPromise;
      } finally {
        harness.dispose();
      }
    },
  });

  const result = await pickMainEntry(
    {
      setLabel() {
        throw new Error("read only");
      },
    } as never,
    mock.ctx,
    {
      createSelector: (options) => {
        captured = options;
        return {
          focused: false,
          render: () => ["tree"],
          invalidate() {},
          handleInput(data) {
            if (data === "copy") {
              for (const entryId of [leaf.entry.id, sibling.entry.id, otherRoot.entry.id]) {
                options.onCopy(entryId, "display text");
              }
            }
            if (data === "label") options.onLabelChange(leaf.entry.id, "unsaved");
            if (data === "escape") options.onCancel();
          },
          setViewLabel(entryId, label, timestamp) {
            restored.push({ entryId, label, timestamp });
          },
        };
      },
      copyToClipboard: async (text) => {
        copied.push(text);
      },
    },
  );

  assert.deepEqual(result, { kind: "back" });
  assert.ok(captured, "preprocessing must reach the UI boundary");
  assert.equal(captured.currentLeafId, leaf.entry.id);
  assert.deepEqual(
    captured.tree.map((node) => node.entry.id),
    [nodes[0].entry.id, otherRoot.entry.id],
  );
  assert.deepEqual(
    captured.tree[0].children.map((node) => node.entry.id),
    [nodes[1].entry.id, sibling.entry.id],
  );
  let displayed = captured.tree[0];
  for (const [index, raw] of nodes.entries()) {
    assert.notEqual(displayed, raw);
    assert.notEqual(displayed.entry, raw.entry);
    assert.notEqual(displayed.children, raw.children);
    assert.equal(displayed.entry.id, raw.entry.id);
    assert.equal(displayed.entry.parentId, raw.entry.parentId);
    if (
      displayed.entry.type !== "message" ||
      displayed.entry.message.role !== "user" ||
      raw.entry.type !== "message" ||
      raw.entry.message.role !== "user"
    ) {
      throw new Error("Expected user message entries");
    }
    assert.equal(displayed.entry.message.content, `message ${index}[2J`);
    assert.equal(raw.entry.message.content, `message ${index}\u001b[2J`);
    assert.equal(displayed.label, index === nodes.length - 1 ? "saved[2J" : undefined);
    assert.equal(displayed.labelTimestamp, index === nodes.length - 1 ? "2026-01-01T00:00:00.000Z" : undefined);
    assert.equal(displayed.children.length, index === 0 ? 2 : index === nodes.length - 1 ? 0 : 1);
    if (index < nodes.length - 1) displayed = displayed.children[0];
  }
  assert.deepEqual(copied, ["message 9999\u001b[2J", "sibling\u001b[2J", "other root"]);
  assert.deepEqual(restored, [{ entryId: leaf.entry.id, label: "saved[2J", timestamp: "2026-01-01T00:00:00.000Z" }]);
  assert.equal(leaf.label, "saved\u001b[2J");
  assert.equal(leaf.labelTimestamp, "2026-01-01T00:00:00.000Z\u001b");
  assert.equal(mock.editorText, "main draft");
  assert.ok(mock.notifications.some(({ message }) => message === "Could not update tree label: read only"));
});

test("native tree selector renders and cancels a deep linear tree", async () => {
  initTheme("dark", false);
  const nodes = linearTree(10_000);
  const leafId = nodes[nodes.length - 1].entry.id;
  for (const [input, kind] of [
    ["\u001b", "back"],
    ["\u0003", "closed"],
  ] as const) {
    let wide: string[] | undefined;
    let narrow: string[] | undefined;
    const mock = createMockContext({
      mode: "tui",
      sessionManager: { getTree: () => [nodes[0]], getLeafId: () => leafId },
      custom: async (factory: unknown) => {
        const harness = await createTreeHarness(factory);
        try {
          wide = harness.render(80);
          narrow = harness.render(28);
          harness.handleInput(input);
          return await harness.resultPromise;
        } finally {
          harness.dispose();
        }
      },
    });

    assert.deepEqual(await pickMainEntry({ setLabel() {} } as never, mock.ctx), { kind });
    assert.ok(wide?.some((line) => line.includes("message 9999[2J")));
    assert.ok(wide?.every((line) => visibleWidth(line) <= 80));
    assert.ok(narrow?.every((line) => visibleWidth(line) <= 28));
    assert.deepEqual(mock.notifications, []);
  }
});

test("tree display strips terminal controls while copy keeps the raw selected text", async () => {
  const rawText = "safe\u001b]52;c;ZXZpbA==\u0007\u009b31mtext";
  const root = userNode("root", null, rawText);
  root.label = "label\u001b[2J";
  root.children.push(
    {
      entry: {
        type: "message",
        id: "assistant",
        parentId: "root",
        timestamp: "2026-01-01T00:00:01.000Z",
        message: {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: "call-1",
              name: "read\u001b[31m",
              arguments: { path: "src/unsafe\u009b2J.ts" },
            },
          ],
        },
      },
      children: [],
    } as unknown as SessionTreeNode,
    {
      entry: {
        type: "usage",
        id: "usage",
        parentId: "root",
        timestamp: "2026-01-01T00:00:02.000Z",
        kind: "cache_warm\u001b[31m",
        provider: "unsafe\u001b]0;title\u0007",
        model: "model\u009b2J",
        note: "warm\u001b[2J",
        usage: {
          input: 1,
          output: 0,
          cacheRead: 1,
          cacheWrite: 0,
          totalTokens: 2,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
      },
      children: [],
    } as unknown as SessionTreeNode,
    {
      entry: {
        type: "model_change",
        id: "model",
        parentId: "root",
        timestamp: "2026-01-01T00:00:02.000Z",
        provider: "unsafe\u001b]0;title\u0007",
        modelId: "model\u009b2J",
      },
      children: [],
    },
  );
  let displayTree: SessionTreeNode[] | undefined;
  let copied: string | undefined;
  const mock = createMockContext({
    mode: "tui",
    hasUI: true,
    sessionManager: {
      getTree: () => [root],
      getLeafId: () => "root",
      getEntry: () => root.entry,
    },
    custom: async (factory: unknown) => {
      const harness = await createTreeHarness(factory);
      harness.handleInput("copy-raw");
      await new Promise<void>((resolve) => setImmediate(resolve));
      harness.handleInput("escape");
      return harness.resultPromise;
    },
  });

  await pickMainEntry({ setLabel() {} } as never, mock.ctx, {
    createSelector: (options) => {
      displayTree = options.tree;
      return {
        focused: false,
        render: () => ["tree"],
        handleInput(data) {
          if (data === "copy-raw") {
            (options.onCopy as (...args: unknown[]) => void)("root", "sanitized text");
          }
          if (data === "escape") options.onCancel();
        },
        invalidate() {},
      };
    },
    copyToClipboard: async (text) => {
      copied = text;
    },
  });

  const displayed = JSON.stringify(displayTree);
  assert.equal(hasTerminalControlInValue(displayTree), false);
  assert.match(displayed, /safe.*text/);
  assert.equal(copied, rawText);
  assert.equal((root.entry as { message: { content: string } }).message.content, rawText);
  assert.equal(root.label, "label\u001b[2J");
});

test("main-thread tree picker reports an empty tree without opening custom UI", async () => {
  let customCalls = 0;
  const mock = createMockContext({
    mode: "tui",
    hasUI: true,
    sessionManager: { getTree: () => [], getLeafId: () => null },
    custom: async () => {
      customCalls += 1;
    },
  });

  const result = await pickMainEntry({ setLabel() {} } as never, mock.ctx);

  assert.deepEqual(result, { kind: "back" });
  assert.equal(customCalls, 0);
  assert.deepEqual(mock.notifications, [{ message: "No main-thread entries are available", level: "warning" }]);
});

test("Escape returns to the menu while Ctrl+C closes the overall tree flow", async () => {
  const node = userNode("branch-entry", null, "branch");
  const run = async (input: string) => {
    const mock = createMockContext({
      mode: "tui",
      hasUI: true,
      sessionManager: {
        getTree: () => [node],
        getLeafId: () => "branch-entry",
        getEntry: () => node.entry,
      },
      custom: async (factory: unknown) => {
        const harness = await createTreeHarness(factory);
        harness.handleInput(input);
        return harness.resultPromise;
      },
    });
    return pickMainEntry({ setLabel() {} } as never, mock.ctx, {
      createSelector: createFakeSelector(() => {}),
    });
  };

  assert.deepEqual(await run("escape"), { kind: "back" });
  assert.deepEqual(await run("\u0003"), { kind: "closed" });
});

test("native copy success and failure are observable and terminal-safe", async () => {
  const node = userNode("branch-entry", null, "branch");
  const copied: string[] = [];
  const mock = createMockContext({
    mode: "tui",
    hasUI: true,
    sessionManager: {
      getTree: () => [node],
      getLeafId: () => "branch-entry",
      getEntry: () => node.entry,
    },
    custom: async (factory: unknown) => {
      const harness = await createTreeHarness(factory);
      harness.handleInput("copy");
      await new Promise<void>((resolve) => setImmediate(resolve));
      harness.handleInput("escape");
      return harness.resultPromise;
    },
  });
  const createSelector = createFakeSelector(() => {});

  await pickMainEntry({ setLabel() {} } as never, mock.ctx, {
    createSelector,
    copyToClipboard: async (text) => {
      copied.push(text);
    },
  });
  await pickMainEntry({ setLabel() {} } as never, mock.ctx, {
    createSelector,
    copyToClipboard: () => {
      throw new Error("clipboard failed\u001b]52;c;ZXZpbA==\u0007");
    },
  });

  assert.deepEqual(copied, ["branch"]);
  assert.ok(mock.notifications.some(({ message }) => message === "Copied selected message"));
  const failure = mock.notifications.find(({ level }) => level === "error")?.message ?? "";
  assert.match(failure, /Could not copy selected message: clipboard failed/);
  assert.equal(
    [...failure].some((character) => {
      const code = character.charCodeAt(0);
      return code <= 31 || (code >= 127 && code <= 159);
    }),
    false,
  );
});

test("failed label persistence restores the previously displayed label", async () => {
  const node = userNode("branch-entry", null, "branch");
  node.label = "saved";
  let displayedLabel: string | undefined = node.label;
  const mock = createMockContext({
    mode: "tui",
    hasUI: true,
    sessionManager: {
      getTree: () => [node],
      getLeafId: () => "branch-entry",
      getEntry: () => node.entry,
    },
    custom: async (factory: unknown) => {
      const harness = await createTreeHarness(factory);
      harness.handleInput("label");
      harness.handleInput("escape");
      return harness.resultPromise;
    },
  });

  await pickMainEntry(
    {
      setLabel() {
        throw new Error("read only");
      },
    } as never,
    mock.ctx,
    {
      createSelector: (options) => ({
        focused: false,
        render: () => [displayedLabel ?? ""],
        handleInput(data) {
          if (data === "label") {
            displayedLabel = "unsaved";
            options.onLabelChange("branch-entry", "unsaved");
          }
          if (data === "escape") options.onCancel();
        },
        invalidate() {},
        setViewLabel(_entryId, label) {
          displayedLabel = label;
        },
      }),
    },
  );

  assert.equal(displayedLabel, "saved");
  assert.ok(mock.notifications.some(({ message }) => /Could not update tree label/u.test(message)));
});

test("native label editing writes only after the selector's explicit callback", async () => {
  const node = userNode("branch-entry", null, "branch");
  const labels: Array<{ entryId: string; label: string | undefined }> = [];
  const mock = createMockContext({
    mode: "tui",
    hasUI: true,
    sessionManager: {
      getTree: () => [node],
      getLeafId: () => "branch-entry",
      getEntry: () => node.entry,
    },
    custom: async (factory: unknown) => {
      const harness = await createTreeHarness(factory);
      assert.deepEqual(labels, []);
      harness.handleInput("label");
      harness.handleInput("escape");
      return harness.resultPromise;
    },
  });

  await pickMainEntry(
    {
      setLabel: (entryId: string, label: string | undefined) => labels.push({ entryId, label }),
    } as never,
    mock.ctx,
    { createSelector: createFakeSelector(() => {}) },
  );

  assert.deepEqual(labels, [{ entryId: "branch-entry", label: "check[2Jpoint" }]);
});

test("native tree selector renders within narrow terminal widths", async () => {
  initTheme("dark", false);
  const root = userNode("root", null, "root with a very long untrusted-looking message");
  const mock = createMockContext({
    mode: "tui",
    hasUI: true,
    sessionManager: {
      getTree: () => [root],
      getLeafId: () => "root",
      getEntry: () => root.entry,
    },
    custom: async (factory: unknown) => {
      const harness = await createTreeHarness(factory, 28);
      const rendered = harness.render(28);
      assert.ok(rendered.every((line) => visibleWidth(line) <= 28));
      harness.handleInput("\u0003");
      return harness.resultPromise;
    },
  });

  assert.deepEqual(await pickMainEntry({ setLabel() {} } as never, mock.ctx), {
    kind: "closed",
  });
});

test("native tree selector opens with omitted and replaced context edits", async () => {
  for (const replacement of [null, { content: "replacement\u001b[2J" }]) {
    initTheme("dark", false);
    const root = userNode("root", null, "original");
    const edit: SessionTreeNode = {
      entry: {
        type: "context_edit",
        id: "edit",
        parentId: "root",
        timestamp: "2026-01-01T00:00:01.000Z",
        targetId: "root\u001b[2J",
        replacement,
      },
      children: [],
    };
    root.children.push(edit);
    let rendered: string[] | undefined;
    let renderedWide: string[] | undefined;
    const mock = createMockContext({
      mode: "tui",
      hasUI: true,
      sessionManager: {
        getTree: () => [root],
        getLeafId: () => "edit",
        getEntry: () => edit.entry,
      },
      custom: async (factory: unknown) => {
        const harness = await createTreeHarness(factory, 28);
        renderedWide = harness.render(80);
        rendered = harness.render(28);
        harness.handleInput("\u0003");
        return harness.resultPromise;
      },
    });

    assert.deepEqual(await pickMainEntry({ setLabel() {} } as never, mock.ctx), { kind: "closed" });
    assert.ok(renderedWide?.some((line) => line.includes("original")));
    assert.ok(rendered?.every((line) => visibleWidth(line) <= 28));
    assert.ok(renderedWide?.every((line) => visibleWidth(line) <= 80));
    if (edit.entry.type !== "context_edit") throw new Error("Expected a context edit entry");
    assert.equal(edit.entry.replacement, replacement);
  }
});

test("context edit target IDs are display-safe without changing raw entries", async () => {
  const root = userNode("root", null, "root");
  const rawTargetId = "root\u001b[2J";
  const replacement = { content: "raw\u001b]0;title\u0007" };
  const edit: SessionTreeNode = {
    entry: {
      type: "context_edit",
      id: "edit",
      parentId: "root",
      timestamp: "2026-01-01T00:00:01.000Z",
      targetId: rawTargetId,
      replacement,
    },
    children: [],
  };
  root.children.push(edit);
  let displayedEntry: SessionTreeNode["entry"] | undefined;
  const mock = createMockContext({
    mode: "tui",
    hasUI: true,
    sessionManager: {
      getTree: () => [root],
      getLeafId: () => "edit",
      getEntry: () => edit.entry,
    },
    custom: async (factory: unknown) => {
      const harness = await createTreeHarness(factory);
      harness.handleInput("escape");
      return harness.resultPromise;
    },
  });

  assert.deepEqual(
    await pickMainEntry({ setLabel() {} } as never, mock.ctx, {
      createSelector: createFakeSelector((options) => {
        displayedEntry = options.tree[0]?.children[0]?.entry;
      }),
    }),
    { kind: "back" },
  );
  assert.equal(displayedEntry?.type, "context_edit");
  if (displayedEntry?.type !== "context_edit" || edit.entry.type !== "context_edit") {
    throw new Error("Expected context edit entries");
  }
  assert.equal(displayedEntry.targetId, "root[2J");
  assert.equal(displayedEntry.replacement, replacement);
  assert.equal(edit.entry.targetId, rawTargetId);
});

test("disposing the tree picker aborts and drains the pending clipboard operation", async () => {
  const node = userNode("branch-entry", null, "branch");
  let copyAborted = false;
  const mock = createMockContext({
    mode: "tui",
    hasUI: true,
    sessionManager: {
      getTree: () => [node],
      getLeafId: () => "branch-entry",
      getEntry: () => node.entry,
    },
    custom: async (factory: unknown) => {
      const harness = await createTreeHarness(factory);
      harness.handleInput("copy");
      harness.dispose();
      return harness.resultPromise;
    },
  });

  const result = await pickMainEntry({ setLabel() {} } as never, mock.ctx, {
    createSelector: createFakeSelector(() => {}),
    copyToClipboard: async (_text, signal) =>
      new Promise<void>((_resolve, reject) => {
        if (!signal) {
          reject(new Error("missing abort signal"));
          return;
        }
        signal.addEventListener(
          "abort",
          () => {
            copyAborted = true;
            reject(signal.reason);
          },
          { once: true },
        );
      }),
  });

  assert.deepEqual(result, { kind: "closed" });
  assert.equal(copyAborted, true);
  assert.deepEqual(mock.notifications, []);
});

function hasTerminalControlInValue(value: unknown): boolean {
  if (typeof value === "string") {
    return [...value].some((character) => {
      const code = character.charCodeAt(0);
      return code <= 31 || (code >= 127 && code <= 159);
    });
  }
  if (Array.isArray(value)) return value.some(hasTerminalControlInValue);
  if (value !== null && typeof value === "object") {
    return Object.values(value).some(hasTerminalControlInValue);
  }
  return false;
}
