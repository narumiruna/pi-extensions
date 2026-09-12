import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { ContentMatchRange, ContentSearchMatch } from "./content-search.js";

export const CONTENT_SEARCH_CARD_ROWS = 3;

interface ContentSearchScreenOptions {
  theme: Theme;
  width: number;
  availableRows: number;
  queryLine: string;
  query: string;
  cwd?: string;
  matches: readonly ContentSearchMatch[];
  selectedIndex: number;
  scrollOffset: number;
  caseSensitive: boolean;
  fuzzy: boolean;
  loading: boolean;
  opening: boolean;
  truncated: boolean;
  skippedFiles: number;
  error?: string;
}

export function contentSearchCardCapacity(availableRows: number): number {
  return Math.max(1, Math.floor((availableRows - 4) / CONTENT_SEARCH_CARD_ROWS));
}

export function renderContentSearchScreen(options: ContentSearchScreenOptions): string[] {
  const { theme, width, availableRows } = options;
  const capacity = contentSearchCardCapacity(availableRows);
  const cwdLabel = options.cwd ? ` · cwd: ${escapeTerminalControls(options.cwd)}` : "";
  const title = theme.fg("accent", theme.bold(`File Context · Content Search${cwdLabel}`));
  const modes = theme.fg(
    "muted",
    `Case: ${options.caseSensitive ? "on" : "off"} · Fuzzy: ${options.fuzzy ? "on" : "off"} · Alt+C case · Alt+F fuzzy`,
  );
  const body: string[] = [];

  if (options.error) {
    body.push(theme.fg("error", `  Search failed: ${escapeTerminalControls(options.error)}`));
  } else if (options.loading) {
    body.push(theme.fg("warning", "  Searching…"));
  } else if (!options.query.trim()) {
    body.push(theme.fg("muted", "  Type text to search project contents"));
  } else if (options.matches.length === 0) {
    body.push(
      theme.fg(
        "muted",
        `  No matches for "${escapeTerminalControls(options.query)}"${options.fuzzy ? "" : " · Alt+F enables fuzzy matching"}`,
      ),
    );
  } else {
    const visible = options.matches.slice(options.scrollOffset, options.scrollOffset + capacity);
    for (let visibleIndex = 0; visibleIndex < visible.length; visibleIndex += 1) {
      const index = options.scrollOffset + visibleIndex;
      const match = visible[visibleIndex];
      if (match) {
        body.push(...renderContentSearchCard(match, index === options.selectedIndex, width, theme));
      }
    }
  }

  const count = `${options.matches.length}${options.truncated ? "+" : ""} matches`;
  const skipped = options.skippedFiles > 0 ? ` · ${options.skippedFiles} skipped` : "";
  const action = options.opening
    ? "Opening…"
    : `${count}${skipped} · ↑↓ navigate · Enter preview · Tab reference · Ctrl+F files · Esc cancel`;
  return fitRows(
    [
      truncateToWidth(title, width, ""),
      truncateToWidth(options.queryLine, width, ""),
      truncateToWidth(modes, width, ""),
      ...body.map((line) => truncateToWidth(line, width, "")),
      truncateToWidth(theme.fg(options.opening ? "warning" : "muted", action), width, ""),
    ],
    availableRows,
  );
}

export function highlightContentRanges(line: string, ranges: readonly ContentMatchRange[], theme: Theme): string {
  let result = "";
  let index = 0;
  for (const range of ranges) {
    const start = Math.max(index, Math.min(line.length, range.start));
    const end = Math.max(start, Math.min(line.length, range.end));
    result += escapeTerminalControls(line.slice(index, start));
    result += theme.fg("warning", theme.bold(escapeTerminalControls(line.slice(start, end))));
    index = end;
  }
  return result + escapeTerminalControls(line.slice(index));
}

function renderContentSearchCard(match: ContentSearchMatch, selected: boolean, width: number, theme: Theme): string[] {
  if (width < 8) {
    return [truncateToWidth(`${selected ? ">" : " "}${escapeTerminalControls(match.path)}`, width, "")];
  }
  const prefix = selected ? theme.fg("accent", "> ") : "  ";
  const cardWidth = Math.max(4, width - visibleWidth(prefix));
  const innerWidth = Math.max(1, cardWidth - 2);
  const borderColor = selected ? "borderAccent" : "borderMuted";
  const border = (text: string) => theme.fg(borderColor, text);
  const rawTitle = ` ${escapeTerminalControls(match.path)} · L${match.lineNumber} `;
  const title = truncateToWidth(rawTitle, innerWidth, "");
  const titleFill = "─".repeat(Math.max(0, innerWidth - visibleWidth(title)));
  const context = clipMatchContext(match, Math.max(1, innerWidth - 1));
  const highlighted = highlightContentRanges(context.line, context.ranges, theme);
  const content = truncateToWidth(` ${highlighted}`, innerWidth, "");
  const contentFill = " ".repeat(Math.max(0, innerWidth - visibleWidth(content)));
  const contentLine = `${border("│")}${content}${contentFill}${border("│")}`;
  return [
    `${prefix}${border("╭")}${title}${border(`${titleFill}╮`)}`,
    `${" ".repeat(visibleWidth(prefix))}${selected ? theme.bg("selectedBg", contentLine) : contentLine}`,
    `${" ".repeat(visibleWidth(prefix))}${border(`╰${"─".repeat(innerWidth)}╯`)}`,
  ];
}

function clipMatchContext(
  match: ContentSearchMatch,
  maxCharacters: number,
): { line: string; ranges: ContentMatchRange[] } {
  const firstStart = match.ranges[0]?.start ?? 0;
  const lastEnd = match.ranges.at(-1)?.end ?? firstStart;
  const matchSpan = Math.max(1, lastEnd - firstStart);
  const before = Math.max(0, Math.floor((maxCharacters - Math.min(matchSpan, maxCharacters)) / 3));
  const rawStart = Math.max(0, firstStart - before);
  const prefix = rawStart > 0 ? "…" : "";
  const availableRawCharacters = Math.max(1, maxCharacters - prefix.length - 1);
  let rawEnd = Math.min(match.line.length, rawStart + availableRawCharacters);
  if (rawEnd < lastEnd) rawEnd = Math.min(match.line.length, lastEnd);
  const suffix = rawEnd < match.line.length ? "…" : "";
  const line = `${prefix}${match.line.slice(rawStart, rawEnd)}${suffix}`;
  const ranges = match.ranges.flatMap((range): ContentMatchRange[] => {
    const start = Math.max(rawStart, range.start);
    const end = Math.min(rawEnd, range.end);
    return end > start ? [{ start: prefix.length + start - rawStart, end: prefix.length + end - rawStart }] : [];
  });
  return { line, ranges };
}

function fitRows(lines: string[], height: number): string[] {
  if (lines.length <= height) return lines;
  if (height <= 1) return lines.slice(0, 1);
  return [...lines.slice(0, height - 1), lines.at(-1) ?? ""];
}

function escapeTerminalControls(text: string): string {
  return [...text]
    .map((character) => {
      if (character === "\t") return "    ";
      const code = character.charCodeAt(0);
      if (code <= 31 || (code >= 127 && code <= 159)) {
        return `\\x${code.toString(16).padStart(2, "0")}`;
      }
      return character;
    })
    .join("");
}
