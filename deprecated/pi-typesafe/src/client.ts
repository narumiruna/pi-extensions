import { stripVTControlCharacters } from "node:util";
import type { Usage } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize, truncateHead } from "@earendil-works/pi-coding-agent";
import {
  APIError,
  type Questions,
  type SystemOneRequest,
  TypeSafeClient,
  type Fetch as TypeSafeFetch,
} from "@typesafe-ai/sdk";
import type { JevDecisionInput, JevDecisionResponse, JevUsage } from "./types.js";
import { normalizeJevResponse } from "./validation.js";

export const TYPESAFE_ENDPOINT = "https://api.typesafe.ai/v1/systemone";
export const TYPESAFE_MODEL = "jev-latest";
export const OPENROUTER_ENDPOINT = "https://openrouter.ai/api/alpha/decisions";
export const OPENROUTER_MODEL = "~typesafe/jev-latest";
const OPENROUTER_ORIGIN = "https://openrouter.ai";
const MAX_REQUEST_BYTES = 1024 * 1024;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const MAX_ERROR_BYTES = 2048;
const TYPESAFE_TIMEOUT_MS = 10_000;

export interface JevProvider {
  name: "TypeSafe" | "OpenRouter";
  endpoint: string;
  model: string;
  authorization: string;
  secrets: string[];
}

export interface JevResultDetails {
  truncated: boolean;
  truncatedBy?: "lines" | "bytes";
  totalLines: number;
  totalBytes: number;
  outputLines: number;
  outputBytes: number;
}

export async function resolveJevProvider(
  ctx: Pick<ExtensionContext, "modelRegistry">,
  env: Readonly<Record<string, string | undefined>> = process.env,
  openRouterFallback = false,
): Promise<JevProvider> {
  const typeSafeApiKey = env.TYPESAFE_API_KEY?.trim();
  if (typeSafeApiKey) {
    if (/\s/u.test(typeSafeApiKey)) {
      throw new Error("TYPESAFE_API_KEY must not contain whitespace.");
    }
    const authorization = `Bearer ${typeSafeApiKey}`;
    return {
      name: "TypeSafe",
      endpoint: TYPESAFE_ENDPOINT,
      model: TYPESAFE_MODEL,
      authorization,
      secrets: [typeSafeApiKey, authorization],
    };
  }

  if (!openRouterFallback) {
    throw new Error(
      'TypeSafe authentication is not configured. Set TYPESAFE_API_KEY, or set "openRouterFallback": true in pi-typesafe.json.',
    );
  }

  const result = await ctx.modelRegistry.getProviderAuth("openrouter");
  if (!result) {
    throw new Error(
      `The experimental OpenRouter fallback is enabled, but OpenRouter authentication is not configured. Run /login openrouter or set OPENROUTER_API_KEY.`,
    );
  }

  assertOfficialOpenRouterUrl(result.auth.baseUrl, "resolved OpenRouter authentication");
  const configuredProvider = ctx.modelRegistry.getProvider("openrouter");
  assertOfficialOpenRouterUrl(configuredProvider?.baseUrl, "configured OpenRouter provider");

  const configuredHeader = headerValue(result.auth.headers, "authorization")?.trim();
  const apiKey = result.auth.apiKey?.trim();
  const authorization = configuredHeader || (apiKey ? `Bearer ${apiKey}` : undefined);
  if (!authorization || !/^Bearer\s+\S+$/iu.test(authorization)) {
    throw new Error("OpenRouter authentication did not resolve to a Bearer credential.");
  }

  const token = authorization.replace(/^Bearer\s+/iu, "");
  return {
    name: "OpenRouter",
    endpoint: OPENROUTER_ENDPOINT,
    model: OPENROUTER_MODEL,
    authorization,
    secrets: [...new Set([apiKey, configuredHeader, authorization, token].filter(isNonEmptyString))],
  };
}

export async function requestJevDecision(
  input: JevDecisionInput,
  provider: JevProvider,
  signal: AbortSignal | undefined,
  fetchImpl: typeof fetch = fetch,
): Promise<JevDecisionResponse> {
  const request = {
    model: provider.model,
    state: input.state,
    questions: input.questions,
  };
  const body = JSON.stringify(request);
  if (Buffer.byteLength(body, "utf8") > MAX_REQUEST_BYTES) {
    throw new Error(`Jev request exceeds the ${formatSize(MAX_REQUEST_BYTES)} request limit.`);
  }

  if (provider.name === "TypeSafe") {
    return requestOfficialTypeSafeDecision(input, provider, request, signal, fetchImpl);
  }
  return requestOpenRouterDecision(input, provider, body, signal, fetchImpl);
}

async function requestOfficialTypeSafeDecision(
  input: JevDecisionInput,
  provider: JevProvider,
  request: { model: string; state: JevDecisionInput["state"]; questions: JevDecisionInput["questions"] },
  signal: AbortSignal | undefined,
  fetchImpl: typeof fetch,
): Promise<JevDecisionResponse> {
  const sdkFetch: TypeSafeFetch = async (url, init) => {
    const response = await fetchImpl(url, init);
    const responseText = await readBoundedResponseText(response, init?.signal ?? undefined, provider.name);
    const headers = new Headers(response.headers);
    headers.delete("content-encoding");
    headers.delete("content-length");
    const body = response.status === 204 || response.status === 205 || response.status === 304 ? null : responseText;
    return new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  };
  const client = new TypeSafeClient({
    apiKey: provider.authorization.replace(/^Bearer\s+/u, ""),
    baseURL: new URL(provider.endpoint).origin,
    defaultModel: provider.model,
    fetch: sdkFetch,
    logLevel: "off",
    retry: { maxRetries: 0 },
    timeout: TYPESAFE_TIMEOUT_MS,
  });
  const sdkRequest: SystemOneRequest<Questions> = {
    ...request,
    questions: request.questions as Questions,
  };

  let payload: unknown;
  try {
    payload = await client.systemOne(sdkRequest, { signal });
    signal?.throwIfAborted();
  } catch (error) {
    if (signal?.aborted) signal.throwIfAborted();
    if (error instanceof APIError) {
      const detail = formatErrorPayload(error.body, provider.secrets);
      throw new Error(`${provider.name} Jev request failed (${error.status})${detail ? `: ${detail}` : ""}`);
    }
    const detail = sanitizeErrorText(errorMessage(error), provider.secrets);
    throw new Error(`${provider.name} Jev request failed${detail ? `: ${detail}` : "."}`);
  }

  if (typeof payload === "string") {
    throw new Error(`${provider.name} Jev returned a non-JSON response.`);
  }
  try {
    return normalizeJevResponse(payload, input);
  } catch (error) {
    throw new Error(`${provider.name} Jev returned an invalid response: ${errorMessage(error)}`);
  }
}

async function requestOpenRouterDecision(
  input: JevDecisionInput,
  provider: JevProvider,
  body: string,
  signal: AbortSignal | undefined,
  fetchImpl: typeof fetch,
): Promise<JevDecisionResponse> {
  const response = await fetchImpl(provider.endpoint, {
    method: "POST",
    headers: {
      Authorization: provider.authorization,
      "Content-Type": "application/json",
    },
    body,
    signal,
  });
  const responseText = await readBoundedResponseText(response, signal, provider.name);
  if (!response.ok) {
    const detail = formatErrorDetail(responseText, provider.secrets);
    throw new Error(`${provider.name} Jev request failed (${response.status})${detail ? `: ${detail}` : ""}`);
  }

  let payload: unknown;
  try {
    payload = JSON.parse(responseText) as unknown;
  } catch {
    throw new Error(`${provider.name} Jev returned a non-JSON response.`);
  }
  try {
    return normalizeJevResponse(payload, input);
  } catch (error) {
    throw new Error(`${provider.name} Jev returned an invalid response: ${errorMessage(error)}`);
  }
}

export function formatJevResult(response: JevDecisionResponse) {
  const serialized = escapeTerminalControls(JSON.stringify(response, null, 2));
  const usage = response.usage ? toToolUsage(response.usage) : undefined;
  const initial = truncateHead(serialized, {
    maxBytes: DEFAULT_MAX_BYTES,
    maxLines: DEFAULT_MAX_LINES,
  });
  if (!initial.truncated) {
    return {
      content: [{ type: "text" as const, text: initial.content }],
      details: resultDetails(initial, false),
      ...(usage ? { usage } : {}),
    };
  }

  let byteBudget = DEFAULT_MAX_BYTES;
  let lineBudget = DEFAULT_MAX_LINES;
  for (;;) {
    const excerpt = truncateHead(serialized, { maxBytes: byteBudget, maxLines: lineBudget });
    const footer = `[Jev output truncated: showing ${excerpt.outputLines} of ${excerpt.totalLines} lines (${formatSize(excerpt.outputBytes)} of ${formatSize(excerpt.totalBytes)}). Ask fewer questions or use fewer choice options.]`;
    const separator = excerpt.content ? "\n\n" : "";
    const text = `${excerpt.content}${separator}${footer}`;
    if (Buffer.byteLength(text, "utf8") <= DEFAULT_MAX_BYTES && countLines(text) <= DEFAULT_MAX_LINES) {
      return {
        content: [{ type: "text" as const, text }],
        details: resultDetails(excerpt, true),
        ...(usage ? { usage } : {}),
      };
    }
    const nextByteBudget = Math.max(0, DEFAULT_MAX_BYTES - Buffer.byteLength(footer, "utf8") - 2);
    const nextLineBudget = Math.max(0, DEFAULT_MAX_LINES - countLines(footer) - 1);
    if (nextByteBudget === byteBudget && nextLineBudget === lineBudget) {
      throw new Error("Could not fit the Jev truncation notice within Pi's tool output limits.");
    }
    byteBudget = Math.min(byteBudget, nextByteBudget);
    lineBudget = Math.min(lineBudget, nextLineBudget);
  }
}

export function formatJevToolError(error: unknown): Error {
  const message = sanitizeErrorText(errorMessage(error), []);
  return new Error(message || "Jev request failed.");
}

function resultDetails(
  truncation: {
    truncatedBy?: "lines" | "bytes" | null;
    totalLines: number;
    totalBytes: number;
    outputLines: number;
    outputBytes: number;
  },
  truncated: boolean,
): JevResultDetails {
  return {
    truncated,
    ...(truncation.truncatedBy ? { truncatedBy: truncation.truncatedBy } : {}),
    totalLines: truncation.totalLines,
    totalBytes: truncation.totalBytes,
    outputLines: truncation.outputLines,
    outputBytes: truncation.outputBytes,
  };
}

async function readBoundedResponseText(
  response: Response,
  signal: AbortSignal | undefined,
  providerName: JevProvider["name"],
): Promise<string> {
  if (signal?.aborted) {
    await cancelResponseBody(response, signal.reason);
    signal.throwIfAborted();
  }

  const contentLength = response.headers.get("content-length");
  if (contentLength && /^\d+$/u.test(contentLength) && Number(contentLength) > MAX_RESPONSE_BYTES) {
    await cancelResponseBody(response);
    throw new Error(`${providerName} Jev response exceeds the ${formatSize(MAX_RESPONSE_BYTES)} response limit.`);
  }
  if (!response.body) return "";

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = "";
  const abortReader = () => {
    void reader.cancel(signal?.reason).catch(() => {});
  };
  signal?.addEventListener("abort", abortReader, { once: true });

  try {
    signal?.throwIfAborted();
    for (;;) {
      const { done, value } = await reader.read();
      signal?.throwIfAborted();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) {
        await reader.cancel().catch(() => {});
        throw new Error(`${providerName} Jev response exceeds the ${formatSize(MAX_RESPONSE_BYTES)} response limit.`);
      }
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } catch (error) {
    if (signal?.aborted) await reader.cancel(signal.reason).catch(() => {});
    throw error;
  } finally {
    signal?.removeEventListener("abort", abortReader);
    reader.releaseLock();
  }
}

async function cancelResponseBody(response: Response, reason?: unknown): Promise<void> {
  await response.body?.cancel(reason).catch(() => {});
}

function toToolUsage(usage: JevUsage): Usage {
  return {
    input: usage.input_tokens,
    output: usage.output_tokens,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: usage.input_tokens + usage.output_tokens,
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      total: usage.cost ?? 0,
    },
  };
}

function formatErrorDetail(responseText: string, secrets: readonly string[]): string {
  if (!responseText) return "";
  try {
    return formatErrorPayload(JSON.parse(responseText) as unknown, secrets);
  } catch {
    return sanitizeErrorText(responseText, secrets);
  }
}

function formatErrorPayload(payload: unknown, secrets: readonly string[]): string {
  let value: string;
  if (isRecord(payload) && typeof payload.error === "string") value = payload.error;
  else if (isRecord(payload) && isRecord(payload.error) && typeof payload.error.message === "string") {
    value = payload.error.message;
  } else if (isRecord(payload) && typeof payload.message === "string") value = payload.message;
  else if (typeof payload === "string") value = payload;
  else {
    try {
      value = JSON.stringify(payload) ?? String(payload);
    } catch {
      value = String(payload);
    }
  }
  return sanitizeErrorText(value, secrets);
}

function sanitizeErrorText(value: string, secrets: readonly string[]): string {
  for (const secret of [...secrets].sort((left, right) => right.length - left.length)) {
    value = value.replaceAll(secret, "[redacted]");
  }
  const safe = escapeTerminalControls(stripControlCharacters(stripVTControlCharacters(value)))
    .replace(/\s+/gu, " ")
    .trim();
  return truncateHead(safe, { maxBytes: MAX_ERROR_BYTES, maxLines: 1 }).content;
}

function escapeTerminalControls(value: string): string {
  let escaped = "";
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (
      (code >= 0x7f && code <= 0x9f) ||
      code === 0x061c ||
      code === 0x200e ||
      code === 0x200f ||
      (code >= 0x2028 && code <= 0x202e) ||
      (code >= 0x2066 && code <= 0x2069)
    ) {
      escaped += `\\u${code.toString(16).padStart(4, "0")}`;
    } else {
      escaped += character;
    }
  }
  return escaped;
}

function stripControlCharacters(value: string): string {
  let safe = "";
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    safe += code <= 0x08 || (code >= 0x0b && code <= 0x1f) || (code >= 0x7f && code <= 0x9f) ? " " : character;
  }
  return safe;
}

function assertOfficialOpenRouterUrl(value: string | undefined, source: string): void {
  if (!value) return;
  let origin: string;
  try {
    origin = new URL(value).origin;
  } catch {
    throw new Error(`The ${source} has an invalid base URL.`);
  }
  if (origin !== OPENROUTER_ORIGIN) {
    throw new Error(`The ${source} uses a proxy base URL; refusing to send that credential to OpenRouter.`);
  }
}

function headerValue(headers: Record<string, string | null> | undefined, name: string): string | undefined {
  if (!headers) return undefined;
  const entry = Object.entries(headers).find(([key]) => key.toLowerCase() === name.toLowerCase());
  return typeof entry?.[1] === "string" ? entry[1] : undefined;
}

function countLines(content: string): number {
  if (!content) return 0;
  const lines = content.split("\n");
  if (content.endsWith("\n")) lines.pop();
  return lines.length;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isNonEmptyString(value: string | undefined): value is string {
  return typeof value === "string" && value.length > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
