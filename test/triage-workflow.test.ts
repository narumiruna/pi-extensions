import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "vitest";

const workflow = readFileSync(resolve(".github/workflows/triage.yml"), "utf8");

test("triage retains pending jobs while serializing OAuth credential access", () => {
  const concurrency = workflow.match(/^ {4}concurrency:\n(?: {6}[^\n]*\n)+/mu)?.[0];
  assert.ok(concurrency, "triage must use job-level concurrency");
  assert.match(concurrency, /^ {6}group: pi-oauth-auth-json$/mu);
  assert.match(concurrency, /^ {6}queue: max$/mu);
  assert.match(concurrency, /^ {6}cancel-in-progress: false$/mu);
  assert.match(workflow, /^ {4}environment: pi-oauth$/mu);
  assert.doesNotMatch(workflow, /^concurrency:/mu);
});
