import { sanitizeTerminalDocument } from "@narumitw/pi-tui-kit/terminal-document";

/** Keep terminal controls out of native renderers without changing agent payloads. */
export function settingsChatDisplayValue<T>(value: T): T {
  if (typeof value === "string") return sanitizeTerminalDocument(value) as T;
  if (Array.isArray(value)) return value.map(settingsChatDisplayValue) as T;
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, settingsChatDisplayValue(item)])) as T;
  }
  return value;
}
