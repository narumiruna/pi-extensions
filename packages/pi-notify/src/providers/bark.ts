import { type DeliveryResult, isObject, type NotificationProvider } from "../provider.js";
import { normalizeHttpUrl, postJson, truncateUtf8 } from "./http.js";

// Official contract: https://bark.day.app/#/tutorial and Finb/bark-server at
// 640deaa151ddf79193202927b35ca2f14f65ee1d: docs/API_V2.md, route_push.go,
// router.go, and route_auth.go. POST /push accepts JSON; numeric code 200 means acceptance.
// Native Basic authentication is not supported. Keys and messages stay in the JSON body.
export function createBarkProvider(fetcher: typeof fetch = fetch): NotificationProvider {
  return {
    id: "bark",
    label: "Bark",
    validate(value) {
      if (!isObject(value) || value.provider !== "bark") return undefined;
      if (typeof value.label !== "string" || !value.label.trim() || value.label.length > 128) return undefined;
      const serverUrl = normalizeHttpUrl(value.serverUrl);
      // Local printable-ASCII safety limit (no spaces), not an upstream device-key format claim.
      if (!serverUrl || typeof value.deviceKey !== "string" || !/^[\x21-\x7e]{1,512}$/.test(value.deviceKey))
        return undefined;
      return { provider: "bark", label: value.label, serverUrl, deviceKey: value.deviceKey };
    },
    async send(destination, notification, signal): Promise<DeliveryResult> {
      if (signal.aborted) return { state: "cancelled", code: "cancelled" };
      const valid = this.validate(destination);
      if (valid?.provider !== "bark") return { state: "failed", code: "invalid-destination" };
      // Local limits, not upstream limits: title 256 and body 2048 UTF-8 bytes.
      // Keep encoded {title,body} within 3000 bytes to leave room in APNs' default
      // 4096-byte envelope. Count JSON escapes, not only decoded text bytes.
      const title = truncateUtf8(notification.title, 256);
      let remaining = 3000 - Buffer.byteLength(JSON.stringify({ title, body: "" }), "utf8");
      let body = "";
      for (const point of truncateUtf8(notification.body, 2048)) {
        const encodedBytes = Buffer.byteLength(JSON.stringify(point), "utf8") - 2;
        if (encodedBytes > remaining) break;
        body += point;
        remaining -= encodedBytes;
      }
      const result = await postJson(
        `${valid.serverUrl}/push`,
        { device_key: valid.deviceKey, title, body },
        signal,
        fetcher,
      );
      if (result.state !== "response") return result;
      if (result.status !== 200 || !isObject(result.body) || typeof result.body.code !== "number")
        return { state: "failed", code: "response" };
      return result.body.code === 200 ? { state: "accepted" } : { state: "failed", code: "api" };
    },
  };
}
