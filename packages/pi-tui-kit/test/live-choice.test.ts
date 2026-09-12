import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import { CURSOR_MARKER, type KeyId, matchesKey, visibleWidth } from "@earendil-works/pi-tui";
import { test } from "vitest";
import { createMockContext } from "../../../test/support.js";
import { runLiveChoice } from "../src/index.js";
import { createRpcHarness, createTuiHarness } from "../src/testing/index.js";

const choices = [
  {
    id: "minimal",
    label: "Minimal",
    description: "Small output",
    details: ["Model and branch"],
  },
  {
    id: "blocked",
    label: "Blocked\u001b[31m",
    description: "Unavailable profile",
    disabled: true,
    disabledReason: "Missing\u0007 font",
    confirmationDisabled: true,
    confirmationDisabledReason: "This must not replace the disabled reason",
  },
  {
    id: "full",
    label: "Full",
    description: "Everything",
    details: ["Model, tokens, tools, and time"],
  },
] as const;

const confirmationGatedChoices = [
  {
    id: "active",
    label: "Active preset",
    description: "Currently applied",
    confirmationDisabled: true,
    confirmationDisabledReason: "Already\u0007 active",
  },
  { id: "other", label: "Other preset" },
] as const;

test("runLiveChoice blocks gated confirmation while preserving preview and shortcuts", async () => {
  const previews: string[] = [];
  const tui = createTuiHarness({ width: 24, rows: 12 });
  const context = createMockContext({ mode: "tui", hasUI: true, custom: tui.custom });
  const running = runLiveChoice(context.ctx, {
    title: "Preset\u001b[2J picker",
    items: confirmationGatedChoices,
    currentItemId: "active",
    initialItemId: "active",
    confirmLabel: "apply",
    shortcuts: [{ id: "customize", keys: ["e"], label: "customize" }],
    onSelectionChange: ({ item }) => {
      previews.push(item.id);
    },
  });
  await tui.waitForOpen();
  await tui.waitForPending();
  const frame = tui.render();
  const plain = stripVTControlCharacters(frame.join("\n"));
  assert.match(plain, /Active preset.*curr/u);
  assert.match(plain, /Cannot apply: Already\s+active/u);
  assert.equal(frame.join("\n").includes("\u001b[2J"), false);
  for (const line of frame) assert.ok(visibleWidth(line) <= 24);
  assert.deepEqual(previews, ["active"]);

  tui.press("tui.select.confirm");
  assert.equal(tui.isOpen, true);
  tui.type("e");
  assert.deepEqual(await running, {
    kind: "shortcut",
    shortcutId: "customize",
    itemId: "active",
  });
});

test("runLiveChoice preserves supplied controls in height-compacted hints", async () => {
  const tui = createTuiHarness({ width: 120, rows: 8 });
  const context = createMockContext({ mode: "tui", hasUI: true, custom: tui.custom });
  const running = runLiveChoice(context.ctx, {
    title: "Preset",
    items: choices,
    navigationLabel: "inspect",
    confirmLabel: "apply",
    shortcuts: [{ id: "customize", keys: ["e"], label: "customize" }],
  });
  await tui.waitForOpen();
  const rendered = stripVTControlCharacters(tui.render().join("\n"));
  assert.match(rendered, /e customize/u);
  assert.match(rendered, /enter apply/u);
  assert.match(rendered, /↑\/↓ inspect/u);
  const narrow = stripVTControlCharacters(tui.resize({ width: 45 }).join("\n"));
  assert.match(narrow, /esc back • \(1\/3\) • enter apply • ctrl\+c close/u);
  assert.doesNotMatch(narrow, /customize|page/u);
  tui.press("ctrl+c");
  assert.deepEqual(await running, { kind: "closed", reason: "close" });
});

test("runLiveChoice preserves gated Back, Close, owner abort, and disposal", async () => {
  async function drive(exit: "tui.select.cancel" | "ctrl+c") {
    const tui = createTuiHarness();
    const context = createMockContext({ mode: "tui", hasUI: true, custom: tui.custom });
    const running = runLiveChoice(context.ctx, {
      title: "Preset",
      items: confirmationGatedChoices,
      initialItemId: "active",
    });
    await tui.waitForOpen();
    await tui.waitForPending();
    tui.press(exit);
    return running;
  }
  assert.deepEqual(await drive("tui.select.cancel"), { kind: "closed", reason: "back" });
  assert.deepEqual(await drive("ctrl+c"), { kind: "closed", reason: "close" });

  const owner = new AbortController();
  const staleTui = createTuiHarness();
  const staleContext = createMockContext({ mode: "tui", hasUI: true, custom: staleTui.custom });
  const stale = runLiveChoice(staleContext.ctx, {
    title: "Preset",
    items: confirmationGatedChoices,
    signal: owner.signal,
  });
  await staleTui.waitForOpen();
  owner.abort(new DOMException("Session replaced", "AbortError"));
  assert.deepEqual(await stale, { kind: "stale" });

  const disposedTui = createTuiHarness();
  const disposedContext = createMockContext({
    mode: "tui",
    hasUI: true,
    custom: disposedTui.custom,
  });
  const disposed = runLiveChoice(disposedContext.ctx, {
    title: "Preset",
    items: confirmationGatedChoices,
  });
  await disposedTui.waitForOpen();
  disposedTui.dispose();
  assert.deepEqual(await disposed, { kind: "stale" });
});

test("runLiveChoice gives full disabled state precedence over confirmation gating", async () => {
  const previews: string[] = [];
  const tui = createTuiHarness({ width: 40, rows: 12 });
  const context = createMockContext({ mode: "tui", hasUI: true, custom: tui.custom });
  const running = runLiveChoice(context.ctx, {
    title: "Preset",
    items: [
      {
        ...confirmationGatedChoices[0],
        disabled: true,
        disabledReason: "Missing font",
      },
      confirmationGatedChoices[1],
    ],
    initialItemId: "active",
    confirmLabel: "apply",
    shortcuts: [{ id: "customize", keys: ["e"], label: "customize" }],
    onSelectionChange: ({ item }) => {
      previews.push(item.id);
    },
  });
  await tui.waitForOpen();
  await tui.waitForPending();
  const plain = stripVTControlCharacters(tui.render().join("\n"));
  assert.match(plain, /Unavailable: Missing font/u);
  assert.doesNotMatch(plain, /Cannot apply|Already active/u);
  tui.press("tui.select.confirm");
  tui.type("e");
  assert.equal(tui.isOpen, true);
  tui.press("tui.select.down");
  await tui.waitForPending();
  tui.press("tui.select.confirm");
  assert.deepEqual(await running, { kind: "selected", itemId: "other" });
  assert.deepEqual(previews, ["active", "other"]);
});

test("runLiveChoice previews initial and cursor choices and dispatches enabled shortcuts", async () => {
  const previews: string[] = [];
  const tui = createTuiHarness({ width: 32, rows: 20 });
  const context = createMockContext({ mode: "tui", hasUI: true, custom: tui.custom });
  const running = runLiveChoice(context.ctx, {
    title: "Preset\u001b[2J picker",
    lines: ["Choose with a live preview."],
    items: choices,
    currentItemId: "minimal",
    initialItemId: "blocked",
    shortcuts: [{ id: "customize", keys: ["e", "shift+e"], label: "customize" }],
    onSelectionChange: ({ item }) => {
      previews.push(item.id);
    },
  });
  await tui.waitForOpen();
  await Promise.resolve();
  const frame = tui.render();
  const plain = stripVTControlCharacters(frame.join("\n"));
  assert.match(plain, /Minimal.*✓ current/u);
  assert.match(plain, /Blocked/u);
  assert.match(plain, /Unavailable: Missing font/u);
  assert.equal(frame.join("\n").includes("\u001b[2J"), false);
  for (const line of frame) assert.ok(visibleWidth(line) <= 32);
  assert.deepEqual(previews, ["blocked"]);

  tui.press("tui.select.confirm");
  assert.equal(tui.isOpen, true);
  tui.type("e");
  assert.equal(tui.isOpen, true);
  tui.press("tui.select.down");
  await Promise.resolve();
  tui.type("E");
  assert.deepEqual(await running, {
    kind: "shortcut",
    shortcutId: "customize",
    itemId: "full",
  });
  assert.deepEqual(previews, ["blocked", "full"]);
});

test("runLiveChoice forwards passive hover and stable mouse activation through its wrapper", async () => {
  const previews: string[] = [];
  const tui = createTuiHarness({ width: 40, rows: 20 });
  const context = createMockContext({ mode: "tui", hasUI: true, custom: tui.custom });
  const running = runLiveChoice(context.ctx, {
    title: "Preset",
    items: choices,
    initialItemId: "minimal",
    onSelectionChange: ({ item }) => {
      previews.push(item.id);
    },
  });
  await tui.waitForOpen();
  await tui.waitForPending();
  let frame = tui.render();
  let row = frame.map(stripVTControlCharacters).findIndex((line) => line.includes("Full"));
  assert.notEqual(row, -1);
  tui.mouse({ type: "move", x: 3, y: row });
  assert.deepEqual(previews, ["minimal"]);
  tui.mouse({ type: "press", x: 3, y: row });
  await tui.waitForPending();
  frame = tui.render();
  row = frame.map(stripVTControlCharacters).findIndex((line) => line.includes("Full"));
  tui.mouse({ type: "click", x: 3, y: row });
  assert.deepEqual(await running, { kind: "selected", itemId: "full" });
  assert.deepEqual(previews, ["minimal", "full"]);
});

test("runLiveChoice opt-in search preserves editing, raw identity, and preview selection", async () => {
  const previews: string[] = [];
  const tui = createTuiHarness({ width: 48, rows: 16 });
  const context = createMockContext({ mode: "tui", hasUI: true, custom: tui.custom });
  const running = runLiveChoice(context.ctx, {
    title: "Search presets",
    items: choices.map((item) => (item.id === "full" ? { ...item, searchText: "maximal alias" } : item)),
    initialItemId: "minimal",
    enableSearch: true,
    shortcuts: [{ id: "customize", keys: ["e"], label: "customize" }],
    onSelectionChange: ({ item }) => {
      previews.push(item.id);
    },
  });
  await tui.waitForOpen();
  tui.setFocused(true);
  assert.equal(tui.render().join("\n").includes(CURSOR_MARKER), true);
  assert.doesNotMatch(tui.render().join("\n"), /customize/u);

  tui.type("e");
  assert.equal(tui.isOpen, true);
  assert.match(stripVTControlCharacters(tui.render().join("\n")), /Search:.*e/u);
  tui.send("\u0015");
  tui.send("\u001b[200~maximal alias\u0007\u001b[201~");
  await tui.waitForPending();
  assert.match(stripVTControlCharacters(tui.render().join("\n")), /[→›] Full/u);
  tui.send("\u0015");
  tui.type("zzz");
  assert.match(stripVTControlCharacters(tui.render().join("\n")), /No matching choices/u);
  for (let index = 0; index < 3; index += 1) tui.send("\u007f");
  assert.match(stripVTControlCharacters(tui.render().join("\n")), /[→›] Minimal/u);
  tui.type("maximal alias");
  tui.press("tui.select.confirm");
  assert.deepEqual(await running, { kind: "selected", itemId: "full" });
  assert.ok(previews.includes("full"));
});

test("search filtering coalesces previews and drains them on cancellation", async () => {
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started: string[] = [];
  let previewSignal: AbortSignal | undefined;
  const tui = createTuiHarness();
  const context = createMockContext({ mode: "tui", hasUI: true, custom: tui.custom });
  const running = runLiveChoice(context.ctx, {
    title: "Search presets",
    items: choices,
    initialItemId: "minimal",
    enableSearch: true,
    onSelectionChange: async ({ item, signal }) => {
      started.push(item.id);
      previewSignal = signal;
      await gate;
    },
  });
  await tui.waitForOpen();
  tui.type("everything");
  tui.send("\u0015");
  tui.type("small");
  tui.press("tui.select.cancel");
  assert.equal(previewSignal?.aborted, true);
  release();
  assert.deepEqual(await running, { kind: "closed", reason: "back" });
  assert.deepEqual(started, ["minimal"]);
});

test("runLiveChoice omits shortcuts that conflict with remapped standard controls", async () => {
  const bindingKeys = (binding: string): KeyId[] => {
    switch (binding) {
      case "tui.select.up":
        return ["up"];
      case "tui.select.down":
        return ["e"];
      case "tui.select.pageUp":
        return ["pageUp"];
      case "tui.select.pageDown":
        return ["pageDown"];
      case "tui.select.confirm":
        return ["enter"];
      case "tui.select.cancel":
        return ["escape", "ctrl+c"];
      default:
        return [];
    }
  };
  const tui = createTuiHarness({
    keybindings: {
      getKeys: (binding) => bindingKeys(binding),
      matches: (data, binding) => bindingKeys(binding).some((key) => matchesKey(data, key)),
    },
  });
  const context = createMockContext({ mode: "tui", hasUI: true, custom: tui.custom });
  const running = runLiveChoice(context.ctx, {
    title: "Preset",
    items: [choices[0], choices[2]],
    shortcuts: [{ id: "customize", keys: ["e", "return"], label: "customize" }],
  });
  await tui.waitForOpen();
  assert.doesNotMatch(tui.render().join("\n"), /customize/u);

  tui.type("e");
  tui.press("tui.select.confirm");
  assert.deepEqual(await running, { kind: "selected", itemId: "full" });
});

test("runLiveChoice shares wrapping, clamped paging, Home, and End selection semantics", async () => {
  const previews: string[] = [];
  const tui = createTuiHarness();
  const context = createMockContext({ mode: "tui", hasUI: true, custom: tui.custom });
  const running = runLiveChoice(context.ctx, {
    title: "Preset",
    items: choices,
    initialItemId: "minimal",
    viewportSize: 2,
    onSelectionChange: ({ item }) => {
      previews.push(item.id);
    },
  });
  await tui.waitForOpen();
  for (const input of [
    "tui.select.up",
    "tui.select.down",
    "tui.select.pageDown",
    "tui.select.pageDown",
    "home",
    "end",
  ] as const) {
    tui.press(input);
    await Promise.resolve();
  }
  tui.press("tui.select.confirm");
  assert.deepEqual(await running, { kind: "selected", itemId: "full" });
  assert.deepEqual(previews, ["minimal", "full", "minimal", "full", "full", "minimal", "full"]);
});

test("runLiveChoice preserves Back, Close, stale ownership, and external disposal", async () => {
  async function drive(exit: "tui.select.cancel" | "ctrl+c") {
    const tui = createTuiHarness();
    const context = createMockContext({ mode: "tui", hasUI: true, custom: tui.custom });
    const running = runLiveChoice(context.ctx, { title: "Preset", items: choices });
    await tui.waitForOpen();
    tui.press(exit);
    return running;
  }
  assert.deepEqual(await drive("tui.select.cancel"), { kind: "closed", reason: "back" });
  assert.deepEqual(await drive("ctrl+c"), { kind: "closed", reason: "close" });

  const owner = new AbortController();
  const staleTui = createTuiHarness();
  const staleContext = createMockContext({ mode: "tui", hasUI: true, custom: staleTui.custom });
  const stale = runLiveChoice(staleContext.ctx, {
    title: "Preset",
    items: choices,
    signal: owner.signal,
  });
  await staleTui.waitForOpen();
  owner.abort(new DOMException("Session replaced", "AbortError"));
  assert.deepEqual(await stale, { kind: "stale" });

  const disposedTui = createTuiHarness();
  const disposedContext = createMockContext({
    mode: "tui",
    hasUI: true,
    custom: disposedTui.custom,
  });
  const disposed = runLiveChoice(disposedContext.ctx, { title: "Preset", items: choices });
  await disposedTui.waitForOpen();
  disposedTui.dispose();
  assert.deepEqual(await disposed, { kind: "stale" });
});

test("runLiveChoice blocks cursor previews after generation ownership becomes stale", async () => {
  let current = true;
  const previews: string[] = [];
  const tui = createTuiHarness();
  const context = createMockContext({ mode: "tui", hasUI: true, custom: tui.custom });
  const running = runLiveChoice(context.ctx, {
    title: "Preset",
    items: choices,
    isCurrent: () => current,
    onSelectionChange: ({ item }) => {
      previews.push(item.id);
    },
  });
  await tui.waitForOpen();
  current = false;
  tui.press("tui.select.down");
  tui.press("ctrl+c");
  assert.deepEqual(await running, { kind: "stale" });
  assert.deepEqual(previews, ["minimal"]);
});

test("runLiveChoice revalidates generation ownership after an awaited preview", async () => {
  let current = true;
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tui = createTuiHarness();
  const context = createMockContext({ mode: "tui", hasUI: true, custom: tui.custom });
  const running = runLiveChoice(context.ctx, {
    title: "Preset",
    items: choices,
    isCurrent: () => current,
    onSelectionChange: async () => gate,
  });
  await tui.waitForOpen();
  current = false;
  release();
  assert.deepEqual(await running, { kind: "stale" });
});

test("runLiveChoice aborts and drains preview work while coalescing queued cursor changes", async () => {
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started: string[] = [];
  let previewSignal: AbortSignal | undefined;
  const tui = createTuiHarness();
  const context = createMockContext({ mode: "tui", hasUI: true, custom: tui.custom });
  const running = runLiveChoice(context.ctx, {
    title: "Preset",
    items: choices,
    onSelectionChange: async ({ item, signal }) => {
      started.push(item.id);
      previewSignal = signal;
      await gate;
    },
  });
  await tui.waitForOpen();
  tui.press("tui.select.down");
  tui.press("tui.select.down");
  tui.press("tui.select.cancel");
  let settled = false;
  void running.then(() => {
    settled = true;
  });
  await Promise.resolve();
  assert.equal(settled, false);
  assert.equal(previewSignal?.aborted, true);
  release();
  assert.deepEqual(await running, { kind: "closed", reason: "back" });
  assert.deepEqual(started, ["minimal"]);
});

test("runLiveChoice reports current preview failures without leaking stale failures", async () => {
  const failure = new Error("Preview failed");
  let reported: unknown;
  const tui = createTuiHarness();
  const context = createMockContext({ mode: "tui", hasUI: true, custom: tui.custom });
  assert.deepEqual(
    await runLiveChoice(context.ctx, {
      title: "Preset",
      items: choices,
      onSelectionChange: () => {
        throw failure;
      },
      onError: (_ctx, error) => {
        reported = error;
      },
    }),
    { kind: "error", error: failure },
  );
  assert.equal(reported, failure);
});

test("runLiveChoice degrades RPC to ordinary selection without preview or shortcuts", async () => {
  let previews = 0;
  const rpc = createRpcHarness([
    {
      kind: "select",
      options: [
        "Minimal — current · Small output",
        "[-] Blocked [31m — unavailable: Missing font · Unavailable profile",
        "Full — Everything",
        "← Back",
      ],
      response: "Full — Everything",
    },
  ]);
  const base = createMockContext({ mode: "rpc", hasUI: true }).ctx as unknown as {
    ui: Record<string, unknown>;
    [key: string]: unknown;
  };
  const context = { ...base, ui: { ...base.ui, ...rpc.ui } } as never;
  const result = await runLiveChoice(context, {
    title: "Preset",
    items: choices,
    currentItemId: "minimal",
    enableSearch: true,
    shortcuts: [{ id: "customize", keys: ["e"], label: "customize" }],
    onSelectionChange: () => {
      previews += 1;
    },
  });
  assert.deepEqual(result, { kind: "selected", itemId: "full" });
  assert.equal(previews, 0);
  rpc.assertConsumed();
});

test("runLiveChoice keeps confirmation-gated RPC rows explanatory and inert", async () => {
  let previews = 0;
  const options = ["Same — current · cannot apply: Already active · Currently applied", "Same", "Close"];
  const rpc = createRpcHarness([
    { kind: "select", options, response: options[0] },
    { kind: "select", options, response: options[1] },
  ]);
  const base = createMockContext({ mode: "rpc", hasUI: true }).ctx as unknown as {
    ui: Record<string, unknown>;
    [key: string]: unknown;
  };
  const context = { ...base, ui: { ...base.ui, ...rpc.ui } } as never;
  assert.deepEqual(
    await runLiveChoice(context, {
      title: "Preset",
      items: [
        { ...confirmationGatedChoices[0], label: "Same" },
        { ...confirmationGatedChoices[1], label: "Same" },
      ],
      currentItemId: "active",
      confirmLabel: "apply",
      hint: "close",
      shortcuts: [{ id: "customize", keys: ["e"], label: "customize" }],
      onSelectionChange: () => {
        previews += 1;
      },
    }),
    { kind: "selected", itemId: "other" },
  );
  assert.equal(previews, 0);
  rpc.assertConsumed();
});

test("runLiveChoice preserves raw identity for duplicate RPC labels", async () => {
  const options = ["Same", "Same [2]", "← Back"];
  const rpc = createRpcHarness([{ kind: "select", options, response: options[1] }]);
  const base = createMockContext({ mode: "rpc", hasUI: true }).ctx as unknown as {
    ui: Record<string, unknown>;
    [key: string]: unknown;
  };
  const context = { ...base, ui: { ...base.ui, ...rpc.ui } } as never;
  assert.deepEqual(
    await runLiveChoice(context, {
      title: "Preset",
      items: [
        { id: "first", label: "Same" },
        { id: "second", label: "Same" },
      ],
    }),
    { kind: "selected", itemId: "second" },
  );
  rpc.assertConsumed();
});

test("runLiveChoice follows the requested RPC cancellation hint for gated rows", async () => {
  const options = ["Active preset — cannot select: Already active · Currently applied", "Close"];
  const rpc = createRpcHarness([
    { kind: "select", options, response: options[0] },
    { kind: "select", options, response: "Close" },
  ]);
  const base = createMockContext({ mode: "rpc", hasUI: true }).ctx as unknown as {
    ui: Record<string, unknown>;
    [key: string]: unknown;
  };
  const context = { ...base, ui: { ...base.ui, ...rpc.ui } } as never;
  assert.deepEqual(
    await runLiveChoice(context, {
      title: "Preset",
      items: [confirmationGatedChoices[0]],
      hint: "close",
    }),
    { kind: "closed", reason: "close" },
  );
  rpc.assertConsumed();
});

test("runLiveChoice keeps disabled RPC rows inert and preserves deterministic Back", async () => {
  const options = [
    "Minimal — current · Small output",
    "[-] Blocked [31m — unavailable: Missing font · Unavailable profile",
    "Full — Everything",
    "← Back",
  ];
  const rpc = createRpcHarness([
    { kind: "select", options, response: options[1] },
    { kind: "select", options, response: "← Back" },
  ]);
  const base = createMockContext({ mode: "rpc", hasUI: true }).ctx as unknown as {
    ui: Record<string, unknown>;
    [key: string]: unknown;
  };
  const context = { ...base, ui: { ...base.ui, ...rpc.ui } } as never;
  assert.deepEqual(
    await runLiveChoice(context, {
      title: "Preset",
      items: choices,
      currentItemId: "minimal",
    }),
    { kind: "closed", reason: "back" },
  );
  rpc.assertConsumed();
});

test("runLiveChoice gives stale ownership precedence over preview and RPC failures", async () => {
  const failure = new Error("Late preview failed");
  const owner = new AbortController();
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let reports = 0;
  const tui = createTuiHarness();
  const tuiContext = createMockContext({ mode: "tui", hasUI: true, custom: tui.custom });
  const running = runLiveChoice(tuiContext.ctx, {
    title: "Preset",
    items: choices,
    signal: owner.signal,
    onSelectionChange: async () => {
      await gate;
      throw failure;
    },
    onError: () => {
      reports += 1;
    },
  });
  await tui.waitForOpen();
  owner.abort(new DOMException("Session replaced", "AbortError"));
  release();
  assert.deepEqual(await running, { kind: "stale" });
  assert.equal(reports, 0);

  const rpcOwner = new AbortController();
  const rpc = createRpcHarness([{ kind: "select", waitForAbort: true }]);
  const base = createMockContext({ mode: "rpc", hasUI: true }).ctx as unknown as {
    ui: Record<string, unknown>;
    [key: string]: unknown;
  };
  const rpcContext = { ...base, ui: { ...base.ui, ...rpc.ui } } as never;
  const rpcRunning = runLiveChoice(rpcContext, {
    title: "Preset",
    items: choices,
    signal: rpcOwner.signal,
  });
  await rpc.waitForCall();
  rpcOwner.abort(new DOMException("Session replaced", "AbortError"));
  assert.deepEqual(await rpcRunning, { kind: "stale" });
  rpc.assertConsumed();
});

test("runLiveChoice reports unsupported modes and unsupported callback failures", async () => {
  const printContext = createMockContext({ mode: "print", hasUI: false });
  let unsupportedMode = "";
  assert.deepEqual(
    await runLiveChoice(printContext.ctx, {
      title: "Preset",
      items: choices,
      onUnsupportedMode: (_ctx, mode) => {
        unsupportedMode = mode;
      },
    }),
    { kind: "unsupported", mode: "print" },
  );
  assert.equal(unsupportedMode, "print");

  const failure = new Error("Fallback failed");
  let reported: unknown;
  assert.deepEqual(
    await runLiveChoice(printContext.ctx, {
      title: "Preset",
      items: choices,
      onUnsupportedMode: () => {
        throw failure;
      },
      onError: (_ctx, error) => {
        reported = error;
      },
    }),
    { kind: "error", error: failure },
  );
  assert.equal(reported, failure);
});
