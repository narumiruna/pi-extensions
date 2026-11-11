import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { EditorStatusWidgetState } from "@narumitw/pi-tui-kit/editor-status-widget";
import { type ContextOptions, type ContextService, registerFileContext } from "./context-service.js";
import type { FileQuote } from "./file-context.js";
import { publishFilesWidget } from "./files-widget.js";
import { registerScope, type ScopeOptions, type ScopeView } from "./scope/edit-scope.js";

interface Flow {
  kind: "context" | "scope" | "manager";
  controller: AbortController;
  promise: Promise<void>;
}
interface Display {
  widgetState: EditorStatusWidgetState;
  quotes: readonly FileQuote[];
  scope?: ScopeView;
}
export interface FilesOptions {
  context?: ContextOptions;
  scope?: Pick<ScopeOptions, "showMenu">;
}

/** The single extension factory; services share UI ownership, not permission state. */
export async function registerFiles(pi: ExtensionAPI, options: FilesOptions = {}): Promise<void> {
  const flows = new Map<object, Flow>();
  const displays = new Map<object, Display>();
  const display = (ctx: ExtensionContext): Display => {
    let state = displays.get(ctx.sessionManager);
    if (!state) {
      state = { quotes: [], widgetState: { collapsed: false } };
      displays.set(ctx.sessionManager, state);
    }
    return state;
  };
  const redraw = (ctx: ExtensionContext) => {
    const state = display(ctx);
    publishFilesWidget(ctx, state.quotes, state.scope, state.widgetState);
  };
  const runFlow = (
    ctx: ExtensionContext,
    kind: Flow["kind"],
    run: (ctx: ExtensionContext) => Promise<void> | void,
  ): Promise<void> => {
    const key = ctx.sessionManager;
    const previous = flows.get(key);
    if (previous) {
      if (kind === "context" && previous.kind === kind) return previous.promise;
      throw new Error(
        kind === "scope" && previous.kind === "scope"
          ? "A Scope menu is already open; close it before issuing another Scope command"
          : "A Files menu is already open; close it before opening another file flow",
      );
    }
    const flow: Flow = { kind, controller: new AbortController(), promise: Promise.resolve() };
    const signal = AbortSignal.any([flow.controller.signal, ...(ctx.signal ? [ctx.signal] : [])]);
    const scoped = Object.create(ctx) as ExtensionContext;
    Object.defineProperty(scoped, "signal", { value: signal });
    flows.set(key, flow);
    flow.promise = Promise.resolve()
      .then(() => {
        signal.throwIfAborted();
        return run(scoped);
      })
      .finally(() => {
        if (flows.get(key) === flow) flows.delete(key);
      });
    return flow.promise;
  };
  const cancelFlow = (ctx: ExtensionContext) => {
    const flow = flows.get(ctx.sessionManager);
    if (!flow) return;
    flow.controller.abort(new DOMException("Files session or branch changed", "AbortError"));
    // Reload waits for lifecycle hooks: do not wait here for the command that requested it.
    // Services drain native work and writes; aborted UI continuations cannot publish new state.
    if (flows.get(ctx.sessionManager) === flow) flows.delete(ctx.sessionManager);
  };
  // Run before the service handlers so replaced UI cannot outlive restoration.
  pi.on("session_start", (_event, ctx) => {
    cancelFlow(ctx);
    displays.delete(ctx.sessionManager);
    if (ctx.hasUI) ctx.ui.setWidget("files", undefined);
  });
  pi.on("session_tree", (_event, ctx) => cancelFlow(ctx));
  pi.on("session_shutdown", (_event, ctx) => cancelFlow(ctx));

  const serviceAPI: ExtensionAPI = {
    ...pi,
    registerCommand(name, command) {
      pi.registerCommand(name, {
        ...command,
        handler: (args, ctx) => {
          const route = name === "file-context" ? args.trim().toLowerCase() : args.trim();
          const valid =
            name === "file-context" ? ["", "browse", "remove"].includes(route) : ["", "off"].includes(route);
          if (!valid || ctx.mode !== "tui") return command.handler(args, ctx);
          return runFlow(ctx, name === "file-context" ? "context" : "scope", (scoped) =>
            command.handler(args, scoped as ExtensionCommandContext),
          );
        },
      });
    },
    registerShortcut(key, shortcut) {
      pi.registerShortcut(key, {
        ...shortcut,
        handler: (ctx) => runFlow(ctx, "context", (scoped) => shortcut.handler(scoped)),
      });
    },
  };
  // Enforcement is registered before the first settings await and stays eager.
  const scope = registerScope(serviceAPI, {
    ...options.scope,
    onChange: (ctx, state) => {
      display(ctx).scope = state;
      redraw(ctx);
    },
  });
  const context: ContextService = await registerFileContext(serviceAPI, {
    ...options.context,
    onChange: (ctx, quotes) => {
      display(ctx).quotes = quotes;
      redraw(ctx);
    },
  });

  pi.registerCommand("files", {
    description: "Browse file context and manage allowed edit targets",
    getArgumentCompletions: (prefix) =>
      [
        { value: "browse", label: "browse", description: "Open the context browser" },
        { value: "off", label: "off", description: "End the editing restriction" },
      ].filter((item) => item.value.startsWith(prefix)),
    handler: async (args, ctx) => {
      const route = args.trim();
      if (route !== "" && route !== "browse" && route !== "off") throw new Error("Usage: /files [browse|off]");
      if (ctx.mode !== "tui" || !ctx.hasUI) throw new Error("/files requires Pi TUI mode");
      await runFlow(ctx, route === "browse" ? "context" : "manager", async (scoped) => {
        if (route === "browse") return context.browse(scoped);
        const commandCtx = scoped as ExtensionCommandContext;
        if (route === "off") {
          scope.off(commandCtx);
          return;
        }
        // The existing manager is the keyboard route to restore the summary.
        if (display(scoped).widgetState.collapsed) {
          display(scoped).widgetState.collapsed = false;
          redraw(scoped);
        }
        const { showFilesMenu } = await import("./files-menu.js");
        scoped.signal?.throwIfAborted();
        await showFilesMenu(commandCtx, context, scope);
      });
    },
  });
  pi.on("session_shutdown", (_event, ctx) => {
    displays.delete(ctx.sessionManager);
    if (ctx.hasUI) ctx.ui.setWidget("files", undefined);
  });
}
export default registerFiles;
