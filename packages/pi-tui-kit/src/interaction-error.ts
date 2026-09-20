import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { MenuContext } from "./types.js";

/**
 * Invoke without wrapping the completion: callers must await the original value and
 * catch its rejection locally to preserve their lifecycle checks' microtask ordering.
 */
export function callErrorReporter<Context extends MenuContext>(
  ctx: Context,
  options: { onError?(ctx: Context, error: unknown): void | Promise<void> },
  error: unknown,
): false | { completion: void | Promise<void> } {
  if (!options.onError) return false;
  try {
    return { completion: options.onError(ctx, error) };
  } catch {
    // Keep synchronous reporter failures synchronous, just like an absent reporter.
    return false;
  }
}

/** Call only after the runner's notification-eligibility checks. */
export function notifyInteractionError(
  ctx: MenuContext,
  error: unknown,
  prefix: string,
  sanitize: (message: string) => string,
): void {
  const message = error instanceof Error ? error.message : String(error);
  try {
    (ctx.ui as ExtensionCommandContext["ui"]).notify(`${prefix}${sanitize(message)}`, "error");
  } catch {
    // Error reporting must not change the runner's typed result.
  }
}
