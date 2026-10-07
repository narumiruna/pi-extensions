import { stripVTControlCharacters } from "node:util";
import { Type } from "@earendil-works/pi-ai";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, truncateHead } from "@earendil-works/pi-coding-agent";
import { isObject, type Settings } from "./settings.js";

class SearchError extends Error {}

export const outputSchema = Type.Object({
  provider: Type.Literal("ceramic"),
  items: Type.Array(
    Type.Object({ url: Type.String(), title: Type.Optional(Type.String()), description: Type.Optional(Type.String()) }),
  ),
  metadata: Type.Object({
    query: Type.String(),
    requestId: Type.Optional(Type.String()),
    latencyMs: Type.Optional(Type.Number()),
  }),
  truncated: Type.Boolean(),
});
export interface SearchResult {
  provider: "ceramic";
  items: { url: string; title?: string; description?: string }[];
  metadata: { query: string; requestId?: string; latencyMs?: number };
  truncated: boolean;
}

// Sanitization is only for terminal presentation, never the request or raw structured data.
export function displayText(value: string): string {
  return Array.from(stripVTControlCharacters(value), (char) => {
    const code = char.charCodeAt(0);
    // Directional formatting can spoof adjacent terminal text. Keep legitimate
    // Unicode joiners (ZWJ/ZWNJ), and leave the request/structured payload intact.
    return code < 32 || (code >= 127 && code <= 159) || /\p{Bidi_Control}/u.test(char) ? " " : char;
  }).join("");
}
function bounded(value: string, maxBytes: number): string {
  let result = "";
  let bytes = 2; // JSON quotes; account for escaping in the structured output budget.
  for (const char of value) {
    const length = Buffer.byteLength(JSON.stringify(char)) - 2;
    if (bytes + length > maxBytes) break;
    result += char;
    bytes += length;
  }
  return result;
}
export function validateQuery(query: string, limit: number) {
  if (typeof query !== "string" || !query.trim() || Array.from(query).length > 1024)
    throw new SearchError("Search query must contain 1–1024 characters and not be blank.");
  if (!Number.isInteger(limit) || limit < 1 || limit > 10)
    throw new SearchError("Search limit must be an integer from 1 to 10.");
}

export async function search(
  settings: Settings,
  query: string,
  limit: number,
  signal: AbortSignal,
  request: typeof fetch = fetch,
): Promise<SearchResult> {
  validateQuery(query, limit);
  if (!settings.accountId || !settings.apiToken)
    throw new SearchError("Configure accountId and apiToken in pi-web-search.json before searching.");
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) abort();
  const timer = setTimeout(abort, settings.timeoutMs);
  const safe = (text: string) => text.replaceAll(settings.apiToken, "[redacted]");
  try {
    controller.signal.throwIfAborted();
    const response = await request(
      `https://api.cloudflare.com/client/v4/accounts/${settings.accountId}/ai/websearch/`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${settings.apiToken}`, "Content-Type": "application/json" },
        redirect: "error",
        signal: controller.signal,
        body: JSON.stringify({
          query,
          provider: "ceramic",
          limit,
          options: { gateway: { id: settings.gatewayId } },
          ...(settings.byokAlias ? { byokAlias: settings.byokAlias } : {}),
        }),
      },
    );
    controller.signal.throwIfAborted();
    if (!response.ok) {
      await response.body?.cancel();
      throw new SearchError(
        `Cloudflare Web Search failed (HTTP ${response.status}); check account access, gateway credits or BYOK configuration. No fallback was attempted.`,
      );
    }
    const reader = response.body?.getReader();
    if (!reader) throw new SearchError("Invalid Cloudflare Web Search response.");
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        controller.signal.throwIfAborted();
        if (done) break;
        size += value.length;
        if (size > 1024 * 1024) throw new SearchError("Cloudflare Web Search response exceeds 1 MB.");
        chunks.push(value);
      }
    } finally {
      await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
    let data: unknown;
    try {
      data = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
    } catch {
      throw new SearchError("Invalid Cloudflare Web Search response JSON.");
    }
    if (!isObject(data) || !Array.isArray(data.items) || !isObject(data.metadata))
      throw new SearchError("Invalid Cloudflare Web Search response.");
    const redactedQuery = safe(query);
    const returnedQuery = bounded(redactedQuery, 4096);
    const result: SearchResult = {
      provider: "ceramic",
      items: [],
      metadata: { query: returnedQuery },
      truncated: data.items.length > limit || returnedQuery !== redactedQuery,
    };
    for (const item of data.items) {
      if (
        !isObject(item) ||
        typeof item.url !== "string" ||
        (item.title !== undefined && typeof item.title !== "string") ||
        (item.description !== undefined && typeof item.description !== "string")
      )
        throw new SearchError("Invalid Cloudflare Web Search result fields.");
      let url: URL;
      try {
        url = new URL(item.url);
      } catch {
        throw new SearchError("Invalid Cloudflare Web Search result URL.");
      }
      if (
        !["https:", "http:"].includes(url.protocol) ||
        Array.from(item.url).some((char) => {
          const code = char.charCodeAt(0);
          return code <= 32 || (code >= 127 && code <= 159);
        }) ||
        Buffer.byteLength(JSON.stringify(item.url)) > 2048
      )
        throw new SearchError("Invalid Cloudflare Web Search result URL.");
      if (result.items.length >= limit) continue;
      const redactedUrl = safe(item.url);
      if (Buffer.byteLength(JSON.stringify(redactedUrl)) > 2048)
        throw new SearchError("Invalid Cloudflare Web Search result URL after credential redaction.");
      const next: SearchResult["items"][number] = { url: redactedUrl };
      for (const key of ["title", "description"] as const) {
        if (typeof item[key] === "string") {
          next[key] = bounded(safe(item[key]), key === "title" ? 512 : 2000);
          if (next[key] !== safe(item[key])) result.truncated = true;
        }
      }
      result.items.push(next);
    }
    if (data.metadata.requestId !== undefined) {
      if (typeof data.metadata.requestId !== "string") throw new SearchError("Invalid Cloudflare Web Search metadata.");
      const requestId = safe(data.metadata.requestId);
      result.metadata.requestId = bounded(requestId, 256);
      if (result.metadata.requestId !== requestId) result.truncated = true;
    }
    if (data.metadata.latencyMs !== undefined) {
      if (
        typeof data.metadata.latencyMs !== "number" ||
        !Number.isFinite(data.metadata.latencyMs) ||
        data.metadata.latencyMs < 0
      )
        throw new SearchError("Invalid Cloudflare Web Search metadata.");
      result.metadata.latencyMs = data.metadata.latencyMs;
    }
    controller.signal.throwIfAborted();
    return result;
  } catch (error) {
    if (controller.signal.aborted) throw new Error(signal.aborted ? "Web search cancelled." : "Web search timed out.");
    // Only our fixed diagnostics escape; never echo transport errors or remote bodies.
    if (error instanceof SearchError) throw error;
    throw new SearchError("Cloudflare Web Search request failed; check network access and settings.");
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", abort);
  }
}

export function resultText(result: SearchResult): string {
  const lines = ["Cloudflare Web Search / Ceramic.ai", `Query: ${displayText(result.metadata.query)}`];
  result.items.forEach((item, index) => {
    lines.push(`${index + 1}. ${displayText(item.title ?? item.url)}`);
    // A missing title already displays the URL; do not double its text budget.
    if (item.title !== undefined) lines.push(displayText(item.url));
    lines.push(displayText(item.description ?? ""));
  });
  if (!result.items.length) lines.push("No results.");
  if (result.truncated) lines.push("Result fields were truncated to fit output limits.");
  const text = lines.join("\n");
  const output = truncateHead(text);
  if (!output.truncated) return output.content;
  const notice = "Rendered results were truncated to fit output limits; some text or results were omitted.";
  const bounded = truncateHead(text, {
    maxBytes: DEFAULT_MAX_BYTES - Buffer.byteLength(notice) - 1,
    maxLines: DEFAULT_MAX_LINES - 1,
  });
  return `${bounded.content}\n${notice}`;
}
