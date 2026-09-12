import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DefaultResourceLoader, ExtensionRunner, SettingsManager } from "@earendil-works/pi-coding-agent";
import { test } from "vitest";
import { builtinTool, createMockContext, extensionTool } from "../../../test/support.js";

const EVENT_RECORDER = Symbol.for("pi-plan-mode.issue-1263-events");

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

test("ready-menu fresh handoff waits for settled and prompt-end dispatch", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-issue-1263-"));
  const agentDir = join(root, "agent");
  const followerPath = join(root, "later-extension.ts");
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  const events: string[] = [];
  Reflect.set(globalThis, EVENT_RECORDER, (event: string) => events.push(event));
  try {
    await mkdir(agentDir, { recursive: true });
    await writeFile(
      followerPath,
      `const recorder = globalThis[Symbol.for("pi-plan-mode.issue-1263-events")];
export default function laterExtension(pi) {
	pi.on("agent_settled", (_event, ctx) => {
		void ctx.sessionManager;
		recorder("later-agent-settled");
	});
	pi.on("ui_prompt_end", (_event, ctx) => {
		void ctx.sessionManager;
		recorder("later-ui-prompt-end");
	});
}
`,
      "utf8",
    );
    process.env.PI_CODING_AGENT_DIR = agentDir;
    const loader = new DefaultResourceLoader({
      cwd: root,
      agentDir,
      settingsManager: SettingsManager.inMemory({}),
      additionalExtensionPaths: [resolve("packages/pi-plan-mode/src/index.ts"), followerPath],
    });
    await loader.reload();
    const loaded = loader.getExtensions();
    assert.deepEqual(loaded.errors, []);

    const sourceSessionManager = {
      getSessionId: () => "source",
      getSessionName: () => undefined,
      getSessionFile: () => "/sessions/source.jsonl",
      getBranch: () => [],
      getEntries: () => [],
    };
    const model = {
      provider: "test-provider",
      id: "test-model",
      name: "Test model",
      reasoning: true,
      input: ["text"],
      contextWindow: 100_000,
      maxTokens: 10_000,
    };
    const modelRegistry = {
      getAvailable: () => [model],
      find: () => model,
      getApiKeyAndHeaders: async () => ({ ok: true as const }),
    };
    const runner = new ExtensionRunner(
      loaded.extensions,
      loaded.runtime,
      root,
      sourceSessionManager as never,
      modelRegistry as never,
    );
    let activeTools = ["read", "write", "plan_mode_question", "plan_mode_complete"];
    runner.bindCore(
      {
        sendMessage: () => undefined,
        sendUserMessage: () => undefined,
        appendEntry: () => undefined,
        setSessionName: () => undefined,
        getSessionName: () => undefined,
        setLabel: () => undefined,
        getActiveTools: () => [...activeTools],
        getAllTools: () => [
          builtinTool("read"),
          builtinTool("write"),
          extensionTool("plan_mode_question"),
          extensionTool("plan_mode_complete"),
        ],
        setActiveTools: (names: string[]) => {
          activeTools = [...names];
        },
        refreshTools: () => undefined,
        getCommands: () => [],
        setModel: async () => true,
        getThinkingLevel: () => "medium",
        setThinkingLevel: () => undefined,
      } as never,
      {
        getModel: () => model,
        getScopedModels: () => [],
        isIdle: () => true,
        isProjectTrusted: () => true,
        getSignal: () => undefined,
        waitForIdle: async () => undefined,
        abort: () => undefined,
        hasPendingMessages: () => false,
        shutdown: () => undefined,
        getContextUsage: () => undefined,
        compact: () => undefined,
        getSystemPrompt: () => "",
        getSystemPromptOptions: () => ({ cwd: root }),
      } as never,
    );
    const mockContext = createMockContext({
      mode: "rpc",
      hasUI: true,
      select: async (_title: string, options: string[]) => {
        if (options.includes("Start fresh and implement")) return "Start fresh and implement";
        if (options.includes("Start fresh implementation")) return "Start fresh implementation";
        return undefined;
      },
    });
    runner.setUIContext((mockContext.ctx as { ui: never }).ui, "rpc");
    const handoffFinished = deferred<void>();
    let setupCalls = 0;
    let kickoffCalls = 0;
    runner.bindCommandContext({
      waitForIdle: async () => undefined,
      newSession: async (options) => {
        events.push("replacement-started");
        await runner.emit({ type: "session_shutdown", reason: "new" });
        runner.invalidate();
        if (options?.setup) setupCalls += 1;
        await options?.setup?.({
          appendCustomEntry: () => "state",
          appendCustomMessageEntry: () => "contract",
        } as never);
        await options?.withSession?.({
          sessionManager: { getBranch: () => [] },
          ui: (mockContext.ctx as { ui: never }).ui,
          sendUserMessage: async () => {
            kickoffCalls += 1;
          },
        } as never);
        handoffFinished.resolve();
        return { cancelled: false };
      },
      fork: async () => ({ cancelled: false }),
      navigateTree: async () => ({ cancelled: false }),
      switchSession: async () => ({ cancelled: false }),
      reload: async () => undefined,
    });

    const errors: Array<{ extensionPath: string; event: string; error: string }> = [];
    runner.onError((error) => errors.push(error));
    await runner.emit({ type: "session_start", reason: "startup" });
    const command = runner.getCommand("plan");
    assert.ok(command);
    await command.handler("start", runner.createCommandContext());
    const complete = runner.getToolDefinition("plan_mode_complete");
    assert.ok(complete);
    await complete.execute(
      "complete",
      { plan: "# Plan\n\nImplement it." },
      new AbortController().signal,
      undefined,
      runner.createContext(),
    );
    await runner.emit({ type: "agent_settled" });
    await handoffFinished.promise;
    await Promise.resolve();

    const replacementIndex = events.indexOf("replacement-started");
    const settledIndex = events.indexOf("later-agent-settled");
    const promptEndIndex = events.lastIndexOf("later-ui-prompt-end");
    assert.ok(replacementIndex >= 0, JSON.stringify(events));
    assert.ok(settledIndex >= 0 && settledIndex < replacementIndex, JSON.stringify(events));
    assert.ok(promptEndIndex >= 0 && promptEndIndex < replacementIndex, JSON.stringify(events));
    assert.equal(setupCalls, 1);
    assert.equal(kickoffCalls, 1);
    assert.deepEqual(errors, []);
  } finally {
    Reflect.deleteProperty(globalThis, EVENT_RECORDER);
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    await rm(root, { force: true, recursive: true });
  }
});
