import assert from "node:assert/strict";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { test } from "vitest";
import { createCustomSelectorHarness, createMockContext } from "../../../test/support.js";
import { createPlanActionController } from "../src/plan-action-controller.js";
import { showPlanModeMenu, showReadyPlanMenu } from "../src/plan-action-menus.js";

test("stale Plan actions do not load interactive UI", async () => {
  let interactiveLoads = 0;
  const controller = createPlanActionController({
    loadInteractiveUi: async () => {
      interactiveLoads += 1;
      return {} as never;
    },
    getState: () => ({ enabled: false, awaitingAction: false }),
    captureLifecycle: () => ({
      signal: new AbortController().signal,
      isCurrent: () => false,
    }),
    statusText: () => "off",
    getThinkingLevel: () => "medium",
    getSettings: () => ({ thinkingLevel: "inherit" }),
    implementationOutcome: () => "",
    getExportDestination: () => ({ configuredPath: "plan.md", resolvedPath: "/tmp/plan.md" }),
    show: () => undefined,
    finalize: () => undefined,
    implementHere: () => undefined,
    implementFresh: () => undefined,
    exportPlan: async () => false,
    settings: async () => false,
    save: () => undefined,
    stay: () => undefined,
    exitReady: () => undefined,
    clearSaved: () => undefined,
  });
  const context = createMockContext({ hasUI: true });

  await controller.showSaved(context.ctx);
  await controller.showCurrent(context.ctx);
  await controller.showReady(context.ctx);

  assert.equal(interactiveLoads, 0);
});

test("only ready-plan fresh actions survive normal menu disposal for deferred handoff", async () => {
  const timings: string[] = [];
  const currents: Array<() => boolean> = [];
  const invokeFresh = async (menuOptions: Record<string, unknown>, kind: "saved" | "current" | "ready") => {
    const controller = new AbortController();
    if (kind === "saved") {
      await (menuOptions.implementFresh as (signal: AbortSignal) => Promise<void>)(controller.signal);
    } else {
      await (menuOptions.implementFresh as (runtime: Record<string, never>, signal: AbortSignal) => Promise<void>)(
        {},
        controller.signal,
      );
    }
    controller.abort(new DOMException("Menu closed", "AbortError"));
  };
  const controller = createPlanActionController({
    loadInteractiveUi: async () =>
      ({
        showSavedPlanMenu: (_ctx: unknown, options: Record<string, unknown>) => invokeFresh(options, "saved"),
        showPlanModeMenu: (_ctx: unknown, options: Record<string, unknown>) => invokeFresh(options, "current"),
        showReadyPlanMenu: (_ctx: unknown, options: Record<string, unknown>) => invokeFresh(options, "ready"),
      }) as never,
    getState: () => ({
      enabled: true,
      awaitingAction: true,
      latestPlan: "# Plan",
      latestPlanSource: "plan_mode_complete",
    }),
    captureLifecycle: () => ({
      signal: new AbortController().signal,
      isCurrent: () => true,
    }),
    statusText: () => "ready",
    getThinkingLevel: () => "medium",
    getSettings: () => ({ thinkingLevel: "inherit" }),
    implementationOutcome: () => "",
    getExportDestination: () => ({ configuredPath: "plan.md", resolvedPath: "/tmp/plan.md" }),
    show: () => undefined,
    finalize: () => undefined,
    implementHere: () => undefined,
    implementFresh: (_ctx, isCurrent, _runtime, timing) => {
      timings.push(timing);
      currents.push(isCurrent);
    },
    exportPlan: async () => false,
    settings: async () => false,
    save: () => undefined,
    stay: () => undefined,
    exitReady: () => undefined,
    clearSaved: () => undefined,
  });
  const context = createMockContext({
    hasUI: true,
    model: { provider: "planning-provider", id: "planning-model" },
    modelRegistry: { getAvailable: () => [] },
  });

  await controller.showSaved(context.ctx);
  await controller.showCurrent(context.ctx);
  await controller.showReady(context.ctx);

  assert.deepEqual(timings, ["immediate", "immediate", "after-settled"]);
  assert.deepEqual(
    currents.map((isCurrent) => isCurrent()),
    [false, false, true],
  );
});

test("saved-plan fresh actions use persistent defaults and fall back from missing models", async () => {
  const target = { provider: "target-provider", id: "target-model" };
  const scenarios = [
    { name: "available", availableModels: [target], scopedModels: undefined, usesTarget: true },
    { name: "missing", availableModels: [], scopedModels: undefined, usesTarget: false },
    {
      name: "stale scoped model",
      availableModels: [],
      scopedModels: [{ model: target }],
      usesTarget: false,
    },
  ];
  for (const scenario of scenarios) {
    let selectedRuntime: unknown;
    const controller = createPlanActionController({
      loadInteractiveUi: async () =>
        ({
          showSavedPlanMenu: async (_ctx: unknown, menuOptions: Record<string, unknown>) => {
            await (menuOptions.implementFresh as (signal: AbortSignal) => Promise<void>)(new AbortController().signal);
          },
        }) as never,
      getState: () => ({
        enabled: false,
        awaitingAction: false,
        savedPlan: { plan: "# Plan", source: "plan_mode_complete" },
      }),
      captureLifecycle: () => ({
        signal: new AbortController().signal,
        isCurrent: () => true,
      }),
      statusText: () => "saved",
      getThinkingLevel: () => "medium",
      getSettings: () => ({
        thinkingLevel: "inherit",
        defaultImplementationModel: {
          provider: target.provider,
          modelId: target.id,
        },
        defaultImplementationThinkingLevel: "high",
      }),
      implementationOutcome: () => "",
      getExportDestination: () => ({ configuredPath: "plan.md", resolvedPath: "/tmp/plan.md" }),
      show: () => undefined,
      finalize: () => undefined,
      implementHere: () => undefined,
      implementFresh: (_ctx, _isCurrent, runtime) => {
        selectedRuntime = runtime;
      },
      exportPlan: async () => false,
      settings: async () => false,
      save: () => undefined,
      stay: () => undefined,
      exitReady: () => undefined,
      clearSaved: () => undefined,
    });
    const context = createMockContext({
      hasUI: true,
      model: { provider: "planning-provider", id: "planning-model" },
      ...(scenario.scopedModels ? { scopedModels: scenario.scopedModels } : {}),
      modelRegistry: { getAvailable: () => scenario.availableModels },
    });

    await controller.showSaved(context.ctx);

    assert.deepEqual(
      selectedRuntime,
      {
        model: scenario.usesTarget
          ? { provider: target.provider, modelId: target.id }
          : { provider: "planning-provider", modelId: "planning-model" },
        thinkingLevel: "high",
      },
      scenario.name,
    );
    assert.equal(
      context.notifications.some((notice) => /unavailable/u.test(notice.message)),
      !scenario.usesTarget,
      scenario.name,
    );
  }
});

function controllerOptions(overrides: Partial<Parameters<typeof createPlanActionController>[0]> = {}) {
  return {
    loadInteractiveUi: async () => ({}) as never,
    getState: () => ({ enabled: true, awaitingAction: false }),
    captureLifecycle: () => ({ signal: new AbortController().signal, isCurrent: () => true }),
    statusText: () => "Plan mode is active. File edits remain blocked.",
    getThinkingLevel: () => undefined,
    getSettings: () => ({ thinkingLevel: "inherit" as const }),
    implementationOutcome: () => "",
    getExportDestination: () => ({ configuredPath: "PLAN.md", resolvedPath: "/tmp/PLAN.md" }),
    show: () => undefined,
    finalize: () => undefined,
    implementHere: () => undefined,
    implementFresh: () => undefined,
    exportPlan: async () => false,
    settings: async () => false,
    save: () => undefined,
    stay: () => undefined,
    exitReady: () => undefined,
    clearSaved: () => undefined,
    ...overrides,
  };
}

function activeMenuOptions(overrides: Partial<Parameters<typeof showPlanModeMenu>[1]> = {}) {
  return {
    signal: new AbortController().signal,
    isCurrent: () => true,
    statusText: "Plan mode is active. File edits remain blocked.",
    planThinkingLevel: undefined,
    hasReadyPlan: false,
    implementationOutcome: () => "",
    getExportDestination: () => ({ configuredPath: "PLAN.md", resolvedPath: "/tmp/PLAN.md" }),
    show: () => undefined,
    finalize: () => undefined,
    implementHere: () => undefined,
    implementFresh: () => undefined,
    exportPlan: async () => false,
    save: () => undefined,
    stay: () => undefined,
    exit: () => undefined,
    ...overrides,
  };
}

test.each([undefined, "questions", "discussion"] as const)(
  "controller forwards %s interaction mode only to the manual active menu",
  async (interactionMode) => {
    const received: Array<{ kind: string; options: Record<string, unknown> }> = [];
    const toggledContexts: unknown[] = [];
    const controller = createPlanActionController(
      controllerOptions({
        getState: () => ({ enabled: true, awaitingAction: false, interactionMode, latestPlan: "Ready" }),
        toggleInteraction: (ctx) => {
          toggledContexts.push(ctx);
        },
        loadInteractiveUi: async () =>
          ({
            showPlanModeMenu: async (_ctx: unknown, options: Record<string, unknown>) => {
              received.push({ kind: "current", options });
              (options.toggleInteraction as () => void)();
            },
            showReadyPlanMenu: async (_ctx: unknown, options: Record<string, unknown>) => {
              received.push({ kind: "ready", options });
            },
            showSavedPlanMenu: async (_ctx: unknown, options: Record<string, unknown>) => {
              received.push({ kind: "saved", options });
            },
          }) as never,
      }),
    );
    const context = createMockContext({ hasUI: true });
    await controller.showCurrent(context.ctx);
    await controller.showReady(context.ctx);
    await controller.showSaved(context.ctx);
    assert.equal(received[0]?.options.interactionMode, interactionMode);
    assert.equal(received[0]?.options.hasReadyPlan, true);
    assert.deepEqual(toggledContexts, [context.ctx]);
    for (const menu of received.slice(1)) {
      assert.equal("toggleInteraction" in menu.options, false, menu.kind);
      assert.equal("interactionMode" in menu.options, false, menu.kind);
    }
  },
);

test("controller omits an unavailable interaction action", async () => {
  let received: Record<string, unknown> | undefined;
  const controller = createPlanActionController(
    controllerOptions({
      loadInteractiveUi: async () =>
        ({
          showPlanModeMenu: async (_ctx: unknown, options: Record<string, unknown>) => {
            received = options;
          },
        }) as never,
    }),
  );
  await controller.showCurrent(createMockContext({ hasUI: true }).ctx);
  assert.ok(received);
  assert.equal("toggleInteraction" in received, false);
});

test.each(["replaced", "aborted"])("controller does not open a menu after a %s lazy load", async (reason) => {
  const abort = new AbortController();
  let current = true;
  let menuCalls = 0;
  const controller = createPlanActionController(
    controllerOptions({
      captureLifecycle: () => ({ signal: abort.signal, isCurrent: () => current }),
      loadInteractiveUi: async () => {
        if (reason === "replaced") current = false;
        else abort.abort();
        return {
          showPlanModeMenu: async () => {
            menuCalls += 1;
          },
        } as never;
      },
    }),
  );
  await controller.showCurrent(createMockContext({ hasUI: true }).ctx);
  assert.equal(menuCalls, 0);
});

test.each([undefined, "questions", "discussion"] as const)(
  "RPC active menu offers the %s switch only when supplied and closes after selection",
  async (interactionMode) => {
    for (const hasReadyPlan of [false, true]) {
      for (const available of [false, true]) {
        const dialogs: string[][] = [];
        let toggles = 0;
        const label = interactionMode === "discussion" ? "Enable questionnaires" : "Switch to free discussion";
        const context = createMockContext({
          mode: "rpc",
          hasUI: true,
          custom: () => {
            throw new Error("RPC must not use custom UI");
          },
          select: async (_title: string, items: string[]) => {
            dialogs.push(items);
            return available ? label : undefined;
          },
        });
        await showPlanModeMenu(
          context.ctx,
          activeMenuOptions({
            interactionMode,
            hasReadyPlan,
            ...(available
              ? {
                  toggleInteraction: () => {
                    toggles += 1;
                  },
                }
              : {}),
          }),
        );
        assert.equal(dialogs.length, 1, "switch closes rather than reopening the menu");
        assert.equal(dialogs[0]?.includes(label), available);
        assert.equal(toggles, available ? 1 : 0);
        assert.equal(context.notifications.length, 0);
      }
    }
  },
);

test.each(["questions", "discussion"] as const)(
  "TUI %s switch works with native and remapped menu keys at active and ready states",
  async (interactionMode) => {
    for (const hasReadyPlan of [false, true]) {
      for (const remapped of [false, true]) {
        let toggles = 0;
        let screens = 0;
        let selected = false;
        const frames: Array<{ width: number; lines: string[] }> = [];
        const label = interactionMode === "discussion" ? "Enable questionnaires" : "Switch to free discussion";
        const keys = {
          matches: (data: string, action: string) =>
            (action === "tui.select.down" && data === "j") ||
            (action === "tui.select.confirm" && data === "x") ||
            (action === "tui.select.cancel" && data === "q"),
          getKeys: (action: string) =>
            action === "tui.select.confirm" ? ["x"] : action === "tui.select.cancel" ? ["q"] : ["j"],
        };
        const context = createMockContext({
          mode: "tui",
          hasUI: true,
          custom: async (factory: unknown) => {
            screens += 1;
            const harness = createCustomSelectorHarness(factory, 100, remapped ? keys : undefined);
            for (const width of [0, 1, 20, 100]) frames.push({ width, lines: harness.render(width) });
            harness.invalidate();
            for (let index = 0; index < 10; index += 1) {
              if (
                harness
                  .render()
                  .map(stripTerminalSequences)
                  .some((line) => line.includes(`→ ${label}`))
              ) {
                selected = true;
                harness.handleInput(remapped ? "x" : "tui.select.confirm");
                break;
              }
              harness.handleInput(remapped ? "j" : "tui.select.down");
            }
            if (!selected) harness.handleInput("\u0003");
            return harness.resultPromise;
          },
        });
        await showPlanModeMenu(
          context.ctx,
          activeMenuOptions({
            interactionMode,
            hasReadyPlan,
            toggleInteraction: () => {
              toggles += 1;
            },
          }),
        );
        assert.equal(selected, true);
        assert.equal(screens, 1);
        assert.equal(toggles, 1);
        assert.ok(frames.every(({ width, lines }) => lines.every((line) => visibleWidth(line) <= width)));
        assert.equal(context.notifications.length, 0);
      }
    }
  },
);

test.each(["remapped cancel", "hard cancel", "abort", "dispose"])(
  "TUI switch leaves state unchanged on %s",
  async (reason) => {
    const abort = new AbortController();
    let toggles = 0;
    let screens = 0;
    const context = createMockContext({
      mode: "tui",
      hasUI: true,
      custom: async (factory: unknown) => {
        screens += 1;
        const harness = createCustomSelectorHarness(factory, 80, {
          matches: (data, action) => action === "tui.select.cancel" && data === "q",
          getKeys: (action) => (action === "tui.select.cancel" ? ["q"] : []),
        });
        if (reason === "dispose") {
          harness.dispose();
          return undefined;
        }
        if (reason === "abort") abort.abort();
        else harness.handleInput(reason === "hard cancel" ? "\u0003" : "q");
        return harness.resultPromise;
      },
    });
    await showPlanModeMenu(
      context.ctx,
      activeMenuOptions({
        signal: abort.signal,
        toggleInteraction: () => {
          toggles += 1;
        },
      }),
    );
    assert.equal(screens, 1);
    assert.equal(toggles, 0);
    assert.equal(context.notifications.length, 0);
  },
);

test.each(["cancel", "abort", "replace"])("RPC switch leaves state unchanged on %s", async (reason) => {
  const abort = new AbortController();
  let current = true;
  let toggles = 0;
  const context = createMockContext({
    mode: "rpc",
    hasUI: true,
    select: async () => {
      if (reason === "abort") abort.abort();
      if (reason === "replace") current = false;
      return reason === "cancel" ? undefined : "Switch to free discussion";
    },
  });
  await showPlanModeMenu(
    context.ctx,
    activeMenuOptions({
      signal: abort.signal,
      isCurrent: () => current,
      toggleInteraction: () => {
        toggles += 1;
      },
    }),
  );
  assert.equal(toggles, 0);
});

test.each(["print", "json"] as const)("active menu does not prompt or toggle in %s mode", async (mode) => {
  let calls = 0;
  const context = createMockContext({
    mode,
    hasUI: false,
    custom: () => {
      calls += 1;
    },
    select: () => {
      calls += 1;
    },
  });
  await showPlanModeMenu(
    context.ctx,
    activeMenuOptions({
      toggleInteraction: () => {
        calls += 1;
      },
    }),
  );
  assert.equal(calls, 0);
});

test("automatic ready menu has no interaction switch", async () => {
  const dialogs: string[][] = [];
  let toggles = 0;
  const context = createMockContext({
    mode: "rpc",
    hasUI: true,
    select: async (_title: string, items: string[]) => {
      dialogs.push(items);
      return undefined;
    },
  });
  await showReadyPlanMenu(
    context.ctx,
    activeMenuOptions({
      interactionMode: "discussion",
      toggleInteraction: () => {
        toggles += 1;
      },
    }),
  );
  assert.equal(dialogs.length, 1);
  assert.equal(
    dialogs[0]?.some((label) => /questionnaires|discussion/u.test(label)),
    false,
  );
  assert.equal(toggles, 0);
});
