import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { test } from "vitest";

interface BenchmarkWorkerResult {
  firstFrameMs?: number;
  highlightJsLoaded: boolean;
  packageUrls: string[];
  scenario: string;
  syntaxHighlighted: boolean;
}

const benchmarkScript = path.resolve("scripts/benchmark-tui-kit-runtime.mjs");

test("fresh Kit processes load syntax highlighting only for code review", () => {
  const rootImport = runWorker("import");
  const actions = runWorker("actions");
  const review = runWorker("review");

  assert.equal(rootImport.highlightJsLoaded, false);
  assert.equal(kitHighlighterLoaded(rootImport), false);
  assert.equal(actions.highlightJsLoaded, false);
  assert.equal(actions.syntaxHighlighted, false);
  assert.equal(kitHighlighterLoaded(actions), false);
  assert.equal(typeof actions.firstFrameMs, "number");
  assert.equal(review.highlightJsLoaded, true);
  assert.equal(review.syntaxHighlighted, true);
  assert.equal(kitHighlighterLoaded(review), true);
  assert.equal(typeof review.firstFrameMs, "number");
});

function runWorker(scenario: "actions" | "import" | "review"): BenchmarkWorkerResult {
  return JSON.parse(
    execFileSync(process.execPath, [benchmarkScript, "--worker", scenario], {
      encoding: "utf8",
    }),
  ) as BenchmarkWorkerResult;
}

function kitHighlighterLoaded(result: BenchmarkWorkerResult): boolean {
  return result.packageUrls.some((url) => url.includes("/pi-tui-kit/node_modules/highlight.js/"));
}
