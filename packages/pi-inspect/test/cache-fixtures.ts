import type { Api, AssistantMessage, Model, Usage } from "@earendil-works/pi-ai";

export const cacheModel: Model<Api> = {
  id: "cache-model",
  name: "Cache model",
  api: "openai-responses",
  provider: "cache-provider",
  baseUrl: "https://example.invalid",
  reasoning: false,
  input: ["text"],
  cost: {
    input: 10,
    output: 20,
    cacheRead: 1,
    cacheWrite: 20,
    tiers: [{ inputTokensAbove: 2000, input: 20, output: 40, cacheRead: 2, cacheWrite: 40 }],
  },
  contextWindow: 200000,
  maxTokens: 10000,
};
export function cacheUsage(input = 200, cacheRead = 800, cacheWrite = 0): Usage {
  return {
    input,
    cacheRead,
    cacheWrite,
    output: 10,
    totalTokens: input + cacheRead + cacheWrite + 10,
    cost: {
      input: input * 0.00001,
      cacheRead: cacheRead * 0.000001,
      cacheWrite: cacheWrite * 0.00002,
      output: 0.0002,
      total: 0,
    },
  };
}
export function cacheAssistant(usage = cacheUsage(), overrides: Partial<AssistantMessage> = {}): AssistantMessage {
  return {
    role: "assistant",
    api: "openai-responses",
    provider: cacheModel.provider,
    model: cacheModel.id,
    content: [{ type: "text", text: "Recorded cache response" }],
    timestamp: 1000,
    stopReason: "stop",
    usage,
    ...overrides,
  };
}
