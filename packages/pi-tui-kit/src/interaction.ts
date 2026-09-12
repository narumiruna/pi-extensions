import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { safeMenuText } from "./components/index.js";
import { runTask } from "./task.js";
import type {
  ActionMenuItem,
  MenuActionHandler,
  MenuActionResult,
  MenuContext,
  MenuDefinition,
  MenuScreen,
  MenuTransition,
} from "./types.js";

export type MenuInteraction =
  | { kind: "activate"; itemId: string }
  | { kind: "setting"; itemId: string; value: string }
  | { kind: "multiSelect"; itemId: string; selected: boolean }
  | { kind: "input"; value: string };

export interface InteractionInvocation<ScreenId extends string> {
  accepted: boolean;
  stale: boolean;
  transition: MenuTransition<ScreenId>;
  selectionItemId?: string;
}

interface InteractionRuntimeOptions<Context extends MenuContext> {
  isCurrent?(): boolean;
  onError?(ctx: Context, error: unknown): void | Promise<void>;
}

interface InvokeMenuInteractionOptions<
  State,
  ScreenId extends string,
  ActionId extends string,
  Context extends MenuContext,
> {
  ctx: Context;
  definition: MenuDefinition<State, ScreenId, ActionId, Context>;
  screen: MenuScreen<ScreenId, ActionId>;
  state: State;
  menuSignal: AbortSignal;
  interactionSignal?: AbortSignal;
  runtime: InteractionRuntimeOptions<Context>;
  interaction: MenuInteraction;
}

export async function invokeMenuInteraction<
  State,
  ScreenId extends string,
  ActionId extends string,
  Context extends MenuContext,
>(options: InvokeMenuInteractionOptions<State, ScreenId, ActionId, Context>): Promise<InteractionInvocation<ScreenId>> {
  const { ctx, definition, screen, state, menuSignal, runtime, interaction } = options;
  const signal = options.interactionSignal ? AbortSignal.any([menuSignal, options.interactionSignal]) : menuSignal;

  switch (interaction.kind) {
    case "activate": {
      if (screen.kind === "actions") {
        const item = screen.items.find((candidate) => candidate.id === interaction.itemId);
        if (!item || item.disabled) return rejected();
        return activateActionItem(ctx, definition, item, state, signal, runtime);
      }
      if (screen.kind === "choice") {
        const item = screen.items.find((candidate) => candidate.id === interaction.itemId);
        if (!item || item.disabled) return rejected();
        return withSelection(
          await invokeAction(ctx, definition.actions[screen.action], state, signal, item.id, runtime),
          item.id,
        );
      }
      if (screen.kind === "review") {
        if (!screen.confirm || screen.confirm.id !== interaction.itemId) return rejected();
        return invokeAction(ctx, definition.actions[screen.confirm.action], state, signal, screen.confirm.id, runtime);
      }
      if (screen.kind === "multiSelect") {
        const item = screen.actions?.find((candidate) => candidate.id === interaction.itemId);
        if (!item || item.disabled) return rejected();
        return activateActionItem(ctx, definition, item, state, signal, runtime);
      }
      return rejected();
    }
    case "setting": {
      if (screen.kind !== "settings") return rejected();
      const item = screen.items.find((candidate) => candidate.id === interaction.itemId);
      if (!item || item.disabled) return rejected();
      return withSelection(
        await invokeAction(ctx, definition.actions[item.action], state, signal, item.id, runtime, {
          value: interaction.value,
        }),
        item.id,
      );
    }
    case "multiSelect": {
      if (screen.kind !== "multiSelect") return rejected();
      const item = screen.items.find((candidate) => candidate.id === interaction.itemId);
      if (!item || item.disabled) return rejected();
      return withSelection(
        await invokeAction(ctx, definition.actions[screen.action], state, signal, item.id, runtime, {
          selected: interaction.selected,
        }),
        item.id,
      );
    }
    case "input":
      if (screen.kind !== "input") return rejected();
      return invokeAction(ctx, definition.actions[screen.action], state, signal, "input", runtime, {
        value: interaction.value,
      });
  }
}

async function activateActionItem<State, ScreenId extends string, ActionId extends string, Context extends MenuContext>(
  ctx: Context,
  definition: MenuDefinition<State, ScreenId, ActionId, Context>,
  item: ActionMenuItem<ScreenId, ActionId>,
  state: State,
  signal: AbortSignal,
  runtime: InteractionRuntimeOptions<Context>,
): Promise<InteractionInvocation<ScreenId>> {
  if ("to" in item && item.to !== undefined) {
    return accepted({ kind: "to", screen: item.to }, item.id);
  }
  if ("close" in item) return accepted({ kind: "close" }, item.id);
  if (!("action" in item) || item.action === undefined) return rejected();
  const handler = definition.actions[item.action];
  const invocation =
    "busyLabel" in item && item.busyLabel && ctx.mode === "tui" && ctx.hasUI
      ? await invokeBusyAction(ctx, handler, state, item.id, item.busyLabel, signal, runtime)
      : await invokeAction(ctx, handler, state, signal, item.id, runtime);
  return withSelection(invocation, item.id);
}

async function invokeBusyAction<State, ScreenId extends string, Context extends MenuContext>(
  ctx: Context,
  handler: MenuActionHandler<State, ScreenId, Context>,
  state: State,
  itemId: string,
  label: string,
  signal: AbortSignal,
  runtime: InteractionRuntimeOptions<Context>,
): Promise<InteractionInvocation<ScreenId>> {
  const result = await runTask(ctx, {
    label,
    signal,
    isCurrent: runtime.isCurrent,
    onError: () => undefined,
    task: ({ signal: taskSignal }) => invokeAction(ctx, handler, state, taskSignal, itemId, runtime, {}, false),
  });
  switch (result.kind) {
    case "completed":
      return result.value;
    case "cancelled":
      return rejected();
    case "stale":
      return { ...rejected<ScreenId>(), stale: true };
    case "error":
      throw result.error;
  }
}

async function invokeAction<State, ScreenId extends string, Context extends MenuContext>(
  ctx: Context,
  handler: MenuActionHandler<State, ScreenId, Context>,
  state: State,
  signal: AbortSignal,
  itemId: string,
  runtime: InteractionRuntimeOptions<Context>,
  input: { value?: string; selected?: boolean } = {},
  abortIsStale = true,
): Promise<InteractionInvocation<ScreenId>> {
  if (!isMenuCurrent(runtime)) return { ...rejected<ScreenId>(), stale: true };
  if (signal.aborted) {
    return abortIsStale ? { ...rejected<ScreenId>(), stale: true } : rejected();
  }
  let result: MenuActionResult<ScreenId>;
  try {
    result = await handler({ ctx, state, signal, itemId, ...input });
  } catch (error) {
    if (!isMenuCurrent(runtime)) return { ...rejected<ScreenId>(), stale: true };
    if (signal.aborted) {
      return abortIsStale ? { ...rejected<ScreenId>(), stale: true } : rejected();
    }
    await reportMenuError(ctx, runtime, error);
    if (!isMenuCurrent(runtime)) return { ...rejected<ScreenId>(), stale: true };
    if (signal.aborted) {
      return abortIsStale ? { ...rejected<ScreenId>(), stale: true } : rejected();
    }
    return rejected();
  }
  if (!isMenuCurrent(runtime)) return { ...rejected<ScreenId>(), stale: true };
  if (signal.aborted) {
    return abortIsStale ? { ...rejected<ScreenId>(), stale: true } : rejected();
  }
  if (result?.kind === "rejected") {
    if (result.error !== undefined) await reportMenuError(ctx, runtime, result.error);
    if (!isMenuCurrent(runtime)) return { ...rejected<ScreenId>(), stale: true };
    if (signal.aborted) {
      return abortIsStale ? { ...rejected<ScreenId>(), stale: true } : rejected();
    }
    return rejected();
  }
  return accepted(result ?? { kind: "stay" });
}

export async function reportMenuError<Context extends MenuContext>(
  ctx: Context,
  runtime: InteractionRuntimeOptions<Context>,
  error: unknown,
) {
  if (runtime.onError) {
    try {
      await runtime.onError(ctx, error);
      return;
    } catch {
      // Fall back to Pi's notifier when a custom reporter is no longer available.
    }
  }
  if (ctx.hasUI) {
    const message = error instanceof Error ? error.message : String(error);
    try {
      uiFor(ctx).notify(`Menu action failed: ${safeMenuText(message)}`, "error");
    } catch {
      // Error reporting must never escape the documented menu result contract.
    }
  }
}

export function isMenuCurrent<Context extends MenuContext>(runtime: InteractionRuntimeOptions<Context>) {
  return runtime.isCurrent?.() ?? true;
}

function accepted<ScreenId extends string>(
  transition: MenuTransition<ScreenId>,
  selectionItemId?: string,
): InteractionInvocation<ScreenId> {
  return { accepted: true, stale: false, transition, selectionItemId };
}

function rejected<ScreenId extends string>(): InteractionInvocation<ScreenId> {
  return { accepted: false, stale: false, transition: { kind: "stay" } };
}

function withSelection<ScreenId extends string>(
  invocation: InteractionInvocation<ScreenId>,
  selectionItemId: string,
): InteractionInvocation<ScreenId> {
  return { ...invocation, selectionItemId };
}

function uiFor(ctx: MenuContext): ExtensionCommandContext["ui"] {
  return ctx.ui as ExtensionCommandContext["ui"];
}
