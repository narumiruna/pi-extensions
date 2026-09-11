import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
  actionMenuDialogLabel,
  browseDialogLabel,
  browseDialogPages,
  createMenuScreenComponent,
  type MenuInputSubmit,
  type MenuMultiSelectChange,
  type MenuScreenComponent,
  type MenuScreenEvent,
  type MenuSettingChange,
  prepareMenuScreenRendering,
  reviewDialogPages,
  safeMenuText,
} from "./components/index.js";
import {
  type InteractionInvocation,
  invokeMenuInteraction,
  isMenuCurrent,
  type MenuInteraction,
  reportMenuError,
} from "./interaction.js";
import { resolveMenuScreen } from "./model.js";
import { createMenuNavigator } from "./navigator.js";
import type { MenuCloseReason, MenuContext, MenuDefinition, MenuScreen, MenuTransition } from "./types.js";

type ExtensionMode = MenuContext["mode"];

export type RunMenuResult =
  | { kind: "closed"; reason: MenuCloseReason }
  | { kind: "stale" }
  | { kind: "unsupported"; mode: ExtensionMode }
  | { kind: "error"; error: unknown };

export interface RunMenuOptions<State, Context extends MenuContext = ExtensionCommandContext> {
  getState(context: { ctx: Context; signal: AbortSignal }): State | Promise<State>;
  signal?: AbortSignal;
  isCurrent?(): boolean;
  onError?(ctx: Context, error: unknown): void | Promise<void>;
  onUnsupportedMode?(ctx: Context, mode: ExtensionMode): void | Promise<void>;
}

type InternalScreenEvent<ScreenId extends string> =
  | MenuScreenEvent
  | { kind: "transition"; transition: MenuTransition<ScreenId> };

export async function runMenu<
  State,
  ScreenId extends string,
  ActionId extends string,
  Context extends MenuContext = ExtensionCommandContext,
>(
  ctx: Context,
  definition: MenuDefinition<State, ScreenId, ActionId, Context>,
  options: RunMenuOptions<State, Context>,
): Promise<RunMenuResult> {
  if (ctx.mode === "tui" && ctx.hasUI) return runTuiMenu(ctx, definition, options);
  if (ctx.mode === "rpc" && ctx.hasUI) return runDialogMenu(ctx, definition, options);
  await options.onUnsupportedMode?.(ctx, ctx.mode);
  return { kind: "unsupported", mode: ctx.mode };
}

async function runTuiMenu<State, ScreenId extends string, ActionId extends string, Context extends MenuContext>(
  ctx: Context,
  definition: MenuDefinition<State, ScreenId, ActionId, Context>,
  options: RunMenuOptions<State, Context>,
): Promise<RunMenuResult> {
  const menuController = new AbortController();
  const menuSignal = options.signal ? AbortSignal.any([menuController.signal, options.signal]) : menuController.signal;
  const navigator = createMenuNavigator(definition.start);
  const searchQueries = new Map<ScreenId, string>();
  try {
    while (!navigator.closed) {
      const loaded = await loadState(ctx, options, menuSignal);
      if (loaded.kind !== "loaded") return loaded.result;
      const state = loaded.state;
      const screenId = navigator.current;
      const screen = resolveMenuScreen(definition, screenId, state);
      const renderingPreparation = prepareMenuScreenRendering(screen);
      if (renderingPreparation) {
        await renderingPreparation;
        if (!isMenuCurrent(options) || menuSignal.aborted) return { kind: "stale" };
      }
      let staleAction = false;
      const interact = async (interaction: MenuInteraction, interactionSignal?: AbortSignal) => {
        const invocation = await invokeMenuInteraction({
          ctx,
          definition,
          screen,
          state,
          menuSignal,
          interactionSignal,
          runtime: options,
          interaction,
        });
        if (invocation.selectionItemId) {
          navigator.rememberSelection(navigator.current, invocation.selectionItemId);
        }
        if (invocation.stale) staleAction = true;
        return invocation;
      };
      const event = await showTuiScreen(
        ctx,
        screen,
        navigator.selectionFor(screenId, selectableItemIds(screen)),
        searchQueries.get(screenId),
        menuSignal,
        {
          onSelectionChange: (itemId) => navigator.rememberSelection(screenId, itemId),
          onSearchQueryChange: (query) => searchQueries.set(screenId, query),
          onSettingChange: (change, signal) =>
            interact({ kind: "setting", itemId: change.itemId, value: change.value }, signal),
          onMultiSelectChange: (change, signal) =>
            interact(
              {
                kind: "multiSelect",
                itemId: change.itemId,
                selected: change.selected,
              },
              signal,
            ),
          onInputSubmit: async (change, signal) => {
            const invocation = await interact({ kind: "input", value: change.value }, signal);
            return invocation.stale ? componentCloseInvocation<ScreenId>() : invocation;
          },
        },
      );
      if (staleAction || !isMenuCurrent(options) || menuSignal.aborted) {
        return { kind: "stale" };
      }
      if (!event) {
        navigator.apply({ kind: "close" });
        continue;
      }
      if (event.kind === "back" || event.kind === "close") {
        searchQueries.delete(screenId);
        navigator.apply({ kind: event.kind });
        continue;
      }
      if (event.kind === "transition") {
        if (event.transition.kind !== "stay") searchQueries.delete(screenId);
        navigator.apply(event.transition);
        continue;
      }
      const outcome = await interact({ kind: "activate", itemId: event.itemId });
      if (outcome.stale) return { kind: "stale" };
      if (outcome.transition.kind !== "stay") searchQueries.delete(screenId);
      navigator.apply(outcome.transition);
    }
    return closedMenuResult(navigator.closeReason);
  } catch (error) {
    if (!isMenuCurrent(options) || menuSignal.aborted) return { kind: "stale" };
    await reportMenuError(ctx, options, error);
    if (!isMenuCurrent(options) || menuSignal.aborted) return { kind: "stale" };
    return { kind: "error", error };
  } finally {
    menuController.abort(new DOMException("Menu closed", "AbortError"));
  }
}

function selectableItemIds<ScreenId extends string, ActionId extends string>(screen: MenuScreen<ScreenId, ActionId>) {
  if (!("items" in screen)) return [];
  if (screen.kind === "multiSelect") {
    return [...screen.items, ...(screen.actions ?? [])].map((item) => item.id);
  }
  const itemIds = screen.items.map((item) => item.id);
  if (screen.kind !== "choice") return itemIds;
  const preferred = [screen.initialItemId, screen.currentItemId].find(
    (itemId): itemId is string => itemId !== undefined && itemIds.includes(itemId),
  );
  return preferred ? [preferred, ...itemIds.filter((itemId) => itemId !== preferred)] : itemIds;
}

async function showTuiScreen<ScreenId extends string, ActionId extends string, Context extends MenuContext>(
  ctx: Context,
  screen: MenuScreen<ScreenId, ActionId>,
  selectedItemId: string | undefined,
  searchQuery: string | undefined,
  menuSignal: AbortSignal,
  callbacks: {
    onSelectionChange(itemId: string): void;
    onSearchQueryChange(query: string): void;
    onSettingChange(change: MenuSettingChange, signal: AbortSignal): Promise<InteractionInvocation<ScreenId>>;
    onMultiSelectChange(change: MenuMultiSelectChange, signal: AbortSignal): Promise<InteractionInvocation<ScreenId>>;
    onInputSubmit(change: MenuInputSubmit, signal: AbortSignal): Promise<InteractionInvocation<ScreenId>>;
  },
): Promise<InternalScreenEvent<ScreenId> | undefined> {
  let component: MenuScreenComponent | undefined;
  let removeAbortListener = () => {};
  try {
    return await uiFor(ctx).custom<InternalScreenEvent<ScreenId> | undefined>((tui, theme, keybindings, done) => {
      const screenController = new AbortController();
      let finished = false;
      const finish = (event: InternalScreenEvent<ScreenId>) => {
        if (finished) return;
        finished = true;
        done(event);
      };
      const abortScreen = () => {
        screenController.abort(new DOMException("Menu owner disposed", "AbortError"));
        finish({ kind: "close" });
      };
      menuSignal.addEventListener("abort", abortScreen, { once: true });
      removeAbortListener = () => menuSignal.removeEventListener("abort", abortScreen);
      if (menuSignal.aborted) abortScreen();
      component = createMenuScreenComponent({
        screen,
        selectedItemId,
        searchQuery,
        tui,
        theme,
        keybindings,
        onEvent: finish,
        onSelectionChange: callbacks.onSelectionChange,
        onSearchQueryChange: callbacks.onSearchQueryChange,
        onSettingChange: (change) => callbacks.onSettingChange(change, screenController.signal),
        onMultiSelectChange: (change) => callbacks.onMultiSelectChange(change, screenController.signal),
        onInputSubmit: (change) => callbacks.onInputSubmit(change, screenController.signal),
        onTransition: (transition) => finish({ kind: "transition", transition }),
        onDispose: () => {
          removeAbortListener();
          screenController.abort(new DOMException("Menu screen disposed", "AbortError"));
        },
      });
      return component;
    });
  } finally {
    removeAbortListener();
    await component?.waitForPending();
  }
}

async function runDialogMenu<State, ScreenId extends string, ActionId extends string, Context extends MenuContext>(
  ctx: Context,
  definition: MenuDefinition<State, ScreenId, ActionId, Context>,
  options: RunMenuOptions<State, Context>,
): Promise<RunMenuResult> {
  const controller = new AbortController();
  const menuSignal = options.signal ? AbortSignal.any([controller.signal, options.signal]) : controller.signal;
  const navigator = createMenuNavigator(definition.start);
  try {
    while (!navigator.closed) {
      const loaded = await loadState(ctx, options, menuSignal);
      if (loaded.kind !== "loaded") return loaded.result;
      const state = loaded.state;
      const screen = resolveMenuScreen(definition, navigator.current, state);
      const interact = (interaction: MenuInteraction) =>
        invokeMenuInteraction({
          ctx,
          definition,
          screen,
          state,
          menuSignal,
          runtime: options,
          interaction,
        });
      if (screen.kind === "input") {
        const value = await uiFor(ctx).input(dialogTitle(screen), safeMenuText(screen.placeholder ?? ""), {
          signal: menuSignal,
        });
        if (!isMenuCurrent(options) || menuSignal.aborted) return { kind: "stale" };
        if (value === undefined) {
          navigator.apply({ kind: screen.hint ?? "back" });
          continue;
        }
        const outcome = await interact({ kind: "input", value });
        if (outcome.stale) return { kind: "stale" };
        navigator.apply(outcome.transition);
        continue;
      }
      if (screen.kind === "review") {
        const pages = reviewDialogPages(screen);
        let pageIndex = 0;
        let finished = false;
        while (!finished) {
          const choices = uniqueReviewChoices([
            ...(pageIndex > 0 ? [{ kind: "previous" as const, label: "Previous" }] : []),
            ...(pageIndex < pages.length - 1 ? [{ kind: "next" as const, label: "Next" }] : []),
            ...(screen.confirm ? [{ kind: "confirm" as const, label: safeMenuText(screen.confirm.label) }] : []),
            { kind: "exit" as const, label: dialogExitChoice(screen) },
          ]);
          const pageTitle = [
            dialogTitle(screen),
            pages[pageIndex]?.join("\n") ?? "",
            ...(pages.length > 1 ? [`Page ${pageIndex + 1}/${pages.length}`] : []),
          ]
            .filter(Boolean)
            .join("\n");
          const choice = await uiFor(ctx).select(
            pageTitle,
            choices.map((row) => row.label),
            { signal: menuSignal },
          );
          if (!isMenuCurrent(options) || menuSignal.aborted) return { kind: "stale" };
          const selected = choices.find((row) => row.label === choice);
          if (!selected || selected.kind === "exit") {
            navigator.apply({ kind: screen.hint ?? "back" });
            finished = true;
          } else if (selected.kind === "previous") pageIndex = Math.max(0, pageIndex - 1);
          else if (selected.kind === "next") {
            pageIndex = Math.min(pages.length - 1, pageIndex + 1);
          } else if (screen.confirm) {
            const outcome = await interact({ kind: "activate", itemId: screen.confirm.id });
            if (outcome.stale) return { kind: "stale" };
            if (outcome.accepted) {
              navigator.apply(outcome.transition);
              finished = true;
            }
          }
        }
        continue;
      }
      if (screen.kind === "browse") {
        let browsing = true;
        while (browsing) {
          const choices = uniqueBrowseChoices([
            ...screen.items.map((item) => ({
              kind: "item" as const,
              item,
              label: browseDialogLabel(item),
            })),
            { kind: "exit" as const, label: dialogExitChoice(screen) },
          ]);
          const choice = await uiFor(ctx).select(
            dialogTitle(screen),
            choices.map((row) => row.label),
            { signal: menuSignal },
          );
          if (!isMenuCurrent(options) || menuSignal.aborted) return { kind: "stale" };
          const selected = choices.find((row) => row.label === choice);
          if (!selected || selected.kind === "exit") {
            navigator.apply({ kind: screen.hint ?? "back" });
            browsing = false;
            continue;
          }
          const pages = browseDialogPages(selected.item);
          let pageIndex = 0;
          let viewingDetail = true;
          while (viewingDetail) {
            const pageChoices = uniqueReviewChoices([
              ...(pageIndex > 0 ? [{ kind: "previous" as const, label: "Previous" }] : []),
              ...(pageIndex < pages.length - 1 ? [{ kind: "next" as const, label: "Next" }] : []),
              { kind: "exit" as const, label: "Back" },
            ]);
            const pageTitle = [
              browseDialogLabel(selected.item),
              pages[pageIndex]?.join("\n") ?? "",
              ...(pages.length > 1 ? [`Page ${pageIndex + 1}/${pages.length}`] : []),
            ]
              .filter(Boolean)
              .join("\n");
            const pageChoice = await uiFor(ctx).select(
              pageTitle,
              pageChoices.map((row) => row.label),
              { signal: menuSignal },
            );
            if (!isMenuCurrent(options) || menuSignal.aborted) return { kind: "stale" };
            const selectedPage = pageChoices.find((row) => row.label === pageChoice);
            if (!selectedPage || selectedPage.kind === "exit") viewingDetail = false;
            else if (selectedPage.kind === "previous") {
              pageIndex = Math.max(0, pageIndex - 1);
            } else if (selectedPage.kind === "next") {
              pageIndex = Math.min(pages.length - 1, pageIndex + 1);
            }
          }
        }
        continue;
      }
      const rows = dialogRows(screen);
      const choice = await uiFor(ctx).select(
        dialogTitle(screen),
        rows.map((row) => row.label),
        { signal: menuSignal },
      );
      if (!isMenuCurrent(options) || menuSignal.aborted) return { kind: "stale" };
      if (!choice) {
        navigator.apply({ kind: "back" });
        continue;
      }
      const selectedRow = rows.find((row) => row.label === choice);
      if (!selectedRow) continue;
      if (selectedRow.kind === "exit") {
        const destination = "hint" in screen ? (screen.hint ?? "back") : "back";
        navigator.apply({ kind: destination });
        continue;
      }
      const outcome = await interact(selectedRow.interaction);
      if (outcome.stale) return { kind: "stale" };
      navigator.apply(outcome.transition);
    }
    return closedMenuResult(navigator.closeReason);
  } catch (error) {
    if (!isMenuCurrent(options) || menuSignal.aborted) return { kind: "stale" };
    await reportMenuError(ctx, options, error);
    if (!isMenuCurrent(options) || menuSignal.aborted) return { kind: "stale" };
    return { kind: "error", error };
  } finally {
    controller.abort(new DOMException("Menu closed", "AbortError"));
  }
}

function dialogTitle<ScreenId extends string, ActionId extends string>(screen: MenuScreen<ScreenId, ActionId>) {
  return [safeMenuText(screen.title), ...(("lines" in screen && screen.lines) || []).map(safeMenuText)]
    .filter(Boolean)
    .join("\n");
}

type DialogRow = { kind: "interaction"; interaction: MenuInteraction; label: string } | { kind: "exit"; label: string };

interface ReviewDialogChoice {
  kind: "previous" | "next" | "confirm" | "exit";
  label: string;
}

type BrowseDialogChoice =
  | {
      kind: "item";
      label: string;
      item: Extract<MenuScreen<string, string>, { kind: "browse" }>["items"][number];
    }
  | { kind: "exit"; label: string; item?: never };

function dialogRows<ScreenId extends string, ActionId extends string>(
  screen: MenuScreen<ScreenId, ActionId>,
): DialogRow[] {
  let rows: DialogRow[];
  if (screen.kind === "detail") {
    rows = [{ kind: "exit", label: dialogExitChoice(screen) }];
  } else if (screen.kind === "actions") {
    rows = screen.items.map((item) => ({
      kind: "interaction",
      interaction: { kind: "activate", itemId: item.id },
      label: actionMenuDialogLabel(item),
    }));
  } else if (screen.kind === "settings") {
    rows = [
      ...screen.items.map((item) => {
        const values = item.values ?? [item.currentValue];
        const currentIndex = Math.max(0, values.indexOf(item.currentValue));
        return {
          kind: "interaction" as const,
          interaction: {
            kind: "setting" as const,
            itemId: item.id,
            value: values[(currentIndex + 1) % values.length] ?? item.currentValue,
          },
          label: `${safeMenuText(item.label)} (${safeMenuText(item.currentValue)})`,
        };
      }),
      { kind: "exit", label: dialogExitChoice(screen) },
    ];
  } else if (screen.kind === "input" || screen.kind === "review") {
    rows = [];
  } else if (screen.kind === "browse") {
    rows = [{ kind: "exit", label: dialogExitChoice(screen) }];
  } else if (screen.kind === "choice") {
    rows = [
      ...screen.items.map((item) => {
        const label = safeMenuText(item.label);
        const current = item.id === screen.currentItemId ? " (current)" : "";
        const unavailable = item.disabled
          ? `[-] ${label} (unavailable${item.disabledReason ? `: ${safeMenuText(item.disabledReason)}` : ""})`
          : `${label}${current}`;
        return {
          kind: "interaction" as const,
          interaction: { kind: "activate" as const, itemId: item.id },
          label: unavailable,
        };
      }),
      { kind: "exit", label: dialogExitChoice(screen) },
    ];
  } else {
    rows = [
      ...screen.items.map((item) => ({
        kind: "interaction" as const,
        interaction: {
          kind: "multiSelect" as const,
          itemId: item.id,
          selected: !item.selected,
        },
        label: item.disabled
          ? `[-] ${safeMenuText(item.label)} (unavailable${item.disabledReason ? `: ${safeMenuText(item.disabledReason)}` : ""})`
          : `${item.selected ? "[x]" : "[ ]"} ${safeMenuText(item.label)}`,
      })),
      ...(screen.actions ?? []).map((item) => ({
        kind: "interaction" as const,
        interaction: { kind: "activate" as const, itemId: item.id },
        label: actionMenuDialogLabel(item),
      })),
      { kind: "exit", label: dialogExitChoice(screen) },
    ];
  }
  return uniqueDialogRows(rows);
}

function uniqueReviewChoices(rows: readonly ReviewDialogChoice[]): ReviewDialogChoice[] {
  const used = new Set<string>();
  return rows.map((row) => ({ ...row, label: uniqueDialogLabel(row.label, used) }));
}

function uniqueBrowseChoices(rows: readonly BrowseDialogChoice[]): BrowseDialogChoice[] {
  const used = new Set<string>();
  return rows.map((row) => ({ ...row, label: uniqueDialogLabel(row.label, used) }));
}

function uniqueDialogRows(rows: readonly DialogRow[]): DialogRow[] {
  const used = new Set<string>();
  return rows.map((row) => ({ ...row, label: uniqueDialogLabel(row.label, used) }));
}

function uniqueDialogLabel(base: string, used: Set<string>) {
  let label = base;
  let suffix = 2;
  while (used.has(label)) {
    label = `${base} [${suffix}]`;
    suffix += 1;
  }
  used.add(label);
  return label;
}

function dialogExitChoice<ScreenId extends string, ActionId extends string>(screen: MenuScreen<ScreenId, ActionId>) {
  if (screen.kind === "multiSelect" && screen.doneLabel) return safeMenuText(screen.doneLabel);
  return "hint" in screen && screen.hint === "close" ? "Done" : "Back";
}

async function loadState<State, Context extends MenuContext>(
  ctx: Context,
  options: RunMenuOptions<State, Context>,
  signal: AbortSignal,
): Promise<{ kind: "loaded"; state: State } | { kind: "result"; result: RunMenuResult }> {
  if (signal.aborted || !isMenuCurrent(options)) {
    return { kind: "result", result: { kind: "stale" } };
  }
  try {
    const state = await options.getState({ ctx, signal });
    if (signal.aborted || !isMenuCurrent(options)) {
      return { kind: "result", result: { kind: "stale" } };
    }
    return { kind: "loaded", state };
  } catch (error) {
    if (signal.aborted || !isMenuCurrent(options)) {
      return { kind: "result", result: { kind: "stale" } };
    }
    await reportMenuError(ctx, options, error);
    if (signal.aborted || !isMenuCurrent(options)) {
      return { kind: "result", result: { kind: "stale" } };
    }
    return { kind: "result", result: { kind: "error", error } };
  }
}

function componentCloseInvocation<ScreenId extends string>(): InteractionInvocation<ScreenId> {
  return { accepted: true, stale: false, transition: { kind: "close" } };
}

function closedMenuResult(reason: MenuCloseReason | undefined): RunMenuResult {
  if (reason === undefined) throw new Error("Menu navigator closed without a termination reason");
  return { kind: "closed", reason };
}

function uiFor(ctx: MenuContext): ExtensionCommandContext["ui"] {
  // Pi core packages are peers and can be typechecked at multiple compatible versions in one tree.
  // The runtime uses only this stable UI surface and never adds command-only context capabilities.
  return ctx.ui as ExtensionCommandContext["ui"];
}
