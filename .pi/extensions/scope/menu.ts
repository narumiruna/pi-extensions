import { isAbsolute, relative, sep } from "node:path";
import { pathToFileURL } from "node:url";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { defineMenu, runMenu, runTask } from "@narumitw/pi-tui-kit";
import { displayError, displayPath } from "./display.ts";
import { discoverScopeFiles } from "./files.ts";
import { showScopePathInput } from "./input.ts";
import { assertScopeTarget, resolveScopeTarget, type ScopeTarget } from "./paths.ts";
import { showScopePicker } from "./picker.ts";
import type { ScopeSettings } from "./settings.ts";
import { createSnapshot, MAX_TARGETS } from "./state.ts";

export interface ScopeView {
  state: "inactive" | "active" | "blocked";
  cwd: string;
  targets: readonly ScopeTarget[];
  error?: string;
}

export interface ScopeMenuOptions {
  signal: AbortSignal;
  isCurrent(): boolean;
  getView(): ScopeView;
  getSettings(): ScopeSettings;
  saveShowHiddenFiles(value: boolean): Promise<void>;
  apply(targets: readonly ScopeTarget[], newFile?: boolean, signal?: AbortSignal): Promise<void>;
  off(): Promise<void>;
}

type Screen = "main" | "settings" | "status" | "help" | "new-review";
type Action = "select" | "new" | "apply-new" | "hidden" | "off";

function stateLines(view: ScopeView): string[] {
  return [
    `Cwd: ${displayPath(view.cwd)}`,
    view.state === "inactive"
      ? "Not restricted"
      : `Editing limited to ${view.targets.length} file${view.targets.length === 1 ? "" : "s"}`,
    ...(view.state === "blocked"
      ? ["Restriction blocked: repair the allowed files or explicitly end the restriction."]
      : []),
    ...(view.error ? [displayError(view.error)] : []),
  ];
}

export async function showScopeMenu(ctx: ExtensionCommandContext, options: ScopeMenuOptions): Promise<void> {
  if (ctx.mode !== "tui" || !ctx.hasUI) throw new Error("/scope requires interactive TUI mode.");
  const current = () => !options.signal.aborted && options.isCurrent();
  const notify = (error: unknown) => {
    if (current()) ctx.ui.notify(displayError(error), "error");
  };
  let pendingNew: ScopeTarget | undefined;
  const definition = defineMenu<ScopeView, Screen, Action>({
    start: "main",
    screens: {
      main: ({ state }) => ({
        kind: "actions",
        title: "Scope",
        lines: stateLines(state),
        hint: "close",
        items: [
          {
            id: "select",
            label: state.state === "inactive" ? "Select files…" : "Change allowed files…",
            action: "select",
          },
          { id: "new", label: state.state === "inactive" ? "New file…" : "Use only a new file…", action: "new" },
          { id: "settings", label: "Settings", to: "settings" },
          { id: "status", label: "Status", to: "status" },
          { id: "help", label: "Help", to: "help" },
          ...(state.state === "inactive" ? [] : [{ id: "off", label: "End restriction", action: "off" as const }]),
          { id: "close", label: "Close", close: true },
        ],
      }),
      "new-review": ({ state }) => {
        if (!pendingNew) throw new Error("No new-file target to review.");
        const fromCwd = relative(state.cwd, pendingNew.path);
        const outside = isAbsolute(fromCwd) || fromCwd === ".." || fromCwd.startsWith(`..${sep}`);
        return {
          kind: "review",
          title: "Review new file",
          content: [
            ...(state.state === "inactive" ? [] : ["This replaces the complete allowed-file set with one file."]),
            ...(outside ? ["Outside the current directory."] : []),
            ...(pendingNew.canonical !== pendingNew.path
              ? ["The canonical target differs from the entered path."]
              : []),
            `Path: ${displayPath(pendingNew.path)}`,
            ...(pendingNew.canonical !== pendingNew.path
              ? [`Canonical target: ${displayPath(pendingNew.canonical)}`]
              : []),
            "Reserved only. The first normal write creates the file and parent directories.",
          ].join("\n"),
          format: { kind: "text" },
          viewportSize: "adaptive",
          confirm: {
            id: "apply-new",
            label: state.state === "inactive" ? "Start restriction" : "Replace allowed files with this new file",
            action: "apply-new",
          },
          hint: "back",
        };
      },
      settings: () => ({
        kind: "settings",
        title: "Scope Settings",
        lines: ["User setting. Changes are saved immediately."],
        items: [
          {
            id: "hidden",
            label: "Show hidden files",
            description:
              "Include hidden files and directories in the picker. This does not change the active restriction.",
            currentValue: options.getSettings().showHiddenFiles ? "true" : "false",
            values: ["false", "true"],
            action: "hidden",
          },
        ],
      }),
      status: ({ state }) => ({
        kind: "review",
        title: "Scope Status",
        lines: stateLines(state),
        content: [
          ...state.targets.flatMap((target, index) => [
            `${index + 1}. ${displayPath(target.path)}`,
            ...(target.path === target.canonical ? [] : [`   Canonical: ${displayPath(target.canonical)}`]),
          ]),
          "",
          "Missing selected paths are reserved. The first normal write creates the file and parent directories.",
          "While restricted, write/edit are limited to exact allowed targets. Supported readers remain available.",
          "Shell commands, tests, formatters, and opaque writing/delegation tools are blocked; use /scope off first.",
          "This guard is not an OS sandbox. User shell commands, other programs, filesystem races, and trusted extensions are outside its boundary.",
        ].join("\n"),
        format: { kind: "text" },
        viewportSize: "adaptive",
        hint: "back",
      }),
      help: () => ({
        kind: "detail",
        title: "Scope Help",
        lines: [
          "Select files to start a restriction or replace the complete allowed-file set.",
          "Search does not change checked files. Confirm file rows to toggle, then confirm Start restriction or Apply changes.",
          "Enter a full or ~/ path and confirm Add file to check an existing file, including files outside cwd. Adding a path changes only the draft.",
          "New file reserves one target; it replaces all allowed files and creates no content here.",
          "Cancelling a draft, closing this menu, and run completion do not release the restriction.",
          "Use End restriction or /scope off to release it explicitly.",
          "Discovery starts at cwd, skips symlinks and fixed generated/dependency/version-control directories, and does not use .gitignore.",
          "Settings controls only hidden-file discovery. Selected targets remain visible even when discovery would exclude them.",
          "Status lists every selected path and the tool limitations.",
        ],
        hint: "back",
      }),
    },
    actions: {
      select: async ({ signal }) => {
        const view = options.getView();
        const live = new Map(view.targets.map((target) => [target.path, target]));
        const result = await showScopePicker(ctx, {
          cwd: view.cwd,
          targets: view.targets,
          completionLabel: view.state === "inactive" ? "Start restriction" : "Apply changes",
          signal,
          isCurrent: current,
          discover: (scanSignal) => discoverScopeFiles(view.cwd, options.getSettings().showHiddenFiles, scanSignal),
          resolvePath: async (raw, validationSignal) => {
            const target = await resolveScopeTarget(raw, view.cwd, "existing", validationSignal);
            if (!current() || validationSignal.aborted)
              throw validationSignal.reason ?? new Error("Scope flow is stale.");
            return target;
          },
          validate: async (paths, validationSignal, added) => {
            if (paths.length > MAX_TARGETS) throw new Error(`Select no more than ${MAX_TARGETS} files.`);
            const manual = new Map(added.map((target) => [target.path, target] as const));
            const known = new Map([...live, ...manual]);
            const targets: ScopeTarget[] = [];
            for (const path of paths) {
              // Discovery/snapshots already contain lexical native paths. A file
              // URL preserves literal Unicode spaces through Pi's raw-input resolver.
              const nativePath = pathToFileURL(path).href;
              const existing = known.get(path);
              if (existing) {
                let checked = existing;
                if (manual.has(path)) {
                  checked = await resolveScopeTarget(nativePath, view.cwd, "existing", validationSignal);
                  if (!current() || validationSignal.aborted)
                    throw validationSignal.reason ?? new Error("Scope flow is stale.");
                  if (checked.canonical !== existing.canonical)
                    throw new Error(`The added target changed: ${displayPath(path)}. Add it again.`);
                }
                await assertScopeTarget(nativePath, view.cwd, [existing], validationSignal);
                if (!current() || validationSignal.aborted)
                  throw validationSignal.reason ?? new Error("Scope flow is stale.");
                targets.push(checked);
              } else {
                const target = await resolveScopeTarget(nativePath, view.cwd, "existing", validationSignal);
                if (!current() || validationSignal.aborted)
                  throw validationSignal.reason ?? new Error("Scope flow is stale.");
                targets.push(target);
              }
            }
            createSnapshot(view.cwd, targets);
            return targets;
          },
        });
        if (!current() || signal.aborted || result.kind === "stale") return { kind: "close" };
        if (result.kind !== "completed") return { kind: "stay" };
        if (result.value.kind === "cancelled") return { kind: result.value.reason === "close" ? "close" : "stay" };
        if (result.value.kind === "error") {
          notify(result.value.error);
          return { kind: "stay" };
        }
        if (result.value.targets.length === 0) {
          ctx.ui.notify("No files selected. The restriction is unchanged.", "info");
          return { kind: "stay" };
        }
        const selected = result.value.targets;
        const applied = await runTask(ctx, {
          label: "Applying editing scope…",
          signal,
          isCurrent: current,
          task: ({ signal: operation }) => options.apply(selected, false, operation),
          onError: (_ctx, error) => notify(error),
        });
        return { kind: applied.kind === "completed" || applied.kind === "stale" ? "close" : "stay" };
      },
      new: async ({ signal }) => {
        const view = options.getView();
        const result = await showScopePathInput(ctx, {
          cwd: view.cwd,
          signal,
          isCurrent: current,
        });
        if (!current() || signal.aborted || result.kind === "stale") return { kind: "close" };
        if (result.kind !== "completed") return { kind: "stay" };
        if (result.value.kind === "cancelled") return { kind: result.value.reason === "close" ? "close" : "stay" };
        pendingNew = result.value.target;
        return { kind: "to", screen: "new-review" };
      },
      "apply-new": async ({ signal }) => {
        if (!current() || signal.aborted || !pendingNew) return { kind: "close" };
        const target = pendingNew;
        const applied = await runTask(ctx, {
          label: "Applying new-file scope…",
          signal,
          isCurrent: current,
          task: ({ signal: operation }) => options.apply([target], true, operation),
          onError: (_ctx, error) => notify(error),
        });
        return { kind: applied.kind === "completed" || applied.kind === "stale" ? "close" : "stay" };
      },
      hidden: async ({ value, signal }) => {
        if (!current() || signal.aborted) return { kind: "close" };
        await options.saveShowHiddenFiles(value === "true");
        if (!current() || signal.aborted) return { kind: "close" };
        return { kind: "stay" };
      },
      off: async ({ signal }) => {
        if (!current() || signal.aborted) return { kind: "close" };
        await options.off();
        return { kind: "close" };
      },
    },
  });
  await runMenu(ctx, definition, {
    signal: options.signal,
    isCurrent: current,
    getState: () => options.getView(),
    onError: (_ctx, error) => notify(error),
  });
}
