import { createHash } from "node:crypto";
import type { Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import {
  backgroundAnsi,
  type Color,
  colorToRgb,
  foregroundAnsi,
  getCapabilities,
  hyperlink,
  Marked,
  rgbColor,
  stripTerminalSequences,
} from "@earendil-works/pi-tui";
import { resolveLinkPath } from "./filelinks.ts";

const START =
  /(?<![![])\[\[\[([^[\]\r\n]+)\]\]\]\(|(?<![![])\[\[([^[\]\r\n]+)\]\](?![\](])|\[(?:\\[^\r\n]|[^[\]\\\r\n])+\]\(/g;
const MARKER = /(\uE000+)(\d+)\uE001/g;
const BADGE_MARKER = /\[\[(\uE000+)(\d+)\uE001\]\]/g;
const WORD_JOINER = "\u2060";
const palette: readonly ThemeColor[] = [
  "accent",
  "mdLink",
  "success",
  "mdHeading",
  "error",
  "syntaxString",
  "syntaxVariable",
  "thinkingXhigh",
];
const parser = new Marked();

interface MarkupStart {
  offset: number;
  end: number;
  taggedOffset: number;
  marker: string;
  badge?: string;
  linkedBadge?: string;
}

interface Replacement {
  offset: number;
  end: number;
  text: string;
}

function asCodeSpan(text: string): string {
  // Carry ANSI styling through Pi's Markdown renderer without parsing the label.
  let ticks = 1;
  for (const [run] of text.matchAll(/`+/g)) ticks = Math.max(ticks, run.length + 1);
  const fence = "`".repeat(ticks);
  return fence + text + fence;
}

function textColorForFill(fill: Color): Color {
  // Compare black and white against the fill's relative luminance (WCAG 2.2).
  const { r, g, b } = colorToRgb(fill);
  const linear = (channel: number) => {
    const srgb = Math.round(channel) / 255;
    return srgb <= 0.04045 ? srgb / 12.92 : ((srgb + 0.055) / 1.055) ** 2.4;
  };
  const luminance = 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
  const blackContrast = (luminance + 0.05) / 0.05;
  const whiteContrast = 1.05 / (luminance + 0.05);
  const channel = blackContrast >= whiteContrast ? 0 : 255;
  return rgbColor(channel, channel, channel);
}

function cleanBadgeLabel(label: string): string {
  return stripTerminalSequences(label)
    .replace(/[\p{Cc}\p{Zl}\p{Zp}\p{Bidi_Control}]/gu, " ")
    .trim();
}

function renderBadge(label: string, theme: Theme, userMessage: boolean, href?: string): string {
  const caps = getCapabilities();
  const mode = caps.trueColor ? "truecolor" : "256color";
  const key = createHash("sha256").update(label.normalize("NFC")).digest()[0];
  const fill = theme.colors[palette[key % palette.length]];
  const edge = foregroundAnsi(fill, mode);
  const body = backgroundAnsi(fill, mode) + foregroundAnsi(textColorForFill(fill), mode);
  const resetFill = (userMessage && theme.getBgAnsi("userMessageBg")) || "\x1b[49m";
  const padded = `\u00a0${label.replaceAll(" ", "\u00a0")}\u00a0`;
  // Rounded Powerline caps require glyph support from the terminal or its font.
  const badge = `${edge}\uE0B6${body}${padded}${resetFill}${edge}\uE0B4\x1b[39m`;
  return asCodeSpan(href && caps.hyperlinks ? hyperlink(badge, href) : badge);
}

function renderFileLabel(label: string, href: string, theme: Theme, inlineCode: boolean): string {
  const text = inlineCode
    ? theme.fg("mdLink", "📄\u00a0") + theme.fg("mdCode", label)
    : theme.fg("mdLink", `📄\u00a0${label}`);
  return asCodeSpan(getCapabilities().hyperlinks ? hyperlink(text, href) : text);
}

function isEscaped(source: string, offset: number): boolean {
  let start = offset;
  while (source[start - 1] === "\\") start--;
  return (offset - start) % 2 === 1;
}

function isWrappedLink(source: string, offset: number, end: number): boolean {
  return (
    offset >= 2 &&
    source.startsWith("[[", offset - 2) &&
    source.startsWith("]]", end) &&
    source[offset - 3] !== "[" &&
    source[offset - 3] !== "!" &&
    source[end + 2] !== "]" &&
    source[end + 2] !== "(" &&
    !isEscaped(source, offset - 2)
  );
}

/** Styles prose badges and local Markdown links without changing their destinations. */
export function renderInlineMarkup(markdown: string, root: string, theme: Theme, userMessage: boolean): string {
  if (!markdown.includes("[[") && !markdown.includes("](")) return markdown;

  // Tag each occurrence so the lexer can separate prose from code, link titles, and image labels.
  let prefix = "\uE000";
  while (markdown.includes(prefix)) prefix += "\uE000";
  const starts: MarkupStart[] = [];
  let added = 0;
  const tagged = markdown.replace(
    START,
    (raw, linkedBadge: string | undefined, badge: string | undefined, offset: number) => {
      if (markdown.charCodeAt(offset - 1) === 0x1b || isEscaped(markdown, offset)) return raw;
      const marker = `${prefix}${starts.length}\uE001`;
      starts.push({ offset, end: offset + raw.length, taggedOffset: offset + added, marker, badge, linkedBadge });
      // Present `[ [[label]] ](path)` without the inner brackets to Marked.
      const replacement =
        linkedBadge !== undefined
          ? `[${marker}](`
          : badge !== undefined
            ? `[[${marker}]]`
            : `[${marker}${raw.slice(1)}`;
      added += replacement.length - raw.length;
      return replacement;
    },
  );
  if (!starts.length) return markdown;

  const untag = (text: string) =>
    text.replace(MARKER, (tag, marker: string, id: string) => {
      if (marker !== prefix) return tag;
      const { badge, linkedBadge } = starts[Number(id)];
      return linkedBadge === undefined ? (badge ?? "") : `[[${linkedBadge}]]`;
    });
  const proseBadges = new Set<number>();
  const blocked = new Set<number>();
  const replacements = new Map<number, Replacement>();
  parser.walkTokens(parser.lexer(tagged), (token) => {
    if (token.type === "text" && !token.tokens && !token.escaped) {
      for (const [, marker, id] of token.raw.matchAll(BADGE_MARKER)) {
        if (marker === prefix) proseBadges.add(Number(id));
      }
      return;
    }

    if (token.type !== "link" && token.type !== "image") return;
    for (const [, marker, id] of token.raw.matchAll(MARKER)) {
      if (marker === prefix && (token.type === "image" || starts[Number(id)].badge !== undefined))
        blocked.add(Number(id));
    }
    if (token.type !== "link") return;

    const match = /^\[(\uE000+)(\d+)\uE001/.exec(token.raw);
    if (!match || match[1] !== prefix) return;
    const id = Number(match[2]);
    const start = starts[id];
    if (!start || start.badge !== undefined || !tagged.startsWith(token.raw, start.taggedOffset)) return;
    const href = untag(token.href);
    if (!token.text.startsWith(start.marker) || !resolveLinkPath(root, href)) return;
    const { offset } = start;
    const end = offset + untag(token.raw).length;
    if (start.linkedBadge !== undefined) {
      const label = cleanBadgeLabel(start.linkedBadge);
      if (label) replacements.set(id, { offset, end, text: renderBadge(label, theme, userMessage, href) });
      return;
    }
    const parts = token.tokens;
    if (!parts) return;
    const [marker, span] = parts;
    const code =
      parts.length === 2 && marker?.type === "text" && marker.text === start.marker && span?.type === "codespan"
        ? span.text
        : undefined;
    // Leave other rich labels to Pi.
    if (code === undefined && parts.some(({ type }) => type !== "text" && type !== "escape")) return;
    const label =
      code ??
      parts
        .map((part) => ("text" in part ? part.text : ""))
        .join("")
        .slice(start.marker.length)
        .trim();
    if (!label || /[\p{Cc}\p{Zl}\p{Zp}\p{Bidi_Control}]/u.test(label)) return;
    const wrapped = isWrappedLink(markdown, offset, end);
    replacements.set(id, {
      offset: wrapped ? offset - 2 : offset,
      end: wrapped ? end + 2 : end,
      text: wrapped
        ? renderBadge(label, theme, userMessage, href)
        : renderFileLabel(label, href, theme, code !== undefined),
    });
  });

  let result = "";
  let cursor = 0;
  for (const [id, start] of starts.entries()) {
    if (blocked.has(id)) continue;
    let replacement = replacements.get(id);
    if (start.badge !== undefined && proseBadges.has(id)) {
      const label = cleanBadgeLabel(start.badge);
      if (label) replacement = { offset: start.offset, end: start.end, text: renderBadge(label, theme, userMessage) };
    }
    if (!replacement || replacement.offset < cursor) continue;
    result += markdown.slice(cursor, replacement.offset);
    if (result.endsWith("`")) result += WORD_JOINER;
    result += replacement.text;
    cursor = replacement.end;
    if (markdown[cursor] === "`") result += WORD_JOINER;
  }
  return result + markdown.slice(cursor);
}
