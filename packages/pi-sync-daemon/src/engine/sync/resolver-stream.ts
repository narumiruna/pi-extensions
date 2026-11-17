import { type Api, createAssistantMessageEventStream, type Model } from "@earendil-works/pi-ai";
import type { EngineModelStream } from "../host.js";

/** Adapt only the public stream surface; do not leak SDK-private class identity to hosts. */
export function forwardResolverStream(upstream: EngineModelStream, model: Model<Api>) {
  const stream = createAssistantMessageEventStream();
  void (async () => {
    for await (const event of upstream) stream.push(event);
    stream.end(await upstream.result());
  })().catch(() => {
    stream.push({
      type: "error",
      reason: "error",
      error: {
        role: "assistant",
        api: model.api,
        provider: model.provider,
        model: model.id,
        content: [],
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "error",
        errorMessage: "Resolver transport failed.",
        timestamp: Date.now(),
      },
    });
  });
  return stream;
}
