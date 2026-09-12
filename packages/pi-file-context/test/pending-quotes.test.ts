import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTuiHarness } from "@narumitw/pi-tui-kit/testing";
import { test } from "vitest";
import { createMockContext, createMockPi } from "../../../test/support.js";
import { registerFileQuoteExtension } from "../src/file-context.js";

async function withTempProject(run: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "pi-file-context-pending-test-"));
  try {
    await writeFile(join(root, "example.txt"), "example\n");
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function waitForNextOpen(tui: ReturnType<typeof createTuiHarness>, previousCount: number): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    if (tui.openCount > previousCount && tui.isOpen) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Timed out waiting for the next File Context screen");
}

async function waitForText(tui: ReturnType<typeof createTuiHarness>, text: string): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    if (tui.isOpen && tui.render().join("\n").includes(text)) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`Timed out waiting for File Context text: ${text}`);
}

async function stageQuote(
  command: { handler(args: string, ctx: unknown): unknown } | undefined,
  context: ReturnType<typeof createMockContext>,
  path: string,
  text: string,
): Promise<void> {
  const tui = createTuiHarness({ width: 80, rows: 18 });
  (context.ctx as unknown as { ui: { custom: typeof tui.custom } }).ui.custom = tui.custom;
  const running = Promise.resolve(command?.handler("browse", context.ctx));
  await waitForText(tui, "File Context");
  assert.equal(path.startsWith("src/"), true);
  tui.press("tui.select.confirm");
  tui.press("tui.select.confirm");
  await waitForText(tui, "Enter add");
  assert.match(tui.render().join("\n"), new RegExp(text, "u"));
  tui.press("tui.select.confirm");
  await running;
}

test("removes an exact duplicate-looking pending quote and refreshes the widget", async () => {
  await withTempProject(async (root) => {
    const mock = createMockPi();
    await registerFileQuoteExtension(mock.pi, {
      loadSettings: async () => ({ settings: { openShortcut: "f8" } }),
    });
    await mkdir(join(root, "src"));
    const quotePath = join(root, "src", "example.ts");
    await writeFile(quotePath, "first snapshot\n");
    const widgets = new Map<string, unknown>();
    const context = createMockContext({
      mode: "tui",
      hasUI: true,
      cwd: root,
      ui: {
        theme: { fg: (_color: string, text: string) => text },
        notify() {},
        setWidget(key: string, value: unknown) {
          widgets.set(key, value);
        },
        async custom() {
          return undefined;
        },
        pasteToEditor() {},
      },
    });
    const command = mock.commands.get("file-context");
    await mock.events.get("session_start")?.[0]?.({}, context.ctx);
    await stageQuote(command, context, "src/example.ts", "first snapshot");
    await writeFile(quotePath, "second snapshot\n");
    await stageQuote(command, context, "src/example.ts", "second snapshot");

    const tui = createTuiHarness({ width: 60, rows: 18 });
    (context.ctx as unknown as { ui: { custom: typeof tui.custom } }).ui.custom = tui.custom;
    const running = Promise.resolve(command?.handler("", context.ctx));
    await tui.waitForOpen();
    const mainCount = tui.openCount;
    tui.press("tui.select.down");
    tui.press("tui.select.confirm");
    await waitForNextOpen(tui, mainCount);
    assert.match(tui.render().join("\n"), /first snapshot/u);
    tui.press("tui.select.down");
    const selectedCount = tui.openCount;
    tui.press("tui.select.confirm");
    await waitForNextOpen(tui, selectedCount);
    assert.match(tui.render().join("\n"), /Review context snippet/u);
    assert.match(tui.render().join("\n"), /second snapshot/u);
    const reviewCount = tui.openCount;
    tui.press("tui.select.confirm");
    await tui.waitForPending();
    await waitForNextOpen(tui, reviewCount);
    assert.match(tui.render().join("\n"), /first snapshot/u);
    assert.doesNotMatch(tui.render().join("\n"), /second snapshot/u);
    tui.press("tui.select.cancel");
    await tui.waitForOpen();
    tui.press("ctrl+c");
    await running;

    assert.deepEqual(widgets.get("file-context"), [
      "Next prompt context · 1 snippet · ~4 tokens · /file-context to review",
      "1. src/example.ts · lines 1-1 · ~4 tokens",
    ]);
    const injection = await mock.events.get("before_agent_start")?.[0]?.(
      { prompt: "Explain", systemPrompt: "base" },
      context.ctx,
    );
    assert.match(JSON.stringify(injection), /first snapshot/u);
    assert.doesNotMatch(JSON.stringify(injection), /second snapshot/u);
  });
});

test("removal cancellation and menu failures preserve pending quotes", async () => {
  await withTempProject(async (root) => {
    const mock = createMockPi();
    await registerFileQuoteExtension(mock.pi, {
      loadSettings: async () => ({ settings: { openShortcut: "f8" } }),
    });
    await mkdir(join(root, "src"));
    await writeFile(join(root, "src", "keep.ts"), "keep\n");
    const widgets = new Map<string, unknown>();
    const notifications: string[] = [];
    const context = createMockContext({
      mode: "tui",
      hasUI: true,
      cwd: root,
      ui: {
        theme: { fg: (_color: string, text: string) => text },
        notify(message: string) {
          notifications.push(message);
        },
        setWidget(key: string, value: unknown) {
          widgets.set(key, value);
        },
        async custom() {
          return undefined;
        },
        pasteToEditor() {},
      },
    });
    const command = mock.commands.get("file-context");
    await mock.events.get("session_start")?.[0]?.({}, context.ctx);
    await stageQuote(command, context, "src/keep.ts", "keep");
    const widgetBefore = widgets.get("file-context");

    const tui = createTuiHarness();
    (context.ctx as unknown as { ui: { custom: typeof tui.custom } }).ui.custom = tui.custom;
    const cancelled = Promise.resolve(command?.handler("remove", context.ctx));
    await tui.waitForOpen();
    tui.press("tui.select.cancel");
    await cancelled;
    assert.deepEqual(widgets.get("file-context"), widgetBefore);

    (
      context.ctx as unknown as {
        ui: { custom: (factory: unknown) => Promise<unknown> };
      }
    ).ui.custom = async () => {
      throw new Error("picker \u001b[31mfailed");
    };
    await command?.handler("remove", context.ctx);
    assert.deepEqual(widgets.get("file-context"), widgetBefore);
    assert.ok(!(notifications.at(-1) ?? "").includes("\u001b"));
    assert.match(notifications.at(-1) ?? "", /failed.*kept.*try again/iu);

    const injection = await mock.events.get("before_agent_start")?.[0]?.(
      { prompt: "Explain", systemPrompt: "base" },
      context.ctx,
    );
    assert.match(JSON.stringify(injection), /src\/keep\.ts/u);
    await command?.handler("remove", context.ctx);
    assert.match(notifications.at(-1) ?? "", /no .*context/iu);
  });
});

test("session replacement closes the menu and ignores stale input", async () => {
  await withTempProject(async (root) => {
    const mock = createMockPi();
    await registerFileQuoteExtension(mock.pi, {
      loadSettings: async () => ({ settings: { openShortcut: "f8" } }),
    });
    await mkdir(join(root, "src"));
    await writeFile(join(root, "src", "old.ts"), "old\n");
    const oldManager = { getSessionId: () => "old" };
    const newManager = { getSessionId: () => "new" };
    const oldContext = createMockContext({
      mode: "tui",
      hasUI: true,
      cwd: root,
      sessionManager: oldManager,
      ui: {
        theme: { fg: (_color: string, text: string) => text },
        notify() {},
        setWidget() {},
        async custom() {
          return undefined;
        },
        pasteToEditor() {},
      },
    });
    await mock.events.get("session_start")?.[0]?.({}, oldContext.ctx);
    await stageQuote(mock.commands.get("file-context"), oldContext, "src/old.ts", "old");
    const tui = createTuiHarness();
    (oldContext.ctx as unknown as { ui: { custom: typeof tui.custom } }).ui.custom = tui.custom;
    const oldMenu = Promise.resolve(mock.commands.get("file-context")?.handler("", oldContext.ctx));
    await tui.waitForOpen();

    const newContext = createMockContext({
      mode: "tui",
      hasUI: true,
      cwd: root,
      sessionManager: newManager,
    });
    await mock.events.get("session_start")?.[0]?.({}, newContext.ctx);
    await oldMenu;
    assert.equal(tui.isOpen, false);
    tui.press("tui.select.confirm");
    assert.equal(
      await mock.events.get("before_agent_start")?.[0]?.({ prompt: "new", systemPrompt: "base" }, newContext.ctx),
      undefined,
    );
  });
});
