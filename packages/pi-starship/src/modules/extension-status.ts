import { parseStyle } from "../format/style.js";
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
  values: ({ runtime, extensionStatus, palette }) => {
    const statuses = [...runtime.extensionStatuses.entries()]
      .filter(([key, value]) => key !== "starship" && value.trim())
      .slice(0, extensionStatus.maxStatuses)
      .map(([key, value]) => ({ key, text: formatExtensionStatus(key, value, extensionStatus.icons) }));
    if (statuses.length === 0) return undefined;
    const { separator, styles } = extensionStatus;
    const content =
      Object.keys(styles).length === 0
        ? statuses.map(({ text }) => text).join(separator)
        : statuses.flatMap(({ key, text }, index) => {
            const configured = configuredStatusValue(key, styles);
            const style = configured ?? (Object.hasOwn(styles, "fallback") ? styles.fallback : undefined);
            return [
              ...(index > 0 ? [{ text: separator }] : []),
              { text, style: style === undefined ? undefined : (parseStyle(style, palette) ?? {}) },
            ];
          });
    return { statuses: content, count: `${statuses.length}` };
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
  const configured = configuredStatusValue(key, configuredIcons);
  if (configured !== undefined) return configured;
  const fallback = Object.hasOwn(configuredIcons, "fallback") ? configuredIcons.fallback : undefined;
  return leadingIcon ?? fallback ?? "🔌";
}

function configuredStatusValue(key: string, configured: Readonly<Record<string, string>>): string | undefined {
  if (Object.hasOwn(configured, key)) return configured[key];
  let match: { baseLength: number; value: string } | undefined;
  for (const [selector, value] of Object.entries(configured)) {
    if (!selector.endsWith(":*")) continue;
    const base = selector.slice(0, -2);
    if (!base || !key.startsWith(`${base}:`)) continue;
    if (!match || base.length > match.baseLength) match = { baseLength: base.length, value };
  }
  return match?.value;
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
