import { type DeliveryResult, isObject, type NotificationProvider } from "../provider.js";
import { normalizeHttpUrl, postJson, truncateUtf8 } from "./http.js";

// Official contract: https://docs.ntfy.sh/publish/#publish-as-json
// Topics: https://docs.ntfy.sh/publish/#picking-a-topic
// Reserved names: https://github.com/binwiederhier/ntfy/blob/main/server/config.go (DefaultDisallowedTopics).
// These names are case-sensitive; self-hosted servers can forbid additional topics.
const RESERVED_TOPICS = new Set([
  "docs",
  "static",
  "file",
  "app",
  "metrics",
  "account",
  "settings",
  "signup",
  "login",
  "v1",
]);

/** Anonymous or Bearer publishing only. Topic secrecy does not replace server access control. */
export function createNtfyProvider(fetcher: typeof fetch = fetch): NotificationProvider {
  return {
    id: "ntfy",
    label: "ntfy",
    validate(value) {
      if (!isObject(value) || value.provider !== "ntfy") return undefined;
      if (typeof value.label !== "string" || !value.label.trim() || value.label.length > 128) return undefined;
      if (!normalizeHttpUrl(value.serverUrl)) return undefined;
      // Publishing targets the base itself; preserve its trailing slash for exact proxy mounts.
      const serverUrl = new URL(String(value.serverUrl)).href;
      if (serverUrl.length > 2048 || typeof value.topic !== "string" || !/^[-_A-Za-z0-9]{1,64}$/.test(value.topic))
        return undefined;
      if (RESERVED_TOPICS.has(value.topic)) return undefined;
      // Local header-safety limit, not a claim that the server accepts any such token.
      if (
        value.accessToken !== undefined &&
        (typeof value.accessToken !== "string" || !/^[\x21-\x7e]{1,512}$/.test(value.accessToken))
      )
        return undefined;
      if (
        value.priority !== undefined &&
        (!Number.isInteger(value.priority) || Number(value.priority) < 1 || Number(value.priority) > 5)
      )
        return undefined;
      return {
        provider: "ntfy",
        label: value.label,
        serverUrl,
        topic: value.topic,
        accessToken: value.accessToken === undefined ? undefined : String(value.accessToken),
        priority: value.priority === undefined ? undefined : Number(value.priority),
      };
    },
    async send(destination, notification, signal): Promise<DeliveryResult> {
      if (signal.aborted) return { state: "cancelled", code: "cancelled" };
      const valid = this.validate(destination);
      if (valid?.provider !== "ntfy") return { state: "failed", code: "invalid-destination" };
      // https://docs.ntfy.sh/publish/#limitations: title 1 KiB, message 4096 UTF-8 bytes.
      const payload = {
        topic: valid.topic,
        title: truncateUtf8(notification.title, 1024),
        message: truncateUtf8(notification.body, 4096),
        ...(valid.priority === undefined ? {} : { priority: valid.priority }),
      };
      // The server's transformBodyJSON also caps the complete JSON envelope at 2 * message-size-limit.
      // Escaped controls can exceed that limit even when the decoded strings fit their byte limits.
      const excess = Buffer.byteLength(JSON.stringify(payload), "utf8") - 8192;
      if (excess > 0)
        payload.message = truncateUtf8(payload.message, Math.max(0, Buffer.byteLength(payload.message) - excess));
      const result = await postJson(
        valid.serverUrl,
        payload,
        signal,
        fetcher,
        valid.accessToken === undefined ? {} : { Authorization: `Bearer ${valid.accessToken}` },
      );
      if (result.state !== "response") return result;
      // Publish returns a Message: https://docs.ntfy.sh/subscribe/api/#json-message-format
      const body = result.body;
      return result.status === 200 &&
        isObject(body) &&
        typeof body.id === "string" &&
        body.id.length > 0 &&
        Number.isSafeInteger(body.time) &&
        Number(body.time) > 0 &&
        body.event === "message" &&
        body.topic === valid.topic &&
        typeof body.message === "string"
        ? { state: "accepted" }
        : { state: "failed", code: "response" };
    },
  };
}
