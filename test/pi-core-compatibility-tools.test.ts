import assert from "node:assert/strict";
import {
  fauxAssistantMessage,
  fauxProvider,
  getCurrentSystemPrompt,
  getCurrentTools,
  type Tool,
  type TranscriptContext,
} from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { test } from "vitest";
import { withCoreCompatibilityFixture } from "./pi-core-compatibility-fixture.js";

// The Responses serializers have no root export.
const responsesSpecifier = "@earendil-works/pi-ai/api/openai-responses-shared";
const { convertResponsesMessages, convertResponsesTools } = await import(responsesSpecifier);

interface CacheInput {
  systemPrompt: string;
  names: string[];
  definitions: Tool[];
  providerTools: unknown;
  messages: unknown[];
}

function assertSameEpoch(previous: CacheInput, current: CacheInput): void {
  assert.equal(current.systemPrompt, previous.systemPrompt);
  assert.deepEqual(current.names, previous.names);
  assert.deepEqual(current.definitions, previous.definitions);
  assert.deepEqual(current.providerTools, previous.providerTools);
  assert.deepEqual(current.messages.slice(0, previous.messages.length), previous.messages);
}

test("native active-tool selection keeps retained order and cache prefixes across loadout epochs", async () => {
  await withCoreCompatibilityFixture(async (fixture) => {
    const faux = fauxProvider({ provider: "compat-tool-order", tokensPerSecond: Infinity });
    const model = faux.getModel();
    const requests: CacheInput[] = [];
    const names = ["compat_alpha", "compat_beta", "compat_gamma", "compat_delta"] as const;
    const [alpha, beta, gamma, delta] = names;
    const definitions = new Map<string, Tool>();
    let api: ExtensionAPI | undefined;
    const toolsExtension: ExtensionFactory = (pi) => {
      api = pi;
      for (const name of [...names, "compat_hidden"]) {
        const definition = {
          name,
          description: `Describe ${name} input.`,
          parameters: Type.Object({ value: Type.String({ description: `Value for ${name}` }) }),
          constrainedSampling: { type: "json_schema", strict: "prefer" },
        } satisfies Tool;
        definitions.set(name, definition);
        pi.registerTool({
          ...definition,
          label: name,
          defaultActive: false,
          exposure: name === "compat_hidden" ? "hidden" : "direct",
          promptSnippet: `Inspect ${name} values`,
          promptGuidelines: [`Use ${name} only when requested.`],
          async execute() {
            throw new Error("The order fixture does not execute tools");
          },
        });
      }
    };
    const capture = (context: TranscriptContext) => {
      const tools = getCurrentTools(context.messages);
      requests.push({
        systemPrompt: getCurrentSystemPrompt(context.messages),
        names: tools.map((tool) => tool.name),
        definitions: JSON.parse(
          JSON.stringify(
            tools.map(({ name, description, parameters, constrainedSampling }) => ({
              name,
              description,
              parameters,
              constrainedSampling,
            })),
          ),
        ),
        providerTools: JSON.parse(JSON.stringify(convertResponsesTools(tools))),
        messages: JSON.parse(
          JSON.stringify(
            convertResponsesMessages(model, context, new Set([model.provider]), { includeSystemPrompt: false }),
          ),
        ),
      });
      return fauxAssistantMessage("Ordinary fixture response.");
    };
    faux.setResponses(Array.from({ length: 24 }, () => capture));
    const session = await fixture.createSession({ provider: faux.provider, extensionFactories: [toolsExtension] });
    assert.ok(api);
    const extensionApi = api;
    const request = async (label: string, expected: string[]) => {
      const count = requests.length;
      await session.prompt(label);
      assert.equal(requests.length, count + 1);
      assert.equal(session.getLastAssistantText(), "Ordinary fixture response.");
      const input = requests.at(-1);
      assert.ok(input);
      assert.deepEqual(input.names, expected);
      assert.deepEqual(input.definitions, JSON.parse(JSON.stringify(expected.map((name) => definitions.get(name)))));
      assert.equal(session.systemPrompt, input.systemPrompt);
      for (const name of names) {
        assert.equal(input.systemPrompt.includes(`Inspect ${name} values`), expected.includes(name));
        assert.equal(input.systemPrompt.includes(`Use ${name} only when requested.`), expected.includes(name));
      }
      return input;
    };

    // These are explicit loadout transitions between runs, not lazy loading.
    // Each changed set establishes a new prefix epoch; ordinary turns within it
    // must retain the normalized prompt, definitions, and serialized history.
    const cases = [
      { label: "initial selection", requested: [alpha, beta], expected: [alpha, beta], transition: true },
      { label: "same selection", requested: [alpha, beta], expected: [alpha, beta], transition: false },
      { label: "reorder only", requested: [beta, alpha], expected: [alpha, beta], transition: false },
      {
        label: "duplicate names",
        requested: [beta, beta, alpha, alpha],
        expected: [alpha, beta],
        transition: false,
      },
      {
        label: "unknown and hidden names",
        requested: ["compat_unknown", beta, "compat_hidden", alpha],
        expected: [alpha, beta],
        transition: false,
      },
      {
        label: "new tools append in request order",
        requested: [delta, beta, gamma, alpha, delta, "compat_unknown"],
        expected: [alpha, beta, delta, gamma],
        transition: true,
      },
      {
        label: "reorder expanded set",
        requested: [gamma, delta, beta, alpha],
        expected: [alpha, beta, delta, gamma],
        transition: false,
      },
      {
        label: "remove beta",
        requested: [gamma, alpha, delta],
        expected: [alpha, delta, gamma],
        transition: true,
      },
      {
        label: "re-add beta at the tail",
        requested: [beta, gamma, alpha, delta],
        expected: [alpha, delta, gamma, beta],
        transition: true,
      },
      { label: "remove all tools", requested: [], expected: [], transition: true },
      {
        label: "restore from empty in requested order",
        requested: [gamma, alpha, gamma, "compat_unknown"],
        expected: [gamma, alpha],
        transition: true,
      },
    ];
    let previous: CacheInput | undefined;
    for (const scenario of cases) {
      extensionApi.setActiveTools(scenario.requested);
      assert.deepEqual(extensionApi.getActiveTools(), scenario.expected);
      assert.deepEqual(session.getActiveToolNames(), scenario.expected);
      const baseline = await request(scenario.label, scenario.expected);
      if (previous) {
        assert.deepEqual(baseline.messages.slice(0, previous.messages.length), previous.messages);
        if (scenario.transition) {
          assert.notDeepEqual(baseline.names, previous.names);
          assert.notEqual(baseline.systemPrompt, previous.systemPrompt);
        } else {
          assertSameEpoch(previous, baseline);
        }
      }
      const ordinary = await request(`ordinary turn after ${scenario.label}`, scenario.expected);
      assertSameEpoch(baseline, ordinary);
      previous = ordinary;
    }
  });
});
