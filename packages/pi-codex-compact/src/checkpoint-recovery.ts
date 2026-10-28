import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { type AssistantMessage, type AssistantMessageEventStream, normalizeContext } from "@earendil-works/pi-ai";
import type { SessionBeforeCompactEvent } from "@earendil-works/pi-coding-agent";
import { expandRemoteCompactionPayload, MAX_COMPACTION_ITEM_BYTES, MAX_SSE_BYTES } from "./protocol.js";
import { abortError, assertPreparedInput, isJsonObject, type RemoteCompactionRequest } from "./remote-types.js";

export const RECOVERY_INSTRUCTION =
  "Summarize the preceding conversation and encrypted checkpoint into a plaintext continuation checkpoint. Preserve user goals, constraints, decisions, completed work, pending tasks, and relevant file paths. Do not continue the task, call tools, or emit another encrypted checkpoint. Later retained messages are provided separately by the client.";

export function summaryPrefix(
  messages: AgentMessage[],
  kept: AgentMessage[],
  fingerprint: (message: AgentMessage) => string,
): AgentMessage[] {
  if (kept.length > messages.length) throw new Error("Checkpoint recovery cut point cannot be projected safely");
  const prefixLength = messages.length - kept.length;
  if (!kept.every((message, index) => fingerprint(message) === fingerprint(messages[prefixLength + index]))) {
    throw new Error("Checkpoint recovery retained tail does not match the active context");
  }
  return messages.slice(0, prefixLength);
}

// This is an inference request, not another remote compaction protocol. The caller
// owns the lossy native-fallback policy after this request releases its resources.
export async function summarizeCheckpoint(
  request: RemoteCompactionRequest,
  options: { maxTokens: number; customInstructions?: string },
) {
  if (!request.priorCheckpoint) throw new Error("Checkpoint recovery requires a compatible checkpoint");
  if (request.signal.aborted) throw abortError();
  const controller = new AbortController();
  const signal = AbortSignal.any([request.signal, controller.signal]);
  const timer = setTimeout(
    () => controller.abort(new Error("Checkpoint recovery timed out")),
    request.requestTimeoutMs ?? 300_000,
  );
  let abortListener: (() => void) | undefined;
  const aborted = new Promise<never>((_, reject) => {
    abortListener = () => reject(signal.reason instanceof Error ? signal.reason : abortError());
    signal.addEventListener("abort", abortListener, { once: true });
  });
  // Synchronous provider failures can occur before the collection race is installed.
  void aborted.catch(() => undefined);
  let stream: AssistantMessageEventStream | undefined;
  let payloadSeen = false;
  let successes = 0;
  let terminalSeen = false;
  let terminalText: string | undefined;
  const baseFetch = request.fetch ?? globalThis.fetch;
  try {
    stream = request.provider.stream(request.model, normalizeContext(request.context), {
      apiKey: request.apiKey,
      headers: request.headers,
      env: request.env,
      signal,
      transport: "sse",
      cacheRetention: "none",
      maxTokens: options.maxTokens,
      maxRetries: request.maxRetries,
      timeoutMs: request.requestTimeoutMs,
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
        const body = response.body.pipeThrough(
          new TransformStream<Uint8Array, Uint8Array>({
            transform(chunk, destination) {
              bytes += chunk.byteLength;
              if (bytes > MAX_SSE_BYTES) throw new Error("Checkpoint recovery stream exceeded the size limit");
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
        const input = assertPreparedInput(expanded);
        if (input.some((item) => item.type === "compaction_trigger"))
          throw new Error("Recovery input contains a compaction trigger");
        const prepared: Record<string, unknown> = {
          ...expanded,
          input: [
            ...input,
            {
              role: "user",
              content: [
                {
                  type: "input_text",
                  text:
                    RECOVERY_INSTRUCTION +
                    (options.customInstructions ? `\nAdditional focus: ${options.customInstructions}` : ""),
                },
              ],
            },
          ],
          tools: [],
          tool_choice: "none",
          store: false,
          stream: true,
        };
        delete prepared.context_management;
        delete prepared.previous_response_id;
        if (Buffer.byteLength(JSON.stringify(prepared)) > MAX_SSE_BYTES)
          throw new Error("Checkpoint recovery request exceeded the size limit");
        payloadSeen = true;
        return prepared;
      },
      onProviderStreamEvent: (raw) => {
        if (!isJsonObject(raw)) return;
        if (raw.type === "response.output_item.done") {
          const item = raw.item;
          if (!isJsonObject(item) || (item.type !== "message" && item.type !== "reasoning"))
            throw new Error("Unsafe checkpoint recovery output");
          if (
            item.type === "message" &&
            (item.role !== "assistant" ||
              !Array.isArray(item.content) ||
              !item.content.every(
                (part) => isJsonObject(part) && part.type === "output_text" && typeof part.text === "string",
              ))
          )
            throw new Error("Unsafe checkpoint recovery message");
        }
        if (raw.type !== "response.completed" && raw.type !== "response.done") return;
        const response = raw.response;
        if (
          terminalSeen ||
          !isJsonObject(response) ||
          response.status !== "completed" ||
          response.error != null ||
          response.incomplete_details != null ||
          !Array.isArray(response.output)
        )
          throw new Error("Checkpoint recovery did not complete safely");
        if (
          !Array.from(response.output).every(
            (item) =>
              isJsonObject(item) &&
              (item.status === undefined || item.status === "completed") &&
              (item.type === "reasoning" ||
                (item.type === "message" &&
                  item.role === "assistant" &&
                  Array.isArray(item.content) &&
                  item.content.every(
                    (part) => isJsonObject(part) && part.type === "output_text" && typeof part.text === "string",
                  ))),
          )
        )
          throw new Error("Unsafe checkpoint recovery terminal output");
        // Pi emits one text block per message, concatenating its output-text parts.
        terminalText = response.output
          .flatMap((item) =>
            isJsonObject(item) && item.type === "message" && Array.isArray(item.content)
              ? [item.content.map((part: { text: string }) => part.text).join("")]
              : [],
          )
          .join("\n");
        terminalSeen = true;
      },
    });
    const activeStream = stream;
    const collect = async () => {
      let completed: AssistantMessage | undefined;
      for await (const item of activeStream) {
        if (signal.aborted) throw abortError();
        if (item.type === "error") throw new Error(item.error.errorMessage ?? "Checkpoint recovery failed");
        if (item.type === "done") {
          if (
            completed ||
            item.reason !== "stop" ||
            item.message.stopReason !== "stop" ||
            item.message.content.some((block) => block.type !== "text" && block.type !== "thinking")
          )
            throw new Error("Unsafe checkpoint recovery completion");
          completed = item.message;
        }
      }
      if (!completed || !payloadSeen || successes !== 1 || !terminalSeen)
        throw new Error("Checkpoint recovery ended without validated completion");
      const summary = completed.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n");
      if (summary !== terminalText)
        throw new Error("Checkpoint recovery terminal text conflicts with provider completion");
      if (!summary.trim() || Buffer.byteLength(summary) > MAX_COMPACTION_ITEM_BYTES)
        throw new Error("Checkpoint recovery returned an empty or oversized summary");
      return { summary, usage: completed.usage };
    };
    return await Promise.race([collect(), aborted]);
  } finally {
    clearTimeout(timer);
    if (abortListener) signal.removeEventListener("abort", abortListener);
    controller.abort();
    // Unblock our consumer even if a custom provider ignores the abort signal.
    stream?.end();
  }
}

export async function recoverCheckpoint(request: RemoteCompactionRequest, event: SessionBeforeCompactEvent) {
  const result = await summarizeCheckpoint(request, {
    maxTokens: Math.max(
      1,
      Math.min(
        Math.floor(event.preparation.settings.reserveTokens * 0.8),
        request.model.maxTokens > 0 ? request.model.maxTokens : Number.POSITIVE_INFINITY,
      ),
    ),
    customInstructions: event.customInstructions,
  });
  const modifiedFiles = [
    ...new Set([...event.preparation.fileOps.written, ...event.preparation.fileOps.edited]),
  ].sort();
  const readFiles = [...event.preparation.fileOps.read].filter((path) => !modifiedFiles.includes(path)).sort();
  const summary =
    result.summary +
    (readFiles.length ? `\n\n<read-files>\n${readFiles.join("\n")}\n</read-files>` : "") +
    (modifiedFiles.length ? `\n\n<modified-files>\n${modifiedFiles.join("\n")}\n</modified-files>` : "");
  if (Buffer.byteLength(summary) > MAX_COMPACTION_ITEM_BYTES)
    throw new Error("Checkpoint recovery summary and file metadata exceeded the size limit");
  return {
    summary,
    firstKeptEntryId: event.preparation.firstKeptEntryId,
    tokensBefore: event.preparation.tokensBefore,
    usage: result.usage,
    details: { readFiles, modifiedFiles },
  };
}
