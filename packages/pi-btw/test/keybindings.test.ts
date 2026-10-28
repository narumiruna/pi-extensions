import assert from "node:assert/strict";
import {
  isKittyProtocolActive,
  KeybindingsManager,
  matchesKey,
  StdinBuffer,
  setKittyProtocolActive,
  TUI_KEYBINDINGS,
} from "@earendil-works/pi-tui";
import { afterEach, test, vi } from "vitest";
import {
  BtwPasteGuard,
  btwKeysOverlap,
  normalizeBtwKey,
  resolveBtwShortcuts,
  validateBtwShortcutEdit,
} from "../src/keybindings.js";

test.each([false, true])("manual import fallback respects terminal mode %s", (kitty) => {
  setKittyProtocolActive(kitty);
  const keys = manager({ "app.thinking.cycle": ["f9", "f10"] });
  const shortcuts = resolveBtwShortcuts({}, keys);
  assert.deepEqual(shortcuts.keys.importMainUpdates, ["f11"]);
  assert.equal(shortcuts.matches("\u001b[23~", "importMainUpdates"), true);
  const unavailable = resolveBtwShortcuts({}, manager({ "app.thinking.cycle": ["f9", "f10", "f11"] }));
  assert.deepEqual(unavailable.keys.importMainUpdates, []);
  assert.ok(unavailable.warnings.some((warning) => warning.startsWith("importMainUpdates:")));
});

test.each([
  ["ctrl+alt+x", "alt+ctrl+x", "\u001b\u0018"],
  ["ctrl+[", "esc", "\u001b"],
  ["unknown+ctrl+x", "invalid", ""],
  ["ctrl+r", "existing bring action", "\u0012"],
])("manual import rejects invalid or conflicting override %s (%s)", (candidate, _label, _input) => {
  assert.ok(validateBtwShortcutEdit("importMainUpdates", candidate, { exit: "alt+ctrl+x" }, manager(), true));
});

test("manual import accepts a reachable override without displacing existing defaults", () => {
  const keys = manager();
  assert.equal(validateBtwShortcutEdit("importMainUpdates", "f12", {}, keys, true), undefined);
  const shortcuts = resolveBtwShortcuts({ importMainUpdates: "f12" }, keys);
  assert.equal(shortcuts.matches("\u001b[24~", "importMainUpdates"), true);
  assert.deepEqual(shortcuts.keys.switchPane, ["f6"]);
  assert.deepEqual(shortcuts.keys.bringToMain, ["ctrl+r"]);
});

const initialKitty = isKittyProtocolActive();
afterEach(() => {
  setKittyProtocolActive(initialKitty);
  vi.unstubAllEnvs();
});
function manager(bindings: Readonly<Record<string, string | readonly string[]>> = {}) {
  return new KeybindingsManager(
    {
      ...TUI_KEYBINDINGS,
      "app.thinking.cycle": { defaultKeys: "shift+tab" },
      "app.message.copy": { defaultKeys: "ctrl+x" },
    },
    bindings as never,
  );
}

test.each([
  ["CTRL+SHIFT+P", "shift+ctrl+p"],
  ["alt+ctrl+x", "alt+ctrl+x"],
  ["esc", "escape"],
  ["return", "enter"],
  ["pageUp", "pageup"],
  ["shift+clear", "shift+clear"],
  ["ctrl+clear", "ctrl+clear"],
  ["f12", "f12"],
  ["super+k", "super+k"],
  ["ctrl+_", "ctrl+_"],
  ["meta+x", undefined],
  ["ctrl+ctrl+x", undefined],
  ["ctrl+", undefined],
  ["ctrl++", undefined],
  ["ctrl+escape", undefined],
  ["shift+f1", undefined],
  ["alt+clear", undefined],
  ["constructor", undefined],
  [" ctrl+x", undefined],
  ["ctrl+\u001b", undefined],
  ["f13", undefined],
  ["ctrl+unknown", undefined],
])("normalizes strict BTW key syntax %s", (input, expected) => {
  assert.equal(normalizeBtwKey(input), expected);
});

test.each([
  ["esc", "escape"],
  ["return", "enter"],
  ["ctrl+shift+p", "shift+ctrl+p"],
  ["ctrl+i", "tab"],
  ["ctrl+m", "enter"],
  ["ctrl+j", "enter"],
  ["ctrl+[", "escape"],
  ["ctrl+-", "ctrl+_"],
  ["ctrl+h", "backspace"],
  ["alt+b", "alt+left"],
  ["alt+f", "alt+right"],
  ["alt+p", "alt+up"],
  ["alt+n", "alt+down"],
  ["ctrl+alt+h", "alt+backspace"],
  ["ctrl+alt+m", "alt+enter"],
])("detects live legacy matcher overlap: %s / %s", (first, second) => {
  setKittyProtocolActive(false);
  vi.stubEnv("WT_SESSION", "");
  assert.equal(btwKeysOverlap(first, second), true);
});

test.each(["unknown+ctrl+x", "ctrl+ctrl+x"])("invalid Pi modifier tokens do not overlap: %s", (key) => {
  assert.equal(matchesKey("\u0018", key as never), false);
  assert.equal(btwKeysOverlap("ctrl+x", key), false);
});

test("mode-dependent and Windows Terminal collisions follow Pi rather than string identity", () => {
  setKittyProtocolActive(true);
  assert.equal(btwKeysOverlap("alt+b", "alt+left"), false);
  assert.equal(btwKeysOverlap("ctrl+j", "shift+enter"), true);
  assert.equal(btwKeysOverlap("ctrl+j", "enter"), false);
  assert.equal(btwKeysOverlap("ctrl+alt+m", "alt+enter"), false);
  setKittyProtocolActive(false);
  assert.equal(btwKeysOverlap("ctrl+alt+i", "alt+tab"), false);
  vi.stubEnv("WT_SESSION", "test");
  for (const name of ["SSH_CONNECTION", "SSH_CLIENT", "SSH_TTY"]) vi.stubEnv(name, "");
  assert.equal(btwKeysOverlap("ctrl+h", "ctrl+backspace"), true);
  assert.equal(btwKeysOverlap("ctrl+h", "backspace"), false);
  vi.stubEnv("SSH_TTY", "/dev/pts/1");
  assert.equal(btwKeysOverlap("ctrl+h", "backspace"), true);
});

test("defaults, explicit overrides, first usable inherited fallback and release filtering", () => {
  const defaults = resolveBtwShortcuts({}, manager());
  assert.deepEqual(defaults.keys, {
    exit: ["ctrl+c"],
    cycleThinkingLevel: ["shift+tab"],
    bringToMain: ["ctrl+r"],
    switchPane: ["f6"],
    importMainUpdates: ["f9"],
  });
  assert.deepEqual(defaults.warnings, []);
  const custom = resolveBtwShortcuts({ exit: "ctrl+q", cycleThinkingLevel: "f6", bringToMain: "f7" }, manager());
  assert.equal(custom.matches("\u0011", "exit"), true);
  assert.equal(custom.matches("\u0003", "exit"), true);
  assert.equal(custom.matches("\u001b[17~", "cycleThinkingLevel"), true);
  assert.equal(custom.matches("\u001b[18~", "bringToMain"), true);
  assert.equal(custom.matches("\u0012", "bringToMain"), false);
  assert.equal(custom.matches("\u001b[113;5:3u", "exit"), false);
  assert.equal(custom.label("exit"), "Ctrl+Q");
  const fallback = resolveBtwShortcuts(
    {},
    manager({ "app.thinking.cycle": ["ctrl+c", "alt+clear", "ctrl+i", "f6", "f7"] }),
  );
  assert.deepEqual(fallback.keys.cycleThinkingLevel, ["f6", "f7"]);
  assert.equal(fallback.label("cycleThinkingLevel"), "F6");
});

test("explicit Pi printable thinking bindings remain inherited but new overrides cannot take text", () => {
  const inherited = resolveBtwShortcuts({}, manager({ "app.thinking.cycle": "t" }));
  assert.equal(inherited.matches("t", "cycleThinkingLevel"), true);
  assert.ok(validateBtwShortcutEdit("cycleThinkingLevel", "t", {}, manager(), true));
  assert.deepEqual(resolveBtwShortcuts({}, manager({ "app.thinking.cycle": [] })).warnings, []);
});

test.each([
  "ctrl+b",
  "ctrl+i",
  "ctrl+j",
  "ctrl+m",
  "ctrl+[",
  "alt+enter",
  "shift+space",
  "shift+backspace",
  "ctrl+shift+f",
  "pageup",
  "escape",
  "x",
  "shift+x",
])("rejects reserved editor, viewport and text binding %s", (key) => {
  assert.ok(validateBtwShortcutEdit("exit", key, {}, manager(), true));
});

test("edits reject alias conflicts, preserve other defaults, and allow recovery resets", () => {
  assert.ok(validateBtwShortcutEdit("exit", "ctrl+r", {}, manager(), true));
  assert.ok(validateBtwShortcutEdit("exit", "shift+tab", {}, manager(), true));
  assert.ok(validateBtwShortcutEdit("bringToMain", "alt+ctrl+x", { exit: "ctrl+alt+x" }, manager(), true));
  assert.equal(validateBtwShortcutEdit("exit", "ctrl+q", {}, manager(), true), undefined);
  assert.equal(validateBtwShortcutEdit("exit", "ctrl+c", {}, manager(), true), undefined);
  assert.equal(
    validateBtwShortcutEdit("exit", undefined, { exit: "ctrl+b", bringToMain: "ctrl+b" }, manager(), true),
    undefined,
  );
});

test("non-default editor/viewport/copy bindings win; stale overrides warn and fall back", () => {
  const keys = manager({ "tui.editor.historyPrevious": "ctrl+q", "tui.altScreen.bottom": "f6" });
  assert.ok(validateBtwShortcutEdit("exit", "ctrl+q", {}, keys, true));
  assert.ok(validateBtwShortcutEdit("cycleThinkingLevel", "f6", {}, keys, true));
  assert.equal(validateBtwShortcutEdit("exit", "ctrl+x", {}, keys, true), undefined);
  assert.ok(validateBtwShortcutEdit("exit", "ctrl+x", {}, keys, false));
  const fallback = resolveBtwShortcuts({ exit: "ctrl+q", cycleThinkingLevel: "f6" }, keys);
  assert.deepEqual(fallback.keys.exit, ["ctrl+c"]);
  assert.deepEqual(fallback.keys.cycleThinkingLevel, ["shift+tab"]);
  assert.equal(fallback.warnings.length, 2);
  const unavailable = resolveBtwShortcuts({}, manager({ "tui.editor.undo": "ctrl+r", "app.thinking.cycle": "ctrl+c" }));
  assert.deepEqual(unavailable.keys.bringToMain, []);
  assert.deepEqual(unavailable.keys.cycleThinkingLevel, []);
  assert.equal(unavailable.label("bringToMain"), "Unavailable");
});

test.each(["\u001b[112;6u", "\u001b[80;6u", "\u001b[112;70u", "\u001b[27;6;80~", "\u001b[1095::112;6u"])(
  "matches normalized terminal encoding %j",
  (input) => {
    const shortcuts = resolveBtwShortcuts(
      { cycleThinkingLevel: "ctrl+shift+p" },
      manager({ "tui.editor.jumpForward": [], "tui.editor.undo": [] }),
    );
    assert.equal(matchesKey(input, "ctrl+shift+p"), true);
    assert.equal(shortcuts.matches(input, "cycleThinkingLevel"), true);
  },
);

test("hints and matching revalidate after asynchronous terminal negotiation changes mode", () => {
  setKittyProtocolActive(true);
  const shortcuts = resolveBtwShortcuts({ exit: "alt+b" }, manager({ "tui.editor.cursorWordLeft": "alt+left" }));
  assert.equal(shortcuts.label("exit"), "Alt+B");
  setKittyProtocolActive(false);
  assert.equal(shortcuts.label("exit"), "Ctrl+C");
  assert.equal(shortcuts.matches("\u001bb", "exit"), false);
  assert.equal(shortcuts.matches("\u0003", "exit"), true);
  setKittyProtocolActive(true);
  assert.equal(shortcuts.label("exit"), "Alt+B");
});

test("keypad input follows the same inherited conflict and activation identity", () => {
  const shortcuts = resolveBtwShortcuts({}, manager({ "app.thinking.cycle": "1" }));
  assert.equal(shortcuts.matches("\u001b[57399u", "cycleThinkingLevel"), false);
  assert.equal(shortcuts.matches("\u001b[57400u", "cycleThinkingLevel"), true);
});

test.each([
  ["shift+ctrl+1", "ctrl+!", "\u001b[49:33;6u"],
  ["shift+ctrl+=", "ctrl++", "\u001b[61:43;6u"],
  ["ctrl+1", "ctrl+s", "\u001b[49::115;5u"],
  ["shift+!", "!", "\u001b[27;2;33~"],
] as const)("enhanced physical/logical identities %s and %s share a reserved input", (first, second, input) => {
  assert.equal(matchesKey(input, first as never), true);
  assert.equal(matchesKey(input, second as never), true);
  assert.equal(btwKeysOverlap(first, second), true);
});

test("enhanced shortcut conflicts preserve editing and hard cancellation", () => {
  assert.ok(validateBtwShortcutEdit("exit", "shift+ctrl+1", {}, manager({ "tui.editor.undo": "ctrl+!" }), true));
  assert.ok(validateBtwShortcutEdit("exit", "ctrl+1", {}, manager(), true));
  assert.equal(btwKeysOverlap("ctrl+s", "ctrl+d"), false);
});

test.each([
  [{ exit: "shift+tab" }, ["ctrl+c"], ["shift+tab"], ["ctrl+r"]],
  [{ cycleThinkingLevel: "ctrl+r" }, ["ctrl+c"], ["shift+tab"], ["ctrl+r"]],
  [{ exit: "f6", cycleThinkingLevel: "f6" }, ["ctrl+c"], ["shift+tab"], ["ctrl+r"]],
  [{ exit: "shift+tab", cycleThinkingLevel: "ctrl+r" }, ["ctrl+c"], ["shift+tab"], ["ctrl+r"]],
  [{ exit: "shift+tab", cycleThinkingLevel: "f6" }, ["shift+tab", "ctrl+c"], ["f6"], ["ctrl+r"]],
] as const)("resolves the complete shortcut proposal %j", (overrides, exit, cycle, bring) => {
  const resolved = resolveBtwShortcuts(overrides, manager());
  assert.deepEqual(
    {
      exit: resolved.keys.exit,
      cycleThinkingLevel: resolved.keys.cycleThinkingLevel,
      bringToMain: resolved.keys.bringToMain,
    },
    { exit, cycleThinkingLevel: cycle, bringToMain: bring },
  );
  if (exit.length === 1) assert.ok(resolved.warnings.length);
});

test.each([
  [{ "tui.altScreen.search": "f6" }, {}, ["f7"]],
  [{ "tui.altScreen.search": ["f6", "f7", "f8"] }, {}, []],
  [{ "app.thinking.cycle": ["f6", "f7"] }, {}, ["f8"]],
  [{}, { exit: "f6" }, ["f7"]],
  [{}, { cycleThinkingLevel: "f6", bringToMain: "f7" }, ["f8"]],
] as const)("pane transfer selects only the first usable fallback %j %j", (bindings, overrides, expected) => {
  const shortcuts = resolveBtwShortcuts(overrides, manager(bindings));
  assert.deepEqual(shortcuts.keys.switchPane, expected);
  assert.equal(shortcuts.matches("\u001b[17~", "switchPane"), expected.includes("f6" as never));
});

test("pane shortcut validation preserves existing overrides and rejects input collisions", () => {
  assert.equal(validateBtwShortcutEdit("exit", "f6", {}, manager(), true), undefined);
  assert.equal(validateBtwShortcutEdit("switchPane", "f9", {}, manager(), true), undefined);
  assert.ok(validateBtwShortcutEdit("switchPane", "ctrl+shift+f", {}, manager(), true));
  assert.ok(validateBtwShortcutEdit("switchPane", "ctrl+alt+x", { exit: "alt+ctrl+x" }, manager(), true));
  const custom = resolveBtwShortcuts({ switchPane: "f9" }, manager());
  assert.equal(custom.matches("\u001b[20~", "switchPane"), true);
  assert.equal(custom.matches("\u001b[17~", "switchPane"), false);
  assert.equal(custom.matches("\u001b[57372;1:3u", "switchPane"), false);
});

test("Pi stdin buffering delivers complete pastes across every delimiter split", () => {
  const start = "\u001b[200~";
  const end = "\u001b[201~";
  for (let opening = 1; opening < start.length; opening++) {
    for (let closing = 1; closing < end.length; closing++) {
      const buffer = new StdinBuffer();
      const guard = new BtwPasteGuard();
      const events: boolean[] = [];
      buffer.on("data", (data) => events.push(guard.consume(data)));
      // ProcessTerminal.setupStdinBuffer uses this exact paste rewrapping boundary.
      buffer.on("paste", (data) => events.push(guard.consume(`${start}${data}${end}`)));
      try {
        for (const chunk of [
          start.slice(0, opening),
          start.slice(opening),
          "x".repeat(10000),
          "\u0003",
          end.slice(0, closing),
          end.slice(closing),
          "\u0003",
        ])
          buffer.process(chunk);
        assert.deepEqual(events, [true, false]);
      } finally {
        buffer.destroy();
      }
    }
  }
});

test("paste guard covers whole, split, repeated and closed bracketed payloads", () => {
  const guard = new BtwPasteGuard();
  assert.equal(guard.consume("normal"), false);
  assert.equal(guard.consume("\u001b[200~text"), true);
  assert.equal(guard.consume("\u0003"), true);
  assert.equal(guard.consume("\u001b[201~"), true);
  assert.equal(guard.consume("\u0003"), false);
  assert.equal(guard.consume("\u001b[200~\u0011\u001b[201~"), true);
  assert.equal(guard.consume("\u0011"), false);
});
