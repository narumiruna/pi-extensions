import { defineModule } from "./types.js";

export const extensionStatusModule = defineModule({
  name: "extension_status",
  variables: ["symbol", "statuses", "count"],
  defaults: {
    format: "[$statuses]($style)",
    symbol: "",
    style: "dimmed white",
    disabled: false,
  },
  values: ({ runtime, extensionStatus }) => {
    const statuses = [...runtime.extensionStatuses.entries()]
      .filter(([key, value]) => key !== "starship" && value.trim())
      .map(([key, value]) => formatExtensionStatus(key, value, extensionStatus.icons))
      .slice(0, extensionStatus.maxStatuses);
    if (statuses.length === 0) return undefined;
    return {
      statuses: statuses.join(extensionStatus.separator),
      count: `${statuses.length}`,
    };
  },
});

export function formatExtensionStatus(
  key: string,
  value: string,
  configuredIcons: Readonly<Record<string, string>>,
): string {
  const status = splitExtensionStatusIcon(stripExtensionStatusPrefix(key, value));
  const icon = extensionStatusIcon(key, status.icon, configuredIcons);
  const text = simplifyExtensionStatusText(status.text);
  return icon ? `${icon} ${text}` : text;
}

function extensionStatusIcon(
  key: string,
  leadingIcon: string | undefined,
  configuredIcons: Readonly<Record<string, string>>,
): string {
  if (Object.hasOwn(configuredIcons, key)) return configuredIcons[key] ?? "";
  const namespaceIcon = configuredNamespaceIcon(key, configuredIcons);
  if (namespaceIcon !== undefined) return namespaceIcon;
  const fallbackIcon = Object.hasOwn(configuredIcons, "fallback") ? configuredIcons.fallback : undefined;
  return leadingIcon ?? fallbackIcon ?? "🔌";
}

function configuredNamespaceIcon(key: string, configuredIcons: Readonly<Record<string, string>>): string | undefined {
  let match: { baseLength: number; icon: string } | undefined;
  for (const [selector, icon] of Object.entries(configuredIcons)) {
    if (!selector.endsWith(":*")) continue;
    const base = selector.slice(0, -2);
    if (!base || !key.startsWith(`${base}:`)) continue;
    if (!match || base.length > match.baseLength) match = { baseLength: base.length, icon };
  }
  return match?.icon;
}

function splitExtensionStatusIcon(value: string): { icon?: string; text: string } {
  const trimmed = value.trim();
  const [first, ...rest] = trimmed.split(/\s+/u);
  if (first && isEmojiOnlyToken(first)) return { icon: first, text: rest.join(" ") };
  return { text: trimmed };
}

function isEmojiOnlyToken(value: string): boolean {
  return /^(?=.*(?:\p{Extended_Pictographic}|\p{Regional_Indicator}|[0-9#*]\ufe0f?\u20e3))(?:\p{Extended_Pictographic}|\p{Emoji_Modifier}|\p{Regional_Indicator}|\u200d|\ufe0f|[0-9#*]\ufe0f?\u20e3)+$/u.test(
    value,
  );
}

function stripExtensionStatusPrefix(key: string, value: string): string {
  return value.trim().replace(new RegExp(`^${escapeRegExp(key)}\\s*:\\s*`, "iu"), "");
}

function simplifyExtensionStatusText(value: string): string {
  return value
    .trim()
    .replace(/\bready\b/giu, "✓")
    .replace(/\bmissing\b/giu, "✗")
    .replace(/,\s*/g, " ")
    .replace(/\s+\([^)]*\)\s*$/u, "")
    .replace(/\s+/gu, " ");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
