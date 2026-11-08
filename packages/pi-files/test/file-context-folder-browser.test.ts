import assert from "node:assert/strict";
import { visibleWidth } from "@earendil-works/pi-tui";
import { test } from "vitest";
import { ProjectFileBrowser, parentProjectDirectory } from "../src/file-browser.js";
import { FileQuoteExplorer } from "../src/file-context-explorer.js";

const files = ["README.md", "src/main.ts", "src/nested/value.ts", "test/main.test.ts"];

function createExplorer(
  cancelInput = "q",
  loadFile: (path: string, signal?: AbortSignal) => Promise<{ path: string; lines: string[] }> = async (path) => ({
    path,
    lines: [path],
  }),
) {
  let result: unknown = "pending";
  const explorer = new FileQuoteExplorer({
    tui: { terminal: { rows: 14 }, requestRender() {} } as never,
    theme: {
      fg: (_color: string, text: string) => text,
      bg: (_color: string, text: string) => text,
      bold: (text: string) => text,
    } as never,
    keybindings: {
      matches(data: string, binding: string) {
        return (
          (data === "k" && binding === "tui.select.up") ||
          (data === "j" && binding === "tui.select.down") ||
          (data === "o" && binding === "tui.select.confirm") ||
          (data === cancelInput && binding === "tui.select.cancel") ||
          (data === "t" && binding === "tui.input.tab")
        );
      },
      getKeys(binding: string) {
        return (
          {
            "tui.select.up": ["k"],
            "tui.select.down": ["j"],
            "tui.select.confirm": ["o"],
            "tui.select.cancel": ["q"],
            "tui.input.tab": ["t"],
          }[binding] ?? []
        );
      },
    } as never,
    files,
    loadFile,
    rootNavigation: true,
    done: (value) => {
      result = value;
    },
  });
  return { explorer, getResult: () => result };
}

test("derives safe immediate folder entries while preserving raw file paths", () => {
  const unsafePath = "src/unsafe\u001b[31m.ts";
  const browser = new ProjectFileBrowser([...files, unsafePath]);
  assert.deepEqual(browser.list(""), [
    { kind: "directory", path: "src", label: "src" },
    { kind: "directory", path: "test", label: "test" },
    { kind: "file", path: "README.md", label: "README.md" },
  ]);
  assert.deepEqual(browser.list("src"), [
    { kind: "directory", path: "src/nested", label: "nested" },
    { kind: "file", path: "src/main.ts", label: "main.ts" },
    { kind: "file", path: unsafePath, label: "unsafe\\x1b[31m.ts" },
  ]);
  assert.deepEqual(browser.searchResults([unsafePath]), [
    { kind: "file", path: unsafePath, label: "src/unsafe\\x1b[31m.ts" },
  ]);
  assert.equal(parentProjectDirectory("src/nested"), "src");
  assert.equal(parentProjectDirectory("src"), "");
});

test("browses folders with effective keybindings and keeps folder rows non-referenceable", () => {
  const { explorer, getResult } = createExplorer();
  let frame = explorer.render(44);
  assert.ok(frame.every((line) => visibleWidth(line) <= 44));
  assert.match(frame.join("\n"), /src\//u);
  assert.match(frame.join("\n"), /test\//u);
  assert.match(frame.join("\n"), /k\/j navigate/u);
  assert.match(frame.join("\n"), /o open folder/u);
  assert.match(explorer.render(100).join("\n"), /q\/Ctrl\+C cancel/u);

  explorer.handleInput("o");
  frame = explorer.render(44);
  assert.match(frame.join("\n"), /File Context · files · \/src/u);
  assert.match(frame.join("\n"), /nested\//u);
  assert.match(frame.join("\n"), /main\.ts/u);
  assert.match(explorer.render(100).join("\n"), /q\/Ctrl\+C back/u);
  explorer.handleInput("t");
  assert.equal(getResult(), "pending");

  explorer.handleInput("\u001b[D");
  assert.equal(explorer.render(44)[0], "File Context · files · /");
  explorer.handleInput("o");
  explorer.handleInput("\u007f");
  assert.equal(explorer.render(44)[0], "File Context · files · /");
  explorer.handleInput("o");
  explorer.handleInput("q");
  assert.equal(explorer.render(44)[0], "File Context · files · /");
  explorer.handleInput("q");
  assert.deepEqual(getResult(), { kind: "back" });
});

test("cancels a pending nested file open when returning to the parent folder", async () => {
  let openSignal: AbortSignal | undefined;
  let resolveOpen: ((value: { path: string; lines: string[] }) => void) | undefined;
  const { explorer } = createExplorer(
    "q",
    (_path, signal) =>
      new Promise((resolve) => {
        openSignal = signal;
        resolveOpen = resolve;
      }),
  );

  explorer.handleInput("o");
  explorer.handleInput("j");
  explorer.handleInput("o");
  await Promise.resolve();
  explorer.handleInput("q");
  assert.equal(openSignal?.aborted, true);
  assert.equal(explorer.render(60)[0], "File Context · files · /");
  resolveOpen?.({ path: "src/main.ts", lines: ["stale"] });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(explorer.render(60)[0], "File Context · files · /");
});

test("prioritizes a remapped cancel binding over the additive content-search shortcut", () => {
  const { explorer, getResult } = createExplorer("\u0006");

  explorer.handleInput("\u0006");
  assert.deepEqual(getResult(), { kind: "back" });
});

test("keeps fuzzy search global while browsing a folder", () => {
  const { explorer, getResult } = createExplorer();
  explorer.handleInput("o");
  explorer.handleInput("value");
  const frame = explorer.render(60).join("\n");
  assert.match(frame, /src\/nested\/value\.ts/u);
  assert.match(frame, /1 matching file/u);
  explorer.handleInput("t");
  assert.deepEqual(getResult(), { kind: "reference", path: "src/nested/value.ts" });
});
