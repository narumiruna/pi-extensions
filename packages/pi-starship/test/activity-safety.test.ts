import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import { test } from "vitest";
import { validateConfigDocument } from "../src/config.js";
import { renderStatusline } from "../src/modules/render.js";
import type { StarshipRuntimeSnapshot } from "../src/modules/types.js";
import { STARSHIP_PRESETS } from "../src/presets/catalog.js";

const TOOL_NAMES = [
  { name: "LF and CR", raw: "read\nFORGED\rROW", displayed: "read FORGED ROW" },
  { name: "CRLF", raw: "read\r\nFORGED", displayed: "read  FORGED" },
  {
    name: "Unicode line separators and tabs",
    raw: "re\tad\u0085next\u2028line\u2029end",
    displayed: "re ad next line end",
  },
  {
    name: "terminal sequences",
    raw: "\x1b[31mread\x1b[0m\x1b]52;c;payload\x07\x1bPprivate\x1b\\\u009d0;title\u009c",
    displayed: "read",
  },
  { name: "control characters", raw: "read\0\x07\b\x1f\x7f\u009fhidden\u009c", displayed: "read" },
  { name: "direction controls", raw: "read\u202eFOO\u2066bar\u2069", displayed: "readFOObar" },
  { name: "ordinary Unicode", raw: "re\u0301ad界👩‍💻", displayed: "re\u0301ad界👩‍💻" },
] as const;
const STATES = ["active", "completed"] as const;

function runtime(tool: string, state: (typeof STATES)[number]): StarshipRuntimeSnapshot {
  return {
    cwd: "/work/repo",
    thinkingLevel: "high",
    turnCount: 1,
    activeTools:
      state === "active"
        ? new Map([
            [tool, 2],
            ["other", 1],
          ])
        : new Map(),
    isStreaming: false,
    lastCompletedTool: state === "completed" ? tool : undefined,
    tokenTotals: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
    usingSubscription: false,
    gitBranch: null,
    extensionStatuses: new Map(),
    now: new Date(2026, 0, 2, 9, 5),
  };
}

const CUSTOM = validateConfigDocument(
  "/test/activity.toml",
  `format = "before\\n$activity\\nafter"
[activity]
format = "$tool|$text|$count"
symbol = "*"
style = ""
`,
);
assert.deepEqual(CUSTOM.diagnostics, []);

for (const state of STATES) {
  test.each(TOOL_NAMES)(`${state} tool: $name cannot add footer rows or controls`, ({ raw, displayed }) => {
    const snapshot = runtime(raw, state);
    const before = structuredClone(snapshot);
    const activity = state === "active" ? `* ${displayed}×2+1` : `* completed ${displayed}`;
    const expected = `${displayed}|${activity}|${state === "active" ? 2 : 0}`;
    for (const trueColor of [true, false]) {
      const rendered = renderStatusline(CUSTOM.config, snapshot, 160, trueColor);
      assert.equal(rendered.modules.activity.map((chunk) => chunk.text).join(""), expected);
      assert.deepEqual(stripVTControlCharacters(rendered.ansi).split("\n"), ["before", expected, "after"]);
      assert.deepEqual(snapshot, before, "display sanitization must not change raw tool identities");
    }
  });
}

for (const preset of STARSHIP_PRESETS) {
  test.each(STATES)(`${preset.id}: %s tool names preserve document-owned row structure`, (state) => {
    const loaded = validateConfigDocument(`/presets/${preset.id}.toml`, preset.rawDocument);
    assert.deepEqual(loaded.diagnostics, []);
    const baseline = runtime("read FORGED ROW", state);
    const hostile = runtime("read\nFORGED\rROW", state);
    const before = structuredClone(hostile);
    for (const trueColor of [true, false]) {
      const expected = renderStatusline(loaded.config, baseline, 160, trueColor);
      const actual = renderStatusline(loaded.config, hostile, 160, trueColor);
      assert.equal(actual.ansi, expected.ansi, "only the displayed name must change");
      assert.deepEqual(hostile, before);
    }
  });
}
