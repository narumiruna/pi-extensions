import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { safeMenuText } from "./components/rendering.js";
import { TaskLoader } from "./components/task-loader.js";
import type { MenuContext } from "./types.js";

export type RunTaskResult<Value> =
  | { kind: "completed"; value: Value }
  | { kind: "cancelled" }
  | { kind: "stale" }
  | { kind: "error"; error: unknown };

export interface RunTaskOptions<Value, Context extends MenuContext = ExtensionCommandContext> {
  label: string;
  task(context: { ctx: Context; signal: AbortSignal }): Value | Promise<Value>;
  signal?: AbortSignal;
  isCurrent?(): boolean;
  cancellable?: boolean;
  onError?(ctx: Context, error: unknown): void | Promise<void>;
}

interface TaskOwnership {
  userCancelled: boolean;
  externallyDisposed: boolean;
}

/**
 * Run abort-aware work with Pi's cancellable loader in TUI mode and the same
 * typed lifecycle result in every other mode.
 */
export async function runTask<Value, Context extends MenuContext = ExtensionCommandContext>(
  ctx: Context,
  options: RunTaskOptions<Value, Context>,
): Promise<RunTaskResult<Value>> {
  if (!isCurrent(options) || options.signal?.aborted) return { kind: "stale" };
  if (ctx.mode !== "tui" || !ctx.hasUI) {
    const controller = new AbortController();
    const signal = options.signal ? AbortSignal.any([controller.signal, options.signal]) : controller.signal;
    return executeTask(ctx, options, signal, {
      userCancelled: false,
      externallyDisposed: false,
    });
  }
  return runTuiTask(ctx, options);
}

async function runTuiTask<Value, Context extends MenuContext>(
  ctx: Context,
  options: RunTaskOptions<Value, Context>,
): Promise<RunTaskResult<Value>> {
  const controller = new AbortController();
  const signal = options.signal ? AbortSignal.any([controller.signal, options.signal]) : controller.signal;
  const ownership: TaskOwnership = { userCancelled: false, externallyDisposed: false };
  let taskPromise: Promise<RunTaskResult<Value>> | undefined;
  let taskSettled = false;
  let componentDisposed = false;
  let customResult: RunTaskResult<Value> | undefined;
  let customError: unknown;

  try {
    customResult = await uiFor(ctx).custom<RunTaskResult<Value> | undefined>((tui, theme, keybindings, done) => {
      const loader = new TaskLoader(tui, theme, keybindings, safeMenuText(options.label), {
        cancellable: options.cancellable ?? true,
      });
      let loaderDisposed = false;
      const disposeLoader = () => {
        if (loaderDisposed) return;
        loaderDisposed = true;
        loader.dispose();
      };
      loader.onAbort = () => {
        if (taskSettled || ownership.userCancelled) return;
        ownership.userCancelled = true;
        controller.abort(new DOMException("Task cancelled", "AbortError"));
      };
      taskPromise = executeTask(ctx, options, signal, ownership);
      void taskPromise.then((result) => {
        taskSettled = true;
        disposeLoader();
        if (!componentDisposed) done(result);
      });
      return {
        render: (width: number) => loader.render(width),
        invalidate: () => loader.invalidate(),
        handleInput: (data: string) => loader.handleInput(data),
        dispose() {
          if (componentDisposed) return;
          componentDisposed = true;
          if (!taskSettled && !ownership.userCancelled && !options.signal?.aborted) {
            ownership.externallyDisposed = true;
          }
          controller.abort(new DOMException("Task UI disposed", "AbortError"));
          disposeLoader();
        },
      };
    });
  } catch (error) {
    customError = error;
    controller.abort(new DOMException("Task UI failed", "AbortError"));
  }
  if (customError === undefined && customResult === undefined && !ownership.userCancelled && !options.signal?.aborted) {
    ownership.externallyDisposed = true;
    controller.abort(new DOMException("Task UI closed", "AbortError"));
  }

  const taskResult = taskPromise ? await taskPromise : undefined;
  if (ownership.externallyDisposed || !isCurrent(options) || options.signal?.aborted) {
    return { kind: "stale" };
  }
  if (customError !== undefined) {
    await reportTaskError(ctx, options, customError);
    if (!isCurrent(options) || options.signal?.aborted) return { kind: "stale" };
    return { kind: "error", error: customError };
  }
  return customResult ?? taskResult ?? { kind: "stale" };
}

async function executeTask<Value, Context extends MenuContext>(
  ctx: Context,
  options: RunTaskOptions<Value, Context>,
  signal: AbortSignal,
  ownership: TaskOwnership,
): Promise<RunTaskResult<Value>> {
  if (!isCurrent(options) || options.signal?.aborted || ownership.externallyDisposed) {
    return { kind: "stale" };
  }
  if (ownership.userCancelled || signal.aborted) return abortResult(options, ownership);
  try {
    const value = await options.task({ ctx, signal });
    if (!isCurrent(options) || options.signal?.aborted || ownership.externallyDisposed) {
      return { kind: "stale" };
    }
    if (ownership.userCancelled || signal.aborted) return abortResult(options, ownership);
    return { kind: "completed", value };
  } catch (error) {
    if (!isCurrent(options) || options.signal?.aborted || ownership.externallyDisposed) {
      return { kind: "stale" };
    }
    if (ownership.userCancelled || signal.aborted) return abortResult(options, ownership);
    await reportTaskError(ctx, options, error);
    if (!isCurrent(options) || options.signal?.aborted || ownership.externallyDisposed) {
      return { kind: "stale" };
    }
    if (ownership.userCancelled || signal.aborted) return abortResult(options, ownership);
    return { kind: "error", error };
  }
}

function abortResult<Value, Context extends MenuContext>(
  options: RunTaskOptions<Value, Context>,
  ownership: TaskOwnership,
): RunTaskResult<Value> {
  return ownership.userCancelled && !options.signal?.aborted ? { kind: "cancelled" } : { kind: "stale" };
}

async function reportTaskError<Value, Context extends MenuContext>(
  ctx: Context,
  options: RunTaskOptions<Value, Context>,
  error: unknown,
) {
  if (options.onError) {
    try {
      await options.onError(ctx, error);
      return;
    } catch {
      // Fall through to Pi's notifier when the custom reporter is unavailable.
    }
  }
  if (!ctx.hasUI) return;
  const message = error instanceof Error ? error.message : String(error);
  try {
    uiFor(ctx).notify(`Task failed: ${safeMenuText(message)}`, "error");
  } catch {
    // Error reporting must not change the typed task result.
  }
}

function isCurrent<Value, Context extends MenuContext>(options: RunTaskOptions<Value, Context>) {
  return options.isCurrent?.() ?? true;
}

function uiFor(ctx: MenuContext): ExtensionCommandContext["ui"] {
  return ctx.ui as ExtensionCommandContext["ui"];
}
