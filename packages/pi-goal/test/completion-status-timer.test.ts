import assert from "node:assert/strict";
import { test, vi } from "vitest";
import { createMockContext, createMockPi } from "../../../test/support.js";
import { GoalRuntime } from "../src/runtime.js";

test("completion status uses unreferenced Node timers and retains replacement and cleanup", () => {
  const state = new GoalRuntime(createMockPi().pi);
  const context = createMockContext();
  const clear = vi.spyOn(globalThis, "clearTimeout");
  try {
    state.showCompletionStatus(context.ctx);
    const first = state.completionStatusTimer;
    assert.ok(first);
    assert.equal(first.hasRef(), false);
    assert.equal(context.statuses.get("goal"), "complete");

    state.showCompletionStatus(context.ctx);
    const second = state.completionStatusTimer;
    assert.ok(second);
    assert.notEqual(second, first);
    assert.equal(second.hasRef(), false);
    assert.ok(clear.mock.calls.some(([handle]) => handle === first));

    state.clearCompletionStatusTimer();
    state.clearCompletionStatusTimer();
    assert.equal(state.completionStatusTimer, undefined);
    assert.equal(clear.mock.calls.filter(([handle]) => handle === second).length, 1);
  } finally {
    state.clearCompletionStatusTimer();
    clear.mockRestore();
  }
});
