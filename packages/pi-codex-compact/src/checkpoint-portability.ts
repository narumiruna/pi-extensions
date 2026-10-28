import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { convertToLlm, type ExtensionContext, type SessionEntry } from "@earendil-works/pi-coding-agent";
import { checkpointMarker, type latestCheckpoint } from "./checkpoint.js";
import { compactionFailureDetail } from "./compaction-failure.js";
import { resolveCompactionRoute } from "./model-api.js";
import { MAX_COMPACTION_ITEM_BYTES } from "./protocol.js";
import type { RemoteCompactionRequest } from "./remote-types.js";
import type { CodexCompactSettings } from "./settings.js";

export const PLAINTEXT_CHECKPOINT_TYPE = "codex-compact:plaintext-v1";
type Checkpoint = NonNullable<ReturnType<typeof latestCheckpoint>>;

export function savedPlaintextCheckpoint(entries: SessionEntry[], checkpoint: Checkpoint): string | undefined {
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index];
    if (entry.type !== "custom" || entry.customType !== PLAINTEXT_CHECKPOINT_TYPE) continue;
    const value = entry.data;
    if (
      value !== null &&
      typeof value === "object" &&
      "entryId" in value &&
      value.entryId === checkpoint.entry.id &&
      "checkpointId" in value &&
      value.checkpointId === checkpoint.details.checkpointId &&
      "summary" in value &&
      typeof value.summary === "string" &&
      value.summary.trim() &&
      Buffer.byteLength(value.summary) <= MAX_COMPACTION_ITEM_BYTES
    )
      return value.summary;
  }
  return undefined;
}

export function plaintextCheckpointMessages(
  messages: AgentMessage[],
  checkpoint: Checkpoint,
  summary: string,
): AgentMessage[] {
  const marker = checkpointMarker(checkpoint.details.checkpointId);
  return messages.map((message) =>
    message.role === "user" &&
    Array.isArray(message.content) &&
    message.content.length === 1 &&
    message.content[0].type === "text" &&
    message.content[0].text === marker
      ? {
          role: "compactionSummary",
          summary,
          tokensBefore: checkpoint.entry.tokensBefore,
          timestamp: message.timestamp,
        }
      : message,
  );
}

/** Resolve the issuer independently; never send its opaque state or credentials to the selected provider. */
export async function checkpointIssuerRequest(
  ctx: ExtensionContext,
  checkpoint: Checkpoint,
  messages: AgentMessage[],
  settings: CodexCompactSettings,
  signal: AbortSignal,
  isCurrent: () => boolean,
  fetch?: typeof globalThis.fetch,
): Promise<RemoteCompactionRequest> {
  const details = checkpoint.details;
  const model = ctx.modelRegistry.find(details.provider, details.modelId);
  const route = resolveCompactionRoute(model, settings);
  if (!model || route.kind !== "remote" || route.api !== details.api || route.profile !== details.profile)
    throw new Error("The checkpoint's issuing model/API/profile is unavailable; switch back to its original provider");
  const provider = ctx.modelRegistry.getProvider(model.provider);
  if (!provider) throw new Error("The checkpoint's issuing provider is unavailable");
  const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
  if (!isCurrent() || signal.aborted) throw new Error("Checkpoint transfer ownership changed");
  if (!auth.ok) throw new Error("The checkpoint's issuing provider requires authentication");
  const secrets = [auth.apiKey, ...Object.values(auth.headers ?? {}), ...Object.values(auth.env ?? {})].filter(
    (value): value is string => typeof value === "string" && value.length > 0,
  );
  return {
    provider,
    model,
    profile: route.profile,
    protocol: details.protocol,
    context: { systemPrompt: ctx.getSystemPrompt(), messages: convertToLlm(messages), tools: [] },
    apiKey: auth.apiKey,
    headers: auth.headers,
    env: auth.env,
    signal,
    priorCheckpoint: { marker: checkpointMarker(details.checkpointId), replacementHistory: details.replacementHistory },
    requestTimeoutMs: settings.requestTimeoutMs,
    maxRetries: settings.maxRetries,
    fetch: async (input, init) => {
      if (!isCurrent() || signal.aborted) throw new Error("Checkpoint transfer ownership changed before dispatch");
      try {
        return await (fetch ?? globalThis.fetch)(input, init);
      } catch (error) {
        throw new Error(compactionFailureDetail(error, secrets));
      }
    },
  };
}
