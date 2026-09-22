import assert from "node:assert/strict";
import { test } from "vitest";
import { createMockPi } from "../../../test/support.js";
import { registerBtwMainThreadUpdates } from "../src/main-thread-updates.js";

const MAIN_THREAD_UPDATE_EVENTS = [
  "session_info_changed",
  "session_compact",
  "session_tree",
  "agent_start",
  "agent_end",
  "agent_settled",
  "turn_start",
  "turn_end",
  "message_start",
  "message_update",
  "message_end",
  "tool_execution_start",
  "tool_execution_update",
  "tool_execution_end",
  "model_select",
  "thinking_level_select",
] as const;

test("main-thread updates refresh only the active session subscription and unsubscribe cleanly", () => {
  const mock = createMockPi();
  const subscribe = registerBtwMainThreadUpdates(mock.pi);
  const activeSession = {} as never;
  const otherSession = {} as never;
  let updates = 0;
  const unsubscribe = subscribe(activeSession, () => {
    updates += 1;
  });

  for (const event of MAIN_THREAD_UPDATE_EVENTS) {
    const handlers = mock.events.get(event) ?? [];
    assert.equal(handlers.length, 1, `${event} should have one refresh handler`);
    handlers[0]?.({}, { sessionManager: otherSession });
    handlers[0]?.({}, { sessionManager: activeSession });
  }
  assert.equal(updates, MAIN_THREAD_UPDATE_EVENTS.length);

  unsubscribe();
  mock.events.get("message_update")?.[0]?.({}, { sessionManager: activeSession });
  assert.equal(updates, MAIN_THREAD_UPDATE_EVENTS.length);
});
