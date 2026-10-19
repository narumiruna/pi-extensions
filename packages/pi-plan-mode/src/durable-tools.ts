import type { TSchema } from "@earendil-works/pi-ai";
import { defineTool, type ToolRegistration } from "@earendil-works/pi-durable";
import { PLAN_MODE_COMPLETE_PARAMS, PLAN_MODE_COMPLETE_TOOL_NAME } from "./completion-domain.js";
import { AUTHORIZATION_MEMO } from "./durable-policy.js";
import {
  fingerprint,
  recordHelper,
  type ToolAuthorization,
  validateOptions,
  validateState,
  WorkflowDoc,
} from "./durable-state.js";
import type { DurablePlanOptions } from "./durable-types.js";
import { PLAN_MODE_QUESTION_PARAMS, PLAN_MODE_QUESTION_TOOL_NAME } from "./question-domain.js";

/** Model-only helpers commit their proposal before returning a small terminating acknowledgment. */
export function createDurableTools(options: DurablePlanOptions): readonly ToolRegistration[] {
  validateOptions(options);
  const registryVersion = options.registryVersion;
  const capabilities = fingerprint(options.capabilities);
  const create = (kind: "question" | "complete", name: string, parameters: TSchema, description: string) =>
    defineTool({
      name,
      description,
      parameters,
      callers: ["model"],
      replay: "safe",
      outputLimits: { maxBytes: 50 * 1024, maxLines: 2_000 },
      execute: async (input, api, context) => {
        context.abortSignal?.throwIfAborted();
        const authorization = await api.memo<ToolAuthorization>(AUTHORIZATION_MEMO, context);
        if (
          authorization?.mode !== "plan" ||
          authorization.owner !== api.conversationId ||
          authorization.registryVersion !== registryVersion
        )
          throw new Error("Missing or invalid Plan helper authorization");
        const receipt = await api.commit(async (tx) => {
          const state = await tx.doc(WorkflowDoc, api.conversationId);
          validateState(state);
          if (
            state.owner !== api.conversationId ||
            state.workflowId === null ||
            state.workflowId !== authorization.workflowId ||
            state.closing ||
            state.registryVersion !== registryVersion ||
            fingerprint(state.capabilities) !== capabilities
          )
            throw new Error("Plan helper workflow is inactive or stale");
          const previous = state.helperReceipts.find((item) => item.taskId === api.taskId);
          if (
            previous &&
            (authorization.revision + 1 !== state.revision ||
              (state.phase !== "ready" && state.phase !== "awaiting_answers"))
          )
            throw new Error("Stale Plan helper replay authorization");
          context.abortSignal?.throwIfAborted();
          recordHelper(state, api.conversationId, api.taskId, kind, input, authorization, registryVersion);
          return { workflowId: state.workflowId, revision: state.revision, taskId: api.taskId, kind };
        }, context);
        return {
          output: [
            {
              type: "text",
              text:
                kind === "question"
                  ? "Clarification recorded. Await host answers."
                  : "Plan recorded. Await host review.",
            },
          ],
          details: receipt,
          control: { terminate: true },
        };
      },
    });
  return [
    create(
      "question",
      PLAN_MODE_QUESTION_TOOL_NAME,
      PLAN_MODE_QUESTION_PARAMS,
      "Ask one to three structured questions only when the host has activated the current durable Plan contract. Tool visibility alone does not activate Plan mode. The host records answers after this call terminates.",
    ),
    create(
      "complete",
      PLAN_MODE_COMPLETE_TOOL_NAME,
      PLAN_MODE_COMPLETE_PARAMS,
      "Submit a decision-ready plan only when the host has activated the current durable Plan contract, and call it alone as the final action. Tool visibility alone does not activate Plan mode. A proposal is not approval; only the host can approve implementation.",
    ),
  ];
}
