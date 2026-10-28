import { safeText } from "./metadata.js";
import type { Destination } from "./provider.js";

export const providerLabels: Record<Destination["provider"], string> = {
  telegram: "Telegram",
  gotify: "Gotify",
  slack: "Slack",
  ntfy: "ntfy",
  pushover: "Pushover",
  discord: "Discord",
  bark: "Bark",
  webhook: "Generic webhook",
  line: "LINE",
  teams: "Microsoft Teams",
};
export const providerLabel = (destination: Destination) => providerLabels[destination.provider];
export const credentialLabels: Record<Destination["provider"], string> = {
  telegram: "bot token",
  gotify: "application token",
  slack: "webhook URL",
  ntfy: "access token (empty for anonymous)",
  pushover: "application token",
  discord: "webhook URL",
  bark: "device key",
  webhook: "webhook URL",
  line: "channel access token",
  teams: "webhook URL",
};
export function displayServerUrl(raw: string): string {
  try {
    const url = new URL(raw);
    // Never include URL credentials, query parameters, or fragments in descriptions.
    return safeText(`${url.protocol}//${url.host}${url.pathname}`);
  } catch {
    return "not configured";
  }
}
export function destinationDescription(destination: Destination): string {
  switch (destination.provider) {
    case "telegram":
      return `Telegram · ${safeText(destination.chatId)} · token configured`;
    case "gotify":
      return `Gotify · ${displayServerUrl(destination.serverUrl)} · token configured`;
    case "slack":
      return "Slack · webhook configured";
    case "line":
      return "LINE · channel access token and recipient configured";
    case "teams":
      return "Microsoft Teams · workflow webhook configured";
    case "pushover":
      return "Pushover · application token and user key configured";
    case "discord":
      return "Discord · webhook configured";
    case "bark":
      return `Bark · ${displayServerUrl(destination.serverUrl)} · device key configured`;
    case "webhook":
      return `Generic webhook · URL configured · ${destination.bearerToken ? "Bearer token configured" : "no authentication"}`;
    case "ntfy":
      return `ntfy · ${displayServerUrl(destination.serverUrl)} · ${destination.accessToken ? "token configured" : "anonymous"}`;
  }
}
export function destinationLines(destination: Destination): string[] {
  const label = `Label: ${safeText(destination.label)}`;
  switch (destination.provider) {
    case "telegram":
      return [
        label,
        `Chat: ${safeText(destination.chatId)}`,
        `Topic: ${destination.messageThreadId ?? "none"}`,
        "Bot token: configured (hidden)",
      ];
    case "gotify":
      return [
        label,
        `Server: ${displayServerUrl(destination.serverUrl)}`,
        `Priority: ${destination.priority ?? "server default"}`,
        "Application token: configured (hidden)",
      ];
    case "slack":
      return [label, "Channel: fixed by webhook installation", "Webhook URL: configured (hidden)"];
    case "line":
      return [
        label,
        "Channel access token: configured (hidden)",
        "Recipient ID: configured (hidden)",
        "Messaging API only, not LINE Notify. Account quotas and recipient eligibility apply.",
      ];
    case "teams":
      return [
        label,
        "Webhook URL: configured (hidden)",
        "Target: fixed by the owning workflow",
        "Anyone authentication only. HTTP acceptance does not confirm a Teams post.",
      ];
    case "pushover":
      return [
        label,
        "Application token: configured (hidden)",
        "User key: configured (hidden)",
        "Priority: normal (0); emergency mode is not supported.",
      ];
    case "discord":
      return [label, "Webhook URL: configured (hidden)", "Mentions and link embeds are disabled."];
    case "bark":
      return [
        label,
        `Server: ${displayServerUrl(destination.serverUrl)}`,
        "Device key: configured (hidden)",
        "Use HTTPS. HTTP sends credentials and metadata without encryption.",
      ];
    case "webhook":
      return [
        label,
        "Webhook URL: configured (hidden)",
        `Bearer token: ${destination.bearerToken ? "configured (hidden)" : "none"}`,
        "User endpoints can reach the Pi host network. Use HTTPS; HTTP is unencrypted.",
      ];
    case "ntfy":
      return [
        label,
        `Server: ${displayServerUrl(destination.serverUrl)}`,
        `Topic: ${safeText(destination.topic)}`,
        `Priority: ${destination.priority ?? "server default"}`,
        `Access token: ${destination.accessToken ? "configured (hidden)" : "none (anonymous)"}`,
        "A topic name is not access control. Configure server authentication and topic permissions.",
        "Use HTTPS. HTTP sends credentials and metadata without encryption.",
      ];
  }
}
