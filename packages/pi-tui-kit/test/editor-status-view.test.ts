import assert from "node:assert/strict";
import { test } from "vitest";
import { createEditorStatusView, type EditorStatusMode, type EditorStatusTrigger } from "../src/editor-status-view.js";

function harness() {
  let allowed = true;
  let changes = 0;
  const view = createEditorStatusView({
    canCompact: () => allowed,
    onChange: () => changes++,
  });
  return {
    view,
    allow(value: boolean) {
      allowed = value;
    },
    get changes() {
      return changes;
    },
  };
}

function cycle(view: ReturnType<typeof createEditorStatusView>, eligible = true, messages = 1) {
  view.agentStarted();
  for (let i = 0; i < messages; i++) view.userMessage();
  view.settled(eligible);
}

const modes: EditorStatusMode[] = ["default", "expanded", "compact", "hidden"];
const triggers: EditorStatusTrigger[] = ["manual", "user-message", "settled-cycle"];

for (const mode of modes) {
  for (const pinned of [false, true]) {
    for (const allowed of [false, true]) {
      for (const trigger of triggers) {
        test(`automatic matrix: ${mode}, pinned=${pinned}, allowed=${allowed}, ${trigger}`, () => {
          const h = harness();
          h.view.setMode(mode);
          h.view.setPinned(pinned);
          h.allow(allowed);
          h.view.setTrigger(trigger);
          const before = h.changes;
          cycle(h.view);
          const compacts = trigger !== "manual" && mode !== "hidden" && !pinned && allowed;
          assert.equal(h.view.mode, compacts ? "compact" : mode);
          assert.equal(h.view.trigger, compacts ? "manual" : trigger);
          assert.equal(h.changes - before, compacts ? 1 : 0);
        });
      }
    }
  }
}

for (const from of modes) {
  for (const to of modes) {
    test(`manual mode transition ${from} to ${to}`, () => {
      const h = harness();
      h.view.setMode(from);
      const before = h.changes;
      h.view.setMode(to);
      assert.equal(h.view.mode, to);
      assert.equal(h.view.pinned, false);
      assert.equal(h.view.trigger, "manual");
      assert.equal(h.changes - before, from === to ? 0 : 1);
    });
  }
}

test("defaults and unchanged selections do not publish changes", () => {
  const h = harness();
  assert.equal(h.view.mode, "default");
  assert.equal(h.view.pinned, false);
  assert.equal(h.view.trigger, "manual");
  h.view.setMode("default");
  h.view.setPinned(false);
  h.view.setTrigger("manual");
  h.view.revision("initial");
  h.view.revision("initial");
  h.view.reset();
  assert.equal(h.changes, 0);
});

test("manual view selection cancels an armed rule, including an unchanged mode", () => {
  const h = harness();
  h.view.setTrigger("settled-cycle");
  h.view.setMode("default");
  assert.equal(h.view.trigger, "manual");
  cycle(h.view);
  assert.equal(h.view.mode, "default");
  assert.equal(h.changes, 2);
});

test("pin affects automatic reductions only; manual compact remains available", () => {
  const h = harness();
  h.view.setPinned(true);
  h.allow(false);
  h.view.setMode("compact");
  assert.equal(h.view.mode, "compact");
  assert.equal(h.view.pinned, true);
});

test("message rule ignores earlier consumed activity and fires once on the next consumed message", () => {
  const h = harness();
  h.view.userMessage();
  h.view.setTrigger("user-message");
  assert.equal(h.view.mode, "default");
  h.view.agentStarted();
  assert.equal(h.view.mode, "default");
  h.view.userMessage();
  assert.equal(h.view.mode, "compact");
  assert.equal(h.view.trigger, "manual");
  const changes = h.changes;
  h.view.userMessage();
  h.view.settled(true);
  cycle(h.view);
  assert.equal(h.changes, changes);
});

test("switching to manual cancels without changing the view", () => {
  const h = harness();
  h.view.setTrigger("user-message");
  h.view.setTrigger("manual");
  h.view.userMessage();
  assert.equal(h.view.mode, "default");
});

test("selecting or reselecting a settled rule never consumes the current cycle", () => {
  const h = harness();
  h.view.agentStarted();
  h.view.userMessage();
  h.view.setTrigger("settled-cycle");
  h.view.userMessage();
  h.view.agentStarted();
  h.view.settled(true);
  assert.equal(h.view.mode, "default");
  assert.equal(h.view.trigger, "settled-cycle");
  h.view.agentStarted();
  h.view.userMessage();
  h.view.setTrigger("settled-cycle");
  h.view.settled(true);
  assert.equal(h.view.mode, "compact");
});

test("queued consumed messages and retry starts remain one cycle until settlement", () => {
  const h = harness();
  h.view.setTrigger("settled-cycle");
  h.view.agentStarted();
  h.view.userMessage();
  h.view.agentStarted();
  h.view.userMessage();
  h.view.agentStarted();
  assert.equal(h.view.mode, "default");
  assert.equal(h.changes, 1);
  h.view.settled(true);
  assert.equal(h.view.mode, "compact");
  assert.equal(h.changes, 2);
  h.view.settled(true);
  assert.equal(h.changes, 2);
});

test("settlement without a started cycle or later user activity cannot compact", () => {
  const h = harness();
  h.view.userMessage();
  h.view.setTrigger("settled-cycle");
  h.view.settled(true);
  cycle(h.view, true, 0);
  assert.equal(h.view.mode, "default");
  assert.equal(h.view.trigger, "settled-cycle");
  cycle(h.view);
  assert.equal(h.view.mode, "compact");
});

for (const reason of ["error", "abort", "protected outcome"]) {
  test(`owner-ineligible ${reason} leaves the rule armed for a later user cycle`, () => {
    const h = harness();
    h.view.setTrigger("settled-cycle");
    cycle(h.view, false);
    assert.equal(h.view.mode, "default");
    assert.equal(h.view.trigger, "settled-cycle");
    cycle(h.view, true, 0);
    assert.equal(h.view.mode, "default");
    cycle(h.view);
    assert.equal(h.view.mode, "compact");
  });
}

test("eligibility is owner-supplied; an eligible outcome can compact without success inference", () => {
  const h = harness();
  h.view.setTrigger("settled-cycle");
  cycle(h.view, true);
  assert.equal(h.view.mode, "compact");
});

for (const trigger of ["user-message", "settled-cycle"] as const) {
  for (const guard of ["pin", "owner"] as const) {
    test(`${trigger} remains armed behind ${guard} and needs a later event after release`, () => {
      const h = harness();
      h.view.setTrigger(trigger);
      if (guard === "pin") h.view.setPinned(true);
      else h.allow(false);
      cycle(h.view);
      assert.equal(h.view.trigger, trigger);
      assert.equal(h.view.mode, "default");
      if (guard === "pin") h.view.setPinned(false);
      else h.allow(true);
      assert.equal(h.view.mode, "default");
      cycle(h.view);
      assert.equal(h.view.mode, "compact");
      assert.equal(h.view.trigger, "manual");
    });
  }
}

test("a meaningful revision excludes its current cycle and rearms against current positions", () => {
  const h = harness();
  h.view.revision("one");
  h.view.setTrigger("settled-cycle");
  h.view.agentStarted();
  h.view.userMessage();
  h.view.revision("two");
  h.view.userMessage();
  h.view.settled(true);
  assert.equal(h.view.mode, "default");
  cycle(h.view, true, 0);
  assert.equal(h.view.mode, "default");
  cycle(h.view);
  assert.equal(h.view.mode, "compact");
});

test("identical revisions and cosmetic refreshes do not renew a rule", () => {
  const h = harness();
  h.view.revision("one");
  h.view.setTrigger("settled-cycle");
  h.view.agentStarted();
  h.view.userMessage();
  h.view.revision("one");
  h.view.settled(true);
  assert.equal(h.view.mode, "compact");
  assert.equal(h.changes, 2);
  h.view.revision("two");
  cycle(h.view);
  assert.equal(h.view.trigger, "manual");
  assert.equal(h.changes, 2);
});

test("message revision rearms without consuming the current position", () => {
  const h = harness();
  h.view.setPinned(true);
  h.view.setTrigger("user-message");
  h.view.userMessage();
  h.view.revision("new");
  h.view.setPinned(false);
  assert.equal(h.view.mode, "default");
  h.view.userMessage();
  assert.equal(h.view.mode, "compact");
});

test("reset clears pin, mode, trigger, revision, and an in-progress cycle", () => {
  const h = harness();
  h.view.setMode("hidden");
  h.view.setPinned(true);
  h.view.revision("one");
  h.view.setTrigger("settled-cycle");
  h.view.agentStarted();
  h.view.userMessage();
  h.view.reset();
  assert.equal(h.view.mode, "default");
  assert.equal(h.view.trigger, "manual");
  assert.equal(h.view.pinned, false);
  h.view.setTrigger("settled-cycle");
  h.view.settled(true);
  assert.equal(h.view.mode, "default");
  cycle(h.view);
  assert.equal(h.view.mode, "compact");
});

test("dispose is idempotent and rejects every future state action without callbacks", () => {
  const h = harness();
  h.view.setMode("expanded");
  h.view.setPinned(true);
  h.view.setTrigger("settled-cycle");
  h.view.agentStarted();
  h.view.userMessage();
  h.view.dispose();
  h.view.dispose();
  const before = h.changes;
  h.view.setMode("compact");
  h.view.setPinned(false);
  h.view.setTrigger("manual");
  h.view.revision("replacement");
  h.view.userMessage();
  h.view.agentStarted();
  h.view.settled(true);
  h.view.reset();
  assert.equal(h.view.mode, "expanded");
  assert.equal(h.view.pinned, true);
  assert.equal(h.view.trigger, "settled-cycle");
  assert.equal(h.changes, before);
});
