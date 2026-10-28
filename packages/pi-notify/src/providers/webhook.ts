import { type DeliveryResult, isObject, type NotificationProvider } from "../provider.js";
import { normalizeHttpUrl, postJson } from "./http.js";

/** A fixed metadata contract; HTTP 2xx means endpoint acceptance, not downstream delivery. */
export function createWebhookProvider(fetcher: typeof fetch = fetch): NotificationProvider {
  return {
    id: "webhook",
    label: "Generic webhook",
    validate(value) {
      if (!isObject(value) || value.provider !== "webhook") return undefined;
      if (typeof value.label !== "string" || !value.label.trim() || value.label.length > 128) return undefined;
      if (!normalizeHttpUrl(value.webhookUrl)) return undefined;
      // This is an exact endpoint, not a server base: trailing slashes can select a different route.
      const webhookUrl = new URL(String(value.webhookUrl)).href;
      if (webhookUrl.length > 2048) return undefined;
      // Local printable-ASCII header-safety limit (no spaces), not an endpoint token-format claim.
      if (
        value.bearerToken !== undefined &&
        (typeof value.bearerToken !== "string" || !/^[\x21-\x7e]{1,512}$/.test(value.bearerToken))
      )
        return undefined;
      return {
        provider: "webhook",
        label: value.label,
        webhookUrl,
        bearerToken: value.bearerToken === undefined ? undefined : String(value.bearerToken),
      };
    },
    async send(destination, notification, signal): Promise<DeliveryResult> {
      if (signal.aborted) return { state: "cancelled", code: "cancelled" };
      const valid = this.validate(destination);
      if (valid?.provider !== "webhook") return { state: "failed", code: "invalid-destination" };
      const result = await postJson(
        valid.webhookUrl,
        {
          id: notification.id,
          title: notification.title,
          body: notification.body,
          settledAt: notification.settledAt,
        },
        signal,
        fetcher,
        valid.bearerToken === undefined ? {} : { Authorization: `Bearer ${valid.bearerToken}` },
      );
      return result.state === "response" ? { state: "accepted" } : result;
    },
  };
}
