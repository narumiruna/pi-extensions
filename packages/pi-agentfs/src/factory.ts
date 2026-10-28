import type { ExtensionAPI, ExtensionContext, ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { validateDatabasePath } from "./paths.js";
import { createWorkspaceTools } from "./tools.js";
import { Workspace } from "./workspace.js";

type WorkspaceState = {
  status: "loading" | "ready" | "failed" | "closed";
  workspace?: Workspace;
  initialization: Promise<void>;
};

export type AgentfsExtension = ExtensionFactory & {
  /** Call after session.bindExtensions(); Pi reports lifecycle errors without rejecting that call. */
  ready(sessionManager: object): Promise<void>;
};

/** Package-owned lifecycle shared by the SDK factory and the opt-in CLI entrypoint. */
export function installAgentfsLifecycle(
  pi: ExtensionAPI,
  states: WeakMap<object, WorkspaceState>,
  resolvePath: () => unknown,
  registerDuringLoad: boolean,
): void {
  // CLI flags are fixed for this runtime, including an absent flag.
  let pathResolved = false;
  let path: unknown;
  let requested = registerDuringLoad;

  const resolveWorkspace = (ctx: ExtensionContext): Workspace => {
    const state = states.get(ctx.sessionManager);
    if (state?.status !== "ready" || !state.workspace) {
      throw new Error(`AgentFS workspace is ${state?.status ?? "not started"}`);
    }
    return state.workspace;
  };
  let toolsRegistered = false;
  const registerTools = () => {
    if (toolsRegistered) return;
    for (const tool of createWorkspaceTools(resolveWorkspace)) pi.registerTool(tool);
    toolsRegistered = true;
  };
  if (registerDuringLoad) registerTools();

  pi.on("user_bash", () => {
    if (requested) {
      // Returning undefined here would let ! and !! execute on the host.
      throw new Error("AgentFS blocks ! and !! host commands; use the bash tool instead");
    }
    return undefined;
  });

  pi.on("session_start", async (_event, ctx) => {
    if (!pathResolved) {
      path = resolvePath();
      pathResolved = true;
    }
    if (path === undefined && !registerDuringLoad) return;
    requested = true;

    const key = ctx.sessionManager;
    const previous = states.get(key);
    if (previous) previous.status = "closed";
    const state: WorkspaceState = { status: "loading", initialization: Promise.resolve() };
    const isCurrent = () => states.get(key) === state && state.status !== "closed";
    states.set(key, state);
    // Replace host tools before validation or opening. Pi swallows session_start errors.
    if (!registerDuringLoad) registerTools();
    state.initialization = (async () => {
      try {
        await previous?.workspace?.close();
        if (!isCurrent()) throw new Error("AgentFS workspace was closed during initialization");
        validateDatabasePath(path);
        state.workspace = new Workspace(path);
        await state.workspace.open();
        if (!isCurrent()) throw new Error("AgentFS workspace was closed during initialization");
        state.status = "ready";
      } catch (error) {
        if (state.status !== "closed") state.status = "failed";
        await state.workspace?.close();
        throw error;
      }
    })();
    await state.initialization;
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    const state = states.get(ctx.sessionManager);
    if (!state) return;
    state.status = "closed";
    await state.workspace?.close();
    // Also drain a pending open, including its cleanup, before shutdown returns.
    await state.initialization.catch(() => undefined);
  });
}

/** Register exactly the AgentFS read, write, edit, and bash replacements. */
export function createAgentfsExtension(options: { path: string }): AgentfsExtension {
  validateDatabasePath(options.path);
  const path = options.path;
  const states = new WeakMap<object, WorkspaceState>();
  const factory: ExtensionFactory = (pi) => installAgentfsLifecycle(pi, states, () => path, true);
  return Object.assign(factory, {
    async ready(sessionManager: object): Promise<void> {
      const state = states.get(sessionManager);
      if (!state) throw new Error("AgentFS workspace has not started; call session.bindExtensions() first");
      await state.initialization;
      if (states.get(sessionManager) !== state || state.status !== "ready") {
        throw new Error(`AgentFS workspace is ${state.status}`);
      }
    },
  });
}
