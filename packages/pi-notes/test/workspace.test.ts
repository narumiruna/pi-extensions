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
  visibleWidth,
} from "@earendil-works/pi-tui";
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

function createFakeChild(options: { messages?: unknown[]; onPrompt?(text: string): Promise<void> } = {}) {
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
      promptOptions?.preflightResult?.(true);
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

test("workspace renders bounded wide and narrow layouts, sanitizes text, and hard-cancels cleanly", async () => {
  const { agentDir, storage } = await fixture(
    `# Heading\n\nUnsafe \u001b]52;c;QQ==\u0007 preview\n${"line\n".repeat(30)}`,
  );
  const fake = createFakeChild({
    messages: [
      { role: "user", content: "Earlier question" },
      { role: "assistant", content: [{ type: "text", text: "Unsafe \u001b[31m answer" }] },
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
    dependencies: { createChildSession: async () => fake.child },
  });
  await tui.waitForOpen();
  await tui.waitForPending();
  tui.setFocused(true);

  const wide = tui.render();
  const wideText = stripVTControlCharacters(wide.join("\n"));
  assert.match(wideText, /Chat · Ready · new note conversation/u);
  assert.match(wideText, /Preview ·/u);
  assert.equal(wide.join("\n").includes("\u001b]52"), false);
  assert.ok(wide.every((line) => visibleWidth(line) <= 120));
  assert.equal(wide.join("\n").includes(CURSOR_MARKER), true, "chat editor receives focus");

  const narrowChat = tui.resize({ width: 60, rows: 16 });
  assert.match(stripVTControlCharacters(narrowChat.join("\n")), /Chat · Ready/u);
  tui.press("tui.input.tab");
  const narrowPreview = tui.render();
  assert.match(stripVTControlCharacters(narrowPreview.join("\n")), /Preview ·/u);
  assert.equal(narrowPreview.join("\n").includes(CURSOR_MARKER), false, "read-only preview has no cursor");
  tui.press("tui.select.pageDown");
  for (const size of [
    { width: 24, rows: 8 },
    { width: 8, rows: 5 },
    { width: 1, rows: 1 },
  ]) {
    const lines = tui.resize(size);
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
