import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { DefaultResourceLoader, ExtensionRunner, SettingsManager } from "@earendil-works/pi-coding-agent";
import { test } from "vitest";
import { listFiles, registerRuntimeBuilderContract } from "../../../test/runtime-builder-contract.js";
import { builtinTool, createMockContext, extensionTool } from "../../../test/support.js";

const { packageRoot, loadBuilder } = registerRuntimeBuilderContract({
  packageId: "pi-plan-mode",
  forbiddenEagerInputs: [
    "src/interactive-ui.ts",
    "src/active-implementation-menu.ts",
    "src/plan-export-screen.ts",
    "src/plan-action-menus.ts",
    "src/plan-launch-menu.ts",
    "src/saved-plan-menu.ts",
    "src/settings-menu.ts",
  ],
  forbiddenEagerExternals: ["@narumitw/pi-tui-kit"],
});

test("generated interactive UI stays loadable with a lazy external questionnaire", async () => {
  const builder = await loadBuilder();
  const root = await mkdtemp(join(packageRoot, ".pi-plan-mode-build-test-"));
  try {
    const output = join(root, "dist");
    const metadata = await builder.buildRuntime({ outputDirectory: output });
    const interactiveUiPath = (await listFiles(output)).find((path) =>
      /^chunks\/interactive-ui-[A-Z0-9]+\.ts$/u.test(path),
    );
    assert.ok(interactiveUiPath, "generated runtime must include its lazy interactive UI chunk");
    const interactiveUi = await import(
      `${pathToFileURL(join(output, interactiveUiPath)).href}?test=${crypto.randomUUID()}`
    );
    assert.equal(typeof interactiveUi.showReadyPlanMenu, "function");
    const kitImports = Object.values(metadata.outputs ?? {})
      .flatMap((chunk) => chunk.imports ?? [])
      .filter((imported) => imported.path === "@narumitw/pi-tui-kit");
    assert.ok(kitImports.length > 0, "generated runtime must import Pi TUI Kit");
    assert.ok(
      kitImports.every((imported) => imported.external),
      "Pi TUI Kit must remain external",
    );
    assert.ok(
      kitImports.some((imported) => imported.kind === "dynamic-import"),
      "the questionnaire runner must remain a first-use import",
    );
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("generated runtime is loadable by Pi's Jiti resource loader", async () => {
  const builder = await loadBuilder();
  const root = await mkdtemp(join(packageRoot, ".pi-plan-mode-build-test-"));
  const agentDir = join(root, "agent");
  const output = join(root, "dist");
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  try {
    await builder.buildRuntime({ outputDirectory: output });
    await mkdir(agentDir, { recursive: true });
    process.env.PI_CODING_AGENT_DIR = agentDir;
    const loader = new DefaultResourceLoader({
      cwd: root,
      agentDir,
      settingsManager: SettingsManager.inMemory({}),
      additionalExtensionPaths: [join(output, "index.ts")],
    });
    await loader.reload();
    const loaded = loader.getExtensions();
    assert.deepEqual(loaded.errors, []);
    assert.equal(loaded.extensions.length, 1);
    const extension = loaded.extensions[0];
    assert.ok(extension?.commands.has("plan"));
    assert.ok(extension?.handlers.has("session_start"));
    assert.ok(extension?.handlers.has("session_shutdown"));

    let activeTools = ["read", "write", "plan_mode_question", "plan_mode_complete"];
    const sessionManager = {
      getSessionId: () => "generated-plan-mode",
      getSessionName: () => undefined,
      getSessionFile: () => undefined,
      getBranch: () => [],
      getEntries: () => [],
    };
    const runner = new ExtensionRunner(loaded.extensions, loaded.runtime, root, sessionManager as never, {} as never);
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
        getThinkingLevel: () => "off",
        setThinkingLevel: () => undefined,
      } as never,
      {
        getModel: () => undefined,
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
      mode: "tui",
      hasUI: true,
      cwd: root,
      sessionManager,
    });
    runner.setUIContext((mockContext.ctx as { ui: never }).ui, "tui");
    const errors: unknown[] = [];
    runner.onError((error) => errors.push(error));
    await runner.emit({ type: "session_start", reason: "startup" });
    const command = runner.getCommand("plan");
    assert.ok(command);
    await command.handler("start", runner.createCommandContext());
    const complete = runner.getToolDefinition("plan_mode_complete");
    assert.ok(complete);
    await complete.execute(
      "complete-generated-plan",
      { plan: "# Plan\n\nImplement the generated-runtime fix." },
      new AbortController().signal,
      undefined,
      runner.createContext(),
    );
    await runner.emit({ type: "agent_settled" });
    assert.deepEqual(errors, []);
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    await rm(root, { force: true, recursive: true });
  }
});
