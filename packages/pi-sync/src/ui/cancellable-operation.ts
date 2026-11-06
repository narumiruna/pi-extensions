import { BorderedLoader, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isKeyRelease, Key, matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import { formatInteractionHints, runCustomInteraction } from "@narumitw/pi-tui-kit";
import type { SetupPullOutcome } from "../sync/setup-switch.js";
import type { SyncDecision } from "../sync/sync-decision.js";
import type { RemoteSelectionDecision } from "../sync/sync-policy.js";

export type RunRouteResult =
  | { kind: "completed"; outcome?: SetupPullOutcome }
  | { kind: "decision-required"; decision: SyncDecision }
  | { kind: "remote-selection-required"; decision: RemoteSelectionDecision }
  | { kind: "failed" };

export type RunRoute = (
  route: string,
  signal?: AbortSignal,
  onCommit?: () => void,
  target?: string,
  onDialog?: (active: boolean) => void,
  retryRefusal?: boolean,
) => Promise<RunRouteResult | undefined>;

export type CancellableOperationResult = RunRouteResult | { kind: "closed" } | { kind: "cancelled" };

interface CancellableOperationOptions {
  commitAware?: boolean;
  cancelAcrossDialogs?: boolean;
  cancelledMessage?: string | null;
  target?: string;
  signal?: AbortSignal;
  isCurrent?: () => boolean;
}

export async function runCancellableOperation(
  ctx: ExtensionContext,
  message: string,
  route: string,
  runRoute: RunRoute,
  options: CancellableOperationOptions = {},
): Promise<CancellableOperationResult> {
  const result = await runCancellableTask(
    ctx,
    message,
    (signal, onCommit, onDialog) => runRoute(route, signal, onCommit, options.target, onDialog),
    options,
  );
  return result.kind === "completed" ? (result.value ?? { kind: "failed" }) : result;
}

export type CancellableTaskResult<Value> =
  | { kind: "completed"; value: Value }
  | { kind: "closed" }
  | { kind: "cancelled" };

/** Keep non-route work under the same cancellation and drain owner as transfers. */
export async function runCancellableTask<Value>(
  ctx: ExtensionContext,
  message: string,
  task: (
    signal: AbortSignal | undefined,
    onCommit?: () => void,
    onDialog?: (active: boolean) => void,
  ) => Promise<Value>,
  options: Omit<CancellableOperationOptions, "target"> = {},
): Promise<CancellableTaskResult<Value>> {
  const {
    commitAware = false,
    cancelAcrossDialogs = false,
    cancelledMessage = "Check cancelled; no settings or files were changed.",
    signal,
    isCurrent = () => true,
  } = options;
  if (signal?.aborted || !isCurrent()) return { kind: "closed" };
  if (ctx.mode !== "tui") return { kind: "completed", value: await task(signal) };
  let commitStarted = false;
  let taskResult!: Value;
  const interaction = await runCustomInteraction<{ cancelled?: boolean; error?: unknown }, ExtensionContext>(ctx, {
    signal,
    isCurrent: () => !signal?.aborted && isCurrent(),
    create: ({ tui, theme, keybindings, signal: interactionSignal, complete }) => {
      const loader = new BorderedLoader(tui, theme, message, { cancellable: false });
      const cancelHint = formatInteractionHints(keybindings, [
        {
          keys: [...keybindings.getKeys("tui.select.cancel").filter((key) => !hasControlCharacter(key)), "ctrl+c"],
          label: "cancel",
        },
      ]);
      const cancel = (data: string) => {
        // Raw terminal listeners run before Pi filters Kitty key releases.
        if (isKeyRelease(data)) return false;
        if (!matchesKey(data, Key.ctrl("c")) && !keybindings.matches(data, "tui.select.cancel")) return false;
        if (commitStarted) {
          ctx.ui.notify("Applying or publishing has started and cannot be cancelled safely.", "warning");
        } else complete({ cancelled: true });
        return true;
      };
      // Pi dialogs replace this loader and restore the normal editor. Defer
      // ordinary keys while they are open; retain raw cancellation afterward.
      // Ctrl+C remains the root flow's hard-cancel path regardless of focus.
      let activeDialogs = 0;
      const unsubscribe = cancelAcrossDialogs
        ? ctx.ui.onTerminalInput((data) => {
            if (isKeyRelease(data)) return;
            if (activeDialogs > 0 && !matchesKey(data, Key.ctrl("c"))) return;
            return cancel(data) ? { consume: true } : undefined;
          })
        : undefined;
      let pendingTask: Promise<Value>;
      try {
        pendingTask = task(
          interactionSignal,
          commitAware ? () => (commitStarted = true) : undefined,
          cancelAcrossDialogs
            ? (active) => {
                activeDialogs += active ? 1 : -1;
              }
            : undefined,
        );
      } catch (error) {
        unsubscribe?.();
        loader.dispose();
        throw error;
      }
      const operation = pendingTask.then(
        (result) => {
          taskResult = result;
          complete({});
        },
        (error: unknown) => complete({ error }),
      );
      return {
        render(width: number) {
          if (width <= 0) return [];
          const safeWidth = Math.max(1, width);
          const lines = loader.render(safeWidth);
          const bottomBorder = lines.at(-1);
          return [
            ...lines.slice(0, -1),
            truncateToWidth(theme.fg("dim", cancelHint), safeWidth, ""),
            ...(bottomBorder === undefined ? [] : [bottomBorder]),
          ];
        },
        invalidate: () => loader.invalidate(),
        handleInput: cancel,
        dispose() {
          unsubscribe?.();
          loader.dispose();
        },
        waitForPending: () => operation,
      };
    },
  });
  if (interaction.kind === "error") throw interaction.error;
  if (interaction.kind !== "completed") return { kind: "closed" };
  if (interaction.value.cancelled) {
    if (cancelledMessage) ctx.ui.notify(cancelledMessage, "info");
    return { kind: "cancelled" };
  }
  if (interaction.value.error) throw interaction.value.error;
  return { kind: "completed", value: taskResult };
}

function hasControlCharacter(value: string) {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: Unsafe key labels must be omitted.
  return /[\u0000-\u001f\u007f-\u009f]/u.test(value);
}
