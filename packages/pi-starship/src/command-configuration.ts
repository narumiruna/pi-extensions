import { type ExtensionCommandContext, withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { sanitizeTerminalText } from "@narumitw/pi-tui-kit/terminal-text";
import { type PreviewMenuResult, showPreviewActionMenu } from "./command-preview.js";
import {
  assertConfigDocumentUnchanged,
  BUILT_IN_EXAMPLE,
  type ConfigDocumentSnapshot,
  type LoadedStarshipConfig,
  loadStarshipConfig,
  readConfigDocumentSnapshot,
} from "./config.js";
import { presetForDocument } from "./presets/catalog.js";
import { archiveConfigDocument } from "./profile-store.js";

const RELOAD_ACTIONS = {
  apply: "apply",
  cancel: "cancel",
} as const;

export interface WorkflowOwner {
  signal: AbortSignal;
  isCurrent(): boolean;
  /** Session ownership independent of command cancellation and candidate/revision guards. */
  isSessionCurrent?(): boolean;
  /** The shared parent terminal can remain live after its session context changes. */
  canRestoreTerminal?(): boolean;
}

export interface ConfigurationCommandOptions {
  getLoaded(): LoadedStarshipConfig;
  getLoadedRevision?(): number;
  apply(loaded: LoadedStarshipConfig, ctx: ExtensionCommandContext): void;
  settingsPath: string;
  renderPreview?(loaded: LoadedStarshipConfig, width: number, ctx: ExtensionCommandContext): string[];
  read?: (settingsPath: string) => LoadedStarshipConfig;
  archive?: typeof archiveConfigDocument;
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
      ? "Pi native footer"
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
    restoreDisabled: healthyMissing,
    restoreDescription: healthyMissing
      ? "Already using Pi native footer · no file to remove"
      : "Preview before restoring Pi native footer",
  };
}

export function configurationMenuScreen(loaded: LoadedStarshipConfig, settingsPath: string) {
  const presentation = configurationPresentation(loaded);
  return {
    kind: "actions" as const,
    title: "Configuration",
    lines: [
      `State: ${presentation.state}`,
      `Source: ${presentation.source}`,
      `Path: ${sanitizeTerminalText(settingsPath)}`,
      ...diagnosticLines(loaded, true, loaded.diagnostics.length),
    ],
    items: [
      {
        id: "configuration-reload",
        label: "Reload from disk…",
        description: "Validate and preview external changes",
        action: "configuration-reload" as const,
      },
      {
        id: "gist-share",
        label: "Share settings as Gist…",
        description: "Upload reviewed TOML to GitHub · unlisted, not private · requires gh",
        action: "gist-share" as const,
      },
      {
        id: "gist-import",
        label: "Import settings from Gist…",
        description: "Review and preview remote TOML before replacing settings · requires gh",
        action: "gist-import" as const,
      },
      {
        id: "history",
        label: "History",
        description: "Review and restore recovery copies; legacy skill backups are read-only",
        action: "history" as const,
      },
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
  let disk: ConfigDocumentSnapshot;
  try {
    disk = readConfigDocumentSnapshot(options.settingsPath);
  } catch (error) {
    ctx.ui.notify(`Footer reload was blocked: ${safeError(error)}`, "error");
    return "stay";
  }
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
      ? "Show Pi's native footer for this session? No settings file will be created."
      : "Apply the validated settings document to this session without changing its bytes? The previous loaded document will be kept in History.",
    { signal: owner.signal },
  );
  if (!isCurrentOwner(owner) || activeRevisionChanged(options, revision) || !confirmed) {
    return "stay";
  }

  let warnings = 0;
  try {
    const applied = await withFileMutationQueue(options.settingsPath, async () => {
      if (
        !isCurrentOwner(owner) ||
        activeRevisionChanged(options, revision) ||
        !sameLoadedDocument(previous, options.getLoaded())
      )
        return false;
      assertConfigDocumentUnchanged(options.settingsPath, disk);
      const fresh = readReloadCandidate(options);
      if (!fresh.ok) throw new Error(fresh.error);
      if (!sameLoadedDocument(candidate.loaded, fresh.loaded)) {
        throw new Error(
          "The settings document changed after preview. The previous footer remains active; reload again to review the latest version.",
        );
      }
      let recoveryPath: string | undefined;
      const previousBytes = previous.rawBytes ?? previous.rawDocument;
      if (previousBytes !== undefined) {
        recoveryPath = (options.archive ?? archiveConfigDocument)(options.settingsPath, previousBytes).path;
      }
      assertConfigDocumentUnchanged(options.settingsPath, disk);
      if (!isCurrentOwner(owner) || activeRevisionChanged(options, revision)) return false;
      try {
        options.apply(fresh.loaded, ctx);
      } catch (error) {
        let rollbackError: unknown;
        try {
          if (!isCurrentOwner(owner)) throw new Error("The session owner changed; stale restoration was blocked");
          const current = options.getLoaded();
          if (!sameLoadedDocument(current, previous) && !sameLoadedDocument(current, fresh.loaded))
            throw new Error("The active runtime changed; stale restoration was blocked");
          options.apply(previous, ctx);
        } catch (rollback) {
          rollbackError = rollback;
        }
        throw new Error(
          `Footer reload failed: ${formatError(error)}. ${
            rollbackError
              ? `Restoring the previous configuration also failed: ${formatError(rollbackError)}.`
              : "The previous configuration was restored."
          }${recoveryPath ? ` Recovery copy retained: ${recoveryPath}.` : ""}`,
        );
      }
      warnings = fresh.loaded.diagnostics.length;
      return true;
    });
    if (!isCurrentOwner(owner) || !applied) return "stay";
  } catch (error) {
    if (isCurrentOwner(owner))
      ctx.ui.notify(`Footer reload was blocked after confirmation: ${safeError(error)}`, "error");
    return "stay";
  }
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
      ? "Applying shows Pi's native footer and creates no settings file."
      : "Applying changes only the active session; the settings document bytes stay unchanged.",
    ...diagnosticLines(loaded, true),
    "",
    ...preview,
  ];
}

export function diagnosticLines(loaded: LoadedStarshipConfig, includeSummary: boolean, limit = 8): string[] {
  const diagnostics = loaded.diagnostics
    .slice(0, limit)
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
