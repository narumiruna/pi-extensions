import { randomUUID } from "node:crypto";
import { lstat, mkdir, open, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { formatDisplayValue, formatError } from "./script-support.mjs";

const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const MAX_EMBEDDED_ERROR_LENGTH = 240;
const MAX_NESTED_DIRECTORY_ERROR_LENGTH = 80;

export async function backupExpectedDocument(destinationPath, expected, options = {}) {
  const backupDirectory = join(dirname(destinationPath), "pi-starship");
  const backupPath = join(backupDirectory, `pi-starship-${localTimestamp(options.now ?? new Date())}.toml`);
  const temporaryPath = join(backupDirectory, `.pi-starship-${randomUUID()}.tmp`);
  const inspectPath = options.inspectPath ?? lstat;
  const makeDirectory = options.makeDirectory ?? mkdir;
  const openFile = options.openFile ?? open;
  const removeFile = options.removeFile ?? rm;
  const renameFile = options.renameFile ?? rename;
  const syncDirectory = options.syncDirectory ?? syncDirectoryEntry;

  await assertBackupDirectorySafe(backupDirectory, inspectPath, true);
  await makeDirectory(backupDirectory, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
  await assertBackupDirectorySafe(backupDirectory, inspectPath, false);

  let handle;
  let ownsTemporaryPath = false;
  let backupPublished = false;
  try {
    handle = await openFile(temporaryPath, "wx", PRIVATE_FILE_MODE);
    ownsTemporaryPath = true;
    await handle.writeFile(expected);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await assertBackupMissing(backupPath, inspectPath);
    await renameFile(temporaryPath, backupPath);
    ownsTemporaryPath = false;
    backupPublished = true;
    await syncDirectory(backupDirectory);
    await syncDirectory(dirname(backupDirectory));
    return backupPath;
  } catch (error) {
    const cleanupErrors = [];
    if (handle) {
      try {
        await handle.close();
      } catch (closeError) {
        cleanupErrors.push({ operation: "closing the temporary backup", error: closeError });
      }
    }
    if (ownsTemporaryPath) {
      try {
        await removeFile(temporaryPath, { force: true });
      } catch (removeError) {
        cleanupErrors.push({ operation: "removing the temporary backup", error: removeError });
      }
    }
    if (cleanupErrors.length > 0) {
      const diagnostics = cleanupErrors
        .map(({ operation, error: cleanupError }) => `${operation}: ${formatEmbeddedError(cleanupError)}`)
        .join("; ");
      throw new Error(
        `Backup creation failed: ${formatEmbeddedError(error)}. Cleanup also failed (${diagnostics}). The active file was preserved.`,
      );
    }
    if (backupPublished) {
      throw new Error(
        `Backup was retained at ${formatDisplayValue(backupPath)}, but its directory durability check failed: ${formatEmbeddedError(error)}. The active file was preserved.`,
      );
    }
    throw error;
  }
}

async function syncDirectoryEntry(directoryPath) {
  if (process.platform === "win32") return;

  const handle = await open(directoryPath, "r");
  let syncError;
  try {
    await handle.sync();
  } catch (error) {
    syncError = error;
  }

  try {
    await handle.close();
  } catch (closeError) {
    if (syncError) {
      throw new Error(
        `Directory sync failed: ${formatEmbeddedError(syncError, MAX_NESTED_DIRECTORY_ERROR_LENGTH)}. Closing the directory also failed: ${formatEmbeddedError(closeError, MAX_NESTED_DIRECTORY_ERROR_LENGTH)}.`,
      );
    }
    throw closeError;
  }

  if (syncError) throw syncError;
}

async function assertBackupDirectorySafe(directoryPath, inspectPath, allowMissing) {
  let info;
  try {
    info = await inspectPath(directoryPath);
  } catch (error) {
    if (allowMissing && error && typeof error === "object" && error.code === "ENOENT") return;
    throw error;
  }
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new Error(
      `Backup directory must be a real directory, not a symbolic link: ${formatDisplayValue(directoryPath)}`,
    );
  }
}

async function assertBackupMissing(backupPath, inspectPath) {
  try {
    await inspectPath(backupPath);
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") return;
    throw error;
  }
  throw new Error(`Backup already exists at ${formatDisplayValue(backupPath)}; the active file was preserved.`);
}

function formatEmbeddedError(error, maximumLength = MAX_EMBEDDED_ERROR_LENGTH) {
  const diagnostic = formatError(error);
  return diagnostic.length > maximumLength ? `${diagnostic.slice(0, maximumLength - 1)}…` : diagnostic;
}

function localTimestamp(date) {
  return [date.getFullYear(), date.getMonth() + 1, date.getDate(), date.getHours(), date.getMinutes()]
    .map((value, index) => String(value).padStart(index === 0 ? 4 : 2, "0"))
    .join("");
}
