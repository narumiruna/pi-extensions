import { createHash } from "node:crypto";
import { backendIdentityCoordinates } from "../backends/backend-identity.js";
import { normalizeGitBranch, normalizeGitDirectory, normalizeGitRemote } from "../backends/git/git-config.js";
import { normalizeWebDavPath, normalizeWebDavUrl } from "../backends/webdav/webdav-config.js";
import { getEngineRoot } from "../host.js";
import { type IgnorePolicyInput, loadEffectiveIgnorePolicy } from "../ignore/effective-ignore-policy.js";
import { DEFAULT_IGNORE_FILENAME, readIgnoreSource, validateIgnoreFilename } from "../ignore/ignore-source.js";
import { normalizeSyncExclude } from "../sync/exclude-policy.js";
import { normalizeLocalFields } from "../sync/local-field-policy.js";
import {
  normalizeDirectoryRules,
  normalizeSyncInclude,
  type SyncSelectionConfig,
  syncDirectoryPolicyKey,
  syncSessionsSelected,
} from "../sync/sync-policy.js";
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
  return requireLegacyOperationConfig(configFromSettings(await requireSettings(), setupName));
}

/** A background freshness read must never trigger legacy-file publication. */
export async function loadConfigForCheck(): Promise<AnySyncConfig> {
  return requireLegacyOperationConfig(configFromSettings(await readSettingsForCheck()));
}

async function readSettingsForCheck() {
  const document = await readActiveLocalConfigDocumentForRepair();
  if (!document) throw new Error(`Missing pi-sync settings: ${localConfigPath()}`);
  return validateSettingsDocument(document.parsed);
}

export function requireLegacyOperationConfig(config: AnySyncConfig): AnySyncConfig {
  if (config.pathPolicy === "ignore-file" || config.ignorePolicy || config.reservedIgnoreNames !== undefined) {
    throw new Error("This Pi Sync operation does not yet support settings with ignore-file policies.");
  }
  return config;
}

export async function resolveIgnoreConfig(
  settings: PiSyncSettingsV3,
  setupName?: string,
  signal?: AbortSignal,
): Promise<AnySyncConfig> {
  signal?.throwIfAborted();
  const config = configFromSettings(validateSettingsDocument(settings), setupName);
  if (config.pathPolicy !== "ignore-file") return requireLegacyOperationConfig(config);
  const root = getEngineRoot();
  const validateRoot = () => {
    if (root !== getEngineRoot())
      throw new Error("The Pi agent directory changed; reopen the review before continuing.");
  };
  const settingsFingerprint = syncCheckConfigFingerprint(config);
  const ignorePolicy = await loadEffectiveIgnorePolicy(root, ignorePolicyInput(config), signal);
  signal?.throwIfAborted();
  validateRoot();
  return {
    ...config,
    ignorePolicy,
    validateIgnorePolicy: async () => {
      signal?.throwIfAborted();
      const current = configFromSettings(await readSettingsForCheck(), setupName);
      signal?.throwIfAborted();
      validateRoot();
      if (settingsFingerprint !== syncCheckConfigFingerprint(current)) {
        throw new Error("Pi Sync settings changed; reopen the review before continuing.");
      }
      const source = await readIgnoreSource(root, current.ignoreFile, signal);
      signal?.throwIfAborted();
      validateRoot();
      if (source.sourceDigest !== ignorePolicy.sourceDigest) {
        throw new Error("Pi Sync ignore policy changed; reopen the review before continuing.");
      }
      if (!source.present) {
        throw new Error(`Ignore file "${source.filename}" is missing; starter rules can only be used for a preview.`);
      }
    },
  };
}

function ignorePolicyInput(config: AnySyncConfig): IgnorePolicyInput {
  return {
    filename: config.ignoreFile,
    sessions: config.include.includes("sessions"),
    configuredFilenames: config.reservedIgnoreNames ?? [],
  };
}

export function configFromSettings(settings: PiSyncSettingsV3, setupName?: string): AnySyncConfig {
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
  const ignoreNames = new Set<string>();
  for (const { sync } of Object.values(settings.syncSetups)) {
    if (sync.pathPolicy === "ignore-file")
      ignoreNames.add(validateIgnoreFilename(sync.ignoreFile ?? DEFAULT_IGNORE_FILENAME).toLowerCase());
  }
  if (ignoreNames.size > 0) ignoreNames.add(DEFAULT_IGNORE_FILENAME);
  return {
    ...resolveSyncConfig(
      selectedName,
      setup,
      connectionName,
      connection,
      settings.onSwitch,
      settings.skipSecretScan ?? false,
      settings.showStatus ?? true,
    ),
    debug: settings.debug ?? false,
    ...(ignoreNames.size > 0 ? { reservedIgnoreNames: [...ignoreNames].sort() } : {}),
  };
}

export type SyncSetupStorageReview = Pick<
  PartialConfig,
  "connectionName" | "storageKind" | "storagePath" | "bucket" | "branch"
>;

/** A validated setup-facing projection used by manager and settings UI. */
export async function loadPartialConfig(setupName?: string): Promise<PartialConfig> {
  const config = configFromSettings(await requireSettings(), setupName);
  return {
    setupName: config.setupName,
    ...storageReviewFromConfig(config),
    include: [...config.include],
    ...(config.scope === undefined ? {} : { scope: config.scope }),
    ...(config.pathPolicy === undefined ? {} : { pathPolicy: config.pathPolicy, ignoreFile: config.ignoreFile }),
    ...(config.exclude === undefined ? {} : { exclude: [...config.exclude] }),
    ...(config.reinclude === undefined ? {} : { reinclude: [...config.reinclude] }),
    automatic: config.automatic,
    automaticTransfer: config.automaticTransfer ?? false,
    agentMode: config.agentMode ?? false,
    continuous: config.continuous ?? false,
    onSwitch: config.onSwitch,
    showStatus: config.showStatus,
  };
}

export function syncSetupStorageReview(
  setupName: string,
  setup: SyncSetupSettings,
  connectionName: string,
  connection: StorageConnectionSettings,
): SyncSetupStorageReview {
  return storageReviewFromConfig(
    resolveSyncConfig(setupName, setup, connectionName, connection, DEFAULT_ON_SWITCH, false, true),
  );
}

export function syncSetupReviewIdentity(
  setupName: string,
  setup: SyncSetupSettings,
  connectionName: string,
  connection: StorageConnectionSettings,
) {
  return syncConfigReviewIdentity(
    resolveSyncConfig(setupName, setup, connectionName, connection, DEFAULT_ON_SWITCH, false, true),
  );
}

export function syncConfigReviewIdentity(config: AnySyncConfig) {
  const directoryPolicy =
    config.pathPolicy === "ignore-file" && !config.ignorePolicy
      ? JSON.stringify([config.pathPolicy, config.ignoreFile])
      : syncDirectoryPolicyKey(config);
  return JSON.stringify([
    config.setupName,
    config.connectionName,
    backendIdentityCoordinates(config),
    config.include,
    config.automatic,
    config.automaticTransfer ?? false,
    config.agentMode ?? false,
    config.localFields,
    config.mergeSettings ?? false,
    config.mergeContent ?? false,
    config.partialSync ?? false,
    // Preserve existing Off identities and cached candidates across the upgrade.
    ...(config.continuous ? ["continuous"] : []),
    ...(directoryPolicy !== undefined
      ? [directoryPolicy]
      : config.exclude === undefined
        ? []
        : ["exclude", normalizeSyncExclude(config.exclude).map((rule) => rule.toLowerCase())]),
  ]);
}

export function syncConfigReviewFingerprint(config: AnySyncConfig) {
  return createHash("sha256").update(syncConfigReviewIdentity(config)).digest("hex");
}

/** Internal freshness token, including credentials; never display or persist it. */
export function syncCheckConfigFingerprint(config: AnySyncConfig) {
  return createHash("sha256")
    .update(JSON.stringify({ ...config, showStatus: undefined, debug: undefined }))
    .digest("hex");
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
  showStatus: boolean,
): AnySyncConfig {
  const storagePath = normalizeStoragePath(setup.storage.path);
  const namespace = storagePath === "./" ? "root" : storagePath.slice(storagePath.lastIndexOf("/") + 1);
  const policy = setup.sync;
  const selection =
    policy.scope === "agent-directory"
      ? {
          scope: policy.scope,
          include: policy.sessions ? ["sessions"] : [],
          ...(policy.pathPolicy === "ignore-file"
            ? {
                pathPolicy: policy.pathPolicy,
                ignoreFile: validateIgnoreFilename(policy.ignoreFile ?? DEFAULT_IGNORE_FILENAME),
              }
            : {}),
          ...(policy.exclude === undefined ? {} : { exclude: normalizeDirectoryRules(policy.exclude) }),
          ...(policy.reinclude === undefined ? {} : { reinclude: normalizeDirectoryRules(policy.reinclude) }),
        }
      : {
          include: normalizeSyncInclude(policy.include),
          ...(policy.exclude === undefined ? {} : { exclude: normalizeSyncExclude(policy.exclude) }),
        };
  const common = {
    setupName,
    connectionName,
    storagePath,
    snapshotIdentity: namespace,
    ...selection,
    automatic: setup.sync.automatic,
    automaticTransfer: setup.sync.automaticTransfer ?? false,
    agentMode: setup.sync.agentMode ?? false,
    continuous: setup.sync.continuous ?? false,
    localFields: setup.sync.localFields === undefined ? undefined : normalizeLocalFields(setup.sync.localFields),
    mergeSettings: setup.sync.mergeSettings ?? false,
    mergeContent: setup.sync.mergeContent ?? false,
    partialSync: setup.sync.partialSync ?? false,
    onSwitch,
    skipSecretScan,
    showStatus,
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

export function syncSessionsWarnings(config: SyncSelectionConfig) {
  if (!syncSessionsSelected(config)) return [];
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
