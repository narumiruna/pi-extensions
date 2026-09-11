import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export default function setup(): () => void {
  const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
  const testRoot = mkdtempSync(path.join(os.tmpdir(), "pi-extensions-test-"));
  process.env.PI_CODING_AGENT_DIR = testRoot;

  return () => {
    if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
    rmSync(testRoot, { recursive: true, force: true });
  };
}
