import assert from "node:assert/strict";
import { isKittyProtocolActive, setKittyProtocolActive } from "@earendil-works/pi-tui";
import { test } from "vitest";
import { createInteractionContractMessage, INTERACTION_CONTRACT_MESSAGE_TYPE } from "../src/interaction-contract.js";
import {
  createInteractionCoordinator,
  createInteractionInputGuard,
  interactionShortcutAvailable,
} from "../src/interaction-coordinator.js";
import { createModeContractMessage } from "../src/mode-contract.js";
import { type PlanModeState, restorePlanModeState } from "../src/state.js";
import { createMockContext, createMockPi } from "./support.js";

function fixture(initial: PlanModeState = { enabled: true, awaitingAction: false, interactionMode: "discussion" }) {
  let state = initial;
  let writes = 0;
  let aborts = 0;
  let failWrites = 0;
  const mock = createMockPi();
  const context = createMockContext({
    mode: "tui",
    hasUI: true,
    abort: () => {
      aborts += 1;
    },
  });
  const coordinator = createInteractionCoordinator(mock.pi, {
    getState: () => state,
    setState: (next) => {
      state = next;
    },
    persistState: () => {
      writes += 1;
      if (failWrites-- > 0) throw new Error("disk failed");
    },
    captureCurrent: () => () => true,
    clearReadyIntent() {},
    resetFinalization() {},
    updateUi() {},
  });
  return {
    coordinator,
    mock,
    context,
    state: () => state,
    writes: () => writes,
    aborts: () => aborts,
    failWrites: (count: number) => {
      failWrites = count;
    },
  };
}

for (const kitty of [false, true]) {
  test(`fixed F2 respects actual native key matches (Kitty=${kitty})`, () => {
    const previous = isKittyProtocolActive();
    setKittyProtocolActive(kitty);
    try {
      for (const [keys, available] of [
        [[], true],
        ["f2", false],
        ["F2", false],
        [["f3", "f2"], false],
        ["shift+f2", true],
        ["ctrl+alt+f2", true],
        ["alt+ctrl+f2", true],
        ["enter", true],
        ["return", true],
        ["esc", true],
        ["nonsense", true],
        ["ctrl+ctrl+f2", true],
        [null, true],
        [7, true],
      ] as const) {
        assert.equal(interactionShortcutAvailable({ "tui.select.cancel": keys }), available, String(keys));
      }
      assert.equal(interactionShortcutAvailable({}, "f2"), false, "the existing Plan toggle takes priority");
      assert.equal(interactionShortcutAvailable({}, "ctrl+alt+p"), true);
    } finally {
      setKittyProtocolActive(previous);
    }
  });
}

test("raw input guard ignores releases, repeats, complete and fragmented pastes", () => {
  const guard = createInteractionInputGuard();
  assert.equal(guard("\u001bOQ"), true);
  assert.equal(guard("\u001b[12;1:2~"), false);
  assert.equal(guard("\u001b[12;1:3~"), false);
  assert.equal(guard("\u001b[200~hello\u001bOQ\u001b[201~"), false);
  assert.equal(guard("\u001b[20"), false);
  assert.equal(guard("0~draft"), false);
  assert.equal(guard("\u001bOQ"), false);
  assert.equal(guard("\u001b[201"), false);
  assert.equal(guard("~"), false);
  assert.equal(guard("\u001bOQ"), true);
});

test("restoration appends once and preserves every prior serialized message", () => {
  const f = fixture();
  const prefix = [
    createModeContractMessage("plan", 0),
    { role: "compactionSummary", summary: "Earlier planning" },
    { role: "user", content: "Continue" },
  ];
  const serialized = JSON.stringify(prefix);
  const first = f.coordinator.transformContext(prefix, f.context.ctx);
  assert.equal(JSON.stringify(first.slice(0, prefix.length)), serialized);
  assert.equal(first.length, prefix.length + 1);
  assert.equal(f.mock.sentMessages.length, 1);
  assert.equal((first.at(-1) as { customType: string }).customType, INTERACTION_CONTRACT_MESSAGE_TYPE);
  assert.deepEqual(f.mock.sentMessages[0]?.options, { triggerTurn: false });
  assert.deepEqual(f.coordinator.transformContext(structuredClone(prefix), f.context.ctx), first);
  assert.deepEqual(f.coordinator.transformContext(structuredClone(first), f.context.ctx), first);
  assert.equal(f.mock.sentMessages.length, 1);
});

test("deferred fallback publication stays at its first request boundary after newer output", () => {
  const f = fixture();
  const prefix = [createModeContractMessage("plan", 0), { role: "user", content: "Discuss" }];
  const first = f.coordinator.transformContext(prefix, f.context.ctx);
  const assistant = { role: "assistant", content: [{ type: "text", text: "Discussion" }] };
  const persisted = { ...(f.mock.sentMessages[0]?.message as object), role: "custom", timestamp: 125 };
  const physical = [...prefix, assistant, persisted];
  const next = f.coordinator.transformContext(physical, f.context.ctx);
  assert.deepEqual(next.slice(0, first.length), first);
  assert.deepEqual(next.at(-1), assistant);
  assert.equal(f.mock.sentMessages.length, 1);
  assert.deepEqual(f.coordinator.transformContext(structuredClone(physical), f.context.ctx), next);
  const reloaded = fixture();
  assert.deepEqual(reloaded.coordinator.transformContext(physical, reloaded.context.ctx), next);
  assert.equal(reloaded.mock.sentMessages.length, 0, "persisted metadata restores the boundary after reload");
});

test("immediate fallback publication is stable and ignores unrelated metadata", () => {
  const f = fixture();
  const prefix = [createModeContractMessage("plan", 0), { role: "user", content: "Discuss" }];
  const first = f.coordinator.transformContext(prefix, f.context.ctx);
  const persisted = { ...(f.mock.sentMessages[0]?.message as object), role: "custom", timestamp: 900 };
  assert.deepEqual(f.coordinator.transformContext([...prefix, persisted], f.context.ctx), first);
  assert.equal(f.mock.sentMessages.length, 1);
});

test("a changed compaction boundary gets one new fallback rather than a stale anchor", () => {
  const f = fixture();
  f.coordinator.transformContext([{ role: "user", content: "Before compaction" }], f.context.ctx);
  const compacted = [{ role: "compactionSummary", summary: "New summary" }];
  const next = f.coordinator.transformContext(compacted, f.context.ctx);
  assert.deepEqual(next.slice(0, 1), compacted);
  assert.equal(f.mock.sentMessages.length, 2);
  assert.deepEqual(f.coordinator.transformContext(compacted, f.context.ctx), next);
  assert.equal(f.mock.sentMessages.length, 2);
});

for (const published of [true, false]) {
  test(`restored contract prefixes survive toggle, exit, reload, and a new workflow (published=${published})`, () => {
    const f = fixture();
    if (!published) f.mock.rawPi.sendMessage = () => {};
    const prefix = [createModeContractMessage("plan", 0), { role: "user", content: "Before restoration" }];
    const first = f.coordinator.transformContext(prefix, f.context.ctx);
    const assistant = { role: "assistant", content: [{ type: "text", text: "First discussion" }] };
    const physical = [...prefix, assistant, ...(published ? [{ ...(first.at(-1) as object), timestamp: 100 }] : [])];
    const second = f.coordinator.transformContext(physical, f.context.ctx);
    assert.deepEqual(second.slice(0, first.length), first);
    assert.equal(f.coordinator.toggle(f.context.ctx), true);
    const afterToggle = [
      ...physical,
      ...(published ? [createInteractionContractMessage("questions", 200)] : []),
      { role: "user", content: "Next question turn" },
    ];
    const third = f.coordinator.transformContext(afterToggle, f.context.ctx);
    assert.deepEqual(third.slice(0, second.length), second);

    f.state().enabled = false;
    f.state().interactionMode = undefined;
    const restoredState = restorePlanModeState([{ type: "custom", customType: "state", data: f.state() }], "state");
    const reloaded = fixture(restoredState);
    const afterExit = [
      ...afterToggle,
      { role: "assistant", content: "Next answer" },
      createModeContractMessage("normal", 300),
    ];
    const fourth = reloaded.coordinator.transformContext(afterExit, reloaded.context.ctx);
    assert.deepEqual(fourth.slice(0, third.length), third);
    assert.equal(reloaded.mock.sentMessages.length, 0, "inactive restoration never starts publication or a turn");

    reloaded.state().enabled = true;
    reloaded.state().interactionMode = "questions";
    reloaded.coordinator.reset();
    const nextWorkflow = [
      ...afterExit,
      createModeContractMessage("plan", 400),
      createInteractionContractMessage("questions", 401),
      { role: "user", content: "A different plan" },
    ];
    const fifth = reloaded.coordinator.transformContext(nextWorkflow, reloaded.context.ctx);
    assert.deepEqual(fifth.slice(0, fourth.length), fourth);
    assert.equal(reloaded.mock.sentMessages.length, 0);
  });
}

test("inactive state does not inject an interaction contract", () => {
  const f = fixture({ enabled: false, awaitingAction: false });
  const messages = [{ role: "user", content: "Normal" }];
  assert.equal(f.coordinator.transformContext(messages, f.context.ctx), messages);
  assert.equal(f.mock.sentMessages.length, 0);
});

test("switch publication failure restores the previous state and contract without a turn", () => {
  const f = fixture();
  const sendMessage = f.mock.rawPi.sendMessage.bind(f.mock.rawPi);
  let attempts = 0;
  f.mock.rawPi.sendMessage = (message, options) => {
    if (++attempts === 1) throw new Error("publication failed");
    sendMessage(message, options);
  };
  assert.equal(f.coordinator.toggle(f.context.ctx), false);
  assert.equal(f.state().interactionMode, "discussion");
  assert.equal(f.writes(), 2);
  assert.match(JSON.stringify(f.mock.sentMessages.at(-1)), /DISCUSSION/);
  assert.equal(f.mock.sentUserMessages.length, 0);
  assert.equal(f.aborts(), 0);
});

test("failed rollback aborts and blocks questionnaires until the workflow is reset", () => {
  const f = fixture({ enabled: true, awaitingAction: false, interactionMode: "questions" });
  f.failWrites(2);
  assert.equal(f.coordinator.toggle(f.context.ctx), false);
  assert.equal(f.coordinator.questionsPaused(), true);
  assert.equal(f.aborts(), 1);
  assert.match(f.context.notifications.at(-1)?.message ?? "", /reload/);
  assert.equal(f.coordinator.toggle(f.context.ctx), false);
  f.coordinator.reset();
  assert.equal(f.coordinator.questionsPaused(), false);
  assert.equal(f.coordinator.toggle(f.context.ctx), true);
  assert.equal(f.state().interactionMode, "discussion");
});

test("lost asynchronous publication restores from durable state at the same boundary after reload", () => {
  const f = fixture();
  // Pi's void sendMessage returns before an asynchronous failure is reported.
  f.mock.rawPi.sendMessage = () => {};
  const prefix = [createModeContractMessage("plan", 0), { role: "user", content: "Discuss" }];
  const first = f.coordinator.transformContext(prefix, f.context.ctx);
  assert.equal(f.writes(), 1);
  const restored = restorePlanModeState(
    [{ type: "custom", customType: "plan-mode-state", data: f.state() }],
    "plan-mode-state",
  );
  const reloaded = fixture(restored);
  const assistant = { role: "assistant", content: [{ type: "text", text: "More discussion" }] };
  const second = reloaded.coordinator.transformContext([...prefix, assistant], reloaded.context.ctx);
  assert.deepEqual(second.slice(0, first.length), first);
  assert.deepEqual(second.at(-1), assistant);
  assert.equal(reloaded.writes(), 0);
  assert.equal(
    reloaded.mock.sentMessages.length,
    0,
    "ordinary turns do not retry a failed fire-and-forget publication",
  );
});

test("interaction history rejects malformed anchors and preserves valid records across mode boundaries", () => {
  const valid = { version: 1, mode: "discussion", boundary: { length: 3, hash: "a".repeat(64) } };
  for (const interactionFallback of [
    undefined,
    null,
    {},
    { ...valid, version: 2 },
    { ...valid, mode: "invalid" },
    { ...valid, boundary: { length: -1, hash: "a".repeat(64) } },
    { ...valid, boundary: { length: 0, hash: "invalid" } },
  ]) {
    const restored = restorePlanModeState(
      [
        {
          type: "custom",
          customType: "state",
          data: { enabled: true, interactionMode: "discussion", interactionRestorations: [interactionFallback] },
        },
      ],
      "state",
    );
    assert.equal(restored.interactionRestorations, undefined);
  }
  const restored = restorePlanModeState(
    [
      {
        type: "custom",
        customType: "state",
        data: { enabled: false, interactionRestorations: [valid] },
      },
    ],
    "state",
  );
  assert.deepEqual(restored.interactionRestorations, [valid]);
  assert.equal(restored.interactionMode, undefined);
});

test("a retained explicit interaction needs no restoration or republishing", () => {
  const f = fixture();
  const messages = [
    createModeContractMessage("plan", 0),
    createInteractionContractMessage("discussion", 1),
    { role: "user", content: "More" },
  ];
  assert.equal(f.coordinator.transformContext(messages, f.context.ctx), messages);
  assert.equal(f.mock.sentMessages.length, 0);
});
