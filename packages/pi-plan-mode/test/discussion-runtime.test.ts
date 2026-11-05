import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  createFauxCore,
  fauxAssistantMessage,
  fauxToolCall,
  getCurrentSystemPrompt,
  getCurrentTools,
  InMemoryCredentialStore,
  type TranscriptContext,
} from "@earendil-works/pi-ai";
import {
  createAgentSession,
  DefaultResourceLoader,
  type ExtensionFactory,
  type ExtensionUIContext,
  ModelRegistry,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type TerminalInputHandler,
  type ToolExecutionEndEvent,
} from "@earendil-works/pi-coding-agent";
import { getKeybindings, isKittyProtocolActive, setKeybindings, setKittyProtocolActive } from "@earendil-works/pi-tui";
import { createTuiHarness } from "@narumitw/pi-tui-kit/testing";
import { Type } from "typebox";
import { test } from "vitest";
import { createMockContext } from "./support.js";

const QUESTION = {
  questions: [
    {
      id: "scope",
      header: "Scope",
      question: "How broad should the change be?",
      options: [
        { label: "Small", description: "Only fix the bug." },
        { label: "Broad", description: "Also clean up related code." },
      ],
    },
  ],
};
const F2 = "\u001bOQ";
const NESTED = "discussion_fixture_nested";
const SIBLING = "discussion_fixture_sibling";
const NEXT_TEXT = "We can discuss the trade-offs in plain text. Which constraint matters most?";
const PLAN = "# Discussion plan\n\n1. Apply the agreed fix.\n2. Run the focused tests.";
type Scenario = "standalone" | "parallel" | "nested";
type Session = Awaited<ReturnType<typeof createAgentSession>>["session"];

interface RequestEvidence {
  aborted: boolean;
  systemPrompt: string;
  tools: unknown;
  messages: TranscriptContext["messages"];
}

async function withRuntime(
  run: (fixture: Awaited<ReturnType<typeof createRuntime>>) => Promise<void>,
  options: { queued?: boolean } = {},
) {
  const fixture = await createRuntime(options);
  try {
    await run(fixture);
  } finally {
    await fixture.dispose();
  }
}

async function createRuntime(options: { queued?: boolean }) {
  const root = await mkdtemp(join(tmpdir(), "pi-plan-discussion-runtime-"));
  const agentDir = join(root, "agent");
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  const previousKeys = getKeybindings();
  const previousKitty = isKittyProtocolActive();
  let session: Session | undefined;
  let tui: ReturnType<typeof createTuiHarness> | undefined;
  const listeners = new Set<TerminalInputHandler>();
  const errors: unknown[] = [];
  const ends: ToolExecutionEndEvent[] = [];
  const settled: boolean[] = [];
  const requests: RequestEvidence[] = [];
  const streamAttempts: boolean[] = [];
  const restored: Array<{ steering: string[]; followUp: string[] }> = [];
  const abortTasks: Promise<void>[] = [];
  let abortCount = 0;
  let dialogCount = 0;

  async function dispose() {
    try {
      // A failed assertion must also release an open questionnaire and active run.
      if (session) {
        await session.abort();
        await Promise.all(abortTasks);
        await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
        assert.equal(listeners.size, 0, "shutdown releases all Plan terminal listeners");
        assert.equal(tui?.isOpen, false, "shutdown releases the owned questionnaire");
      }
    } finally {
      tui?.dispose();
      session?.dispose();
      setKeybindings(previousKeys);
      setKittyProtocolActive(previousKitty);
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
      await rm(root, { recursive: true, force: true });
    }
  }

  try {
    await mkdir(agentDir);
    await writeFile(
      join(agentDir, "pi-plan-mode.json"),
      JSON.stringify({ defaultPlanTools: ["read", NESTED, SIBLING] }),
    );
    // Set the directory before Jiti imports Plan and its module-cached paths.
    process.env.PI_CODING_AGENT_DIR = agentDir;
    setKittyProtocolActive(false);
    // Use the public host registry. A second AppKeys runtime would not be the
    // registry used by the generated extension loaded through Pi's Jiti loader.
    tui = createTuiHarness({ width: 80, rows: 30, keybindings: getKeybindings() });
    const harness = tui;
    const uiHost = createMockContext({
      editorText: "existing main draft",
      custom: harness.custom,
      onTerminalInput(listener: TerminalInputHandler) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      select: async () => {
        dialogCount += 1;
        return undefined;
      },
    });
    // Only UI is substituted. AgentSession supplies every extension/tool context,
    // signal, lifecycle event, session entry, and model-loop decision below.
    const ui = (uiHost.ctx as { ui: ExtensionUIContext }).ui;
    const support: ExtensionFactory = (pi) => {
      pi.registerTool({
        name: SIBLING,
        label: "Discussion sibling fixture",
        description: "Return a read-only result without terminating the tool batch.",
        parameters: Type.Object({}),
        async execute() {
          return { content: [{ type: "text", text: "Sibling completed." }], details: { sibling: true } };
        },
      });
      pi.registerTool({
        name: NESTED,
        label: "Nested discussion fixture",
        description: "Call the Plan question through the public nested tool pipeline.",
        parameters: Type.Object({}),
        async execute(_id, _params, signal, _update, ctx) {
          const nested = await ctx.executeTool("plan_mode_question", QUESTION, { signal });
          // Deliberately do not propagate terminate: nested termination alone
          // cannot stop this model-issued outer call.
          return { content: nested.result.content, details: { nested: nested.result.details } };
        },
      });
      pi.on("tool_execution_end", (event) => {
        ends.push(event);
      });
      pi.on("agent_settled", (event) => {
        settled.push(event.aborted);
      });
    };
    const faux = createFauxCore({
      api: `plan-discussion-${crypto.randomUUID()}`,
      provider: `plan-discussion-${crypto.randomUUID()}`,
      models: [{ id: "discussion-fixture", contextWindow: 100_000, maxTokens: 4_000 }],
      tokenSize: { min: 100_000, max: 100_000 },
    });
    const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null });
    const registry = new ModelRegistry(runtime);
    registry.registerProvider(faux.provider, {
      api: faux.api,
      apiKey: "local-fixture",
      baseUrl: "http://localhost:0",
      streamSimple(model, context, streamOptions) {
        requests.push({
          aborted: streamOptions?.signal?.aborted === true,
          systemPrompt: getCurrentSystemPrompt(context.messages),
          tools: JSON.parse(JSON.stringify(getCurrentTools(context.messages))),
          messages: structuredClone(context.messages),
        });
        return faux.streamSimple(model, context, streamOptions);
      },
      models: faux.models,
    });
    const model = registry.find(faux.provider, "discussion-fixture");
    assert.ok(model);
    const settingsManager = SettingsManager.inMemory({
      compaction: { enabled: false },
      retry: { enabled: false },
    });
    const loader = new DefaultResourceLoader({
      cwd: root,
      agentDir,
      settingsManager,
      noExtensions: true,
      noSkills: true,
      noContextFiles: true,
      additionalExtensionPaths: [resolve("packages/pi-plan-mode")],
      extensionFactories: [support],
    });
    await loader.reload();
    assert.deepEqual(loader.getExtensions().errors, []);
    const created = await createAgentSession({
      cwd: root,
      agentDir,
      modelRuntime: runtime,
      model,
      settingsManager,
      resourceLoader: loader,
      sessionManager: SessionManager.inMemory(root),
    });
    session = created.session;
    const live = session;
    const stream = live.agent.streamFunction;
    live.agent.streamFunction = (requestModel, context, streamOptions) => {
      streamAttempts.push(streamOptions?.signal?.aborted === true);
      return stream(requestModel, context, streamOptions);
    };
    await live.bindExtensions({
      mode: "tui",
      uiContext: ui,
      onError: (error) => errors.push(error),
      // Mirror InteractiveMode.restoreQueuedMessagesToEditor using only public
      // session APIs. This tests queue semantics, not a physical terminal/editor.
      ...(options.queued
        ? {
            abortHandler: () => {
              abortCount += 1;
              const queued = live.clearQueue();
              restored.push(queued);
              const text = [...queued.steering, ...queued.followUp, ui.getEditorText()]
                .filter((part) => part.trim())
                .join("\n\n");
              ui.setEditorText(text);
              abortTasks.push(live.abort());
            },
          }
        : {}),
    });
    await live.prompt("/plan start");
    assert.equal(faux.state.callCount, 0);
    assert.equal(harness.openCount, 0);
    assert.equal(listeners.size, 1, "only the session input guard is installed while idle");

    return {
      session: live,
      faux,
      tui: harness,
      ui,
      listeners,
      errors,
      ends,
      settled,
      requests,
      streamAttempts,
      restored,
      async toggleInteraction() {
        const shortcut = loader
          .getExtensions()
          .extensions.flatMap((extension) => [...extension.shortcuts.values()])
          .find((candidate) => candidate.description === "Toggle Plan questionnaires and free discussion");
        assert.ok(shortcut);
        await shortcut.handler(live.extensionRunner.createCommandContext());
      },
      get abortCount() {
        return abortCount;
      },
      get dialogCount() {
        return dialogCount;
      },
      dispose,
    };
  } catch (error) {
    await dispose();
    throw error;
  }
}

type Fixture = Awaited<ReturnType<typeof createRuntime>>;

async function switchQuestionToDiscussion(f: Fixture, scenario: Scenario, queued = false) {
  const calls =
    scenario === "nested"
      ? [fauxToolCall(NESTED, {}, { id: "outer-question" })]
      : [
          fauxToolCall("plan_mode_question", QUESTION, { id: "direct-question" }),
          ...(scenario === "parallel" ? [fauxToolCall(SIBLING, {}, { id: "sibling" })] : []),
        ];
  f.faux.setResponses([
    fauxAssistantMessage(calls, { stopReason: "toolUse" }),
    fauxAssistantMessage("Unexpected automatic continuation."),
  ]);
  const active = f.session.getActiveToolNames();
  const prompt = f.session.prompt("Ask about the plan scope.");
  try {
    await Promise.race([
      f.tui.waitForOpen(),
      prompt.then(() => {
        throw new Error(`The ${scenario} run settled without opening its questionnaire`);
      }),
    ]);
    assert.match(f.tui.render().join("\n"), /How broad should the change be/);
    assert.equal(f.listeners.size, 2, "the questionnaire adds its scoped F2 listener");
    if (queued) {
      assert.equal(await f.session.followUp("queued user follow-up"), "queued");
      assert.equal(f.session.pendingMessageCount, 1);
    }
    let consumed = false;
    // Pi delivers raw terminal listeners before registered editor shortcuts.
    // Do not send F2 directly to the questionnaire component.
    for (const listener of [...f.listeners]) {
      if (listener(F2)?.consume) {
        consumed = true;
        break;
      }
    }
    assert.equal(consumed, true);
    await prompt;
  } finally {
    if (!f.session.isIdle) await f.session.abort();
    await prompt;
  }
  assert.equal(f.session.isIdle, true);
  assert.deepEqual(f.settled, [true], "the actual run settles as aborted");
  assert.equal(f.tui.openCount, 1, "no automatic questionnaire or ready menu opens");
  assert.equal(f.tui.isOpen, false);
  assert.equal(f.dialogCount, 0);
  assert.equal(f.listeners.size, 1, "the scoped questionnaire listener is removed");
  assert.deepEqual(f.session.getActiveToolNames(), active);
  assert.equal(f.requests.filter((request) => !request.aborted).length, 1);
  assert.equal(f.faux.state.callCount, f.requests.length);
  // Installed Pi stops a uniformly terminating batch without another stream.
  // Mixed/nested batches enter the SDK stream once with an ALREADY aborted
  // signal. ModelRuntime rejects auth preparation before invoking faux; Pi's
  // lazyStream currently classifies that setup AbortError as an error response.
  assert.deepEqual(
    f.requests.map((request) => request.aborted),
    [false],
  );
  assert.deepEqual(f.streamAttempts, scenario === "standalone" ? [false] : [false, true]);
  const assistants = f.session.messages.filter((message) => message.role === "assistant");
  assert.equal(assistants.length, scenario === "standalone" ? 1 : 2);
  if (scenario !== "standalone") {
    assert.equal(assistants.at(-1)?.stopReason, "error");
    assert.match(assistants.at(-1)?.errorMessage ?? "", /abort/i);
    assert.deepEqual(assistants.at(-1)?.content, []);
  }
  const question = f.ends.find((event) => event.toolName === "plan_mode_question");
  assert.ok(question);
  assert.equal(question.isError, false);
  assert.equal(question.result.terminate, true);
  assert.deepEqual(question.result.details, {
    cancelled: true,
    reason: "discussion_requested",
    questions: QUESTION.questions,
  });
  if (scenario === "parallel") {
    const sibling = f.ends.find((event) => event.toolName === SIBLING);
    assert.ok(sibling);
    assert.equal(sibling.isError, false);
    assert.notEqual(sibling.result.terminate, true);
  }
  const branch = f.session.sessionManager.getBranch();
  const state = branch.findLast((entry) => entry.type === "custom" && entry.customType === "plan-mode-state");
  assert.ok(state?.type === "custom");
  assert.equal((state.data as { interactionMode: string }).interactionMode, "discussion");
  const contracts = branch.filter(
    (entry) => entry.type === "custom_message" && entry.customType === "plan-mode-interaction",
  );
  assert.equal(contracts.length, 2, "activation and the user transition are persisted once each");
  assert.match(JSON.stringify(contracts.at(-1)), /DISCUSSION/);
  if (scenario === "nested") {
    assert.equal(question.parentToolCallId, "outer-question");
    assert.equal(question.toolCallId, "outer-question/1");
    // Pi does not persist a nested tool result as a model-visible tool message.
    // The independent persisted interaction contract must survive the outer call.
    assert.equal(
      f.session.messages.some((message) => message.role === "toolResult" && message.toolName === "plan_mode_question"),
      false,
    );
  } else {
    const result = f.session.messages.find(
      (message) => message.role === "toolResult" && message.toolName === "plan_mode_question",
    );
    assert.ok(result?.role === "toolResult");
    assert.deepEqual(result.details, question.result.details);
  }
  assert.deepEqual(f.errors, []);
}

async function assertNextPlainTextTurn(f: Fixture) {
  const active = f.session.getActiveToolNames();
  const previousRequests = f.requests.length;
  f.faux.setResponses([fauxAssistantMessage(NEXT_TEXT)]);
  await f.session.prompt("Let us discuss the constraints instead.");
  assert.equal(f.requests.length, previousRequests + 1, "ordinary text does not trigger a finalization retry");
  assert.equal(f.requests.at(-1)?.aborted, false);
  assert.equal(f.session.getLastAssistantText(), NEXT_TEXT);
  assert.equal(f.session.isIdle, true);
  assert.equal(f.tui.openCount, 1);
  assert.equal(f.dialogCount, 0);
  assert.deepEqual(f.session.getActiveToolNames(), active);
  assert.deepEqual(f.requests.at(-1)?.tools, f.requests[0]?.tools);
  assert.equal(f.requests.at(-1)?.systemPrompt, f.requests[0]?.systemPrompt);
  assert.match(JSON.stringify(f.requests.at(-1)?.messages), /PI PLAN MODE INTERACTION CONTRACT v1: DISCUSSION/);
  assert.deepEqual(f.errors, []);
}

test("real Pi restores a durably committed interaction when fire-and-forget publication rejects", async () => {
  await withRuntime(async (f) => {
    const original = f.session.sendCustomMessage.bind(f.session);
    const failure = Promise.withResolvers<void>();
    const unsubscribe = f.session.extensionRunner.onError((error) => {
      if (error.event === "send_message") failure.resolve();
    });
    f.session.sendCustomMessage = async (message, options) => {
      if (message.customType === "plan-mode-interaction") throw new Error("fixture asynchronous publication failure");
      return original(message, options);
    };
    try {
      await f.toggleInteraction();
      await failure.promise;
      const latestState = () =>
        f.session.sessionManager
          .getBranch()
          .findLast((entry) => entry.type === "custom" && entry.customType === "plan-mode-state");
      assert.match(JSON.stringify(latestState()), /discussion/);
      for (const prompt of ["Discuss the first constraint.", "Discuss the next constraint."]) {
        f.faux.setResponses([fauxAssistantMessage(NEXT_TEXT)]);
        await f.session.prompt(prompt);
        assert.equal(f.session.getLastAssistantText(), NEXT_TEXT);
        assert.equal(f.tui.openCount, 0);
        assert.match(JSON.stringify(f.requests.at(-1)?.messages), /PI PLAN MODE INTERACTION CONTRACT v1: DISCUSSION/);
      }
      assert.equal(f.requests.length, 2);
      const normalize = (messages: TranscriptContext["messages"]) =>
        messages.map(({ role, content }) => ({ role, content }));
      const first = normalize(f.requests[0]?.messages ?? []);
      assert.deepEqual(normalize(f.requests[1]?.messages ?? []).slice(0, first.length), first);
      assert.match(JSON.stringify(latestState()), /interactionRestorations/);
      assert.equal(
        f.errors.length,
        2,
        "transition and one restoration report transport failures; ordinary turns do not republish",
      );
      const discussionPrefix = normalize(f.requests.at(-1)?.messages ?? []);
      await f.toggleInteraction();
      f.faux.setResponses([fauxAssistantMessage("Questionnaires are enabled for the next decision.")]);
      await f.session.prompt("Reconsider the remaining decision.");
      const questionPrefix = normalize(f.requests.at(-1)?.messages ?? []);
      assert.deepEqual(questionPrefix.slice(0, discussionPrefix.length), discussionPrefix);
      await f.session.prompt("/plan exit");
      f.faux.setResponses([fauxAssistantMessage("Normal conversation continues.")]);
      await f.session.prompt("Continue outside Plan mode.");
      assert.deepEqual(normalize(f.requests.at(-1)?.messages ?? []).slice(0, questionPrefix.length), questionPrefix);
      assert.equal(f.errors.length, 4, "each mode restores once; exit retains prior virtual contracts");
    } finally {
      f.session.sendCustomMessage = original;
      unsubscribe();
    }
  });
});

for (const scenario of ["standalone", "parallel", "nested"] as const) {
  test(`real Pi ${scenario} question stops on F2 and the next user turn stays plain text`, async () => {
    await withRuntime(async (f) => {
      await switchQuestionToDiscussion(f, scenario);
      assert.equal(f.ui.getEditorText(), "existing main draft");
      await assertNextPlainTextTurn(f);
    });
  });
}

test("real Pi abort with the public TUI queue policy restores rather than runs queued follow-up", async () => {
  await withRuntime(
    async (f) => {
      await switchQuestionToDiscussion(f, "standalone", true);
      assert.equal(f.abortCount, 1);
      assert.deepEqual(f.restored, [{ steering: [], followUp: ["queued user follow-up"] }]);
      assert.equal(f.session.pendingMessageCount, 0);
      assert.equal(f.ui.getEditorText(), "queued user follow-up\n\nexisting main draft");
      assert.equal(
        f.session.messages.some(
          (message) => message.role === "user" && JSON.stringify(message.content).includes("queued user follow-up"),
        ),
        false,
      );
      await assertNextPlainTextTurn(f);
    },
    { queued: true },
  );
});

test("real Pi discussion rejects a fresh questionnaire and saves a ready plan without opening a menu", async () => {
  await withRuntime(async (f) => {
    await switchQuestionToDiscussion(f, "standalone");
    f.faux.setResponses([
      fauxAssistantMessage(fauxToolCall("plan_mode_question", QUESTION)),
      fauxAssistantMessage("We can continue without a questionnaire."),
    ]);
    await f.session.prompt("Discuss another decision.");
    const paused = f.ends.findLast((event) => event.toolName === "plan_mode_question");
    assert.ok(paused);
    assert.equal((paused.result.details as { reason: string }).reason, "questions_paused");
    assert.equal(f.tui.openCount, 1);
    f.faux.setResponses([
      fauxAssistantMessage(fauxToolCall("plan_mode_complete", { plan: PLAN })),
      fauxAssistantMessage("The decision-ready plan is saved."),
    ]);
    await f.session.prompt("Save the agreed plan.");
    const state = f.session.sessionManager
      .getBranch()
      .findLast((entry) => entry.type === "custom" && entry.customType === "plan-mode-state");
    assert.ok(state?.type === "custom");
    assert.equal((state.data as { latestPlan: string }).latestPlan, PLAN);
    assert.equal((state.data as { awaitingAction: boolean }).awaitingAction, true);
    assert.equal(f.tui.openCount, 1, "ready completion must not claim UI focus in discussion");
    assert.equal(f.dialogCount, 0);
    await assertNextPlainTextTurn(f);
  });
});
