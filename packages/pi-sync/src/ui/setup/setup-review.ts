import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { defineMenu, runMenu } from "@narumitw/pi-tui-kit";
import { syncErrorGuidance } from "../../sync/sync-error-guidance.js";

/** A settings draft is committed only after review; retryable I/O failures retain the same draft. */
export async function saveReviewedDraft(
  ctx: ExtensionCommandContext,
  title: string,
  lines: readonly string[],
  label: string,
  save: (signal: AbortSignal) => Promise<unknown>,
  signal?: AbortSignal,
) {
  let saved = false;
  let failure: unknown;
  let failureText: string | undefined;
  const menu = defineMenu<undefined, "review", "save", ExtensionCommandContext>({
    start: "review",
    screens: {
      review: () => ({
        kind: "review",
        title,
        content: [...(failureText ? [failureText, ""] : []), ...lines].join("\n"),
        lines: ["Review before saving. Back cancels this draft."],
        format: { kind: "text" },
        viewportSize: "adaptive",
        confirm: { id: "save", label, action: "save" },
        hint: "back",
      }),
    },
    actions: {
      save: async ({ signal: actionSignal }) => {
        try {
          actionSignal.throwIfAborted();
          await save(actionSignal);
          saved = true;
          return { kind: "close" };
        } catch (error) {
          if (actionSignal.aborted) return { kind: "close" };
          // Do not silently rebase a stale review or overwrite an invalid settings file.
          // The caller must reopen current settings for those failures.
          if (!retryableSettingsError(error)) {
            failure = error;
            return { kind: "close" };
          }
          failureText = `Not saved. ${syncErrorGuidance(error)}\nYour draft is retained. Fix the problem, then save again, or cancel.`;
          ctx.ui.notify(failureText, "error");
          return { kind: "stay" };
        }
      },
    },
  });
  const result = await runMenu(ctx, menu, {
    getState: () => undefined,
    signal,
    isCurrent: () => !signal?.aborted,
  });
  if (signal?.aborted) return false;
  if (failure) throw failure;
  if (result.kind === "error") throw result.error;
  return saved;
}

function retryableSettingsError(error: unknown) {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return (
    code !== undefined && ["EACCES", "EPERM", "ENOSPC", "EBUSY", "EIO", "EMFILE", "ENFILE", "EROFS"].includes(code)
  );
}
