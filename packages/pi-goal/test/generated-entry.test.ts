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
  const root = mkdtempSync(join(tmpdir(), "pi-goal-generated-entry-"));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = join(root, "agent");
  try {
    const { default: extension } = await import("../dist/index.js");
    const mock = createMockPi();
    await extension(mock.pi);
    mock.rawPi.setActiveTools(["goal_complete", "goal_blocked", "goal_wait"]);
    assert.ok(mock.commands.has("goal"));
    assert.ok(mock.events.has("session_start"));
    assert.ok(mock.events.has("session_shutdown"));
    const sessionManager = {
      getSessionId: () => "generated-goal-session",
      getSessionName: () => undefined,
      getBranch: () => [],
      getEntries: () => [],
    };
    const context = createMockContext({
      mode: "tui",
      hasUI: true,
      cwd: root,
      sessionManager,
    });
    await emit(mock.events, "session_start", { reason: "startup" }, context.ctx);
    await mock.commands.get("goal")?.handler("generated goal", context.ctx);
    const activeAttempt = { session: sessionManager, group: "agent-workflow", busy: false };
    mock.eventBus.emit("workflow:mutex:v1", activeAttempt);
    assert.equal(activeAttempt.busy, true);

    await emit(mock.events, "session_shutdown", { reason: "quit" }, context.ctx);
    const releasedAttempt = { ...activeAttempt, busy: false };
    mock.eventBus.emit("workflow:mutex:v1", releasedAttempt);
    assert.equal(releasedAttempt.busy, false);
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    rmSync(root, { force: true, recursive: true });
  }
});
