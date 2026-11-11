import { normalizeContext } from "@earendil-works/pi-ai";
import {
  COMPACTION_MAINTENANCE_MESSAGE,
  CONTEXT_MANAGEMENT_THRESHOLD,
  createContextManagementCollector,
} from "./context-management.js";
import { CodexCompactionProtocolError, expandRemoteCompactionPayload, MAX_SSE_BYTES } from "./protocol.js";
import { collectProviderUsage } from "./remote-shared.js";
import {
  abortError,
  assertPreparedInput,
  codexReasoningEffort,
  isJsonObject,
  type RemoteCompactionRequest,
  type RemoteCompactionResponse,
} from "./remote-types.js";

export async function requestContextManagement(request: RemoteCompactionRequest): Promise<RemoteCompactionResponse> {
  if (request.signal.aborted) throw abortError();
  const controller = new AbortController();
  const signal = AbortSignal.any([request.signal, controller.signal]);
  const timeout = setTimeout(
    () => controller.abort(new Error("Context management request timed out")),
    request.requestTimeoutMs ?? 300_000,
  );
  const collector = createContextManagementCollector();
  let sentInput: ReturnType<typeof assertPreparedInput> | undefined;
  let successes = 0;
  const baseFetch = request.fetch ?? globalThis.fetch;
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(signal.reason instanceof Error ? signal.reason : abortError());
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    const stream = request.provider.stream(request.model, normalizeContext(request.context), {
      apiKey: request.apiKey,
      headers: request.headers,
      env: request.env,
      signal,
      reasoningEffort: codexReasoningEffort(request),
      transport: "sse",
      cacheRetention: "none",
      timeoutMs: request.requestTimeoutMs ?? 300_000,
      maxRetries: request.maxRetries ?? 2,
      fetch: async (input, init) => {
        const response = await baseFetch(input, {
          ...init,
          signal: AbortSignal.any([signal, ...(init?.signal ? [init.signal] : [])]),
        });
        if (signal.aborted) {
          void response.body?.cancel().catch(() => undefined);
          throw abortError();
        }
        if (!response.body) return response;
        if (response.ok) successes += 1;
        let bytes = 0;
        // A single pipe owns both readers; abort/error cancels upstream without tee deadlocks.
        const body = response.body.pipeThrough(
          new TransformStream<Uint8Array, Uint8Array>({
            transform(chunk, destination) {
              bytes += chunk.byteLength;
              if (bytes > MAX_SSE_BYTES)
                throw new CodexCompactionProtocolError("Context management stream exceeded the size limit");
              destination.enqueue(chunk);
            },
          }),
          { signal },
        );
        return new Response(body, {
          status: response.status,
          statusText: response.statusText,
          headers: response.headers,
        });
      },
      onPayload: (payload) => {
        if (signal.aborted) throw abortError();
        const expanded = expandRemoteCompactionPayload(payload, request.priorCheckpoint);
        sentInput = assertPreparedInput(expanded);
        if (sentInput.some((item) => item.type === "compaction_trigger")) {
          throw new CodexCompactionProtocolError("Context management input already contains a compaction trigger");
        }
        const include = expanded.include ?? [];
        if (!Array.isArray(include) || !Array.from(include).every((field) => typeof field === "string")) {
          throw new CodexCompactionProtocolError("Context management provider payload has an invalid include list");
        }
        const prepared = {
          ...expanded,
          // Request stateless reasoning without changing the provider's thinking effort.
          reasoning: isJsonObject(expanded.reasoning)
            ? { ...expanded.reasoning, summary: undefined }
            : expanded.reasoning,
          include: include.includes("reasoning.encrypted_content")
            ? [...include]
            : [...include, "reasoning.encrypted_content"],
          input: [
            ...sentInput,
            { role: "user", content: [{ type: "input_text", text: COMPACTION_MAINTENANCE_MESSAGE }] },
          ],
          context_management: [{ type: "compaction", compact_threshold: CONTEXT_MANAGEMENT_THRESHOLD }],
          store: false,
          stream: true,
          tool_choice: "none",
        };
        // Array replay never depends on server-side response state.
        delete (prepared as Record<string, unknown>).previous_response_id;
        return prepared;
      },
      onProviderStreamEvent: (event) => {
        request.onProviderStreamEvent?.(event);
        collector.observe(event);
      },
    });
    const usage = await Promise.race([collectProviderUsage(stream, signal), aborted]);
    if (signal.aborted) throw abortError();
    if (!sentInput || successes !== 1) {
      throw new CodexCompactionProtocolError(
        "Provider did not expose exactly one successful context management request",
      );
    }
    const replacementHistory = collector.finish();
    return { item: replacementHistory[0], replacementHistory, promptInput: sentInput, usage };
  } finally {
    clearTimeout(timeout);
    if (onAbort) signal.removeEventListener("abort", onAbort);
    controller.abort();
  }
}
