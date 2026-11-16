import {
  type Api,
  type AssistantMessage,
  type Context,
  createAssistantMessageEventStream,
  type Model,
} from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createMockContext } from "../../../test/support.js";
import type { AgentUnit } from "../src/sync/agent-candidate.js";

export const agentTestModel: Model<Api> = {
  id: "sync-test",
  name: "Sync test",
  provider: "sync-test",
  api: "openai-responses",
  baseUrl: "https://invalid.example",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 64000,
  maxTokens: 8192,
};
export function agentContext(
  answer: (
    units: AgentUnit[],
    context: Context,
  ) => string | Partial<AssistantMessage> | Promise<string | Partial<AssistantMessage>>,
  overrides: Record<string, unknown> = {},
) {
  const requests: Context[] = [];
  const requestOptions: unknown[] = [];
  const mock = createMockContext({ mode: "rpc", model: agentTestModel, ...overrides });
  const ctx = mock.ctx as ExtensionContext;
  const registry: Pick<
    ExtensionContext["modelRegistry"],
    "getRegisteredProviderIds" | "getProviderAuthStatus" | "streamSimple"
  > = {
    getRegisteredProviderIds: () => ["sync-test"],
    getProviderAuthStatus: () => ({ configured: true, source: "runtime" }),
    streamSimple: (_model, context, options) => {
      requests.push(structuredClone(context));
      requestOptions.push(options);
      const stream = createAssistantMessageEventStream();
      const message: AssistantMessage = {
        role: "assistant",
        api: agentTestModel.api,
        provider: agentTestModel.provider,
        model: agentTestModel.id,
        content: [],
        stopReason: "stop",
        timestamp: Date.now(),
        usage: {
          input: 10,
          output: 10,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 20,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
      };
      let finished = false;
      const fail = () => {
        if (finished) return;
        finished = true;
        stream.push({
          type: "error",
          reason: "aborted",
          error: { ...message, stopReason: "aborted", errorMessage: "fixture stopped" },
        });
        stream.end();
      };
      options?.signal?.addEventListener("abort", fail, { once: true });
      if (options?.signal?.aborted) fail();
      void Promise.resolve().then(async () => {
        try {
          const latest = context.messages.at(-1);
          const payload =
            latest?.role === "user"
              ? typeof latest.content === "string"
                ? latest.content
                : latest.content
                    .filter((part) => part.type === "text")
                    .map((part) => part.text)
                    .join("")
              : "{}";
          const result = await answer(JSON.parse(payload).units as AgentUnit[], context);
          if (finished) return;
          finished = true;
          if (typeof result === "string") message.content = [{ type: "text", text: result }];
          else Object.assign(message, result);
          stream.push({
            type: "done",
            reason: message.stopReason === "toolUse" ? "toolUse" : message.stopReason === "length" ? "length" : "stop",
            message,
          });
          stream.end();
        } catch {
          fail();
        } finally {
          options?.signal?.removeEventListener("abort", fail);
        }
      });
      return stream;
    },
  };
  ctx.modelRegistry = registry as ExtensionContext["modelRegistry"];
  return { ...mock, ctx, requests, requestOptions };
}
export function selectRemote(units: AgentUnit[]) {
  return JSON.stringify({
    version: 1,
    results: units.map((unit) =>
      unit.kind === "settings" ? { id: unit.id, source: "remote" } : { id: unit.id, content: unit.remote },
    ),
  });
}
