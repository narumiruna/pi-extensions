import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { prepareMenuScreenRendering } from "./components/mermaid.js";
import { safeMenuText } from "./components/rendering.js";
import { createReviewComponent, reviewDialogPages } from "./components/review.js";
import { runCustomInteraction } from "./custom-interaction.js";
import { callErrorReporter, notifyInteractionError } from "./interaction-error.js";
import {
  MAX_REVIEW_VIEWPORT_SIZE,
  type MenuCloseReason,
  type MenuContext,
  type ReviewFormat,
  type ReviewScreen,
} from "./types.js";

type ExtensionMode = MenuContext["mode"];
type DocumentReviewValue = { kind: "confirmed" } | { kind: "cancelled"; reason: MenuCloseReason };

export interface DocumentReviewConfirmation {
  label: string;
}

export interface RunDocumentReviewOptions<Context extends MenuContext = ExtensionCommandContext> {
  title: string;
  lines?: readonly string[];
  content: string;
  format?: ReviewFormat;
  viewportSize?: number | "adaptive";
  /** Enable literal search over displayed document text in TUI mode. */
  enableSearch?: boolean;
  confirmation?: DocumentReviewConfirmation;
  hint?: MenuCloseReason;
  signal?: AbortSignal;
  isCurrent?(): boolean;
  onError?(ctx: Context, error: unknown): void | Promise<void>;
  onUnsupportedMode?(ctx: Context, mode: ExtensionMode): void | Promise<void>;
}

export type RunDocumentReviewResult =
  | { kind: "confirmed" }
  | { kind: "cancelled"; reason: MenuCloseReason }
  | { kind: "stale" }
  | { kind: "unsupported"; mode: ExtensionMode }
  | { kind: "error"; error: unknown };

/** Review one document without exposing Kit's internal screen factories. */
export async function runDocumentReview<Context extends MenuContext = ExtensionCommandContext>(
  ctx: Context,
  options: RunDocumentReviewOptions<Context>,
): Promise<RunDocumentReviewResult> {
  if (!isCurrent(options) || options.signal?.aborted) return { kind: "stale" };
  const validationError = validateOptions(options);
  if (validationError) return documentReviewError(ctx, options, validationError);
  const screen = reviewScreen(options);
  if (ctx.mode === "tui" && ctx.hasUI) return runTuiDocumentReview(ctx, options, screen);
  if (ctx.mode === "rpc" && ctx.hasUI) return runRpcDocumentReview(ctx, options, screen);

  try {
    await options.onUnsupportedMode?.(ctx, ctx.mode);
  } catch (error) {
    return documentReviewError(ctx, options, error);
  }
  if (!isCurrent(options) || options.signal?.aborted) return { kind: "stale" };
  return { kind: "unsupported", mode: ctx.mode };
}

async function runTuiDocumentReview<Context extends MenuContext>(
  ctx: Context,
  options: RunDocumentReviewOptions<Context>,
  screen: ReviewScreen<"confirm">,
): Promise<RunDocumentReviewResult> {
  try {
    const preparation = prepareMenuScreenRendering(screen);
    if (preparation) await preparation;
  } catch (error) {
    return documentReviewError(ctx, options, error);
  }
  if (!isCurrent(options) || options.signal?.aborted) return { kind: "stale" };

  const result = await runCustomInteraction<DocumentReviewValue, Context>(ctx, {
    signal: options.signal,
    isCurrent: options.isCurrent,
    onError: (currentCtx, error) => reportDocumentReviewError(currentCtx, options, error),
    create: ({ tui, theme, keybindings, complete }) =>
      createReviewComponent<"review", "confirm">({
        screen,
        tui,
        theme,
        keybindings,
        onEvent: (event) => {
          if (event.kind === "activate") complete({ kind: "confirmed" });
          else complete({ kind: "cancelled", reason: event.kind });
        },
      }),
  });
  return result.kind === "completed" ? result.value : result;
}

async function runRpcDocumentReview<Context extends MenuContext>(
  ctx: Context,
  options: RunDocumentReviewOptions<Context>,
  screen: ReviewScreen<"confirm">,
): Promise<RunDocumentReviewResult> {
  const pages = reviewDialogPages(screen);
  let pageIndex = 0;
  for (;;) {
    const choices = uniqueChoices([
      ...(pageIndex > 0 ? [{ kind: "previous" as const, label: "Previous" }] : []),
      ...(pageIndex < pages.length - 1 ? [{ kind: "next" as const, label: "Next" }] : []),
      ...(screen.confirm ? [{ kind: "confirm" as const, label: safeMenuText(screen.confirm.label) }] : []),
      { kind: "cancel" as const, label: screen.hint === "close" ? "Close" : "Back" },
    ]);
    const title = [
      safeMenuText(screen.title),
      ...(screen.lines ?? []).map(safeMenuText),
      pages[pageIndex]?.join("\n") ?? "",
      ...(pages.length > 1 ? [`Page ${pageIndex + 1}/${pages.length}`] : []),
    ]
      .filter(Boolean)
      .join("\n");
    let selectedLabel: string | undefined;
    try {
      selectedLabel = await uiFor(ctx).select(
        title,
        choices.map((choice) => choice.label),
        { signal: options.signal },
      );
    } catch (error) {
      return documentReviewError(ctx, options, error);
    }
    if (!isCurrent(options) || options.signal?.aborted) return { kind: "stale" };
    if (selectedLabel === undefined) return { kind: "cancelled", reason: screen.hint ?? "back" };
    const selected = choices.find((choice) => choice.label === selectedLabel);
    if (!selected) {
      return documentReviewError(
        ctx,
        options,
        new Error("Document review dialog returned an option that was not offered"),
      );
    }
    if (selected.kind === "cancel") return { kind: "cancelled", reason: screen.hint ?? "back" };
    if (selected.kind === "confirm") return { kind: "confirmed" };
    if (selected.kind === "previous") pageIndex = Math.max(0, pageIndex - 1);
    else pageIndex = Math.min(pages.length - 1, pageIndex + 1);
  }
}

function reviewScreen<Context extends MenuContext>(
  options: RunDocumentReviewOptions<Context>,
): ReviewScreen<"confirm"> {
  return {
    kind: "review",
    title: options.title,
    lines: options.lines,
    content: options.content,
    format: options.format,
    viewportSize: options.viewportSize,
    enableSearch: options.enableSearch,
    hint: options.hint,
    ...(options.confirmation
      ? { confirm: { id: "confirm", label: options.confirmation.label, action: "confirm" as const } }
      : {}),
  };
}

type RpcChoice = { kind: "previous" | "next" | "confirm" | "cancel"; label: string };

function uniqueChoices(choices: readonly RpcChoice[]): RpcChoice[] {
  const used = new Set<string>();
  return choices.map((choice) => ({ ...choice, label: uniqueLabel(choice.label, used) }));
}

function uniqueLabel(label: string, used: Set<string>): string {
  const base = label || "Choice";
  if (!used.has(base)) {
    used.add(base);
    return base;
  }
  let suffix = 2;
  while (used.has(`${base} [${suffix}]`)) suffix += 1;
  const unique = `${base} [${suffix}]`;
  used.add(unique);
  return unique;
}

function validateOptions<Context extends MenuContext>(options: RunDocumentReviewOptions<Context>): Error | undefined {
  if (!safeMenuText(options.title)) return new Error("Document review title must be displayable");
  if (
    options.viewportSize !== undefined &&
    options.viewportSize !== "adaptive" &&
    (!Number.isInteger(options.viewportSize) ||
      options.viewportSize <= 0 ||
      options.viewportSize > MAX_REVIEW_VIEWPORT_SIZE)
  ) {
    return new Error(
      `Document review viewportSize must be "adaptive" or a positive integer no greater than ${MAX_REVIEW_VIEWPORT_SIZE}`,
    );
  }
  if (options.confirmation && !safeMenuText(options.confirmation.label)) {
    return new Error("Document review confirmation label must be displayable");
  }
  return undefined;
}

async function documentReviewError<Context extends MenuContext>(
  ctx: Context,
  options: RunDocumentReviewOptions<Context>,
  error: unknown,
): Promise<RunDocumentReviewResult> {
  if (!isCurrent(options) || options.signal?.aborted) return { kind: "stale" };
  await reportDocumentReviewError(ctx, options, error);
  if (!isCurrent(options) || options.signal?.aborted) return { kind: "stale" };
  return { kind: "error", error };
}

async function reportDocumentReviewError<Context extends MenuContext>(
  ctx: Context,
  options: RunDocumentReviewOptions<Context>,
  error: unknown,
): Promise<void> {
  const reporting = callErrorReporter(ctx, options, error);
  let reported = false;
  if (reporting) {
    try {
      await reporting.completion;
      reported = true;
    } catch {
      // Fall through to Pi's notifier when the custom reporter rejects.
    }
  }
  if (reported || !ctx.hasUI || !isCurrent(options) || options.signal?.aborted) return;
  notifyInteractionError(ctx, error, "Document review failed: ", safeMenuText);
}

function isCurrent<Context extends MenuContext>(options: RunDocumentReviewOptions<Context>): boolean {
  return options.isCurrent?.() ?? true;
}

function uiFor(ctx: MenuContext): ExtensionCommandContext["ui"] {
  return ctx.ui as ExtensionCommandContext["ui"];
}
