import assert from "node:assert/strict";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { currentTokenTotal } from "../src/accounting.ts";

// Run each sample in a fresh process: node --expose-gc .../cache-memory.mjs [entries] [tokensPerAssistant]
// Measures retained JS heap, not transient recount allocations or process RSS.
assert.equal(typeof global.gc, "function", "Run Node with --expose-gc");
const entries = Number(process.argv[2] ?? 60_000);
const tokensPerAssistant = Number(process.argv[3] ?? 110);
assert.ok(Number.isSafeInteger(entries) && entries > 0);
assert.ok(Number.isSafeInteger(tokensPerAssistant) && tokensPerAssistant > 0);

function collect() {
  for (let index = 0; index < 4; index++) global.gc();
}

function prepare(count) {
  const sessionManager = SessionManager.inMemory();
  for (let index = 0; index < count; index++) {
    if (index % 4 === 0) {
      sessionManager.appendMessage({
        role: "assistant",
        content: [],
        api: "openai-responses",
        provider: "benchmark",
        model: "benchmark",
        stopReason: "stop",
        timestamp: 0,
        usage: {
          input: tokensPerAssistant,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: tokensPerAssistant,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
      });
    } else sessionManager.appendCustomEntry("benchmark", {});
  }
  return { sessionManager };
}

function warm() {
  currentTokenTotal(prepare(1_000));
}

warm();
collect();
const ctx = prepare(entries);
collect();
const before = process.memoryUsage().heapUsed;
const total = currentTokenTotal(ctx);
collect();
const after = process.memoryUsage().heapUsed;
// Keep the manager live across both measurements, including its weakly owned checkpoint.
assert.equal(currentTokenTotal(ctx), total);
assert.equal(total, Math.ceil(entries / 4) * tokensPerAssistant);
console.log(
  JSON.stringify({
    node: process.version,
    entries,
    tokensPerAssistant,
    retainedBytes: after - before,
    retainedMiB: (after - before) / 1_048_576,
  }),
);
