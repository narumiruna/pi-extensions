import assert from "node:assert/strict";
import { test } from "vitest";
import planMode from "../src/plan-mode.js";
import type { PlanModeSettings } from "../src/settings.js";
import { createMockContext, createMockPi } from "./support.js";

const PLAN_MODEL = { provider: "openai-codex", modelId: "plan-model" };
const NORMAL_MODEL = { provider: "xiaomi-token-plan-cn", modelId: "normal-model" };
const ESC = String.fromCharCode(27);

function autoSwitchSettings(overrides: Partial<PlanModeSettings> = {}): PlanModeSettings {
  return {
    thinkingLevel: "inherit",
    autoSwitchModel: true,
    planModel: PLAN_MODEL,
    normalModel: NORMAL_MODEL,
    ...overrides,
  };
}

function createHarness(settings: PlanModeSettings, options: { resolveModels?: boolean } = {}) {
  const mock = createMockPi({ activeTools: ["read", "edit", "write"] });
  planMode(mock.pi, {
    readSettings: async () => ({ kind: "loaded" as const, settings }),
  });
  const context = createMockContext({
    model: { provider: "other", id: "previous-model" },
    modelRegistry: {
      find: (provider: string, modelId: string) =>
        options.resolveModels === false ? undefined : { provider, id: modelId },
      getAvailable: () => [],
      getAll: () => [],
      isUsingOAuth: () => false,
      getApiKeyAndHeaders: async () => ({ ok: true, headers: {} }),
    },
    sessionManager: {
      getSessionId: () => "test-session",
      getSessionName: () => undefined,
      getBranch: () => [],
      getEntries: () => [],
    },
  });
  return { mock, context };
}

async function startSession(mock: ReturnType<typeof createMockPi>, ctx: unknown) {
  await mock.events.get("session_start")?.[0]?.({ reason: "startup" }, ctx);
}

async function completePlan(mock: ReturnType<typeof createMockPi>, ctx: unknown) {
  const complete = mock.tools.find((tool) => tool.name === "plan_mode_complete")?.execute as
    | ((...args: unknown[]) => Promise<unknown>)
    | undefined;
  assert.ok(complete);
  await complete("complete", { plan: "# Auto-switch plan" }, undefined, undefined, ctx);
}

test("starting Plan mode switches to the configured Plan enter model", async () => {
  const { mock, context } = createHarness(autoSwitchSettings());
  await startSession(mock, context.ctx);
  await mock.commands.get("plan")?.handler("start", context.ctx);

  assert.deepEqual(mock.setModels, [{ provider: PLAN_MODEL.provider, id: PLAN_MODEL.modelId }]);
});

test("leaving Plan mode switches to the configured Plan exit model", async () => {
  const { mock, context } = createHarness(autoSwitchSettings());
  await startSession(mock, context.ctx);
  await mock.commands.get("plan")?.handler("start", context.ctx);
  await mock.commands.get("plan")?.handler("exit", context.ctx);

  assert.deepEqual(mock.setModels, [
    { provider: PLAN_MODEL.provider, id: PLAN_MODEL.modelId },
    { provider: NORMAL_MODEL.provider, id: NORMAL_MODEL.modelId },
  ]);
});

test("implementation start switches to the configured Plan exit model", async () => {
  const { mock, context } = createHarness(autoSwitchSettings());
  await startSession(mock, context.ctx);
  await mock.commands.get("plan")?.handler("start", context.ctx);
  await completePlan(mock, context.ctx);
  await mock.commands.get("plan")?.handler("implement", context.ctx);

  assert.deepEqual(mock.setModels, [
    { provider: PLAN_MODEL.provider, id: PLAN_MODEL.modelId },
    { provider: NORMAL_MODEL.provider, id: NORMAL_MODEL.modelId },
  ]);
  assert.ok(mock.sentUserMessages.some((message) => message.text.length > 0));
});

test("auto switch disabled or partially configured switches only the configured direction", async () => {
  const disabled = createHarness(autoSwitchSettings({ autoSwitchModel: false }));
  await startSession(disabled.mock, disabled.context.ctx);
  await disabled.mock.commands.get("plan")?.handler("start", disabled.context.ctx);
  await disabled.mock.commands.get("plan")?.handler("exit", disabled.context.ctx);
  assert.deepEqual(disabled.mock.setModels, []);

  const planOnly = createHarness(autoSwitchSettings({ normalModel: undefined }));
  await startSession(planOnly.mock, planOnly.context.ctx);
  await planOnly.mock.commands.get("plan")?.handler("start", planOnly.context.ctx);
  await planOnly.mock.commands.get("plan")?.handler("exit", planOnly.context.ctx);
  assert.deepEqual(planOnly.mock.setModels, [{ provider: PLAN_MODEL.provider, id: PLAN_MODEL.modelId }]);
});

test("an unavailable target model keeps the current model and reports it", async () => {
  const { mock, context } = createHarness(autoSwitchSettings(), { resolveModels: false });
  await startSession(mock, context.ctx);
  await mock.commands.get("plan")?.handler("start", context.ctx);

  assert.deepEqual(mock.setModels, []);
  assert.equal(context.statuses.get("plan-mode"), "plan active");
  assert.ok(context.notifications.some((entry) => /unavailable/iu.test(entry.message)));
});

test("re-entering Plan mode while already active does not switch models again", async () => {
  const { mock, context } = createHarness(autoSwitchSettings());
  await startSession(mock, context.ctx);
  await mock.commands.get("plan")?.handler("start", context.ctx);
  await mock.commands.get("plan")?.handler("start", context.ctx);

  assert.deepEqual(mock.setModels, [{ provider: PLAN_MODEL.provider, id: PLAN_MODEL.modelId }]);
});

test("saving a plan from Plan mode switches to the Plan exit model", async () => {
  const { mock, context } = createHarness(autoSwitchSettings());
  await startSession(mock, context.ctx);
  await mock.commands.get("plan")?.handler("start", context.ctx);
  await completePlan(mock, context.ctx);
  await mock.commands.get("plan")?.handler("save", context.ctx);

  assert.deepEqual(mock.setModels, [
    { provider: PLAN_MODEL.provider, id: PLAN_MODEL.modelId },
    { provider: NORMAL_MODEL.provider, id: NORMAL_MODEL.modelId },
  ]);
});

test("implementing a saved plan outside Plan mode does not switch models", async () => {
  const { mock, context } = createHarness(autoSwitchSettings());
  await startSession(mock, context.ctx);
  await mock.commands.get("plan")?.handler("start", context.ctx);
  await completePlan(mock, context.ctx);
  await mock.commands.get("plan")?.handler("save", context.ctx);
  assert.equal(mock.setModels.length, 2);

  await mock.commands.get("plan")?.handler("implement", context.ctx);

  assert.equal(mock.setModels.length, 2);
  assert.ok(mock.sentUserMessages.some((message) => message.text.length > 0));
});

test("a model switch preserves the current thinking level", async () => {
  const { mock, context } = createHarness(autoSwitchSettings());
  const originalSetModel = mock.rawPi.setModel.bind(mock.rawPi);
  mock.rawPi.setModel = async (model: unknown) => {
    const applied = await originalSetModel(model);
    // Mirror pi.setModel resetting the thinking level for the new model.
    mock.rawPi.setThinkingLevel("xhigh");
    return applied;
  };
  const initialThinking = mock.thinkingLevel;

  await startSession(mock, context.ctx);
  await mock.commands.get("plan")?.handler("start", context.ctx);
  assert.equal(mock.thinkingLevel, initialThinking);
  await mock.commands.get("plan")?.handler("exit", context.ctx);
  assert.equal(mock.thinkingLevel, initialThinking);
  assert.equal(mock.setModels.length, 2);
});

test("model identifiers with terminal control characters are sanitized in notifications", async () => {
  const { mock, context } = createHarness(
    autoSwitchSettings({
      planModel: { provider: "openai-codex", modelId: `plan${ESC}[31m-model` },
    }),
    { resolveModels: false },
  );
  await startSession(mock, context.ctx);
  await mock.commands.get("plan")?.handler("start", context.ctx);

  assert.ok(context.notifications.some((entry) => /unavailable/iu.test(entry.message)));
  for (const entry of context.notifications) {
    assert.ok(!entry.message.includes(ESC), `notification leaked a control character: ${entry.message}`);
  }
});

test("a session replacement during the switch skips the stale thinking restore", async () => {
  const { mock, context } = createHarness(autoSwitchSettings());
  const originalSetModel = mock.rawPi.setModel.bind(mock.rawPi);
  let replaced = false;
  mock.rawPi.setModel = async (model: unknown) => {
    const applied = await originalSetModel(model);
    // Mirror pi.setModel resetting the thinking level for the new model.
    mock.rawPi.setThinkingLevel("xhigh");
    if (!replaced) {
      replaced = true;
      // Simulate a session replacement while setModel awaits:
      // session_start updates currentSession and bumps menuGeneration.
      const replacementCtx = createMockContext({
        sessionManager: {
          getSessionId: () => "other-session",
          getSessionName: () => undefined,
          getBranch: () => [],
          getEntries: () => [],
        },
      });
      await mock.events.get("session_start")?.[0]?.({ reason: "replacement" }, replacementCtx.ctx);
    }
    return applied;
  };

  await startSession(mock, context.ctx);
  await mock.commands.get("plan")?.handler("start", context.ctx);

  assert.equal(mock.setModels.length, 1);
  // The stale continuation must not write the old session's thinking snapshot back.
  assert.equal(mock.thinkingLevel, "xhigh");
});

test("overlapping transitions serialize so the later switch wins", async () => {
  const { mock, context } = createHarness(autoSwitchSettings());
  await startSession(mock, context.ctx);

  const originalSetModel = mock.rawPi.setModel.bind(mock.rawPi);
  let releaseFirst!: () => void;
  const firstGate = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  let calls = 0;
  mock.rawPi.setModel = async (model: unknown) => {
    calls += 1;
    // Gate the first switch so a second transition can start while it is in flight.
    if (calls === 1) await firstGate;
    return originalSetModel(model);
  };

  const entering = mock.commands.get("plan")?.handler("start", context.ctx) as Promise<unknown>;
  for (let i = 0; i < 100 && calls === 0; i += 1) await Promise.resolve();
  assert.equal(calls, 1, "the enter transition should reach setModel");

  const exiting = mock.commands.get("plan")?.handler("exit", context.ctx) as Promise<unknown>;
  // Let the exit transition run as far as it can while the enter switch is still gated.
  for (let i = 0; i < 100; i += 1) await Promise.resolve();
  releaseFirst();
  await Promise.all([entering, exiting]);

  assert.deepEqual(mock.setModels, [
    { provider: PLAN_MODEL.provider, id: PLAN_MODEL.modelId },
    { provider: NORMAL_MODEL.provider, id: NORMAL_MODEL.modelId },
  ]);
});
