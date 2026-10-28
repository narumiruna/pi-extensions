import type { DeliveryResult } from "../provider.js";

const TIMEOUT_MS = 10_000;
const MAX_RESPONSE_BYTES = 65_536;

/** Explicit HTTP(S) endpoints may reach local networks; never accept URL credentials or query auth. */
export function normalizeHttpUrl(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > 2048 || /[\s\\?#\p{Cc}]/u.test(value)) return undefined;
  if (!/^https?:\/\/[^/@]+(?:\/|$)/i.test(value)) return undefined;
  try {
    // Reject encoded controls, backslashes, and malformed percent escapes before URL parsing.
    if (/[\\\p{Cc}]/u.test(decodeURIComponent(value))) return undefined;
    const raw = /^https?:\/\/([^/]+)(\/.*)?$/i.exec(value);
    if (
      !raw ||
      decodeURIComponent(raw[2] ?? "")
        .split("/")
        .some((part) => part === "." || part === "..")
    )
      return undefined;
    const url = new URL(value);
    if (url.username || url.password || !url.hostname) return undefined;
    // WHATWG rewrites numeric IPv4 aliases (hex, octal, shortened, or integer) to a different host spelling.
    // Accept explicit private addresses, but require canonical dotted-decimal IPv4 input.
    const rawHost = raw[1]?.split(":")[0];
    if (/^(?:\d{1,3}\.){3}\d{1,3}$/.test(url.hostname) && rawHost !== url.hostname) return undefined;
    const normalized = url.href.replace(/\/+$/, "");
    return normalized.length <= 2048 ? normalized : undefined;
  } catch {
    return undefined;
  }
}

/** Keep complete Unicode code points within a UTF-8 byte budget. */
export function truncateUtf8(value: string, maxBytes: number): string {
  let bytes = 0;
  let result = "";
  for (const point of value) {
    bytes += Buffer.byteLength(point, "utf8");
    if (bytes > maxBytes) break;
    result += point;
  }
  return result;
}

/** POST once. A response is transport acceptance only; the provider checks its service contract. */
export async function postJson(
  url: string,
  payload: unknown,
  signal: AbortSignal,
  fetcher: typeof fetch = fetch,
  headers: Record<string, string> = {},
): Promise<{ state: "response"; body: unknown; status: number } | DeliveryResult> {
  if (signal.aborted) return { state: "cancelled", code: "cancelled" };
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(), TIMEOUT_MS);
  const combined = AbortSignal.any([signal, timeout.signal]);
  let rejectAbort!: (reason: unknown) => void;
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectAbort = reject;
  });
  const onAbort = () => rejectAbort(combined.reason);
  combined.addEventListener("abort", onAbort, { once: true });
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    const fetching = fetcher(url, {
      method: "POST",
      redirect: "error",
      signal: combined,
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(payload),
    }).then((response) => {
      // An injected fetch can ignore abort and settle after this request has ended.
      if (combined.aborted) void response.body?.cancel().catch(() => {});
      return response;
    });
    const response = await Promise.race([fetching, aborted]);
    combined.throwIfAborted();
    if (!response.ok) {
      void response.body?.cancel().catch(() => {});
      const retry = response.headers.get("retry-after");
      return {
        state: "failed",
        code: response.status === 429 ? "rate-limit" : "http",
        ...(response.status === 429 &&
        retry &&
        /^\d+$/.test(retry) &&
        Number.isSafeInteger(Number(retry)) &&
        Number(retry) > 0
          ? { retryAfterSeconds: Number(retry) }
          : {}),
      };
    }
    reader = response.body?.getReader();
    const chunks: Uint8Array[] = [];
    let length = 0;
    while (reader) {
      const part = await Promise.race([reader.read(), aborted]);
      combined.throwIfAborted();
      if (part.done) break;
      length += part.value.byteLength;
      if (length > MAX_RESPONSE_BYTES) return { state: "failed", code: "response" };
      if (part.value.byteLength) chunks.push(part.value);
    }
    let body: unknown;
    try {
      body = JSON.parse(Buffer.concat(chunks, length).toString("utf8"));
    } catch {
      // Empty/non-JSON success is valid for some endpoints, but not for service-specific JSON APIs.
      body = undefined;
    }
    return { state: "response", body, status: response.status };
  } catch {
    if (signal.aborted) return { state: "cancelled", code: "cancelled" };
    return { state: "failed", code: timeout.signal.aborted ? "timeout" : "network" };
  } finally {
    if (reader) {
      // Stream cancellation itself can stall. Do not await an untrusted underlying source.
      void reader.cancel().catch(() => {});
      reader.releaseLock();
    }
    combined.removeEventListener("abort", onAbort);
    clearTimeout(timer);
  }
}
