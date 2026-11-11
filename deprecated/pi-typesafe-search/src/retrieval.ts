import {
  CHUNKS_PER_SEMANTIC_FILE,
  FTS_RESULTS_PER_QUERY,
  MAX_FILE_MAPS,
  MAX_RERANK_CANDIDATES,
  RRF_K,
} from "./constants.js";
import type { FileMapRecord, SearchDatabase, StoredChunk } from "./database.js";
import { ftsExpression } from "./text-normalization.js";

export interface RetrievalSource {
  query: string;
  rank: number;
  weight: number;
  bm25: number;
}

export interface RetrievedChunk extends StoredChunk {
  rrfScore: number;
  lexicalRank?: number;
  fileScore?: number;
  sources: RetrievalSource[];
}

export function retrieveLexicalCandidates(
  database: SearchDatabase,
  query: string,
  alternatives: readonly string[],
): RetrievedChunk[] {
  const queries = [query, ...alternatives];
  const candidates = new Map<number, RetrievedChunk>();

  for (let queryIndex = 0; queryIndex < queries.length; queryIndex += 1) {
    const currentQuery = queries[queryIndex];
    if (!currentQuery) continue;
    const expression = ftsExpression(currentQuery);
    if (!expression) continue;
    const weight = queryIndex === 0 ? 2 : 1;
    const results = database.searchFts(expression, FTS_RESULTS_PER_QUERY);
    for (let rank = 0; rank < results.length; rank += 1) {
      const result = results[rank];
      if (!result) continue;
      const contribution = weight / (RRF_K + rank + 1);
      const existing = candidates.get(result.id);
      const source = { query: currentQuery, rank: rank + 1, weight, bm25: result.bm25 };
      if (existing) {
        existing.rrfScore += contribution;
        existing.sources.push(source);
      } else {
        candidates.set(result.id, { ...result, rrfScore: contribution, sources: [source] });
      }
    }
  }

  return [...candidates.values()]
    .sort((left, right) => right.rrfScore - left.rrfScore || compareChunks(left, right))
    .map((candidate, index) => ({ ...candidate, lexicalRank: index + 1 }));
}

export function selectFileMaps(database: SearchDatabase, lexical: readonly RetrievedChunk[]): FileMapRecord[] {
  const lexicalPaths = [...new Set(lexical.map((chunk) => chunk.filePath))];
  const selected = database.listFileMaps(MAX_FILE_MAPS, lexicalPaths);
  if (selected.length >= MAX_FILE_MAPS) return selected;
  const selectedPaths = new Set(selected.map((file) => file.path));
  for (const file of database.listFileMaps(MAX_FILE_MAPS)) {
    if (selectedPaths.has(file.path)) continue;
    selected.push(file);
    selectedPaths.add(file.path);
    if (selected.length >= MAX_FILE_MAPS) break;
  }
  return selected;
}

export function chunksForSemanticFiles(
  database: SearchDatabase,
  query: string,
  alternatives: readonly string[],
  files: readonly { path: string; score: number }[],
): RetrievedChunk[] {
  const chunks = new Map<number, RetrievedChunk>();
  for (const file of files) {
    const expressions = [query, ...alternatives].flatMap((value) => {
      const expression = ftsExpression(value);
      return expression ? [expression] : [];
    });
    let selected: StoredChunk[] = [];
    for (const expression of expressions) {
      selected.push(...database.searchFts(expression, CHUNKS_PER_SEMANTIC_FILE, file.path));
    }
    selected = deduplicateChunks(selected);
    if (selected.length < CHUNKS_PER_SEMANTIC_FILE) {
      selected = deduplicateChunks([
        ...selected,
        ...database.representativeChunks(file.path, CHUNKS_PER_SEMANTIC_FILE),
      ]);
    }
    for (const chunk of selected.slice(0, CHUNKS_PER_SEMANTIC_FILE)) {
      chunks.set(chunk.id, {
        ...chunk,
        rrfScore: 0,
        fileScore: file.score,
        sources: [],
      });
    }
  }
  return [...chunks.values()].sort(
    (left, right) => (right.fileScore ?? 0) - (left.fileScore ?? 0) || compareChunks(left, right),
  );
}

export function mergeCandidates(
  lexical: readonly RetrievedChunk[],
  semantic: readonly RetrievedChunk[],
): RetrievedChunk[] {
  const merged = new Map<number, RetrievedChunk>();
  for (const candidate of [...lexical, ...semantic]) {
    const existing = merged.get(candidate.id);
    if (!existing) {
      merged.set(candidate.id, { ...candidate, sources: [...candidate.sources] });
      continue;
    }
    existing.rrfScore = Math.max(existing.rrfScore, candidate.rrfScore);
    existing.lexicalRank = existing.lexicalRank ?? candidate.lexicalRank;
    existing.fileScore = Math.max(existing.fileScore ?? 0, candidate.fileScore ?? 0) || undefined;
    existing.sources = [...existing.sources, ...candidate.sources];
  }
  const selected: RetrievedChunk[] = [];
  const selectedIds = new Set<number>();
  const add = (candidate: RetrievedChunk | undefined) => {
    if (!candidate || selectedIds.has(candidate.id) || selected.length >= MAX_RERANK_CANDIDATES) return;
    const combined = merged.get(candidate.id);
    if (!combined) return;
    selected.push(combined);
    selectedIds.add(candidate.id);
  };
  const count = Math.max(lexical.length, semantic.length);
  for (let index = 0; index < count && selected.length < MAX_RERANK_CANDIDATES; index += 1) {
    add(lexical[index]);
    add(semantic[index]);
  }
  return selected;
}

function deduplicateChunks(chunks: readonly StoredChunk[]): StoredChunk[] {
  return [...new Map(chunks.map((chunk) => [chunk.id, chunk])).values()];
}

function compareChunks(left: StoredChunk, right: StoredChunk): number {
  return left.filePath.localeCompare(right.filePath) || left.sequence - right.sequence;
}
