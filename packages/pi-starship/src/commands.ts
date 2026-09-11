import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { defineMenu, runMenu } from "@narumitw/pi-tui-kit";
import {
  type ConfigurationCommandOptions,
  configurationMenuScreen,
  configurationOverviewScreen,
  configurationPresentation,
  effectiveConfigurationScreen,
  reloadConfiguration,
  settingsDocumentScreen,
  type WorkflowOwner,
} from "./command-configuration.js";
import { completeStarshipArguments, STARSHIP_SUBCOMMANDS } from "./command-contract.js";
import { formatFooterExplanation } from "./command-inspector.js";
import { showPresetPicker } from "./command-preset-picker.js";
import { type PreviewMenuResult, showPreviewActionMenu } from "./command-preview.js";
import {
  atomicRestoreConfigDocument,
  atomicSaveConfigDocument,
  BUILT_IN_EXAMPLE,
  type LoadedStarshipConfig,
  removeConfigDocumentIfMatches,
  validateConfigDocument,
} from "./config.js";
import { inspectUnavailableModules, type StatuslineInspection } from "./modules/inspection.js";
import { getStarshipPreset, presetForDocument, STARSHIP_PRESETS, type StarshipPreset } from "./presets/catalog.js";

const MAIN_ACTIONS = {
  customize: "customize",
  presets: "presets",
  explain: "explain",
  modules: "modules",
  configuration: "configuration",
  help: "help",
  restore: "restore",
} as const;

const PREVIEW_ACTIONS = {
  continue: "continue",
  edit: "edit",
  cancel: "cancel",
} as const;

export interface StarshipCommandOptions extends ConfigurationCommandOptions {
  getInspection?(): StatuslineInspection | undefined;
  preview?(loaded: LoadedStarshipConfig | undefined, ctx: ExtensionCommandContext): void;
  save?: (settingsPath: string, rawDocument: string) => LoadedStarshipConfig;
  restore?: (settingsPath: string, rawDocument: string) => void;
  validate?: (settingsPath: string, rawDocument: string) => LoadedStarshipConfig;
  getMenuOwner?(): WorkflowOwner;
}

type ReviewIntent = { kind: "customize" } | { kind: "restore" } | { kind: "preset"; preset: StarshipPreset };

export function registerStarshipCommand(pi: ExtensionAPI, options: StarshipCommandOptions) {
  pi.registerCommand("starship", {
    description: "Customize or inspect the native Starship-style footer",
    getArgumentCompletions: completeStarshipArguments,
    handler: (args, ctx) => handleStarshipCommand(args, ctx, options),
  });
}

export async function handleStarshipCommand(
  args: string,
  ctx: ExtensionCommandContext,
  options: StarshipCommandOptions,
) {
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
  type Screen =
    | "main"
    | "explain"
    | "modules"
    | "configuration"
    | "configuration-overview"
    | "configuration-effective"
    | "configuration-document"
    | "help";
  type Action = "customize" | "presets" | "configuration-reload" | "restore";
  const menu = defineMenu<undefined, Screen, Action, ExtensionCommandContext>({
    start: "main",
    screens: {
      main: () => {
        const loaded = options.getLoaded();
        const presentation = configurationPresentation(loaded);
        return {
          kind: "actions",
          title: "pi-starship",
          lines: [`${presentation.state} · ${presentation.health}`],
          items: [
            {
              id: MAIN_ACTIONS.customize,
              label: "Customize footer",
              description: `${presentation.state} · preview before applying`,
              action: "customize",
            },
            {
              id: MAIN_ACTIONS.presets,
              label: "Presets",
              description: "Browse and live-preview bundled footer starting points",
              action: "presets",
            },
            {
              id: MAIN_ACTIONS.explain,
              label: "Explain footer",
              description: "Why each visible module appears",
              to: "explain",
            },
            {
              id: MAIN_ACTIONS.modules,
              label: "Modules",
              description: "Browse supported modules and current states",
              to: "modules",
            },
            {
              id: MAIN_ACTIONS.configuration,
              label: "Configuration",
              description: presentation.health,
              to: "configuration",
            },
            {
              id: MAIN_ACTIONS.help,
              label: "Help",
              description: "Formats, modules, and commands",
              to: "help",
            },
            {
              id: MAIN_ACTIONS.restore,
              label: "Restore built-in…",
              description: presentation.restoreDescription,
              disabled: presentation.restoreDisabled,
              action: "restore",
            },
          ],
          hint: "close",
        };
      },
      explain: () => ({
        kind: "review",
        title: "Explain footer",
        content: formatFooterExplanation(options.getInspection?.()),
        format: { kind: "text" },
        viewportSize: "adaptive",
        hint: "back",
      }),
      modules: () => {
        const inspection = options.getInspection?.() ?? inspectUnavailableModules(options.getLoaded().config);
        return {
          kind: "browse",
          title: "Modules",
          items: inspection.modules.map((module) => ({
            id: module.name,
            label: module.name,
            statusText: module.state,
            description: module.description,
            searchText: [...module.variables, ...module.styleFields, ...module.displayRules].join(" "),
            details: [
              `Root: ${module.rootReferenced ? "Referenced" : "Not referenced"}`,
              `Reachable: ${module.reachable ? "Yes" : "No"}`,
              ...modulePreviewDetails(module.preview),
              `Reason: ${module.reason}`,
              `Variables: ${module.variables.join(", ") || "none"}`,
              `Style fields: ${module.styleFields.join(", ") || "none"}`,
              `Display rules: ${module.displayRules.join(" · ") || "none"}`,
            ],
          })),
          viewportSize: "adaptive",
          hint: "back",
        };
      },
      configuration: () => configurationMenuScreen(options.getLoaded()),
      "configuration-overview": () => configurationOverviewScreen(options.getLoaded(), options.settingsPath),
      "configuration-effective": () => effectiveConfigurationScreen(options.getLoaded()),
      "configuration-document": () => settingsDocumentScreen(options.getLoaded(), options.settingsPath),
      help: () => ({
        kind: "detail",
        title: "pi-starship help",
        lines: [
          "Customize footer opens the TOML editor, then previews and confirms before saving.",
          "Presets live-previews the cursor in the footer; Enter confirms apply and e customizes first.",
          "Explain footer breaks down the modules currently showing from the existing snapshot.",
          "Modules searches every supported module and explains its current read-only state.",
          "Configuration separates overview, effective TOML, loaded settings text, and safe disk reload.",
          `Settings: ${safeText(options.settingsPath)}`,
          "Docs: https://github.com/narumiruna/pi-extensions/tree/main/packages/pi-starship",
        ],
        hint: "back",
      }),
    },
    actions: {
      customize: async () => {
        const result = await editSettings(ctx, options);
        return result === "applied" || result === "close" ? { kind: "close" } : { kind: "stay" };
      },
      presets: async () => {
        const result = await choosePreset(ctx, options, owner);
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
  let draft = options.getLoaded().rawDocument ?? BUILT_IN_EXAMPLE;
  while (true) {
    const edited = await ctx.ui.editor("Customize footer — close to preview", draft);
    if (!isCurrentOwner(owner) || edited === undefined) return "cancel";
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
      if (!isCurrentOwner(owner)) return "cancel";
      if (action?.kind === "closed") return "close";
      if (selectedPreviewAction(action) === PREVIEW_ACTIONS.edit) continue;
      return "cancel";
    }

    const result = await reviewAndApply(ctx, options, validated, { kind: "customize" }, owner);
    if (result === "edit") continue;
    return result;
  }
}

async function choosePreset(
  ctx: ExtensionCommandContext,
  options: StarshipCommandOptions,
  owner: WorkflowOwner,
): Promise<"applied" | "cancel" | "close"> {
  const activePreset = presetForDocument(options.getLoaded().rawDocument);
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
  if (!isCurrentOwner(owner)) {
    options.preview?.(undefined, ctx);
    return "cancel";
  }
  if (selection.kind === "back" || selection.kind === "close") {
    options.preview?.(undefined, ctx);
    return selection.kind === "close" ? "close" : "cancel";
  }

  const preset = getStarshipPreset(selection.presetId);
  try {
    return await applyPreset(ctx, options, preset, selection.kind === "customize" ? "customize" : "confirm");
  } finally {
    options.preview?.(undefined, ctx);
  }
}

async function applyPreset(
  ctx: ExtensionCommandContext,
  options: StarshipCommandOptions,
  preset: StarshipPreset,
  start: "review" | "confirm" | "customize" = "review",
): Promise<"applied" | "cancel" | "close"> {
  const owner = workflowOwner(options);
  if (!isCurrentOwner(owner)) return "cancel";
  let draft = preset.rawDocument;
  if (start === "customize") {
    const edited = await ctx.ui.editor(`Customize ${preset.label} preset`, draft);
    if (!isCurrentOwner(owner) || edited === undefined) return "cancel";
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
      if (!isCurrentOwner(owner)) return "cancel";
      if (action?.kind === "closed") return "close";
      if (selectedPreviewAction(action) !== PREVIEW_ACTIONS.edit) return "cancel";
      const edited = await ctx.ui.editor(`Customize ${preset.label} preset`, draft);
      if (!isCurrentOwner(owner) || edited === undefined) return "cancel";
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
    );
    if (result !== "edit") return result;
    const edited = await ctx.ui.editor(`Customize ${preset.label} preset`, draft);
    if (!isCurrentOwner(owner) || edited === undefined) return "cancel";
    draft = edited;
  }
}

async function restoreBuiltIn(
  ctx: ExtensionCommandContext,
  options: StarshipCommandOptions,
): Promise<"applied" | "cancel" | "close"> {
  const owner = workflowOwner(options);
  if (!isCurrentOwner(owner)) return "cancel";
  const validated = (options.validate ?? validateConfigDocument)(options.settingsPath, BUILT_IN_EXAMPLE);
  const result = await reviewAndApply(ctx, options, validated, { kind: "restore" }, owner);
  return result === "edit" ? "cancel" : result;
}

async function reviewAndApply(
  ctx: ExtensionCommandContext,
  options: StarshipCommandOptions,
  validated: LoadedStarshipConfig,
  intent: ReviewIntent,
  owner: WorkflowOwner,
  skipReview = false,
): Promise<"applied" | "edit" | "cancel" | "close"> {
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
          ...(intent.kind === "restore"
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
        ],
        owner.signal,
        owner.isCurrent,
      );
      if (!isCurrentOwner(owner)) return "cancel";
      if (selection?.kind === "closed") return "close";
      const selected = selectedPreviewAction(selection);
      if (selected === PREVIEW_ACTIONS.edit) return "edit";
      if (selected !== PREVIEW_ACTIONS.continue) return "cancel";
    }
    reviewRequired = true;

    const confirmed = await ctx.ui.confirm(
      confirmationTitle(intent),
      confirmationMessage(options.settingsPath, intent),
    );
    if (!isCurrentOwner(owner)) return "cancel";
    if (!confirmed) {
      if (directAttempt) return "cancel";
      continue;
    }

    const save = options.save ?? atomicSaveConfigDocument;
    const previous = options.getLoaded();
    let saved: LoadedStarshipConfig;
    try {
      saved = save(options.settingsPath, validated.rawDocument ?? BUILT_IN_EXAMPLE);
    } catch (error) {
      ctx.ui.notify(
        `Footer settings were not saved: ${safeText(formatError(error))}. The previous footer remains active.`,
        "error",
      );
      if (directAttempt) return "cancel";
      continue;
    }

    try {
      options.apply(saved, ctx);
    } catch (error) {
      const rollbackError = restorePreviousConfiguration(ctx, options, previous, saved);
      ctx.ui.notify(
        rollbackError
          ? `Footer settings could not be applied: ${safeText(formatError(error))}. Restoring the previous configuration also failed: ${safeText(formatError(rollbackError))}.`
          : `Footer settings could not be applied: ${safeText(formatError(error))}. The previous configuration was restored.`,
        "error",
      );
      if (directAttempt) return "cancel";
      continue;
    }

    const warningSuffix =
      saved.diagnostics.length > 0
        ? ` (${saved.diagnostics.length} warning${saved.diagnostics.length === 1 ? "" : "s"})`
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
    case "preset":
      return `${intent.preset.label} preset preview`;
  }
}

function continueLabel(intent: ReviewIntent): string {
  switch (intent.kind) {
    case "customize":
      return "Apply changes…";
    case "restore":
      return "Replace with built-in…";
    case "preset":
      return `Apply ${intent.preset.label} preset…`;
  }
}

function confirmationTitle(intent: ReviewIntent): string {
  switch (intent.kind) {
    case "customize":
      return "Apply footer changes?";
    case "restore":
      return "Restore built-in footer?";
    case "preset":
      return `Apply ${intent.preset.label} preset?`;
  }
}

function confirmationMessage(settingsPath: string, intent: ReviewIntent): string {
  if (intent.kind === "customize") return "Save this configuration and apply it immediately?";
  const replacement = intent.kind === "restore" ? "the built-in configuration" : `the ${intent.preset.label} preset`;
  return `Replace ${safeText(settingsPath)} entirely with ${replacement}? All custom settings, unknown fields, and comments will be removed. No backup is kept after success.`;
}

function successMessage(intent: ReviewIntent): string {
  switch (intent.kind) {
    case "customize":
      return "Footer settings saved and applied";
    case "restore":
      return "Built-in footer restored and applied";
    case "preset":
      return `${intent.preset.label} preset saved and applied`;
  }
}

function modulePreviewDetails(preview: string): string[] {
  const lines = preview ? preview.split("\n") : ["(no current preview)"];
  return lines.map((line, index) => `${index === 0 ? "Preview: " : "         "}${line}`);
}

function workflowOwner(options: StarshipCommandOptions): WorkflowOwner {
  if (options.getMenuOwner) return options.getMenuOwner();
  const controller = new AbortController();
  return { signal: controller.signal, isCurrent: () => true };
}

function isCurrentOwner(owner: WorkflowOwner): boolean {
  return !owner.signal.aborted && owner.isCurrent();
}

function restorePreviousConfiguration(
  ctx: ExtensionCommandContext,
  options: StarshipCommandOptions,
  previous: LoadedStarshipConfig,
  saved: LoadedStarshipConfig,
): unknown {
  try {
    if (saved.rawDocument === undefined || saved.fileIdentity === undefined) {
      throw new Error("The saved settings document identity is unavailable");
    }
    removeConfigDocumentIfMatches(options.settingsPath, saved.rawDocument, saved.fileIdentity);
    if (previous.rawDocument !== undefined) {
      (options.restore ?? atomicRestoreConfigDocument)(options.settingsPath, previous.rawDocument);
    }
    options.apply(previous, ctx);
    return undefined;
  } catch (error) {
    return error;
  }
}

function reviewPreviewBody(
  ctx: ExtensionCommandContext,
  options: StarshipCommandOptions,
  loaded: LoadedStarshipConfig,
  width: number,
  intent: ReviewIntent,
): string[] {
  if (intent.kind === "restore") return restorePreviewBody(ctx, options, loaded, width);
  if (intent.kind === "customize") return previewBody(ctx, options, loaded, width);
  const current = configurationPresentation(options.getLoaded());
  return [
    `Preset: ${intent.preset.label}`,
    `Requirement: ${intent.preset.requiresNerdFont ? "Nerd Font" : "No special font"}`,
    `Current: ${current.state}`,
    `Path: ${safeText(options.settingsPath)}`,
    "Applying replaces the entire settings document, including custom settings, unknown fields, and comments.",
    "No backup is kept after a successful apply.",
    "",
    ...previewBody(ctx, options, loaded, width),
  ];
}

function restorePreviewBody(
  ctx: ExtensionCommandContext,
  options: StarshipCommandOptions,
  loaded: LoadedStarshipConfig,
  width: number,
): string[] {
  const current = configurationPresentation(options.getLoaded());
  return [
    `Current: ${current.state}`,
    `Path: ${safeText(options.settingsPath)}`,
    "The entire settings document will be replaced, including custom settings, unknown fields, and comments.",
    "No backup is kept after a successful restore.",
    "",
    ...previewBody(ctx, options, loaded, width),
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
      "/starship — customize, live-preview presets, explain, or inspect the footer in TUI mode",
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
