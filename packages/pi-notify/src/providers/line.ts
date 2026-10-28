import { sanitizeTerminalText } from "@narumitw/pi-tui-kit/terminal-text";
import { type DeliveryResult, isObject, type NotificationProvider } from "../provider.js";
import { clipText } from "../text.js";
import { postJson } from "./http.js";

// Verified 2026-10-18: https://developers.line.biz/en/reference/messaging-api/#send-push-message
// https://developers.line.biz/en/docs/messaging-api/text-character-count/: 5,000 UTF-16 units.
// https://developers.line.biz/en/docs/basics/channel-access-token/: tokens are opaque.
// RFC 6750 section 2.1 defines Bearer syntax; 8,192 is a local cap, not a LINE token limit.
const MAX_TOKEN_LENGTH = 8192;

function plainText(text: string): string {
  return text.split("\n").map(sanitizeTerminalText).join("\n");
}

function acceptedBody(body: unknown): boolean {
  if (!isObject(body)) return false;
  // Legacy {}: https://github.com/line/line-bot-sdk-nodejs/blob/master/test/line-bot-client.spec.ts
  // Current schema: https://github.com/line/line-openapi/blob/main/messaging-api.yml
  if (Object.keys(body).length === 0) return true;
  // Current reference uses Number for id; official line-openapi and its example use String.
  return (
    Array.isArray(body.sentMessages) &&
    body.sentMessages.length >= 1 &&
    body.sentMessages.length <= 5 &&
    body.sentMessages.every(
      (message) =>
        isObject(message) &&
        ((typeof message.id === "string" && message.id.length > 0) ||
          (typeof message.id === "number" && Number.isInteger(message.id) && message.id >= 0)) &&
        (message.quoteToken === undefined || typeof message.quoteToken === "string"),
    )
  );
}

/** One normal text push; HTTP acceptance does not prove recipient delivery. */
export function createLineProvider(fetcher: typeof fetch = fetch): NotificationProvider {
  return {
    id: "line",
    label: "LINE",
    validate(value) {
      if (!isObject(value) || value.provider !== "line") return undefined;
      if (typeof value.label !== "string" || !value.label.trim() || value.label.length > 128) return undefined;
      if (
        typeof value.channelAccessToken !== "string" ||
        value.channelAccessToken.length > MAX_TOKEN_LENGTH ||
        /\s/u.test(value.channelAccessToken) ||
        !/^[A-Za-z0-9._~+/-]+=*$/u.test(value.channelAccessToken)
      )
        return undefined;
      // https://developers.line.biz/en/docs/messaging-api/getting-user-ids/: U + 32 lowercase hex.
      // The push reference's webhook source examples use C/R prefixes for group/room IDs.
      // Group/room syntax is not specified: printable ASCII and 128 suffix characters
      // are local safety bounds, not a claimed service grammar.
      if (
        typeof value.recipientId !== "string" ||
        value.recipientId.length > 129 ||
        /\s/u.test(value.recipientId) ||
        !/^(?:U[0-9a-f]{32}|[CR][!-~]{1,128})$/u.test(value.recipientId)
      )
        return undefined;
      return {
        provider: "line",
        label: value.label,
        channelAccessToken: value.channelAccessToken,
        recipientId: value.recipientId,
      };
    },
    async send(destination, notification, signal): Promise<DeliveryResult> {
      if (signal.aborted) return { state: "cancelled", code: "cancelled" };
      const valid = this.validate(destination);
      if (valid?.provider !== "line") return { state: "failed", code: "invalid-destination" };
      const result = await postJson(
        "https://api.line.me/v2/bot/message/push",
        {
          to: valid.recipientId,
          // No mention/emoji objects, substitutions, formatting, or silent-delivery option.
          // LINE clients can still auto-link literal URLs; this does not promise link suppression.
          messages: [{ type: "text", text: clipText(plainText(`${notification.title}\n${notification.body}`), 5000) }],
        },
        signal,
        fetcher,
        { Authorization: `Bearer ${valid.channelAccessToken}` },
      );
      if (result.state !== "response") return result;
      return result.status === 200 && acceptedBody(result.body)
        ? { state: "accepted" }
        : { state: "failed", code: "response" };
    },
  };
}
