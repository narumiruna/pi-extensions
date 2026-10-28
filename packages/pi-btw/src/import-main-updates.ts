import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { MenuContext } from "@narumitw/pi-tui-kit";
import {
  buildMainContextSnapshot,
  type MainContextSnapshot,
  validateMainContextSnapshot,
} from "./main-context-snapshot.js";
import { runBtwMenuPreservingEditor } from "./menu.js";
import { appendMainContextUpdate, type SideThread } from "./side-thread.js";

export type ImportMainResult = "imported" | "back" | "close";
export type MainUpdatePreview = (
  ctx: ExtensionCommandContext,
  snapshot: MainContextSnapshot,
) => Promise<"confirm" | "back" | "close">;

export async function importMainUpdates(
  thread: SideThread,
  ctx: ExtensionCommandContext,
  preview: MainUpdatePreview = showMainUpdatePreview,
): Promise<ImportMainResult> {
  if (ctx.mode !== "tui" || ctx.signal?.aborted) return "close";
  const manager = ctx.sessionManager;
  const snapshot = buildMainContextSnapshot(manager, thread.source);
  if (snapshot.kind !== "ready") {
    ctx.ui.notify(
      snapshot.kind === "empty" ? "No completed main updates to import." : snapshot.reason,
      snapshot.kind === "empty" ? "info" : "warning",
    );
    return "back";
  }
  const turnCount = thread.turns.length;
  const updateCount = thread.updates.length;
  const result = await preview(ctx, snapshot);
  if (ctx.signal?.aborted || result === "close") return "close";
  if (result !== "confirm") return "back";
  if (
    ctx.sessionManager !== manager ||
    thread.turns.length !== turnCount ||
    thread.updates.length !== updateCount ||
    !validateMainContextSnapshot(manager, snapshot) ||
    !appendMainContextUpdate(thread, snapshot)
  ) {
    ctx.ui.notify("Main context or side thread changed. Import was not applied; review it again.", "warning");
    return "back";
  }
  return "imported";
}

export async function showMainUpdatePreview(
  ctx: ExtensionCommandContext,
  snapshot: MainContextSnapshot,
): Promise<"confirm" | "back" | "close"> {
  if (ctx.mode !== "tui" || ctx.signal?.aborted) return "close";
  const { defineMenu, runMenu } = await import("@narumitw/pi-tui-kit");
  if (ctx.signal?.aborted) return "close";
  let confirmed = false;
  const menu = defineMenu<void, "preview", "import", MenuContext>({
    start: "preview",
    screens: {
      preview: () => ({
        kind: "review",
        title: `Import main updates · ${snapshot.text.length} characters`,
        content: `Source session: ${snapshot.source.sessionId}\nEntries: ${snapshot.source.entryId ?? "root"} → ${snapshot.target.entryId}\n${snapshot.entryCount} entries scanned. Text and bounded tool evidence only.\n\n${snapshot.text}`,
        viewportSize: "adaptive",
        hint: "back",
        confirm: { id: "import", label: "Import", action: "import" },
      }),
    },
    actions: {
      import: () => {
        confirmed = true;
        return { kind: "close" };
      },
    },
  });
  const result = await runBtwMenuPreservingEditor(ctx, (menuContext) =>
    runMenu(menuContext, menu, { getState: () => undefined, signal: ctx.signal }),
  );
  if (ctx.signal?.aborted || result.kind === "stale") return "close";
  if (result.kind === "error") throw result.error;
  if (confirmed && result.kind === "closed" && result.reason === "close") return "confirm";
  return result.kind === "closed" && result.reason === "back" ? "back" : "close";
}
