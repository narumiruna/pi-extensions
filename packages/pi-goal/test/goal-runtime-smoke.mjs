import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { InMemoryCredentialStore, Type } from "@earendil-works/pi-ai";
import { createFauxCore, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRegistry,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";

const extensionPath = resolve(import.meta.dirname, "../src/goal.ts");

async function createHarness(responses, fauxOptions = {}, prepareSession, goalSettings, piSettings = {}, managedRun) {
  const root = await mkdtemp(join(tmpdir(), "pi-goal-runtime-"));
  const agentDir = join(root, "agent");
  const cwd = join(root, "workspace");
  await mkdir(cwd, { recursive: true });
  if (goalSettings) {
    await mkdir(agentDir, { recursive: true });
    await writeFile(join(agentDir, "pi-goal.json"), `${JSON.stringify(goalSettings)}\n`, "utf8");
  }

  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  let createdSession;
  let agentDirRestored = false;
  const restoreAgentDir = () => {
    if (agentDirRestored) return;
    agentDirRestored = true;
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  };
  process.env.PI_CODING_AGENT_DIR = agentDir;
  const cleanupResources = async () => {
    try {
      createdSession?.dispose();
    } finally {
      try {
        await rm(root, { recursive: true, force: true });
      } finally {
        restoreAgentDir();
      }
    }
  };

  try {
    const credentials = new InMemoryCredentialStore();
    const modelRuntime = await ModelRuntime.create({ credentials, modelsPath: null });
    const modelRegistry = new ModelRegistry(modelRuntime);
    const faux = createFauxCore({
      api: `pi-goal-faux-${crypto.randomUUID()}`,
      provider: `pi-goal-faux-${crypto.randomUUID()}`,
      ...fauxOptions,
    });
    const provider = faux.getModel().provider;
    modelRegistry.registerProvider(provider, {
      api: faux.api,
      apiKey: "runtime-smoke",
      baseUrl: "http://localhost",
      streamSimple: faux.streamSimple,
      models: faux.models.map((model) => ({
        id: model.id,
        name: model.name,
        api: model.api,
        baseUrl: model.baseUrl,
        reasoning: model.reasoning,
        input: model.input,
        cost: model.cost,
        contextWindow: model.contextWindow,
        maxTokens: model.maxTokens,
      })),
    });
    const model = modelRegistry.find(provider, faux.getModel().id);
    assert.ok(model, "expected registered faux model");
    faux.setResponses(responses);
    const managedRunEvents = [];

    const settingsManager = SettingsManager.inMemory({
      compaction: { enabled: false },
      retry: { enabled: false },
      ...piSettings,
    });
    const lifecycleEvents = [];
    const resourceLoader = new DefaultResourceLoader({
      cwd,
      agentDir,
      settingsManager,
      additionalExtensionPaths: [extensionPath],
      extensionFactories: [
        {
          name: "runtime-smoke-observer",
          factory: (pi) => {
            if (managedRun) {
              pi.events.on(`pi-goal:event:${managedRun.runId}`, (event) => {
                managedRunEvents.push(event);
              });
              pi.on("session_start", () => {
                pi.events.emit("pi-goal:start", managedRun);
              });
            }
            pi.registerTool({
              name: "budget_probe",
              label: "Budget Probe",
              description: "No-op tool for lifecycle smoke coverage",
              parameters: Type.Object({}),
              async execute() {
                lifecycleEvents.push("budget_probe_execute");
                return { content: [{ type: "text", text: "probe complete" }] };
              },
            });
            pi.on("session_start", () => lifecycleEvents.push("session_start"));
            pi.on("agent_start", () => lifecycleEvents.push("agent_start"));
            pi.on("message_end", (event) => {
              if (event.message.role === "assistant") lifecycleEvents.push("assistant_message_end");
            });
            pi.on("tool_execution_end", () => lifecycleEvents.push("tool_execution_end"));
            pi.on("session_before_compact", () => lifecycleEvents.push("session_before_compact"));
            pi.on("session_compact", (event, ctx) =>
              lifecycleEvents.push(
                `session_compact:idle=${ctx.isIdle()}:pending=${ctx.hasPendingMessages()}:reason=${event.reason}:willRetry=${event.willRetry}`,
              ),
            );
            pi.on("agent_settled", () => lifecycleEvents.push("agent_settled"));
          },
        },
      ],
    });
    await resourceLoader.reload();
    const sessionManager = SessionManager.inMemory(cwd);
    prepareSession?.(sessionManager);
    const result = await createAgentSession({
      cwd,
      agentDir,
      modelRuntime,
      model,
      resourceLoader,
      sessionManager,
      settingsManager,
      noTools: "builtin",
    });
    assert.deepEqual(result.extensionsResult.errors, []);
    createdSession = result.session;
    await result.session.bindExtensions({});
    return {
      agentDir,
      extensions: result.extensionsResult.extensions.map((extension) => ({
        path: extension.path,
        handlers: [...extension.handlers.keys()],
      })),
      faux,
      lifecycleEvents,
      managedRunEvents,
      session: result.session,
      cleanup: cleanupResources,
    };
  } catch (error) {
    await cleanupResources();
    throw error;
  }
}

function completionResponse(context) {
  const modelContext = [context.systemPrompt ?? "", ...context.messages.map(modelMessageText)].join("\n");
  const goalId = [...modelContext.matchAll(/<goal_id>\s*([^<\s]+)\s*<\/goal_id>/g)].at(-1)?.[1];
  assert.ok(goalId, "expected goal id in appended Goal context");
  return fauxAssistantMessage(
    fauxToolCall("goal_complete", {
      goal_id: goalId,
      summary: "Runtime smoke completed and verified.",
    }),
  );
}

function modelMessageText(message) {
  if (typeof message.content === "string") return message.content;
  if (!Array.isArray(message.content)) return "";
  return message.content
    .filter((part) => part?.type === "text")
    .map((part) => part.text)
    .join("\n");
}

function userMessageText(message) {
  return message.role === "user" ? modelMessageText(message) : "";
}

async function agentDirectoryIsolationScenario() {
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  const harness = await createHarness([]);
  try {
    assert.equal(process.env.PI_CODING_AGENT_DIR, harness.agentDir);
  } finally {
    await harness.cleanup();
  }
  assert.equal(process.env.PI_CODING_AGENT_DIR, previousAgentDir);
}

function persistedGoalState(session) {
  return session.sessionManager
    .getBranch()
    .filter((candidate) => candidate.type === "custom" && candidate.customType === "goal-state")
    .at(-1)?.data;
}

function persistedGoalStatus(session) {
  return persistedGoalState(session)?.goal?.status ?? null;
}

function persistedGoalHistory(session) {
  return session.sessionManager
    .getBranch()
    .filter((candidate) => candidate.type === "custom" && candidate.customType === "goal-state")
    .map((candidate) => candidate.data?.goal)
    .filter(Boolean);
}

async function waitFor(predicate, description, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${description}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function normalContinuationScenario() {
  const harness = await createHarness([
    fauxAssistantMessage("First pass stopped without completion."),
    completionResponse,
  ]);
  const events = [];
  const unsubscribe = harness.session.subscribe((event) => events.push(event.type));
  try {
    await harness.session.prompt("/goal runtime continuation smoke");
    await waitFor(() => harness.faux.state.callCount === 2, "settled continuation");
    await harness.session.agent.waitForIdle();
    assert.equal(events.filter((type) => type === "agent_settled").length, 2);
    assert.equal(persistedGoalStatus(harness.session), null);
    assert.ok(harness.session.messages.map(userMessageText).some((text) => text.includes("pi-goal-continuation:")));
  } finally {
    unsubscribe();
    await harness.cleanup();
  }
}

async function runawayNoProgressScenario() {
  const harness = await createHarness([
    fauxAssistantMessage("Required phrase"),
    fauxAssistantMessage(""),
    fauxAssistantMessage("   ...   "),
    fauxAssistantMessage(""),
  ]);
  try {
    await harness.session.prompt('/goal Reply with exactly: "Required phrase"');
    await waitFor(() => harness.faux.state.callCount === 4, "no-progress safety pause");
    await harness.session.agent.waitForIdle();
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(harness.faux.state.callCount, 4);
    assert.equal(persistedGoalStatus(harness.session), "paused");
    assert.equal(persistedGoalState(harness.session)?.goal?.safetyPauseCause, "no_progress");
    assert.equal(persistedGoalState(harness.session)?.goal?.toolFreeRepeatCount, 3);
    assert.equal(
      harness.session.messages.map(userMessageText).filter((text) => text.includes("pi-goal-continuation:")).length,
      3,
    );
  } finally {
    await harness.cleanup();
  }
}

async function automaticToolLoopLimitScenario() {
  const observedSignals = [];
  const toolResponse = (_context, options) => {
    observedSignals.push(options?.signal?.aborted === true);
    return fauxAssistantMessage(fauxToolCall("budget_probe", {}));
  };
  const harness = await createHarness(
    [
      fauxAssistantMessage("Start automatic work."),
      toolResponse,
      toolResponse,
      toolResponse,
      (_context, options) => {
        observedSignals.push(options?.signal?.aborted === true);
        assert.equal(options?.signal?.aborted, true);
        return fauxAssistantMessage("Synthetic aborted cleanup.");
      },
    ],
    {},
    undefined,
    { continuationLimits: { automaticTurns: 3, noProgressTurns: null } },
  );
  try {
    await harness.session.prompt("/goal bounded automatic tool loop");
    await harness.session.agent.waitForIdle();
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(persistedGoalStatus(harness.session), "paused");
    assert.equal(persistedGoalState(harness.session)?.goal?.safetyPauseCause, "continuation_limit");
    assert.equal(persistedGoalState(harness.session)?.goal?.automaticModelTurns, 3);
    assert.equal(harness.lifecycleEvents.filter((event) => event === "budget_probe_execute").length, 3);
    assert.deepEqual(observedSignals.slice(0, 3), [false, false, false]);
    assert.ok(observedSignals.length <= 4);
    if (observedSignals.length === 4) assert.equal(observedSignals[3], true);
    assert.ok(harness.faux.state.callCount <= 5);
  } finally {
    await harness.cleanup();
  }
}

async function retryAtHardLimitScenario() {
  const observedSignals = [];
  const harness = await createHarness(
    [
      fauxAssistantMessage("Initial unfinished result."),
      (_context, options) => {
        observedSignals.push(options?.signal?.aborted === true);
        return fauxAssistantMessage("", {
          stopReason: "error",
          errorMessage: "HTTP 524: transient upstream timeout",
        });
      },
      (_context, options) => {
        observedSignals.push(options?.signal?.aborted === true);
        assert.equal(options?.signal?.aborted, true);
        return fauxAssistantMessage("Guard-owned aborted retry cleanup.");
      },
    ],
    {},
    undefined,
    { continuationLimits: { automaticTurns: 1, noProgressTurns: null } },
    {
      compaction: { enabled: false },
      retry: { enabled: true, maxRetries: 1, baseDelayMs: 0 },
    },
  );
  try {
    await harness.session.prompt("/goal retry cannot cross hard limit");
    await harness.session.agent.waitForIdle();
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(persistedGoalStatus(harness.session), "paused");
    assert.equal(persistedGoalState(harness.session)?.goal?.safetyPauseCause, "continuation_limit");
    assert.equal(persistedGoalState(harness.session)?.goal?.automaticModelTurns, 1);
    assert.deepEqual(observedSignals.slice(0, 1), [false]);
    assert.ok(observedSignals.length <= 2, "hard limit allows at most one cleanup provider call");
    if (observedSignals.length === 2) assert.equal(observedSignals[1], true);
    assert.equal(harness.faux.state.callCount, observedSignals.length + 1);
  } finally {
    await harness.cleanup();
  }
}

async function automaticRetryOwnershipScenario() {
  const harness = await createHarness(
    [
      fauxAssistantMessage("Initial unfinished result."),
      fauxAssistantMessage("", {
        stopReason: "error",
        errorMessage: "HTTP 524: transient upstream timeout",
      }),
      fauxAssistantMessage("Recovered provider response."),
      completionResponse,
    ],
    {},
    undefined,
    { continuationLimits: { automaticTurns: 3, noProgressTurns: null } },
    {
      compaction: { enabled: false },
      retry: { enabled: true, maxRetries: 1, baseDelayMs: 0 },
    },
  );
  try {
    await harness.session.prompt("/goal runtime retry ownership smoke");
    await waitFor(() => harness.faux.state.callCount === 4, "provider retry and continuation");
    await harness.session.agent.waitForIdle();
    assert.equal(persistedGoalStatus(harness.session), null);
    assert.ok(
      persistedGoalHistory(harness.session).some((goal) => goal.automaticModelTurns === 2 && goal.status === "active"),
      "retry response must retain automatic ownership",
    );
    assert.ok(
      harness.lifecycleEvents.filter((event) => event === "agent_start").length >= 3,
      "expected retry to emit agent_start",
    );
  } finally {
    await harness.cleanup();
  }
}

async function queuedInputScenario() {
  const observedPrompts = [];
  const harness = await createHarness(
    [
      (context) => {
        observedPrompts.push(context.messages.map(userMessageText).filter(Boolean).at(-1) ?? "");
        return fauxAssistantMessage("x".repeat(120));
      },
      (context) => {
        observedPrompts.push(context.messages.map(userMessageText).filter(Boolean).at(-1) ?? "");
        return fauxAssistantMessage("Queued request handled.");
      },
      (context) => {
        observedPrompts.push(context.messages.map(userMessageText).filter(Boolean).at(-1) ?? "");
        return completionResponse(context);
      },
    ],
    { tokensPerSecond: 200, tokenSize: { min: 1, max: 1 } },
  );
  try {
    await harness.session.prompt("/goal queued work smoke");
    await waitFor(() => harness.session.isStreaming, "initial turn streaming");
    await harness.session.prompt("queued user work", { streamingBehavior: "followUp" });
    await waitFor(() => harness.faux.state.callCount === 3, "continuation after queued input");
    await harness.session.agent.waitForIdle();
    const queuedIndex = observedPrompts.findIndex((text) => text.includes("queued user work"));
    const continuationIndex = observedPrompts.findIndex((text) => text.includes("pi-goal-continuation:"));
    assert.ok(queuedIndex >= 0, "expected queued work to reach the model");
    assert.ok(continuationIndex > queuedIndex, "continuation must yield to queued work");
  } finally {
    await harness.cleanup();
  }
}

async function busyEditOwnershipScenario() {
  const harness = await createHarness(
    [
      fauxAssistantMessage("x".repeat(120)),
      fauxAssistantMessage("Edited objective handled in the current run."),
      completionResponse,
    ],
    { tokensPerSecond: 200, tokenSize: { min: 1, max: 1 } },
  );
  try {
    await harness.session.prompt("/goal original busy objective");
    await waitFor(() => harness.session.isStreaming, "busy goal turn");
    await harness.session.prompt("/goal edit revised busy objective");
    await waitFor(() => harness.faux.state.callCount === 3, "edited-goal continuation");
    await harness.session.agent.waitForIdle();
    assert.equal(persistedGoalStatus(harness.session), null);
    assert.ok(
      harness.session.messages.map(userMessageText).some((text) => text.includes("updated objective supersedes")),
    );
  } finally {
    await harness.cleanup();
  }
}

async function pauseScenario() {
  const harness = await createHarness([fauxAssistantMessage("x".repeat(200))], {
    tokensPerSecond: 100,
    tokenSize: { min: 1, max: 1 },
  });
  try {
    await harness.session.prompt("/goal interrupt runtime smoke");
    await waitFor(() => harness.session.isStreaming, "goal turn streaming");
    await harness.session.prompt("/goal pause");
    await waitFor(() => !harness.session.isStreaming, "goal turn abort");
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.ok(
      harness.faux.state.callCount <= 1,
      "an interrupted stream may stop before Faux records its completed call",
    );
    assert.equal(persistedGoalStatus(harness.session), "paused");
    assert.equal(
      harness.session.messages.map(userMessageText).filter((text) => text.includes("pi-goal-continuation:")).length,
      0,
    );
  } finally {
    await harness.cleanup();
  }
}

async function staleBlockedToolAbortScenario() {
  const observedSignals = [];
  const harness = await createHarness([
    fauxAssistantMessage("", {
      stopReason: "error",
      errorMessage: "Unauthorized: invalid API key",
    }),
    fauxAssistantMessage(fauxToolCall("budget_probe", {})),
    (_context, options) => {
      observedSignals.push(options?.signal?.aborted === true);
      return fauxAssistantMessage("Synthetic stale-turn cleanup.");
    },
  ]);
  try {
    await harness.session.prompt("/goal stale blocked-tool runtime smoke");
    await harness.session.agent.waitForIdle();
    assert.equal(persistedGoalStatus(harness.session), "blocked");

    // Bypass the normal input boundary to model provider-owned stale work that
    // arrives after the interrupted goal has already installed its tool guard.
    await harness.session.agent.prompt("Simulate a stale provider-owned turn.");
    await harness.session.agent.waitForIdle();
    assert.ok(harness.faux.state.callCount <= 3, "stale guard must allow at most one cleanup call");
    assert.equal(observedSignals.includes(false), false, "any cleanup call must inherit abort");
    assert.equal(harness.lifecycleEvents.filter((event) => event === "budget_probe_execute").length, 0);
  } finally {
    await harness.cleanup();
  }
}

async function budgetBoundaryScenario() {
  const harness = await createHarness([fauxAssistantMessage(fauxToolCall("budget_probe", {}))]);
  try {
    await harness.session.prompt("/goal --tokens 1 budget boundary runtime smoke");
    await harness.session.agent.waitForIdle();
    assert.equal(harness.faux.state.callCount, 1, "budget stop must not queue another model call");
    assert.equal(
      harness.session.messages.some(
        (message) => message.role === "custom" && message.customType === "goal-budget-wrap-up",
      ),
      false,
    );
    assert.equal(persistedGoalStatus(harness.session), "budget_limited");
    assert.equal(harness.lifecycleEvents.filter((event) => event === "tool_execution_end").length, 1);
    assert.ok(
      harness.lifecycleEvents.indexOf("assistant_message_end") < harness.lifecycleEvents.indexOf("tool_execution_end"),
      "assistant message must finalize before tool_execution_end",
    );
  } finally {
    await harness.cleanup();
  }
}

async function budgetViolationScenario() {
  const harness = await createHarness([fauxAssistantMessage(fauxToolCall("budget_probe", {}))]);
  try {
    await harness.session.prompt("/goal --tokens 1 stop budget tools at runtime");
    await harness.session.agent.waitForIdle();
    assert.equal(harness.faux.state.callCount, 1, "budget guard must not queue cleanup work");
    assert.equal(harness.lifecycleEvents.filter((event) => event === "budget_probe_execute").length, 1);
    assert.equal(persistedGoalStatus(harness.session), "budget_limited");
  } finally {
    await harness.cleanup();
  }
}

async function budgetAgentEndFallbackScenario() {
  const harness = await createHarness([fauxAssistantMessage("No-tool budget response.")]);
  try {
    await harness.session.prompt("/goal --tokens 1 no-tool budget runtime smoke");
    await harness.session.agent.waitForIdle();
    assert.equal(harness.faux.state.callCount, 1);
    assert.equal(persistedGoalStatus(harness.session), "budget_limited");
  } finally {
    await harness.cleanup();
  }
}

async function managedRunRpcScenario() {
  const runId = crypto.randomUUID();
  const harness = await createHarness(
    [completionResponse],
    {},
    undefined,
    { rpc: { enabled: true } },
    {},
    { runId, objective: "complete a managed runtime run" },
  );
  try {
    await waitFor(
      () => harness.managedRunEvents.some((event) => event.status === "complete"),
      "managed run completion",
    );
    await harness.session.agent.waitForIdle();
    assert.deepEqual(
      harness.managedRunEvents.filter((event) => event.type === "state").map((event) => event.status),
      ["active", "complete"],
    );
    assert.equal(
      harness.managedRunEvents.filter((event) => event.type === "state" && event.status !== "active").length,
      1,
    );
  } finally {
    await harness.cleanup();
  }
}

async function managedRunDisabledScenario() {
  const runId = crypto.randomUUID();
  const harness = await createHarness([], {}, undefined, undefined, {}, { runId, objective: "must stay disabled" });
  try {
    await waitFor(() => harness.managedRunEvents.length > 0, "managed run disabled rejection");
    assert.deepEqual(harness.managedRunEvents, [
      {
        type: "error",
        runId,
        operation: "start",
        error: { code: "RPC_DISABLED", message: "Managed run RPC is disabled." },
      },
    ]);
    assert.equal(harness.faux.state.callCount, 0);
  } finally {
    await harness.cleanup();
  }
}

async function manualCompactionScenario() {
  const now = Date.now();
  const harness = await createHarness(
    [fauxAssistantMessage("Compacted prior work."), completionResponse],
    {},
    (sessionManager) => {
      sessionManager.appendMessage({
        role: "user",
        content: [{ type: "text", text: `Old request ${"x".repeat(100_000)}` }],
        timestamp: now - 4_000,
      });
      sessionManager.appendMessage(fauxAssistantMessage(`Old result ${"y".repeat(100_000)}`));
      sessionManager.appendMessage({
        role: "user",
        content: [{ type: "text", text: "Recent request" }],
        timestamp: now - 2_000,
      });
      sessionManager.appendMessage(fauxAssistantMessage("Recent result"));
      sessionManager.appendCustomEntry("goal-state", {
        goal: {
          id: crypto.randomUUID(),
          text: "finish after manual compaction",
          status: "active",
          startedAt: now - 1_000,
          updatedAt: now - 1_000,
          iteration: 1,
          tokensUsed: 0,
          timeUsedSeconds: 1,
          baselineTokens: 0,
        },
      });
    },
  );
  const events = [];
  const unsubscribe = harness.session.subscribe((event) => events.push(event));
  try {
    await harness.session.compact("Summarize for the runtime smoke test.");
    await waitFor(
      () => harness.faux.state.callCount === 2,
      `manual-compaction continuation (${JSON.stringify({
        callCount: harness.faux.state.callCount,
        goalStatus: persistedGoalStatus(harness.session),
        isIdle: harness.session.isIdle,
        events: events.map((event) => event.type),
        extensions: harness.extensions,
        lifecycleEvents: harness.lifecycleEvents,
      })})`,
    );
    await harness.session.agent.waitForIdle();
    assert.equal(persistedGoalStatus(harness.session), null);
    assert.ok(harness.session.messages.map(userMessageText).some((text) => text.includes("pi-goal-continuation:")));
  } finally {
    unsubscribe();
    await harness.cleanup();
  }
}

await agentDirectoryIsolationScenario();
await normalContinuationScenario();
await runawayNoProgressScenario();
await automaticToolLoopLimitScenario();
await retryAtHardLimitScenario();
await automaticRetryOwnershipScenario();
await queuedInputScenario();
await busyEditOwnershipScenario();
await pauseScenario();
await staleBlockedToolAbortScenario();
await budgetBoundaryScenario();
await budgetViolationScenario();
await budgetAgentEndFallbackScenario();
await managedRunRpcScenario();
await managedRunDisabledScenario();
await manualCompactionScenario();
console.log(
  "pi-goal runtime smoke: normal, runaway guards, retry and busy-edit ownership, queued input, pause, stale blocked-tool aborts, managed-run RPC, terminal budget stops, and manual compaction passed",
);
