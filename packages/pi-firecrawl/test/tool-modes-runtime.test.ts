import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import {
  createAgentSession,
  DefaultResourceLoader,
  type ExtensionContext,
  type InlineExtension,
  initTheme,
  ModelRegistry,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { test } from "vitest";
import { createCustomSelectorHarness, createMockContext } from "../../../test/support.js";

const capabilities = [
  "firecrawl_scrape",
  "firecrawl_crawl",
  "firecrawl_crawl_status",
  "firecrawl_map",
  "firecrawl_search",
];
const fauxSpecifier = "@earendil-works/pi-ai/providers/faux";

for (const fixture of [
  { toolMode: undefined, native: false },
  { toolMode: "codemode", native: false },
  { toolMode: "lazy", native: false },
  { toolMode: "direct", native: false },
  { toolMode: "direct", native: false, defaultCapability: true },
  { toolMode: "lazy", native: true },
  { toolMode: "lazy", native: true, fallback: true },
  { toolMode: "lazy", native: true, allowlist: true },
  { toolMode: "lazy", native: false, allowlist: true },
  { toolMode: "direct", native: false, allowlist: true },
  { toolMode: "codemode", native: false, allowlist: true },
] as const) {
  const { toolMode, native } = fixture;
  const allowlist = "allowlist" in fixture && fixture.allowlist;
  const defaultCapability = "defaultCapability" in fixture && fixture.defaultCapability;
  const fallback = "fallback" in fixture && fixture.fallback;
  test(`Jiti runtime enforces ${toolMode ?? "old-file default"}${native ? " native" : ""}${allowlist ? " allowlisted" : ""}${defaultCapability ? " explicit default" : ""}${fallback ? " model fallback" : ""} mode and discovery without an active-only mock`, async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-firecrawl-runtime-"));
    const agentDir = join(root, "agent");
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    const previousKey = process.env.FIRECRAWL_API_KEY;
    const previousFetch = globalThis.fetch;
    let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
    try {
      await mkdir(agentDir);
      process.env.PI_CODING_AGENT_DIR = agentDir;
      process.env.FIRECRAWL_API_KEY = "test-secret-not-for-display";
      await writeFile(
        join(agentDir, "pi-firecrawl.json"),
        JSON.stringify({ tools: capabilities, toolMode, updatedAt: 1 }),
      );
      const fauxModule = (await import(fauxSpecifier)) as typeof import("@earendil-works/pi-ai/providers/faux");
      const faux = fauxModule.createFauxCore({
        api: native ? "openai-responses" : `firecrawl-${crypto.randomUUID()}`,
        provider: `firecrawl-${crypto.randomUUID()}`,
        models: [{ id: "test", contextWindow: 100_000, maxTokens: 4_000 }],
      });
      const modelRuntime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null });
      const registry = new ModelRegistry(modelRuntime);
      registry.registerProvider(faux.provider, {
        api: faux.api,
        apiKey: "test",
        baseUrl: "http://localhost",
        streamSimple: faux.streamSimple,
        models: faux.models.map((entry) => ({
          ...entry,
          compat: { supportsMidConvoSystemMessages: true, supportsToolSearch: native },
        })),
      });
      const model = registry.find(faux.provider, "test");
      assert.ok(model);
      const settingsManager = SettingsManager.inMemory({
        defaultTools: ["+codemode", ...(defaultCapability ? ["+firecrawl_scrape"] : [])],
        retry: { enabled: false },
        compaction: { enabled: false },
      });
      // SDK resource loaders do not supply CLI built-ins. Load Pi's own codemode for host characterization only.
      const builtinsSpecifier = new URL("extensions/index.js", import.meta.resolve("@earendil-works/pi-coding-agent"))
        .href;
      const { builtInExtensions } = (await import(builtinsSpecifier)) as { builtInExtensions: InlineExtension[] };
      const loader = new DefaultResourceLoader({
        cwd: root,
        agentDir,
        settingsManager,
        extensionFactories: builtInExtensions,
        noExtensions: true,
        noSkills: true,
        noContextFiles: true,
        additionalExtensionPaths: ["builtin:codemode", resolve("packages/pi-firecrawl")],
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
        ...(allowlist ? { tools: ["read", "bash", "codemode", "firecrawl_load", ...capabilities] } : {}),
      });
      session = created.session;
      initTheme("dark", false);
      let uiLines: string[] = [];
      let toggleSearch = false;
      const context = createMockContext({
        mode: "tui",
        hasUI: true,
        custom: async (factory: unknown) => {
          const harness = createCustomSelectorHarness(factory);
          uiLines = harness.render();
          if (toggleSearch) {
            for (let row = 0; row < 5; row++) harness.handleInput("\x1b[B");
            harness.handleInput("\r");
            await harness.waitForPending();
          }
          harness.handleInput("\x03");
          return harness.resultPromise;
        },
      });
      const errors: unknown[] = [];
      await session.bindExtensions({
        mode: "tui",
        uiContext: (context.ctx as ExtensionContext).ui,
        onError: (error) => errors.push(error),
      });
      const codemode = toolMode === undefined || toolMode === "codemode";
      const names = session.getActiveToolNames().filter((name) => name.startsWith("firecrawl_"));
      assert.deepEqual(
        names,
        toolMode === "lazy"
          ? native
            ? ["firecrawl_load"]
            : allowlist
              ? [...capabilities, "firecrawl_load"]
              : ["firecrawl_load", ...capabilities]
          : codemode && !allowlist
            ? []
            : capabilities,
      );
      assert.deepEqual(
        session.getCallableToolNames().filter((name) => capabilities.includes(name)),
        native ? [] : capabilities,
      );
      assert.equal(
        session.getAllTools().some((tool) => tool.name === "firecrawl_load"),
        toolMode === "lazy",
      );
      assert.ok(
        session
          .getAllTools()
          .filter((tool) => capabilities.includes(tool.name))
          .every((tool) => tool.exposure === (codemode ? "codemode" : "direct")),
      );

      // Exercise the generated settings chunk through the real Jiti loader and command runner.
      await session.prompt("/firecrawl settings");
      assert.deepEqual(errors, []);
      assert.ok(uiLines.some((line) => line.includes("Firecrawl Settings")));
      if (native) {
        const prior = session.getActiveToolNames();
        const priorPrompt = session.systemPrompt;
        faux.setResponses([
          fauxModule.fauxAssistantMessage(fauxModule.fauxToolCall("firecrawl_load", { query: "scrape one page" })),
          fauxModule.fauxAssistantMessage("loaded"),
        ]);
        await session.prompt("load scrape");
        assert.deepEqual(session.getActiveToolNames(), [...prior, "firecrawl_scrape"]);
        assert.equal(session.systemPrompt, priorPrompt);
        assert.ok(
          session.agent.state.messages.some(
            (message) =>
              message.role === "toolResult" &&
              message.toolName === "firecrawl_load" &&
              JSON.stringify(message.details).includes("firecrawl_scrape"),
          ),
        );
        await session.extensionRunner.emit({ type: "session_start", reason: "reload" });
        assert.deepEqual(session.getActiveToolNames(), [...prior, "firecrawl_scrape"]);
      }
      if (allowlist) {
        // A registration refresh activates every allowlisted declarable tool, not just the changed one.
        // Native mode must retain the loaded scrape while removing those collateral activations.
        if (codemode) {
          session.setActiveToolsByName([
            ...session.getActiveToolNames().filter((name) => !capabilities.includes(name)),
            "firecrawl_scrape",
          ]);
          assert.ok(session.getActiveToolNames().includes("firecrawl_scrape"));
        }
        const prior = session.getActiveToolNames();
        const priorPrompt = session.systemPrompt;
        toggleSearch = true;
        await session.prompt("/firecrawl settings");
        assert.deepEqual(
          session.getActiveToolNames(),
          prior.filter((name) => name !== "firecrawl_search"),
        );
        assert.equal(session.getAllTools().find((tool) => tool.name === "firecrawl_search")?.exposure, "hidden");
        await session.prompt("/firecrawl settings");
        toggleSearch = false;
        // Pi appends a re-enabled tool instead of restoring its old position.
        assert.deepEqual(session.getActiveToolNames(), [
          ...prior.filter((name) => name !== "firecrawl_search"),
          ...(prior.includes("firecrawl_search") ? ["firecrawl_search"] : []),
        ]);
        assert.equal(session.systemPrompt, priorPrompt);
        assert.equal(
          session.getAllTools().find((tool) => tool.name === "firecrawl_search")?.exposure,
          codemode ? "codemode" : "direct",
        );
        if (native) {
          assert.deepEqual(
            session.getCallableToolNames().filter((name) => capabilities.includes(name)),
            ["firecrawl_scrape"],
          );
          faux.setResponses([
            fauxModule.fauxAssistantMessage(fauxModule.fauxToolCall("firecrawl_load", { query: "web search" })),
            fauxModule.fauxAssistantMessage("search loaded"),
          ]);
          await session.prompt("load the newly enabled search");
          assert.deepEqual(session.getActiveToolNames(), [...prior, "firecrawl_search"]);
          assert.equal(session.systemPrompt, priorPrompt);
          await session.extensionRunner.emit({ type: "session_start", reason: "reload" });
          assert.deepEqual(session.getActiveToolNames(), [...prior, "firecrawl_search"]);
        }
      }
      let networkCalls = 0;
      globalThis.fetch = async (_url, options) => {
        networkCalls += 1;
        assert.equal(new Headers(options?.headers).get("Authorization"), "Bearer test-secret-not-for-display");
        return new Response(JSON.stringify({ success: true, data: { markdown: "runtime scrape" } }), { status: 200 });
      };
      const capture: string[][] = [];
      faux.setResponses([
        (request) => {
          capture.push(request.messages.map((message) => JSON.stringify(message)));
          return fauxModule.fauxAssistantMessage(
            fauxModule.fauxToolCall("codemode", {
              code: 'const found = await searchTools("firecrawl scrape"); text(found); text(await describeTool("firecrawl_scrape")); text(await tools.firecrawl_scrape({url: "https://example.test"}));',
            }),
          );
        },
        (request) => {
          capture.push(request.messages.map((message) => JSON.stringify(message)));
          return fauxModule.fauxAssistantMessage("done");
        },
        (request) => {
          capture.push(request.messages.map((message) => JSON.stringify(message)));
          return fauxModule.fauxAssistantMessage("ordinary next turn");
        },
      ]);
      const prompt = session.systemPrompt;
      const definitions = JSON.stringify(
        session.getActiveToolNames().map((name) => {
          const tool = session?.getAllTools().find((entry) => entry.name === name);
          return { name, description: tool?.description, parameters: tool?.parameters };
        }),
      );
      await session.prompt("scrape with codemode");
      await session.prompt("continue ordinarily");
      const toolResults = session.agent.state.messages.filter((message) => message.role === "toolResult");
      assert.equal(networkCalls, 1, JSON.stringify(toolResults));
      assert.ok(toolResults.some((message) => JSON.stringify(message).includes("runtime scrape")));
      assert.deepEqual(capture[2]?.slice(0, capture[1]?.length), capture[1]);
      assert.equal(session.systemPrompt, prompt);
      assert.equal(
        JSON.stringify(
          session.getActiveToolNames().map((name) => {
            const tool = session?.getAllTools().find((entry) => entry.name === name);
            return { name, description: tool?.description, parameters: tool?.parameters };
          }),
        ),
        definitions,
      );

      await session.prompt("/firecrawl disable");
      assert.ok(
        session
          .getAllTools()
          .filter((tool) => capabilities.includes(tool.name))
          .every((tool) => tool.exposure === "hidden"),
      );
      assert.deepEqual(
        session.getCallableToolNames().filter((name) => capabilities.includes(name)),
        [],
      );
      session.setActiveToolsByName([...session.getActiveToolNames(), ...capabilities]);
      assert.deepEqual(
        session.getActiveToolNames().filter((name) => capabilities.includes(name)),
        [],
      );
      faux.setResponses([
        fauxModule.fauxAssistantMessage(
          fauxModule.fauxToolCall("codemode", {
            code: 'text(await tools.firecrawl_scrape({url:"https://example.test"}));',
          }),
        ),
        fauxModule.fauxAssistantMessage("disabled"),
      ]);
      await session.prompt("try disabled scrape");
      assert.equal(networkCalls, 1);
      assert.ok(session.agent.state.messages.some((message) => message.role === "toolResult" && message.isError));
      assert.deepEqual(JSON.parse(await readFile(join(agentDir, "pi-firecrawl.json"), "utf8")).tools, []);
      await session.prompt("/firecrawl enable");
      assert.deepEqual(
        session.getCallableToolNames().filter((name) => capabilities.includes(name)),
        native ? [] : capabilities,
      );

      // Exercise AgentSession.reload(), not an emitted event: it carries old active names
      // across fresh Jiti factories/APIs. Those extension-owned names are not host intent.
      if (native) {
        faux.setResponses([
          fauxModule.fauxAssistantMessage(fauxModule.fauxToolCall("firecrawl_load", { query: "scrape one page" })),
          fauxModule.fauxAssistantMessage("loaded before transition"),
        ]);
        await session.prompt("load scrape before changing modes");
      }
      if (fallback) {
        await session.extensionRunner.emit({
          type: "model_select",
          model: { ...model, compat: { supportsToolSearch: false } },
          previousModel: model,
          source: "set",
        });
        assert.deepEqual(
          session.getActiveToolNames().filter((name) => capabilities.includes(name)),
          capabilities,
        );
      }
      const beforeTransition = session.getActiveToolNames();
      const expectedAfterTransition = beforeTransition.filter(
        (name) =>
          name !== "firecrawl_load" &&
          (!capabilities.includes(name) ||
            allowlist ||
            (codemode && name === "firecrawl_scrape") ||
            (defaultCapability && name === "firecrawl_scrape")),
      );
      const persisted = JSON.parse(await readFile(join(agentDir, "pi-firecrawl.json"), "utf8"));
      await writeFile(join(agentDir, "pi-firecrawl.json"), JSON.stringify({ ...persisted, toolMode: "codemode" }));
      await session.reload();
      assert.deepEqual(errors, []);
      assert.deepEqual(session.getActiveToolNames(), expectedAfterTransition);
      assert.ok(
        session
          .getAllTools()
          .filter((tool) => capabilities.includes(tool.name))
          .every((tool) => tool.exposure === "codemode"),
      );
      assert.ok(!session.getCallableToolNames().includes("firecrawl_load"));
      assert.deepEqual(
        session.getCallableToolNames().filter((name) => capabilities.includes(name)),
        capabilities,
      );
      const transitionedPrompt = session.systemPrompt;
      await session.reload();
      assert.deepEqual(session.getActiveToolNames(), expectedAfterTransition);
      assert.equal(session.systemPrompt, transitionedPrompt);
    } finally {
      await session?.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
      session?.dispose();
      globalThis.fetch = previousFetch;
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
      if (previousKey === undefined) delete process.env.FIRECRAWL_API_KEY;
      else process.env.FIRECRAWL_API_KEY = previousKey;
      await rm(root, { recursive: true, force: true });
    }
  });
}
