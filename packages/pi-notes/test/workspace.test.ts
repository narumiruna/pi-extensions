import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import {
  CURSOR_MARKER,
  getKeybindings,
  type KeybindingsConfig,
  KeybindingsManager,
  setKeybindings,
  TUI_KEYBINDINGS,
  truncateToWidth,
  visibleWidth,
} from "@earendil-works/pi-tui";
import { runCustomInteraction } from "@narumitw/pi-tui-kit/custom-interaction";
import { createTuiHarness } from "@narumitw/pi-tui-kit/testing";
import { afterEach, test } from "vitest";
import { createMockContext } from "../../../test/support.js";
import type { NotesChildSession } from "../src/child-session.js";
import { NotesStorage } from "../src/storage.js";
import { openNotesWorkspace } from "../src/workspace.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(content = "# Note\n\nPreview text\n") {
  const root = await mkdtemp(join(tmpdir(), "pi-notes-workspace-"));
  roots.push(root);
  const agentDir = join(root, "agent");
  const storage = new NotesStorage(agentDir);
  await storage.initialize();
  await writeFile(join(storage.paths.notes, "current.md"), content, "utf8");
  return { agentDir, storage };
}

interface FakeEvent {
  type: string;
  toolName?: string;
}

interface FakePromptOptions {
  preflightResult?(accepted: boolean): void;
}

function createFakeChild(
  options: {
    messages?: unknown[];
    onPreflight?(text: string): boolean | Promise<boolean>;
    onPrompt?(text: string): Promise<void>;
  } = {},
) {
  const listeners = new Set<(event: FakeEvent) => void>();
  const messages = options.messages ?? [];
  const state: { streamingMessage?: unknown } = {};
  const stats = { aborts: 0, disposals: 0, prompts: [] as string[] };
  let streaming = false;
  const emit = (event: FakeEvent) => {
    for (const listener of listeners) listener(event);
  };
  const session = {
    messages,
    state,
    get isStreaming() {
      return streaming;
    },
    subscribe(listener: (event: FakeEvent) => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async prompt(text: string, promptOptions?: FakePromptOptions) {
      stats.prompts.push(text);
      const accepted = (await options.onPreflight?.(text)) ?? true;
      promptOptions?.preflightResult?.(accepted);
      if (!accepted) throw new Error("prompt preflight rejected");
      streaming = true;
      messages.push({ role: "user", content: text });
      state.streamingMessage = { role: "assistant", content: [{ type: "text", text: "Streaming response" }] };
      emit({ type: "agent_start" });
      emit({ type: "message_update" });
      try {
        await options.onPrompt?.(text);
        messages.push({ role: "assistant", content: [{ type: "text", text: "Finished response" }] });
      } finally {
        state.streamingMessage = undefined;
        streaming = false;
        emit({ type: "agent_settled" });
      }
    },
    async abort() {
      stats.aborts += 1;
      streaming = false;
    },
    dispose() {
      stats.disposals += 1;
      listeners.clear();
    },
  };
  return {
    child: { session: session as never, resumed: false } satisfies NotesChildSession,
    emit,
    stats,
  };
}

function workspaceContext(tui: ReturnType<typeof createTuiHarness>, editorText = "parent draft") {
  return createMockContext({
    mode: "tui",
    hasUI: true,
    custom: tui.custom,
    editorText,
    model: { provider: "test", id: "test", api: "test" },
  });
}

function widePaneText(lines: readonly string[]): { chat: string; preview: string } {
  const panes = lines
    .slice(1, -1)
    .map((line) => stripVTControlCharacters(line).split(" │ "))
    .filter((columns) => columns.length === 2);
  return {
    chat: panes.map(([chat]) => chat).join("\n"),
    preview: panes.map(([, preview]) => preview).join("\n"),
  };
}

test("workspace renders bounded wide and narrow layouts, sanitizes text, and hard-cancels cleanly", async () => {
  const { agentDir, storage } = await fixture(
    `# Heading\n\nUnsafe \u001b]52;c;QQ==\u0007 preview\n${"line\n".repeat(30)}`,
  );
  const fake = createFakeChild({
    messages: [
      { role: "user", content: "Earlier question" },
      {
        role: "assistant",
        content: [{ type: "text", text: `Unsafe \u001b[31m answer\n${"chat line\n".repeat(40)}` }],
      },
    ],
  });
  const keybindings = new KeybindingsManager(TUI_KEYBINDINGS, { "tui.select.cancel": "ctrl+x" });
  const tui = createTuiHarness({ width: 120, rows: 24, keybindings });
  const context = workspaceContext(tui);
  const controller = new AbortController();
  const running = openNotesWorkspace({
    ctx: context.ctx,
    agentDir,
    storage,
    notePath: "current.md",
    thinkingLevel: "off",
    signal: controller.signal,
    isCurrent: () => true,
    dependencies: { createChildSession: async () => fake.child, runInteraction: runCustomInteraction },
  });
  await tui.waitForOpen();
  await tui.waitForPending();
  tui.setFocused(true);

  const wide = tui.render();
  const wideText = stripVTControlCharacters(wide.join("\n"));
  assert.equal(stripVTControlCharacters(wide[0] ?? ""), "current.md");
  assert.match(wideText, /Chat · Ready · new note conversation/u);
  assert.match(wideText, /Preview ·/u);
  assert.equal(wide.join("\n").includes("\u001b]52"), false);
  assert.ok(wide.every((line) => visibleWidth(line) <= 120));
  assert.equal(wide.join("\n").includes(CURSOR_MARKER), true, "chat editor receives focus");

  const beforeChatWheel = widePaneText(wide);
  const afterChatWheel = widePaneText(tui.mouse({ type: "wheel", x: 2, y: 5, wheelDelta: -3 }));
  assert.notEqual(afterChatWheel.chat, beforeChatWheel.chat, "wheel over Chat scrolls its transcript");
  assert.equal(afterChatWheel.preview, beforeChatWheel.preview, "Chat wheel leaves Preview fixed");
  const afterPreviewWheel = widePaneText(tui.mouse({ type: "wheel", x: 110, y: 5, wheelDelta: 3 }));
  assert.equal(afterPreviewWheel.chat, afterChatWheel.chat, "Preview wheel leaves Chat fixed");
  assert.notEqual(afterPreviewWheel.preview, afterChatWheel.preview, "wheel over Preview scrolls the note");

  const narrowChat = tui.resize({ width: 60, rows: 16 });
  assert.equal(stripVTControlCharacters(narrowChat[0] ?? ""), "current.md");
  assert.match(stripVTControlCharacters(narrowChat.join("\n")), /Chat · Ready/u);
  tui.press("tui.input.tab");
  const narrowPreview = tui.render();
  assert.match(stripVTControlCharacters(narrowPreview.join("\n")), /Preview ·/u);
  assert.equal(narrowPreview.join("\n").includes(CURSOR_MARKER), false, "read-only preview has no cursor");
  const narrowAfterWheel = tui.mouse({ type: "wheel", x: 2, y: 5, wheelDelta: -3 });
  assert.notEqual(narrowAfterWheel.join("\n"), narrowPreview.join("\n"), "narrow view scrolls its active pane");
  tui.press("tui.select.pageDown");
  for (const size of [
    { width: 24, rows: 8 },
    { width: 8, rows: 5 },
    { width: 1, rows: 1 },
  ]) {
    const lines = tui.resize(size);
    assert.equal(
      stripVTControlCharacters(lines[0] ?? ""),
      stripVTControlCharacters(truncateToWidth("current.md", size.width)),
    );
    assert.ok(lines.length <= Math.max(1, size.rows - 4));
    assert.ok(lines.every((line) => visibleWidth(line) <= size.width));
  }

  tui.press("ctrl+c");
  await running;
  assert.equal(fake.stats.aborts, 1);
  assert.equal(fake.stats.disposals, 1);
  const parentUi = (
    context.ctx as unknown as {
      ui: { getEditorText(): string; setEditorText(value: string): void };
    }
  ).ui;
  assert.equal(parentUi.getEditorText(), "parent draft");
  parentUi.setEditorText("first parent input after close");
  assert.equal(parentUi.getEditorText(), "first parent input after close");
});

test("workspace preserves remapped editing, newline, paste, streaming, preview refresh, and normal close", async (t) => {
  const previousKeybindings = getKeybindings();
  t.onTestFinished(() => setKeybindings(previousKeybindings));
  const bindings = {
    "tui.input.newLine": "alt+enter",
    "tui.input.submit": "ctrl+s",
    "tui.input.tab": "ctrl+q",
    "tui.select.pageDown": "ctrl+n",
    "tui.select.cancel": "ctrl+x",
  } satisfies KeybindingsConfig;
  const keybindings = new KeybindingsManager(TUI_KEYBINDINGS, bindings);
  setKeybindings(keybindings);

  const { agentDir, storage } = await fixture(`# Original\n\n${"scroll line\n".repeat(40)}`);
  let noteChanged: ((snapshot: Awaited<ReturnType<NotesStorage["readNote"]>>) => void) | undefined;
  let releasePrompt!: () => void;
  let signalPromptStarted!: () => void;
  const promptStarted = new Promise<void>((resolve) => {
    signalPromptStarted = resolve;
  });
  const promptRelease = new Promise<void>((resolve) => {
    releasePrompt = resolve;
  });
  const fake = createFakeChild({
    onPrompt: async () => {
      const current = await storage.readNote("current.md");
      const changed = await storage.replaceNote("current.md", current.revision, "# Updated\n\nFresh preview\n");
      noteChanged?.(changed);
      signalPromptStarted();
      await promptRelease;
    },
  });
  const tui = createTuiHarness({ width: 70, rows: 18, keybindings });
  const context = workspaceContext(tui);
  const running = openNotesWorkspace({
    ctx: context.ctx,
    agentDir,
    storage,
    notePath: "current.md",
    thinkingLevel: "off",
    signal: new AbortController().signal,
    isCurrent: () => true,
    dependencies: {
      runInteraction: runCustomInteraction,
      createChildSession: async (options) => {
        noteChanged = options.onNoteChanged;
        return fake.child;
      },
    },
  });
  await tui.waitForOpen();
  await tui.waitForPending();
  tui.setFocused(true);

  tui.type("wrongx");
  tui.send("\u007f");
  tui.send("\u001b\r");
  tui.type("second");
  tui.send("\u001b[200~ pasted\t\u0003text \u001b[201~");
  assert.equal(tui.isOpen, true, "paste payload shortcuts must not close or switch the workspace");
  assert.match(stripVTControlCharacters(tui.render().join("\n")), /wrong\s*\nsecond/u);
  tui.send("\u0013");
  await promptStarted;

  const streaming = stripVTControlCharacters(tui.render().join("\n"));
  assert.match(streaming, /Agent is working/u);
  assert.match(streaming, /Streaming response/u);
  assert.match(fake.stats.prompts[0] ?? "", /wrong\nsecond/u);
  assert.match(fake.stats.prompts[0] ?? "", /pasted/u);

  releasePrompt();
  await tui.waitForPending();
  tui.send("\u0011");
  const preview = stripVTControlCharacters(tui.render().join("\n"));
  assert.match(preview, /Preview ·/u);
  assert.match(preview, /Updated|Fresh preview/u);
  tui.send("\u000e");
  assert.equal(tui.isOpen, true);
  tui.send("\u0018");
  await running;
  assert.equal(fake.stats.aborts, 1);
  assert.equal(fake.stats.disposals, 1);
});

test("workspace gives editor actions priority over colliding cancel bindings", async (t) => {
  const previousKeybindings = getKeybindings();
  t.onTestFinished(() => setKeybindings(previousKeybindings));
  const bindings = {
    "tui.select.cancel": [
      "backspace",
      "shift+backspace",
      "shift+delete",
      "shift+space",
      "enter",
      "alt+enter",
      "shift+enter",
      "ctrl+j",
    ],
    "tui.input.newLine": "ctrl+n",
  } satisfies KeybindingsConfig;
  const keybindings = new KeybindingsManager(TUI_KEYBINDINGS, bindings);
  setKeybindings(keybindings);

  const { agentDir, storage } = await fixture();
  const fake = createFakeChild();
  const tui = createTuiHarness({ width: 100, rows: 24, keybindings });
  const running = openNotesWorkspace({
    ctx: workspaceContext(tui).ctx,
    agentDir,
    storage,
    notePath: "current.md",
    thinkingLevel: "off",
    signal: new AbortController().signal,
    isCurrent: () => true,
    dependencies: { createChildSession: async () => fake.child, runInteraction: runCustomInteraction },
  });
  await tui.waitForOpen();
  await tui.waitForPending();
  tui.setFocused(true);

  tui.type("wrongxy");
  tui.send("\u007f");
  tui.send("\u001b[127;2u");
  tui.send("\u001b[32;2u");
  tui.type("x");
  tui.send("\u001b[D");
  tui.send("\u001b[3;2~");
  tui.send("\u007f");
  tui.send("\u001b\r");
  tui.type("second");
  tui.send("\u001b[13;2~");
  tui.type("third");
  tui.send("\n");
  tui.type("fourth");
  tui.send("\r");
  await tui.waitForPending();

  assert.deepEqual(fake.stats.prompts, ["wrong\nsecond\nthird\nfourth"]);
  assert.equal(tui.isOpen, true, "editor collisions must not close the workspace");
  tui.press("ctrl+c");
  await running;
  assert.equal(fake.stats.aborts, 1);
  assert.equal(fake.stats.disposals, 1);
});

test("workspace gives printable input priority over colliding screen shortcuts", async (t) => {
  const previousKeybindings = getKeybindings();
  t.onTestFinished(() => setKeybindings(previousKeybindings));
  const bindings = {
    "tui.select.cancel": "x",
    "tui.select.pageDown": "y",
    "tui.select.pageUp": "shift+x",
  } satisfies KeybindingsConfig;
  const keybindings = new KeybindingsManager(TUI_KEYBINDINGS, bindings);
  setKeybindings(keybindings);

  const { agentDir, storage } = await fixture();
  const fake = createFakeChild();
  const tui = createTuiHarness({ width: 100, rows: 24, keybindings });
  const running = openNotesWorkspace({
    ctx: workspaceContext(tui).ctx,
    agentDir,
    storage,
    notePath: "current.md",
    thinkingLevel: "off",
    signal: new AbortController().signal,
    isCurrent: () => true,
    dependencies: { createChildSession: async () => fake.child, runInteraction: runCustomInteraction },
  });
  await tui.waitForOpen();
  await tui.waitForPending();
  tui.setFocused(true);

  tui.send("x");
  tui.send("y");
  tui.send("\u001b[120u");
  tui.send("\u001b[121u");
  tui.send("\u001b[27;2;88~");
  tui.send("\r");
  await tui.waitForPending();

  assert.deepEqual(fake.stats.prompts, ["xyxyX"]);
  assert.equal(tui.isOpen, true, "printable collisions must not close or scroll the workspace");
  tui.press("ctrl+c");
  await running;
  assert.equal(fake.stats.aborts, 1);
  assert.equal(fake.stats.disposals, 1);
});

test("workspace gives default page navigation to the focused multiline editor", async (t) => {
  const previousKeybindings = getKeybindings();
  t.onTestFinished(() => setKeybindings(previousKeybindings));
  const keybindings = new KeybindingsManager(TUI_KEYBINDINGS);
  setKeybindings(keybindings);

  const { agentDir, storage } = await fixture();
  const fake = createFakeChild();
  const tui = createTuiHarness({ width: 100, rows: 24, keybindings });
  const running = openNotesWorkspace({
    ctx: workspaceContext(tui).ctx,
    agentDir,
    storage,
    notePath: "current.md",
    thinkingLevel: "off",
    signal: new AbortController().signal,
    isCurrent: () => true,
    dependencies: { createChildSession: async () => fake.child, runInteraction: runCustomInteraction },
  });
  await tui.waitForOpen();
  await tui.waitForPending();
  tui.setFocused(true);

  for (let index = 0; index < 30; index += 1) {
    tui.type(`line ${index}`);
    if (index < 29) tui.send("\u001b\r");
  }
  tui.press("tui.select.pageUp");
  tui.type("X");
  tui.press("tui.input.submit");
  await tui.waitForPending();

  const [prompt] = fake.stats.prompts;
  assert.ok(prompt?.includes("X"));
  assert.equal(prompt?.endsWith("X"), false, "PageUp must move the draft cursor before insertion");
  tui.press("ctrl+c");
  await running;
  assert.equal(fake.stats.aborts, 1);
  assert.equal(fake.stats.disposals, 1);
});

test("workspace gives configured submit priority over a colliding pane-switch key", async (t) => {
  const previousKeybindings = getKeybindings();
  t.onTestFinished(() => setKeybindings(previousKeybindings));
  const bindings = {
    "tui.input.submit": "tab",
    "tui.input.tab": ["tab", "ctrl+q"],
    "tui.select.cancel": "ctrl+x",
  } satisfies KeybindingsConfig;
  const keybindings = new KeybindingsManager(TUI_KEYBINDINGS, bindings);
  setKeybindings(keybindings);

  const { agentDir, storage } = await fixture();
  const fake = createFakeChild();
  const tui = createTuiHarness({ width: 60, rows: 18, keybindings });
  const running = openNotesWorkspace({
    ctx: workspaceContext(tui).ctx,
    agentDir,
    storage,
    notePath: "current.md",
    thinkingLevel: "off",
    signal: new AbortController().signal,
    isCurrent: () => true,
    dependencies: { createChildSession: async () => fake.child, runInteraction: runCustomInteraction },
  });
  await tui.waitForOpen();
  await tui.waitForPending();
  tui.setFocused(true);

  tui.type("submit with tab");
  tui.send("\t");
  await tui.waitForPending();

  assert.deepEqual(fake.stats.prompts, ["submit with tab"]);
  assert.match(stripVTControlCharacters(tui.render().join("\n")), /Chat · Ready/u);
  tui.send("\u0011");
  assert.match(stripVTControlCharacters(tui.render().join("\n")), /Preview ·/u);
  tui.press("ctrl+c");
  await running;
  assert.equal(fake.stats.aborts, 1);
  assert.equal(fake.stats.disposals, 1);
});

test("workspace preserves a new draft while accepted prompt preflight is pending", async () => {
  const { agentDir, storage } = await fixture();
  let releasePreflight!: () => void;
  let signalPreflightStarted!: () => void;
  const preflightStarted = new Promise<void>((resolve) => {
    signalPreflightStarted = resolve;
  });
  const preflightRelease = new Promise<void>((resolve) => {
    releasePreflight = resolve;
  });
  const fake = createFakeChild({
    onPreflight: async () => {
      signalPreflightStarted();
      await preflightRelease;
      return true;
    },
  });
  const tui = createTuiHarness({ width: 100, rows: 24 });
  const running = openNotesWorkspace({
    ctx: workspaceContext(tui).ctx,
    agentDir,
    storage,
    notePath: "current.md",
    thinkingLevel: "off",
    signal: new AbortController().signal,
    isCurrent: () => true,
    dependencies: { createChildSession: async () => fake.child, runInteraction: runCustomInteraction },
  });
  await tui.waitForOpen();
  await tui.waitForPending();
  tui.setFocused(true);

  tui.type("submitted message");
  tui.press("tui.input.submit");
  await preflightStarted;
  tui.type("new draft");
  releasePreflight();
  await tui.waitForPending();

  assert.match(stripVTControlCharacters(tui.render().join("\n")), /new draft/u);
  tui.press("tui.select.cancel");
  await running;
});

for (const cancellation of ["hard-cancel", "upstream cancellation"] as const) {
  test(`workspace ${cancellation} does not wait for unresolved prompt preflight`, async () => {
    const { agentDir, storage } = await fixture();
    let signalPreflightStarted!: () => void;
    const preflightStarted = new Promise<void>((resolve) => {
      signalPreflightStarted = resolve;
    });
    const fake = createFakeChild({
      onPreflight: async () => {
        signalPreflightStarted();
        return await new Promise<boolean>(() => {});
      },
    });
    const controller = new AbortController();
    const tui = createTuiHarness({ width: 100, rows: 24 });
    const running = openNotesWorkspace({
      ctx: workspaceContext(tui).ctx,
      agentDir,
      storage,
      notePath: "current.md",
      thinkingLevel: "off",
      signal: controller.signal,
      isCurrent: () => true,
      dependencies: { createChildSession: async () => fake.child, runInteraction: runCustomInteraction },
    });
    await tui.waitForOpen();
    await tui.waitForPending();
    tui.setFocused(true);

    tui.type("pending authentication");
    tui.press("tui.input.submit");
    await preflightStarted;
    if (cancellation === "hard-cancel") tui.press("ctrl+c");
    else controller.abort(new DOMException("session replaced", "AbortError"));
    await running;

    assert.equal(fake.stats.aborts, 1);
    assert.equal(fake.stats.disposals, 1);
  });
}

test("workspace restores a rejected prompt before a draft typed during preflight", async () => {
  const { agentDir, storage } = await fixture();
  let releasePreflight!: () => void;
  let signalPreflightStarted!: () => void;
  const preflightStarted = new Promise<void>((resolve) => {
    signalPreflightStarted = resolve;
  });
  const preflightRelease = new Promise<void>((resolve) => {
    releasePreflight = resolve;
  });
  const fake = createFakeChild({
    onPreflight: async () => {
      signalPreflightStarted();
      await preflightRelease;
      return false;
    },
  });
  const tui = createTuiHarness({ width: 100, rows: 24 });
  const running = openNotesWorkspace({
    ctx: workspaceContext(tui).ctx,
    agentDir,
    storage,
    notePath: "current.md",
    thinkingLevel: "off",
    signal: new AbortController().signal,
    isCurrent: () => true,
    dependencies: { createChildSession: async () => fake.child, runInteraction: runCustomInteraction },
  });
  await tui.waitForOpen();
  await tui.waitForPending();
  tui.setFocused(true);

  tui.type("rejected message");
  tui.press("tui.input.submit");
  await preflightStarted;
  tui.type("newer draft");
  releasePreflight();
  await tui.waitForPending();

  const frame = stripVTControlCharacters(tui.render().join("\n"));
  assert.match(frame, /rejected message/u);
  assert.match(frame, /newer draft/u);
  assert.match(frame, /prompt preflight rejected/u);
  tui.press("tui.select.cancel");
  await running;
});

test("workspace disposes a child that arrives after component disposal", async () => {
  const { agentDir, storage } = await fixture();
  const fake = createFakeChild();
  let releaseChild!: () => void;
  let signalFactoryStarted!: () => void;
  const factoryStarted = new Promise<void>((resolve) => {
    signalFactoryStarted = resolve;
  });
  const childRelease = new Promise<void>((resolve) => {
    releaseChild = resolve;
  });
  const tui = createTuiHarness();
  const context = workspaceContext(tui);
  const running = openNotesWorkspace({
    ctx: context.ctx,
    agentDir,
    storage,
    notePath: "current.md",
    thinkingLevel: "off",
    signal: new AbortController().signal,
    isCurrent: () => true,
    dependencies: {
      runInteraction: runCustomInteraction,
      createChildSession: async () => {
        signalFactoryStarted();
        await childRelease;
        return fake.child;
      },
    },
  });
  await tui.waitForOpen();
  await factoryStarted;
  tui.dispose();
  releaseChild();
  await running;
  assert.equal(fake.stats.disposals, 1);
});

test("workspace reports child startup failure without losing a working close path", async () => {
  const { agentDir, storage } = await fixture("");
  const tui = createTuiHarness();
  const context = workspaceContext(tui);
  const running = openNotesWorkspace({
    ctx: context.ctx,
    agentDir,
    storage,
    notePath: "current.md",
    thinkingLevel: "off",
    signal: new AbortController().signal,
    isCurrent: () => true,
    dependencies: {
      runInteraction: runCustomInteraction,
      createChildSession: async () => {
        throw new Error("selected model is unavailable");
      },
    },
  });
  await tui.waitForOpen();
  await tui.waitForPending();
  const frame = stripVTControlCharacters(tui.render().join("\n"));
  assert.match(frame, /Unavailable/u);
  assert.match(frame, /selected model is unavailable/u);
  assert.match(frame, /\(Empty note\)/u);
  tui.press("tui.select.cancel");
  await running;
});
