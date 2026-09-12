import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { createMenuScreenComponent, safeMenuText } from "./components/index.js";
import { runCustomInteraction } from "./custom-interaction.js";
import type { MenuCloseReason, MenuContext } from "./types.js";

type ExtensionMode = MenuContext["mode"];
type ConfirmationValue = "confirmed" | MenuCloseReason;
type ConfirmationAction = "confirm" | "back";

export interface RunConfirmationOptions<Context extends MenuContext = ExtensionCommandContext> {
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  signal?: AbortSignal;
  isCurrent?(): boolean;
  onError?(ctx: Context, error: unknown): void | Promise<void>;
  onUnsupportedMode?(ctx: Context, mode: ExtensionMode): void | Promise<void>;
}

export type RunConfirmationResult =
  | { kind: "confirmed" }
  | { kind: "closed"; reason: MenuCloseReason }
  | { kind: "stale" }
  | { kind: "unsupported"; mode: ExtensionMode }
  | { kind: "error"; error: unknown };

interface ConfirmationPrompt {
  title: string;
  lines: readonly string[];
  confirmLabel: string;
  cancelLabel: string;
}

/** Run one standalone confirmation without absorbing the caller's confirmed side effect. */
export async function runConfirmation<Context extends MenuContext = ExtensionCommandContext>(
  ctx: Context,
  options: RunConfirmationOptions<Context>,
): Promise<RunConfirmationResult> {
  if (!isCurrent(options) || options.signal?.aborted) return { kind: "stale" };
  const prompt = normalizePrompt(options);
  if (ctx.mode === "tui" && ctx.hasUI) return runTuiConfirmation(ctx, options, prompt);
  if (ctx.mode === "rpc" && ctx.hasUI) return runRpcConfirmation(ctx, options, prompt);

  try {
    await options.onUnsupportedMode?.(ctx, ctx.mode);
  } catch (error) {
    return confirmationError(ctx, options, error);
  }
  if (!isCurrent(options) || options.signal?.aborted) return { kind: "stale" };
  return { kind: "unsupported", mode: ctx.mode };
}

async function runTuiConfirmation<Context extends MenuContext>(
  ctx: Context,
  options: RunConfirmationOptions<Context>,
  prompt: ConfirmationPrompt,
): Promise<RunConfirmationResult> {
  const result = await runCustomInteraction<ConfirmationValue, Context>(ctx, {
    signal: options.signal,
    isCurrent: options.isCurrent,
    onError: (currentCtx, error) => reportConfirmationError(currentCtx, options, error),
    create: ({ tui, theme, keybindings, complete }) =>
      createMenuScreenComponent<"confirmation", ConfirmationAction>({
        screen: {
          kind: "actions",
          title: prompt.title,
          lines: prompt.lines,
          items: [
            { id: "confirm", label: prompt.confirmLabel, action: "confirm" },
            { id: "back", label: prompt.cancelLabel, action: "back" },
          ],
          hint: "back",
        },
        selectedItemId: "confirm",
        tui,
        theme,
        keybindings,
        onEvent: (event) => {
          if (event.kind === "activate") {
            complete(event.itemId === "confirm" ? "confirmed" : "back");
            return;
          }
          complete(event.kind);
        },
      }),
  });
  if (result.kind === "completed") {
    return result.value === "confirmed" ? { kind: "confirmed" } : { kind: "closed", reason: result.value };
  }
  return result;
}

async function runRpcConfirmation<Context extends MenuContext>(
  ctx: Context,
  options: RunConfirmationOptions<Context>,
  prompt: ConfirmationPrompt,
): Promise<RunConfirmationResult> {
  let selection: string | undefined;
  try {
    selection = await uiFor(ctx).select(
      [prompt.title, ...prompt.lines].join("\n"),
      [prompt.confirmLabel, prompt.cancelLabel],
      { signal: options.signal },
    );
  } catch (error) {
    return confirmationError(ctx, options, error);
  }
  if (!isCurrent(options) || options.signal?.aborted) return { kind: "stale" };
  if (selection === prompt.confirmLabel) return { kind: "confirmed" };
  if (selection === undefined || selection === prompt.cancelLabel) {
    return { kind: "closed", reason: "back" };
  }
  return confirmationError(ctx, options, new Error("Confirmation dialog returned an option that was not offered"));
}

function normalizePrompt<Context extends MenuContext>(options: RunConfirmationOptions<Context>): ConfirmationPrompt {
  const title = safeMenuText(options.title) || "Confirm";
  const lines = options.message.split(/\r?\n/u).map(safeMenuText);
  const confirmLabel = safeMenuText(options.confirmLabel ?? "Confirm") || "Confirm";
  let cancelLabel = safeMenuText(options.cancelLabel ?? "Cancel") || "Cancel";
  if (cancelLabel === confirmLabel) cancelLabel = `${cancelLabel} [2]`;
  return { title, lines, confirmLabel, cancelLabel };
}

async function confirmationError<Context extends MenuContext>(
  ctx: Context,
  options: RunConfirmationOptions<Context>,
  error: unknown,
): Promise<RunConfirmationResult> {
  if (!isCurrent(options) || options.signal?.aborted) return { kind: "stale" };
  await reportConfirmationError(ctx, options, error);
  if (!isCurrent(options) || options.signal?.aborted) return { kind: "stale" };
  return { kind: "error", error };
}

async function reportConfirmationError<Context extends MenuContext>(
  ctx: Context,
  options: RunConfirmationOptions<Context>,
  error: unknown,
): Promise<void> {
  let reported = false;
  if (options.onError) {
    try {
      await options.onError(ctx, error);
      reported = true;
    } catch {
      // Fall through to Pi's notifier when a custom reporter is unavailable.
    }
  }
  if (reported || !ctx.hasUI || !isCurrent(options) || options.signal?.aborted) return;
  const message = error instanceof Error ? error.message : String(error);
  try {
    uiFor(ctx).notify(`Confirmation failed: ${safeMenuText(message)}`, "error");
  } catch {
    // Error reporting must not change the typed result.
  }
}

function isCurrent<Context extends MenuContext>(options: RunConfirmationOptions<Context>) {
  return options.isCurrent?.() ?? true;
}

function uiFor(ctx: MenuContext): ExtensionCommandContext["ui"] {
  return ctx.ui as ExtensionCommandContext["ui"];
}
