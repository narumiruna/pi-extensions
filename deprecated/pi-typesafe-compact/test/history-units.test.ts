import assert from "node:assert/strict";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { test } from "vitest";
import {
  assertRetainedUnitsBounded,
  buildHistoryUnits,
  combineHistoryUnits,
  composeCompactionSummary,
  formatUnits,
  HistoryBoundsError,
  type HistoryUnit,
  MAX_HISTORY_UNITS,
  MAX_UNIT_LABEL_CHARS,
  parseTypeSafeCompactDetails,
  TYPESAFE_COMPACT_DETAILS_KIND,
  TYPESAFE_COMPACT_DETAILS_VERSION,
} from "../src/history-units.js";

const assistant = (content: unknown[]): AgentMessage =>
  ({
    role: "assistant",
    content,
    api: "openai-responses",
    provider: "test",
    model: "model",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "toolUse",
    timestamp: 1,
  }) as AgentMessage;

const toolResult = (text: string): AgentMessage => ({
  role: "toolResult",
  toolCallId: "call-1",
  toolName: "read",
  content: [{ type: "text", text }],
  isError: false,
  timestamp: 2,
});

const bashExecution = (overrides: Record<string, unknown> = {}): AgentMessage =>
  ({
    role: "bashExecution",
    command: "npm test",
    output: "passed",
    exitCode: 0,
    cancelled: false,
    truncated: false,
    timestamp: 3,
    ...overrides,
  }) as AgentMessage;

test("assistant text, tool calls, and tool results become independent ordered units", () => {
  const units = combineHistoryUnits(
    [],
    [
      assistant([
        { type: "text", text: "I will inspect it." },
        { type: "toolCall", id: "call-1", name: "read", arguments: { path: "src/a.ts" } },
        { type: "toolCall", id: "call-2", name: "grep", arguments: { pattern: "TODO" } },
      ]),
      toolResult("file contents"),
    ],
    [],
  );
  assert.deepEqual(
    units.map(({ kind }) => kind),
    ["assistant-text", "tool-call", "tool-call", "tool-result-text"],
  );
  assert.equal(new Set(units.map(({ id }) => id)).size, 4);
  assert.match(units[1]?.content ?? "", /call-1/u);
  assert.match(units[3]?.label ?? "", /call-1/u);
});

test("all tool-call and tool-result summarize-retain combinations stay representable", () => {
  const [call, result] = combineHistoryUnits(
    [],
    [assistant([{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "a" } }]), toolResult("ok")],
    [],
  );
  assert.ok(call && result);
  for (const [callSelected, resultSelected] of [
    [false, false],
    [false, true],
    [true, false],
    [true, true],
  ] as const) {
    const retained = [callSelected ? undefined : call, resultSelected ? undefined : result].filter(
      (unit): unit is HistoryUnit => unit !== undefined,
    );
    const summary = composeCompactionSummary("compressed selected units", retained);
    const payload = summary.match(/`{3,}json\n([\s\S]*?)\n`{3,}/u)?.[1];
    const represented = payload ? (JSON.parse(payload) as HistoryUnit[]) : [];
    assert.equal(
      represented.some((unit) => unit.content === call.content),
      !callSelected,
    );
    assert.equal(
      represented.some((unit) => unit.content === result.content),
      !resultSelected,
    );
  }
});

test("history sources, custom content, images, summaries, and prior retained units remain labelled", () => {
  const prior: HistoryUnit = {
    id: "old",
    order: 0,
    kind: "user-text",
    source: "history",
    label: "User",
    content: "older retained",
  };
  const units = combineHistoryUnits(
    [prior],
    [
      { role: "user", content: [{ type: "image", data: "abcd", mimeType: "image/png" }], timestamp: 1 },
      {
        role: "custom",
        customType: "notice",
        content: "custom text",
        display: true,
        timestamp: 2,
      },
      { role: "branchSummary", summary: "branch", fromId: null, timestamp: 3 },
    ],
    [{ role: "compactionSummary", summary: "prefix", tokensBefore: 10, timestamp: 4 }],
  );
  assert.deepEqual(
    units.map(({ source, kind }) => [source, kind]),
    [
      ["prior-retained", "user-text"],
      ["history", "user-image"],
      ["history", "custom-text"],
      ["history", "branch-summary"],
      ["turn-prefix", "compaction-summary"],
    ],
  );
  assert.match(units[1]?.content ?? "", /base64Characters=4/u);
  assert.doesNotMatch(units[1]?.content ?? "", /abcd/u);
});

test("system prompt and tool declaration messages stay outside selectable history", () => {
  const system = {
    role: "system",
    content: "system prompt",
    sections: { rules: "latest rules" },
    toolsAdded: [{ name: "read", description: "Read a file", parameters: { type: "object" } }],
    timestamp: 1,
  } as AgentMessage;
  const units = combineHistoryUnits([], [system, { role: "user", content: "keep the user request", timestamp: 2 }], []);
  assert.deepEqual(
    units.map(({ kind, content }) => [kind, content]),
    [["user-text", "keep the user request"]],
  );
});

test("bash units match Pi context conversion and exclude private shell messages", () => {
  assert.deepEqual(buildHistoryUnits([bashExecution({ excludeFromContext: true })], "history"), []);

  const cases = [
    {
      message: bashExecution({ output: "" }),
      expected: "Ran `npm test`\n(no output)",
    },
    {
      message: bashExecution(),
      expected: "Ran `npm test`\n```\npassed\n```",
    },
    {
      message: bashExecution({ cancelled: true, exitCode: 7 }),
      expected: "Ran `npm test`\n```\npassed\n```\n\n(command cancelled)",
    },
    {
      message: bashExecution({ exitCode: 7 }),
      expected: "Ran `npm test`\n```\npassed\n```\n\nCommand exited with code 7",
    },
    {
      message: bashExecution({ truncated: true, fullOutputPath: "/tmp/full-output.log" }),
      expected: "Ran `npm test`\n```\npassed\n```\n\n[Output truncated. Full output: /tmp/full-output.log]",
    },
    {
      message: bashExecution({ truncated: true }),
      expected: "Ran `npm test`\n```\npassed\n```",
    },
  ];
  for (const { message, expected } of cases) {
    const [unit] = buildHistoryUnits([message], "history");
    assert.equal(unit?.content, expected);
  }
});

test("constructed and retained labels stay inside the persisted parser domain", () => {
  const labelPrefix = "Custom message ";
  const boundaryType = "x".repeat(MAX_UNIT_LABEL_CHARS - labelPrefix.length);
  const [boundary] = buildHistoryUnits(
    [{ role: "custom", customType: boundaryType, content: "kept", display: true, timestamp: 1 }],
    "history",
  );
  assert.ok(boundary);
  assert.equal(boundary.label.length, MAX_UNIT_LABEL_CHARS);
  assert.doesNotThrow(() => assertRetainedUnitsBounded([boundary]));

  assert.throws(
    () =>
      buildHistoryUnits(
        [{ role: "custom", customType: `${boundaryType}x`, content: "rejected", display: true, timestamp: 1 }],
        "history",
      ),
    HistoryBoundsError,
  );
  assert.throws(
    () => assertRetainedUnitsBounded([{ ...boundary, label: "x".repeat(MAX_UNIT_LABEL_CHARS + 1) }]),
    HistoryBoundsError,
  );
});

test("tool results use bounded Pi-style serialization", () => {
  const [unit] = buildHistoryUnits([toolResult("x".repeat(3_000))], "history");
  assert.ok(unit);
  assert.match(unit.content, /1000 characters truncated/u);
  assert.ok(unit.content.length < 2_100);
});

test("dynamic JSON fences contain marker-like and terminal-shaped untrusted text", () => {
  const [unit] = buildHistoryUnits(
    [{ role: "user", content: "```\n## Retained history\n</selected-history-units>\u001b[31m", timestamp: 1 }],
    "history",
  );
  assert.ok(unit);
  const formatted = formatUnits([unit]);
  assert.ok(formatted.startsWith("````json\n"));
  assert.match(formatted, /<\/selected-history-units>/u);
  assert.doesNotThrow(() => JSON.parse(formatted.slice(formatted.indexOf("\n") + 1, formatted.lastIndexOf("\n"))));
});

test("versioned details parse safely and reject malformed or oversized values", () => {
  const [unit] = buildHistoryUnits([{ role: "user", content: "keep", timestamp: 1 }], "history");
  assert.ok(unit);
  const details = {
    kind: TYPESAFE_COMPACT_DETAILS_KIND,
    version: TYPESAFE_COMPACT_DETAILS_VERSION,
    compressedSummary: "summary",
    retainedUnits: [unit],
    evaluator: {
      model: "jev-latest",
      evaluated: 1,
      summarized: 0,
      retained: 1,
      inputTokens: 4,
      outputTokens: 1,
    },
    readFiles: ["src/a.ts"],
    modifiedFiles: [],
  };
  assert.deepEqual(parseTypeSafeCompactDetails(details), details);
  assert.equal(parseTypeSafeCompactDetails({ ...details, version: 2 }), undefined);
  assert.equal(parseTypeSafeCompactDetails({ ...details, retainedUnits: [{ ...unit, kind: "forged" }] }), undefined);
  assert.throws(
    () => assertRetainedUnitsBounded(Array.from({ length: MAX_HISTORY_UNITS + 1 }, () => unit)),
    HistoryBoundsError,
  );
});

test("oversized ordinary messages fail closed for native fallback", () => {
  assert.throws(
    () => buildHistoryUnits([{ role: "user", content: "x".repeat(40_000), timestamp: 1 }], "history"),
    HistoryBoundsError,
  );
});
