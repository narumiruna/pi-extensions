import assert from "node:assert/strict";
import { visibleWidth } from "@earendil-works/pi-tui";
import { createTuiHarness } from "@narumitw/pi-tui-kit/testing";
import { test } from "vitest";
import { createMockContext } from "../../../test/support.js";
import { buildGoalMenuState, GOAL_MENU_ACTIONS, safeGoalMenuText, showGoalManager } from "../src/menu.js";
import type { ActiveGoal } from "../src/persistence.js";
import { createGoal, transitionGoal } from "../src/runtime.js";
import { DEFAULT_GOAL_SETTINGS } from "../src/settings.js";

function runtime(goal?: ActiveGoal) {
  return {
    activeGoal: goal,
    settings: structuredClone(DEFAULT_GOAL_SETTINGS),
  };
}

function commands() {
  const calls: Array<{ name: string; args: unknown[] }> = [];
  const record =
    (name: string) =>
    (...args: unknown[]) =>
      calls.push({ name, args });
  return {
    calls,
    controller: {
      startGoal: record("startGoal"),
      pauseGoal: record("pauseGoal"),
      resumeGoal: record("resumeGoal"),
      clearGoal: record("clearGoal"),
      editGoal: record("editGoal"),
      showGoal: record("showGoal"),
    },
  };
}

test("buildGoalMenuState prioritizes actions for empty, active, stopped, and budget states", () => {
  const empty = runtime();
  assert.match(buildGoalMenuState(empty).title, /configured to pause after 25 responses/i);
  assert.deepEqual(buildGoalMenuState(empty).actions.slice(0, 2), [
    GOAL_MENU_ACTIONS.start,
    GOAL_MENU_ACTIONS.startBudget,
  ]);

  const customEmpty = runtime();
  customEmpty.settings.continuationLimits.automaticTurns = 40;
  assert.match(buildGoalMenuState(customEmpty).title, /configured to pause after 40 responses/i);
  assert.doesNotMatch(buildGoalMenuState(customEmpty).title, /by default/i);

  const active = createGoal("ship the release", 100, 0);
  active.tokensUsed = 20;
  active.automaticModelTurns = 12;
  const capped = runtime(active);
  assert.equal(buildGoalMenuState(capped).actions[0], GOAL_MENU_ACTIONS.pause);
  assert.match(buildGoalMenuState(capped).title, /Active.*Usage: 20\/100/is);
  assert.match(buildGoalMenuState(capped).title, /Automatic work: 12 of 25 responses.*13 remaining/is);

  const unlimited = runtime(active);
  unlimited.settings.continuationLimits.automaticTurns = null;
  assert.match(buildGoalMenuState(unlimited).title, /Automatic work: 12 responses.*Unlimited/is);

  const waiting = runtime({
    ...active,
    waiting: { reason: "Waiting \u001b]52;c;unsafe\u0007 for review" },
    activeStartedAt: undefined,
  });
  assert.equal(buildGoalMenuState(waiting).actions[0], GOAL_MENU_ACTIONS.resume);
  assert.match(buildGoalMenuState(waiting).title, /Waiting.*for review/is);
  assert.equal(buildGoalMenuState(waiting).title.includes(String.fromCharCode(27)), false);
  assert.equal(buildGoalMenuState(waiting).title.includes(String.fromCharCode(7)), false);

  for (const status of ["paused", "blocked", "usage_limited"] as const) {
    const stopped = runtime(transitionGoal(active, status));
    assert.equal(buildGoalMenuState(stopped).actions[0], GOAL_MENU_ACTIONS.resume);
  }

  const limited = runtime(transitionGoal({ ...active, tokensUsed: 100 }, "budget_limited"));
  assert.equal(buildGoalMenuState(limited).actions[0], GOAL_MENU_ACTIONS.increaseBudget);
});

test("start with token budget offers presets before collecting the objective", async () => {
  for (const automaticLimit of [25, null] as const) {
    const state = runtime();
    state.settings.continuationLimits.automaticTurns = automaticLimit;
    const tracked = commands();
    const selections = [GOAL_MENU_ACTIONS.startBudget, "100k — Suggested"];
    let chooserTitle = "";
    let chooserOptions: string[] = [];
    let editorTitle = "";
    const context = createMockContext({
      mode: "tui",
      hasUI: true,
      select: async (title: string, options: string[]) => {
        if (/Choose token budget/i.test(title)) {
          chooserTitle = title;
          chooserOptions = options;
        }
        return selections.shift();
      },
      editor: async (title: string) => {
        editorTitle = title;
        return "ship the release";
      },
    });

    await showGoalManager(state, tracked.controller as never, context.ctx, async () => undefined);

    assert.deepEqual(chooserOptions, [
      "25k — Lower token ceiling",
      "100k — Suggested",
      "300k — Higher token ceiling",
      "Set a custom budget…",
      "Back",
    ]);
    assert.match(chooserTitle, /maximum cumulative token usage/i);
    assert.match(chooserTitle, /final model call may exceed/i);
    assert.match(chooserTitle, /not a dollar-cost cap/i);
    assert.match(
      chooserTitle,
      automaticLimit === null
        ? /automatic work has no response-count cap/i
        : /automatic work will also pause after 25 responses/i,
    );
    assert.match(editorTitle, /Goal objective.*Token budget 100k/i);
    assert.match(editorTitle, automaticLimit === null ? /Automatic Unlimited/i : /Automatic limit 25/i);
    assert.equal(tracked.calls[0]?.name, "startGoal");
    assert.deepEqual(tracked.calls[0]?.args.slice(0, 2), ["ship the release", 100_000]);
  }
});

test("custom start budget explains formats and uses the canonical parser", async () => {
  const state = runtime();
  const tracked = commands();
  const selections = [GOAL_MENU_ACTIONS.startBudget, "Set a custom budget…"];
  const entered = ["not-a-budget", "1.5m"];
  let inputTitle = "";
  const context = createMockContext({
    mode: "tui",
    hasUI: true,
    select: async () => selections.shift(),
    input: async (title: string) => {
      inputTitle = title;
      return entered.shift();
    },
    editor: async () => "custom-budget objective",
  });

  await showGoalManager(state, tracked.controller as never, context.ctx, async () => undefined);

  assert.match(inputTitle, /maximum cumulative token usage/i);
  assert.match(inputTitle, /Examples: 25k, 300k, 1\.5m, or 300000/i);
  assert.match(context.notifications[0]?.message ?? "", /positive token amount.*25k.*300k.*1\.5m/i);
  assert.equal(tracked.calls[0]?.name, "startGoal");
  assert.deepEqual(tracked.calls[0]?.args.slice(0, 2), ["custom-budget objective", 1_500_000]);
});

test("custom budget input retains invalid drafts and stays responsive", async () => {
  const state = runtime();
  const tracked = commands();
  const tui = createTuiHarness({ width: 80, rows: 30 });
  const context = createMockContext({ mode: "tui", hasUI: true, custom: tui.custom });

  try {
    const running = showGoalManager(state, tracked.controller as never, context.ctx, async () => undefined);
    await tui.waitForOpen();
    tui.press("tui.select.down");
    tui.press("tui.select.confirm");
    await tui.waitForPending();
    await tui.waitForOpen();
    for (const width of [40, 80, 120]) {
      const lines = tui.render(width);
      const frame = lines.join(" ").replace(/\s+/gu, " ");
      assert.ok(lines.every((line) => visibleWidth(line) <= width));
      assert.match(frame, /Choose token budget/i);
      assert.match(frame, /25k — Lower token ceiling/i);
      assert.match(frame, /100k — Suggested/i);
      assert.match(frame, /300k — Higher token ceiling/i);
      assert.match(frame, /Set a custom budget…/i);
      assert.match(frame, /Back/i);
    }

    for (let index = 0; index < 3; index++) tui.press("tui.select.down");
    tui.press("tui.select.confirm");
    await tui.waitForPending();
    await tui.waitForOpen();
    assert.equal(tui.isFocusable, true);
    for (const width of [40, 80, 120]) {
      const lines = tui.render(width);
      const frame = lines.join(" ").replace(/\s+/gu, " ");
      assert.ok(lines.every((line) => visibleWidth(line) <= width));
      assert.match(frame, /Custom token budget/i);
      assert.match(frame, /Examples: 25k, 300k, 1\.5m, or 300000/i);
    }
    tui.type("invalid");
    tui.press("tui.input.submit");
    await tui.waitForPending();
    assert.match(tui.render().join(" "), /invalid/i);
    assert.match(context.notifications.at(-1)?.message ?? "", /positive token amount/i);
    tui.press("tui.select.cancel");
    await tui.waitForPending();
    await tui.waitForOpen();
    assert.match(tui.render().join(" "), /Choose token budget/i);
    tui.press("tui.select.confirm");
    await tui.waitForPending();
    await tui.waitForOpen();
    assert.match(tui.render().join(" "), /Custom token budget/i);
    tui.press("tui.select.cancel");
    await tui.waitForPending();
    await tui.waitForOpen();
    tui.press("ctrl+c");
    await running;
    assert.equal(tracked.calls.length, 0);
  } finally {
    tui.dispose();
  }
});

test("hard-cap pause names the cause and prioritizes review over immediate resume", () => {
  const goal = transitionGoal(createGoal("preserve this objective", undefined, 0), "paused");
  goal.automaticModelTurns = 25;
  goal.tokensUsed = 12_345;
  goal.timeUsedSeconds = 90;
  goal.safetyPauseCause = "continuation_limit";
  const state = buildGoalMenuState(runtime(goal));

  assert.match(state.title, /Paused — automatic-work limit reached/i);
  assert.match(state.title, /Automatic work: 25 of 25 responses/i);
  assert.match(state.title, /Progress is saved/i);
  assert.equal(state.actions[0], "Review and continue…");
  assert.equal(state.actions.includes(GOAL_MENU_ACTIONS.resume), false);
});

test("hard-cap recovery previews the next epoch and Back has no side effects", async () => {
  const goal = transitionGoal(createGoal("preserve this objective", undefined, 0), "paused");
  goal.automaticModelTurns = 25;
  goal.tokensUsed = 12_345;
  goal.timeUsedSeconds = 90;
  goal.safetyPauseCause = "continuation_limit";
  const state = runtime(goal);
  const tracked = commands();
  const selections = ["Review and continue…", "Back", GOAL_MENU_ACTIONS.close];
  let recoveryRender = "";
  const context = createMockContext({
    mode: "tui",
    hasUI: true,
    select: async (title: string) => {
      if (/Automatic work paused/i.test(title)) recoveryRender = title;
      return selections.shift();
    },
  });

  await showGoalManager(state, tracked.controller as never, context.ctx, async () => undefined);

  assert.match(recoveryRender, /25-of-25 safety limit/i);
  assert.match(recoveryRender, /12,345 cumulative tokens/i);
  assert.match(recoveryRender, /1m active time/i);
  assert.match(recoveryRender, /objective and usage are preserved/i);
  assert.match(recoveryRender, /resets the counter to 0.*up to 25 more/is);
  assert.equal(tracked.calls.length, 0);
  assert.equal(state.activeGoal, goal);
});

test("hard-cap recovery applies Continue only to the previewed goal", async () => {
  for (const replaceBeforeContinue of [false, true]) {
    const goal = transitionGoal(createGoal("previewed objective", undefined, 0), "paused");
    goal.automaticModelTurns = 25;
    goal.safetyPauseCause = "continuation_limit";
    const state = runtime(goal);
    const tracked = commands();
    const selections = ["Review and continue…", "Continue — up to 25 more responses"];
    const context = createMockContext({
      mode: "tui",
      hasUI: true,
      select: async () => {
        const selection = selections.shift();
        if (selection?.startsWith("Continue") && replaceBeforeContinue) {
          state.activeGoal = transitionGoal(createGoal("replacement objective", undefined, 0), "paused");
        }
        return selection;
      },
    });

    await showGoalManager(state, tracked.controller as never, context.ctx, async () => undefined);

    assert.equal(tracked.calls.filter((call) => call.name === "resumeGoal").length, replaceBeforeContinue ? 0 : 1);
    if (replaceBeforeContinue) {
      assert.match(context.notifications.at(-1)?.message ?? "", /active goal changed.*reopen/i);
    }
  }
});

test("hard-cap recovery can open the automatic-work setting and remain paused", async () => {
  for (const updatedLimit of [40, null] as const) {
    const goal = transitionGoal(createGoal("paused objective", undefined, 0), "paused");
    goal.automaticModelTurns = 25;
    goal.safetyPauseCause = "continuation_limit";
    const state = runtime(goal);
    const tracked = commands();
    const selections = ["Review and continue…", "Change automatic-work limit…", "Back", GOAL_MENU_ACTIONS.close];
    const targets: Array<string | undefined> = [];
    const recoveryFrames: string[] = [];
    const context = createMockContext({
      mode: "tui",
      hasUI: true,
      select: async (title: string) => {
        if (/Automatic work paused/i.test(title)) recoveryFrames.push(title);
        return selections.shift();
      },
    });

    await showGoalManager(state, tracked.controller as never, context.ctx, async (_ctx, target?: string) => {
      targets.push(target);
      state.settings.continuationLimits.automaticTurns = updatedLimit;
    });

    assert.deepEqual(targets, ["automatic"]);
    const updatedFrame = recoveryFrames.at(-1) ?? "";
    assert.match(updatedFrame, /paused after 25 responses at its previous safety limit/i);
    assert.match(
      updatedFrame,
      updatedLimit === null ? /Current limit: Unlimited/i : /Current automatic-work limit: 40/i,
    );
    assert.doesNotMatch(updatedFrame, /of-(?:40|Unlimited) safety limit/i);
    assert.equal(state.activeGoal?.status, "paused");
    assert.equal(tracked.calls.length, 0);
  }
});

test("hard-cap recovery remains readable and keyboard-operable at supported widths", async () => {
  const goal = transitionGoal(
    createGoal(`long objective ${"with preserved detail ".repeat(12)}`, undefined, 0),
    "paused",
  );
  goal.automaticModelTurns = 25;
  goal.tokensUsed = 12_345;
  goal.safetyPauseCause = "continuation_limit";
  const state = runtime(goal);
  const tracked = commands();
  const tui = createTuiHarness({ width: 80, rows: 40 });
  const context = createMockContext({
    mode: "tui",
    hasUI: true,
    custom: tui.custom,
  });

  try {
    const running = showGoalManager(state, tracked.controller as never, context.ctx, async () => undefined);
    await tui.waitForOpen();
    for (const width of [40, 80, 120]) {
      const lines = tui.render(width);
      assert.ok(lines.every((line) => visibleWidth(line) <= width));
      assert.match(lines.join(" ").replace(/\s+/gu, " "), /Review and continue…/i);
    }

    tui.press("tui.select.confirm");
    await tui.waitForPending();
    await tui.waitForOpen();
    for (const width of [40, 80, 120]) {
      const lines = tui.render(width);
      const frame = lines.join(" ").replace(/\s+/gu, " ");
      assert.ok(lines.every((line) => visibleWidth(line) <= width));
      assert.match(frame, /Automatic work paused/i);
      assert.match(frame, /25-of-25 safety limit/i);
      assert.match(frame, /Continue — up to 25 more responses/i);
      assert.match(frame, /Back/i);
    }

    tui.press("tui.select.cancel");
    await tui.waitForOpen();
    assert.match(tui.render().join(" "), /Review and continue…/i);
    tui.press("ctrl+c");
    await running;
    assert.equal(tracked.calls.length, 0);
  } finally {
    tui.dispose();
  }
});

test("safeGoalMenuText strips terminal controls and bounds untrusted previews", () => {
  const safe = safeGoalMenuText(
    `hello\u001b[31mred\u001b[0m\u001b]52;c;clipboard\u0007\u009bworld\r\u0000\n${"界".repeat(200)}`,
  );
  assert.equal(
    [...safe].some((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f);
    }),
    false,
  );
  assert.doesNotMatch(safe, /\[(?:31|0)m|clipboard|\]52/u);
  assert.match(safe, /hellored world/u);
  assert.match(safe, /…$/u);
  assert.ok([...safe].length <= 121);
});

test("showGoalManager preserves non-TUI status behavior", async () => {
  const tracked = commands();
  const context = createMockContext({ mode: "print", hasUI: false });
  await showGoalManager(runtime(), tracked.controller as never, context.ctx, async () => undefined);
  assert.deepEqual(
    tracked.calls.map((call) => call.name),
    ["showGoal"],
  );
});

test("menu cancellation has no side effects and clear requires an exact preview", async () => {
  const goal = createGoal("clear this objective", undefined, 0);
  const state = runtime(goal);
  const tracked = commands();
  let selects = 0;
  const context = createMockContext({
    mode: "tui",
    hasUI: true,
    select: async () => (++selects === 1 ? GOAL_MENU_ACTIONS.clear : undefined),
    confirm: async (title: string, message: string) => {
      assert.equal(title, "Clear goal?");
      assert.match(message, /clear this objective/);
      return false;
    },
  });

  await showGoalManager(state, tracked.controller as never, context.ctx, async () => undefined);
  assert.equal(tracked.calls.length, 0);
});

test("clear confirmation does not erase a goal that changed while open", async () => {
  const state = runtime(createGoal("previewed objective", undefined, 0));
  const tracked = commands();
  const selections = [GOAL_MENU_ACTIONS.clear, undefined];
  const context = createMockContext({
    mode: "tui",
    hasUI: true,
    select: async () => selections.shift(),
    confirm: async () => {
      state.activeGoal = createGoal("replacement objective", undefined, 0);
      return true;
    },
  });

  await showGoalManager(state, tracked.controller as never, context.ctx, async () => undefined);

  assert.equal(
    tracked.calls.some((call) => call.name === "clearGoal"),
    false,
  );
  assert.match(context.notifications.at(-1)?.message ?? "", /active goal changed.*reopen/i);
});

test("increase budget input shows current usage and confirms the exact resume effect", async () => {
  const goal = transitionGoal(createGoal("increase safely", 100_000, 0), "budget_limited");
  goal.tokensUsed = 108_000;
  const state = runtime(goal);
  const tracked = commands();
  const selections = [GOAL_MENU_ACTIONS.increaseBudget];
  let inputTitle = "";
  let confirmation = "";
  const context = createMockContext({
    mode: "tui",
    hasUI: true,
    select: async () => selections.shift(),
    input: async (title: string) => {
      inputTitle = title;
      return "300k";
    },
    confirm: async (_title: string, message: string) => {
      confirmation = message;
      return true;
    },
  });

  await showGoalManager(state, tracked.controller as never, context.ctx, async () => undefined);

  assert.match(inputTitle, /Current budget: 100k/i);
  assert.match(inputTitle, /Current usage: 108k/i);
  assert.match(inputTitle, /new cumulative total greater than 108k/i);
  assert.match(inputTitle, /Examples: 300k, 1\.5m, or 300000/i);
  assert.match(confirmation, /Budget: 100k → 300k/i);
  assert.match(confirmation, /Current usage: 108k/i);
  assert.match(confirmation, /Automatic work: up to 25 more responses after resume/i);
  assert.match(confirmation, /resume immediately/i);
  assert.equal(tracked.calls[0]?.name, "editGoal");
  assert.deepEqual(tracked.calls[0]?.args.slice(0, 2), ["increase safely", 300_000]);
});

test("increase budget validation and confirmation cancellation preserve the stopped goal", async () => {
  for (const scenario of ["invalid-total", "confirmation-cancel"] as const) {
    const goal = transitionGoal(createGoal("keep stopped", 100_000, 0), "budget_limited");
    goal.tokensUsed = 108_000;
    const state = runtime(goal);
    const tracked = commands();
    const entered = scenario === "invalid-total" ? ["100k", undefined] : ["300k", undefined];
    const selections = [GOAL_MENU_ACTIONS.increaseBudget, GOAL_MENU_ACTIONS.close];
    const context = createMockContext({
      mode: "tui",
      hasUI: true,
      select: async () => selections.shift(),
      input: async () => entered.shift(),
      confirm: async () => false,
    });

    await showGoalManager(state, tracked.controller as never, context.ctx, async () => undefined);

    assert.equal(tracked.calls.length, 0);
    assert.equal(state.activeGoal, goal);
    assert.equal(state.activeGoal?.status, "budget_limited");
    if (scenario === "invalid-total") {
      assert.match(context.notifications[0]?.message ?? "", /greater than current usage.*108k/i);
    }
  }
});

test("increase budget becomes read-only when no larger safe integer exists", async () => {
  const goal = transitionGoal(createGoal("maximum safe budget", Number.MAX_SAFE_INTEGER, 0), "budget_limited");
  goal.tokensUsed = Number.MAX_SAFE_INTEGER;
  const state = runtime(goal);
  const tracked = commands();
  let title = "";
  const selections = [GOAL_MENU_ACTIONS.increaseBudget, undefined, GOAL_MENU_ACTIONS.close];
  const context = createMockContext({
    mode: "tui",
    hasUI: true,
    select: async (receivedTitle: string) => {
      if (/Increase token budget unavailable/i.test(receivedTitle)) title = receivedTitle;
      return selections.shift();
    },
  });

  await showGoalManager(state, tracked.controller as never, context.ctx, async () => undefined);

  assert.match(title, /Increase token budget unavailable/i);
  assert.match(title, /No larger safe whole-number token budget/i);
  assert.equal(tracked.calls.length, 0);
});

test("increase budget rejects goal state that changes while confirmation is open", async () => {
  for (const changed of ["usage", "status"] as const) {
    const goal = transitionGoal(createGoal("changing state", 100_000, 0), "budget_limited");
    goal.tokensUsed = 108_000;
    const state = runtime(goal);
    const tracked = commands();
    const context = createMockContext({
      mode: "tui",
      hasUI: true,
      select: async () => GOAL_MENU_ACTIONS.increaseBudget,
      input: async () => "300k",
      confirm: async () => {
        if (changed === "usage") goal.tokensUsed = 109_000;
        else goal.status = "paused";
        return true;
      },
    });

    await showGoalManager(state, tracked.controller as never, context.ctx, async () => undefined);

    assert.equal(tracked.calls.length, 0);
    assert.match(context.notifications.at(-1)?.message ?? "", /goal changed|usage changed/i);
    assert.match(context.notifications.at(-1)?.message ?? "", /reopen/i);
  }
});

test("menu preserves exact token values in status and budget input", async () => {
  const goal = transitionGoal(createGoal("precise budget", 10_500, 0), "budget_limited");
  goal.tokensUsed = 10_499;
  const state = runtime(goal);
  assert.match(buildGoalMenuState(state).title, /10499\/10500/);
  let inputTitle = "";
  const tracked = commands();
  const context = createMockContext({
    mode: "tui",
    hasUI: true,
    select: async () => GOAL_MENU_ACTIONS.increaseBudget,
    input: async (title: string) => {
      inputTitle = title;
      return undefined;
    },
  });
  await showGoalManager(state, tracked.controller as never, context.ctx, async () => undefined);
  assert.match(inputTitle, /Current budget: 10\.5k \(10,500 tokens\)/i);
  assert.match(inputTitle, /Current usage: 10\.5k \(10,499 tokens\)/i);
  assert.equal(tracked.calls.length, 0);
});

test("main menu routes a waiting goal through the existing resume action", async () => {
  const waitingGoal = {
    ...createGoal("waiting objective", undefined, 0),
    waiting: { reason: "Waiting for review" },
    activeStartedAt: undefined,
  };
  const state = runtime(waitingGoal);
  const tracked = commands();
  const selections = [GOAL_MENU_ACTIONS.resume];
  const context = createMockContext({
    mode: "tui",
    hasUI: true,
    select: async () => selections.shift(),
  });

  await showGoalManager(state, tracked.controller as never, context.ctx, async () => undefined);

  assert.equal(tracked.calls.filter((call) => call.name === "resumeGoal").length, 1);
});

test("main-menu pause and resume do not mutate a replacement goal", async () => {
  for (const scenario of [
    { action: GOAL_MENU_ACTIONS.pause, status: "active" as const, method: "pauseGoal" },
    { action: GOAL_MENU_ACTIONS.resume, status: "paused" as const, method: "resumeGoal" },
  ]) {
    const displayed = transitionGoal(createGoal("displayed objective", undefined, 0), scenario.status);
    const state = runtime(displayed);
    const tracked = commands();
    const selections = [scenario.action, GOAL_MENU_ACTIONS.close];
    const context = createMockContext({
      mode: "tui",
      hasUI: true,
      select: async () => {
        const selected = selections.shift();
        if (selected === scenario.action) {
          state.activeGoal = transitionGoal(createGoal("replacement objective", undefined, 0), scenario.status);
        }
        return selected;
      },
    });

    await showGoalManager(state, tracked.controller as never, context.ctx, async () => undefined);

    assert.equal(
      tracked.calls.some((call) => call.name === scenario.method),
      false,
    );
    assert.match(context.notifications.at(-1)?.message ?? "", /active goal changed.*reopen/i);
  }
});

test("edit dialogs do not mutate a replacement active goal", async () => {
  const original = createGoal("old objective", undefined, 0);
  const replacement = createGoal("replacement objective", undefined, 0);
  const state = runtime(original);
  const tracked = commands();
  const context = createMockContext({
    mode: "tui",
    hasUI: true,
    select: async () => GOAL_MENU_ACTIONS.edit,
    editor: async () => {
      state.activeGoal = replacement;
      return "edited old objective";
    },
    confirm: async () => true,
  });

  await showGoalManager(state, tracked.controller as never, context.ctx, async () => undefined);

  assert.equal(tracked.calls.length, 0);
  assert.match(context.notifications.at(-1)?.message ?? "", /goal changed.*reopen/i);
});

test("budget dialogs do not mutate a replacement active goal", async () => {
  const original = transitionGoal(createGoal("old objective", 100, 0), "budget_limited");
  original.tokensUsed = 100;
  const replacement = createGoal("replacement objective", undefined, 0);
  const state = runtime(original);
  const tracked = commands();
  const context = createMockContext({
    mode: "tui",
    hasUI: true,
    select: async () => GOAL_MENU_ACTIONS.increaseBudget,
    input: async () => {
      state.activeGoal = replacement;
      return "200";
    },
    confirm: async () => true,
  });

  await showGoalManager(state, tracked.controller as never, context.ctx, async () => undefined);

  assert.equal(tracked.calls.length, 0);
  assert.match(context.notifications.at(-1)?.message ?? "", /goal changed.*reopen/i);
});

test("menu start and edit delegate raw objective data only after explicit input", async () => {
  const empty = runtime();
  const started = commands();
  const startContext = createMockContext({
    mode: "tui",
    hasUI: true,
    select: async () => GOAL_MENU_ACTIONS.start,
    editor: async () => "  implement menu  ",
  });
  await showGoalManager(empty, started.controller as never, startContext.ctx, async () => undefined);
  assert.equal(started.calls[0]?.name, "startGoal");
  assert.deepEqual(started.calls[0]?.args.slice(0, 2), ["implement menu", undefined]);

  const active = runtime(createGoal("old objective", undefined, 0));
  const edited = commands();
  const editContext = createMockContext({
    mode: "tui",
    hasUI: true,
    select: async () => GOAL_MENU_ACTIONS.edit,
    editor: async () => "new objective",
    confirm: async (title: string, message: string) => {
      assert.equal(title, "Apply goal edit?");
      assert.match(message, /old objective/);
      assert.match(message, /new objective/);
      return true;
    },
  });
  await showGoalManager(active, edited.controller as never, editContext.ctx, async () => undefined);
  assert.equal(edited.calls[0]?.name, "editGoal");
  assert.deepEqual(edited.calls[0]?.args.slice(0, 2), ["new objective", undefined]);
});
