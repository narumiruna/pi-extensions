import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { boundResponseText, formatJsonResult } from "./response-format.js";

const DEFAULT_API_URL = "https://api.firecrawl.dev/v1";
const STATUS_KEY = "firecrawl";

let apiUrl = normalizeApiUrl(process.env.FIRECRAWL_API_URL ?? process.env.FIRECRAWL_BASE_URL);

export function configuredApiUrl() {
  return apiUrl;
}

export function resetConfiguredApiUrl() {
  apiUrl = normalizeApiUrl(process.env.FIRECRAWL_API_URL ?? process.env.FIRECRAWL_BASE_URL);
}

export async function firecrawlRequest(
  method: "GET" | "POST",
  path: string,
  body: unknown,
  signal: AbortSignal | undefined,
  artifactOwner: object,
) {
  const apiKey = getApiKey();
  const response = await fetch(`${apiUrl}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal,
  });
  const responseText = await response.text();
  const payload = parseResponseBody(responseText);
  if (!response.ok) {
    const prefix = `Firecrawl ${method} ${path} failed (${response.status}): `;
    const bounded = await boundResponseText(`${prefix}${formatPayload(payload)}`, artifactOwner, {
      artifactText: responseText,
      artifactExtension: "txt",
    });
    throw new Error(bounded.text);
  }
  return payload;
}

export function getApiKey() {
  const apiKey = process.env.FIRECRAWL_API_KEY?.trim();
  if (!apiKey) {
    throw new Error("FIRECRAWL_API_KEY is not configured. Set it in your shell or Pi environment, then retry once.");
  }
  return apiKey;
}

export function hasApiKey() {
  return Boolean(process.env.FIRECRAWL_API_KEY?.trim());
}

export function normalizeApiUrl(value: string | undefined) {
  return (value?.trim() || DEFAULT_API_URL).replace(/\/+$/, "");
}

export function parseResponseBody(responseText: string) {
  if (!responseText) return {};
  try {
    return JSON.parse(responseText) as unknown;
  } catch {
    return responseText;
  }
}

export function formatPayload(payload: unknown) {
  return typeof payload === "string" ? payload : (JSON.stringify(payload) ?? String(payload));
}

export function jsonResult(payload: unknown, artifactOwner: object) {
  return formatJsonResult(payload, artifactOwner);
}

export async function withStatus<T>(ctx: Pick<ExtensionContext, "ui">, status: string, callback: () => Promise<T>) {
  ctx.ui.setStatus(STATUS_KEY, status);
  try {
    return await callback();
  } finally {
    ctx.ui.setStatus(STATUS_KEY, undefined);
  }
}

export function cleanObject<T>(value: T): T {
  if (Array.isArray(value)) return value.map(cleanObject) as T;
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .map(([key, item]) => [key, cleanObject(item)]),
  ) as T;
}
