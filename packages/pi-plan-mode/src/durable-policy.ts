import type { Context } from "@earendil-works/chord";
import {
  type ConversationId,
  type Harness,
  type HookApi,
  type HookRegistration,
  hook,
  LiveDoc,
  type PromptSection,
  type RegistryReader,
  type RegistrySnapshot,
  section,
  type ToolRegistration,
  ToolTask,
  type Tx,
} from "@earendil-works/pi-durable";
import { PLAN_MODE_COMPLETE_TOOL_NAME } from "./completion-domain.js";
import { matchesPlanInput } from "./durable-input.js";
import {
  fingerprint,
  initialState,
  type ToolAuthorization,
  validateOptions,
  validateState,
  WorkflowDoc,
} from "./durable-state.js";
import type { DurablePlanOptions, DurablePlanState } from "./durable-types.js";
import { PLAN_MODE_QUESTION_TOOL_NAME } from "./question-domain.js";
import { isSafeCommand, isSafePowerShellCommand } from "./shell-policy.js";

export const AUTHORIZATION_MEMO = "narumitw.plan-mode.authorization";
export const PLAN_CONTRACT =
  "[PI DURABLE PLAN MODE v1: PLAN]\nPlan mode is active or execution is restricted. Use only host-reviewed read-only capabilities. Do not edit, write, or implement. Ask clarification with plan_mode_question. Submit a decision-ready plan with plan_mode_complete alone as the final action. Tool visibility is not activation or approval. Only the host can approve implementation.";
export const NORMAL_CONTRACT =
  "[PI DURABLE PLAN MODE v1: NORMAL]\nPlan mode is inactive or the host approved implementation in this conversation. Follow the current user request. Do not call plan_mode_question or plan_mode_complete. Tool visibility does not activate Plan mode.";

function helperKind(name: string) {
  return name === PLAN_MODE_QUESTION_TOOL_NAME
    ? "question"
    : name === PLAN_MODE_COMPLETE_TOOL_NAME
      ? "complete"
      : undefined;
}

/** Request IDs are deduplication keys, not proof of which content was placed. */
async function placedInput(
  tx: Tx,
  owner: ConversationId,
  state: DurablePlanState,
  requestId: string,
  content: string,
  liveOnly: boolean,
) {
  const receipt = await tx.submissionByRequest(owner, requestId);
  if (
    receipt?.type !== "input" ||
    receipt.conversationId !== owner ||
    receipt.requestId !== requestId ||
    (receipt.status !== "placed" && receipt.status !== "done")
  )
    return false;
  const entry = await tx.entry(receipt.entry);
  if (
    state.workflowId === null ||
    !state.delivery ||
    !matchesPlanInput(
      entry,
      owner,
      {
        workflowId: state.workflowId,
        revision: state.revision,
        operationId: state.delivery.operationId,
      },
      content,
    )
  )
    return false;
  const live = await tx.doc(LiveDoc, owner);
  return live.run?.inputs.includes(receipt.id) === true || (!liveOnly && receipt.status === "done");
}

async function modeInTransaction(
  tx: Tx,
  owner: ConversationId,
  state: DurablePlanState,
  liveOnly: boolean,
): Promise<"plan" | "normal"> {
  if (state.workflowId === null) return state.closing || state.delivery ? "plan" : "normal";
  if (state.owner !== owner || state.closing) return "plan";
  if (state.phase === "inactive") return state.delivery ? "plan" : "normal";
  if (
    state.phase === "implementing" &&
    !state.delivery &&
    state.plan !== undefined &&
    state.plan.trim().length > 0 &&
    state.approval &&
    Number.isSafeInteger(state.approval.submissionId) &&
    state.approval.submissionId !== undefined &&
    state.approval.submissionId > 0 &&
    state.approval.planRevision === state.revision - 1
  )
    return "normal";
  if (
    state.phase === "handoff_pending" &&
    state.approval &&
    state.plan !== undefined &&
    state.approval.planRevision === state.revision - 1 &&
    state.delivery?.kind === "approve" &&
    state.delivery.revision === state.revision &&
    state.delivery.requestId === state.approval.requestId &&
    (await placedInput(tx, owner, state, state.approval.requestId, state.plan, liveOnly))
  )
    return "normal";
  return "plan";
}

function authorization(
  state: DurablePlanState,
  owner: number,
  registryVersion: string,
  mode: "plan" | "normal",
): ToolAuthorization {
  return { owner, workflowId: state.workflowId, revision: state.revision, registryVersion, mode };
}

/** The facade is mandatory: selected extension hooks alone cannot guard recovery or deselection. */
export function createDurablePolicy(
  options: DurablePlanOptions,
  getHarness: () => Harness | undefined,
): { reader: RegistryReader; hook: HookRegistration; section: PromptSection } {
  validateOptions(options);
  const version = options.registryVersion;
  const registry = options.registry;
  const capabilities = structuredClone([...options.capabilities]);
  const reviewed = fingerprint(capabilities);
  let sealed: RegistrySnapshot | undefined;
  let transformed: RegistrySnapshot | undefined;
  const assertRegistry = () => {
    const raw = registry.snapshot();
    if (sealed !== undefined && raw !== sealed)
      throw new Error("Reviewed Plan registry changed; restart the host with a new reviewed registryVersion");
    sealed ??= raw;
    return raw;
  };
  const validateFrozen = (state: DurablePlanState) => {
    validateState(state);
    if (
      state.workflowId !== null &&
      (state.phase !== "inactive" || state.closing || state.delivery) &&
      (state.registryVersion !== version || fingerprint(state.capabilities) !== reviewed)
    )
      throw new Error("Frozen Plan capabilities or registryVersion changed");
  };
  const check = async (
    tx: Tx,
    api: Pick<HookApi, "conversationId" | "taskId">,
    name: string,
    args: unknown,
    memo?: ToolAuthorization,
  ) => {
    const state = await tx.doc(WorkflowDoc, api.conversationId);
    validateFrozen(state);
    const kind = helperKind(name);
    const mode = await modeInTransaction(tx, api.conversationId, state, true);
    const expected = authorization(state, api.conversationId, version, mode);
    if (kind) {
      const replay = state.helperReceipts.find((receipt) => receipt.taskId === api.taskId);
      if (replay) {
        if (
          state.owner !== api.conversationId ||
          state.closing ||
          state.workflowId === null ||
          replay.kind !== kind ||
          replay.workflowId !== state.workflowId ||
          replay.revision !== state.revision ||
          replay.fingerprint !== fingerprint({ kind, input: args }) ||
          (state.phase !== "ready" && state.phase !== "awaiting_answers") ||
          (memo &&
            (memo.owner !== api.conversationId ||
              memo.mode !== "plan" ||
              memo.workflowId !== state.workflowId ||
              memo.revision + 1 !== replay.revision ||
              memo.registryVersion !== version))
        )
          throw new Error("Stale or changed Plan helper replay");
        return memo ?? { ...expected, mode: "plan" as const, revision: state.revision - 1 };
      }
      if (
        state.owner !== api.conversationId ||
        state.workflowId === null ||
        state.phase !== "planning" ||
        state.closing
      )
        throw new Error("Plan helper is inactive or stale");
    }
    if (memo && fingerprint(memo) !== fingerprint(expected)) throw new Error("Stale Plan execution authorization");
    if (mode === "normal") {
      if (kind) throw new Error("Plan helpers are unavailable in Normal mode");
      return expected;
    }
    if (state.owner !== api.conversationId || state.workflowId === null || state.closing || state.phase !== "planning")
      throw new Error("Plan workflow does not admit tools in its current phase");
    if (state.delivery) {
      const delivery = state.delivery;
      if (
        !delivery.requestId ||
        delivery.content === undefined ||
        delivery.revision !== state.revision ||
        !(await placedInput(tx, api.conversationId, state, delivery.requestId, delivery.content, true))
      )
        throw new Error("Only the exact pending Plan delivery may run tools");
    }
    if (kind) return expected;
    if (["edit", "write", "update_plan"].includes(name)) throw new Error(`Plan mode cannot execute ${name}`);
    const capability = capabilities.find((candidate) => candidate.name === name);
    if (!capability) throw new Error(`Tool ${name} is not a reviewed Plan capability`);
    if (capability.policy !== "read-only") {
      const command = typeof args === "object" && args !== null ? (args as { command?: unknown }).command : undefined;
      if (
        typeof command !== "string" ||
        !(capability.policy === "bash" ? isSafeCommand(command) : isSafePowerShellCommand(command))
      )
        throw new Error("Shell command is not read-only under the Plan policy");
    }
    return expected;
  };

  const admit = async (name: string, args: unknown, api: HookApi, context: Context) => {
    assertRegistry();
    const harness = getHarness();
    if (!harness) throw new Error("Bind the Plan Harness before executing tools");
    const candidate = await harness.commit((tx) => check(tx, api, name, args), context);
    assertRegistry();
    const memo = await api.memo<ToolAuthorization>(AUTHORIZATION_MEMO, candidate, context);
    // Memos are immutable. Re-read after publication so admission cannot bless a stale workflow.
    await harness.commit((tx) => check(tx, api, name, args, memo), context);
    assertRegistry();
  };
  const admissionHook = hook(ToolTask, {
    beforeTool: async (call, api, context) => {
      await admit(call.name, call.arguments, api, context);
    },
  });
  const guards = new WeakMap<ToolRegistration, ToolRegistration>();
  const guard = (tool: ToolRegistration): ToolRegistration => {
    const previous = guards.get(tool);
    if (previous) return previous;
    const guarded: ToolRegistration = {
      ...tool,
      execute: async (args, api, context) => {
        assertRegistry();
        context.abortSignal?.throwIfAborted();
        let memo = await api.memo<ToolAuthorization>(AUTHORIZATION_MEMO, context);
        if (!memo) {
          // A deselected hook must not turn a recovered planning task into a fresh authorization.
          const current = await api.snapshot(WorkflowDoc, api.conversationId, context);
          if (current?.workflowId !== undefined && current.workflowId !== null)
            throw new Error("Missing Plan execution authorization");
          memo = await api.memo<ToolAuthorization>(
            AUTHORIZATION_MEMO,
            authorization(current ?? initialState(api.conversationId), api.conversationId, version, "normal"),
            context,
          );
        }
        await api.commit(async (tx) => {
          const admitted = await check(tx, api, tool.name, args, memo);
          const state = await tx.doc(WorkflowDoc, api.conversationId);
          if (
            state.delivery &&
            ((admitted.mode === "normal" && state.delivery.kind === "approve") ||
              (admitted.mode === "plan" && state.phase === "planning"))
          ) {
            const delivery = state.delivery;
            // check() proved that this exact marked input belongs to the current live run.
            const receipt = state.receipts.find((item) => item.operationId === delivery.operationId);
            if (!receipt || !delivery.requestId) throw new Error("Missing pending Plan delivery receipt");
            const submission = await tx.submissionByRequest(api.conversationId, delivery.requestId);
            if (!submission) throw new Error("Missing placed Plan delivery");
            receipt.status = "done";
            receipt.submissionId = submission.id;
            if (delivery.kind === "approve") {
              if (!state.approval) throw new Error("Missing Plan approval");
              state.approval.submissionId = submission.id;
              state.phase = "implementing";
            }
            delete state.delivery;
          }
        }, context);
        assertRegistry();
        context.abortSignal?.throwIfAborted();
        return tool.execute(args, api, context);
      },
    };
    guards.set(tool, guarded);
    guards.set(guarded, guarded);
    return guarded;
  };
  const reader: RegistryReader = {
    snapshot() {
      const raw = assertRegistry();
      if (transformed) return transformed;
      const extensions = raw.installed().map((extension) => ({
        ...extension,
        // A selected tool owner must admit fresh calls even when the Plan extension is deselected.
        // Recovery skips beforeTool, so missing or stale task authorization still fails closed.
        ...(extension.tools?.length && !extension.hooks?.includes(admissionHook)
          ? {
              hooks: [
                ...(extension.hooks ?? []),
                hook(ToolTask, {
                  beforeTool: async (call, api, context) => {
                    if (extension.tools?.some((tool) => tool.name === call.name))
                      await admit(call.name, call.arguments, api, context);
                  },
                }),
              ],
            }
          : {}),
        ...(extension.tools === undefined ? {} : { tools: extension.tools.map(guard) }),
        ...(extension.wraps === undefined
          ? {}
          : {
              wraps: extension.wraps.map((wrap) =>
                "tool" in wrap
                  ? {
                      ...wrap,
                      wrap: (tool: ToolRegistration) => {
                        assertRegistry();
                        return guard(wrap.wrap(tool));
                      },
                    }
                  : wrap,
              ),
            }),
      }));
      const byName = new Map(extensions.map((extension) => [extension.name, extension]));
      transformed = {
        installed: () => extensions,
        extension: (name) => byName.get(name),
        tools: () => extensions.flatMap((extension) => (extension.tools ?? []).map((tool) => ({ extension, tool }))),
        sections: () =>
          extensions.flatMap((extension) => (extension.sections ?? []).map((item) => ({ extension, section: item }))),
        tasks: () => raw.tasks(),
        task: (name) => raw.task(name),
      };
      return transformed;
    },
    subscribe: (listener) => registry.subscribe(listener),
  };
  return {
    reader,
    hook: admissionHook,
    section: section(
      "plan_mode",
      async (input, context) => {
        const harness = getHarness();
        if (harness)
          return harness.commit(async (tx) => {
            const state = await tx.doc(WorkflowDoc, input.conversationId);
            validateFrozen(state);
            return (await modeInTransaction(tx, input.conversationId, state, false)) === "normal"
              ? NORMAL_CONTRACT
              : PLAN_CONTRACT;
          }, context);
        const state = await input.read.snapshot(WorkflowDoc, input.conversationId, context);
        if (state) validateFrozen(state);
        return state === undefined || (state.workflowId === null && !state.closing) ? NORMAL_CONTRACT : PLAN_CONTRACT;
      },
      { tag: false },
    ),
  };
}
