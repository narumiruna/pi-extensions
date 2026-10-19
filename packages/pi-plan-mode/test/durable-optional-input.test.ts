import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { createRegistry, Harness, MemoryStorage } from "@earendil-works/pi-durable";
import { afterEach, describe, expect, it } from "vitest";
import { createDurablePlanMode, type DurablePlanController } from "../src/durable.js";
import { required } from "./durable-test-values.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

async function fixture() {
  const registry = createRegistry();
  const integration = createDurablePlanMode({
    registry,
    registryVersion: "optional-input-reviewed-v1",
    capabilities: [],
  });
  registry.install(integration.extension);
  const faux = fauxProvider({ tokenSize: { min: 100_000, max: 100_000 } });
  const models = createModels();
  models.setProvider(faux.provider);
  const harness = await Harness.open(
    new MemoryStorage(),
    {
      models,
      registry: integration.registry,
      settings: { compaction: { enabled: false }, retry: { maxRetries: 0 } },
    },
    context,
  );
  let controller: DurablePlanController | undefined;
  cleanup.push(async () => {
    try {
      await controller?.dispose(context);
    } finally {
      await harness.close(context);
    }
  });
  const bound = integration.createController(harness);
  controller = bound;
  const root = await harness.root(context, {
    agent: { model: { provider: faux.provider.id, modelId: faux.getModel().id } },
  });
  return { harness, controller: bound, root, faux };
}

const question = {
  id: "scope",
  header: "Scope",
  question: "Which scope?",
  options: [
    { label: "Package", description: "Only this package." },
    { label: "Repository", description: "All packages." },
  ],
};
const start = {
  operationId: "start",
  workflowId: "workflow",
  expected: { workflowId: null, revision: 0 },
};

describe("public durable controller optional input", () => {
  it("starts without a prompt when explicitly undefined and retries with the prompt omitted", async () => {
    const f = await fixture();
    const first = await f.controller.start(f.root, { ...start, prompt: undefined }, context);
    expect(first).toMatchObject({ phase: "planning", revision: 1, workflowId: start.workflowId });
    expect(first.delivery).toBeUndefined();
    expect(first.receipts).toHaveLength(1);
    expect(first.receipts[0]).toMatchObject({ operationId: start.operationId, status: "done" });
    expect(first.receipts[0]?.taskId).toBeUndefined();
    expect(await f.controller.start(f.root, start, context)).toEqual(first);
    await expect(f.controller.start(f.root, { ...start, prompt: "Different payload" }, context)).rejects.toThrow(
      "different payload",
    );
    expect(await f.controller.inspect(f.root, context)).toEqual(first);
    expect((await f.harness.inspect(context)).tasks).toEqual([]);
    expect((await f.root.context(context)).messages.filter((message) => message.role === "user")).toEqual([]);
    expect(f.faux.state.callCount).toBe(0);
  });

  it.each([true, false])("accepts and deduplicates undefined answer optionals (custom=%s)", async (wasCustom) => {
    const f = await fixture();
    await f.controller.start(f.root, start, context);
    f.faux.setResponses([
      fauxAssistantMessage(fauxToolCall("plan_mode_question", { questions: [question] }, { id: "scope" }), {
        stopReason: "toolUse",
      }),
    ]);
    // The native submission boundary joins the real helper before the host reads its question batch.
    await (await f.root.submit({ type: "input", content: "Clarify the scope" }, context)).wait(context);
    await f.root.waitForIdle(context);
    const pending = await f.controller.inspect(f.root, context);
    expect(pending.phase).toBe("awaiting_answers");
    expect(pending.question?.questions).toEqual([question]);
    const answer = {
      id: question.id,
      header: question.header,
      question: question.question,
      answer: wasCustom ? "  Custom scope\n" : "Package",
      wasCustom,
      ...(wasCustom ? {} : { optionIndex: 1 }),
    };
    const input = {
      operationId: "answer",
      expected: { workflowId: pending.workflowId, revision: pending.revision },
      batchId: required(pending.question).batchId,
      answers: [answer],
    };
    f.faux.setResponses([fauxAssistantMessage("Answer received")]);
    await f.controller.answer(
      f.root,
      { ...input, answers: [{ ...answer, optionIndex: answer.optionIndex, note: undefined }] },
      context,
    );
    const admitted = await f.controller.inspect(f.root, context);
    const taskId = required(required(admitted.receipts.find((item) => item.operationId === "answer")).taskId);
    await f.harness.waitForTask(taskId, context);
    const delivered = await f.controller.inspect(f.root, context);
    const receipt = required(delivered.receipts.find((item) => item.operationId === "answer"));
    expect(receipt.status).toBe("done");
    await required(await f.harness.submission(required(receipt.submissionId), context)).wait(context);
    await f.root.waitForIdle(context);
    const before = await f.controller.inspect(f.root, context);
    expect(await f.controller.answer(f.root, input, context)).toEqual(before);
    await expect(
      f.controller.answer(f.root, { ...input, answers: [{ ...answer, note: "Different payload" }] }, context),
    ).rejects.toThrow("different payload");
    expect(await f.controller.inspect(f.root, context)).toEqual(before);
    expect(before).toMatchObject({ phase: "planning", revision: pending.revision + 1 });
    expect(before.delivery).toBeUndefined();
    expect(before.question).toBeUndefined();
    expect(before.receipts.filter((item) => item.operationId === "answer")).toHaveLength(1);
    const inputs = (await f.root.context(context)).messages.filter((message) => message.role === "user");
    expect(inputs).toHaveLength(2);
    expect(JSON.parse(required(inputs[1]).content as string)).toEqual({
      type: "plan_mode_answers",
      batchId: input.batchId,
      answers: [answer],
    });
    expect(f.faux.state.callCount).toBe(2);
  });
});
