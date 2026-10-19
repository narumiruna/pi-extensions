import { awaitWithContext, BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall, Type } from "@earendil-works/pi-ai";
import {
  createRegistry,
  defineDoc,
  defineExtension,
  defineTool,
  Harness,
  hook,
  MemoryStorage,
  type ToolRegistration,
  ToolTask,
  wrapTool,
} from "@earendil-works/pi-durable";
import { afterEach, describe, expect, it } from "vitest";
import { required } from "./durable-test-values.js";

// Keep the committed in-memory ledger across Harness.close(), like reopening a disk backend.
class ReopenableStorage extends MemoryStorage {
  override async close() {}
}

const Workflow = defineDoc<{ active: boolean; revision: number }>({
  kind: "test.plan-mode.release-recovery",
  version: 1,
  scope: "conversation",
  history: "rewindable",
  fork: "asOf",
  initial: () => ({ active: true, revision: 1 }),
});
const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

function barrier() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function fixture(nested: boolean, guarded: boolean) {
  const entered = barrier();
  let executions = 0;
  let admissions = 0;
  let registryVersion = "reviewed-v1";
  let effects = 0;
  const storage = new ReopenableStorage();
  const faux = fauxProvider({ tokenSize: { min: 100_000, max: 100_000 } });
  const models = createModels();
  models.setProvider(faux.provider);
  const capability = defineTool({
    name: "inspect",
    description: "Synthetic reviewed capability",
    parameters: Type.Object({}),
    replay: "safe",
    execute: async (_args, _api, ctx) => {
      executions++;
      if (executions === 1) {
        entered.resolve();
        await awaitWithContext(new Promise<never>(() => {}), ctx);
      }
      effects++;
      return {};
    },
  });
  const orchestrator = defineTool({
    name: "orchestrator",
    description: "Call an independently admitted capability",
    parameters: Type.Object({}),
    replay: "safe",
    execute: async (_args, api, ctx) => {
      const result = await api.executeTool("inspect", {}, ctx, { key: "inspection" });
      return { isError: result.isError };
    },
  });
  const registry = createRegistry();
  registry.install(defineExtension({ name: "capabilities", tools: [capability, orchestrator] }));
  registry.install(
    defineExtension({
      name: "policy",
      hooks: [
        hook(ToolTask, {
          beforeTool: async (call, api, ctx) => {
            if (call.name !== "inspect") return;
            admissions++;
            const state = await api.snapshot(Workflow, api.conversationId, ctx);
            if (!state?.active) return { block: "workflow inactive" };
            await api.memo("authorization", { revision: state.revision, registryVersion }, ctx);
          },
        }),
      ],
      wraps: guarded
        ? [
            wrapTool(capability, (tool) => ({
              ...tool,
              execute: async (args, api, ctx) => {
                const authorization = await api.memo<{ revision: number; registryVersion: string }>(
                  "authorization",
                  ctx,
                );
                const state = await api.snapshot(Workflow, api.conversationId, ctx);
                if (
                  !state?.active ||
                  authorization?.revision !== state.revision ||
                  authorization.registryVersion !== registryVersion
                ) {
                  throw new Error("stale execution authorization");
                }
                return tool.execute(args, api, ctx);
              },
            })),
          ]
        : [],
    }),
  );
  const open = async () => {
    const harness = await Harness.open(
      storage,
      {
        models,
        registry,
        settings: { compaction: { enabled: false }, retry: { maxRetries: 0 } },
      },
      context,
    );
    cleanup.push(() => harness.close(context));
    return harness;
  };
  const first = await open();
  const root = await first.root(context, {
    agent: { model: { provider: faux.provider.id, modelId: faux.getModel().id } },
  });
  await root.commit(async (tx) => {
    await tx.doc(Workflow, root.id);
  }, context);
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall(nested ? "orchestrator" : "inspect", {}, { id: "inspection" }), {
      stopReason: "toolUse",
    }),
    fauxAssistantMessage("finished"),
  ]);
  const submission = await root.submit({ type: "input", content: "inspect", requestId: "inspection" }, context);
  await entered.promise;
  await first.close(context);
  return {
    open,
    root,
    submission,
    registry,
    capability,
    counters: () => ({ executions, admissions, effects }),
    changeRegistry: (replacement?: ToolRegistration) => {
      registryVersion = "reviewed-v2";
      registry.install(defineExtension({ name: "capabilities", tools: [replacement ?? capability, orchestrator] }));
    },
  };
}

describe("published durable release: recovered execution", () => {
  it.each([false, true])("recovery bypasses beforeTool for nested=%s", async (nested) => {
    const f = await fixture(nested, false);
    const reopened = await f.open();
    const same = await reopened.root(context);
    await same.commit(async (tx) => {
      (await tx.doc(Workflow, same.id)).active = false;
    }, context);
    const submission = await reopened.submission(f.submission.id, context);
    expect((await required(submission).wait(context)).status).toBe("done");
    expect(f.counters()).toEqual({ executions: 2, admissions: 1, effects: 1 });
  });

  it.each([false, true])("execution guards reject revoked workflow authorization for nested=%s", async (nested) => {
    const f = await fixture(nested, true);
    const reopened = await f.open();
    const same = await reopened.root(context);
    await same.commit(async (tx) => {
      (await tx.doc(Workflow, same.id)).active = false;
    }, context);
    await required(await reopened.submission(f.submission.id, context)).wait(context);
    expect(f.counters()).toEqual({ executions: 1, admissions: 1, effects: 0 });
  });

  it.each([false, true])("execution guards reject registry replacement on recovery for nested=%s", async (nested) => {
    const f = await fixture(nested, true);
    let replacementEffects = 0;
    f.changeRegistry(
      defineTool({
        ...f.capability,
        execute: async () => {
          replacementEffects++;
          return {};
        },
      }),
    );
    const reopened = await f.open();
    await required(await reopened.submission(f.submission.id, context)).wait(context);
    expect(replacementEffects).toBe(0);
    expect(f.counters()).toEqual({ executions: 1, admissions: 1, effects: 0 });
  });
});
