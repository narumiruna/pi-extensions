import { createHash } from "node:crypto";
import path from "node:path";
import { documentFingerprint } from "../../document.js";
import { backendIdentityCoordinates } from "../backends/backend-identity.js";
import { normalizeGitBranch, normalizeGitDirectory, normalizeGitRemote } from "../backends/git/git-config.js";
import { normalizeWebDavPath, normalizeWebDavUrl } from "../backends/webdav/webdav-config.js";
import { engineHost, getEngineRoot } from "../host.js";
import { compileEffectiveIgnorePolicy, type IgnorePolicyInput } from "../ignore/effective-ignore-policy.js";
import { DEFAULT_IGNORE_FILENAME, readIgnoreSource, validateIgnoreFilename } from "../ignore/ignore-source.js";
import { normalizeSyncExclude } from "../sync/exclude-policy.js";
import { normalizeLocalFields } from "../sync/local-field-policy.js";
import {
  localIgnorePolicyKey,
  normalizeDirectoryRules,
  normalizeSyncInclude,
  type SyncSelectionConfig,
  syncDirectoryPolicyKey,
  syncSessionsSelected,
} from "../sync/sync-policy.js";
import { safeTerminalText } from "../ui/terminal-text.js";
import {
  type LocalConfigDocument,
  localConfigPath,
  readActiveLocalConfigDocumentForRepair,
  withLockedLocalConfigDocument,
} from "./config-file.js";
import { readLocalConfigDocument, requireSettings } from "./settings-store.js";
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

export async function loadConfig(setupName?: string, signal?: AbortSignal): Promise<AnySyncConfig> {
  signal?.throwIfAborted();
  const document = await readLocalConfigDocument();
  if (!document)
    throw new Error(`Missing pi-sync settings. Open /sync and choose Set up sync, or create ${localConfigPath()}.`);
  return operationalConfig(document, setupName, signal);
}

/** A background freshness read must never trigger legacy-file publication. */
export async function loadConfigForCheck(setupName?: string, signal?: AbortSignal): Promise<AnySyncConfig> {
  signal?.throwIfAborted();
  return operationalConfig(await readActiveLocalConfigDocumentForRepair(), setupName, signal);
}

async function operationalConfig(document: LocalConfigDocument | undefined, setupName?: string, signal?: AbortSignal) {
  signal?.throwIfAborted();
  const config = configFromSettings(settingsFromCheckDocument(document), setupName);
  if (!config.reservedIgnoreNames) return config;
  if (engineHost().ignoreFileOperationsAvailable === false) return requireLegacyOperationConfig(config);
  return resolveOperationPolicy(config, setupName, signal, document && { kind: "checked", document });
}

export async function loadSettingsConfig(setupName?: string) {
  const settings = settingsFromCheckDocument(await readActiveLocalConfigDocumentForRepair());
  return { ...configFromSettings(settings, setupName), settingsVersion: settings.version };
}

function settingsFromCheckDocument(document: LocalConfigDocument | undefined) {
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
  return resolveOperationPolicy(configFromSettings(validateSettingsDocument(settings), setupName), setupName, signal);
}

export function createSettingsConfigView(document: LocalConfigDocument) {
  const settings = validateSettingsDocument(document.parsed);
  const ignoreNames = reservedIgnoreFilenames(settings);
  const metadata = (setupName?: string) => projectSettingsConfig(settings, setupName, () => ignoreNames);
  let fingerprint: string | null | undefined;
  return {
    activeSetupName: settings.activeSyncSetup,
    setupNames: Object.keys(settings.syncSetups),
    metadata,
    async observe(setupName?: string, signal?: AbortSignal) {
      signal?.throwIfAborted();
      const config = metadata(setupName);
      if (!config.reservedIgnoreNames) return config;
      if (engineHost().ignoreFileOperationsAvailable === false) return requireLegacyOperationConfig(config);
      fingerprint ??= settingsDocumentFingerprint(document);
      return resolveOperationPolicy(config, setupName, signal, { kind: "view", fingerprint });
    },
  };
}

function settingsDocumentFingerprint(document: LocalConfigDocument | undefined) {
  return documentFingerprint(document && { bytes: document.bytes.toString("base64"), identity: document.identity });
}

type OperationSettingsSource =
  | { kind: "checked"; document: LocalConfigDocument }
  | { kind: "view"; fingerprint: string | null };

async function resolveOperationPolicy(
  config: AnySyncConfig,
  setupName: string | undefined,
  signal: AbortSignal | undefined,
  settingsSource?: OperationSettingsSource,
): Promise<AnySyncConfig> {
  if (!config.reservedIgnoreNames) return config;
  const root = getEngineRoot();
  const validateRoot = () => {
    signal?.throwIfAborted();
    if (root !== getEngineRoot())
      throw new Error("The Pi agent directory changed; reopen the review before continuing.");
  };
  const original = settingsSource?.kind === "checked" ? settingsSource.document : undefined;
  const configDocumentFingerprint =
    settingsSource?.kind === "view" ? settingsSource.fingerprint : original && settingsDocumentFingerprint(original);
  const settingsFingerprint = settingsSource?.kind === "view" ? undefined : syncCheckConfigFingerprint(config);
  const validateSettings = (document: LocalConfigDocument | undefined) => {
    validateRoot();
    if (
      (original &&
        (document?.path !== original.path || settingsDocumentFingerprint(document) !== configDocumentFingerprint)) ||
      settingsFingerprint !==
        syncCheckConfigFingerprint(configFromSettings(settingsFromCheckDocument(document), setupName))
    ) {
      throw new Error("Pi Sync settings changed; reopen the review before continuing.");
    }
  };
  const source =
    config.pathPolicy === "ignore-file" ? await readIgnoreSource(root, config.ignoreFile, signal) : undefined;
  validateRoot();
  if (settingsSource && source && !source.present) {
    throw new Error(
      `Ignore file is missing: ${safeTerminalText(path.join(root, source.filename))}. Create it and reopen Pi Sync; starter rules are only a preview.`,
    );
  }
  if (original && source) validateSettings(await readActiveLocalConfigDocumentForRepair());
  const observed = {
    ...config,
    ...(configDocumentFingerprint ? { configDocumentFingerprint } : {}),
    ...(source ? { ignorePolicy: compileEffectiveIgnorePolicy(source, ignorePolicyInput(config)) } : {}),
    ...(source?.identity ? { ignoreSourceIdentity: source.identity } : {}),
  };
  if (settingsSource?.kind === "view") return observed;
  return {
    ...observed,
    validateIgnorePolicy: async () => {
      validateRoot();
      await withLockedLocalConfigDocument(
        async (document, recheck) => {
          validateSettings(document);
          if (source) {
            const current = await readIgnoreSource(root, source.filename, signal);
            validateRoot();
            recheck();
            if (current.sourceDigest !== source.sourceDigest || current.identity !== source.identity) {
              throw new Error("Pi Sync ignore policy changed; reopen the review before continuing.");
            }
            if (!current.present) {
              throw new Error(
                `Ignore file "${source.filename}" is missing; starter rules can only be used for a preview.`,
              );
            }
          } else {
            recheck();
          }
        },
        signal,
        true,
      );
      validateRoot();
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

function reservedIgnoreFilenames(settings: PiSyncSettingsV3) {
  const names = new Set<string>();
  for (const { sync } of Object.values(settings.syncSetups)) {
    if (sync.pathPolicy === "ignore-file")
      names.add(validateIgnoreFilename(sync.ignoreFile ?? DEFAULT_IGNORE_FILENAME).toLowerCase());
  }
  if (names.size === 0) return undefined;
  names.add(DEFAULT_IGNORE_FILENAME);
  return [...names].sort();
}

export function configFromSettings(settings: PiSyncSettingsV3, setupName?: string): AnySyncConfig {
  return projectSettingsConfig(settings, setupName, () => reservedIgnoreFilenames(settings));
}

function projectSettingsConfig(
  settings: PiSyncSettingsV3,
  setupName: string | undefined,
  getReservedIgnoreNames: () => string[] | undefined,
): AnySyncConfig {
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
  const reservedIgnoreNames = getReservedIgnoreNames();
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
    ...(reservedIgnoreNames ? { reservedIgnoreNames } : {}),
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
  const localPolicy = localIgnorePolicyKey(config);
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
    ...(localPolicy ? [localPolicy] : []),
  ]);
}

export function syncConfigReviewFingerprint(config: AnySyncConfig) {
  return createHash("sha256").update(syncConfigReviewIdentity(config)).digest("hex");
}

/** Internal freshness token, including credentials; never display or persist it. */
export function syncCheckConfigFingerprint(config: AnySyncConfig & { settingsVersion?: PiSyncSettingsV3["version"] }) {
  return createHash("sha256")
    .update(JSON.stringify({ ...config, showStatus: undefined, debug: undefined, settingsVersion: undefined }))
    .digest("hex");
}

export function syncSettingsConfigFingerprint(config: AnySyncConfig) {
  return syncCheckConfigFingerprint({
    ...config,
    configDocumentFingerprint: undefined,
    ignoreSourceIdentity: undefined,
    ignorePolicy: undefined,
  });
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
    ...(policy.maxFileSizeMiB === undefined ? {} : { maxFileSizeMiB: policy.maxFileSizeMiB }),
    ...(policy.maxDirectorySizeMiB === undefined ? {} : { maxDirectorySizeMiB: policy.maxDirectorySizeMiB }),
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
