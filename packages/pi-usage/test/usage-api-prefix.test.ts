import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  fauxAssistantMessage,
  fauxProvider,
  getCurrentSystemPrompt,
  getCurrentTools,
  type TranscriptContext,
} from "@earendil-works/pi-ai";
import {
  createAgentSession,
  createEventBus,
  DefaultResourceLoader,
  type ExtensionContext,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { test, vi } from "vitest";
import { queryUsage } from "./fixtures/usage-client.js";

test("API traffic preserves consecutive normalized provider prefixes in a real Pi session", async () => {
  const root = await mkdtemp(join(tmpdir(), "usage-api-prefix-"));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = root;
  let dispose: () => void = () => undefined;
  try {
    const { default: usageExtension } = await import("../src/usage.js");
    const faux = fauxProvider({ tokensPerSecond: Infinity });
    const runtime = await ModelRuntime.create({
      authPath: join(root, "auth.json"),
      modelsPath: null,
      refreshOnCreate: false,
    });
    runtime.registerNativeProvider(faux.provider);
    const routerModel = { ...faux.getModel(), provider: "openrouter", baseUrl: "https://openrouter.ai/api/v1" };
    runtime.registerNativeProvider({
      ...faux.provider,
      id: "openrouter",
      name: "Synthetic OpenRouter",
      baseUrl: routerModel.baseUrl,
      getModels: () => [routerModel],
      auth: { apiKey: { name: "Synthetic", resolve: async () => ({ auth: { apiKey: "synthetic-prefix-key" } }) } },
    });
    const requests: Array<{ prompt: string; tools: unknown; messages: unknown[] }> = [];
    const normalize = (key: string, value: unknown): unknown =>
      ["timestamp", "usage", "durationMs", "details", "responseId", "diagnostics"].includes(key) ? undefined : value;
    const record = (context: TranscriptContext) => {
      requests.push(
        JSON.parse(
          JSON.stringify(
            {
              prompt: getCurrentSystemPrompt(context.messages),
              tools: getCurrentTools(context.messages).map((tool) => ({
                name: tool.name,
                description: tool.description,
                parameters: tool.parameters,
                constrainedSampling: tool.constrainedSampling,
              })),
              messages: context.messages,
            },
            normalize,
          ),
        ),
      );
      return fauxAssistantMessage("Synthetic answer");
    };
    faux.setResponses([record, record]);
    const settings = SettingsManager.inMemory({ compaction: { enabled: false }, defaultTools: [] });
    const bus = createEventBus();
    let consumerContext: ExtensionContext | undefined;
    const loader = new DefaultResourceLoader({
      cwd: root,
      agentDir: root,
      eventBus: bus,
      settingsManager: settings,
      noExtensions: true,
      noSkills: true,
      noThemes: true,
      noContextFiles: true,
      extensionFactories: [
        usageExtension,
        (pi) => {
          pi.on("session_start", (_event, ctx) => {
            consumerContext = ctx;
          });
        },
      ],
    });
    await loader.reload();
    assert.deepEqual(loader.getExtensions().errors, []);
    const { session } = await createAgentSession({
      cwd: root,
      agentDir: root,
      resourceLoader: loader,
      settingsManager: settings,
      sessionManager: SessionManager.inMemory(root),
      modelRuntime: runtime,
      model: faux.getModel(),
      tools: [],
    });
    dispose = () => session.dispose();
    await session.bindExtensions({ mode: "json" });
    await session.prompt("First request");
    assert.ok(consumerContext);
    const before = JSON.stringify(
      { prompt: session.systemPrompt, tools: session.getActiveToolNames(), messages: session.messages },
      normalize,
    );
    let fetches = 0;
    vi.stubGlobal("fetch", async () => {
      fetches++;
      return new Response(JSON.stringify({ data: { limit: 100, limit_remaining: 75, usage: 25 } }));
    });
    const updated: unknown[] = [];
    bus.on("usage:changed:v1", (event) => updated.push(event));
    for (let index = 0; index < 2; index++) {
      assert.equal(
        (await queryUsage({ events: bus }, consumerContext, { providerId: "openrouter", refresh: true })).status,
        "ready",
      );
    }
    bus.emit("usage:capabilities:v1", {
      session: consumerContext.sessionManager,
      sessionId: consumerContext.sessionManager.getSessionId(),
      providerId: "openrouter",
      signal: new AbortController().signal,
      respond: () => true,
    });
    assert.equal(fetches, 2);
    assert.equal(updated.length, 2);
    assert.equal(
      JSON.stringify(
        { prompt: session.systemPrompt, tools: session.getActiveToolNames(), messages: session.messages },
        normalize,
      ),
      before,
    );
    await session.prompt("Second request");
    assert.equal(requests.length, 2);
    assert.equal(requests[1]?.prompt, requests[0]?.prompt);
    assert.deepEqual(requests[1]?.tools, requests[0]?.tools);
    assert.deepEqual(requests[1]?.messages.slice(0, requests[0]?.messages.length), requests[0]?.messages);
  } finally {
    dispose();
    vi.unstubAllGlobals();
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    await rm(root, { recursive: true, force: true });
  }
});
