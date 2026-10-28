import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, test } from "vitest";
import type { Reporter, TestModule } from "vitest/node";
import TestTimingReporter from "./vitest.timing-reporter.js";

let root: string;
let reporter: TestTimingReporter;
let logs: string[];
let warnings: string[];
let reportPath: string;

beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), "pi-timing-reporter-"));
  mkdirSync(path.join(root, "scripts"));
  cpSync(
    path.resolve(import.meta.dirname, "../scripts/test-timing-report.mjs"),
    path.join(root, "scripts/test-timing-report.mjs"),
  );
  reportPath = path.join(root, "node_modules/.cache/pi-extensions-test-report.json");
  logs = [];
  warnings = [];
  reporter = new TestTimingReporter();
  reporter.onInit({
    config: { root },
    logger: { log: (message: string) => logs.push(message), warn: (message: string) => warnings.push(message) },
  } as unknown as Parameters<NonNullable<Reporter["onInit"]>>[0]);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function module(state = "passed", testState = "passed"): TestModule {
  return {
    moduleId: path.join(root, "packages/example/test/example.test.ts"),
    state: () => state,
    children: { allTests: () => [{ result: () => ({ state: testState }) }] },
    diagnostic: () => ({
      duration: 12.5,
      collectDuration: 25,
      setupDuration: 2,
      prepareDuration: 1,
      environmentSetupDuration: 0,
    }),
  } as unknown as TestModule;
}

test("reporter clears stale data and publishes only the current failed or interrupted run", async () => {
  mkdirSync(path.dirname(reportPath), { recursive: true });
  writeFileSync(reportPath, "stale");
  reporter.onTestRunStart();
  assert.equal(existsSync(reportPath), false);
  await reporter.onTestRunEnd([module("failed", "failed")], [], "failed");
  const first = JSON.parse(readFileSync(reportPath, "utf8"));
  assert.equal(first.reason, "failed");
  assert.equal(first.totals.tests.failed, 1);
  assert.equal(first.totals.testsAndHooksMs, 12.5);
  assert.ok(first.elapsedMs >= 0);
  reporter.onTestRunStart();
  await reporter.onTestRunEnd([module("queued", "pending")], [], "interrupted");
  const second = JSON.parse(readFileSync(reportPath, "utf8"));
  assert.equal(second.reason, "interrupted");
  assert.equal(second.files.length, 1);
  assert.equal(second.totals.tests.failed, 0);
  assert.equal(second.totals.tests.pending, 1);
  assert.ok(logs.length > 0);
  assert.deepEqual(warnings, []);
});

test("publication failure cannot replace the test process exit status", async () => {
  writeFileSync(path.join(root, "node_modules"), "not a directory");
  const previousExitCode = process.exitCode;
  try {
    process.exitCode = 23;
    reporter.onTestRunStart();
    await reporter.onTestRunEnd([module()], [], "failed");
    assert.equal(process.exitCode, 23);
    assert.equal(existsSync(reportPath), false);
    assert.ok(warnings.some((line) => line.includes("publication failed")));
  } finally {
    process.exitCode = previousExitCode;
  }
});

test("an end hook without a start records an unavailable interval rather than reusing a prior start", async () => {
  await reporter.onTestRunEnd([], [], "interrupted");
  assert.equal(JSON.parse(readFileSync(reportPath, "utf8")).elapsedMs, null);
});
