import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { defineMenu, runMenu, runTask } from "@narumitw/pi-tui-kit";
import { sanitizeTerminalText } from "@narumitw/pi-tui-kit/terminal-text";
import type { WorkflowOwner } from "./command-configuration.js";
import type { StarshipCommandOptions } from "./commands.js";
import {
  atomicSaveConfigDocument,
  BUILT_IN_EXAMPLE,
  type LoadedStarshipConfig,
  loadStarshipConfig,
  readConfigDocumentSnapshot,
  validateConfigDocument,
} from "./config.js";
import { checkGistDocument, createSettingsGist, fetchSettingsGist, type GhApi, gistId } from "./gist.js";

export type GistWorkflowResult = "applied" | "cancel" | "close";
export type ReviewImport = (
  loaded: LoadedStarshipConfig,
  options: StarshipCommandOptions,
  owner: WorkflowOwner,
) => Promise<GistWorkflowResult>;

export async function shareSettingsGist(
  ctx: ExtensionCommandContext,
  options: StarshipCommandOptions,
  owner: WorkflowOwner,
  api?: GhApi,
): Promise<GistWorkflowResult> {
  if (ctx.mode !== "tui" || !current(owner)) return "cancel";
  const loaded = options.getLoaded();
  if (loaded.diagnostics.some((item) => item.severity === "error")) {
    ctx.ui.notify("Fix configuration errors before sharing settings.", "warning");
    return "cancel";
  }
  const raw = loaded.rawDocument ?? BUILT_IN_EXAMPLE;
  try {
    checkGistDocument(raw);
  } catch (error) {
    ctx.ui.notify(safeError(error), "error");
    return "cancel";
  }
  const review = await reviewDocument(
    ctx,
    owner,
    "Share settings as Gist",
    raw,
    [
      "Review the entire loaded document, including comments and unknown fields, for secrets and local paths.",
      "No settings file is created when sharing built-in defaults.",
    ],
    "Share unlisted Gist…",
  );
  if (!current(owner)) return "cancel";
  if (!review) return "close";
  const confirmed = await ctx.ui.confirm(
    "Upload settings to GitHub?",
    [
      "Send the reviewed pi-starship.toml to github.com as a new unlisted Gist?",
      "Unlisted is not private: anyone with the link can read it. Comments and unknown fields are included.",
      "Cancellation or a network error cannot undo an upload already accepted by GitHub; check your Gists before retrying.",
    ].join("\n"),
    { signal: owner.signal },
  );
  if (!current(owner) || !confirmed) return "cancel";
  const result = await runTask(ctx, {
    label: "Sharing settings with GitHub…",
    signal: owner.signal,
    isCurrent: owner.isCurrent,
    task: ({ signal }) => createSettingsGist(raw, signal, api),
    onError: () =>
      ctx.ui.notify(
        "Gist upload failed. Check gh auth status, Gist access, connectivity, and your Gists before retrying. The upload may already exist.",
        "error",
      ),
  });
  if (!current(owner)) return "cancel";
  if (result.kind === "completed") {
    ctx.ui.notify(`Settings Gist: ${result.value}`, "info");
    return "cancel";
  }
  return result.kind === "error" ? "cancel" : "close";
}

export async function importSettingsGist(
  ctx: ExtensionCommandContext,
  options: StarshipCommandOptions,
  owner: WorkflowOwner,
  reviewImport: ReviewImport,
  api?: GhApi,
): Promise<GistWorkflowResult> {
  if (ctx.mode !== "tui" || !current(owner)) return "cancel";
  const previous = options.getLoaded();
  const revision = options.getLoadedRevision?.();
  const disk = diskSnapshot(options);
  const initialDisk = readConfigDocumentSnapshot(options.settingsPath);
  const guardedOwner: WorkflowOwner = {
    signal: owner.signal,
    isSessionCurrent: () => owner.isSessionCurrent?.() ?? owner.isCurrent(),
    isCurrent: () =>
      current(owner) &&
      options.getLoadedRevision?.() === revision &&
      options.getLoaded().rawDocument === previous.rawDocument &&
      options.getLoaded().source === previous.source,
  };
  const value = await ctx.ui.input("Import pi-starship settings from Gist", "https://gist.github.com/<owner>/<id>", {
    signal: owner.signal,
  });
  if (!current(guardedOwner) || value === undefined) return "cancel";
  let id: string;
  try {
    id = gistId(value);
  } catch (error) {
    ctx.ui.notify(safeError(error), "error");
    return "cancel";
  }
  const result = await runTask(ctx, {
    label: "Reading settings from GitHub…",
    signal: owner.signal,
    isCurrent: guardedOwner.isCurrent,
    task: ({ signal }) => fetchSettingsGist(id, signal, api),
    onError: () =>
      ctx.ui.notify(
        "Gist import failed. Check the Gist ID, gh auth status, connectivity, and a complete pi-starship.toml file (up to 64 KiB).",
        "error",
      ),
  });
  if (!current(guardedOwner)) return "cancel";
  if (result.kind !== "completed") return result.kind === "error" ? "cancel" : "close";
  let validated: LoadedStarshipConfig;
  try {
    validated = (options.validate ?? validateConfigDocument)(options.settingsPath, result.value);
  } catch (error) {
    ctx.ui.notify(`Gist settings are invalid: ${safeError(error)}`, "error");
    return "cancel";
  }
  const reviewed = await reviewDocument(
    ctx,
    guardedOwner,
    "Review Gist settings",
    result.value,
    [
      `Source: https://gist.github.com/${id}`,
      "Untrusted settings can enable local commands and network requests. Review the complete TOML before applying.",
      "Import replaces the entire local document, including comments and unknown fields; its previous bytes will be kept in History.",
    ],
    "Preview imported footer…",
  );
  if (!current(guardedOwner)) return "cancel";
  if (!reviewed) return "close";
  return reviewImport(
    validated,
    {
      ...options,
      save(path, raw) {
        if (!current(guardedOwner) || diskSnapshot(options) !== disk) {
          throw new Error("Settings changed during import. Start a new import to review the latest state.");
        }
        return options.save ? options.save(path, raw) : atomicSaveConfigDocument(path, raw, {}, initialDisk);
      },
    },
    guardedOwner,
  );
}

async function reviewDocument(
  ctx: ExtensionCommandContext,
  owner: WorkflowOwner,
  title: string,
  content: string,
  lines: string[],
  label: string,
): Promise<boolean> {
  let approved = false;
  const menu = defineMenu<undefined, "document", "continue", ExtensionCommandContext>({
    start: "document",
    screens: {
      document: () => ({
        kind: "review",
        title,
        lines,
        content,
        format: { kind: "code", language: "toml" },
        viewportSize: "adaptive",
        enableSearch: true,
        confirm: { id: "continue", label, action: "continue" },
        hint: "close",
      }),
    },
    actions: {
      continue: () => {
        approved = true;
        return { kind: "close" };
      },
    },
  });
  await runMenu(ctx, menu, { getState: () => undefined, signal: owner.signal, isCurrent: owner.isCurrent });
  return current(owner) && approved;
}

function diskSnapshot(options: StarshipCommandOptions): string {
  const loaded = (options.read ?? loadStarshipConfig)(options.settingsPath);
  return JSON.stringify([
    loaded.rawDocument,
    loaded.source,
    loaded.diagnostics,
    readConfigDocumentSnapshot(options.settingsPath),
  ]);
}

function current(owner: WorkflowOwner): boolean {
  return !owner.signal.aborted && owner.isCurrent();
}

function safeError(error: unknown): string {
  return sanitizeTerminalText(error instanceof Error ? error.message : String(error));
}
