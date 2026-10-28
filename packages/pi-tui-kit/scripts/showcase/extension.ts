import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

const COMMAND_NAME = "tui-kit-showcase";
const USAGE = "Usage: /tui-kit-showcase";

type ShowcaseRuntimeModule = Pick<typeof import("./runtime.js"), "showTuiKitShowcase">;

export interface PiTuiKitShowcaseDependencies {
  loadRuntime?: () => Promise<ShowcaseRuntimeModule>;
}

export function createPiTuiKitShowcaseExtension(
  dependencies: PiTuiKitShowcaseDependencies = {},
): (pi: ExtensionAPI) => void {
  return function piTuiKitShowcaseExtension(pi: ExtensionAPI): void {
    const loadRuntime = cachedModuleLoader(dependencies.loadRuntime ?? (() => import("./runtime.js")));
    let generation = 0;
    let owner = new AbortController();
    let pendingCommand: Promise<void> | undefined;

    function replaceSessionOwner() {
      owner.abort();
      owner = new AbortController();
      generation += 1;
    }

    function abortSessionOwner() {
      owner.abort();
      generation += 1;
    }

    pi.on("session_start", async () => {
      replaceSessionOwner();
      await pendingCommand?.catch(() => {});
    });
    pi.on("session_shutdown", async () => {
      abortSessionOwner();
      await pendingCommand?.catch(() => {});
    });

    pi.registerCommand(COMMAND_NAME, {
      description: "Open the private Pi TUI Kit showcase",
      getArgumentCompletions: () => [],
      handler: async (rawArgs, ctx) => {
        const args = rawArgs.trim();
        if (args) throw new Error(USAGE);
        if (ctx.mode !== "tui") {
          reportUnsupportedMode(ctx);
          return;
        }

        // A new command cancels and drains the previous interaction before it
        // opens another custom component on the same host.
        replaceSessionOwner();
        const commandGeneration = generation;
        const signal = owner.signal;
        const isCurrent = () => !signal.aborted && commandGeneration === generation;
        const previous = pendingCommand;
        const running = (async () => {
          await previous?.catch(() => {});
          if (!isCurrent()) return;
          try {
            const runtime = await loadRuntime();
            if (!isCurrent()) return;
            await runtime.showTuiKitShowcase(ctx, { signal, isCurrent });
          } catch (error) {
            if (isCurrent()) throw error;
          }
        })();
        pendingCommand = running;
        try {
          await running;
        } finally {
          if (pendingCommand === running) pendingCommand = undefined;
        }
      },
    });
  };
}

function reportUnsupportedMode(ctx: ExtensionCommandContext): void {
  const message = "Pi TUI Kit Showcase is an interactive visual demo. Run /tui-kit-showcase in TUI mode.";
  if (ctx.mode === "rpc" && ctx.hasUI) {
    ctx.ui.notify(message, "warning");
    return;
  }
  throw new Error(`${message} ${USAGE}`);
}

function cachedModuleLoader<T>(load: () => Promise<T>): () => Promise<T> {
  let promise: Promise<T> | undefined;
  return async () => {
    promise ??= load().catch((error) => {
      promise = undefined;
      throw error;
    });
    return promise;
  };
}

export default createPiTuiKitShowcaseExtension();
