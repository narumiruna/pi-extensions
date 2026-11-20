import { posix, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { getMarkdownTheme, type Theme } from "@earendil-works/pi-coding-agent";
import { Markdown, stripTerminalSequences, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { type PreviewExcerpt, renderPreviewFrame } from "./filelinks.ts";
import { createFileIndex } from "./wikilink-index.ts";

const cardInset = 6; // Two borders and two spaces on each side.
// biome-ignore lint/suspicious/noControlCharactersInRegex: OSC 8 uses literal ESC and BEL bytes.
const osc8 = /\x1b\]8;[^\x07\x1b]*(?:\x07|\x1b\\)/g;

/** Preview metadata for a wikilink to one Markdown file. */
export interface WikiNote {
  path: string;
}

/** Preview metadata for a bare filename that matches multiple Markdown files. */
interface WikiGroup {
  filename: string;
  sources: readonly string[];
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
  excerpt: PreviewExcerpt,
  theme: Theme,
  width: number,
  height: number,
): { width: number; lines: string[] } | undefined {
  const bodyWidth = width - cardInset;
  const rendered = renderWikiBody(excerpt, theme, bodyWidth);
  if (!rendered.length) return undefined;

  const caption = `${theme.fg("accent", "▎")} ${theme.fg("muted", excerpt.filename)}`;
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
  const { filename, sources } = group;
  const count = excerpts.length;
  const remaining = sources.length - count;
  const content = [`${theme.fg("accent", "▎")} ${theme.fg("muted", displayPath(filename))}`];
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

interface WikiBadge {
  label: string;
  href?: string;
  groupId?: string;
}

/** Tracks wikilink targets and their previews while explicitly enabled in a session. */
export function createWikilinks(root: string, onChange: () => void) {
  const previews = new Map<string, WikiPreview>();
  const index = createFileIndex(root, () => {
    previews.clear();
    onChange();
  });
  return {
    findPreview: (href: string) => previews.get(href),
    resolve(body: string): WikiBadge | undefined {
      const [name, alias] = body.split("|", 2);
      const target = name.replace(/\\$/, "").split("#", 1)[0].trim();
      if (!target) return undefined;
      const { path, sources } = index.find(target) ?? {};
      const filename = sources ? posix.basename(sources[0]) : undefined;
      const displayTarget = path ?? filename;
      const label = alias?.trim() || (displayTarget ? posix.basename(displayTarget, ".md") : target);
      const absolutePath = path ? resolve(root, path) : undefined;
      const href = absolutePath ? pathToFileURL(absolutePath).href : undefined;
      if (sources && filename) {
        const groupId = `pi-inline-markup-${Buffer.from(filename).toString("base64url")}`;
        const key = `wiki:${groupId}`;
        if (!previews.has(key)) previews.set(key, { filename, sources });
        return { label, href, groupId };
      }
      if (href && absolutePath && /\.md$/i.test(absolutePath) && !previews.has(href)) {
        previews.set(href, { path: absolutePath });
      }
      return { label, href };
    },
    dispose() {
      index.dispose();
      previews.clear();
    },
  };
}
