import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import { type ExtensionCommandContext, initTheme } from "@earendil-works/pi-coding-agent";
import {
  CURSOR_MARKER,
  getKeybindings,
  KeybindingsManager,
  type OverlayHandle,
  setKeybindings,
  type TUI,
  TUI_KEYBINDINGS,
  TuiAltScreen,
  TuiMainScreen,
  visibleWidth,
} from "@earendil-works/pi-tui";
import { FullscreenTerminal } from "@narumitw/pi-tui-kit/testing";
import { test } from "vitest";
import { BtwFloatingFrame } from "../src/floating-frame.js";
import { runBtwFloating } from "../src/floating-ui.js";
import { BtwAnsweringView, BtwTranscriptPager, type TranscriptPagerAction } from "../src/transcript-pager.js";
import { appearanceTheme, response } from "./native-appearance-support.js";

const theme = appearanceTheme("dark");

const ESC = "\u001b";
const CTRL_C = "\u0003";
const F10 = `${ESC}[21~`;
const F11 = `${ESC}[23~`;

type Custom = ExtensionCommandContext["ui"]["custom"];

function harness(mode: TUI["mode"], keybindings = new KeybindingsManager(TUI_KEYBINDINGS)) {
  initTheme("dark");
  const oldKeys = getKeybindings();
  setKeybindings(keybindings);
  const terminal = new FullscreenTerminal();
  terminal.rows = 30;
  terminal.columns = 100;
  const parent = mode === "fullscreen" ? new TuiAltScreen(terminal) : new TuiMainScreen(terminal);
  const main = { render: () => ["Main conversation"], invalidate() {}, handleInput() {} };
  parent.addChild(main);
  parent.setFocus(main);
  parent.start();
  const controller = new AbortController();
  let overlay: OverlayHandle | undefined;
  let host: Awaited<ReturnType<Parameters<Custom>[0]>> | undefined;
  let opened = 0;
  let closed = 0;
  const custom: Custom = async (factory, options) => {
    const result = Promise.withResolvers<unknown>();
    opened++;
    let done = false;
    host = await factory(parent, theme, keybindings as Parameters<typeof factory>[2], (value) => {
      if (done) return;
      done = true;
      closed++;
      overlay?.hide();
      host?.dispose?.();
      result.resolve(value);
    });
    if (!done) {
      const opts = options?.overlayOptions;
      overlay = parent.showOverlay(host, typeof opts === "function" ? opts() : opts);
      options?.onHandle?.(overlay);
    }
    return result.promise as never;
  };
  let editor = "main draft";
  const ctx = {
    mode: "tui",
    hasUI: true,
    signal: controller.signal,
    ui: {
      custom,
      getEditorText: () => editor,
      setEditorText: (value: string) => {
        editor = value;
      },
    },
  } as unknown as ExtensionCommandContext;
  return {
    ctx,
    controller,
    parent,
    terminal,
    get host() {
      assert.ok(host);
      return host;
    },
    get closes() {
      return closed;
    },
    get opens() {
      return opened;
    },
    bounds() {
      parent.renderNow();
      const bounds = overlay?.getBounds();
      assert.ok(bounds);
      return bounds;
    },
    disposeHost() {
      overlay?.hide();
      host?.dispose?.();
      host?.dispose?.();
    },
    dispose() {
      controller.abort();
      parent.stop();
      setKeybindings(oldKeys);
    },
  };
}

for (const mode of ["regular", "fullscreen"] as const) {
  test(`floating BTW in ${mode} Pi keeps its rectangle, edit keys, and draft across pages`, async () => {
    const keys = new KeybindingsManager(TUI_KEYBINDINGS, {
      "tui.input.submit": "ctrl+s",
      "tui.altScreen.search": "f10",
      "tui.select.cancel": "ctrl+g",
    });
    const h = harness(mode, keys);
    const sibling = h.parent.showOverlay({ render: () => ["Not BTW"], invalidate() {} }, { width: 7 });
    const turns = Array.from({ length: 24 }, (_, i) => ({
      kind: "answered" as const,
      question: `Q${i}`,
      answer: `A${i}`,
      response: response(`A${i}`),
    }));
    const composer = Promise.withResolvers<BtwTranscriptPager>();
    const review = Promise.withResolvers<() => void>();
    const received: TranscriptPagerAction[] = [];
    let reviewDisposals = 0;
    const running = runBtwFloating(
      h.ctx,
      async (ctx) => {
        received.push(
          await ctx.ui.custom<TranscriptPagerAction>((tui, themed, keys, done) => {
            const pager = new BtwTranscriptPager(tui, themed, turns, done, {
              keybindings: keys,
              initialQuestion: " draft",
            });
            queueMicrotask(() => composer.resolve(pager));
            return pager;
          }),
        );
        await ctx.ui.custom<void>((_tui, _theme, _keys, done) => {
          queueMicrotask(() => review.resolve(done));
          return {
            render: () => ["Nested review"],
            invalidate() {},
            dispose: () => {
              reviewDisposals++;
            },
          };
        });
      },
      { exit: "ctrl+q" },
    );
    try {
      const page = await composer.promise;
      assert.deepEqual(h.bounds(), { row: 4, col: 15, width: 70, height: 21 });
      assert.match(stripVTControlCharacters(h.host.render(70)[0] ?? ""), /F11 move\/resize/i);
      assert.equal(page.focused, true);
      assert.ok(h.host.render(70).some((line) => line.includes(CURSOR_MARKER)));
      h.terminal.input(`${ESC}[6~`);
      assert.ok(page.getPrimaryScrollView().scrollTop > 0);
      h.terminal.input(F11);
      assert.equal(page.focused, false);
      h.terminal.input(`${ESC}[C`);
      h.terminal.input(`${ESC}[B`);
      h.terminal.input(`${ESC}[1;2C`);
      h.terminal.input(`${ESC}[1;2B`);
      assert.deepEqual(h.bounds(), { row: 5, col: 16, width: 71, height: 22 });
      h.terminal.input("\u0007");
      assert.equal(page.focused, true);
      h.terminal.input("\u007f");
      h.terminal.input(`${ESC}[200~字${ESC}[201~`);
      h.terminal.input("\u0013");
      await review.promise;
      assert.deepEqual(received, [{ kind: "submit", question: "draf字" }]);
      assert.deepEqual(h.bounds(), { row: 5, col: 16, width: 71, height: 22 });
      assert.match(h.host.render(71).join("\n"), /Nested review/);
      h.terminal.input(CTRL_C);
      await running;
      assert.equal(reviewDisposals, 1);
      assert.equal(h.opens, 1);
      assert.equal(h.closes, 1);
      assert.equal(sibling.isFocused(), true);
      assert.equal(h.ctx.ui.getEditorText(), "main draft");
      assert.deepEqual(
        h.terminal.events.map(({ name }) => name),
        ["start"],
      );
    } finally {
      h.dispose();
      await running;
    }
  });
}

test("the native fullscreen TUI drags the title and resize grip, and the overlay fits a tiny terminal", async () => {
  const h = harness("fullscreen");
  const ready = Promise.withResolvers<void>();
  const running = runBtwFloating(h.ctx, async (ctx) =>
    ctx.ui.custom(() => {
      queueMicrotask(() => ready.resolve());
      return { render: () => ["側邊視窗"], invalidate() {} };
    }),
  );
  const mouse = (button: number, col: number, row: number, suffix = "M") =>
    h.terminal.input(`${ESC}[<${button};${col + 1};${row + 1}${suffix}`);
  try {
    await ready.promise;
    const start = h.bounds();
    mouse(0, start.col + 2, start.row);
    mouse(32, start.col + 7, start.row + 2);
    mouse(0, start.col + 7, start.row + 2, "m");
    const moved = h.bounds();
    assert.deepEqual(moved, { ...start, col: start.col + 5, row: start.row + 2 });
    const grip = { x: moved.col + moved.width - 2, y: moved.row + moved.height - 1 };
    mouse(0, grip.x, grip.y);
    mouse(32, grip.x - 4, grip.y - 3);
    mouse(0, grip.x - 4, grip.y - 3, "m");
    assert.deepEqual(h.bounds(), { ...moved, width: moved.width - 4, height: moved.height - 3 });
    const remembered = h.bounds();
    h.terminal.columns = 2;
    h.terminal.rows = 1;
    assert.deepEqual(h.bounds(), { col: 0, row: 0, width: 2, height: 1 });
    assert.ok(h.host.render(2).every((line) => visibleWidth(line) <= 2));
    assert.deepEqual(h.host.render(0), []);
    h.terminal.columns = 100;
    h.terminal.rows = 30;
    assert.deepEqual(h.bounds(), remembered);
  } finally {
    h.dispose();
    await running;
  }
});

for (const stop of ["shutdown", "disposed"] as const) {
  test(`floating ${stop} closes once and disposes an asynchronously created page`, async () => {
    const h = harness("regular");
    const entered = Promise.withResolvers<AbortSignal>();
    const page = Promise.withResolvers<{ render(): string[]; invalidate(): void; dispose(): void }>();
    const disposed = Promise.withResolvers<void>();
    let disposals = 0;
    const running = runBtwFloating(h.ctx, async (ctx) =>
      ctx.ui.custom(() => {
        assert.ok(ctx.signal);
        entered.resolve(ctx.signal);
        return page.promise;
      }),
    );
    try {
      const signal = await entered.promise;
      if (stop === "shutdown") h.controller.abort();
      else h.disposeHost();
      await running;
      assert.equal(signal.aborted, true);
      assert.equal(h.closes, stop === "shutdown" ? 1 : 0);
      assert.equal(h.parent.hasOverlay(), false);
      page.resolve({
        render: () => [],
        invalidate() {},
        dispose: () => {
          disposals++;
          disposed.resolve();
        },
      });
      await disposed.promise;
      assert.equal(disposals, 1);
    } finally {
      h.dispose();
      await running;
    }
  });
}

for (const answering of [false, true]) {
  test(`floating BTW keeps the ${answering ? "steering" : "compose"} editor above the bottom hints`, () => {
    const h = harness("regular");
    const frame = new BtwFloatingFrame(h.parent, theme, getKeybindings(), () => {});
    const page = answering
      ? new BtwAnsweringView(frame.tui, theme, [], "Question", () => {}, undefined, {
          steering: { questions: ["next"], onSubmit: () => {} },
        })
      : new BtwTranscriptPager(
          frame.tui,
          theme,
          [{ kind: "answered", question: "Question", answer: "Answer", response: response("Answer") }],
          () => {},
        );
    try {
      frame.setPage(page);
      frame.focused = true;
      const render = () => frame.render(Number(frame.overlayOptions.width));
      for (const expectedHeight of [21, 23]) {
        const rows = render();
        const plain = rows.map(stripVTControlCharacters);
        assert.equal(rows.length, expectedHeight);
        assert.match(plain[2] ?? "", /Question/);
        assert.match(plain.at(-3) ?? "", /btw/);
        assert.match(plain.at(-2) ?? "", /ctrl\+c/i);
        assert.ok(rows[expectedHeight - 5]?.includes(CURSOR_MARKER));
        if (answering) assert.match(plain[expectedHeight - 7] ?? "", /Steering next: next/);
        if (expectedHeight === 21) {
          for (const key of [F10, `${ESC}[1;2B`, `${ESC}[1;2B`, ESC]) frame.handleInput(key);
        }
      }
      h.terminal.columns = 2;
      h.terminal.rows = 1;
      const rows = render();
      assert.equal(rows.length, 1);
      assert.ok(rows[0]?.includes(CURSOR_MARKER));
      assert.equal(visibleWidth(rows[0] ?? ""), 2);
    } finally {
      frame.setPage(undefined);
      page.dispose();
      h.dispose();
    }
  });
}

test("floating geometry shortcuts do not consume pasted input", () => {
  const h = harness("regular");
  try {
    const frame = new BtwFloatingFrame(h.parent, theme, getKeybindings(), () => assert.fail("pasted hard cancel"));
    const passed: string[] = [];
    frame.setPage({ render: () => [], invalidate() {}, handleInput: (data) => passed.push(data) });
    for (const part of [`${ESC}[200~`, F10, CTRL_C, `${ESC}[201~`]) frame.handleInput(part);
    assert.deepEqual(passed, [`${ESC}[200~`, F10, CTRL_C, `${ESC}[201~`]);
  } finally {
    h.dispose();
  }
});
