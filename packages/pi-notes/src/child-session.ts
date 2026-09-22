import type { Dir } from "node:fs";
import { lstat, mkdir, opendir, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import { type Api, type Model, Type } from "@earendil-works/pi-ai";
import {
  type AgentSession,
  type CreateAgentSessionOptions,
  createAgentSession,
  DefaultResourceLoader,
  defineTool,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { sanitizeTerminalText } from "@narumitw/pi-tui-kit/terminal-text";
import { CHILD_TOOL_NAMES, MAX_SESSION_FILES_PER_NOTE, NOTES_SYSTEM_PROMPT } from "./constants.js";
import { type NoteSnapshot, type NotesStorage, noteSessionKey } from "./storage.js";

export { noteSessionKey };

export interface CreateNotesChildSessionOptions {
  agentDir: string;
  storage: NotesStorage;
  notePath: string;
  parentModel: Model<Api> | undefined;
  thinkingLevel: NonNullable<CreateAgentSessionOptions["thinkingLevel"]>;
  signal?: AbortSignal;
  onNoteChanged?(snapshot: NoteSnapshot): void;
}

export interface NotesChildSession {
  session: AgentSession;
  resumed: boolean;
  recoveryWarning?: string;
  modelFallbackMessage?: string;
}

export interface NotesChildSessionDependencies {
  createModelRuntime(options: Parameters<typeof ModelRuntime.create>[0]): Promise<ModelRuntime>;
}

export async function createNotesChildSession(
  options: CreateNotesChildSessionOptions,
  dependencies: Partial<NotesChildSessionDependencies> = {},
): Promise<NotesChildSession> {
  throwIfAborted(options.signal);
  if (!options.parentModel) throw new Error("Select a model in the parent Pi session before opening a note");

  const createModelRuntime = dependencies.createModelRuntime ?? ModelRuntime.create;
  const modelRuntime = await createModelRuntime({
    authPath: join(options.agentDir, "auth.json"),
    modelsPath: join(options.agentDir, "models.json"),
    modelsStorePath: join(options.agentDir, "models-store.json"),
    signal: options.signal,
  });
  throwIfAborted(options.signal);
  const model = modelRuntime.getModel(options.parentModel.provider, options.parentModel.id);
  if (!model) {
    throw new Error(
      `The selected model ${options.parentModel.provider}/${options.parentModel.id} is not available to the embedded notes runtime. Providers registered only by another extension are not inherited.`,
    );
  }

  const settingsManager = SettingsManager.inMemory({
    compaction: { enabled: true },
    retry: { enabled: true },
  });
  const resourceLoader = new DefaultResourceLoader({
    cwd: options.storage.paths.notes,
    agentDir: options.agentDir,
    settingsManager,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    systemPrompt: NOTES_SYSTEM_PROMPT,
  });
  await resourceLoader.reload();
  throwIfAborted(options.signal);

  const selectedSession = await selectNoteSessionManager(
    options.storage.paths.notes,
    options.storage.paths.sessions,
    options.notePath,
    options.signal,
  );
  throwIfAborted(options.signal);
  if (!selectedSession.manager.getSessionName()) {
    selectedSession.manager.appendSessionInfo(sanitizeTerminalText(options.notePath));
  }

  const tools = createCurrentNoteTools(options.storage, options.notePath, options.onNoteChanged);
  const sessionModelRuntime = options.signal ? withCancellableAuth(modelRuntime, options.signal) : modelRuntime;
  const result = await createAgentSession({
    cwd: options.storage.paths.notes,
    agentDir: options.agentDir,
    modelRuntime: sessionModelRuntime,
    model,
    thinkingLevel: options.thinkingLevel,
    tools: [...CHILD_TOOL_NAMES],
    customTools: tools,
    resourceLoader,
    sessionManager: selectedSession.manager,
    settingsManager,
  });
  if (options.signal?.aborted) {
    result.session.dispose();
    throwIfAborted(options.signal);
  }
  if (result.extensionsResult.extensions.length > 0 || result.extensionsResult.errors.length > 0) {
    result.session.dispose();
    throw new Error("The embedded notes runtime did not remain resource-isolated");
  }
  const activeTools = result.session.getActiveToolNames();
  if (
    activeTools.length !== CHILD_TOOL_NAMES.length ||
    activeTools.some((toolName, index) => toolName !== CHILD_TOOL_NAMES[index])
  ) {
    result.session.dispose();
    throw new Error(`Unexpected embedded notes tool set: ${activeTools.join(", ") || "none"}`);
  }

  return {
    session: result.session,
    resumed: selectedSession.resumed,
    ...(selectedSession.recoveryWarning ? { recoveryWarning: selectedSession.recoveryWarning } : {}),
    ...(result.modelFallbackMessage ? { modelFallbackMessage: result.modelFallbackMessage } : {}),
  };
}

export function createCurrentNoteTools(
  storage: NotesStorage,
  notePath: string,
  onNoteChanged?: (snapshot: NoteSnapshot) => void,
) {
  let currentPath = notePath;

  const readTool = defineTool({
    name: "read_current_note",
    label: "Read current note",
    description: "Read the complete current Markdown note and return its relative path and revision.",
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, signal) {
      const note = await storage.readNote(currentPath, signal);
      return {
        content: [
          {
            type: "text" as const,
            text: `Path: ${note.relativePath}\nRevision: ${note.revision}\nBytes: ${note.size}\n\n${note.content}`,
          },
        ],
        details: { relativePath: note.relativePath, revision: note.revision, size: note.size },
      };
    },
  });

  const editTool = defineTool({
    name: "edit_current_note",
    label: "Edit current note",
    description:
      "Replace one unique exact text fragment in the current Markdown note. This tool never accepts a path and rejects stale revisions.",
    parameters: Type.Object({
      revision: Type.String({ description: "Latest revision returned by a current-note tool" }),
      oldText: Type.String({ minLength: 1, description: "Unique exact text to replace" }),
      newText: Type.String({ description: "Replacement text" }),
    }),
    async execute(_toolCallId, params, signal) {
      const note = await storage.editNote(currentPath, params.revision, params.oldText, params.newText, signal);
      notifyNoteChanged(onNoteChanged, note);
      return mutationResult(note);
    },
  });

  const replaceTool = defineTool({
    name: "replace_current_note",
    label: "Replace current note",
    description:
      "Replace the complete current Markdown note. Use only when a precise edit is unsuitable. This tool never accepts a path and rejects stale revisions.",
    parameters: Type.Object({
      revision: Type.String({ description: "Latest revision returned by a current-note tool" }),
      content: Type.String({ description: "Complete replacement Markdown" }),
    }),
    async execute(_toolCallId, params, signal) {
      const note = await storage.replaceNote(currentPath, params.revision, params.content, signal);
      notifyNoteChanged(onNoteChanged, note);
      return mutationResult(note);
    },
  });

  const renameTool = defineTool({
    name: "rename_current_note",
    label: "Rename current note",
    description:
      "Rename the current note to a concise, descriptive relative Markdown path. This tool accepts no source path, rejects stale revisions, and never overwrites another note.",
    parameters: Type.Object({
      revision: Type.String({ description: "Latest revision returned by a current-note tool" }),
      newPath: Type.String({
        minLength: 4,
        maxLength: 1_024,
        description: "New relative path below the notes root, ending in .md",
      }),
    }),
    async execute(_toolCallId, params, signal) {
      const previousPath = currentPath;
      const note = await storage.renameNote(previousPath, params.revision, params.newPath, signal);
      currentPath = note.relativePath;
      notifyNoteChanged(onNoteChanged, note);
      return renameResult(previousPath, note);
    },
  });

  return [readTool, editTool, replaceTool, renameTool];
}

async function selectNoteSessionManager(
  notesRoot: string,
  sessionsRoot: string,
  notePath: string,
  signal?: AbortSignal,
): Promise<{ manager: SessionManager; resumed: boolean; recoveryWarning?: string }> {
  throwIfAborted(signal);
  const rootInfo = await lstat(sessionsRoot);
  throwIfAborted(signal);
  if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) {
    throw new Error(`Invalid note sessions root: ${sessionsRoot}`);
  }
  const root = await realpath(sessionsRoot);
  throwIfAborted(signal);
  const sessionDirectory = join(root, noteSessionKey(notePath));
  assertContained(root, sessionDirectory);
  try {
    await mkdir(sessionDirectory, { mode: 0o700 });
  } catch (error) {
    if (!isNodeError(error, "EEXIST")) throw error;
  }
  throwIfAborted(signal);
  const sessionInfo = await lstat(sessionDirectory);
  throwIfAborted(signal);
  if (sessionInfo.isSymbolicLink() || !sessionInfo.isDirectory()) {
    throw new Error(`Invalid note session directory: ${sessionDirectory}`);
  }
  const canonicalDirectory = await realpath(sessionDirectory);
  throwIfAborted(signal);
  assertContained(root, canonicalDirectory);
  if (canonicalDirectory !== sessionDirectory) throw new Error("Note session directory is not canonical");

  const candidates: string[] = [];
  let directory: Dir | undefined;
  try {
    directory = await opendir(canonicalDirectory);
    throwIfAborted(signal);
    for await (const entry of directory) {
      throwIfAborted(signal);
      if (entry.isSymbolicLink() || !entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
      candidates.push(entry.name);
      if (candidates.length > MAX_SESSION_FILES_PER_NOTE) {
        throw new Error(`A note may have at most ${MAX_SESSION_FILES_PER_NOTE} saved sessions`);
      }
    }
    throwIfAborted(signal);
  } finally {
    await directory?.close().catch(() => undefined);
  }
  throwIfAborted(signal);
  candidates.sort((first, second) => second.localeCompare(first));

  let invalidSessions = 0;
  for (const name of candidates) {
    const file = join(canonicalDirectory, name);
    try {
      const info = await lstat(file);
      throwIfAborted(signal);
      if (info.isSymbolicLink() || !info.isFile()) continue;
      const manager = SessionManager.open(file, canonicalDirectory, notesRoot);
      return {
        manager,
        resumed: true,
        ...(invalidSessions > 0
          ? {
              recoveryWarning: `Ignored ${invalidSessions} invalid newer note session${invalidSessions === 1 ? "" : "s"}.`,
            }
          : {}),
      };
    } catch {
      throwIfAborted(signal);
      invalidSessions += 1;
    }
  }

  return {
    manager: SessionManager.create(notesRoot, canonicalDirectory),
    resumed: false,
    ...(invalidSessions > 0
      ? {
          recoveryWarning: `Started a new conversation after ${invalidSessions} saved note session${invalidSessions === 1 ? "" : "s"} could not be loaded.`,
        }
      : {}),
  };
}

function withCancellableAuth(modelRuntime: ModelRuntime, lifetime: AbortSignal): ModelRuntime {
  // AgentSession.prompt does not forward caller cancellation to its authentication check.
  const checkAuth: ModelRuntime["checkAuth"] = (providerId, options) => {
    const signal = options?.signal ? AbortSignal.any([lifetime, options.signal]) : lifetime;
    throwIfAborted(signal);
    return settleOnAbort(modelRuntime.checkAuth(providerId, { ...options, signal }), signal);
  };
  return new Proxy(modelRuntime, {
    get(target, property) {
      if (property === "checkAuth") return checkAuth;
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

function settleOnAbort<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(abortReason(signal));
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(abortReason(signal));
    signal.addEventListener("abort", abort, { once: true });
    void operation.then(
      (value) => {
        signal.removeEventListener("abort", abort);
        if (signal.aborted) reject(abortReason(signal));
        else resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", abort);
        reject(error);
      },
    );
  });
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new DOMException("Operation aborted", "AbortError");
}

function notifyNoteChanged(callback: ((snapshot: NoteSnapshot) => void) | undefined, note: NoteSnapshot): void {
  try {
    callback?.(note);
  } catch {
    // The note is already published; a rendering callback must not turn success into a tool failure.
  }
}

function mutationResult(note: NoteSnapshot) {
  return {
    content: [
      {
        type: "text" as const,
        text: `Updated the current note.\nPath: ${note.relativePath}\nRevision: ${note.revision}\nBytes: ${note.size}`,
      },
    ],
    details: { relativePath: note.relativePath, revision: note.revision, size: note.size },
  };
}

function renameResult(previousPath: string, note: NoteSnapshot) {
  return {
    content: [
      {
        type: "text" as const,
        text: `Renamed the current note from ${previousPath} to ${note.relativePath}.\nRevision: ${note.revision}\nBytes: ${note.size}`,
      },
    ],
    details: {
      previousPath,
      relativePath: note.relativePath,
      revision: note.revision,
      size: note.size,
    },
  };
}

function assertContained(root: string, candidate: string): void {
  const nested = relative(root, candidate);
  if (nested === "" || (!nested.startsWith(`..${sep}`) && nested !== ".." && !isAbsolute(nested))) return;
  throw new Error("Session path escapes the managed sessions directory");
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  throw signal.reason instanceof Error ? signal.reason : new DOMException("Operation aborted", "AbortError");
}
