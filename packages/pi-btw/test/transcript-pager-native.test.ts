import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { initTheme, type Theme } from "@earendil-works/pi-coding-agent";
import {
  type Component,
  CURSOR_MARKER,
  Editor,
  getKeybindings,
  isKittyProtocolActive,
  type KeybindingsConfig,
  KeybindingsManager,
  type ScrollView,
  setKeybindings,
  setKittyProtocolActive,
  type Terminal,
  type TUI,
  TUI_KEYBINDINGS,
  TuiAltScreen,
  visibleWidth,
} from "@earendil-works/pi-tui";
import { afterEach, beforeEach, test, vi } from "vitest";
import { setBtwHostInputBlockers, setBtwKeybindings } from "../src/keybindings.js";
import type { SideThreadTurn } from "../src/side-thread.js";
import {
  BtwAnsweringView,
  BtwTranscriptPager,
  formatSideTranscript,
  type TranscriptPagerAction,
} from "../src/transcript-pager.js";

const plainTheme = {
  fg: (_role: string, text: string) => text,
  bg: (_role: string, text: string) => text,
  bold: (text: string) => text,
  getThinkingBorderColor: (level: string) => (text: string) => `\u001b[${level === "high" ? 31 : 32}m${text}\u001b[0m`,
} as unknown as Theme;
const originalBindings = getKeybindings();
const originalKitty = isKittyProtocolActive();
const cleanup: Array<() => void> = [];
beforeEach(() => {
  initTheme("dark");
  setKittyProtocolActive(false);
});
afterEach(() => {
  for (const dispose of cleanup.splice(0).reverse()) dispose();
  setKeybindings(originalBindings);
  setKittyProtocolActive(originalKitty);
  vi.useRealTimers();
});

function bindings(config: Record<string, string | string[]> = {}) {
  return new KeybindingsManager(
    { ...TUI_KEYBINDINGS, "app.thinking.cycle": { defaultKeys: "shift+tab" } },
    config as KeybindingsConfig,
  );
}
function response(text: string): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    stopReason: "stop",
    timestamp: 0,
    api: "anthropic-messages",
    provider: "test",
    model: "side",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  } as AssistantMessage;
}
function turns(count = 12): SideThreadTurn[] {
  return Array.from({ length: count }, (_, index) => ({
    kind: "answered",
    question: `Question ${index} 中文 🙂`,
    answer: `Answer ${index}\n${"wrapped reading material ".repeat(8)}`,
    response: response(`Answer ${index}`),
  }));
}

// Real TuiAltScreen input callback, not direct calls to pager.handleInput().
// The terminal implements the same public surface as fullscreen-ui's native harness.
function nativeHarness(
  keys = bindings(),
  history = turns(),
  answering = false,
  transformer?: (text: string) => string,
) {
  setKeybindings(keys);
  let input: ((data: string) => void) | undefined;
  const writes: string[] = [];
  const terminal = {
    columns: 80,
    rows: 24,
    start(onInput: (data: string) => void) {
      input = onInput;
    },
    stop() {
      input = undefined;
    },
    write(data: string) {
      writes.push(data);
    },
    hideCursor() {},
    showCursor() {},
  };
  const copied: string[] = [];
  const tui = new TuiAltScreen(terminal as unknown as Terminal, false, undefined, {
    copySelection: async (text) => {
      copied.push(text);
      return true;
    },
  });
  setBtwKeybindings(tui, keys);
  const actions: TranscriptPagerAction[] = [];
  const queued: string[] = [];
  const levels: string[] = [];
  let cancellations = 0;
  const thinking = {
    level: "medium" as const,
    levels: ["medium", "high"] as const,
    keybindings: keys as never,
    onChange: (level: string) => levels.push(level),
  };
  const view = answering
    ? new BtwAnsweringView(
        tui,
        plainTheme,
        history,
        "Pending 中文 🙂",
        () => {
          cancellations++;
        },
        "medium",
        {
          keybindings: keys,
          markdownTransformers: transformer ? [transformer] : [],
          steering: { questions: queued, onSubmit: (question) => queued.push(question), thinking },
        },
      )
    : new BtwTranscriptPager(tui, plainTheme, history, (action) => actions.push(action), {
        startAtBottom: true,
        thinking,
        keybindings: keys,
        markdownTransformers: transformer ? [transformer] : [],
      });
  tui.setLayoutRoot(view.getFullscreenLayout());
  tui.setFocus(view);
  tui.start();
  tui.renderNow(true);
  cleanup.push(() => {
    view.dispose();
    tui.stop();
  });
  const send = (data: string) => {
    assert.ok(input);
    input(data);
    tui.renderNow(true);
  };
  const frame = () => (tui as unknown as { currentLayout: NativeFrame }).currentLayout;
  const clickComposer = () => {
    const find = (box: ReturnType<typeof frame>["root"]): typeof box | undefined => {
      if (box.component instanceof Editor) return box;
      for (const child of box.children) {
        const match = find(child);
        if (match) return match;
      }
      return undefined;
    };
    const box = find(frame().root);
    assert.ok(box);
    const row = box.lines?.findIndex((line) => line.includes(CURSOR_MARKER)) ?? -1;
    assert.ok(row >= 0);
    send(`\u001b[<0;${box.rect.x + 1};${box.rect.y + row - (box.lineOffset ?? 0) + 1}M`);
    send(`\u001b[<0;${box.rect.x + 1};${box.rect.y + row - (box.lineOffset ?? 0) + 1}m`);
    assert.ok(tui.getFocusedComponent() instanceof Editor, "native mouse focus reaches embedded Editor");
  };
  return {
    tui,
    terminal,
    view,
    writes,
    copied,
    actions,
    queued,
    levels,
    send,
    frame,
    clickComposer,
    get cancellations() {
      return cancellations;
    },
  };
}

for (const answering of [false, true]) {
  test(`native composer click retains owner shortcuts, paste, editing and cancel (answering=${answering})`, () => {
    const h = nativeHarness(bindings(), turns(), answering);
    h.clickComposer();
    h.send("\u001b[Z");
    assert.deepEqual(h.levels, ["high"]);
    h.send("\u001b[200~");
    h.send(`large 中文 🙂 ${"p".repeat(2000)}\nsecond line`);
    h.send("\u0003"); // paste payload, not hard cancel
    h.send("\u001b[201~");
    assert.equal(h.cancellations, 0);
    assert.equal(h.actions.length, 0);
    h.send("?");
    h.send("\u007f");
    h.send("!");
    h.send("\r");
    if (answering) assert.match(h.queued[0] ?? "", /large 中文 🙂/u);
    else assert.equal(h.actions[0]?.kind, "submit");
  });
  test(`native composer click hard cancel settles once (answering=${answering})`, () => {
    const h = nativeHarness(bindings(), turns(), answering);
    h.clickComposer();
    h.send("\u0003");
    h.send("\u0003");
    assert.equal(answering ? h.cancellations : h.actions.filter((action) => action.kind === "close").length, 1);
  });
}

test("native viewport owns remapped paging once; old/disabled paging is not replayed by pager", () => {
  const keys = bindings({ "tui.altScreen.pageUp": "ctrl+u", "tui.altScreen.pageDown": [] });
  const h = nativeHarness(keys);
  const scroll = h.view.getPrimaryScrollView();
  const initial = scroll.scrollTop;
  h.send("\u001b[5~");
  assert.equal(scroll.scrollTop, initial);
  h.send("\u0015");
  assert.equal(scroll.scrollTop, initial - Math.max(1, scroll.viewportHeight - 4));
  const manual = scroll.scrollTop;
  h.send("\u001b[6~");
  assert.equal(scroll.scrollTop, manual);
  const footer = stripVTControlCharacters(h.frame().lines.join("\n"));
  assert.match(footer, /Ctrl\+U history/u);
  assert.doesNotMatch(footer, /PgUp|PgDn/u);
});

test.each([
  { keys: ["not-a-key", "alt+s"], expected: "Alt+S", data: "\u001bs", kitty: false },
  { keys: ["return"], expected: "Enter", data: "\r", kitty: false },
  { keys: ["alt+ctrl+s"], expected: "Alt+Ctrl+S", data: "\u001b[115;7u", kitty: true },
  { keys: ["ctrl+j", "alt+s"], expected: "Alt+S", data: "\u001bs", kitty: false },
  { keys: ["ctrl+i", "alt+s"], expected: "Ctrl+I", data: "\u001b[105;5u", kitty: true },
])("native submit hint selects first usable binding: $keys (Kitty=$kitty)", ({ keys, expected, data, kitty }) => {
  setKittyProtocolActive(kitty);
  const h = nativeHarness(bindings({ "tui.input.submit": keys }));
  setKittyProtocolActive(kitty);
  const footer = stripVTControlCharacters(h.frame().lines.join("\n"));
  assert.ok(footer.includes(`${expected} send`), footer);
  h.send("draft");
  h.send(data);
  assert.deepEqual(h.actions, [{ kind: "submit", question: "draft" }]);
});

test("native host collision and disabled submit never advertise a hidden Enter action", () => {
  const h = nativeHarness(bindings({ "tui.input.submit": ["enter", "alt+s"], "tui.altScreen.pageUp": "enter" }));
  assert.doesNotMatch(stripVTControlCharacters(h.frame().lines.join("\n")), /Enter send/u);
  assert.match(stripVTControlCharacters(h.frame().lines.join("\n")), /Alt\+S send/u);
  h.send("draft");
  h.send("\r");
  assert.deepEqual(h.actions, []);
  h.send("\u001bs");
  assert.equal((h.actions as TranscriptPagerAction[])[0]?.kind, "submit");
  const disabled = nativeHarness(bindings({ "tui.input.submit": [] }));
  assert.doesNotMatch(stripVTControlCharacters(disabled.frame().lines.join("\n")), /send/u);
  disabled.send("draft");
  disabled.send("\r");
  assert.deepEqual(disabled.actions, []);
});

for (const answering of [false, true]) {
  test(`native prompt jumps use trusted component metadata only (answering=${answering})`, () => {
    const injected = "\u001b]133;A\u0007evil\u001b]133;C\u001b\\\u001b[2J";
    const history = turns(5);
    history.push({ kind: "error", question: injected, answer: injected });
    const h = nativeHarness(bindings(), history, answering);
    const scroll = h.view.getPrimaryScrollView();
    const metadata = getScrollViewBox(h.frame(), scroll)?.scrollContentLines ?? [];
    const promptRows = metadata.flatMap((line, index) => (line.startsWith("\u001b]133;A\u0007") ? [index] : []));
    assert.equal(promptRows.length, answering ? 12 : 11);
    const initial = scroll.scrollTop;
    h.send("\u001b[1;5A");
    assert.ok(scroll.scrollTop < initial);
    assert.ok(promptRows.includes(scroll.scrollTop));
    const previous = scroll.scrollTop;
    h.send("\u001b[1;5A");
    assert.ok(scroll.scrollTop < previous);
    h.send("\u001b[1;5B");
    assert.equal(scroll.scrollTop, previous);
    h.terminal.columns = 20;
    h.tui.renderNow(true);
    h.send("\u001b[1;5A");
    assert.ok(scroll.scrollTop >= 0);
    assert.ok(!h.frame().lines.join("\n").includes("\u001b]133;"));
    assert.ok(!h.writes.join("").includes("\u001b]133;"));
    assert.ok(!h.view.render(20).join("\n").includes("\u001b]133;"));
    assert.ok(!formatSideTranscript(history).includes("\u001b"));
    assert.ok(
      metadata.some((line) => line.includes("\\x1b]133;A")),
      "raw controls remain escaped data",
    );
  });
}

interface NativeBox {
  component: Component;
  rect: { x: number; y: number; width: number; height: number };
  lines?: readonly string[];
  lineOffset?: number;
  children: NativeBox[];
  scrollView?: ScrollView;
  scrollContentLines?: readonly string[];
}
interface NativeFrame {
  root: NativeBox;
  lines: string[];
}
function getScrollViewBox(frame: NativeFrame, scroll: ScrollView): NativeBox | undefined {
  const visit = (box: NativeBox): NativeBox | undefined => {
    if (box.scrollView === scroll) return box;
    for (const child of box.children) {
      const match = visit(child);
      if (match) return match;
    }
    return undefined;
  };
  return visit(frame.root);
}
function renderLayoutFrame(root: Component, columns: number, rows: number, _requestRender: () => void): NativeFrame {
  const terminal = { columns, rows, start() {}, stop() {}, write() {}, hideCursor() {}, showCursor() {} };
  const tui = new TuiAltScreen(terminal as unknown as Terminal, false);
  tui.setLayoutRoot(root);
  tui.start();
  try {
    tui.renderNow(true);
    return (tui as unknown as { currentLayout: NativeFrame }).currentLayout;
  } finally {
    tui.stop();
  }
}
function regularHarness(keys = bindings(), rows = 24) {
  setKeybindings(keys);
  const tui = { mode: "regular", terminal: { rows, columns: 80 }, requestRender() {} } as unknown as TUI;
  setBtwKeybindings(tui, keys);
  return tui;
}

test("native search closure restores logical composer dispatch", () => {
  const h = nativeHarness();
  h.clickComposer();
  h.send("\u001b[102;6u");
  h.send("Question 0");
  h.send("\r");
  h.send("\u001b");
  h.send("\u001b[Z");
  assert.deepEqual(h.levels, ["high"]);
  h.send("after search");
  h.send("\r");
  assert.deepEqual(h.actions, [{ kind: "submit", question: "after search" }]);
});

test("native metadata never exposes forged transformer prompt markers, search text, or clipboard markers", async () => {
  const h = nativeHarness(
    bindings(),
    turns(2),
    false,
    (text) => `${text}\n\u001b]133;A\u0007forged\u001b]133;D;0\u0007`,
  );
  const scroll = h.view.getPrimaryScrollView();
  const metadata = getScrollViewBox(h.frame(), scroll)?.scrollContentLines ?? [];
  assert.equal(metadata.filter((line) => line.startsWith("\u001b]133;A\u0007")).length, 4);
  assert.ok(metadata.every((line) => !line.includes("\u001b]133;D")));
  h.send("\u001b[1;5H");
  const row = h.frame().lines.findIndex((line) => stripVTControlCharacters(line).includes("Question 0"));
  assert.ok(row >= 0);
  h.send(`\u001b[<0;2;${row + 1}M`);
  h.send(`\u001b[<32;12;${row + 1}M`);
  h.send(`\u001b[<0;12;${row + 1}m`);
  await Promise.resolve();
  assert.ok(h.copied.length > 0, "native selection invokes clipboard callback");
  assert.match(h.copied[0] ?? "", /Question/u);
  assert.ok(!h.copied.join("").includes("\u001b]133;"));
  h.send("\u001b[102;6u");
  h.send("forged");
  h.send("\r");
  h.send("\u001b");
  assert.ok(!h.writes.join("").includes("\u001b]133;"));
});

test("host-owned copy bindings suppress unreachable submit and paging hints", () => {
  const h = nativeHarness(
    bindings({
      "tui.input.submit": ["alt+s", "alt+x"],
      "tui.altScreen.pageUp": ["alt+s", "ctrl+u"],
    }),
  );
  setBtwHostInputBlockers(h.tui, ["alt+s"]);
  h.tui.renderNow(true);
  const text = stripVTControlCharacters(h.frame().lines.join("\n"));
  assert.match(text, /Alt\+X send/u);
  assert.match(text, /Ctrl\+U\/PgDn history/u);
  assert.doesNotMatch(text, /Alt\+S/u);
});

test("native auto scrollbar hides its thumb and releases timer ownership without restarting manual follow", () => {
  vi.useFakeTimers();
  const h = nativeHarness();
  const scroll = h.view.getPrimaryScrollView();
  h.send("\u001b[5~");
  assert.equal(scroll.isScrollbarVisible, true);
  assert.equal(scroll.isFollowingEnd, false);
  vi.advanceTimersByTime(1001);
  assert.equal(scroll.isScrollbarVisible, false);
  h.terminal.rows = 1000;
  h.tui.renderNow(true);
  assert.equal(scroll.isFollowingEnd, false);
  h.terminal.rows = 24;
  h.tui.renderNow(true);
  assert.equal(scroll.isFollowingEnd, false);
  h.send("\u001b[1;5F");
  assert.equal(scroll.isFollowingEnd, true);
  h.send("\u001b[5~");
  h.view.dispose();
  h.tui.stop();
  assert.equal(scroll.isScrollbarVisible, false);
  assert.equal(vi.getTimerCount(), 0);
});

test("regular fallback uses effective bindings and preserves paste, manual follow, and explicit end-follow", () => {
  const keys = bindings({ "tui.altScreen.pageUp": "ctrl+u", "tui.altScreen.pageDown": "ctrl+d" });
  const tui = regularHarness(keys);
  const view = new BtwTranscriptPager(tui, plainTheme, turns(), () => {}, { startAtBottom: true });
  cleanup.push(() => view.dispose());
  view.focused = true;
  view.render(80);
  const scroll = view.getPrimaryScrollView();
  const bottom = scroll.scrollTop;
  view.handleInput("\u001b[5~");
  assert.equal(scroll.scrollTop, bottom);
  view.handleInput("\u0015");
  assert.ok(scroll.scrollTop < bottom);
  assert.equal(scroll.isFollowingEnd, false);
  scroll.updateLayout(1, 10, () => {});
  scroll.updateLayout(100, 10, () => {});
  assert.equal(scroll.isFollowingEnd, false);
  scroll.scrollToEnd();
  assert.equal(scroll.isFollowingEnd, true);
  assert.equal(scroll.scrollbar, "auto");
  scroll.scrollBy(-1);
  assert.equal(scroll.isScrollbarVisible, true);
  view.dispose();
  assert.equal(scroll.isScrollbarVisible, false);
});

test("dock width/height matrix retains active input before optional chrome in regular and native layouts", () => {
  const tui = regularHarness();
  const queued = ["one 中文", "two 🙂", "three", "four"];
  for (const answering of [false, true]) {
    const view = answering
      ? new BtwAnsweringView(tui, plainTheme, turns(1), "pending", () => {}, "medium", {
          steering: { questions: queued, onSubmit() {} },
        })
      : new BtwTranscriptPager(tui, plainTheme, turns(1), () => {}, { initialQuestion: "中文🙂\nline two\nthird" });
    cleanup.push(() => view.dispose());
    view.focused = true;
    if (answering) view.handleInput("\u001b[200~中文🙂\nline two\nthird\u001b[201~");
    for (const width of [0, 1, 2, 20, 40, 79, 80, 120]) {
      for (const height of [0, 1, 2, 3, 5, 10, 24]) {
        (tui.terminal as unknown as { rows: number }).rows = height;
        const regular = view.render(width);
        if (width === 0 || height === 0) {
          assert.deepEqual(regular, []);
          continue;
        }
        assert.ok(regular.length <= Math.max(1, height - 3));
        assert.ok(
          regular.some((line) => line.includes(CURSOR_MARKER)),
          `${answering}/${width}/${height} regular cursor`,
        );
        const native = renderLayoutFrame(view.getFullscreenLayout(), width, height, () => {});
        assert.ok(
          native.lines.some((line) => line.includes(CURSOR_MARKER)),
          `${answering}/${width}/${height} native cursor`,
        );
        for (const line of [...regular, ...native.lines]) assert.ok(visibleWidth(line) <= width, `${width}: ${line}`);
      }
    }
    view.dispose();
  }
});

test("constrained footers retain only complete, reachable key labels", () => {
  const tui = regularHarness();
  const pager = new BtwTranscriptPager(tui, plainTheme, turns(), () => {});
  const answering = new BtwAnsweringView(tui, plainTheme, turns(), "pending", () => {}, "medium", {
    steering: { questions: [], onSubmit() {} },
  });
  cleanup.push(
    () => pager.dispose(),
    () => answering.dispose(),
  );
  for (const view of [pager, answering]) {
    const at20 = view.render(20).map(stripVTControlCharacters);
    assert.ok(at20.includes("Enter • Ctrl+C"), at20.join("\n"));
    assert.ok(!at20.some((line) => line.includes("Ctrl...")));
    const at6 = view.render(6).map(stripVTControlCharacters);
    assert.ok(at6.includes("Ctrl+C"));
    const at1 = view.render(1).map(stripVTControlCharacters);
    assert.ok(!at1.some((line) => line.includes("Ctrl")));
  }
  const wide = pager.render(40).map(stripVTControlCharacters);
  assert.ok(wide.includes("Enter • Ctrl+R • Ctrl+C • PgUp/PgDn"), wide.join("\n"));
});

test("theme invalidation rebuilds transcript colours without changing draft or exact text", () => {
  const tui = regularHarness();
  const view = new BtwTranscriptPager(tui, plainTheme, turns(1), () => {}, { initialQuestion: "draft 中文 🙂" });
  cleanup.push(() => view.dispose());
  view.focused = true;
  const dark = view.render(80).join("\n");
  initTheme("light");
  view.invalidate();
  const light = view.render(80).join("\n");
  assert.notEqual(dark, light);
  assert.equal(stripVTControlCharacters(dark), stripVTControlCharacters(light));
  assert.match(light, /draft 中文 🙂/u);
});

test("answering status uses Editor border; queue remains bounded, ordered, and timing-labelled", () => {
  const tui = regularHarness();
  const view = new BtwAnsweringView(tui, plainTheme, turns(1), "pending", () => {}, "high", {
    steering: { questions: ["first", "second", "third", "fourth"], onSubmit() {} },
  });
  cleanup.push(() => view.dispose());
  view.focused = true;
  const frame = renderLayoutFrame(view.getFullscreenLayout(), 120, 24, () => {});
  const text = stripVTControlCharacters(frame.lines.join("\n"));
  assert.match(text, /Answering….*─/u);
  assert.match(text, /queue next/u);
  assert.match(text, /Steering next: first[\s\S]*Steering next: second[\s\S]*Steering next: … \+2 more/u);
  assert.doesNotMatch(text, /Steering next: third/u);
  view.setWorkspaceFocus("main", "F6");
  const focused = stripVTControlCharacters(view.render(120).join("\n"));
  assert.match(focused, /btw · Main focus/u);
  assert.match(focused, /F6 switch/u);
  view.invalidate();
  view.finish();
  assert.equal(view.getPrimaryScrollView().scrollbar, "hidden");
});
