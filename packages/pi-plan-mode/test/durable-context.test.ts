import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  getCurrentSystemPrompt,
  getCurrentTools,
  type Message,
  type TranscriptContext,
  toToolDeclaration,
} from "@earendil-works/pi-ai";
import {
  CompactionTask,
  createRegistry,
  defineExtension,
  Harness,
  hook,
  MemoryStorage,
  SystemEntry,
} from "@earendil-works/pi-durable";
import { expect, it } from "vitest";
import { createDurablePlanMode } from "../src/durable.js";
import { NORMAL_CONTRACT, PLAN_CONTRACT } from "../src/durable-policy.js";
import type { DurablePlanView } from "../src/durable-types.js";
import { required } from "./durable-test-values.js";

class RetainedStorage extends MemoryStorage {
  override async close() {}
}
const identity = (view: DurablePlanView) => ({ workflowId: view.workflowId, revision: view.revision });
function normalize(input: TranscriptContext) {
  // Project only serialized model-visible fields. Do not compare runtime implementations,
  // task/UI details, identities, usage, response metadata, timestamps, or transport controls.
  const messages = input.messages.map((message) => {
    switch (message.role) {
      case "system":
        return {
          role: message.role,
          content: message.content,
          sections: message.sections,
          toolsAdded: message.toolsAdded?.map(toToolDeclaration),
          toolsRemoved: message.toolsRemoved,
        };
      case "user":
        return { role: message.role, content: message.content };
      case "assistant":
        return { role: message.role, content: message.content };
      case "toolResult":
        return {
          role: message.role,
          toolCallId: message.toolCallId,
          toolName: message.toolName,
          content: message.content,
          isError: message.isError,
        };
      default:
        throw new Error("Unsupported provider message role");
    }
  });
  const tools = getCurrentTools(input.messages).map(toToolDeclaration);
  return JSON.parse(
    JSON.stringify({
      system: getCurrentSystemPrompt(input.messages),
      tools,
      names: tools.map((tool) => tool.name),
      messages,
    }),
  ) as {
    system: string;
    tools: unknown[];
    names: string[];
    messages: unknown[];
  };
}
function retains(previous: ReturnType<typeof normalize>, next: ReturnType<typeof normalize>) {
  expect(next.system).toBe(previous.system);
  expect(next.names).toEqual(previous.names);
  expect(next.tools).toEqual(previous.tools);
  expect(next.messages.slice(0, previous.messages.length)).toEqual(previous.messages);
}

it.each(["approve", "discard"] as const)(
  "normalizes ordinary prefixes across %s, reopen and Normal compaction epochs",
  async (transition) => {
    const storage = new RetainedStorage();
    const faux = fauxProvider({ tokenSize: { min: 100_000, max: 100_000 } });
    const models = createModels();
    models.setProvider(faux.provider);
    const requests: ReturnType<typeof normalize>[] = [];
    const open = async () => {
      const registry = createRegistry();
      registry.install(
        defineExtension({
          name: "synthetic-compaction",
          hooks: [
            hook(CompactionTask, { beforeCompact: () => ({ summary: "Synthetic retained conversation summary" }) }),
          ],
        }),
      );
      const integration = createDurablePlanMode({ registry, registryVersion: "context-reviewed-v1", capabilities: [] });
      registry.install(integration.extension);
      const harness = await Harness.open(
        storage,
        {
          models,
          registry: integration.registry,
          settings: { compaction: { enabled: false, keepRecentTokens: 0 }, retry: { maxRetries: 0 } },
        },
        context,
      );
      const controller = integration.createController(harness);
      const root = await harness.root(context, {
        agent: { model: { provider: faux.provider.id, modelId: faux.getModel().id } },
      });
      return { harness, controller, root };
    };
    let f = await open();
    const respond = (answer: string | Message["content"] = "Synthetic answer") =>
      faux.setResponses([
        (input) => {
          requests.push(normalize(input));
          return typeof answer === "string"
            ? fauxAssistantMessage(answer)
            : fauxAssistantMessage(answer as Parameters<typeof fauxAssistantMessage>[0], { stopReason: "toolUse" });
        },
      ]);
    const send = async (text: string) => {
      respond();
      await (await f.root.submit({ type: "input", content: text }, context)).wait(context);
      return required(requests.at(-1));
    };
    try {
      await f.controller.start(
        f.root,
        { operationId: "start", workflowId: "context-workflow", expected: { workflowId: null, revision: 0 } },
        context,
      );
      const firstPlan = await send("Research one");
      const secondPlan = await send("Research two");
      expect(firstPlan.system).toContain(PLAN_CONTRACT);
      retains(firstPlan, secondPlan);
      let firstNormal: ReturnType<typeof normalize>;
      if (transition === "approve") {
        const plan = "# Exact proposed plan\n\nRetain the existing context.\n";
        respond([fauxToolCall("plan_mode_complete", { plan }, { id: "proposal" })]);
        await (await f.root.submit({ type: "input", content: "Complete the plan" }, context)).wait(context);
        const ready = await f.controller.inspect(f.root, context);
        respond();
        const pending = await f.controller.approve(
          f.root,
          { operationId: "approve", expected: identity(ready) },
          context,
        );
        await f.harness.waitForTask(
          required(required(pending.receipts.find((receipt) => receipt.operationId === "approve")).taskId),
          context,
        );
        const placed = await f.controller.inspect(f.root, context);
        const submissionId = required(
          required(placed.receipts.find((receipt) => receipt.operationId === "approve")).submissionId,
        );
        await required(await f.harness.submission(submissionId, context)).wait(context);
        firstNormal = required(requests.at(-1));
        expect(
          firstNormal.messages.some(
            (message) =>
              (message as { role?: string; content?: unknown }).role === "user" &&
              (message as { content?: unknown }).content === plan,
          ),
        ).toBe(true);
      } else {
        const planning = await f.controller.inspect(f.root, context);
        const pending = await f.controller.discard(
          f.root,
          { operationId: "discard", expected: identity(planning) },
          context,
        );
        await f.harness.waitForTask(
          required(required(pending.receipts.find((receipt) => receipt.operationId === "discard")).taskId),
          context,
        );
        firstNormal = await send("Normal after discard");
      }
      expect(firstNormal.system).toContain(NORMAL_CONTRACT);
      expect(firstNormal.tools).toEqual(firstPlan.tools);
      const secondNormal = await send("Continue in Normal mode");
      retains(firstNormal, secondNormal);
      await f.controller.dispose(context);
      await f.harness.close(context);
      f = await open();
      const calls = faux.state.callCount;
      await f.controller.inspect(f.root, context);
      expect(faux.state.callCount).toBe(calls);
      const reopened = await send("Continue after reopen");
      retains(secondNormal, reopened);
      const compaction = await f.harness.waitForTask(await f.root.compact(undefined, context), context);
      if (compaction.state.outcome.status !== "completed" || compaction.state.outcome.result.submissionId === undefined)
        throw new Error("Synthetic Normal compaction did not publish");
      await required(await f.harness.submission(compaction.state.outcome.result.submissionId, context)).wait(context);
      const compacted = await send("Normal after compaction");
      retains(compacted, await send("One more Normal turn"));
      expect(compacted.system).toContain(NORMAL_CONTRACT);
      expect(compacted.tools).toEqual(firstPlan.tools);
      const active = await f.root.context(context);
      expect(
        active.entries.filter(
          (entry) =>
            SystemEntry.is(entry) &&
            entry.model?.some(
              (message) => message.role === "system" && message.sections?.plan_mode === NORMAL_CONTRACT,
            ),
        ),
      ).toHaveLength(1);
    } finally {
      await f.controller.dispose(context);
      await f.harness.close(context);
    }
  },
);
