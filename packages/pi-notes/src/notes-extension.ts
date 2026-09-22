import {
  type ExtensionAPI,
  type ExtensionCommandContext,
  type ExtensionContext,
  getAgentDir,
} from "@earendil-works/pi-coding-agent";
import { sanitizeTerminalText } from "@narumitw/pi-tui-kit/terminal-text";
import type { NotesManagerResult } from "./menu.js";
import { NotesStorage } from "./storage.js";
import type { OpenNotesWorkspaceOptions } from "./workspace.js";

interface NotesExtensionDependencies {
  getAgentDir(): string;
  createStorage(agentDir: string): NotesStorage;
  showManager(
    ctx: ExtensionCommandContext,
    storage: NotesStorage,
    ownership: { signal: AbortSignal; isCurrent(): boolean },
  ): Promise<NotesManagerResult>;
  openWorkspace(options: OpenNotesWorkspaceOptions): Promise<void>;
}

export function createNotesExtension(
  dependencies: Partial<NotesExtensionDependencies> = {},
): (pi: ExtensionAPI) => void {
  const deps: NotesExtensionDependencies = {
    getAgentDir: dependencies.getAgentDir ?? getAgentDir,
    createStorage: dependencies.createStorage ?? ((agentDir) => new NotesStorage(agentDir)),
    showManager:
      dependencies.showManager ??
      (async (ctx, storage, ownership) => {
        const { showNotesManager } = await import("./menu.js");
        if (ownership.signal.aborted || !ownership.isCurrent()) return { kind: "closed" };
        return showNotesManager(ctx, storage, ownership);
      }),
    openWorkspace:
      dependencies.openWorkspace ??
      (async (options) => {
        const { openNotesWorkspace } = await import("./workspace.js");
        if (options.signal.aborted || !options.isCurrent()) return;
        await openNotesWorkspace(options);
      }),
  };

  return function notesExtension(pi: ExtensionAPI): void {
    let generation = 0;
    let activeSessionManager: unknown;
    let sessionController = new AbortController();
    const activeCommands = new Set<Promise<void>>();

    const replaceOwner = (sessionManager: unknown, reason: string) => {
      sessionController.abort(new DOMException(reason, "AbortError"));
      sessionController = new AbortController();
      activeSessionManager = sessionManager;
      generation += 1;
    };

    const runCommand = async (args: string, ctx: ExtensionCommandContext): Promise<void> => {
      if (args.trim()) {
        rejectCommand(ctx, "Usage: /notes");
        return;
      }
      if (ctx.mode !== "tui" || !ctx.hasUI) throw new Error("/notes requires Pi TUI mode.");
      if (activeSessionManager === undefined) replaceOwner(ctx.sessionManager, "Pi Notes initialized a session owner");
      const owner = ctx.sessionManager;
      const ownerGeneration = generation;
      const ownerController = sessionController;
      const signal = ctx.signal ? AbortSignal.any([ctx.signal, ownerController.signal]) : ownerController.signal;
      const isCurrent = () =>
        activeSessionManager === owner && generation === ownerGeneration && !ownerController.signal.aborted;
      const isOwned = () => isCurrent() && !signal.aborted;
      if (!isOwned()) throw new Error("Pi Notes session is no longer active.");

      const agentDir = deps.getAgentDir();
      const storage = deps.createStorage(agentDir);
      await storage.initialize(signal);
      if (!isOwned()) return;

      while (isOwned()) {
        const selected = await deps.showManager(ctx, storage, { signal, isCurrent });
        if (!isOwned()) return;
        if (selected.kind === "closed") return;

        if (selected.kind === "pastePath") {
          const absolutePath = await storage.resolveCanonicalNotePath(selected.notePath, signal);
          if (!isOwned()) return;
          ctx.ui.pasteToEditor(absolutePath);
          return;
        }

        if (selected.kind === "editTemplate") {
          const template = await storage.readTemplate(selected.templatePath, signal);
          if (!isOwned()) return;
          const content = await ctx.ui.editor(
            `Edit template · ${sanitizeTerminalText(template.relativePath)}`,
            template.content,
          );
          if (!isOwned()) return;
          if (content === undefined || content === template.content) continue;
          try {
            await storage.replaceTemplate(template.relativePath, template.revision, content, signal);
          } catch (error) {
            if (!isOwned()) return;
            safeNotify(ctx, `Pi Notes failed to save template: ${safeErrorMessage(error)}`, "error");
            continue;
          }
          if (!isOwned()) return;
          safeNotify(ctx, `Saved template: ${template.relativePath}`, "info");
          continue;
        }

        const thinkingLevel = pi.getThinkingLevel();
        if (!isOwned()) return;
        await deps.openWorkspace({
          ctx,
          agentDir,
          storage,
          notePath: selected.notePath,
          thinkingLevel,
          signal,
          isCurrent,
        });
        if (!isOwned()) return;
        return;
      }
    };

    pi.registerCommand("notes", {
      description: "Browse and edit global Markdown notes with an isolated agent",
      handler: async (args, ctx) => {
        const task = runCommand(args, ctx);
        activeCommands.add(task);
        try {
          await task;
        } finally {
          activeCommands.delete(task);
        }
      },
    });

    pi.on("session_start", async (_event, ctx) => {
      if (activeSessionManager !== undefined) {
        sessionController.abort(new DOMException("Pi Notes parent session replaced or reloaded", "AbortError"));
        await Promise.allSettled([...activeCommands]);
      }
      replaceOwner(ctx.sessionManager, "Pi Notes session started");
    });

    pi.on("session_shutdown", async (_event, ctx) => {
      if (ctx.sessionManager !== activeSessionManager) return;
      sessionController.abort(new DOMException("Pi Notes session shut down", "AbortError"));
      activeSessionManager = undefined;
      generation += 1;
      await Promise.allSettled([...activeCommands]);
    });
  };
}

function safeNotify(ctx: ExtensionContext, message: string, level: "info" | "warning" | "error"): void {
  try {
    ctx.ui.notify(sanitizeTerminalText(message), level);
  } catch {
    // A replaced session can invalidate the old UI immediately.
  }
}

function safeErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function rejectCommand(ctx: ExtensionContext, message: string): void {
  if (ctx.hasUI) {
    try {
      ctx.ui.notify(message, "warning");
    } catch {
      // A replaced session can invalidate the old UI immediately.
    }
    return;
  }
  throw new Error(message);
}

export default createNotesExtension();
