import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { isKeyRelease, Key, matchesKey } from "@earendil-works/pi-tui";
import { defineMenu, runMenu } from "@narumitw/pi-tui-kit";
import {
  type CommitExpectation,
  type CommitOptions,
  captureCommitExpectation,
  commitActiveDocument,
  commitOwnerCurrent,
} from "./command-commit.js";
import {
  type ConfigurationCommandOptions,
  configurationPresentation,
  reloadConfiguration,
  type WorkflowOwner,
} from "./command-configuration.js";
import { completeStarshipArguments, STARSHIP_SUBCOMMANDS } from "./command-contract.js";
import { importSettingsGist, shareSettingsGist } from "./command-gist.js";
import { showPresetPicker } from "./command-preset-picker.js";
import { type PreviewMenuResult, showPreviewActionMenu } from "./command-preview.js";
import { saveAsProfile, showHistory, showProfiles } from "./command-profiles.js";
import { BUILT_IN_EXAMPLE, type LoadedStarshipConfig, nativeFooterConfig, validateConfigDocument } from "./config.js";
import type { GhApi } from "./gist.js";
import type { StatuslineInspection } from "./modules/inspection.js";
import { getStarshipPreset, presetForDocument, STARSHIP_PRESETS, type StarshipPreset } from "./presets/catalog.js";

const MAIN_ACTIONS = {
  presets: "presets",
  configuration: "configuration",
  help: "help",
  restore: "restore",
  profiles: "profiles",
  chat: "settings-chat",
} as const;

const PREVIEW_ACTIONS = {
  continue: "continue",
  edit: "edit",
  cancel: "cancel",
  saveProfile: "save-profile",
} as const;

export interface StarshipCommandOptions extends ConfigurationCommandOptions, CommitOptions {
  getInspection?(): StatuslineInspection | undefined;
  preview?(loaded: LoadedStarshipConfig | undefined, ctx: ExtensionCommandContext): void;
  save?: (settingsPath: string, rawDocument: string) => LoadedStarshipConfig;
  restore?: (settingsPath: string, rawDocument: string) => void;
  validate?: (settingsPath: string, rawDocument: string) => LoadedStarshipConfig;
  getMenuOwner?(): WorkflowOwner;
  gistApi?: GhApi;
  registerChatCleanup?(cleanup: () => Promise<void>): () => void;
}

export type ReviewIntent =
  | { kind: "customize" }
  | { kind: "restore" }
  | { kind: "import" }
  | { kind: "profile"; name: string }
  | { kind: "history"; name?: string }
  | { kind: "preset"; preset: StarshipPreset };

export function registerStarshipCommand(pi: ExtensionAPI, options: StarshipCommandOptions) {
  pi.registerCommand("starship", {
    description: "Configure the footer with agent, presets, profiles, and recovery",
    getArgumentCompletions: completeStarshipArguments,
    handler: (args, ctx) => handleStarshipCommand(args, ctx, options),
  });
}

export async function handleStarshipCommand(
  args: string,
  ctx: ExtensionCommandContext,
  options: StarshipCommandOptions,
) {
  if (ctx.mode !== "tui") return runStarshipCommand(args, ctx, options);
  const base = workflowOwner(options);
  if (!isCurrentOwner(base)) return;
  const controller = new AbortController();
  const signal = AbortSignal.any([base.signal, controller.signal]);
  const owner: WorkflowOwner = {
    signal,
    isCurrent: () => !signal.aborted && base.isCurrent(),
    isSessionCurrent: () => base.isSessionCurrent?.() ?? base.isCurrent(),
    canRestoreTerminal: base.canRestoreTerminal,
  };
  // Pi delivers bracketed paste as one framed packet. Exact key matching does
  // not treat controls inside pasted text as cancellation or consume native input.
  const unsubscribe = ctx.ui.onTerminalInput((data) => {
    if (!isKeyRelease(data) && matchesKey(data, Key.ctrl("c"))) {
      // Let the current native dialog receive this input before abort restores
      // focus; otherwise the same key can reach the underlying editor.
      queueMicrotask(() => controller.abort());
    }
    return undefined;
  });
  let listening = true;
  const release = () => {
    if (!listening) return;
    listening = false;
    unsubscribe();
  };
  signal.addEventListener("abort", release, { once: true });
  try {
    return await runStarshipCommand(args, ctx, { ...options, getMenuOwner: () => owner });
  } finally {
    signal.removeEventListener("abort", release);
    release();
    controller.abort();
  }
}

async function runStarshipCommand(args: string, ctx: ExtensionCommandContext, options: StarshipCommandOptions) {
  const normalized = args.trim();
  if (!normalized) {
    if (ctx.mode === "tui") await showMainMenu(ctx, options);
    else showHelp(ctx, options.settingsPath);
    return;
  }

  const [subcommand = "", ...trailing] = normalized.split(/\s+/u);
  const route = subcommand.toLowerCase();
  if (trailing.length > 0 || !STARSHIP_SUBCOMMANDS.some((item) => item.value === route)) {
    if (canNotify(ctx)) {
      const reason =
        trailing.length > 0
          ? `Unexpected arguments for /starship ${safeText(route)}.`
          : `Unknown /starship subcommand: ${safeText(route)}.`;
      ctx.ui.notify(`${reason} Usage: /starship [settings|status|help]`, "warning");
    }
    return;
  }
  switch (route) {
    case "settings":
      await editSettings(ctx, options);
      return;
    case "status":
      showStatus(ctx, options);
      return;
    case "help":
      showHelp(ctx, options.settingsPath);
      return;
  }
}

async function showMainMenu(ctx: ExtensionCommandContext, options: StarshipCommandOptions) {
  const fallbackController = new AbortController();
  const owner = options.getMenuOwner?.() ?? {
    signal: fallbackController.signal,
    isCurrent: () => !fallbackController.signal.aborted,
  };
  type Screen = "main" | "help";
  type Action =
    | "configuration"
    | "presets"
    | "profiles"
    | "history"
    | "configuration-reload"
    | "restore"
    | "gist-share"
    | "gist-import"
    | "settings-chat";
  const menu = defineMenu<undefined, Screen, Action, ExtensionCommandContext>({
    start: "main",
    screens: {
      main: () => {
        const loaded = options.getLoaded();
        const presentation = configurationPresentation(loaded);
        return {
          kind: "actions",
          title: "pi-starship",
          lines: [
            `${presentation.state} · ${presentation.health}`,
            "Configure with agent for edits, module questions, and footer explanations.",
          ],
          items: [
            {
              id: MAIN_ACTIONS.chat,
              label: "Configure with agent",
              description: "Separate conversation · draft tools · live preview only until you save",
              action: "settings-chat",
            },
            {
              id: MAIN_ACTIONS.presets,
              label: "Presets",
              description: "Browse and live-preview bundled footer starting points",
              action: "presets",
            },
            {
              id: MAIN_ACTIONS.profiles,
              label: "Profiles",
              description: "Save, edit, manage, and live-preview named TOML documents",
              action: "profiles",
            },
            {
              id: MAIN_ACTIONS.configuration,
              label: "Configuration",
              description: presentation.health,
              action: "configuration",
            },
            {
              id: MAIN_ACTIONS.restore,
              label: "Restore built-in…",
              description: presentation.restoreDescription,
              disabled: presentation.restoreDisabled,
              action: "restore",
            },
            {
              id: MAIN_ACTIONS.help,
              label: "Help",
              description: "Settings, modules, and commands",
              to: "help",
            },
          ],
          hint: "close",
        };
      },
      help: () => ({
        kind: "detail",
        title: "pi-starship help",
        lines: [
          "/starship settings retains the TOML editor with preview and confirmation.",
          "Configure with agent opens a separate skill-backed chat; edits preview only until you explicitly save.",
          "Presets live-previews the cursor in the footer; Enter confirms apply, e customizes, and s saves a profile when available.",
          "Profiles manages named TOML copies; selecting a document previews it without saving.",
          "Configuration History reviews and restores recovery copies; external edits are not fully tracked.",
          "Ask Configure with agent about active settings and module states captured when the chat opens.",
          "Configuration includes disk reload plus unlisted Gist sharing and reviewed Gist import through gh.",
          `Settings: ${safeText(options.settingsPath)}`,
          "Docs: https://github.com/narumiruna/pi-extensions/tree/main/packages/pi-starship",
        ],
        hint: "back",
      }),
    },
    actions: {
      "settings-chat": async () => {
        const { showSettingsAgentChat } = await import("./command-settings-chat.js");
        if (!isCurrentOwner(owner)) return { kind: "close" };
        await showSettingsAgentChat(ctx, options, owner);
        return { kind: "close" };
      },
      configuration: async () => {
        const { showConfigurationMenu } = await import("./command-configuration-menu.js");
        if (!isCurrentOwner(owner)) return { kind: "close" };
        let selected: string | undefined;
        while (isCurrentOwner(owner)) {
          const result = await showConfigurationMenu(ctx, options, owner, selected);
          if (!isCurrentOwner(owner) || result.kind !== "completed") return { kind: "close" };
          if (result.value === "back") return { kind: "stay" };
          if (result.value === "close") return { kind: "close" };
          selected = result.value;
          const transition = await menu.actions[result.value]({
            ctx,
            state: undefined,
            signal: owner.signal,
            itemId: result.value,
          });
          if (!isCurrentOwner(owner) || transition?.kind === "close") return { kind: "close" };
        }
        return { kind: "close" };
      },
      presets: async () => {
        const result = await choosePreset(ctx, options, owner);
        return result === "applied" || result === "close" ? { kind: "close" } : { kind: "stay" };
      },
      profiles: async () => {
        const result = await showProfiles(ctx, options, owner, async (loaded, guardedOwner, checkCandidate, name) => {
          const applied = await reviewAndApply(
            ctx,
            options,
            loaded,
            { kind: "profile", name },
            guardedOwner,
            false,
            checkCandidate,
          );
          return applied === "applied" ? "applied" : applied === "close" ? "close" : "stay";
        });
        return result === "close" ? { kind: "close" } : { kind: "stay" };
      },
      history: async () => {
        const result = await showHistory(ctx, options, owner, async (loaded, guardedOwner, checkCandidate, name) => {
          const applied = await reviewAndApply(
            ctx,
            options,
            loaded,
            { kind: "history", name },
            guardedOwner,
            false,
            checkCandidate,
          );
          return applied === "applied" ? "applied" : applied === "close" ? "close" : "stay";
        });
        return result === "close" ? { kind: "close" } : { kind: "stay" };
      },
      "gist-share": async () => {
        const result = await shareSettingsGist(ctx, options, owner, options.gistApi);
        return result === "close" ? { kind: "close" } : { kind: "stay" };
      },
      "gist-import": async () => {
        const result = await importSettingsGist(
          ctx,
          options,
          owner,
          async (loaded, guardedOptions, guardedOwner) => {
            const applied = await reviewAndApply(ctx, guardedOptions, loaded, { kind: "import" }, guardedOwner);
            return applied === "edit" ? "cancel" : applied;
          },
          options.gistApi,
        );
        return result === "applied" || result === "close" ? { kind: "close" } : { kind: "stay" };
      },
      "configuration-reload": async () => {
        const result = await reloadConfiguration(ctx, options, owner);
        return result === "close" ? { kind: "close" } : { kind: "stay" };
      },
      restore: async () => {
        const presentation = configurationPresentation(options.getLoaded());
        if (presentation.restoreDisabled) {
          ctx.ui.notify(presentation.restoreDescription, "info");
          return { kind: "stay" };
        }
        const result = await restoreBuiltIn(ctx, options);
        return result === "applied" || result === "close" ? { kind: "close" } : { kind: "stay" };
      },
    },
  });
  try {
    await runMenu(ctx, menu, {
      getState: () => undefined,
      signal: owner.signal,
      isCurrent: owner.isCurrent,
    });
  } finally {
    fallbackController.abort(new DOMException("Starship menu closed", "AbortError"));
  }
}

async function editSettings(
  ctx: ExtensionCommandContext,
  options: StarshipCommandOptions,
): Promise<"applied" | "cancel" | "close"> {
  const owner = workflowOwner(options);
  if (!isCurrentOwner(owner)) return "cancel";
  if (ctx.mode !== "tui") {
    if (ctx.hasUI) ctx.ui.notify(`Edit settings manually: ${options.settingsPath}`, "info");
    return "cancel";
  }
  const expected = captureExpectation(ctx, options);
  if (!expected) return "cancel";
  let draft = expected.previous.rawDocument ?? BUILT_IN_EXAMPLE;
  while (true) {
    const edited = await ctx.ui.editor("Customize footer — close to preview", draft);
    if (!commitOwnerCurrent(options, owner, expected) || edited === undefined) return "cancel";
    draft = edited;
    let validated: LoadedStarshipConfig;
    try {
      validated = (options.validate ?? validateConfigDocument)(options.settingsPath, draft);
    } catch (error) {
      ctx.ui.notify(`Footer draft is invalid: ${safeText(formatError(error))}`, "error");
      const action = await showPreviewActionMenu(
        ctx,
        "Configuration needs attention",
        () => [safeText(formatError(error)), "The current footer has not changed."],
        [
          { value: PREVIEW_ACTIONS.edit, label: "Continue editing" },
          { value: PREVIEW_ACTIONS.cancel, label: "Discard draft" },
        ],
        owner.signal,
        owner.isCurrent,
      );
      if (!commitOwnerCurrent(options, owner, expected)) return "cancel";
      if (action?.kind === "closed") return "close";
      if (selectedPreviewAction(action) === PREVIEW_ACTIONS.edit) continue;
      return "cancel";
    }

    const result = await reviewAndApply(
      ctx,
      options,
      validated,
      { kind: "customize" },
      owner,
      false,
      undefined,
      expected,
    );
    if (result === "edit") continue;
    return result;
  }
}

async function choosePreset(
  ctx: ExtensionCommandContext,
  options: StarshipCommandOptions,
  owner: WorkflowOwner,
): Promise<"applied" | "cancel" | "close"> {
  const expected = captureExpectation(ctx, options);
  if (!expected) return "cancel";
  const activePreset = presetForDocument(expected.previous.rawDocument);
  const selection = await showPresetPicker(ctx, {
    presets: STARSHIP_PRESETS,
    activePresetId: activePreset?.id,
    initialPresetId: activePreset?.id ?? STARSHIP_PRESETS[0]?.id,
    signal: owner.signal,
    isCurrent: owner.isCurrent,
    preview(preset) {
      const loaded = (options.validate ?? validateConfigDocument)(options.settingsPath, preset.rawDocument);
      options.preview?.(loaded, ctx);
    },
  });
  if (!commitOwnerCurrent(options, owner, expected)) {
    clearSessionPreview(ctx, options, owner);
    return "cancel";
  }
  if (selection.kind === "back" || selection.kind === "close") {
    clearSessionPreview(ctx, options, owner);
    return selection.kind === "close" ? "close" : "cancel";
  }

  const preset = getStarshipPreset(selection.presetId);
  try {
    if (selection.kind === "save-profile") {
      const saved = await saveAsProfile(ctx, options, owner, preset.rawDocument);
      return saved === "close" ? "close" : "cancel";
    }
    return await applyPreset(
      ctx,
      options,
      preset,
      selection.kind === "customize" ? "customize" : "confirm",
      expected,
      owner,
    );
  } finally {
    clearSessionPreview(ctx, options, owner);
  }
}

async function applyPreset(
  ctx: ExtensionCommandContext,
  options: StarshipCommandOptions,
  preset: StarshipPreset,
  start: "review" | "confirm" | "customize" = "review",
  captured?: CommitExpectation,
  capturedOwner?: WorkflowOwner,
): Promise<"applied" | "cancel" | "close"> {
  const owner = capturedOwner ?? workflowOwner(options);
  if (!isCurrentOwner(owner)) return "cancel";
  const expected = captured ?? captureExpectation(ctx, options);
  if (!expected) return "cancel";
  let draft = preset.rawDocument;
  if (start === "customize") {
    const edited = await ctx.ui.editor(`Customize ${preset.label} preset`, draft);
    if (!commitOwnerCurrent(options, owner, expected) || edited === undefined) return "cancel";
    draft = edited;
  }
  while (true) {
    let validated: LoadedStarshipConfig;
    try {
      validated = (options.validate ?? validateConfigDocument)(options.settingsPath, draft);
    } catch (error) {
      ctx.ui.notify(`Preset draft is invalid: ${safeText(formatError(error))}`, "error");
      const action = await showPreviewActionMenu(
        ctx,
        "Preset needs attention",
        () => [safeText(formatError(error)), "The current footer has not changed."],
        [
          { value: PREVIEW_ACTIONS.edit, label: "Continue editing" },
          { value: PREVIEW_ACTIONS.cancel, label: "Choose another preset" },
        ],
        owner.signal,
        owner.isCurrent,
      );
      if (!commitOwnerCurrent(options, owner, expected)) return "cancel";
      if (action?.kind === "closed") return "close";
      if (selectedPreviewAction(action) !== PREVIEW_ACTIONS.edit) return "cancel";
      const edited = await ctx.ui.editor(`Customize ${preset.label} preset`, draft);
      if (!commitOwnerCurrent(options, owner, expected) || edited === undefined) return "cancel";
      draft = edited;
      continue;
    }

    const result = await reviewAndApply(
      ctx,
      options,
      validated,
      { kind: "preset", preset },
      owner,
      start === "confirm",
      undefined,
      expected,
    );
    if (result !== "edit") return result;
    const edited = await ctx.ui.editor(`Customize ${preset.label} preset`, draft);
    if (!commitOwnerCurrent(options, owner, expected) || edited === undefined) return "cancel";
    draft = edited;
  }
}

async function restoreBuiltIn(
  ctx: ExtensionCommandContext,
  options: StarshipCommandOptions,
): Promise<"applied" | "cancel" | "close"> {
  const owner = workflowOwner(options);
  if (!isCurrentOwner(owner)) return "cancel";
  const candidate = nativeFooterConfig(options.settingsPath);
  const result = await reviewAndApply(ctx, options, candidate, { kind: "restore" }, owner);
  return result === "edit" ? "cancel" : result;
}

export async function reviewAndApply(
  ctx: ExtensionCommandContext,
  options: StarshipCommandOptions,
  validated: LoadedStarshipConfig,
  intent: ReviewIntent,
  owner: WorkflowOwner,
  skipReview = false,
  checkCandidate?: () => void,
  captured?: CommitExpectation,
): Promise<"applied" | "edit" | "cancel" | "close"> {
  if (ctx.mode !== "tui" || !isCurrentOwner(owner)) return "cancel";
  const expected = captured ?? captureExpectation(ctx, options);
  if (!expected) return "cancel";
  let reviewRequired = !skipReview;
  while (true) {
    const directAttempt = !reviewRequired;
    if (reviewRequired) {
      const selection = await showPreviewActionMenu(
        ctx,
        reviewTitle(intent),
        (width) => reviewPreviewBody(ctx, options, validated, width, intent),
        [
          { value: PREVIEW_ACTIONS.continue, label: continueLabel(intent) },
          ...(intent.kind !== "customize" && intent.kind !== "preset"
            ? []
            : [
                {
                  value: PREVIEW_ACTIONS.edit,
                  label: intent.kind === "preset" ? "Customize before applying" : "Continue editing",
                },
              ]),
          {
            value: PREVIEW_ACTIONS.cancel,
            label:
              intent.kind === "restore"
                ? "Cancel"
                : intent.kind === "preset"
                  ? "Choose another preset"
                  : "Discard draft",
          },
          ...(intent.kind === "customize" || intent.kind === "preset" || intent.kind === "import"
            ? [{ value: PREVIEW_ACTIONS.saveProfile, label: "Save as profile…" }]
            : []),
        ],
        owner.signal,
        owner.isCurrent,
      );
      if (!commitOwnerCurrent(options, owner, expected)) return "cancel";
      if (selection?.kind === "closed") return "close";
      const selected = selectedPreviewAction(selection);
      if (selected === PREVIEW_ACTIONS.edit) return "edit";
      if (selected === PREVIEW_ACTIONS.saveProfile) {
        const saved = await saveAsProfile(ctx, options, owner, validated.rawDocument ?? BUILT_IN_EXAMPLE);
        if (saved === "close") return "close";
        if (!commitOwnerCurrent(options, owner, expected)) return "cancel";
        continue;
      }
      if (selected !== PREVIEW_ACTIONS.continue) return "cancel";
    }
    reviewRequired = true;

    const confirmed = await ctx.ui.confirm(
      confirmationTitle(intent),
      confirmationMessage(options.settingsPath, intent, expected.previous),
      { signal: owner.signal },
    );
    if (!commitOwnerCurrent(options, owner, expected)) return "cancel";
    if (!confirmed) {
      if (directAttempt) return "cancel";
      continue;
    }

    try {
      const result = await commitActiveDocument(
        ctx,
        options,
        validated,
        owner,
        expected,
        intent.kind === "restore" || intent.kind === "history" || intent.kind === "customize",
        checkCandidate,
        intent.kind === "restore",
      );
      if (!isSessionOwnerCurrent(owner) || result === "cancel") return "cancel";
    } catch (error) {
      if (!isSessionOwnerCurrent(owner)) return "cancel";
      ctx.ui.notify(safeText(formatError(error)), "error");
      if (directAttempt) return "cancel";
      continue;
    }

    const warningSuffix =
      validated.diagnostics.length > 0
        ? ` (${validated.diagnostics.length} warning${validated.diagnostics.length === 1 ? "" : "s"})`
        : "";
    ctx.ui.notify(`${successMessage(intent)}${warningSuffix}.`, "info");
    return "applied";
  }
}

function reviewTitle(intent: ReviewIntent): string {
  switch (intent.kind) {
    case "customize":
      return "Footer preview";
    case "restore":
      return "Restore preview";
    case "import":
      return "Gist footer preview";
    case "profile":
      return `${safeText(intent.name)} profile preview`;
    case "history":
      return "History recovery preview";
    case "preset":
      return `${intent.preset.label} preset preview`;
  }
}

function continueLabel(intent: ReviewIntent): string {
  switch (intent.kind) {
    case "customize":
      return "Apply changes…";
    case "restore":
      return "Restore Pi native footer…";
    case "import":
      return "Replace with Gist settings…";
    case "profile":
      return `Apply ${safeText(intent.name)} profile…`;
    case "history":
      return "Restore history document…";
    case "preset":
      return `Apply ${intent.preset.label} preset…`;
  }
}

function confirmationTitle(intent: ReviewIntent): string {
  switch (intent.kind) {
    case "customize":
      return "Apply footer changes?";
    case "restore":
      return "Restore Pi native footer?";
    case "import":
      return "Replace settings with Gist?";
    case "profile":
      return `Apply ${safeText(intent.name)} profile?`;
    case "history":
      return "Restore settings from history?";
    case "preset":
      return `Apply ${intent.preset.label} preset?`;
  }
}

function confirmationMessage(settingsPath: string, intent: ReviewIntent, previous: LoadedStarshipConfig): string {
  if (intent.kind === "restore")
    return `Remove ${safeText(settingsPath)} and show Pi's native footer? The exact previous document, including invalid settings, unknown fields, and comments, will be kept in History.`;
  if (previous.diagnostics.some((item) => item.severity === "error")) {
    return `Explicit recovery: replace the invalid settings file ${safeText(settingsPath)} entirely with the reviewed document? Its exact original bytes will be kept in History before replacement.`;
  }
  if (intent.kind === "customize")
    return "Replace the entire settings document and apply it immediately? Its previous bytes will be kept in History.";
  const replacement =
    intent.kind === "import"
      ? "the reviewed Gist settings"
      : intent.kind === "profile"
        ? `the ${safeText(intent.name)} profile`
        : intent.kind === "history"
          ? "the reviewed history document"
          : `the ${intent.preset.label} preset`;
  return `Replace ${safeText(settingsPath)} entirely with ${replacement}? All custom settings, unknown fields, and comments will be replaced. The previous document will be kept in History.`;
}

function successMessage(intent: ReviewIntent): string {
  switch (intent.kind) {
    case "customize":
      return "Footer settings saved and applied";
    case "restore":
      return "Pi native footer restored and applied";
    case "import":
      return "Gist settings saved and applied";
    case "profile":
      return `${safeText(intent.name)} profile applied`;
    case "history":
      return "History document restored and applied";
    case "preset":
      return `${intent.preset.label} preset saved and applied`;
  }
}

function workflowOwner(options: StarshipCommandOptions): WorkflowOwner {
  if (options.getMenuOwner) return options.getMenuOwner();
  const controller = new AbortController();
  return { signal: controller.signal, isCurrent: () => true };
}

function isCurrentOwner(owner: WorkflowOwner): boolean {
  return !owner.signal.aborted && owner.isCurrent();
}

function isSessionOwnerCurrent(owner: WorkflowOwner): boolean {
  return !owner.signal.aborted && (owner.isSessionCurrent?.() ?? owner.isCurrent());
}

function clearSessionPreview(ctx: ExtensionCommandContext, options: StarshipCommandOptions, owner: WorkflowOwner) {
  if (owner.isSessionCurrent?.() ?? owner.isCurrent()) options.preview?.(undefined, ctx);
}

function captureExpectation(
  ctx: ExtensionCommandContext,
  options: StarshipCommandOptions,
): CommitExpectation | undefined {
  try {
    return captureCommitExpectation(options);
  } catch (error) {
    ctx.ui.notify(`Footer settings were not saved: ${safeText(formatError(error))}`, "error");
    return undefined;
  }
}

function reviewPreviewBody(
  ctx: ExtensionCommandContext,
  options: StarshipCommandOptions,
  loaded: LoadedStarshipConfig,
  width: number,
  intent: ReviewIntent,
): string[] {
  if (intent.kind === "restore") return restorePreviewBody(options);
  if (intent.kind !== "preset") return previewBody(ctx, options, loaded, width);
  const current = configurationPresentation(options.getLoaded());
  return [
    `Preset: ${intent.preset.label}`,
    `Requirement: ${intent.preset.requiresNerdFont ? "Nerd Font" : "No special font"}`,
    `Current: ${current.state}`,
    `Path: ${safeText(options.settingsPath)}`,
    "Applying replaces the entire settings document, including custom settings, unknown fields, and comments.",
    "The previous document will be kept in History before replacement.",
    "",
    ...previewBody(ctx, options, loaded, width),
  ];
}

function restorePreviewBody(options: StarshipCommandOptions): string[] {
  const current = configurationPresentation(options.getLoaded());
  return [
    `Current: ${current.state}`,
    `Path: ${safeText(options.settingsPath)}`,
    "The entire settings document will be removed, including custom settings, unknown fields, and comments.",
    "The previous document will be kept in History before removal.",
    "Pi's native footer will be shown instead of the pi-starship footer.",
    "No replacement settings file will be created.",
  ];
}

function previewBody(
  ctx: ExtensionCommandContext,
  options: StarshipCommandOptions,
  loaded: LoadedStarshipConfig,
  width: number,
): string[] {
  let lines: string[];
  try {
    lines = options.renderPreview?.(loaded, width, ctx) ?? [
      "Live preview is unavailable until the footer is ready.",
      "The draft is valid and can still be applied.",
    ];
  } catch (error) {
    lines = [`Preview unavailable: ${safeText(formatError(error))}`];
  }
  const warning =
    loaded.diagnostics.length === 0
      ? "Draft validation: Healthy"
      : `Draft validation: ${loaded.diagnostics.length} warning${loaded.diagnostics.length === 1 ? "" : "s"}`;
  return [...lines, "", warning];
}

function selectedPreviewAction<Value extends string>(result: PreviewMenuResult<Value> | undefined): Value | null {
  return result?.kind === "selected" ? result.value : null;
}

function showStatus(ctx: ExtensionCommandContext, options: StarshipCommandOptions) {
  if (!canNotify(ctx)) return;
  const loaded = options.getLoaded();
  const diagnostics = loaded.diagnostics
    .slice(0, 5)
    .map((item) => `${safeText(item.path || "root")}: ${safeText(item.message)}`)
    .join("; ");
  ctx.ui.notify(
    [
      `pi-starship source: ${loaded.source}`,
      `path: ${options.settingsPath}`,
      diagnostics ? `warnings: ${diagnostics}` : "warnings: none",
    ].join("\n"),
    loaded.diagnostics.length > 0 ? "warning" : "info",
  );
}

function showHelp(ctx: ExtensionCommandContext, settingsPath: string) {
  if (!canNotify(ctx)) return;
  ctx.ui.notify(
    [
      "/starship — configure with agent, manage profiles, preview presets, or recover settings in TUI mode",
      "/starship settings — customize, preview, and apply TOML",
      "/starship status — show source, path, and warnings",
      "/starship help — show this help",
      `Settings: ${settingsPath}`,
      "Format/module docs: https://github.com/narumiruna/pi-extensions/tree/main/packages/pi-starship",
    ].join("\n"),
    "info",
  );
}

function canNotify(ctx: ExtensionCommandContext): boolean {
  return ctx.mode === "tui" || ctx.hasUI;
}

function safeText(value: string): string {
  return Array.from(value, (character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    const unsafe =
      codePoint <= 0x08 || (codePoint >= 0x0b && codePoint <= 0x1f) || (codePoint >= 0x7f && codePoint <= 0x9f);
    return unsafe ? `\\u${codePoint.toString(16).padStart(4, "0")}` : character;
  }).join("");
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
