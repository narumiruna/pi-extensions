import assert from "node:assert/strict";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { KeybindingsManager, TUI_KEYBINDINGS, visibleWidth } from "@earendil-works/pi-tui";
import { createTuiHarness } from "@narumitw/pi-tui-kit/testing";
import { test } from "vitest";
import { createCustomSelectorHarness, createMockContext, createMockPi } from "../../../test/support.js";
import { GoalCommandController } from "../src/commands.js";
import { createGoal, GoalRuntime } from "../src/runtime.js";
import { DEFAULT_GOAL_SETTINGS, type GoalSettings } from "../src/settings.js";
import { applyGoalSettings, parseGoalLimit, showGoalSettings } from "../src/settings-ui.js";

initTheme("dark", false);

function runtime() {
  const mock = createMockPi({ activeTools: ["read"] });
  const state = new GoalRuntime(mock.pi);
  state.settings = structuredClone(DEFAULT_GOAL_SETTINGS);
  return state;
}

test("goal setting custom limits accept only safe whole numbers greater than zero", () => {
  assert.equal(parseGoalLimit("40"), 40);
  assert.equal(parseGoalLimit(" 25 "), 25);
  for (const invalid of ["", "0", "-1", "1.5", "Unlimited", "off", "many", String(Number.MAX_SAFE_INTEGER + 1)]) {
    assert.equal(parseGoalLimit(invalid), undefined);
  }
});

test("applyGoalSettings saves before committing runtime settings and enforces lower limits", () => {
  const state = runtime();
  let saved: GoalSettings | undefined;
  let enforced = 0;
  state.enforceAutomaticTurnLimit = () => {
    enforced++;
    return false;
  };
  const next: GoalSettings = {
    ...structuredClone(DEFAULT_GOAL_SETTINGS),
    continuationLimits: { automaticTurns: 10, noProgressTurns: 2 },
  };
  const context = createMockContext();

  applyGoalSettings(state as never, next, context.ctx, {
    save(settings: GoalSettings) {
      saved = structuredClone(settings);
    },
  });

  assert.deepEqual(saved, next);
  assert.deepEqual(state.settings, next);
  assert.equal(enforced, 1);
});

test("applyGoalSettings restores runtime settings when persistence fails", () => {
  const state = runtime();
  const next: GoalSettings = {
    ...structuredClone(DEFAULT_GOAL_SETTINGS),
    rpc: { enabled: true },
  };
  const context = createMockContext();

  assert.throws(
    () =>
      applyGoalSettings(state as never, next, context.ctx, {
        save() {
          throw new Error("disk full");
        },
      }),
    /disk full/,
  );
  assert.deepEqual(state.settings, DEFAULT_GOAL_SETTINGS);
});

test("lowering the no-progress limit pauses and aborts in-flight Goal work", () => {
  const mock = createMockPi({ activeTools: ["goal_complete", "goal_blocked", "goal_wait"] });
  const state = new GoalRuntime(mock.pi);
  state.settings = {
    ...structuredClone(DEFAULT_GOAL_SETTINGS),
    continuationLimits: { automaticTurns: 25, noProgressTurns: 5 },
  };
  state.activeGoal = createGoal("current objective", undefined, 0);
  state.activeGoal.toolFreeRepeatCount = 3;
  state.beginAgentRun(state.activeGoal.id, "automatic");
  let aborts = 0;
  const context = createMockContext({
    mode: "tui",
    hasUI: true,
    abort: () => aborts++,
  });
  const next = {
    ...structuredClone(state.settings),
    continuationLimits: { automaticTurns: 25, noProgressTurns: 3 },
  };

  applyGoalSettings(state, next, context.ctx, { save() {} });

  assert.equal(aborts, 1);
  assert.equal(state.activeGoal?.status, "paused");
  assert.equal(state.activeGoal?.safetyPauseCause, "no_progress");
});

test("lowering a reached limit preserves an unrelated in-flight run", () => {
  const mock = createMockPi({ activeTools: ["goal_complete", "goal_blocked", "goal_wait"] });
  const state = new GoalRuntime(mock.pi);
  state.settings = {
    ...structuredClone(DEFAULT_GOAL_SETTINGS),
    continuationLimits: { automaticTurns: 25, noProgressTurns: 5 },
  };
  state.activeGoal = createGoal("current objective", undefined, 0);
  state.activeGoal.toolFreeRepeatCount = 3;
  state.beginAgentRun(null, undefined);
  let aborts = 0;
  const context = createMockContext({
    mode: "tui",
    hasUI: true,
    abort: () => aborts++,
  });
  const next = {
    ...structuredClone(state.settings),
    continuationLimits: { automaticTurns: 25, noProgressTurns: 3 },
  };

  applyGoalSettings(state, next, context.ctx, { save() {} });

  assert.equal(aborts, 0);
  assert.equal(state.agentRunGoalId, null);
  assert.equal(state.activeGoal?.status, "paused");
  assert.equal(state.activeGoal?.safetyPauseCause, "no_progress");
});

test("replacement confirmation does not replace a goal that changed while open", async () => {
  const mock = createMockPi({ activeTools: ["goal_complete", "goal_blocked", "goal_wait"] });
  const state = new GoalRuntime(mock.pi);
  state.activeGoal = createGoal("previewed objective", undefined, 0);
  const replacement = createGoal("replacement objective", undefined, 0);
  const context = createMockContext({
    mode: "tui",
    hasUI: true,
    confirm: async () => {
      state.activeGoal = replacement;
      return true;
    },
  });
  const controller = new GoalCommandController(state);

  await controller.startGoal("new objective", undefined, context.ctx);

  assert.equal(state.activeGoal?.id, replacement.id);
  assert.equal(mock.sentUserMessages.length, 0);
  assert.match(context.notifications.at(-1)?.message ?? "", /active goal changed.*try again/i);
});

test("replacement confirmation sanitizes terminal controls without changing goal data", async () => {
  const mock = createMockPi({ activeTools: ["goal_complete", "goal_blocked", "goal_wait"] });
  const state = new GoalRuntime(mock.pi);
  state.activeGoal = createGoal("current\u001b]8;;bad\u0007 objective", undefined, 0);
  let preview = "";
  const context = createMockContext({
    mode: "tui",
    hasUI: true,
    confirm: async (_title: string, message: string) => {
      preview = message;
      return false;
    },
  });
  const controller = new GoalCommandController(state);

  await controller.startGoal("new\u009b31m objective", undefined, context.ctx);

  for (const control of ["\u0007", "\u001b", "\u009b"]) {
    assert.equal(preview.includes(control), false);
  }
  assert.match(preview, /Current goal: current objective/);
  assert.doesNotMatch(preview, /]8;;bad/);
  assert.match(preview, /New goal: new 31m objective/);
  assert.equal(state.activeGoal?.text, "current\u001b]8;;bad\u0007 objective");
});

test("standard settings keep all four controls on one level", async () => {
  const state = runtime();
  let title = "";
  let options: string[] = [];
  const context = createMockContext({
    hasUI: true,
    mode: "tui",
    select: async (receivedTitle: string, receivedOptions: string[]) => {
      title = receivedTitle;
      options = receivedOptions;
      return undefined;
    },
  });
  await showGoalSettings(state, context.ctx, { settingsPath: "/tmp/pi-goal.json" });
  assert.match(title, /Pi Goal Settings/);
  assert.deepEqual(options, ["Automatic-work limit", "No-progress guard", "Retry usage limits", "Managed run RPC"]);
});

test("automatic-work settings can open directly from the safety recovery flow", async () => {
  const state = runtime();
  let title = "";
  let options: string[] = [];
  const context = createMockContext({
    hasUI: true,
    mode: "tui",
    select: async (receivedTitle: string, receivedOptions: string[]) => {
      title = receivedTitle;
      options = receivedOptions;
      return undefined;
    },
  });

  await showGoalSettings(state, context.ctx, {
    settingsPath: "/tmp/pi-goal.json",
    initialScreen: "automatic",
  });

  assert.match(title, /Automatic-work limit/i);
  assert.deepEqual(options, ["Set response limit…", "Unlimited…"]);
});

test("automatic-work finite limit editor starts from the current value or built-in default", async () => {
  for (const scenario of [
    {
      initial: null,
      prefill: "25",
      entered: "25",
      expected: 25,
    },
    {
      initial: 50,
      prefill: "50",
      entered: "40",
      expected: 40,
    },
  ] as const) {
    const state = runtime();
    state.settings.continuationLimits.automaticTurns = scenario.initial;
    let saved: GoalSettings | undefined;
    let editorTitle = "";
    let editorPrefill = "";
    const selections = ["Automatic-work limit", "Set response limit…", undefined];
    const context = createMockContext({
      hasUI: true,
      mode: "tui",
      select: async () => selections.shift(),
      editor: async (title: string, prefill: string) => {
        editorTitle = title;
        editorPrefill = prefill;
        return scenario.entered;
      },
    });

    await showGoalSettings(state, context.ctx, {
      settingsPath: "/tmp/pi-goal.json",
      save(settings) {
        saved = structuredClone(settings);
      },
    });

    assert.match(editorTitle, /default: 25/i);
    assert.equal(editorPrefill, scenario.prefill);
    assert.equal(saved?.continuationLimits.automaticTurns, scenario.expected);
    assert.equal(state.settings.continuationLimits.automaticTurns, scenario.expected);
  }
});

test("cancelling the automatic-work finite limit editor changes nothing", async () => {
  const state = runtime();
  state.settings.continuationLimits.automaticTurns = 50;
  let saves = 0;
  const selections = ["Automatic-work limit", "Set response limit…", undefined];
  const context = createMockContext({
    hasUI: true,
    mode: "tui",
    select: async () => selections.shift(),
    editor: async () => undefined,
  });

  await showGoalSettings(state, context.ctx, {
    settingsPath: "/tmp/pi-goal.json",
    save() {
      saves++;
    },
  });

  assert.equal(saves, 0);
  assert.equal(state.settings.continuationLimits.automaticTurns, 50);
});

test("Unlimited automatic work requires a concrete confirmation and cancellation changes nothing", async () => {
  for (const confirmed of [false, true]) {
    const state = runtime();
    let confirmation = "";
    let saves = 0;
    const selections = ["Automatic-work limit", "Unlimited…", undefined];
    const context = createMockContext({
      hasUI: true,
      mode: "tui",
      select: async () => selections.shift(),
      confirm: async (_title: string, message: string) => {
        confirmation = message;
        return confirmed;
      },
    });

    await showGoalSettings(state, context.ctx, {
      settingsPath: "/tmp/pi-goal.json",
      save() {
        saves++;
      },
    });

    assert.match(confirmation, /tool loops can continue.*without a response-count limit/i);
    assert.equal(saves, confirmed ? 1 : 0);
    assert.equal(state.settings.continuationLimits.automaticTurns, confirmed ? null : 25);
  }
});

test("lowering a reached automatic-work limit previews the immediate pause", async () => {
  for (const confirmed of [false, true]) {
    const state = runtime();
    state.settings.continuationLimits.automaticTurns = 40;
    state.activeGoal = createGoal("active objective", undefined, 0);
    state.activeGoal.automaticModelTurns = 25;
    let preview = "";
    let saves = 0;
    const selections = ["Automatic-work limit", "Set response limit…", undefined];
    const context = createMockContext({
      hasUI: true,
      mode: "tui",
      select: async () => selections.shift(),
      editor: async () => "20",
      confirm: async (_title: string, message: string) => {
        preview = message;
        return confirmed;
      },
    });

    await showGoalSettings(state, context.ctx, {
      settingsPath: "/tmp/pi-goal.json",
      save() {
        saves++;
      },
    });

    assert.match(preview, /already used 25.*limit to 20.*pause.*without deleting progress/is);
    assert.equal(saves, confirmed ? 1 : 0);
    assert.equal(state.settings.continuationLimits.automaticTurns, confirmed ? 20 : 40);
    assert.equal(state.activeGoal?.status, confirmed ? "paused" : "active");
  }
});

test("automatic-work save failure preserves the previous valid setting", async () => {
  const state = runtime();
  const selections = ["Automatic-work limit", "Set response limit…", undefined];
  const context = createMockContext({
    hasUI: true,
    mode: "tui",
    select: async () => selections.shift(),
    editor: async () => "40",
  });

  await showGoalSettings(state, context.ctx, {
    settingsPath: "/tmp/pi-goal.json",
    save() {
      throw new Error("disk full");
    },
  });

  assert.equal(state.settings.continuationLimits.automaticTurns, 25);
  assert.match(context.notifications.at(-1)?.message ?? "", /previous value remains/i);
});

test("automatic-work settings stay readable and keyboard-operable at supported widths", async () => {
  const state = runtime();
  const tui = createTuiHarness({ width: 80, rows: 30 });
  const context = createMockContext({ mode: "tui", hasUI: true, custom: tui.custom });

  try {
    const running = showGoalSettings(state, context.ctx, {
      settingsPath: "/tmp/pi-goal.json",
      save() {},
    });
    await tui.waitForOpen();
    for (const width of [40, 80, 120]) {
      const lines = tui.render(width);
      assert.ok(lines.every((line) => visibleWidth(line) <= width));
      assert.match(lines.join(" "), /Automatic-work limit/i);
    }

    tui.press("tui.select.confirm");
    await tui.waitForPending();
    await tui.waitForOpen();
    for (const width of [40, 80, 120]) {
      const lines = tui.render(width);
      const frame = lines.join(" ").replace(/\s+/gu, " ");
      assert.ok(lines.every((line) => visibleWidth(line) <= width));
      assert.match(frame, /Set response limit…/i);
      assert.match(frame, /Default: 25/i);
      assert.match(frame, /Unlimited…/i);
      assert.doesNotMatch(frame, /25 responses \(default\)/i);
    }
    tui.press("tui.select.cancel");
    await tui.waitForOpen();
    assert.match(tui.render().join(" "), /Automatic-work limit/i);
    tui.press("ctrl+c");
    await running;
  } finally {
    tui.dispose();
  }
});

test("automatic-work editing stops without side effects when its menu is disposed", async () => {
  const state = runtime();
  let saves = 0;
  const selections = ["Automatic-work limit", "Set response limit…", undefined];
  const context = createMockContext({
    hasUI: true,
    mode: "tui",
    select: async () => selections.shift(),
    editor: async () => {
      state.closeMenuSession();
      return "10";
    },
  });

  await showGoalSettings(state, context.ctx, {
    settingsPath: "/tmp/pi-goal.json",
    save() {
      saves++;
    },
  });

  assert.equal(saves, 0);
  assert.equal(state.settings.continuationLimits.automaticTurns, 25);
});

test("automatic-work editing rejects a replacement active goal without saving", async () => {
  const state = runtime();
  state.activeGoal = createGoal("original", undefined, 0);
  let saves = 0;
  const selections = ["Automatic-work limit", "Set response limit…", undefined];
  const context = createMockContext({
    hasUI: true,
    mode: "tui",
    select: async () => selections.shift(),
    editor: async () => {
      state.activeGoal = createGoal("replacement", undefined, 0);
      return "10";
    },
  });

  await showGoalSettings(state, context.ctx, {
    settingsPath: "/tmp/pi-goal.json",
    save() {
      saves++;
    },
  });

  assert.equal(saves, 0);
  assert.equal(state.settings.continuationLimits.automaticTurns, 25);
  assert.match(context.notifications.at(-1)?.message ?? "", /active goal changed/i);
});

test("Retry usage limits saves each toggle without restarting an already stopped Goal", async () => {
  const state = runtime();
  state.activeGoal = createGoal("stopped objective", undefined, 0);
  state.activeGoal.status = "usage_limited";
  const goalId = state.activeGoal.id;
  const saved: GoalSettings[] = [];
  const selections = ["Retry usage limits", "Retry usage limits", undefined];
  const context = createMockContext({
    hasUI: true,
    mode: "tui",
    select: async () => selections.shift(),
  });

  assert.equal(state.settings.retryUsageLimits, false);
  await showGoalSettings(state, context.ctx, {
    settingsPath: "/tmp/pi-goal.json",
    save(settings) {
      saved.push(structuredClone(settings));
    },
  });

  assert.deepEqual(
    saved.map((settings) => settings.retryUsageLimits),
    [true, false],
  );
  assert.deepEqual(state.settings, DEFAULT_GOAL_SETTINGS);
  assert.equal(state.activeGoal?.id, goalId);
  assert.equal(state.activeGoal?.status, "usage_limited");
  assert.match(context.notifications.at(-1)?.message ?? "", /Retry usage limits: Off/i);
});

test("Retry usage limits rolls back after save or application failure in both directions", async () => {
  for (const initial of [false, true]) {
    for (const failure of ["save", "apply"] as const) {
      const state = runtime();
      state.settings.retryUsageLimits = initial;
      if (failure === "apply") {
        state.enforceAutomaticTurnLimit = () => {
          throw new Error("application failed");
        };
      }
      const saved: boolean[] = [];
      const selections = ["Retry usage limits", undefined];
      const context = createMockContext({
        hasUI: true,
        mode: "tui",
        select: async () => selections.shift(),
      });

      await showGoalSettings(state, context.ctx, {
        settingsPath: "/tmp/pi-goal.json",
        save(settings) {
          if (failure === "save") throw new Error("disk full");
          saved.push(settings.retryUsageLimits);
        },
      });

      assert.equal(state.settings.retryUsageLimits, initial);
      assert.deepEqual(saved, failure === "save" ? [] : [!initial, initial]);
      assert.match(context.notifications.at(-1)?.message ?? "", /previous value remains/i);
    }
  }
});

test("Retry usage limits retains Kit framing, warnings, and remapped standard actions", async () => {
  const state = runtime();
  const roles: Array<{ role: string; text: string }> = [];
  const tui = createTuiHarness({
    width: 80,
    rows: 30,
    theme: {
      fg: (role, text) => {
        roles.push({ role, text });
        return text;
      },
      bold: (text) => text,
    },
    keybindings: new KeybindingsManager(TUI_KEYBINDINGS, {
      "tui.select.down": "ctrl+n",
      "tui.select.up": "ctrl+p",
      "tui.select.confirm": "ctrl+y",
      "tui.select.cancel": "ctrl+q",
    }),
  });
  const context = createMockContext({ mode: "tui", hasUI: true, custom: tui.custom });
  const saved: boolean[] = [];

  try {
    const running = showGoalSettings(state, context.ctx, {
      settingsPath: "/tmp/pi-goal.json",
      save(settings) {
        saved.push(settings.retryUsageLimits);
      },
    });
    await tui.waitForOpen();
    tui.send("\u000e");
    tui.send("\u000e");
    for (const width of [40, 80, 120]) {
      const lines = tui.render(width);
      const frame = lines.join(" ").replace(/\s+/gu, " ");
      assert.ok(lines.every((line) => visibleWidth(line) <= width));
      assert.equal(lines[0], "─".repeat(width));
      assert.equal(lines.at(-1), "─".repeat(width));
      assert.match(frame, /→ Retry usage limits\s+Off/);
      assert.match(frame, /repeated provider requests.*charges/i);
      assert.match(frame, /billing.*indefinitely/i);
      assert.match(frame, /15-minute fallback/i);
      assert.match(frame, /Ctrl\+Y.*change/i);
      assert.match(frame, /Ctrl\+Q.*back/i);
    }
    assert.ok(roles.some(({ role, text }) => role === "border" && text === "─".repeat(80)));
    assert.ok(roles.some(({ role, text }) => role === "muted" && /provider requests/i.test(text)));

    tui.send("\u0019");
    await tui.waitForPending();
    await tui.waitForOpen();
    assert.equal(state.settings.retryUsageLimits, true);
    assert.match(tui.render().join(" "), /Retry usage limits\s+On/);
    assert.deepEqual(saved, [true]);
    tui.send(" ");
    await tui.waitForPending();
    await tui.waitForOpen();
    assert.equal(state.settings.retryUsageLimits, false);
    assert.deepEqual(saved, [true, false]);

    for (const rows of [8, 7, 4, 30]) {
      const lines = tui.resize({ width: 40, rows });
      assert.ok(lines.length <= Math.max(1, rows - 3));
      assert.ok(lines.every((line) => visibleWidth(line) <= 40));
      assert.match(lines.join(" "), /→ Retry usage limits/);
      assert.equal(lines[0] === "─".repeat(40), rows >= 8);
    }
    for (const width of [1, 20, 80]) {
      const lines = tui.render(width);
      assert.ok(lines.every((line) => visibleWidth(line) <= width));
    }
    tui.invalidate();
    assert.match(tui.render().join(" "), /Retry usage limits/);
    tui.send("\u0011");
    await running;
    assert.equal(tui.isOpen, false);
  } finally {
    tui.dispose();
  }
});

test("Retry usage limits reverts its displayed value after failure and the next toggle can save", async () => {
  const state = runtime();
  const tui = createTuiHarness({ width: 80, rows: 30 });
  const context = createMockContext({ mode: "tui", hasUI: true, custom: tui.custom });
  let attempts = 0;
  try {
    const running = showGoalSettings(state, context.ctx, {
      settingsPath: "/tmp/pi-goal.json",
      save() {
        attempts++;
        if (attempts === 1) throw new Error("disk full");
      },
    });
    await tui.waitForOpen();
    tui.type("Retry usage");
    tui.press("tui.select.confirm");
    await tui.waitForPending();
    await tui.waitForOpen();
    assert.equal(state.settings.retryUsageLimits, false);
    assert.match(tui.render().join(" "), /Retry usage limits\s+Off/);
    assert.match(context.notifications.at(-1)?.message ?? "", /previous value remains/i);
    tui.press("tui.select.confirm");
    await tui.waitForPending();
    await tui.waitForOpen();
    assert.equal(state.settings.retryUsageLimits, true);
    assert.match(tui.render().join(" "), /Retry usage limits\s+On/);
    assert.equal(attempts, 2);
    tui.press("ctrl+c");
    await running;
  } finally {
    tui.dispose();
  }
});

test("Managed run RPC setting defaults off and saves immediately", async () => {
  const state = runtime();
  let saved: GoalSettings | undefined;
  const selections = ["Managed run RPC", undefined];
  const context = createMockContext({
    hasUI: true,
    mode: "tui",
    select: async () => selections.shift(),
  });

  assert.equal(state.settings.rpc.enabled, false);
  await showGoalSettings(state, context.ctx, {
    settingsPath: "/tmp/pi-goal.json",
    save(settings) {
      saved = structuredClone(settings);
    },
  });

  assert.equal(saved?.rpc.enabled, true);
  assert.equal(state.settings.rpc.enabled, true);
  assert.match(context.notifications.at(-1)?.message ?? "", /Managed run RPC: On/i);
});

test("Managed run RPC setting disables immediately", async () => {
  const state = runtime();
  state.settings = {
    ...structuredClone(state.settings),
    rpc: { enabled: true },
  };
  let saved: GoalSettings | undefined;
  const selections = ["Managed run RPC", undefined];
  const context = createMockContext({
    hasUI: true,
    mode: "tui",
    select: async () => selections.shift(),
  });

  await showGoalSettings(state, context.ctx, {
    settingsPath: "/tmp/pi-goal.json",
    save(settings) {
      saved = structuredClone(settings);
    },
  });

  assert.equal(saved?.rpc.enabled, false);
  assert.equal(state.settings.rpc.enabled, false);
  assert.match(context.notifications.at(-1)?.message ?? "", /Managed run RPC: Off/i);
});

test("Managed run RPC setting rolls back when save fails", async () => {
  const state = runtime();
  const selections = ["Managed run RPC", undefined];
  const context = createMockContext({
    hasUI: true,
    mode: "tui",
    select: async () => selections.shift(),
  });

  await showGoalSettings(state, context.ctx, {
    settingsPath: "/tmp/pi-goal.json",
    save() {
      throw new Error("disk full");
    },
  });

  assert.equal(state.settings.rpc.enabled, false);
  assert.match(context.notifications.at(-1)?.message ?? "", /previous value remains/i);
});

test("settings and invalid-file details render no cells at zero width", async () => {
  for (const invalid of [false, true]) {
    const state = runtime();
    if (invalid) state.settingsLoadIssue = { kind: "invalid", reason: "invalid settings shape" };
    const frames: string[][] = [];
    const context = createMockContext({
      mode: "tui",
      hasUI: true,
      custom: async (factory: unknown) => {
        const harness = createCustomSelectorHarness(factory);
        try {
          frames.push(harness.render(0));
          harness.invalidate();
          frames.push(harness.render(0));
          harness.handleInput("\u0003");
          return await harness.resultPromise;
        } finally {
          harness.dispose();
        }
      },
    });

    await showGoalSettings(state, context.ctx, { settingsPath: "/tmp/pi-goal.json" });

    assert.deepEqual(frames, [[], []]);
    assert.deepEqual(state.settings, DEFAULT_GOAL_SETTINGS);
  }
});

test("invalid settings use a standard read-only detail screen", async () => {
  const state = runtime();
  state.settingsLoadIssue = { kind: "invalid", reason: "invalid settings shape" };
  let title = "";
  let saves = 0;
  const context = createMockContext({
    hasUI: true,
    mode: "tui",
    select: async (receivedTitle: string) => {
      title = receivedTitle;
      return undefined;
    },
  });
  await showGoalSettings(state, context.ctx, {
    settingsPath: "/tmp/pi-goal.json",
    save() {
      saves++;
    },
  });
  assert.equal(saves, 0);
  assert.match(title, /Retry usage limits: Off/i);
  assert.match(title, /Read only/i);
  assert.match(title, /Invalid settings file/i);
  assert.match(title, /Automatic-work limit: Up to 25 responses/i);
  assert.match(title, /Managed run RPC: Off/i);
});

test("showGoalSettings never opens or saves settings outside TUI and gives RPC a manual path", async () => {
  for (const mode of ["rpc", "print", "json"] as const) {
    const state = runtime();
    let customCalls = 0;
    let saves = 0;
    const context = createMockContext({
      mode,
      hasUI: mode === "rpc",
      custom: async () => {
        customCalls++;
      },
    });
    await showGoalSettings(state, context.ctx, {
      settingsPath: "/tmp/pi-goal.json",
      save() {
        saves++;
      },
    });
    assert.equal(customCalls, 0);
    assert.equal(saves, 0);
    assert.deepEqual(state.settings, DEFAULT_GOAL_SETTINGS);
    if (mode === "rpc") {
      assert.match(context.notifications.at(-1)?.message ?? "", /Edit pi-goal settings manually: \/tmp\/pi-goal.json/);
    }
  }
});
