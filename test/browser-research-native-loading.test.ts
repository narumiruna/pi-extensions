import assert from "node:assert/strict";
import {
  type Api,
  type AssistantMessage,
  getCurrentSystemPrompt,
  getCurrentTools,
  getInitialSystemMessage,
  getSystemMessageText,
  type Model,
  normalizeContext,
  resolveTranscript,
  resolveTranscriptTools,
  type Tool,
  type TranscriptContext,
  toToolDeclaration,
} from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { test } from "vitest";
import {
  CHROME_DEVTOOLS_LOAD_TOOL_NAME,
  chromeDevtoolsToolExposureMode,
  configureChromeDevtoolsToolExposure,
  supportsNativeDeferredToolLoading as supportsChromeNativeLoading,
} from "../packages/pi-chrome-devtools/src/lazy-tools.js";
import {
  configureFirecrawlToolExposure,
  FIRECRAWL_LOAD_TOOL_NAME,
  firecrawlToolExposureMode,
  supportsNativeDeferredToolLoading as supportsFirecrawlNativeLoading,
} from "../packages/pi-firecrawl/src/lazy-tools.js";
import { createMockPi } from "./support.js";

// These serializers have no root export; a variable also avoids Pi's static subpath import issue.
const responsesSpecifier = "@earendil-works/pi-ai/api/openai-responses-shared";
const { convertResponsesMessages, convertResponsesTools, getResponsesToolSupport } = await import(responsesSpecifier);

const extensions = [
  {
    name: "Chrome DevTools",
    supports: supportsChromeNativeLoading,
    exposureMode: chromeDevtoolsToolExposureMode,
    loader: CHROME_DEVTOOLS_LOAD_TOOL_NAME,
    capability: "chrome_devtools_list_pages",
    configure(pi: ExtensionAPI, model: ExtensionContext["model"]) {
      configureChromeDevtoolsToolExposure(pi, ["chrome_devtools_list_pages"], model, "lazy");
    },
  },
  {
    name: "Firecrawl",
    supports: supportsFirecrawlNativeLoading,
    exposureMode: firecrawlToolExposureMode,
    loader: FIRECRAWL_LOAD_TOOL_NAME,
    capability: "firecrawl_search",
    configure(pi: ExtensionAPI, model: ExtensionContext["model"]) {
      configureFirecrawlToolExposure(pi, ["firecrawl_search"], [], undefined, model, "lazy");
    },
  },
];
const responsesApis = ["openai-responses", "openai-codex-responses", "azure-openai-responses"] as const;
const flagValues = [undefined, false, true];
const apiFlags = [
  ["anthropic-messages", "supportsMidConvoToolChanges"],
  ["openai-completions", "supportsMidConvoToolAdditions"],
  ...responsesApis.flatMap((api) => [
    [api, "supportsAdditionalTools"],
    [api, "supportsToolSearch"],
  ]),
];
const compatibilityCases: { label: string; model: unknown; supported: boolean }[] = [
  { label: "missing model", model: undefined, supported: false },
  { label: "null model", model: null, supported: false },
  { label: "missing API and compat", model: {}, supported: false },
  {
    label: "legacy Anthropic model-name heuristic",
    model: { api: "anthropic-messages", provider: "anthropic", id: "claude-sonnet-4-5" },
    supported: false,
  },
];

function addCase(api: string, compat: unknown, supported: boolean, label = JSON.stringify(compat)) {
  compatibilityCases.push({ label: `${api}: ${label}`, model: { api, compat }, supported });
}

for (const [api, flag] of apiFlags) {
  for (const system of flagValues) {
    for (const tools of flagValues) {
      addCase(api, { supportsMidConvoSystemMessages: system, [flag]: tools }, system === true && tools === true);
    }
  }
  // Malformed values must not become opt-ins through JavaScript truthiness.
  for (const value of [null, 0, 1, "false", "true", [], {}]) {
    addCase(api, { supportsMidConvoSystemMessages: value, [flag]: true }, false);
    addCase(api, { supportsMidConvoSystemMessages: true, [flag]: value }, false);
  }
  const valid = { supportsMidConvoSystemMessages: true, [flag]: true };
  for (const [index, compat] of [
    undefined,
    null,
    true,
    1,
    "true",
    Object.assign([], valid),
    Object.assign(() => undefined, valid),
  ].entries()) {
    addCase(api, compat, false, `malformed compat container ${index}`);
  }
}

for (const api of responsesApis) {
  for (const system of flagValues) {
    for (const additional of flagValues) {
      for (const search of flagValues) {
        addCase(
          api,
          {
            supportsMidConvoSystemMessages: system,
            supportsAdditionalTools: additional,
            supportsToolSearch: search,
          },
          system === true && (additional === true || search === true),
        );
      }
    }
  }
  addCase(
    api,
    { supportsMidConvoSystemMessages: true, supportsAdditionalTools: "true", supportsToolSearch: true },
    true,
  );
  addCase(
    api,
    { supportsMidConvoSystemMessages: true, supportsAdditionalTools: true, supportsToolSearch: "true" },
    true,
  );
}

const allFlags = {
  supportsMidConvoSystemMessages: true,
  supportsMidConvoToolChanges: true,
  supportsMidConvoToolAdditions: true,
  supportsAdditionalTools: true,
  supportsToolSearch: true,
};
for (const api of [
  "google-generative-ai",
  "google-vertex",
  "bedrock-converse-stream",
  "mistral-conversations",
  "custom",
  "",
]) {
  addCase(api, allFlags, false, "unsupported API with every current flag enabled");
}
for (const [api, legacy] of [
  ["anthropic-messages", { supportsToolReferences: true }],
  ["openai-completions", { deferredToolsMode: "kimi" }],
  ["openai-completions", { supportsToolSearch: true }],
  ["anthropic-messages", { supportsMidConvoToolAdditions: true }],
  ["openai-completions", { supportsMidConvoToolChanges: true }],
  ...responsesApis.map(
    (api) => [api, { supportsMidConvoToolChanges: true, supportsMidConvoToolAdditions: true }] as const,
  ),
] as const) {
  addCase(
    api,
    { supportsMidConvoSystemMessages: true, ...legacy },
    false,
    `legacy or wrong API flags ${JSON.stringify(legacy)}`,
  );
}

for (const extension of extensions) {
  test.each(compatibilityCases)(`${extension.name} native loading: $label`, ({ model, supported }) => {
    const candidate = model as ExtensionContext["model"];
    assert.equal(extension.supports(candidate), supported);
    const mock = createMockPi({ activeTools: ["read"] });
    extension.configure(mock.pi, candidate);
    assert.equal(extension.exposureMode(mock.pi), supported ? "native deferred" : "eager");
    assert.deepEqual(mock.rawPi.getActiveTools(), [
      "read",
      extension.loader,
      ...(supported ? [] : [extension.capability]),
    ]);
  });
}

function syntheticTool(name: string): Tool {
  return {
    name,
    description: `Synthetic ${name} definition.`,
    parameters: {
      type: "object",
      properties: { query: { type: "string" } },
      required: ["query"],
      additionalProperties: false,
    },
    constrainedSampling: { type: "json_schema", strict: "prefer" },
  };
}

function syntheticModel(api: Api, compat: Record<string, boolean>): Model<Api> {
  return {
    api,
    provider: "synthetic-browser-research",
    id: "synthetic-model",
    name: "Synthetic model",
    baseUrl: "https://example.invalid",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 32_000,
    maxTokens: 1_000,
    compat,
  };
}

function assistant(model: Model<Api>, content: AssistantMessage["content"]): AssistantMessage {
  return {
    role: "assistant",
    api: model.api,
    provider: model.provider,
    model: model.id,
    content,
    stopReason: content.some((block) => block.type === "toolCall") ? "toolUse" : "stop",
    timestamp: 0,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  };
}

function cacheInput(model: Model<Api>, context: TranscriptContext) {
  const compat = model.compat as Record<string, boolean>;
  const resolved = resolveTranscript(context, compat.supportsMidConvoSystemMessages);
  const tools = getCurrentTools(resolved.messages);
  const requestTools = resolveTranscriptTools(resolved.messages, getResponsesToolSupport(compat)).requestTools;
  const codex = model.api === "openai-codex-responses";
  const toolOptions = { supportsStrictMode: true, ...(codex ? { strict: null } : {}) };
  const initial = getInitialSystemMessage(resolved.messages);
  // Only model-visible content: no transport settings, usage, timestamps, or runtime tool fields.
  return JSON.parse(
    JSON.stringify({
      systemPrompt: getCurrentSystemPrompt(resolved.messages),
      instructions: codex && initial ? getSystemMessageText(initial) : undefined,
      names: tools.map((tool) => tool.name),
      definitions: tools.map(toToolDeclaration),
      requestTools: convertResponsesTools(requestTools, toolOptions),
      messages: convertResponsesMessages(model, resolved, new Set([model.provider]), {
        ...compat,
        includeSystemPrompt: !codex,
        toolOptions,
      }),
    }),
  );
}

for (const extension of extensions) {
  for (const api of responsesApis) {
    for (const flag of ["supportsAdditionalTools", "supportsToolSearch"]) {
      test(`${extension.name} ${api} ${flag} anchors additions and retains ordinary request prefixes`, () => {
        const model = syntheticModel(api, { supportsMidConvoSystemMessages: true, [flag]: true });
        assert.equal(extension.supports(model), true);
        const loader = syntheticTool(extension.loader);
        const capability = syntheticTool(extension.capability);
        const context = normalizeContext({
          systemPrompt: "Use browser research tools only when requested.",
          tools: [loader],
          messages: [{ role: "user", content: "Load a research capability.", timestamp: 0 }],
        });
        const before = cacheInput(model, context);
        context.messages.push(
          assistant(model, [
            { type: "toolCall", id: "load_call|fc_load", name: loader.name, arguments: { query: "research" } },
          ]),
          {
            role: "toolResult",
            toolCallId: "load_call|fc_load",
            toolName: loader.name,
            content: [{ type: "text", text: "Research capability loaded." }],
            isError: false,
            timestamp: 0,
          },
          { role: "system", content: "", toolsAdded: [capability], timestamp: 0 },
        );
        const loaded = cacheInput(model, context);
        assert.equal(loaded.systemPrompt, before.systemPrompt);
        assert.equal(loaded.instructions, before.instructions);
        assert.deepEqual(loaded.names, [loader.name, capability.name]);
        assert.deepEqual(loaded.definitions, JSON.parse(JSON.stringify([loader, capability])));
        assert.deepEqual(loaded.requestTools, before.requestTools);
        assert.deepEqual(loaded.messages.slice(0, before.messages.length), before.messages);

        const additional = flag === "supportsAdditionalTools";
        const payloadType = additional ? "additional_tools" : "tool_search_output";
        const declarations = loaded.messages.filter((item: { type?: string }) => item.type === payloadType);
        assert.deepEqual(
          declarations.map((item: { tools: unknown }) => item.tools),
          [
            ...(additional ? [convertResponsesTools([loader], { strict: null, supportsStrictMode: true })] : []),
            convertResponsesTools([capability], {
              supportsStrictMode: true,
              ...(api === "openai-codex-responses" ? { strict: null } : {}),
              ...(!additional ? { toolSearchResult: true } : {}),
            }),
          ],
        );
        assert.ok(
          loaded.messages.findIndex((item: { type?: string }) => item.type === "function_call_output") <
            loaded.messages.findLastIndex((item: { type?: string }) => item.type === payloadType),
        );
        assert.deepEqual(
          before.requestTools,
          additional ? [] : convertResponsesTools([loader], { supportsStrictMode: true }),
        );

        let previous = loaded;
        for (const turn of ["First ordinary turn.", "Second ordinary turn."]) {
          context.messages.push(assistant(model, [{ type: "text", text: "Synthetic research response." }]), {
            role: "user",
            content: turn,
            timestamp: 0,
          });
          const current = cacheInput(model, context);
          assert.deepEqual({ ...current, messages: previous.messages }, previous);
          assert.deepEqual(current.messages.slice(0, previous.messages.length), previous.messages);
          previous = current;
        }
      });
    }
  }
}
