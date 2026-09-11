import type { Theme } from "@earendil-works/pi-coding-agent";
import type { MarkdownTheme } from "@earendil-works/pi-tui";
import * as PiTui from "@earendil-works/pi-tui";
import { hardWrapTerminalDocument } from "../terminal-document.js";
import type { ReviewFormat } from "../types.js";
import { sanitizeDocumentText } from "./document-sanitization.js";
import type { DocumentSearchSegment, DocumentSearchSource } from "./document-search.js";
import { mermaidMarkdownTransform, supportsRichMarkdown } from "./mermaid.js";
import { getLanguageFromPath, highlightCode } from "./syntax-highlighting.js";

export const RPC_DOCUMENT_LINE_WIDTH = 120;
export const RPC_DOCUMENT_PAGE_SIZE = 8;
const MAX_MARKDOWN_REFERENCE_CELLS = 100_000;

type DocumentTheme = Pick<Theme, "fg" | "bold"> & Partial<Pick<Theme, "italic" | "underline" | "strikethrough">>;

export function createDocumentLineCache(theme: DocumentTheme, includeSearchMetadata = false) {
  let cached:
    | {
        content: string;
        formatKind: ReviewFormat["kind"];
        language: string | undefined;
        filePath: string | undefined;
        renderLatex: boolean | undefined;
        renderMermaid: boolean | undefined;
        richMarkdown: boolean;
        width: number;
        presentation: DocumentPresentation;
      }
    | undefined;
  const presentation = (content: string, format: ReviewFormat | undefined, width: number) => {
    const identity = documentFormatIdentity(format);
    if (
      cached?.content === content &&
      cached.formatKind === identity.kind &&
      cached.language === identity.language &&
      cached.filePath === identity.filePath &&
      cached.renderLatex === identity.renderLatex &&
      cached.renderMermaid === identity.renderMermaid &&
      cached.richMarkdown === identity.richMarkdown &&
      cached.width === width
    ) {
      return cached.presentation;
    }
    const next = formatDocumentPresentation(content, format, width, theme, includeSearchMetadata);
    cached = {
      content,
      formatKind: identity.kind,
      language: identity.language,
      filePath: identity.filePath,
      renderLatex: identity.renderLatex,
      renderMermaid: identity.renderMermaid,
      richMarkdown: identity.richMarkdown,
      width,
      presentation: next,
    };
    return next;
  };
  return {
    presentation,
    lines(content: string, format: ReviewFormat | undefined, width: number) {
      return presentation(content, format, width).lines;
    },
    invalidate() {
      cached = undefined;
    },
  };
}

export interface DocumentPresentation {
  lines: string[];
  /** Unpadded rows used to build the search corpus while retaining display-cell coordinates. */
  searchLines: string[];
  /** True when a rendered row continues directly into the next row without source whitespace. */
  softWrapAfter: boolean[];
  /** Ignore renderer-added indentation at the start of a continued row. */
  ignoreLeadingWhitespace: boolean[];
  /** Alternate rendered reading orders, such as independently wrapped Markdown table cells. */
  searchSources: DocumentSearchSource[];
}

export function formatDocumentLines(
  content: string,
  format: ReviewFormat | undefined,
  width: number,
  theme: DocumentTheme,
): string[] {
  return formatDocumentPresentation(content, format, width, theme, false).lines;
}

export function formatDocumentPresentation(
  content: string,
  format: ReviewFormat | undefined,
  width: number,
  theme: DocumentTheme,
  includeSearchMetadata = true,
): DocumentPresentation {
  const resolvedFormat = format ?? { kind: "text" as const };
  if (resolvedFormat.kind === "markdown") {
    const prepared = prepareMarkdownDocument(content, resolvedFormat, width, theme);
    const lines = renderMarkdownDocument(prepared, resolvedFormat, width, theme);
    const searchLines = markdownSearchLines(lines);
    if (!includeSearchMetadata) {
      return {
        lines,
        searchLines,
        softWrapAfter: lines.map(() => false),
        ignoreLeadingWhitespace: lines.map(() => false),
        searchSources: [],
      };
    }
    const referenceWidth = markdownReferenceWidth(prepared, width);
    const referenceLines = renderMarkdownDocument(prepared, resolvedFormat, referenceWidth, theme);
    const referenceSearchLines = markdownSearchLines(referenceLines);
    const boundaryLines = renderMarkdownDocument(prepared, resolvedFormat, referenceWidth + 1, theme);
    const boundarySearchLines = markdownSearchLines(boundaryLines);
    const referenceSoftWrapAfter = markdownSoftWrapAfter(
      referenceSearchLines,
      markdownReferenceText(boundarySearchLines, []),
      1,
    );
    const softWrapAfter = markdownSoftWrapAfter(
      searchLines,
      markdownReferenceText(referenceSearchLines, referenceSoftWrapAfter),
    );
    return {
      lines,
      searchLines,
      softWrapAfter,
      ignoreLeadingWhitespace: searchLines.map((_, index) => softWrapAfter[index - 1] ?? false),
      searchSources: markdownTableSearchSources(lines, referenceLines, boundaryLines),
    };
  }
  const segments = documentSegments(content, width);
  let lines: string[];
  if (resolvedFormat.kind === "code") {
    const language =
      resolvedFormat.language ?? (resolvedFormat.filePath ? getLanguageFromPath(resolvedFormat.filePath) : undefined);
    lines = segments.map(({ text }) => highlightCode(text, language, theme));
  } else if (resolvedFormat.kind === "diff") {
    lines = segments.map(({ source, text }) => {
      if (source.startsWith("@@")) return theme.fg("accent", text);
      if (source.startsWith("+") && !source.startsWith("+++")) {
        return theme.fg("toolDiffAdded", text);
      }
      if (source.startsWith("-") && !source.startsWith("---")) {
        return theme.fg("toolDiffRemoved", text);
      }
      return theme.fg("toolDiffContext", text);
    });
  } else {
    lines = segments.map(({ text }) => theme.fg("text", text));
  }
  return {
    lines,
    searchLines: lines,
    softWrapAfter: segments.map(({ softWrapAfter }) => softWrapAfter),
    ignoreLeadingWhitespace: lines.map(() => false),
    searchSources: [],
  };
}

function markdownSearchLines(lines: readonly string[]) {
  const plainLines = lines.map((line) => PiTui.stripTerminalSequences(line).trimEnd());
  const tableRowStarts = markdownTableRowStarts(plainLines);
  return plainLines.map((line, index) => {
    const tableStart = tableRowStarts[index];
    if (tableStart !== undefined) {
      const prefix = PiTui.sliceByColumn(line, 0, tableStart, true);
      const frame = markdownTableFrame(line, tableStart);
      return `${normalizeMarkdownContainerPrefix(prefix)}${frame.replace(/^│ /u, "  ").replace(/ │$/u, "")}`;
    }
    return normalizeMarkdownContainerPrefix(line);
  });
}

function normalizeMarkdownContainerPrefix(line: string) {
  return line.replace(
    /^((?:(?:\s+|(?:[-+*]|\d+[.)])\s+))*)((?:│ )+)/u,
    (_match, prefix: string, quoteBorders: string) => prefix + " ".repeat(PiTui.visibleWidth(quoteBorders)),
  );
}

function markdownTableRowStarts(lines: readonly string[]) {
  const starts: Array<number | undefined> = lines.map(() => undefined);
  for (const [index, line] of lines.entries()) {
    const tableStart = markdownTableTopStart(line);
    if (tableStart === undefined) continue;
    const rows: number[] = [];
    for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
      const frame = markdownTableFrame(lines[cursor] ?? "", tableStart);
      if (/^│ .* │$/u.test(frame)) {
        rows.push(cursor);
        continue;
      }
      if (/^├.*┤$/u.test(frame)) continue;
      if (/^└.*┘$/u.test(frame)) {
        for (const row of rows) starts[row] = tableStart;
      }
      break;
    }
  }
  return starts;
}

function markdownTableTopStart(line: string) {
  for (let index = line.indexOf("┌"); index >= 0; index = line.indexOf("┌", index + 1)) {
    const start = PiTui.visibleWidth(line.slice(0, index));
    if (/^┌.*┐$/u.test(markdownTableFrame(line, start))) return start;
  }
  return undefined;
}

function markdownTableFrame(line: string, start: number) {
  return PiTui.sliceByColumn(line, start, Math.max(0, PiTui.visibleWidth(line) - start), true);
}

function markdownTableSearchSources(
  lines: readonly string[],
  referenceLines: readonly string[],
  boundaryLines: readonly string[],
): DocumentSearchSource[] {
  const sources = markdownTableCellSources(lines);
  const referenceSources = markdownTableCellSources(referenceLines);
  const boundarySources = markdownTableCellSources(boundaryLines);
  return sources.flatMap((source, index) => {
    if (source.length < 2) return [];
    const markedReference = markTableCellSeparators(
      referenceSources[index] ?? [],
      boundarySources[index] ?? [],
      false,
      1,
    );
    return [markTableCellSeparators(source, markedReference, true)];
  });
}

function markdownTableCellSources(lines: readonly string[]) {
  const plainLines = lines.map((line) => PiTui.stripTerminalSequences(line).trimEnd());
  const tableRowStarts = markdownTableRowStarts(plainLines);
  const sources: DocumentSearchSource[] = [];
  for (let index = 0; index < plainLines.length; ) {
    const tableStart = tableRowStarts[index];
    if (tableStart === undefined) {
      index += 1;
      continue;
    }
    const boundaries = markdownTableBoundaries(plainLines, index, tableStart);
    const rows: ReturnType<typeof markdownTableCells>[] = [];
    while (index < plainLines.length && tableRowStarts[index] === tableStart) {
      rows.push(markdownTableCells(plainLines[index] ?? "", index, boundaries));
      index += 1;
    }
    const columnCount = Math.max(0, ...rows.map((row) => row.length));
    for (let column = 0; column < columnCount; column += 1) {
      sources.push(
        rows.flatMap((row) => {
          const segment = row[column];
          return segment ? [segment] : [];
        }),
      );
    }
  }
  return sources;
}

function markTableCellSeparators(
  source: DocumentSearchSource,
  referenceSource: DocumentSearchSource,
  referenceHasMetadata: boolean,
  rightLimit = 16,
): DocumentSearchSource {
  const reference = referenceSource
    .map((segment, index) => {
      const separator = index === 0 || (referenceHasMetadata && !segment.separatorBefore) ? "" : "\n";
      return `${separator}${segment.text}`;
    })
    .join("");
  let referenceOffset = 0;
  return source.map((segment, index) => {
    if (index === 0) return segment;
    const previous = source[index - 1];
    const left = Array.from(previous?.text ?? "")
      .slice(-16)
      .join("");
    const right = Array.from(segment.text).slice(0, rightLimit).join("");
    const leftIndex = reference.indexOf(left, referenceOffset);
    if (leftIndex >= 0) referenceOffset = leftIndex + left.length;
    return {
      ...segment,
      separatorBefore: leftIndex < 0 || !reference.startsWith(right, referenceOffset),
    };
  });
}

function markdownTableBoundaries(lines: readonly string[], rowIndex: number, tableStart: number) {
  let borderIndex = rowIndex - 1;
  while (borderIndex >= 0 && /^│ .* │$/u.test(markdownTableFrame(lines[borderIndex] ?? "", tableStart))) {
    borderIndex -= 1;
  }
  const border = lines[borderIndex] ?? "";
  const boundaries: number[] = [];
  let column = 0;
  for (const character of border) {
    if (/^[┌├└┬┼┴┐┤┘]$/u.test(character)) boundaries.push(column);
    column += PiTui.visibleWidth(character);
  }
  return boundaries;
}

function markdownTableCells(line: string, row: number, boundaries: readonly number[]) {
  const cells: Array<DocumentSearchSegment | undefined> = [];
  for (let index = 0; index < boundaries.length - 1; index += 1) {
    const start = (boundaries[index] ?? 0) + 1;
    const end = boundaries[index + 1] ?? start;
    const raw = PiTui.sliceByColumn(line, start, Math.max(0, end - start), true);
    const leading = /^\s*/u.exec(raw)?.[0] ?? "";
    const text = raw.trim();
    if (text) {
      cells.push({
        row,
        column: start + PiTui.visibleWidth(leading),
        text,
      });
    } else cells.push(undefined);
  }
  return cells;
}

function markdownReferenceWidth(content: string, width: number) {
  const sourceLines = content.split("\n");
  const widestSourceLine = sourceLines.reduce((widest, line) => Math.max(widest, PiTui.visibleWidth(line)), 0);
  const budgetedWidth = Math.max(1, Math.floor(MAX_MARKDOWN_REFERENCE_CELLS / Math.max(1, sourceLines.length)));
  return Math.max(1, width, Math.min(widestSourceLine + 32, budgetedWidth));
}

function markdownSoftWrapAfter(lines: readonly string[], reference: string, rightLimit = 16) {
  let referenceOffset = 0;
  return lines.map((line, index) => {
    const next = lines[index + 1];
    if (next === undefined) return false;
    const left = Array.from(line.trim()).slice(-16).join("");
    const right = Array.from(next.trim()).slice(0, rightLimit).join("");
    if (!left || !right) return false;
    const leftIndex = reference.indexOf(left, referenceOffset);
    if (leftIndex < 0) return false;
    referenceOffset = leftIndex + left.length;
    return reference.startsWith(right, referenceOffset);
  });
}

function markdownReferenceText(lines: readonly string[], softWrapAfter: readonly boolean[]) {
  return lines.map((line, index) => `${line.trim()}${softWrapAfter[index] ? "" : "\n"}`).join("");
}

export function plainDocumentLines(content: string, width: number): string[] {
  return documentSegments(content, width).map(({ text }) => text);
}

function prepareMarkdownDocument(
  content: string,
  format: Extract<ReviewFormat, { kind: "markdown" }>,
  width: number,
  theme: DocumentTheme,
) {
  const safe = sanitizeDocumentText(content);
  const transform = format.renderMermaid === false ? undefined : mermaidMarkdownTransform(theme);
  return transform?.(safe, Math.max(1, width)) ?? safe;
}

function renderMarkdownDocument(
  content: string,
  format: Extract<ReviewFormat, { kind: "markdown" }>,
  width: number,
  theme: DocumentTheme,
): string[] {
  const component = new PiTui.Markdown(
    content,
    0,
    0,
    markdownTheme(theme),
    { color: (text) => theme.fg("text", text) },
    { renderLatex: format.renderLatex ?? true },
  );
  return component.render(Math.max(1, width));
}

function markdownTheme(theme: DocumentTheme): MarkdownTheme {
  return {
    heading: (text) => theme.fg("mdHeading", text),
    link: (text) => theme.fg("mdLink", text),
    linkUrl: (text) => theme.fg("mdLinkUrl", text),
    code: (text) => theme.fg("mdCode", text),
    codeBlock: (text) => theme.fg("mdCodeBlock", text),
    codeBlockBorder: (text) => theme.fg("mdCodeBlockBorder", text),
    quote: (text) => theme.fg("mdQuote", text),
    quoteBorder: (text) => theme.fg("mdQuoteBorder", text),
    hr: (text) => theme.fg("mdHr", text),
    listBullet: (text) => theme.fg("mdListBullet", text),
    bold: (text) => theme.bold(text),
    italic: (text) => theme.italic?.(text) ?? text,
    underline: (text) => theme.underline?.(text) ?? text,
    strikethrough: (text) => theme.strikethrough?.(text) ?? text,
    highlightCode: (code, language) => code.split("\n").map((line) => highlightCode(line, language, theme)),
  };
}

export function documentDialogPages(content: string, width: number, pageSize: number): string[][] {
  const lines = plainDocumentLines(content, width);
  const safePageSize = Math.max(1, Math.floor(pageSize));
  const pages: string[][] = [];
  for (let index = 0; index < lines.length; index += safePageSize) {
    pages.push(lines.slice(index, index + safePageSize));
  }
  return pages.length > 0 ? pages : [[""]];
}

function documentFormatIdentity(format: ReviewFormat | undefined) {
  const shared = {
    renderLatex: undefined,
    renderMermaid: undefined,
    richMarkdown: supportsRichMarkdown(),
  };
  if (format?.kind === "code") {
    return { ...shared, kind: format.kind, language: format.language, filePath: format.filePath };
  }
  if (format?.kind === "diff") {
    return { ...shared, kind: format.kind, language: undefined, filePath: format.filePath };
  }
  if (format?.kind === "markdown") {
    return {
      ...shared,
      kind: format.kind,
      language: undefined,
      filePath: undefined,
      renderLatex: format.renderLatex ?? true,
      renderMermaid: format.renderMermaid ?? true,
    };
  }
  return { ...shared, kind: "text" as const, language: undefined, filePath: undefined };
}

function documentSegments(content: string, width: number) {
  return sanitizeDocumentText(content)
    .split("\n")
    .flatMap((source) => {
      const wrapped = hardWrapTerminalDocument(source, width);
      return wrapped.map((text, index) => ({
        source,
        text,
        softWrapAfter: index < wrapped.length - 1,
      }));
    });
}
