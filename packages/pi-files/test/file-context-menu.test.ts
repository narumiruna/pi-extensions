import assert from "node:assert/strict";
import { visibleWidth } from "@earendil-works/pi-tui";
import { createTuiHarness } from "@narumitw/pi-tui-kit/testing";
import { test } from "vitest";
import { createMockContext } from "../../../test/support.js";
import {
  type FileContextMenuOptions,
  type FileContextMenuState,
  showFileContextMenu,
} from "../src/file-context-menu.js";

function quote(
  id: string,
  overrides: Partial<FileContextMenuState["quotes"][number]> = {},
): FileContextMenuState["quotes"][number] {
  return {
    id,
    path: "src/example.ts",
    startLine: 1,
    endLine: 1,
    text: "const example = true;",
    ...overrides,
  };
}

function state(
  quotes: FileContextMenuState["quotes"] = [],
  overrides: Partial<FileContextMenuState> = {},
): FileContextMenuState {
  return {
    quotes,
    shortcut: "ctrl+shift+x",
    maximumQuotes: 8,
    maximumBytes: 100_000,
    totalBytes: quotes.reduce((total, item) => total + Buffer.byteLength(item.text), 0),
    settingsPath: "/tmp/pi-file-context.json",
    ...overrides,
  };
}

function menuContext(width = 80, rows = 24, reload: () => Promise<void> = async () => {}) {
  const tui = createTuiHarness({ width, rows });
  let reloadCalls = 0;
  const base = createMockContext({
    mode: "tui",
    hasUI: true,
    async reload() {
      reloadCalls += 1;
      await reload();
    },
  });
  const baseCtx = base.ctx as unknown as { ui: Record<string, unknown> } & Record<string, unknown>;
  return {
    tui,
    notifications: base.notifications,
    get reloadCalls() {
      return reloadCalls;
    },
    ctx: {
      ...baseCtx,
      ui: { ...baseCtx.ui, custom: tui.custom },
    } as never,
  };
}

function options(
  getState: () => FileContextMenuState,
  overrides: Partial<FileContextMenuOptions> = {},
): FileContextMenuOptions {
  return {
    getState,
    isCurrent: () => true,
    signal: new AbortController().signal,
    addQuote: async () => "close" as const,
    removeQuote: () => ({ kind: "missing" }),
    saveShortcut() {},
    ...overrides,
  };
}

test("shows the primary menu immediately with visible state and disabled reasons", async () => {
  const { tui, ctx } = menuContext(20, 6);
  let removeCalls = 0;
  const running = showFileContextMenu(
    ctx,
    options(() => state(), {
      removeQuote: () => {
        removeCalls += 1;
        return { kind: "missing" };
      },
    }),
  );
  await tui.waitForOpen();

  for (const size of [
    { width: 20, rows: 6 },
    { width: 40, rows: 12 },
    { width: 80, rows: 24 },
  ]) {
    const frame = tui.resize(size);
    assert.ok(frame.length > 0);
    assert.ok(frame.every((line) => visibleWidth(line) <= size.width));
  }
  const initial = tui.render().join("\n");
  assert.match(initial, /File Context/u);
  assert.match(initial, /Next prompt context: 0\/8 snippets/u);
  assert.match(initial, /Shortcut: CTRL\+SHIFT\+X/u);
  assert.match(initial, /Add context snippet/u);
  assert.match(initial, /Settings/u);
  assert.match(initial, /Status/u);

  tui.press("tui.select.down");
  const disabled = tui.render().join("\n");
  assert.match(disabled, /\[-\].*Review selected context \(0\)/u);
  assert.match(disabled, /No context selected for the next prompt/u);
  tui.press("tui.select.confirm");
  await tui.waitForPending();
  assert.equal(removeCalls, 0);
  assert.equal(tui.isOpen, true);

  tui.press("ctrl+c");
  assert.deepEqual(await running, { kind: "closed", reason: "close" });
});

test("closes the menu before handing off to Add", async () => {
  const { tui, ctx } = menuContext();
  let menuWasOpenDuringAdd = true;
  const running = showFileContextMenu(
    ctx,
    options(() => state(), {
      addQuote: async () => {
        menuWasOpenDuringAdd = tui.isOpen;
        return "close" as const;
      },
    }),
  );
  await tui.waitForOpen();
  tui.press("tui.select.confirm");
  await running;
  assert.equal(menuWasOpenDuringAdd, false);
});

test("opens Status with current limits and settings", async () => {
  const { tui, ctx } = menuContext(44, 14);
  const running = showFileContextMenu(
    ctx,
    options(() => state([quote("quote-1")])),
  );
  await tui.waitForOpen();
  tui.press("tui.select.down");
  tui.press("tui.select.down");
  tui.press("tui.select.down");
  tui.press("tui.select.confirm");
  await tui.waitForOpen();
  const frame = tui.render().join("\n");
  assert.match(frame, /File Context Status/u);
  assert.match(frame, /Next prompt context: 1\/8 snippets/u);
  assert.match(frame, /Open shortcut: ctrl\+shift\+x/u);
  assert.match(frame, /pi-file-context\.json/u);
  tui.press("ctrl+c");
  await running;
});

test("opens Help from the menu and Escape returns without side effects", async () => {
  const { tui, ctx } = menuContext();
  let addCalls = 0;
  const running = showFileContextMenu(
    ctx,
    options(() => state(), {
      addQuote: async () => {
        addCalls += 1;
        return "close" as const;
      },
    }),
  );
  await tui.waitForOpen();
  tui.press("tui.select.down");
  tui.press("tui.select.down");
  tui.press("tui.select.down");
  tui.press("tui.select.down");
  tui.press("tui.select.confirm");
  await tui.waitForOpen();
  assert.match(tui.render().join("\n"), /Selected context is attached.*next prompt/u);
  tui.press("tui.select.cancel");
  await tui.waitForOpen();
  assert.match(tui.render().join("\n"), /Add context snippet/u);
  assert.equal(addCalls, 0);
  tui.press("ctrl+c");
  await running;
});

test("Settings saves or disables the shortcut and reloads Pi", async () => {
  for (const scenario of [
    { input: "ctrl+y", expected: "ctrl+y" },
    { input: "", expected: null },
  ] as const) {
    const menu = menuContext(44, 14);
    const saved: Array<string | null> = [];
    const running = showFileContextMenu(
      menu.ctx,
      options(() => state(), {
        saveShortcut: (shortcut) => {
          saved.push(shortcut);
        },
      }),
    );
    await menu.tui.waitForOpen();
    menu.tui.press("tui.select.down");
    menu.tui.press("tui.select.down");
    menu.tui.press("tui.select.confirm");
    await menu.tui.waitForOpen();
    assert.match(menu.tui.render().join("\n"), /File Context Settings/u);
    assert.match(menu.tui.render().join("\n"), /Open shortcut\s+ctrl\+shift\+x/u);
    assert.ok(menu.tui.render(28).every((line) => visibleWidth(line) <= 28));

    menu.tui.press("tui.select.confirm");
    await menu.tui.waitForPending();
    await menu.tui.waitForOpen();
    if (scenario.input) menu.tui.type(scenario.input);
    menu.tui.press("tui.input.submit");
    await menu.tui.waitForPending();
    await running;

    assert.deepEqual(saved, [scenario.expected]);
    assert.equal(menu.reloadCalls, 1);
    assert.match(menu.notifications.at(-1)?.message ?? "", /Reloading Pi/u);
  }
});

test("Settings rejects invalid keys without saving or reloading", async () => {
  const menu = menuContext(44, 14);
  const saved: Array<string | null> = [];
  const controller = new AbortController();
  const running = showFileContextMenu(
    menu.ctx,
    options(() => state(), {
      signal: controller.signal,
      saveShortcut: (shortcut) => {
        saved.push(shortcut);
      },
    }),
  );
  await menu.tui.waitForOpen();
  menu.tui.press("tui.select.down");
  menu.tui.press("tui.select.down");
  menu.tui.press("tui.select.confirm");
  await menu.tui.waitForOpen();
  menu.tui.press("tui.select.confirm");
  await menu.tui.waitForPending();
  await menu.tui.waitForOpen();
  menu.tui.type("ctrl+not-a-key");
  menu.tui.press("tui.input.submit");
  await menu.tui.waitForPending();
  assert.deepEqual(saved, []);
  assert.equal(menu.reloadCalls, 0);
  assert.match(menu.notifications.at(-1)?.message ?? "", /Invalid key identifier/u);
  controller.abort();
  menu.tui.dispose();
  await running;
});

test("Settings is unavailable while selected context would be lost by reload", async () => {
  const { tui, ctx } = menuContext(52, 14);
  const running = showFileContextMenu(
    ctx,
    options(() => state([quote("quote-1")])),
  );
  await tui.waitForOpen();
  tui.press("tui.select.down");
  tui.press("tui.select.down");
  const frame = tui.render().join("\n");
  assert.match(frame, /\[-\].*Settings/u);
  assert.match(frame, /Submit or remove selected context\s+first/u);
  tui.press("tui.select.confirm");
  await tui.waitForPending();
  assert.equal(tui.isOpen, true);
  tui.press("ctrl+c");
  await running;
});

test("invalid settings are read-only and save failures preserve the displayed shortcut", async () => {
  for (const failure of ["invalid", "save"] as const) {
    const { tui, ctx, notifications } = menuContext(48, 14);
    const current = state([], failure === "invalid" ? { settingsInvalidReason: "invalid JSON" } : {});
    const controller = new AbortController();
    const running = showFileContextMenu(
      ctx,
      options(() => current, {
        signal: controller.signal,
        saveShortcut: async () => {
          throw new Error("disk full\u001b]52;c;payload\u0007");
        },
      }),
    );
    await tui.waitForOpen();
    tui.press("tui.select.down");
    tui.press("tui.select.down");
    tui.press("tui.select.confirm");
    await tui.waitForOpen();
    if (failure === "invalid") {
      assert.match(tui.render().join("\n"), /Read only/u);
      assert.match(tui.render().join("\n"), /invalid JSON/u);
    } else {
      tui.press("tui.select.confirm");
      await tui.waitForPending();
      await tui.waitForOpen();
      tui.type("ctrl+y");
      tui.press("tui.input.submit");
      await tui.waitForPending();
      assert.match(notifications.at(-1)?.message ?? "", /previous shortcut remains/u);
      assert.ok(!(notifications.at(-1)?.message ?? "").includes("\u001b"));
    }
    controller.abort();
    tui.dispose();
    await running;
  }
});

test("a reload failure keeps the saved value and gives a safe recovery instruction", async () => {
  const menu = menuContext(48, 14, async () => {
    throw new Error("reload failed\u001b]52;c;payload\u0007");
  });
  const saved: Array<string | null> = [];
  const running = showFileContextMenu(
    menu.ctx,
    options(() => state(), {
      saveShortcut: (shortcut) => {
        saved.push(shortcut);
      },
    }),
  );
  await menu.tui.waitForOpen();
  menu.tui.press("tui.select.down");
  menu.tui.press("tui.select.down");
  menu.tui.press("tui.select.confirm");
  await menu.tui.waitForOpen();
  menu.tui.press("tui.select.confirm");
  await menu.tui.waitForPending();
  await menu.tui.waitForOpen();
  menu.tui.type("ctrl+y");
  menu.tui.press("tui.input.submit");
  await menu.tui.waitForPending();
  await running;
  assert.deepEqual(saved, ["ctrl+y"]);
  assert.equal(menu.reloadCalls, 1);
  assert.match(menu.notifications.at(-1)?.message ?? "", /settings were saved.*run \/reload/iu);
  assert.ok(!(menu.notifications.at(-1)?.message ?? "").includes("\u001b"));
});

test("Settings disposal aborts an in-flight shortcut save without reporting a stale error", async () => {
  const { tui, ctx, notifications } = menuContext(48, 14);
  const controller = new AbortController();
  let saveSignal: AbortSignal | undefined;
  let markStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  const running = showFileContextMenu(
    ctx,
    options(() => state(), {
      signal: controller.signal,
      saveShortcut: async (_shortcut, signal) => {
        saveSignal = signal;
        markStarted();
        return new Promise<void>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
      },
    }),
  );
  await tui.waitForOpen();
  tui.press("tui.select.down");
  tui.press("tui.select.down");
  tui.press("tui.select.confirm");
  await tui.waitForOpen();
  tui.press("tui.select.confirm");
  await tui.waitForPending();
  await tui.waitForOpen();
  tui.type("ctrl+y");
  tui.press("tui.input.submit");
  await started;
  controller.abort();
  tui.dispose();
  await running;
  assert.equal(saveSignal?.aborted, true);
  assert.deepEqual(notifications, []);
});

test("reviews exact snippets before repeatedly removing them by stable ID", async () => {
  const { tui, ctx, notifications } = menuContext(40, 12);
  let current = state([
    quote("quote-1", { text: "first snapshot\nwith details" }),
    quote("quote-2", { text: "second snapshot\nwith details" }),
  ]);
  const removedIds: string[] = [];
  const running = showFileContextMenu(
    ctx,
    options(() => current, {
      removeQuote: (id) => {
        const selected = current.quotes.find((item) => item.id === id);
        if (!selected) return { kind: "missing" };
        removedIds.push(id);
        current = state(current.quotes.filter((item) => item.id !== id));
        return { kind: "removed", quote: selected, remaining: current.quotes.length };
      },
    }),
  );
  await tui.waitForOpen();
  tui.press("tui.select.down");
  tui.press("tui.select.confirm");
  await tui.waitForOpen();
  const firstChoice = tui.render().join("\n");
  assert.match(firstChoice, /src\/example\.ts/u);
  assert.match(firstChoice, /Lines 1-1/u);
  assert.equal(removedIds.length, 0);

  tui.press("tui.select.confirm");
  await tui.waitForOpen();
  const firstReview = tui.render().join("\n");
  assert.match(firstReview, /Review context snippet/u);
  assert.match(firstReview, /first snapshot/u);
  tui.press("tui.select.down");
  const scrolledReview = tui.render().join("\n");
  assert.match(scrolledReview, /with details/u);
  assert.match(scrolledReview, /Remove from next\s+prompt/u);
  assert.equal(removedIds.length, 0);

  tui.press("tui.select.cancel");
  await tui.waitForOpen();
  assert.match(tui.render().join("\n"), /Selected context/u);
  assert.equal(removedIds.length, 0);
  tui.press("tui.select.confirm");
  await tui.waitForOpen();
  tui.press("tui.select.confirm");
  await tui.waitForPending();
  await tui.waitForOpen();
  assert.match(tui.render().join("\n"), /second snapshot/u);
  tui.press("tui.select.confirm");
  await tui.waitForOpen();
  assert.match(tui.render().join("\n"), /Review context snippet/u);
  tui.press("tui.select.confirm");
  await tui.waitForPending();
  await tui.waitForOpen();

  assert.deepEqual(removedIds, ["quote-1", "quote-2"]);
  assert.match(tui.render().join("\n"), /No context selected for the next prompt/u);
  assert.equal(notifications.filter(({ message }) => /Removed from next prompt context/u.test(message)).length, 2);
  tui.press("ctrl+c");
  await running;
});

test("sanitizes untrusted quote text and keeps cancellation side-effect free", async () => {
  const { tui, ctx } = menuContext(32, 12);
  const unsafe = quote("quote-unsafe", {
    path: "src/unsafe\u001b[31m.ts",
    text: "first\u0000 line\nsecond",
  });
  let removeCalls = 0;
  const running = showFileContextMenu(
    ctx,
    options(() => state([unsafe]), {
      removeQuote: () => {
        removeCalls += 1;
        return { kind: "missing" };
      },
    }),
  );
  await tui.waitForOpen();
  tui.press("tui.select.down");
  tui.press("tui.select.confirm");
  await tui.waitForOpen();
  const frame = tui.render();
  assert.ok(frame.every((line) => visibleWidth(line) <= 32));
  assert.ok(frame.every((line) => !line.includes("\u001b[31m") && !line.includes("\u0000")));
  tui.press("tui.select.cancel");
  await tui.waitForOpen();
  assert.equal(removeCalls, 0);
  tui.press("ctrl+c");
  await running;
});

test("disables Add at either hard pending limit", async () => {
  for (const limited of [
    state(Array.from({ length: 8 }, (_, index) => quote(`quote-${index}`))),
    state([quote("quote-bytes")], { totalBytes: 100_000 }),
  ]) {
    const { tui, ctx } = menuContext();
    let addCalls = 0;
    const running = showFileContextMenu(
      ctx,
      options(() => limited, {
        addQuote: async () => {
          addCalls += 1;
          return "close" as const;
        },
      }),
    );
    await tui.waitForOpen();
    assert.match(tui.render().join("\n"), /\[-\].*Add context snippet/u);
    tui.press("tui.select.confirm");
    await tui.waitForPending();
    assert.equal(addCalls, 0);
    tui.press("ctrl+c");
    await running;
  }
});
