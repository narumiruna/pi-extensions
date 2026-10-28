import { type DeliveryResult, isObject, type NotificationProvider } from "../provider.js";

const TIMEOUT_MS = 10_000;
const MAX_RESPONSE_BYTES = 65_536;

/** Accept self-hosted HTTP(S), including reverse-proxy paths, but no URL credentials. */
export function normalizeGotifyUrl(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > 2048 || /[\s\\?#\p{Cc}]/u.test(value)) return undefined;
  try {
    const url = new URL(value);
    if (!/^https?:\/\/[^/@]+(?:\/|$)/i.test(value) || url.username || url.password) return undefined;
    const normalized = url.href.replace(/\/+$/, "");
    return normalized.length <= 2048 ? normalized : undefined;
  } catch {
    return undefined;
  }
}

/** Application-token auth only; no redirects, retries, Markdown extras, or client subscriptions. */
export function createGotifyProvider(fetcher: typeof fetch = fetch): NotificationProvider {
  return {
    id: "gotify",
    label: "Gotify",
    validate(value) {
      if (!isObject(value) || value.provider !== "gotify") return undefined;
      if (typeof value.label !== "string" || !value.label.trim() || value.label.length > 128) return undefined;
      const serverUrl = normalizeGotifyUrl(value.serverUrl);
      if (!serverUrl || typeof value.appToken !== "string" || !/^[\x21-\x7e]{1,512}$/.test(value.appToken))
        return undefined;
      if (value.priority !== undefined && !Number.isSafeInteger(value.priority)) return undefined;
      return {
        provider: "gotify",
        label: value.label,
        serverUrl,
        appToken: value.appToken,
        priority: value.priority === undefined ? undefined : Number(value.priority),
      };
    },
    async send(destination, notification, signal): Promise<DeliveryResult> {
      if (signal.aborted) return { state: "cancelled", code: "cancelled" };
      // Validate again for direct callers and use the normalized reverse-proxy base path.
      const valid = this.validate(destination);
      if (valid?.provider !== "gotify") return { state: "failed", code: "invalid-destination" };
      const timeout = new AbortController();
      const timer = setTimeout(() => timeout.abort(), TIMEOUT_MS);
      const combined = AbortSignal.any([signal, timeout.signal]);
      try {
        const response = await fetcher(`${valid.serverUrl}/message`, {
          method: "POST",
          redirect: "error",
          signal: combined,
          headers: { "content-type": "application/json", "X-Gotify-Key": valid.appToken },
          body: JSON.stringify({
            title: notification.title,
            message: notification.body,
            ...(valid.priority === undefined ? {} : { priority: valid.priority }),
          }),
        });
        combined.throwIfAborted();
        if (!response.ok) {
          await response.body?.cancel().catch(() => {});
          combined.throwIfAborted();
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
        const reader = response.body?.getReader();
        if (!reader) return { state: "failed", code: "response" };
        let length = 0;
        const chunks: Uint8Array[] = [];
        try {
          while (true) {
            combined.throwIfAborted();
            const part = await reader.read();
            combined.throwIfAborted();
            if (part.done) break;
            length += part.value.byteLength;
            if (length > MAX_RESPONSE_BYTES) break;
            chunks.push(part.value);
          }
        } finally {
          await reader.cancel().catch(() => {});
          reader.releaseLock();
        }
        combined.throwIfAborted();
        if (length > MAX_RESPONSE_BYTES) return { state: "failed", code: "response" };
        let body: unknown;
        try {
          body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        } catch {
          return { state: "failed", code: "response" };
        }
        // The documented success is a Message, not merely any HTTP 2xx response.
        return isObject(body) &&
          Number.isSafeInteger(body.id) &&
          Number(body.id) > 0 &&
          Number.isSafeInteger(body.appid) &&
          Number(body.appid) > 0 &&
          typeof body.message === "string" &&
          typeof body.date === "string" &&
          Number.isFinite(Date.parse(body.date))
          ? { state: "accepted" }
          : { state: "failed", code: "response" };
      } catch {
        if (signal.aborted) return { state: "cancelled", code: "cancelled" };
        return { state: "failed", code: timeout.signal.aborted ? "timeout" : "network" };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
