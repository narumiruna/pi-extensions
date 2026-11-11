export const SETTINGS_FILE_NAME = "pi-typesafe-search.json";
export const INDEX_POLICY_VERSION = "1";
export const SCHEMA_VERSION = "1";

export const MAX_SETTINGS_BYTES = 64 * 1024;
export const MAX_FILES = 5_000;
export const MAX_FILE_BYTES = 512 * 1024;
export const MAX_CORPUS_BYTES = 50 * 1024 * 1024;

export const CHUNK_TARGET_BYTES = 6 * 1024;
export const CHUNK_MAX_BYTES = 8 * 1024;
export const CHUNK_OVERLAP_UNITS = 3;
export const FILE_MAP_MAX_BYTES = 4 * 1024;

export const MAX_ALTERNATIVES = 4;
export const DEFAULT_RESULT_LIMIT = 8;
export const MAX_RESULT_LIMIT = 20;
export const FTS_RESULTS_PER_QUERY = 60;
export const MAX_FILE_MAPS = 80;
export const MAX_SEMANTIC_FILES = 8;
export const CHUNKS_PER_SEMANTIC_FILE = 3;
export const INITIAL_RERANK_CANDIDATES = 20;
export const RERANK_WIDENING_BATCH = 10;
export const MAX_RERANK_CANDIDATES = 40;

export const JEV_BATCH_SIZE = 8;
export const JEV_MAX_STATE_BYTES = 24 * 1024;
export const JEV_CONCURRENCY = 2;
export const JEV_TIMEOUT_MS = 15_000;
export const RESULT_RELEVANCE_THRESHOLD = 0.5;
export const FILE_RELEVANCE_THRESHOLD = 0.5;
export const RRF_K = 60;
