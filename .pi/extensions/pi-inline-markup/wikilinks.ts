import { createHash } from "node:crypto";
import type { Dirent } from "node:fs";
import { readdir } from "node:fs/promises";
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

const parser = new Marked();
const wikilinks = /(?<![![])\[\[([^[\]\r\n]+)\]\](?![[\](])/g;
const taggedLinks = /\[\[(\uE000+)(\d+)\]\]/g;
const nonBreakingSpace = "\u00a0";
const wordJoiner = "\u2060";
// Ghostty-based renderers draw these Powerline caps to the full cell height.
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

export interface WikiNote {
  path: string;
  color: ThemeColor;
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

function renderChip(label: string, fill: Color, url: string | undefined, userBackground?: string): string {
  const caps = getCapabilities();
  const mode = caps.trueColor ? "truecolor" : "256color";
  const edge = foregroundAnsi(fill, mode);
  const body = backgroundAnsi(fill, mode) + foregroundAnsi(textColorForFill(fill), mode);
  const resetFill = userBackground || "\x1b[49m";
  const padded = `${nonBreakingSpace}${label.replace(/ /g, nonBreakingSpace)}${nonBreakingSpace}`;
  const terminal = process.env.TERM_PROGRAM?.toLowerCase();
  const rounded = terminal === "rex" || terminal === "ghostty";
  const chip = rounded
    ? `${edge}${leftCap}${body}${padded}${resetFill}${edge}${rightCap}\x1b[39m`
    : `${body}${padded}${resetFill}\x1b[39m`;
  const styled = url && caps.hyperlinks ? hyperlink(chip, url) : chip;
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

export function renderWikiPreview(
  note: WikiNote,
  excerpt: PreviewExcerpt,
  theme: Theme,
  width: number,
  height: number,
): { width: number; lines: string[] } | undefined {
  const hasFrontmatter = /^---[ \t]*\n/.test(excerpt.text);
  const bodyText = hasFrontmatter ? excerpt.text.replace(/^---[ \t]*\n[\s\S]*?^---[ \t]*(?:\n|$)/m, "") : excerpt.text;
  // Do not show frontmatter that runs past the read limit.
  if (hasFrontmatter && bodyText === excerpt.text) return undefined;
  const text = bodyText.replace(/^(?:[ \t]*\n)+/, "").trimEnd();
  if (!text) return undefined;

  const caption = `${theme.fg(note.color, "▎")} ${theme.fg("muted", excerpt.filename)}`;
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
  const rendered = markdown.render(width - cardInset).map((line) => line.replace(osc8, "").trimEnd());
  while (rendered.length && !stripTerminalSequences(rendered.at(-1) ?? "").trim()) rendered.pop();

  const spacer = height >= 7 ? [""] : [];
  const limit = height - 3 - spacer.length;
  const body = rendered.slice(0, limit);
  if (excerpt.clipped || rendered.length > limit) {
    while (body.length && !stripTerminalSequences(body.at(-1) ?? "").trim()) body.pop();
    const last = body.pop() ?? "";
    body.push(truncateToWidth(last, width - cardInset - 1, "") + theme.fg("muted", "…"));
  }

  const content = [caption, ...spacer, ...body];
  const usedWidth = Math.max(...content.map(visibleWidth)) + cardInset;
  const cardWidth = Math.min(width, Math.max(30, usedWidth));
  return { width: cardWidth, lines: renderPreviewFrame(theme, content, cardWidth, 2, true) };
}

export function createWikilinks(root: string, onChange: () => void) {
  const notes = new Map<string, WikiNote>();
  const index = createFileIndex(root, () => {
    notes.clear();
    onChange();
  });
  return {
    findPreview: (href: string) => notes.get(href),
    render(markdown: string, theme: Theme, userMessage: boolean): string {
      return transformLinks(markdown, (body) => {
        const [name, alias] = body.split("|", 2);
        const target = name.replace(/\\$/, "").split("#", 1)[0].trim();
        if (!target) return undefined;
        const path = index.find(target);
        const label = (alias?.trim() || (path ? posix.basename(path, ".md") : target))
          .replace(/[\p{Cc}\p{Zl}\p{Zp}\p{Bidi_Control}]/gu, " ")
          .trim();
        if (!label) return undefined;

        const color = themeColorForKey(path ?? target);
        let url: string | undefined;
        if (path) {
          const absolutePath = resolve(root, path);
          url = pathToFileURL(absolutePath).href;
          if (/\.md$/i.test(path) && !notes.has(url)) notes.set(url, { path: absolutePath, color });
        }
        const userBackground = userMessage ? theme.getBgAnsi("userMessageBg") : undefined;
        return renderChip(label, theme.colors[color], url, userBackground);
      });
    },
    dispose() {
      index.dispose();
      notes.clear();
    },
  };
}

const refreshIntervalMs = 5_000;

async function scanFiles(root: string, signal: AbortSignal): Promise<Set<string>> {
  const paths = new Set<string>();
  const directories = [""];
  for (const directory of directories) {
    if (signal.aborted) return paths;
    let entries: Dirent[];
    try {
      entries = await readdir(resolve(root, directory), { withFileTypes: true });
    } catch {
      // A directory can disappear during a scan. Retry it in the next snapshot.
      continue;
    }
    if (signal.aborted) return paths;
    for (const entry of entries) {
      if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
      const path = posix.join(directory, entry.name);
      if (entry.isDirectory()) {
        directories.push(path);
      } else if (entry.isFile()) {
        paths.add(path);
      }
    }
  }
  return paths;
}

interface FileIndex {
  find(target: string): string | undefined;
  dispose(): void;
}

function samePaths(previous: Set<string>, next: Set<string>): boolean {
  if (previous.size !== next.size) return false;
  for (const path of next) {
    if (!previous.has(path)) return false;
  }
  return true;
}

export function createFileIndex(root: string, onChange: () => void): FileIndex {
  const controller = new AbortController();
  let paths = new Set<string>();
  let names = new Map<string, string | undefined>();
  let started = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  async function refresh(): Promise<void> {
    const next = await scanFiles(root, controller.signal);
    if (controller.signal.aborted) return;
    timer = setTimeout(() => void refresh(), refreshIntervalMs).unref();
    if (samePaths(paths, next)) return;

    paths = next;
    names = new Map();
    for (const path of paths) {
      const name = posix.basename(path);
      names.set(name, names.has(name) ? undefined : path);
    }
    onChange();
  }

  return {
    find(target) {
      const path = target.replace(/^\.\//, "");
      if (controller.signal.aborted || !path || /[\\\p{Cc}]/u.test(path)) return undefined;
      if (!started) {
        started = true;
        void refresh();
      }
      const note = `${path}.md`;
      if (paths.has(path)) return path;
      if (paths.has(note)) return note;
      return path.includes("/") ? undefined : (names.get(path) ?? names.get(note));
    },
    dispose() {
      controller.abort();
      clearTimeout(timer);
    },
  };
}
