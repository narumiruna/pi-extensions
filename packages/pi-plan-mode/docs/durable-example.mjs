import assert from "node:assert/strict";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { createRegistry, Harness, MemoryStorage } from "@earendil-works/pi-durable";
import { createDurablePlanMode } from "@narumitw/pi-plan-mode/durable";

// This example has no credentials, environment, filesystem tools, or live provider.
const faux = fauxProvider({ tokenSize: { min: 100_000, max: 100_000 } });
const models = createModels();
models.setProvider(faux.provider);
const registry = createRegistry();
const integration = createDurablePlanMode({ registry, registryVersion: "synthetic-host-v1", capabilities: [] });
registry.install(integration.extension);
const harness = await Harness.open(
  new MemoryStorage(),
  {
    models,
    registry: integration.registry,
    settings: { compaction: { enabled: false }, retry: { maxRetries: 0 } },
  },
  context,
);
const controller = integration.createController(harness);
const expected = ({ workflowId, revision }) => ({ workflowId, revision });
const plan = "# Synthetic plan\n\nVerify an explicit host approval without editing files.\n";
try {
  const conversation = await harness.root(context, {
    agent: { model: { provider: faux.provider.id, modelId: faux.getModel().id } },
  });
  const initial = await controller.inspect(conversation, context);
  await controller.start(
    conversation,
    { operationId: "start-1", workflowId: "example-1", expected: expected(initial) },
    context,
  );
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("plan_mode_complete", { plan }, { id: "proposal" }), { stopReason: "toolUse" }),
    (input) => {
      assert.equal(input.messages.filter((message) => message.role === "user").at(-1)?.content, plan);
      assert.ok(
        input.messages.some(
          (message) => message.role === "system" && message.sections?.plan_mode?.includes(": NORMAL]"),
        ),
      );
      return fauxAssistantMessage("Synthetic implementation acknowledged. No external effects.");
    },
  ]);
  assert.equal(
    (
      await (
        await conversation.submit({ type: "input", content: "Prepare the synthetic plan." }, context)
      ).wait(context)
    ).status,
    "done",
  );
  const ready = await controller.inspect(conversation, context);
  assert.equal(ready.phase, "ready");
  assert.equal(ready.plan, plan);
  assert.equal(ready.approval, undefined);
  const pending = await controller.approve(
    conversation,
    { operationId: "approve-1", expected: expected(ready) },
    context,
  );
  const operation = pending.receipts.find((receipt) => receipt.operationId === "approve-1");
  assert.ok(operation?.taskId);
  await harness.waitForTask(operation.taskId, context);
  const placed = await controller.inspect(conversation, context);
  const receipt = placed.receipts.find((item) => item.operationId === "approve-1");
  assert.equal(receipt?.status, "done");
  assert.ok(receipt.submissionId);
  const submission = await harness.submission(receipt.submissionId, context);
  assert.equal((await submission.wait(context)).status, "done");
  assert.equal((await controller.inspect(conversation, context)).phase, "implementing");
  console.log(
    JSON.stringify({
      provider: "synthetic",
      proposal: "persisted",
      approval: "explicit-host",
      kickoff: "exact-plan",
      status: "done",
    }),
  );
} finally {
  await controller.dispose(context);
  await harness.close(context);
}
