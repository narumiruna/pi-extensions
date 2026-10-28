import { sanitizeTerminalText } from "@narumitw/pi-tui-kit/terminal-text";
import { type DeliveryResult, isObject, type NotificationProvider } from "../provider.js";
import { postJson } from "./http.js";

// Local support policy, not a complete Microsoft URL grammar. Reviewed 2026-10-18:
// https://learn.microsoft.com/en-us/power-automate/triggers-troubleshoot
// documents migration from logic.azure.com and the optional /direct/cu/20 route.
// https://learn.microsoft.com/en-us/connectors/teams/#microsoft-teams-webhook
// documents Anyone authentication (no Authorization header) and the card envelope.
// https://learn.microsoft.com/en-us/azure/logic-apps/logic-apps-http-endpoint
// documents signed Request URLs; this is corroboration, not a Teams URL/response contract.
// Public current-format example (corroboration only):
// https://dev.classmethod.jp/en/articles/aws-step-functions-teams-workflows-new-webhook-url/
// Support only literal lowercase commercial DNS hosts with one or more valid prefix
// labels before .environment.api.powerplatform.com; labels <=63, entire host <=253.
// Require HTTPS, no userinfo, and no port except an explicit generated :443.
// Paths are exactly /powerautomate/automations/direct/[cu/<route>/]workflows/<id>
// /triggers/manual/paths/invoke. Route/id are opaque ASCII letters, digits, _ or -,
// 1..256 characters each: a local bound, NOT an inferred fixed-length service ID.
// Reject all encoded hosts/paths, dot segments, fragments, whitespace, controls and
// backslashes before a URL parser could normalize them. Total URL cap: 8,192 chars.
// Query keys must be literal api-version, sp, sv, sig, exactly once, in any order.
// api-version=1 and sv=1.0 are literal; decoded sp is /triggers/manual/run.
// Decoded sig is nonempty opaque base64/base64url syntax (up to two trailing =).
// Percent escapes must be valid UTF-8. In particular, + is NOT form-decoded to space.
// Preserve the COMPLETE raw signed URL, including port, escape case and query order.
const MAX_URL_LENGTH = 8192;
const HOST_SUFFIX = ".environment.api.powerplatform.com";
const DNS_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u;
const WORKFLOW_PATH =
  /^\/powerautomate\/automations\/direct\/(?:cu\/[A-Za-z0-9_-]{1,256}\/)?workflows\/[A-Za-z0-9_-]{1,256}\/triggers\/manual\/paths\/invoke$/u;

function workflowUrl(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > MAX_URL_LENGTH || /[\s\\\p{Cc}]/u.test(value)) return undefined;
  const parts = /^https:\/\/([^/?#]+)(\/[^?#]+)\?([^#]+)$/u.exec(value);
  if (!parts) return undefined;
  const [, authority = "", path = "", query = ""] = parts;
  const hostname = authority.endsWith(":443") ? authority.slice(0, -4) : authority;
  if (
    hostname.length > 253 ||
    !hostname.endsWith(HOST_SUFFIX) ||
    hostname.length <= HOST_SUFFIX.length ||
    !hostname.split(".").every((label) => DNS_LABEL.test(label)) ||
    !WORKFLOW_PATH.test(path)
  )
    return undefined;
  const values = new Map<string, string>();
  try {
    for (const pair of query.split("&")) {
      const separator = pair.indexOf("=");
      if (separator < 0) return undefined;
      const key = pair.slice(0, separator);
      const raw = pair.slice(separator + 1);
      if (!["api-version", "sp", "sv", "sig"].includes(key) || values.has(key)) return undefined;
      const decoded = decodeURIComponent(raw);
      // Also reject encoded terminal whitespace: JavaScript's $ can precede a final newline.
      if (/[\s\\\p{Cc}]/u.test(decoded)) return undefined;
      if ((key === "api-version" && raw !== "1") || (key === "sv" && raw !== "1.0")) return undefined;
      values.set(key, decoded);
    }
  } catch {
    return undefined;
  }
  if (
    values.size !== 4 ||
    values.get("sp") !== "/triggers/manual/run" ||
    !/^[A-Za-z0-9_+/-]+={0,2}$/u.test(values.get("sig") ?? "")
  )
    return undefined;
  return value;
}

function card(text: string) {
  return {
    type: "message",
    attachments: [
      {
        contentType: "application/vnd.microsoft.card.adaptive",
        contentUrl: null,
        content: {
          $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
          type: "AdaptiveCard",
          version: "1.2",
          // TextRun has no Markdown support. No actions, images or mention entities.
          // https://learn.microsoft.com/en-us/adaptive-cards/schema-explorer/text-run
          // Clients can still auto-link text; this does not promise link suppression.
          body: [{ type: "RichTextBlock", inlines: [{ type: "TextRun", text }] }],
        },
      },
    ],
  };
}

// A local encoded-JSON budget, NOT proof of Teams' downstream rendered-card size.
// https://learn.microsoft.com/en-us/connectors/teams/#known-issues-and-limitations
// The connector's approximate 28 KB limit includes rendered elements.
const MAX_PAYLOAD_BYTES = 24_000;
const TEXT_BUDGET = MAX_PAYLOAD_BYTES - Buffer.byteLength(JSON.stringify(card("")), "utf8");

function boundedText(title: string, body: string): string {
  const text = `${title}\n${body}`.split("\n").map(sanitizeTerminalText).join("\n");
  const points: string[] = [];
  const costs: number[] = [];
  let bytes = 0;
  for (const point of text) {
    // Count JSON escapes as well as UTF-8, using only constant-sized serializations.
    const cost = Buffer.byteLength(JSON.stringify(point), "utf8") - 2;
    if (bytes + cost > TEXT_BUDGET) {
      while (bytes + 3 > TEXT_BUDGET) {
        bytes -= costs.pop() ?? 0;
        points.pop();
      }
      return `${points.join("")}…`;
    }
    bytes += cost;
    points.push(point);
    costs.push(cost);
  }
  return points.join("");
}

/** One workflow request. Local acceptance is HTTP 202, never downstream-post proof. */
export function createTeamsProvider(fetcher: typeof fetch = fetch): NotificationProvider {
  return {
    id: "teams",
    label: "Microsoft Teams",
    validate(value) {
      if (!isObject(value) || value.provider !== "teams") return undefined;
      if (typeof value.label !== "string" || !value.label.trim() || value.label.length > 128) return undefined;
      const webhookUrl = workflowUrl(value.webhookUrl);
      return webhookUrl ? { provider: "teams", label: value.label, webhookUrl } : undefined;
    },
    async send(destination, notification, signal): Promise<DeliveryResult> {
      if (signal.aborted) return { state: "cancelled", code: "cancelled" };
      const valid = this.validate(destination);
      if (valid?.provider !== "teams") return { state: "failed", code: "invalid-destination" };
      const result = await postJson(
        valid.webhookUrl,
        card(boundedText(notification.title, notification.body)),
        signal,
        fetcher,
      );
      if (result.state !== "response") return result;
      // Explicit local status-only policy after the FULL bounded response read:
      // https://www.rfc-editor.org/rfc/rfc9110.html#section-15.3.3
      // 202 means accepted for processing, not completed. The Request documentation
      // above corroborates default 202 without a Response action, but does not define
      // Teams responses. A public workflow example also reports 202 despite a later
      // workflow failure (corroboration only, NOT a normative Teams response shape):
      // https://simonscholz.dev/tutorials/microsoft-teams-messages-webhook-workflow/
      // Ignore bounded empty/text/JSON bodies and undocumented fields.
      // Live Teams interoperability and downstream receipt remain unverified.
      return result.status === 202 ? { state: "accepted" } : { state: "failed", code: "response" };
    },
  };
}
