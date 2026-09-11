import path from "node:path";
import { normalizeEndpointIdentity } from "../backends/backend-identity.js";
import {
  normalizeGitBranch,
  normalizeGitDirectory,
  normalizeGitRemote,
  normalizeGitRemoteIdentity,
} from "../backends/git/git-config.js";
import {
  normalizeWebDavIdentityUrl,
  normalizeWebDavPath,
  normalizeWebDavUrl,
  validateWebDavCredentials,
} from "../backends/webdav/webdav-config.js";
import { normalizeSyncInclude } from "../sync/sync-policy.js";
import { localConfigPath } from "./config-file.js";
import type {
  OnSwitchAction,
  PiSyncSettingsV3,
  StorageConnectionSettings,
  SyncSetupSettings,
} from "./settings-types.js";

export const DEFAULT_ON_SWITCH: OnSwitchAction = "ask-before-pull";

export function normalizeOnSwitch(value: unknown): OnSwitchAction {
  if (value === "ask-before-pull" || value === "pull-after-switch" || value === "switch-only") {
    return value;
  }
  throw new Error(
    'Invalid pi-sync settings: onSwitch must be "ask-before-pull", "pull-after-switch", or "switch-only".',
  );
}

export function validateSettingsDocument(value: Record<string, unknown>): PiSyncSettingsV3 {
  if (value.version !== 3) {
    throw new Error(
      `Unsupported pi-sync settings: version 3 is required. Keep the existing file for recovery, then create a new version 3 ${path.basename(localConfigPath())}; pi-sync will not migrate or overwrite old settings.`,
    );
  }
  rejectLegacyFields(
    value,
    [
      "profiles",
      "targets",
      "activeTarget",
      "targetSwitchAction",
      "endpoint",
      "bucket",
      "region",
      "accessKeyId",
      "secretAccessKey",
      "sessionToken",
      "profile",
      "prefix",
      "autoSync",
      "syncFiles",
      "syncSessions",
      "extraFiles",
    ],
    "top level",
  );
  normalizeOnSwitch(value.onSwitch);
  if (value.skipSecretScan !== undefined && typeof value.skipSecretScan !== "boolean") {
    throw new Error("Invalid pi-sync settings: skipSecretScan must be boolean.");
  }
  const storageConnections = requireNamedObjectMap(
    value.storageConnections,
    "storageConnections",
    "storage connection",
  );
  const syncSetups = requireNamedObjectMap(value.syncSetups, "syncSetups", "sync setup");
  for (const name of Object.keys(storageConnections)) {
    validateStorageConnection(
      name,
      requireOwnObject(storageConnections, name, "storage connection") as Record<string, unknown>,
    );
  }
  for (const name of Object.keys(syncSetups)) {
    validateSyncSetup(
      name,
      requireOwnObject(syncSetups, name, "sync setup") as Record<string, unknown>,
      storageConnections,
    );
  }
  const names = Object.keys(syncSetups);
  const activeSyncSetup = optionalCanonicalReference(value.activeSyncSetup, "activeSyncSetup");
  if (names.length === 0) {
    if (activeSyncSetup !== undefined) {
      throw new Error("Invalid pi-sync settings: empty syncSetups cannot have activeSyncSetup.");
    }
  } else if (!activeSyncSetup || !Object.hasOwn(syncSetups, activeSyncSetup)) {
    throw new Error("Invalid pi-sync settings: activeSyncSetup must reference an existing own-property sync setup.");
  }
  validateUniqueRemoteSyncSetups(syncSetups, storageConnections);
  return value as PiSyncSettingsV3;
}

function validateStorageConnection(name: string, value: Record<string, unknown>) {
  rejectLegacyFields(
    value,
    ["kind", "accessKeyId", "secretAccessKey", "sessionToken", "username", "password"],
    `storage connection “${name}”`,
  );
  const type = requiredString(value.type, `storage connection “${name}” type`);
  if (type !== "s3" && type !== "git" && type !== "webdav") {
    throw new Error(`Invalid pi-sync settings: storage connection “${name}” has unsupported type.`);
  }
  const known = ["endpoint", "region", "remote", "url", "credentials"];
  const allowed =
    type === "s3"
      ? new Set(["endpoint", "region", "credentials"])
      : type === "git"
        ? new Set(["remote"])
        : new Set(["url", "credentials"]);
  if (known.some((field) => Object.hasOwn(value, field) && !allowed.has(field))) {
    throw new Error(
      `Invalid pi-sync settings: ${type.toUpperCase()} storage connection “${name}” mixes backend fields.`,
    );
  }
  if (type === "git") {
    if (!normalizeGitRemote(requiredString(value.remote, `Git remote for “${name}”`))) {
      throw new Error(`Invalid pi-sync settings: Git remote for “${name}” is required.`);
    }
    return;
  }
  const credentials = requireRecord(value.credentials, `credentials for storage connection “${name}”`);
  if (type === "webdav") {
    normalizeWebDavUrl(requiredString(value.url, `WebDAV URL for “${name}”`));
    const username = requiredString(credentials.username, `WebDAV username for “${name}”`);
    const password = requiredSecret(credentials.password, `WebDAV password for “${name}”`);
    if (["accessKeyId", "secretAccessKey", "sessionToken"].some((field) => Object.hasOwn(credentials, field))) {
      throw new Error(`Invalid pi-sync settings: WebDAV credentials for “${name}” mix fields.`);
    }
    validateWebDavCredentials(username, password);
    return;
  }
  normalizeS3Endpoint(requiredString(value.endpoint, `S3 endpoint for “${name}”`));
  requiredString(value.region, `S3 region for “${name}”`);
  requiredString(credentials.accessKeyId, `S3 access key id for “${name}”`);
  requiredSecret(credentials.secretAccessKey, `S3 secret access key for “${name}”`);
  optionalString(credentials.sessionToken, `S3 session token for “${name}”`);
  if (["username", "password"].some((field) => Object.hasOwn(credentials, field))) {
    throw new Error(`Invalid pi-sync settings: S3 credentials for “${name}” mix fields.`);
  }
}

function validateSyncSetup(name: string, value: Record<string, unknown>, connections: Record<string, unknown>) {
  rejectLegacyFields(
    value,
    [
      "profile",
      "bucket",
      "branch",
      "path",
      "prefix",
      "directory",
      "namespace",
      "autoSync",
      "syncFiles",
      "syncSessions",
      "extraFiles",
    ],
    `sync setup “${name}”`,
  );
  const storage = requireRecord(value.storage, `storage for sync setup “${name}”`);
  const sync = requireRecord(value.sync, `sync policy for sync setup “${name}”`);
  rejectLegacyFields(storage, ["profile", "prefix", "directory", "namespace"], `storage for sync setup “${name}”`);
  rejectLegacyFields(
    sync,
    ["autoSync", "syncFiles", "syncSessions", "extraFiles"],
    `sync policy for sync setup “${name}”`,
  );
  const connectionName = requiredCanonicalReference(
    storage.connection,
    `storage connection reference for sync setup “${name}”`,
  );
  validateConfigName(connectionName, "storage connection reference");
  const connection = ownObject<Record<string, unknown>>(connections, connectionName);
  if (!connection) {
    throw new Error(
      `Invalid pi-sync settings: sync setup “${name}” references missing storage connection “${connectionName}”.`,
    );
  }
  const type = connection.type;
  normalizeStoragePath(requiredString(storage.path, `storage path for sync setup “${name}”`));
  if (type === "s3") {
    normalizeS3Bucket(requiredString(storage.bucket, `S3 bucket for sync setup “${name}”`));
    if (Object.hasOwn(storage, "branch")) mixedSetupError("S3", name);
  } else if (type === "git") {
    normalizeGitBranch(requiredString(storage.branch, `Git branch for sync setup “${name}”`));
    if (Object.hasOwn(storage, "bucket")) mixedSetupError("Git", name);
  } else if (type === "webdav") {
    if (Object.hasOwn(storage, "bucket") || Object.hasOwn(storage, "branch")) {
      mixedSetupError("WebDAV", name);
    }
  }
  if (!Object.hasOwn(sync, "include")) {
    throw new Error(`Invalid pi-sync settings: sync setup “${name}” is missing sync.include.`);
  }
  normalizeSyncInclude(sync.include);
  if (typeof sync.automatic !== "boolean") {
    throw new Error(`Invalid pi-sync settings: sync setup “${name}” sync.automatic must be boolean.`);
  }
}

function mixedSetupError(type: string, name: string): never {
  throw new Error(`Invalid pi-sync settings: ${type} sync setup “${name}” mixes backend fields.`);
}

export function validateUniqueRemoteSyncSetups(setups: Record<string, unknown>, connections: Record<string, unknown>) {
  const identities = new Map<string, string>();
  for (const name of Object.keys(setups)) {
    const setup = requireOwnObject(setups, name, "sync setup") as unknown as SyncSetupSettings;
    const connection = requireOwnObject(
      connections,
      setup.storage.connection,
      "storage connection",
    ) as unknown as StorageConnectionSettings;
    const identity = effectiveSyncSetupRemoteIdentity(setup, connection);
    const existing = identities.get(identity);
    if (existing) {
      throw new Error(
        `Invalid pi-sync settings: sync setups “${existing}” and “${name}” use the same normalized remote location.`,
      );
    }
    identities.set(identity, name);
  }
}

export function effectiveSyncSetupRemoteIdentity(setup: SyncSetupSettings, connection: StorageConnectionSettings) {
  const storagePath = normalizeStoragePath(setup.storage.path);
  if (connection.type === "git") {
    return JSON.stringify([
      "git",
      normalizeGitRemoteIdentity(connection.remote),
      normalizeGitBranch(setup.storage.branch),
      normalizeGitDirectory(storagePath),
    ]);
  }
  if (connection.type === "webdav") {
    return JSON.stringify([
      "webdav",
      normalizeWebDavIdentityUrl(connection.url),
      connection.credentials.username.trim(),
      normalizeWebDavPath(storagePath),
    ]);
  }
  return JSON.stringify([
    "s3",
    normalizeEndpointIdentity(connection.endpoint),
    normalizeS3Bucket(setup.storage.bucket),
    storagePath,
  ]);
}

function rejectLegacyFields(value: Record<string, unknown>, fields: readonly string[], context: string) {
  const field = fields.find((candidate) => Object.hasOwn(value, candidate));
  if (field) {
    throw new Error(`Invalid pi-sync settings: ${context} contains unsupported version 1/2 field “${field}”.`);
  }
}

function requireNamedObjectMap(value: unknown, field: string, itemLabel: string) {
  const result = requireRecord(value, field);
  for (const name of Object.keys(result)) validateConfigName(name, itemLabel);
  return result;
}

function requireOwnObject(value: Record<string, unknown>, key: string, label: string) {
  const item = ownObject(value, key);
  if (!item) throw new Error(`Invalid pi-sync settings: ${label} “${key}” must be an object.`);
  return item;
}

export function ownObject<T extends object>(value: Record<string, unknown>, key: string): T | undefined {
  if (!Object.hasOwn(value, key)) return undefined;
  const item = value[key];
  return item && typeof item === "object" && !Array.isArray(item) ? (item as T) : undefined;
}

function requireRecord(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Invalid pi-sync settings: ${field} must be an object.`);
  }
  return value as Record<string, unknown>;
}

export function validateConfigName(value: string, field: string) {
  if (
    !value.trim() ||
    value !== value.trim() ||
    value.length > 100 ||
    value === "__proto__" ||
    value === "prototype" ||
    value === "constructor" ||
    hasControlCharacter(value)
  ) {
    throw new Error(`Invalid pi-sync settings: invalid ${field} name.`);
  }
}

export function requiredString(value: unknown, field: string) {
  if (typeof value !== "string" || !value.trim() || hasControlCharacter(value)) {
    throw new Error(`Invalid pi-sync settings: ${field} must be a non-empty string.`);
  }
  return value.trim();
}

function requiredCanonicalReference(value: unknown, field: string) {
  const normalized = requiredString(value, field);
  if (value !== normalized) {
    throw new Error(`Invalid pi-sync settings: ${field} must not have surrounding whitespace.`);
  }
  return normalized;
}

function optionalCanonicalReference(value: unknown, field: string) {
  const normalized = optionalString(value, field);
  if (normalized !== undefined && value !== normalized) {
    throw new Error(`Invalid pi-sync settings: ${field} must not have surrounding whitespace.`);
  }
  return normalized;
}

function requiredSecret(value: unknown, field: string) {
  if (typeof value !== "string" || !value || hasControlCharacter(value)) {
    throw new Error(`Invalid pi-sync settings: ${field} must be configured.`);
  }
  return value;
}

export function optionalString(value: unknown, field: string) {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || hasControlCharacter(value)) {
    throw new Error(`Invalid pi-sync settings: ${field} must be a string.`);
  }
  return value.trim() || undefined;
}

export function normalizeStoragePath(value: string) {
  if (value.trim() === "." || value.trim() === "./") return "./";
  const normalized = value.trim().replace(/^\/+|\/+$/gu, "");
  if (
    !normalized ||
    normalized.length > 1024 ||
    normalized.startsWith("-") ||
    normalized.includes("\\") ||
    hasControlCharacter(normalized) ||
    normalized.split("/").some((segment) => !segment || segment === "." || segment === "..")
  ) {
    throw new Error("Invalid pi-sync settings: storage.path must be a safe relative path.");
  }
  return normalized;
}

export function normalizeS3Endpoint(value: string) {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error("Invalid pi-sync S3 endpoint.");
  }
  const loopback = url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "[::1]";
  if (
    (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error("Invalid pi-sync S3 endpoint: HTTPS is required except for loopback.");
  }
  url.pathname = url.pathname.replace(/\/+$/gu, "");
  return url.toString().replace(/\/$/u, "");
}

export function normalizeS3Bucket(value: string | undefined) {
  const bucket = requiredString(value, "S3 bucket");
  if (bucket.includes("/") || bucket.includes("\\") || bucket.startsWith("-")) {
    throw new Error("Invalid pi-sync S3 bucket.");
  }
  return bucket;
}

function hasControlCharacter(value: string) {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: Stored settings cannot contain controls.
  return /[\u0000-\u001f\u007f-\u009f]/u.test(value);
}

export function isCloudflareR2Endpoint(endpoint: string | undefined) {
  const value = endpoint?.trim();
  if (!value) return false;
  try {
    const hostname = new URL(value).hostname.toLowerCase();
    return hostname === "r2.cloudflarestorage.com" || hostname.endsWith(".r2.cloudflarestorage.com");
  } catch {
    return false;
  }
}

export function ownRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}
