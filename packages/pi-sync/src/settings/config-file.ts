import { randomUUID } from "node:crypto";
import {
  mkdir,
  mkdirSync,
  realpath,
  realpathSync,
  rmdir,
  rmdirSync,
  stat,
  statSync,
  utimes,
  utimesSync,
} from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import lockfile from "proper-lockfile";

const CONFIG_FILE_NAME = "pi-sync.json";
const LEGACY_CONFIG_FILE_NAME = "pi-sync.local.json";
const configMigrationNotices = new Map<string, string>();
const legacyPresenceNoticed = new Set<string>();
const CONFIG_LOCK_STALE_MS = 30_000;
const CONFIG_LOCK_UPDATE_MS = 10_000;
const LOCKFILE_FS_ADAPTER = {
  mkdir,
  mkdirSync,
  realpath,
  realpathSync,
  rmdir,
  rmdirSync,
  stat,
  statSync,
  utimes,
  utimesSync,
};

type PublishFile = (
  source: string,
  destination: string,
  expected?: LocalConfigDocument,
  signal?: AbortSignal,
) => Promise<void>;
let configUpdateQueue: Promise<void> = Promise.resolve();
let publishConfigFile: PublishFile = publishFileWithGuard;
let beforeConfigPublicationHook: () => Promise<void> = async () => undefined;
let afterMissingConfigReadProbeHook: () => Promise<void> = async () => undefined;
let afterReplacementInstalledHook: () => Promise<void> = async () => undefined;
let afterConfigQuarantinedHook: () => Promise<void> = async () => undefined;

export type FileIdentity = { dev: number; ino: number };

export async function withConfigFilePublicationForTest<T>(publish: PublishFile, run: () => Promise<T>): Promise<T> {
  const previous = publishConfigFile;
  publishConfigFile = publish;
  try {
    return await run();
  } finally {
    publishConfigFile = previous;
  }
}

export async function withConfigPublicationReadyHookForTest<T>(
  hook: () => Promise<void>,
  run: () => Promise<T>,
): Promise<T> {
  const previous = beforeConfigPublicationHook;
  beforeConfigPublicationHook = hook;
  try {
    return await run();
  } finally {
    beforeConfigPublicationHook = previous;
  }
}

export async function withMissingConfigReadProbeHookForTest<T>(
  hook: () => Promise<void>,
  run: () => Promise<T>,
): Promise<T> {
  const previous = afterMissingConfigReadProbeHook;
  afterMissingConfigReadProbeHook = hook;
  try {
    return await run();
  } finally {
    afterMissingConfigReadProbeHook = previous;
  }
}

export async function withConfigReplacementInstalledHookForTest<T>(
  hook: () => Promise<void>,
  run: () => Promise<T>,
): Promise<T> {
  const previous = afterReplacementInstalledHook;
  afterReplacementInstalledHook = hook;
  try {
    return await run();
  } finally {
    afterReplacementInstalledHook = previous;
  }
}

export async function withConfigQuarantinedHookForTest<T>(
  hook: () => Promise<void>,
  run: () => Promise<T>,
): Promise<T> {
  const previous = afterConfigQuarantinedHook;
  afterConfigQuarantinedHook = hook;
  try {
    return await run();
  } finally {
    afterConfigQuarantinedHook = previous;
  }
}

type ConfigSnapshot = {
  bytes: Buffer;
  identity: FileIdentity;
  parsed: Record<string, unknown>;
};

export type LocalConfigDocument = ConfigSnapshot & { path: string };

export function localConfigPath() {
  return path.join(getAgentDir(), CONFIG_FILE_NAME);
}

export function legacyLocalConfigPath() {
  return path.join(getAgentDir(), LEGACY_CONFIG_FILE_NAME);
}

export async function activeLocalConfigPath() {
  const canonicalPath = localConfigPath();
  const legacyPath = legacyLocalConfigPath();
  return queueConfigOperation(() =>
    withLocalConfigReadLockIfNeeded(async () => {
      if (await pathExists(canonicalPath)) return canonicalPath;
      return (await pathExists(legacyPath)) ? legacyPath : canonicalPath;
    }),
  );
}

export function consumeLocalConfigMigrationNotice() {
  const configPath = localConfigPath();
  const notice = configMigrationNotices.get(configPath);
  configMigrationNotices.delete(configPath);
  return notice;
}

export async function readActiveLocalConfigDocumentForRepair(): Promise<LocalConfigDocument | undefined> {
  const canonicalPath = localConfigPath();
  const legacyPath = legacyLocalConfigPath();
  return queueConfigOperation(() =>
    withLocalConfigReadLockIfNeeded(async () => {
      const filePath = (await pathExists(canonicalPath)) ? canonicalPath : legacyPath;
      const snapshot = await readConfigSnapshotIfExists(filePath);
      return snapshot ? { path: filePath, ...snapshot } : undefined;
    }),
  );
}

export async function readMigratingLocalConfigDocument(
  validateForMigration: (settings: Record<string, unknown>) => void,
): Promise<LocalConfigDocument | undefined> {
  return queueConfigOperation(() =>
    withLocalConfigReadLockIfNeeded(async () => {
      const configPath = await prepareLocalConfigPath(validateForMigration);
      const snapshot = await readConfigSnapshotIfExists(configPath);
      return snapshot ? { path: configPath, ...snapshot } : undefined;
    }),
  );
}

async function withLocalConfigReadLockIfNeeded<T>(read: () => Promise<T>): Promise<T> {
  if ((await pathExists(localConfigPath())) || (await pathExists(legacyLocalConfigPath()))) {
    return withLocalConfigFileLock(read);
  }
  await afterMissingConfigReadProbeHook();
  if (await pathExists(configMutationLockPath())) return withLocalConfigFileLock(read);
  await assertNoInterruptedConfigReplacement();
  return read();
}

function queueConfigOperation<T>(run: () => Promise<T>): Promise<T> {
  // Mutation callbacks use the unlocked helpers below, never a queued public read.
  const operation = configUpdateQueue.then(run);
  configUpdateQueue = operation.then(
    () => undefined,
    () => undefined,
  );
  return operation;
}

export function updateLocalConfigDocument<T extends Record<string, unknown>>(
  defaultValue: T,
  update: (current: T) => T,
  validate: (value: Record<string, unknown>) => void,
  signal?: AbortSignal,
): Promise<T> {
  return queueConfigOperation(() => {
    signal?.throwIfAborted();
    return withLocalConfigFileLock(async () => {
      signal?.throwIfAborted();
      const configPath = await prepareLocalConfigPath(validate);
      signal?.throwIfAborted();
      const snapshot = await readConfigSnapshotIfExists(configPath);
      signal?.throwIfAborted();
      const document = snapshot ? { path: configPath, ...snapshot } : undefined;
      const current = document ? (structuredClone(document.parsed) as T) : structuredClone(defaultValue);
      const next = update(current);
      validate(next);
      signal?.throwIfAborted();
      if (document && JSON.stringify(document.parsed) === JSON.stringify(next)) return next;
      if (document) await replaceLocalConfigDocumentUnlocked(document, next, signal);
      else await installPrivateConfigExclusively(localConfigPath(), serializedConfig(next), signal);
      return next;
    });
  });
}

export function createLocalConfigDocument(value: Record<string, unknown>, signal?: AbortSignal) {
  return queueConfigOperation(() => {
    signal?.throwIfAborted();
    return withLocalConfigFileLock(async () => {
      signal?.throwIfAborted();
      const bytes = serializedConfig(value);
      try {
        await installPrivateConfigExclusively(localConfigPath(), bytes, signal);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") {
          throw new Error("Pi-sync settings were created concurrently; reopen settings and retry.");
        }
        throw error;
      }
    });
  });
}

export function replaceLocalConfigDocument(document: LocalConfigDocument, value: Record<string, unknown>) {
  return queueConfigOperation(() => withLocalConfigFileLock(() => replaceLocalConfigDocumentUnlocked(document, value)));
}

async function replaceLocalConfigDocumentUnlocked(
  document: LocalConfigDocument,
  value: Record<string, unknown>,
  signal?: AbortSignal,
) {
  const nextBytes = serializedConfig(value);
  const canonicalPath = localConfigPath();
  if (document.path !== canonicalPath) {
    if (!(await configDocumentStillMatches(document))) throw settingsChangedError();
    let installed: FileIdentity;
    try {
      installed = await installPrivateConfigExclusively(canonicalPath, nextBytes, signal);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        throw new Error("Canonical settings were created concurrently; no settings were replaced.");
      }
      throw error;
    }
    if (!(await configDocumentStillMatches(document))) {
      await quarantineAndRemoveConfigIfMatchesUnlocked(canonicalPath, installed, nextBytes);
      throw settingsChangedError();
    }
    return;
  }

  const recoveryPath = path.join(
    path.dirname(canonicalPath),
    `.${path.basename(canonicalPath)}.${randomUUID()}.schema-migration-source`,
  );
  const previousHandle = await fs.open(canonicalPath, "r");
  try {
    const previous = await previousHandle.stat();
    if (previous.dev !== document.identity.dev || previous.ino !== document.identity.ino) {
      throw settingsChangedError();
    }
    await writePrivateConfigBytes(recoveryPath, document.bytes, "wx");
    await syncParentDirectory(canonicalPath);
    await withPrivateConfigTemporary(canonicalPath, nextBytes, async (temporaryPath, installed) => {
      let published = false;
      let previousBytesRead: Promise<Buffer> | undefined;
      const readPreviousBytes = () => (previousBytesRead ??= previousHandle.readFile());
      try {
        signal?.throwIfAborted();
        await publishConfigFile(temporaryPath, canonicalPath, document, signal);
        published = true;
        await syncParentDirectory(canonicalPath);
        await afterReplacementInstalledHook();
        if (!(await readPreviousBytes()).equals(document.bytes)) throw settingsChangedError();
        if (!(await fileIdentityAndContentsMatch(canonicalPath, installed, nextBytes))) {
          throw settingsChangedError();
        }
      } catch (error) {
        if (published || (await fileIdentityAndContentsMatch(canonicalPath, installed, nextBytes))) {
          const previousBytes = await readPreviousBytes().catch(() => document.bytes);
          if (!previousBytes.equals(document.bytes)) {
            await writePrivateConfigBytes(recoveryPath, previousBytes, "w");
          }
          // Rollback also replaces atomically; never remove the active settings first.
          if (await fileIdentityAndContentsMatch(canonicalPath, installed, nextBytes)) {
            await fs.rename(recoveryPath, canonicalPath);
            await syncParentDirectory(canonicalPath);
          }
        } else if (await configDocumentStillMatches(document)) {
          await fs.rm(recoveryPath);
        }
        if ((error as NodeJS.ErrnoException).code === "EEXIST") {
          throw new Error("Canonical settings changed concurrently; no settings were replaced.");
        }
        throw error;
      }
    });
    await fs.rm(recoveryPath).catch(() => undefined);
    await syncParentDirectory(canonicalPath).catch(() => undefined);
  } catch (error) {
    if (await configDocumentStillMatches(document)) {
      await fs.rm(recoveryPath, { force: true }).catch(() => undefined);
    }
    throw error;
  } finally {
    await previousHandle.close().catch(() => undefined);
  }
}

async function prepareLocalConfigPath(validateForMigration: (settings: Record<string, unknown>) => void) {
  const canonicalPath = localConfigPath();
  const legacyPath = legacyLocalConfigPath();
  if (await pathExists(canonicalPath)) {
    const legacyStatus = await secureIgnoredLegacyIfPresent(legacyPath);
    if (legacyStatus !== "missing" && !legacyPresenceNoticed.has(canonicalPath)) {
      legacyPresenceNoticed.add(canonicalPath);
      recordConfigMigrationNotice(
        canonicalPath,
        legacyStatus === "private"
          ? `${LEGACY_CONFIG_FILE_NAME} legacy settings were ignored because ${CONFIG_FILE_NAME} takes precedence. Delete ${LEGACY_CONFIG_FILE_NAME} after confirming your settings.`
          : `${LEGACY_CONFIG_FILE_NAME} legacy settings were ignored because ${CONFIG_FILE_NAME} takes precedence, but pi-sync could not verify them as a private regular file. Secure or delete the legacy path after confirming your settings.`,
      );
    }
    return canonicalPath;
  }

  const legacy = await readConfigSnapshotIfExists(legacyPath);
  if (!legacy) return canonicalPath;
  validateForMigration(legacy.parsed);

  let installedIdentity: FileIdentity;
  try {
    installedIdentity = await installPrivateConfigExclusively(canonicalPath, legacy.bytes);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      recordConfigMigrationNotice(
        canonicalPath,
        `${LEGACY_CONFIG_FILE_NAME} legacy settings were ignored because ${CONFIG_FILE_NAME} was created concurrently and takes precedence.`,
      );
      return canonicalPath;
    }
    recordConfigMigrationNotice(
      canonicalPath,
      `Could not migrate ${LEGACY_CONFIG_FILE_NAME} to ${CONFIG_FILE_NAME}; the legacy settings were used for this session and were not changed.`,
    );
    return legacyPath;
  }

  if (!(await configSnapshotStillMatches(legacyPath, legacy))) {
    const removed = await quarantineAndRemoveConfigIfMatchesUnlocked(canonicalPath, installedIdentity, legacy.bytes);
    recordConfigMigrationNotice(
      canonicalPath,
      removed
        ? `${LEGACY_CONFIG_FILE_NAME} changed during migration; the stale ${CONFIG_FILE_NAME} copy was removed and the legacy settings were used for this session.`
        : `${LEGACY_CONFIG_FILE_NAME} changed during migration, but ${CONFIG_FILE_NAME} was replaced concurrently and takes precedence.`,
    );
    return removed ? legacyPath : canonicalPath;
  }

  legacyPresenceNoticed.add(canonicalPath);
  recordConfigMigrationNotice(
    canonicalPath,
    `pi-sync settings migrated from ${LEGACY_CONFIG_FILE_NAME} to ${CONFIG_FILE_NAME}; the private legacy file was retained as a recovery copy and can be deleted after verification.`,
  );
  return canonicalPath;
}

async function secureIgnoredLegacyIfPresent(filePath: string) {
  let pathStat: Awaited<ReturnType<typeof fs.lstat>>;
  try {
    pathStat = await fs.lstat(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "missing" as const;
    return "unsafe" as const;
  }
  if (pathStat.isSymbolicLink() || !pathStat.isFile()) return "unsafe" as const;

  let handle: fs.FileHandle | undefined;
  try {
    handle = await fs.open(filePath, "r");
    const openedStat = await handle.stat();
    if (openedStat.dev !== pathStat.dev || openedStat.ino !== pathStat.ino) {
      return "unsafe" as const;
    }
    if (process.platform !== "win32" && (openedStat.mode & 0o777) !== 0o600) {
      await handle.chmod(0o600);
    }
    return "private" as const;
  } catch {
    return "unsafe" as const;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function readConfigSnapshotIfExists(filePath: string): Promise<ConfigSnapshot | undefined> {
  let pathStat: Awaited<ReturnType<typeof fs.lstat>>;
  try {
    pathStat = await fs.lstat(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  if (pathStat.isSymbolicLink()) {
    throw new Error(`Refusing to read symlinked pi-sync config: ${filePath}`);
  }
  if (!pathStat.isFile()) throw new Error(`pi-sync config is not a regular file: ${filePath}`);

  const handle = await fs.open(filePath, "r");
  try {
    const openedStat = await handle.stat();
    if (openedStat.dev !== pathStat.dev || openedStat.ino !== pathStat.ino) {
      throw new Error(`pi-sync config changed while opening: ${filePath}`);
    }
    if (process.platform !== "win32" && (openedStat.mode & 0o777) !== 0o600) {
      await handle.chmod(0o600);
    }
    const bytes = await handle.readFile();
    return {
      bytes,
      identity: { dev: openedStat.dev, ino: openedStat.ino },
      parsed: parseConfigObject(bytes, filePath),
    };
  } finally {
    await handle.close();
  }
}

function serializedConfig(value: Record<string, unknown>) {
  return Buffer.from(`${JSON.stringify(value, null, "\t")}\n`, "utf8");
}

function parseConfigObject(bytes: Buffer, filePath: string) {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new SyntaxError(`Invalid JSON in pi-sync config: ${filePath}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`pi-sync config must contain a JSON object: ${filePath}`);
  }
  return parsed as Record<string, unknown>;
}

async function installPrivateConfigExclusively(filePath: string, bytes: Buffer, signal?: AbortSignal) {
  return withPrivateConfigTemporary(filePath, bytes, async (temporaryPath, installed) => {
    signal?.throwIfAborted();
    await publishConfigFile(temporaryPath, filePath, undefined, signal);
    try {
      if (!(await fileIdentityAndContentsMatch(filePath, installed, bytes))) {
        throw new Error(`Published pi-sync settings changed concurrently: ${filePath}`);
      }
      await syncParentDirectory(filePath);
    } catch (error) {
      await quarantineAndRemoveConfigIfMatchesUnlocked(filePath, installed, bytes);
      throw error;
    }
    return installed;
  });
}

async function withPrivateConfigTemporary<T>(
  filePath: string,
  bytes: Buffer,
  publish: (temporaryPath: string, identity: FileIdentity) => Promise<T>,
): Promise<T> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temporaryPath = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.migrate`,
  );
  try {
    const identity = await writePrivateConfigBytes(temporaryPath, bytes, "wx");
    return await publish(temporaryPath, identity);
  } finally {
    await fs.rm(temporaryPath, { force: true }).catch(() => undefined);
  }
}

async function writePrivateConfigBytes(filePath: string, bytes: Buffer, flags: "w" | "wx") {
  const handle = await fs.open(filePath, flags, 0o600);
  try {
    await handle.writeFile(bytes);
    if (process.platform !== "win32") await handle.chmod(0o600);
    await handle.sync();
    const installed = await handle.stat();
    return { dev: installed.dev, ino: installed.ino };
  } finally {
    await handle.close();
  }
}

async function configDocumentStillMatches(document: LocalConfigDocument) {
  return fileIdentityAndContentsMatch(document.path, document.identity, document.bytes);
}

function settingsChangedError() {
  return new Error("pi-sync settings changed during migration; no settings were replaced.");
}

async function configSnapshotStillMatches(filePath: string, snapshot: ConfigSnapshot) {
  return fileIdentityAndContentsMatch(filePath, snapshot.identity, snapshot.bytes);
}

export function quarantineAndRemoveConfigIfMatches(filePath: string, identity: FileIdentity, expectedBytes: Buffer) {
  return queueConfigOperation(() =>
    withLocalConfigFileLock(() => quarantineAndRemoveConfigIfMatchesUnlocked(filePath, identity, expectedBytes)),
  );
}

async function quarantineAndRemoveConfigIfMatchesUnlocked(
  filePath: string,
  identity: FileIdentity,
  expectedBytes: Buffer,
) {
  const quarantinePath = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${randomUUID()}.migration-retired`,
  );
  try {
    await fs.rename(filePath, quarantinePath);
  } catch {
    return false;
  }
  await afterConfigQuarantinedHook();
  try {
    await syncParentDirectory(filePath);
  } catch {
    await restoreQuarantinedConfig(filePath, quarantinePath);
    return false;
  }

  const matches = await fileIdentityAndContentsMatch(quarantinePath, identity, expectedBytes);
  if (!matches) {
    await restoreQuarantinedConfig(filePath, quarantinePath);
    return false;
  }
  if (await pathExists(filePath)) {
    await fs.rm(quarantinePath, { force: true });
    await syncParentDirectory(filePath);
    return false;
  }
  await fs.rm(quarantinePath);
  await syncParentDirectory(filePath);
  return true;
}

async function fileIdentityAndContentsMatch(filePath: string, identity: FileIdentity, expectedBytes: Buffer) {
  try {
    const current = await fs.lstat(filePath);
    if (current.isSymbolicLink()) return false;
    if (current.dev !== identity.dev || current.ino !== identity.ino) return false;
    return (await fs.readFile(filePath)).equals(expectedBytes);
  } catch {
    return false;
  }
}

async function restoreQuarantinedConfig(filePath: string, quarantinePath: string) {
  try {
    await renameFileWithoutReplacement(quarantinePath, filePath);
    if (process.platform !== "win32") await fs.chmod(filePath, 0o600);
    await syncParentDirectory(filePath);
    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") return;
  }
  try {
    if (process.platform !== "win32") await fs.chmod(quarantinePath, 0o600);
    await syncParentDirectory(filePath);
  } catch {
    // Preserve the quarantine rather than risk deleting settings that changed concurrently.
  }
}

function configMutationLockPath() {
  return `${localConfigPath()}.mutation-lock`;
}

export async function withLocalConfigFileLock<T>(run: () => Promise<T>): Promise<T> {
  const configPath = localConfigPath();
  await fs.mkdir(path.dirname(configPath), { recursive: true });
  let compromisedError: Error | undefined;
  const release = await lockfile.lock(configPath, {
    fs: LOCKFILE_FS_ADAPTER,
    lockfilePath: configMutationLockPath(),
    realpath: false,
    stale: CONFIG_LOCK_STALE_MS,
    update: CONFIG_LOCK_UPDATE_MS,
    retries: { retries: 100, factor: 1.2, minTimeout: 10, maxTimeout: 100 },
    onCompromised: (error) => {
      compromisedError = error;
    },
  });
  try {
    await assertNoInterruptedConfigReplacement();
    const result = await run();
    if (compromisedError) throw compromisedError;
    return result;
  } finally {
    await release();
  }
}

async function syncParentDirectory(filePath: string) {
  if (process.platform === "win32") return;
  let handle: fs.FileHandle | undefined;
  try {
    handle = await fs.open(path.dirname(filePath), "r");
    await handle.sync();
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function publishFileWithGuard(
  source: string,
  destination: string,
  expected?: LocalConfigDocument,
  signal?: AbortSignal,
) {
  await beforeConfigPublicationHook();
  signal?.throwIfAborted();
  if (expected) {
    // The shared lock orders Pi Sync writers; rename has no CAS for noncooperating writers.
    if (!(await configDocumentStillMatches(expected))) throw settingsChangedError();
    signal?.throwIfAborted();
    await fs.rename(source, destination);
  } else {
    await renameFileWithoutReplacement(source, destination, signal);
  }
}

async function renameFileWithoutReplacement(source: string, destination: string, signal?: AbortSignal) {
  if (await pathExists(destination)) {
    throw Object.assign(new Error(`Settings already exist: ${destination}`), { code: "EEXIST" });
  }
  signal?.throwIfAborted();
  await fs.rename(source, destination);
}

async function assertNoInterruptedConfigReplacement() {
  const configPath = localConfigPath();
  if (await pathExists(configPath)) return;
  let names: string[];
  try {
    names = await fs.readdir(path.dirname(configPath));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  const prefix = `.${path.basename(configPath)}.`;
  if (
    names.some(
      (name) =>
        name.startsWith(prefix) && (name.endsWith(".schema-migration-source") || name.endsWith(".migration-retired")),
    )
  ) {
    throw new Error(
      "Interrupted pi-sync settings replacement: restore the retained recovery file to pi-sync.json before retrying; legacy settings were not loaded.",
    );
  }
}

async function pathExists(filePath: string) {
  try {
    await fs.lstat(filePath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function recordConfigMigrationNotice(configPath: string, notice: string) {
  if (!configMigrationNotices.has(configPath)) configMigrationNotices.set(configPath, notice);
}
