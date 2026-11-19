import { createHash } from "node:crypto";
import { posix, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { getMarkdownTheme, type Theme, type ThemeColor } from "@earendil-works/pi-coding-agent";
import {
  backgroundAnsi,
  type Color,
  colorToRgb,
  foregroundAnsi,
  getCapabilities,
  hyperlink,
  Markdown,
  Marked,
  rgbColor,
  stripTerminalSequences,
  truncateToWidth,
  visibleWidth,
} from "@earendil-works/pi-tui";
import { type PreviewExcerpt, renderPreviewFrame } from "./filelinks.ts";
import { createFileIndex } from "./wikilink-index.ts";

const parser = new Marked();
const wikilinks = /(?<![![])\[\[([^[\]\r\n]+)\]\](?![[\](])/g;
const taggedLinks = /\[\[(\uE000+)(\d+)\]\]/g;
const nonBreakingSpace = "\u00a0";
const wordJoiner = "\u2060";
// Round Powerline caps require glyph support from the terminal or its font.
const leftCap = "\uE0B6";
const rightCap = "\uE0B4";
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

const cardInset = 6; // Two borders and two spaces on each side.
// biome-ignore lint/suspicious/noControlCharactersInRegex: OSC 8 uses literal ESC and BEL bytes.
const osc8 = /\x1b\]8;[^\x07\x1b]*(?:\x07|\x1b\\)/g;

/** Preview metadata for a wikilink to one Markdown file. */
export interface WikiNote {
  path: string;
  color: ThemeColor;
}

/** Preview metadata for a bare filename that matches multiple Markdown files. */
interface WikiGroup {
  filename: string;
  sources: readonly string[];
  color: ThemeColor;
}

/** The file or group to show when hovering over a wikilink chip. */
export type WikiPreview = WikiNote | WikiGroup;

// biome-ignore lint/suspicious/noControlCharactersInRegex: Match the OSC 8 group ID, not its click destination.
const groupLink = /\x1b\]8;id=(pi-inline-markup-[\w-]+);[^\x07\x1b]*/g;

/** Substitutes hover IDs for click URLs in a copy of the screen line. */
export function hoverLinkLine(line: string): string {
  return line.replace(groupLink, "\x1b]8;;wiki:$1");
}

function displayPath(path: string): string {
  return stripTerminalSequences(path).replace(/[\p{Cc}\p{Zl}\p{Zp}\p{Bidi_Control}]/gu, " ");
}

function themeColorForKey(key: string): ThemeColor {
  const hash = createHash("sha256").update(key.normalize("NFC"), "utf8").digest();
  return palette[hash[0] % palette.length];
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

function renderChip(
  label: string,
  fill: Color,
  url: string | undefined,
  groupId: string | undefined,
  userBackground?: string,
): string {
  const caps = getCapabilities();
  const mode = caps.trueColor ? "truecolor" : "256color";
  const edge = foregroundAnsi(fill, mode);
  const body = backgroundAnsi(fill, mode) + foregroundAnsi(textColorForFill(fill), mode);
  const resetFill = userBackground || "\x1b[49m";
  const padded = `${nonBreakingSpace}${label.replace(/ /g, nonBreakingSpace)}${nonBreakingSpace}`;
  const chip = `${edge}${leftCap}${body}${padded}${resetFill}${edge}${rightCap}\x1b[39m`;
  // An empty OSC 8 URL leaves a group without a primary file non-clickable.
  const styled = !caps.hyperlinks
    ? chip
    : groupId
      ? `\x1b]8;id=${groupId};${url ?? ""}\x1b\\${chip}\x1b]8;;\x1b\\`
      : url
        ? hyperlink(chip, url)
        : chip;
  // An inline code span carries the ANSI through Markdown without parsing the label.
  let ticks = 1;
  for (const [run] of styled.matchAll(/`+/g)) ticks = Math.max(ticks, run.length + 1);
  const fence = "`".repeat(ticks);
  return fence + styled + fence;
}

function transformLinks(markdown: string, render: (body: string) => string | undefined): string {
  if (!markdown.includes("[[")) return markdown;

  // Match by occurrence, not label: the same text can be inside prose and code.
  let marker = "\uE000";
  while (markdown.includes(marker)) marker += "\uE000";
  let index = 0;
  const tagged = markdown.replace(wikilinks, () => `[[${marker}${index++}]]`);
  if (!index) return markdown;

  const prose = new Set<number>();
  const otherLinks = new Set<number>();
  parser.walkTokens(parser.lexer(tagged), (token) => {
    const indices =
      token.type === "link" || token.type === "image"
        ? otherLinks
        : token.type === "text" && !token.tokens && !token.escaped
          ? prose
          : undefined;
    if (!indices) return;
    for (const [, prefix, id] of token.raw.matchAll(taggedLinks)) {
      if (prefix === marker) indices.add(Number(id));
    }
  });

  index = 0;
  return markdown.replace(wikilinks, (original, body: string, offset: number) => {
    const id = index++;
    if (!prose.has(id) || otherLinks.has(id)) return original;
    const chip = render(body);
    if (chip === undefined) return original;

    // Keep the chip fence and an adjacent backtick run separate without a visible space.
    const before = markdown[offset - 1] === "`" ? wordJoiner : "";
    const after = markdown[offset + original.length] === "`" ? wordJoiner : "";
    return before + chip + after;
  });
}

function renderWikiBody(excerpt: PreviewExcerpt, theme: Theme, width: number): string[] {
  const hasFrontmatter = /^---[ \t]*\n/.test(excerpt.text);
  const bodyText = hasFrontmatter ? excerpt.text.replace(/^---[ \t]*\n[\s\S]*?^---[ \t]*(?:\n|$)/m, "") : excerpt.text;
  // Do not show frontmatter that runs past the read limit.
  if (hasFrontmatter && bodyText === excerpt.text) return [];
  const text = bodyText.replace(/^(?:[ \t]*\n)+/, "").trimEnd();
  if (!text) return [];
  const markdown = new Markdown(
    text,
    0,
    0,
    {
      ...getMarkdownTheme(),
      heading: (text) => theme.fg("text", text),
      underline: (text) => text,
      bold: (text) => theme.style(text, { bold: true }),
      linkUrl: () => "", // Keep link text, but do not show URLs in the card.
      highlightCode: undefined,
    },
    { color: (text) => theme.fg("text", text) },
    { renderLatex: false },
  );
  const lines = markdown.render(width).map((line) => line.replace(osc8, "").trimEnd());
  while (lines.length && isBlank(lines.at(-1) ?? "")) lines.pop();
  return lines;
}

function isBlank(line: string): boolean {
  return !stripTerminalSequences(line).trim();
}

function clipBody(lines: string[], clipped: boolean, theme: Theme, width: number, limit: number): string[] {
  const body = lines.slice(0, limit);
  if (clipped || lines.length > limit) {
    while (body.length && isBlank(body.at(-1) ?? "")) body.pop();
    const last = body.pop() ?? "";
    body.push(truncateToWidth(last, width - 1, "") + theme.fg("muted", "…"));
  }
  return body;
}

/** Renders one Markdown note, omitting its YAML front matter. */
export function renderWikiPreview(
  note: WikiNote,
  excerpt: PreviewExcerpt,
  theme: Theme,
  width: number,
  height: number,
): { width: number; lines: string[] } | undefined {
  const bodyWidth = width - cardInset;
  const rendered = renderWikiBody(excerpt, theme, bodyWidth);
  if (!rendered.length) return undefined;

  const caption = `${theme.fg(note.color, "▎")} ${theme.fg("muted", excerpt.filename)}`;
  const spacer = height >= 7 ? [""] : [];
  const body = clipBody(rendered, excerpt.clipped, theme, bodyWidth, height - 3 - spacer.length);
  return renderWikiCard([caption, ...spacer, ...body], theme, width);
}

/** Determines how many sources to read, reserving rows for paths and overflow. */
export function wikiGroupSourceLimit(total: number, height: number): number {
  const slots = Math.min(3, total, Math.floor((height - 3) / 2));
  return Math.max(0, slots === total ? slots : Math.min(slots, Math.floor((height - 4) / 2)));
}

/** Stacks brief excerpts in candidate order, with a count for sources not shown. */
export function renderWikiGroupPreview(
  group: WikiGroup,
  excerpts: readonly (PreviewExcerpt | undefined)[],
  theme: Theme,
  width: number,
  height: number,
): { width: number; lines: string[] } {
  const { filename, sources, color } = group;
  const count = excerpts.length;
  const remaining = sources.length - count;
  const content = [`${theme.fg(color, "▎")} ${theme.fg("muted", displayPath(filename))}`];
  const bodyWidth = width - cardInset - 2;
  if (count > 0) {
    const limit = Math.min(2, Math.floor((height - 3 - Number(remaining > 0)) / count) - 1);
    for (const [index, excerpt] of excerpts.entries()) {
      const path = displayPath(sources[index]);
      content.push(theme.fg("accent", path.includes("/") ? path : `./${path}`));
      const rendered = excerpt ? renderWikiBody(excerpt, theme, bodyWidth).filter((line) => !isBlank(line)) : [];
      const body = rendered.length
        ? clipBody(rendered, excerpt?.clipped ?? false, theme, bodyWidth, limit)
        : [theme.fg("muted", "Preview unavailable")];
      content.push(...body.map((line) => `  ${line}`));
    }
  }
  if (remaining > 0) {
    const footer =
      count === 0 ? `${remaining} matching files` : `… ${remaining} more ${remaining === 1 ? "file" : "files"}`;
    content.push(theme.fg("muted", footer));
  }
  return renderWikiCard(content, theme, width);
}

function renderWikiCard(content: string[], theme: Theme, width: number): { width: number; lines: string[] } {
  const usedWidth = Math.max(...content.map(visibleWidth)) + cardInset;
  const cardWidth = Math.min(width, Math.max(30, usedWidth));
  return { width: cardWidth, lines: renderPreviewFrame(theme, content, cardWidth, 2, true) };
}

/** Creates display-only wikilinks and tracks their previews for one session. */
export function createWikilinks(root: string, onChange: () => void) {
  const previews = new Map<string, WikiPreview>();
  const index = createFileIndex(root, () => {
    previews.clear();
    onChange();
  });
  return {
    findPreview: (href: string) => previews.get(href),
    render(markdown: string, theme: Theme, userMessage: boolean): string {
      return transformLinks(markdown, (body) => {
        const [name, alias] = body.split("|", 2);
        const target = name.replace(/\\$/, "").split("#", 1)[0].trim();
        if (!target) return undefined;
        const { path, sources } = index.find(target) ?? {};
        const filename = sources ? posix.basename(sources[0]) : undefined;
        const displayTarget = path ?? filename;
        const label = displayPath(
          alias?.trim() || (displayTarget ? posix.basename(displayTarget, ".md") : target),
        ).trim();
        if (!label) return undefined;

        const color = themeColorForKey(path ?? filename ?? target);
        const absolutePath = path ? resolve(root, path) : undefined;
        const url = absolutePath ? pathToFileURL(absolutePath).href : undefined;
        let groupId: string | undefined;
        if (sources && filename) {
          groupId = `pi-inline-markup-${Buffer.from(filename).toString("base64url")}`;
          const href = `wiki:${groupId}`;
          if (!previews.has(href)) previews.set(href, { filename, sources, color });
        } else if (url && absolutePath && /\.md$/i.test(absolutePath) && !previews.has(url)) {
          previews.set(url, { path: absolutePath, color });
        }
        const userBackground = userMessage ? theme.getBgAnsi("userMessageBg") : undefined;
        return renderChip(label, theme.colors[color], url, groupId, userBackground);
      });
    },
    dispose() {
      index.dispose();
      previews.clear();
    },
  };
}
