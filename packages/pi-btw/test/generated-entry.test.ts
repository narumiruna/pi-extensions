import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import { createMockPi } from "../../../test/support.js";

test("declared generated entry preserves registration and partial lifecycle cleanup", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-btw-generated-entry-"));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = join(root, "agent");
  try {
    const { default: extension } = await import("../dist/index.js");
    const mock = createMockPi();
    await extension(mock.pi);
    assert.ok(mock.commands.has("btw"));
    assert.equal(mock.events.has("session_shutdown"), false);
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    rmSync(root, { force: true, recursive: true });
  }
});
