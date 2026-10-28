import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  InMemoryCredentialStore,
  type JsonObject,
} from "@earendil-works/pi-ai";
import type { ExtensionContext, ExtensionFactory, ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import { createRpcHarness, createTuiHarness } from "@narumitw/pi-tui-kit/testing";
import { afterEach, beforeEach, test, vi } from "vitest";
import type { ChildRequest, ChildResult } from "../packages/pi-subagents/src/types.js";

type Consumer = "progress" | "subagents";
type Evidence = { idle: boolean; signal: AbortSignal | undefined };

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function hold() {
  return { entered: deferred(), release: deferred() };
}

type Hold = ReturnType<typeof hold>;
let directory: string;
let cleanup: (() => Promise<void>) | undefined;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "editor-status-cycle-runtime-"));
  vi.stubEnv("PI_CODING_AGENT_DIR", directory);
  vi.stubEnv("PI_SUBAGENT_DEPTH", "0");
  // Extension-owned paths and Pi's theme are module-cached.
  vi.resetModules();
});

afterEach(async () => {
  try {
    await cleanup?.();
  } finally {
    cleanup = undefined;
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    await rm(directory, { recursive: true, force: true });
  }
});

async function createRuntime(consumer: Consumer, observerFirst = false) {
  const { createAgentSession, DefaultResourceLoader, initTheme, ModelRuntime, SessionManager, SettingsManager } =
    await import("@earendil-works/pi-coding-agent");
  initTheme("dark");
  const provider = fauxProvider({ provider: "editor-status-cycle", tokensPerSecond: Infinity });
  const modelRuntime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsPath: null,
    modelsStorePath: join(directory, "models-store.json"),
    refreshOnCreate: false,
  });
  modelRuntime.registerNativeProvider(provider.provider);
  const settingsManager = SettingsManager.inMemory({
    retry: { enabled: false },
    compaction: { enabled: false, keepRecentTokens: 0 },
  });
  const state = {
    starts: 0,
    settled: 0,
    trees: [] as Evidence[],
    treePreparations: [] as Evidence[],
    preparations: [] as Evidence[],
    compactions: [] as (Evidence & { reason: string })[],
    treeHold: undefined as Hold | undefined,
    beforeTreeHold: undefined as Hold | undefined,
    preparationHold: undefined as Hold | undefined,
    compactionHold: undefined as Hold | undefined,
    cancelTree: false,
    cancelCompaction: false,
  };
  const evidence = (ctx: ExtensionContext): Evidence => ({ idle: ctx.isIdle(), signal: ctx.signal });
  let sendCustom: (() => void) | undefined;
  const observer: ExtensionFactory = (pi) => {
    sendCustom = () =>
      pi.sendMessage(
        { customType: "cycle-runtime", content: "Start custom work.", display: false },
        { triggerTurn: true },
      );
    pi.on("agent_start", () => {
      state.starts++;
    });
    pi.on("agent_settled", () => {
      state.settled++;
    });
    pi.on("session_before_tree", async (event, ctx) => {
      state.treePreparations.push(evidence(ctx));
      const gate = state.beforeTreeHold;
      gate?.entered.resolve();
      await gate?.release.promise;
      if (state.cancelTree) return { cancel: true };
      if (event.preparation.userWantsSummary) return { summary: { summary: "Extension branch summary." } };
    });
    pi.on("session_tree", async (_event, ctx) => {
      state.trees.push(evidence(ctx));
      const gate = state.treeHold;
      gate?.entered.resolve();
      await gate?.release.promise;
    });
    pi.on("before_agent_start", async (_event, ctx) => {
      state.preparations.push(evidence(ctx));
      const gate = state.preparationHold;
      gate?.entered.resolve();
      await gate?.release.promise;
    });
    pi.on("session_before_compact", async (event, ctx) => {
      state.compactions.push({ ...evidence(ctx), reason: event.reason });
      const gate = state.compactionHold;
      gate?.entered.resolve();
      await gate?.release.promise;
      if (state.cancelCompaction) return { cancel: true };
      return {
        compaction: {
          summary: "Extension compaction summary.",
          firstKeptEntryId: event.preparation.firstKeptEntryId,
          tokensBefore: event.preparation.tokensBefore,
        },
      };
    });
  };
  const childReady = deferred();
  const children: ChildRequest[] = [];
  let factory: ExtensionFactory;
  if (consumer === "progress") {
    const { default: progress } = await import("../packages/pi-progress/src/progress-widget.js");
    factory = (pi) => progress(pi);
  } else {
    const [{ default: subagents }, { SubagentSettingsStore }, { MessageBroker }] = await Promise.all([
      import("../packages/pi-subagents/src/subagents.js"),
      import("../packages/pi-subagents/src/settings.js"),
      import("../packages/pi-subagents/src/message-broker.js"),
    ]);
    // Only the child transport and its admission checks are replaced. The real
    // session, public hooks, tools, runtime, widget, and menus remain in use.
    vi.spyOn(modelRuntime, "getRegisteredProviderIds").mockReturnValue([]);
    vi.spyOn(modelRuntime, "getProviderAuthStatus").mockReturnValue({ configured: true, source: "environment" });
    factory = (pi) =>
      subagents(pi, {
        settingsStore: new SubagentSettingsStore(join(directory, "pi-subagents.json")),
        createBroker: (onMessage) => {
          const broker = new MessageBroker({ onMessage });
          // No socket is needed: the fake child never uses broker credentials.
          vi.spyOn(broker, "start").mockResolvedValue(undefined);
          vi.spyOn(broker, "assertReady").mockImplementation(() => {});
          return broker;
        },
        runChild: (request) => {
          children.push(request);
          childReady.resolve();
          return new Promise<ChildResult>((resolve) => {
            const finish = () => resolve({ state: "cancelled", limitations: [], truncated: false });
            if (request.signal.aborted) finish();
            else request.signal.addEventListener("abort", finish, { once: true });
          });
        },
      });
  }
  const loader = new DefaultResourceLoader({
    cwd: directory,
    agentDir: directory,
    settingsManager,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    extensionFactories: observerFirst ? [observer, factory] : [factory, observer],
  });
  await loader.reload();
  assert.deepEqual(loader.getExtensions().errors, []);
  const manager = SessionManager.inMemory(directory);
  const tool = consumer === "progress" ? "update_progress" : "subagent_spawn";
  const { session } = await createAgentSession({
    cwd: directory,
    agentDir: directory,
    modelRuntime,
    model: provider.getModel(),
    settingsManager,
    sessionManager: manager,
    resourceLoader: loader,
    tools: [tool],
    thinkingLevel: "off",
  });
  const errors: unknown[] = [];
  const notifications: string[] = [];
  const menuFrames: string[] = [];
  const tui = createTuiHarness({ width: 100, rows: 36 });
  let mounted: (Component & { dispose?(): void }) | undefined;
  let lines: string[] | undefined;
  const widgetTui = { terminal: { rows: 36 }, requestRender() {} } as unknown as TUI;
  const ui: ExtensionUIContext = {
    ...session.extensionRunner.getUIContext(),
    custom: (factory, options) =>
      tui.custom((host, theme, bindings, done) => {
        // Collect callback evidence here; assert only after command completion.
        const component = factory(host, theme, bindings, done);
        return Promise.resolve(component).then((screen) => {
          menuFrames.push(screen.render(100).map(stripVTControlCharacters).join("\n"));
          return screen;
        });
      }, options),
    notify(message) {
      notifications.push(message);
    },
    setWidget(key, content) {
      assert.equal(key, consumer);
      mounted?.dispose?.();
      mounted = undefined;
      lines = undefined;
      if (typeof content === "function") mounted = content(widgetTui, ui.theme);
      else lines = content;
    },
  };
  const pending = new Set<Promise<unknown>>();
  const track = <T>(task: Promise<T>): Promise<T> => {
    pending.add(task);
    void task.then(
      () => pending.delete(task),
      () => pending.delete(task),
    );
    return task;
  };
  cleanup = async () => {
    state.treeHold?.release.resolve();
    state.beforeTreeHold?.release.resolve();
    state.preparationHold?.release.resolve();
    state.compactionHold?.release.resolve();
    tui.dispose();
    try {
      await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
      await Promise.allSettled([...pending]);
      assert.ok(
        children.every((child) => child.signal.aborted),
        "shutdown releases every fake child",
      );
      assert.equal(mounted, undefined, "shutdown clears the owned widget");
      assert.equal(lines, undefined, "shutdown clears RPC widget lines");
      assert.deepEqual(errors, []);
    } finally {
      session.dispose();
      mounted?.dispose?.();
    }
  };
  const rpc =
    consumer === "progress"
      ? createRpcHarness(
          [
            "Widget view",
            "Automatic compaction",
            "Next eligible future user cycle settled",
            undefined,
            undefined,
            "Close",
          ].map((response) => ({ kind: "select" as const, response })),
        )
      : undefined;
  if (rpc) Object.assign(ui, rpc.ui);
  await session.bindExtensions({
    mode: consumer === "progress" ? "rpc" : "tui",
    uiContext: ui,
    onError: (error) => errors.push(error),
  });
  const text = () => (mounted?.render(100) ?? lines ?? []).map(stripVTControlCharacters);
  const taskRow = consumer === "progress" ? /First task/u : /Pending fake child/u;
  const assertExpanded = () => {
    assert.ok(text().length > 2, `expected expanded ${consumer}: ${text().join("\n")}`);
    assert.match(text().join("\n"), taskRow);
  };
  const assertCompact = () => {
    assert.equal(text().length, 2, text().join("\n"));
    assert.doesNotMatch(text().join("\n"), taskRow);
    assert.match(
      text().join("\n"),
      consumer === "progress" ? /Progress · 0\/2 complete/u : /Subagents · 1 active · 1 running · 0 queued/u,
    );
    assert.deepEqual(errors, []);
  };
  const arm = async () => {
    const command = track(session.prompt(`/${consumer}`));
    if (rpc) {
      await command;
      rpc.assertConsumed();
      assert.ok(rpc.dialogs.some((dialog) => dialog.options?.includes("Next eligible future user cycle settled")));
    } else {
      await tui.waitForOpen();
      for (const label of ["Widget view", "Automatic compaction", "Next eligible settled cycle"]) {
        let found = false;
        for (let index = 0; index < 20; index++) {
          if (tui.render().some((line) => stripVTControlCharacters(line).includes(`→ ${label}`))) {
            found = true;
            tui.press("tui.select.confirm");
            await tui.waitForOpen();
            break;
          }
          tui.press("tui.select.down");
        }
        assert.ok(found, `missing menu action: ${label}`);
      }
      tui.press("ctrl+c");
      await command;
      assert.ok(menuFrames.some((frame) => frame.includes("Automatic compaction")));
    }
    assertExpanded();
    assert.deepEqual(notifications, []);
  };
  return {
    session,
    manager,
    provider,
    state,
    children,
    childReady,
    tool,
    track,
    text,
    assertExpanded,
    assertCompact,
    arm,
    startCustom() {
      assert.ok(sendCustom);
      sendCustom();
    },
  };
}

type Runtime = Awaited<ReturnType<typeof createRuntime>>;

async function seed(runtime: Runtime) {
  const args: JsonObject =
    runtime.tool === "update_progress"
      ? {
          steps: [
            { text: "First task", status: "pending" },
            { text: "Second task", status: "pending" },
          ],
        }
      : { task: "Pending fake child", tools: ["read"] };
  runtime.provider.setResponses([
    fauxAssistantMessage(fauxToolCall(runtime.tool, args), { stopReason: "toolUse" }),
    fauxAssistantMessage("Ready."),
  ]);
  await runtime.track(runtime.session.prompt("Prepare the widget."));
  const result = runtime.manager
    .getEntries()
    .find(
      (entry) =>
        entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolName === runtime.tool,
    );
  assert.ok(result?.type === "message" && result.message.role === "toolResult");
  assert.equal(result.message.isError, false);
  if (runtime.tool === "subagent_spawn") await runtime.childReady.promise;
  runtime.assertExpanded();
  return result.id;
}

async function successfulCycle(runtime: Runtime) {
  const starts = runtime.state.starts;
  const settled = runtime.state.settled;
  runtime.provider.setResponses([fauxAssistantMessage("Successful user response.")]);
  await runtime.track(runtime.session.prompt("Continue the work."));
  assert.equal(runtime.state.starts, starts + 1);
  assert.equal(runtime.state.settled, settled + 1);
  assert.equal(runtime.session.isIdle, true);
  const message = runtime.session.messages.at(-1);
  assert.ok(message?.role === "assistant");
  assert.equal(message.stopReason, "stop");
}

for (const consumer of ["progress", "subagents"] as const) {
  for (const summarize of [false, true]) {
    for (const armWhileNavigating of [false, true]) {
      test(`${consumer}: navigation ${summarize ? "with extension summary" : "without summary"}, armed ${armWhileNavigating ? "while busy" : "after idle"}, does not exclude the first user cycle`, async () => {
        const runtime = await createRuntime(consumer);
        const target = await seed(runtime);
        const settled = runtime.state.settled;
        const gate = hold();
        runtime.state.treeHold = gate;
        const navigating = runtime.track(runtime.session.navigateTree(target, { summarize }));
        await gate.entered.promise;
        assert.deepEqual(runtime.state.trees, [{ idle: false, signal: undefined }]);
        assert.equal(runtime.session.isIdle, false);
        if (armWhileNavigating) await runtime.arm();
        gate.release.resolve();
        const result = await navigating;
        assert.equal(result.cancelled, false);
        assert.equal(result.summaryEntry?.fromHook, summarize ? true : undefined);
        assert.equal(runtime.state.settled, settled, "navigation has no agent_settled boundary");
        assert.equal(runtime.session.isIdle, true);
        assert.ok(
          runtime.children.every((child) => !child.signal.aborted),
          "navigation preserves running children",
        );
        if (!armWhileNavigating) await runtime.arm();
        await successfulCycle(runtime);
        runtime.assertCompact();
      });
    }
  }

  test(`${consumer}: arming during held manual compaction permits the first actual user cycle`, async () => {
    const runtime = await createRuntime(consumer);
    await seed(runtime);
    const settled = runtime.state.settled;
    const gate = hold();
    runtime.state.compactionHold = gate;
    const compacting = runtime.track(runtime.session.compact());
    await gate.entered.promise;
    assert.deepEqual(runtime.state.compactions, [{ reason: "manual", idle: false, signal: undefined }]);
    await runtime.arm();
    gate.release.resolve();
    await compacting;
    assert.equal(runtime.state.settled, settled, "manual compaction has no agent_settled boundary");
    assert.equal(runtime.session.isIdle, true);
    await successfulCycle(runtime);
    runtime.assertCompact();
  });

  for (const operation of ["navigation", "manual-compaction"] as const) {
    test(`${consumer}: an earlier extension cancels ${operation} before the consumer sees it`, async () => {
      const runtime = await createRuntime(consumer, true);
      const target = await seed(runtime);
      const settled = runtime.state.settled;
      const gate = hold();
      let operating: Promise<unknown>;
      if (operation === "navigation") {
        runtime.state.beforeTreeHold = gate;
        runtime.state.cancelTree = true;
        operating = runtime.track(runtime.session.navigateTree(target, { summarize: false }));
      } else {
        runtime.state.compactionHold = gate;
        runtime.state.cancelCompaction = true;
        operating = runtime.track(runtime.session.compact());
      }
      await gate.entered.promise;
      const evidence =
        operation === "navigation" ? runtime.state.treePreparations.at(-1) : runtime.state.compactions.at(-1);
      assert.equal(evidence?.idle, false);
      assert.equal(evidence?.signal, undefined);
      await runtime.arm();
      gate.release.resolve();
      if (operation === "navigation") {
        const result = (await operating) as { cancelled: boolean };
        assert.equal(result.cancelled, true);
      } else {
        await assert.rejects(operating, /Compaction cancelled/u);
      }
      assert.equal(runtime.state.settled, settled);
      assert.equal(runtime.session.isIdle, true);
      assert.deepEqual(runtime.state.trees, []);
      // Native input observes the idle boundary. It clears only provisional
      // tracking, not the armed rule or any domain state.
      await successfulCycle(runtime);
      runtime.assertCompact();
    });
  }

  for (const operation of ["navigation", "manual-compaction"] as const) {
    test(`${consumer}: custom preparation after ${operation} is still the current cycle`, async () => {
      const runtime = await createRuntime(consumer, true);
      const target = await seed(runtime);
      if (operation === "navigation") await runtime.session.navigateTree(target, { summarize: false });
      else await runtime.session.compact();
      assert.equal(runtime.session.isIdle, true);
      const gate = hold();
      runtime.state.preparationHold = gate;
      const starts = runtime.state.starts;
      runtime.provider.setResponses([
        fauxAssistantMessage("Custom response."),
        fauxAssistantMessage("Queued user response."),
      ]);
      runtime.startCustom(); // Custom triggers bypass input, so there is no idle input observation.
      const processing = runtime.track(runtime.session.waitForIdle());
      await gate.entered.promise;
      assert.equal(runtime.session.isIdle, false);
      assert.equal(runtime.state.starts, starts);
      assert.deepEqual(runtime.state.preparations.at(-1), { idle: false, signal: undefined });
      await runtime.arm();
      await runtime.session.prompt("Queued user work.", { streamingBehavior: "followUp" });
      gate.release.resolve();
      await processing;
      runtime.assertExpanded();
      await successfulCycle(runtime);
      runtime.assertCompact();
    });
  }

  for (const observerFirst of [false, true]) {
    test(`${consumer}: arming during held before_agent_start, observer first=${observerFirst}, excludes that starting cycle only`, async () => {
      const runtime = await createRuntime(consumer, observerFirst);
      await seed(runtime);
      const gate = hold();
      runtime.state.preparationHold = gate;
      const starts = runtime.state.starts;
      const settled = runtime.state.settled;
      runtime.provider.setResponses([fauxAssistantMessage("Starting cycle finished.")]);
      const preparing = runtime.track(runtime.session.prompt("Start a held user cycle."));
      await gate.entered.promise;
      const evidence = runtime.state.preparations.at(-1);
      assert.equal(evidence?.idle, false);
      assert.equal(evidence?.signal, undefined, "before_agent_start precedes the low-level run signal");
      assert.equal(runtime.state.starts, starts, "agent_start has not fired yet");
      await runtime.arm();
      gate.release.resolve();
      await preparing;
      assert.equal(runtime.state.starts, starts + 1);
      assert.equal(runtime.state.settled, settled + 1);
      assert.equal(runtime.session.isIdle, true);
      runtime.assertExpanded();
      await successfulCycle(runtime);
      runtime.assertCompact();
    });
  }
}
