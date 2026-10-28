import { type DeliveryResult, isObject, type NotificationProvider } from "../provider.js";
import { clipText } from "../text.js";
import { postJson } from "./http.js";

// https://pushover.net/api: Messages API, response format, and limitations.
// Tokens and user/group keys are exactly 30 case-sensitive ASCII alphanumeric characters.
export function createPushoverProvider(fetcher: typeof fetch = fetch): NotificationProvider {
  return {
    id: "pushover",
    label: "Pushover",
    validate(value) {
      if (!isObject(value) || value.provider !== "pushover") return undefined;
      if (typeof value.label !== "string" || !value.label.trim() || value.label.length > 128) return undefined;
      if (
        typeof value.appToken !== "string" ||
        value.appToken.length !== 30 ||
        !/^[A-Za-z0-9]{30}$/.test(value.appToken)
      )
        return undefined;
      if (typeof value.userKey !== "string" || value.userKey.length !== 30 || !/^[A-Za-z0-9]{30}$/.test(value.userKey))
        return undefined;
      return { provider: "pushover", label: value.label, appToken: value.appToken, userKey: value.userKey };
    },
    async send(destination, notification, signal): Promise<DeliveryResult> {
      if (signal.aborted) return { state: "cancelled", code: "cancelled" };
      const valid = this.validate(destination);
      if (valid?.provider !== "pushover") return { state: "failed", code: "invalid-destination" };
      const result = await postJson(
        "https://api.pushover.net/1/messages.json",
        {
          token: valid.appToken,
          user: valid.userKey,
          // UTF-16 budgets are conservative for the documented character limits.
          title: clipText(notification.title, 250),
          message: clipText(notification.body, 1024),
          priority: 0,
        },
        signal,
        fetcher,
      );
      if (result.state !== "response") return result;
      if (result.status !== 200 || !isObject(result.body) || typeof result.body.status !== "number")
        return { state: "failed", code: "response" };
      return result.body.status === 1 ? { state: "accepted" } : { state: "failed", code: "api" };
    },
  };
}
