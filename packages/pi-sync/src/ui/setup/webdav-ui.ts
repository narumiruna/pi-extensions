import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
  normalizeWebDavPath,
  normalizeWebDavUrl,
  validateWebDavCredentials,
} from "../../backends/webdav/webdav-config.js";
import {
  addStorageConnection,
  addSyncSetup,
  saveNewV3Settings,
  updateStorageConnection,
  updateSyncSetup,
} from "../../settings/settings-management.js";
import type { PartialConfig } from "../../settings/settings-types.js";
import { automaticSyncSummary } from "../automatic-sync-summary.js";
import { promptSecret } from "../secret-input.js";
import { safeTerminalText as safe } from "../terminal-text.js";
import { promptAvailableSetupStorage } from "./setup-location-ui.js";
import {
  chooseAutomaticSync,
  chooseSessions,
  chooseSetupContent,
  includedContentLines,
  promptResourceName,
  readSetupConnection,
} from "./setup-prompts.js";
import { saveReviewedDraft } from "./setup-review.js";
import { promptTextInput } from "./text-input.js";

export async function showWebDavSetup(ctx: ExtensionCommandContext, targetName: string, signal?: AbortSignal) {
  const url = await promptWebDavUrl(ctx, signal);
  if (!url) return false;
  const username = await promptUsername(ctx, signal);
  if (!username) return false;
  const password = await promptSecret(ctx, "WebDAV password", { signal });
  signal?.throwIfAborted();
  if (password === undefined) return false;
  const remotePath = await chooseDestination(ctx, signal);
  if (!remotePath) return false;
  const include = await chooseSetupContent(ctx, signal);
  if (!include) return false;
  const automatic = await chooseAutomaticSync(ctx, signal);
  if (automatic === undefined) return false;
  const sessions = await chooseSessions(ctx, signal);
  if (sessions === undefined) return false;
  const saved = await saveReviewedDraft(
    ctx,
    "Review WebDAV setup",
    [
      `Sync setup: ${safe(targetName)}`,
      `Storage connection: ${safe(targetName)} (WebDAV)`,
      `URL: ${safe(url)}`,
      `Storage location: ${safe(remotePath)}`,
      "Username and password: stored privately (values hidden)",
      ...includedContentLines(include, sessions),
      `Automatic sync: ${automaticSyncSummary(automatic)}`,
      "Check setup tests whether this server can safely save sync updates using a temporary probe.",
      "Saving does not contact remote storage or start syncing.",
    ],
    "Save setup",
    (saveSignal) =>
      saveNewV3Settings(
        {
          setupName: targetName,
          connectionName: targetName,
          connection: { type: "webdav", url, credentials: { username, password } },
          setup: {
            storage: { connection: targetName, path: remotePath },
            sync: { include: [...include, ...(sessions ? ["sessions"] : [])], automatic },
          },
        },
        saveSignal,
      ),
    signal,
  );
  if (saved && !signal?.aborted)
    ctx.ui.notify(`Sync setup “${safe(targetName)}” saved. Choose Sync now to start.`, "info");
  return saved;
}

export async function showAddWebDavTarget(
  ctx: ExtensionCommandContext,
  name: string,
  profile: string,
  signal?: AbortSignal,
) {
  const remotePath = await chooseDestination(ctx, signal);
  if (!remotePath) return false;
  const storage = await promptAvailableSetupStorage(ctx, { connection: profile, path: remotePath }, signal);
  if (!storage) return false;
  const include = await chooseSetupContent(ctx, signal);
  if (!include) return false;
  const automatic = await chooseAutomaticSync(ctx, signal);
  if (automatic === undefined) return false;
  const connection = await readSetupConnection(profile, signal);
  if (connection.type !== "webdav") throw new Error("Storage connection changed; reopen setup.");
  const saved = await saveReviewedDraft(
    ctx,
    "Review WebDAV sync setup",
    [
      `Sync setup: ${safe(name)}`,
      `Storage connection: ${safe(profile)}`,
      `URL: ${safe(connection.url)}`,
      `Storage location: ${safe(storage.path)}`,
      ...includedContentLines(include),
      `Automatic sync: ${automaticSyncSummary(automatic)}`,
      "Adding this setup does not sync or modify remote data.",
    ],
    "Add sync setup",
    (saveSignal) => addSyncSetup(name, { storage, sync: { include, automatic } }, saveSignal, connection),
    signal,
  );
  if (saved && !signal?.aborted) ctx.ui.notify(`Added sync setup “${safe(name)}”.`, "info");
  return saved;
}

export async function showEditWebDavTarget(ctx: ExtensionCommandContext, partial: PartialConfig, signal?: AbortSignal) {
  const remotePath = await chooseDestination(ctx, signal, partial.storagePath);
  if (!remotePath) return false;
  const connection = await readSetupConnection(partial.connectionName, signal);
  if (connection.type !== "webdav") throw new Error("Storage connection changed; reopen setup.");
  const saved = await saveReviewedDraft(
    ctx,
    "Review sync setup",
    [
      `Sync setup: ${safe(partial.setupName)}`,
      `Storage connection: ${safe(partial.connectionName)}`,
      `URL: ${safe(connection.url)}`,
      `Storage path: ${safe(partial.storagePath)} → ${safe(remotePath)}`,
      "Saving changes the future storage location only; it does not move or delete remote data.",
    ],
    "Save sync setup",
    (saveSignal) =>
      updateSyncSetup(
        partial.setupName,
        (setup) => ({
          ...setup,
          storage: { ...setup.storage, path: remotePath },
        }),
        { expectedStorage: partial, expectedConnection: connection, signal: saveSignal },
      ),
    signal,
  );
  if (saved && !signal?.aborted) ctx.ui.notify(`Saved sync setup “${safe(partial.setupName)}”.`, "info");
  return saved;
}

export async function showAddWebDavStorageProfile(ctx: ExtensionCommandContext, signal?: AbortSignal) {
  const name = await promptResourceName(ctx, "storage connection", "webdav", signal, true);
  if (!name) return false;
  const url = await promptWebDavUrl(ctx, signal);
  if (!url) return false;
  const username = await promptUsername(ctx, signal);
  if (!username) return false;
  const password = await promptSecret(ctx, "WebDAV password", { signal });
  signal?.throwIfAborted();
  if (password === undefined) return false;
  const saved = await saveReviewedDraft(
    ctx,
    "Review storage connection",
    [
      `Name: ${safe(name)}`,
      "Type: WebDAV",
      `URL: ${safe(url)}`,
      "Username and password: stored privately (values hidden)",
      "Adding a connection does not contact the server or start syncing.",
    ],
    "Add storage connection",
    (saveSignal) =>
      addStorageConnection(name, { type: "webdav", url, credentials: { username, password } }, saveSignal),
    signal,
  );
  if (saved && !signal?.aborted) ctx.ui.notify(`Added storage connection “${safe(name)}”.`, "info");
  return saved;
}

export async function showEditWebDavStorageProfile(
  ctx: ExtensionCommandContext,
  name: string,
  profile: Record<string, unknown>,
  signal?: AbortSignal,
  affectedSetups?: string[],
) {
  const url = await promptWebDavUrl(ctx, signal, typeof profile.url === "string" ? profile.url : undefined);
  if (!url) return false;
  const username = await promptUsername(ctx, signal);
  if (!username) return false;
  const hasPassword = typeof profile.password === "string" && profile.password.length > 0;
  const passwordAction = hasPassword
    ? await select(ctx, "WebDAV password", ["Keep current password", "Replace password", "Cancel"], signal)
    : "Replace password";
  if (!passwordAction || passwordAction === "Cancel") return false;
  const replacePassword = passwordAction === "Replace password";
  const password = replacePassword ? await promptSecret(ctx, "New WebDAV password", { signal }) : undefined;
  signal?.throwIfAborted();
  if (replacePassword && password === undefined) return false;
  const saved = await saveReviewedDraft(
    ctx,
    "Review storage connection",
    [
      `Storage connection: ${safe(name)}`,
      `URL: ${safe(String(profile.url))} → ${safe(url)}`,
      "Username: stored privately (value hidden)",
      `Password: ${replacePassword ? "will be replaced" : "unchanged"} (value hidden)`,
      `Affected sync setups: ${affectedSetups?.length ? affectedSetups.map(safe).join(", ") : "None"}`,
      "Saving changes future storage access for every affected setup; it does not move remote data.",
    ],
    "Save storage connection",
    (saveSignal) =>
      updateStorageConnection(
        name,
        (current) => {
          if (
            current.type !== "webdav" ||
            current.url !== profile.url ||
            current.credentials.username !== profile.username ||
            current.credentials.password !== profile.password
          )
            throw new Error("Storage connection changed while it was open; reopen it.");
          return {
            ...current,
            url,
            credentials: {
              ...current.credentials,
              username,
              password: password ?? current.credentials.password,
            },
          };
        },
        affectedSetups,
        saveSignal,
      ),
    signal,
  );
  if (saved && !signal?.aborted) ctx.ui.notify(`Saved storage connection “${safe(name)}”.`, "info");
  return saved;
}

async function chooseDestination(ctx: ExtensionCommandContext, signal?: AbortSignal, current = "./") {
  return promptTextInput(
    ctx,
    "WebDAV storage path\n\nFolder relative to the collection URL, not your local filesystem.\n./ uses the collection root. Use different folders for independent setups.",
    { defaultValue: current, validate: normalizeWebDavPath },
    signal,
  );
}

async function promptUsername(ctx: ExtensionCommandContext, signal?: AbortSignal) {
  return promptTextInput(
    ctx,
    "WebDAV username\n\nEnter the account username; stored values remain hidden.",
    {
      example: "user",
      validate: (value) => {
        validateWebDavCredentials(value);
        return value;
      },
    },
    signal,
  );
}

async function promptWebDavUrl(ctx: ExtensionCommandContext, signal?: AbortSignal, current?: string) {
  return promptTextInput(
    ctx,
    "WebDAV collection URL\n\nUse the HTTPS WebDAV URL from your provider, not its web login page.",
    {
      ...(current ? { defaultValue: current } : { example: "https://cloud.example.com/remote.php/dav/files/user" }),
      validate: (value) => {
        const url = normalizeWebDavUrl(value);
        if (!url) throw new Error("WebDAV URL is required.");
        return url;
      },
    },
    signal,
  );
}

async function select(ctx: ExtensionCommandContext, title: string, options: string[], signal?: AbortSignal) {
  const value = await ctx.ui.select(title, options, { signal });
  signal?.throwIfAborted();
  return value;
}
