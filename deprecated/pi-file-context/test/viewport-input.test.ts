import assert from "node:assert/strict";
import {
  CURSOR_MARKER,
  getKeybindings,
  type KeybindingsConfig,
  KeybindingsManager,
  setKeybindings,
  TUI_KEYBINDINGS,
  TuiAltScreen,
  TuiMainScreen,
} from "@earendil-works/pi-tui";
import { FullscreenTerminal } from "@narumitw/pi-tui-kit/testing";
import { test } from "vitest";
import { FileQuoteExplorer, type FileQuoteExplorerResult } from "../src/file-context-explorer.js";

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

function nativeExplorer(fullscreen: boolean, config: KeybindingsConfig = {}) {
  const previous = getKeybindings();
  const keys = new KeybindingsManager(TUI_KEYBINDINGS, config);
  setKeybindings(keys);
  const terminal = new FullscreenTerminal();
  terminal.rows = 16;
  const host = fullscreen ? new TuiAltScreen(terminal, false) : new TuiMainScreen(terminal, false);
  const opened: string[] = [];
  let result: FileQuoteExplorerResult | undefined;
  const explorer = new FileQuoteExplorer({
    tui: host,
    theme: {
      fg: (_role: string, text: string) => text,
      bg: (_role: string, text: string) => text,
      bold: (text: string) => text,
    } as never,
    keybindings: keys as never,
    files: Array.from({ length: 24 }, (_, index) => `file-${String(index).padStart(2, "0")}.ts`),
    loadFile: async (path) => {
      opened.push(path);
      return { path, lines: Array.from({ length: 60 }, (_, index) => `needle ${index}`) };
    },
    gitContext: {
      project: { repositoryRoot: "/repo", projectPrefix: "", branch: "main", head: "a".repeat(40), dirty: true },
      statuses: new Map(),
      async getFileContext() {
        return {
          hunks: [
            {
              header: "@@ -1,60 +1,60 @@",
              oldStart: 1,
              oldCount: 60,
              newStart: 1,
              newCount: 60,
              changedLines: [1],
              lines: Array.from({ length: 60 }, (_, index) => `+diff ${index}`),
            },
          ],
        };
      },
      async getHistory() {
        return ["first", "second"].map((summary, index) => ({
          commit: String(index).repeat(40),
          path: "file-00.ts",
          author: "Author",
          authorTime: 1,
          summary,
        }));
      },
    } as never,
    rootNavigation: true,
    done: (value) => {
      result = value;
    },
  });
  host.addChild(explorer);
  host.setFocus(explorer);
  host.start();
  host.renderNow(true);
  return {
    explorer,
    terminal,
    host,
    opened,
    result: () => result,
    dispose() {
      explorer.dispose();
      host.stop({ preserveScreen: true });
      setKeybindings(previous);
    },
  };
}

for (const fullscreen of [false, true]) {
  test(`native ${fullscreen ? "fullscreen" : "regular"} file and preview paging retains exact quote selection`, async () => {
    const f = nativeExplorer(fullscreen);
    try {
      assert.equal(f.explorer.capturesViewportInput, true);
      f.terminal.input("\u001b[6~");
      f.terminal.input("\r");
      await flush();
      assert.deepEqual(f.opened, ["file-10.ts"]);
      assert.equal(f.explorer.capturesViewportInput, true);
      f.terminal.input("\u001b[6~");
      f.terminal.input("\r");
      const result = f.result();
      assert.equal(result?.kind, "quote");
      if (result?.kind === "quote") {
        assert.equal(result.quote.startLine, 11);
        assert.equal(result.quote.text, "needle 10");
      }
    } finally {
      f.dispose();
    }
  });

  test(`native ${fullscreen ? "fullscreen" : "regular"} content-search and diff paging remain local`, async () => {
    const f = nativeExplorer(fullscreen, { "tui.altScreen.search": "ctrl+q" });
    try {
      f.terminal.input("\u0006");
      assert.equal(f.explorer.capturesViewportInput, true);
      f.terminal.input("\u001b[200~needle\u001b[201~");
      await flush();
      assert.ok(f.explorer.render(80).join("\n").includes(CURSOR_MARKER));
      f.terminal.input("\u001b[6~");
      f.terminal.input("\r");
      await flush();
      assert.match(f.explorer.render(80).join("\n"), /needle 10/u);
      f.terminal.input("d");
      assert.equal(f.explorer.capturesViewportInput, true);
      f.terminal.input("\u001b[6~");
      assert.match(f.explorer.render(80).join("\n"), /rows 11-/u);
      f.terminal.input("\u001b[5~");
      assert.match(f.explorer.render(80).join("\n"), /rows 1-/u);
    } finally {
      f.dispose();
    }
  });
}

test("fullscreen capture follows navigation modes but excludes revision Input and static help", async () => {
  const f = nativeExplorer(true, { "tui.select.down": "pageDown" });
  const delivered: string[] = [];
  const unsubscribe = f.host.addInputListener((data) => {
    delivered.push(data);
  });
  try {
    f.terminal.input("\r");
    await flush();
    f.terminal.input("?");
    assert.equal(f.explorer.capturesViewportInput, false);
    f.terminal.input("\u001b[6~");
    assert.notEqual(delivered.at(-1), "\u001b[6~");
    f.terminal.input("\u001b");
    assert.equal(f.explorer.capturesViewportInput, true);
    f.terminal.input("h");
    await flush();
    assert.equal(f.explorer.capturesViewportInput, true);
    f.terminal.input("\u001b[6~");
    assert.match(f.explorer.render(80).join("\n"), /> .*second/u);
    f.terminal.input("\u001b");
    f.terminal.input("r");
    assert.equal(f.explorer.capturesViewportInput, false);
    f.terminal.input("\u001b[6~");
    assert.notEqual(delivered.at(-1), "\u001b[6~");
    f.terminal.input("\u001b[200~HEAD~1\u001b[201~");
    const revision = f.explorer.render(80).join("\n");
    assert.match(revision, /Revision: .*HEAD~1/u);
    assert.ok(revision.includes(CURSOR_MARKER));
    f.terminal.input("\u001b");
    assert.equal(f.explorer.capturesViewportInput, true);
    f.terminal.input("\u0003");
    assert.deepEqual(f.result(), { kind: "close" });
  } finally {
    unsubscribe();
    f.dispose();
  }
});
