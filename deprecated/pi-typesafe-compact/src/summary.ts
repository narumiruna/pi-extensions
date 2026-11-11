import type { AgentMessage, StreamFn } from "@earendil-works/pi-agent-core";
import type { Api, Model, ProviderHeaders, Usage } from "@earendil-works/pi-ai";
import { type CompactionResult, compact, type ExtensionContext, estimateTokens } from "@earendil-works/pi-coding-agent";
import { formatUnits, type HistoryUnit } from "./history-units.js";

const MAX_SELECTED_CONTEXT_BYTES = 512 * 1024;

export type PiCompactionPreparation = Parameters<typeof compact>[0];

export interface ActiveModelSummary {
  text: string;
  usage?: Usage;
}

export interface PiNativeCompactRequest {
  preparation: PiCompactionPreparation;
  model: Model<Api>;
  apiKey?: string;
  headers?: Record<string, string>;
  customInstructions?: string;
  signal: AbortSignal;
  thinkingLevel: ExtensionContext["thinkingLevel"];
  env?: Record<string, string>;
  streamFn: StreamFn;
}

export type PiNativeCompactor = (request: PiNativeCompactRequest) => Promise<CompactionResult>;

const compactWithPi: PiNativeCompactor = (request) =>
  compact(
    request.preparation,
    request.model,
    request.apiKey,
    request.headers,
    request.customInstructions,
    request.signal,
    request.thinkingLevel,
    request.streamFn,
    request.env,
  );

function contextMessage(text: string): {
  message: AgentMessage;
  bytes: number;
} {
  return {
    message: {
      role: "user",
      content: [{ type: "text", text }],
      timestamp: Date.now(),
    },
    bytes: Buffer.byteLength(text, "utf8"),
  };
}

function selectedContextMessage(units: readonly HistoryUnit[]) {
  return contextMessage(formatUnits(units));
}

function estimatedTextTokens(text: string | undefined): number {
  return text ? Math.ceil(text.length / 4) : 0;
}

function assertSelectedInputFitsModel(
  preparation: PiCompactionPreparation,
  model: Model<Api>,
  customInstructions?: string,
): void {
  const contextWindow = model.contextWindow ?? 0;
  if (contextWindow <= 0) return;
  const inputBudget = contextWindow - preparation.settings.reserveTokens;
  const historyTokens =
    preparation.messagesToSummarize.reduce((total, message) => total + estimateTokens(message), 0) +
    estimatedTextTokens(preparation.previousSummary) +
    estimatedTextTokens(customInstructions);
  const turnPrefixTokens = preparation.turnPrefixMessages.reduce(
    (total, message) => total + estimateTokens(message),
    0,
  );
  if (Math.max(historyTokens, turnPrefixTokens) > inputBudget) {
    throw new Error("Selected history exceeds the active model compaction input budget");
  }
}

function selectedPreparation(
  preparation: PiCompactionPreparation,
  units: readonly HistoryUnit[],
  model: Model<Api>,
  customInstructions?: string,
): PiCompactionPreparation {
  const historyUnits = units.filter((unit) => unit.source !== "turn-prefix");
  const turnPrefixUnits = units.filter((unit) => unit.source === "turn-prefix");
  const history = historyUnits.length > 0 ? selectedContextMessage(historyUnits) : undefined;
  const turnPrefix = turnPrefixUnits.length > 0 ? selectedContextMessage(turnPrefixUnits) : undefined;
  const routePrefixThroughHistory = !history && turnPrefix !== undefined && Boolean(customInstructions?.trim());
  const historyRequest = history ?? (routePrefixThroughHistory ? turnPrefix : undefined);
  const turnPrefixRequest = routePrefixThroughHistory ? undefined : turnPrefix;
  const previousSummary =
    !historyRequest && turnPrefixRequest && preparation.previousSummary !== undefined
      ? contextMessage(`## Previous compaction summary\n\n${preparation.previousSummary}`)
      : undefined;
  const forwardedPreviousSummaryBytes = previousSummary
    ? 0
    : Buffer.byteLength(preparation.previousSummary ?? "", "utf8");
  const selectedBytes =
    (history?.bytes ?? 0) +
    (turnPrefix?.bytes ?? 0) +
    (previousSummary?.bytes ?? 0) +
    forwardedPreviousSummaryBytes +
    Buffer.byteLength(customInstructions ?? "", "utf8");
  if (selectedBytes > MAX_SELECTED_CONTEXT_BYTES) {
    throw new Error("Selected history exceeds the 512 KiB Pi-native compact request limit");
  }
  const selected = {
    ...preparation,
    messagesToSummarize: historyRequest ? [historyRequest.message] : previousSummary ? [previousSummary.message] : [],
    turnPrefixMessages: turnPrefixRequest ? [turnPrefixRequest.message] : [],
    isSplitTurn: turnPrefixRequest !== undefined,
    previousSummary: previousSummary ? undefined : preparation.previousSummary,
  };
  assertSelectedInputFitsModel(selected, model, customInstructions);
  return selected;
}

function stringHeaders(headers: ProviderHeaders | undefined): Record<string, string> | undefined {
  if (!headers) return undefined;
  return Object.fromEntries(Object.entries(headers).filter((entry): entry is [string, string] => entry[1] !== null));
}

function staleError(): DOMException {
  return new DOMException("Compaction ownership changed", "AbortError");
}

export async function summarizeWithPiNativeCompact(
  ctx: ExtensionContext,
  options: {
    model: Model<Api>;
    thinkingLevel: ExtensionContext["thinkingLevel"];
    selectedUnits: readonly HistoryUnit[];
    preparation: PiCompactionPreparation;
    customInstructions?: string;
    signal: AbortSignal;
    isCurrent(): boolean;
  },
  runCompact: PiNativeCompactor = compactWithPi,
): Promise<ActiveModelSummary> {
  options.signal.throwIfAborted();
  if (!options.isCurrent()) throw staleError();
  if (options.selectedUnits.length === 0 && !options.customInstructions?.trim()) {
    return {
      text: options.preparation.previousSummary?.trim() || "No history units were selected for summarization.",
    };
  }
  const preparation = selectedPreparation(
    options.preparation,
    options.selectedUnits,
    options.model,
    options.customInstructions,
  );
  const auth = await ctx.modelRegistry.getApiKeyAndHeaders(options.model);
  options.signal.throwIfAborted();
  if (!options.isCurrent()) throw staleError();
  if (!auth.ok) throw new Error(`Could not authenticate the active model: ${auth.error}`);

  const provider = ctx.modelRegistry.getProvider(options.model.provider);
  if (!provider) throw new Error(`Could not resolve the active model provider: ${options.model.provider}`);
  const model = auth.baseUrl ? { ...options.model, baseUrl: auth.baseUrl } : options.model;
  const streamFn: StreamFn = (requestModel, context, requestOptions) =>
    provider.streamSimple(requestModel, context, requestOptions);
  const result = await runCompact({
    preparation,
    model,
    apiKey: auth.apiKey,
    headers: stringHeaders(auth.headers),
    customInstructions: options.customInstructions,
    signal: options.signal,
    thinkingLevel: options.thinkingLevel,
    env: auth.env,
    streamFn,
  });
  options.signal.throwIfAborted();
  if (!options.isCurrent()) throw staleError();
  return { text: result.summary, usage: result.usage };
}
