import { createHash } from "node:crypto";
import { backendIdentityCoordinates } from "../backends/backend-identity.js";
import { normalizeGitBranch, normalizeGitDirectory, normalizeGitRemote } from "../backends/git/git-config.js";
import { normalizeWebDavPath, normalizeWebDavUrl } from "../backends/webdav/webdav-config.js";
import { normalizeSyncInclude } from "../sync/sync-policy.js";
import { localConfigPath, readActiveLocalConfigDocumentForRepair } from "./config-file.js";
import { requireSettings } from "./settings-store.js";
import type {
  AnySyncConfig,
  OnSwitchAction,
  PartialConfig,
  PiSyncSettingsV3,
  StorageConnectionSettings,
  SyncSetupSettings,
} from "./settings-types.js";
import {
  DEFAULT_ON_SWITCH,
  isCloudflareR2Endpoint,
  normalizeS3Bucket,
  normalizeS3Endpoint,
  normalizeStoragePath,
  optionalString,
  ownObject,
  requiredString,
  validateConfigName,
  validateSettingsDocument,
} from "./settings-validation.js";

export async function loadConfig(setupName?: string): Promise<AnySyncConfig> {
  return configFromSettings(await requireSettings(), setupName);
}

/** A background freshness read must never trigger legacy-file publication. */
export async function loadConfigForCheck(): Promise<AnySyncConfig> {
  const document = await readActiveLocalConfigDocumentForRepair();
  if (!document) throw new Error(`Missing pi-sync settings: ${localConfigPath()}`);
  validateSettingsDocument(document.parsed);
  return configFromSettings(document.parsed as PiSyncSettingsV3);
}

function configFromSettings(settings: PiSyncSettingsV3, setupName?: string): AnySyncConfig {
  const selectedName = setupName ?? settings.activeSyncSetup;
  if (!selectedName) throw new Error("No sync setups are configured.");
  validateConfigName(selectedName, "sync setup");
  const setup = ownObject<SyncSetupSettings>(settings.syncSetups, selectedName);
  if (!setup) throw new Error(`Invalid pi-sync settings: sync setup “${selectedName}” was not found.`);
  const connectionName = setup.storage.connection;
  const connection = ownObject<StorageConnectionSettings>(settings.storageConnections, connectionName);
  if (!connection) {
    throw new Error(
      `Invalid pi-sync settings: sync setup “${selectedName}” references missing storage connection “${connectionName}”.`,
    );
  }
  return resolveSyncConfig(
    selectedName,
    setup,
    connectionName,
    connection,
    settings.onSwitch,
    settings.skipSecretScan ?? false,
  );
}

export type SyncSetupStorageReview = Pick<
  PartialConfig,
  "connectionName" | "storageKind" | "storagePath" | "bucket" | "branch"
>;

/** A validated setup-facing projection used by manager and settings UI. */
export async function loadPartialConfig(setupName?: string): Promise<PartialConfig> {
  const config = await loadConfig(setupName);
  return {
    setupName: config.setupName,
    ...storageReviewFromConfig(config),
    include: [...config.include],
    automatic: config.automatic,
    onSwitch: config.onSwitch,
  };
}

export function syncSetupStorageReview(
  setupName: string,
  setup: SyncSetupSettings,
  connectionName: string,
  connection: StorageConnectionSettings,
): SyncSetupStorageReview {
  return storageReviewFromConfig(
    resolveSyncConfig(setupName, setup, connectionName, connection, DEFAULT_ON_SWITCH, false),
  );
}

export function syncSetupReviewIdentity(
  setupName: string,
  setup: SyncSetupSettings,
  connectionName: string,
  connection: StorageConnectionSettings,
) {
  return syncConfigReviewIdentity(
    resolveSyncConfig(setupName, setup, connectionName, connection, DEFAULT_ON_SWITCH, false),
  );
}

export function syncConfigReviewIdentity(config: AnySyncConfig) {
  return JSON.stringify([
    config.setupName,
    config.connectionName,
    backendIdentityCoordinates(config),
    config.include,
    config.automatic,
  ]);
}

export function syncConfigReviewFingerprint(config: AnySyncConfig) {
  return createHash("sha256").update(syncConfigReviewIdentity(config)).digest("hex");
}

/** Internal freshness token, including credentials; never display or persist it. */
export function syncCheckConfigFingerprint(config: AnySyncConfig) {
  return createHash("sha256").update(JSON.stringify(config)).digest("hex");
}

function storageReviewFromConfig(config: AnySyncConfig): SyncSetupStorageReview {
  return {
    connectionName: config.connectionName,
    storageKind: config.backend.type,
    storagePath: config.storagePath,
    ...(config.backend.type === "s3"
      ? { bucket: config.backend.destination.bucket }
      : config.backend.type === "git"
        ? { branch: config.backend.destination.branch }
        : {}),
  };
}

function resolveSyncConfig(
  setupName: string,
  setup: SyncSetupSettings,
  connectionName: string,
  connection: StorageConnectionSettings,
  onSwitch: OnSwitchAction,
  skipSecretScan: boolean,
): AnySyncConfig {
  const storagePath = normalizeStoragePath(setup.storage.path);
  const namespace = storagePath === "./" ? "root" : storagePath.slice(storagePath.lastIndexOf("/") + 1);
  const include = normalizeSyncInclude(setup.sync.include);
  const common = {
    setupName,
    connectionName,
    storagePath,
    snapshotIdentity: namespace,
    include,
    automatic: setup.sync.automatic,
    onSwitch,
    skipSecretScan,
  };
  if (connection.type === "git") {
    return {
      ...common,
      backend: {
        type: "git",
        profile: { kind: "git", remote: normalizeGitRemote(connection.remote) as string },
        destination: {
          branch: normalizeGitBranch(setup.storage.branch),
          directory: normalizeGitDirectory(storagePath),
          namespace,
        },
      },
    };
  }
  if (connection.type === "webdav") {
    return {
      ...common,
      backend: {
        type: "webdav",
        profile: {
          kind: "webdav",
          url: normalizeWebDavUrl(connection.url) as string,
          username: connection.credentials.username,
          password: connection.credentials.password,
        },
        destination: { path: normalizeWebDavPath(storagePath), namespace },
      },
    };
  }
  return {
    ...common,
    backend: {
      type: "s3",
      profile: {
        kind: isCloudflareR2Endpoint(connection.endpoint) ? "r2" : "s3-compatible",
        endpoint: normalizeS3Endpoint(connection.endpoint),
        region: requiredString(connection.region, "S3 region"),
        accessKeyId: connection.credentials.accessKeyId,
        secretAccessKey: connection.credentials.secretAccessKey,
        sessionToken: optionalString(connection.credentials.sessionToken, "S3 session token"),
      },
      destination: {
        bucket: normalizeS3Bucket(setup.storage.bucket),
        prefix: storagePath,
        namespace,
      },
    },
  };
}

export function sessionTokenWarnings(config: { endpoint?: string; sessionToken?: string }) {
  if (!isCloudflareR2Endpoint(config.endpoint) || !config.sessionToken) return [];
  return [
    "session token: configured for Cloudflare R2; if R2 rejects X-Amz-Security-Token, pi-sync retries once without it. R2 static access keys usually do not need a session token.",
  ];
}

export function syncSessionsWarnings(config: { include: readonly string[] }) {
  if (!config.include.includes("sessions")) return [];
  return [
    "sessions: included; Pi session JSONL can contain prompts, tool output, file paths, images, and secrets. Sync sessions only to storage you trust.",
  ];
}

export function isEnabled(value: boolean | string | undefined, defaultValue: boolean) {
  if (value === undefined) return defaultValue;
  if (typeof value === "boolean") return value;
  return !["0", "false", "no", "off"].includes(value.trim().toLowerCase());
}

export function isExplicitlyEnabled(value: boolean | string | undefined) {
  if (typeof value === "boolean") return value;
  return ["1", "true", "yes", "on"].includes(value?.trim().toLowerCase() ?? "");
}
