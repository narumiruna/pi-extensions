import { type Api, getSupportedThinkingLevels, type Model } from "@earendil-works/pi-ai";
import {
  BorderedLoader,
  type ExtensionCommandContext,
  type KeybindingsManager,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import type { MenuContext, RunMenuResult } from "@narumitw/pi-tui-kit";
import {
  BTW_SHORTCUT_ACTIONS,
  type BtwShortcutAction,
  normalizeBtwKey,
  resolveBtwShortcuts,
  validateBtwShortcutEdit,
} from "./keybindings.js";
import {
  type BtwLayout,
  type BtwSettings,
  type BtwSettingsPatch,
  btwSettingsPath,
  effectiveBtwLayout,
  effectiveFullscreenCopyOnSelect,
  effectiveRememberThinkingLevelChanges,
  parseBtwModelReference,
  readBtwSettings,
  type UpdateBtwSettingsOptions,
  updateBtwSettings,
} from "./settings.js";
import { BTW_THINKING_LEVELS, type BtwThinkingLevel } from "./side-thread.js";
import { formatKeyLabel, sanitizeSingleLine } from "./text.js";

interface BtwMenuState {
  kind: "valid" | "invalid";
  settings: BtwSettings;
  reason?: string;
}

export interface BtwResumeThreadSummary {
  id: string;
  title: string;
  questionCount: number;
}

export interface ShowBtwCommandMenuOptions {
  currentThinkingLevel: BtwThinkingLevel;
  /** Deterministic test override; production derives levels from each selected model. */
  availableThinkingLevels?: readonly BtwThinkingLevel[];
  availableModels?: readonly Model<Api>[];
  currentModel?: Model<Api>;
  scopedModels?: ExtensionCommandContext["scopedModels"];
  resumeThreads?: readonly BtwResumeThreadSummary[];
  settingsPath?: string;
  readSettings?: typeof readBtwSettings;
  updateSettings?: (patch: BtwSettingsPatch, options: UpdateBtwSettingsOptions) => Promise<BtwSettings>;
}

export type BtwCommandMenuResult = "start" | "tree" | "closed" | { kind: "resume"; threadId: string };

type BtwMenuScreen = "main" | "resume" | "settings" | "model" | "invalid" | "shortcut" | "shortcut-input";
type BtwMenuAction =
  | "start"
  | "start-tree"
  | "resume"
  | "open-model"
  | "set-model"
  | "set-thinking"
  | "set-remember"
  | "set-fullscreen-copy"
  | "set-layout"
  | "edit-shortcut"
  | "save-shortcut"
  | "reset-shortcut";
const SAME_AS_MAIN_THREAD = "Same as main thread";
const BTW_LAYOUT_LABELS: Record<BtwLayout, string> = {
  fullscreen: "Fullscreen",
  "left-pane": "Side thread left",
  "right-pane": "Side thread right",
};
const BTW_LAYOUT_VALUES = Object.values(BTW_LAYOUT_LABELS);
type BtwCustomOptions = Parameters<ExtensionCommandContext["ui"]["custom"]>[1];

type BtwCustomFactory<T> = (
  tui: TUI,
  theme: Theme,
  keybindings: KeybindingsManager,
  done: (result: T) => void,
) => Component;

export async function showBtwCommandMenu(
  ctx: ExtensionCommandContext,
  options: ShowBtwCommandMenuOptions,
): Promise<BtwCommandMenuResult> {
  if (ctx.mode !== "tui") return "closed";
  const { defineMenu, runMenu, sanitizeTerminalText } = await import("@narumitw/pi-tui-kit");
  if (ctx.signal?.aborted) return "closed";
  const settingsPath = options.settingsPath ?? btwSettingsPath();
  const readSettings = options.readSettings ?? readBtwSettings;
  const updateSettings = options.updateSettings ?? updateBtwSettings;
  const getAvailable = ctx.modelRegistry.getAvailable;
  const allAvailableModels = deduplicateModels(
    options.availableModels ??
      (typeof getAvailable === "function" ? getAvailable.call(ctx.modelRegistry) : ctx.modelRegistry.getAll()),
  );
  const currentModel = options.currentModel ?? ctx.model;
  const scopedModels = options.scopedModels ?? ctx.scopedModels ?? [];
  const selectableModels = availableModelsInScope(allAvailableModels, scopedModels);
  const modelItemIds = new Map(selectableModels.map((model, index) => [model, `btw-settings-model:${index}`]));
  const modelsByItemId = new Map(selectableModels.map((model) => [modelItemIds.get(model) as string, model]));
  const safeModelMetadata = (value: string, fallback: string): string => {
    const safe = sanitizeTerminalText(value).trim() || fallback;
    return [...safe].slice(0, 512).join("");
  };
  const displayModelReference = (model: Pick<Model<Api>, "provider" | "id">): string =>
    `${safeModelMetadata(model.id, "unknown model")} [${safeModelMetadata(model.provider, "unknown provider")}]`;
  const rawModelReference = (model: Pick<Model<Api>, "provider" | "id">): string | undefined => {
    const reference = `${model.provider}/${model.id}`;
    const parsed = parseBtwModelReference(reference);
    return parsed?.provider === model.provider && parsed.modelId === model.id ? reference : undefined;
  };
  const displaySettingsPath = sanitizeSingleLine(settingsPath);
  const resumeThreads = options.resumeThreads ?? [];
  let startSelected = false;
  let treeSelected = false;
  let resumedThreadId: string | undefined;
  let keybindings: KeybindingsManager | undefined;
  let shortcut: BtwShortcutAction = "exit";
  const shortcutLabels: Record<BtwShortcutAction, string> = {
    exit: "Exit shortcut",
    cycleThinkingLevel: "Cycle thinking level shortcut",
    bringToMain: "Bring to main shortcut",
  };
  const shortcutValue = (settings: BtwSettings, action: BtwShortcutAction): string => {
    if (!keybindings) return "Default";
    const effective = resolveBtwShortcuts(settings.keybindings, keybindings, effectiveFullscreenCopyOnSelect(settings));
    const configured = settings.keybindings?.[action];
    if (configured !== undefined && !effective.keys[action].includes(configured)) {
      return `Fallback (${effective.label(action)}; saved ${formatKeyLabel(configured)})`;
    }
    const source = configured === undefined ? (action === "cycleThinkingLevel" ? "Inherit Pi" : "Default") : "Custom";
    return `${source} (${effective.label(action)})`;
  };
  const saveShortcut = async (state: BtwMenuState, value: string | undefined, signal: AbortSignal) => {
    if (!keybindings || state.kind !== "valid" || signal.aborted) return { kind: "rejected" } as const;
    const action = shortcut;
    const manager = keybindings;
    const validate = (settings: BtwSettings) =>
      validateBtwShortcutEdit(
        action,
        value,
        settings.keybindings ?? {},
        manager,
        effectiveFullscreenCopyOnSelect(settings),
      );
    const error = validate(state.settings);
    if (error) {
      notifySafely(ctx, error, "error");
      return { kind: "rejected" } as const;
    }
    try {
      await updateSettings(
        { keybindings: { [action]: value === undefined ? undefined : normalizeBtwKey(value) } },
        {
          settingsPath,
          signal,
          validateCurrent: (settings) => {
            const conflict = validate(settings);
            if (conflict) throw new Error(conflict);
          },
        },
      );
      if (signal.aborted) return { kind: "rejected" } as const;
      notifySafely(ctx, "Pi BTW shortcut saved; applies when opening or resuming BTW.", "info");
      return { kind: "back" } as const;
    } catch (error) {
      if (!signal.aborted) notifySaveFailure(ctx, error);
      return { kind: "rejected" } as const;
    }
  };

  const saveModel = async (
    model: Model<Api> | undefined,
    signal: AbortSignal,
  ): Promise<{ kind: "saved" } | { kind: "cancelled" } | { kind: "failed"; error: unknown }> => {
    const modelReference = model ? rawModelReference(model) : undefined;
    if (model && !modelReference) return { kind: "cancelled" };
    const result = await ctx.ui.custom<{ kind: "saved" } | { kind: "cancelled" } | { kind: "failed"; error: unknown }>(
      (tui, theme, _keybindings, done) => {
        const loader = new BorderedLoader(tui, theme, "Saving Pi BTW model...");
        const ownerController = new AbortController();
        const saveSignal = AbortSignal.any([signal, loader.signal, ownerController.signal]);
        let settled = false;
        const finish = (value: { kind: "saved" } | { kind: "cancelled" } | { kind: "failed"; error: unknown }) => {
          if (settled) return;
          settled = true;
          done(value);
        };
        const cancel = () => finish({ kind: "cancelled" });
        loader.onAbort = cancel;
        saveSignal.addEventListener("abort", cancel, { once: true });
        queueMicrotask(() => {
          void (async () => {
            // Let the host mount the loader before a synchronous test double or cached write can settle it.
            await Promise.resolve();
            if (saveSignal.aborted) return;
            try {
              await updateSettings({ model: modelReference }, { settingsPath, signal: saveSignal });
              finish({ kind: "saved" });
            } catch (error) {
              finish(saveSignal.aborted ? { kind: "cancelled" } : { kind: "failed", error });
            }
          })();
        });
        return {
          render: (width: number) => loader.render(width),
          invalidate: () => loader.invalidate(),
          handleInput: (data: string) => loader.handleInput(data),
          dispose() {
            ownerController.abort(new DOMException("Pi BTW model save disposed", "AbortError"));
            loader.dispose();
          },
        };
      },
    );
    return result ?? { kind: "cancelled" };
  };

  const loadState = async (): Promise<BtwMenuState> => {
    const loaded = await readSettings(settingsPath);
    if (loaded.kind === "invalid") {
      return { kind: "invalid", settings: {}, reason: loaded.reason };
    }
    return { kind: "valid", settings: loaded.kind === "loaded" ? loaded.settings : {} };
  };
  const configuredModel = (settings: BtwSettings): Model<Api> | undefined => {
    if (!settings.model) return undefined;
    const reference = parseBtwModelReference(settings.model);
    return reference
      ? allAvailableModels.find((model) => model.provider === reference.provider && model.id === reference.modelId)
      : undefined;
  };
  const selectableConfiguredModel = (settings: BtwSettings): Model<Api> | undefined => {
    const configured = configuredModel(settings);
    return configured ? selectableModels.find((model) => sameModel(model, configured)) : undefined;
  };
  const thinkingLevels = (settings: BtwSettings): BtwThinkingLevel[] => {
    const overridden = options.availableThinkingLevels;
    const effectiveModel = configuredModel(settings) ?? currentModel;
    const available =
      overridden && overridden.length > 0
        ? overridden
        : effectiveModel
          ? getSupportedThinkingLevels(effectiveModel)
          : BTW_THINKING_LEVELS;
    return available.length > 0 ? [...available] : ["off"];
  };
  const currentMainThinkingLevel = (settings: BtwSettings): BtwThinkingLevel =>
    clampToAvailableThinkingLevel(options.currentThinkingLevel, thinkingLevels(settings));
  const displayThinkingLevel = (settings: BtwSettings): string =>
    settings.thinkingLevel === undefined
      ? SAME_AS_MAIN_THREAD
      : clampToAvailableThinkingLevel(settings.thinkingLevel, thinkingLevels(settings));
  const displayThinkingSummary = (settings: BtwSettings): string =>
    settings.thinkingLevel === undefined
      ? `${SAME_AS_MAIN_THREAD} (currently ${currentMainThinkingLevel(settings)})`
      : displayThinkingLevel(settings);
  const displayRememberSummary = (settings: BtwSettings): string => {
    const value = effectiveRememberThinkingLevelChanges(settings) ? "On" : "Off";
    return settings.thinkingLevel === undefined ? `${value} (fixed levels only)` : value;
  };
  const displayModelValue = (settings: BtwSettings): string => {
    if (!settings.model) {
      return currentModel ? `${SAME_AS_MAIN_THREAD} (${displayModelReference(currentModel)})` : SAME_AS_MAIN_THREAD;
    }
    const available = configuredModel(settings);
    if (!available) return `${SAME_AS_MAIN_THREAD} · ${safeModelMetadata(settings.model, "unknown model")} unavailable`;
    const reference = displayModelReference(available);
    return selectableConfiguredModel(settings) ? reference : `${reference} · outside current scope`;
  };
  const modelItems = (settings: BtwSettings) => {
    const configured = configuredModel(settings);
    const selectable = selectableConfiguredModel(settings);
    const retained = settings.model && !selectable;
    return [
      {
        id: "same-as-main",
        label: SAME_AS_MAIN_THREAD,
        description: currentModel
          ? `Currently ${displayModelReference(currentModel)}`
          : "Use the main thread model when /btw starts.",
      },
      ...selectableModels.map((model) => {
        const reference = displayModelReference(model);
        const name = safeModelMetadata(model.name ?? "", "");
        const validReference = rawModelReference(model);
        return {
          id: modelItemIds.get(model) as string,
          label: reference,
          ...(name ? { details: [`Model Name: ${name}`] } : {}),
          searchText: [reference, name].filter(Boolean).join(" "),
          ...(!validReference
            ? {
                disabled: true,
                disabledReason: "This model identity cannot be stored in pi-btw.json.",
              }
            : {}),
        };
      }),
      ...(retained
        ? [
            {
              id: "configured-model",
              label: configured
                ? displayModelReference(configured)
                : safeModelMetadata(settings.model as string, "unknown model"),
              ...(configured
                ? { description: "Configured outside the current model scope; retained until changed." }
                : {
                    disabled: true,
                    disabledReason: "Configured model is unavailable; /btw falls back to the main model.",
                  }),
            },
          ]
        : []),
    ];
  };
  const selectedModelItemId = (settings: BtwSettings): string => {
    const selected = selectableConfiguredModel(settings);
    return selected ? (modelItemIds.get(selected) as string) : settings.model ? "configured-model" : "same-as-main";
  };
  const currentModelItemId = (settings: BtwSettings): string =>
    settings.model && configuredModel(settings) ? selectedModelItemId(settings) : "same-as-main";

  const menu = defineMenu<BtwMenuState, BtwMenuScreen, BtwMenuAction, MenuContext>({
    start: "main",
    screens: {
      main: ({ state }) => ({
        kind: "actions",
        title: "Pi BTW",
        lines: [
          `Model: ${displayModelValue(state.settings)}`,
          `Thinking: ${displayThinkingSummary(state.settings)} · Remember changes: ${displayRememberSummary(state.settings)}`,
          `Layout: ${BTW_LAYOUT_LABELS[effectiveBtwLayout(state.settings)]} · Copy on select: ${effectiveFullscreenCopyOnSelect(state.settings) ? "On" : "Off"}`,
        ],
        items: [
          {
            id: "start",
            label: "Start side thread",
            description: "Open an empty side thread",
            action: "start",
          },
          {
            id: "start-tree",
            label: "Start from main thread tree…",
            description: "Choose context without switching the main branch",
            action: "start-tree",
          },
          ...(resumeThreads.length > 0
            ? [
                {
                  id: "resume" as const,
                  label: "Resume side thread",
                  description: "Continue an in-memory side thread",
                  to: "resume" as const,
                },
              ]
            : []),
          {
            id: "settings",
            label: "Settings",
            description: "Choose model, thinking, layout, keybindings, and selection copying",
            to: state.kind === "invalid" ? "invalid" : "settings",
          },
        ],
        hint: "close",
      }),
      resume: () => ({
        kind: "choice",
        title: "Resume BTW side thread",
        enableSearch: true,
        items: resumeThreads.map((thread) => ({
          id: thread.id,
          label: thread.title,
          description: `${thread.questionCount} ${thread.questionCount === 1 ? "question" : "questions"}`,
        })),
        action: "resume",
        viewportSize: 10,
        hint: "back",
      }),
      settings: ({ state }) => ({
        kind: "settings",
        title: "Pi BTW Settings",
        lines: [`User settings · ${displaySettingsPath}`],
        items: [
          {
            id: "model",
            label: "Model",
            description: "Choose the model for future pi-btw side threads without changing the main session.",
            currentValue: displayModelValue(state.settings),
            action: "open-model",
          },
          {
            id: "thinkingLevel",
            label: "Thinking level",
            description: `Set the starting level for future pi-btw side threads. Currently ${currentMainThinkingLevel(state.settings)}.`,
            currentValue: displayThinkingLevel(state.settings),
            values: [SAME_AS_MAIN_THREAD, ...thinkingLevels(state.settings)],
            action: "set-thinking",
          },
          {
            id: "rememberThinkingLevelChanges",
            label: "Remember thinking level changes",
            description: "Save shortcut changes for fixed thinking levels to pi-btw.json.",
            currentValue: effectiveRememberThinkingLevelChanges(state.settings) ? "On" : "Off",
            values: ["On", "Off"],
            action: "set-remember",
          },
          {
            id: "fullscreenCopyOnSelect",
            label: "Copy selection automatically",
            description: "Copy mouse selections immediately instead of with the configured copy key.",
            currentValue: effectiveFullscreenCopyOnSelect(state.settings) ? "On" : "Off",
            values: ["On", "Off"],
            action: "set-fullscreen-copy",
          },
          {
            id: "layout",
            label: "Side-thread layout",
            description: "Use the full workspace or place BTW beside the live, click-to-focus main thread.",
            currentValue: BTW_LAYOUT_LABELS[effectiveBtwLayout(state.settings)],
            values: BTW_LAYOUT_VALUES,
            action: "set-layout",
          },
          ...BTW_SHORTCUT_ACTIONS.map((action) => ({
            id: action,
            label: shortcutLabels[action],
            description: "Edit a BTW-only key combination or restore its default. Ctrl+C always hard-cancels.",
            currentValue: shortcutValue(state.settings, action),
            action: "edit-shortcut" as const,
          })),
        ],
      }),
      model: ({ state }) => ({
        kind: "choice",
        title: "Pi BTW Model",
        lines: [
          "Same as main thread is the default and fallback when a configured model is unavailable.",
          ...(state.settings.model && !selectableConfiguredModel(state.settings)
            ? [`Configured: ${displayModelValue(state.settings)}`]
            : []),
        ],
        items: modelItems(state.settings),
        action: "set-model",
        currentItemId: currentModelItemId(state.settings),
        initialItemId: selectedModelItemId(state.settings),
        enableSearch: true,
        viewportSize: 10,
        hint: "back",
      }),
      shortcut: ({ state }) => ({
        kind: "actions",
        title: shortcutLabels[shortcut],
        lines: [shortcutValue(state.settings, shortcut), "Ctrl+C always hard-cancels BTW."],
        items: [
          { id: "edit", label: "Edit key combination…", to: "shortcut-input" },
          { id: "reset", label: "Restore default", action: "reset-shortcut" },
        ],
        hint: "back",
      }),
      "shortcut-input": () => ({
        kind: "input",
        title: shortcutLabels[shortcut],
        lines: ["Type a key name, not the shortcut itself. For example: ctrl+q or f6."],
        placeholder: "Key combination",
        action: "save-shortcut",
        hint: "back",
      }),
      invalid: ({ state }) => ({
        kind: "detail",
        title: "Pi BTW Settings · Read only",
        lines: [
          `Invalid settings file. Fix ${displaySettingsPath} before saving.`,
          sanitizeSingleLine(state.reason ?? "The settings file is invalid."),
        ],
        hint: "back",
      }),
    },
    actions: {
      "edit-shortcut": ({ itemId }) => {
        if (!BTW_SHORTCUT_ACTIONS.includes(itemId as BtwShortcutAction)) return { kind: "rejected" };
        shortcut = itemId as BtwShortcutAction;
        return { kind: "to", screen: "shortcut" };
      },
      "save-shortcut": ({ state, value, signal }) => saveShortcut(state, value?.trim() ?? "", signal),
      "reset-shortcut": ({ state, signal }) => saveShortcut(state, undefined, signal),
      "open-model": async () => ({ kind: "to", screen: "model" }),
      "set-model": async ({ state, itemId, signal }) => {
        if (itemId === "configured-model" && configuredModel(state.settings)) {
          return { kind: "back" };
        }
        const model = itemId ? modelsByItemId.get(itemId) : undefined;
        if (itemId !== "same-as-main" && (!model || !rawModelReference(model))) return { kind: "rejected" };
        const result = await saveModel(model, signal);
        if (result.kind === "failed") {
          notifySaveFailure(ctx, result.error);
          return { kind: "rejected" };
        }
        if (result.kind === "cancelled" || signal.aborted) return { kind: "close" };
        notifySafely(
          ctx,
          model ? `Pi BTW model: ${displayModelReference(model)}.` : `Pi BTW model: ${SAME_AS_MAIN_THREAD}.`,
          "info",
        );
        return { kind: "back" };
      },
      start: async () => {
        startSelected = true;
        return { kind: "close" };
      },
      "start-tree": async () => {
        treeSelected = true;
        return { kind: "close" };
      },
      resume: async ({ itemId }: { itemId: string }) => {
        if (!resumeThreads.some((thread) => thread.id === itemId)) {
          return { kind: "rejected" } as const;
        }
        resumedThreadId = itemId;
        return { kind: "close" } as const;
      },
      "set-thinking": async ({ state, value, signal }) => {
        if (!value) return { kind: "rejected" };
        const levels = thinkingLevels(state.settings);
        const patch =
          value === SAME_AS_MAIN_THREAD
            ? ({ thinkingLevel: undefined } satisfies BtwSettingsPatch)
            : levels.includes(value as BtwThinkingLevel)
              ? ({ thinkingLevel: value as BtwThinkingLevel } satisfies BtwSettingsPatch)
              : undefined;
        if (!patch) return { kind: "rejected" };
        try {
          await updateSettings(patch, { settingsPath, signal });
          if (signal.aborted) return { kind: "rejected" };
          notifySafely(ctx, `Pi BTW thinking level: ${value}.`, "info");
          return { kind: "stay" };
        } catch (error) {
          if (!signal.aborted) notifySaveFailure(ctx, error);
          return { kind: "rejected" };
        }
      },
      "set-remember": async ({ value, signal }) => {
        if (value !== "On" && value !== "Off") return { kind: "rejected" };
        try {
          await updateSettings({ rememberThinkingLevelChanges: value === "On" }, { settingsPath, signal });
          if (signal.aborted) return { kind: "rejected" };
          notifySafely(ctx, `Remember thinking level changes: ${value}.`, "info");
          return { kind: "stay" };
        } catch (error) {
          if (!signal.aborted) notifySaveFailure(ctx, error);
          return { kind: "rejected" };
        }
      },
      "set-fullscreen-copy": async ({ value, signal }) => {
        if (value !== "On" && value !== "Off") return { kind: "rejected" };
        try {
          await updateSettings({ fullscreenCopyOnSelect: value === "On" }, { settingsPath, signal });
          if (signal.aborted) return { kind: "rejected" };
          notifySafely(ctx, `Copy selection automatically: ${value}.`, "info");
          return { kind: "stay" };
        } catch (error) {
          if (!signal.aborted) notifySaveFailure(ctx, error);
          return { kind: "rejected" };
        }
      },
      "set-layout": async ({ value, signal }) => {
        const layout = Object.entries(BTW_LAYOUT_LABELS).find(([, label]) => label === value)?.[0] as
          | BtwLayout
          | undefined;
        if (!layout) return { kind: "rejected" };
        try {
          await updateSettings({ layout }, { settingsPath, signal });
          if (signal.aborted) return { kind: "rejected" };
          notifySafely(ctx, `Pi BTW layout: ${BTW_LAYOUT_LABELS[layout]}. Applies when BTW next opens.`, "info");
          return { kind: "stay" };
        } catch (error) {
          if (!signal.aborted) notifySaveFailure(ctx, error);
          return { kind: "rejected" };
        }
      },
    },
  });

  const result = await runBtwMenuPreservingEditor(
    ctx,
    (menuContext) => runMenu(menuContext, menu, { getState: loadState }),
    (manager) => {
      keybindings = manager;
    },
  );
  if (result.kind !== "closed" || result.reason !== "close") return "closed";
  if (resumedThreadId) return { kind: "resume", threadId: resumedThreadId };
  if (treeSelected) return "tree";
  return startSelected ? "start" : "closed";
}

export async function showBtwCustomPreservingEditor<T>(
  ctx: ExtensionCommandContext,
  factory: BtwCustomFactory<T>,
): Promise<T | undefined> {
  let liveEditorText = ctx.ui.getEditorText();
  let completed = false;
  const result = await ctx.ui.custom<T>((tui, theme, keybindings, done) =>
    factory(tui, theme, keybindings, (value) => {
      try {
        liveEditorText = ctx.ui.getEditorText();
      } catch {
        // Keep completion finite if session replacement invalidates the editor context.
      }
      completed = true;
      done(value);
    }),
  );
  if (completed) {
    try {
      if (ctx.ui.getEditorText() !== liveEditorText) ctx.ui.setEditorText(liveEditorText);
    } catch {
      // A replaced context owns a different editor and must not receive stale restoration.
    }
  }
  return result;
}

export async function runBtwMenuPreservingEditor(
  ctx: ExtensionCommandContext,
  run: (menuContext: MenuContext) => Promise<RunMenuResult>,
  onKeybindings?: (keybindings: KeybindingsManager) => void,
): Promise<RunMenuResult> {
  let liveEditorText = ctx.ui.getEditorText();
  let completed = false;
  const ui = new Proxy(ctx.ui, {
    get(target, property) {
      if (property === "custom") {
        return <Value>(factory: BtwCustomFactory<Value>, customOptions?: BtwCustomOptions) =>
          target.custom<Value>((tui, theme, keybindings, done) => {
            onKeybindings?.(keybindings);
            return factory(tui, theme, keybindings, (value) => {
              try {
                liveEditorText = target.getEditorText();
              } catch {
                // Keep completion finite if session replacement invalidates the editor context.
              }
              completed = true;
              done(value);
            });
          }, customOptions);
      }
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const result = await run({ mode: ctx.mode, hasUI: ctx.hasUI, ui });
  if (result.kind !== "stale" && completed) {
    try {
      if (ctx.ui.getEditorText() !== liveEditorText) ctx.ui.setEditorText(liveEditorText);
    } catch {
      // A replaced context owns a different editor and must not receive stale restoration.
    }
  }
  return result;
}

function deduplicateModels(models: readonly Model<Api>[]): Model<Api>[] {
  return models.filter((model, index) => models.findIndex((candidate) => sameModel(candidate, model)) === index);
}

function availableModelsInScope(
  availableModels: readonly Model<Api>[],
  scopedModels: ExtensionCommandContext["scopedModels"],
): Model<Api>[] {
  if (scopedModels.length === 0) return [...availableModels];
  return deduplicateModels(
    scopedModels.flatMap((entry) => {
      const available = availableModels.find((model) => sameModel(model, entry.model));
      return available ? [available] : [];
    }),
  );
}

function sameModel(left: Pick<Model<Api>, "provider" | "id">, right: Pick<Model<Api>, "provider" | "id">): boolean {
  return left.provider === right.provider && left.id === right.id;
}

function clampToAvailableThinkingLevel(
  requested: BtwThinkingLevel,
  available: readonly BtwThinkingLevel[],
): BtwThinkingLevel {
  if (available.includes(requested)) return requested;
  const requestedIndex = BTW_THINKING_LEVELS.indexOf(requested);
  for (let index = requestedIndex; index < BTW_THINKING_LEVELS.length; index += 1) {
    const candidate = BTW_THINKING_LEVELS[index];
    if (candidate && available.includes(candidate)) return candidate;
  }
  for (let index = requestedIndex - 1; index >= 0; index -= 1) {
    const candidate = BTW_THINKING_LEVELS[index];
    if (candidate && available.includes(candidate)) return candidate;
  }
  return available[0] ?? "off";
}

function notifySaveFailure(ctx: ExtensionCommandContext, error: unknown): void {
  notifySafely(
    ctx,
    `Pi BTW settings were not saved; the previous value remains active: ${formatError(error)}`,
    "error",
  );
}

function notifySafely(
  ctx: ExtensionCommandContext,
  message: string,
  level: Parameters<ExtensionCommandContext["ui"]["notify"]>[1],
): void {
  try {
    ctx.ui.notify(sanitizeSingleLine(message), level);
  } catch {
    // A completed save remains valid if its command context was replaced before notification.
  }
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
