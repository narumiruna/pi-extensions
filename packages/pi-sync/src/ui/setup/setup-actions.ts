import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { refreshTargetCompletions } from "../../commands/setup-completions.js";
import { loadPartialConfig } from "../../settings/config.js";
import { removeSyncSetup } from "../../settings/settings-management.js";
import { readLocalConfigObject } from "../../settings/settings-store.js";
import { ownRecord } from "../../settings/settings-validation.js";
import type { RunRoute } from "../cancellable-operation.js";
import { showAddStorageConnection } from "../storage-connections-ui.js";
import { showSyncSetups } from "../sync-setups-ui.js";
import { safeTerminalText } from "../terminal-text.js";
import { showAddGitTarget, showEditGitTarget } from "./git-ui.js";
import { showAddS3Target, showEditS3Target } from "./s3-ui.js";
import { promptResourceName } from "./setup-prompts.js";
import { showSetupSwitcher } from "./setup-switcher.js";
import { showAddWebDavTarget, showEditWebDavTarget } from "./webdav-ui.js";

export async function showSyncSetupManager(ctx: ExtensionCommandContext, runRoute: RunRoute, signal?: AbortSignal) {
  return showSyncSetups(
    ctx,
    {
      add: async (setupSignal) => {
        await showAddTarget(ctx, setupSignal);
      },
      edit: async (name, setupSignal) => {
        await showEditTarget(ctx, name, setupSignal);
      },
      makeCurrent: async (name, setupSignal) => {
        const result = await showSetupSwitcher(ctx, runRoute, name, setupSignal);
        return result === "pull-attempted" || result === "closed" ? "exit" : undefined;
      },
      remove: async (name, setupSignal) => {
        await showRemoveTarget(ctx, name, setupSignal);
      },
    },
    signal,
  );
}

async function showAddTarget(ctx: ExtensionCommandContext, signal?: AbortSignal) {
  let raw = await readLocalConfigObject();
  if (signal?.aborted) return;
  if (!raw) return void ctx.ui.notify("Set up the first sync setup before adding another.", "info");
  if (raw.version !== 3) {
    ctx.ui.notify("Version 1 and version 2 settings are unsupported and are never migrated.", "error");
    return;
  }
  let profiles = ownRecord(raw.storageConnections) ?? {};
  const name = await promptResourceName(ctx, "sync setup", "work", signal);
  if (!name) return;
  const createConnection = "Add a new storage connection…";
  let profile = await ctx.ui.select(
    "Choose a storage connection\n\nReuse a server address and sign-in details. A new connection is saved separately and remains if you cancel this setup.",
    [...Object.keys(profiles).sort(), createConnection, "Cancel"],
    { signal },
  );
  if (signal?.aborted || !profile || profile === "Cancel") return;
  if (profile === createConnection) {
    const previousNames = new Set(Object.keys(profiles));
    if (!(await showAddStorageConnection(ctx, signal))) return;
    if (signal?.aborted) return;
    raw = (await readLocalConfigObject()) ?? raw;
    if (signal?.aborted) return;
    profiles = ownRecord(raw.storageConnections) ?? {};
    profile = Object.keys(profiles).find((candidate) => !previousNames.has(candidate));
    if (!profile) return;
    ctx.ui.notify(
      `Connection “${safeTerminalText(profile)}” saved. Cancelling setup will keep this connection.`,
      "info",
    );
  }
  const storageKind = ownRecord(profiles[profile])?.type;
  if (storageKind === "webdav") {
    const saved = await showAddWebDavTarget(ctx, name, profile, signal);
    if (signal?.aborted) return;
    if (saved) await refreshTargetCompletions();
    return;
  }
  if (storageKind === "git") {
    const saved = await showAddGitTarget(ctx, name, profile, signal);
    if (signal?.aborted) return;
    if (saved) await refreshTargetCompletions();
    return;
  }
  await showAddS3Target(ctx, raw, profile, name, signal);
}

async function showEditTarget(ctx: ExtensionCommandContext, name: string, signal?: AbortSignal) {
  const partial = await loadPartialConfig(name);
  if (signal?.aborted) return;
  if (!partial.setupName) {
    ctx.ui.notify("Create version 3 settings before editing a named sync setup.", "info");
    return;
  }
  if (partial.storageKind === "webdav") {
    await showEditWebDavTarget(ctx, partial, signal);
    return;
  }
  if (partial.storageKind === "git") {
    await showEditGitTarget(ctx, partial, signal);
    return;
  }
  await showEditS3Target(ctx, partial, signal);
}

async function showRemoveTarget(ctx: ExtensionCommandContext, name: string, signal?: AbortSignal) {
  const confirmed = await ctx.ui.confirm(
    "Remove sync setup?",
    `Remove local sync setup “${safeTerminalText(name)}”? Remote data and history are not deleted.`,
    { signal },
  );
  if (signal?.aborted || !confirmed) return;
  await removeSyncSetup(name, signal);
  if (signal?.aborted) return;
  await refreshTargetCompletions();
  if (signal?.aborted) return;
  ctx.ui.notify(`Removed sync setup “${safeTerminalText(name)}”; remote data was not deleted.`, "info");
}
