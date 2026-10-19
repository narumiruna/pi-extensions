import {
  type Api,
  type AssistantMessage,
  type AssistantMessageEventStream,
  createAssistantMessageEventStream,
  type Model,
  type Models,
  type ModelsApiStreamOptions,
  type ModelsDeferredFetchOptions,
  type ModelsSimpleStreamOptions,
  type TranscriptContext,
} from "@earendil-works/pi-ai";

export type HostAttempt = {
  method: "stream" | "complete" | "streamSimple" | "completeSimple" | "streamDeferred" | "fetchDeferred";
  model: Model<Api>;
  signal: AbortSignal | undefined;
  sessionId?: string;
  handle?: Parameters<Models["fetchDeferred"]>[1];
};

export interface HostPermit {
  finish(message: AssistantMessage): Promise<void>;
}

/** Chat-dispatch experiment, not a public Models implementation or a passed gate. */
export function probeHostModels(underlying: Models, admit: (attempt: HostAttempt) => Promise<HostPermit>): Models {
  const failure = (model: Model<Api>, error: unknown): AssistantMessage => ({
    role: "assistant",
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    stopReason: "error",
    errorMessage: `Goal host admission denied: ${error instanceof Error ? error.message : String(error)}`,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    timestamp: 0,
  });

  const relay = (attempt: HostAttempt, produce: () => AssistantMessageEventStream) => {
    const output = createAssistantMessageEventStream();
    void (async () => {
      try {
        const permit = await admit(attempt);
        attempt.signal?.throwIfAborted();
        const source = produce();
        for await (const event of source) {
          if (event.type === "done" || event.type === "error") {
            const message = event.type === "done" ? event.message : event.error;
            // push(done/error) resolves result(), so persistence must happen first.
            await permit.finish(message);
          }
          output.push(event);
        }
        output.end(await source.result());
      } catch (error) {
        const message = failure(attempt.model, error);
        output.push({ type: "error", reason: "error", error: message });
        output.end(message);
      }
    })();
    return output;
  };

  const complete = async (attempt: HostAttempt, produce: () => Promise<AssistantMessage>) => {
    const permit = await admit(attempt);
    attempt.signal?.throwIfAborted();
    const message = await produce();
    await permit.finish(message);
    return message;
  };

  const streamSimple = (model: Model<Api>, messages: TranscriptContext, options?: ModelsSimpleStreamOptions) =>
    relay({ method: "streamSimple", model, signal: options?.signal, sessionId: options?.sessionId }, () =>
      underlying.streamSimple(model, messages, { ...options, maxRetries: 0 }),
    );
  const completeSimple = (model: Model<Api>, messages: TranscriptContext, options?: ModelsSimpleStreamOptions) =>
    complete({ method: "completeSimple", model, signal: options?.signal, sessionId: options?.sessionId }, () =>
      underlying.completeSimple(model, messages, { ...options, maxRetries: 0 }),
    );
  const stream = (model: Model<Api>, messages: TranscriptContext, options?: ModelsApiStreamOptions<Api>) =>
    relay({ method: "stream", model, signal: options?.signal, sessionId: options?.sessionId }, () =>
      underlying.stream(model, messages, { ...options, maxRetries: 0 }),
    );
  const completeFull = (model: Model<Api>, messages: TranscriptContext, options?: ModelsApiStreamOptions<Api>) =>
    complete({ method: "complete", model, signal: options?.signal, sessionId: options?.sessionId }, () =>
      underlying.complete(model, messages, { ...options, maxRetries: 0 }),
    );
  const streamDeferred = (
    model: Model<Api>,
    handle: Parameters<Models["streamDeferred"]>[1],
    options?: ModelsDeferredFetchOptions,
  ) =>
    relay({ method: "streamDeferred", model, signal: options?.signal, handle }, () =>
      underlying.streamDeferred(model, handle, { ...options, maxRetries: 0 }),
    );
  const fetchDeferred = (
    model: Model<Api>,
    handle: Parameters<Models["fetchDeferred"]>[1],
    options?: ModelsDeferredFetchOptions,
  ) =>
    complete({ method: "fetchDeferred", model, signal: options?.signal, handle }, () =>
      underlying.fetchDeferred(model, handle, { ...options, maxRetries: 0 }),
    );

  return new Proxy(underlying, {
    get(target, key) {
      if (key === "stream") return stream;
      if (key === "complete") return completeFull;
      if (key === "streamSimple") return streamSimple;
      if (key === "completeSimple") return completeSimple;
      if (key === "streamDeferred") return streamDeferred;
      if (key === "fetchDeferred") return fetchDeferred;
      // Cancellation deliberately remains available after admission is denied.
      // Other API surfaces are not covered: this prototype is not production-safe.
      const value = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
