import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { sanitizeTerminalText } from "@narumitw/pi-tui-kit/terminal-text";
import { type PreviewMenuResult, showPreviewActionMenu } from "./command-preview.js";
import { BUILT_IN_EXAMPLE, type LoadedStarshipConfig, loadStarshipConfig } from "./config.js";
import { serializeEffectiveConfig } from "./effective-config.js";
import { presetForDocument } from "./presets/catalog.js";

const RELOAD_ACTIONS = {
  apply: "apply",
  cancel: "cancel",
} as const;

export interface WorkflowOwner {
  signal: AbortSignal;
  isCurrent(): boolean;
}

export interface ConfigurationCommandOptions {
  getLoaded(): LoadedStarshipConfig;
  getLoadedRevision?(): number;
  apply(loaded: LoadedStarshipConfig, ctx: ExtensionCommandContext): void;
  settingsPath: string;
  renderPreview?(loaded: LoadedStarshipConfig, width: number, ctx: ExtensionCommandContext): string[];
  read?: (settingsPath: string) => LoadedStarshipConfig;
}

export interface ConfigurationPresentation {
  state: string;
  source: string;
  health: string;
  restoreDisabled: boolean;
  restoreDescription: string;
}

export function configurationPresentation(loaded: LoadedStarshipConfig): ConfigurationPresentation {
  const healthyMissing = isHealthyMissing(loaded);
  const savedBuiltIn = loaded.source === "user" && loaded.rawDocument === BUILT_IN_EXAMPLE;
  const activePreset = presetForDocument(loaded.rawDocument);
  const fallback = loaded.source === "built-in" && loaded.diagnostics.length > 0;
  return {
    state: healthyMissing
      ? "Built-in defaults"
      : savedBuiltIn
        ? "Saved built-in configuration"
        : activePreset
          ? `${activePreset.label} preset`
          : fallback
            ? "Built-in fallback"
            : "Custom configuration",
    source: healthyMissing
      ? "No settings file"
      : activePreset
        ? "Bundled preset"
        : loaded.source === "user"
          ? "User file"
          : "Built-in fallback",
    health: configurationHealth(loaded),
    restoreDisabled: healthyMissing || savedBuiltIn,
    restoreDescription: healthyMissing
      ? "Already using defaults · no file to replace"
      : savedBuiltIn
        ? "Built-in configuration already saved"
        : fallback
          ? "Preview before replacing invalid settings"
          : "Preview before replacing the document",
  };
}

export function configurationMenuScreen(loaded: LoadedStarshipConfig) {
  const presentation = configurationPresentation(loaded);
  return {
    kind: "actions" as const,
    title: "Configuration",
    lines: [`${presentation.state} · ${presentation.health}`],
    items: [
      {
        id: "configuration-overview",
        label: "Overview",
        description: "State, source, path, health, and warnings",
        to: "configuration-overview" as const,
      },
      {
        id: "configuration-effective",
        label: "Effective configuration",
        description: "Normalized public TOML currently in use",
        to: "configuration-effective" as const,
      },
      {
        id: "configuration-document",
        label: "Settings document",
        description: isHealthyMissing(loaded)
          ? "No settings file · built-in defaults are active"
          : "Exact loaded UTF-8 text · read-only",
        to: "configuration-document" as const,
      },
      {
        id: "configuration-reload",
        label: "Reload from disk…",
        description: "Validate and preview external changes",
        action: "configuration-reload" as const,
      },
    ],
    hint: "back" as const,
  };
}

export function configurationOverviewScreen(loaded: LoadedStarshipConfig, settingsPath: string) {
  const presentation = configurationPresentation(loaded);
  return {
    kind: "detail" as const,
    title: "Configuration overview",
    lines: [
      `State: ${presentation.state}`,
      `Source: ${presentation.source}`,
      `Path: ${sanitizeTerminalText(settingsPath)}`,
      ...diagnosticLines(loaded, true),
    ],
    hint: "back" as const,
  };
}

export function effectiveConfigurationScreen(loaded: LoadedStarshipConfig) {
  const presentation = configurationPresentation(loaded);
  return {
    kind: "review" as const,
    title: "Effective configuration",
    lines: [
      `${presentation.state} · ${presentation.health}`,
      "Normalized public TOML; comments and unknown fields are intentionally excluded.",
    ],
    content: serializeEffectiveConfig(loaded.config),
    format: { kind: "code" as const, language: "toml" },
    viewportSize: "adaptive" as const,
    hint: "back" as const,
  };
}

export function settingsDocumentScreen(loaded: LoadedStarshipConfig, settingsPath: string) {
  const path = sanitizeTerminalText(settingsPath);
  if (loaded.rawDocument !== undefined) {
    return {
      kind: "review" as const,
      title: "Settings document",
      lines: ["Exact loaded UTF-8 text · display controls sanitized · read-only", `Path: ${path}`],
      content: loaded.rawDocument,
      format: { kind: "code" as const, language: "toml" },
      viewportSize: "adaptive" as const,
      hint: "back" as const,
    };
  }
  return {
    kind: "detail" as const,
    title: "Settings document",
    lines: [
      ...(isHealthyMissing(loaded)
        ? ["No settings document exists.", "Built-in defaults are active; this read created no file."]
        : ["The settings document could not be loaded.", ...diagnosticLines(loaded, false)]),
      `Path: ${path}`,
    ],
    hint: "back" as const,
  };
}

export async function reloadConfiguration(
  ctx: ExtensionCommandContext,
  options: ConfigurationCommandOptions,
  owner: WorkflowOwner,
): Promise<"applied" | "stay" | "close"> {
  if (!isCurrentOwner(owner)) return "stay";
  const previous = options.getLoaded();
  const revision = options.getLoadedRevision?.();
  const candidate = readReloadCandidate(options);
  if (!candidate.ok) {
    ctx.ui.notify(`Footer reload was blocked: ${safeError(candidate.error)}`, "error");
    return "stay";
  }
  if (sameLoadedDocument(previous, candidate.loaded)) {
    ctx.ui.notify("The current disk configuration is already loaded.", "info");
    return "stay";
  }

  const selection = await showPreviewActionMenu(
    ctx,
    "Reload preview",
    (width) => reloadPreviewBody(ctx, options, candidate.loaded, width),
    [
      { value: RELOAD_ACTIONS.apply, label: "Apply reloaded configuration…" },
      { value: RELOAD_ACTIONS.cancel, label: "Cancel" },
    ],
    owner.signal,
    owner.isCurrent,
  );
  if (!isCurrentOwner(owner) || activeRevisionChanged(options, revision)) return "stay";
  if (selection?.kind === "closed") return "close";
  if (selectedReloadAction(selection) !== RELOAD_ACTIONS.apply) return "stay";

  const confirmed = await ctx.ui.confirm(
    "Apply configuration from disk?",
    candidate.loaded.rawDocument === undefined
      ? "Use built-in defaults for this session? No settings file will be created."
      : "Apply the validated settings document to this session without changing its bytes?",
  );
  if (!isCurrentOwner(owner) || activeRevisionChanged(options, revision) || !confirmed) {
    return "stay";
  }

  const fresh = readReloadCandidate(options);
  if (!fresh.ok) {
    ctx.ui.notify(
      `Footer reload was blocked after confirmation: ${safeError(fresh.error)}. The previous footer remains active.`,
      "error",
    );
    return "stay";
  }
  if (!sameLoadedDocument(candidate.loaded, fresh.loaded)) {
    ctx.ui.notify(
      "The settings document changed after preview. The previous footer remains active; reload again to review the latest version.",
      "warning",
    );
    return "stay";
  }

  try {
    options.apply(fresh.loaded, ctx);
  } catch (error) {
    let rollbackError: unknown;
    try {
      options.apply(previous, ctx);
    } catch (rollback) {
      rollbackError = rollback;
    }
    ctx.ui.notify(
      rollbackError
        ? `Footer reload failed: ${safeError(error)}. Restoring the previous configuration also failed: ${safeError(rollbackError)}.`
        : `Footer reload failed: ${safeError(error)}. The previous configuration was restored.`,
      "error",
    );
    return "stay";
  }

  const warnings = fresh.loaded.diagnostics.length;
  ctx.ui.notify(
    warnings === 0
      ? "Footer configuration reloaded and applied."
      : `Footer configuration reloaded and applied with ${warnings} warning${warnings === 1 ? "" : "s"}.`,
    "info",
  );
  return "applied";
}

function readReloadCandidate(
  options: ConfigurationCommandOptions,
): { ok: true; loaded: LoadedStarshipConfig } | { ok: false; error: string } {
  let loaded: LoadedStarshipConfig;
  try {
    loaded = (options.read ?? loadStarshipConfig)(options.settingsPath);
  } catch (error) {
    return { ok: false, error: formatError(error) };
  }
  const errors = loaded.diagnostics.filter((item) => item.severity === "error");
  if (errors.length > 0) {
    return { ok: false, error: errors.map((item) => item.message).join("; ") };
  }
  return { ok: true, loaded };
}

function reloadPreviewBody(
  ctx: ExtensionCommandContext,
  options: ConfigurationCommandOptions,
  loaded: LoadedStarshipConfig,
  width: number,
): string[] {
  const presentation = configurationPresentation(loaded);
  let preview: string[];
  try {
    preview = options.renderPreview?.(loaded, width, ctx) ?? ["Live preview is unavailable until the footer is ready."];
  } catch (error) {
    preview = [`Preview unavailable: ${safeError(formatError(error))}`];
  }
  return [
    `Candidate: ${presentation.state}`,
    `Source: ${presentation.source}`,
    `Path: ${sanitizeTerminalText(options.settingsPath)}`,
    loaded.rawDocument === undefined
      ? "Applying uses built-in defaults and creates no settings file."
      : "Applying changes only the active session; the settings document bytes stay unchanged.",
    ...diagnosticLines(loaded, true),
    "",
    ...preview,
  ];
}

export function diagnosticLines(loaded: LoadedStarshipConfig, includeSummary: boolean): string[] {
  const diagnostics = loaded.diagnostics
    .slice(0, 8)
    .map((item) => `${sanitizeTerminalText(item.path || "root")}: ${sanitizeTerminalText(item.message)}`);
  const remaining = loaded.diagnostics.length - diagnostics.length;
  return [
    ...(includeSummary ? [`Health: ${configurationHealth(loaded)}`] : []),
    ...(diagnostics.length > 0 ? diagnostics : ["No configuration warnings."]),
    ...(remaining > 0 ? [`${remaining} additional warnings not shown.`] : []),
  ];
}

function configurationHealth(loaded: LoadedStarshipConfig): string {
  const errors = loaded.diagnostics.filter((item) => item.severity === "error").length;
  if (errors > 0) return `${errors} error${errors === 1 ? "" : "s"}`;
  const warnings = loaded.diagnostics.length;
  return warnings === 0 ? "Healthy" : `${warnings} warning${warnings === 1 ? "" : "s"}`;
}

function isHealthyMissing(loaded: LoadedStarshipConfig): boolean {
  return loaded.source === "built-in" && loaded.rawDocument === undefined && loaded.diagnostics.length === 0;
}

function sameLoadedDocument(left: LoadedStarshipConfig, right: LoadedStarshipConfig): boolean {
  return (
    left.source === right.source &&
    left.rawDocument === right.rawDocument &&
    JSON.stringify(left.diagnostics) === JSON.stringify(right.diagnostics)
  );
}

function activeRevisionChanged(options: ConfigurationCommandOptions, revision: number | undefined): boolean {
  return revision !== undefined && options.getLoadedRevision?.() !== revision;
}

function isCurrentOwner(owner: WorkflowOwner): boolean {
  return !owner.signal.aborted && owner.isCurrent();
}

function selectedReloadAction(
  result: PreviewMenuResult<(typeof RELOAD_ACTIONS)[keyof typeof RELOAD_ACTIONS]> | undefined,
) {
  return result?.kind === "selected" ? result.value : null;
}

function safeError(value: unknown): string {
  return sanitizeTerminalText(typeof value === "string" ? value : formatError(value));
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
