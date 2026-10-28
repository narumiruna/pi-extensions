import { sanitizeTerminalDocument } from "@narumitw/pi-tui-kit/terminal-document";

const PREFIX = "\u001b]8;;";
const BEL = "\u0007";
const ST = "\u001b\\";

/** Preserve layout and supported HTTP(S) links, never arbitrary terminal controls. */
export function sanitizeFormatText(value: string): string {
  let output = "";
  let offset = 0;
  let cursor = 0;
  while (cursor < value.length) {
    const start = value.indexOf(PREFIX, cursor);
    if (start < 0) break;
    const opening = findTerminator(value, start + PREFIX.length);
    if (!opening) break;
    const closing = findLinkEnd(value, opening.end);
    if (!closing) break;
    cursor = closing.end;
    const url = safeHyperlinkUrl(value.slice(start + PREFIX.length, opening.start));
    if (!url) continue;
    output += sanitizePlainText(value.slice(offset, start));
    const label = sanitizePlainText(value.slice(opening.end, closing.start));
    if (label) {
      const openTerminator = value.slice(opening.start, opening.end);
      const closeTerminator = value.slice(closing.start + PREFIX.length, closing.end);
      output += `${PREFIX}${url}${openTerminator}${label}${PREFIX}${closeTerminator}`;
    }
    offset = closing.end;
  }
  return output + sanitizePlainText(value.slice(offset));
}

function sanitizePlainText(value: string): string {
  return sanitizeTerminalDocument(value).replace(/\t/gu, " ");
}

function terminatorEnd(value: string, start: number): number | undefined {
  if (value.startsWith(BEL, start)) return start + BEL.length;
  if (value.startsWith(ST, start)) return start + ST.length;
  return undefined;
}

function findTerminator(value: string, start: number): { start: number; end: number } | undefined {
  for (let index = start; index < value.length; index += 1) {
    const end = terminatorEnd(value, index);
    if (end !== undefined) return { start: index, end };
  }
  return undefined;
}

function findLinkEnd(value: string, start: number): { start: number; end: number } | undefined {
  let index = value.indexOf(PREFIX, start);
  while (index >= 0) {
    const end = terminatorEnd(value, index + PREFIX.length);
    if (end !== undefined) return { start: index, end };
    index = value.indexOf(PREFIX, index + PREFIX.length);
  }
  return undefined;
}

/** Match the URL policy used by the GitHub collector before generating OSC 8. */
function safeHyperlinkUrl(value: string): string | undefined {
  if (
    value.length > 4_096 ||
    Array.from(value).some((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code <= 0x1f || (code >= 0x7f && code <= 0x9f) || (code >= 0xd800 && code <= 0xdfff);
    })
  )
    return undefined;
  try {
    const url = new URL(value);
    if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password) return undefined;
    const normalized = url.toString();
    return normalized.length <= 4_096 ? normalized : undefined;
  } catch {
    return undefined;
  }
}
