import { sanitizeTerminalText } from "@narumitw/pi-tui-kit/terminal-text";
import { type DeliveryResult, isObject, type Notification, type NotificationProvider } from "../provider.js";

const TIMEOUT_MS = 10_000;
const MAX_RESPONSE_BYTES = 65_536;

/** Slack decodes these entities even in plain_text. Bound encoded length without cutting an entity. */
function slackText(notification: Notification): string {
  const raw = `${notification.title}\n${notification.body}`.split("\n").map(sanitizeTerminalText).join("\n");
  let text = "";
  let beforeLast = 0;
  for (const character of raw) {
    const escaped = character === "&" ? "&amp;" : character === "<" ? "&lt;" : character === ">" ? "&gt;" : character;
    if (text.length + escaped.length > 3000) return `${text.length === 3000 ? text.slice(0, beforeLast) : text}…`;
    beforeLast = text.length;
    text += escaped;
  }
  return text.trim() ? text : "Pi notification";
}

/** Match the commercial webhook literal, not a URL parser's normalized interpretation.
 * https://docs.slack.dev/messaging/sending-messages-using-incoming-webhooks/
 */
export function validateSlackWebhookUrl(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= 2048 &&
    !/\s/.test(value) &&
    /^https:\/\/hooks\.slack\.com\/services\/T[A-Z0-9]+\/B[A-Z0-9]+\/[A-Za-z0-9]+$/.test(value)
  );
}

/** Fixed channel, no redirects or retries; the entire URL is a credential. */
export function createSlackProvider(fetcher: typeof fetch = fetch): NotificationProvider {
  return {
    id: "slack",
    label: "Slack",
    validate(value) {
      if (!isObject(value) || value.provider !== "slack") return undefined;
      if (typeof value.label !== "string" || !value.label.trim() || value.label.length > 128) return undefined;
      if (!validateSlackWebhookUrl(value.webhookUrl)) return undefined;
      return { provider: "slack", label: value.label, webhookUrl: value.webhookUrl };
    },
    async send(destination, notification, signal): Promise<DeliveryResult> {
      if (signal.aborted) return { state: "cancelled", code: "cancelled" };
      const valid = this.validate(destination);
      if (valid?.provider !== "slack") return { state: "failed", code: "invalid-destination" };
      const timeout = new AbortController();
      const timer = setTimeout(() => timeout.abort(), TIMEOUT_MS);
      const combined = AbortSignal.any([signal, timeout.signal]);
      try {
        // Plain text disables Slack formatting. Keep untrusted metadata out of the
        // fallback, which Slack also uses for notifications and screen readers.
        // https://docs.slack.dev/messaging/formatting-message-text/#disabling-formatting
        // Escape Slack control characters exactly once, including existing entity-like text.
        // https://docs.slack.dev/messaging/formatting-message-text/#escaping
        // Section text is limited to 3,000 characters; UTF-16 length is conservative.
        // https://docs.slack.dev/reference/block-kit/blocks/section-block/
        const response = await fetcher(valid.webhookUrl, {
          method: "POST",
          redirect: "error",
          signal: combined,
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            text: "Pi notification. Open Pi to review.",
            mrkdwn: false,
            parse: "none",
            unfurl_links: false,
            unfurl_media: false,
            blocks: [
              {
                type: "section",
                text: { type: "plain_text", text: slackText(notification), emoji: false },
              },
            ],
          }),
        });
        if (combined.aborted || response.status !== 200) {
          // Do not await an untrusted stream's potentially stalled cancellation.
          void response.body?.cancel().catch(() => {});
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
        // Also interrupt injected streams that do not observe the fetch signal.
        const cancel = () => {
          void reader.cancel().catch(() => {});
        };
        combined.addEventListener("abort", cancel, { once: true });
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
            if (part.value.byteLength) chunks.push(part.value);
          }
        } finally {
          combined.removeEventListener("abort", cancel);
          cancel();
          reader.releaseLock();
        }
        combined.throwIfAborted();
        // Only the documented HTTP 200 and exact plain-text `ok` is acceptance.
        return length <= MAX_RESPONSE_BYTES && Buffer.concat(chunks).equals(Buffer.from("ok"))
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
