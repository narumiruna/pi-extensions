import { stripVTControlCharacters } from "node:util";
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  type ExtensionAPI,
  type ExtensionContext,
  truncateHead,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { DEFAULT_RESULT_LIMIT, MAX_ALTERNATIVES, MAX_RESULT_LIMIT, SETTINGS_FILE_NAME } from "./constants.js";
import { openSearchDatabase, type SearchDatabase } from "./database.js";
import { discoverSearchFiles } from "./files.js";
import { JevEvaluator } from "./jev-client.js";
import { type SearchResponse, searchIndexedWorkspace } from "./search.js";
import { loadSettings, type SettingsLoadResult } from "./settings.js";

interface SessionState {
  closed: boolean;
  settings: SettingsLoadResult;
  evaluator?: JevEvaluator;
  databases: Map<string, Promise<SearchDatabase>>;
  abortController: AbortController;
  operations: Set<Promise<void>>;
}

const sessionStates = new WeakMap<object, SessionState>();
const closedSessionManagers = new WeakSet<object>();

const parameters = Type.Object({
  query: Type.String({ minLength: 1, maxLength: 1_000, description: "Question or concept to search for." }),
  path: Type.String({ minLength: 1, maxLength: 4_096, description: "Directory inside the current workspace." }),
  alternatives: Type.Optional(
    Type.Array(Type.String({ minLength: 1, maxLength: 500 }), {
      maxItems: MAX_ALTERNATIVES,
      description: "Alternative lexical or paraphrased searches that improve FTS recall.",
    }),
  ),
  limit: Type.Optional(
    Type.Integer({ minimum: 1, maximum: MAX_RESULT_LIMIT, description: "Maximum number of matching excerpts." }),
  ),
});

export default function registerJevSearch(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "jev_search",
    label: "Jev Search",
    description:
      "Search a directory inside the current workspace with an incremental SQLite FTS5 index and TypeSafe Jev semantic reranking. Indexed source chunks persist privately under the Pi agent directory; selected file maps and candidate chunks are sent to TypeSafe. Returns at most 50 KB or 2,000 lines.",
    promptSnippet: "Search workspace files with FTS5 retrieval and Jev semantic reranking",
    promptGuidelines: [
      "Use jev_search when semantic or paraphrased workspace search is more useful than an exact grep, and include a few concise alternatives when the query has likely aliases.",
    ],
    parameters,
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      try {
        const query = params.query.trim();
        const path = params.path;
        if (!query) throw new Error("jev_search query must not be empty");
        if (!path.trim()) throw new Error("jev_search path must not be empty");
        const alternatives = orderedAlternatives(query, params.alternatives ?? []);
        const limit = params.limit ?? DEFAULT_RESULT_LIMIT;
        const state = await sessionState(ctx);
        signal?.throwIfAborted();
        if (state.closed) throw new Error("jev_search session ended before the search started");
        if (state.settings.kind !== "loaded") throw settingsError(state.settings);
        state.evaluator ??= new JevEvaluator(state.settings.settings.apiKey);
        const operationSignal = signal
          ? AbortSignal.any([signal, state.abortController.signal])
          : state.abortController.signal;
        const operation = createOperationGate();
        state.operations.add(operation.promise);

        try {
          onUpdate?.({
            content: [{ type: "text", text: "Discovering searchable files…" }],
            details: { phase: "discover" },
          });
          const discovery = await discoverSearchFiles(ctx.cwd, path, operationSignal);
          operationSignal.throwIfAborted();
          if (state.closed) throw new Error("jev_search session ended during file discovery");
          const database = await sessionDatabase(state, discovery.root, operationSignal);
          operationSignal.throwIfAborted();
          if (state.closed) throw new Error("jev_search session ended while opening its search index");

          const response = await searchIndexedWorkspace({
            database,
            discovery,
            evaluator: state.evaluator,
            request: { query, alternatives, limit },
            signal: operationSignal,
            onProgress: (_phase, detail) => {
              onUpdate?.({
                content: [{ type: "text", text: safeDisplayField(detail) }],
                details: { phase: _phase },
              });
            },
          });
          operationSignal.throwIfAborted();
          if (state.closed) throw new Error("jev_search session ended during the search");
          return formatToolResult(response);
        } finally {
          operation.finish();
          state.operations.delete(operation.promise);
        }
      } catch (error) {
        if (signal?.aborted || isAbortError(error)) throw error;
        throw new Error(safeDisplayField(formatError(error)), { cause: error });
      }
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    closedSessionManagers.delete(ctx.sessionManager);
    const previous = sessionStates.get(ctx.sessionManager);
    if (previous) {
      sessionStates.delete(ctx.sessionManager);
      await disposeSessionState(previous);
      if (closedSessionManagers.has(ctx.sessionManager) || sessionStates.has(ctx.sessionManager)) return;
    }
    const state: SessionState = {
      closed: false,
      settings: { kind: "missing", path: "" },
      databases: new Map(),
      abortController: new AbortController(),
      operations: new Set(),
    };
    sessionStates.set(ctx.sessionManager, state);
    const settings = await loadSettings();
    if (state.closed || sessionStates.get(ctx.sessionManager) !== state) return;
    state.settings = settings;
    if (settings.kind === "invalid") {
      ctx.ui.notify(safeDisplayField(`pi-typesafe-search settings ignored: ${settings.reason}`), "warning");
    }
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    closedSessionManagers.add(ctx.sessionManager);
    const state = sessionStates.get(ctx.sessionManager);
    if (!state) return;
    sessionStates.delete(ctx.sessionManager);
    await disposeSessionState(state);
  });
}

async function disposeSessionState(state: SessionState): Promise<void> {
  if (state.closed) return;
  state.closed = true;
  state.abortController.abort();
  await Promise.allSettled(state.operations);
  const databases = await Promise.allSettled(state.databases.values());
  for (const result of databases) {
    if (result.status === "fulfilled") result.value.close();
  }
  state.databases.clear();
}

async function sessionState(ctx: ExtensionContext): Promise<SessionState> {
  if (closedSessionManagers.has(ctx.sessionManager)) throw new Error("jev_search session has already shut down");
  const existing = sessionStates.get(ctx.sessionManager);
  if (existing) return existing;
  const settings = await loadSettings();
  if (closedSessionManagers.has(ctx.sessionManager)) throw new Error("jev_search session has already shut down");
  const current = sessionStates.get(ctx.sessionManager);
  if (current) return current;
  const state: SessionState = {
    closed: false,
    settings,
    databases: new Map(),
    abortController: new AbortController(),
    operations: new Set(),
  };
  sessionStates.set(ctx.sessionManager, state);
  return state;
}

async function sessionDatabase(state: SessionState, root: string, signal: AbortSignal): Promise<SearchDatabase> {
  let pending = state.databases.get(root);
  if (!pending) {
    pending = openSearchDatabase(root, undefined, state.abortController.signal).then((database) => {
      if (state.closed) {
        database.close();
        throw new Error("jev_search session ended while opening its search index");
      }
      return database;
    });
    state.databases.set(root, pending);
    void pending.catch(() => {
      if (state.databases.get(root) === pending) state.databases.delete(root);
    });
  }
  const database = await waitForPromise(pending, signal);
  if (state.closed) throw new Error("jev_search session ended while opening its search index");
  return database;
}

function waitForPromise<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const abort = () => {
      signal.removeEventListener("abort", abort);
      reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
    };
    signal.addEventListener("abort", abort, { once: true });
    void promise.then(
      (value) => {
        signal.removeEventListener("abort", abort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", abort);
        reject(error);
      },
    );
  });
}

function orderedAlternatives(query: string, alternatives: readonly string[]): string[] {
  const seen = new Set([query.toLocaleLowerCase("en-US")]);
  const selected: string[] = [];
  for (const value of alternatives) {
    const trimmed = value.trim();
    const key = trimmed.toLocaleLowerCase("en-US");
    if (!trimmed || seen.has(key)) continue;
    seen.add(key);
    selected.push(trimmed);
    if (selected.length >= MAX_ALTERNATIVES) break;
  }
  return selected;
}

function settingsError(settings: Exclude<SettingsLoadResult, { kind: "loaded" }>): Error {
  if (settings.kind === "missing") {
    return new Error(
      `TypeSafe API key is missing. Create ${settings.path || SETTINGS_FILE_NAME} with a private apiKey.`,
    );
  }
  return new Error(`TypeSafe API key settings are unavailable: ${settings.reason}`);
}

export function formatToolResult(response: SearchResponse) {
  const lines =
    response.matches.length === 0 ? ["No relevant matches found."] : [`Found ${response.matches.length} matches:`];
  for (const match of response.matches) {
    lines.push(
      "",
      `${safeDisplayField(match.filePath)}:${match.startLine}-${match.endLine} (Jev ${match.relevance.toFixed(3)})`,
      safeDisplayMultiline(match.body),
    );
  }
  lines.push(
    "",
    `Scanned ${response.scannedFiles} files; index ${response.index.indexed} updated, ${response.index.unchanged} unchanged, ${response.index.removed} removed, ${response.index.skipped} skipped.`,
    `Jev evaluated ${response.fileMapsEvaluated} file maps and ${response.candidatesEvaluated} chunks in ${response.requests} requests (${response.inputTokens} input tokens, ${response.outputTokens} output tokens).`,
  );
  const truncation = truncateHead(lines.join("\n"), {
    maxBytes: DEFAULT_MAX_BYTES - 512,
    maxLines: DEFAULT_MAX_LINES - 4,
  });
  const text = truncation.truncated
    ? `${truncation.content}\n\n[Output truncated to fit Pi tool limits.]`
    : truncation.content;
  return {
    content: [{ type: "text" as const, text }],
    details: {
      matches: response.matches.map((match) => ({
        path: safeDisplayField(match.filePath),
        startLine: match.startLine,
        endLine: match.endLine,
        relevance: match.relevance,
        lexicalRank: match.lexicalRank,
        rrfScore: match.rrfScore,
        fileScore: match.fileScore,
        retrievalSources: match.sources.slice(0, MAX_ALTERNATIVES + 1).map((source) => ({
          ...source,
          query: boundedDisplayField(source.query, 500),
        })),
        excerpt: boundedDisplayMultiline(match.body, 2_048, 50),
      })),
      index: response.index,
      scannedFiles: response.scannedFiles,
      fileMapsEvaluated: response.fileMapsEvaluated,
      candidatesEvaluated: response.candidatesEvaluated,
      requests: response.requests,
      inputTokens: response.inputTokens,
      outputTokens: response.outputTokens,
      model: response.model ? boundedDisplayField(response.model, 200) : undefined,
      truncated: truncation.truncated,
    },
  };
}

function createOperationGate(): { promise: Promise<void>; finish: () => void } {
  let finish: () => void = () => undefined;
  const promise = new Promise<void>((resolve) => {
    finish = resolve;
  });
  return { promise, finish };
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && (error.name === "AbortError" || error.name === "APIUserAbortError");
}

function boundedDisplayField(value: string, maxBytes: number): string {
  return truncateHead(safeDisplayField(value), { maxBytes, maxLines: 1 }).content;
}

function boundedDisplayMultiline(value: string, maxBytes: number, maxLines: number): string {
  return truncateHead(safeDisplayMultiline(value), { maxBytes, maxLines }).content;
}

function safeDisplayField(value: string): string {
  return safeDisplayMultiline(value).replace(/[\t\r\n\u2028\u2029]+/gu, " ");
}

function safeDisplayMultiline(value: string): string {
  return [...stripVTControlCharacters(value).replace(/\p{Cf}/gu, "")]
    .filter((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code === 9 || code === 10 || code === 13 || code >= 160 || (code >= 32 && code <= 126);
    })
    .join("");
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
