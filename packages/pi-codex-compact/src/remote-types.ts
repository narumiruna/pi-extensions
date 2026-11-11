import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import {
  type Api,
  type Context,
  clampThinkingLevel,
  type Model,
  type Provider,
  type ProviderHeaders,
  type Usage,
} from "@earendil-works/pi-ai";
import type { RemoteCompactionProtocol, ResponsesCompactionProfile } from "./model-api.js";
import type { JsonObject } from "./protocol.js";

export interface PriorCheckpointPayload {
  marker: string;
  replacementHistory: readonly unknown[];
}

export interface RemoteCompactionRequest {
  provider: Provider;
  model: Model<Api>;
  profile: ResponsesCompactionProfile;
  context: Context;
  protocol: RemoteCompactionProtocol;
  thinkingLevel?: ThinkingLevel;
  apiKey?: string;
  headers?: ProviderHeaders;
  env?: Record<string, string>;
  signal: AbortSignal;
  priorCheckpoint?: PriorCheckpointPayload;
  requestTimeoutMs?: number;
  maxRetries?: number;
  fetch?: typeof globalThis.fetch;
  onProviderStreamEvent?: (event: unknown) => void;
}

export function codexReasoningEffort(request: RemoteCompactionRequest) {
  if (request.model.api !== "openai-codex-responses") return undefined;
  const level = clampThinkingLevel(request.model, request.thinkingLevel ?? "medium");
  return level === "off" ? "none" : level;
}

export interface RemoteCompactionResponse {
  item: JsonObject;
  promptInput: JsonObject[];
  compactedOutput?: JsonObject[];
  replacementHistory?: JsonObject[];
  usage: Usage;
}

export function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function abortError(): DOMException {
  return new DOMException("Compaction aborted", "AbortError");
}

export function assertPreparedInput(payload: JsonObject): JsonObject[] {
  if (!Array.isArray(payload.input) || !payload.input.every(isJsonObject)) {
    throw new Error("Prepared compaction payload has invalid input items");
  }
  return structuredClone(payload.input);
}
