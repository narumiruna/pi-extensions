import assert from "node:assert/strict";
import { type ExtensionCommandContext, initTheme } from "@earendil-works/pi-coding-agent";
import {
  CURSOR_MARKER,
  getKeybindings,
  KeybindingsManager,
  setKeybindings,
  TUI_KEYBINDINGS,
  visibleWidth,
} from "@earendil-works/pi-tui";
import { createTuiHarness } from "@narumitw/pi-tui-kit/testing";
import { test, vi } from "vitest";
import { plainTuiText as stripVTControlCharacters } from "../../../test/tui-text.js";
import { showProgressSettings } from "../src/progress-settings-ui.js";
import { DEFAULT_PROGRESS_SETTINGS } from "../src/settings.js";
import { createContext } from "./progress-harness.js";

initTheme("dark");

async function openInput(t: { onTestFinished(callback: () => Promise<void>): void }, initial: number | null = null) {
  const current = createContext();
  const keybindings = getKeybindings();
  const tui = createTuiHarness({ keybindings });
  Object.assign(current.ctx.ui, { custom: tui.custom });
  let settings = { ...DEFAULT_PROGRESS_SETTINGS, maxVisibleItems: initial };
  const save = vi.fn(async (patch) => ({ ...settings, ...patch }));
  const controller = new AbortController();
  const running = showProgressSettings(current.ctx as ExtensionCommandContext, {
    signal: controller.signal,
    isCurrent: () => !controller.signal.aborted,
    get: () => settings,
    save,
    apply: (next) => {
      settings = next;
    },
  });
  t.onTestFinished(async () => {
    controller.abort();
    tui.dispose();
    await running;
  });
  await tui.waitForOpen();
  tui.setFocused(true);
  for (let index = 0; index < 3; index++) tui.press("tui.select.down");
  tui.press("tui.select.confirm");
  const frame = () => stripVTControlCharacters(tui.render().join("\n").replaceAll(CURSOR_MARKER, ""));
  assert.match(frame(), /Visible item limit/u);
  return { tui, save, frame, current, running, settings: () => settings };
}

for (const value of ["1", "17", "50", " 12 ", "007"]) {
  test(`accepts the entered item limit ${JSON.stringify(value)}`, async (t) => {
    const screen = await openInput(t);
    screen.tui.type(value);
    screen.tui.press("tui.input.submit");
    await vi.waitFor(() => assert.equal(screen.settings().maxVisibleItems, Number(value)));
    assert.deepEqual(screen.save.mock.calls[0]?.[0], { maxVisibleItems: Number(value) });
    assert.match(screen.frame(), /Progress Settings/u);
  });
}

for (const value of ["0", "51", "-1", "1.5", "0x10", "1e1", "none", "text", "9007199254740993"]) {
  test(`rejects ${JSON.stringify(value)} and retains the draft for correction`, async (t) => {
    const screen = await openInput(t);
    screen.tui.type(value);
    screen.tui.press("tui.input.submit");
    assert.equal(screen.save.mock.calls.length, 0);
    assert.equal(screen.settings().maxVisibleItems, null);
    assert.match(screen.frame(), /Enter a whole number from 1 to 50/u);
    assert.ok(screen.frame().includes(`> ${value}`));
    screen.tui.send("\u0015");
    screen.tui.type("10");
    screen.tui.press("tui.input.submit");
    await vi.waitFor(() => assert.equal(screen.settings().maxVisibleItems, 10));
  });
}

test("prefills the current value and accepts a blank field as no limit", async (t) => {
  const screen = await openInput(t, 17);
  assert.match(screen.frame(), /> 17/u);
  screen.tui.press("end");
  screen.tui.send("\u0015");
  screen.tui.press("tui.input.submit");
  await vi.waitFor(() => assert.equal(screen.settings().maxVisibleItems, null));
  assert.deepEqual(screen.save.mock.calls[0]?.[0], { maxVisibleItems: null });
});

test("keeps native Backspace, cursor movement, newline submission, and bracketed paste behavior", async (t) => {
  const screen = await openInput(t);
  screen.tui.send("\u001b[200~1\r\n0\u001b[201~");
  assert.match(screen.frame(), /> 10/u);
  assert.equal(screen.save.mock.calls.length, 0);
  screen.tui.send("\u007f");
  screen.tui.type("5");
  screen.tui.send("\n");
  await vi.waitFor(() => assert.equal(screen.settings().maxVisibleItems, 15));
});

for (const raw of ["1\u001b[31m0", "1\u202e0", "1\u00030"]) {
  test(`unsafe paste is not rendered or accepted: ${JSON.stringify(raw)}`, async (t) => {
    const screen = await openInput(t);
    screen.tui.send(`\u001b[200~${raw}\u001b[201~`);
    assert.match(screen.frame(), /Invalid pasted text/u);
    assert.ok(!screen.tui.render().join("\n").includes(raw));
    screen.tui.press("tui.input.submit");
    assert.equal(screen.save.mock.calls.length, 0);
    screen.tui.send("\u0015");
    screen.tui.type("20");
    screen.tui.press("tui.input.submit");
    await vi.waitFor(() => assert.equal(screen.settings().maxVisibleItems, 20));
  });
}

test("fragmented paste does not treat pasted Ctrl+C as a key, but trailing Ctrl+C closes the flow", async (t) => {
  const screen = await openInput(t);
  screen.tui.send("\u001b[200~1");
  screen.tui.send("\u0003");
  assert.equal(screen.tui.isOpen, true);
  screen.tui.send("0\u001b[201~");
  assert.match(screen.frame(), /Invalid pasted text/u);
  screen.tui.send("\u0015");
  screen.tui.send("\u001b[200~25\u001b[201~\u0003");
  await screen.running;
  assert.equal(screen.tui.isOpen, false);
  assert.equal(screen.save.mock.calls.length, 0);
});

test("a submit key after the paste end uses the complete pasted value", async (t) => {
  const screen = await openInput(t);
  screen.tui.send("\u001b[200~25\u001b[201~\r");
  await vi.waitFor(() => assert.equal(screen.settings().maxVisibleItems, 25));
});

test("Escape cancels the field without changing settings; Ctrl+C closes the Settings screen", async (t) => {
  const screen = await openInput(t, 17);
  screen.tui.press("end");
  screen.tui.type("5");
  screen.tui.press("tui.select.cancel");
  assert.match(screen.frame(), /Progress Settings/u);
  assert.equal(screen.settings().maxVisibleItems, 17);
  assert.equal(screen.save.mock.calls.length, 0);
  screen.tui.press("ctrl+c");
  await screen.running;
  assert.equal(screen.tui.isOpen, false);
});

test("non-default submit and cancellation keys work and the hints use those keys", async (t) => {
  const original = getKeybindings();
  const bindings = new KeybindingsManager(TUI_KEYBINDINGS, {
    "tui.input.submit": "ctrl+s",
    "tui.select.cancel": "ctrl+x",
  });
  setKeybindings(bindings);
  try {
    const screen = await openInput(t);
    assert.match(screen.frame(), /ctrl\+s save/u);
    assert.match(screen.frame(), /ctrl\+x back/u);
    assert.match(screen.frame(), /ctrl\+c close/u);
    screen.tui.type("12");
    screen.tui.send("\u0013");
    await vi.waitFor(() => assert.equal(screen.settings().maxVisibleItems, 12));
    screen.tui.press("tui.select.confirm");
    screen.tui.send("\u0018");
    assert.match(screen.frame(), /Progress Settings/u);
    screen.tui.press("tui.select.confirm");
    screen.tui.press("ctrl+c");
    await screen.running;
    assert.equal(screen.save.mock.calls.length, 1);
  } finally {
    setKeybindings(original);
  }
});

test("input focus reaches the native cursor and the draft survives small terminal sizes", async (t) => {
  const screen = await openInput(t);
  assert.equal(screen.tui.isFocusable, true);
  screen.tui.type("50");
  assert.ok(screen.tui.render().join("\n").includes(CURSOR_MARKER));
  screen.tui.setFocused(false);
  assert.ok(!screen.tui.render().join("\n").includes(CURSOR_MARKER));
  screen.tui.setFocused(true);
  for (const rows of [4, 7, 8, 24]) {
    for (const width of [1, 4, 20, 80]) {
      screen.tui.resize({ rows, width });
      const lines = screen.tui.render();
      assert.ok(lines.length <= Math.max(1, rows - 3));
      for (const line of lines) assert.ok(visibleWidth(line) <= width);
    }
  }
  screen.tui.press("tui.input.submit");
  await vi.waitFor(() => assert.equal(screen.settings().maxVisibleItems, 50));
});
