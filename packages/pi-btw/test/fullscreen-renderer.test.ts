import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import { KeybindingsManager, ScrollView, type TUI, TUI_KEYBINDINGS, VStack } from "@earendil-works/pi-tui";
import { test, vi } from "vitest";
import { createBtwFullscreenTui } from "../src/fullscreen-renderer.js";

function renderer(copy: (text: string) => Promise<void> = async () => {}) {
  let input!: (data: string) => void;
  const writes: string[] = [];
  const terminal = {
    rows: 8,
    columns: 60,
    start(callback: (data: string) => void) {
      input = callback;
    },
    stop() {},
    write(data: string) {
      writes.push(data);
    },
    hideCursor() {},
    showCursor() {},
  };
  const parent = { terminal, getShowHardwareCursor: () => false } as unknown as TUI;
  const theme = {
    fg: (_role: string, text: string) => text,
    bg: (_role: string, text: string) => text,
    underline: (text: string) => `\u001b[4m${text}\u001b[24m`,
    inverse: (text: string) => text,
    bold: (text: string) => text,
  } as never;
  const tui = createBtwFullscreenTui(
    parent,
    theme,
    new KeybindingsManager(TUI_KEYBINDINGS),
    true,
    true,
    () => {},
    copy,
  );
  return { tui, writes, input: (data: string) => input(data) };
}

test("native renderer uses auto wheel acceleration and does not route unsupported right-click paste", () => {
  const { tui, input } = renderer();
  const scroll = new ScrollView(
    { render: () => Array.from({ length: 100 }, (_, i) => `line ${i}`), invalidate() {} },
    { primary: true },
  );
  tui.setLayoutRoot(new VStack([{ component: scroll, grow: 1, basis: 0 }]));
  const clock = vi.spyOn(performance, "now");
  try {
    tui.start();
    tui.renderNow(true);
    clock.mockReturnValue(1000);
    input("\u001b[<65;10;2M");
    assert.equal(scroll.scrollTop, 1);
    clock.mockReturnValue(1020);
    input("\u001b[<65;10;2M");
    // Native macOS terminals already accelerate wheel input; SSH and other
    // platforms apply the native velocity accelerator instead.
    const localMac =
      process.platform === "darwin" &&
      ["SSH_CONNECTION", "SSH_CLIENT", "SSH_TTY"].every((key) => process.env[key] === undefined);
    assert.equal(scroll.scrollTop, localMac ? 2 : 6);
    assert.equal(Reflect.get(tui, "onRightClickPaste"), undefined);
  } finally {
    clock.mockRestore();
    tui.stop();
  }
});

test("late clipboard feedback cannot create flash timers after terminal ownership moves", () => {
  const { tui } = renderer();
  const flashes = Reflect.get(tui, "flashes") as { render(width: number): string[] };
  tui.start();
  try {
    tui.flash?.("live copy feedback");
    assert.match(flashes.render(60).join("\n"), /live copy feedback/u);
  } finally {
    tui.stop();
  }
  tui.flash?.("late copy feedback");
  assert.deepEqual(flashes.render(60), []);
});

test("search navigation buttons use native hover styling and clipboard errors cannot inject terminal controls", async () => {
  const { tui } = renderer(async () => {
    throw new Error("clipboard\u001b[2Junavailable\nretry");
  });
  const style = Reflect.get(tui, "searchNavigationButtonStyle") as (text: string, hovered: boolean) => string;
  assert.equal(style("next", false), "next");
  assert.equal(style("next", true), "\u001b[4mnext\u001b[24m");
  const copy = Reflect.get(tui, "copySelection") as (text: string) => Promise<boolean | string>;
  const failure = await copy("selected");
  assert.equal(typeof failure, "string");
  assert.equal(failure, stripVTControlCharacters(String(failure)));
  assert.equal(
    ["\r", "\n", "\u001b"].some((control) => String(failure).includes(control)),
    false,
  );
  assert.match(String(failure), /clipboard.*unavailable.*retry/u);
});
