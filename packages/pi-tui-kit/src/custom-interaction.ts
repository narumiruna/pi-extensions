import type { ExtensionCommandContext, KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import type { Component, Focusable, TUI } from "@earendil-works/pi-tui";
import { safeMenuText } from "./components/rendering.js";
import type { MenuContext } from "./types.js";

type ExtensionMode = MenuContext["mode"];

export interface CustomInteractionComponent extends Component {
  dispose?(): void;
  waitForPending?(): Promise<void>;
}

export interface CustomInteractionContext<Value, Context extends MenuContext = ExtensionCommandContext> {
  ctx: Context;
  tui: TUI;
  theme: Theme;
  keybindings: KeybindingsManager;
  signal: AbortSignal;
  complete(value: Value): void;
}

export interface RunCustomInteractionOptions<Value, Context extends MenuContext = ExtensionCommandContext> {
  create(
    context: CustomInteractionContext<Value, Context>,
  ): CustomInteractionComponent | Promise<CustomInteractionComponent>;
  signal?: AbortSignal;
  isCurrent?(): boolean;
  onError?(ctx: Context, error: unknown): void | Promise<void>;
  onUnsupportedMode?(ctx: Context, mode: ExtensionMode): void | Promise<void>;
}

export type RunCustomInteractionResult<Value> =
  | { kind: "completed"; value: Value }
  | { kind: "stale" }
  | { kind: "unsupported"; mode: ExtensionMode }
  | { kind: "error"; error: unknown };

type InternalInteractionResult<Value> = { kind: "completed"; value: Value } | { kind: "stale" };

/**
 * Run one extension-owned custom TUI interaction under explicit owner and disposal semantics.
 */
export async function runCustomInteraction<Value, Context extends MenuContext = ExtensionCommandContext>(
  ctx: Context,
  options: RunCustomInteractionOptions<Value, Context>,
): Promise<RunCustomInteractionResult<Value>> {
  if (!isCurrent(options) || options.signal?.aborted) return { kind: "stale" };
  if (ctx.mode !== "tui" || !ctx.hasUI) {
    try {
      await options.onUnsupportedMode?.(ctx, ctx.mode);
    } catch (error) {
      return reportInteractionError(ctx, options, error);
    }
    if (!isCurrent(options) || options.signal?.aborted) return { kind: "stale" };
    return { kind: "unsupported", mode: ctx.mode };
  }

  const controller = new AbortController();
  const signal = options.signal ? AbortSignal.any([controller.signal, options.signal]) : controller.signal;
  let component: CustomInteractionComponent | undefined;
  let wrappedComponent: CustomInteractionComponent | undefined;
  let removeAbortListener = () => {};
  let externallyDisposed = false;
  let completionRequested = false;
  let customResult: InternalInteractionResult<Value> | undefined;
  let uiError: unknown;
  let cleanupError: unknown;

  try {
    customResult = await uiFor(ctx).custom<InternalInteractionResult<Value> | undefined>(
      async (tui, theme, keybindings, done) => {
        let finished = false;
        const finish = (result: InternalInteractionResult<Value>) => {
          if (finished) return;
          finished = true;
          done(result);
        };
        const finishStale = () => {
          controller.abort(new DOMException("Custom interaction owner disposed", "AbortError"));
          finish({ kind: "stale" });
        };
        options.signal?.addEventListener("abort", finishStale, { once: true });
        removeAbortListener = () => options.signal?.removeEventListener("abort", finishStale);
        if (options.signal?.aborted || !isCurrent(options)) {
          finishStale();
          return { render: () => [], invalidate() {} };
        }

        component = await options.create({
          ctx,
          tui,
          theme,
          keybindings,
          signal,
          complete: (value) => {
            if (externallyDisposed || signal.aborted || !isCurrent(options)) {
              finishStale();
              return;
            }
            completionRequested = true;
            finish({ kind: "completed", value });
          },
        });
        if (signal.aborted || !isCurrent(options)) finishStale();
        wrappedComponent = wrapComponent(component, () => {
          if (!completionRequested && !options.signal?.aborted) externallyDisposed = true;
          controller.abort(new DOMException("Custom interaction disposed", "AbortError"));
          removeAbortListener();
        });
        return wrappedComponent;
      },
    );
  } catch (error) {
    uiError = error;
    controller.abort(new DOMException("Custom interaction failed", "AbortError"));
  } finally {
    removeAbortListener();
  }

  if (customResult === undefined && uiError === undefined) {
    externallyDisposed = true;
    controller.abort(new DOMException("Custom interaction closed", "AbortError"));
  }
  try {
    wrappedComponent?.dispose?.();
  } catch (error) {
    cleanupError ??= error;
  }
  try {
    await component?.waitForPending?.();
  } catch (error) {
    cleanupError ??= error;
  }
  controller.abort(new DOMException("Custom interaction settled", "AbortError"));

  if (customResult?.kind === "stale" || options.signal?.aborted || !isCurrent(options)) {
    return { kind: "stale" };
  }
  if (uiError !== undefined) return reportInteractionError(ctx, options, uiError);
  if (externallyDisposed) return { kind: "stale" };
  if (cleanupError !== undefined) return reportInteractionError(ctx, options, cleanupError);
  if (customResult?.kind === "completed") return customResult;
  return { kind: "stale" };
}

function wrapComponent(component: CustomInteractionComponent, onDispose: () => void): CustomInteractionComponent {
  let disposed = false;
  const wrapped: CustomInteractionComponent & Partial<Focusable> = {
    render: (width) => component.render(width),
    invalidate: () => component.invalidate(),
    ...(component.handleInput ? { handleInput: (data: string) => component.handleInput?.(data) } : {}),
    ...(component.handleMouse
      ? {
          handleMouse: (event: Parameters<NonNullable<Component["handleMouse"]>>[0]) => component.handleMouse?.(event),
        }
      : {}),
    ...(component.waitForPending ? { waitForPending: () => component.waitForPending?.() ?? Promise.resolve() } : {}),
    dispose() {
      if (disposed) return;
      disposed = true;
      onDispose();
      component.dispose?.();
    },
  };
  Object.defineProperty(wrapped, "wantsKeyRelease", {
    get: () => component.wantsKeyRelease,
  });
  if ("focused" in component) {
    Object.defineProperty(wrapped, "focused", {
      get: () => (component as CustomInteractionComponent & Focusable).focused,
      set: (value: boolean) => {
        (component as CustomInteractionComponent & Focusable).focused = value;
      },
    });
  }
  return wrapped;
}

async function reportInteractionError<Value, Context extends MenuContext>(
  ctx: Context,
  options: RunCustomInteractionOptions<Value, Context>,
  error: unknown,
): Promise<RunCustomInteractionResult<Value>> {
  if (!isCurrent(options) || options.signal?.aborted) return { kind: "stale" };
  let reported = false;
  if (options.onError) {
    try {
      await options.onError(ctx, error);
      reported = true;
    } catch {
      // Fall through to Pi's notifier when a custom reporter is unavailable.
    }
  }
  if (!reported && ctx.hasUI) {
    const message = error instanceof Error ? error.message : String(error);
    try {
      uiFor(ctx).notify(`Custom interaction failed: ${safeMenuText(message)}`, "error");
    } catch {
      // Error reporting must not change the typed result.
    }
  }
  if (!isCurrent(options) || options.signal?.aborted) return { kind: "stale" };
  return { kind: "error", error };
}

function isCurrent<Value, Context extends MenuContext>(options: RunCustomInteractionOptions<Value, Context>) {
  return options.isCurrent?.() ?? true;
}

function uiFor(ctx: MenuContext): ExtensionCommandContext["ui"] {
  return ctx.ui as ExtensionCommandContext["ui"];
}
