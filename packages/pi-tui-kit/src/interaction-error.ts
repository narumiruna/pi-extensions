import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { MenuContext } from "./types.js";

/** Reporting mechanics only; callers retain all lifecycle checks and typed results. */
export function callErrorReporter<Context extends MenuContext>(
  ctx: Context,
  options: { onError?(ctx: Context, error: unknown): void | Promise<void> },
  error: unknown,
): false | Promise<boolean> {
  if (!options.onError) return false;
  try {
    return Promise.resolve(options.onError(ctx, error)).then(
      () => true,
      () => false,
    );
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
