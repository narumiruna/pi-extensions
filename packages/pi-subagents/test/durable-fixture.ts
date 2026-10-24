// Test-only durable lifecycle proof. This is not a coding-agent extension or a production backend.
import { randomUUID } from "node:crypto";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import type { JsonValue } from "@earendil-works/chord";
import {
  awaitWithContext,
  BACKGROUND_CONTEXT,
  type Context,
  withAbortSignal,
  withCancel,
} from "@earendil-works/chord/context";
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  getCurrentSystemPrompt,
  getCurrentTools,
  Type,
  toToolDeclaration,
} from "@earendil-works/pi-ai";
import {
  type Conversation,
  type ConversationId,
  configure,
  createRegistry,
  type DocumentObserver,
  defineDoc,
  defineExtension,
  defineTask,
  defineTool,
  Harness,
  type TaskId,
} from "@earendil-works/pi-durable";
import { openNodeJsonlStorage } from "@earendil-works/pi-durable/storage/jsonl/node";

export type Run = {
  id: string;
  task: string;
  status: "pending" | "completed" | "failed" | "cancelled" | "timed_out";
  result: string;
  submissionId: number | null;
  cancelIntent: "cancelled" | "timed_out" | null;
  finishing: boolean;
};
export type Question = {
  id: string;
  message: string;
  answer: string | null;
  status: "pending" | "answered" | "cancelled";
};
export type MainRequest = {
  id: string;
  task: string;
  runId: string;
  delivered: boolean;
  taskId: TaskId;
  status: "pending" | "answered" | "cancelled";
  result: string;
};
export type Agent = {
  id: string;
  conversationId: ConversationId;
  anchorId: TaskId;
  state: "running" | "standby" | "closed";
  closeIntent: boolean;
  activeRun: string | null;
  runs: Record<string, Run>;
  questions: Record<string, Question>;
  mainRequests: Record<string, MainRequest>;
};
export type Report = { id: string; agentId: string; runId: string; result: string; acknowledged: boolean };
export type FixtureState = { agents: Record<string, Agent>; reports: Record<string, Report> };
export const FixtureDoc = defineDoc<FixtureState>({
  kind: "subagents.proof.state",
  version: 1,
  scope: "session",
  initial: () => ({ agents: {}, reports: {} }),
});
export type Policy = {
  session: string;
  branch: string;
  capabilities: string;
  code: string;
  trusted: boolean;
  credentials: boolean;
};
export const fixturePolicy: Policy = {
  session: "main",
  branch: "root",
  capabilities: "explicit-fixture-tools",
  code: "proof-v1",
  trusted: true,
  credentials: true,
};
export type Checkpoint = (name: string, data: JsonValue, context: Context) => Promise<void>;
const context = BACKGROUND_CONTEXT;

// A serialized watch closes the read/subscribe race. Context cancellation releases the watch.
async function changed<T>(
  owner: DocumentObserver,
  predicate: (state: Readonly<FixtureState>) => T | undefined,
  ctx: Context,
): Promise<T> {
  const watch = await owner.watchDoc(FixtureDoc, ctx);
  if (!watch) throw new Error("Missing fixture document");
  try {
    const value = watch.value && predicate(watch.value);
    if (value !== undefined && value !== null) return value;
    let resolve!: (value: T) => void;
    const result = new Promise<T>((done) => {
      resolve = done;
    });
    watch.start(async (state) => {
      const next = state && predicate(state);
      if (next !== undefined && next !== null) resolve(next);
    });
    return await awaitWithContext(result, ctx);
  } finally {
    await watch.stop();
  }
}

function finish(state: FixtureState, agent: Agent, run: Run, status: Run["status"], result: string): void {
  run.status = status;
  run.result = result;
  const id = `report:${run.id}`;
  state.reports[id] ??= { id, agentId: agent.id, runId: run.id, result, acknowledged: false };
  agent.activeRun = null;
  for (const question of Object.values(agent.questions))
    if (question.status === "pending") question.status = "cancelled";
  if (!agent.closeIntent) agent.state = "standby";
}

export class DurableFixture {
  readonly token = randomUUID();
  readonly stopping = withCancel(context);
  harness!: Harness;
  root!: Conversation;
  private stopped = false;
  private shutdownTask?: Promise<void>;
  private checkpoint: Checkpoint;
  private constructor(
    readonly directory: string,
    checkpoint: Checkpoint,
  ) {
    this.checkpoint = checkpoint;
  }

  static async open(
    directory: string,
    policy = fixturePolicy,
    checkpoint: Checkpoint = async () => {},
  ): Promise<DurableFixture> {
    // Harness.open can reconcile stored tasks. Authorization must precede it, not just resume().
    if (!policy.trusted || !policy.credentials) throw new Error("Recovery blocked: trust or credentials");
    const fixture = new DurableFixture(directory, checkpoint);
    await mkdir(directory, { recursive: true });
    const lease = path.join(directory, "owner.lock");
    await writeFile(lease, fixture.token, { flag: "wx", mode: 0o600 });
    try {
      const binding = JSON.stringify({
        session: policy.session,
        branch: policy.branch,
        capabilities: policy.capabilities,
        code: policy.code,
      });
      const file = path.join(directory, "binding.json");
      try {
        await writeFile(file, binding, { flag: "wx", mode: 0o600 });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
      if ((await readFile(file, "utf8")) !== binding)
        throw new Error("Recovery blocked: session, branch, capabilities, or code mismatch");
      await fixture.initialize();
      return fixture;
    } catch (error) {
      await fixture.harness?.close(context);
      await unlink(lease);
      throw error;
    }
  }

  private async point(name: string, data: JsonValue, ctx = this.stopping.context): Promise<void> {
    await this.checkpoint(name, data, ctx);
    if (this.stopped) throw new Error("Fixture stopped");
  }

  private async initialize(): Promise<void> {
    const registry = createRegistry();
    const models = createModels();
    const faux = fauxProvider({ tokenSize: { min: 100_000, max: 100_000 } });
    models.setProvider(faux.provider);
    faux.setResponses(
      Array.from({ length: 100 }, () => async (request, options) => {
        // Capture only cache-sensitive provider input, not implementations, request IDs, or usage.
        const normalized = request.messages.map((message) => {
          if (message.role === "system")
            return {
              role: message.role,
              content: message.content,
              sections: message.sections ?? {},
              toolsAdded: message.toolsAdded ?? [],
              toolsRemoved: message.toolsRemoved ?? [],
            };
          if (message.role === "toolResult")
            return {
              role: message.role,
              content: message.content,
              toolCallId: message.toolCallId,
              toolName: message.toolName,
              isError: message.isError,
            };
          return { role: message.role, content: message.content };
        });
        await this.point(
          "provider-request",
          JSON.parse(
            JSON.stringify({
              messages: normalized,
              systemPrompt: getCurrentSystemPrompt(request.messages),
              tools: getCurrentTools(request.messages).map(toToolDeclaration),
            }),
          ),
          withAbortSignal(options?.signal ?? new AbortController().signal, this.stopping.context),
        );
        const user = [...request.messages].reverse().find((message) => message.role === "user");
        const task = typeof user?.content === "string" ? user.content : JSON.stringify(user?.content);
        const last = request.messages.at(-1);
        if (task === "generation")
          await this.point(
            "generation",
            {},
            withAbortSignal(options?.signal ?? new AbortController().signal, this.stopping.context),
          );
        if (task === "fail")
          return fauxAssistantMessage("failed", { stopReason: "error", errorMessage: "synthetic failure" });
        if (last?.role === "user" && ["safe", "unsafe", "question"].includes(task)) {
          return fauxAssistantMessage([fauxToolCall(task, {}, { id: `call-${request.messages.length}` })], {
            stopReason: "toolUse",
          });
        }
        return fauxAssistantMessage(`answer:${task}`);
      }),
    );
    const effect = (name: "safe" | "unsafe") =>
      defineTool({
        name,
        description: "Synthetic external effect",
        parameters: Type.Object({}),
        replay: name === "safe" ? "safe" : "unsafe",
        execute: async (_args, api, ctx) => {
          const file = path.join(this.directory, `effect-${api.taskId}`);
          if (name === "safe") {
            try {
              await writeFile(file, "effect\n", { flag: "wx" });
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
            }
          } else {
            await writeFile(file, "effect\n", { flag: "a" });
          }
          await this.point("effect", { name, file, callId: api.callId }, ctx);
          return { output: [{ type: "text", text: "effect completed" }] };
        },
      });
    const question = defineTool({
      name: "question",
      description: "Ask main and wait for the first persisted answer",
      parameters: Type.Object({}),
      replay: "safe",
      execute: async (_args, api, ctx) => {
        const id = `question:${api.callId}`;
        const agentId = await api.commit(async (tx) => {
          const state = await tx.doc(FixtureDoc);
          const agent = Object.values(state.agents).find((agent) => agent.conversationId === api.conversationId);
          if (!agent) throw new Error("Missing agent");
          agent.questions[id] ??= { id, message: "Need an answer", answer: null, status: "pending" };
          return agent.id;
        }, ctx);
        await this.point("question", { agentId, id }, ctx);
        const answer = await changed(
          api,
          (state) => {
            const agent = state.agents[agentId];
            const answer = agent?.questions[id]?.answer;
            if (answer !== null && answer !== undefined) return answer;
            return agent &&
              Object.values(agent.mainRequests).some((request) => request.delivered && request.status === "pending")
              ? "Interrupted by a main request; the question is still pending"
              : undefined;
          },
          ctx,
        );
        return { output: [{ type: "text", text: answer }] };
      },
    });
    type Phase =
      | { phase: "dispatch" }
      | { phase: "collect"; runId: string; submissionId: number }
      | { phase: "cancel"; runId: string; submissionId: number };
    const anchor = defineTask<{ agentId: string }, Phase, null>({
      name: "subagents.proof.anchor",
      version: 1,
      initial: () => ({ phase: "dispatch" }),
      phases: {
        dispatch: async (task, runtime, ctx) => {
          const agent = await changed(
            runtime,
            (state) => {
              const agent = state.agents[task.input.agentId];
              return agent?.activeRun && !agent.closeIntent ? agent : undefined;
            },
            ctx,
          );
          const run = agent.runs[agent.activeRun as string];
          if (!run) throw new Error("Missing run");
          if (run.cancelIntent) {
            await runtime.commit(
              () => ({
                status: "running",
                checkpoint: { phase: "cancel", runId: run.id, submissionId: run.submissionId ?? 0 },
              }),
              ctx,
            );
            return;
          }
          const child = await runtime.conversation(agent.conversationId, ctx);
          if (!child) throw new Error("Missing child");
          // Submission is outside the commit; an ambiguous result reuses its request ID.
          const submission = await child.submit(
            { type: "input", content: run.task, requestId: run.id, whenBusy: "reject" },
            ctx,
          );
          await this.point("submitted", { agentId: agent.id, runId: run.id, submissionId: submission.id }, ctx);
          await runtime.commit(async (tx) => {
            const currentRun = (await tx.doc(FixtureDoc)).agents[agent.id]?.runs[run.id];
            if (!currentRun) throw new Error("Missing run");
            currentRun.submissionId = submission.id;
            return {
              status: "running",
              checkpoint: {
                phase: currentRun.cancelIntent ? "cancel" : "collect",
                runId: run.id,
                submissionId: submission.id,
              },
            };
          }, ctx);
        },
        collect: async (task, runtime, ctx) => {
          const agent = (await runtime.snapshot(FixtureDoc, ctx))?.agents[task.input.agentId];
          const run = agent?.runs[task.state.checkpoint.runId];
          if (!agent || !run) throw new Error("Missing run");
          if (run.cancelIntent) {
            await runtime.commit(
              () => ({ status: "running", checkpoint: { ...task.state.checkpoint, phase: "cancel" } }),
              ctx,
            );
            return;
          }
          const child = await runtime.conversation(agent.conversationId, ctx);
          if (!child) throw new Error("Missing child");
          const submission = await child.submit({ type: "input", content: run.task, requestId: run.id }, ctx);
          // Cancellation interrupts this WAIT, not the durable work. Only the anchor's
          // cancel phase can abort the conversation, before it publishes standby.
          const waiting = withCancel(ctx);
          const settlement = submission
            .wait(waiting.context)
            .then((settled) => ({ kind: "settled" as const, settled }));
          const cancellation = changed(
            runtime,
            (state) => state.agents[agent.id]?.runs[run.id]?.cancelIntent || undefined,
            waiting.context,
          ).then(() => ({ kind: "cancel" as const }));
          let result: Awaited<typeof settlement> | Awaited<typeof cancellation>;
          try {
            result = await Promise.race([settlement, cancellation]);
          } finally {
            waiting.cancel();
            await Promise.allSettled([settlement, cancellation]);
          }
          if (result.kind === "cancel") {
            await runtime.commit(
              () => ({ status: "running", checkpoint: { ...task.state.checkpoint, phase: "cancel" } }),
              ctx,
            );
            return;
          }
          const settled = result.settled;
          const transcript = await runtime.context(agent.conversationId, ctx);
          const answer =
            settled.status === "done" && settled.type === "input"
              ? transcript.entries.find((entry) => entry.id === settled.answer)
              : undefined;
          const output = JSON.stringify(answer?.model ?? settled);
          await this.point("settled", { agentId: agent.id, runId: run.id, submissionId: settled.id }, ctx);
          // Seal message admission before draining. An already accepted message can
          // own another child run even though the primary input has settled.
          await runtime.commit(async (tx) => {
            const currentRun = (await tx.doc(FixtureDoc)).agents[agent.id]?.runs[run.id];
            if (currentRun) currentRun.finishing = true;
          }, ctx);
          const requests = Object.values(
            (await runtime.snapshot(FixtureDoc, ctx))?.agents[agent.id]?.mainRequests ?? {},
          ).filter((request) => request.runId === run.id);
          await this.point("draining", { agentId: agent.id, runId: run.id }, ctx);
          const draining = withCancel(ctx);
          const idle = (async () => {
            for (const request of requests) await runtime.waitForTask(request.taskId, draining.context);
            await child.waitForIdle(draining.context);
            return "idle" as const;
          })();
          const cancelDrain = changed(
            runtime,
            (state) => state.agents[agent.id]?.runs[run.id]?.cancelIntent || undefined,
            draining.context,
          ).then(() => "cancel" as const);
          let drained: "idle" | "cancel";
          try {
            drained = await Promise.race([idle, cancelDrain]);
          } finally {
            draining.cancel();
            await Promise.allSettled([idle, cancelDrain]);
          }
          if (drained === "cancel") {
            await runtime.commit(
              () => ({ status: "running", checkpoint: { ...task.state.checkpoint, phase: "cancel" } }),
              ctx,
            );
            return;
          }
          await runtime.commit(async (tx) => {
            const state = await tx.doc(FixtureDoc);
            const current = state.agents[agent.id];
            const currentRun = current?.runs[run.id];
            if (!current || !currentRun) throw new Error("Missing run");
            if (currentRun.cancelIntent)
              return { status: "running", checkpoint: { ...task.state.checkpoint, phase: "cancel" } };
            for (const request of Object.values(current.mainRequests)) {
              if (request.runId === run.id && request.status === "pending") {
                request.status = "cancelled";
                request.result = "Message task ended without a reply";
              }
            }
            if (!current.closeIntent)
              finish(state, current, currentRun, settled.status === "done" ? "completed" : "failed", output);
            return { status: "running", checkpoint: { phase: "dispatch" } };
          }, ctx);
          await this.point("reported", { agentId: agent.id, runId: run.id }, ctx);
        },
        cancel: async (task, runtime, ctx) => {
          const agent = (await runtime.snapshot(FixtureDoc, ctx))?.agents[task.input.agentId];
          const run = agent?.runs[task.state.checkpoint.runId];
          if (!agent || !run?.cancelIntent || agent.activeRun !== run.id) throw new Error("Stale cancellation phase");
          await this.point("before-cancel", { agentId: agent.id, runId: run.id }, ctx);
          // Stop message dispatch before stopping the child, so no sibling task can
          // submit new work after abort has observed the child idle.
          for (const request of Object.values(agent.mainRequests)) {
            if (request.runId === run.id && request.status === "pending") await runtime.abortOwned(request.taskId, ctx);
          }
          const child = await runtime.conversation(agent.conversationId, ctx);
          if (!child) throw new Error("Missing child");
          await child.abort(ctx);
          await runtime.commit(async (tx) => {
            const state = await tx.doc(FixtureDoc);
            const current = state.agents[agent.id];
            const currentRun = current?.runs[run.id];
            if (!current || !currentRun?.cancelIntent || current.activeRun !== run.id)
              throw new Error("Stale cancellation commit");
            if (!current.closeIntent) finish(state, current, currentRun, currentRun.cancelIntent, "Cancelled by main");
            return { status: "running", checkpoint: { phase: "dispatch" } };
          }, ctx);
        },
      },
      abort: async (task, runtime, ctx) => {
        await runtime.commit(async (tx) => {
          const state = await tx.doc(FixtureDoc);
          const agent = state.agents[task.input.agentId];
          if (!agent) throw new Error("Missing agent");
          if (agent.activeRun) {
            const run = agent.runs[agent.activeRun];
            if (run) finish(state, agent, run, "cancelled", "closed by main");
          }
          agent.state = "closed";
          return { status: "terminal", outcome: { status: "aborted" } };
        }, ctx);
      },
    });
    const messageTask = defineTask<{ agentId: string; requestId: string }, { phase: "deliver" | "collect" }, null>({
      name: "subagents.proof.message",
      version: 1,
      initial: () => ({ phase: "deliver" }),
      phases: {
        deliver: async (task, runtime, ctx) => {
          const agent = await changed(
            runtime,
            (state) => {
              const agent = state.agents[task.input.agentId];
              const request = agent?.mainRequests[task.input.requestId];
              const run = request && agent?.runs[request.runId];
              return agent && run && (run.submissionId !== null || run.status !== "pending") ? agent : undefined;
            },
            ctx,
          );
          const request = agent.mainRequests[task.input.requestId];
          if (!request) throw new Error("Missing main request");
          if (agent.closeIntent || agent.state !== "running" || agent.runs[request.runId]?.cancelIntent) {
            await runtime.commit(async (tx) => {
              const request = (await tx.doc(FixtureDoc)).agents[agent.id]?.mainRequests[task.input.requestId];
              if (request) {
                request.status = "cancelled";
                request.result = "Owning run ended before delivery";
              }
              return { status: "terminal", outcome: { status: "completed", result: null } };
            }, ctx);
            return;
          }
          const child = await runtime.conversation(agent.conversationId, ctx);
          if (!child) throw new Error("Missing child");
          await child.submit(
            { type: "input", content: request.task, requestId: `main:${request.id}`, whenBusy: "steer" },
            ctx,
          );
          await this.point("main-delivered", { requestId: request.id }, ctx);
          await runtime.commit(async (tx) => {
            const request = (await tx.doc(FixtureDoc)).agents[agent.id]?.mainRequests[task.input.requestId];
            if (request) request.delivered = true;
            return { status: "running", checkpoint: { phase: "collect" } };
          }, ctx);
        },
        collect: async (task, runtime, ctx) => {
          const agent = (await runtime.snapshot(FixtureDoc, ctx))?.agents[task.input.agentId];
          const request = agent?.mainRequests[task.input.requestId];
          if (!agent || !request) throw new Error("Missing main request");
          const child = await runtime.conversation(agent.conversationId, ctx);
          if (!child) throw new Error("Missing child");
          const settled = await (
            await child.submit(
              { type: "input", content: request.task, requestId: `main:${request.id}`, whenBusy: "steer" },
              ctx,
            )
          ).wait(ctx);
          const transcript = await runtime.context(agent.conversationId, ctx);
          const answer =
            settled.status === "done" && settled.type === "input"
              ? transcript.entries.find((entry) => entry.id === settled.answer)
              : undefined;
          await runtime.commit(async (tx) => {
            const request = (await tx.doc(FixtureDoc)).agents[agent.id]?.mainRequests[task.input.requestId];
            if (request?.status === "pending") {
              request.status = settled.status === "done" ? "answered" : "cancelled";
              request.result = JSON.stringify(answer?.model ?? settled);
            }
            return { status: "terminal", outcome: { status: "completed", result: null } };
          }, ctx);
        },
      },
      abort: async (task, runtime, ctx) => {
        await runtime.commit(async (tx) => {
          const request = (await tx.doc(FixtureDoc)).agents[task.input.agentId]?.mainRequests[task.input.requestId];
          if (request?.status === "pending") {
            request.status = "cancelled";
            request.result = "Agent closed";
          }
          return { status: "terminal", outcome: { status: "aborted" } };
        }, ctx);
      },
    });
    this.send = async (agentId, requestId, task) => {
      await this.root.commit(async (tx) => {
        const agent = (await tx.doc(FixtureDoc)).agents[agentId];
        if (!agent || agent.closeIntent || agent.state === "closed") throw new Error("Main request owner unavailable");
        const existing = agent.mainRequests[requestId];
        if (existing) {
          if (existing.task !== task) throw new Error("Request payload conflict");
          return;
        }
        if (
          agent.state !== "running" ||
          !agent.activeRun ||
          agent.runs[agent.activeRun]?.cancelIntent ||
          agent.runs[agent.activeRun]?.finishing
        )
          throw new Error("Main request owner unavailable");
        const taskId = await tx.createTask(
          messageTask,
          { agentId, requestId },
          { ownership: { kind: "task", taskId: agent.anchorId }, conversationId: this.root.id },
        );
        agent.mainRequests[requestId] = {
          id: requestId,
          task,
          runId: agent.activeRun,
          delivered: false,
          taskId,
          status: "pending",
          result: "",
        };
      }, this.stopping.context);
      this.harness.resume();
    };
    const tools = [effect("safe"), effect("unsafe"), question];
    const extension = defineExtension({ name: "subagents-proof", tools, tasks: [anchor, messageTask] });
    registry.install(extension);
    const storage = await openNodeJsonlStorage(path.join(this.directory, "store"), context, { fsync: true });
    this.harness = await Harness.open(
      storage,
      {
        models,
        registry,
        settings: { compaction: { enabled: false }, retry: { maxRetries: 0 } },
      },
      context,
    );
    this.root = await this.harness.root(context, {
      agent: {
        model: { provider: faux.provider.id, modelId: faux.getModel().id },
        instructions: "Main context must not be inherited",
      },
    });
    await this.root.commit(async (tx) => {
      await tx.doc(FixtureDoc);
    }, context);
    this.createAgent = async (id, task) => {
      const anchorId = await this.root.commit(async (tx) => {
        const state = await tx.doc(FixtureDoc);
        const existing = state.agents[id];
        if (existing) {
          if (existing.state === "closed" || existing.closeIntent) throw new Error("Agent closed");
          if (existing.runs[`${id}:1`]?.task !== task) throw new Error("Request payload conflict");
          return existing.anchorId;
        }
        const anchorId = await tx.createTask(
          anchor,
          { agentId: id },
          { ownership: { kind: "conversation" }, background: true },
        );
        const child = await tx.createConversation({ ownership: { kind: "task", taskId: anchorId } });
        await configure(tx, child.id, { instructions: "Fresh child", tools, extensions: [extension] });
        const runId = `${id}:1`;
        state.agents[id] = {
          id,
          anchorId,
          conversationId: child.id,
          state: "running",
          closeIntent: false,
          activeRun: runId,
          runs: {
            [runId]: {
              id: runId,
              task,
              status: "pending",
              result: "",
              submissionId: null,
              cancelIntent: null,
              finishing: false,
            },
          },
          questions: {},
          mainRequests: {},
        };
        return anchorId;
      }, this.stopping.context);
      return anchorId;
    };
    // Mark close/cancel intent before ANY progress API enables global scheduling.
    const inspection = await this.harness.inspect(context);
    for (const agent of Object.values((await this.state()).agents)) {
      if (agent.closeIntent && agent.state !== "closed") {
        await this.harness.abortTask(agent.anchorId, context);
      } else if (agent.activeRun && agent.runs[agent.activeRun]?.cancelIntent) {
        for (const request of Object.values(agent.mainRequests)) {
          if (request.runId === agent.activeRun && request.status === "pending")
            await this.harness.abortTask(request.taskId, context);
        }
        for (const { record } of inspection.tasks) {
          if (record.conversationId === agent.conversationId && record.kind === "pi.generation")
            await this.harness.abortTask(record.id, context);
        }
      }
    }
  }

  private createAgent!: (id: string, task: string) => Promise<TaskId>;
  send!: (agentId: string, requestId: string, task: string) => Promise<void>;
  async waitMessage(agentId: string, requestId: string): Promise<MainRequest> {
    return changed(
      this.harness,
      (state) => {
        const request = state.agents[agentId]?.mainRequests[requestId];
        if (!request) throw new Error("Unknown main request");
        return request.status !== "pending" ? request : undefined;
      },
      this.stopping.context,
    );
  }
  async spawn(id: string, task: string): Promise<Agent> {
    await this.point("before-admission", { id });
    await this.createAgent(id, task);
    await this.point("admitted", { id });
    this.harness.resume();
    return this.agent(id);
  }
  async assign(id: string, requestId: string, task: string): Promise<Agent> {
    await this.root.commit(async (tx) => {
      const state = await tx.doc(FixtureDoc);
      const agent = state.agents[id];
      if (!agent || agent.closeIntent || agent.state === "closed") throw new Error("Agent closed or missing");
      const runId = `${id}:${requestId}`;
      if (agent.runs[runId]) {
        if (agent.runs[runId].task !== task) throw new Error("Request payload conflict");
        return;
      }
      if (agent.state !== "standby") throw new Error("Agent busy");
      agent.runs[runId] = {
        id: runId,
        task,
        status: "pending",
        result: "",
        submissionId: null,
        cancelIntent: null,
        finishing: false,
      };
      agent.activeRun = runId;
      agent.state = "running";
    }, this.stopping.context);
    this.harness.resume();
    return this.agent(id);
  }
  async state(): Promise<Readonly<FixtureState>> {
    const state = await this.harness.snapshot(FixtureDoc, context);
    if (!state) throw new Error("Missing state");
    return state;
  }
  async agent(id: string): Promise<Agent> {
    const agent = (await this.state()).agents[id];
    if (!agent) throw new Error("Missing agent");
    return agent;
  }
  async wait(id: string, ctx = this.stopping.context): Promise<Agent> {
    return changed(
      this.harness,
      (state) => {
        const agent = state.agents[id];
        return agent?.state !== "running" ? agent : undefined;
      },
      ctx,
    );
  }
  async close(id: string): Promise<Agent> {
    const anchor = await this.root.commit(async (tx) => {
      const agent = (await tx.doc(FixtureDoc)).agents[id];
      if (!agent) throw new Error("Missing agent");
      agent.closeIntent = true;
      return agent.anchorId;
    }, this.stopping.context);
    await this.point("close-intent", { id });
    await this.harness.abortTask(anchor, this.stopping.context);
    await this.harness.waitForTask(anchor, this.stopping.context);
    return this.agent(id);
  }
  async cancel(id: string, timedOut = false): Promise<Agent> {
    const agent = await this.agent(id);
    const runId = agent.activeRun;
    if (!runId) return agent;
    await this.root.commit(async (tx) => {
      const current = (await tx.doc(FixtureDoc)).agents[id];
      const run = current?.runs[runId];
      if (current && !current.closeIntent && current.activeRun === runId && run?.status === "pending") {
        run.cancelIntent ??= timedOut ? "timed_out" : "cancelled";
      }
    }, this.stopping.context);
    await this.point("cancel-intent", { agentId: id, runId });
    // The durable anchor owns the abort and the standby boundary. A delayed caller
    // never aborts the whole conversation after a newer run has been admitted.
    this.harness.resume();
    return changed(
      this.harness,
      (state) => {
        const current = state.agents[id];
        return current?.runs[runId]?.status !== "pending" ? current : undefined;
      },
      this.stopping.context,
    );
  }
  async answer(id: string, questionId: string, answer: string): Promise<void> {
    await this.root.commit(async (tx) => {
      const agent = (await tx.doc(FixtureDoc)).agents[id];
      const question = agent?.questions[questionId];
      if (!agent || agent.closeIntent || !question || question.status === "cancelled")
        throw new Error("Question unavailable");
      question.answer ??= answer;
      question.status = "answered";
    }, this.stopping.context);
  }
  async acknowledge(reportId: string): Promise<void> {
    await this.root.commit(async (tx) => {
      const report = (await tx.doc(FixtureDoc)).reports[reportId];
      if (!report) throw new Error("Unknown report");
      report.acknowledged = true;
    }, this.stopping.context);
  }
  shutdown(): Promise<void> {
    this.shutdownTask ??= (async () => {
      this.stopped = true;
      this.stopping.cancel(new Error("Fixture shutdown"));
      await this.harness.close(context);
      const lease = path.join(this.directory, "owner.lock");
      if ((await readFile(lease, "utf8")) !== this.token) throw new Error("Lease ownership changed");
      await unlink(lease);
    })();
    return this.shutdownTask;
  }
}
