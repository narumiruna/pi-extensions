import { readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { stripVTControlCharacters } from "node:util";
import { type ExtensionCommandContext, initTheme, type Theme } from "@earendil-works/pi-coding-agent";
import { KeybindingsManager, parseColor, TUI_KEYBINDINGS, visibleWidth } from "@earendil-works/pi-tui";
import { PI_EXTENSION_MENU_API_VERSION, runMenu } from "@narumitw/pi-tui-kit";
import { createTuiHarness } from "@narumitw/pi-tui-kit/testing";
import { expect, test, vi } from "vitest";
import { createMockContext } from "../../../test/support.js";
import { createInitialShowcaseState, createShowcaseMenu } from "../scripts/showcase/menu.js";
import { inspectShowcaseRuntime } from "../scripts/showcase/runtime-info.js";
import { runSyntheticInput } from "../scripts/showcase/synthetic-inputs.js";
import { runShowcaseTask } from "../scripts/showcase/task-demo.js";
import { runThemeDemo, themeSampleLines } from "../scripts/showcase/theme-demo.js";

initTheme("dark", false);

const ownerOptions = (owner = new AbortController()) => ({
  signal: owner.signal,
  isCurrent: () => !owner.signal.aborted,
});

// Real Input bindings include editing and paste behavior, not just menu navigation.
function editingKeys() {
  return new KeybindingsManager(
    {
      ...TUI_KEYBINDINGS,
      "app.models.save": { defaultKeys: ["ctrl+s"], description: "Synthetic default intent" },
      "app.thinking.save": { defaultKeys: ["ctrl+s"], description: "Synthetic default intent" },
    },
    {
      "tui.select.cancel": ["alt+q"],
    },
  );
}

test("showcase runtime identifies the actual local built Kit module", async () => {
  const manifest = JSON.parse(readFileSync("packages/pi-tui-kit/package.json", "utf8"));
  const info = await inspectShowcaseRuntime();
  expect(info).toEqual({
    version: manifest.version,
    apiVersion: PI_EXTENSION_MENU_API_VERSION,
    origin: realpathSync(path.resolve("packages/pi-tui-kit/dist/index.js")),
  });
  expect(info.origin).toBe(stripVTControlCharacters(info.origin));
});

test.each(["submit", "cancel", "replace", "dispose"] as const)(
  "synthetic secret %s never retains its payload",
  async (outcome) => {
    const tui = createTuiHarness({ width: 80, keybindings: editingKeys() });
    const { ctx, notifications } = createMockContext({ mode: "tui", hasUI: true, custom: tui.custom });
    const state = createInitialShowcaseState();
    const owner = new AbortController();
    const pending = runSyntheticInput(ctx, state, "secret", ownerOptions(owner));
    await tui.waitForOpen();
    tui.send("\u001b[200~synthetic-secret\u001b[201~");
    const before = tui.render().join("\n");
    tui.invalidate();
    const after = tui.resize({ width: 18 }).join("\n");
    if (outcome === "submit") tui.press("tui.input.submit");
    else if (outcome === "cancel") tui.press("ctrl+c");
    else if (outcome === "replace") owner.abort();
    else tui.dispose();
    await pending;
    expect(before).toContain("•");
    expect([before, after, JSON.stringify(state), JSON.stringify(notifications)].join("\n")).not.toContain(
      "synthetic-secret",
    );
    expect(tui.isOpen).toBe(false);
    if (outcome === "replace") expect(state.log).toHaveLength(1);
  },
);

test("editable prefill preserves native editing, paste, cancellation, and the exact draft", async () => {
  const tui = createTuiHarness({ width: 80, rows: 30, keybindings: editingKeys() });
  const { ctx } = createMockContext({ mode: "tui", hasUI: true, custom: tui.custom });
  const state = createInitialShowcaseState();
  const owner = new AbortController();
  const menu = { ...createShowcaseMenu({ requestStandalone() {} }), start: "prefill" as const };
  const pending = runMenu(ctx, menu, { getState: () => state, ...ownerOptions(owner) });
  await tui.waitForOpen();
  tui.press("end");
  tui.send("\u007f");
  tui.send("\u001b[200~X\nY\tZ\u001b[201~");
  tui.invalidate();
  const small = tui.resize({ width: 22, rows: 10 });
  tui.resize({ width: 80, rows: 30 });
  const draft = tui.render().join("\n");
  tui.press("tui.input.submit");
  await pending;
  expect(state.prefillText).toBe("Synthetic editable drafXY    Z");
  expect(draft).toContain("drafXY    Z");
  expect(small.every((line) => visibleWidth(line) <= 22)).toBe(true);
  const cancelling = runMenu(ctx, menu, { getState: () => state, ...ownerOptions(owner) });
  await tui.waitForOpen();
  tui.type("discard me");
  tui.press("ctrl+c");
  await cancelling;
  expect(state.prefillText).toBe("Synthetic editable drafXY    Z");
});

test("synthetic selectors retain current/default state and record only memory save intents", async () => {
  const tui = createTuiHarness({ width: 100, keybindings: editingKeys() });
  const { ctx, notifications } = createMockContext({ mode: "tui", hasUI: true, custom: tui.custom });
  const state = createInitialShowcaseState();
  const options = ownerOptions();
  let pending = runSyntheticInput(ctx, state, "model", options);
  await tui.waitForOpen();
  const frame = tui.render().join("\n");
  tui.type("balanced");
  tui.invalidate();
  tui.resize({ width: 32 });
  tui.resize({ width: 100 });
  const filtered = tui.render().join("\n");
  tui.send("\u0013");
  await pending;
  expect(frame).toContain("✓ synthetic-fast");
  expect(frame).toContain("synthetic-deep [demo-beta] · default");
  expect(filtered).toContain("synthetic-balanced");
  expect(state.model.id).toBe("synthetic-fast");
  expect(state.defaultModel.id).toBe("synthetic-balanced");

  pending = runSyntheticInput(ctx, state, "model", options);
  await tui.waitForOpen();
  tui.type("synthetic-deep");
  const selectionFrame = tui.render().join("\n");
  tui.press("tui.select.confirm");
  await pending;
  expect(state.model.id, selectionFrame).toBe("synthetic-deep");
  pending = runSyntheticInput(ctx, state, "thinking", options);
  await tui.waitForOpen();
  const thinkingFrame = tui.render().join("\n");
  tui.type("low");
  tui.send("\u0013");
  await pending;
  expect(thinkingFrame).toContain("✓ medium");
  expect(thinkingFrame).toContain("high");
  expect(thinkingFrame).toContain("default");
  expect(state.thinking).toBe("medium");
  expect(state.defaultThinking).toBe("low");
  pending = runSyntheticInput(ctx, state, "thinking", options);
  await tui.waitForOpen();
  tui.type("high");
  tui.press("tui.select.confirm");
  await pending;
  expect(state.thinking).toBe("high");
  expect(state.defaultThinking).toBe("low");
  expect(notifications).toEqual([]);
  expect(state.log.join("\n")).toContain("memory only");
});

test.each(["model", "thinking"] as const)("%s selection is discarded on owner replacement", async (kind) => {
  const tui = createTuiHarness({ keybindings: editingKeys() });
  const { ctx, notifications } = createMockContext({ mode: "tui", hasUI: true, custom: tui.custom });
  const state = createInitialShowcaseState();
  const before = JSON.stringify(state);
  const owner = new AbortController();
  const pending = runSyntheticInput(ctx, state, kind, ownerOptions(owner));
  await tui.waitForOpen();
  tui.press("tui.select.down");
  owner.abort();
  await pending;
  expect(JSON.stringify(state)).toBe(before);
  expect(notifications).toEqual([]);
});

test.each(["task", "taskFailure", "taskCancel"] as const)(
  "bounded %s releases work and permits retry",
  async (scenario) => {
    vi.useFakeTimers();
    const tui = createTuiHarness();
    const { ctx, notifications } = createMockContext({ mode: "tui", hasUI: true, custom: tui.custom });
    const state = createInitialShowcaseState();
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const pending = runShowcaseTask(ctx, state, scenario, ownerOptions());
      await tui.waitForOpen();
      if (scenario === "taskCancel") tui.press("ctrl+c");
      else await vi.advanceTimersByTimeAsync(250);
      await pending;
      expect(tui.isOpen).toBe(false);
      expect(vi.getTimerCount()).toBe(0);
    }
    expect(state.log.join("\n")).toMatch(
      scenario === "task" ? /completed/u : scenario === "taskFailure" ? /failed/u : /cancelled/u,
    );
    expect(notifications.every(({ message }) => !message.includes("Error:"))).toBe(true);
  },
);

test.each(["abort", "dispose"] as const)("task %s releases the timer without stale feedback", async (ending) => {
  vi.useFakeTimers();
  const tui = createTuiHarness();
  const { ctx, notifications } = createMockContext({ mode: "tui", hasUI: true, custom: tui.custom });
  const state = createInitialShowcaseState();
  const owner = new AbortController();
  const pending = runShowcaseTask(ctx, state, "taskCancel", ownerOptions(owner));
  await tui.waitForOpen();
  if (ending === "abort") owner.abort();
  else tui.dispose();
  await pending;
  await vi.advanceTimersByTimeAsync(4000);
  expect(vi.getTimerCount()).toBe(0);
  expect(notifications).toEqual([]);
  expect(state.log).toHaveLength(1);
});

test("theme samples use the callback theme and distinguish active host from sample palettes", async () => {
  let appearance = "dark";
  const styles: unknown[] = [];
  const theme = {
    get name() {
      return appearance;
    },
    get appearance() {
      return appearance;
    },
    colors: { text: parseColor("#eeeeee"), accent: parseColor("#66aaff") },
    fg: (_role: string, text: string) => text,
    bold: (text: string) => text,
    style(text: string, style: unknown) {
      styles.push(style);
      return text;
    },
  } as unknown as Theme;
  const tui = createTuiHarness({ width: 100, rows: 40, keybindings: editingKeys() });
  const custom: ExtensionCommandContext["ui"]["custom"] = (factory, options) =>
    tui.custom((host, _theme, keys, done) => factory(host, theme, keys, done), options);
  const { ctx, notifications } = createMockContext({ mode: "tui", hasUI: true, custom });
  const pending = runThemeDemo(ctx, ownerOptions());
  await tui.waitForOpen();
  const frame = stripVTControlCharacters(tui.render().join("\n"));
  const rows = [];
  for (const size of [
    { width: 1, rows: 4 },
    { width: 20, rows: 8 },
    { width: 100, rows: 40 },
  ]) {
    tui.invalidate();
    rows.push({ size, lines: tui.resize(size) });
  }
  appearance = "light";
  tui.invalidate();
  const changed = tui.render().join("\n");
  tui.press("ctrl+c");
  await pending;
  expect(frame).toContain("Active host theme: dark · appearance: dark");
  expect(changed).toContain("Active host theme: light · appearance: light");
  expect(styles).toContainEqual({ fg: "success", bg: "toolSuccessBg", bold: true });
  expect(frame).toContain("Sample DARK palette — not the host theme");
  expect(frame).toContain("Sample LIGHT palette — not the host theme");
  expect(frame).toContain("theme.style()");
  expect(themeSampleLines(theme).join("\n")).toContain("colors.accent");
  for (const { size, lines } of rows) {
    expect(lines.length).toBeLessThanOrEqual(Math.max(1, size.rows - 3));
    expect(lines.every((line) => visibleWidth(line) <= size.width)).toBe(true);
  }
  expect(notifications).toEqual([]);
});
