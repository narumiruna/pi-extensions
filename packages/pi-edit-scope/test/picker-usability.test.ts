import { relative } from "node:path";
import { CURSOR_MARKER, setKittyProtocolActive, visibleWidth } from "@earendil-works/pi-tui";
import { expect, test, vi } from "vitest";
import { displayPath } from "../src/display.js";
import { plain, setup } from "./picker-fixture.js";

const mark = (tui: ReturnType<typeof setup>["tui"]) => tui.press("tui.input.tab");
const openPath = (tui: ReturnType<typeof setup>["tui"], raw: string) => {
  tui.send("\x0f");
  tui.type(raw);
};

test("opens a clean file-only list with readable labels, a search placeholder, and persistent primary keys", async () => {
  const { tui, running } = setup();
  await tui.waitForOpen();
  await tui.waitForPending();
  const text = plain(tui.render());
  expect(text).toContain("Select files");
  expect(text).toContain("Search files…");
  expect(text).toContain("→ [ ] a file");
  expect(text).not.toContain('"a file"');
  expect(text).not.toContain("Path: a file");
  expect(text).not.toContain("→ Start restriction");
  expect(text).not.toContain("→ Show full paths");
  expect(text).toContain("0 selected");
  expect(text).toContain("tab select");
  expect(text).toContain("enter apply (select files)");
  expect(text).toContain("esc cancel");
  expect(text).not.toMatch(/f(?:8|9|10) apply/u);
  tui.send("\x03");
  await running;
});

test("Tab toggles and moves down; Shift+Tab toggles and moves up with wraparound", async () => {
  const { tui, running, validate } = setup();
  await tui.waitForOpen();
  await tui.waitForPending();
  mark(tui);
  expect(plain(tui.render())).toContain("[x] a file");
  expect(plain(tui.render())).toContain("→ [ ] b");
  tui.send("\x1b[Z");
  expect(plain(tui.render())).toContain("→ [x] a file");
  expect(plain(tui.render())).toContain("[x] b");
  tui.send("\x1b[Z");
  expect(plain(tui.render())).toContain("→ [ ] other");
  expect(plain(tui.render())).toContain("[ ] a file");
  tui.press("tui.select.confirm");
  await running;
  expect(validate).toHaveBeenCalledWith(["/cwd/b"], expect.any(AbortSignal), []);
});

test("directory fragments and whitespace use native fuzzy search, never path resolution", async () => {
  const { tui, running, resolvePath, validate } = setup({
    discover: async () => ["/cwd/src/target-file.ts", "/cwd/docs/target-file.md", "/cwd/src/unrelated.ts"],
  });
  await tui.waitForOpen();
  await tui.waitForPending();
  tui.type("src/trg fl");
  const text = plain(tui.render());
  expect(text).toContain(relative("/cwd", "/cwd/src/target-file.ts"));
  expect(text).not.toContain("docs/target-file.md");
  expect(text).not.toContain("Add file:");
  expect(resolvePath).not.toHaveBeenCalled();
  mark(tui);
  tui.press("tui.select.confirm");
  await running;
  expect(validate.mock.calls[0]?.[0]).toEqual(["/cwd/src/target-file.ts"]);
  expect(resolvePath).not.toHaveBeenCalled();
});

test("Enter with no marked files stays open rather than implicitly applying the highlighted file", async () => {
  const { tui, running, validate } = setup();
  await tui.waitForOpen();
  await tui.waitForPending();
  tui.press("tui.select.confirm");
  expect(tui.isOpen).toBe(true);
  expect(validate).not.toHaveBeenCalled();
  expect(plain(tui.render())).toContain("Select at least one file first.");
  tui.send("\x1b");
  expect(await running).toMatchObject({ kind: "completed", value: { kind: "cancelled", reason: "back" } });
});

test("fuzzy ranking chooses the closer filename, while Tab never changes the query", async () => {
  const { tui, running, validate } = setup({ discover: async () => ["/cwd/archive/a-long-b-name.ts", "/cwd/ab.ts"] });
  await tui.waitForOpen();
  await tui.waitForPending();
  tui.type("ab");
  expect(plain(tui.render())).toContain("→ [ ] ab.ts");
  mark(tui);
  expect(plain(tui.render())).toContain("> ab");
  expect(plain(tui.render())).toContain("1 selected");
  tui.press("tui.select.confirm");
  await running;
  expect(validate.mock.calls[0]?.[0]).toEqual(["/cwd/ab.ts"]);
});

test("path mode preserves query, cursor, checks, and raw completion payload", async () => {
  const { tui, running, validate } = setup();
  await tui.waitForOpen();
  await tui.waitForPending();
  tui.type("a file");
  mark(tui);
  tui.send("\x1b[D");
  tui.send("\x10");
  expect(plain(tui.render())).toContain("→ [x] /cwd/a file");
  tui.send("\x10");
  expect(plain(tui.render())).toContain("→ [x] a file");
  const compact = plain(tui.resize({ width: 80, rows: 8 }));
  expect(compact).toContain("→ [x] a file");
  expect(compact).toContain("> a fil");
  expect(compact).toContain("enter apply");
  tui.resize({ width: 100, rows: 32 });
  tui.type("X");
  expect(plain(tui.render())).toContain("> a filXe");
  tui.press("tui.select.confirm");
  await running;
  expect(validate.mock.calls[0]?.[0]).toEqual(["/cwd/a file"]);
});

test("outside and canonical targets remain explicit while unsafe or ambiguous labels remain quoted", async () => {
  const path = "/cwd/src/a\u202e\u00a0 b";
  const target = { path: "/cwd/src/alias.ts", canonical: "/outside/real.ts" };
  const { tui, running } = setup({
    targets: [target],
    discover: async () => [path, "/cwd/a  b", "/cwd-neighbour/a.ts"],
  });
  await tui.waitForOpen();
  await tui.waitForPending();
  const text = plain(tui.render());
  expect(text).toContain(`→ [x] ${relative("/cwd", target.path)}`);
  expect(text).toContain(`Canonical target: ${target.canonical}`);
  expect(text).toContain("Outside the current directory.");
  expect(text).toContain("(outside) /cwd-neighbour/a.ts");
  expect(text).toContain(displayPath(relative("/cwd", path)));
  expect(text).toContain('"a  b"');
  expect(text).not.toContain("\u202e");
  tui.send("\x03");
  await running;
});

test("adding an external file is separate from search and preserves a matching query and checked draft", async () => {
  const { tui, running, resolvePath, validate } = setup();
  await tui.waitForOpen();
  await tui.waitForPending();
  tui.type("a file");
  mark(tui);
  openPath(tui, "/outside/a file");
  const form = plain(tui.render());
  expect(form).toContain("Add existing file");
  expect(form).toContain("enter add file");
  expect(resolvePath).not.toHaveBeenCalled();
  tui.press("tui.input.submit");
  await tui.waitForPending();
  const files = plain(tui.render());
  expect(files).toContain("Select files");
  expect(files).toContain("> a file");
  expect(files).toContain("→ [x] (outside) /outside/a file");
  expect(files).toContain("2 selected");
  expect(resolvePath).toHaveBeenCalledWith("/outside/a file", expect.any(AbortSignal));
  tui.press("tui.select.confirm");
  await running;
  expect(validate).toHaveBeenCalledWith(["/cwd/a file", "/outside/a file"], expect.any(AbortSignal), [
    { path: "/outside/a file", canonical: "/outside/a file" },
  ]);
});

test("an added file hidden by the search stays checked and produces a clear status without discarding the query", async () => {
  const { tui, running, validate } = setup();
  await tui.waitForOpen();
  await tui.waitForPending();
  tui.type("b");
  mark(tui);
  openPath(tui, "/outside/external");
  tui.press("tui.input.submit");
  await tui.waitForPending();
  const text = plain(tui.render());
  expect(text).toContain("> b");
  expect(text).toContain("→ [x] b");
  expect(text).toContain("Added /outside/external");
  expect(text).toContain("2 selected");
  tui.press("tui.select.confirm");
  await running;
  expect(validate.mock.calls[0]?.[0]).toEqual(["/cwd/b", "/outside/external"]);
});

test("Back cancels only the add panel and preserves both independent drafts", async () => {
  const { tui, running, resolvePath } = setup({}, { "tui.select.cancel": "q" });
  await tui.waitForOpen();
  await tui.waitForPending();
  tui.type("a file");
  mark(tui);
  openPath(tui, "/outside/draft");
  tui.send("q");
  expect(plain(tui.render())).toContain("Select files");
  expect(plain(tui.render())).toContain("> a file");
  expect(plain(tui.render())).toContain("1 selected");
  tui.send("\x0f");
  expect(plain(tui.render())).toContain("> /outside/draft");
  expect(resolvePath).not.toHaveBeenCalled();
  tui.send("q");
  tui.send("q");
  expect(await running).toMatchObject({ kind: "completed", value: { kind: "cancelled", reason: "back" } });
});

test("the add panel retains its raw input on failure and accepts corrected input in place", async () => {
  const resolvePath = vi
    .fn()
    .mockRejectedValueOnce(new Error("Not a regular file"))
    .mockResolvedValueOnce({ path: "/outside/fixed", canonical: "/outside/fixed" });
  const { tui, running } = setup({ resolvePath });
  await tui.waitForOpen();
  await tui.waitForPending();
  openPath(tui, "/outside/bad");
  tui.press("tui.input.submit");
  await tui.waitForPending();
  expect(plain(tui.render())).toContain("Add existing file");
  expect(plain(tui.render())).toContain("> /outside/bad");
  expect(plain(tui.render())).toContain("Not a regular file");
  tui.send("\x15");
  tui.type("/outside/fixed");
  tui.press("tui.input.submit");
  await tui.waitForPending();
  expect(plain(tui.render())).toContain("Select files");
  expect(plain(tui.render())).toContain("[x] (outside) /outside/fixed");
  tui.send("\x03");
  await running;
});

test("remapped marking, confirmation, cancellation, and add submission retain their separate meanings", async () => {
  const { tui, running, validate, resolvePath } = setup(
    {},
    {
      "tui.input.tab": "f2",
      "tui.select.confirm": "f3",
      "tui.select.cancel": "q",
      "tui.input.submit": "f4",
    },
  );
  await tui.waitForOpen();
  await tui.waitForPending();
  tui.send("\t");
  tui.send("\r");
  expect(plain(tui.render())).toContain("0 selected");
  expect(validate).not.toHaveBeenCalled();
  tui.send("\x1bOR");
  expect(plain(tui.render())).toContain("Select at least one file first.");
  expect(plain(tui.render())).not.toContain("with Tab");
  tui.send("\x1bOQ");
  expect(plain(tui.render())).toContain("1 selected");
  expect(plain(tui.render())).toContain("f2 select");
  expect(plain(tui.render())).toContain("f3 apply");
  openPath(tui, "/outside/file");
  tui.send("\r");
  expect(resolvePath).not.toHaveBeenCalled();
  expect(plain(tui.render())).toContain("f4 add file");
  tui.send("\x1bOS");
  await tui.waitForPending();
  tui.send("\x1bOR");
  await running;
  expect(validate.mock.calls[0]?.[0]).toEqual(["/cwd/a file", "/outside/file"]);
});

test("standard selection wins over legacy Tab/Ctrl+I and Shift+Tab marking collisions", async () => {
  const first = setup({ targets: [{ path: "/cwd/b", canonical: "/cwd/b" }] }, { "tui.select.confirm": "ctrl+i" });
  await first.tui.waitForOpen();
  await first.tui.waitForPending();
  expect(plain(first.tui.render())).not.toContain("• tab select");
  first.tui.send("\t");
  await first.running;
  expect(first.validate.mock.calls[0]?.[0]).toEqual(["/cwd/b"]);
  const second = setup({}, { "tui.select.up": "shift+tab" });
  await second.tui.waitForOpen();
  await second.tui.waitForPending();
  second.tui.send("\x1b[Z");
  expect(plain(second.tui.render())).toContain("→ [ ] other");
  expect(plain(second.tui.render())).toContain("0 selected");
  expect(plain(second.tui.render())).not.toContain("shift+tab select");
  second.tui.send("\x03");
  await second.running;
});

test("native editing wins over Add and the first safe non-function-key alternative is shown", async () => {
  const { tui, running } = setup({}, { "tui.editor.undo": "ctrl+o" });
  await tui.waitForOpen();
  await tui.waitForPending();
  tui.type("query");
  tui.send("\x0f");
  expect(plain(tui.render())).toContain("Select files");
  expect(plain(tui.render())).toContain("alt+o Add file…");
  tui.send("\x1bo");
  expect(plain(tui.render())).toContain("Add existing file");
  tui.send("\x03");
  await running;
});

test("an arbitrary path-toggle remap still works without advertising an unproved key", async () => {
  setKittyProtocolActive(true);
  const { tui, running } = setup({}, { "app.session.togglePath": "alt+ctrl+x" });
  await tui.waitForOpen();
  await tui.waitForPending();
  expect(plain(tui.render())).not.toContain("alt+ctrl+x Full paths");
  tui.send("\x1b[120;7u");
  expect(plain(tui.render())).toContain("→ [ ] /cwd/a file");
  tui.send("\x03");
  await running;
});

test("fragmented paste cannot mark, apply, open Add, switch paths, or cancel", async () => {
  const { tui, running, validate, resolvePath } = setup();
  await tui.waitForOpen();
  await tui.waitForPending();
  tui.send("\x1b[200~");
  tui.send("\t");
  tui.send("\r");
  tui.send("\x0f");
  tui.send("\x10");
  tui.send("\x03");
  tui.send("\x1b[201~");
  expect(validate).not.toHaveBeenCalled();
  expect(resolvePath).not.toHaveBeenCalled();
  expect(plain(tui.render())).toContain("Select files");
  expect(plain(tui.render())).toContain("0 selected");
  tui.send("\x15");
  tui.send("\x1b[200~a file\x1b[201~\t");
  expect(plain(tui.render())).toContain("1 selected");
  tui.press("tui.select.confirm");
  await running;
  expect(validate.mock.calls[0]?.[0]).toEqual(["/cwd/a file"]);
});

test("old function-key completion is gone and failed Enter validation retains marks and query", async () => {
  const validate = vi
    .fn()
    .mockRejectedValueOnce(new Error("Target changed"))
    .mockResolvedValueOnce([{ path: "/cwd/b", canonical: "/cwd/b" }]);
  const { tui, running } = setup({ targets: [{ path: "/cwd/b", canonical: "/cwd/b" }], validate });
  await tui.waitForOpen();
  await tui.waitForPending();
  tui.type("b");
  tui.send("\x1b[21~");
  expect(validate).not.toHaveBeenCalled();
  tui.press("tui.select.confirm");
  await tui.waitForPending();
  expect(plain(tui.render())).toContain("Target changed");
  expect(plain(tui.render())).toContain("> b");
  expect(plain(tui.render())).toContain("[x] b");
  tui.press("tui.select.confirm");
  await running;
  expect(validate).toHaveBeenCalledTimes(2);
});

test("file clicks toggle without applying, and explicit footer buttons handle Add and Apply", async () => {
  const { tui, running, validate } = setup();
  await tui.waitForOpen();
  await tui.waitForPending();
  const file = tui.render().findIndex((line) => line.includes("→ [ ] a file"));
  tui.mouse({ type: "press", x: 5, y: file });
  tui.mouse({ type: "click", x: 5, y: file });
  expect(validate).not.toHaveBeenCalled();
  let frame = tui.render();
  const add = frame.findIndex((line) => line.includes("Add file…"));
  const addX = frame[add].indexOf("Add file…");
  tui.mouse({ type: "press", x: addX, y: add });
  tui.mouse({ type: "click", x: addX, y: add });
  expect(plain(tui.render())).toContain("Add existing file");
  tui.send("\x1b");
  frame = tui.render();
  const apply = frame.findIndex((line) => line.includes("[ Start restriction ]"));
  tui.mouse({ type: "press", x: 5, y: apply });
  tui.mouse({ type: "click", x: 5, y: apply });
  await running;
  expect(validate.mock.calls[0]?.[0]).toEqual(["/cwd/a file"]);
});

test("an in-flight lookup cannot transfer a fragmented paste to the returned file panel", async () => {
  const lookup = Promise.withResolvers<{ path: string; canonical: string }>();
  const { tui, running, validate } = setup({
    targets: [{ path: "/cwd/b", canonical: "/cwd/b" }],
    resolvePath: async () => lookup.promise,
  });
  await tui.waitForOpen();
  await tui.waitForPending();
  openPath(tui, "/outside/file");
  tui.press("tui.input.submit");
  tui.send("\x1b[200~");
  lookup.resolve({ path: "/outside/file", canonical: "/outside/file" });
  await tui.waitForPending();
  expect(plain(tui.render())).toContain("Select files");
  expect(plain(tui.render())).toContain("Pasting…");
  expect(plain(tui.render())).not.toContain("ctrl+o Add file…");
  expect(plain(tui.render())).not.toContain("ctrl+p Full paths");
  tui.send("\t");
  tui.send("\x03");
  expect(tui.isOpen).toBe(true);
  expect(validate).not.toHaveBeenCalled();
  expect(plain(tui.render())).toContain("2 selected");
  // Bytes after the end marker belong to the current panel, not the old path field.
  tui.send("\x1b[201~b");
  expect(plain(tui.render())).toContain("> b");
  expect(plain(tui.render())).toContain("→ [x] b");
  tui.press("tui.select.confirm");
  await running;
  expect(validate.mock.calls[0]?.[0]).toEqual(["/cwd/b", "/outside/file"]);
});

test("paste blocks pointer mode changes, then a trailing Add key routes through the current screen", async () => {
  const { tui, running, resolvePath } = setup();
  await tui.waitForOpen();
  await tui.waitForPending();
  const frame = tui.render();
  const row = frame.findIndex((line) => line.includes("Add file…"));
  const x = frame[row].indexOf("Add file…");
  tui.send("\x1b[200~a file");
  tui.mouse({ type: "press", x, y: row });
  tui.mouse({ type: "click", x, y: row });
  expect(plain(tui.render())).toContain("Select files");
  expect(resolvePath).not.toHaveBeenCalled();
  tui.send("\x1b[201~\x0f");
  expect(plain(tui.render())).toContain("Add existing file");
  tui.send("\x1b");
  expect(plain(tui.render())).toContain("> a file");
  expect(plain(tui.render())).toContain("0 selected");
  tui.send("\x03");
  await running;
});

test("when both Add keys are reserved by editing, only the clickable control advertises the action", async () => {
  const { tui, running } = setup({}, { "tui.editor.undo": ["ctrl+o", "alt+o"] });
  await tui.waitForOpen();
  await tui.waitForPending();
  tui.send("\x0f");
  tui.send("\x1bo");
  const frame = tui.render();
  const text = plain(frame);
  expect(text).toContain("Select files");
  expect(text).not.toContain("ctrl+o Add file…");
  expect(text).not.toContain("alt+o Add file…");
  const row = frame.findIndex((line) => line.includes("[ Add file… ]"));
  const x = frame[row].indexOf("Add file…");
  tui.mouse({ type: "press", x, y: row });
  tui.mouse({ type: "click", x, y: row });
  expect(plain(tui.render())).toContain("Add existing file");
  tui.send("\x03");
  await running;
});

test.each([false, true])(
  "post-paste list actions use the new query before dispatch (fragmented=%s)",
  async (fragmented) => {
    for (const [tail, next, selected] of [
      ["\t", "b1", "b0"],
      ["\x1b[Z", "b2", "b0"],
      ["\x1b[B", "b1", undefined],
      ["\x1b[6~", "b2", undefined],
    ] as const) {
      const { tui, running, validate } = setup({ discover: async () => ["/cwd/a", "/cwd/b0", "/cwd/b1", "/cwd/b2"] });
      await tui.waitForOpen();
      await tui.waitForPending();
      if (fragmented) {
        tui.send("\x1b[200~b");
        tui.send(`\x1b[201~${tail}`);
      } else tui.send(`\x1b[200~b\x1b[201~${tail}`);
      const text = plain(tui.render());
      expect(text, `tail=${JSON.stringify(tail)}`).toContain(`→ [ ] ${next}`);
      expect(text).toContain("> b");
      if (selected) expect(text).toContain(`[x] ${selected}`);
      else mark(tui);
      tui.press("tui.select.confirm");
      await running;
      expect(validate.mock.calls[0]?.[0]).toEqual([`/cwd/${selected ?? next}`]);
    }
  },
);

test("a pressed file keeps its identity when canonical details move it outside the old pointer row", async () => {
  const { tui, running, validate } = setup({
    targets: [
      { path: "/cwd/a", canonical: "/cwd/a" },
      { path: "/cwd/b", canonical: "/outside/b" },
    ],
    discover: async () => ["/cwd/c"],
  });
  await tui.waitForOpen();
  await tui.waitForPending();
  const frame = tui.resize({ width: 100, rows: 15 });
  const row = frame.findIndex((line) => line.includes("[x] b"));
  tui.mouse({ type: "press", x: 5, y: row });
  const changed = tui.render();
  expect(plain(changed)).toContain("Canonical target: /outside/b");
  expect(changed[row]).not.toContain("[x] b");
  tui.mouse({ type: "click", x: 5, y: row });
  expect(plain(tui.render())).toContain("1 selected");
  tui.press("tui.select.confirm");
  await running;
  expect(validate.mock.calls[0]?.[0]).toEqual(["/cwd/a"]);
});

test("lookup completion invalidates a held Back gesture instead of clicking a file in the returned panel", async () => {
  const lookup = Promise.withResolvers<{ path: string; canonical: string }>();
  const { tui, running, validate } = setup({
    targets: [{ path: "/cwd/b", canonical: "/cwd/b" }],
    resolvePath: async () => lookup.promise,
  });
  await tui.waitForOpen();
  await tui.waitForPending();
  openPath(tui, "/outside/file");
  tui.press("tui.input.submit");
  const frame = tui.render();
  const row = frame.findIndex((line) => line.includes("[ Back ]"));
  tui.mouse({ type: "press", x: 4, y: row });
  lookup.resolve({ path: "/outside/file", canonical: "/outside/file" });
  await tui.waitForPending();
  expect(plain(tui.render())).toContain("Select files");
  tui.mouse({ type: "click", x: 4, y: row });
  expect(tui.isOpen).toBe(true);
  expect(plain(tui.render())).toContain("2 selected");
  tui.press("tui.select.confirm");
  await running;
  expect(validate.mock.calls[0]?.[0]).toEqual(["/cwd/b", "/outside/file"]);
});

test("both panels preserve native IME focus, zero-width safety, frame bounds, and masked pointer geometry", async () => {
  const { tui, running, zeroFrames } = setup();
  await tui.waitForOpen();
  await tui.waitForPending();
  tui.setFocused(true);
  expect(tui.render().join("")).toContain(CURSOR_MARKER);
  for (const panel of ["files", "path"]) {
    if (panel === "path") openPath(tui, "./a\u202eb");
    for (const rows of [4, 7, 8, 14, 32])
      for (const width of [1, 8, 40, 100]) {
        const frame = tui.resize({ rows, width });
        expect(frame.length).toBeLessThanOrEqual(Math.max(1, rows - 3));
        expect(frame.every((line) => visibleWidth(line) <= width)).toBe(true);
      }
    tui.resize({ rows: 32, width: 100 });
    expect(tui.render().join("")).toContain(CURSOR_MARKER);
  }
  expect(zeroFrames.flat().every((line) => visibleWidth(line) === 0)).toBe(true);
  tui.send("\x03");
  await running;
});
