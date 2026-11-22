import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { convertToLlm } from "@earendil-works/pi-coding-agent";
import { isKittyProtocolActive, setKittyProtocolActive } from "@earendil-works/pi-tui";
import { test } from "vitest";
import { planFromDraftContextMessage } from "../src/draft-context.js";
import { createInteractionContractMessage, INTERACTION_CONTRACT_MESSAGE_TYPE } from "../src/interaction-contract.js";
import {
  createInteractionCoordinator,
  createInteractionInputGuard,
  interactionShortcutAvailable,
} from "../src/interaction-coordinator.js";
import { createModeContractMessage, MODE_CONTRACT_MESSAGE_TYPE } from "../src/mode-contract.js";
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

const legacyPlan = {
  ...createModeContractMessage("plan", 10),
  content: readFileSync(new URL("./fixtures/legacy-plan-contract.txt", import.meta.url), "utf8"),
  details: { version: 1, mode: "plan" },
};

function normalizedMessages(messages: unknown[]) {
  return convertToLlm(messages as Parameters<typeof convertToLlm>[0]).map(
    ({ timestamp: _timestamp, ...message }) => message,
  );
}

for (const publication of ["immediate", "deferred", "lost"] as const) {
  test(`upgrade appends both contracts once and retains their request boundary after reload (${publication})`, () => {
    const f = fixture();
    const user = { role: "user", content: "Continue planning", timestamp: 12 };
    const legacyInteraction = createInteractionContractMessage("discussion", 11, 1);
    const prefix = [legacyPlan, legacyInteraction, user];
    const first = f.coordinator.transformContext(prefix, f.context.ctx, "plan");
    const serialized = normalizedMessages(first);
    assert.deepEqual(first.slice(0, prefix.length), prefix);
    assert.deepEqual(serialized.slice(0, prefix.length), normalizedMessages(prefix));
    assert.equal(f.writes(), 1);
    assert.deepEqual(
      f.mock.sentMessages.map(({ message, options }) => [(message as { customType: string }).customType, options]),
      [
        [MODE_CONTRACT_MESSAGE_TYPE, { triggerTurn: false }],
        [INTERACTION_CONTRACT_MESSAGE_TYPE, { triggerTurn: false }],
      ],
    );
    const physicalContracts = f.mock.sentMessages.map(({ message }, index) => ({
      ...(message as object),
      role: "custom",
      timestamp: 32 + index,
    }));
    const answer = { role: "assistant", content: [{ type: "text", text: "The draft is ready to discuss." }] };
    const nextUser = { role: "user", content: "Next request", timestamp: 40 };
    const physical = [
      ...prefix,
      ...(publication === "immediate" ? physicalContracts : []),
      ...(publication === "deferred" ? [nextUser, ...physicalContracts] : [nextUser]),
    ];
    const state = restorePlanModeState([{ type: "custom", customType: "state", data: f.state() }], "state");
    const reloaded = fixture(state);
    const next = reloaded.coordinator.transformContext(physical, reloaded.context.ctx, "plan");
    assert.deepEqual(normalizedMessages(next).slice(0, first.length), serialized);
    assert.deepEqual(next.at(-1), nextUser);
    assert.equal(reloaded.mock.sentMessages.length, 0);
    assert.equal(reloaded.writes(), 0);
    assert.deepEqual(reloaded.coordinator.transformContext([...next, answer], reloaded.context.ctx, "plan"), [
      ...next,
      answer,
    ]);
  });
}

test("upgrade preserves a missing v1 interaction publication at its original model-visible boundary", () => {
  const oldPrefix = [legacyPlan, { role: "user", content: "Open discussion" }];
  const boundary = {
    length: oldPrefix.length,
    hash: createHash("sha256").update(JSON.stringify(oldPrefix)).digest("hex"),
  };
  const legacy = createInteractionContractMessage("discussion", 0, 1);
  const assistant = { role: "assistant", content: "Earlier reply" };
  const f = fixture({
    enabled: true,
    awaitingAction: false,
    interactionMode: "discussion",
    interactionRestorations: [{ version: 1, mode: "discussion", boundary }],
  });
  const first = f.coordinator.transformContext([...oldPrefix, assistant], f.context.ctx, "plan");
  assert.deepEqual(first.slice(0, oldPrefix.length + 2), [
    ...oldPrefix,
    { ...legacy, details: { ...legacy.details, contextBoundary: boundary } },
    assistant,
  ]);
  assert.equal(f.mock.sentMessages.length, 2);
});

test("compaction restores both required contracts once after all retained messages", () => {
  const f = fixture();
  const before = [legacyPlan, createInteractionContractMessage("discussion", 11, 1)];
  f.coordinator.transformContext(before, f.context.ctx, "plan");
  const retained = [
    { role: "compactionSummary", summary: "Planning details" },
    { role: "user", content: "Continue from the summary" },
  ];
  const after = f.coordinator.transformContext(retained, f.context.ctx, "plan");
  assert.deepEqual(after.slice(0, retained.length), retained);
  assert.equal(after.length, retained.length + 2);
  assert.equal(f.mock.sentMessages.length, 4);
  assert.deepEqual(f.coordinator.transformContext(retained, f.context.ctx, "plan"), after);
  assert.equal(f.mock.sentMessages.length, 4);
});

test("draft snapshots survive deferred publication and ordinary updates, then obsolete anchors prune on compaction", () => {
  const f = fixture({
    enabled: true,
    awaitingAction: false,
    interactionMode: "discussion",
    draftPlan: "# First draft",
  });
  const prefix = [
    createModeContractMessage("plan", 0),
    createInteractionContractMessage("discussion", 1),
    { role: "user", content: "Restore the current draft." },
  ];
  const first = f.coordinator.transformContext(prefix, f.context.ctx, "plan");
  assert.equal(f.mock.sentMessages.length, 1);
  assert.equal(planFromDraftContextMessage(first.at(-1)), "# First draft");
  const nextDraft = "# Changed draft";
  f.state().draftPlan = nextDraft;
  const deferred = [
    ...prefix,
    {
      role: "assistant",
      content: [{ type: "toolCall", id: "update", name: "plan_mode_update", arguments: { plan: nextDraft } }],
    },
    {
      role: "toolResult",
      toolName: "plan_mode_update",
      toolCallId: "update",
      isError: false,
      details: { version: 1, source: "plan_mode_update" },
    },
    { ...(f.mock.sentMessages[0]?.message as object), role: "custom", timestamp: 3 },
  ];
  const afterUpdate = f.coordinator.transformContext(deferred, f.context.ctx, "plan");
  assert.deepEqual(afterUpdate.slice(0, first.length), first);
  assert.deepEqual(afterUpdate.slice(first.length), deferred.slice(prefix.length, -1));
  assert.equal(f.mock.sentMessages.length, 1, "a retained successful update makes another snapshot unnecessary");

  const compacted = [{ role: "compactionSummary", summary: "Plan update dropped" }];
  const projected = f.coordinator.transformContext(compacted, f.context.ctx, "plan");
  assert.equal(planFromDraftContextMessage(projected.at(-1)), nextDraft);
  assert.deepEqual(
    f
      .state()
      .interactionRestorations?.flatMap((restoration) => (restoration.mode === "draft" ? [restoration.plan] : [])),
    [nextDraft],
  );
  const state = restorePlanModeState([{ type: "custom", customType: "state", data: f.state() }], "state");
  const reloaded = fixture(state);
  assert.deepEqual(reloaded.coordinator.transformContext(compacted, reloaded.context.ctx, "plan"), projected);
  assert.equal(reloaded.mock.sentMessages.length, 0);

  reloaded.state().enabled = false;
  const normal = reloaded.coordinator.transformContext(compacted, reloaded.context.ctx, "normal");
  assert.equal(normal.some(planFromDraftContextMessage), false);
});

test("a ready plan is not published as a draft", () => {
  const f = fixture({
    enabled: true,
    awaitingAction: true,
    interactionMode: "discussion",
    latestPlan: "# Ready plan",
  });
  const messages = [createModeContractMessage("plan", 0), createInteractionContractMessage("discussion", 1)];
  assert.equal(f.coordinator.transformContext(messages, f.context.ctx, "plan"), messages);
  assert.equal(f.mock.sentMessages.length, 0);
});

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
    { ...valid, version: 3 },
    { ...valid, mode: "plan" },
    { ...valid, version: 2, mode: "normal" },
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
