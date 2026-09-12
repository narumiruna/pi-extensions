// This module intentionally keeps adapter transport beside resolved-auth and origin validation;
// separating that security boundary would duplicate request and redaction policy across providers.
import { randomBytes } from "node:crypto";
import { type ExtensionContext, readStoredCredential } from "@earendil-works/pi-coding-agent";
import { errorMessage, fingerprintResolvedAuth, redactUsageError } from "./core.js";
import { fallbackOAuthCredentialCandidates, type OAuthCredentialCandidateReader } from "./oauth-credential-source.js";
import { normalizeBasetenBillingUsagePayload } from "./providers/baseten.js";
import { normalizeCodexBackendPayload } from "./providers/codex.js";
import { normalizeDeepSeekBalancePayload } from "./providers/deepseek.js";
import { createFireworksAdapter } from "./providers/fireworks.js";
import { normalizeGitHubCopilotUsagePayload } from "./providers/github-copilot.js";
import { normalizeKimiCodingUsagePayload } from "./providers/kimi-coding.js";
import { type MiniMaxProviderId, miniMaxUsageKind, normalizeMiniMaxUsagePayload } from "./providers/minimax.js";
import { normalizeMoonshotBalancePayload } from "./providers/moonshot.js";
import { normalizeOpenCodeZenPayload } from "./providers/opencode-zen.js";
import { normalizeOpenRouterKeyPayload } from "./providers/openrouter.js";
import { normalizeVercelAIGatewayCreditsPayload } from "./providers/vercel-ai-gateway.js";
import { normalizeXaiBillingPayload } from "./providers/xai.js";
import { normalizeZaiQuotaPayload, normalizeZaiSubscriptionPayload } from "./providers/zai.js";
import { zaiResponseError } from "./providers/zai-errors.js";
import type {
  BasetenBillingUsagePayload,
  CodexBackendPayload,
  DeepSeekBalancePayload,
  GitHubCopilotUsagePayload,
  KimiCodingUsagePayload,
  MiniMaxUsagePayload,
  MoonshotBalancePayload,
  OpenCodeZenPayload,
  OpenRouterKeyPayload,
  PiModel,
  ResolvedUsageAuth,
  UsageProviderAdapter,
  UsageQuerySettings,
  UsageReport,
  UsageRequestGuard,
  VercelAIGatewayCreditsPayload,
  XaiBillingPayload,
  XaiUserPayload,
  ZaiPlanInfo,
  ZaiQuotaPayload,
  ZaiSubscriptionPayload,
} from "./types.js";
import { resolveUsageTarget } from "./usage-targets.js";

const BASETEN_BILLING_USAGE_URL = "https://api.baseten.co/v1/billing/usage_summary";
const BASETEN_USAGE_WINDOW_DAYS = 30;
const CODEX_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const DEEPSEEK_BALANCE_URL = "https://api.deepseek.com/user/balance";
const GITHUB_COPILOT_USAGE_URL = "https://api.github.com/copilot_internal/user";
const OPENROUTER_KEY_URL = "https://openrouter.ai/api/v1/key";
const VERCEL_AI_GATEWAY_CREDITS_URL = "https://ai-gateway.vercel.sh/v1/credits";
const OPENCODE_GO_USAGE_URL = "https://opencode.ai/zen/go/v1/usage";
const KIMI_CODING_USAGE_URL = "https://api.kimi.com/coding/v1/usages";
const MINIMAX_API_ROOTS = Object.freeze({
  minimax: "https://api.minimax.io",
  "minimax-cn": "https://api.minimaxi.com",
});
const MOONSHOT_BALANCE_URLS = Object.freeze({
  moonshotai: "https://api.moonshot.ai/v1/users/me/balance",
  "moonshotai-cn": "https://api.moonshot.cn/v1/users/me/balance",
});
const SHARED_MOONSHOT_ENV_VAR = "MOONSHOT_API_KEY";
const XAI_USER_URL = "https://cli-chat-proxy.grok.com/v1/user?include=subscription";
const XAI_BILLING_URL = "https://cli-chat-proxy.grok.com/v1/billing?format=credits";
const XAI_CLIENT_HEADERS = Object.freeze({
  "X-XAI-Token-Auth": "xai-grok-cli",
  "x-grok-client-version": "1.0.10",
  "x-grok-client-mode": "interactive",
});
const MAX_SUCCESS_BODY_BYTES = 64 * 1024;
const MAX_ERROR_BODY_BYTES = 4 * 1024;

export const AUTH_FINGERPRINT_SALT = randomBytes(32);

export const SUPPORTED_ADAPTERS: readonly UsageProviderAdapter[] = [
  {
    id: "baseten",
    displayName: "Baseten",
    semantics: { kind: "api-key", label: "Organization Model APIs spend" },
    async query(auth, signal, timeoutMs, guard) {
      if (!guard) throw new Error("Baseten billing usage requires request-boundary revalidation.");
      const startedAt = Date.now();
      await guard();
      const windowAt = Date.now();
      const payload = (await fetchProviderJson(
        basetenBillingUsageUrl(windowAt),
        auth,
        signal,
        remainingTimeout(timeoutMs, startedAt, "fetching Baseten billing usage"),
        "Baseten billing usage endpoint",
        { redirect: "error" },
      )) as BasetenBillingUsagePayload;
      await guard();
      return normalizeBasetenBillingUsagePayload(payload, Date.now());
    },
  },
  {
    id: "openai-codex",
    displayName: "OpenAI Codex",
    semantics: {
      kind: "consumer-subscription",
      label: "ChatGPT subscription limits",
    },
    async query(auth, signal, timeoutMs) {
      const payload = await fetchProviderJson(CODEX_USAGE_URL, auth, signal, timeoutMs, "Codex usage endpoint");
      return normalizeCodexBackendPayload(payload as CodexBackendPayload, Date.now());
    },
  },
  {
    id: "deepseek",
    displayName: "DeepSeek",
    semantics: { kind: "api-key", label: "DeepSeek API balance" },
    async query(auth, signal, timeoutMs, guard) {
      if (!guard) throw new Error("DeepSeek API balance requires request-boundary revalidation.");
      const startedAt = Date.now();
      await guard();
      const remainingMs = timeoutMs - (Date.now() - startedAt);
      if (remainingMs <= 0) throw new Error("Timed out while revalidating DeepSeek runtime auth.");
      const payload = await fetchProviderJson(
        DEEPSEEK_BALANCE_URL,
        auth,
        signal,
        remainingMs,
        "DeepSeek API balance endpoint",
        { redirect: "error" },
      );
      return normalizeDeepSeekBalancePayload(payload as DeepSeekBalancePayload, Date.now());
    },
  },
  {
    id: "github-copilot",
    displayName: "GitHub Copilot",
    semantics: {
      kind: "consumer-subscription",
      label: "GitHub Copilot account allowance",
    },
    async query(auth, signal, timeoutMs) {
      const payload = await fetchProviderJson(
        GITHUB_COPILOT_USAGE_URL,
        auth,
        signal,
        timeoutMs,
        "GitHub Copilot usage endpoint",
      );
      return normalizeGitHubCopilotUsagePayload(payload as GitHubCopilotUsagePayload, Date.now());
    },
  },
  {
    id: "openrouter",
    displayName: "OpenRouter",
    semantics: { kind: "api-key", label: "API-key spend limits" },
    async query(auth, signal, timeoutMs) {
      const payload = await fetchProviderJson(OPENROUTER_KEY_URL, auth, signal, timeoutMs, "OpenRouter key endpoint");
      return normalizeOpenRouterKeyPayload(payload as OpenRouterKeyPayload, Date.now());
    },
  },
  {
    id: "vercel-ai-gateway",
    displayName: "Vercel AI Gateway",
    semantics: { kind: "api-key", label: "AI Gateway credits and lifetime spend" },
    async query(auth, signal, timeoutMs, guard) {
      if (!guard) throw new Error("Vercel AI Gateway usage requires request-boundary revalidation.");
      const startedAt = Date.now();
      await guard();
      const payload = (await fetchProviderJson(
        VERCEL_AI_GATEWAY_CREDITS_URL,
        auth,
        signal,
        remainingTimeout(timeoutMs, startedAt, "fetching Vercel AI Gateway credits"),
        "Vercel AI Gateway credits endpoint",
        { redirect: "error" },
      )) as VercelAIGatewayCreditsPayload;
      await guard();
      return normalizeVercelAIGatewayCreditsPayload(payload, Date.now());
    },
  },
  createFireworksAdapter(fetchProviderJson),
  {
    id: "opencode-go",
    displayName: "OpenCode Go",
    semantics: { kind: "consumer-subscription", label: "OpenCode Zen plan usage" },
    async query(auth, signal, timeoutMs) {
      const payload = await fetchProviderJson(
        OPENCODE_GO_USAGE_URL,
        auth,
        signal,
        timeoutMs,
        "OpenCode Zen usage endpoint",
      );
      return normalizeOpenCodeZenPayload(payload as OpenCodeZenPayload, Date.now());
    },
  },
  {
    id: "kimi-coding",
    displayName: "Kimi For Coding",
    semantics: { kind: "consumer-subscription", label: "Kimi Coding Plan usage" },
    async query(auth, signal, timeoutMs) {
      const payload = await fetchProviderJson(
        KIMI_CODING_USAGE_URL,
        auth,
        signal,
        timeoutMs,
        "Kimi Coding usage endpoint",
        { redirect: "error" },
      );
      return normalizeKimiCodingUsagePayload(payload as KimiCodingUsagePayload, Date.now());
    },
  },
  {
    id: "minimax",
    displayName: "MiniMax",
    semantics: { kind: "consumer-subscription", label: "MiniMax usage" },
    async query(auth, signal, timeoutMs, guard) {
      return queryMiniMaxUsage("minimax", auth, signal, timeoutMs, guard);
    },
  },
  {
    id: "minimax-cn",
    displayName: "MiniMax CN",
    semantics: { kind: "consumer-subscription", label: "MiniMax usage" },
    async query(auth, signal, timeoutMs, guard) {
      return queryMiniMaxUsage("minimax-cn", auth, signal, timeoutMs, guard);
    },
  },
  {
    id: "moonshotai",
    displayName: "Moonshot AI",
    semantics: { kind: "api-key", label: "Moonshot API account balance" },
    async query(auth, signal, timeoutMs, guard) {
      return queryMoonshotBalance("moonshotai", auth, signal, timeoutMs, guard);
    },
  },
  {
    id: "moonshotai-cn",
    displayName: "Moonshot AI CN",
    semantics: { kind: "api-key", label: "Moonshot API account balance" },
    async query(auth, signal, timeoutMs, guard) {
      return queryMoonshotBalance("moonshotai-cn", auth, signal, timeoutMs, guard);
    },
  },
  {
    id: "zai",
    displayName: "Z.AI",
    invalidateCacheOnFailure: true,
    semantics: { kind: "consumer-subscription", label: "GLM Coding Plan usage" },
    async query(auth, signal, timeoutMs, guard) {
      return queryZaiUsage("zai", "Z.AI", auth, signal, timeoutMs, guard);
    },
  },
  {
    id: "zai-coding-cn",
    displayName: "Z.AI Coding CN",
    invalidateCacheOnFailure: true,
    semantics: { kind: "consumer-subscription", label: "GLM Coding Plan usage" },
    async query(auth, signal, timeoutMs, guard) {
      return queryZaiUsage("zai-coding-cn", "Z.AI Coding CN", auth, signal, timeoutMs, guard);
    },
  },
];

// Reviewed contract pins:
// - Pi xAI provider at https://api.x.ai and OAuth scope
//   "openid profile email offline_access grok-cli:access api:access" at
//   e86823096c5bad39e1ca282ec24bc5eb9bec745b, unchanged at
//   ccfe79ed238674f760c986e3a61493aab794000a.
// - Grok Build identity, credits routes/structs, required token-auth and version headers, and
//   client-mode telemetry at 9684fa3cdbf2995e30ea8b9b637f1db008f144fc (client version 1.0.10).
// - xAI Management API's separate team billing boundary at
//   723dd2aa22d17be35617463837dc47cda008d90e.
// x-userid remains attached only to billing to bind the proxy-canonical identity as Grok Build does.
export const XAI_ADAPTER: UsageProviderAdapter = {
  id: "xai",
  displayName: "xAI",
  semantics: {
    kind: "consumer-subscription",
    label: "xAI consumer subscription usage",
  },
  publishesStatusline: false,
  async query(auth, signal, timeoutMs, guard) {
    if (!guard) throw new Error("xAI usage requires request-boundary revalidation.");
    const startedAt = Date.now();
    const clientAuth = {
      ...auth,
      headers: { ...auth.headers, ...XAI_CLIENT_HEADERS },
    };
    await guard();
    const userPayload = (await fetchProviderJson(
      XAI_USER_URL,
      clientAuth,
      signal,
      remainingTimeout(timeoutMs, startedAt),
      "xAI consumer identity endpoint",
      { redirect: "error", userAgent: false },
    )) as XaiUserPayload;
    await guard();
    const userId = validatedXaiUserId(userPayload.userId);
    const billingAuth = {
      ...clientAuth,
      headers: { ...clientAuth.headers, "x-userid": userId },
      secrets: [...clientAuth.secrets, userId],
    };
    await guard();
    const billingPayload = (await fetchProviderJson(
      XAI_BILLING_URL,
      billingAuth,
      signal,
      remainingTimeout(timeoutMs, startedAt),
      "xAI consumer billing endpoint",
      { redirect: "error", userAgent: false },
    )) as XaiBillingPayload;
    await guard();
    return normalizeXaiBillingPayload(billingPayload, userPayload.subscriptionTier, Date.now());
  },
};

export function usageAdapters(): readonly UsageProviderAdapter[] {
  return [...SUPPORTED_ADAPTERS, XAI_ADAPTER];
}

export function adapterForProvider(providerId: string | undefined): UsageProviderAdapter | undefined {
  return usageAdapters().find((adapter) => adapter.id === providerId);
}

export function isStaleExtensionContextError(error: unknown): boolean {
  return (
    error instanceof Error && error.message.includes("This extension ctx is stale after session replacement or reload")
  );
}

export async function resolveUsageAuth(
  ctx: ExtensionContext,
  adapter: UsageProviderAdapter,
  salt: Uint8Array = AUTH_FINGERPRINT_SALT,
  credentialReader: StoredCredentialReader = readStoredCredential,
  candidateReader?: OAuthCredentialCandidateReader,
): Promise<ResolvedUsageAuth | undefined> {
  if (ctx.model?.provider === adapter.id && !hasOfficialOrigin(ctx.model, adapter.id)) {
    throw new Error(
      `${adapter.displayName} usage cannot send a custom provider base URL credential to the official usage endpoint.`,
    );
  }

  const model = candidateModels(ctx, adapter.id).find((candidate) => hasOfficialOrigin(candidate, adapter.id));
  if (!model) return undefined;
  // SAFETY: Pi exposes the required auth methods at runtime, and checks below narrow them before use.
  const registry = ctx.modelRegistry as unknown as UsageAuthRegistry;
  const provider = registry.getProvider?.(adapter.id);
  if (provider?.baseUrl && !hasOfficialUrlOrigin(provider.baseUrl, adapter.id)) {
    throw new Error(
      `${adapter.displayName} usage cannot send an overridden provider credential to the official usage endpoint.`,
    );
  }
  let modelAuth: RequestAuth | undefined;
  const currentModel = ctx.model?.provider === adapter.id ? ctx.model : undefined;
  const resolveCurrentModelAuth = async (): Promise<RequestAuth | undefined> => {
    if (!currentModel || typeof registry.getApiKeyAndHeaders !== "function") return undefined;
    const result = await registry.getApiKeyAndHeaders(currentModel);
    if (!result.ok) throw new Error(redactUsageError(result.error));
    return authorizationFrom(result) ? result : undefined;
  };
  const resolveSelectedAuthLast = ["deepseek", "minimax", "minimax-cn"].includes(adapter.id);
  if (!resolveSelectedAuthLast) modelAuth = await resolveCurrentModelAuth();
  if (typeof registry.getProviderAuth !== "function") {
    throw new Error("pi-usage requires Pi 0.81.0 or newer to validate resolved provider auth.");
  }
  if (!moonshotProviderAuthIsAllowed(ctx, adapter.id)) return undefined;
  const providerResult = await registry.getProviderAuth(adapter.id);
  if (!moonshotProviderAuthIsAllowed(ctx, adapter.id)) return undefined;
  if (providerResult?.auth.baseUrl && !hasOfficialUrlOrigin(providerResult.auth.baseUrl, adapter.id)) {
    throw new Error(
      `${adapter.displayName} usage cannot send a proxy-resolved credential to the official usage endpoint.`,
    );
  }
  // Providers with credential-change retries read selected-model auth last so a rotation during
  // provider-origin validation cannot leave the earlier credential queued for the usage request.
  if (resolveSelectedAuthLast) modelAuth = await resolveCurrentModelAuth();
  if (modelAuth?.baseUrl && !hasOfficialUrlOrigin(modelAuth.baseUrl, adapter.id)) {
    throw new Error(
      `${adapter.displayName} usage cannot send model-resolved proxy credentials to the official usage endpoint.`,
    );
  }
  const auth = modelAuth ?? providerResult?.auth;
  if (!auth) return undefined;
  const finalize = (resolved: ResolvedUsageAuth): ResolvedUsageAuth => {
    const preservedAuth = { ...(providerResult?.auth ?? auth) };
    const env = providerResult?.env ?? modelAuth?.env;
    const source = providerResult?.source;
    const effectiveBaseUrl = modelAuth?.baseUrl ?? providerResult?.auth.baseUrl ?? provider?.baseUrl ?? model.baseUrl;
    const redactionInputs = [
      preservedAuth.apiKey,
      ...Object.values(preservedAuth.headers ?? {}),
      ...Object.values(env ?? {}),
      modelAuth?.apiKey,
      ...Object.values(modelAuth?.headers ?? {}),
    ].filter((value): value is string => typeof value === "string" && value.length > 0);
    return {
      ...resolved,
      auth: preservedAuth,
      ...(env ? { env: { ...env } } : {}),
      ...(source ? { source } : {}),
      effectiveBaseUrl,
      secrets: [...new Set([...resolved.secrets, ...redactionInputs])],
      fingerprint: fingerprintResolvedAuth(
        {
          apiKey: resolved.apiKey,
          headers: resolved.headers,
          baseUrl: effectiveBaseUrl,
          env,
          source,
          providerAuth: preservedAuth,
        },
        salt,
      ),
    };
  };
  if (adapter.id === "github-copilot") {
    const offered = candidateReader
      ? candidateReader(ctx, adapter.id)
      : fallbackOAuthCredentialCandidates(adapter.id, credentialReader);
    if (!offered.ok) {
      throw new Error("GitHub Copilot OAuth credential discovery failed closed.");
    }
    return finalize(resolveGitHubCopilotUsageAuth(auth, model, salt, offered.candidates, offered.offeredCount === 0));
  }
  if (adapter.id === "xai") {
    const offered = candidateReader
      ? candidateReader(ctx, adapter.id)
      : fallbackOAuthCredentialCandidates(adapter.id, credentialReader);
    if (!offered.ok) throw new Error("xAI OAuth credential discovery failed closed.");
    return finalize(resolveXaiUsageAuth(auth, model, salt, offered.candidates));
  }
  if (adapter.id === "deepseek") {
    const resolvedAuthorization = authorizationFrom(auth);
    const access = bearerToken(resolvedAuthorization);
    if (!access) throw new Error("DeepSeek API balance requires Bearer authentication.");
    const authorization = `Bearer ${access}`;
    const headers = { Authorization: authorization };
    return finalize({
      apiKey: access,
      headers,
      fingerprint: "",
      secrets: [
        access,
        auth.apiKey,
        headerValue(auth.headers, "Authorization"),
        resolvedAuthorization,
        authorization,
      ].filter((value): value is string => Boolean(value)),
      model,
    });
  }
  const authorization = authorizationFrom(auth);
  if (!authorization) return undefined;
  const headers = { Authorization: authorization };
  const secrets = [auth.apiKey, headerValue(auth.headers, "Authorization"), authorization].filter(
    (value): value is string => Boolean(value),
  );
  return finalize({
    apiKey: auth.apiKey,
    headers,
    fingerprint: "",
    secrets,
    model,
  });
}

export async function queryProviderUsage(
  adapter: UsageProviderAdapter,
  auth: ResolvedUsageAuth,
  signal: AbortSignal,
  timeoutMs: number,
  guard?: UsageRequestGuard,
  targetOrSettings?: string | Readonly<UsageQuerySettings>,
): Promise<UsageReport> {
  const startedAt = Date.now();
  let targetId =
    typeof targetOrSettings === "string"
      ? targetOrSettings
      : adapter.id === "fireworks"
        ? targetOrSettings?.fireworksAccountId
        : undefined;
  let resolvedLegacyFireworksTarget = false;
  try {
    if (adapter.id === "fireworks" && typeof targetOrSettings !== "string" && adapter.targets && guard) {
      const target = await resolveUsageTarget(
        adapter,
        auth,
        targetId,
        signal,
        remainingTimeout(timeoutMs, startedAt, "resolving the Fireworks account"),
        guard,
      );
      if (target.kind === "selection-required") {
        throw new Error("Fireworks account selection is required.");
      }
      targetId = target.targetId;
      resolvedLegacyFireworksTarget = true;
    }
    return await adapter.query(
      auth,
      signal,
      resolvedLegacyFireworksTarget
        ? remainingTimeout(timeoutMs, startedAt, `querying ${adapter.displayName} usage`)
        : timeoutMs,
      guard,
      targetId,
    );
  } catch (error) {
    if (isStaleExtensionContextError(error) || isAbortError(error)) throw error;
    throw new Error(redactUsageError(errorMessage(error), auth.secrets));
  }
}

export function providerIsConfigured(ctx: ExtensionContext, providerId: string): boolean {
  try {
    const status = ctx.modelRegistry.getProviderAuthStatus(providerId);
    return status.configured && moonshotProviderAuthSourceIsAllowed(ctx, providerId, status.source, status.label);
  } catch {
    return !isMoonshotSiblingProvider(ctx, providerId) && candidateModels(ctx, providerId).length > 0;
  }
}

function moonshotProviderAuthIsAllowed(ctx: ExtensionContext, providerId: string): boolean {
  if (!isMoonshotSiblingProvider(ctx, providerId)) return true;
  try {
    const status = ctx.modelRegistry.getProviderAuthStatus(providerId);
    return moonshotProviderAuthSourceIsAllowed(ctx, providerId, status.source, status.label);
  } catch {
    return false;
  }
}

function moonshotProviderAuthSourceIsAllowed(
  ctx: ExtensionContext,
  providerId: string,
  source: string | undefined,
  label: string | undefined,
): boolean {
  if (!isMoonshotSiblingProvider(ctx, providerId)) return true;
  if (source === undefined) return false;
  if (source !== "environment") return true;
  return (
    label !== undefined &&
    !label
      .split(",")
      .map((name) => name.trim())
      .includes(SHARED_MOONSHOT_ENV_VAR)
  );
}

function isMoonshotSiblingProvider(ctx: ExtensionContext, providerId: string): boolean {
  return (providerId === "moonshotai" || providerId === "moonshotai-cn") && ctx.model?.provider !== providerId;
}

function candidateModels(ctx: ExtensionContext, providerId: string): PiModel[] {
  const candidates: PiModel[] = [];
  const seen = new Set<string>();
  const add = (model: PiModel | undefined) => {
    if (!model || model.provider !== providerId) return;
    const key = `${model.provider}/${model.id}`;
    if (seen.has(key)) return;
    seen.add(key);
    candidates.push(model);
  };
  add(ctx.model);
  for (const model of ctx.modelRegistry.getAvailable()) add(model);
  for (const model of ctx.modelRegistry.getAll()) add(model);
  return candidates;
}

export async function fetchProviderJson(
  url: string,
  auth: ResolvedUsageAuth,
  signal: AbortSignal,
  timeoutMs: number,
  description: string,
  request: {
    method?: "GET" | "POST";
    body?: Record<string, unknown>;
    redirect?: RequestRedirect;
    userAgent?: boolean;
    responseError?: (status: number, text: string) => string | undefined;
  } = {},
): Promise<Record<string, unknown>> {
  const controller = new AbortController();
  let timedOut = false;
  const abortFromCaller = () => controller.abort();
  if (signal.aborted) controller.abort();
  else signal.addEventListener("abort", abortFromCaller, { once: true });
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  try {
    const headers = { ...auth.headers };
    if (request.userAgent !== false && !hasHeader(headers, "User-Agent")) {
      headers["User-Agent"] = "pi-usage";
    }
    if (request.body && !hasHeader(headers, "Content-Type")) {
      headers["Content-Type"] = "application/json";
    }
    const response = await fetch(url, {
      method: request.method ?? "GET",
      headers,
      ...(request.body ? { body: JSON.stringify(request.body) } : {}),
      ...(request.redirect ? { redirect: request.redirect } : {}),
      signal: controller.signal,
    });
    if (response.redirected) throw new Error(`${description} refused a redirected response.`);
    if (controller.signal.aborted) throw Object.assign(new Error("Usage query aborted."), { name: "AbortError" });
    const text = await readBoundedResponse(
      response,
      response.ok ? MAX_SUCCESS_BODY_BYTES : MAX_ERROR_BODY_BYTES,
      !response.ok,
      description,
      controller.signal,
    );
    if (controller.signal.aborted) throw Object.assign(new Error("Usage query aborted."), { name: "AbortError" });
    const responseError = request.responseError?.(response.status, text);
    if (responseError) throw new Error(responseError);
    if (!response.ok) {
      throw new Error(
        `${description} returned ${response.status} ${response.statusText}: ${redactUsageError(text, auth.secrets)}`,
      );
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text) as unknown;
    } catch (error) {
      throw new Error(`${description} returned invalid JSON: ${errorMessage(error)}`);
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error(`${description} response was not an object.`);
    }
    return parsed as Record<string, unknown>;
  } catch (error) {
    if (timedOut) {
      throw new Error(`Timed out after ${Math.round(timeoutMs / 1000)}s while fetching usage.`);
    }
    if (signal.aborted) throw Object.assign(new Error("Usage query aborted."), { name: "AbortError" });
    throw error;
  } finally {
    clearTimeout(timeout);
    signal.removeEventListener("abort", abortFromCaller);
  }
}

async function readBoundedResponse(
  response: Response,
  maxBytes: number,
  truncateOverflow: boolean,
  description: string,
  signal: AbortSignal,
): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  const abort = () => void reader.cancel().catch(() => undefined);
  if (signal.aborted) abort();
  else signal.addEventListener("abort", abort, { once: true });
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const remaining = maxBytes - total;
      if (value.byteLength > remaining) {
        if (remaining > 0) chunks.push(value.subarray(0, remaining));
        total = maxBytes;
        truncated = true;
        await reader.cancel();
        break;
      }
      chunks.push(value);
      total += value.byteLength;
    }
  } finally {
    signal.removeEventListener("abort", abort);
    reader.releaseLock();
  }
  if (truncated && !truncateOverflow) {
    throw new Error(`${description} response exceeded ${maxBytes} bytes.`);
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const text = new TextDecoder().decode(body);
  return truncated ? `${text}…` : text;
}

type RequestAuth = {
  apiKey?: string;
  headers?: Record<string, string | null>;
  baseUrl?: string;
  env?: Record<string, string>;
};

type StoredCredentialReader = (providerId: string) => unknown;

type UsageAuthRegistry = {
  getProvider?(providerId: string): { baseUrl?: string } | undefined;
  getApiKeyAndHeaders?(model: PiModel): Promise<({ ok: true } & RequestAuth) | { ok: false; error: string }>;
  getProviderAuth?(providerId: string): Promise<
    | {
        auth: RequestAuth;
        env?: Record<string, string>;
        source?: string;
      }
    | undefined
  >;
};

function resolveXaiUsageAuth(
  auth: RequestAuth,
  model: PiModel,
  salt: Uint8Array,
  candidates: readonly unknown[],
): ResolvedUsageAuth {
  const resolvedAccess = bearerToken(headerValue(auth.headers, "Authorization")) ?? auth.apiKey;
  if (!resolvedAccess) throw new Error("xAI runtime authentication was incomplete.");
  let sawOAuth = false;
  let sawMatchingAccess = false;
  let sawIncompleteMatch = false;
  const matches: Array<{ access: string; refresh: string }> = [];
  for (const candidate of candidates) {
    try {
      const credential = asObject(candidate);
      if (credential?.type !== "oauth") continue;
      sawOAuth = true;
      if (credential.access !== resolvedAccess) continue;
      sawMatchingAccess = true;
      if (
        typeof credential.access !== "string" ||
        !credential.access ||
        typeof credential.refresh !== "string" ||
        !credential.refresh ||
        typeof credential.expires !== "number" ||
        !Number.isFinite(credential.expires)
      ) {
        sawIncompleteMatch = true;
        continue;
      }
      matches.push({ access: credential.access, refresh: credential.refresh });
    } catch {
      // Malformed candidates never authorize a consumer-proxy request.
    }
  }
  if (sawIncompleteMatch) throw new Error("The matching xAI OAuth credential was incomplete.");
  if (matches.length > 1) {
    throw new Error("Multiple OAuth credentials match the active xAI runtime account.");
  }
  const match = matches[0];
  if (!match) {
    if (!sawOAuth) {
      throw new Error(
        "xAI consumer usage requires the OAuth subscription account configured through Pi /login; XAI_API_KEY users can review API spend at console.x.ai.",
      );
    }
    if (sawMatchingAccess) throw new Error("The matching xAI OAuth credential was incomplete.");
    throw new Error("The active xAI runtime account does not match Pi's stored OAuth account.");
  }
  const authorization = `Bearer ${match.access}`;
  const headers = { Authorization: authorization };
  return {
    apiKey: match.access,
    headers,
    fingerprint: fingerprintResolvedAuth({ headers }, salt),
    secrets: [
      match.access,
      match.refresh,
      resolvedAccess,
      auth.apiKey,
      headerValue(auth.headers, "Authorization"),
      authorization,
    ].filter((value): value is string => Boolean(value)),
    model,
  };
}

function resolveGitHubCopilotUsageAuth(
  auth: RequestAuth,
  model: PiModel,
  salt: Uint8Array,
  candidates: readonly unknown[],
  standaloneFallback: boolean,
): ResolvedUsageAuth {
  const resolvedAccess = bearerToken(headerValue(auth.headers, "Authorization")) ?? auth.apiKey;
  if (!resolvedAccess) throw new Error("GitHub Copilot OAuth credentials were incomplete.");
  let sawOAuth = false;
  let sawMatchingAccess = false;
  let sawIncompleteMatch = false;
  let sawEnterpriseMatch = false;
  const matches = new Map<string, { refresh: string; storedAccess: string }>();
  for (const candidate of candidates) {
    try {
      const credential = asObject(candidate);
      if (credential?.type !== "oauth") continue;
      sawOAuth = true;
      const storedAccess = typeof credential.access === "string" && credential.access ? credential.access : undefined;
      if (storedAccess !== resolvedAccess) continue;
      sawMatchingAccess = true;
      const enterpriseUrl = credential.enterpriseUrl;
      if (typeof enterpriseUrl === "string" && enterpriseUrl && !isPublicGitHubDomain(enterpriseUrl)) {
        sawEnterpriseMatch = true;
        continue;
      }
      const refresh = typeof credential.refresh === "string" && credential.refresh ? credential.refresh : undefined;
      if (!refresh) {
        sawIncompleteMatch = true;
        continue;
      }
      matches.set(`${storedAccess.length}:${storedAccess}${refresh}`, { refresh, storedAccess });
    } catch {
      // Malformed candidates never authorize a provider request.
    }
  }
  if (sawEnterpriseMatch) {
    throw new Error("GitHub Copilot usage does not yet support GitHub Enterprise accounts.");
  }
  if (sawIncompleteMatch) throw new Error("GitHub Copilot OAuth credentials were incomplete.");
  if (matches.size > 1) {
    throw new Error("Conflicting OAuth credentials match the active GitHub Copilot runtime account.");
  }
  const match = matches.values().next().value;
  if (!match) {
    if (!sawOAuth) {
      throw new Error(
        standaloneFallback
          ? "GitHub Copilot usage requires the OAuth account configured through Pi /login."
          : "GitHub Copilot usage requires an OAuth account configured through Pi /login or a compatible credential source.",
      );
    }
    if (sawMatchingAccess) throw new Error("GitHub Copilot OAuth credentials were incomplete.");
    throw new Error(
      standaloneFallback
        ? "The active GitHub Copilot runtime account does not match Pi's stored OAuth account."
        : "The active GitHub Copilot runtime account does not match any available OAuth account.",
    );
  }
  const { refresh, storedAccess } = match;
  const authorization = `Bearer ${refresh}`;
  const headers = {
    Authorization: authorization,
    "X-GitHub-Api-Version": "2025-05-01",
  };
  return {
    apiKey: refresh,
    headers,
    fingerprint: fingerprintResolvedAuth({ headers }, salt),
    secrets: [refresh, storedAccess, resolvedAccess, authorization],
    model,
  };
}

function authorizationFrom(auth: RequestAuth): string | undefined {
  return headerValue(auth.headers, "Authorization") ?? (auth.apiKey ? `Bearer ${auth.apiKey}` : undefined);
}

function bearerToken(authorization: string | undefined): string | undefined {
  const match = /^Bearer\s+(.+)$/iu.exec(authorization ?? "");
  return match?.[1];
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function isPublicGitHubDomain(value: string): boolean {
  try {
    const url = new URL(value.includes("://") ? value : `https://${value}`);
    return url.hostname.toLowerCase() === "github.com";
  } catch {
    return false;
  }
}

function hasOfficialOrigin(model: PiModel, providerId: string): boolean {
  return hasOfficialUrlOrigin(model.baseUrl, providerId);
}

function hasOfficialUrlOrigin(value: string, providerId: string): boolean {
  try {
    const url = new URL(value);
    if (providerId === "baseten") {
      return ["https://inference.baseten.co", "https://api.baseten.co"].includes(url.origin);
    }
    if (providerId === "openai-codex") return url.origin === "https://chatgpt.com";
    if (providerId === "deepseek") return url.origin === "https://api.deepseek.com";
    if (providerId === "fireworks") return url.origin === "https://api.fireworks.ai";
    if (providerId === "openrouter") return url.origin === "https://openrouter.ai";
    if (providerId === "vercel-ai-gateway") return url.origin === "https://ai-gateway.vercel.sh";
    if (providerId === "opencode-go") return url.origin === "https://opencode.ai";
    if (providerId === "kimi-coding") return url.origin === "https://api.kimi.com";
    if (providerId === "minimax") return url.origin === "https://api.minimax.io";
    if (providerId === "minimax-cn") return url.origin === "https://api.minimaxi.com";
    if (providerId === "moonshotai") return url.origin === "https://api.moonshot.ai";
    if (providerId === "moonshotai-cn") return url.origin === "https://api.moonshot.cn";
    if (providerId === "xai") return url.origin === "https://api.x.ai";
    if (providerId === "zai") return url.origin === "https://api.z.ai";
    if (providerId === "zai-coding-cn") return url.origin === "https://open.bigmodel.cn";
    if (providerId === "github-copilot") {
      return url.protocol === "https:" && /^api\.[a-z0-9-]+\.githubcopilot\.com$/u.test(url.hostname);
    }
    return false;
  } catch {
    return false;
  }
}

function headerValue(headers: Record<string, string | null> | undefined, name: string): string | undefined {
  const entry = Object.entries(headers ?? {}).find(([candidate]) => candidate.toLowerCase() === name.toLowerCase());
  return entry?.[1] ?? undefined;
}

function hasHeader(headers: Record<string, string>, name: string): boolean {
  return Object.keys(headers).some((key) => key.toLowerCase() === name.toLowerCase());
}

function validatedXaiUserId(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9._~-]{1,128}$/u.test(value)) {
    throw new Error("xAI consumer identity returned an unsafe canonical user ID.");
  }
  return value;
}

function basetenBillingUsageUrl(windowAt: number): string {
  const url = new URL(BASETEN_BILLING_USAGE_URL);
  url.searchParams.set(
    "start_date",
    new Date(windowAt - BASETEN_USAGE_WINDOW_DAYS * 24 * 60 * 60 * 1_000).toISOString(),
  );
  url.searchParams.set("end_date", new Date(windowAt).toISOString());
  return url.toString();
}

async function queryMiniMaxUsage(
  providerId: MiniMaxProviderId,
  auth: ResolvedUsageAuth,
  signal: AbortSignal,
  timeoutMs: number,
  guard: UsageRequestGuard | undefined,
): Promise<UsageReport> {
  if (!guard) throw new Error("MiniMax usage requires request-boundary revalidation.");
  const apiKey = bearerToken(headerValue(auth.headers, "Authorization")) ?? auth.apiKey;
  if (!apiKey) throw new Error("MiniMax runtime API key was unavailable.");
  const kind = miniMaxUsageKind(apiKey);
  const path = kind === "account-balance" ? "/account/query_balance" : "/v1/token_plan/remains";
  const startedAt = Date.now();
  await guard();
  const payload = (await fetchProviderJson(
    `${MINIMAX_API_ROOTS[providerId]}${path}`,
    auth,
    signal,
    remainingTimeout(timeoutMs, startedAt, "fetching MiniMax usage"),
    "MiniMax usage endpoint",
    { redirect: "error" },
  )) as MiniMaxUsagePayload;
  await guard();
  return normalizeMiniMaxUsagePayload(providerId, kind, payload, Date.now());
}

async function queryMoonshotBalance(
  providerId: "moonshotai" | "moonshotai-cn",
  auth: ResolvedUsageAuth,
  signal: AbortSignal,
  timeoutMs: number,
  guard: UsageRequestGuard | undefined,
): Promise<UsageReport> {
  if (!guard) throw new Error("Moonshot AI balance requires request-boundary revalidation.");
  const startedAt = Date.now();
  await guard();
  const payload = (await fetchProviderJson(
    MOONSHOT_BALANCE_URLS[providerId],
    auth,
    signal,
    remainingTimeout(timeoutMs, startedAt, "fetching Moonshot AI balance"),
    "Moonshot AI balance endpoint",
    { redirect: "error" },
  )) as MoonshotBalancePayload;
  await guard();
  return normalizeMoonshotBalancePayload(providerId, payload, Date.now());
}

function remainingTimeout(timeoutMs: number, startedAt: number, description = "fetching xAI consumer usage"): number {
  const remaining = timeoutMs - (Date.now() - startedAt);
  if (remaining <= 0) throw new Error(`Timed out while ${description}.`);
  return remaining;
}

function zaiOrigin(baseUrl: string | undefined): string {
  const base = baseUrl?.trim();
  if (!base) throw new Error("Z.AI model base URL is unavailable.");
  return new URL(base).origin;
}

function zaiMonitorUrl(baseUrl: string | undefined): string {
  return `${zaiOrigin(baseUrl)}/api/monitor/usage/quota/limit`;
}

function zaiMonitorAuth(auth: ResolvedUsageAuth): ResolvedUsageAuth {
  const authorization = headerValue(auth.headers, "Authorization");
  const token = authorization === undefined ? undefined : (bearerToken(authorization) ?? authorization);
  if (token === undefined || token === authorization) return auth;
  return { ...auth, headers: { ...auth.headers, Authorization: token } };
}

async function queryZaiUsage(
  providerId: "zai" | "zai-coding-cn",
  providerName: string,
  auth: ResolvedUsageAuth,
  signal: AbortSignal,
  timeoutMs: number,
  guard: UsageRequestGuard | undefined,
): Promise<UsageReport> {
  if (!guard) throw new Error("Z.AI usage requires request-boundary revalidation.");
  const startedAt = Date.now();
  await guard();
  const payload = (await fetchProviderJson(
    zaiMonitorUrl(auth.model.baseUrl),
    zaiMonitorAuth(auth),
    signal,
    remainingTimeout(timeoutMs, startedAt, `fetching ${providerName} quota`),
    `${providerName} quota endpoint`,
    { responseError: zaiResponseError },
  )) as ZaiQuotaPayload;
  await guard();
  const planTimeoutMs = timeoutMs - (Date.now() - startedAt);
  const plan = await fetchZaiPlan(providerName, auth, signal, planTimeoutMs);
  return normalizeZaiQuotaPayload(providerId, providerName, payload, Date.now(), plan);
}

// The subscription endpoint is undocumented and may not exist on every official origin. It only
// contributes the plan name and renewal date, so any non-abort failure is swallowed instead of
// blanking the required quota report.
async function fetchZaiPlan(
  providerName: string,
  auth: ResolvedUsageAuth,
  signal: AbortSignal,
  timeoutMs: number,
): Promise<ZaiPlanInfo | undefined> {
  if (timeoutMs <= 0 || signal.aborted) return undefined;
  try {
    const payload = (await fetchProviderJson(
      `${zaiOrigin(auth.model.baseUrl)}/api/biz/subscription/list`,
      zaiMonitorAuth(auth),
      signal,
      timeoutMs,
      `${providerName} plan endpoint`,
      { responseError: zaiResponseError },
    )) as ZaiSubscriptionPayload;
    return normalizeZaiSubscriptionPayload(payload);
  } catch (error) {
    if (isAbortError(error)) throw error;
    return undefined;
  }
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}
