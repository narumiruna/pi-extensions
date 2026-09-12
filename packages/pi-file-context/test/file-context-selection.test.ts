import assert from "node:assert/strict";
import { visibleWidth } from "@earendil-works/pi-tui";
import { test } from "vitest";
import { FileQuoteExplorer } from "../src/file-context-explorer.js";

test("explorer keeps an over-limit selection editable instead of closing", async () => {
  let result: unknown = "pending";
  const explorer = new FileQuoteExplorer({
    tui: { terminal: { rows: 12 }, requestRender() {} } as never,
    theme: {
      fg: (_color: string, text: string) => text,
      bg: (_color: string, text: string) => text,
      bold: (text: string) => text,
    } as never,
    keybindings: {
      matches(data: string, key: string) {
        return data === "enter" && key === "tui.select.confirm";
      },
    } as never,
    files: ["large.txt"],
    loadFile: async () => ({ path: "large.txt", lines: ["large"] }),
    getSelectedContextState: () => ({
      count: 8,
      totalBytes: 100,
      maximumCount: 8,
      maximumBytes: 100_000,
    }),
    validateQuote: () => {
      throw new Error("File Context supports at most 8 pending quotes");
    },
    done: (value) => {
      result = value;
    },
  });

  explorer.handleInput("enter");
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.match(explorer.render(80).join("\n"), /Next prompt limit exceeded/u);
  explorer.handleInput("enter");
  assert.equal(result, "pending");
  assert.match(explorer.render(80).join("\n"), /at most 8 pending quotes/u);
});

test("preview warns for per-snippet line and byte limits before adding", async () => {
  for (const lines of [Array.from({ length: 501 }, () => "x"), ["x".repeat(50_001)]]) {
    const explorer = new FileQuoteExplorer({
      tui: { terminal: { rows: 12 }, requestRender() {} } as never,
      theme: {
        fg: (_color: string, text: string) => text,
        bg: (_color: string, text: string) => text,
        bold: (text: string) => text,
      } as never,
      keybindings: {
        matches(data: string, key: string) {
          return (data === "enter" && key === "tui.select.confirm") || (data === "down" && key === "tui.select.down");
        },
      } as never,
      files: ["large.txt"],
      loadFile: async () => ({ path: "large.txt", lines }),
      getSelectedContextState: () => ({
        count: 0,
        totalBytes: 0,
        maximumCount: 8,
        maximumBytes: 100_000,
        maximumSnippetLines: 500,
        maximumSnippetBytes: 50_000,
      }),
      done() {},
    });

    explorer.handleInput("enter");
    await new Promise<void>((resolve) => setImmediate(resolve));
    if (lines.length > 1) {
      explorer.handleInput(" ");
      for (let index = 1; index < lines.length; index += 1) explorer.handleInput("down");
    }
    assert.match(explorer.render(80).join("\n"), /Snippet limit exceeded/u);
  }
});

test("diff attachment also stays open when aggregate validation fails", async () => {
  let result: unknown = "pending";
  const explorer = new FileQuoteExplorer({
    tui: { terminal: { rows: 12 }, requestRender() {} } as never,
    theme: {
      fg: (_color: string, text: string) => text,
      bg: (_color: string, text: string) => text,
      bold: (text: string) => text,
    } as never,
    keybindings: {
      matches(data: string, key: string) {
        return data === "enter" && key === "tui.select.confirm";
      },
    } as never,
    files: ["changed.ts"],
    loadFile: async () => ({ path: "changed.ts", lines: ["changed"] }),
    gitContext: {
      project: {
        repositoryRoot: "/repo",
        projectPrefix: "",
        branch: "main",
        head: "a".repeat(40),
        dirty: true,
      },
      statuses: new Map(),
      async getFileContext() {
        return {
          status: undefined,
          blob: undefined,
          hunks: [
            {
              header: "@@ -1 +1 @@",
              oldStart: 1,
              oldCount: 1,
              newStart: 1,
              newCount: 1,
              lines: ["@@ -1 +1 @@", "-old", "+changed"],
              changedLines: [1],
            },
          ],
        };
      },
    } as never,
    validateQuote: () => {
      throw new Error("Pending quotes exceed 100000 bytes");
    },
    done: (value) => {
      result = value;
    },
  });

  explorer.handleInput("enter");
  await new Promise<void>((resolve) => setImmediate(resolve));
  explorer.handleInput("d");
  explorer.handleInput("enter");
  assert.equal(result, "pending");
  assert.match(explorer.render(80).join("\n"), /exceed 100000 bytes/u);
});

test("explorer adds exact context and keeps browsing with visible capacity and adaptive help", async () => {
  let result: unknown = "pending";
  let selectedCount = 2;
  let selectedBytes = 100;
  const continued: unknown[] = [];
  const explorer = new FileQuoteExplorer({
    tui: { terminal: { rows: 16 }, requestRender() {} } as never,
    theme: {
      fg: (_color: string, text: string) => text,
      bg: (_color: string, text: string) => text,
      bold: (text: string) => text,
    } as never,
    keybindings: {
      matches(data: string, key: string) {
        return (data === "enter" && key === "tui.select.confirm") || (data === "down" && key === "tui.select.down");
      },
    } as never,
    files: ["src/context.ts"],
    loadFile: async () => ({ path: "src/context.ts", lines: ["one", "two"] }),
    getSelectedContextState: () => ({
      count: selectedCount,
      totalBytes: selectedBytes,
      maximumCount: 8,
      maximumBytes: 100_000,
    }),
    onAddAndContinue: (quote) => {
      continued.push(quote);
      selectedCount += 1;
      selectedBytes += Buffer.byteLength(quote.text, "utf8");
    },
    done: (value) => {
      result = value;
    },
  });

  explorer.handleInput("enter");
  explorer.handleInput("enter");
  await new Promise<void>((resolve) => setImmediate(resolve));
  explorer.handleInput(" ");
  explorer.handleInput("down");
  const wide = explorer.render(80).join("\n");
  assert.match(wide, /Next prompt: 3\/8 snippets/u);
  assert.match(wide, /Enter add & close/u);
  assert.match(wide, /A add & continue/u);
  const narrow = explorer.render(36);
  assert.ok(narrow.every((line) => visibleWidth(line) <= 36));
  assert.match(narrow.join("\n"), /Enter add/u);
  assert.match(narrow.join("\n"), /A keep browsing/u);
  assert.match(narrow.join("\n"), /\? actions/u);

  explorer.handleInput("?");
  const help = explorer.render(36);
  assert.ok(help.every((line) => visibleWidth(line) <= 36));
  assert.match(help.join("\n"), /Preview actions/u);
  assert.match(help.join("\n"), /Blame/u);
  assert.match(help.join("\n"), /Git diff/u);
  explorer.handleInput("\u001b");
  assert.match(explorer.render(80).join("\n"), /Enter add & close/u);

  explorer.handleInput("a");
  assert.deepEqual(continued, [
    {
      path: "src/context.ts",
      startLine: 1,
      endLine: 2,
      text: "one\ntwo",
    },
  ]);
  assert.equal(result, "pending");
  assert.ok(explorer.render(80).some((line) => line.includes("File Context · files")));

  explorer.handleInput("enter");
  await new Promise<void>((resolve) => setImmediate(resolve));
  explorer.handleInput("enter");
  assert.deepEqual(result, {
    kind: "quote",
    quote: { path: "src/context.ts", startLine: 1, endLine: 1, text: "one" },
  });
});

test("preview uses the effective external-editor binding and reloads edited content", async () => {
  let lines = ["one", "two", "three"];
  let editCount = 0;
  const explorer = new FileQuoteExplorer({
    tui: { terminal: { rows: 16 }, requestRender() {} } as never,
    theme: {
      fg: (_color: string, text: string) => text,
      bg: (_color: string, text: string) => text,
      bold: (text: string) => text,
    } as never,
    keybindings: {
      matches(data: string, key: string) {
        return (
          (data === "enter" && key === "tui.select.confirm") ||
          (data === "down" && key === "tui.select.down") ||
          (data === "alt-e" && key === "app.editor.external")
        );
      },
      getKeys(key: string) {
        return key === "app.editor.external" ? ["alt+e"] : [];
      },
    } as never,
    files: ["src/edit.ts"],
    loadFile: async () => ({ path: "src/edit.ts", lines }),
    editFile: async (path) => {
      assert.equal(path, "src/edit.ts");
      editCount += 1;
      lines = ["edited"];
    },
    done() {},
  });

  explorer.handleInput("enter");
  explorer.handleInput("enter");
  await new Promise<void>((resolve) => setImmediate(resolve));
  explorer.handleInput("down");
  explorer.handleInput(" ");
  explorer.handleInput("down");
  const preview = explorer.render(80).join("\n");
  assert.match(preview, /Alt\+E edit/u);
  assert.match(preview, /B blame · H history · R revision · D diff · \[\/\] hunk/u);
  assert.doesNotMatch(preview, /Ctrl\+G/u);
  const narrow = explorer.render(36);
  assert.ok(narrow.every((line) => visibleWidth(line) <= 36));
  assert.match(narrow.join("\n"), /Alt\+E edit/u);
  explorer.handleInput("ctrl-g");
  assert.equal(editCount, 0);
  explorer.handleInput("alt-e");
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(editCount, 1);
  assert.match(explorer.render(80).join("\n"), /> 1 │ edited/u);
});

test("preview invokes the default external-editor action and explains an unbound action", async () => {
  let edits = 0;
  const keybindings = {
    matches(data: string, key: string) {
      return (data === "enter" && key === "tui.select.confirm") || (data === "ctrl-g" && key === "app.editor.external");
    },
    getKeys(key: string) {
      return key === "app.editor.external" ? ["ctrl+g"] : [];
    },
  };
  const explorer = new FileQuoteExplorer({
    tui: { terminal: { rows: 16 }, requestRender() {} } as never,
    theme: {
      fg: (_color: string, text: string) => text,
      bg: (_color: string, text: string) => text,
      bold: (text: string) => text,
    } as never,
    keybindings: keybindings as never,
    files: ["edit.ts"],
    loadFile: async () => ({ path: "edit.ts", lines: ["one"] }),
    editFile: async () => {
      edits += 1;
    },
    done() {},
  });

  explorer.handleInput("enter");
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.match(explorer.render(80).join("\n"), /Ctrl\+G edit/u);
  explorer.handleInput("ctrl-g");
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(edits, 1);

  const unbound = new FileQuoteExplorer({
    tui: { terminal: { rows: 16 }, requestRender() {} } as never,
    theme: {
      fg: (_color: string, text: string) => text,
      bg: (_color: string, text: string) => text,
      bold: (text: string) => text,
    } as never,
    keybindings: {
      matches(data: string, key: string) {
        return data === "enter" && key === "tui.select.confirm";
      },
      getKeys() {
        return [];
      },
    } as never,
    files: ["edit.ts"],
    loadFile: async () => ({ path: "edit.ts", lines: ["one"] }),
    editFile: async () => {},
    done() {},
  });
  unbound.handleInput("enter");
  await new Promise<void>((resolve) => setImmediate(resolve));
  unbound.handleInput("?");
  assert.match(unbound.render(80).join("\n"), /External editor action is unbound/u);
});

test("configured external-editor action takes priority over preview-owned shortcuts", async () => {
  let edits = 0;
  let historyLoads = 0;
  const explorer = new FileQuoteExplorer({
    tui: { terminal: { rows: 16 }, requestRender() {} } as never,
    theme: {
      fg: (_color: string, text: string) => text,
      bg: (_color: string, text: string) => text,
      bold: (text: string) => text,
    } as never,
    keybindings: {
      matches(data: string, key: string) {
        return (data === "enter" && key === "tui.select.confirm") || (data === "h" && key === "app.editor.external");
      },
      getKeys(key: string) {
        return key === "app.editor.external" ? ["h"] : [];
      },
    } as never,
    files: ["src/edit.ts"],
    loadFile: async () => ({ path: "src/edit.ts", lines: ["one"] }),
    editFile: async () => {
      edits += 1;
    },
    gitContext: {
      async getFileContext() {
        return { status: undefined, blob: undefined, hunks: [] };
      },
      async getHistory() {
        historyLoads += 1;
        return [];
      },
    } as never,
    done() {},
  });

  explorer.handleInput("enter");
  explorer.handleInput("enter");
  await new Promise<void>((resolve) => setImmediate(resolve));
  explorer.handleInput("h");
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(edits, 1);
  assert.equal(historyLoads, 0);
});

for (const reloadError of [
  "Cannot open src/edit.ts: file was deleted",
  "src/edit.ts appears to be binary",
  "src/edit.ts exceeds 1000000 bytes",
]) {
  test(`preview keeps reload failure visible after external editing: ${reloadError}`, async () => {
    let loads = 0;
    const explorer = new FileQuoteExplorer({
      tui: { terminal: { rows: 16 }, requestRender() {} } as never,
      theme: {
        fg: (_color: string, text: string) => text,
        bg: (_color: string, text: string) => text,
        bold: (text: string) => text,
      } as never,
      keybindings: {
        matches(data: string, key: string) {
          return (
            (data === "enter" && key === "tui.select.confirm") || (data === "edit" && key === "app.editor.external")
          );
        },
        getKeys(key: string) {
          return key === "app.editor.external" ? ["ctrl+g"] : [];
        },
      } as never,
      files: ["src/edit.ts"],
      loadFile: async () => {
        loads += 1;
        if (loads > 1) throw new Error(reloadError);
        return { path: "src/edit.ts", lines: ["original"] };
      },
      editFile: async () => {},
      done() {},
    });

    explorer.handleInput("enter");
    explorer.handleInput("enter");
    await new Promise<void>((resolve) => setImmediate(resolve));
    explorer.handleInput("edit");
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.match(explorer.render(100).join("\n"), new RegExp(reloadError, "u"));
  });
}

test("disposing a preview aborts external editing and rejects its stale continuation", async () => {
  let resolveEdit: (() => void) | undefined;
  let editSignal: AbortSignal | undefined;
  let loads = 0;
  let result: unknown = "pending";
  const explorer = new FileQuoteExplorer({
    tui: { terminal: { rows: 16 }, requestRender() {} } as never,
    theme: {
      fg: (_color: string, text: string) => text,
      bg: (_color: string, text: string) => text,
      bold: (text: string) => text,
    } as never,
    keybindings: {
      matches(data: string, key: string) {
        return (data === "enter" && key === "tui.select.confirm") || (data === "edit" && key === "app.editor.external");
      },
      getKeys() {
        return ["ctrl+g"];
      },
    } as never,
    files: ["src/edit.ts"],
    loadFile: async () => {
      loads += 1;
      return { path: "src/edit.ts", lines: ["original"] };
    },
    editFile: (_path, signal) => {
      editSignal = signal;
      return new Promise<void>((resolve) => {
        resolveEdit = resolve;
      });
    },
    done(value) {
      result = value;
    },
  });

  explorer.handleInput("enter");
  explorer.handleInput("enter");
  await new Promise<void>((resolve) => setImmediate(resolve));
  explorer.handleInput("edit");
  explorer.dispose();
  assert.equal(editSignal?.aborted, true);
  resolveEdit?.();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(loads, 1);
  assert.equal(result, undefined);
});

test("historical revision previews remain read-only", async () => {
  let edits = 0;
  const explorer = new FileQuoteExplorer({
    tui: { terminal: { rows: 16 }, requestRender() {} } as never,
    theme: {
      fg: (_color: string, text: string) => text,
      bg: (_color: string, text: string) => text,
      bold: (text: string) => text,
    } as never,
    keybindings: {
      matches(data: string, key: string) {
        return (data === "enter" && key === "tui.select.confirm") || (data === "edit" && key === "app.editor.external");
      },
      getKeys(key: string) {
        return key === "app.editor.external" ? ["ctrl+g"] : [];
      },
    } as never,
    files: ["src/edit.ts"],
    loadFile: async () => ({ path: "src/edit.ts", lines: ["worktree"] }),
    editFile: async () => {
      edits += 1;
    },
    gitContext: {
      project: {
        repositoryRoot: "/repo",
        projectPrefix: "",
        branch: "main",
        head: "a".repeat(40),
        dirty: false,
      },
      statuses: new Map(),
      async getFileContext() {
        return { status: undefined, blob: undefined, hunks: [] };
      },
      async loadRevision() {
        return {
          path: "src/edit.ts",
          lines: ["historical"],
          revision: "HEAD~1",
          commit: "b".repeat(40),
          blob: "c".repeat(40),
        };
      },
    } as never,
    done() {},
  });

  explorer.handleInput("enter");
  explorer.handleInput("enter");
  await new Promise<void>((resolve) => setImmediate(resolve));
  explorer.handleInput("r");
  explorer.handleInput("enter");
  await new Promise<void>((resolve) => setImmediate(resolve));
  explorer.handleInput("?");
  assert.match(explorer.render(100).join("\n"), /Historical revisions are read-only/u);
  explorer.handleInput("\u001b");
  explorer.handleInput("edit");
  assert.equal(edits, 0);
  assert.match(explorer.render(100).join("\n"), /Historical revisions are read-only/u);
});

test("short narrow previews keep primary add controls visible", async () => {
  const explorer = new FileQuoteExplorer({
    tui: { terminal: { rows: 8 }, requestRender() {} } as never,
    theme: {
      fg: (_color: string, text: string) => text,
      bg: (_color: string, text: string) => text,
      bold: (text: string) => text,
    } as never,
    keybindings: {
      matches(data: string, key: string) {
        return data === "enter" && key === "tui.select.confirm";
      },
      getKeys(key: string) {
        return key === "app.editor.external" ? ["ctrl+g"] : [];
      },
    } as never,
    files: ["short.ts"],
    loadFile: async () => ({ path: "short.ts", lines: ["short"] }),
    editFile: async () => {},
    onAddAndContinue() {},
    done() {},
  });

  explorer.handleInput("enter");
  await new Promise<void>((resolve) => setImmediate(resolve));
  const preview = explorer.render(36);
  assert.ok(preview.every((line) => visibleWidth(line) <= 36));
  assert.match(preview.join("\n"), /Enter add/u);
  assert.match(preview.join("\n"), /A keep browsing/u);
  assert.match(preview.join("\n"), /Ctrl\+G edit/u);
  assert.match(preview.join("\n"), /\? actions/u);
});

test("compact preview help keeps every advanced action visible on short terminals", async () => {
  const explorer = new FileQuoteExplorer({
    tui: { terminal: { rows: 8 }, requestRender() {} } as never,
    theme: {
      fg: (_color: string, text: string) => text,
      bg: (_color: string, text: string) => text,
      bold: (text: string) => text,
    } as never,
    keybindings: {
      matches(data: string, key: string) {
        return data === "enter" && key === "tui.select.confirm";
      },
    } as never,
    files: ["short.ts"],
    loadFile: async () => ({ path: "short.ts", lines: ["short"] }),
    done() {},
  });

  explorer.handleInput("enter");
  await new Promise<void>((resolve) => setImmediate(resolve));
  explorer.handleInput("?");
  const help = explorer.render(36);
  assert.ok(help.every((line) => visibleWidth(line) <= 36));
  assert.match(help.join("\n"), /B blame/u);
  assert.match(help.join("\n"), /H history/u);
  assert.match(help.join("\n"), /R revision/u);
  assert.match(help.join("\n"), /D Git diff/u);
});

test("preview help cancels stale history loading before returning to preview", async () => {
  let resolveHistory: ((entries: []) => void) | undefined;
  let historySignal: AbortSignal | undefined;
  const explorer = new FileQuoteExplorer({
    tui: { terminal: { rows: 12 }, requestRender() {} } as never,
    theme: {
      fg: (_color: string, text: string) => text,
      bg: (_color: string, text: string) => text,
      bold: (text: string) => text,
    } as never,
    keybindings: {
      matches(data: string, key: string) {
        return data === "enter" && key === "tui.select.confirm";
      },
    } as never,
    files: ["history.ts"],
    loadFile: async () => ({ path: "history.ts", lines: ["history"] }),
    gitContext: {
      project: {
        repositoryRoot: "/repo",
        projectPrefix: "",
        branch: "main",
        head: "a".repeat(40),
        dirty: false,
      },
      statuses: new Map(),
      async getFileContext() {
        return { status: undefined, blob: undefined, hunks: [] };
      },
      async getHistory(_path: string, signal: AbortSignal) {
        historySignal = signal;
        return new Promise<[]>((resolve) => {
          resolveHistory = resolve;
        });
      },
    } as never,
    done() {},
  });

  explorer.handleInput("enter");
  await new Promise<void>((resolve) => setImmediate(resolve));
  explorer.handleInput("h");
  explorer.handleInput("?");
  assert.equal(historySignal?.aborted, true);
  explorer.handleInput("\u001b");
  resolveHistory?.([]);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.ok(explorer.render(80).some((line) => line.includes("history.ts")));
  assert.ok(explorer.render(80).every((line) => !line.includes("File history")));
});
