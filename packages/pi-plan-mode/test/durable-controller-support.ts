import type { Context } from "@earendil-works/chord";
import { awaitWithContext, BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall, Type } from "@earendil-works/pi-ai";
import {
  createRegistry,
  defineExtension,
  defineTask,
  defineTool,
  Harness,
  MemoryStorage,
  type StorageWrite,
} from "@earendil-works/pi-durable";
import { createControllerRuntime } from "../src/durable-controller.js";
import { WorkflowDoc } from "../src/durable-state.js";
import type { DurablePlanView } from "../src/durable-types.js";

export function barrier() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

export class ControllerStorage extends MemoryStorage {
  fail?: (writes: readonly StorageWrite[]) => boolean;
  readonly failure = barrier();
  beforeCommit?: (writes: readonly StorageWrite[]) => Promise<void>;
  afterCommit?: (writes: readonly StorageWrite[]) => void;
  beforeSubmissionByRequest?: (requestId: string, ctx: Context) => Promise<void>;
  override async submissionByRequest(
    id: Parameters<MemoryStorage["submissionByRequest"]>[0],
    requestId: string,
    ctx: Context,
  ) {
    await this.beforeSubmissionByRequest?.(requestId, ctx);
    return super.submissionByRequest(id, requestId, ctx);
  }
  override async commit(writes: readonly StorageWrite[], ctx: Context) {
    await this.beforeCommit?.(writes);
    if (this.fail?.(writes)) {
      this.fail = undefined;
      this.failure.resolve();
      throw new Error("Synthetic storage failure");
    }
    const result = await super.commit(writes, ctx);
    this.afterCommit?.(writes);
    return result;
  }
  override async close() {}
}

export async function controllerFixture(storage = new ControllerStorage()) {
  const entered = barrier();
  const release = barrier();
  let heldExecutions = 0;
  const hold = defineTool({
    name: "hold",
    description: "Hold one synthetic round",
    parameters: Type.Object({}),
    replay: "safe",
    execute: async (_input, _api, ctx) => {
      heldExecutions++;
      entered.resolve();
      await awaitWithContext(release.promise, ctx);
      return { control: { terminate: true } };
    },
  });
  const unrelated = defineTask<Record<string, never>, { phase: "hold" }, Record<string, never>>({
    name: "test.unrelated",
    version: 1,
    initial: () => ({ phase: "hold" }),
    phases: {
      hold: async (_task, runtime, ctx) => {
        await awaitWithContext(release.promise, ctx);
        await runtime.commit(() => ({ status: "terminal", outcome: { status: "completed", result: {} } }), ctx);
      },
    },
    abort: async (_task, runtime, ctx) => {
      await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), ctx);
    },
  });
  const registry = createRegistry();
  const options = {
    registry,
    registryVersion: "reviewed-v1",
    capabilities: [{ name: "hold", policy: "read-only" as const }],
  };
  const runtime = createControllerRuntime(options);
  registry.install(defineExtension({ name: "test.controller", tasks: [runtime.task, unrelated], tools: [hold] }));
  const faux = fauxProvider({ tokenSize: { min: 100_000, max: 100_000 } });
  const models = createModels();
  models.setProvider(faux.provider);
  const harness = await Harness.open(
    storage,
    {
      models,
      registry,
      settings: { compaction: { enabled: false }, retry: { maxRetries: 0 } },
    },
    context,
  );
  const controller = runtime.bind(harness);
  const root = await harness.root(context, {
    agent: { model: { provider: faux.provider.id, modelId: faux.getModel().id } },
  });
  const identity = (view: DurablePlanView) => ({ workflowId: view.workflowId, revision: view.revision });
  const start = () =>
    controller.start(
      root,
      { operationId: "start", workflowId: "workflow-1", expected: { workflowId: null, revision: 0 } },
      context,
    );
  const ready = async () => {
    await start();
    await root.commit(async (tx) => {
      const state = await tx.doc(WorkflowDoc, root.id);
      state.revision++;
      state.plan = "# EXACT PLAN\n\n1. Add focused tests.\n";
      state.phase = "ready";
    }, context);
    return controller.inspect(root, context);
  };
  const busy = async () => {
    faux.setResponses([fauxAssistantMessage(fauxToolCall("hold", {}, { id: "hold" }), { stopReason: "toolUse" })]);
    const submission = await root.submit({ type: "input", content: "competing input" }, context);
    await entered.promise;
    return submission;
  };
  const settle = async (operationId: string) => {
    const view = await controller.inspect(root, context);
    const taskId = view.receipts.find((receipt) => receipt.operationId === operationId)?.taskId;
    if (taskId === undefined) throw new Error("Missing delivery task");
    await harness.waitForTask(taskId, context);
    return controller.inspect(root, context);
  };
  return {
    storage,
    registry,
    options,
    runtime,
    harness,
    controller,
    root,
    faux,
    models,
    identity,
    start,
    ready,
    busy,
    settle,
    entered,
    release,
    unrelated,
    heldExecutions: () => heldExecutions,
    close: () => harness.close(context),
    reopen: async () => {
      const recoveredRuntime = createControllerRuntime(options);
      registry.install(
        defineExtension({ name: "test.controller", tasks: [recoveredRuntime.task, unrelated], tools: [hold] }),
      );
      const reopened = await Harness.open(
        storage,
        { models, registry, settings: { compaction: { enabled: false }, retry: { maxRetries: 0 } } },
        context,
      );
      const recoveredController = recoveredRuntime.bind(reopened);
      const recoveredRoot = await reopened.root(context);
      return { harness: reopened, controller: recoveredController, root: recoveredRoot };
    },
  };
}
