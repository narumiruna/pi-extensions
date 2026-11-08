import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createFauxCore, fauxAssistantMessage, fauxToolCall, InMemoryCredentialStore } from "@earendil-works/pi-ai";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRegistry,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const extensionPath = resolve(import.meta.dirname, "../../src/goal.ts");

export async function createHarness(
  responses,
  fauxOptions = {},
  prepareSession,
  goalSettings,
  piSettings = {},
  managedRun,
) {
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
      await createdSession?.abort();
      // SDK dispose invalidates contexts but does not emit extension shutdown.
      // Exercise the public lifecycle before disposal so owned waits are released.
      await createdSession?.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
    } finally {
      try {
        createdSession?.dispose();
      } finally {
        try {
          await rm(root, { recursive: true, force: true });
        } finally {
          restoreAgentDir();
        }
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
    let cancelManagedRun;

    const settingsManager = SettingsManager.inMemory({
      compaction: { enabled: false },
      retry: { enabled: false },
      ...piSettings,
    });
    const lifecycleEvents = [];
    const compactionEvents = [];
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
              cancelManagedRun = (reason) => pi.events.emit("pi-goal:cancel", { runId: managedRun.runId, reason });
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
            pi.on("session_before_compact", (event) => {
              lifecycleEvents.push("session_before_compact");
              compactionEvents.push(event);
            });
            pi.on("session_compact", (event, ctx) => {
              lifecycleEvents.push(
                `session_compact:idle=${ctx.isIdle()}:pending=${ctx.hasPendingMessages()}:reason=${event.reason}:willRetry=${event.willRetry}`,
              );
              compactionEvents.push(event);
            });
            pi.on("session_compact_failed", (event) => compactionEvents.push(event));
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
    // SDK retry events are observations only; they are not extension events.
    const sdkEvents = [];
    result.session.subscribe((event) => {
      sdkEvents.push({
        ...event,
        providerCalls: faux.state.callCount,
        continuationCount: continuationMessages(result.session).length,
        goal: structuredClone(persistedGoalState(result.session)?.goal),
      });
    });
    await result.session.bindExtensions({});
    return {
      agentDir,
      cancelManagedRun,
      compactionEvents,
      extensions: result.extensionsResult.extensions.map((extension) => ({
        path: extension.path,
        handlers: [...extension.handlers.keys()],
      })),
      faux,
      lifecycleEvents,
      managedRunEvents,
      sdkEvents,
      session: result.session,
      cleanup: cleanupResources,
    };
  } catch (error) {
    await cleanupResources();
    throw error;
  }
}

export function goalIdFromContext(context) {
  const modelContext = [context.systemPrompt ?? "", ...context.messages.map(modelMessageText)].join("\n");
  const goalId = [...modelContext.matchAll(/<goal_id>\s*([^<\s]+)\s*<\/goal_id>/g)].at(-1)?.[1];
  assert.ok(goalId, "expected goal id in appended Goal context");
  return goalId;
}

export function completionResponse(context) {
  return fauxAssistantMessage(
    fauxToolCall("goal_complete", {
      goal_id: goalIdFromContext(context),
      summary: "Runtime smoke completed and verified.",
    }),
  );
}

export function modelMessageText(message) {
  if (typeof message.content === "string") return message.content;
  if (!Array.isArray(message.content)) return "";
  return message.content
    .filter((part) => part?.type === "text")
    .map((part) => part.text)
    .join("\n");
}

export function userMessageText(message) {
  return message.role === "user" ? modelMessageText(message) : "";
}

export function continuationMessages(session) {
  // Raw history also includes continuation prompts omitted by native compaction.
  return session.sessionManager
    .getBranch()
    .filter((entry) => entry.type === "message")
    .map((entry) => userMessageText(entry.message))
    .filter((text) => text.includes("pi-goal-continuation:"));
}

export function providerError(errorMessage) {
  return fauxAssistantMessage("", { stopReason: "error", errorMessage });
}

export function assertNativeRetries(harness, attempts, success, continuationCount = 0) {
  const starts = harness.sdkEvents.filter((event) => event.type === "auto_retry_start");
  const ends = harness.sdkEvents.filter((event) => event.type === "auto_retry_end");
  assert.deepEqual(
    starts.map((event) => event.attempt),
    attempts,
    "native retry attempts",
  );
  assert.deepEqual(
    ends.map(({ attempt, success }) => ({ attempt, success })),
    attempts.length ? [{ attempt: attempts.at(-1), success }] : [],
    "native retry terminal event",
  );
  for (const event of starts) {
    assert.equal(event.goal?.status, "active", "Goal must not veto a native retry");
    assert.equal(event.goal.waiting, undefined, "Goal must not wait before native recovery settles");
    assert.equal(event.continuationCount, continuationCount, "no extra Goal continuation during native recovery");
  }
}

export function managedRunStatuses(harness) {
  return harness.managedRunEvents.map((event) => event.status);
}

export async function waitForSettlement(harness, description) {
  await waitFor(() => harness.sdkEvents.some((event) => event.type === "agent_settled"), description);
  await harness.session.waitForIdle();
}

export function persistedGoalState(session) {
  return session.sessionManager
    .getBranch()
    .filter((candidate) => candidate.type === "custom" && candidate.customType === "goal-state")
    .at(-1)?.data;
}

export function persistedGoalStatus(session) {
  return persistedGoalState(session)?.goal?.status ?? null;
}

export function persistedGoalHistory(session) {
  return session.sessionManager
    .getBranch()
    .filter((candidate) => candidate.type === "custom" && candidate.customType === "goal-state")
    .map((candidate) => candidate.data?.goal)
    .filter(Boolean);
}

export function assertActiveGoalContract(session, goalId) {
  const contracts = session.sessionManager
    .getBranch()
    .filter((entry) => entry.type === "custom_message" && entry.customType === "goal-contract");
  const activationIndex = contracts.findIndex((entry) => entry.details?.state === "active");
  assert.ok(activationIndex >= 0, "expected the active Goal contract to be persisted");
  assert.ok(
    contracts
      .slice(activationIndex)
      .every((entry) => entry.details?.state === "active" && entry.details.goalId === goalId),
    "waiting must not publish an inactive or replacement Goal contract",
  );
}

export function assertQuietErrorWait(harness, expectedCalls, reasonPattern) {
  const goal = persistedGoalState(harness.session)?.goal;
  assert.equal(goal?.status, "active");
  assert.match(goal.waiting?.reason ?? "", reasonPattern);
  assert.equal(goal.waiting.resumeAt, undefined, "provider wait must not have a deadline");
  assert.equal(harness.faux.state.callCount, expectedCalls, "quiet waiting must not request provider work");
  assert.equal(harness.faux.getPendingResponseCount(), 1, "the completion response must remain unused");
  assert.equal(continuationMessages(harness.session).length, 0, "quiet waiting must not add a Goal continuation");
  assert.equal(harness.session.pendingMessageCount, 0);
  assertActiveGoalContract(harness.session, goal.id);
  const ends = harness.sdkEvents.filter((event) => event.type === "agent_end");
  assert.ok(ends.length > 0);
  for (const event of ends) {
    assert.equal(event.goal?.status, "active", "pending error must remain active before settlement");
    assert.equal(event.goal.waiting, undefined, "waiting must start only at agent_settled");
  }
  const settled = harness.sdkEvents.filter((event) => event.type === "agent_settled");
  assert.deepEqual(
    settled.map((event) => event.providerCalls),
    [expectedCalls],
  );
  assert.equal(settled[0].aborted, false);
  assert.equal(settled[0].goal?.id, goal.id);
  assert.equal(settled[0].goal.status, "active");
  assert.ok(settled[0].goal.waiting, "the settled event must observe active waiting");
  return goal;
}

export async function waitFor(predicate, description, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${description}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

export function seedCompactionHistory(sessionManager, now = Date.now()) {
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
}
