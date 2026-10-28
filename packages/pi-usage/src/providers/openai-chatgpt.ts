import type { PiModel, ResolvedUsageAuth, UsageProviderAdapter } from "../types.js";

export const CHATGPT_USAGE_SETTINGS_URL = "https://chatgpt.com/settings/usage";
const DIRECT_TOKEN_SCOPE = "chatgpt.tokens.use.direct";

type RequestAuth = {
  apiKey?: string;
  headers?: Record<string, string | null>;
};

export class UnsupportedOpenAIUsageAuthError extends Error {
  override readonly name = "UnsupportedOpenAIUsageAuthError";

  constructor() {
    super("OpenAI API-key usage reporting is not supported; ChatGPT plan status requires native /login openai OAuth.");
  }
}

// Native Sign in with ChatGPT grants access to api.openai.com, not the legacy wham contract.
// Report only verified authentication, never invented quotas or backend endpoint compatibility.
// https://developers.openai.com/siwc/token-sharing-open-source/token-reference
// https://developers.openai.com/siwc/ui-ux-guidelines
export const OPENAI_CHATGPT_ADAPTER: UsageProviderAdapter = {
  id: "openai",
  displayName: "OpenAI",
  semantics: { kind: "consumer-subscription", label: "ChatGPT plan authentication status" },
  invalidateCacheOnFailure: true,
  async query(auth, signal, timeoutMs, guard) {
    if (auth.openaiCompanion) {
      const { queryOpenAICompanionUsage } = await import("./openai-companion-usage.js");
      signal.throwIfAborted();
      return queryOpenAICompanionUsage(auth, signal, timeoutMs, guard);
    }
    if (!guard) throw new Error("ChatGPT plan status requires runtime-auth revalidation.");
    signal.throwIfAborted();
    await guard();
    signal.throwIfAborted();
    return {
      providerId: "openai",
      providerName: "OpenAI",
      capturedAt: Date.now(),
      source: "openai-chatgpt-auth",
      semantics: { kind: "consumer-subscription", label: "ChatGPT plan authentication status" },
      buckets: [],
      metrics: [{ id: "plan-auth", label: "ChatGPT plan authentication", value: "Connected (native OAuth)" }],
      notes: [
        auth.openaiUseCodexUsage
          ? "Numerical usage requires a companion /login openai-codex with the same ChatGPT account/workspace; native inference stays on openai."
          : "Codex companion usage is disabled. Enable Use Codex login for OpenAI usage in /usage Settings only when both logins use the same ChatGPT account and workspace.",
        `Manage usage: ${CHATGPT_USAGE_SETTINGS_URL}`,
        "Native OpenAI has no supported numerical usage API. Optional companion usage uses undocumented ChatGPT endpoints; registration matching is not independent identity proof.",
        "Fast mode and earned reset redemption remain legacy openai-codex features.",
      ],
    };
  },
};

export function resolveOpenAIChatGPTAuth(
  auth: RequestAuth,
  providerAuth: RequestAuth | undefined,
  source: string | undefined,
  model: PiModel,
  candidates: readonly unknown[],
): ResolvedUsageAuth {
  // isUsingOAuth() is a cached snapshot; source alone is also insufficient when a model header
  // overrides Authorization. Match both freshly resolved credentials and the exact native grant.
  if (source !== "OAuth") throw new UnsupportedOpenAIUsageAuthError();
  const access = openAIAuthAccessToken(auth);
  if (!access || access !== openAIAuthAccessToken(providerAuth)) {
    throw new Error("The active OpenAI model authorization does not match its resolved OAuth credential.");
  }
  const matches = new Map<string, { refresh: string; clientId: string }>();
  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) continue;
    const credential = candidate as Record<string, unknown>;
    if (credential.type !== "oauth" || credential.access !== access) continue;
    if (
      typeof credential.refresh !== "string" ||
      !credential.refresh ||
      typeof credential.expires !== "number" ||
      !Number.isFinite(credential.expires) ||
      typeof credential.clientId !== "string" ||
      !credential.clientId.trim() ||
      !Array.isArray(credential.scopes) ||
      !credential.scopes.every((scope) => typeof scope === "string") ||
      !credential.scopes.includes(DIRECT_TOKEN_SCOPE)
    ) {
      throw new Error(
        "The matching OpenAI OAuth credential is not a complete native ChatGPT grant; reconnect with /login openai.",
      );
    }
    matches.set(JSON.stringify([credential.clientId, credential.refresh]), {
      refresh: credential.refresh,
      clientId: credential.clientId,
    });
  }
  if (matches.size > 1)
    throw new Error("Conflicting native ChatGPT credentials match the active OpenAI runtime account.");
  const match = matches.values().next().value;
  if (!match)
    throw new Error("The active OpenAI runtime account does not match an available native ChatGPT OAuth credential.");
  const authorization = `Bearer ${access}`;
  return {
    openaiClientId: match.clientId,
    apiKey: access,
    headers: { Authorization: authorization },
    fingerprint: "",
    secrets: [access, match.refresh, authorization, match.clientId],
    model,
  };
}

export function openAIAuthAccessToken(auth: RequestAuth | undefined): string | undefined {
  if (!auth) return undefined;
  const authorization = Object.entries(auth.headers ?? {}).filter(([name]) => name.toLowerCase() === "authorization");
  if (authorization.length > 1) throw new Error("OpenAI runtime authorization headers are ambiguous.");
  // Explicit null or non-Bearer overrides must not fall back to the underlying OAuth apiKey.
  if (authorization.length === 1) return /^Bearer\s+(.+)$/iu.exec(authorization[0]?.[1] ?? "")?.[1];
  return auth.apiKey;
}
