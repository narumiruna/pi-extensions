import { homedir } from "node:os";
import { type ExtensionAPI, type ExtensionCommandContext, getAgentDir } from "@earendil-works/pi-coding-agent";
import { argumentCompletions, parseCommand, type Route } from "./command.ts";
import type { Environment, Guard } from "./types.ts";

interface Owner {
  controller: AbortController;
  running?: Promise<boolean>;
}

type ShowMenu = (ctx: ExtensionCommandContext, route: Route, env: Environment, guard: Guard) => Promise<boolean>;

const showMenu: ShowMenu = async (ctx, route, env, guard) => {
  const { showSkillsMenu } = await import("./menu.ts");
  guard.check();
  return showSkillsMenu(ctx, route, env, guard);
};

export function createSkillsExtension(show: ShowMenu = showMenu) {
  return (pi: ExtensionAPI) => {
    const owners = new Map<object, Owner>();
    const starts = new WeakMap<object, object>();
    const release = async (key: object) => {
      const owner = owners.get(key);
      if (!owner) return;
      owner.controller.abort(new DOMException("Skills session ended", "AbortError"));
      try {
        await owner.running;
      } catch {
        /* The command reports non-cancellation failures. */
      }
      if (owners.get(key) === owner) owners.delete(key);
    };

    pi.on("session_start", async (_event, ctx) => {
      const key = ctx.sessionManager;
      const token = {};
      starts.set(key, token);
      await release(key);
      if (starts.get(key) === token) owners.set(key, { controller: new AbortController() });
    });
    pi.on("session_shutdown", async (_event, ctx) => {
      const key = ctx.sessionManager;
      starts.delete(key);
      await release(key);
    });

    pi.registerCommand("skills", {
      description: "Manage local skill bundles and model invocation",
      getArgumentCompletions: argumentCompletions,
      handler: async (args, ctx) => {
        const route = parseCommand(args);
        if ((ctx.mode !== "tui" && ctx.mode !== "rpc") || !ctx.hasUI) {
          throw new Error("/skills requires Pi TUI or an RPC client with extension dialogs");
        }
        const key = ctx.sessionManager;
        let owner = owners.get(key);
        if (!owner) {
          owner = { controller: new AbortController() };
          owners.set(key, owner);
        }
        if (owner.running) throw new Error("A skills operation is already open in this session");
        const current = owner;
        const guard: Guard = {
          signal: current.controller.signal,
          check() {
            current.controller.signal.throwIfAborted();
            if (owners.get(key) !== current) throw new DOMException("Skills session replaced", "AbortError");
          },
          isProjectTrusted: () => ctx.isProjectTrusted(),
        };
        const env: Environment = {
          cwd: ctx.cwd,
          agentDir: getAgentDir(),
          homeDir: homedir(),
          isProjectTrusted: guard.isProjectTrusted,
        };
        const work = Promise.resolve().then(() => {
          guard.check();
          return show(ctx, route, env, guard);
        });
        current.running = work;
        let reload = false;
        try {
          reload = await work;
          guard.check();
        } catch (error) {
          if (!current.controller.signal.aborted) throw error;
        } finally {
          if (current.running === work) current.running = undefined;
        }
        if (reload && !current.controller.signal.aborted && owners.get(key) === current) {
          // Release command ownership before reload: session_shutdown must not await itself.
          await ctx.reload();
          return;
        }
      },
    });
  };
}

export default createSkillsExtension();
