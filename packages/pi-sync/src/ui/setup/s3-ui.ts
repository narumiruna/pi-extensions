import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { refreshTargetCompletions } from "../../commands/setup-completions.js";
import { addSyncSetup, saveNewV3Settings, updateSyncSetup } from "../../settings/settings-management.js";
import type { PartialConfig } from "../../settings/settings-types.js";
import { normalizeS3Bucket, normalizeS3Endpoint, normalizeStoragePath } from "../../settings/settings-validation.js";
import { automaticSyncSummary } from "../automatic-sync-summary.js";
import { safeTerminalText } from "../terminal-text.js";
import { chooseS3Credentials } from "./s3-credentials-ui.js";
import {
  chooseAdditionalRemoteLocation,
  chooseInitialRemoteLocation,
  promptAvailableSetupStorage,
} from "./setup-location-ui.js";
import {
  chooseAutomaticSync,
  chooseSessions,
  chooseSetupContent,
  includedContentLines,
  readSetupConnection,
} from "./setup-prompts.js";
import { saveReviewedDraft } from "./setup-review.js";
import { requiredInput, requiredValueInput } from "./text-input.js";

export async function showS3Setup(
  ctx: ExtensionCommandContext,
  preset: string,
  targetName: string,
  signal?: AbortSignal,
) {
  const endpoint = await requiredValueInput(
    ctx,
    preset === "Cloudflare R2"
      ? "Cloudflare R2 endpoint\n\nCopy the S3 API endpoint from your R2 account; replace <account-id>."
      : "S3-compatible endpoint\n\nUse your provider's S3 API URL, not its web console.",
    preset === "Cloudflare R2" ? "https://<account-id>.r2.cloudflarestorage.com" : "https://s3.example.com",
    signal,
    normalizeS3Endpoint,
  );
  if (!endpoint) return false;
  const region =
    preset === "Cloudflare R2"
      ? "auto"
      : await requiredInput(
          ctx,
          "Storage region\n\nUse the region assigned to your bucket by the provider.",
          "us-east-1",
          signal,
        );
  if (!region) return false;
  const location = await chooseInitialRemoteLocation(ctx, preset, targetName, signal);
  if (!location) return false;
  const credentials = await chooseS3Credentials(ctx, signal);
  if (!credentials) return false;
  const include = await chooseSetupContent(ctx, signal);
  if (!include) return false;
  const automatic = await chooseAutomaticSync(ctx, signal);
  if (automatic === undefined) return false;
  const sessions = await chooseSessions(ctx, signal);
  if (sessions === undefined) return false;
  const saved = await saveReviewedDraft(
    ctx,
    "Review sync setup",
    [
      `Sync setup: ${safeTerminalText(targetName)}`,
      `Storage connection: ${safeTerminalText(location.connectionName)} (${preset})`,
      `Endpoint: ${safeTerminalText(endpoint)}`,
      `Region: ${safeTerminalText(region)}`,
      `Bucket: ${safeTerminalText(location.bucket)}`,
      `Storage location: ${safeTerminalText(location.path)}`,
      ...includedContentLines(include, sessions),
      `Automatic sync: ${automaticSyncSummary(automatic)}`,
      `Credentials: ${credentials.summary}`,
      "The bucket must already exist. Saving does not contact remote storage or start syncing.",
    ],
    "Save sync setup",
    (saveSignal) =>
      saveNewV3Settings(
        {
          setupName: targetName,
          connectionName: location.connectionName,
          connection: {
            type: "s3",
            endpoint,
            region,
            credentials: {
              accessKeyId: credentials.profileFields.accessKeyId ?? "",
              secretAccessKey: credentials.profileFields.secretAccessKey ?? "",
            },
          },
          setup: {
            storage: {
              connection: location.connectionName,
              bucket: location.bucket,
              path: location.path,
            },
            sync: { include: [...include, ...(sessions ? ["sessions"] : [])], automatic },
          },
        },
        saveSignal,
      ),
    signal,
  );
  if (!saved || signal?.aborted) return false;
  await refreshTargetCompletions();
  if (!signal?.aborted)
    ctx.ui.notify(`Sync setup “${safeTerminalText(targetName)}” saved. Choose Sync now to start.`, "info");
  return true;
}

export async function showAddS3Target(
  ctx: ExtensionCommandContext,
  raw: Record<string, unknown>,
  profile: string,
  name: string,
  signal?: AbortSignal,
) {
  const location = await chooseAdditionalRemoteLocation(ctx, raw, profile, name, signal);
  if (!location) return;
  const storage = await promptAvailableSetupStorage(ctx, { connection: profile, ...location }, signal);
  if (!storage) return;
  const include = await chooseSetupContent(ctx, signal);
  if (!include) return;
  const automatic = await chooseAutomaticSync(ctx, signal);
  if (automatic === undefined) return;
  const connection = await readSetupConnection(profile, signal);
  if (connection.type !== "s3") throw new Error("Storage connection changed; reopen setup.");
  const saved = await saveReviewedDraft(
    ctx,
    "Review new sync setup",
    [
      `Sync setup: ${safeTerminalText(name)}`,
      `Storage connection: ${safeTerminalText(profile)}`,
      `Endpoint: ${safeTerminalText(connection.endpoint)}`,
      `Bucket: ${safeTerminalText(storage.bucket)}`,
      `Storage location: ${safeTerminalText(storage.path)}`,
      ...includedContentLines(include),
      `Automatic sync: ${automaticSyncSummary(automatic)}`,
      "Only the current setup is checked at startup. Shutdown can push selected content when sessions are included.",
      "The bucket must already exist. Adding this setup does not sync or modify remote data.",
    ],
    "Add sync setup",
    (saveSignal) => addSyncSetup(name, { storage, sync: { include, automatic } }, saveSignal, connection),
    signal,
  );
  if (!saved || signal?.aborted) return;
  await refreshTargetCompletions();
  if (!signal?.aborted) ctx.ui.notify(`Added sync setup “${safeTerminalText(name)}”.`, "info");
}

export async function showEditS3Target(ctx: ExtensionCommandContext, partial: PartialConfig, signal?: AbortSignal) {
  const bucket = await requiredInput(
    ctx,
    "Bucket\n\nUse an existing bucket; pi-sync will not create it.",
    partial.bucket ?? "pi-sync",
    signal,
    normalizeS3Bucket,
  );
  if (!bucket) return;
  const storagePath = await requiredInput(
    ctx,
    "Storage path\n\nPath inside the bucket, not your local filesystem. ./ uses the bucket root.",
    partial.storagePath,
    signal,
    normalizeStoragePath,
  );
  if (!storagePath) return;
  const connection = await readSetupConnection(partial.connectionName, signal);
  if (connection.type !== "s3") throw new Error("Storage connection changed; reopen setup.");
  const saved = await saveReviewedDraft(
    ctx,
    "Review sync setup",
    [
      `Sync setup: ${safeTerminalText(partial.setupName)}`,
      `Storage connection: ${safeTerminalText(partial.connectionName)}`,
      `Endpoint: ${safeTerminalText(connection.endpoint)}`,
      `Bucket: ${safeTerminalText(partial.bucket ?? "missing")} → ${safeTerminalText(bucket)}`,
      `Storage path: ${safeTerminalText(partial.storagePath)} → ${safeTerminalText(storagePath)}`,
      "Saving changes the future storage location only; it does not move or delete remote data.",
    ],
    "Save sync setup",
    (saveSignal) =>
      updateSyncSetup(
        partial.setupName,
        (setup) => {
          if (typeof setup.storage.bucket !== "string") throw new Error("Sync setup storage type changed; reopen it.");
          return { ...setup, storage: { ...setup.storage, bucket, path: storagePath } };
        },
        { expectedStorage: partial, expectedConnection: connection, signal: saveSignal },
      ),
    signal,
  );
  if (saved && !signal?.aborted) ctx.ui.notify(`Saved sync setup “${safeTerminalText(partial.setupName)}”.`, "info");
}
