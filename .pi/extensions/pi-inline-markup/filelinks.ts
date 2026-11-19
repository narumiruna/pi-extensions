import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { basename, isAbsolute, relative, resolve, sep } from "node:path";
import { getMarkdownTheme, type Theme } from "@earendil-works/pi-coding-agent";
import { Markdown, stripTerminalSequences, truncateToWidth } from "@earendil-works/pi-tui";

const MAX_BYTES = 16 * 1024;
const MAX_LINE_SCAN_BYTES = 256 * 1024;
// biome-ignore lint/suspicious/noControlCharactersInRegex: OSC 8 uses ESC and BEL.
const OSC_8 = /\x1b\]8;[^\x07\x1b]*(?:\x07|\x1b\\)/g;

export interface LineRange {
  start: number;
  end: number;
}

export interface PreviewExcerpt {
  filename: string;
  text: string;
  clipped: boolean;
  lineRange?: LineRange;
}

function workspacePath(root: string, path: string): string | undefined {
  const local = relative(root, path);
  if (!local || isAbsolute(local)) return undefined;
  if (local.split(sep).some((part) => part.startsWith(".") || part === "node_modules")) return undefined;
  return local;
}

export function resolveLinkPath(root: string, href: string): string | undefined {
  // Interpret Markdown destinations as filesystem paths, not as URLs to fetch.
  // Leave URI schemes (including file:) and protocol-relative links to Pi.
  const invalid = /[\\\p{Cc}\p{Zl}\p{Zp}\p{Bidi_Control}]/u;
  if (invalid.test(href)) return undefined;
  const [encoded] = href.split(/[?#]/, 1);
  try {
    const path = decodeURIComponent(encoded);
    if (!path || path.startsWith("//") || invalid.test(path)) return undefined;
    if (/^[a-z][a-z\d+.-]*:/i.test(path) && !isAbsolute(path)) return undefined;
    const target = resolve(root, path);
    return workspacePath(root, target) ? target : undefined;
  } catch {
    return undefined; // Malformed percent escape.
  }
}

export function parseLineRange(href: string): LineRange | undefined {
  const match = /#L([1-9]\d*)(?:-L?([1-9]\d*))?$/.exec(href);
  if (!match || match.index !== href.indexOf("#")) return undefined;
  const start = Number(match[1]);
  const end = match[2] ? Number(match[2]) : start;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || end < start) return undefined;
  return { start, end };
}

function selectLines(
  bytes: Buffer,
  { start, end }: LineRange,
  moreBytes: boolean,
): { bytes: Buffer; clipped: boolean } | undefined {
  let line = 1;
  let offset = 0;
  let from = 0;
  while (offset < bytes.length) {
    const byte = bytes[offset++];
    if (byte !== 10 && byte !== 13) continue;
    if (byte === 13 && bytes[offset] === 10) offset++;
    if (line === end) {
      return { bytes: bytes.subarray(from, Math.min(offset, from + MAX_BYTES)), clipped: offset - from > MAX_BYTES };
    }
    if (++line === start) from = offset;
  }
  if (line < start || from === bytes.length) return undefined;
  return {
    bytes: bytes.subarray(from, from + MAX_BYTES),
    clipped: moreBytes || bytes.length - from > MAX_BYTES,
  };
}

export async function readExcerpt(
  root: string,
  path: string,
  signal: AbortSignal,
  lineRange?: LineRange,
): Promise<PreviewExcerpt | undefined> {
  try {
    const local = workspacePath(root, path);
    if (!local || signal.aborted) return undefined;
    const project = await realpath(root);
    if (signal.aborted) return undefined;
    const candidate = resolve(project, local);
    if ((await realpath(candidate)) !== candidate || signal.aborted) return undefined;
    if (!(await lstat(candidate)).isFile() || signal.aborted) return undefined;

    const file = await open(candidate, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
    try {
      if (signal.aborted) return undefined;
      const stat = await file.stat();
      if (signal.aborted || !stat.isFile()) return undefined;
      const buffer = Buffer.alloc(Math.min(stat.size, lineRange ? MAX_LINE_SCAN_BYTES : MAX_BYTES));
      const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
      if (signal.aborted) return undefined;
      const bytes = buffer.subarray(0, bytesRead);
      const moreBytes = stat.size > bytesRead;
      const excerpt = lineRange ? selectLines(bytes, lineRange, moreBytes) : { bytes, clipped: moreBytes };
      if (!excerpt) return undefined;
      const { clipped } = excerpt;
      const text = new TextDecoder("utf-8", { fatal: true }).decode(excerpt.bytes, { stream: clipped });
      if (text.includes("\0")) return undefined;
      const clean = stripTerminalSequences(text)
        .replace(/\r\n?/g, "\n")
        .replace(/[\p{Zl}\p{Zp}]/gu, " ")
        .replace(/(?![\n\t])[\p{Cc}\p{Bidi_Control}]/gu, "");
      return {
        filename: basename(candidate).replace(/[\p{Cc}\p{Zl}\p{Zp}\p{Bidi_Control}]/gu, " "),
        text: clean,
        clipped,
        lineRange,
      };
    } finally {
      await file.close();
    }
  } catch {
    // A file can be missing, unreadable, or not UTF-8.
    return undefined;
  }
}

export function renderFilePreview(theme: Theme, excerpt: PreviewExcerpt, width: number, height: number): string[] {
  if (width < 5 || height < 4) return [];
  const contentWidth = width - 4;
  // Anchors refer to source lines, not to the rendered Markdown document.
  const markdown = !excerpt.lineRange && /\.(md|markdown)$/i.test(excerpt.filename);
  const lines = markdown
    ? new Markdown(
        excerpt.text,
        0,
        0,
        { ...getMarkdownTheme(), linkUrl: () => "", highlightCode: undefined },
        { color: (text) => theme.fg("text", text) },
        { renderLatex: false },
      )
        .render(contentWidth)
        .map((line) => line.replace(OSC_8, ""))
    : excerpt.text
        .replace(/\n$/, "")
        .split("\n")
        .map((line) => line.replaceAll("\t", "    "));
  const limit = height - 3;
  const body = lines.slice(0, limit);
  if (excerpt.clipped || lines.length > limit) {
    const last = body.pop() ?? "";
    body.push(truncateToWidth(last, contentWidth - 1, "") + theme.fg("muted", "…"));
  }
  const { filename, lineRange } = excerpt;
  const caption = lineRange
    ? `${filename}#L${lineRange.start}${lineRange.end === lineRange.start ? "" : `-L${lineRange.end}`}`
    : filename;
  const border = (text: string) => theme.fg("borderMuted", text);
  const edge = "─".repeat(width - 2);
  const rows = [theme.fg("accent", caption), ...body].map(
    (text) => `${border("│")} ${truncateToWidth(text, contentWidth, "…", true)} ${border("│")}`,
  );
  const background = theme.getBgAnsi("toolPendingBg");
  // Truncation adds full SGR resets before the ellipsis and padding.
  return [border(`┌${edge}┐`), ...rows, border(`└${edge}┘`)].map((line) =>
    theme.bg("toolPendingBg", line.replaceAll("\x1b[0m", `\x1b[0m${background}`)),
  );
}
