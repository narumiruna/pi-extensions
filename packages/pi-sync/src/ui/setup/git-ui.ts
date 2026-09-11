import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { normalizeGitBranch, normalizeGitDirectory, normalizeGitRemote } from "../../backends/git/git-config.js";
import {
  addStorageConnection,
  addSyncSetup,
  saveNewV3Settings,
  updateStorageConnection,
  updateSyncSetup,
} from "../../settings/settings-management.js";
import type { PartialConfig } from "../../settings/settings-types.js";
import { automaticSyncSummary } from "../automatic-sync-summary.js";
import { safeTerminalText } from "../terminal-text.js";
import { promptAvailableSetupStorage } from "./setup-location-ui.js";
import {
  chooseAutomaticSync,
  chooseSetupContent,
  includedContentLines,
  promptResourceName,
  readSetupConnection,
} from "./setup-prompts.js";
import { saveReviewedDraft } from "./setup-review.js";
import { requiredInput, requiredValueInput } from "./text-input.js";

export async function showGitSetup(ctx: ExtensionCommandContext, targetName: string, signal?: AbortSignal) {
  const remote = await promptGitRemote(ctx, signal);
  if (!remote) return false;
  const destination = await promptGitDestination(ctx, signal);
  if (!destination) return false;
  const include = await chooseSetupContent(ctx, signal);
  if (!include) return false;
  const automatic = await chooseAutomaticSync(ctx, signal);
  if (automatic === undefined) return false;
  const saved = await saveReviewedDraft(
    ctx,
    "Review Git sync setup",
    [
      `Sync setup: ${safeTerminalText(targetName)}`,
      `Storage connection: ${safeTerminalText(targetName)} (Git)`,
      `Remote: ${safeTerminalText(remote)}`,
      `Sync branch: ${safeTerminalText(destination.branch)}`,
      `Storage location: ${safeTerminalText(destination.directory)}`,
      ...includedContentLines(include),
      `Automatic sync: ${automaticSyncSummary(automatic)}`,
      "Authentication: existing Git credential helper or SSH configuration (not stored by pi-sync).",
      "pi-sync manages the entire branch. The repository must already exist; a new branch is created on first push.",
      "Saving does not contact remote storage or start syncing.",
    ],
    "Save setup",
    (saveSignal) =>
      saveNewV3Settings(
        {
          setupName: targetName,
          connectionName: targetName,
          connection: { type: "git", remote },
          setup: {
            storage: {
              connection: targetName,
              branch: destination.branch,
              path: destination.directory,
            },
            sync: { include, automatic },
          },
        },
        saveSignal,
      ),
    signal,
  );
  if (saved && !signal?.aborted)
    ctx.ui.notify(`Saved Git sync setup “${safeTerminalText(targetName)}”. Choose Sync now to start.`, "info");
  return saved;
}

export async function showAddGitStorageProfile(ctx: ExtensionCommandContext, signal?: AbortSignal) {
  const name = await promptResourceName(ctx, "storage connection", "git", signal);
  if (!name) return false;
  const remote = await promptGitRemote(ctx, signal);
  if (!remote) return false;
  const saved = await saveReviewedDraft(
    ctx,
    "Review storage connection",
    [
      `Name: ${safeTerminalText(name)}`,
      "Type: Git",
      `Remote: ${safeTerminalText(remote)}`,
      "Credentials: existing Git/SSH authentication (not stored)",
      "Adding a connection does not contact the remote or start syncing.",
    ],
    "Add storage connection",
    (saveSignal) => addStorageConnection(name, { type: "git", remote }, saveSignal),
    signal,
  );
  if (saved && !signal?.aborted) ctx.ui.notify(`Added storage connection “${safeTerminalText(name)}”.`, "info");
  return saved;
}

export async function showEditGitStorageProfile(
  ctx: ExtensionCommandContext,
  name: string,
  profile: Record<string, unknown>,
  signal?: AbortSignal,
  affectedSetups?: string[],
) {
  const remote = await promptGitRemote(ctx, signal, typeof profile.remote === "string" ? profile.remote : undefined);
  if (!remote) return false;
  const saved = await saveReviewedDraft(
    ctx,
    "Review storage connection",
    [
      `Storage connection: ${safeTerminalText(name)}`,
      `Remote: ${safeTerminalText(String(profile.remote ?? "missing"))} → ${safeTerminalText(remote)}`,
      `Affected sync setups: ${affectedSetups?.length ? affectedSetups.map(safeTerminalText).join(", ") : "None"}`,
      "Saving changes future storage access for every affected setup; it does not move or delete remote history.",
    ],
    "Save storage connection",
    (saveSignal) =>
      updateStorageConnection(
        name,
        (current) => {
          if (current.type !== "git" || current.remote !== profile.remote)
            throw new Error("Storage connection changed while it was open; reopen it.");
          return { ...current, remote };
        },
        affectedSetups,
        saveSignal,
      ),
    signal,
  );
  if (saved && !signal?.aborted) ctx.ui.notify(`Saved storage connection “${safeTerminalText(name)}”.`, "info");
  return saved;
}

export async function showAddGitTarget(
  ctx: ExtensionCommandContext,
  name: string,
  profile: string,
  signal?: AbortSignal,
) {
  const selected = await promptGitDestination(ctx, signal);
  if (!selected) return false;
  const storage = await promptAvailableSetupStorage(
    ctx,
    { connection: profile, branch: selected.branch, path: selected.directory },
    signal,
  );
  if (!storage) return false;
  const include = await chooseSetupContent(ctx, signal);
  if (!include) return false;
  const automatic = await chooseAutomaticSync(ctx, signal);
  if (automatic === undefined) return false;
  const connection = await readSetupConnection(profile, signal);
  if (connection?.type !== "git") throw new Error("Storage connection changed; reopen setup.");
  const saved = await saveReviewedDraft(
    ctx,
    "Review Git sync setup",
    [
      `Sync setup: ${safeTerminalText(name)}`,
      `Storage connection: ${safeTerminalText(profile)}`,
      `Remote: ${safeTerminalText(connection.remote)}`,
      `Sync branch: ${safeTerminalText(storage.branch)}`,
      `Storage location: ${safeTerminalText(storage.path)}`,
      ...includedContentLines(include),
      `Automatic sync: ${automaticSyncSummary(automatic)}`,
      "pi-sync manages the entire branch. Adding this setup does not sync or modify remote data.",
    ],
    "Add sync setup",
    (saveSignal) => addSyncSetup(name, { storage, sync: { include, automatic } }, saveSignal, connection),
    signal,
  );
  if (saved && !signal?.aborted) ctx.ui.notify(`Added sync setup “${safeTerminalText(name)}”.`, "info");
  return saved;
}

export async function showEditGitTarget(ctx: ExtensionCommandContext, partial: PartialConfig, signal?: AbortSignal) {
  let destination = await promptGitDestination(ctx, signal, partial);
  if (!destination) return false;
  while (destination.directory !== partial.storagePath && destination.branch === partial.branch) {
    ctx.ui.notify(
      "Changing a Git storage path requires a new Git branch so the existing branch remains readable.",
      "warning",
    );
    const branch = await requiredValueInput(
      ctx,
      "New Git branch\n\nKeep the previous branch unchanged; enter a new branch for this path.",
      "pi-sync/archive",
      signal,
      normalizeGitBranch,
    );
    if (!branch) return false;
    destination = { ...destination, branch };
  }
  const chosen = destination;
  const connection = await readSetupConnection(partial.connectionName, signal);
  if (connection.type !== "git") throw new Error("Storage connection changed; reopen setup.");
  const saved = await saveReviewedDraft(
    ctx,
    "Review sync setup",
    [
      `Sync setup: ${safeTerminalText(partial.setupName)}`,
      `Storage connection: ${safeTerminalText(partial.connectionName)}`,
      `Remote: ${safeTerminalText(connection.remote)}`,
      `Branch: ${safeTerminalText(partial.branch ?? "missing")} → ${safeTerminalText(chosen.branch)}`,
      `Storage path: ${safeTerminalText(partial.storagePath)} → ${safeTerminalText(chosen.directory)}`,
      "Saving changes the future storage location only; it does not move or delete remote history.",
    ],
    "Save sync setup",
    (saveSignal) =>
      updateSyncSetup(
        partial.setupName,
        (setup) => {
          if (typeof setup.storage.branch !== "string") throw new Error("Sync setup storage type changed; reopen it.");
          return {
            ...setup,
            storage: { ...setup.storage, branch: chosen.branch, path: chosen.directory },
          };
        },
        { expectedStorage: partial, expectedConnection: connection, signal: saveSignal },
      ),
    signal,
  );
  if (saved && !signal?.aborted) ctx.ui.notify(`Saved sync setup “${safeTerminalText(partial.setupName)}”.`, "info");
  return saved;
}

async function promptGitRemote(ctx: ExtensionCommandContext, signal?: AbortSignal, current?: string) {
  const title =
    "Git remote URL (SSH or HTTPS)\n\nUse an existing private repository with Git/SSH authentication already configured.";
  const validate = (value: string) => {
    const remote = normalizeGitRemote(value);
    if (!remote) throw new Error("Git remote URL is required.");
    return remote;
  };
  return current
    ? requiredInput(ctx, title, current, signal, validate)
    : requiredValueInput(
        ctx,
        title,
        "git@github.com:owner/private-pi-sync.git (SSH) or https://github.com/owner/private-pi-sync.git (HTTPS)",
        signal,
        validate,
      );
}

async function promptGitDestination(
  ctx: ExtensionCommandContext,
  signal?: AbortSignal,
  current: Partial<PartialConfig> = {},
) {
  const branch = await requiredInput(
    ctx,
    "Git branch for sync snapshots\n\npi-sync manages this entire branch, not your local working branch.\nUse a new branch or one already used by pi-sync; unrelated content is rejected.",
    current.branch ?? "main",
    signal,
    normalizeGitBranch,
  );
  if (!branch) return undefined;
  const directory = await requiredInput(
    ctx,
    "Git storage path\n\nRelative to the repository root, not your local filesystem.\n./ stores manifest.json and files/ at the repository root.",
    current.storagePath ?? "./",
    signal,
    normalizeGitDirectory,
  );
  return directory ? { branch, directory } : undefined;
}
