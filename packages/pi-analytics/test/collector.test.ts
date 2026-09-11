import assert from "node:assert/strict";
import { test } from "vitest";
import { ResponseCollector } from "../src/collector.js";
import { classifyProviderError } from "../src/errors.js";

const model = { provider: "openai", model: "gpt-test", thinkingLevel: "high" };

test("collector summarizes a settled tool loop without retaining content", () => {
  const collector = new ResponseCollector();
  collector.begin({ id: "run-1", now: 100, triggerSource: "interactive", model });
  collector.beginAttempt();
  collector.beginGeneration({ id: "gen-1", now: 110, model });
  collector.recordProviderResponse({ status: 200, now: 115 });
  collector.finishGeneration({ now: 120, stopReason: "toolUse" });
  collector.beginTool({ id: "call-1", name: "read", now: 121, model });
  collector.finishTool({ id: "call-1", now: 131, isError: false });
  collector.beginGeneration({ id: "gen-2", now: 140, model });
  collector.recordProviderResponse({ status: 200, now: 145 });
  collector.finishGeneration({ now: 150, stopReason: "stop" });

  const run = collector.settle(160);
  assert.ok(run);
  assert.equal(run.outcome, "success");
  assert.equal(run.attemptCount, 1);
  assert.equal(run.generations.length, 2);
  assert.equal(run.tools.length, 1);
  assert.equal(run.tools[0]?.durationMs, 10);
  assert.equal(run.providerErrorCount, 0);
  assert.doesNotMatch(JSON.stringify(run), /prompt|secret|arguments|result/i);
});

test("collector keeps parallel tools independent and interrupts unfinished work", () => {
  const collector = new ResponseCollector();
  collector.begin({ id: "run-2", now: 0, triggerSource: "rpc", model });
  collector.beginAttempt();
  collector.beginGeneration({ id: "gen-1", now: 1, model });
  collector.finishGeneration({ now: 2, stopReason: "toolUse" });
  collector.beginTool({ id: "a", name: "bash", now: 3, model });
  collector.beginTool({ id: "b", name: "read", now: 4, model });
  collector.finishTool({ id: "b", now: 6, isError: true });

  const run = collector.interrupt(10);
  assert.ok(run);
  assert.equal(run.outcome, "interrupted");
  assert.deepEqual(
    run.tools.map(({ name, completionState, isError }) => ({ name, completionState, isError })),
    [
      { name: "bash", completionState: "interrupted", isError: false },
      { name: "read", completionState: "finished", isError: true },
    ],
  );
  assert.equal(run.toolErrorCount, 1);
});

test("collector records recovered HTTP and generation failures conservatively", () => {
  const collector = new ResponseCollector();
  collector.begin({ id: "run-3", now: 0, triggerSource: "interactive", model });
  collector.beginAttempt();
  collector.beginGeneration({ id: "gen-1", now: 1, model });
  collector.recordProviderResponse({ status: 429, now: 2 });
  collector.recordProviderResponse({ status: 200, now: 3 });
  collector.finishGeneration({
    now: 4,
    stopReason: "error",
    errorMessage: "connect ETIMEDOUT https://secret.example/token",
  });
  collector.beginAttempt();
  collector.beginGeneration({ id: "gen-2", now: 5, model });
  collector.recordProviderResponse({ status: 200, now: 6 });
  collector.finishGeneration({ now: 7, stopReason: "stop" });

  const run = collector.settle(8);
  assert.ok(run);
  assert.equal(run.outcome, "recovered_success");
  assert.equal(run.providerErrorCount, 2);
  assert.equal(run.recoveredErrorCount, 2);
  assert.equal(run.providerErrors[0]?.category, "timeout");
  assert.equal(run.providerErrors[0]?.recovered, true);
  assert.doesNotMatch(JSON.stringify(run), /secret\.example|token/);
});

test("skill activation is deduplicated and explicit user use takes precedence", () => {
  const collector = new ResponseCollector();
  collector.begin({ id: "run-4", now: 0, triggerSource: "interactive", model });
  collector.activateSkill({ name: "reviewing-code", initiatedBy: "model", now: 1, model });
  collector.activateSkill({ name: "reviewing-code", initiatedBy: "model", now: 2, model });
  collector.activateSkill({ name: "reviewing-code", initiatedBy: "user", now: 3, model });
  collector.activateSkill({ name: "applying-tdd", initiatedBy: "model", now: 4, model });

  const run = collector.settle(5);
  assert.ok(run);
  assert.deepEqual(
    run.skills.map(({ name, initiatedBy }) => ({ name, initiatedBy })),
    [
      { name: "reviewing-code", initiatedBy: "user" },
      { name: "applying-tdd", initiatedBy: "model" },
    ],
  );
});

test("collector ignores duplicate or out-of-run events", () => {
  const collector = new ResponseCollector();
  assert.equal(collector.settle(1), undefined);
  collector.begin({ id: "run-5", now: 2, triggerSource: "unknown", model: undefined });
  collector.beginGeneration({ id: "same", now: 3, model });
  collector.beginGeneration({ id: "same", now: 4, model });
  collector.beginTool({ id: "same", name: "read", now: 5, model });
  collector.beginTool({ id: "same", name: "read", now: 6, model });
  const run = collector.settle(7);
  assert.equal(run?.generations.length, 1);
  assert.equal(run?.tools.length, 1);
});

test("provider errors are classified without preserving their messages", () => {
  assert.equal(classifyProviderError("getaddrinfo ENOTFOUND api.example.com"), "dns");
  assert.equal(classifyProviderError("connect ECONNREFUSED 127.0.0.1"), "connection_refused");
  assert.equal(classifyProviderError("socket ECONNRESET"), "connection_reset");
  assert.equal(classifyProviderError("certificate verify failed"), "tls");
  assert.equal(classifyProviderError("fetch failed"), "network_other");
  assert.equal(classifyProviderError("invalid API response"), "provider_other");
});
