import {
  type ExtensionAPI,
  type ExtensionCommandContext,
  type ExtensionContext,
  getAgentDir,
} from "@earendil-works/pi-coding-agent";
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
      if (!isCurrent()) throw new Error("Pi Notes session is no longer active.");

      const agentDir = deps.getAgentDir();
      const storage = deps.createStorage(agentDir);
      await storage.initialize(signal);
      if (!isCurrent() || signal.aborted) return;
      const selected = await deps.showManager(ctx, storage, { signal, isCurrent });
      if (!isCurrent() || signal.aborted || selected.kind !== "open" || !selected.notePath) return;
      const thinkingLevel = pi.getThinkingLevel();
      if (!isCurrent() || signal.aborted) return;
      await deps.openWorkspace({
        ctx,
        agentDir,
        storage,
        notePath: selected.notePath,
        thinkingLevel,
        signal,
        isCurrent,
      });
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
