import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { Agent } from "@earendil-works/pi-agent-core";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { CustomEditor, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
  CURSOR_MARKER,
  Editor,
  getKeybindings,
  isKittyProtocolActive,
  KeybindingsManager,
  matchesKey,
  setKeybindings,
  setKittyProtocolActive,
  TUI_KEYBINDINGS,
  TuiAltScreen,
  visibleWidth,
} from "@earendil-works/pi-tui";
import { createTuiHarness } from "@narumitw/pi-tui-kit/testing";
import { test } from "vitest";
import { createMockContext } from "../../../test/support.js";
import {
  createSettingsChatComponent,
  SettingsChatEditor,
  settingsChatSaveShortcut,
  settingsChatStopInput,
  showSettingsChat,
} from "../src/settings-chat-ui.js";
import { createSettingsDraft } from "../src/settings-draft.js";
import { FullscreenTerminal } from "./settings-chat-fullscreen-support.js";
import { response, settingsChatCustom, testModel } from "./settings-chat-support.js";

// Native scrollbar position can change while the anchored message stays fixed.
function transcriptContent(lines: readonly string[]) {
  return lines.map((line) => stripVTControlCharacters(line).replace(/[│┃]$/u, "").trimEnd());
}

const CHAT_KEYS = {
  ...TUI_KEYBINDINGS,
  "app.message.followUp": { defaultKeys: "alt+enter" },
  "app.message.dequeue": { defaultKeys: "alt+up" },
  "app.clipboard.pasteImage": { defaultKeys: "ctrl+v" },
  "app.interrupt": { defaultKeys: "escape" },
  "app.exit": { defaultKeys: "ctrl+d" },
  "app.tools.expand": { defaultKeys: "ctrl+o" },
} as const;

function fixture(
  streamFn: ConstructorParameters<typeof Agent>[0]["streamFn"] = () =>
    response([{ type: "text", text: "Preview updated\x1b]52;c;secret\x07" }]),
  keys = new KeybindingsManager(CHAT_KEYS),
  preview = () => ["FOOTER PREVIEW"],
  toolsExpanded = false,
) {
  const root = mkdtempSync(join(tmpdir(), "starship-ui-test-"));
  const controller = new AbortController();
  const draft = createSettingsDraft({
    settingsPath: join(root, "pi-starship.toml"),
    baseline: undefined,
    packageRoot: resolve(import.meta.dirname, ".."),
    isCurrent: () => !controller.signal.aborted,
    onPreview() {},
  });
  const agent = new Agent({ initialState: { model: { ...testModel, input: ["text"] }, tools: draft.tools }, streamFn });
  const previousKeys = getKeybindings();
  setKeybindings(keys);
  const tui = createTuiHarness({ rows: 32, keybindings: keys });
  const overlayOptions: unknown[] = [];
  const ctx = createMockContext({
    mode: "tui",
    hasUI: true,
    custom: settingsChatCustom(tui.custom, (options) => overlayOptions.push(options)),
  }).ctx as ExtensionCommandContext;
  ctx.ui.getToolsExpanded = () => toolsExpanded;
  const state = { input: "", error: "" };
  const running = showSettingsChat(
    ctx,
    agent,
    draft,
    state,
    { signal: controller.signal, isCurrent: () => !controller.signal.aborted },
    preview,
  );
  return {
    root,
    ctx,
    controller,
    draft,
    agent,
    tui,
    state,
    running,
    overlayOptions,
    keys,
    async dispose() {
      controller.abort();
      tui.dispose();
      await running;
      agent.abort();
      await agent.waitForIdle();
      draft.dispose();
      rmSync(root, { force: true, recursive: true });
      setKeybindings(previousKeys);
    },
  };
}

for (const remapped of [false, true]) {
  test(`chat history supports paging and wheel scrolling with ${remapped ? "custom" : "default"} keys`, async () => {
    const keys = new KeybindingsManager(
      CHAT_KEYS,
      remapped
        ? {
            "tui.altScreen.pageUp": "ctrl+alt+u",
            "tui.altScreen.pageDown": "ctrl+alt+d",
          }
        : {},
    );
    const f = fixture(undefined, keys);
    try {
      await f.tui.waitForOpen();
      f.agent.state.messages.push({
        role: "user",
        content: Array.from({ length: 120 }, (_, i) => `history-${i.toString().padStart(3, "0")}`).join("\n"),
        timestamp: 0,
      });
      const bottom = f.tui.render().join("\n");
      assert.match(bottom, /history-119/u);
      f.tui.type("keep this draft");
      f.tui.send(remapped ? "\x1b[117;7u" : "\x1b[5~");
      const older = f.tui.render().join("\n");
      assert.doesNotMatch(older, /history-119/u);
      assert.match(older, /keep this draft/u);
      f.agent.state.messages.push({ role: "user", content: "new-tail", timestamp: 1 });
      assert.equal(f.tui.render().join("\n"), older);
      f.tui.mouse({ type: "wheel", x: 1, y: 1, wheelDelta: -1 });
      assert.notEqual(f.tui.render().join("\n"), older);
      for (let i = 0; i < 10; i++) f.tui.send(remapped ? "\x1b[100;7u" : "\x1b[6~");
      assert.match(f.tui.render().join("\n"), /new-tail/u);
      for (const width of [1, 20, 80]) {
        const frame = f.tui.render(width);
        assert.ok(frame.every((line) => visibleWidth(line) <= width));
      }
      f.tui.send("\x03");
      assert.equal(await f.running, "discard");
      assert.equal(f.state.input, "keep this draft");
    } finally {
      await f.dispose();
    }
  });
}

test("native history retains manual position through resize, dock changes, and temporary fit", async () => {
  let preview = ["FOOTER PREVIEW"];
  const f = fixture(undefined, undefined, () => preview);
  try {
    await f.tui.waitForOpen();
    const message = {
      role: "user" as const,
      content: Array.from({ length: 120 }, (_, row) => `retained-row-${row}`).join("\n"),
      timestamp: 0,
    };
    f.agent.state.messages.push(message);
    f.tui.render();
    f.tui.send("\x1b[5~");
    const first = transcriptContent(f.tui.render())[0];
    preview = Array.from({ length: 8 }, (_, row) => `preview-${row}`);
    assert.equal(transcriptContent(f.tui.render())[0], first);
    f.tui.resize({ rows: 40, width: 50 });
    assert.equal(transcriptContent(f.tui.render())[0], first);
    message.content = "temporarily short";
    f.tui.invalidate();
    f.tui.render();
    message.content = Array.from({ length: 120 }, (_, row) => `restored-row-${row}`).join("\n");
    f.tui.invalidate();
    assert.doesNotMatch(f.tui.render().join("\n"), /restored-row-119/u);
    f.tui.send("\x1b[1;5F");
    assert.match(f.tui.render().join("\n"), /restored-row-119/u);
  } finally {
    await f.dispose();
  }
});

for (const [name, configured, packet, kitty] of [
  ["default", "ctrl+o", "\x0f", false],
  ["remapped editing key", "ctrl+alt+o", "\x1b[111;7u", true],
  ["remapped alias", "ctrl+return", "\x1b[13;5u", true],
  ["modifier order", "alt+ctrl+x", "\x1b[120;7u", true],
  ["first usable alternative", ["ctrl+", "ctrl+o"], "\x0f", false],
] as const) {
  test(`tool collapse uses native action routing with ${name} keys`, async () => {
    const previousKitty = isKittyProtocolActive();
    const keys = new KeybindingsManager(CHAT_KEYS, { "app.tools.expand": configured as never });
    const f = fixture(undefined, keys);
    setKittyProtocolActive(kitty);
    try {
      await f.tui.waitForOpen();
      const assistant = await response(
        [{ type: "toolCall", id: "collapse-call", name: "read", arguments: { path: "draft.toml" } }],
        "toolUse",
      ).result();
      f.agent.state.messages.push(assistant, {
        role: "toolResult",
        toolCallId: "collapse-call",
        toolName: "read",
        content: [{ type: "text", text: Array.from({ length: 20 }, (_, i) => `output-${i}`).join("\n") }],
        isError: false,
        timestamp: 1,
      });
      assert.doesNotMatch(f.tui.render().join("\n"), /output-19/u);
      f.tui.send(packet);
      const expanded = f.tui.render().join("\n");
      assert.match(expanded, /output-19/u);
      f.tui.invalidate();
      assert.equal(f.tui.render().join("\n"), expanded);
      f.tui.send("\x1b[200~");
      f.tui.send(packet);
      assert.match(f.tui.render().join("\n"), /output-19/u);
      f.tui.send("\x1b[201~");
      f.tui.send(packet);
      assert.doesNotMatch(f.tui.render().join("\n"), /output-19/u);
      f.tui.send("\x03");
      assert.equal(await f.running, "discard");
    } finally {
      setKittyProtocolActive(previousKitty);
      await f.dispose();
    }
  });
}

for (const initial of [false, true]) {
  test(`tool expansion starts from parent=${initial} and stays local across chat reopening`, async () => {
    const f = fixture(undefined, undefined, undefined, initial);
    const assistant = await response(
      [{ type: "toolCall", id: "local", name: "read", arguments: { path: "local.toml" } }],
      "toolUse",
    ).result();
    try {
      await f.tui.waitForOpen();
      f.agent.state.messages.push(assistant, {
        role: "toolResult",
        toolCallId: "local",
        toolName: "read",
        content: [{ type: "text", text: "local tool output" }],
        isError: false,
        timestamp: 0,
      });
      assert.equal(f.tui.render().join("\n").includes("local tool output"), initial);
      f.tui.send("\x0f");
      assert.equal(f.tui.render().join("\n").includes("local tool output"), !initial);
      assert.equal(f.ctx.ui.getToolsExpanded(), initial);
      f.tui.send("\x13");
      assert.equal(await f.running, "save");
      const reopened = showSettingsChat(
        f.ctx,
        f.agent,
        f.draft,
        f.state,
        { signal: f.controller.signal, isCurrent: () => !f.controller.signal.aborted },
        () => ["FOOTER PREVIEW"],
      );
      await f.tui.waitForOpen();
      assert.equal(f.tui.render().join("\n").includes("local tool output"), !initial);
      f.tui.send("\x03");
      assert.equal(await reopened, "discard");
    } finally {
      await f.dispose();
    }
  });
}

test("native tool result clicks expand one row and survive theme invalidation", async () => {
  const f = fixture();
  const calls = ["first.toml", "second.toml"].map((path) => ({
    type: "toolCall" as const,
    id: path,
    name: "read",
    arguments: { path },
  }));
  const assistant = await response(calls, "toolUse").result();
  try {
    await f.tui.waitForOpen();
    f.agent.state.messages.push(
      assistant,
      ...calls.map((call) => ({
        role: "toolResult" as const,
        toolCallId: call.id,
        toolName: "read",
        content: [{ type: "text" as const, text: `contents of ${call.id}` }],
        isError: false,
        timestamp: 0,
      })),
    );
    const before = f.tui.render();
    const row = before.findIndex((line) => line.includes("first.toml"));
    f.tui.mouse({ type: "click", x: 1, y: row });
    assert.match(f.tui.render().join("\n"), /contents of first.toml/u);
    assert.doesNotMatch(f.tui.render().join("\n"), /contents of second.toml/u);
    f.tui.invalidate();
    assert.match(f.tui.render().join("\n"), /contents of first.toml/u);
    assert.doesNotMatch(f.tui.render().join("\n"), /contents of second.toml/u);
    f.tui.send("\x0f");
    assert.match(f.tui.render().join("\n"), /contents of second.toml/u);
  } finally {
    await f.dispose();
  }
});

for (const appended of [1, 5, 30]) {
  test(`history keeps retained content stable after ${appended} message evictions`, async () => {
    const f = fixture();
    const message = (index: number) => ({
      role: "user" as const,
      content: Array.from({ length: 4 }, (_, row) => `message-${index}-row-${row}`).join("\n"),
      timestamp: index,
    });
    try {
      await f.tui.waitForOpen();
      f.agent.state.messages.push(...Array.from({ length: 30 }, (_, index) => message(index)));
      f.tui.render();
      f.tui.send("\x1b[5~");
      const older = f.tui.render();
      assert.doesNotMatch(older.join("\n"), /message-29-row-3/u);
      f.agent.state.messages.push(...Array.from({ length: appended }, (_, index) => message(30 + index)));
      const after = f.tui.render();
      if (appended < 30) assert.deepEqual(transcriptContent(after), transcriptContent(older));
      else {
        // The anchor itself is gone. Show the oldest retained message, not a later one.
        assert.match(after.join("\n"), /message-30-row-0/u);
        assert.doesNotMatch(after.join("\n"), /message-59-row-3/u);
      }
      for (let index = 0; index < 20; index++) {
        f.tui.send("\x1b[6~");
        f.tui.render();
      }
      assert.match(f.tui.render().join("\n"), new RegExp(`message-${29 + appended}-row-3`, "u"));
      f.agent.state.messages.push(message(30 + appended));
      assert.match(f.tui.render().join("\n"), new RegExp(`message-${30 + appended}-row-3`, "u"));
    } finally {
      await f.dispose();
    }
  });
}

test("history stays in the streaming response across updates and finalization", async () => {
  const stream = createAssistantMessageEventStream();
  const f = fixture(() => stream);
  const text = Array.from({ length: 120 }, (_, row) => `streaming-row-${row}`).join("\n");
  const partial = await response([{ type: "text", text }]).result();
  let updated = () => {};
  const unsubscribe = f.agent.subscribe((event) => {
    if (event.type === "message_update") updated();
  });
  const update = async (message: typeof partial) => {
    const ready = new Promise<void>((done) => {
      updated = done;
    });
    stream.push({ type: "text_delta", contentIndex: 0, delta: "more", partial: message });
    await ready;
  };
  try {
    await f.tui.waitForOpen();
    f.tui.type("Long response");
    f.tui.send("\r");
    stream.push({ type: "start", partial });
    await update(partial);
    f.tui.render();
    f.tui.send("\x1b[5~");
    const older = f.tui.render();
    assert.match(older.join("\n"), /streaming-row-/u);
    assert.doesNotMatch(older.join("\n"), /streaming-row-119/u);
    const next = { ...partial, content: [{ type: "text" as const, text: `${text}\nnew tail` }] };
    await update(next);
    assert.deepEqual(transcriptContent(f.tui.render()), transcriptContent(older));
    stream.push({ type: "done", reason: "stop", message: { ...next } });
    await f.tui.waitForPending();
    // The editor status changes at settlement; the transcript rows must not move.
    assert.deepEqual(transcriptContent(f.tui.render().slice(0, 20)), transcriptContent(older.slice(0, 20)));
    for (let index = 0; index < 10; index++) {
      f.tui.send("\x1b[6~");
      f.tui.render();
    }
    assert.match(f.tui.render().join("\n"), /new tail/u);
  } finally {
    stream.end(partial);
    unsubscribe();
    await f.dispose();
  }
});

test("editor border labels preserve native hidden-line indicators", () => {
  class NativeEditor extends Editor {
    borders(width: number, hidden: number) {
      return [this.renderTopBorder(width, hidden), this.renderBottomBorder(width, hidden)];
    }
  }
  class LabeledEditor extends SettingsChatEditor {
    borders(width: number, hidden: number) {
      return [this.renderTopBorder(width, hidden), this.renderBottomBorder(width, hidden)];
    }
  }
  const tui = { requestRender() {} } as ConstructorParameters<typeof Editor>[0];
  const theme = { fg: (_role: string, value: string) => value } as ConstructorParameters<typeof SettingsChatEditor>[1];
  const plain = (value: string) => value;
  const native = new NativeEditor(tui, {
    borderColor: plain,
    selectList: { selectedPrefix: plain, selectedText: plain, description: plain, scrollInfo: plain, noMatch: plain },
  });
  const labeled = new LabeledEditor(
    tui,
    theme,
    () => ({ top: "pi-starship", bottom: "Valid · unsaved" }),
    getKeybindings() as unknown as ConstructorParameters<typeof SettingsChatEditor>[3],
  );
  for (const width of [0, 1, 5, 80]) {
    for (const hidden of [1, 12, 100]) assert.deepEqual(labeled.borders(width, hidden), native.borders(width, hidden));
    assert.ok(labeled.borders(width, 0).every((line) => visibleWidth(line) <= width));
  }
});

test("fullscreen dock handles zero dimensions, callback theme changes, and read-only preview", async () => {
  const f = fixture();
  const roles: string[] = [];
  const dimLabels: string[] = [];
  type Options = Parameters<typeof createSettingsChatComponent>[0];
  const terminal = new FullscreenTerminal();
  terminal.rows = 40;
  const renderer = new TuiAltScreen(terminal);
  let previewLines = ["read-only footer"];
  const previewWidths: number[] = [];
  const component = createSettingsChatComponent({
    agent: f.agent,
    draft: f.draft,
    state: f.state,
    tui: renderer,
    theme: {
      fg: (role: string, value: string) => {
        roles.push(role);
        if (role === "dim") dimLabels.push(value);
        return value;
      },
      bold: (value: string) => value,
    } as Options["theme"],
    keybindings: getKeybindings() as unknown as Options["keybindings"],
    signal: f.controller.signal,
    preview: (width) => {
      previewWidths.push(width);
      return previewLines;
    },
    complete() {},
  });
  renderer.setLayoutRoot(component.getFullscreenLayout());
  renderer.start();
  const renderFrame = () => {
    renderer.renderNow(false);
    return renderer.getScreenLines().map((line) => stripVTControlCharacters(line).trimEnd());
  };
  try {
    await f.tui.waitForOpen();
    component.focused = true;
    assert.equal(component.focused, true);
    assert.deepEqual(component.render(0), []);
    const frame = renderFrame();
    assert.equal(frame.length, 40);
    assert.equal(frame.filter((line) => /^─+$/u.test(line)).length, 0);
    const previewRow = frame.findIndex((line) => line.includes("read-only footer"));
    assert.ok(!frame.some((line) => /─ Preview /u.test(line)));
    assert.equal(previewRow, frame.length - 1);
    assert.match(frame[previewRow - 3], /^─ pi-starship ─+$/u);
    assert.match(frame[previewRow - 1], /^─ Valid · unsaved · ctrl\+s to save profile · ctrl\+c to discard ─+$/u);
    assert.ok(dimLabels.some((label) => label.includes("pi-starship")));
    assert.ok(dimLabels.some((label) => label.includes("Valid · unsaved")));
    assert.ok(!frame.some((line) => line.includes("Active file unchanged")));
    assert.ok(previewWidths.every((width) => width === 80));
    assert.ok(roles.includes("borderMuted") && roles.includes("dim"));
    const calls = roles.length;
    component.invalidate();
    renderFrame();
    assert.ok(roles.length > calls);
    assert.ok(!frame.find((line) => line.includes("read-only footer"))?.includes("→"));
    previewLines = ["PREVIEW-FIRST", "\x1b[31mPREVIEW-SECOND 中文\x1b[39m"];
    for (const [rows, shown] of [
      [4, 0],
      [6, 2],
      [7, 2],
      [8, 2],
      [12, 2],
      [40, 2],
    ]) {
      terminal.rows = rows;
      const resized = renderFrame();
      assert.ok(resized.length <= rows);
      const start = resized.findIndex((line) => line.includes("PREVIEW-FIRST"));
      if (shown > 0) {
        assert.ok(start >= 0);
        assert.ok(!resized.some((line) => /─ Preview /u.test(line)));
        assert.equal(resized[start + 1], stripVTControlCharacters(previewLines[1]));
        assert.equal(start + shown, resized.length);
      } else {
        assert.equal(start, -1);
        assert.ok(!resized.some((line) => line.includes("PREVIEW-SECOND")));
      }
      assert.ok(component.render(80).some((line) => line.includes(CURSOR_MARKER)));
    }
    terminal.rows = 40;
    previewLines = ["ONE", "TWO", "THREE", "FOUR", "FIVE"];
    assert.deepEqual(renderFrame().slice(-5), previewLines);
    f.state.error = "Provider error\x1b]52;c;secret\x07";
    const failed = renderFrame();
    assert.match(failed.join("\n"), /─ Agent error · unsaved/u);
    assert.ok(failed.includes("Provider error"));
    assert.deepEqual(failed.slice(-5), previewLines);
    assert.ok(!failed.join("\n").includes("\x1b]52"));
    terminal.rows = 0;
    assert.deepEqual(component.render(80), []);
  } finally {
    component.dispose();
    renderer.stop({ preserveScreen: true });
    await component.waitForPending();
    await f.dispose();
  }
});

test("chat retains native editing, expanded paste, focus, bounded framing, and sanitized conversation", async () => {
  let submitted = "";
  const f = fixture((_model, context) => {
    const last = context.messages.at(-1);
    if (last?.role === "user")
      submitted =
        typeof last.content === "string"
          ? last.content
          : last.content.map((part) => (part.type === "text" ? part.text : "")).join("");
    return response([{ type: "text", text: "Safe reply\x1b]52;c;secret\x07" }]);
  });
  try {
    await f.tui.waitForOpen();
    assert.equal(f.overlayOptions.length, 1);
    assert.equal((f.overlayOptions[0] as { overlay?: boolean }).overlay, true);
    assert.equal(f.tui.isFocusable, true);
    f.tui.setFocused(true);
    assert.equal(f.tui.focused, true);
    assert.match(f.tui.render().join("\n"), /FOOTER PREVIEW/u);
    const previewRow = f.tui.render().findIndex((line) => line.includes("FOOTER PREVIEW"));
    f.tui.type("abc");
    f.tui.send("\x7f");
    const paste = "line\n".repeat(40);
    f.tui.send(`\x1b[200~${paste}\x1b[201~`);
    f.tui.send("\r");
    await f.tui.waitForPending();
    assert.equal(submitted, `ab${paste}`.trim());
    assert.ok(!submitted.includes("[paste #"));
    const frame = f.tui.render();
    assert.equal(frame.length, 32);
    assert.equal(
      frame.findIndex((line) => line.includes("FOOTER PREVIEW")),
      previewRow,
    );
    assert.ok(!frame.join("\n").includes("\x1b]52"));
    for (const rows of [4, 8, 24])
      for (const width of [1, 5, 80]) {
        f.tui.resize({ rows, width: Math.max(1, width) });
        const lines = f.tui.render(width);
        assert.ok(lines.length <= rows);
        assert.ok(lines.every((line) => visibleWidth(line) <= width));
        if (width > 5) assert.equal(f.tui.isFocusable, true);
      }
    f.tui.invalidate();
    f.tui.send("\x1b");
    assert.equal(f.tui.isOpen, true);
    f.tui.send("\x13");
    assert.equal(await f.running, "save");
    assert.equal(existsSync(join(f.root, "pi-starship.toml")), false);
  } finally {
    await f.dispose();
  }
});

test("fragmented paste never triggers cancellation and preserves the unsubmitted editor draft", async () => {
  const f = fixture();
  try {
    await f.tui.waitForOpen();
    f.tui.send("\x1b[200~hello");
    assert.ok(!f.tui.render().join("\n").includes("save profile"));
    f.tui.send("\x13");
    f.tui.send("\x03");
    f.tui.send("\x1b[201~");
    assert.equal(f.tui.isOpen, true);
    f.tui.send("\x1b");
    assert.equal(f.tui.isOpen, true);
    f.tui.send("\x13");
    assert.equal(await f.running, "save");
    assert.equal(f.state.input, "hello");
  } finally {
    await f.dispose();
  }
});

for (const exit of ["escape", "hard cancel", "disposal", "owner abort"] as const) {
  test(`active response cancels and settles on ${exit}`, async () => {
    let ready!: () => void;
    const started = new Promise<void>((done) => {
      ready = done;
    });
    let aborted = false;
    const f = fixture((_model, _context, options) => {
      const stream = createAssistantMessageEventStream();
      options?.signal?.addEventListener(
        "abort",
        () => {
          aborted = true;
          void response([], "aborted")
            .result()
            .then((error) => stream.push({ type: "error", reason: "aborted", error }));
        },
        { once: true },
      );
      ready();
      return stream;
    });
    try {
      await f.tui.waitForOpen();
      f.tui.type("Wait");
      f.tui.send("\r");
      await started;
      assert.match(f.tui.render().join("\n"), /Working · esc to interrupt/u);
      f.keys.setUserBindings({ "tui.altScreen.top": "escape" });
      assert.doesNotMatch(f.tui.render().join("\n"), /esc to interrupt/u);
      f.tui.send("\x1b");
      assert.equal(f.agent.state.isStreaming, true);
      f.keys.setUserBindings({ "tui.editor.historyPrevious": "escape" });
      assert.doesNotMatch(f.tui.render().join("\n"), /esc to interrupt/u);
      f.keys.setUserBindings({});
      f.tui.send("\x1b[200~");
      assert.doesNotMatch(f.tui.render().join("\n"), /esc to interrupt/u);
      f.tui.send("\x1b[201~");
      assert.match(f.tui.render().join("\n"), /Working · esc to interrupt/u);
      assert.ok(!f.tui.render().join("\n").includes("save profile"));
      f.tui.send("\x13");
      assert.equal(f.tui.isOpen, true);
      f.tui.type("steer while waiting");
      f.tui.send("\r");
      f.tui.type("follow up while waiting");
      f.tui.send("\x1b\r");
      assert.equal(f.agent.hasQueuedMessages(), true);
      if (exit === "escape") {
        f.tui.send("\x1b");
        await f.tui.waitForPending();
        assert.equal(f.tui.isOpen, true);
        f.tui.send("\x1b");
        assert.equal(f.tui.isOpen, true);
        f.tui.send("\x03");
      } else if (exit === "hard cancel") f.tui.send("\x03");
      else if (exit === "disposal") f.tui.dispose();
      else f.controller.abort();
      const result = await f.running;
      assert.equal(result, "discard");
      assert.equal(aborted, true);
      assert.equal(f.agent.state.isStreaming, false);
      assert.equal(f.agent.hasQueuedMessages(), false);
    } finally {
      await f.dispose();
    }
  });
}

for (const [name, bindings, kitty, expected, packet] of [
  ["default", {}, false, "ctrl+s", "\x13"],
  ["Kitty", {}, true, "ctrl+s", "\x1b[115;5u"],
  ["modifyOtherKeys", {}, false, "ctrl+s", "\x1b[27;5;115~"],
  ["submit collision", { "tui.input.submit": "ctrl+s" }, false, "f2", "\x1bOQ"],
  ["case alias", { "tui.input.submit": "CTRL+S" }, true, "f2", "\x1bOQ"],
  ["message collision", { "app.message.followUp": "ctrl+s" }, false, "f2", "\x1b[12~"],
  ["history collision", { "tui.editor.historyPrevious": "ctrl+s" }, false, "f2", "\x1bOQ"],
  ["cancel collision", { "tui.select.cancel": "ctrl+s" }, false, "f2", "\x1bOQ"],
  ["interrupt collision", { "app.interrupt": "ctrl+s" }, false, "f2", "\x1bOQ"],
  ["clipboard collision", { "app.clipboard.pasteImage": "ctrl+s" }, false, "f2", "\x1bOQ"],
  ["invalid configured key", { "tui.input.submit": "ctrl+" }, false, "ctrl+s", "\x13"],
  ["invalid modifier", { "app.message.followUp": "shift+f2" }, false, "ctrl+s", "\x13"],
  ["modifier order", { "app.message.followUp": "shift+ctrl+s" }, true, "ctrl+s", "\x1b[115;5u"],
  ["both reserved", { "tui.input.submit": "ctrl+s", "app.message.dequeue": "f2" }, false, undefined, "\x1bOQ"],
] as const) {
  test(`direct save hint is executable without replacing native actions: ${name}`, async () => {
    const previousKitty = isKittyProtocolActive();
    setKittyProtocolActive(kitty);
    const keys = new KeybindingsManager(CHAT_KEYS, bindings as never);
    const f = fixture(undefined, keys);
    try {
      await f.tui.waitForOpen();
      assert.equal(
        settingsChatSaveShortcut(keys as unknown as Parameters<typeof settingsChatSaveShortcut>[0]),
        expected,
      );
      const frame = f.tui.render().join("\n");
      if (!expected) {
        assert.ok(!frame.includes("save profile"));
        f.tui.send("\x03");
        assert.equal(await f.running, "discard");
      } else {
        assert.ok(frame.includes(`${expected} to save profile`));
        assert.equal(matchesKey(packet, expected), true);
        const paste = "line\n".repeat(40);
        f.tui.send(`\x1b[200~${paste}\x1b[201~`);
        f.tui.send(packet);
        assert.equal(await f.running, "save");
        assert.equal(f.state.input, paste);
      }
    } finally {
      await f.dispose();
      setKittyProtocolActive(previousKitty);
    }
  });
}

test("invalid drafts do not advertise or accept the save shortcut", async () => {
  const f = fixture();
  try {
    await f.tui.waitForOpen();
    await assert.rejects(
      f.draft.tools[1].execute("invalid", { path: f.draft.path, content: "format = [" }),
      /preview rejected/u,
    );
    assert.ok(!f.tui.render().join("\n").includes("save profile"));
    f.tui.send("\x13");
    assert.equal(f.tui.isOpen, true);
    f.tui.send("\x03");
    assert.equal(await f.running, "discard");
  } finally {
    await f.dispose();
  }
});

test("steering precedes tool continuation; follow-up waits for natural completion with a stable request prefix", async () => {
  const stream = createAssistantMessageEventStream();
  const requests: Parameters<NonNullable<ConstructorParameters<typeof Agent>[0]["streamFn"]>>[1][] = [];
  const pendingRows: string[] = [];
  let ready!: () => void;
  const started = new Promise<void>((done) => {
    ready = done;
  });
  const f = fixture((_model, context) => {
    requests.push(structuredClone(context));
    pendingRows.push(f.tui.render().join("\n"));
    if (requests.length === 1) {
      ready();
      return stream;
    }
    if (requests.length === 2)
      return response(
        [{ type: "toolCall", id: "second-read", name: "read", arguments: { path: f.draft.path } }],
        "toolUse",
      );
    return response([{ type: "text", text: "Done" }]);
  });
  const users = (index: number) =>
    requests[index].messages
      .filter((message) => message.role === "user")
      .map((message) =>
        typeof message.content === "string"
          ? message.content
          : message.content
              .filter((part) => part.type === "text")
              .map((part) => part.text)
              .join(""),
      );
  try {
    await f.tui.waitForOpen();
    f.tui.setFocused(true);
    f.tui.type("start");
    f.tui.send("\r");
    await started;
    // Duplicate content must remain in its own queue, not be removed by text matching.
    const text = "same\x1b]52;c;secret\x07";
    f.tui.type(text);
    f.tui.send("\x1b\r");
    f.tui.type(text);
    f.tui.send("\r");
    const queuedFrame = f.tui.render();
    assert.match(queuedFrame.join("\n"), /Steering: same/u);
    assert.match(queuedFrame.join("\n"), /Follow-up: same/u);
    assert.ok(!queuedFrame.join("\n").includes("\x1b]52"));
    assert.match(queuedFrame.at(-1) ?? "", /FOOTER PREVIEW/u);
    assert.match(queuedFrame.join("\n"), /2 queued/u);
    for (const rows of [4, 8, 32])
      for (const width of [1, 5, 80]) {
        f.tui.resize({ rows, width });
        const resized = f.tui.render(width);
        assert.ok(resized.length <= rows);
        assert.ok(resized.every((line) => visibleWidth(line) <= width));
        if (width === 80) assert.equal(f.tui.isFocusable, true);
      }
    f.tui.resize({ rows: 32, width: 80 });
    assert.equal(f.agent.state.messages.filter((message) => message.role === "user").length, 1);
    const first = await response(
      [{ type: "toolCall", id: "first-read", name: "read", arguments: { path: f.draft.path } }],
      "toolUse",
    ).result();
    stream.push({ type: "done", reason: "toolUse", message: first });
    await f.tui.waitForPending();
    assert.equal(requests.length, 4);
    assert.equal(users(1).length, 2);
    assert.equal(users(2).length, 2);
    assert.equal(users(3).length, 3);
    assert.equal(users(1).at(-1), text);
    assert.equal(users(3).at(-1), text);
    assert.ok(!pendingRows[1].includes("Steering:"));
    assert.ok(pendingRows[1].includes("Follow-up:"));
    assert.ok(!pendingRows[3].includes("Follow-up:"));
    assert.equal(f.agent.state.messages.filter((message) => message.role === "user").length, 3);
    for (const request of requests.slice(1)) {
      assert.deepEqual(request.messages.slice(0, requests[0].messages.length), requests[0].messages);
      assert.deepEqual(
        request.messages.filter((message) => message.role === "system"),
        requests[0].messages.filter((message) => message.role === "system"),
      );
    }
    assert.equal(f.agent.hasQueuedMessages(), false);
  } finally {
    stream.push({ type: "error", reason: "aborted", error: await response([], "aborted").result() });
    await f.dispose();
  }
});

for (const cancel of [false, true])
  for (const kind of ["steer", "followUp"] as const) {
    test(`${kind} queued during agent_end ${cancel ? "is retained on cancel" : "continues only after idle settlement"}`, async () => {
      let ended!: () => void;
      const ending = new Promise<void>((done) => {
        ended = done;
      });
      let release!: () => void;
      const gate = new Promise<void>((done) => {
        release = done;
      });
      let requests = 0;
      const f = fixture(() => {
        requests += 1;
        return response([{ type: "text", text: "Done" }]);
      });
      const unsubscribe = f.agent.subscribe(async (event) => {
        if (event.type === "agent_end" && requests === 1) {
          ended();
          await gate;
        }
      });
      try {
        await f.tui.waitForOpen();
        f.tui.type("first");
        f.tui.send("\r");
        await ending;
        assert.equal(f.agent.state.isStreaming, true);
        if (cancel) f.tui.send("\x1b");
        f.tui.type("late");
        f.tui.send(kind === "steer" ? "\r" : "\x1b\r");
        assert.equal(requests, 1);
        release();
        await f.tui.waitForPending();
        assert.equal(requests, cancel ? 1 : 2);
        assert.equal(f.agent.hasQueuedMessages(), false);
        f.tui.send("\x1b");
        assert.equal(f.tui.isOpen, true);
        f.tui.send("\x13");
        assert.equal(await f.running, "save");
        assert.equal(f.state.input, cancel ? "late" : "");
      } finally {
        release();
        unsubscribe();
        await f.dispose();
      }
    });
  }

for (const outcome of ["dequeue", "error", "aborted"] as const) {
  test(`${outcome} restores undelivered messages with expanded input and never auto-resumes`, async () => {
    const stream = createAssistantMessageEventStream();
    let requests = 0;
    let ready!: () => void;
    const started = new Promise<void>((done) => {
      ready = done;
    });
    const f = fixture(() => {
      requests += 1;
      ready();
      return stream;
    });
    try {
      await f.tui.waitForOpen();
      f.tui.type("first");
      f.tui.send("\r");
      await started;
      f.tui.type("later");
      f.tui.send("\x1b\r");
      f.tui.type("sooner");
      f.tui.send("\r");
      const paste = "line\n".repeat(40);
      f.tui.send(`\x1b[200~${paste}\x1b[201~`);
      if (outcome === "dequeue") f.tui.send("\x1b[1;3A");
      const message = await response(
        [{ type: "text", text: "Done" }],
        outcome === "dequeue" ? "stop" : outcome,
      ).result();
      stream.push({ type: "done", reason: message.stopReason as "stop", message });
      await f.tui.waitForPending();
      assert.equal(requests, 1);
      assert.equal(f.agent.hasQueuedMessages(), false);
      f.tui.send("\x1b");
      assert.equal(f.tui.isOpen, true);
      f.tui.send("\x13");
      assert.equal(await f.running, "save");
      assert.equal(f.state.input, `sooner\n\nlater\n\n${paste}`);
      assert.ok(!f.state.input.includes("[paste #"));
    } finally {
      stream.push({ type: "error", reason: "aborted", error: await response([], "aborted").result() });
      await f.dispose();
    }
  });
}

test("multiple steering and follow-up messages drain one at a time in priority order", async () => {
  const stream = createAssistantMessageEventStream();
  let ready!: () => void;
  const started = new Promise<void>((done) => {
    ready = done;
  });
  const seen: unknown[] = [];
  const largeFollowUp = "follow-one\n".repeat(40).trim();
  const keys = new KeybindingsManager(CHAT_KEYS, {
    "tui.input.submit": "ctrl+s",
    "app.message.followUp": "ctrl+alt+x",
  });
  const previousKitty = isKittyProtocolActive();
  setKittyProtocolActive(true);
  const f = fixture((_model, context) => {
    const last = context.messages.at(-1);
    seen.push(
      last?.role === "user"
        ? typeof last.content === "string"
          ? last.content
          : last.content
              .filter((part) => part.type === "text")
              .map((part) => part.text)
              .join("")
        : undefined,
    );
    if (seen.length === 1) {
      ready();
      return stream;
    }
    return response([{ type: "text", text: "Done" }]);
  }, keys);
  try {
    await f.tui.waitForOpen();
    f.tui.type("first");
    f.tui.send("\x13");
    await started;
    for (const [text, packet] of [
      [largeFollowUp, "\x1b[120;7u"],
      ["steer-one", "\x13"],
      ["follow-two", "\x1b[120;7u"],
      ["steer-two", "\x13"],
    ]) {
      if (text === largeFollowUp) f.tui.send(`\x1b[200~${text}\x1b[201~`);
      else f.tui.type(text);
      f.tui.send(packet);
    }
    assert.match(f.tui.render().join("\n"), /4 queued/u);
    const message = await response([{ type: "text", text: "Done" }]).result();
    stream.push({ type: "done", reason: "stop", message });
    await f.tui.waitForPending();
    assert.deepEqual(seen.slice(1), ["steer-one", "steer-two", largeFollowUp, "follow-two"]);
    assert.equal(f.agent.hasQueuedMessages(), false);
  } finally {
    stream.push({ type: "error", reason: "aborted", error: await response([], "aborted").result() });
    await f.dispose();
    setKittyProtocolActive(previousKitty);
  }
});

test("follow-up when idle submits normally, and fragmented paste never triggers message actions", async () => {
  const inputs: unknown[] = [];
  const f = fixture((_model, context) => {
    inputs.push(context.messages.at(-1)?.content);
    return response([{ type: "text", text: "Done" }]);
  });
  try {
    await f.tui.waitForOpen();
    f.tui.type("idle");
    f.tui.send("\x1b\r");
    await f.tui.waitForPending();
    assert.equal(inputs.length, 1);
    f.tui.send("\x1b[200~paste");
    f.tui.send("\x1b\r");
    f.tui.send("\x1b[1;3A");
    f.tui.send("\x1b[201~");
    assert.equal(inputs.length, 1);
    assert.equal(f.agent.hasQueuedMessages(), false);
    f.tui.send("\x1b");
    assert.equal(f.tui.isOpen, true);
    f.tui.send("\x13");
    assert.equal(await f.running, "save");
    assert.equal(f.state.input, "paste\n[1;3A");
  } finally {
    await f.dispose();
  }
});

for (const [name, configured, packet, kitty, follows, history] of [
  ["alias", "alt+return", "\x1b\r", false, true, false],
  ["Kitty legacy alt-enter is newline", "alt+enter", "\x1b\r", true, false, false],
  ["Kitty alt-enter", "alt+enter", "\x1b[13;3u", true, true, false],
  ["modifier order", "alt+ctrl+x", "\x1b[120;7u", true, true, false],
  ["case", "CTRL+ALT+X", "\x1b[120;7u", true, true, false],
  ["legacy tab collision", "ctrl+i", "\t", false, true, false],
  ["Kitty legacy tab", "ctrl+i", "\t", true, true, false],
  ["Kitty ctrl+i", "ctrl+i", "\x1b[105;5u", true, true, false],
  ["modifyOtherKeys", "ctrl+alt+x", "\x1b[27;7;120~", false, true, false],
  ["explicit history priority", "alt+enter", "\x1b\r", false, false, true],
  ["invalid binding", "ctrl+", "\x1b\r", false, false, false],
  ["disabled action", [], "\x1b\r", false, false, false],
  ["first usable alternative", ["ctrl+", "ctrl+alt+x"], "\x1b[120;7u", true, true, false],
] as const) {
  test(`message shortcuts match native CustomEditor for ${name}`, () => {
    const previous = getKeybindings();
    const previousKitty = isKittyProtocolActive();
    const keys = new KeybindingsManager(CHAT_KEYS, {
      "app.message.followUp": configured as never,
      ...(history ? { "tui.editor.historyPrevious": "alt+enter" as const } : {}),
    });
    setKeybindings(keys);
    setKittyProtocolActive(kitty);
    try {
      const tui = { requestRender() {} } as ConstructorParameters<typeof Editor>[0];
      const plain = (value: string) => value;
      const theme = {
        borderColor: plain,
        selectList: {
          selectedPrefix: plain,
          selectedText: plain,
          description: plain,
          scrollInfo: plain,
          noMatch: plain,
        },
      };
      const native = new CustomEditor(tui, theme, keys as unknown as ConstructorParameters<typeof CustomEditor>[2]);
      const labeled = new SettingsChatEditor(
        tui,
        { fg: (_role: string, value: string) => value } as ConstructorParameters<typeof SettingsChatEditor>[1],
        () => ({ top: "pi-starship", bottom: "unsaved" }),
        keys as unknown as ConstructorParameters<typeof SettingsChatEditor>[3],
      );
      const calls = [0, 0];
      for (const [index, editor] of [native, labeled].entries()) {
        editor.setText("input");
        editor.onAction("app.message.followUp", () => {
          calls[index] += 1;
        });
        editor.handleInput(packet);
      }
      assert.deepEqual(calls, [Number(follows), Number(follows)]);
      assert.equal(labeled.getExpandedText(), native.getExpandedText());
    } finally {
      setKeybindings(previous);
      setKittyProtocolActive(previousKitty);
    }
  });
}

for (const [name, configured, packet, kitty, expected] of [
  ["alias", "esc", "\x1b", false, true],
  ["plain text collision", "x", "x", false, false],
  ["Kitty text collision", "x", "\x1b[120u", true, false],
  ["modifyOtherKeys text collision", "shift+x", "\x1b[27;2;120~", false, false],
  ["native shift delete", "shift+delete", "\x1b[3;2~", false, false],
  ["native alt enter", "alt+enter", "\x1b\r", false, false],
  ["native LF newline", "ctrl+j", "\n", false, false],
  ["modifier order", "alt+ctrl+x", "\x1b[120;7u", true, true],
  ["case", "CTRL+ALT+X", "\x1b[120;7u", true, true],
  ["legacy tab collision", "ctrl+i", "\t", false, false],
  ["legacy return collision", "ctrl+m", "\r", false, false],
  ["Kitty distinct ctrl+i", "ctrl+i", "\x1b[105;5u", true, true],
  ["invalid configured string", "ctrl+", "\x1b", false, true],
  ["invalid modifier", "shift+escape", "\x1b", true, true],
  ["first usable fallback", "ctrl+h", "\x1b", false, true],
  ["preserve delete", "ctrl+h", "\x08", false, false],
] as const) {
  test(`stop key respects ${name}`, () => {
    const previous = getKeybindings();
    const previousKitty = isKittyProtocolActive();
    const keys = new KeybindingsManager(TUI_KEYBINDINGS, { "tui.select.cancel": configured as never });
    setKeybindings(keys);
    setKittyProtocolActive(kitty);
    try {
      assert.equal(settingsChatStopInput(packet, keys), expected);
    } finally {
      setKeybindings(previous);
      setKittyProtocolActive(previousKitty);
    }
  });
}
