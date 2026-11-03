import assert from "node:assert/strict";
import { type AgentTool, runToolCall } from "@earendil-works/pi-agent-core";
import type { ToolCall } from "@earendil-works/pi-ai";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { afterAll, test } from "vitest";
import { createMockContext, createMockPi } from "../../../test/support.js";
import { createChildCommunicationExtension } from "../src/child-communication-tools.js";
import { registerSubagentTools } from "../src/tools.js";

const main = createMockPi();
const registered = registerSubagentTools(main.pi);
const child = createMockPi();
const waits: Array<{ requestId: string; timeoutMs: number | undefined }> = [];
createChildCommunicationExtension({
  async send() {
    throw new Error("These argument tests must not send broker messages");
  },
  async wait(requestId, timeoutMs) {
    waits.push({ requestId, timeoutMs });
    return "response";
  },
})(child.pi);

afterAll(() => registered.shutdown());

function definition(mock: ReturnType<typeof createMockPi>, name: string): ToolDefinition {
  // Registration is heterogeneous; core preparation and validation below remain real.
  const tool = (mock.tools as unknown as ToolDefinition[]).find((entry) => entry.name === name);
  assert.ok(tool);
  return tool;
}

async function call(tool: ToolDefinition, input: ToolCall["arguments"], execute?: AgentTool["execute"]) {
  const ctx = createMockContext().ctx;
  const agentTool: AgentTool = {
    name: tool.name,
    label: tool.label,
    description: tool.description,
    parameters: tool.parameters,
    prepareArguments: tool.prepareArguments,
    execute: execute ?? ((id, args, signal, onUpdate) => tool.execute(id, args, signal, onUpdate, ctx)),
  };
  const toolCall = { type: "toolCall" as const, id: "arguments", name: tool.name, arguments: input };
  const assistantMessage = { ...fauxAssistantMessage(""), content: [toolCall] };
  return runToolCall(toolCall, {
    tools: [agentTool],
    assistantMessage,
    context: { messages: [assistantMessage], tools: [agentTool] },
  });
}

const variants: { name: string; tool: ToolDefinition; fields: ToolCall["arguments"] }[] = [
  { name: "main spawn", tool: definition(main, "subagent_spawn"), fields: { task: "Inspect arguments only" } },
  { name: "main wait", tool: definition(main, "subagent_wait"), fields: { jobId: "job_example" } },
  { name: "child wait", tool: definition(child, "subagent_wait"), fields: { requestId: "req_example" } },
];

for (const { name, tool, fields } of variants) {
  const normalizationCases: {
    label: string;
    timeoutFields: ToolCall["arguments"];
    timeout: number | undefined;
  }[] = [
    { label: "legacy milliseconds", timeoutFields: { timeoutMs: 250 }, timeout: 0.25 },
    { label: "canonical seconds take precedence", timeoutFields: { timeoutMs: 250, timeout: 3 }, timeout: 3 },
    { label: "canonical numeric coercion", timeoutFields: { timeout: "2.5" }, timeout: 2.5 },
    { label: "optional null", timeoutFields: { timeout: null }, timeout: undefined },
  ];
  for (const { label, timeoutFields, timeout } of normalizationCases) {
    test(`${name}: Pi prepares ${label} before validating`, async () => {
      const input = { ...fields, ...timeoutFields };
      const original = structuredClone(input);
      let executed = false;
      const result = await call(tool, input, async (_id, args) => {
        executed = true;
        assert.deepEqual(args, { ...fields, ...(timeout === undefined ? {} : { timeout }) });
        return { content: [], details: undefined };
      });
      assert.equal(result.isError, false);
      assert.equal(executed, true);
      assert.deepEqual(input, original);
    });
  }
  for (const timeoutMs of ["250", null]) {
    test(`${name}: a malformed legacy alias is not rescued by Pi coercion (${JSON.stringify(timeoutMs)})`, async () => {
      const input = { ...fields, timeoutMs };
      const original = structuredClone(input);
      let executed = false;
      const result = await call(tool, input, async () => {
        executed = true;
        return { content: [], details: undefined };
      });
      assert.equal(result.isError, true);
      assert.equal(executed, false);
      assert.deepEqual(input, original);
    });
  }
}

for (const timeout of [0, -1, 2_147_483.648]) {
  test(`child wait retains its execution-time timeout constraint (${timeout})`, async () => {
    const count = waits.length;
    const result = await call(definition(child, "subagent_wait"), { requestId: "req_example", timeout });
    assert.equal(result.isError, true);
    assert.equal(waits.length, count, "invalid timeouts must not reach the broker");
  });
}

test("child wait passes prepared seconds to the broker as milliseconds", async () => {
  const input = { requestId: "req_example", timeoutMs: 250 };
  const result = await call(definition(child, "subagent_wait"), input);
  assert.equal(result.isError, false);
  assert.deepEqual(waits.at(-1), { requestId: "req_example", timeoutMs: 250 });
  assert.deepEqual(input, { requestId: "req_example", timeoutMs: 250 });
});
