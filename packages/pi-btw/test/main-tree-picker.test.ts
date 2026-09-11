import assert from "node:assert/strict";
import { type ExtensionCommandContext, initTheme, type SessionTreeNode } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { test } from "vitest";
import { createCustomSelectorHarness, createMockContext } from "../../../test/support.js";
import { type MainThreadTreeSelectorOptions, pickMainEntry } from "../src/main-tree-picker.js";

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
      const harness = createCustomSelectorHarness(factory);
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
      const harness = createCustomSelectorHarness(factory);
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
        const harness = createCustomSelectorHarness(factory);
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
      const harness = createCustomSelectorHarness(factory);
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
      const harness = createCustomSelectorHarness(factory);
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
      const harness = createCustomSelectorHarness(factory);
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
      const harness = createCustomSelectorHarness(factory, 28);
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
      const harness = createCustomSelectorHarness(factory);
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
