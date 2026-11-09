import assert from "node:assert/strict";
import { platform, release } from "node:os";
import { performance } from "node:perf_hooks";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { cumulativeAssistantTokens, currentTokenTotal } from "../src/accounting.ts";

// Run from the repository root: node packages/pi-goal/benchmark/token-accounting.mjs
// Synthetic metadata only; no provider requests, user sessions, persistence, or UI.
const samples = 250;

function assistant() {
  return {
    role: "assistant",
    content: [],
    api: "openai-responses",
    provider: "benchmark",
    model: "benchmark",
    stopReason: "stop",
    timestamp: 0,
    usage: {
      input: 100,
      output: 10,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 110,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  };
}

function measure(read, beforeEach = () => {}) {
  const times = [];
  for (let index = 0; index < samples; index++) {
    beforeEach();
    const start = performance.now();
    read();
    times.push(performance.now() - start);
  }
  times.sort((a, b) => a - b);
  return { medianMs: times[Math.floor(samples / 2)], p95Ms: times[Math.floor(samples * 0.95)] };
}

console.log(JSON.stringify({ node: process.version, os: `${platform()} ${release()}`, samples }));
for (const entries of [100, 10_000, 60_000]) {
  const sessionManager = SessionManager.inMemory();
  for (let index = 0; index < entries; index++) {
    if (index % 4 === 0) sessionManager.appendMessage(assistant());
    else sessionManager.appendCustomEntry("benchmark", {});
  }
  const ctx = { sessionManager };
  const recount = () => cumulativeAssistantTokens(sessionManager.getBranch());
  const incremental = () => currentTokenTotal(ctx);
  const start = performance.now();
  const first = incremental();
  const coldMs = performance.now() - start;
  assert.equal(first, recount());
  const fullRecount = measure(recount);
  const cachedRead = measure(incremental);
  const append = () => {
    sessionManager.appendMessage(assistant());
    sessionManager.appendCustomEntry("goal-state", {});
  };
  const fullRecountAfterAppend = measure(recount, append);
  assert.equal(incremental(), recount());
  const incrementalAfterAppend = measure(incremental, append);
  assert.equal(incremental(), recount());
  console.log(
    JSON.stringify({
      entries,
      coldMs,
      fullRecount,
      cachedRead,
      fullRecountAfterAppend,
      incrementalAfterAppend,
    }),
  );
}
