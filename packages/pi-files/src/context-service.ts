import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { KeyId } from "@earendil-works/pi-tui";
import { editProjectFileInExternalEditor } from "./external-editor.js";
import {
  appendPendingQuote,
  discoverProjectFiles,
  type FileQuote,
  formatQuoteContext,
  loadProjectTextFile,
  MAX_PENDING_QUOTE_BYTES,
  MAX_PENDING_QUOTES,
  MAX_QUOTE_BYTES,
  MAX_QUOTE_LINES,
} from "./file-context.js";
import type { FileQuoteExplorer, FileQuoteExplorerResult } from "./file-context-explorer.js";
import type { FileContextMenuQuote, FileContextMenuState } from "./file-context-menu.js";
import {
  awaitFileContextSettingsWrites,
  fileContextSettingsPath,
  type LoadedFileContextSettings,
  loadFileContextSettings,
  updateFileContextSettings,
} from "./file-context-settings.js";
import { publishFilesWidget } from "./files-widget.js";
import { createGitContext } from "./git-context.js";

interface ActiveExplorer {
  controller: AbortController;
  component?: FileQuoteExplorer;
}
interface PendingQuote {
  id: string;
  quote: FileQuote;
}
type ExplorerDiscovery = [string[], Awaited<ReturnType<typeof createGitContext>>];

export interface ContextOptions {
  settingsPath?: string;
  loadSettings?: () => Promise<LoadedFileContextSettings>;
  updateSettings?: typeof updateFileContextSettings;
  discoverFiles?: typeof discoverProjectFiles;
  createGit?: typeof createGitContext;
  onChange?(ctx: ExtensionContext, quotes: readonly FileQuote[]): void;
}
export interface ContextService {
  review(ctx: ExtensionCommandContext): Promise<void>;
  browse(ctx: ExtensionContext): Promise<void>;
  getState(ctx: ExtensionContext): FileContextMenuState;
  saveShortcut(ctx: ExtensionContext, shortcut: KeyId | null, signal: AbortSignal): Promise<void>;
  signal(ctx: ExtensionContext): AbortSignal;
}
interface ContextOwner {
  controller: AbortController;
  review: ContextService["review"];
  browse: ContextService["browse"];
  getState(): FileContextMenuState;
  saveShortcut: ContextService["saveShortcut"];
  refresh(ctx: ExtensionContext): Promise<void>;
  consume(ctx: ExtensionContext): FileQuote[];
  release(ctx: ExtensionContext): Promise<void>;
}

/** Registers package-owned context services, not a second extension factory. */
export async function registerFileContext(
  pi: ExtensionAPI,
  dependencies: ContextOptions = {},
): Promise<ContextService> {
  const settingsPath = dependencies.settingsPath ?? fileContextSettingsPath();
  const loadSettings = dependencies.loadSettings ?? (() => loadFileContextSettings(settingsPath));
  const updateSettings = dependencies.updateSettings ?? updateFileContextSettings;
  // Shortcut registration precedes session_start; reading preferences creates no resources.
  const initialSettings = await loadSettings();
  const discoverFiles = dependencies.discoverFiles ?? discoverProjectFiles;
  const createGit = dependencies.createGit ?? createGitContext;
  const owners = new Map<object, ContextOwner>();
  const requireOwner = (ctx: ExtensionContext): ContextOwner => {
    const owner = owners.get(ctx.sessionManager);
    if (!owner || owner.controller.signal.aborted) throw new Error("File Context is not initialized; reload first");
    return owner;
  };

  function createOwner(context: ExtensionContext): ContextOwner {
    let loadedSettings = initialSettings;
    let pendingQuotes: PendingQuote[] = [];
    let nextPendingQuoteId = 1;
    const activeSessionManager = context.sessionManager;
    const sessionGeneration = 0;
    const sessionController = new AbortController();
    const activeExplorers = new Set<ActiveExplorer>();
    const nativeWork = new Set<Promise<unknown>>();
    const gitContexts = new Set<NonNullable<Awaited<ReturnType<typeof createGitContext>>>>();
    const track = <T>(work: Promise<T>): Promise<T> => {
      nativeWork.add(work);
      void work.then(
        () => nativeWork.delete(work),
        () => nativeWork.delete(work),
      );
      return work;
    };
    let activeExplorerLaunch: { promise: Promise<void> } | undefined;
    let activeReviewLaunch: { promise: Promise<void> } | undefined;
    const updatePendingWidget = (ctx: ExtensionContext) =>
      (dependencies.onChange ?? publishFilesWidget)(
        ctx,
        pendingQuotes.map((item) => item.quote),
      );
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
      pendingQuotes = [...pendingQuotes, { id: `quote-${nextPendingQuoteId++}`, quote }];
      updatePendingWidget(ctx);
    };
    const isCurrentSession = (key: unknown, generation: number) =>
      key === activeSessionManager &&
      generation === sessionGeneration &&
      owners.get(activeSessionManager) === runtime &&
      !sessionController.signal.aborted;
    const menuQuote = ({ id, quote }: PendingQuote): FileContextMenuQuote => ({
      id,
      path: quote.path,
      startLine: quote.startLine,
      endLine: quote.endLine,
      text: quote.text,
    });
    const cancelExplorers = () => {
      for (const explorer of activeExplorers) {
        explorer.controller.abort(new DOMException("File Context explorer closed", "AbortError"));
        explorer.component?.dispose();
      }
      activeExplorers.clear();
    };
    const runExplorer = async (ctx: ExtensionContext): Promise<void> => {
      if (ctx.mode !== "tui" || !ctx.hasUI) throw new Error("/files browse requires Pi TUI mode");
      const owner = ctx.sessionManager;
      const generation = sessionGeneration;
      const activeExplorer: ActiveExplorer = { controller: new AbortController() };
      let explorerGit: NonNullable<Awaited<ReturnType<typeof createGitContext>>> | undefined;
      const { controller } = activeExplorer;
      const flowSignal = AbortSignal.any([
        controller.signal,
        sessionController.signal,
        ...(ctx.signal ? [ctx.signal] : []),
      ]);
      activeExplorers.add(activeExplorer);
      try {
        const [{ runCustomInteraction, runTask }, { FileQuoteExplorer }] = await Promise.all([
          import("@narumitw/pi-tui-kit"),
          import("./file-context-explorer.js"),
        ]);
        if (!isCurrentSession(owner, generation) || flowSignal.aborted) return;
        const task = await runTask(ctx, {
          label: "Scanning project files…",
          signal: flowSignal,
          isCurrent: () => isCurrentSession(owner, generation) && !flowSignal.aborted,
          task: ({ signal }) =>
            Promise.all([track(discoverFiles(ctx.cwd, { signal })), track(createGit(ctx.cwd, signal))]),
          onError: (_taskContext, error) => {
            ctx.ui.notify(
              `File Context could not scan project files: ${escapeTerminalControls(formatError(error))}. Use /files browse to retry.`,
              "error",
            );
          },
        });
        if (task.kind !== "completed" || !isCurrentSession(owner, generation) || flowSignal.aborted) return;
        const discovery: ExplorerDiscovery = task.value;
        const [files, gitContext] = discovery;
        if (gitContext) {
          explorerGit = gitContext;
          gitContexts.add(gitContext);
        }
        if (files.length === 0) {
          ctx.ui.notify("File Context found no project files. Use /files browse to retry.", "warning");
          return;
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
                track(
                  loadProjectTextFile(ctx.cwd, path, {
                    signal: signal ? AbortSignal.any([signal, interactionSignal]) : interactionSignal,
                  }),
                ),
              editFile: (path, signal) =>
                track(
                  editProjectFileInExternalEditor({
                    root: ctx.cwd,
                    projectPath: path,
                    tui,
                    projectTrusted: ctx.isProjectTrusted(),
                    signal: signal ? AbortSignal.any([signal, interactionSignal]) : interactionSignal,
                    isCurrent: () => isCurrentSession(owner, generation) && !interactionSignal.aborted,
                  }),
                ),
              gitContext,
              getSelectedContextState: () => ({
                count: pendingQuotes.length,
                totalBytes: pendingQuotes.reduce(
                  (total, item) => total + Buffer.byteLength(item.quote.text, "utf8"),
                  0,
                ),
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
        if (interaction.kind !== "completed" || !isCurrentSession(owner, generation) || flowSignal.aborted) return;
        const result = interaction.value;
        if (result?.kind === "quote") appendPending(result.quote, ctx);
        else if (result?.kind === "reference") ctx.ui.pasteToEditor(formatFileReference(result.path));
      } catch (error: unknown) {
        if (!isCurrentSession(owner, generation) || flowSignal.aborted || isAbortError(error)) return;
        try {
          ctx.ui.notify(
            `File Context failed: ${escapeTerminalControls(formatError(error))}. Use /files browse to retry.`,
            "error",
          );
        } catch {
          // The session may have been replaced while the picker was open.
        }
      } finally {
        activeExplorers.delete(activeExplorer);
        if (explorerGit) {
          await explorerGit.whenIdle();
          gitContexts.delete(explorerGit);
        }
      }
    };

    const openExplorer = (ctx: ExtensionContext): Promise<void> => {
      if (activeExplorerLaunch) return activeExplorerLaunch.promise;
      if (activeReviewLaunch) return activeReviewLaunch.promise;
      const launch = { promise: runExplorer(ctx) };
      activeExplorerLaunch = launch;
      void launch.promise
        .finally(() => {
          if (activeExplorerLaunch === launch) activeExplorerLaunch = undefined;
        })
        .catch(() => {});
      return launch.promise;
    };
    const review = (ctx: ExtensionCommandContext): Promise<void> => {
      if (ctx.mode !== "tui" || !ctx.hasUI) throw new Error("/files requires Pi TUI mode");
      if (activeReviewLaunch) return activeReviewLaunch.promise;
      if (activeExplorerLaunch) return activeExplorerLaunch.promise;
      if (pendingQuotes.length === 0) {
        ctx.ui.notify("File Context has no context selected for the next prompt.", "warning");
        return Promise.resolve();
      }
      const owner = ctx.sessionManager;
      const generation = sessionGeneration;
      const signal = AbortSignal.any([sessionController.signal, ...(ctx.signal ? [ctx.signal] : [])]);
      const isCurrent = () => isCurrentSession(owner, generation) && !signal.aborted;
      const promise = import("./file-context-menu.js")
        .then(({ showFileContextMenu }) => {
          if (!isCurrent()) return;
          return showFileContextMenu(ctx, {
            signal,
            isCurrent,
            getState: () => {
              if (!isCurrent()) throw new DOMException("File Context session replaced", "AbortError");
              return { quotes: pendingQuotes.map(menuQuote) };
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
          });
        })
        .then(() => undefined);
      const launch = { promise };
      activeReviewLaunch = launch;
      const clearLaunch = () => {
        if (activeReviewLaunch === launch) activeReviewLaunch = undefined;
      };
      void promise.then(clearLaunch, clearLaunch);
      return promise;
    };

    const runtime: ContextOwner = {
      controller: sessionController,
      review,
      browse: openExplorer,
      getState: () => ({
        quotes: pendingQuotes.map(menuQuote),
        shortcut: loadedSettings.settings.openShortcut,
        maximumQuotes: MAX_PENDING_QUOTES,
        maximumBytes: MAX_PENDING_QUOTE_BYTES,
        totalBytes: pendingQuotes.reduce((total, item) => total + Buffer.byteLength(item.quote.text, "utf8"), 0),
        settingsPath,
        settingsInvalidReason: loadedSettings.invalidReason,
      }),
      saveShortcut: async (ctx, shortcut, signal) => {
        if (pendingQuotes.length) throw new Error("Submit or remove selected context before changing the shortcut");
        const operation = AbortSignal.any([signal, sessionController.signal, ...(ctx.signal ? [ctx.signal] : [])]);
        operation.throwIfAborted();
        const saved = await updateSettings(shortcut, { settingsPath, signal: operation });
        if (!isCurrentSession(activeSessionManager, sessionGeneration) || operation.aborted) return;
        loadedSettings = { settings: saved };
      },
      refresh: async (ctx) => {
        const refreshed = await loadSettings();
        if (!isCurrentSession(activeSessionManager, sessionGeneration)) return;
        loadedSettings = refreshed;
        if (refreshed.warning && ctx.hasUI) ctx.ui.notify(escapeTerminalControls(refreshed.warning), "warning");
      },
      consume: (ctx) => {
        const quotes = pendingQuotes.map((item) => item.quote);
        clearPending(ctx);
        return quotes;
      },
      release: async (ctx) => {
        // A menu can be waiting for reload, which itself waits for this shutdown hook.
        const work = [activeExplorerLaunch?.promise];
        sessionController.abort(new DOMException("File Context session ended", "AbortError"));
        cancelExplorers();
        const settled = await Promise.allSettled([
          awaitFileContextSettingsWrites(settingsPath),
          Promise.resolve().then(() => clearPending(ctx)),
          ...work,
          ...nativeWork,
          ...[...gitContexts].map((git) => git.whenIdle()),
        ]);
        for (const result of settled.slice(0, 2)) if (result.status === "rejected") throw result.reason;
      },
    };
    return runtime;
  }

  const service: ContextService = {
    review: (ctx) => requireOwner(ctx).review(ctx),
    browse: (ctx) => requireOwner(ctx).browse(ctx),
    getState: (ctx) => requireOwner(ctx).getState(),
    saveShortcut: (ctx, shortcut, signal) => requireOwner(ctx).saveShortcut(ctx, shortcut, signal),
    signal: (ctx) => requireOwner(ctx).controller.signal,
  };
  if (initialSettings.settings.openShortcut) {
    pi.registerShortcut(initialSettings.settings.openShortcut, {
      description: "Open File Context",
      handler: service.browse,
    });
  }
  pi.on("session_start", async (_event, ctx) => {
    const key = ctx.sessionManager;
    const previous = owners.get(key);
    const owner = createOwner(ctx);
    owners.set(key, owner);
    if (previous) await previous.release(ctx);
    if (owners.get(key) !== owner || owner.controller.signal.aborted) return;
    (dependencies.onChange ?? publishFilesWidget)(ctx, []);
    await owner.refresh(ctx);
  });
  pi.on("before_agent_start", (event, ctx) => {
    const owner = owners.get(ctx.sessionManager);
    if (event.messageType === "custom" || !owner || owner.controller.signal.aborted || !owner.getState().quotes.length)
      return;
    return {
      message: { customType: "file-context-quotes", content: formatQuoteContext(owner.consume(ctx)), display: false },
    };
  });
  pi.on("session_shutdown", async (_event, ctx) => {
    const key = ctx.sessionManager;
    const owner = owners.get(key);
    if (!owner) return;
    try {
      await owner.release(ctx);
    } finally {
      if (owners.get(key) === owner) owners.delete(key);
    }
  });
  return service;
}

function formatFileReference(path: string): string {
  const escaped = path.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
  return /\s|["\\]/.test(path) ? `@"${escaped}" ` : `@${path} `;
}
function escapeTerminalControls(text: string): string {
  return [...text]
    .map((character) => {
      const code = character.charCodeAt(0);
      return code <= 31 || (code >= 127 && code <= 159) ? `\\x${code.toString(16).padStart(2, "0")}` : character;
    })
    .join("");
}
function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}
function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
