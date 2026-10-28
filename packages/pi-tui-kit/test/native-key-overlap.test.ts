import assert from "node:assert/strict";
import {
  isKittyProtocolActive,
  type KeybindingsConfig,
  type KeyId,
  matchesKey,
  setKittyProtocolActive,
} from "@earendil-works/pi-tui";
import { test } from "vitest";
import { plainTuiText } from "../../../test/tui-text.js";
import { canonicalKeyId, keysOverlap } from "../src/components/key-matching.js";
import { canonicalizeConfiguredKey } from "../src/key-matching.js";
import { runThinkingSelector } from "../src/pi-selectors.js";
import { createRendererHost } from "./fixtures/renderer-host.js";
import { rendererTheme } from "./fixtures/renderer-theme.js";

const invalidKeys = [
  "ctrl+ctrl+x",
  "shift+ctrl+shift+x",
  "alt+alt+x",
  "super+super+x",
  "unknown+ctrl+x",
  "ctrl+unknown+x",
  "+ctrl+x",
  "ctrl++x",
  "ctrl+x+",
  "ctrl+",
  "ctrl+++",
  "ctrl+ x",
  " ctrl+x",
  "ctrl+x ",
  "ctrl+\x1b[31mx",
  "ctrl+escape",
  "alt+f1",
  "super+clear",
  "shift+ctrl+clear",
];

for (const key of invalidKeys) {
  test(`native invalid host binding ${JSON.stringify(key)} does not remove a valid selector action`, async (t) => {
    assert.equal(canonicalKeyId(key), undefined);
    assert.equal(matchesKey("\x1b[120;5u", key as KeyId), false);
    const fixture = createRendererHost("fullscreen", rendererTheme(), {
      kitty: true,
      bindings: { "tui.altScreen.lineUp": key, "app.thinking.save": "ctrl+x" } as KeybindingsConfig,
    });
    t.onTestFinished(() => fixture.stop());
    const running = runThinkingSelector(fixture.ctx, { availableLevels: ["off"], currentLevel: "off" });
    await fixture.waitForOpen();
    assert.match(plainTuiText(fixture.frame().join("\n")), /ctrl\+x set as default/u);
    const inputs: string[] = [];
    const handleInput = fixture.component.handleInput?.bind(fixture.component);
    fixture.component.handleInput = (data) => {
      inputs.push(data);
      handleInput?.(data);
    };
    fixture.send("\x1b[120;5u");
    assert.deepEqual(inputs, ["\x1b[120;5u"]);
    assert.deepEqual(await running, { kind: "saveDefault", level: "off" });
  });
}

test("canonical grammar preserves native aliases, modifier permutations, and literal plus", () => {
  for (const [key, canonical, input] of [
    ["+", "+", "+"],
    ["ctrl++", "ctrl++", "\x1b[43;5u"],
    ["SuPeR+AlT+CtRl+ShIfT++", "shift+ctrl+alt+super++", "\x1b[43;16u"],
    ["alt+ctrl+X", "ctrl+alt+x", "\x1b[120;7u"],
    ["EsC", "escape", "\x1b"],
    ["Return", "enter", "\r"],
    ["PAGEUP", "pageup", "\x1b[5~"],
    ["shift+clear", "shift+clear", "\x1b[e"],
    ["ctrl+clear", "ctrl+clear", "\x1bOe"],
    ["f12", "f12", "\x1b[24~"],
  ] as const) {
    assert.equal(canonicalKeyId(key), canonical);
    assert.equal(canonicalizeConfiguredKey(key)?.toLowerCase(), canonical);
    assert.equal(matchesKey(input, key as KeyId), true, key);
    assert.equal(matchesKey(input, canonical as KeyId), true, canonical);
  }
});

// A public overlap API is deferred: arbitrary matcher-accepted alternate fields
// are not an oracle for terminal-generated input. Preserve the narrower private
// component probes rather than reserve every Ctrl action behind Ctrl+Up.
test("native functional alternate acceptance does not define terminal collisions", () => {
  for (const [other, codepoint] of [
    ["ctrl+x", 120],
    ["ctrl+space", 32],
    ["ctrl+backspace", 127],
  ] as const) {
    const input = `\x1b[57419::${codepoint};5u`;
    assert.equal(matchesKey(input, "ctrl+up"), true);
    assert.equal(matchesKey(input, other), true);
    for (const enhanced of [false, true]) {
      assert.equal(keysOverlap("ctrl+up", other, enhanced), false);
      assert.equal(keysOverlap(other, "ctrl+up", enhanced), false);
    }
  }
});

test("Kitty mode still accepts raw Ctrl aliases excluded by private enhanced hint policy", () => {
  const previous = isKittyProtocolActive();
  setKittyProtocolActive(true);
  try {
    for (const [input, first, second] of [
      ["\t", "tab", "ctrl+i"],
      ["\r", "enter", "ctrl+m"],
      ["\x1b", "escape", "ctrl+["],
      ["\x1f", "ctrl+-", "ctrl+_"],
    ] as const) {
      assert.equal(matchesKey(input, first), true);
      assert.equal(matchesKey(input, second), true);
      assert.equal(keysOverlap(first, second, false), true);
      assert.equal(keysOverlap(first, second, true), false);
    }
  } finally {
    setKittyProtocolActive(previous);
  }
});

// Cover every symbol accepted by Kitty's logical alternate branch, not only US
// physical/shifted pairs. modifyOtherKeys consumes Shift only for shifted symbols.
test("enhanced overlap covers all native logical-symbol and modifier classes symmetrically", () => {
  const symbols = "`-=[]\\;',./!@#$%^&*()_+|~{}:<>?";
  const shiftedSymbols = "~!@#$%^&*()_+|{}:<>?";
  for (let mask = 0; mask < 16; mask += 2) {
    const prefix = [mask & 4 ? "ctrl" : "", mask & 2 ? "alt" : "", mask & 8 ? "super" : ""].filter(Boolean).join("+");
    const logical = (symbol: string) => (prefix ? `${prefix}+${symbol}` : symbol);
    for (const symbol of symbols) {
      const physical = prefix ? `shift+${prefix}+1` : "shift+1";
      const input = `\x1b[49:${symbol.charCodeAt(0)};${mask + 2}u`;
      assert.equal(matchesKey(input, physical as KeyId), true);
      assert.equal(matchesKey(input, logical(symbol) as KeyId), true);
      for (const enhanced of [false, true]) {
        assert.equal(keysOverlap(physical, logical(symbol), enhanced), true, `${physical}: ${symbol}`);
        assert.equal(keysOverlap(logical(symbol), physical, enhanced), true, `${symbol}: ${physical}`);
      }
      const shifted = `shift+${logical(symbol)}`;
      const modifyInput = `\x1b[27;${mask + 2};${symbol.charCodeAt(0)}~`;
      assert.equal(matchesKey(modifyInput, logical(symbol) as KeyId), shiftedSymbols.includes(symbol));
      if (shiftedSymbols.includes(symbol)) {
        assert.equal(keysOverlap(shifted, logical(symbol), true), true);
        assert.equal(keysOverlap(logical(symbol), shifted, true), true);
      }
    }
  }
});

for (const scenario of [
  { name: "Kitty physical digit / logical symbol", host: "!", save: "shift+1", input: "\x1b[49:33;2u" },
  { name: "Kitty logical symbol / physical digit", host: "shift+1", save: "!", input: "\x1b[49:33;2u" },
  { name: "Kitty Ctrl physical / logical plus", host: "ctrl++", save: "ctrl+shift+=", input: "\x1b[61:43;6u" },
  { name: "Kitty Super and Alt", host: "super+alt+?", save: "super+alt+shift+/", input: "\x1b[47:63;12u" },
  { name: "Kitty unshifted-symbol alternate", host: "/", save: "shift+1", input: "\x1b[49:47;2u" },
  { name: "Kitty digit base-layout fallback", host: "ctrl+x", save: "ctrl+1", input: "\x1b[49::120;5u" },
  { name: "modifyOtherKeys logical symbol", host: "!", save: "shift+!", input: "\x1b[27;2;33~", modify: true },
  { name: "modifyOtherKeys physical symbol", host: "shift+!", save: "!", input: "\x1b[27;2;33~", modify: true },
  { name: "modifyOtherKeys Ctrl plus", host: "ctrl++", save: "ctrl+shift++", input: "\x1b[27;6;43~", modify: true },
]) {
  test(`native enhanced collision: ${scenario.name} hides the consumed key and keeps the fallback`, async (t) => {
    assert.equal(matchesKey(scenario.input, scenario.host as KeyId), true);
    assert.equal(matchesKey(scenario.input, scenario.save as KeyId), true);
    const fixture = createRendererHost("fullscreen", rendererTheme(), {
      kitty: !scenario.modify,
      bindings: {
        "tui.altScreen.lineUp": scenario.host,
        "app.thinking.save": [scenario.save, "ctrl+s"],
      } as KeybindingsConfig,
    });
    if (scenario.modify) Object.defineProperty(fixture.host.terminal, "modifyOtherKeysActive", { value: true });
    t.onTestFinished(() => fixture.stop());
    const running = runThinkingSelector(fixture.ctx, { availableLevels: ["off"], currentLevel: "off" });
    await fixture.waitForOpen();
    const text = plainTuiText(fixture.frame().join("\n"));
    assert.match(text, /ctrl\+s set as default/u);
    assert.ok(!text.includes(`${canonicalKeyId(scenario.save)} set as default`));
    const inputs: string[] = [];
    const handleInput = fixture.component.handleInput?.bind(fixture.component);
    fixture.component.handleInput = (data) => {
      inputs.push(data);
      handleInput?.(data);
    };
    const before = fixture.scroll.scrollTop;
    fixture.send(scenario.input);
    assert.ok(fixture.scroll.scrollTop < before);
    assert.deepEqual(inputs, []);
    fixture.send("\x1b[115;5u");
    assert.deepEqual(await running, { kind: "saveDefault", level: "off" });
  });
}

for (const scenario of [
  { host: "ctrl+y", save: "ctrl+x", input: "\x1b[120::121;5u" },
  { host: "ctrl+[", save: "ctrl+/", input: "\x1b[47::91;5u" },
  { host: "ctrl+x", save: "shift+ctrl+x", input: "\x1b[88;6u" },
  { host: "tab", save: "ctrl+i", input: "\x1b[105;5u" },
  { host: "ctrl+-", save: "ctrl+_", input: "\x1b[95;5u" },
  { host: "ctrl+x", save: "ctrl++", input: "\x1b[43;5u" },
]) {
  test(`native enhanced distinct keys ${scenario.host} / ${scenario.save} remain usable`, async (t) => {
    assert.equal(keysOverlap(scenario.host, scenario.save, true), false);
    const fixture = createRendererHost("fullscreen", rendererTheme(), {
      kitty: true,
      bindings: {
        "tui.altScreen.search": [],
        "tui.altScreen.lineUp": scenario.host,
        "app.thinking.save": scenario.save,
      } as KeybindingsConfig,
    });
    t.onTestFinished(() => fixture.stop());
    const running = runThinkingSelector(fixture.ctx, { availableLevels: ["off"], currentLevel: "off" });
    await fixture.waitForOpen();
    assert.ok(plainTuiText(fixture.frame().join("\n")).includes(`${canonicalKeyId(scenario.save)} set as default`));
    fixture.send(scenario.input);
    assert.deepEqual(await running, { kind: "saveDefault", level: "off" });
  });
}
