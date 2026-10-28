import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import type { Api, AssistantMessage, Context, Model } from "@earendil-works/pi-ai";
import { type ExtensionCommandContext, initTheme, SessionManager } from "@earendil-works/pi-coding-agent";
import { CURSOR_MARKER, KeybindingsManager, TUI_KEYBINDINGS, visibleWidth } from "@earendil-works/pi-tui";
import { createTuiHarness } from "@narumitw/pi-tui-kit/testing";
import { test } from "vitest";
import { buildQuickBringToMainSegments } from "../src/bring-to-main.js";
import { runBtwThread } from "../src/btw.js";
import { importMainUpdates, showMainUpdatePreview } from "../src/import-main-updates.js";
import { buildMainContextSnapshot, captureMainContextSource } from "../src/main-context-snapshot.js";
import {
  appendMainContextUpdate,
  buildSideThreadMessages,
  completeSideThreadTurn,
  createSideThread,
  sideTranscript,
} from "../src/side-thread.js";
import { BtwAnsweringView, BtwTranscriptPager, formatSideTranscript } from "../src/transcript-pager.js";

function required<T>(value: T | undefined | null): T {
  assert.ok(value !== undefined && value !== null);
  return value;
}

function answer(text: string): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    stopReason: "stop",
    timestamp: 1,
    api: "anthropic-messages",
    provider: "test",
    model: "side",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  };
}
function fixture() {
  const manager = SessionManager.inMemory();
  manager.appendMessage({ role: "user", content: "A-B", timestamp: 1 });
  const source = captureMainContextSource(manager);
  const thread = createSideThread(source.conversationContext, source.anchor);
  const notifications: string[] = [];
  const controller = new AbortController();
  const ctx = {
    mode: "tui",
    hasUI: true,
    sessionManager: manager,
    signal: controller.signal,
    ui: { notify: (message: string) => notifications.push(message) },
  } as unknown as ExtensionCommandContext;
  const add = (text = "C-D") => manager.appendMessage({ role: "user", content: text, timestamp: 1 });
  return { manager, thread, ctx, notifications, controller, add };
}

const model = { provider: "test", id: "side", api: "anthropic-messages", reasoning: false } as Model<Api>;

function text(messages: ReturnType<typeof buildSideThreadMessages>) {
  return JSON.stringify(messages.map((message) => message.content));
}

test("main progress alone does not alter side requests; confirmed imports follow X and precede Y", async () => {
  const f = fixture();
  let firstRequest: unknown;
  await completeSideThreadTurn({
    thread: f.thread,
    model,
    question: "X",
    thinkingLevel: "off",
    completeSimple: async (_model, context) => {
      firstRequest = structuredClone(context.messages);
      return answer("side-X");
    },
  });
  const baseline = buildSideThreadMessages(f.thread, "Y").slice(0, -1);
  f.add();
  assert.deepEqual(buildSideThreadMessages(f.thread, "Y").slice(0, -1), baseline);
  assert.equal(await importMainUpdates(f.thread, f.ctx, async () => "confirm"), "imported");
  const second = buildSideThreadMessages(f.thread, "Y");
  assert.deepEqual(second.slice(0, baseline.length), baseline);
  assert.deepEqual(second.slice(0, 1), firstRequest);
  assert.match(text(second), /side-X[\s\S]*Main context update[\s\S]*C-D[\s\S]*Y/u);
  assert.equal(f.thread.turns.length, 1);
  assert.equal(
    f.thread.conversationContext,
    captureMainContextSource(f.manager, required(required(f.thread.updates[0]).snapshot.source.entryId))
      .conversationContext,
  );
  assert.equal(
    await importMainUpdates(f.thread, f.ctx, async () => {
      throw new Error("no preview expected");
    }),
    "back",
  );
  assert.equal(f.thread.updates.length, 1);
  assert.deepEqual(buildQuickBringToMainSegments(f.thread.turns, { kind: "entire" }), [
    { role: "user", text: "X" },
    { role: "assistant", text: "side-X" },
  ]);
});

test("normalized provider inputs keep system instructions and the exact model-visible message prefix", async () => {
  const f = fixture();
  const requests: Array<{ systemPrompt: Context["systemPrompt"]; messages: unknown[] }> = [];
  for (const question of ["X", "Y", "Z"]) {
    if (question !== "X") {
      f.add(`main before ${question}`);
      await importMainUpdates(f.thread, f.ctx, async () => "confirm");
    }
    await completeSideThreadTurn({
      thread: f.thread,
      model,
      question,
      thinkingLevel: "off",
      completeSimple: async (_model, context) => {
        requests.push(
          structuredClone({
            systemPrompt: context.systemPrompt,
            messages: context.messages.map((message) => ({ role: message.role, content: message.content })),
          }),
        );
        return answer(`side ${question}`);
      },
    });
  }
  for (let i = 1; i < requests.length; i++) {
    const previous = required(requests[i - 1]);
    const current = required(requests[i]);
    assert.equal(current.systemPrompt, previous.systemPrompt);
    assert.equal(
      JSON.stringify(current.messages.slice(0, previous.messages.length)),
      JSON.stringify(previous.messages),
    );
  }
});

test("multiple imports before the first answer remain ordered across failure, cancellation, and resume", async () => {
  const f = fixture();
  f.add("first update");
  assert.equal(await importMainUpdates(f.thread, f.ctx, async () => "confirm"), "imported");
  f.thread.turns.push({ kind: "error", question: "failed question", answer: "failure" });
  f.add("second update");
  await importMainUpdates(f.thread, f.ctx, async () => "confirm");
  const first = buildSideThreadMessages(f.thread, "retry").slice(0, -1);
  await completeSideThreadTurn({
    thread: f.thread,
    model,
    question: "retry",
    thinkingLevel: "off",
    completeSimple: async () => {
      throw new Error("provider failed");
    },
  });
  const controller = new AbortController();
  controller.abort();
  const result = await completeSideThreadTurn({
    thread: f.thread,
    model,
    question: "cancel",
    signal: controller.signal,
    thinkingLevel: "off",
    completeSimple: async () => answer("unused"),
  });
  assert.equal(result.kind, "aborted");
  assert.deepEqual(buildSideThreadMessages(f.thread, "resumed").slice(0, -1), first);
  assert.match(text(first), /A-B[\s\S]*first update[\s\S]*second update/u);
  assert.doesNotMatch(text(first), /failed question|provider failed/u);
  assert.equal(f.thread.updates.length, 2);
  assert.deepEqual(
    sideTranscript(f.thread).map((item) => item.kind),
    ["mainContext", "error", "mainContext"],
  );
});

test("preview freezes data while main advances; the next explicit import gets later entries", async () => {
  const f = fixture();
  f.add("previewed");
  let frozen = "";
  await importMainUpdates(f.thread, f.ctx, async (_ctx, snapshot) => {
    frozen = snapshot.text;
    f.add("after preview");
    return "confirm";
  });
  assert.equal(f.thread.updates[0]?.snapshot.text, frozen);
  assert.doesNotMatch(frozen, /after preview/u);
  const next = buildMainContextSnapshot(f.manager, f.thread.source);
  assert.equal(next.kind, "ready");
  if (next.kind === "ready") assert.match(next.text, /after preview/u);
  assert.equal(appendMainContextUpdate(f.thread, required(f.thread.updates[0]).snapshot), false);
});

test.each(["cancel", "abort", "branch", "compaction", "thread", "session", "duplicate"])(
  "does not commit a stale or cancelled preview: %s",
  async (change) => {
    const f = fixture();
    f.add();
    const result = await importMainUpdates(f.thread, f.ctx, async () => {
      if (change === "cancel") return "back";
      if (change === "abort") f.controller.abort();
      if (change === "branch") f.manager.branch(required(required(f.thread.source).entryId));
      if (change === "compaction") f.manager.appendCompaction("summary", required(f.thread.source).entryId, 1);
      if (change === "thread") f.thread.turns.push({ kind: "error", question: "other", answer: "error" });
      if (change === "session") Object.defineProperty(f.ctx, "sessionManager", { value: SessionManager.inMemory() });
      if (change === "duplicate") await importMainUpdates(f.thread, f.ctx, async () => "confirm");
      return "confirm";
    });
    assert.notEqual(result, "imported");
    assert.equal(f.thread.updates.length, change === "duplicate" ? 1 : 0);
  },
);

test.each(["rpc", "json", "print"])("rejects %s before opening a preview", async (mode) => {
  const f = fixture();
  f.add();
  Object.defineProperty(f.ctx, "mode", { value: mode });
  assert.equal(
    await importMainUpdates(f.thread, f.ctx, async () => {
      throw new Error("must not open");
    }),
    "close",
  );
  assert.equal(await showMainUpdatePreview(f.ctx, {} as never), "close");
});

test("preview failure leaves confirmed state and cursor unchanged", async () => {
  const f = fixture();
  f.add();
  const source = { ...f.thread.source };
  await assert.rejects(
    importMainUpdates(f.thread, f.ctx, async () => {
      throw new Error("UI failed");
    }),
    /UI failed/u,
  );
  assert.deepEqual(f.thread.source, source);
  assert.equal(f.thread.updates.length, 0);
});

function previewHost() {
  initTheme("dark");
  const f = fixture();
  f.add("  exact whitespace\n\n中\u001b]52;c;bad\u0007text");
  const bindings = new KeybindingsManager(TUI_KEYBINDINGS, {
    "tui.select.confirm": "ctrl+s",
    "tui.select.cancel": "ctrl+q",
  });
  const tui = createTuiHarness({ width: 100, rows: 24, keybindings: bindings as never });
  let draft = "main draft";
  const ctx = Object.assign(Object.create(f.ctx), {
    ui: {
      custom: tui.custom,
      getEditorText: () => draft,
      setEditorText: (value: string) => {
        draft = value;
      },
      notify() {},
    },
  }) as ExtensionCommandContext;
  return { ...f, tui, ctx };
}

test.each(["confirm", "back", "hard-cancel", "dispose", "shutdown"])(
  "real preview handles %s and releases its interaction",
  async (action) => {
    const f = previewHost();
    const pending = importMainUpdates(f.thread, f.ctx);
    await f.tui.waitForOpen();
    const lines = f.tui.render(100);
    const display = lines.map(stripVTControlCharacters).join("\n");
    assert.match(display, /Import main updates/u);
    assert.match(display, /Source session/u);
    assert.ok(lines.every((line) => visibleWidth(line) <= 100));
    assert.ok(!lines.some((line) => line.includes("\u001b]52;")));
    assert.ok(!lines.some((line) => line.includes(CURSOR_MARKER)));
    for (const rows of [1, 4, 8, 24]) {
      f.tui.resize({ rows });
      for (const width of [1, 2, 20, 100]) assert.ok(f.tui.render(width).every((line) => visibleWidth(line) <= width));
      f.tui.invalidate();
    }
    if (action === "dispose") f.tui.dispose();
    else if (action === "shutdown") f.controller.abort();
    else if (action === "hard-cancel") f.tui.press("ctrl+c");
    else f.tui.send(action === "confirm" ? "\u0013" : "\u0011");
    assert.equal(await pending, action === "confirm" ? "imported" : action === "back" ? "back" : "close");
    assert.equal(f.thread.updates.length, action === "confirm" ? 1 : 0);
  },
);

test("composer import preserves an expanded large-paste draft, renders updates, and respects alternate bindings", async () => {
  initTheme("dark");
  const f = fixture();
  f.add();
  const snapshot = buildMainContextSnapshot(f.manager, f.thread.source);
  assert.equal(snapshot.kind, "ready");
  if (snapshot.kind !== "ready") return;
  appendMainContextUpdate(f.thread, snapshot);
  const tui = createTuiHarness({ width: 120, rows: 24 });
  const manager = new KeybindingsManager(TUI_KEYBINDINGS, { "tui.input.submit": "ctrl+s" });
  const actions: unknown[] = [];
  let pager!: BtwTranscriptPager;
  const pending = tui.custom((nativeTui, theme, _keys, done) => {
    pager = new BtwTranscriptPager(
      nativeTui,
      theme,
      sideTranscript(f.thread),
      (action) => {
        actions.push(action);
        done(action);
      },
      { mainUpdates: () => true, keybindings: manager },
    );
    return pager;
  });
  await tui.waitForOpen();
  const large = "draft line\n".repeat(300);
  pager.handleInput(`\u001b[200~${large}\u001b[201~`);
  assert.equal(actions.length, 0);
  for (const width of [0, 1, 2, 40, 120]) assert.ok(pager.render(width).every((line) => visibleWidth(line) <= width));
  assert.match(formatSideTranscript(sideTranscript(f.thread)), /Main context update[\s\S]*C-D/u);
  pager.handleInput("\u001b[20~");
  assert.deepEqual(actions, [{ kind: "importMainUpdates", questionDraft: large }]);
  await pending;
  pager.dispose();
  tui.dispose();
});

test("composer keeps the import hint last in full and compact layouts", async () => {
  initTheme("dark");
  const harness = createTuiHarness({ width: 160, rows: 24 });
  const keys = new KeybindingsManager({ ...TUI_KEYBINDINGS, "app.thinking.cycle": { defaultKeys: "shift+tab" } });
  let pager!: BtwTranscriptPager;
  const pending = harness.custom((tui, theme, _keys, done) => {
    pager = new BtwTranscriptPager(tui, theme, [], done, {
      mainUpdates: () => false,
      keybindings: keys,
      thinking: { level: "off", levels: ["off", "low"], keybindings: keys, onChange() {} },
    });
    pager.setWorkspaceFocus("side", "F6");
    return pager;
  });
  await harness.waitForOpen();
  const full = pager
    .render(160)
    .map(stripVTControlCharacters)
    .find((line) => line.includes("F9 import"));
  const compact = pager
    .render(40)
    .map(stripVTControlCharacters)
    .find((line) => line.includes("F9 import"));
  pager.dispose();
  await pending;
  harness.dispose();
  assert.equal(full, "Enter send • Ctrl+C exit • Shift+Tab thinking • F6 switch • F9 import main");
  assert.equal(compact, "Enter • Ctrl+C • F9 import");
});

test("busy view does not expose import or disturb the steering queue", async () => {
  initTheme("dark");
  const harness = createTuiHarness({ width: 120, rows: 24 });
  const queued: string[] = [];
  let view!: BtwAnsweringView;
  const pending = harness.custom((tui, theme, _keys, done) => {
    view = new BtwAnsweringView(tui, theme, [], "current", () => done("closed"), undefined, {
      steering: { questions: queued, onSubmit: (question) => queued.push(question) },
    });
    return view;
  });
  await harness.waitForOpen();
  view.handleInput("\u001b[20~");
  assert.equal(harness.isOpen, true);
  assert.doesNotMatch(harness.render().join("\n"), /import main/u);
  view.handleInput("queued");
  view.handleInput("\r");
  assert.deepEqual(queued, ["queued"]);
  view.dispose();
  await pending;
  assert.equal(view.signal.aborted, true);
});

test("queued side questions drain before returning to the import-capable composer", async () => {
  const f = fixture();
  f.add();
  let calls = 0;
  let interactions = 0;
  await runBtwThread({
    selected: { model },
    thinkingLevel: "off",
    ctx: f.ctx,
    initialQuestion: "X",
    dependencies: {
      ask: async (_thread, _question, _selected, _thinking, _ctx, steering) => {
        if (++calls === 1) steering.submit("queued Y");
        assert.equal(interactions, 0);
        return { kind: "answered", response: answer("side"), answer: "side" };
      },
      interact: async () => {
        interactions++;
        assert.equal(calls, 2);
        return { kind: "close" };
      },
    },
  });
  assert.equal(interactions, 1);
});

test("thread loop restores the side draft after import and does not run a provider until a question is submitted", async () => {
  const f = fixture();
  f.add();
  const drafts: Array<string | undefined> = [];
  let interactions = 0;
  let asks = 0;
  await runBtwThread({
    selected: { model },
    thinkingLevel: "off",
    ctx: f.ctx,
    state: { id: "thread", thread: f.thread, thinkingLevel: "off", createdAt: 0, updatedAt: 0 },
    dependencies: {
      interact: async (_thread, _bottom, _ctx, draft) => {
        drafts.push(draft);
        return ++interactions === 1 ? { kind: "importMainUpdates", questionDraft: "side draft" } : { kind: "close" };
      },
      importUpdates: async (thread, ctx) => importMainUpdates(thread, ctx, async () => "confirm"),
      ask: async () => {
        asks++;
        return { kind: "aborted" };
      },
    },
  });
  assert.deepEqual(drafts, [undefined, "side draft"]);
  assert.equal(asks, 0);
  assert.equal(f.thread.updates.length, 1);
});
