import type { Context } from "@earendil-works/chord/context";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
  CompactionTask,
  type ConversationId,
  defineDoc,
  defineExtension,
  GenerationTask,
  type Harness,
  type HookApi,
  hook,
  ProviderDoc,
  type TaskId,
  type ToolRegistration,
  wrapTool,
} from "@earendil-works/pi-durable";
import { context } from "./durable-fixture.js";
import type { HostAttempt, HostPermit } from "./durable-host-models.js";

type Binding = { conversationId: ConversationId; taskId: TaskId; goal: string; activation: number };
type Reservation = Binding & {
  method: HostAttempt["method"];
  status: "reserved" | "pending" | "uncertain";
  attempt: number;
  cutoff: number;
  handle?: string;
};
export type HostLedgerState = {
  goal: string;
  activation: number;
  conversationId: ConversationId;
  active: boolean;
  responses: number;
  tokens: number;
  responseLimit: number;
  tokenLimit: number;
  toolAuthority?: Binding;
  outstanding?: Reservation;
};

/** Repository-only ledger. An absent state grants no Goal authority. */
export const HostSeedDoc = defineDoc<{ state?: HostLedgerState }>({
  kind: "test.goal-host-seed",
  version: 1,
  scope: "conversation",
  history: "rewindable",
  fork: "asOf",
  initial: () => ({}),
});

export function createHostLedger(
  options: {
    tools?: ToolRegistration[];
    beforeAdmission?: (attempt: HostAttempt) => Promise<void>;
    beforeReceipt?: (message: AssistantMessage) => Promise<void>;
    afterReceipt?: (message: AssistantMessage) => Promise<void>;
    backgroundTokens?: () => number;
  } = {},
) {
  const bindings = new WeakMap<AbortSignal, Binding>();
  let harness: Harness;
  let owner: ConversationId;
  const attempts: HostAttempt[] = [];
  const bound: Binding[] = [];
  const denials: string[] = [];
  const polls: { taskId: TaskId; attempt: number; cutoff: number; pollAt: number }[] = [];
  const snapshot = () => harness.snapshot(HostSeedDoc, owner, context).then((value) => value?.state);

  async function bind(api: HookApi, ctx: Context) {
    if (ctx.abortSignal === undefined) throw new Error("Missing hook signal");
    const state = (await api.snapshot(HostSeedDoc, api.conversationId, ctx))?.state;
    ctx.abortSignal.throwIfAborted();
    const binding = {
      conversationId: api.conversationId,
      taskId: api.taskId,
      goal: state?.goal ?? "",
      activation: state?.activation ?? 0,
    };
    bindings.set(ctx.abortSignal, binding);
    bound.push(binding);
    return undefined;
  }

  function valid(state: HostLedgerState, binding: Binding) {
    const backgroundTokens = options.backgroundTokens?.() ?? 0;
    if (backgroundTokens !== 0) throw new Error("Incompatible background compaction profile");
    if (
      !state.active ||
      state.conversationId !== binding.conversationId ||
      state.goal !== binding.goal ||
      state.activation !== binding.activation
    )
      throw new Error("Stale Goal activation or fork");
    if (state.responses >= state.responseLimit || state.tokens >= state.tokenLimit)
      throw new Error("Goal response/token limit exhausted");
  }

  const admit = async (attempt: HostAttempt): Promise<HostPermit> => {
    attempts.push(attempt);
    try {
      await options.beforeAdmission?.(attempt);
      attempt.signal?.throwIfAborted();
      let binding = attempt.signal === undefined ? undefined : bindings.get(attempt.signal);
      // Polls have no beforeRequest hook or sessionId. Only a durable handle
      // receipt may recover their identity. No authority comes from prompt text.
      if (attempt.method === "fetchDeferred") {
        const outstanding = (await snapshot())?.outstanding;
        if (outstanding?.handle === undefined || outstanding.handle !== JSON.stringify(attempt.handle))
          throw new Error("Unknown deferred handle");
        binding = outstanding;
      }
      if (binding === undefined) throw new Error("Missing trusted request binding");
      const identity = binding;
      const guarded = await harness.commit(async (tx) => {
        attempt.signal?.throwIfAborted();
        const task = await tx.task(identity.taskId);
        if (
          task === undefined ||
          task.conversationId !== identity.conversationId ||
          task.abortRequested ||
          task.state.status !== "running"
        )
          throw new Error("Stale native task");
        const checkpoint = task.state.checkpoint;
        if (typeof checkpoint !== "object" || checkpoint === null || Array.isArray(checkpoint))
          throw new Error("Missing public checkpoint");
        if (attempt.method === "fetchDeferred") {
          if (
            checkpoint.phase !== "poll" ||
            typeof checkpoint.pollAt !== "number" ||
            JSON.stringify(checkpoint.handle) !== JSON.stringify(attempt.handle)
          )
            throw new Error("Stale poll checkpoint");
          polls.push({
            taskId: identity.taskId,
            attempt: Number(checkpoint.attempt),
            cutoff: Number(checkpoint.cutoff),
            pollAt: checkpoint.pollAt,
          });
        } else {
          const provider = await tx.doc(ProviderDoc, identity.conversationId);
          if (provider.sessionId !== attempt.sessionId) throw new Error("Provider session mismatch");
          if (checkpoint.phase !== (attempt.method === "completeSimple" ? "summarize" : "request"))
            throw new Error("Wrong native request phase");
        }
        const state = (await tx.doc(HostSeedDoc, identity.conversationId)).state;
        // A hook-bound unrelated conversation remains unaffected. This probe
        // does not yet cover unrelated deferred requests or unselected hooks.
        if (state === undefined) return false;
        valid(state, identity);
        if (attempt.method === "fetchDeferred") {
          if (state.outstanding?.status !== "pending" || state.outstanding.taskId !== identity.taskId)
            throw new Error("Uncertain poll receipt");
        } else if (state.outstanding !== undefined) throw new Error("Outstanding or uncertain reservation");
        state.outstanding = {
          ...identity,
          method: attempt.method,
          status: "reserved",
          attempt: Number(checkpoint.attempt),
          cutoff: Number(checkpoint.cutoff ?? checkpoint.tail),
          ...(attempt.handle === undefined ? {} : { handle: JSON.stringify(attempt.handle) }),
        };
        return true;
      }, context);
      attempt.signal?.throwIfAborted();
      return {
        finish: async (message) => {
          if (!guarded) return;
          await options.beforeReceipt?.(message);
          await harness.commit(async (tx) => {
            const state = (await tx.doc(HostSeedDoc, identity.conversationId)).state;
            if (
              state === undefined ||
              state.goal !== identity.goal ||
              state.activation !== identity.activation ||
              state.outstanding?.taskId !== identity.taskId
            )
              throw new Error("Stale terminal receipt");
            const receipt = state.outstanding;
            if (message.stopReason === "deferred" && message.deferred !== undefined) {
              receipt.handle = JSON.stringify(message.deferred);
              receipt.status = "pending";
            } else {
              const tokens = message.usage.totalTokens;
              if (!Number.isFinite(tokens) || tokens < 0) throw new Error("Invalid usage");
              state.tokens += tokens;
              state.responses++;
              // A failed/aborted dispatch is not proof that the provider did
              // no work. Retain a fail-closed receipt rather than refund it.
              if (message.stopReason === "error" || message.stopReason === "aborted") receipt.status = "uncertain";
              else {
                if (attempt.method !== "completeSimple") state.toolAuthority = identity;
                delete state.outstanding;
              }
            }
          }, context);
          await options.afterReceipt?.(message);
        },
      };
    } catch (error) {
      denials.push(error instanceof Error ? error.message : String(error));
      throw error;
    }
  };

  const extension = defineExtension({
    name: "test-host-admission",
    tools: options.tools,
    hooks: [
      hook(GenerationTask, { beforeRequest: (_request, api, ctx) => bind(api, ctx) }),
      hook(CompactionTask, { beforeCompact: (_request, api, ctx) => bind(api, ctx) }),
    ],
    wraps: options.tools?.map((tool) =>
      wrapTool(tool, (target) => ({
        ...target,
        execute: async (args, api, ctx) => {
          await api.commit(async (tx) => {
            // Nested calls and safe replay retain their native owner chain.
            // Resolve the generation before doc writes; never trust arguments.
            let task = await tx.task(api.taskId);
            while (task?.kind === "pi.tool" && task.owner !== undefined) task = await tx.task(task.owner);
            const state = (await tx.doc(HostSeedDoc, api.conversationId)).state;
            if (state === undefined) return;
            const authority = state.toolAuthority;
            if (task?.kind !== "pi.generation" || authority?.taskId !== task.id)
              throw new Error("Missing originating generation authority");
            valid(state, authority);
            if (state.outstanding !== undefined) throw new Error("Uncertain Goal tool admission");
          }, ctx);
          ctx.abortSignal?.throwIfAborted();
          // This is a start guard, not an atomic external-effect transaction.
          // A tool that awaits internally must also revalidate before effects.
          return target.execute(args, api, ctx);
        },
      })),
    ),
  });

  return {
    extension,
    admit,
    snapshot,
    attempts,
    bound,
    denials,
    polls,
    attach(value: Harness, conversationId: ConversationId) {
      harness = value;
      owner = conversationId;
    },
    async activate(limits: Partial<Pick<HostLedgerState, "responseLimit" | "tokenLimit">> = {}) {
      await harness.commit(async (tx) => {
        (await tx.doc(HostSeedDoc, owner)).state = {
          goal: "goal-one",
          activation: 1,
          conversationId: owner,
          active: true,
          responses: 0,
          tokens: 0,
          responseLimit: 25,
          tokenLimit: 1_000_000,
          ...limits,
        };
      }, context);
    },
  };
}
