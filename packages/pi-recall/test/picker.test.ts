import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import { CURSOR_MARKER, type Focusable, visibleWidth } from "@earendil-works/pi-tui";
import { test } from "vitest";
import type { RecallMessageRecord } from "../src/messages.js";
import { ScopedRecallPicker } from "../src/picker.js";

function saved(id: string, sessionId: string, cwd: string, text: string): RecallMessageRecord {
  return {
    type: "recall_message",
    version: 1,
    id,
    savedAt: "2026-08-04T12:00:00.000Z",
    source: {
      sessionId,
      entryId: `entry-${id}`,
      sessionName: `Session ${sessionId}`,
      cwd,
      messageTimestamp: Date.parse("2026-08-04T11:00:00.000Z"),
    },
    role: id === "one" ? "user" : "assistant",
    text,
  };
}

function createPicker(
  records: RecallMessageRecord[],
  options: {
    initialScope?: "all" | "cwd" | "session";
    initialSelectedId?: string;
    initialQuery?: string;
    rows?: number;
  } = {},
) {
  let result: unknown;
  let renders = 0;
  const themeCalls: Array<{ kind: "fg" | "bg"; color: string; text: string }> = [];
  const picker = new ScopedRecallPicker({
    tui: { terminal: { rows: options.rows ?? 12 }, requestRender: () => renders++ } as never,
    theme: {
      fg: (color: string, text: string) => {
        themeCalls.push({ kind: "fg", color, text });
        return text;
      },
      bg: (color: string, text: string) => {
        themeCalls.push({ kind: "bg", color, text });
        return text;
      },
      bold: (text: string) => text,
    } as never,
    keybindings: {
      matches(data: string, key: string) {
        return (
          (data === "up" && key === "tui.select.up") ||
          (data === "down" && key === "tui.select.down") ||
          (data === "enter" && key === "tui.select.confirm") ||
          (data === "escape" && key === "tui.select.cancel") ||
          (data === "cycle-forward" && key === "app.tree.filter.cycleForward") ||
          (data === "cycle-backward" && key === "app.tree.filter.cycleBackward") ||
          (data === "\u0004" && key === "app.session.delete")
        );
      },
      getKeys: (key: string) => {
        const keys: Record<string, string[]> = {
          "app.session.delete": ["ctrl+d"],
          "app.tree.filter.cycleForward": ["ctrl+o"],
          "app.tree.filter.cycleBackward": ["ctrl+shift+o"],
        };
        return keys[key] ?? [];
      },
    } as never,
    records,
    current: { sessionId: "current", cwd: "/work/project" },
    initialScope: options.initialScope ?? "cwd",
    initialSelectedId: options.initialSelectedId,
    initialQuery: options.initialQuery,
    complete: (value) => {
      result = value;
    },
  });
  return { picker, result: () => result, renders: () => renders, themeCalls };
}

test("defaults to Current cwd and cycles scope forward and backward with visible counts", () => {
  const { picker, renders } = createPicker([
    saved("one", "current", "/work/project", "one"),
    saved("two", "other", "/work/project", "two"),
    saved("three", "elsewhere", "/other", "three"),
  ]);
  assert.match(picker.render(80).join("\n"), /Scope: Current cwd \(2\).*Tab change scope/);
  picker.handleInput("\t");
  assert.match(picker.render(80).join("\n"), /Scope: All \(3\)/);
  picker.handleInput("\t");
  assert.match(picker.render(80).join("\n"), /Scope: Current session \(1\)/);
  picker.handleInput("\u001b[Z");
  assert.match(picker.render(80).join("\n"), /Scope: All \(3\)/);
  assert.equal(renders(), 3);
});

test("cycles all, user, and assistant views through injected tree bindings", () => {
  const { picker, renders } = createPicker([
    saved("one", "current", "/work/project", "user note"),
    saved("two", "other", "/work/project", "assistant note"),
    saved("three", "elsewhere", "/work/project", "another assistant note"),
  ]);
  assert.match(picker.render(100).join("\n"), /View: All messages \(3\)/);
  picker.handleInput("cycle-forward");
  let rendered = picker.render(100).join("\n");
  assert.match(rendered, /View: User only \(1\)/);
  assert.match(rendered, /user note/);
  assert.doesNotMatch(rendered, /assistant note/);
  picker.handleInput("cycle-forward");
  rendered = picker.render(100).join("\n");
  assert.match(rendered, /View: Assistant only \(2\)/);
  assert.doesNotMatch(rendered, /user note/);
  assert.match(rendered, /assistant note/);
  picker.handleInput("cycle-forward");
  assert.match(picker.render(100).join("\n"), /View: All messages \(3\)/);
  picker.handleInput("cycle-backward");
  assert.match(picker.render(100).join("\n"), /View: Assistant only \(2\)/);
  assert.equal(renders(), 4);
});

test("applies scope before view before query and reports mode-specific empty states", () => {
  const { picker } = createPicker([
    saved("one", "current", "/work/project", "local user alpha"),
    saved("two", "other", "/work/project", "local assistant beta"),
    saved("three", "elsewhere", "/other", "remote assistant alpha"),
  ]);
  picker.handleInput("cycle-forward");
  picker.handleInput("alpha");
  let rendered = picker.render(100).join("\n");
  assert.match(rendered, /Scope: Current cwd \(2\).*View: User only \(1\).*1 match/);
  assert.match(rendered, /local user alpha/);
  assert.doesNotMatch(rendered, /remote assistant alpha/);
  picker.handleInput("\t");
  rendered = picker.render(100).join("\n");
  assert.match(rendered, /Scope: All \(3\).*View: User only \(1\).*1 match/);

  const emptyView = createPicker([saved("two", "current", "/work/project", "assistant only")]);
  emptyView.picker.handleInput("cycle-forward");
  assert.match(emptyView.picker.render(80).join("\n"), /No user messages in this scope/);

  const noQueryMatch = createPicker([saved("one", "current", "/work/project", "alpha")]);
  noQueryMatch.picker.handleInput("cycle-forward");
  noQueryMatch.picker.handleInput("zulu");
  assert.match(noQueryMatch.picker.render(80).join("\n"), /No matching saved messages/);
});

test("preserves visible selection across view changes and falls back deterministically", () => {
  const records = [
    saved("one", "current", "/work/project", "user note"),
    saved("two", "current", "/work/project", "older assistant"),
    saved("three", "current", "/work/project", "newer assistant"),
  ];
  const visible = createPicker(records, { initialSelectedId: "one" });
  visible.picker.handleInput("cycle-forward");
  visible.picker.handleInput("enter");
  assert.deepEqual(visible.result(), {
    kind: "selected",
    recordId: "one",
    scope: "cwd",
    view: "user",
    query: "",
  });

  const hidden = createPicker(records, { initialSelectedId: "two" });
  hidden.picker.handleInput("cycle-forward");
  hidden.picker.handleInput("cycle-forward");
  hidden.picker.handleInput("enter");
  assert.deepEqual(hidden.result(), {
    kind: "selected",
    recordId: "three",
    scope: "cwd",
    view: "assistant",
    query: "",
  });
});

test("preserves a selected saved id across scope changes when still visible", () => {
  const { picker, result } = createPicker([
    saved("one", "current", "/work/project", "one"),
    saved("two", "other", "/work/project", "two"),
    saved("three", "elsewhere", "/other", "three"),
  ]);
  picker.handleInput("down");
  picker.handleInput("\t");
  picker.handleInput("enter");
  assert.deepEqual(result(), {
    kind: "selected",
    recordId: "one",
    scope: "all",
    view: "all",
    query: "",
  });
});

test("falls back to the first newest record when selection leaves the scope", () => {
  const { picker, result } = createPicker([
    saved("one", "current", "/work/project", "one"),
    saved("two", "other", "/work/project", "two"),
    saved("three", "elsewhere", "/other", "three"),
  ]);
  picker.handleInput("\t");
  picker.handleInput("\t");
  picker.handleInput("enter");
  assert.deepEqual(result(), {
    kind: "selected",
    recordId: "one",
    scope: "session",
    view: "all",
    query: "",
  });
});

test("escape returns to the menu while ctrl+c closes the whole Recall flow", () => {
  const records = [saved("one", "current", "/work/project", "one")];
  const back = createPicker(records);
  back.picker.handleInput("escape");
  assert.deepEqual(back.result(), {
    kind: "back",
    scope: "cwd",
    view: "all",
    selectedId: "one",
    query: "",
  });
  const close = createPicker(records);
  close.picker.handleInput("\u0003");
  assert.deepEqual(close.result(), {
    kind: "close",
    scope: "cwd",
    view: "all",
    selectedId: "one",
    query: "",
  });
});

test("empty scopes remain switchable and rendered output is sanitized and width-safe", () => {
  const { picker } = createPicker([
    saved(
      "unsafe",
      "other",
      "/other",
      "unsafe\u001b]8;;https://bad\u0007link\u001b[31m\u202espoof\u2066\u2028break\u2029",
    ),
  ]);
  const empty = picker.render(24);
  assert.match(empty.join("\n"), /No saved messages/);
  picker.handleInput("\t");
  const all = picker.render(24);
  assert.ok(all.every((line) => visibleWidth(line) <= 24));
  const rendered = all.join("\n");
  assert.equal(rendered.includes("\u001b]"), false);
  assert.equal(rendered.includes("\u001b[31m"), false);
  assert.equal(rendered.includes("https://bad"), false);
  assert.equal(rendered.includes("\u202e"), false);
  assert.equal(rendered.includes("\u2066"), false);
  assert.equal(rendered.includes("\u2028"), false);
  assert.equal(rendered.includes("\u2029"), false);
  picker.dispose();
  picker.handleInput("\t");
  assert.match(picker.render(24).join("\n"), /Scope: All \(1\)/);
});

test("fuzzy-searches message text, role, and session name with relevance ordering", () => {
  const direct = saved("one", "current", "/work/project", "alpha release");
  direct.source.sessionName = "Planning Room";
  const later = saved("two", "other", "/work/project", "prefix alpha notes");
  later.source.sessionName = "Other Room";

  const content = createPicker([direct, later]);
  assert.ok(
    content.picker.render(100).join("\n").indexOf("prefix alpha") <
      content.picker.render(100).join("\n").indexOf("alpha release"),
  );
  content.picker.handleInput("alpha");
  const ranked = content.picker.render(100).join("\n");
  assert.ok(ranked.indexOf("alpha release") < ranked.indexOf("prefix alpha"));

  const role = createPicker([direct, later]);
  role.picker.handleInput("user");
  assert.match(role.picker.render(100).join("\n"), /alpha release/);
  assert.doesNotMatch(role.picker.render(100).join("\n"), /prefix alpha/);

  const session = createPicker([direct, later]);
  session.picker.handleInput("plnng room");
  assert.match(session.picker.render(100).join("\n"), /Planning Room/);
  assert.doesNotMatch(session.picker.render(100).join("\n"), /Other Room/);

  const hiddenMetadata = createPicker([direct, later]);
  hiddenMetadata.picker.handleInput("work project");
  assert.match(hiddenMetadata.picker.render(100).join("\n"), /No matching saved messages/);
});

test("applies scope before search and distinguishes totals, matches, and empty states", () => {
  const noMatch = createPicker([
    saved("one", "current", "/work/project", "local note"),
    saved("two", "other", "/other", "remote needle"),
  ]);
  noMatch.picker.handleInput("needle");
  let rendered = noMatch.picker.render(80).join("\n");
  assert.match(rendered, /Scope: Current cwd \(1\).*0 matches/);
  assert.match(rendered, /No matching saved messages/);
  noMatch.picker.handleInput("enter");
  assert.equal(noMatch.result(), undefined);
  noMatch.picker.handleInput("\t");
  rendered = noMatch.picker.render(80).join("\n");
  assert.match(rendered, /Scope: All \(2\).*1 match/);
  assert.match(rendered, /remote needle/);

  const empty = createPicker([saved("three", "other", "/other", "elsewhere")]);
  assert.match(empty.picker.render(80).join("\n"), /No saved messages in this scope/);
});

test("renders tree-inspired rows, view status, provenance, and binding-derived hints", () => {
  const { picker, themeCalls } = createPicker([
    saved("one", "current", "/work/project", "user preview"),
    saved("two", "other", "/work/project", "assistant preview"),
  ]);
  let rendered = stripVTControlCharacters(picker.render(120).join("\n"));
  assert.match(rendered, /› assistant: assistant preview/);
  assert.match(rendered, / {2}user: user preview/);
  assert.match(rendered, /Session other/);
  assert.match(rendered, /2026-08-04T11:00:00.000Z/);
  assert.match(rendered, /\(1\/2\) \[all\]/);
  assert.match(rendered, /ctrl\+o\/ctrl\+shift\+o view/);
  assert.ok(themeCalls.some((call) => call.kind === "bg" && call.color === "selectedBg" && call.text.startsWith("› ")));
  assert.ok(themeCalls.some((call) => call.kind === "fg" && call.color === "accent" && call.text === "user: "));
  assert.ok(themeCalls.some((call) => call.kind === "fg" && call.color === "success" && call.text === "assistant: "));

  picker.handleInput("cycle-forward");
  rendered = stripVTControlCharacters(picker.render(120).join("\n"));
  assert.match(rendered, /\(1\/1\) \[user\]/);
});

test("preserves query spaces, removes pasted controls, bounds queries, and forwards focus", () => {
  const record = saved("one", "current", "/work/project", "bar foo 📖");
  const { picker } = createPicker([record]);
  const focusable = picker as ScopedRecallPicker & Focusable;
  focusable.focused = true;
  assert.equal(picker.render(80).join("\n").includes(CURSOR_MARKER), true);
  focusable.focused = false;
  picker.handleInput("\u001b[200~foo \u0007\u009dbar\u009c\u202e\u2066\u2028\u2029\u001b[201~");
  const rendered = picker.render(80).join("\n");
  assert.match(rendered, /bar foo/);
  assert.equal(rendered.includes("\u0007"), false);
  assert.equal(rendered.includes("\u009d"), false);
  assert.equal(rendered.includes("\u009c"), false);
  assert.equal(rendered.includes("\u202e"), false);
  assert.equal(rendered.includes("\u2066"), false);
  assert.equal(rendered.includes("\u2028"), false);
  assert.equal(rendered.includes("\u2029"), false);
  for (const width of [1, 2, 8, 20, 80]) {
    assert.ok(picker.render(width).every((line) => visibleWidth(line) <= width));
  }

  const overlong = createPicker([record]);
  overlong.picker.handleInput("a".repeat(257));
  assert.match(overlong.picker.render(80).join("\n"), /Search query is too long.*256/);
  assert.match(overlong.picker.render(80).join("\n"), /No matching saved messages/);

  const beforeDispose = picker.render(80);
  picker.dispose();
  assert.equal(picker.render(80).join("\n").includes(CURSOR_MARKER), false);
  picker.handleInput("ignored");
  assert.deepEqual(picker.render(80), beforeDispose);
});

test("requests direct deletion with the selected record and nearest surviving result", () => {
  const content = createPicker([
    saved("one", "current", "/work/project", "first saved message"),
    saved("two", "current", "/work/project", "second saved message"),
  ]);
  content.picker.handleInput("down");
  assert.match(content.picker.render(20).join("\n"), /ctrl\+d delete/i);
  content.picker.handleInput("\u0004");
  assert.deepEqual(content.result(), {
    kind: "delete",
    recordId: "one",
    nextSelectedId: "two",
    scope: "cwd",
    view: "all",
    query: "",
  });
});

test("does not request deletion without a match and leaves plain Delete to search input", () => {
  const noMatch = createPicker([saved("one", "current", "/work/project", "alpha")], {
    initialQuery: "zulu",
  });
  noMatch.picker.handleInput("\u0004");
  assert.equal(noMatch.result(), undefined);

  const editing = createPicker([saved("one", "current", "/work/project", "alpha")]);
  editing.picker.handleInput("\u001b[3~");
  assert.equal(editing.result(), undefined);
});

test("restores selection after broadening and carries query through scope and completion", () => {
  const records = [saved("one", "current", "/work/project", "alpha"), saved("two", "other", "/work/project", "zulu")];
  const restored = createPicker(records, { initialSelectedId: "one" });
  restored.picker.handleInput("z");
  restored.picker.handleInput("\u007f");
  restored.picker.handleInput("enter");
  assert.deepEqual(restored.result(), {
    kind: "selected",
    recordId: "one",
    scope: "cwd",
    view: "all",
    query: "",
  });

  const carried = createPicker(records, { initialQuery: "alpha" });
  assert.match(stripVTControlCharacters(carried.picker.render(80).join("\n")), /Search: .*alpha/);
  carried.picker.handleInput("\t");
  carried.picker.handleInput("enter");
  assert.deepEqual(carried.result(), {
    kind: "selected",
    recordId: "one",
    scope: "all",
    view: "all",
    query: "alpha",
  });
});
