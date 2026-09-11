import { mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import { afterAll, afterEach, beforeEach, vi } from "vitest";
import { assertTestTimeoutWithinCap } from "./test-timeout-policy.js";

const testRoot = process.env.PI_CODING_AGENT_DIR;
if (!testRoot) throw new Error("Vitest global setup did not provide PI_CODING_AGENT_DIR");
const testAgentDir = mkdtempSync(path.join(testRoot, "agent-"));
process.env.PI_CODING_AGENT_DIR = testAgentDir;

afterAll(() => {
  process.env.PI_CODING_AGENT_DIR = testRoot;
  rmSync(testAgentDir, { recursive: true, force: true });
});

beforeEach((context) => {
  assertTestTimeoutWithinCap(context.task.timeout, context.task.fullTestName);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});
