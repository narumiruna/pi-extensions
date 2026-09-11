import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import { Key, type KeyId, matchesKey, visibleWidth } from "@earendil-works/pi-tui";
import { resolveMenuScreen, runMenu } from "@narumitw/pi-tui-kit";
import { createRpcHarness, createTuiHarness } from "@narumitw/pi-tui-kit/testing";
import { test } from "vitest";
import { createMockContext } from "../../../test/support.js";
import { createRecallMenu, type RecallMenuSource, showRecallMenu } from "../src/menu.js";
import type { MessageCandidate, RecallMessageRecord } from "../src/messages.js";

function candidate(entryId: string): MessageCandidate {
  return {
    entryId,
    role: entryId === "user" ? "user" : "assistant",
    text: `text for ${entryId}`,
    messageTimestamp: 1_786_000_000_000,
    source: { sessionId: "session-a", sessionName: "Current", cwd: "/work/project" },
  };
}

function record(id = "saved-a", entryId = "assistant"): RecallMessageRecord {
  return {
    type: "recall_message",
    version: 1,
    id,
    savedAt: "2026-08-04T12:00:00.000Z",
    source: {
      sessionId: "session-a",
      entryId,
      sessionName: "Current",
      cwd: "/work/project",
      messageTimestamp: 1_786_000_000_000,
    },
    role: "assistant",
    text: `saved text ${id}`,
  };
}

function source(initialRecords = [record()]): RecallMenuSource & { records: RecallMessageRecord[] } {
  const value: RecallMenuSource & { records: RecallMessageRecord[] } = {
    path: "/agent/pi-recall.jsonl",
    records: [...initialRecords],
    current: { sessionId: "session-a", cwd: "/work/project" },
    candidates: [candidate("assistant"), candidate("user")],
    async load() {
      return {
        path: value.path,
        records: [...value.records],
        bytes: Buffer.byteLength(value.records.map((item) => JSON.stringify(item)).join("\n")),
      };
    },
    async save(item) {
      const saved = record(`saved-${value.records.length + 1}`, item.entryId);
      saved.role = item.role;
      saved.text = item.text;
      value.records.push(saved);
      return saved;
    },
    async delete(id) {
      const previous = value.records.length;
      value.records = value.records.filter((item) => item.id !== id);
      return value.records.length < previous;
    },
  };
  return value;
}

async function state(controller: ReturnType<typeof createRecallMenu>) {
  return controller.getState({ signal: new AbortController().signal });
}

function recallPickerKeybindings() {
  return {
    matches(data: string, binding: string) {
      const keys: Record<string, KeyId> = {
        "app.session.delete": Key.ctrl("d"),
        "app.tree.filter.cycleForward": Key.ctrl("o"),
        "app.tree.filter.cycleBackward": Key.ctrlShift("o"),
        "tui.select.up": Key.up,
        "tui.select.down": Key.down,
        "tui.select.pageUp": Key.pageUp,
        "tui.select.pageDown": Key.pageDown,
        "tui.select.confirm": Key.enter,
        "tui.select.cancel": Key.escape,
      };
      const expected = keys[binding];
      return (
        (expected !== undefined && matchesKey(data, expected)) ||
        (binding === "tui.select.cancel" && matchesKey(data, Key.ctrl("c")))
      );
    },
    getKeys(binding: string) {
      const keys: Record<string, string[]> = {
        "app.session.delete": ["ctrl+d"],
        "app.tree.filter.cycleForward": ["ctrl+o"],
        "app.tree.filter.cycleBackward": ["ctrl+shift+o"],
      };
      return keys[binding] ?? [];
    },
  };
}

async function waitForOpenCount(
  tui: ReturnType<typeof createTuiHarness>,
  count: number,
  running: Promise<unknown> | unknown,
) {
  for (let turn = 0; tui.openCount < count && turn < 100; turn += 1) {
    const settled = await Promise.race([
      Promise.resolve(running).then(() => true),
      new Promise<false>((resolve) => setImmediate(() => resolve(false))),
    ]);
    if (settled) break;
  }
  assert.equal(tui.openCount, count);
}

test("main menu keeps five primary rows and save choice marks duplicate source unavailable", async () => {
  const controller = createRecallMenu(source());
  const current = await state(controller);
  const main = resolveMenuScreen(controller.menu, "main", current);
  assert.equal(main.kind, "actions");
  if (main.kind !== "actions") return;
  assert.deepEqual(
    main.items.map(({ label }) => label),
    ["Save a message", "Recall a saved message", "Status", "Help", "Close"],
  );
  const save = resolveMenuScreen(controller.menu, "save", current);
  assert.equal(save.kind, "choice");
  if (save.kind !== "choice") return;
  assert.equal(save.items.find(({ id }) => id === "assistant")?.disabled, true);
  assert.match(save.items.find(({ id }) => id === "assistant")?.disabledReason ?? "", /already saved/i);
  assert.equal(save.items.find(({ id }) => id === "user")?.disabled, undefined);
});

test("save action persists the selected active-branch candidate and returns to main", async () => {
  const data = source([]);
  const controller = createRecallMenu(data);
  const result = await controller.menu.actions.saveMessage({
    ctx: createMockContext({ hasUI: true, mode: "rpc" }).ctx,
    state: await state(controller),
    signal: new AbortController().signal,
    itemId: "user",
  });
  assert.deepEqual(result, { kind: "to", screen: "main" });
  assert.equal(data.records[0]?.source.entryId, "user");
});

test("RPC saved-message selection asks for scope explicitly and opens selected actions", async () => {
  const data = source();
  let calls = 0;
  const mock = createMockContext({
    hasUI: true,
    mode: "rpc",
    select: async (_title: string, options: string[]) => {
      calls += 1;
      return options[0];
    },
  });
  const controller = createRecallMenu(data);
  const result = await controller.menu.actions.chooseSaved({
    ctx: mock.ctx,
    state: await state(controller),
    signal: new AbortController().signal,
    itemId: "recall",
  });
  assert.equal(calls, 2);
  assert.deepEqual(result, { kind: "to", screen: "selected" });
  const selected = resolveMenuScreen(controller.menu, "selected", await state(controller));
  assert.equal(selected.kind, "actions");
  assert.match(selected.lines?.join("\n") ?? "", /saved text saved-a/);
});

test("TUI saved picker is lifecycle-owned and returns the Tab-selected scope", async () => {
  const data = source([
    record("saved-current"),
    {
      ...record("saved-other", "other-entry"),
      source: {
        ...record().source,
        sessionId: "other-session",
        cwd: "/other",
        entryId: "other-entry",
      },
    },
  ]);
  const tui = createTuiHarness({ width: 72, rows: 18 });
  const base = createMockContext({ hasUI: true, mode: "tui" }).ctx as unknown as {
    ui: Record<string, unknown>;
    [key: string]: unknown;
  };
  const controller = createRecallMenu(data);
  const owner = new AbortController();
  const choosing = controller.menu.actions.chooseSaved({
    ctx: { ...base, ui: { ...base.ui, custom: tui.custom } } as never,
    state: await state(controller),
    signal: owner.signal,
    itemId: "recall",
  });
  await tui.waitForOpen();
  assert.match(tui.render().join("\n"), /Scope: Current cwd \(1\)/);
  tui.send("\t");
  assert.match(tui.render().join("\n"), /Scope: All \(2\)/);
  tui.press("tui.select.confirm");
  assert.deepEqual(await choosing, { kind: "to", screen: "selected" });
  assert.equal(tui.isOpen, false);
});

test("TUI query survives picker re-entry in one Recall flow and resets in a fresh flow", async () => {
  const data = source();
  const base = createMockContext({ hasUI: true, mode: "tui" }).ctx as unknown as {
    ui: Record<string, unknown>;
    [key: string]: unknown;
  };
  const controller = createRecallMenu(data);

  const firstTui = createTuiHarness({
    width: 72,
    rows: 18,
    keybindings: recallPickerKeybindings() as never,
  });
  const first = controller.menu.actions.chooseSaved({
    ctx: { ...base, ui: { ...base.ui, custom: firstTui.custom } } as never,
    state: await state(controller),
    signal: new AbortController().signal,
    itemId: "recall",
  });
  await firstTui.waitForOpen();
  firstTui.send("\u000f");
  firstTui.send("\u000f");
  firstTui.type("saved-a");
  assert.match(stripVTControlCharacters(firstTui.render().join("\n")), /View: Assistant only \(1\).*1 match/);
  firstTui.press("tui.select.confirm");
  assert.deepEqual(await first, { kind: "to", screen: "selected" });

  const reopenedTui = createTuiHarness({
    width: 72,
    rows: 18,
    keybindings: recallPickerKeybindings() as never,
  });
  const reopened = controller.menu.actions.chooseSaved({
    ctx: { ...base, ui: { ...base.ui, custom: reopenedTui.custom } } as never,
    state: await state(controller),
    signal: new AbortController().signal,
    itemId: "recall",
  });
  await reopenedTui.waitForOpen();
  const reopenedFrame = stripVTControlCharacters(reopenedTui.render().join("\n"));
  const reopenedSearch = reopenedFrame.split("\n").find((line) => line.startsWith("Search:"));
  assert.match(reopenedSearch ?? "", /saved-a/);
  assert.match(reopenedFrame, /View: Assistant only \(1\)/);
  reopenedTui.press("tui.select.cancel");
  assert.deepEqual(await reopened, { kind: "stay" });

  const fresh = createRecallMenu(data);
  const freshTui = createTuiHarness({
    width: 72,
    rows: 18,
    keybindings: recallPickerKeybindings() as never,
  });
  const freshChoosing = fresh.menu.actions.chooseSaved({
    ctx: { ...base, ui: { ...base.ui, custom: freshTui.custom } } as never,
    state: await state(fresh),
    signal: new AbortController().signal,
    itemId: "recall",
  });
  await freshTui.waitForOpen();
  const freshFrame = stripVTControlCharacters(freshTui.render().join("\n"));
  const freshSearch = freshFrame.split("\n").find((line) => line.startsWith("Search:"));
  assert.doesNotMatch(freshSearch ?? "", /saved-a/);
  assert.match(freshFrame, /View: All messages \(1\)/);
  freshTui.press("tui.select.cancel");
  assert.deepEqual(await freshChoosing, { kind: "stay" });
});

test("TUI direct delete confirms the selected message, shows progress, and restores picker context", async () => {
  const current = record("saved-current");
  const other = record("saved-other", "other-entry");
  other.source = { ...other.source, sessionId: "other-session", cwd: "/other" };
  const data = source([current, other]);
  const originalDelete = data.delete.bind(data);
  let deleteStarted!: () => void;
  let releaseDelete!: () => void;
  const started = new Promise<void>((resolve) => {
    deleteStarted = resolve;
  });
  const release = new Promise<void>((resolve) => {
    releaseDelete = resolve;
  });
  data.delete = async (id) => {
    deleteStarted();
    await release;
    return originalDelete(id);
  };
  let confirmation: { title: string; message: string } | undefined;
  const tui = createTuiHarness({
    width: 72,
    rows: 18,
    keybindings: recallPickerKeybindings() as never,
  });
  const base = createMockContext({
    hasUI: true,
    mode: "tui",
    confirm: async (title: string, message: string) => {
      confirmation = { title, message };
      return true;
    },
  }).ctx as unknown as { ui: Record<string, unknown>; [key: string]: unknown };
  const controller = createRecallMenu(data);
  const choosing = controller.menu.actions.chooseSaved({
    ctx: { ...base, ui: { ...base.ui, custom: tui.custom } } as never,
    state: await state(controller),
    signal: new AbortController().signal,
    itemId: "recall",
  });
  await tui.waitForOpen();
  tui.send("\t");
  tui.send("\u000f");
  tui.send("\u000f");
  tui.press("tui.select.up");
  tui.type("saved");
  tui.send("\u0004");
  await waitForOpenCount(tui, 2, choosing);
  await started;
  try {
    assert.match(confirmation?.title ?? "", /Delete saved message/);
    assert.match(confirmation?.message ?? "", /saved text saved-other/);
    assert.match(tui.render().join("\n"), /Deleting saved message/);
  } finally {
    releaseDelete();
  }
  await waitForOpenCount(tui, 3, choosing);
  const restored = stripVTControlCharacters(tui.render().join("\n"));
  assert.match(restored, /Scope: All \(1\).*View: Assistant only \(1\).*1 match/);
  assert.match(restored, /Search: .*saved/);
  assert.match(restored, /› assistant: saved text saved-current/);
  assert.equal(
    data.records.some(({ id }) => id === "saved-other"),
    false,
  );
  tui.press("tui.select.cancel");
  assert.deepEqual(await choosing, { kind: "stay" });
});

test("cancelling direct delete is side-effect free and restores query and selection", async () => {
  const data = source();
  let deleteCalls = 0;
  data.delete = async () => {
    deleteCalls += 1;
    return true;
  };
  const tui = createTuiHarness({
    width: 72,
    rows: 18,
    keybindings: recallPickerKeybindings() as never,
  });
  const base = createMockContext({
    hasUI: true,
    mode: "tui",
    confirm: async () => false,
  }).ctx as unknown as { ui: Record<string, unknown>; [key: string]: unknown };
  const controller = createRecallMenu(data);
  const choosing = controller.menu.actions.chooseSaved({
    ctx: { ...base, ui: { ...base.ui, custom: tui.custom } } as never,
    state: await state(controller),
    signal: new AbortController().signal,
    itemId: "recall",
  });
  await tui.waitForOpen();
  tui.send("\u000f");
  tui.send("\u000f");
  tui.type("saved-a");
  tui.send("\u0004");
  await waitForOpenCount(tui, 2, choosing);
  const restored = stripVTControlCharacters(tui.render().join("\n"));
  assert.match(restored, /View: Assistant only \(1\).*1 match/);
  assert.match(restored, /Search: .*saved-a/);
  assert.match(restored, /› assistant: saved text saved-a/);
  assert.equal(deleteCalls, 0);
  assert.equal(data.records.length, 1);
  tui.press("tui.select.cancel");
  assert.deepEqual(await choosing, { kind: "stay" });
});

test("direct delete failure preserves the record and reports an actionable error", async () => {
  const data = source();
  let releaseDelete!: () => void;
  const release = new Promise<void>((resolve) => {
    releaseDelete = resolve;
  });
  data.delete = async () => {
    await release;
    throw new Error("lock unavailable");
  };
  const tui = createTuiHarness({
    width: 72,
    rows: 18,
    keybindings: recallPickerKeybindings() as never,
  });
  const mock = createMockContext({ hasUI: true, mode: "tui", confirm: async () => true });
  const base = mock.ctx as unknown as { ui: Record<string, unknown>; [key: string]: unknown };
  const controller = createRecallMenu(data);
  const choosing = controller.menu.actions.chooseSaved({
    ctx: { ...base, ui: { ...base.ui, custom: tui.custom } } as never,
    state: await state(controller),
    signal: new AbortController().signal,
    itemId: "recall",
  });
  await tui.waitForOpen();
  tui.send("\u000f");
  tui.send("\u000f");
  tui.send("\u0004");
  await waitForOpenCount(tui, 2, choosing);
  releaseDelete();
  await waitForOpenCount(tui, 3, choosing);
  assert.equal(data.records.length, 1);
  assert.match(tui.render().join("\n"), /View: Assistant only \(1\)/);
  assert.match(tui.render().join("\n"), /saved text saved-a/);
  assert.match(mock.notifications.at(-1)?.message ?? "", /Couldn.t delete.*lock unavailable/i);
  tui.press("tui.select.cancel");
  await choosing;
});

test("session cancellation aborts in-flight direct delete without stale success UI", async () => {
  const data = source();
  let deleteStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    deleteStarted = resolve;
  });
  data.delete = async (_id, signal) => {
    deleteStarted();
    await new Promise<void>((_resolve, reject) => {
      if (signal?.aborted) return reject(signal.reason);
      signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
    });
    return true;
  };
  const owner = new AbortController();
  const tui = createTuiHarness({
    width: 72,
    rows: 18,
    keybindings: recallPickerKeybindings() as never,
  });
  const mock = createMockContext({ hasUI: true, mode: "tui", confirm: async () => true });
  const base = mock.ctx as unknown as { ui: Record<string, unknown>; [key: string]: unknown };
  const controller = createRecallMenu(data, { isCurrent: () => !owner.signal.aborted });
  const choosing = controller.menu.actions.chooseSaved({
    ctx: { ...base, ui: { ...base.ui, custom: tui.custom } } as never,
    state: await state(controller),
    signal: owner.signal,
    itemId: "recall",
  });
  await tui.waitForOpen();
  tui.send("\u0004");
  await waitForOpenCount(tui, 2, choosing);
  await started;
  owner.abort(new DOMException("Session replaced", "AbortError"));
  assert.deepEqual(await choosing, { kind: "close" });
  assert.equal(data.records.length, 1);
  assert.equal(
    mock.notifications.some(({ message }) => /Deleted saved message/.test(message)),
    false,
  );
});

test("direct delete reconciles a record already removed by another process", async () => {
  const data = source();
  data.delete = async () => {
    data.records = [];
    return false;
  };
  const tui = createTuiHarness({
    width: 72,
    rows: 18,
    keybindings: recallPickerKeybindings() as never,
  });
  const mock = createMockContext({ hasUI: true, mode: "tui", confirm: async () => true });
  const base = mock.ctx as unknown as { ui: Record<string, unknown>; [key: string]: unknown };
  const controller = createRecallMenu(data);
  const choosing = controller.menu.actions.chooseSaved({
    ctx: { ...base, ui: { ...base.ui, custom: tui.custom } } as never,
    state: await state(controller),
    signal: new AbortController().signal,
    itemId: "recall",
  });
  await tui.waitForOpen();
  tui.send("\u0004");
  await waitForOpenCount(tui, 3, choosing);
  assert.match(tui.render().join("\n"), /No saved messages in this scope/);
  assert.match(mock.notifications.at(-1)?.message ?? "", /already removed/i);
  tui.press("tui.select.cancel");
  await choosing;
});

test("preview is exact, quote appends to the draft without sending, and delete requires review action", async () => {
  const data = source();
  const mock = createMockContext({ hasUI: true, mode: "rpc" });
  let editorText = "Question: ";
  const quoteCtx = mock.ctx as unknown as {
    ui: { pasteToEditor(value: string): void };
  };
  quoteCtx.ui.pasteToEditor = (value) => {
    editorText += value;
  };
  const controller = createRecallMenu(data);
  controller.selectRecordForTest("saved-a");
  const current = await state(controller);
  const preview = resolveMenuScreen(controller.menu, "preview", current);
  assert.equal(preview.kind, "review");
  if (preview.kind !== "review") return;
  assert.equal(preview.content, "saved text saved-a");
  const deletion = resolveMenuScreen(controller.menu, "delete", current);
  assert.equal(deletion.kind, "review");
  if (deletion.kind !== "review") return;
  assert.equal(deletion.confirm?.label, "Delete saved message");
  const quoteResult = await controller.menu.actions.quote({
    ctx: quoteCtx as never,
    state: current,
    signal: new AbortController().signal,
    itemId: "quote",
  });
  assert.deepEqual(quoteResult, { kind: "close" });
  assert.match(editorText, /^Question: <recalled_message/);
  assert.doesNotMatch(editorText, /session-a|\/work\/project/);
  assert.equal(data.records.length, 1);
  await controller.menu.actions.deleteMessage({
    ctx: mock.ctx,
    state: current,
    signal: new AbortController().signal,
    itemId: "delete-confirm",
  });
  assert.equal(data.records.length, 0);
});

test("invalid storage remains visible and disables mutation routes", async () => {
  const data = source();
  data.load = async () => {
    throw new Error("invalid JSON on line 2");
  };
  const controller = createRecallMenu(data);
  const current = await state(controller);
  const main = resolveMenuScreen(controller.menu, "main", current);
  assert.match(main.lines?.join("\n") ?? "", /invalid JSON on line 2/);
  if (main.kind !== "actions") return;
  assert.equal(main.items[0]?.disabled, true);
  assert.equal(main.items[1]?.disabled, true);
  const status = resolveMenuScreen(controller.menu, "status", current);
  assert.match(status.lines?.join("\n") ?? "", /read-only/i);
});

test("RPC manager closes without custom TUI and TUI remains width-safe under owner cancellation", async () => {
  const data = source();
  const rpc = createRpcHarness([{ kind: "select", response: "Close" }]);
  const rpcBase = createMockContext({ hasUI: true, mode: "rpc" }).ctx as unknown as {
    ui: Record<string, unknown>;
    [key: string]: unknown;
  };
  await showRecallMenu({ ...rpcBase, ui: { ...rpcBase.ui, ...rpc.ui } } as never, data, {
    signal: new AbortController().signal,
    isCurrent: () => true,
  });
  rpc.assertConsumed();

  const controller = createRecallMenu(data);
  const tui = createTuiHarness({ width: 32, rows: 16 });
  const owner = new AbortController();
  const tuiBase = createMockContext({ hasUI: true, mode: "tui" }).ctx as unknown as {
    ui: Record<string, unknown>;
    [key: string]: unknown;
  };
  const running = runMenu({ ...tuiBase, ui: { ...tuiBase.ui, custom: tui.custom } } as never, controller.menu, {
    getState: controller.getState,
    signal: owner.signal,
    isCurrent: () => !owner.signal.aborted,
  });
  await tui.waitForOpen();
  for (const line of tui.render()) assert.ok(visibleWidth(line) <= 32);
  owner.abort();
  assert.equal((await running).kind, "stale");
});
