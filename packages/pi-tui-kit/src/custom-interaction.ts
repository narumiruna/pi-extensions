import type { ExtensionCommandContext, KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import type { Component, Focusable, TUI } from "@earendil-works/pi-tui";
import { safeMenuText } from "./components/rendering.js";
import { callErrorReporter, notifyInteractionError } from "./interaction-error.js";
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
  /** Consumer-owned inline waiting status; omitted for loaders and active work. */
  blocked?: NonNullable<Parameters<ExtensionCommandContext["ui"]["custom"]>[1]>["blocked"];
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
  let creation: Promise<CustomInteractionComponent> | undefined;
  let wrappedComponent: CustomInteractionComponent | undefined;
  let removeAbortListener = () => {};
  let externallyDisposed = false;
  let completionRequested = false;
  let customResult: InternalInteractionResult<Value> | undefined;
  let uiError: unknown;
  let disposalError: unknown;
  let cleanupError: unknown;
  let resolveDisposal!: (result: InternalInteractionResult<Value>) => void;
  const disposal = new Promise<InternalInteractionResult<Value>>((resolve) => {
    resolveDisposal = resolve;
  });

  try {
    const interaction = uiFor(ctx).custom<InternalInteractionResult<Value> | undefined>(
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

        creation = Promise.resolve(
          options.create({
            ctx,
            tui,
            theme,
            keybindings,
            signal,
            complete: (value) => {
              // A host-owned unmount must not restore an obsolete editor later.
              if (externallyDisposed) return;
              if (signal.aborted || !isCurrent(options)) {
                finishStale();
                return;
              }
              completionRequested = true;
              finish({ kind: "completed", value });
              controller.abort(new DOMException("Custom interaction completed", "AbortError"));
            },
          }),
        );
        component = await creation;
        if (signal.aborted || !isCurrent(options)) finishStale();
        wrappedComponent = wrapComponent(
          component,
          () => {
            if (!completionRequested) externallyDisposed = true;
            controller.abort(new DOMException("Custom interaction disposed", "AbortError"));
            removeAbortListener();
            // Pi can dispose dialogs during reset without resolving custom(). Settle
            // locally: calling done() here would mutate its live reset iteration
            // and could restore an old editor draft after session replacement.
            if (!completionRequested) resolveDisposal({ kind: "stale" });
          },
          (error) => {
            disposalError ??= error;
          },
        );
        return wrappedComponent;
      },
      options.blocked ? { blocked: options.blocked } : undefined,
    );
    customResult = await Promise.race([interaction, disposal]);
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
  // Completion cancels all interaction-owned work. Match its exact reason so
  // unrelated initialization, disposal, and pending-work failures still report.
  const isCompletionAbort = (error: unknown) =>
    customResult?.kind === "completed" &&
    completionRequested &&
    signal.aborted &&
    (error === signal.reason ||
      (error instanceof Error && error.name === "AbortError" && error.cause === signal.reason));
  // Pi can resolve done() before the async factory returns, then discard its
  // late component. Retain ownership until creation settles so cleanup cannot
  // miss that component or its pending work.
  try {
    if (creation) component = await creation;
  } catch (error) {
    if (!isCompletionAbort(error)) uiError ??= error;
  }
  try {
    wrappedComponent?.dispose?.();
  } catch (error) {
    if (!isCompletionAbort(error)) cleanupError ??= error;
  }
  if (disposalError !== undefined && !isCompletionAbort(disposalError)) cleanupError ??= disposalError;
  try {
    await component?.waitForPending?.();
  } catch (error) {
    if (!isCompletionAbort(error)) cleanupError ??= error;
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

function wrapComponent(
  component: CustomInteractionComponent,
  onDispose: () => void,
  onDisposalError: (error: unknown) => void,
): CustomInteractionComponent {
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
      try {
        component.dispose?.();
      } catch (error) {
        // Do not interrupt Pi's reset loop before it clears inline blocked state.
        // The runner reports current-owner failures after draining pending work.
        onDisposalError(error);
      }
    },
  };
  Object.defineProperty(wrapped, "wantsKeyRelease", {
    get: () => component.wantsKeyRelease,
  });
  Object.defineProperty(wrapped, "capturesViewportInput", {
    get: () => component.capturesViewportInput,
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
  if (!isCurrent(options) || options.signal?.aborted) return { kind: "stale" };
  if (!reported && ctx.hasUI) {
    notifyInteractionError(ctx, error, "Custom interaction failed: ", safeMenuText);
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
