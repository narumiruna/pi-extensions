import { defineExtension } from "@earendil-works/pi-durable";
import { createControllerRuntime } from "./durable-controller.js";
import { createDurablePolicy } from "./durable-policy.js";
import { validateOptions } from "./durable-state.js";
import { createDurableTools } from "./durable-tools.js";
import type { DurablePlanIntegration, DurablePlanOptions } from "./durable-types.js";

export type {
  DurablePlanAnswers,
  DurablePlanCapability,
  DurablePlanController,
  DurablePlanIdentity,
  DurablePlanIntegration,
  DurablePlanMutation,
  DurablePlanOptions,
  DurablePlanPhase,
  DurablePlanReceipt,
  DurablePlanRevision,
  DurablePlanStart,
  DurablePlanState,
  DurablePlanView,
} from "./durable-types.js";

/** Construct a native headless integration without starting work or reading coding-agent settings. */
export function createDurablePlanMode(input: DurablePlanOptions): DurablePlanIntegration {
  validateOptions(input);
  const options: DurablePlanOptions = Object.freeze({
    registry: input.registry,
    registryVersion: input.registryVersion,
    capabilities: Object.freeze(
      input.capabilities.map((capability) => Object.freeze({ name: capability.name, policy: capability.policy })),
    ),
  });
  const controller = createControllerRuntime(options);
  const policy = createDurablePolicy(options, controller.getHarness);
  return {
    extension: defineExtension({
      name: "narumitw.plan-mode.durable",
      tools: createDurableTools(options),
      hooks: [policy.hook],
      sections: [policy.section],
      tasks: [controller.task],
    }),
    registry: policy.reader,
    createController: controller.bind,
  };
}
