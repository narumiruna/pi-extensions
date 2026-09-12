import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTuiHarness } from "@narumitw/pi-tui-kit/testing";
import { test } from "vitest";
import { createMockContext, createMockPi } from "../../../test/support.js";
import { registerFileQuoteExtension } from "../src/file-context.js";

async function withTempProject(run: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "pi-file-context-menu-command-test-"));
  try {
    await writeFile(join(root, "example.ts"), "export const example = true;\n");
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function waitForNextOpen(tui: ReturnType<typeof createTuiHarness>, previousCount: number): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (tui.openCount > previousCount && tui.isOpen) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error("Timed out waiting for the next File Context screen");
}

test("makes the no-argument command a menu and advertises compatibility routes", async () => {
  await withTempProject(async (root) => {
    const mock = createMockPi();
    await registerFileQuoteExtension(mock.pi, {
      loadSettings: async () => ({ settings: { openShortcut: "f8" } }),
    });
    const command = mock.commands.get("file-context");
    assert.ok(command?.getArgumentCompletions);
    assert.deepEqual(
      (command.getArgumentCompletions("") as Array<{ value: string }>).map(({ value }) => value),
      ["browse", "remove"],
    );
    assert.deepEqual(
      (command.getArgumentCompletions("br") as Array<{ value: string }>).map(({ value }) => value),
      ["browse"],
    );

    const tui = createTuiHarness({ width: 40, rows: 12 });
    const base = createMockContext({ mode: "tui", hasUI: true, cwd: root });
    const baseCtx = base.ctx as unknown as { ui: Record<string, unknown> } & Record<string, unknown>;
    const context = {
      ...base,
      ctx: {
        ...baseCtx,
        ui: { ...baseCtx.ui, custom: tui.custom },
      } as never,
    };
    await mock.events.get("session_start")?.[0]?.({}, context.ctx);
    const running = Promise.resolve(command?.handler("", context.ctx));
    await tui.waitForOpen();
    const frame = tui.render().join("\n");
    assert.match(frame, /File Context/u);
    assert.match(frame, /Add context snippet/u);
    assert.match(frame, /Review selected context \(0\)/u);
    tui.press("tui.select.down");
    tui.press("tui.select.down");
    const laterRows = tui.render().join("\n");
    assert.match(laterRows, /Settings/u);
    assert.match(laterRows, /Status/u);
    tui.press("ctrl+c");
    await running;
  });
});

test("saves shortcut settings and reloads instead of mutating stale TUI bindings", async () => {
  await withTempProject(async (root) => {
    const mock = createMockPi();
    let storedShortcut: "ctrl+shift+x" | "ctrl+y" | null = "ctrl+shift+x";
    const saved: Array<string | null> = [];
    let reloadCalls = 0;
    await registerFileQuoteExtension(mock.pi, {
      settingsPath: join(root, "pi-file-context.json"),
      loadSettings: async () => ({ settings: { openShortcut: storedShortcut } }),
      updateSettings: async (shortcut, options) => {
        assert.equal(options?.settingsPath, join(root, "pi-file-context.json"));
        assert.equal(options?.signal?.aborted, false);
        storedShortcut = shortcut as typeof storedShortcut;
        saved.push(shortcut);
        return { openShortcut: shortcut };
      },
    });
    assert.equal(mock.shortcuts.get("ctrl+shift+x")?.description, "Open File Context");

    const tui = createTuiHarness({ width: 52, rows: 16 });
    const base = createMockContext({
      mode: "tui",
      hasUI: true,
      cwd: root,
      async reload() {
        reloadCalls += 1;
      },
    });
    const baseCtx = base.ctx as unknown as { ui: Record<string, unknown> } & Record<string, unknown>;
    const ctx = {
      ...baseCtx,
      ui: { ...baseCtx.ui, custom: tui.custom },
    } as never;
    await mock.events.get("session_start")?.[0]?.({}, ctx);

    const running = Promise.resolve(mock.commands.get("file-context")?.handler("", ctx));
    await tui.waitForOpen();
    tui.press("tui.select.down");
    tui.press("tui.select.down");
    tui.press("tui.select.confirm");
    await tui.waitForOpen();
    assert.match(tui.render().join("\n"), /Open shortcut\s+ctrl\+shift\+x/u);
    tui.press("tui.select.confirm");
    await tui.waitForPending();
    await tui.waitForOpen();
    tui.type("ctrl+y");
    tui.press("tui.input.submit");
    await tui.waitForPending();
    await running;

    assert.deepEqual(saved, ["ctrl+y"]);
    assert.equal(reloadCalls, 1);
    assert.equal(mock.shortcuts.get("ctrl+shift+x")?.description, "Open File Context");
    assert.equal(mock.shortcuts.has("ctrl+y"), false);
    await mock.events.get("session_shutdown")?.[0]?.({}, ctx);
  });
});

test("keeps direct routes while showing the same cancellable scan before browsing", async () => {
  for (const route of ["browse", "shortcut"] as const) {
    await withTempProject(async (root) => {
      const mock = createMockPi();
      let resolveScan: ((files: string[]) => void) | undefined;
      await registerFileQuoteExtension(mock.pi, {
        loadSettings: async () => ({ settings: { openShortcut: "f8" } }),
        discoverFiles: async () =>
          new Promise<string[]>((resolve) => {
            resolveScan = resolve;
          }),
        createGit: async () => undefined,
      });
      const pasted: string[] = [];
      const tui = createTuiHarness({
        width: 40,
        rows: 12,
        keybindings: {
          matches(data: string, binding: string) {
            return data === "\t" && binding === "tui.input.tab";
          },
          getKeys() {
            return [];
          },
        } as never,
      });
      const base = createMockContext({ mode: "tui", hasUI: true, cwd: root });
      const baseCtx = base.ctx as unknown as { ui: Record<string, unknown> } & Record<string, unknown>;
      const ctx = {
        ...baseCtx,
        ui: {
          ...baseCtx.ui,
          custom: tui.custom,
          pasteToEditor(value: string) {
            pasted.push(value);
          },
        },
      } as never;
      await mock.events.get("session_start")?.[0]?.({}, ctx);
      const running = Promise.resolve(
        route === "browse"
          ? mock.commands.get("file-context")?.handler("browse", ctx)
          : mock.shortcuts.get("f8")?.handler(ctx),
      );
      await tui.waitForOpen();
      assert.match(tui.render().join("\n"), /Scanning project files/u);
      const scanOpenCount = tui.openCount;
      resolveScan?.(["example.ts"]);
      await waitForNextOpen(tui, scanOpenCount);
      assert.match(tui.render().join("\n"), /File Context · files/u);
      tui.send("\t");
      await running;
      assert.deepEqual(pasted, ["@example.ts "]);
    });
  }
});

test("cancels direct-route scanning without opening a stale explorer", async () => {
  await withTempProject(async (root) => {
    const mock = createMockPi();
    let scanSignal: AbortSignal | undefined;
    await registerFileQuoteExtension(mock.pi, {
      loadSettings: async () => ({ settings: { openShortcut: "f8" } }),
      discoverFiles: async (_root, { signal } = {}) => {
        scanSignal = signal;
        return new Promise<string[]>((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
      },
      createGit: async () => undefined,
    });
    const tui = createTuiHarness({ width: 40, rows: 12 });
    const base = createMockContext({ mode: "tui", hasUI: true, cwd: root });
    const baseCtx = base.ctx as unknown as { ui: Record<string, unknown> } & Record<string, unknown>;
    const ctx = {
      ...baseCtx,
      ui: { ...baseCtx.ui, custom: tui.custom },
    } as never;
    await mock.events.get("session_start")?.[0]?.({}, ctx);
    const running = Promise.resolve(mock.shortcuts.get("f8")?.handler(ctx));
    await tui.waitForOpen();
    assert.match(tui.render().join("\n"), /Scanning project files/u);
    tui.press("tui.select.cancel");
    await running;
    assert.equal(scanSignal?.aborted, true);
    assert.equal(tui.openCount, 1);
  });
});

test("reports project scanning failures and returns to a retryable menu", async () => {
  await withTempProject(async (root) => {
    const mock = createMockPi();
    let rejectScan: ((error: Error) => void) | undefined;
    await registerFileQuoteExtension(mock.pi, {
      loadSettings: async () => ({ settings: { openShortcut: "f8" } }),
      discoverFiles: async () =>
        new Promise<string[]>((_resolve, reject) => {
          rejectScan = reject;
        }),
    });
    const tui = createTuiHarness({ width: 40, rows: 12 });
    const base = createMockContext({ mode: "tui", hasUI: true, cwd: root });
    const baseCtx = base.ctx as unknown as { ui: Record<string, unknown> } & Record<string, unknown>;
    const ctx = {
      ...baseCtx,
      ui: { ...baseCtx.ui, custom: tui.custom },
    } as never;
    await mock.events.get("session_start")?.[0]?.({}, ctx);
    const running = Promise.resolve(mock.commands.get("file-context")?.handler("", ctx));
    await tui.waitForOpen();
    const menuOpenCount = tui.openCount;
    tui.press("tui.select.confirm");
    await tui.waitForPending();
    await waitForNextOpen(tui, menuOpenCount);
    const scanOpenCount = tui.openCount;
    rejectScan?.(new Error("scan \u001b[31mfailed"));
    await waitForNextOpen(tui, scanOpenCount);
    assert.match(tui.render().join("\n"), /Add context snippet/u);
    assert.ok(!(base.notifications.at(-1)?.message ?? "").includes("\u001b"));
    assert.match(base.notifications.at(-1)?.message ?? "", /could not scan.*retry/iu);
    tui.press("ctrl+c");
    await running;
  });
});

test("shows cancellable project scanning before Add and returns to the menu on cancellation", async () => {
  await withTempProject(async (root) => {
    const mock = createMockPi();
    let scanSignal: AbortSignal | undefined;
    await registerFileQuoteExtension(mock.pi, {
      loadSettings: async () => ({ settings: { openShortcut: "f8" } }),
      discoverFiles: async (_root, { signal } = {}) => {
        scanSignal = signal;
        return new Promise<string[]>((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
      },
    });
    const tui = createTuiHarness({ width: 40, rows: 12 });
    const base = createMockContext({ mode: "tui", hasUI: true, cwd: root });
    const baseCtx = base.ctx as unknown as { ui: Record<string, unknown> } & Record<string, unknown>;
    const ctx = {
      ...baseCtx,
      ui: { ...baseCtx.ui, custom: tui.custom },
    } as never;
    await mock.events.get("session_start")?.[0]?.({}, ctx);
    const running = Promise.resolve(mock.commands.get("file-context")?.handler("", ctx));
    await tui.waitForOpen();
    const menuOpenCount = tui.openCount;
    tui.press("tui.select.confirm");
    await tui.waitForPending();
    await waitForNextOpen(tui, menuOpenCount);
    assert.match(tui.render().join("\n"), /Scanning project files/u);
    const scanOpenCount = tui.openCount;
    tui.press("tui.select.cancel");
    await waitForNextOpen(tui, scanOpenCount);
    assert.equal(scanSignal?.aborted, true);
    assert.match(tui.render().join("\n"), /Add context snippet/u);
    tui.press("ctrl+c");
    await running;
  });
});
