import assert from "node:assert/strict";
import { test } from "vitest";
import { decodeStoredRun, encodeStoredRun, MAX_STORED_RUN_BYTES } from "../src/storage/format.js";
import type { SettledRun } from "../src/types.js";

function run(overrides: Partial<SettledRun> = {}): SettledRun {
  return {
    id: "run-1",
    startedAtMs: 1,
    finishedAtMs: 5,
    durationMs: 4,
    triggerSource: "interactive",
    initialProvider: "openai",
    initialModel: "gpt-test",
    outcome: "success",
    attemptCount: 1,
    generations: [
      {
        id: "generation-1",
        ordinal: 0,
        provider: "openai",
        model: "gpt-test",
        thinkingLevel: "high",
        startedAtMs: 1,
        finishedAtMs: 3,
        durationMs: 2,
        stopReason: "stop",
        outcome: "stop",
        responses: [{ ordinal: 0, occurredAtMs: 2, status: 200 }],
      },
    ],
    tools: [
      {
        id: "provider-call-private-123",
        ordinal: 0,
        name: "read",
        startedAtMs: 3,
        finishedAtMs: 4,
        durationMs: 1,
        isError: false,
        completionState: "finished",
      },
    ],
    skills: [
      {
        id: "skill-1",
        name: "reviewing-code",
        initiatedBy: "model",
        occurredAtMs: 3,
      },
    ],
    providerErrors: [],
    toolErrorCount: 0,
    providerErrorCount: 0,
    recoveredErrorCount: 0,
    ...overrides,
  };
}

test("stored runs round-trip through one versioned newline-terminated frame", () => {
  const input = run();
  const expected = { ...input, tools: input.tools.map((tool) => ({ ...tool, id: "tool-0" })) };
  const encoded = encodeStoredRun(input);
  assert.ok(encoded.endsWith("\n"));
  assert.doesNotMatch(encoded, /provider-call-private-123/);
  assert.deepEqual(decodeStoredRun(encoded.trimEnd()), expected);
});

test("encoding strips unknown fields instead of persisting accidental content", () => {
  const input = Object.assign(run(), { prompt: "private prompt", rawError: "secret" });
  const encoded = encodeStoredRun(input);
  assert.doesNotMatch(encoded, /private prompt|secret|provider-call-private-123/);
  assert.deepEqual(decodeStoredRun(encoded.trimEnd()), {
    ...run(),
    tools: run().tools.map((tool) => ({ ...tool, id: "tool-0" })),
  });
});

test("stored frames reject fractional, unsafe, and aggregate-overflow numeric fields", () => {
  const envelope = JSON.parse(encodeStoredRun(run())) as { run: Record<string, unknown> };
  for (const [field, value] of [
    ["startedAtMs", 1.5],
    ["durationMs", Number.MAX_SAFE_INTEGER],
    ["toolErrorCount", 20_001],
  ] as const) {
    const changed = { ...envelope, run: { ...envelope.run, [field]: value } };
    assert.throws(() => decodeStoredRun(JSON.stringify(changed)), /invalid/i);
  }
});

test("stored frames reject unsupported versions, malformed fields, and oversized input", () => {
  assert.throws(() => decodeStoredRun('{"formatVersion":2,"run":{}}'), /version/i);
  assert.throws(() => decodeStoredRun('{"formatVersion":1,"run":{"id":"only"}}'), /invalid/i);
  assert.throws(() => decodeStoredRun("x".repeat(MAX_STORED_RUN_BYTES + 1)), /too large/i);
  assert.throws(
    () =>
      encodeStoredRun(
        run({
          tools: Array.from({ length: 20_000 }, (_, index) => ({
            id: `tool-${index}`,
            ordinal: index,
            name: "read",
            startedAtMs: index,
            isError: false,
            completionState: "finished" as const,
          })),
        }),
      ),
    /too large/i,
  );
});
