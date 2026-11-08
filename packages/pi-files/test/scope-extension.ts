import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { EditorStatusWidget } from "@narumitw/pi-tui-kit/editor-status-widget";
import { displayPath } from "../src/scope/display.js";
import { registerScope, type ScopeOptions, type ShowMenu } from "../src/scope/edit-scope.js";

/** Test-only predecessor UI consumer; production publishes through the Files aggregator. */
export function createEditScopeExtension(showMenu?: ShowMenu, options: Omit<ScopeOptions, "showMenu"> = {}) {
  return (pi: ExtensionAPI) =>
    registerScope(pi, {
      showMenu,
      onChange(ctx, view) {
        options.onChange?.(ctx, view);
        if (!view || view.state === "inactive" || ctx.mode !== "tui" || !ctx.hasUI) {
          ctx.ui.setWidget("edit-scope", undefined);
          return;
        }
        ctx.ui.setWidget(
          "edit-scope",
          (_tui, theme) =>
            new EditorStatusWidget({
              theme,
              renderBody: () => [
                theme.fg(
                  view.state === "blocked" ? "error" : "accent",
                  view.state === "blocked"
                    ? "Edit Scope unavailable · edits blocked"
                    : `Editing limited to ${view.targets.length} file${view.targets.length === 1 ? "" : "s"}`,
                ),
                theme.fg(
                  "dim",
                  `${view.targets
                    .slice(0, 2)
                    .map((target) => displayPath(target.path))
                    .join(
                      " · ",
                    )}${view.targets.length > 2 ? " · …" : ""}${view.targets.length ? " · " : ""}/edit-scope off`,
                ),
              ],
            }),
        );
      },
    });
}
