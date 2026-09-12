import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { editProjectFileInExternalEditor } from "./external-editor.js";
import { FileQuoteExplorer, type FileQuoteExplorerResult } from "./file-context-explorer.js";
import { type FileContextMenuQuote, showFileContextMenu } from "./file-context-menu.js";
import {
  awaitFileContextSettingsWrites,
  fileContextSettingsPath,
  type LoadedFileContextSettings,
  loadFileContextSettings,
  updateFileContextSettings,
} from "./file-context-settings.js";
import { createGitContext } from "./git-context.js";

const WIDGET_KEY = "file-context";
const DEFAULT_MAX_FILES = 5_000;
const DEFAULT_MAX_BYTES = 1_000_000;
const MAX_QUOTE_BYTES = 50_000;
const MAX_QUOTE_LINES = 500;
const MAX_PENDING_QUOTES = 8;
const MAX_PENDING_QUOTE_BYTES = 100_000;
const IGNORED_DIRECTORIES = new Set([
  ".git",
  ".hg",
  ".svn",
  ".next",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "target",
]);

export interface FileQuoteGitProvenance {
  head: string;
  branch?: string;
  status?: string;
  revision?: string;
  blob?: string;
  contentSha256: string;
  source?: "worktree" | "revision" | "git_diff";
  base?: string;
}

export type FileQuoteGitProvenanceInput = Omit<FileQuoteGitProvenance, "contentSha256">;

export interface FileQuote {
  path: string;
  startLine: number;
  endLine: number;
  text: string;
  git?: FileQuoteGitProvenance;
}

export interface LoadedProjectTextFile {
  path: string;
  lines: string[];
}

interface DiscoveryOptions {
  maxFiles?: number;
  signal?: AbortSignal;
}

interface LoadOptions {
  maxBytes?: number;
  beforeOpen?: () => Promise<void>;
  signal?: AbortSignal;
}

interface ActiveExplorer {
  controller: AbortController;
  component?: FileQuoteExplorer;
}

interface PendingQuote {
  id: string;
  quote: FileQuote;
}

interface ExplorerRunOptions {
  menuOwned?: boolean;
  signal?: AbortSignal;
}

type ExplorerRunResult = "stay" | "close";
type ExplorerDiscovery = [string[], Awaited<ReturnType<typeof createGitContext>>];

export async function discoverProjectFiles(root: string, options: DiscoveryOptions = {}): Promise<string[]> {
  const maxFiles = Math.max(1, options.maxFiles ?? DEFAULT_MAX_FILES);
  const files: string[] = [];
  options.signal?.throwIfAborted();

  const canonicalRoot = await realpath(root);
  const directories: Array<{ directory: string; prefix: string }> = [{ directory: canonicalRoot, prefix: "" }];
  options.signal?.throwIfAborted();

  for (let index = 0; index < directories.length && files.length < maxFiles; index += 1) {
    options.signal?.throwIfAborted();
    const current = directories[index];
    if (!current) break;
    const { directory, prefix } = current;
    const entries = (await readdir(directory, { withFileTypes: true })).sort((left, right) =>
      compareStrings(left.name, right.name),
    );
    options.signal?.throwIfAborted();
    for (const entry of entries) {
      options.signal?.throwIfAborted();
      if (IGNORED_DIRECTORIES.has(entry.name) || entry.isSymbolicLink()) continue;
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
      const absolutePath = resolve(directory, entry.name);
      if (entry.isDirectory()) {
        directories.push({ directory: absolutePath, prefix: relativePath });
      } else if (entry.isFile()) {
        files.push(relativePath);
        if (files.length >= maxFiles) break;
      }
    }
  }
  options.signal?.throwIfAborted();
  return files.sort(compareStrings);
}

export async function loadProjectTextFile(
  root: string,
  projectPath: string,
  options: LoadOptions = {},
): Promise<LoadedProjectTextFile> {
  options.signal?.throwIfAborted();
  if (!projectPath || isAbsolute(projectPath)) throw new Error("File path is outside the project");
  const canonicalRoot = await realpath(root);
  options.signal?.throwIfAborted();
  const candidate = resolve(canonicalRoot, projectPath);
  if (!isInside(canonicalRoot, candidate)) throw new Error("File path is outside the project");

  let canonicalFile: string;
  try {
    canonicalFile = await realpath(candidate);
  } catch (error: unknown) {
    throw new Error(`Cannot open ${projectPath}: ${formatError(error)}`);
  }
  options.signal?.throwIfAborted();
  if (!isInside(canonicalRoot, canonicalFile)) throw new Error("File path is outside the project");
  const info = await lstat(canonicalFile);
  options.signal?.throwIfAborted();
  if (!info.isFile()) throw new Error(`${projectPath} is not a regular file`);

  const maxBytes = Math.max(1, options.maxBytes ?? DEFAULT_MAX_BYTES);
  if (info.size > maxBytes) throw new Error(`${projectPath} exceeds ${maxBytes} bytes`);
  await options.beforeOpen?.();
  options.signal?.throwIfAborted();
  let file: Awaited<ReturnType<typeof open>>;
  try {
    file = await open(canonicalFile, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  } catch (error: unknown) {
    throw new Error(`Cannot safely open ${projectPath}: ${formatError(error)}`);
  }
  try {
    options.signal?.throwIfAborted();
    const openedInfo = await file.stat();
    options.signal?.throwIfAborted();
    if (!openedInfo.isFile()) throw new Error(`${projectPath} is not a regular file`);
    if (openedInfo.dev !== info.dev || openedInfo.ino !== info.ino) {
      throw new Error(`${projectPath} changed while it was being opened safely`);
    }
    if (openedInfo.size > maxBytes) throw new Error(`${projectPath} exceeds ${maxBytes} bytes`);
    const buffer = Buffer.alloc(maxBytes + 1);
    let offset = 0;
    while (offset < buffer.length) {
      options.signal?.throwIfAborted();
      const { bytesRead } = await file.read(buffer, offset, buffer.length - offset, offset);
      options.signal?.throwIfAborted();
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (offset > maxBytes) throw new Error(`${projectPath} exceeds ${maxBytes} bytes`);
    const contents = buffer.subarray(0, offset);
    if (contents.includes(0)) throw new Error(`${projectPath} appears to be binary`);
    return {
      path: projectPath.replaceAll("\\", "/"),
      lines: normalizeTextLines(contents.toString("utf8")),
    };
  } finally {
    await file.close();
  }
}

export function createFileQuote(
  path: string,
  lines: readonly string[],
  anchorIndex: number,
  cursorIndex: number,
  git?: FileQuoteGitProvenanceInput,
): FileQuote {
  if (lines.length === 0) throw new Error("Cannot quote an empty file");
  const startIndex = Math.max(0, Math.min(anchorIndex, cursorIndex, lines.length - 1));
  const endIndex = Math.max(0, Math.min(Math.max(anchorIndex, cursorIndex), lines.length - 1));
  const text = lines.slice(startIndex, endIndex + 1).join("\n");
  return createFileQuoteSnapshot(path, startIndex + 1, endIndex + 1, text, git);
}

export function createFileQuoteSnapshot(
  path: string,
  startLine: number,
  endLine: number,
  text: string,
  git?: FileQuoteGitProvenanceInput,
): FileQuote {
  if (!Number.isSafeInteger(startLine) || !Number.isSafeInteger(endLine) || startLine < 1) {
    throw new Error("Quote lines must be positive integers");
  }
  if (endLine < startLine) throw new Error("Quote end line precedes its start line");
  if (text.split("\n").length > MAX_QUOTE_LINES) {
    throw new Error(`Quote exceeds ${MAX_QUOTE_LINES} lines`);
  }
  if (Buffer.byteLength(text, "utf8") > MAX_QUOTE_BYTES) {
    throw new Error(`Quote exceeds ${MAX_QUOTE_BYTES} bytes`);
  }
  return {
    path,
    startLine,
    endLine,
    text,
    ...(git
      ? {
          git: {
            head: git.head,
            ...(git.branch !== undefined ? { branch: git.branch } : {}),
            ...(git.status !== undefined ? { status: git.status } : {}),
            ...(git.revision !== undefined ? { revision: git.revision } : {}),
            ...(git.blob !== undefined ? { blob: git.blob } : {}),
            contentSha256: createHash("sha256").update(text, "utf8").digest("hex"),
            ...(git.source !== undefined ? { source: git.source } : {}),
            ...(git.base !== undefined ? { base: git.base } : {}),
          },
        }
      : {}),
  };
}

export function appendPendingQuote(current: readonly FileQuote[], quote: FileQuote): FileQuote[] {
  if (current.length >= MAX_PENDING_QUOTES) {
    throw new Error(`File Context supports at most ${MAX_PENDING_QUOTES} pending quotes`);
  }
  const totalBytes = [...current, quote].reduce((total, item) => total + Buffer.byteLength(item.text, "utf8"), 0);
  if (totalBytes > MAX_PENDING_QUOTE_BYTES) {
    throw new Error(`Pending quotes exceed ${MAX_PENDING_QUOTE_BYTES} bytes`);
  }
  return [...current, quote];
}

export function formatPromptWithQuote(prompt: string, quote: FileQuote): string {
  return formatPromptWithQuotes(prompt, [quote]);
}

export function formatPromptWithQuotes(prompt: string, quotes: readonly FileQuote[]): string {
  if (quotes.length === 0) return prompt;
  return `${formatQuoteContext(quotes)}\n\n${prompt}`;
}

export function formatQuoteContext(quotes: readonly FileQuote[]): string {
  const blocks = quotes.map((quote) => {
    const path = escapeXml(quote.path);
    const text = escapeXml(quote.text);
    const attributes = [
      `path="${path}"`,
      `lines="${quote.startLine}-${quote.endLine}"`,
      ...formatGitAttributes(quote.git),
    ].join(" ");
    return `<user_file_quote ${attributes}>\n${text}\n</user_file_quote>`;
  });
  const description =
    quotes.length === 1
      ? "The user intentionally selected the file excerpt above."
      : "The user intentionally selected the file excerpts above.";
  return `${blocks.join("\n\n")}\n\n${description}`;
}

interface FileQuoteExtensionDependencies {
  settingsPath?: string;
  loadSettings?: () => Promise<LoadedFileContextSettings>;
  updateSettings?: typeof updateFileContextSettings;
  discoverFiles?: typeof discoverProjectFiles;
  createGit?: typeof createGitContext;
}

export async function registerFileQuoteExtension(
  pi: ExtensionAPI,
  dependencies: FileQuoteExtensionDependencies = {},
): Promise<void> {
  const settingsPath = dependencies.settingsPath ?? fileContextSettingsPath();
  const loadSettings = dependencies.loadSettings ?? (() => loadFileContextSettings(settingsPath));
  const updateSettings = dependencies.updateSettings ?? updateFileContextSettings;
  let loadedSettings = await loadSettings();
  const discoverFiles = dependencies.discoverFiles ?? discoverProjectFiles;
  const createGit = dependencies.createGit ?? createGitContext;
  let pendingQuotes: PendingQuote[] = [];
  let nextPendingQuoteId = 1;
  let activeSessionManager: unknown;
  let sessionGeneration = 0;
  let sessionController = new AbortController();
  const activeExplorers = new Set<ActiveExplorer>();
  let activeExplorerLaunch: { promise: Promise<void> } | undefined;
  let activeMenuLaunch: { promise: Promise<void> } | undefined;

  const updatePendingWidget = (ctx: ExtensionContext) => {
    if (!ctx.hasUI) return;
    if (pendingQuotes.length === 0) {
      ctx.ui.setWidget(WIDGET_KEY, undefined);
      return;
    }
    const totalBytes = pendingQuotes.reduce((total, item) => total + Buffer.byteLength(item.quote.text, "utf8"), 0);
    ctx.ui.setWidget(WIDGET_KEY, [
      ctx.ui.theme.fg(
        "accent",
        `Next prompt context · ${pendingQuotes.length} ${pendingQuotes.length === 1 ? "snippet" : "snippets"} · ~${estimateTokens(totalBytes)} tokens · /file-context to review`,
      ),
      ...pendingQuotes.map(({ quote }, index) =>
        ctx.ui.theme.fg(
          "muted",
          `${index + 1}. ${escapeTerminalControls(quote.path)} · lines ${quote.startLine}-${quote.endLine} · ~${estimateTokens(Buffer.byteLength(quote.text, "utf8"))} tokens`,
        ),
      ),
    ]);
  };

  const clearPending = (ctx: ExtensionContext) => {
    pendingQuotes = [];
    nextPendingQuoteId = 1;
    updatePendingWidget(ctx);
  };

  const validatePending = (quote: FileQuote) => {
    appendPendingQuote(
      pendingQuotes.map((item) => item.quote),
      quote,
    );
  };

  const appendPending = (quote: FileQuote, ctx: ExtensionContext) => {
    validatePending(quote);
    pendingQuotes = [...pendingQuotes, { id: `quote-${nextPendingQuoteId}`, quote }];
    nextPendingQuoteId += 1;
    updatePendingWidget(ctx);
  };

  const isCurrentSession = (owner: unknown, generation: number) =>
    owner === activeSessionManager && generation === sessionGeneration;

  const menuQuote = ({ id, quote }: PendingQuote): FileContextMenuQuote => ({
    id,
    path: quote.path,
    startLine: quote.startLine,
    endLine: quote.endLine,
    text: quote.text,
  });

  const cancelExplorers = () => {
    activeExplorerLaunch = undefined;
    for (const explorer of activeExplorers) {
      explorer.controller.abort(new DOMException("File Context explorer closed", "AbortError"));
      explorer.component?.dispose();
    }
    activeExplorers.clear();
  };

  const runExplorer = async (ctx: ExtensionContext, options: ExplorerRunOptions = {}): Promise<ExplorerRunResult> => {
    if (ctx.mode !== "tui") {
      rejectCommand(ctx, "File Context requires Pi's interactive TUI.");
      return "close";
    }
    const owner = ctx.sessionManager;
    const generation = sessionGeneration;
    const activeExplorer: ActiveExplorer = { controller: new AbortController() };
    const { controller } = activeExplorer;
    const flowSignal = options.signal ? AbortSignal.any([controller.signal, options.signal]) : controller.signal;
    activeExplorers.add(activeExplorer);
    try {
      const { runCustomInteraction, runTask } = await import("@narumitw/pi-tui-kit");
      if (!isCurrentSession(owner, generation) || flowSignal.aborted) return "close";
      const task = await runTask(ctx, {
        label: "Scanning project files…",
        signal: flowSignal,
        isCurrent: () => isCurrentSession(owner, generation) && !flowSignal.aborted,
        task: ({ signal }) => Promise.all([discoverFiles(ctx.cwd, { signal }), createGit(ctx.cwd, signal)]),
        onError: (_taskContext, error) => {
          ctx.ui.notify(
            `File Context could not scan project files: ${escapeTerminalControls(formatError(error))}. Open File Context to retry.`,
            "error",
          );
        },
      });
      if (task.kind === "cancelled" || task.kind === "error") {
        return options.menuOwned ? "stay" : "close";
      }
      if (task.kind === "stale") return "close";
      const discovery: ExplorerDiscovery = task.value;
      if (!isCurrentSession(owner, generation) || flowSignal.aborted) return "close";
      const [files, gitContext] = discovery;
      if (files.length === 0) {
        ctx.ui.notify("File Context found no project files. Choose Add context snippet to retry.", "warning");
        return options.menuOwned ? "stay" : "close";
      }
      const interaction = await runCustomInteraction<FileQuoteExplorerResult | undefined, ExtensionContext>(ctx, {
        signal: flowSignal,
        isCurrent: () => isCurrentSession(owner, generation),
        onError: () => {},
        create: ({ tui, theme, keybindings, signal: interactionSignal, complete }) => {
          const component = new FileQuoteExplorer({
            tui,
            theme,
            keybindings,
            files,
            cwd: ctx.cwd,
            loadFile: (path, signal) =>
              loadProjectTextFile(ctx.cwd, path, {
                signal: signal ? AbortSignal.any([signal, interactionSignal]) : interactionSignal,
              }),
            editFile: (path, signal) =>
              editProjectFileInExternalEditor({
                root: ctx.cwd,
                projectPath: path,
                tui,
                projectTrusted: ctx.isProjectTrusted(),
                signal: signal ? AbortSignal.any([signal, interactionSignal]) : interactionSignal,
                isCurrent: () => isCurrentSession(owner, generation) && !interactionSignal.aborted,
              }),
            gitContext,
            rootNavigation: options.menuOwned,
            getSelectedContextState: () => ({
              count: pendingQuotes.length,
              totalBytes: pendingQuotes.reduce((total, item) => total + Buffer.byteLength(item.quote.text, "utf8"), 0),
              maximumCount: MAX_PENDING_QUOTES,
              maximumBytes: MAX_PENDING_QUOTE_BYTES,
              maximumSnippetLines: MAX_QUOTE_LINES,
              maximumSnippetBytes: MAX_QUOTE_BYTES,
            }),
            validateQuote: validatePending,
            onAddAndContinue: (quote) => {
              if (!isCurrentSession(owner, generation) || interactionSignal.aborted) {
                throw new DOMException("File Context session replaced", "AbortError");
              }
              appendPending(quote, ctx);
              try {
                ctx.ui.notify(
                  `Added to next prompt context: ${escapeTerminalControls(quote.path)} · lines ${quote.startLine}-${quote.endLine}.`,
                  "info",
                );
              } catch {
                // The widget already reflects the selected snapshot.
              }
            },
            done: complete,
          });
          activeExplorer.component = component;
          return component;
        },
      });
      if (interaction.kind === "error") throw interaction.error;
      const result = interaction.kind === "completed" ? interaction.value : undefined;
      if (!isCurrentSession(owner, generation) || flowSignal.aborted) return "close";
      if (result?.kind === "quote") {
        appendPending(result.quote, ctx);
        return "close";
      }
      if (result?.kind === "reference") {
        ctx.ui.pasteToEditor(formatFileReference(result.path));
        return "close";
      }
      return result?.kind === "back" ? "stay" : "close";
    } catch (error: unknown) {
      if (!isCurrentSession(owner, generation) || flowSignal.aborted || isAbortError(error)) {
        return "close";
      }
      try {
        ctx.ui.notify(
          `File Context failed: ${escapeTerminalControls(formatError(error))}. Open File Context to retry.`,
          "error",
        );
      } catch {
        // The session may have been replaced while the picker was open.
      }
      return options.menuOwned ? "stay" : "close";
    } finally {
      activeExplorers.delete(activeExplorer);
    }
  };

  const openExplorer = (ctx: ExtensionContext): Promise<void> => {
    if (activeExplorerLaunch) return activeExplorerLaunch.promise;
    if (activeMenuLaunch) return activeMenuLaunch.promise;
    const launch = { promise: runExplorer(ctx).then(() => undefined) };
    activeExplorerLaunch = launch;
    const clearLaunch = () => {
      if (activeExplorerLaunch === launch) activeExplorerLaunch = undefined;
    };
    void launch.promise.then(clearLaunch, clearLaunch);
    return launch.promise;
  };

  // Pi snapshots extension shortcuts when the TUI binds them, so settings changes reload Pi.
  const registeredOpenShortcut = loadedSettings.settings.openShortcut;
  if (registeredOpenShortcut) {
    pi.registerShortcut(registeredOpenShortcut, {
      description: "Open File Context",
      handler: openExplorer,
    });
  }

  const openMenu = (ctx: ExtensionCommandContext, start: "main" | "remove" = "main"): Promise<void> => {
    if (ctx.mode !== "tui") {
      rejectCommand(ctx, "File Context requires Pi's interactive TUI.");
      return Promise.resolve();
    }
    if (activeMenuLaunch) return activeMenuLaunch.promise;
    if (activeExplorerLaunch) return activeExplorerLaunch.promise;
    if (start === "remove" && pendingQuotes.length === 0) {
      ctx.ui.notify("File Context has no context selected for the next prompt.", "warning");
      return Promise.resolve();
    }
    const owner = ctx.sessionManager;
    const generation = sessionGeneration;
    const ownerController = sessionController;
    const isCurrent = () =>
      isCurrentSession(owner, generation) && ownerController === sessionController && !ownerController.signal.aborted;
    const promise = showFileContextMenu(ctx, {
      start,
      signal: ownerController.signal,
      isCurrent,
      getState: () => {
        if (!isCurrent()) throw new DOMException("File Context session replaced", "AbortError");
        const quotes = pendingQuotes.map(menuQuote);
        return {
          quotes,
          shortcut: loadedSettings.settings.openShortcut,
          maximumQuotes: MAX_PENDING_QUOTES,
          maximumBytes: MAX_PENDING_QUOTE_BYTES,
          totalBytes: quotes.reduce((total, quote) => total + Buffer.byteLength(quote.text, "utf8"), 0),
          settingsPath,
          settingsInvalidReason: loadedSettings.invalidReason,
        };
      },
      addQuote: (signal) => runExplorer(ctx, { menuOwned: true, signal }),
      saveShortcut: async (shortcut, signal) => {
        if (!isCurrent() || signal.aborted) {
          throw new DOMException("File Context session replaced", "AbortError");
        }
        const saved = await updateSettings(shortcut, { settingsPath, signal });
        if (!isCurrent() || signal.aborted) return;
        loadedSettings = { settings: saved };
      },
      removeQuote: (id, signal) => {
        if (!isCurrent() || signal.aborted) return { kind: "missing" };
        const index = pendingQuotes.findIndex((item) => item.id === id);
        const selected = pendingQuotes[index];
        if (!selected) return { kind: "missing" };
        pendingQuotes = pendingQuotes.filter((_item, itemIndex) => itemIndex !== index);
        updatePendingWidget(ctx);
        return {
          kind: "removed",
          quote: menuQuote(selected),
          remaining: pendingQuotes.length,
        };
      },
    }).then(() => undefined);
    const launch = { promise };
    activeMenuLaunch = launch;
    const clearLaunch = () => {
      if (activeMenuLaunch === launch) activeMenuLaunch = undefined;
    };
    void promise.then(clearLaunch, clearLaunch);
    return promise;
  };

  const handleFileContextCommand = async (args: string, ctx: ExtensionCommandContext) => {
    const normalized = args.trim().toLowerCase();
    if (!normalized) {
      await openMenu(ctx);
      return;
    }
    if (normalized === "browse") {
      await openExplorer(ctx);
      return;
    }
    if (normalized === "remove") {
      await openMenu(ctx, "remove");
      return;
    }
    rejectCommand(ctx, "Usage: /file-context [browse|remove]");
  };
  pi.registerCommand("file-context", {
    description: "Open the File Context menu",
    getArgumentCompletions: (prefix) => {
      const normalized = prefix.trimStart().toLowerCase();
      const completions = [
        { value: "browse", label: "browse", description: "Open the file browser directly" },
        { value: "remove", label: "remove", description: "Review selected context directly" },
      ].filter(({ value }) => value.startsWith(normalized));
      return completions.length > 0 ? completions : null;
    },
    handler: handleFileContextCommand,
  });
  pi.on("session_start", async (_event, ctx) => {
    sessionController.abort(new DOMException("File Context session replaced", "AbortError"));
    sessionController = new AbortController();
    const ownerController = sessionController;
    activeMenuLaunch = undefined;
    cancelExplorers();
    activeSessionManager = ctx.sessionManager;
    const generation = ++sessionGeneration;
    clearPending(ctx);
    const refreshedSettings = await loadSettings();
    if (
      !isCurrentSession(ctx.sessionManager, generation) ||
      ownerController !== sessionController ||
      ownerController.signal.aborted
    ) {
      return;
    }
    loadedSettings = refreshedSettings;
    if (loadedSettings.warning && ctx.hasUI) {
      ctx.ui.notify(escapeTerminalControls(loadedSettings.warning), "warning");
    }
  });

  pi.on("before_agent_start", (_event, ctx) => {
    if (ctx.sessionManager !== activeSessionManager || pendingQuotes.length === 0) return;
    const quotes = pendingQuotes.map((item) => item.quote);
    clearPending(ctx);
    return {
      message: {
        customType: "file-context-quotes",
        content: formatQuoteContext(quotes),
        display: false,
      },
    };
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    if (ctx.sessionManager !== activeSessionManager) return;
    sessionController.abort(new DOMException("File Context session shut down", "AbortError"));
    activeMenuLaunch = undefined;
    cancelExplorers();
    clearPending(ctx);
    await awaitFileContextSettingsWrites(settingsPath);
  });
}

export default async function fileQuoteExtension(pi: ExtensionAPI): Promise<void> {
  await registerFileQuoteExtension(pi);
}

function normalizeTextLines(contents: string): string[] {
  if (contents === "") return [];
  const lines = contents.replaceAll("\r\n", "\n").replaceAll("\r", "\n").split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

function formatFileReference(path: string): string {
  const escaped = path.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
  return /\s|["\\]/.test(path) ? `@"${escaped}" ` : `@${path} `;
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function estimateTokens(bytes: number): number {
  return Math.max(1, Math.ceil(bytes / 4));
}

function isInside(root: string, candidate: string): boolean {
  const result = relative(root, candidate);
  return result === "" || (!result.startsWith(`..${sep}`) && result !== ".." && !isAbsolute(result));
}

function formatGitAttributes(git: FileQuoteGitProvenance | undefined): string[] {
  if (!git) return [];
  return [
    ["git_head", git.head],
    ["git_branch", git.branch],
    ["git_status", git.status],
    ["git_revision", git.revision],
    ["git_blob", git.blob],
    ["content_sha256", git.contentSha256],
    ["source", git.source],
    ["git_base", git.base],
  ].flatMap(([name, value]) => (value ? [`${name}="${escapeXml(value)}"`] : []));
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function escapeTerminalControls(text: string): string {
  return [...text]
    .map((character) => {
      const code = character.charCodeAt(0);
      return code <= 31 || (code >= 127 && code <= 159) ? `\\x${code.toString(16).padStart(2, "0")}` : character;
    })
    .join("");
}

function rejectCommand(ctx: ExtensionContext, message: string): void {
  if (ctx.hasUI) {
    ctx.ui.notify(message, "warning");
    return;
  }
  throw new Error(message);
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
