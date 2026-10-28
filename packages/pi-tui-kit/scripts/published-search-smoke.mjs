// Network-free compatibility smoke. Pass an npm-packed, extracted package directory.
// Prepare dependency resolution in the temporary fixture's parent, never in the artifact
// or installed node_modules. No workspace Kit runtime or private artifact subpaths are used.
import assert from "node:assert/strict";
import { readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { stripVTControlCharacters } from "node:util";
import { initTheme } from "@earendil-works/pi-coding-agent";
import {
  Container,
  getKeybindings,
  Input,
  KeybindingsManager,
  ScrollView,
  setKeybindings,
  Text,
  TUI_KEYBINDINGS,
  TuiAltScreen,
  TuiMainScreen,
  VStack,
} from "@earendil-works/pi-tui";

const artifact = realpathSync(
  process.argv[2] ??
    (() => {
      throw new Error("Usage: node published-search-smoke.mjs <extracted-npm-package>");
    })(),
);
const workspace = realpathSync(resolve(dirname(fileURLToPath(import.meta.url)), ".."));
assert.ok(!inside(workspace, artifact), "A workspace build is not a published artifact");
const manifest = JSON.parse(readFileSync(resolve(artifact, "package.json"), "utf8"));
assert.equal(manifest.name, "@narumitw/pi-tui-kit");
const kit = await publicExport(".");
const testing = await publicExport("./testing");
initTheme("dark", false);
const content = "abcdefghijklmnopqrstuvWXYZ a.b\r\n\ttrailing  \r\nrepeat vWXYZ\r\n";
const rawId = "raw-id\u001b[31m";
const errors = [];

for (const mode of ["regular", "fullscreen"]) {
  for (const kind of ["code", "text", "browse"]) {
    for (const remapped of [false, true]) {
      await check(`${mode} ${kind} ${remapped ? "remapped" : "default"} native input`, async () => {
        const fixture = renderer(mode, remapped);
        const review = {
          kind: "review",
          title: "Exact source",
          lines: ["Source: saved fixture"],
          content,
          format: { kind: kind === "code" ? "code" : "text", ...(kind === "code" ? { language: "toml" } : {}) },
          enableSearch: true,
          viewportSize: "adaptive",
          hint: "back",
        };
        const browse = {
          kind: "browse",
          title: "Tools",
          enableDetailSearch: true,
          hint: "back",
          items: [
            {
              id: "other",
              label: "Other",
              searchText: "other",
              detailDocument: { content: "other", format: { kind: "text" } },
            },
            { id: rawId, label: "Target", searchText: "target", detailDocument: { content, format: { kind: "text" } } },
          ],
        };
        const menu = {
          start: "main",
          screens: {
            main: () => ({
              kind: "actions",
              title: "Owner",
              items: [{ id: rawId, label: "Open exact source", to: "document" }],
            }),
            document: () => (kind === "browse" ? browse : review),
          },
          actions: {},
        };
        const snapshot = JSON.stringify({ review, browse });
        const running = kit.runMenu(fixture.ctx, menu, { getState: () => undefined });
        try {
          await fixture.waitForOpen();
          fixture.send("\r");
          await fixture.waitForOpen();
          let list;
          if (kind === "browse") {
            fixture.send("target");
            list = fixture.frame();
            assert.match(list, /› Target/u);
            assert.doesNotMatch(list, /Other/u);
            fixture.send("\r");
          }
          fixture.frame();
          fixture.send(" ");
          assert.match(fixture.frame(), /Find:/u);
          assert.equal(fixture.component.focused, true);
          const native = new Input();
          // Type, cursor movement, Backspace, Home/End, forward delete, Kitty,
          // and split bracketed paste must retain Pi Input's query semantics.
          for (const data of [
            "vWXYx",
            "\u007f",
            "Z",
            "\u001b[D",
            "\u001b[3~",
            "\u001b[90u",
            "\u001b[D",
            "\u001b[C",
            "\u001b[H",
            "\u001b[F",
          ]) {
            native.handleInput(data);
            fixture.send(data);
          }
          assert.equal(native.getValue(), "vWXYZ");
          assert.match(fixture.frame(), /Find: > vWXYZ/u);
          assert.match(fixture.frame(), /1\/2/u);
          fixture.send(remapped ? "\u001bOS" : "\r"); // F4 or Enter: next match, never approval.
          assert.match(fixture.frame(), /Find: > vWXYZ/u);
          assert.match(fixture.frame(), /2\/2/u);
          fixture.send(remapped ? "\u001b[15~" : "\u001b[13;2u"); // F5 or Shift+Enter: previous match.
          assert.match(fixture.frame(), /1\/2/u);
          fixture.resize(17, 20);
          assert.match(fixture.frame(), /1\/2/u);
          fixture.resize(24, 24);
          for (const data of ["\u0015", "\u001b[200~a.", "b\u001b[201~"]) {
            native.handleInput(data);
            fixture.send(data);
          }
          assert.equal(native.getValue(), "a.b");
          assert.match(fixture.frame(), /Find: > a\.b/u);
          assert.match(fixture.frame(), /1\/1/u);
          fixture.send(remapped ? "\u001bOQ" : "\u001b"); // F2 or Escape: close search only.
          assert.doesNotMatch(fixture.frame(), /Find:/u);
          fixture.send(remapped ? "\u001bOR" : "\u001b"); // F3 or Escape: Back.
          if (kind === "browse") {
            assert.equal(fixture.frame(), list);
            fixture.send("\r");
          } else {
            await fixture.waitForOpen();
            assert.match(fixture.frame(), /→ Open exact source/u);
            fixture.send("\r");
            await fixture.waitForOpen();
          }
          fixture.frame();
          fixture.send(" ");
          fixture.send("\u0003"); // Hard close even with remapped cancellation.
          assert.deepEqual(await running, { kind: "closed", reason: "close" });
          assert.equal(JSON.stringify({ review, browse }), snapshot);
          assert.equal(fixture.editor.getValue(), "main draft");
        } finally {
          fixture.stop();
          await running;
        }
      });
    }
  }
}

for (const kind of ["review", "browse"]) {
  await check(`${kind} RPC pagination and raw content`, async () => {
    const pages = [];
    const long = Array.from({ length: 18 }, (_, index) => `  row ${index + 1}\tvalue`).join("\r\n");
    for (const search of [false, true]) {
      const steps = [
        ...(kind === "browse" ? [{ kind: "select", response: "Target" }] : []),
        { kind: "select", response: "Next" },
        { kind: "select", response: "Next" },
        { kind: "select", response: "Previous" },
        { kind: "select", response: "Back" },
        ...(kind === "browse" ? [{ kind: "select", response: "Back" }] : []),
      ];
      const rpc = testing.createRpcHarness(steps);
      const screen =
        kind === "review"
          ? { kind, title: "Exact source", content: long, format: { kind: "text" }, enableSearch: search, hint: "back" }
          : {
              kind,
              title: "Tools",
              items: [{ id: rawId, label: "Target", detailDocument: { content: long, format: { kind: "text" } } }],
              enableDetailSearch: search,
              hint: "back",
            };
      await kit.runMenu(
        { mode: "rpc", hasUI: true, ui: rpc.ui },
        { start: "document", screens: { document: () => screen }, actions: {} },
        { getState: () => undefined },
      );
      rpc.assertConsumed();
      pages.push(rpc.dialogs);
      assert.equal(kind === "review" ? screen.content : screen.items[0].detailDocument.content, long);
    }
    assert.deepEqual(pages[1], pages[0]);
    assert.match(JSON.stringify(pages[1]), /row 18/u);
  });
}
for (const mode of ["print", "json"]) {
  await check(`${mode} rejects before UI`, async () => {
    const ui = new Proxy(
      {},
      {
        get() {
          throw new Error("Non-TUI UI access");
        },
      },
    );
    assert.deepEqual(
      await kit.runMenu(
        { mode, hasUI: false, ui },
        {
          start: "document",
          screens: {
            document: () => {
              throw new Error("Non-TUI screen access");
            },
          },
          actions: {},
        },
        { getState: () => undefined },
      ),
      { kind: "unsupported", mode },
    );
  });
}
if (errors.length) throw new AggregateError(errors, `${manifest.version}: published search compatibility failed`);
console.log(`PASS published @narumitw/pi-tui-kit@${manifest.version} (${artifact})`);

async function publicExport(name) {
  const entry = manifest.exports[name]?.import;
  assert.equal(typeof entry, "string", `Missing public ${name} import`);
  const path = realpathSync(resolve(artifact, entry));
  assert.ok(inside(artifact, path), "Public export escapes artifact");
  return import(pathToFileURL(path).href);
}
function inside(parent, child) {
  const path = relative(parent, child);
  return !path.startsWith("..") && !isAbsolute(path);
}
async function check(label, run) {
  try {
    await run();
    console.log(`PASS ${label}`);
  } catch (error) {
    errors.push(error);
    console.error(`FAIL ${label}: ${error.stack}`);
  }
}
function plain(lines) {
  return stripVTControlCharacters(
    lines
      .join("\n")
      .replaceAll("\u001b_pi:c\u0007", "")
      .replaceAll("\u001b_pi:fc\u0007", "")
      .replaceAll("\u001b_pi:/fc\u0007", ""),
  );
}
function renderer(mode, remapped) {
  const previous = getKeybindings();
  const keys = new KeybindingsManager(
    TUI_KEYBINDINGS,
    remapped
      ? {
          "tui.altScreen.searchClose": "f2",
          "tui.select.cancel": "f3",
          "tui.altScreen.searchNext": "f4",
          "tui.altScreen.searchPrevious": "f5",
        }
      : {},
  );
  setKeybindings(keys);
  let input;
  let columns = 24;
  let rows = 24;
  const noop = () => {};
  const terminal = {
    get columns() {
      return columns;
    },
    get rows() {
      return rows;
    },
    start(callback) {
      input = callback;
    },
    stop: noop,
    drainInput: async () => {},
    write: noop,
    moveBy: noop,
    hideCursor: noop,
    showCursor: noop,
    clearLine: noop,
    clearFromCursor: noop,
    clearScreen: noop,
    setTitle: noop,
    setProgress: noop,
    setProgramStatus: noop,
  };
  class Regular extends TuiMainScreen {
    flush() {
      this.doRender();
    }
  }
  class Fullscreen extends TuiAltScreen {
    flush() {
      this.doRender();
    }
  }
  const host = mode === "regular" ? new Regular(terminal, false) : new Fullscreen(terminal, false);
  const editor = new Input();
  editor.setValue("main draft");
  const dock = new Container();
  dock.addChild(editor);
  const transcript = new Text(Array.from({ length: 100 }, (_, index) => `history ${index}`).join("\n"), 0, 0);
  const scroll = new ScrollView(transcript, { primary: true, follow: "end" });
  if (mode === "fullscreen")
    host.setLayoutRoot(new VStack([{ component: scroll, basis: 0, grow: 1, minSize: 1 }, dock]));
  else {
    host.addChild(transcript);
    host.addChild(dock);
  }
  host.setFocus(editor);
  const identity = (text) => text;
  const theme = {
    fg: (_role, text) => text,
    bg: (_role, text) => text,
    bold: identity,
    italic: identity,
    underline: identity,
    inverse: identity,
    strikethrough: identity,
    getFgAnsi: () => "",
    getBgAnsi: () => "",
    getColorMode: () => "truecolor",
  };
  let component;
  let ready = deferred();
  let close = noop;
  const custom = async (factory) => {
    const result = deferred();
    const opened = ready;
    ready = deferred();
    let settled = false;
    const done = (value) => {
      if (settled) return;
      settled = true;
      dock.clear();
      dock.addChild(editor);
      host.setFocus(editor);
      result.resolve(value);
      component?.dispose?.();
    };
    close = () => done(undefined);
    component = await factory(host, theme, keys, done);
    dock.clear();
    dock.addChild(component);
    host.setFocus(component);
    host.flush();
    opened.resolve();
    return result.promise;
  };
  let waiting = ready;
  host.start();
  host.flush();
  return {
    ctx: {
      mode: "tui",
      hasUI: true,
      ui: {
        custom,
        notify(message) {
          throw new Error(message);
        },
      },
    },
    editor,
    get component() {
      return component;
    },
    async waitForOpen() {
      await waiting.promise;
      waiting = ready;
    },
    frame() {
      return plain(component.render(columns));
    },
    send(data) {
      input(data);
      host.flush();
    },
    resize(width, height) {
      columns = width;
      rows = height;
      host.invalidate();
      host.flush();
    },
    stop() {
      close();
      host.stop();
      setKeybindings(previous);
    },
  };
}
function deferred() {
  let resolvePromise;
  const promise = new Promise((resolve) => {
    resolvePromise = resolve;
  });
  return { promise, resolve: resolvePromise };
}
