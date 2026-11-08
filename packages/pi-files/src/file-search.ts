import { safeTerminalText } from "./file-browser.js";

const MAX_SEARCH_QUERY_LENGTH = 256;
const MAX_SEARCH_QUERY_PARTS = 8;
const PATH_SCORE_PENALTY = 50;
const PREFIX_SCORE = 100;
const SUBSTRING_SCORE = 200;
const TYPO_SCORE = 300;
const SUBSEQUENCE_SCORE = 400;
const TOKENIZED_SCORE = 500;
const NO_MATCH = Number.POSITIVE_INFINITY;
const PATH_PART_SEPARATOR = /[/._\-\s]+/u;

interface ProjectFileEntry {
  path: string;
  normalizedPath: string;
  normalizedBasename: string;
  basenameParts: readonly string[];
  pathParts: readonly string[];
  originalIndex: number;
}

interface RankedProjectFile {
  path: string;
  score: number;
  originalIndex: number;
}

type TypoDistanceCache = Map<string, Map<string, number | undefined>>;

export class ProjectFileSearch {
  private readonly files: readonly string[];
  private readonly entries: readonly ProjectFileEntry[];

  constructor(files: readonly string[]) {
    this.files = [...files];
    this.entries = this.files.map((path, originalIndex) => {
      const normalizedPath = safeTerminalText(path).toLowerCase();
      const normalizedBasename = normalizedPath.slice(normalizedPath.lastIndexOf("/") + 1);
      return {
        path,
        normalizedPath,
        normalizedBasename,
        basenameParts: splitPathParts(normalizedBasename),
        pathParts: splitPathParts(normalizedPath),
        originalIndex,
      };
    });
  }

  search(query: string): string[] {
    const trimmedQuery = safeTerminalText(query).trim();
    if (!trimmedQuery) return [...this.files];
    if (trimmedQuery.length > MAX_SEARCH_QUERY_LENGTH) return [];
    const normalizedQuery = trimmedQuery.toLowerCase();
    const queryParts = splitPathParts(normalizedQuery);
    const typoDistanceCache: TypoDistanceCache = new Map();

    return this.entries
      .flatMap((entry): RankedProjectFile[] => {
        const score = scoreEntry(normalizedQuery, queryParts, entry, typoDistanceCache);
        return Number.isFinite(score) ? [{ path: entry.path, score, originalIndex: entry.originalIndex }] : [];
      })
      .sort((left, right) => left.score - right.score || left.originalIndex - right.originalIndex)
      .map((result) => result.path);
  }
}

function scoreEntry(
  query: string,
  queryParts: readonly string[],
  entry: ProjectFileEntry,
  typoDistanceCache: TypoDistanceCache,
): number {
  const basenameScore = scoreField(query, queryParts, entry.normalizedBasename, entry.basenameParts, typoDistanceCache);
  const pathScore = scoreField(query, queryParts, entry.normalizedPath, entry.pathParts, typoDistanceCache);
  return Math.min(basenameScore, pathScore + PATH_SCORE_PENALTY);
}

function scoreField(
  query: string,
  queryParts: readonly string[],
  text: string,
  textParts: readonly string[],
  typoDistanceCache: TypoDistanceCache,
): number {
  const directScore = scoreText(query, text);
  if (directScore < TYPO_SCORE) return directScore;
  const typoScore = scoreTypo(query, textParts, typoDistanceCache);
  if (Number.isFinite(typoScore)) return Math.min(directScore, typoScore);
  if (Number.isFinite(directScore)) return directScore;
  return scoreTokenized(queryParts, textParts, typoDistanceCache);
}

function scoreTokenized(
  queryParts: readonly string[],
  candidateParts: readonly string[],
  typoDistanceCache: TypoDistanceCache,
): number {
  if (queryParts.length < 2 || queryParts.length > MAX_SEARCH_QUERY_PARTS) return NO_MATCH;

  let totalScore = TOKENIZED_SCORE;
  for (const queryPart of queryParts) {
    let bestDirectScore = NO_MATCH;
    for (let index = 0; index < candidateParts.length; index += 1) {
      bestDirectScore = Math.min(bestDirectScore, scoreText(queryPart, candidateParts[index] ?? "") + index * 2);
    }
    const bestPartScore =
      bestDirectScore < TYPO_SCORE
        ? bestDirectScore
        : Math.min(bestDirectScore, scoreTypo(queryPart, candidateParts, typoDistanceCache));
    if (!Number.isFinite(bestPartScore)) return NO_MATCH;
    totalScore += bestPartScore;
  }
  return totalScore;
}

function scoreText(query: string, text: string): number {
  if (query === text) return 0;
  if (text.startsWith(query)) return PREFIX_SCORE + lengthPenalty(query, text);

  const substringIndex = text.indexOf(query);
  if (substringIndex >= 0) {
    return SUBSTRING_SCORE + substringIndex * 2 + lengthPenalty(query, text);
  }

  return scoreSubsequence(query, text);
}

function scoreSubsequence(query: string, text: string): number {
  let queryIndex = 0;
  let firstMatch = -1;
  let previousMatch = -1;
  let gaps = 0;
  let boundaryMatches = 0;
  let consecutiveMatches = 0;

  for (let textIndex = 0; textIndex < text.length && queryIndex < query.length; textIndex += 1) {
    if (text[textIndex] !== query[queryIndex]) continue;
    if (firstMatch < 0) firstMatch = textIndex;
    if (previousMatch >= 0) {
      const gap = textIndex - previousMatch - 1;
      gaps += gap;
      if (gap === 0) consecutiveMatches += 1;
    }
    if (textIndex === 0 || PATH_PART_SEPARATOR.test(text[textIndex - 1] ?? "")) {
      boundaryMatches += 1;
    }
    previousMatch = textIndex;
    queryIndex += 1;
  }

  if (queryIndex !== query.length) return NO_MATCH;
  return (
    SUBSEQUENCE_SCORE +
    gaps * 3 +
    firstMatch * 2 +
    lengthPenalty(query, text) -
    boundaryMatches * 8 -
    consecutiveMatches
  );
}

function scoreTypo(query: string, parts: readonly string[], typoDistanceCache: TypoDistanceCache): number {
  const maxDistance = allowedTypoDistance(query.length);
  if (maxDistance === 0) return NO_MATCH;

  let bestScore = NO_MATCH;
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index] ?? "";
    if (Math.abs(query.length - part.length) > maxDistance) continue;
    const distance = cachedTypoDistance(query, part, maxDistance, typoDistanceCache);
    if (distance === undefined || distance === 0) continue;
    bestScore = Math.min(bestScore, TYPO_SCORE + distance * 20 + index * 2 + Math.abs(query.length - part.length));
  }
  return bestScore;
}

function cachedTypoDistance(
  query: string,
  part: string,
  maxDistance: number,
  cache: TypoDistanceCache,
): number | undefined {
  let queryCache = cache.get(query);
  if (!queryCache) {
    queryCache = new Map();
    cache.set(query, queryCache);
  }
  if (queryCache.has(part)) return queryCache.get(part);
  const distance = boundedDamerauLevenshtein(query, part, maxDistance);
  queryCache.set(part, distance);
  return distance;
}

function boundedDamerauLevenshtein(left: string, right: string, maxDistance: number): number | undefined {
  if (Math.abs(left.length - right.length) > maxDistance) return undefined;

  const unreachable = maxDistance + 1;
  let previousPrevious = Array.from({ length: left.length + 1 }, () => unreachable);
  let previous = Array.from({ length: left.length + 1 }, (_, index) => (index <= maxDistance ? index : unreachable));

  for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
    const current = Array.from({ length: left.length + 1 }, () => unreachable);
    if (rightIndex <= maxDistance) current[0] = rightIndex;
    const start = Math.max(1, rightIndex - maxDistance);
    const end = Math.min(left.length, rightIndex + maxDistance);
    for (let leftIndex = start; leftIndex <= end; leftIndex += 1) {
      const substitutionCost = left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1;
      current[leftIndex] = Math.min(
        (previous[leftIndex] ?? unreachable) + 1,
        (current[leftIndex - 1] ?? unreachable) + 1,
        (previous[leftIndex - 1] ?? unreachable) + substitutionCost,
      );
      if (
        leftIndex > 1 &&
        rightIndex > 1 &&
        left[leftIndex - 1] === right[rightIndex - 2] &&
        left[leftIndex - 2] === right[rightIndex - 1]
      ) {
        current[leftIndex] = Math.min(
          current[leftIndex] ?? unreachable,
          (previousPrevious[leftIndex - 2] ?? unreachable) + 1,
        );
      }
    }
    previousPrevious = previous;
    previous = current;
  }

  const distance = previous[left.length] ?? unreachable;
  return distance <= maxDistance ? distance : undefined;
}

function allowedTypoDistance(queryLength: number): number {
  if (queryLength < 5) return 0;
  return queryLength < 10 ? 1 : 2;
}

function splitPathParts(value: string): string[] {
  return value.split(PATH_PART_SEPARATOR).filter(Boolean);
}

function lengthPenalty(query: string, text: string): number {
  return Math.max(0, text.length - query.length) / 100;
}
