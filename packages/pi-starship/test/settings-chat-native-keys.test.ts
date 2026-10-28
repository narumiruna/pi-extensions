import assert from "node:assert/strict";
import { CustomEditor } from "@earendil-works/pi-coding-agent";
import {
  Editor,
  getKeybindings,
  isKittyProtocolActive,
  KeybindingsManager,
  setKeybindings,
  setKittyProtocolActive,
  TUI_KEYBINDINGS,
} from "@earendil-works/pi-tui";
import { test } from "vitest";
import { SettingsChatEditor } from "../src/settings-chat-ui.js";

const definitions = {
  ...TUI_KEYBINDINGS,
  "app.clipboard.pasteImage": { defaultKeys: "ctrl+v" },
  "app.interrupt": { defaultKeys: "escape" },
  "app.exit": { defaultKeys: "ctrl+d" },
  "app.message.followUp": { defaultKeys: "alt+enter" },
  "app.message.dequeue": { defaultKeys: "alt+up" },
  "app.tools.expand": { defaultKeys: "ctrl+o" },
} as const;

type EditorPair = {
  native: CustomEditor;
  chat: SettingsChatEditor;
  events: string[][];
  input(data: string): void;
  paste(data: string): void;
};

function compare(bindings: Record<string, string | string[]>, run: (pair: EditorPair) => void, kitty = false) {
  const previous = getKeybindings();
  const previousKitty = isKittyProtocolActive();
  const keys = new KeybindingsManager(definitions, bindings as never);
  setKeybindings(keys);
  setKittyProtocolActive(kitty);
  try {
    const plain = (value: string) => value;
    const tui = { requestRender() {}, terminal: { rows: 24 } } as ConstructorParameters<typeof CustomEditor>[0];
    const theme = {
      borderColor: plain,
      selectList: { selectedPrefix: plain, selectedText: plain, description: plain, scrollInfo: plain, noMatch: plain },
    };
    const native = new CustomEditor(tui, theme, keys as never);
    const chat = new SettingsChatEditor(
      tui,
      { fg: (_role: string, value: string) => value } as never,
      () => ({ top: "", bottom: "" }),
      keys as never,
    );
    const events: string[][] = [[], []];
    for (const [index, editor] of [native, chat].entries()) {
      editor.setText("alpha beta\ngamma");
      editor.addToHistory("older prompt");
      editor.onSubmit = (text) => events[index]?.push(`submit:${text}`);
      editor.onAction("app.message.followUp", () => events[index]?.push("followUp"));
      editor.onAction("app.message.dequeue", () => events[index]?.push("dequeue"));
      editor.onAction("app.tools.expand", () => events[index]?.push("expand"));
      editor.onCtrlD = () => events[index]?.push("exit");
      editor.onPasteImage = () => events[index]?.push("pasteImage");
      editor.render(40);
    }
    const parity = () => {
      assert.equal(chat.getText(), native.getText());
      assert.deepEqual(chat.getCursor(), native.getCursor());
      assert.deepEqual(events[1], events[0]);
    };
    run({
      native,
      chat,
      events,
      input(data) {
        native.handleInput(data);
        chat.handleInput(data);
        parity();
      },
      paste(data) {
        // The paste route bypasses app shortcuts for both editors.
        Editor.prototype.handleInput.call(native, data);
        chat.handlePasteInput(data);
        parity();
      },
    });
    parity();
  } finally {
    setKeybindings(previous);
    setKittyProtocolActive(previousKitty);
  }
}

const earlier = [
  "tui.input.copy",
  "tui.editor.undo",
  "tui.input.tab",
  "tui.editor.deleteToLineEnd",
  "tui.editor.deleteToLineStart",
  "tui.editor.deleteWordBackward",
  "tui.editor.deleteWordForward",
  "tui.editor.deleteCharBackward",
  "tui.editor.deleteCharForward",
  "tui.editor.yank",
  "tui.editor.yankPop",
  "tui.editor.historyPrevious",
  "tui.editor.historyNext",
  "tui.editor.cursorLineStart",
  "tui.editor.cursorLineEnd",
  "tui.editor.cursorWordLeft",
  "tui.editor.cursorWordRight",
  "tui.input.newLine",
  "tui.input.submit",
  "tui.editor.cursorUp",
  "tui.editor.cursorDown",
  "tui.editor.cursorRight",
  "tui.editor.cursorLeft",
  "app.clipboard.pasteImage",
  "app.interrupt",
  "app.message.followUp",
  "app.message.dequeue",
  "app.tools.expand",
];
for (const action of earlier) {
  test(`native ${action} wins a remapped page collision`, () => {
    compare({ [action]: "pageUp" }, ({ input }) => input("\x1b[5~"));
  });
}

for (const empty of [false, true]) {
  test(`native exit collision is conditional on empty=${empty}`, () => {
    compare({ "app.exit": "pageUp" }, ({ native, chat, input, events }) => {
      if (empty) for (const editor of [native, chat]) editor.setText("");
      input("\x1b[5~");
      assert.deepEqual(events[0], empty ? ["exit"] : []);
    });
  });
}

test("explicit history wins registered message actions before paging", () => {
  compare({ "tui.editor.historyPrevious": "pageUp", "app.message.followUp": "pageUp" }, ({ chat, input, events }) => {
    input("\x1b[5~");
    assert.deepEqual(events, [[], []]);
    assert.equal(chat.getText(), "older prompt");
  });
});

for (const [key, input] of [
  ["shift+backspace", "\x1b[127;2u"],
  ["shift+delete", "\x1b[3;2~"],
  ["ctrl+j", "\n"],
  ["alt+enter", "\x1b\r"],
  ["shift+enter", "\x1b[13;2~"],
] as const) {
  test(`unconditional native editing wins page binding ${key}`, () => {
    compare(
      {
        "tui.editor.pageUp": key,
        "tui.input.newLine": [],
        "tui.editor.deleteCharBackward": [],
        "tui.editor.deleteCharForward": [],
        "app.message.followUp": [],
      },
      (pair) => pair.input(input),
    );
  });
}

for (const kitty of [false, true]) {
  for (const [configured, input] of [
    ["pageUp", "\x1b[5~"],
    ["ctrl+alt+u", "\x1b[117;7u"],
    ["alt+ctrl+u", "\x1b[117;7u"],
    ["esc", "\x1b"],
    ["ctrl+i", "\t"],
  ] as const) {
    test(`page binding uses native matcher: ${configured}, kitty=${kitty}`, () => {
      compare({ "tui.editor.pageUp": configured }, (pair) => pair.input(input), kitty);
    });
  }
}

test("invalid page key does not block the first usable configured alternative", () => {
  compare({ "tui.editor.pageUp": ["not-a-real-key", "ctrl+alt+u"] }, ({ native, chat, input }) => {
    const before = chat.getCursor();
    input("\x1b[117;7u");
    assert.notDeepEqual(chat.getCursor(), before);
    assert.deepEqual(chat.getCursor(), native.getCursor());
  });
});

for (const [action, packet, direction] of [
  ["tui.editor.pageUp", "\x1b[5~", -1],
  ["tui.editor.pageDown", "\x1b[6~", 1],
] as const) {
  test(`${action} moves the editor cursor, not the transcript`, () => {
    compare({}, ({ native, chat, input, events }) => {
      const text = Array.from({ length: 80 }, (_, index) => `line ${index}`).join("\n");
      for (const editor of [native, chat]) {
        editor.setText(text);
        if (direction > 0) {
          for (let index = 0; index < 79; index++) editor.handleInput("\x1b[A");
        }
        editor.render(40);
      }
      const before = chat.getCursor();
      input(packet);
      assert.equal(chat.getText(), text);
      assert.ok(direction * (chat.getCursor().line - before.line) > 0);
      assert.deepEqual(events, [[], []]);
    });
  });
}

for (const input of ["x", "\x1b[120u", "\x1b[27;1;120~"]) {
  test(`pending native jump consumes printable page binding ${JSON.stringify(input)}`, () => {
    compare({ "tui.editor.pageUp": "x" }, ({ native, chat, input: send }) => {
      for (const editor of [native, chat]) editor.setText("x middle x");
      send("\x01");
      send("\x1d");
      send(input);
      assert.deepEqual(chat.getCursor(), { line: 0, col: 9 });
      assert.equal(chat.getText(), "x middle x");
    });
  });
}

for (const [key, packet, consumesJump] of [
  ["x", "\x1b[27;1;120~", true],
  ["shift+x", "\x1b[27;2;120~", true],
  ["x", "\x1b[27;65;120~", true],
  ["x", "\x1b[27;129;120~", true],
  ["shift+x", "\x1b[27;194;120~", true],
  ["ctrl+x", "\x1b[27;5;120~", false],
  ["alt+x", "\x1b[27;3;120~", false],
] as const) {
  test(`modifyOtherKeys jump target respects modifiers: ${JSON.stringify(packet)}`, () => {
    compare({ "tui.editor.pageUp": key }, ({ native, chat, input }) => {
      for (const editor of [native, chat]) editor.setText("x middle x");
      input("\x01");
      input("\x1d");
      input(packet);
      assert.deepEqual(chat.getCursor(), { line: 0, col: consumesJump ? 9 : 0 });
      assert.equal(chat.getText(), "x middle x");
    });
  });
}

test("native page wins later jump trigger and does not enter jump mode", () => {
  compare({ "tui.editor.jumpForward": "pageUp" }, ({ chat, input }) => {
    input("\x1b[5~");
    const before = chat.getText();
    input("z");
    assert.equal(chat.getText().length, before.length + 1);
    assert.ok(chat.getText().includes("z"));
  });
});

test("control page cancels pending jump and performs native editor paging", () => {
  compare({}, ({ chat, input }) => {
    const before = chat.getCursor();
    input("\x1d");
    input("\x1b[5~");
    assert.notDeepEqual(chat.getCursor(), before);
    const text = chat.getText();
    input("z");
    assert.equal(chat.getText().length, text.length + 1);
  });
});

test("interrupt forwards to native Editor and cancels a pending jump", () => {
  compare({ "tui.editor.pageUp": "x" }, ({ chat, input }) => {
    input("\x1d");
    input("\x1b");
    input("x");
    assert.deepEqual(chat.getCursor(), { line: 0, col: 5 });
    assert.equal(chat.getText(), "alpha beta\ngamma");
  });
});

for (const [action, input, event] of [
  ["app.clipboard.pasteImage", "\x16", "pasteImage"],
  ["app.message.followUp", "\x1b\r", "followUp"],
  ["app.message.dequeue", "\x1b[1;3A", "dequeue"],
  ["app.tools.expand", "\x0f", "expand"],
] as const) {
  test(`${action} leaves pending native jump active`, () => {
    compare({ "tui.editor.pageUp": "x" }, ({ native, chat, input: send, events }) => {
      for (const editor of [native, chat]) editor.setText("x middle x");
      send("\x01");
      send("\x1d");
      send(input);
      send("x");
      assert.deepEqual(events[0], [event]);
      assert.deepEqual(chat.getCursor(), { line: 0, col: 9 });
      assert.equal(chat.getText(), "x middle x");
    });
  });
}

test("paste cancels native jump and preserves literal shortcut bytes", () => {
  compare({ "tui.editor.pageUp": "x" }, ({ chat, input, paste }) => {
    input("\x1d");
    paste("\x1b[200~paste\x1b[5~\x1b[201~");
    assert.ok(chat.getText().includes("paste"));
    const text = chat.getText();
    input("x");
    assert.equal(chat.getText(), text);
  });
});

test("split bracketed paste bypasses app actions and preserves native editing", () => {
  compare({ "app.tools.expand": "x" }, ({ chat, input, paste, events }) => {
    paste("\x1b[200~");
    paste("x");
    paste("\nsecond line\x1b[5~");
    paste("\x1b[201~");
    assert.ok(chat.getText().includes("x\nsecond line"));
    assert.deepEqual(events, [[], []]);
    input("x");
    assert.deepEqual(events[0], ["expand"]);
  });
});
