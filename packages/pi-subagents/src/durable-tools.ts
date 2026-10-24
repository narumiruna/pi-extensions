import path from "node:path";
import { awaitWithContext, BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/chord/context";
import { StringEnum, Type } from "@earendil-works/pi-ai";
import { type ExtensionAPI, type ExtensionContext, getAgentDir } from "@earendil-works/pi-coding-agent";
import type { Static } from "typebox";
import type { DurableMainBridge } from "./durable-main-bridge.js";
import type { DurableProfile, DurableRuntimeOptions, DurableSubagentRuntime } from "./durable-runtime.js";
import { validateMessage } from "./message-broker.js";
import { modelVisibleJson } from "./model-output.js";
import { prepareTimeoutArguments, resolveTimeoutMs } from "./timeout.js";
import { CHILD_CORE_TOOL_NAMES, SUBAGENT_THINKING_LEVELS } from "./types.js";

const Id = Type.String({
  description: "Session-owned conversationId returned by subagent_spawn.",
  pattern: "^[1-9][0-9]*$",
  maxLength: 32,
});
const Timeout = Type.Optional(
  Type.Number({
    description: "Seconds: spawn bounds initial execution; wait bounds only the waiter and never cancels work.",
  }),
);
const Spawn = Type.Object(
  {
    task: Type.String({ minLength: 1, maxLength: 50 * 1024 }),
    tools: Type.Optional(Type.Array(StringEnum(CHILD_CORE_TOOL_NAMES), { maxItems: 64 })),
    skills: Type.Optional(
      Type.Array(Type.String(), {
        maxItems: 16,
        description: "Local skill attachments are unsupported by durable mode; must be empty.",
      }),
    ),
    extensions: Type.Optional(
      Type.Array(Type.Object({ path: Type.String(), tools: Type.Array(Type.String()) }), {
        maxItems: 16,
        description: "Coding-agent extension attachments are unsupported by durable mode; must be empty.",
      }),
    ),
    thinkingLevel: Type.Optional(StringEnum(SUBAGENT_THINKING_LEVELS)),
    timeout: Timeout,
  },
  { additionalProperties: false },
);
const Send = Type.Object(
  {
    conversationId: Id,
    message: Type.String({ minLength: 1, maxLength: 48 * 1024 }),
    whenBusy: Type.Optional(StringEnum(["steer", "followUp"] as const)),
  },
  { additionalProperties: false },
);
const Stop = Type.Object({ conversationId: Id }, { additionalProperties: false });
const Wait = Type.Object({ conversationId: Id, timeout: Timeout }, { additionalProperties: false });
const Status = Type.Object({ conversationId: Type.Optional(Id) }, { additionalProperties: false });

type Owner = {
  ctx: ExtensionContext;
  disposed: boolean;
  controller: AbortController;
  runtime?: DurableSubagentRuntime;
  bridge?: DurableMainBridge;
  opening?: Promise<DurableSubagentRuntime>;
  flushing?: Promise<void>;
  flushAgain?: boolean;
  failed?: Error;
  deliveryError?: Error;
};
export interface DurableToolsDependencies {
  openRuntime?: (options: DurableRuntimeOptions) => Promise<DurableSubagentRuntime>;
}
export interface RegisteredDurableTools {
  startSession(ctx: ExtensionContext): Promise<void>;
  shutdown(ctx: ExtensionContext): Promise<void>;
  settled(ctx: ExtensionContext): Promise<void>;
}

export function registerDurableTools(
  pi: ExtensionAPI,
  dependencies: DurableToolsDependencies = {},
): RegisteredDurableTools {
  const owners = new Map<ExtensionContext["sessionManager"], Owner>();
  const current = (owner: Owner) => {
    if (owner.disposed || owners.get(owner.ctx.sessionManager) !== owner)
      throw new Error("Durable subagent session is stale or suspended.");
  };
  const getOwner = (ctx: ExtensionContext) => {
    const owner = owners.get(ctx.sessionManager);
    if (!owner) throw new Error("Durable subagents have not started for this session.");
    current(owner);
    if (owner.failed) throw owner.failed;
    return owner;
  };
  async function flush(owner: Owner): Promise<void> {
    current(owner);
    if (!owner.runtime || !owner.bridge) return;
    if (owner.flushing) {
      owner.flushAgain = true;
      return owner.flushing;
    }
    const runtime = owner.runtime;
    const bridge = owner.bridge;
    owner.flushing = (async () => {
      try {
        do {
          owner.flushAgain = false;
          const reports = await runtime.reports();
          current(owner);
          await bridge.flush(reports, {
            getLatest: (id) => runtime.report(id),
            acknowledge: (id) => runtime.acknowledge(id),
          });
          current(owner);
        } while (owner.flushAgain);
        owner.deliveryError = undefined;
      } finally {
        // Clear before this inner promise resolves. An outer await/finally has
        // a microtask gap in which the last changed() could join finished work.
        owner.flushing = undefined;
      }
    })();
    return owner.flushing;
  }
  function changed(owner: Owner): void {
    if (owner.disposed || !owner.runtime) return;
    // The bridge owns/joins this queue. Failure retains the durable outbox; it must
    // not turn a queued or memory-only main message into an acknowledgement.
    void flush(owner).catch((error: unknown) => {
      if (owner.disposed) return;
      const notify = !owner.deliveryError;
      owner.deliveryError = error instanceof Error ? error : new Error("Durable report publication failed.");
      if (notify) {
        const message =
          "Durable result is pending. Use subagent_wait, or close Pi and reopen the saved session to retry delivery. /reload does not repair missing disk receipts.";
        try {
          if (owner.ctx.hasUI) owner.ctx.ui.notify(message, "warning");
          else process.stderr.write(`pi-subagents: ${message}\n`);
        } catch {
          /* A failed UI must not create an unowned rejection or lose the outbox. */
        }
      }
    });
  }
  async function ensure(owner: Owner): Promise<DurableSubagentRuntime> {
    current(owner);
    if (owner.failed) throw owner.failed;
    if (owner.runtime) return owner.runtime;
    owner.opening ??= (async () => {
      const [{ deriveBinding }, { createDurableModels }, kernel] = await Promise.all([
        import("./durable-main-bridge.js"),
        import("./durable-models.js"),
        import("./durable-runtime.js"),
      ]);
      current(owner);
      owner.bridge = await deriveBinding(pi, owner.ctx, () => current(owner));
      current(owner);
      const authorize = async (profile?: DurableProfile) => {
        current(owner);
        // Recheck persisted main ownership/branch evidence before any storage/progress.
        owner.bridge?.intents();
        if (profile) {
          if (profile.cwd !== owner.ctx.cwd || profile.trusted !== owner.ctx.isProjectTrusted())
            throw new Error("Durable recovery blocked: project trust or workspace changed.");
          const model = owner.ctx.modelRegistry.find(profile.model.provider, profile.model.modelId);
          if (!model) throw new Error("Durable recovery blocked: model/provider credentials unavailable.");
          // A virtual route has no public pre-dispatch physical/auth resolution.
          // Do not resume effects on the strength of its keyless virtual auth.
          // Pi's inspected virtual-model predicate uses this public API identity,
          // not a provider name or model ID (physical/custom IDs remain valid).
          if (model.api === "pi-virtual")
            throw new Error(
              "Durable mode requires a physical model; virtual routing cannot authorize recovery before progress.",
            );
          const provider = owner.ctx.modelRegistry.getProvider(model.provider);
          if (!provider) throw new Error("Durable recovery blocked: model/provider credentials unavailable.");
          const available = await owner.ctx.modelRegistry.getAvailableOfType("chat", model.provider, {
            signal: owner.controller.signal,
          });
          current(owner);
          const latestModel = owner.ctx.modelRegistry.find(model.provider, model.id);
          if (
            !latestModel ||
            latestModel.api !== model.api ||
            owner.ctx.modelRegistry.getProvider(model.provider) !== provider
          )
            throw new Error(
              "Durable model/provider changed during authorization; retry with the current configuration.",
            );
          if (profile.cwd !== owner.ctx.cwd || profile.trusted !== owner.ctx.isProjectTrusted())
            throw new Error("Durable recovery blocked: project trust or workspace changed.");
          if (!available.some((candidate) => candidate.id === model.id && candidate.provider === model.provider))
            throw new Error("Durable recovery blocked: model/provider credentials unavailable.");
        }
      };
      const options: DurableRuntimeOptions = {
        directory: path.join(getAgentDir(), "pi-subagents", owner.bridge.binding.storeKey),
        binding: owner.bridge.binding.storeKey,
        signal: owner.controller.signal,
        models: createDurableModels(owner.ctx.modelRegistry),
        authorize,
        changed: () => changed(owner),
      };
      const runtime = await (dependencies.openRuntime ?? kernel.DurableSubagentRuntime.open)(options);
      if (owner.disposed) {
        await runtime.shutdown();
        throw new Error("Durable session stopped during initialization.");
      }
      current(owner);
      owner.runtime = runtime;
      runtime.resume();
      return runtime;
    })();
    try {
      return await owner.opening;
    } catch (error) {
      owner.failed = error instanceof Error ? error : new Error("Durable initialization failed.");
      throw error;
    }
  }
  async function dispatch<T>(
    ctx: ExtensionContext,
    signal: AbortSignal | undefined,
    operation: (runtime: DurableSubagentRuntime, owner: Owner) => Promise<T>,
  ): Promise<T> {
    signal?.throwIfAborted();
    const owner = getOwner(ctx);
    owner.bridge?.intents();
    const runtime = await ensure(owner);
    current(owner);
    signal?.throwIfAborted();
    const work = operation(runtime, owner);
    return awaitWithContext(work, withAbortSignal(signal ?? new AbortController().signal, BACKGROUND_CONTEXT));
  }
  function result(value: unknown, owner?: Owner, reportIds?: string[]) {
    return {
      content: [{ type: "text" as const, text: modelVisibleJson(value) }],
      details:
        owner && reportIds ? { piSubagentsDurable: { storeKey: owner.bridge?.binding.storeKey, reportIds } } : value,
    };
  }

  pi.registerTool({
    name: "subagent_spawn",
    label: "Subagent · Spawn",
    description:
      "Start a persistent subagent conversation and return its conversationId immediately. Durable mode supports read, write, edit, bash and powershell; defaults to read. Local skills, coding-agent extension attachments, grep/find/ls and codemode are unsupported and rejected. Main remains the current Pi session.",
    parameters: Spawn,
    prepareArguments: (args) => prepareTimeoutArguments(args) as Static<typeof Spawn>,
    execute: async (toolCallId, params, signal, _update, ctx) => {
      const task = params.task;
      if (!task.trim() || task.includes("\0") || Buffer.byteLength(task, "utf8") > 50 * 1024)
        throw new Error("Subagent task must be non-empty text within 50 KiB, without NUL.");
      if ((params.skills?.length ?? 0) > 0 || (params.extensions?.length ?? 0) > 0)
        throw new Error("Durable mode does not support local skills or coding-agent extension attachments.");
      const tools = [...new Set(params.tools ?? ["read"])];
      if (tools.some((tool) => !["read", "write", "edit", "bash", "powershell"].includes(tool)))
        throw new Error(
          "Durable tools must be read, write, edit, bash or powershell; unsupported tools are not ignored.",
        );
      const timeoutMs = resolveTimeoutMs(params.timeout) ?? null;
      const model = ctx.model;
      if (!model) throw new Error("No main-agent model is selected.");
      const thinkingLevel = params.thinkingLevel ?? ctx.thinkingLevel ?? pi.getThinkingLevel();
      return dispatch(ctx, signal, async (runtime, owner) => {
        const profile: DurableProfile = {
          model: { provider: model.provider, modelId: model.id },
          thinkingLevel,
          tools,
          cwd: ctx.cwd,
          trusted: ctx.isProjectTrusted(),
        };
        await owner.bridge?.admit(toolCallId, { tool: "spawn", task, profile, timeoutMs });
        current(owner);
        signal?.throwIfAborted();
        return result(await runtime.spawn(toolCallId, task, profile, timeoutMs));
      });
    },
  });
  pi.registerTool({
    name: "subagent_send",
    label: "Subagent · Send",
    description:
      "Send another assignment to an owned durable conversation, including an idle subagent. whenBusy defaults to steer; followUp queues after its current answer. This is not the legacy requestId question/response protocol.",
    parameters: Send,
    execute: async (toolCallId, params, signal, _update, ctx) => {
      validateMessage(params.message, "Subagent message");
      return dispatch(ctx, signal, async (runtime, owner) => {
        await owner.bridge?.admit(toolCallId, { tool: "send", ...params });
        current(owner);
        signal?.throwIfAborted();
        return result(
          await runtime.send(params.conversationId, toolCallId, params.message, params.whenBusy ?? "steer"),
        );
      });
    },
  });
  pi.registerTool({
    name: "subagent_stop",
    label: "Subagent · Stop",
    description:
      "Stop current and queued durable work without closing its conversation. The subagent can receive later assignments. Replaying the same stop invocation cannot stop newer work.",
    parameters: Stop,
    execute: async (toolCallId, params, signal, _update, ctx) =>
      dispatch(ctx, signal, async (runtime, owner) => {
        await owner.bridge?.admit(toolCallId, { tool: "stop", ...params });
        current(owner);
        signal?.throwIfAborted();
        return result(await runtime.stop(params.conversationId, toolCallId));
      }),
  });
  pi.registerTool({
    name: "subagent_status",
    label: "Subagent · Status",
    description:
      "List this main session's durable conversations or inspect one. Returns running/idle and latest request outcome metadata, never task text, conversation content, tool selections or credentials.",
    parameters: Status,
    execute: async (_id, params, signal, _update, ctx) =>
      dispatch(ctx, signal, async (runtime, owner) =>
        result({ ...(await runtime.status(params.conversationId)), deliveryPending: !!owner.deliveryError }),
      ),
  });
  pi.registerTool({
    name: "subagent_wait",
    label: "Subagent · Wait",
    description:
      "Await work already submitted to one durable conversation and return its saved result. Later assignments do not extend this wait. Timeout or caller cancellation stops only the wait. A work outcome is separate from conversation state, which can remain running while report acknowledgement is pending.",
    parameters: Wait,
    prepareArguments: (args) => prepareTimeoutArguments(args) as Static<typeof Wait>,
    execute: async (_id, params, signal, _update, ctx) =>
      dispatch(ctx, signal, async (runtime, owner) => {
        const waited = await runtime.wait(params.conversationId, resolveTimeoutMs(params.timeout), signal);
        current(owner);
        const { reportIds, ...value } = waited;
        return result(value, owner, reportIds);
      }),
  });

  return {
    async startSession(ctx) {
      if (owners.has(ctx.sessionManager)) throw new Error("Durable session is already initialized.");
      const owner: Owner = { ctx, disposed: false, controller: new AbortController() };
      owners.set(ctx.sessionManager, owner);
      // Empty/new sessions have no disk conversation yet. Initialize on first tool,
      // after the main user/tool prefix is actually persisted.
      if (
        ctx.sessionManager.getSessionFile() &&
        ctx.sessionManager
          .getBranch()
          .some(
            (entry) =>
              entry.type === "message" && (entry.message.role === "user" || entry.message.role === "assistant"),
          )
      ) {
        await ensure(owner);
        current(owner);
        await flush(owner);
      }
    },
    async settled(ctx) {
      const owner = owners.get(ctx.sessionManager);
      if (owner && !owner.disposed && !owner.failed) await flush(owner);
    },
    async shutdown(ctx) {
      const owner = owners.get(ctx.sessionManager);
      if (!owner) return;
      owner.disposed = true;
      owner.controller.abort(new Error("Durable session suspended."));
      owners.delete(ctx.sessionManager);
      owner.bridge?.dispose();
      await owner.opening?.catch(() => undefined);
      await owner.runtime?.shutdown();
      await owner.flushing?.catch(() => undefined);
    },
  };
}
