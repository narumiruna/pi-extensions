import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { normalizeGitBranch } from "../../backends/git/git-config.js";
import { readLocalConfigObject } from "../../settings/settings-store.js";
import type { StorageConnectionSettings, SyncSetupSettings } from "../../settings/settings-types.js";
import {
  effectiveSyncSetupRemoteIdentity,
  normalizeStoragePath,
  ownRecord,
} from "../../settings/settings-validation.js";
import { errorMessage } from "../../sync/sync-errors.js";
import { safeTerminalText } from "../terminal-text.js";
import { promptTextInput, requiredExistingBucket, requiredInput, requiredValueInput } from "./text-input.js";

interface ChosenRemoteLocation {
  connectionName: string;
  bucket: string;
  path: string;
}

export async function chooseInitialRemoteLocation(
  ctx: ExtensionCommandContext,
  _preset: string,
  setupName: string,
  signal?: AbortSignal,
): Promise<ChosenRemoteLocation | undefined> {
  const choice = await ctx.ui.select(
    "Choose storage location\n\nUse an existing bucket. ./ stores snapshots at the bucket root; a custom path keeps them in a separate folder.",
    ["Use an existing bucket at ./", "Customize remote location", "Cancel"],
    { signal },
  );
  if (signal?.aborted || !choice || choice === "Cancel") return undefined;
  if (choice === "Customize remote location") return chooseCustomRemoteLocation(ctx, setupName, signal);
  const bucket = await requiredExistingBucket(ctx, "pi-sync", signal);
  return bucket ? { connectionName: setupName, bucket, path: "./" } : undefined;
}

export async function chooseAdditionalRemoteLocation(
  ctx: ExtensionCommandContext,
  settings: Record<string, unknown>,
  connectionName: string,
  setupName: string,
  signal?: AbortSignal,
): Promise<Omit<ChosenRemoteLocation, "connectionName"> | undefined> {
  const setups = ownRecord(settings.syncSetups) ?? {};
  const currentSetup = typeof settings.activeSyncSetup === "string" ? settings.activeSyncSetup : undefined;
  const candidates = Object.entries(setups)
    .map(([name, value]) => ({ name, storage: ownRecord(ownRecord(value)?.storage) }))
    .filter(
      (item): item is { name: string; storage: Record<string, unknown> } =>
        item.storage?.connection === connectionName && typeof item.storage.bucket === "string",
    );
  const source =
    candidates.find((item) => item.name === currentSetup) ??
    candidates.sort((left, right) => left.name.localeCompare(right.name))[0];
  if (source) {
    const suggestedPath = "./";
    const sameBucketLabel = `Same bucket as “${safeTerminalText(source.name)}”`;
    const choice = await ctx.ui.select(
      [
        `Storage location for “${safeTerminalText(setupName)}”`,
        "",
        `Existing bucket: ${safeTerminalText(String(source.storage.bucket))}`,
        `Remote path: ${safeTerminalText(suggestedPath)}`,
        "./ uses the bucket root. Use a different path or bucket for independent setups.",
      ].join("\n"),
      [sameBucketLabel, "Use a different bucket", "Customize remote location", "Cancel"],
      { signal },
    );
    if (signal?.aborted || !choice || choice === "Cancel") return undefined;
    if (choice === sameBucketLabel) {
      return { bucket: String(source.storage.bucket), path: suggestedPath };
    }
    if (choice === "Use a different bucket") {
      const bucket = await requiredExistingBucket(ctx, "pi-sync", signal);
      return bucket ? { bucket, path: "./" } : undefined;
    }
    const custom = await chooseCustomRemoteLocation(ctx, connectionName, signal);
    return custom ? { bucket: custom.bucket, path: custom.path } : undefined;
  }

  const location = await chooseInitialRemoteLocation(ctx, "S3", setupName, signal);
  return location ? { bucket: location.bucket, path: location.path } : undefined;
}

async function chooseCustomRemoteLocation(
  ctx: ExtensionCommandContext,
  connectionName: string,
  signal?: AbortSignal,
): Promise<ChosenRemoteLocation | undefined> {
  const bucket = await requiredExistingBucket(ctx, "pi-sync", signal);
  if (!bucket) return undefined;
  const storagePath = await requiredInput(
    ctx,
    "Storage path\n\nPath inside the bucket, not your local filesystem.\n./ uses the bucket root. Use different paths for independent setups.",
    "./",
    signal,
    normalizeStoragePath,
  );
  if (!storagePath) return undefined;
  return { connectionName, bucket, path: normalizeStoragePath(storagePath) };
}

/** Early UI check only; the settings writer still validates uniqueness under its lock. */
export async function promptAvailableSetupStorage<T extends SyncSetupSettings["storage"]>(
  ctx: ExtensionCommandContext,
  initial: T,
  signal?: AbortSignal,
): Promise<T | undefined> {
  let storage = initial;
  while (!signal?.aborted) {
    const settings = await readLocalConfigObject();
    if (signal?.aborted) return undefined;
    const connection = settings?.storageConnections[storage.connection];
    if (!settings || !connection) throw new Error("Storage connection changed; reopen setup.");
    const identity = setupPublicationIdentity(storage, connection);
    const occupied = Object.entries(settings.syncSetups).find(
      ([, setup]) =>
        setupPublicationIdentity(setup.storage, settings.storageConnections[setup.storage.connection]) === identity,
    );
    if (!occupied) return storage;
    const git = connection.type === "git";
    const message = `${git ? "Git branch" : "Storage location"} is already used by “${safeTerminalText(occupied[0])}”. ${git ? "Use a different branch; pi-sync owns the entire branch." : "Enter a different storage path, or cancel to choose another connection or bucket."}`;
    ctx.ui.notify(message, "warning");
    const title = `${git ? "Git branch for the new setup" : "Storage path for the new setup"}\n\n${message}`;
    const example = git ? "pi-sync/work" : "backups/work";
    const value =
      connection.type === "webdav"
        ? await promptTextInput(ctx, title, { example }, signal)
        : await requiredValueInput(ctx, title, example, signal);
    if (signal?.aborted || value === undefined) return undefined;
    try {
      storage = git
        ? { ...storage, branch: normalizeGitBranch(value) }
        : { ...storage, path: normalizeStoragePath(value) };
    } catch (error) {
      ctx.ui.notify(safeTerminalText(errorMessage(error)), "warning");
    }
  }
  return undefined;
}

function setupPublicationIdentity(storage: SyncSetupSettings["storage"], connection: StorageConnectionSettings) {
  // Git publications own a complete branch tree; changing only its directory is not isolation.
  return effectiveSyncSetupRemoteIdentity(
    {
      storage: connection.type === "git" ? { ...storage, path: "./" } : storage,
      sync: { include: [], automatic: false },
    },
    connection,
  );
}
