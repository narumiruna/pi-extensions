import type { Context } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { createRegistry, Harness, MemoryStorage, type StorageWrite } from "@earendil-works/pi-durable";
import { expect, it } from "vitest";
import { createDurablePlanMode } from "../src/durable.js";
import type { DurablePlanAnswers, DurablePlanMutation, DurablePlanView } from "../src/durable-types.js";
import { required } from "./durable-test-values.js";

// Inject both a clean pre-commit failure and an uncertain post-commit failure.
// The latter models losing the acknowledgment after the backend stored an atomic commit.
class CrashStorage extends MemoryStorage {
  armed = false;
  commits = 0;
  failAt?: number;
  after = false;
  hit = false;
  override async close() {}
  override async commit(writes: readonly StorageWrite[], ctx: Context) {
    const crash = this.armed && ++this.commits === this.failAt;
    if (crash && !this.after) {
      this.hit = true;
      throw new Error("Synthetic crash before storage commit");
    }
    const seq = await super.commit(writes, ctx);
    if (crash && this.after) {
      this.hit = true;
      throw new Error("Synthetic crash after storage commit");
    }
    return seq;
  }
}
const plan = "# Exact approved plan\n\nUse a synthetic provider; do not edit files.\n";
const question = {
  id: "scope",
  header: "Scope",
  question: "Which scope?",
  options: [
    { label: "Small", description: "Keep it small." },
    { label: "Large", description: "Use a larger scope." },
  ],
};
const identity = (view: DurablePlanView) => ({ workflowId: view.workflowId, revision: view.revision });
type Scenario = "approve" | "answer";

async function fixture(scenario: Scenario) {
  const storage = new CrashStorage();
  const faux = fauxProvider({ tokenSize: { min: 100_000, max: 100_000 } });
  const models = createModels();
  models.setProvider(faux.provider);
  const open = async () => {
    const registry = createRegistry();
    const integration = createDurablePlanMode({ registry, registryVersion: "crash-reviewed-v1", capabilities: [] });
    registry.install(integration.extension);
    const harness = await Harness.open(
      storage,
      {
        models,
        registry: integration.registry,
        settings: { compaction: { enabled: false }, retry: { maxRetries: 0 } },
      },
      context,
    );
    const controller = integration.createController(harness);
    const root = await harness.root(context, {
      agent: { model: { provider: faux.provider.id, modelId: faux.getModel().id } },
    });
    return { harness, controller, root };
  };
  const original = await open();
  await original.controller.start(
    original.root,
    { operationId: "start", workflowId: "crash-workflow", expected: { workflowId: null, revision: 0 } },
    context,
  );
  faux.setResponses([
    fauxAssistantMessage(
      fauxToolCall(
        scenario === "approve" ? "plan_mode_complete" : "plan_mode_question",
        scenario === "approve" ? { plan } : { questions: [question] },
        { id: "initial-helper" },
      ),
      { stopReason: "toolUse" },
    ),
  ]);
  await (await original.root.submit({ type: "input", content: "Prepare a plan" }, context)).wait(context);
  const view = await original.controller.inspect(original.root, context);
  const mutation: DurablePlanMutation | DurablePlanAnswers =
    scenario === "approve"
      ? { operationId: "operation", expected: identity(view) }
      : {
          operationId: "operation",
          expected: identity(view),
          batchId: required(view.question).batchId,
          answers: [
            {
              id: question.id,
              header: question.header,
              question: question.question,
              answer: "Small",
              optionIndex: 1,
              wasCustom: false,
            },
          ],
        };
  const respond = () =>
    faux.setResponses([
      scenario === "approve"
        ? fauxAssistantMessage("Synthetic implementation acknowledged")
        : fauxAssistantMessage(fauxToolCall("plan_mode_complete", { plan }, { id: "answer-completion" }), {
            stopReason: "toolUse",
          }),
    ]);
  const drive = async (f: Awaited<ReturnType<typeof open>>) => {
    if (scenario === "approve") await f.controller.approve(f.root, mutation, context);
    else await f.controller.answer(f.root, mutation as DurablePlanAnswers, context);
    const current = await f.controller.inspect(f.root, context);
    const taskId = current.receipts.find((receipt) => receipt.operationId === "operation")?.taskId;
    if (taskId === undefined) throw new Error("Missing persisted transition task");
    await f.harness.waitForTask(taskId, context);
    const placed = await f.controller.inspect(f.root, context);
    const receipt = placed.receipts.find((item) => item.operationId === "operation");
    if (receipt?.submissionId === undefined || receipt.status !== "done")
      throw new Error("Delivery did not place exact input");
    const input = await f.harness.submission(receipt.submissionId, context);
    if ((await required(input).wait(context)).status !== "done") throw new Error("Synthetic input failed");
    await f.root.waitForIdle(context);
    return f.controller.inspect(f.root, context);
  };
  return { storage, original, open, drive, respond };
}

// Characterize the complete successful commit sequence rather than guessing a fixed
// deadline, sleeping, or silently skipping injection points beyond a hard-coded count.
const checkpoints: Array<{ scenario: Scenario; commit: number; after: boolean }> = [];
for (const scenario of ["approve", "answer"] as const) {
  const f = await fixture(scenario);
  try {
    f.respond();
    f.storage.armed = true;
    await f.drive(f.original);
    for (let commit = 1; commit <= f.storage.commits; commit++) {
      checkpoints.push({ scenario, commit, after: false }, { scenario, commit, after: true });
    }
  } finally {
    await f.original.harness.close(context);
  }
}

it.each(checkpoints)(
  "$scenario recovers exactly one logical input after commit $commit (after=$after)",
  async ({ scenario, commit, after }) => {
    const f = await fixture(scenario);
    let recovered: Awaited<ReturnType<typeof f.open>> | undefined;
    try {
      f.storage.failAt = commit;
      f.storage.after = after;
      f.storage.armed = true;
      f.respond();
      await f.drive(f.original).catch(() => undefined);
      expect(f.storage.hit).toBe(true);
      await f.original.harness.close(context);
      f.storage.armed = false;
      recovered = await f.open();
      f.respond();
      const final = await f.drive(recovered);
      expect(final.phase).toBe(scenario === "approve" ? "implementing" : "ready");
      expect(final.plan).toBe(plan);
      expect(final.receipts.filter((receipt) => receipt.operationId === "operation")).toHaveLength(1);
      expect(final.delivery).toBeUndefined();
      const entries = await recovered.root.entries({ order: "ascending" }, 200, undefined, context);
      const deliveries = entries.items.filter((entry) => entry.kind === "plan-mode.input");
      expect(deliveries).toHaveLength(1);
      if (scenario === "approve") {
        expect(required(deliveries[0]).model?.[0]).toMatchObject({ role: "user", content: plan });
        expect(final.approval).toBeDefined();
      } else {
        expect(final.approval).toBeUndefined();
        const delivered = required(deliveries[0]).model?.[0];
        if (delivered?.role !== "user" || typeof delivered.content !== "string")
          throw new Error("Missing delivered answer text");
        expect(JSON.parse(delivered.content)).toMatchObject({
          type: "plan_mode_answers",
          answers: [{ answer: "Small" }],
        });
      }
    } finally {
      await recovered?.harness.close(context);
      await f.original.harness.close(context);
    }
  },
);
