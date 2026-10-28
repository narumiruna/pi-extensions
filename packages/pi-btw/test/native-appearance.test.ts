import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import {
  AssistantMessageComponent,
  getMarkdownTheme,
  initTheme,
  UserMessageComponent,
} from "@earendil-works/pi-coding-agent";
import {
  CURSOR_MARKER,
  Editor,
  getKeybindings,
  isKittyProtocolActive,
  setKeybindings,
  setKittyProtocolActive,
  truncateToWidth,
  visibleWidth,
} from "@earendil-works/pi-tui";
import { afterEach, beforeEach, test, vi } from "vitest";
import { setBtwHostInputBlockers } from "../src/keybindings.js";
import {
  answer,
  appearanceHarness,
  appearanceTheme,
  editorTheme,
  findBox,
  heights,
  history,
  keys,
  model,
  NativeEditorReference,
  NativeStatusReference,
  plain,
  question,
  response,
  states,
  widths,
} from "./native-appearance-support.js";

const originalBindings = getKeybindings();
const originalKitty = isKittyProtocolActive();
const cleanup: Array<() => void> = [];
beforeEach(() => {
  initTheme("dark");
  setKittyProtocolActive(false);
  vi.useFakeTimers();
});
afterEach(() => {
  for (const dispose of cleanup.splice(0).reverse()) dispose();
  setKeybindings(originalBindings);
  setKittyProtocolActive(originalKitty);
  vi.useRealTimers();
});
function harness(...args: Parameters<typeof appearanceHarness>) {
  const h = appearanceHarness(...args);
  cleanup.push(() => h.dispose());
  return h;
}
for (const palette of ["dark", "light", "system"] as const) {
  for (const state of states) {
    test.each(widths)(`appearance matrix: ${palette}/${state}, width=%i`, (width) => {
      initTheme(palette);
      const longModel = { provider: "provider中文🙂", id: "model中文🙂".repeat(24) };
      const regular = harness(state, appearanceTheme(palette), { model: longModel });
      const native = harness(state, appearanceTheme(palette), { native: true, model: longModel });
      for (const height of heights) {
        regular.resize(width, height);
        native.resize(width, height);
        const lines = regular.view.render(width);
        if (width === 0 || height === 0) {
          assert.deepEqual(lines, []);
          assert.deepEqual(native.view.render(width), []);
          // TuiAltScreen itself clamps terminal dimensions to at least one cell.
          // Zero-sized views are checked at the extension boundary, not called native captures.
          continue;
        }
        const frame = native.frame();
        assert.ok(lines.length <= Math.max(1, height - 3), `${state}/${width}/${height}: regular rows`);
        assert.ok(frame.lines.length <= height, `${state}/${width}/${height}: native rows`);
        for (const [kind, rendered] of [
          ["regular", lines],
          ["native", frame.lines],
        ] as const) {
          assert.ok(
            rendered.some((line) => line.includes(CURSOR_MARKER)),
            `${state}/${width}/${height}: ${kind} cursor`,
          );
          for (const line of rendered) assert.ok(visibleWidth(line) <= width, `${kind}/${width}: ${line}`);
          assert.ok(
            rendered.every((line) => !line.includes("\u001b]133;")),
            "navigation metadata is not display text",
          );
        }
        if (height === 1) {
          assert.equal(lines.length, 1);
          assert.ok(!plain(lines).join("").includes("btw"), "cursor precedes optional identity");
        }
      }
    });
  }
}
for (const state of states) {
  test(`normal hierarchy: ${state} has transcript, queue, editor, then at most two footer rows`, () => {
    const h = harness(state, appearanceTheme("dark"), { native: true });
    h.resize(120, 24);
    h.view.setWorkspaceFocus("side", "F6");
    const frame = h.frame();
    const editor = findBox(frame.root, (box) => box.component instanceof Editor);
    const transcript = findBox(frame.root, (box) => box.scrollView === h.view.getPrimaryScrollView());
    assert.ok(editor);
    assert.ok(transcript);
    const text = plain(frame.lines);
    const editorBottom = editor.rect.y + editor.rect.height;
    const footer = text.slice(editorBottom).filter((line) => line.trim());
    assert.ok(footer.length > 0 && footer.length <= 2, footer.join("\n"));
    assert.match(footer.join("\n"), /btw/u);
    assert.match(footer.join("\n"), /BTW focus/u);
    assert.match(footer.join("\n"), /side-provider\/side-model/u);
    assert.match(footer.join("\n"), /thinking medium/u);
    assert.ok(transcript.rect.y === 0, "no fixed conversation-top header");
    const aboveEditor = text.slice(0, editor.rect.y).join("\n");
    assert.doesNotMatch(aboveEditor, /btw|Ctrl\+C|Enter send|Enter queue|F6 switch/u);
    assert.doesNotMatch(footer.join("\n"), /tokens|\$|context|branch|cache/u);
    if (state === "queued") {
      assert.match(
        aboveEditor,
        /Steering next: first 中文[\s\S]*Steering next: second 🙂[\s\S]*Steering next: … \+2 more/u,
      );
      assert.doesNotMatch(aboveEditor, /Steering next: third|Steering next: fourth/u);
      assert.ok(
        text.findIndex((line) => line.includes("Steering next:")) > text.findIndex((line) => line.includes("Pending")),
      );
    } else assert.doesNotMatch(aboveEditor, /Steering next:/u);
    const direct = plain(h.view.render(120));
    const lastBorder = direct.reduce((last, line, index) => (/^─+$/u.test(line) ? index : last), -1);
    assert.ok(lastBorder >= 0);
    assert.ok(direct.length - lastBorder - 1 <= 2);
    assert.match(direct.slice(lastBorder + 1).join("\n"), /btw/u);
    assert.doesNotMatch(direct.slice(0, lastBorder).join("\n"), /btw|Ctrl\+C/u);
  });
}
for (const palette of ["dark", "light", "system"] as const) {
  test(`source-derived public native message reference retains ANSI, spacing and payload (${palette})`, () => {
    initTheme(palette);
    const turn = { kind: "answered" as const, question, answer, response: response("original provider payload") };
    const before = structuredClone(turn);
    const h = harness("answered", appearanceTheme(palette), { native: true, turns: [turn] });
    h.resize(80, 24);
    const box = findBox(h.frame().root, (candidate) => candidate.scrollView === h.view.getPrimaryScrollView());
    assert.ok(box);
    const nativeUser = new UserMessageComponent(question, getMarkdownTheme(), 1);
    const nativeAssistant = new AssistantMessageComponent(response(answer), true, getMarkdownTheme(), "", 1);
    const reference = [...nativeUser.render(box.rect.width), ...nativeAssistant.render(box.rect.width)];
    assert.deepEqual(box.scrollContentLines, reference, "actual public message components, not stripped snapshots");
    assert.deepEqual(turn, before, "display normalization does not rewrite provider response or transcript");
    const removeNavigation = (line: string) =>
      line
        .replaceAll("\u001b]133;A\u0007", "")
        .replaceAll("\u001b]133;B\u0007", "")
        .replaceAll("\u001b]133;C\u0007", "");
    const visibleReference = reference.map(removeNavigation);
    assert.deepEqual(h.view.render(80).slice(0, visibleReference.length), visibleReference);
    assert.ok(
      reference.some((line) => line.includes("\u001b[")),
      "reference includes ANSI evidence",
    );
  });
}
test.each([20, 40, 79, 80, 120])(
  "idle editor matches public native default geometry and overflow at width=%i",
  (width) => {
    const theme = appearanceTheme("dark");
    const draft = Array.from({ length: 18 }, (_, index) => `draft ${index} 中文 🙂`).join("\n");
    const h = harness("multiline draft", theme, { native: true, draft });
    h.resize(width, 24);
    const native = new Editor(h.tui, editorTheme(theme));
    native.focused = true;
    native.setText(draft);
    const expected = native.render(width);
    const box = findBox(h.frame().root, (candidate) => candidate.component instanceof Editor);
    assert.ok(box);
    assert.deepEqual(box.lines, expected);
    assert.match(plain(expected)[0] ?? "", /↑ \d+ more/u);
    native.handleInput("\u0001");
    native.handleInput("\u001b[H");
    h.send("\u0001");
    h.send("\u001b[H");
    const changed = findBox(h.frame().root, (candidate) => candidate.component instanceof Editor);
    assert.deepEqual(changed?.lines, native.render(width));
  },
);
for (const overflow of [false, true]) {
  test.each([1, 3, 5, 10, 15, 20, 40, 79, 80, 120])(
    `working border follows source-derived native geometry (overflow=${overflow}) at width=%i`,
    (width) => {
      const theme = appearanceTheme("dark");
      const draft = overflow ? Array.from({ length: 18 }, (_, index) => `draft ${index}`).join("\n") : "";
      const h = harness("answering", theme, { native: true });
      h.resize(width, 24);
      const draftLines = draft.split("\n");
      for (const [index, line] of draftLines.entries()) {
        if (index > 0) h.send("\n");
        h.send(line);
      }
      // This is a source-derived public-component fixture, not a native runtime capture.
      const status = new NativeStatusReference(
        h.tui,
        (text) => theme.fg("accent", text),
        (text) => theme.fg("muted", text),
        "Answering…",
      );
      cleanup.push(() => status.dispose());
      const reference = new NativeEditorReference(h.tui, editorTheme(theme), status);
      reference.setText(draft);
      reference.focused = true;
      const expected = reference.render(Math.max(3, width)).map((line) => truncateToWidth(line, width, ""));
      const box = findBox(h.frame().root, (candidate) => candidate.component instanceof Editor);
      assert.ok(box);
      assert.equal(
        box.lines?.[0],
        expected[0],
        "status starts after native rule prefix; centered overflow is retained when it fits",
      );
      assert.equal(box.lines?.at(-1), expected.at(-1));
      if (overflow && width >= 40) assert.match(plain(box.lines ?? [])[0] ?? "", /↑ \d+ more/u);
      const all = stripVTControlCharacters(h.frame().lines.join("\n"));
      assert.ok((all.match(/Answering…/gu)?.length ?? 0) <= 1, "no duplicate working status");
    },
  );
}
test.each(["idle", "answering"] as const)("footer metadata is sanitized, truthful and textual (%s)", (state) => {
  const hostile = { provider: "side\u001b[2Jprovider\n", id: "model\u001b]133;A\u0007中文🙂" };
  const before = structuredClone(hostile);
  const h = harness(state, appearanceTheme("dark"), { native: true, model: hostile });
  h.view.setWorkspaceFocus("main", "F6\u001b[2J\n");
  const frame = h.frame();
  const text = stripVTControlCharacters(frame.lines.join("\n"));
  assert.match(text, /btw.*Main focus/u);
  assert.match(text, /side[^\n]*provider[^\n]*\/model[^\n]*中文🙂/u);
  assert.ok(!frame.lines.join("").includes("\u001b[2J"));
  assert.ok(!frame.lines.join("").includes("\u001b]133;A"));
  assert.deepEqual(hostile, before);
  h.view.setWorkspaceFocus("side", "F6");
  assert.match(stripVTControlCharacters(h.frame().lines.join("\n")), /BTW focus/u);
});
test.each(["dark", "light", "system"] as const)(
  "callback ANSI roles style bottom metadata, status, errors and warnings (%s)",
  (palette) => {
    initTheme(palette);
    const theme = appearanceTheme(palette);
    const h = harness("queued", theme, { native: true });
    h.resize(120, 24);
    const frame = h.frame();
    const metadata = frame.lines.find((line) => stripVTControlCharacters(line).includes("btw"));
    const hints = frame.lines.find((line) => stripVTControlCharacters(line).includes("queue next"));
    assert.ok(metadata?.includes(theme.getFgAnsi("dim")) || metadata?.includes(theme.getFgAnsi("muted")));
    assert.ok(hints?.includes(theme.getFgAnsi("muted")));
    assert.ok(frame.lines.some((line) => line.includes(theme.getFgAnsi("dim")) && line.includes("Steering next:")));
    const editor = findBox(frame.root, (candidate) => candidate.component instanceof Editor);
    assert.ok(editor?.lines?.[0]?.includes(theme.getFgAnsi("thinkingMedium")));
    assert.ok(editor?.lines?.[0]?.includes(theme.getFgAnsi("accent")));
    assert.ok(editor?.lines?.[0]?.includes(theme.getFgAnsi("muted")));
    h.send("\r");
    assert.ok(
      h
        .frame()
        .lines.some(
          (line) => line.includes(theme.getFgAnsi("warning")) && /Question cannot be empty|Empty/u.test(line),
        ),
    );
    const error = harness("error", theme, { native: true });
    assert.ok(error.frame().lines.some((line) => line.includes(theme.getFgAnsi("error")) && line.includes("Failure")));
  },
);
test.each(["multiline draft", "answering"] as const)(
  "theme invalidation rebuilds ANSI without changing text, draft, focus or manual follow (%s)",
  (state) => {
    const callback = appearanceTheme("dark");
    let active = appearanceTheme("dark");
    vi.spyOn(callback, "fg").mockImplementation((role, text) => active.fg(role, text));
    const h = harness(state, callback, { native: true, draft: "draft 中文 🙂\nsecond line\nthird line" });
    h.view.setWorkspaceFocus("main", "F6");
    const before = h.frame().lines;
    const scroll = h.view.getPrimaryScrollView();
    scroll.scrollTo(0, { disableFollow: true });
    initTheme("light");
    active = appearanceTheme("light");
    h.view.invalidate();
    const after = h.frame().lines;
    assert.notDeepEqual(before, after);
    assert.deepEqual(plain(before), plain(after));
    const footer = after.find((line) => stripVTControlCharacters(line).includes("btw"));
    assert.ok(footer?.includes(active.getFgAnsi("dim")), "callback metadata uses the new palette");
    assert.ok(!footer?.includes(appearanceTheme("dark").getFgAnsi("dim")), "no cached callback metadata colour");
    assert.equal(scroll.isFollowingEnd, false);
    assert.match(plain(after).join("\n"), /draft 中文 🙂[\s\S]*Main focus/u);
    assert.deepEqual(h.actions, []);
  },
);
for (const state of ["answered", "answering"] as const) {
  test(`native reachable footer hints survive composer mouse focus, expanded paste and resize (${state})`, () => {
    const bindings = keys({
      "tui.input.submit": ["ctrl+j", "alt+s"],
      "tui.altScreen.pageUp": "ctrl+u",
      "tui.altScreen.pageDown": [],
    });
    const h = harness(state, appearanceTheme("dark"), { native: true, bindings, turns: history(20) });
    h.resize(120, 24);
    const frame = h.frame();
    const full = plain(frame.lines).join("\n");
    assert.match(full, new RegExp(`Alt\\+S ${state === "answering" ? "queue next" : "send"}`, "u"));
    assert.match(full, /Ctrl\+U history/u);
    assert.doesNotMatch(full, /Enter send|Ctrl\+J send|PgUp|PgDn/u);
    h.clickComposer();
    h.send("\u001b[Z");
    assert.deepEqual(h.levels, ["high"]);
    const cycled = h.frame();
    assert.match(plain(cycled.lines).join("\n"), /thinking high/u);
    const editor = findBox(cycled.root, (candidate) => candidate.component instanceof Editor);
    assert.ok(editor?.lines?.[0]?.includes(appearanceTheme("dark").getFgAnsi("thinkingHigh")));
    h.send("\u0015");
    const scroll = h.view.getPrimaryScrollView();
    const top = scroll.scrollTop;
    assert.equal(scroll.isFollowingEnd, false);
    const draft = `expanded 中文 🙂 ${"p".repeat(2200)}\nlast line`;
    h.send(`\u001b[200~${draft}\u001b[201~`);
    for (const [width, height] of [
      [40, 10],
      [120, 40],
      [80, 24],
      [120, 24],
    ]) {
      h.resize(width ?? 80, height ?? 24);
      const resized = h.frame();
      assert.ok(resized.lines.some((line) => line.includes(CURSOR_MARKER)));
      assert.equal(scroll.isFollowingEnd, false);
    }
    assert.ok(scroll.scrollTop <= top, "resize does not jump to the transcript end");
    h.send("\u001bs");
    if (state === "answering") assert.deepEqual(h.submitted, [draft]);
    else assert.deepEqual(h.actions, [{ kind: "submit", question: draft }]);
  });
}
test("narrow footers omit complete fields and never advertise clipped or blocked shortcuts", () => {
  const h = harness("answered", appearanceTheme("dark"), {
    bindings: keys({
      "tui.input.submit": ["alt+s", "alt+x"],
      "tui.altScreen.pageUp": "alt+s",
      "tui.altScreen.pageDown": [],
    }),
    turns: history(20),
  });
  setBtwHostInputBlockers(h.tui, ["alt+s"]);
  h.view.setWorkspaceFocus("main", "F6");
  const completeLabels = new Set(["Alt+X", "Ctrl+C", "Ctrl+R", "Shift+Tab", "F6"]);
  for (const width of [1, 6, 20, 40, 79, 80, 120]) {
    h.resize(width, 24);
    const text = plain(h.view.render(width)).join("\n");
    assert.doesNotMatch(text, /Alt\+S|Enter send|\.\.\.|Ctrl…|Alt…/u);
    for (const token of text.match(/(?:Alt|Ctrl|Shift)\+[^\s•·]+|F\d+/gu) ?? []) {
      assert.ok(completeLabels.has(token), `partial or unreachable key label: ${token}`);
    }
    if (width === 120) {
      assert.match(text, /Alt\+X send/u);
      assert.match(text, /Main focus/u);
      assert.match(text, new RegExp(`${model.provider}/${model.id}`, "u"));
    }
  }
});

for (const native of [false, true]) {
  test(`long metadata is omitted as complete fields (native=${native})`, () => {
    const h = harness("answered", appearanceTheme("dark"), {
      native,
      model: { provider: "provider", id: "long-model-id-中文🙂".repeat(24) },
    });
    h.view.setWorkspaceFocus("main", "F6");
    for (const width of [1, 6, 20, 40, 79, 80, 120]) {
      h.resize(width, 24);
      const lines = plain(native ? h.frame().lines : h.view.render(width));
      const metadata = lines.find((line) => line.includes("btw"));
      if (width === 1) assert.equal(metadata, undefined);
      else {
        assert.ok(metadata);
        assert.match(metadata, /^btw(?: · Main focus)?(?: +thinking medium)?$/u);
        assert.doesNotMatch(metadata, /provider|long-model|\.\.\.|…/u);
        if (width >= 20) assert.match(metadata, /Main focus/u);
      }
    }
  });
}

test.each(["dark", "light", "system"] as const)("native scrollbar uses callback ANSI roles (%s)", (palette) => {
  const theme = appearanceTheme(palette);
  const h = harness("answered", theme, { native: true, turns: history(20) });
  h.frame();
  const scroll = h.view.getPrimaryScrollView();
  scroll.scrollBy(-1);
  const frame = h.frame();
  assert.ok(frame.lines.some((line) => line.includes(theme.getFgAnsi("scrollbarTrack"))));
  assert.ok(frame.lines.some((line) => line.includes(theme.getFgAnsi("scrollbarThumb"))));
  assert.equal(scroll.isFollowingEnd, false);
});
