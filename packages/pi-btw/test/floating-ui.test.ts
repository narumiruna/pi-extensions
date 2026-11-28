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
const F4 = `${ESC}OS`;
const F5 = `${ESC}[15~`;
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

test("BTW's title buttons keep the draft, scroll position, and owned overlay across size changes", async () => {
  const h = harness("fullscreen");
  const ready = Promise.withResolvers<BtwTranscriptPager>();
  let signal: AbortSignal | undefined;
  let disposals = 0;
  const running = runBtwFloating(h.ctx, async (ctx) => {
    signal = ctx.signal;
    await ctx.ui.custom<TranscriptPagerAction>((tui, theme, keys, done) => {
      const turns = Array.from({ length: 24 }, (_, index) => ({
        kind: "answered" as const,
        question: `Q${index}`,
        answer: `A${index}`,
        response: response(`A${index}`),
      }));
      const pager = new BtwTranscriptPager(tui, theme, turns, done, { keybindings: keys, initialQuestion: "draft" });
      const dispose = pager.dispose.bind(pager);
      pager.dispose = () => {
        disposals++;
        dispose();
      };
      queueMicrotask(() => ready.resolve(pager));
      return pager;
    });
  });
  const header = () => stripVTControlCharacters(h.host.render(h.bounds().width)[0] ?? "");
  const click = (icon: string) => {
    const { col, row } = h.bounds();
    const x = header().lastIndexOf(icon);
    assert.ok(x >= 0, `Expected ${icon} in the window title`);
    h.terminal.input(`${ESC}[<0;${col + x + 1};${row + 1}M`);
    h.terminal.input(`${ESC}[<0;${col + x + 1};${row + 1}m`);
  };
  try {
    const page = await ready.promise;
    const normal = h.bounds();
    assert.match(header(), / − {2}□ {2}× ╮$/u);
    h.terminal.input(`${ESC}[6~`);
    const scrollTop = page.getPrimaryScrollView().scrollTop;
    assert.ok(scrollTop > 0);
    h.terminal.input(F10);
    assert.equal(page.focused, false);
    click("−");
    const minimized = { col: 18, row: 29, width: 64, height: 1 };
    assert.deepEqual(h.bounds(), minimized);
    assert.equal(h.host.render(64).length, 1);
    assert.doesNotMatch(header(), /draft|□/u);
    assert.equal(page.focused, false);
    assert.equal(h.parent.getFocusedComponent(), h.host);
    h.terminal.input("x");
    click("+");
    assert.deepEqual(h.bounds(), normal);
    assert.equal(page.focused, true);
    assert.equal(page.getPrimaryScrollView().scrollTop, scrollTop);
    const restored = stripVTControlCharacters(h.host.render(normal.width).join("\n"));
    assert.match(restored, /draft/);
    assert.doesNotMatch(restored, /draftx/);
    click("□");
    const maximized = { col: 0, row: 0, width: 100, height: 30 };
    assert.deepEqual(h.bounds(), maximized);
    assert.equal(page.focused, true);
    click("−");
    assert.deepEqual(h.bounds(), minimized);
    click("+");
    assert.deepEqual(h.bounds(), maximized);
    click("❐");
    assert.deepEqual(h.bounds(), normal);
    const sibling = h.parent.showOverlay(
      { render: () => ["Unrelated"], invalidate() {} },
      { col: 0, row: 0, width: 9 },
    );
    click("×");
    await running;
    assert.equal(sibling.isFocused(), true);
    sibling.hide();
    assert.equal(signal?.aborted, true);
    assert.deepEqual([h.opens, h.closes, disposals], [1, 1, 1]);
    assert.equal(h.ctx.ui.getEditorText(), "main draft");
  } finally {
    h.dispose();
    await running;
  }
});

test.for([
  { mode: "regular", submit: "f4", search: "f5" },
  { mode: "fullscreen", submit: "f5", search: "f4" },
] as const)(
  "floating BTW in $mode picks reachable size keys before showing hints",
  async ({ mode, submit, search }) => {
    const keys = new KeybindingsManager(TUI_KEYBINDINGS, {
      "tui.input.submit": submit,
      "tui.altScreen.search": search,
      "tui.select.cancel": "ctrl+g",
    });
    const h = harness(mode, keys);
    const ready = Promise.withResolvers<void>();
    const received: string[] = [];
    const running = runBtwFloating(h.ctx, async (ctx) =>
      ctx.ui.custom(() => {
        queueMicrotask(() => ready.resolve());
        return { render: () => [], invalidate() {}, handleInput: (input) => received.push(input) };
      }),
    );
    try {
      await ready.promise;
      const header = stripVTControlCharacters(h.host.render(h.bounds().width)[0] ?? "");
      assert.match(header, /F3 minimize · F2 maximize/i);
      const submitInput = submit === "f4" ? F4 : F5;
      h.terminal.input(submitInput);
      assert.deepEqual(received, [submitInput]);
      h.terminal.input(`${ESC}[12~`);
      assert.equal(h.bounds().height, 30);
      h.terminal.input(`${ESC}[13~`);
      assert.equal(h.bounds().height, 1);
      h.terminal.input("m");
      assert.deepEqual(received, [submitInput]);
      h.terminal.input(`${ESC}[13~`);
      assert.equal(h.bounds().height, 30);
      h.terminal.input(`${ESC}[12~`);
      assert.equal(h.bounds().height, 21);
      h.terminal.input(`${ESC}[13~`);
      h.terminal.input("\u0007");
      await running;
      assert.equal(h.closes, 1);
    } finally {
      h.dispose();
      await running;
    }
  },
);

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
    const paste = [`${ESC}[200~`, F10, F4, F5, CTRL_C, `${ESC}[201~`];
    for (const part of paste) frame.handleInput(part);
    assert.deepEqual(passed, paste);
    assert.equal(frame.overlayOptions.maxHeight, 21);
  } finally {
    h.dispose();
  }
});
