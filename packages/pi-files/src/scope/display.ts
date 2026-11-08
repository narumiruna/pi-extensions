import { sanitizeTerminalText } from "@narumitw/pi-tui-kit/terminal-text";

// Escape controls rather than deleting bytes from a path's display identity.
// JSON quotes also expose leading/trailing spaces and distinguish literal backslashes.
export function displayPath(path: string): string {
  return JSON.stringify(path).replace(
    /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\u00a0\u1680\u2000-\u200a\u202f\u205f\u3000]/gu,
    escapeCharacter,
  );
}

/** Keep ordinary picker labels readable without hiding ambiguous or unsafe bytes. */
export function displayFilePath(path: string): string {
  const quoted = displayPath(path);
  return quoted === `"${path}"` && !/^\s|\s$| {2}/u.test(path) ? path : quoted;
}

function escapeCharacter(character: string): string {
  return Array.from(character, (part) => {
    const point = part.codePointAt(0) ?? 0;
    return point > 0xffff ? `\\u{${point.toString(16)}}` : `\\u${point.toString(16).padStart(4, "0")}`;
  }).join("");
}

export function displayError(error: unknown): string {
  return sanitizeTerminalText(error instanceof Error ? error.message : String(error));
}
