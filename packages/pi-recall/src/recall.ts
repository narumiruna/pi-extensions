import { join } from "node:path";
import { type ExtensionAPI, type ExtensionContext, getAgentDir } from "@earendil-works/pi-coding-agent";
import type { RecallMenuSource } from "./menu.js";
import { extractMessageCandidates, normalizeCwd } from "./messages.js";
import { RecallStore } from "./store.js";

interface RecallDependencies {
  getAgentDir(): string;
  createStore(path: string): RecallStore;
}

export function createRecallExtension(dependencies: Partial<RecallDependencies> = {}): (pi: ExtensionAPI) => void {
  const deps: RecallDependencies = {
    getAgentDir: dependencies.getAgentDir ?? getAgentDir,
    createStore: dependencies.createStore ?? ((path) => new RecallStore(path)),
  };

  return function recallExtension(pi: ExtensionAPI): void {
    let generation = 0;
    let sessionController = new AbortController();
    let activeSessionManager: unknown;

    pi.registerCommand("recall", {
      description: "Save and recall messages across Pi sessions",
      handler: async (args, ctx) => {
        if (args.trim()) {
          rejectCommand(ctx, "Usage: /recall");
          return;
        }
        if (ctx.mode !== "tui" && ctx.mode !== "rpc") {
          throw new Error("/recall requires Pi TUI or RPC mode.");
        }
        const owner = ctx.sessionManager;
        const ownerGeneration = generation;
        const controller = sessionController;
        const isCurrent = () =>
          activeSessionManager === owner && generation === ownerGeneration && !controller.signal.aborted;
        if (!isCurrent()) throw new Error("Pi Recall session is no longer active.");

        const sessionId = ctx.sessionManager.getSessionId();
        const cwd = normalizeCwd(ctx.cwd, process.platform);
        const sessionName = ctx.sessionManager.getSessionName();
        const candidates = extractMessageCandidates(ctx.sessionManager.getBranch(), {
          sessionId,
          ...(sessionName ? { sessionName } : {}),
          cwd,
        });
        const store = deps.createStore(join(deps.getAgentDir(), "pi-recall.jsonl"));
        const source: RecallMenuSource = {
          path: store.path,
          current: { sessionId, cwd },
          candidates,
          load: (signal) => store.load(signal),
          save: (candidate, signal) => store.save(candidate, signal),
          delete: (id, signal) => store.delete(id, signal),
        };
        const { showRecallMenu } = await import("./menu.js");
        if (!isCurrent()) return;
        await showRecallMenu(ctx, source, { signal: controller.signal, isCurrent });
      },
    });

    pi.on("session_start", (_event, ctx) => {
      sessionController.abort(new DOMException("Pi Recall session replaced", "AbortError"));
      sessionController = new AbortController();
      generation += 1;
      activeSessionManager = ctx.sessionManager;
    });

    pi.on("session_shutdown", (_event, ctx) => {
      if (ctx.sessionManager !== activeSessionManager) return;
      sessionController.abort(new DOMException("Pi Recall session shut down", "AbortError"));
      activeSessionManager = undefined;
      generation += 1;
    });
  };
}

function rejectCommand(ctx: ExtensionContext, message: string): void {
  if (ctx.hasUI) {
    safeNotify(ctx, message, "warning");
    return;
  }
  throw new Error(message);
}

function safeNotify(ctx: ExtensionContext, message: string, level: "info" | "warning" | "error"): void {
  try {
    ctx.ui.notify(message, level);
  } catch {
    // Session replacement can invalidate an old UI immediately.
  }
}

export default createRecallExtension();
