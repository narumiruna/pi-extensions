import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { createMultiSelectComponent } from "./components/multi-select.js";
import { safeMenuText } from "./components/rendering.js";
import { runCustomInteraction } from "./custom-interaction.js";
import { callErrorReporter, notifyInteractionError } from "./interaction-error.js";
import type { MenuCloseReason, MenuContext, MultiSelectScreen } from "./types.js";

type ExtensionMode = MenuContext["mode"];
type MultiSelectValue = { kind: "completed" } | { kind: "cancelled"; reason: MenuCloseReason };

export interface MultiSelectItem<ItemId extends string = string> {
  id: ItemId;
  label: string;
  description?: string;
  selected?: boolean;
  disabled?: boolean;
  disabledReason?: string;
  /** Additional non-rendered text used by optional TUI fuzzy search. */
  searchText?: string;
}

export interface RunMultiSelectOptions<
  Item extends MultiSelectItem,
  Context extends MenuContext = ExtensionCommandContext,
> {
  title: string;
  lines?: readonly string[];
  items: readonly Item[];
  initialItemId?: Item["id"];
  enableSearch?: boolean;
  viewportSize?: number;
  completionLabel?: string;
  hint?: MenuCloseReason;
  signal?: AbortSignal;
  isCurrent?(): boolean;
  onError?(ctx: Context, error: unknown): void | Promise<void>;
  onUnsupportedMode?(ctx: Context, mode: ExtensionMode): void | Promise<void>;
}

export type RunMultiSelectResult<ItemId extends string = string> =
  | { kind: "completed"; selectedItemIds: ItemId[] }
  | { kind: "cancelled"; reason: MenuCloseReason }
  | { kind: "stale" }
  | { kind: "unsupported"; mode: ExtensionMode }
  | { kind: "error"; error: unknown };

/** Select an interaction-local set of IDs while leaving domain state and persistence to the caller. */
export async function runMultiSelect<
  const Item extends MultiSelectItem,
  Context extends MenuContext = ExtensionCommandContext,
>(ctx: Context, options: RunMultiSelectOptions<Item, Context>): Promise<RunMultiSelectResult<Item["id"]>> {
  if (!isCurrent(options) || options.signal?.aborted) return { kind: "stale" };
  const validationError = validateOptions(options);
  if (validationError) return multiSelectError(ctx, options, validationError);
  const selected = new Set(options.items.filter((item) => item.selected).map((item) => item.id));
  if (ctx.mode === "tui" && ctx.hasUI) return runTuiMultiSelect(ctx, options, selected);
  if (ctx.mode === "rpc" && ctx.hasUI) return runRpcMultiSelect(ctx, options, selected);

  try {
    await options.onUnsupportedMode?.(ctx, ctx.mode);
  } catch (error) {
    return multiSelectError(ctx, options, error);
  }
  if (!isCurrent(options) || options.signal?.aborted) return { kind: "stale" };
  return { kind: "unsupported", mode: ctx.mode };
}

async function runTuiMultiSelect<Item extends MultiSelectItem, Context extends MenuContext>(
  ctx: Context,
  options: RunMultiSelectOptions<Item, Context>,
  selected: Set<Item["id"]>,
): Promise<RunMultiSelectResult<Item["id"]>> {
  const doneId = internalDoneId(options.items);
  const screen: MultiSelectScreen<"standalone", "toggle" | "complete"> = {
    kind: "multiSelect",
    title: options.title,
    lines: options.lines,
    items: options.items.map((item) => ({ ...item, selected: selected.has(item.id) })),
    action: "toggle",
    enableSearch: options.enableSearch,
    viewportSize: options.viewportSize,
    hint: options.hint,
    actions: [{ id: doneId, label: options.completionLabel ?? "Done", action: "complete" }],
  };
  const result = await runCustomInteraction<MultiSelectValue, Context>(ctx, {
    signal: options.signal,
    isCurrent: options.isCurrent,
    onError: (currentCtx, error) => reportMultiSelectError(currentCtx, options, error),
    create: ({ tui, theme, keybindings, complete, signal }) =>
      createMultiSelectComponent<"standalone", "toggle" | "complete">({
        screen,
        selectedItemId: options.initialItemId,
        tui,
        theme,
        keybindings,
        onEvent: (event) => {
          if (event.kind === "activate" && event.itemId === doneId) complete({ kind: "completed" });
          else if (event.kind !== "activate") complete({ kind: "cancelled", reason: event.kind });
        },
        async onMultiSelectChange(change) {
          if (signal.aborted || !isCurrent(options)) return false;
          if (change.selected) selected.add(change.itemId as Item["id"]);
          else selected.delete(change.itemId as Item["id"]);
          return true;
        },
      }),
  });
  if (result.kind !== "completed") return result;
  if (result.value.kind === "cancelled") return result.value;
  return completedResult(options.items, selected);
}

async function runRpcMultiSelect<Item extends MultiSelectItem, Context extends MenuContext>(
  ctx: Context,
  options: RunMultiSelectOptions<Item, Context>,
  selected: Set<Item["id"]>,
): Promise<RunMultiSelectResult<Item["id"]>> {
  for (;;) {
    const rows = rpcRows(options, selected);
    let selectedLabel: string | undefined;
    try {
      selectedLabel = await uiFor(ctx).select(
        [options.title, ...(options.lines ?? [])].map(safeMenuText).filter(Boolean).join("\n"),
        rows.map((row) => row.label),
        { signal: options.signal },
      );
    } catch (error) {
      return multiSelectError(ctx, options, error);
    }
    if (!isCurrent(options) || options.signal?.aborted) return { kind: "stale" };
    if (selectedLabel === undefined) return { kind: "cancelled", reason: options.hint ?? "back" };
    const row = rows.find((candidate) => candidate.label === selectedLabel);
    if (!row)
      return multiSelectError(ctx, options, new Error("Multi-select dialog returned an option that was not offered"));
    if (row.kind === "complete") return completedResult(options.items, selected);
    if (row.item.disabled) continue;
    if (selected.has(row.item.id)) selected.delete(row.item.id);
    else selected.add(row.item.id);
  }
}

function completedResult<Item extends MultiSelectItem>(
  items: readonly Item[],
  selected: ReadonlySet<Item["id"]>,
): RunMultiSelectResult<Item["id"]> {
  return { kind: "completed", selectedItemIds: items.filter((item) => selected.has(item.id)).map((item) => item.id) };
}

type RpcRow<Item extends MultiSelectItem> =
  | { kind: "item"; label: string; item: Item }
  | { kind: "complete"; label: string };

function rpcRows<Item extends MultiSelectItem, Context extends MenuContext>(
  options: RunMultiSelectOptions<Item, Context>,
  selected: ReadonlySet<Item["id"]>,
): RpcRow<Item>[] {
  const used = new Set<string>();
  const rows: RpcRow<Item>[] = options.items.map((item) => {
    const state = item.disabled ? "[-]" : selected.has(item.id) ? "[x]" : "[ ]";
    const details = [
      item.disabled ? `unavailable${item.disabledReason ? `: ${safeMenuText(item.disabledReason)}` : ""}` : undefined,
      item.description ? safeMenuText(item.description) : undefined,
    ].filter((value): value is string => Boolean(value));
    const label = `${state} ${safeMenuText(item.label)}${details.length > 0 ? ` — ${details.join(" · ")}` : ""}`;
    return { kind: "item", label: uniqueLabel(label, used), item };
  });
  rows.push({
    kind: "complete",
    label: uniqueLabel(safeMenuText(options.completionLabel ?? "Done") || "Done", used),
  });
  return rows;
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

function internalDoneId(items: readonly MultiSelectItem[]): string {
  const ids = new Set(items.map((item) => item.id));
  let id = "__pi_tui_kit_done__";
  while (ids.has(id)) id = `_${id}`;
  return id;
}

function validateOptions<Item extends MultiSelectItem, Context extends MenuContext>(
  options: RunMultiSelectOptions<Item, Context>,
): Error | undefined {
  if (!safeMenuText(options.title)) return new Error("Multi-select title must be displayable");
  if (options.viewportSize !== undefined && (!Number.isInteger(options.viewportSize) || options.viewportSize <= 0)) {
    return new Error("Multi-select viewportSize must be a positive integer");
  }
  if (options.completionLabel !== undefined && !safeMenuText(options.completionLabel).trim()) {
    return new Error("Multi-select completionLabel must be displayable");
  }
  const ids = new Set<string>();
  for (const item of options.items) {
    if (!item.id.trim()) return new Error("Multi-select item ids must not be blank");
    if (ids.has(item.id)) return new Error(`Duplicate multi-select item id: ${item.id}`);
    ids.add(item.id);
    if (!safeMenuText(item.label)) return new Error(`Multi-select item ${item.id} requires a displayable label`);
  }
  return undefined;
}

async function multiSelectError<Item extends MultiSelectItem, Context extends MenuContext>(
  ctx: Context,
  options: RunMultiSelectOptions<Item, Context>,
  error: unknown,
): Promise<RunMultiSelectResult<Item["id"]>> {
  if (!isCurrent(options) || options.signal?.aborted) return { kind: "stale" };
  await reportMultiSelectError(ctx, options, error);
  if (!isCurrent(options) || options.signal?.aborted) return { kind: "stale" };
  return { kind: "error", error };
}

async function reportMultiSelectError<Item extends MultiSelectItem, Context extends MenuContext>(
  ctx: Context,
  options: RunMultiSelectOptions<Item, Context>,
  error: unknown,
): Promise<void> {
  const reporting = callErrorReporter(ctx, options, error);
  const reported = reporting && (await reporting);
  if (reported || !ctx.hasUI || !isCurrent(options) || options.signal?.aborted) return;
  notifyInteractionError(ctx, error, "Multi-select failed: ", safeMenuText);
}

function isCurrent<Item extends MultiSelectItem, Context extends MenuContext>(
  options: RunMultiSelectOptions<Item, Context>,
): boolean {
  return options.isCurrent?.() ?? true;
}

function uiFor(ctx: MenuContext): ExtensionCommandContext["ui"] {
  return ctx.ui as ExtensionCommandContext["ui"];
}
