import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { defineMenu, runMenu } from "@narumitw/pi-tui-kit";
import type { ContextService } from "./context-service.js";
import { displayPath } from "./scope/display.js";
import type { ScopeService } from "./scope/edit-scope.js";

type Screen = "main" | "status" | "help";
type Action = "browse" | "review" | "scope" | "settings";

export async function showFilesMenu(
  ctx: ExtensionCommandContext,
  context: ContextService,
  scope: ScopeService,
): Promise<void> {
  if (ctx.mode !== "tui" || !ctx.hasUI) throw new Error("/files requires Pi TUI mode");
  const signal = AbortSignal.any([context.signal(ctx), scope.signal(ctx), ...(ctx.signal ? [ctx.signal] : [])]);
  const current = () => !signal.aborted;
  const state = () => ({ context: context.getState(ctx), scope: scope.getView(ctx) });
  let next: Action | undefined;
  const menu = defineMenu<ReturnType<typeof state>, Screen, Action, ExtensionCommandContext>({
    start: "main",
    screens: {
      main: ({ state }) => ({
        kind: "actions",
        title: "Files",
        lines: [
          `Next prompt context: ${state.context.quotes.length} snippets`,
          state.scope.state === "inactive"
            ? "Edit scope: unrestricted"
            : state.scope.state === "blocked"
              ? "Edit scope: unavailable · edits blocked"
              : `Edit scope: ${state.scope.targets.length} allowed files`,
        ],
        items: [
          {
            id: "browse",
            label: "Browse files",
            description: "Preview files and attach context; does not grant edit permission",
            action: "browse",
          },
          {
            id: "review",
            label: `Review queued context (${state.context.quotes.length})`,
            description: "Inspect exact snapshots and remove snippets",
            action: "review",
            disabled: !state.context.quotes.length,
          },
          {
            id: "scope",
            label: "Manage edit scope",
            description: "Select allowed targets, reserve a new file, or end the restriction",
            action: "scope",
          },
          {
            id: "settings",
            label: "Settings",
            description: "Browser shortcut and hidden-file discovery preference",
            action: "settings",
          },
          { id: "status", label: "Status", description: "Review context and every allowed target", to: "status" },
          { id: "help", label: "Help", description: "Read state lifetimes and the protection boundary", to: "help" },
        ],
        hint: "close",
      }),
      status: ({ state }) => ({
        kind: "detail",
        title: "Files Status",
        lines: [
          `Next prompt context: ${state.context.quotes.length}/${state.context.maximumQuotes} snippets · ${state.context.totalBytes}/${state.context.maximumBytes} bytes`,
          `Browser shortcut: ${state.context.shortcut ?? "disabled"}`,
          `Edit scope: ${state.scope.state}`,
          ...(state.scope.error ? [state.scope.error] : []),
          ...state.scope.targets.map(
            (target) =>
              `${displayPath(target.path)}${target.canonical !== target.path ? ` → ${displayPath(target.canonical)}` : ""}`,
          ),
          ...(state.scope.state === "inactive" ? [] : ["/files off explicitly ends the editing restriction."]),
          "Reserved new-file targets are created only by a normal write call.",
        ],
        hint: "back",
      }),
      help: () => ({
        kind: "detail",
        title: "Files Help",
        lines: [
          "Context snapshots attach once to the next ordinary prompt; selecting context never grants edit permission.",
          "Edit scope lasts until explicitly ended and is restored from the active session branch; selecting a target never loads its content.",
          "An active restriction allows only stock readers and target-checked native write/edit. Shell, codemode, delegation, and custom tools are blocked.",
          "This is an in-process guard, not an OS sandbox. The user-controlled external editor is outside native-tool enforcement.",
          "/file-context [browse|remove] and /edit-scope or /scope [off] keep their existing workflows.",
          "Do not load predecessor extensions with Files. Remove or disable their user and project resources, then reload.",
          "Escape goes back. Ctrl+C closes transient UI without ending an active restriction.",
        ],
        hint: "back",
      }),
    },
    actions: {
      browse: () => {
        next = "browse";
        return { kind: "close" };
      },
      review: () => {
        next = "review";
        return { kind: "close" };
      },
      scope: () => {
        next = "scope";
        return { kind: "close" };
      },
      settings: () => {
        next = "settings";
        return { kind: "close" };
      },
    },
  });
  const result = await runMenu(ctx, menu, { signal, isCurrent: current, getState: state });
  if (!current() || result.kind !== "closed") return;
  if (next === "browse") await context.browse(ctx);
  else if (next === "review") await context.open(ctx, "remove");
  else if (next === "scope") await scope.open(ctx, signal);
  else if (next === "settings") {
    const { showFilesSettings } = await import("./files-settings.js");
    if (current()) await showFilesSettings(ctx, context, scope);
  }
}
