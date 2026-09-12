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

const initialKitty = isKittyProtocolActive();
afterEach(() => {
  setKittyProtocolActive(initialKitty);
  vi.unstubAllEnvs();
});
function manager(bindings: Record<string, string | string[]> = {}) {
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
  ["ctrl+x", "unknown+ctrl+x"],
])("detects live legacy matcher overlap: %s / %s", (first, second) => {
  setKittyProtocolActive(false);
  vi.stubEnv("WT_SESSION", "");
  assert.equal(btwKeysOverlap(first, second), true);
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
    const shortcuts = resolveBtwShortcuts({ cycleThinkingLevel: "ctrl+shift+p" }, manager());
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

test("keypad input follows the same conflict and activation identity", () => {
  const shortcuts = resolveBtwShortcuts({ exit: "ctrl+1" }, manager());
  assert.equal(shortcuts.matches("\u001b[57399;5u", "exit"), false);
  assert.equal(shortcuts.matches("\u001b[57400;5u", "exit"), true);
});

test.each([
  [{ exit: "shift+tab" }, ["ctrl+c"], ["shift+tab"], ["ctrl+r"]],
  [{ cycleThinkingLevel: "ctrl+r" }, ["ctrl+c"], ["shift+tab"], ["ctrl+r"]],
  [{ exit: "f6", cycleThinkingLevel: "f6" }, ["ctrl+c"], ["shift+tab"], ["ctrl+r"]],
  [{ exit: "shift+tab", cycleThinkingLevel: "ctrl+r" }, ["ctrl+c"], ["shift+tab"], ["ctrl+r"]],
  [{ exit: "shift+tab", cycleThinkingLevel: "f6" }, ["shift+tab", "ctrl+c"], ["f6"], ["ctrl+r"]],
] as const)("resolves the complete shortcut proposal %j", (overrides, exit, cycle, bring) => {
  const resolved = resolveBtwShortcuts(overrides, manager());
  assert.deepEqual(resolved.keys, { exit, cycleThinkingLevel: cycle, bringToMain: bring });
  if (exit.length === 1) assert.ok(resolved.warnings.length);
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
