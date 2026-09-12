import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import { createMockContext, createMockPi } from "../../../test/support.js";

async function emit(
  events: ReadonlyMap<string, Array<(...args: unknown[]) => unknown>>,
  name: string,
  ...args: unknown[]
) {
  for (const handler of events.get(name) ?? []) await handler(...args);
}

test("declared generated entry preserves registration and partial lifecycle cleanup", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-firecrawl-generated-entry-"));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = join(root, "agent");
  try {
    const { default: extension } = await import("../dist/index.js");
    const mock = createMockPi();
    await extension(mock.pi);
    assert.ok(mock.commands.has("firecrawl"));
    assert.ok(mock.events.has("session_start"));
    assert.ok(mock.events.has("session_shutdown"));
    const context = createMockContext({ mode: "tui", cwd: root });
    await emit(mock.events, "session_shutdown", { reason: "quit" }, context.ctx);
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    rmSync(root, { force: true, recursive: true });
  }
});
