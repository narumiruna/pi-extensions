import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall, Type } from "@earendil-works/pi-ai";
import {
  createRegistry,
  defineExtension,
  defineTool,
  type Extension,
  Harness,
  type JsonObject,
  MemoryStorage,
  type ToolRegistration,
} from "@earendil-works/pi-durable";
import { afterEach } from "vitest";
import { createDurablePolicy } from "../src/durable-policy.js";
import { initialState, WorkflowDoc } from "../src/durable-state.js";
import { createDurableTools } from "../src/durable-tools.js";
import type { DurablePlanCapability } from "../src/durable-types.js";

export { context, defineTool, fauxAssistantMessage, fauxToolCall, Type, WorkflowDoc };

class ReopenableStorage extends MemoryStorage {
  override async close() {}
}
const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
export function barrier() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
export async function fixture(
  input: {
    tools?: ToolRegistration[];
    capabilities?: DurablePlanCapability[];
    wraps?: Extension["wraps"];
    extensions?: Extension[];
    hooks?: Extension["hooks"];
    storage?: MemoryStorage;
    registryVersion?: string;
  } = {},
) {
  const storage = input.storage ?? new ReopenableStorage();
  const raw = createRegistry();
  const options = {
    registry: raw,
    registryVersion: input.registryVersion ?? "reviewed-v1",
    capabilities: input.capabilities ?? [{ name: "inspect", policy: "read-only" as const }],
  };
  let harness: Harness | undefined;
  const policy = createDurablePolicy(options, () => harness);
  const helpers = createDurableTools(options);
  const capability = defineExtension({
    name: "capabilities",
    tools: input.tools ?? [],
    ...(input.wraps ? { wraps: input.wraps } : {}),
  });
  raw.install(capability);
  const extension = defineExtension({
    name: "plan",
    tools: helpers,
    hooks: [policy.hook, ...(input.hooks ?? [])],
    sections: [policy.section],
  });
  raw.install(extension);
  for (const extra of input.extensions ?? []) raw.install(extra);
  const faux = fauxProvider({ tokenSize: { min: 100_000, max: 100_000 } });
  const models = createModels();
  models.setProvider(faux.provider);
  const open = async () => {
    harness = await Harness.open(
      storage,
      {
        registry: policy.reader,
        models,
        settings: { compaction: { enabled: false, keepRecentTokens: 0 }, retry: { maxRetries: 0 } },
      },
      context,
    );
    const opened = harness;
    cleanup.push(() => opened.close(context));
    return opened;
  };
  const opened = await open();
  const root = await opened.root(context, {
    agent: { model: { provider: faux.provider.id, modelId: faux.getModel().id } },
  });
  const activate = async () =>
    root.commit(async (tx) => {
      Object.assign(await tx.doc(WorkflowDoc, root.id), {
        ...initialState(root.id),
        workflowId: "workflow",
        revision: 1,
        phase: "planning",
        registryVersion: options.registryVersion,
        capabilities: structuredClone(options.capabilities),
      });
    }, context);
  const call = async (name: string, args: JsonObject = {}) => {
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall(name, args, { id: `call-${name}` }), { stopReason: "toolUse" }),
      fauxAssistantMessage("finished"),
    ]);
    return (await root.submit({ type: "input", content: name }, context)).wait(context);
  };
  return {
    storage,
    raw,
    policy,
    options,
    helpers,
    extension,
    capability,
    root,
    faux,
    open,
    activate,
    call,
    get harness() {
      if (!harness) throw new Error("Harness is not open");
      return harness;
    },
  };
}
