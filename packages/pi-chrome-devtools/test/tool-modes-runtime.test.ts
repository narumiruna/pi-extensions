import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import {
  createAgentSession,
  DefaultResourceLoader,
  type ExtensionContext,
  type InlineExtension,
  ModelRegistry,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { test } from "vitest";
import { createMockContext } from "../../../test/support.js";

const fauxSpecifier = "@earendil-works/pi-ai/providers/faux";
for (const mode of [undefined, "codemode", "lazy", "direct"] as const) {
  test(`real Pi/Jiti ${mode ?? "default"} discovery, hidden rejection, and stable ordinary request prefix`, async () => {
    const root = await mkdtemp(join(tmpdir(), "chrome-codemode-runtime-"));
    const agentDir = join(root, "agent");
    const previousDir = process.env.PI_CODING_AGENT_DIR;
    const previousFetch = globalThis.fetch;
    let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
    try {
      await mkdir(agentDir);
      process.env.PI_CODING_AGENT_DIR = agentDir;
      await writeFile(
        join(agentDir, "pi-chrome-devtools.json"),
        JSON.stringify({
          toolMode: mode,
          browser: { autoLaunch: false },
          tools: ["chrome_devtools_list_pages"],
          updatedAt: 1,
        }),
      );
      const fauxModule = (await import(fauxSpecifier)) as typeof import("@earendil-works/pi-ai/providers/faux");
      const faux = fauxModule.createFauxCore({
        api: `chrome-${crypto.randomUUID()}`,
        provider: `chrome-${crypto.randomUUID()}`,
        models: [{ id: "test", contextWindow: 100000, maxTokens: 4000 }],
      });
      const modelRuntime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null });
      const registry = new ModelRegistry(modelRuntime);
      registry.registerProvider(faux.provider, {
        api: faux.api,
        apiKey: "test",
        baseUrl: "http://localhost",
        streamSimple: faux.streamSimple,
        models: faux.models,
      });
      const model = registry.find(faux.provider, "test");
      assert.ok(model);
      const settingsManager = SettingsManager.inMemory({
        defaultTools: ["+codemode"],
        retry: { enabled: false },
        compaction: { enabled: false },
      });
      const builtinSpecifier = new URL("extensions/index.js", import.meta.resolve("@earendil-works/pi-coding-agent"))
        .href;
      const { builtInExtensions } = (await import(builtinSpecifier)) as { builtInExtensions: InlineExtension[] };
      const loader = new DefaultResourceLoader({
        cwd: root,
        agentDir,
        settingsManager,
        extensionFactories: builtInExtensions,
        noExtensions: true,
        noSkills: true,
        noContextFiles: true,
        additionalExtensionPaths: ["builtin:codemode", resolve("packages/pi-chrome-devtools")],
      });
      await loader.reload();
      assert.deepEqual(loader.getExtensions().errors, []);
      const created = await createAgentSession({
        cwd: root,
        agentDir,
        modelRuntime,
        model,
        settingsManager,
        resourceLoader: loader,
        sessionManager: SessionManager.inMemory(root),
      });
      session = created.session;
      const errors: unknown[] = [];
      const context = createMockContext({ mode: "rpc", hasUI: true });
      await session.bindExtensions({
        mode: "rpc",
        uiContext: (context.ctx as ExtensionContext).ui,
        onError: (error) => errors.push(error),
      });
      // Exercise the generated settings menu chunk through Pi's command runner.
      await session.prompt("/chrome-devtools settings");
      const names = session.getActiveToolNames().filter((name) => name.startsWith("chrome_devtools_"));
      assert.deepEqual(
        names,
        mode === "lazy"
          ? ["chrome_devtools_load", "chrome_devtools_list_pages"]
          : mode === "direct"
            ? ["chrome_devtools_list_pages"]
            : [],
      );
      assert.ok(session.getCallableToolNames().includes("chrome_devtools_list_pages"));
      assert.ok(!session.getCallableToolNames().includes("chrome_devtools_webmcp_call_tool"));
      let requests = 0;
      globalThis.fetch = async () => {
        requests++;
        return new Response(
          JSON.stringify([
            {
              id: "test-page",
              type: "page",
              title: "Runtime page",
              url: "https://example.test",
              webSocketDebuggerUrl: "ws://localhost/page",
            },
          ]),
          { status: 200 },
        );
      };
      const captures: string[][] = [];
      faux.setResponses([
        (request) => {
          captures.push(request.messages.map((message) => JSON.stringify(message)));
          return fauxModule.fauxAssistantMessage(
            fauxModule.fauxToolCall("codemode", {
              code: 'text(await searchTools("chrome_devtools_list_pages")); text(await describeTool("chrome_devtools_list_pages")); text(await tools.chrome_devtools_list_pages({}));',
            }),
          );
        },
        (request) => {
          captures.push(request.messages.map((message) => JSON.stringify(message)));
          return fauxModule.fauxAssistantMessage("done");
        },
        (request) => {
          captures.push(request.messages.map((message) => JSON.stringify(message)));
          return fauxModule.fauxAssistantMessage("next");
        },
      ]);
      const prompt = session.systemPrompt;
      const definitions = JSON.stringify(
        session.getAllTools().map(({ name, description, parameters }) => ({ name, description, parameters })),
      );
      await session.prompt("list pages through codemode");
      await session.prompt("continue");
      assert.ok(requests > 0);
      assert.ok(
        session.agent.state.messages.some(
          (message) => message.role === "toolResult" && JSON.stringify(message).includes("Runtime page"),
        ),
      );
      assert.deepEqual(captures[2]?.slice(0, captures[1]?.length), captures[1]);
      assert.equal(session.systemPrompt, prompt);
      assert.equal(
        JSON.stringify(
          session.getAllTools().map(({ name, description, parameters }) => ({ name, description, parameters })),
        ),
        definitions,
      );
      await session.prompt("/chrome-devtools disable");
      assert.ok(!session.getCallableToolNames().includes("chrome_devtools_list_pages"));
      const before = requests;
      faux.setResponses([
        fauxModule.fauxAssistantMessage(
          fauxModule.fauxToolCall("codemode", { code: "text(await tools.chrome_devtools_list_pages({}));" }),
        ),
        fauxModule.fauxAssistantMessage("disabled"),
      ]);
      await session.prompt("try disabled capability");
      assert.equal(requests, before);
      assert.ok(session.agent.state.messages.some((message) => message.role === "toolResult" && message.isError));
      await session.prompt("/chrome-devtools enable");
      await writeFile(
        join(agentDir, "pi-chrome-devtools.json"),
        JSON.stringify({ toolMode: "codemode", browser: { autoLaunch: false } }),
      );
      await session.reload();
      assert.deepEqual(
        session.getActiveToolNames().filter((name) => name.startsWith("chrome_devtools_")),
        [],
      );
      assert.ok(!session.getCallableToolNames().includes("chrome_devtools_load"));
      assert.deepEqual(errors, []);
    } finally {
      await session?.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
      session?.dispose();
      globalThis.fetch = previousFetch;
      if (previousDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousDir;
      await rm(root, { recursive: true, force: true });
    }
  });
}
