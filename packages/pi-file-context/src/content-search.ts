const MAX_CONTENT_QUERY_LENGTH = 256;
const DEFAULT_MAX_RESULTS = 100;

export interface ContentMatchRange {
  start: number;
  end: number;
}

export interface ContentSearchMatch {
  path: string;
  lineNumber: number;
  line: string;
  ranges: ContentMatchRange[];
  fuzzy: boolean;
}

export interface ContentSearchResult {
  matches: ContentSearchMatch[];
  truncated: boolean;
  skippedFiles: number;
}

export interface ContentSearchOptions {
  caseSensitive?: boolean;
  fuzzy?: boolean;
  maxResults?: number;
  signal?: AbortSignal;
}

interface SearchableTextFile {
  path: string;
  lines: readonly string[];
}

type IndexedCharacter = { start: number; end: number; comparable: string };

type LoadSearchableFile = (path: string, signal?: AbortSignal) => Promise<SearchableTextFile>;

export async function searchProjectContents(
  files: readonly string[],
  loadFile: LoadSearchableFile,
  query: string,
  options: ContentSearchOptions = {},
): Promise<ContentSearchResult> {
  const signal = options.signal;
  signal?.throwIfAborted();
  if (!query.trim() || query.length > MAX_CONTENT_QUERY_LENGTH) {
    return { matches: [], truncated: false, skippedFiles: 0 };
  }

  const maxResults = Math.max(1, options.maxResults ?? DEFAULT_MAX_RESULTS);
  const caseSensitive = options.caseSensitive ?? false;
  const literalExpression = new RegExp(escapeRegExp(query), caseSensitive ? "g" : "gi");
  const fuzzyQuery = options.fuzzy ? indexedCharacters(query, caseSensitive) : [];
  const matches: ContentSearchMatch[] = [];
  let truncated = false;
  let skippedFiles = 0;

  for (const path of files) {
    signal?.throwIfAborted();
    let file: SearchableTextFile;
    try {
      file = await loadFile(path, signal);
    } catch (error: unknown) {
      if (isAbortError(error) || signal?.aborted) throw error;
      skippedFiles += 1;
      continue;
    }
    signal?.throwIfAborted();

    for (let lineIndex = 0; lineIndex < file.lines.length; lineIndex += 1) {
      const line = file.lines[lineIndex] ?? "";
      const literalRanges = findLiteralRanges(line, literalExpression);
      if (literalRanges.length > 0) {
        if (matches.length < maxResults) {
          matches.push({
            path: file.path,
            lineNumber: lineIndex + 1,
            line,
            ranges: literalRanges,
            fuzzy: false,
          });
        } else {
          truncated = true;
        }
        continue;
      }

      if (!options.fuzzy) continue;
      const fuzzyRanges = findSubsequenceRanges(line, fuzzyQuery, caseSensitive);
      if (!fuzzyRanges) continue;
      if (matches.length < maxResults) {
        matches.push({
          path: file.path,
          lineNumber: lineIndex + 1,
          line,
          ranges: fuzzyRanges,
          fuzzy: true,
        });
      } else {
        truncated = true;
      }
    }
  }

  return { matches, truncated, skippedFiles };
}

function findLiteralRanges(line: string, expression: RegExp): ContentMatchRange[] {
  const ranges: ContentMatchRange[] = [];
  expression.lastIndex = 0;
  for (let match = expression.exec(line); match; match = expression.exec(line)) {
    const start = match.index;
    ranges.push({ start, end: start + match[0].length });
  }
  return ranges;
}

function findSubsequenceRanges(
  line: string,
  queryCharacters: readonly IndexedCharacter[],
  caseSensitive: boolean,
): ContentMatchRange[] | undefined {
  const lineCharacters = indexedCharacters(line, caseSensitive);
  const positions: Array<{ start: number; end: number }> = [];
  let queryIndex = 0;
  for (let lineIndex = 0; lineIndex < lineCharacters.length && queryIndex < queryCharacters.length; lineIndex += 1) {
    const lineCharacter = lineCharacters[lineIndex];
    const queryCharacter = queryCharacters[queryIndex];
    if (!lineCharacter || !queryCharacter || lineCharacter.comparable !== queryCharacter.comparable) {
      continue;
    }
    positions.push({ start: lineCharacter.start, end: lineCharacter.end });
    queryIndex += 1;
  }
  if (queryIndex !== queryCharacters.length) return undefined;

  const ranges: ContentMatchRange[] = [];
  for (const position of positions) {
    const previous = ranges.at(-1);
    if (previous?.end === position.start) previous.end = position.end;
    else ranges.push(position);
  }
  return ranges;
}

function indexedCharacters(value: string, caseSensitive: boolean): IndexedCharacter[] {
  const characters: IndexedCharacter[] = [];
  for (let start = 0; start < value.length; ) {
    const codePoint = value.codePointAt(start);
    if (codePoint === undefined) break;
    const character = String.fromCodePoint(codePoint);
    const end = start + character.length;
    characters.push({
      start,
      end,
      comparable: caseSensitive ? character : character.toLowerCase(),
    });
    start = end;
  }
  return characters;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}
