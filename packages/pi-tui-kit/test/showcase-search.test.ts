import { stripVTControlCharacters } from "node:util";
import { CURSOR_MARKER, KeybindingsManager, TUI_KEYBINDINGS, visibleWidth } from "@earendil-works/pi-tui";
import { resolveMenuScreen, runMenu } from "@narumitw/pi-tui-kit";
import { createTuiHarness, type TuiHarness, type TuiHarnessOptions } from "@narumitw/pi-tui-kit/testing";
import { expect, type TestContext, test, vi } from "vitest";
import { createMockContext } from "../../../test/support.js";
import { createInitialShowcaseState, createShowcaseMenu } from "../scripts/showcase/menu.js";

function startMenu(t: TestContext, options: TuiHarnessOptions = {}) {
  const tui = createTuiHarness({ width: 100, rows: 30, ...options });
  const { ctx } = createMockContext({ mode: "tui", hasUI: true, custom: tui.custom });
  const state = createInitialShowcaseState();
  const requestStandalone = vi.fn();
  const menu = createShowcaseMenu({ requestStandalone });
  const owner = new AbortController();
  const running = runMenu(ctx, menu, { getState: () => state, signal: owner.signal });
  t.onTestFinished(async () => {
    owner.abort();
    tui.dispose();
    await running;
  });
  return { tui, state, menu, requestStandalone, owner, running };
}

function activateFilteredEntry(tui: TuiHarness, items: readonly { id: string; label: string }[], itemId: string) {
  const item = items.find((candidate) => candidate.id === itemId);
  if (!item) throw new Error(`Missing showcase entry: ${itemId}`);
  tui.type(item.label);
  for (let index = 0; index < items.length; index += 1) {
    if (tui.render().join("\n").includes(`→ ${item.label}`)) {
      tui.press("tui.select.confirm");
      return;
    }
    tui.press("tui.select.down");
  }
  throw new Error(`Showcase entry not found in filtered results: ${itemId}`);
}

const keysets = [
  {
    name: "default",
    keybindings: new KeybindingsManager(TUI_KEYBINDINGS),
    up: "\u001b[A",
    down: "\u001b[B",
    confirm: "\r",
  },
  {
    name: "remapped",
    keybindings: new KeybindingsManager(TUI_KEYBINDINGS, {
      "tui.select.up": ["ctrl+p"],
      "tui.select.down": ["ctrl+n"],
      "tui.select.confirm": ["alt+enter"],
      "tui.select.cancel": ["alt+q"],
    }),
    up: "\u0010",
    down: "\u000e",
    confirm: "\u001b\r",
  },
];

test.for(keysets)("showcase search uses descriptions and $name selection keys", async (keys, t) => {
  const { tui, running, requestStandalone } = startMenu(t, { keybindings: keys.keybindings });
  await tui.waitForOpen();
  tui.setFocused(true);
  expect(tui.isFocusable).toBe(true);
  expect(tui.render().join("\n")).toContain(CURSOR_MARKER);

  tui.type("task");
  const first = tui.render().join("\n");
  tui.send(keys.down);
  expect(tui.render().join("\n")).not.toBe(first);
  tui.send(keys.up);
  expect(tui.render().join("\n")).toBe(first);

  tui.send("\u0015");
  tui.type("safety deadline");
  const filtered = tui.render().join("\n");
  expect(filtered).toContain("→ Task cancellation");
  expect(filtered).not.toContain("Task loader");
  expect(filtered).not.toContain("Native pointer");
  tui.send(keys.confirm);
  expect(await running).toEqual({ kind: "closed", reason: "close" });
  expect(requestStandalone.mock.calls).toEqual([["taskCancel"]]);
});

test("showcase search supports no-match recovery, native editing, split paste, and bounded resize", async (t) => {
  const { tui, running, requestStandalone } = startMenu(t);
  await tui.waitForOpen();
  tui.setFocused(true);
  tui.type("zzzz-showcase-no-match");
  expect(tui.render().join("\n")).toContain("No matching choices");
  tui.press("tui.select.confirm");
  expect(tui.isOpen).toBe(true);
  expect(requestStandalone).not.toHaveBeenCalled();

  tui.send("\u0015");
  expect(tui.render().join("\n")).toContain("Actions screen");
  tui.send("\u001b[200~copy ");
  tui.send("capture\u001b[201~");
  tui.send("\u007f");
  tui.type("e");
  expect(tui.render().join("\n")).toContain("copy capture");
  expect(tui.render().join("\n")).toContain("→ In-memory copy capture");
  for (const size of [
    { width: 1, rows: 4 },
    { width: 20, rows: 8 },
    { width: 100, rows: 30 },
  ]) {
    tui.invalidate();
    const lines = tui.resize(size);
    expect(lines.length).toBeLessThanOrEqual(Math.max(1, size.rows - 3));
    expect(lines.every((line) => visibleWidth(line) <= size.width)).toBe(true);
  }
  expect(tui.render().join("\n")).toContain("→ In-memory copy capture");
  expect(tui.render().join("\n")).toContain(CURSOR_MARKER);
  tui.press("tui.select.confirm");
  expect(await running).toEqual({ kind: "closed", reason: "close" });
  expect(requestStandalone.mock.calls).toEqual([["copy"]]);
});

test.for([
  ["actions", "actions"],
  ["detail", "detail"],
  ["browse", "browse"],
  ["choice", "choice"],
  ["settings", "settings"],
  ["input", "input"],
  ["review", "review"],
  ["multi-select", "multiSelect"],
  ["runtime", "runtime"],
  ["prefill", "prefill"],
] as const)("filtered showcase entry %s retains its screen route", async ([itemId, target], t) => {
  const { tui, menu, state, requestStandalone } = startMenu(t, { width: 40 });
  const main = resolveMenuScreen(menu, "main", state);
  expect(main.kind).toBe("choice");
  if (main.kind !== "choice") return;
  await tui.waitForOpen();
  activateFilteredEntry(tui, main.items, itemId);
  await tui.waitForOpen();
  const frame = tui.render().join("\n");
  expect(frame).toContain(resolveMenuScreen(menu, target, state).title);
  expect(frame).not.toContain("Pi TUI Kit Showcase");
  expect(requestStandalone).not.toHaveBeenCalled();
});

test.for([
  ["questionnaire", "questionnaire"],
  ["task", "task"],
  ["confirmation", "confirmation"],
  ["live-choice", "liveChoice"],
  ["secret", "secret"],
  ["model", "model"],
  ["thinking", "thinking"],
  ["theme", "theme"],
  ["taskFailure", "taskFailure"],
  ["taskCancel", "taskCancel"],
  ["native", "native"],
  ["copy", "copy"],
] as const)("filtered showcase entry %s retains its standalone route", async ([itemId, interaction], t) => {
  const { tui, menu, state, running, requestStandalone } = startMenu(t, { width: 40 });
  const main = resolveMenuScreen(menu, "main", state);
  expect(main.kind).toBe("choice");
  if (main.kind !== "choice") return;
  await tui.waitForOpen();
  activateFilteredEntry(tui, main.items, itemId);
  expect(await running).toEqual({ kind: "closed", reason: "close" });
  expect(requestStandalone.mock.calls).toEqual([[interaction]]);
});

test("returning from a filtered demo restores the launcher selection and clears the query", async (t) => {
  const { tui } = startMenu(t);
  await tui.waitForOpen();
  tui.type("wrapped prose");
  tui.press("tui.select.confirm");
  await tui.waitForOpen();
  expect(tui.render().join("\n")).toContain("Detail screens are for read-only explanations.");
  tui.press("tui.select.cancel");
  await tui.waitForOpen();
  const lines = tui.render().map(stripVTControlCharacters);
  expect(lines.join("\n")).toContain("Pi TUI Kit Showcase");
  expect(lines.join("\n")).toContain("→ Detail screen");
  expect(lines.find((line) => line.includes("Search:"))).not.toContain("wrapped prose");
});

test("the searchable Close entry still closes without opening a demo", async (t) => {
  const { tui, running, requestStandalone } = startMenu(t);
  await tui.waitForOpen();
  tui.type("Close");
  expect(tui.render().join("\n")).toContain("→ Close");
  tui.press("tui.select.confirm");
  expect(await running).toEqual({ kind: "closed", reason: "close" });
  expect(requestStandalone).not.toHaveBeenCalled();
});

test.for(["cancel", "hard cancel", "abort", "dispose"] as const)(
  "showcase search releases the menu on %s without opening a demo",
  async (ending, t) => {
    const { tui, running, requestStandalone, owner } = startMenu(t, { keybindings: keysets[1].keybindings });
    await tui.waitForOpen();
    tui.type("unmatched");
    if (ending === "cancel") tui.send("\u001bq");
    else if (ending === "hard cancel") tui.press("ctrl+c");
    else if (ending === "abort") owner.abort();
    else tui.dispose();
    expect(await running).toEqual(ending === "abort" ? { kind: "stale" } : { kind: "closed", reason: "close" });
    expect(tui.isOpen).toBe(false);
    expect(requestStandalone).not.toHaveBeenCalled();
  },
);
