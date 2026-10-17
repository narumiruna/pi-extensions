import { type DeliveryResult, isObject, type Notification, type NotificationProvider } from "./provider.js";
import { clipText } from "./text.js";

const TIMEOUT_MS = 10_000;
const MAX_RESPONSE_BYTES = 65_536;

function codePointBoundary(text: string, offset: number): boolean {
  const before = text.charCodeAt(offset - 1);
  const after = text.charCodeAt(offset);
  return !(before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff);
}

function telegramMessage(notification: Notification) {
  const source = `${notification.title}\n${notification.body}`;
  const text = clipText(source, 4096);
  // Telegram entities use UTF-16 units. Do not style the clipping ellipsis.
  // https://core.telegram.org/bots/api#messageentity
  const contentEnd = text.length - (text === source ? 0 : 1);
  const ranges = [
    { style: "bold" as const, offset: 0, length: notification.title.length },
    ...(notification.bodyEmphasis ?? []).flatMap((range) =>
      Number.isSafeInteger(range.offset) &&
      Number.isSafeInteger(range.length) &&
      range.offset >= 0 &&
      range.length > 0 &&
      range.offset + range.length <= notification.body.length
        ? [{ ...range, offset: notification.title.length + 1 + range.offset }]
        : [],
    ),
  ];
  const entities = ranges.flatMap(({ style, offset, length }) => {
    // Trim only the retained entity, not the text or later offsets.
    // https://core.telegram.org/api/entities#entity-length
    const retained = source.slice(offset, Math.min(offset + length, contentEnd)).trimEnd();
    const end = offset + retained.length;
    if (end <= offset || !codePointBoundary(source, offset) || !codePointBoundary(source, end)) return [];
    return [{ type: style === "bold" ? "bold" : "code", offset, length: end - offset }];
  });
  return { text, entities };
}

/** No user-configurable origin, redirects, paid broadcasts, parse mode, or retries. */
export function createTelegramProvider(fetcher: typeof fetch = fetch): NotificationProvider {
  return {
    id: "telegram",
    label: "Telegram",
    validate(value) {
      if (!isObject(value) || value.provider !== "telegram") return undefined;
      if (typeof value.label !== "string" || !value.label.trim() || value.label.length > 128) return undefined;
      if (typeof value.botToken !== "string" || !/^\d{1,20}:[A-Za-z0-9_-]{20,200}$/.test(value.botToken))
        return undefined;
      if (typeof value.chatId !== "string" || !/^-?[1-9]\d{0,30}$/.test(value.chatId)) return undefined;
      if (
        value.messageThreadId !== undefined &&
        (!Number.isSafeInteger(value.messageThreadId) || Number(value.messageThreadId) <= 0)
      )
        return undefined;
      return {
        provider: "telegram",
        label: value.label,
        botToken: value.botToken,
        chatId: value.chatId,
        messageThreadId: value.messageThreadId === undefined ? undefined : Number(value.messageThreadId),
      };
    },
    async send(destination, notification, signal): Promise<DeliveryResult> {
      if (signal.aborted) return { state: "cancelled", code: "cancelled" };
      if (destination.provider !== "telegram") return { state: "failed", code: "invalid-destination" };
      const timeout = new AbortController();
      const timer = setTimeout(() => timeout.abort(), TIMEOUT_MS);
      const combined = AbortSignal.any([signal, timeout.signal]);
      try {
        const response = await fetcher(`https://api.telegram.org/bot${destination.botToken}/sendMessage`, {
          method: "POST",
          redirect: "error",
          signal: combined,
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            chat_id: destination.chatId,
            ...(destination.messageThreadId === undefined ? {} : { message_thread_id: destination.messageThreadId }),
            ...telegramMessage(notification),
            link_preview_options: { is_disabled: true },
          }),
        });
        const reader = response.body?.getReader();
        if (!reader) return { state: "failed", code: "response" };
        let length = 0;
        const chunks: Uint8Array[] = [];
        try {
          while (true) {
            combined.throwIfAborted();
            const part = await reader.read();
            if (part.done) break;
            length += part.value.byteLength;
            if (length > MAX_RESPONSE_BYTES) return { state: "failed", code: "response" };
            chunks.push(part.value);
          }
        } finally {
          await reader.cancel().catch(() => {});
          reader.releaseLock();
        }
        combined.throwIfAborted();
        let body: unknown;
        try {
          body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        } catch {
          return { state: "failed", code: "response" };
        }
        if (!isObject(body)) return { state: "failed", code: "response" };
        if (response.status === 429 || body.error_code === 429) {
          const retry = isObject(body.parameters) ? body.parameters.retry_after : undefined;
          return {
            state: "failed",
            code: "rate-limit",
            ...(Number.isSafeInteger(retry) && Number(retry) > 0 ? { retryAfterSeconds: Number(retry) } : {}),
          };
        }
        if (!response.ok) return { state: "failed", code: "http" };
        return body.ok === true && isObject(body.result) ? { state: "accepted" } : { state: "failed", code: "api" };
      } catch {
        if (signal.aborted) return { state: "cancelled", code: "cancelled" };
        return { state: "failed", code: timeout.signal.aborted ? "timeout" : "network" };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
