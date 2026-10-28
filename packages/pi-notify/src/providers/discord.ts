import { sanitizeTerminalText } from "@narumitw/pi-tui-kit/terminal-text";
import { type DeliveryResult, isObject, type NotificationProvider } from "../provider.js";
import { clipText } from "../text.js";
import { postJson } from "./http.js";

// https://discord.com/developers/docs/resources/webhook#execute-webhook
// https://discord.com/developers/docs/resources/message#allowed-mentions-object
// Official OpenAPI: discord/discord-api-spec@ed014089afa986f2b532ae081c456a85de074d0c.
function isSnowflake(value: unknown): value is string {
  return (
    typeof value === "string" &&
    !/\s/.test(value) &&
    /^[1-9][0-9]{0,19}$/.test(value) &&
    BigInt(value) <= 18446744073709551615n
  );
}

/** Match the literal official endpoint; do not accept URL parser normalization aliases. */
export function validateDiscordWebhookUrl(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 2048 || /[\s\\\p{Cc}]/u.test(value)) return false;
  const match = /^https:\/\/discord\.com\/api\/(?:v10\/)?webhooks\/([1-9][0-9]{0,19})\/[-_A-Za-z0-9]+$/.exec(value);
  return match !== null && isSnowflake(match[1]);
}

export function createDiscordProvider(fetcher: typeof fetch = fetch): NotificationProvider {
  return {
    id: "discord",
    label: "Discord",
    validate(value) {
      if (!isObject(value) || value.provider !== "discord") return undefined;
      if (typeof value.label !== "string" || !value.label.trim() || value.label.length > 128) return undefined;
      if (!validateDiscordWebhookUrl(value.webhookUrl)) return undefined;
      return { provider: "discord", label: value.label, webhookUrl: value.webhookUrl };
    },
    async send(destination, notification, signal): Promise<DeliveryResult> {
      if (signal.aborted) return { state: "cancelled", code: "cancelled" };
      const valid = this.validate(destination);
      if (valid?.provider !== "discord") return { state: "failed", code: "invalid-destination" };
      const text = `${notification.title}\n${notification.body}`.split("\n").map(sanitizeTerminalText).join("\n");
      const result = await postJson(
        `${valid.webhookUrl}?wait=true`,
        {
          content: clipText(text.trim() ? text : "Pi notification", 2000),
          // Enforce this for direct callers, not only for metadata produced by the coordinator.
          allowed_mentions: { parse: [] },
          flags: 4, // SUPPRESS_EMBEDS, not SUPPRESS_NOTIFICATIONS (4096).
        },
        signal,
        fetcher,
        {
          // Discord's required bot User-Agent syntax. 1.0 is the adapter version, not the package version.
          "User-Agent": "DiscordBot (https://github.com/narumiruna/pi-extensions, 1.0)",
        },
      );
      if (result.state !== "response") return result;
      const body = result.body;
      return result.status === 200 &&
        isObject(body) &&
        isSnowflake(body.id) &&
        isSnowflake(body.channel_id) &&
        Number.isInteger(body.type)
        ? { state: "accepted" }
        : { state: "failed", code: "response" };
    },
  };
}
