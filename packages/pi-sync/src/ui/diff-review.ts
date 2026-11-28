import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { DiffReviewPreview } from "@narumitw/pi-sync-daemon";
import { defineMenu, runMenu } from "@narumitw/pi-tui-kit";
import { runDocumentReview } from "@narumitw/pi-tui-kit/document-review";
import type { ActiveDiffReview, OpenDiffReviewResult } from "../daemon/diff-review.js";
import { captureMutationOwner } from "../sync/sync-local.js";
import { type CancellableTaskResult, runCancellableTask } from "./cancellable-operation.js";
import { safeTerminalText, snapshotPathLabel } from "./terminal-text.js";

type OpenReview = (signal?: AbortSignal) => Promise<OpenDiffReviewResult>;
const direction = "− Local · + Remote";
const status = { "local-only": "Local only", "remote-only": "Remote only", different: "Different" } as const;

function diffPathLabel(path: string) {
  return snapshotPathLabel(path).replace(/\s+/gu, (space: string, index: number, label: string) =>
    space === " " && index > 0 && index + 1 < label.length
      ? space
      : Array.from(space, (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`).join(""),
  );
}

export async function showSyncDiffReview(
  ctx: ExtensionContext,
  open: OpenReview,
  signal?: AbortSignal,
): Promise<"close" | undefined> {
  const validateOwner = captureMutationOwner(ctx, signal);
  const isCurrent = () => {
    try {
      validateOwner();
      ctx.isIdle();
      return true;
    } catch {
      return false;
    }
  };
  let opened: ActiveDiffReview | undefined;
  try {
    const result = await runCancellableTask(
      ctx,
      "Comparing local and remote…",
      async (pending) => {
        const review = await open(pending);
        if (review.kind === "review") opened = review;
        return review;
      },
      { signal, isCurrent, closeOnHardCancel: true },
    );
    if (!isCurrent() || result.kind === "closed") return "close";
    if (result.kind === "cancelled") return;
    if (result.value.kind === "unavailable") {
      ctx.ui.notify(result.value.message.split("\n").map(safeTerminalText).join("\n"), "warning");
      return;
    }
    return await browseDiff(ctx, result.value, isCurrent, signal);
  } finally {
    await opened?.close();
  }
}

async function browseDiff(
  ctx: ExtensionContext,
  review: ActiveDiffReview,
  isCurrent: () => boolean,
  signal?: AbortSignal,
): Promise<"close" | undefined> {
  const files = review.files.map((file) => ({
    id: file.id,
    label: diffPathLabel(file.path),
    searchText: safeTerminalText(file.path),
    status: status[file.status],
  }));
  const byId = new Map(files.map((file) => [file.id, file]));
  const menu = defineMenu<undefined, "files", "preview", ExtensionContext>({
    start: "files",
    screens: {
      files: () => ({
        kind: "choice",
        title: "View differences",
        lines: review.lines.map(safeTerminalText),
        items: files.map((file) => ({
          id: file.id,
          label: file.label,
          description: file.status,
          searchText: file.searchText,
        })),
        action: "preview",
        enableSearch: true,
      }),
    },
    actions: {
      preview: async ({ itemId, signal }) => {
        const file = itemId === undefined ? undefined : byId.get(itemId);
        if (!file) return { kind: "stay" };
        const current = () => isCurrent() && !signal.aborted;
        let loaded: CancellableTaskResult<DiffReviewPreview>;
        try {
          loaded = await runCancellableTask(ctx, "Loading file diff…", (pending) => review.read(file.id, pending), {
            signal,
            isCurrent: current,
            cancelledMessage: null,
            closeOnHardCancel: true,
          });
        } catch {
          if (!current()) return { kind: "close" };
          ctx.ui.notify("Could not load the file preview. Try again or reopen View differences.", "warning");
          return { kind: "stay" };
        }
        if (!current() || loaded.kind === "closed") return { kind: "close" };
        if (loaded.kind === "cancelled") return { kind: "stay" };
        const preview = loaded.value;
        if (preview.kind === "stale") {
          ctx.ui.notify(
            "The comparison expired or the sync setup changed. Reopen View differences to refresh.",
            "warning",
          );
          return { kind: "back" };
        }
        const result = await runDocumentReview(ctx, {
          title: file.label,
          lines: preview.kind === "diff" ? [direction] : [file.status],
          content: preview.kind === "diff" ? preview.content : preview.message,
          format: { kind: preview.kind === "diff" ? "diff" : "text" },
          presentation: "floating",
          viewportSize: "adaptive",
          enableSearch: preview.kind === "diff",
          signal,
          isCurrent: current,
          onError: () => {},
        });
        if (!current() || result.kind === "stale") return { kind: "close" };
        if (result.kind === "error" || result.kind === "unsupported") {
          ctx.ui.notify("Could not open the file review.", "warning");
          return { kind: "stay" };
        }
        return { kind: result.kind === "cancelled" && result.reason === "back" ? "stay" : "close" };
      },
    },
  });
  const result = await runMenu(ctx, menu, { getState: () => undefined, signal, isCurrent, onError: () => {} });
  if (!isCurrent() || result.kind === "stale") return "close";
  if (result.kind === "error" || result.kind === "unsupported") throw new Error("Could not open the Sync file list.");
  if (result.kind === "closed" && result.reason === "close") return "close";
}
