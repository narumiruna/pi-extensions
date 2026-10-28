import assert from "node:assert/strict";
import {
  isKeyRelease,
  isKeyRepeat,
  isKittyProtocolActive,
  Key,
  KeybindingsManager,
  type KeyId,
  matchesKey,
  parseKey,
  setKittyProtocolActive,
} from "@earendil-works/pi-tui";
import { afterEach, beforeEach, test, vi } from "vitest";
import { canonicalKeyId, keysOverlap } from "../src/components/key-matching.js";
import { canonicalizeConfiguredKey } from "../src/key-matching.js";

let previousKitty: boolean;
beforeEach(() => {
  previousKitty = isKittyProtocolActive();
  setKittyProtocolActive(false);
  for (const name of ["WT_SESSION", "SSH_CONNECTION", "SSH_CLIENT", "SSH_TTY"]) vi.stubEnv(name, "");
});
afterEach(() => {
  setKittyProtocolActive(previousKitty);
  vi.unstubAllEnvs();
});

const symbols = "`-=[]\\;',./!@#$%^&*()_+|~{}:<>?";
const modifiers = ["shift", "ctrl", "alt", "super"] as const;
const modifierMask = { shift: 1, ctrl: 4, alt: 2, super: 8 } as const;

for (const [value, canonical, input] of [
  ["+", "+", "+"],
  ["CTRL++", "ctrl++", "\x1b[43;5u"],
  ["aLt+CtRl+ShIfT+SuPeR++", "shift+ctrl+alt+super++", "\x1b[43;16u"],
  ["RETURN", "enter", "\r"],
  ["EsC", "escape", "\x1b"],
  ["PAGEUP", "pageUp", "\x1b[5~"],
  ["pageDown", "pageDown", "\x1b[6~"],
  ["ctrl+clear", "ctrl+clear", "\x1bOe"],
  ["shift+clear", "shift+clear", "\x1b[e"],
  ["f12", "f12", "\x1b[24~"],
] as const) {
  test(`configured syntax ${JSON.stringify(value)} preserves native matching`, () => {
    assert.equal(canonicalizeConfiguredKey(value), canonical);
    assert.ok(matchesKey(input, value as KeyId));
    assert.ok(matchesKey(input, canonical as KeyId));
    assert.equal(canonicalizeConfiguredKey(value), canonicalizeConfiguredKey(canonical));
  });
}

test("public special names use native KeyId spelling without changing private probe identities", () => {
  for (const [raw, native] of [
    ["PAGEUP", Key.pageUp],
    ["PAGEDOWN", Key.pageDown],
  ] as const) {
    assert.equal(canonicalizeConfiguredKey(raw), native);
    assert.equal(canonicalizeConfiguredKey(`CTRL+${raw}`), Key.ctrl(native));
    assert.equal(canonicalKeyId(raw), native.toLowerCase());
    assert.equal(canonicalKeyId(`CTRL+${raw}`), `ctrl+${native.toLowerCase()}`);
  }
});

for (const invalid of [
  undefined,
  null,
  1,
  true,
  {},
  [],
  "",
  " ",
  "ctrl+",
  "++",
  "ctrl+++",
  "ctrl++x",
  "x+ctrl",
  "ctrl+x+",
  " ctrl+x",
  "ctrl+x ",
  "ctrl+ x",
  "ctrl+\tx",
  "ctrl+\x1bx",
  "ctrl+ctrl+x",
  "alt+alt+x",
  "shift+ctrl+shift+x",
  "super+super+x",
  "meta+x",
  "control+x",
  "unknown+ctrl+x",
  "ctrl+unknown+x",
  "ctrl+escape",
  "shift+esc",
  "alt+f1",
  "ctrl+f12",
  "f0",
  "f13",
  "super+clear",
  "shift+ctrl+clear",
  "é",
  "ctrl+я",
  "arrowup",
  "plus",
  "capslock",
]) {
  test(`invalid configured key ${JSON.stringify(invalid)} is not repaired`, () => {
    assert.equal(canonicalizeConfiguredKey(invalid), undefined);
  });
}

test("all printable key and modifier classes have a native CSI-u witness", () => {
  for (const base of `abcdefghijklmnopqrstuvwxyz0123456789${symbols}`) {
    for (let mask = 0; mask < 16; mask++) {
      const prefix = modifiers.filter((modifier) => mask & modifierMask[modifier]);
      const configured = [...prefix, base].join("+");
      const canonical = canonicalizeConfiguredKey(configured);
      assert.equal(canonical, configured);
      assert.ok(matchesKey(`\x1b[${base.charCodeAt(0)};${mask + 1}u`, canonical as KeyId), configured);
    }
  }
});

test("every modifier permutation has one canonical identity", () => {
  const permutations = (remaining: readonly string[]): string[][] =>
    remaining.length === 0
      ? [[]]
      : remaining.flatMap((modifier) =>
          permutations(remaining.filter((other) => other !== modifier)).map((suffix) => [modifier, ...suffix]),
        );
  for (const order of permutations(modifiers)) {
    const key = `${order.join("+")}+x`;
    assert.equal(canonicalizeConfiguredKey(key), "shift+ctrl+alt+super+x");
    assert.ok(matchesKey("\x1b[120;16u", key as KeyId));
  }
});

for (const kitty of [false, true]) {
  test(`special-key validity follows native executable branches (Kitty ${kitty})`, () => {
    setKittyProtocolActive(kitty);
    const special = {
      space: 32,
      tab: 9,
      enter: 13,
      backspace: 127,
      up: 57419,
      down: 57420,
      left: 57417,
      right: 57418,
      insert: 57425,
      delete: 57426,
      home: 57423,
      end: 57424,
      pageUp: 57421,
      pageDown: 57422,
    };
    for (const [base, codepoint] of Object.entries(special)) {
      for (let mask = 0; mask < 16; mask++) {
        const key = [...modifiers.filter((modifier) => mask & modifierMask[modifier]), base].join("+");
        assert.equal(canonicalizeConfiguredKey(key), key);
        assert.ok(matchesKey(`\x1b[${codepoint};${mask + 1}u`, key as KeyId), key);
      }
    }
    for (const [base, input] of [
      ["escape", "\x1b"],
      ["clear", "\x1b[E"],
      ...["OP", "OQ", "OR", "OS", "[15~", "[17~", "[18~", "[19~", "[20~", "[21~", "[23~", "[24~"].map(
        (suffix, index) => [`f${index + 1}`, `\x1b${suffix}`],
      ),
    ] as const) {
      assert.equal(canonicalizeConfiguredKey(base), base);
      assert.ok(matchesKey(input, base as KeyId));
      for (const modifier of modifiers) {
        if (base === "clear" && (modifier === "shift" || modifier === "ctrl")) continue;
        assert.equal(canonicalizeConfiguredKey(`${modifier}+${base}`), undefined);
      }
    }
  });
}

const overlapCases = [
  { name: "raw Tab / Ctrl+I", first: "tab", second: "ctrl+i", input: "\t" },
  { name: "raw CR / Ctrl+M", first: "enter", second: "ctrl+m", input: "\r" },
  { name: "raw Escape / Ctrl+[", first: "escape", second: "ctrl+[", input: "\x1b" },
  { name: "raw Ctrl punctuation", first: "ctrl+-", second: "ctrl+_", input: "\x1f" },
  { name: "legacy LF / Enter", first: "enter", second: "ctrl+j", input: "\n", kitty: false },
  { name: "Kitty LF custom mapping", first: "shift+enter", second: "ctrl+j", input: "\n", kitty: true },
  { name: "legacy Alt arrow", first: "alt+up", second: "alt+p", input: "\x1bp", kitty: false },
  { name: "legacy Alt+CR", first: "alt+enter", second: "ctrl+alt+m", input: "\x1b\r", kitty: false },
  { name: "legacy Alt+BS", first: "alt+backspace", second: "ctrl+alt+h", input: "\x1b\b", kitty: false },
  { name: "Kitty physical/logical plus", first: "shift+ctrl+=", second: "ctrl++", input: "\x1b[61:43;6u" },
  { name: "Kitty digit layout fallback", first: "ctrl+1", second: "ctrl+x", input: "\x1b[49::120;5u" },
  { name: "modifyOtherKeys logical symbol", first: "shift+ctrl+!", second: "ctrl+!", input: "\x1b[27;6;33~" },
  {
    name: "Kitty Super/Alt shifted symbol",
    first: "super+alt+shift+/",
    second: "alt+super+?",
    input: "\x1b[47:63;12u",
  },
] as const;

for (const kitty of [false, true]) {
  for (const scenario of overlapCases) {
    if ("kitty" in scenario && scenario.kitty !== kitty) continue;
    test(`matcher overlap ${scenario.name} (Kitty ${kitty})`, () => {
      setKittyProtocolActive(kitty);
      assert.ok(matchesKey(scenario.input, scenario.first as KeyId));
      assert.ok(matchesKey(scenario.input, scenario.second as KeyId));
      assert.ok(keysOverlap(scenario.first, scenario.second, false));
      assert.ok(keysOverlap(scenario.second, scenario.first, false));
    });
  }
}

for (const [first, second] of [
  ["ctrl+x", "ctrl+y"],
  ["ctrl+x", "shift+ctrl+x"],
  ["ctrl+/", "ctrl+["],
  ["alt+enter", "shift+enter"],
  ["super+x", "ctrl+x"],
  ["up", "down"],
  ["clear", "ctrl+clear"],
  ["f1", "f2"],
]) {
  test(`distinct matcher identities ${first} / ${second}`, () => {
    for (const kitty of [false, true]) {
      setKittyProtocolActive(kitty);
      assert.equal(keysOverlap(first, second, false), false);
      assert.equal(keysOverlap(second, first, false), false);
    }
  });
}

test("private hint policy does not include all matcher-accepted raw aliases", () => {
  setKittyProtocolActive(true);
  for (const [first, second] of [
    ["tab", "ctrl+i"],
    ["ctrl+-", "ctrl+_"],
  ]) {
    assert.ok(keysOverlap(first, second, false));
    assert.equal(keysOverlap(first, second, true), false); // Existing component hint policy.
  }
  assert.equal(matchesKey("\x1b[105;5u", "tab"), false);
  assert.equal(matchesKey("\x1b[105;5u", "ctrl+i"), true);
});

for (const kitty of [false, true]) {
  for (const ssh of [undefined, "SSH_CONNECTION", "SSH_CLIENT", "SSH_TTY"] as const) {
    test(`BS follows local Windows Terminal heuristic (Kitty ${kitty}, SSH ${ssh ?? "none"})`, () => {
      setKittyProtocolActive(kitty);
      vi.stubEnv("WT_SESSION", "test-session");
      if (ssh) vi.stubEnv(ssh, "remote");
      const backspace = ssh ? "backspace" : "ctrl+backspace";
      const other = ssh ? "ctrl+backspace" : "backspace";
      assert.ok(matchesKey("\b", backspace));
      assert.ok(matchesKey("\b", "ctrl+h"));
      assert.equal(matchesKey("\b", other), false);
      assert.ok(keysOverlap(backspace, "ctrl+h", false));
      assert.equal(keysOverlap(other, "ctrl+h", false), false);
      assert.ok(matchesKey("\x7f", "backspace"));
      assert.ok(matchesKey("\x1b[127;5u", "ctrl+backspace"));
      assert.ok(matchesKey("\x1b[27;5;127~", "ctrl+backspace"));
    });
  }
}

test("private probes read live native mode and Windows/SSH state rather than a stale snapshot", () => {
  assert.ok(keysOverlap("enter", "ctrl+j", false));
  setKittyProtocolActive(true);
  assert.equal(keysOverlap("enter", "ctrl+j", false), false);
  assert.ok(keysOverlap("shift+enter", "ctrl+j", false));
  assert.ok(keysOverlap("backspace", "ctrl+h", false));
  vi.stubEnv("WT_SESSION", "test");
  assert.equal(keysOverlap("backspace", "ctrl+h", false), false);
  assert.ok(keysOverlap("ctrl+backspace", "ctrl+h", false));
  vi.stubEnv("SSH_TTY", "remote");
  assert.ok(keysOverlap("backspace", "ctrl+h", false));
});

for (const [input, key, result] of [
  ["\x1b[67;6u", "shift+ctrl+c", true], // Uppercase shifted-letter identity.
  ["\x1b[67;5u", "ctrl+c", false],
  ["\x1b[1089::99;5u", "ctrl+c", true], // Cyrillic + Latin base layout.
  ["\x1b[120::99;5u", "ctrl+c", false], // Latin primary is authoritative.
  ["\x1b[47::91;5u", "ctrl+[", false], // Known symbol primary is authoritative.
  ["\x1b[57400;5u", "ctrl+1", true], // Keypad normalization.
  ["\x1b[57414;2u", "shift+enter", true],
  ["\x1b[120;197u", "ctrl+x", true], // Caps Lock + Num Lock bits ignored by Kitty.
  ["\x1b[27;197;120~", "ctrl+x", false], // modifyOtherKeys compares modifiers exactly.
  ["\x1b[27;6;88~", "shift+ctrl+x", true],
  ["\x1b[27;1;9~", "tab", false], // Plain Tab/Enter omit modifyOtherKeys branch.
  ["\x1b[27;1;13~", "enter", false],
  ["\x1b[27;2;33~", "!", true],
  ["\x1b[27;2;47~", "/", false], // Only shifted symbols consume Shift in modifyOtherKeys.
  ["\x1b[97;17u", "a", false], // Unsupported modifier bit.
] as const) {
  test(`native encoding branch ${JSON.stringify(input)} / ${key}`, () => {
    assert.equal(matchesKey(input, key as KeyId), result);
    if (result) assert.ok(canonicalizeConfiguredKey(key));
  });
}

for (const [event, release, repeat] of [
  [1, false, false],
  [2, false, true],
  [3, true, false],
] as const) {
  for (const [input, first, second] of [
    [`\x1b[61:43;6:${event}u`, "shift+ctrl+=", "ctrl++"],
    [`\x1b[1;5:${event}A`, "ctrl+up", "ctrl+up"],
    [`\x1b[3;5:${event}~`, "ctrl+delete", "ctrl+delete"],
    [`\x1b[1;5:${event}H`, "ctrl+home", "ctrl+home"],
  ] as const) {
    test(`native event type ${event} ${JSON.stringify(input)} remains matcher-owned`, () => {
      assert.equal(isKeyRelease(input), release);
      assert.equal(isKeyRepeat(input), repeat);
      assert.ok(matchesKey(input, first as KeyId));
      assert.ok(matchesKey(input, second as KeyId));
      assert.ok(keysOverlap(first, second, false));
    });
  }
}

test("native conflict reporting checks raw user-string duplicates only", () => {
  const definitions = Object.fromEntries(["first", "second"].map((id) => [id, { defaultKeys: [] }]));
  for (const [first, second] of [
    ["esc", "escape"],
    ["return", "enter"],
    ["ctrl+shift+x", "shift+ctrl+x"],
    ["CTRL+X", "ctrl+x"],
    ["tab", "ctrl+i"],
    ["shift+=", "+"],
  ] as const) {
    // JSON settings can contain matcher-accepted spellings outside the KeyId type.
    const manager = new KeybindingsManager(definitions, { first: first as KeyId, second: second as KeyId });
    assert.deepEqual(manager.getConflicts(), []);
    assert.ok(keysOverlap(canonicalizeConfiguredKey(first) ?? "", canonicalizeConfiguredKey(second) ?? "", false));
  }
  const manager = new KeybindingsManager(definitions, { first: "ctrl+x", second: "ctrl+x" });
  assert.deepEqual(manager.getConflicts(), [{ key: "ctrl+x", keybindings: ["first", "second"] }]);
  assert.equal(parseKey("ctrl+x"), undefined); // Input decoder, not a settings parser.
});
