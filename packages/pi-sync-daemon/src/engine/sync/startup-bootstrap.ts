import { type BigIntStats, closeSync, constants, fstatSync, lstatSync, openSync, readSync } from "node:fs";
import path from "node:path";
import { readConsent } from "../../consent.js";
import { documentFingerprint } from "../../document.js";
import { MAX_SETTINGS_BYTES } from "../../protocol.js";
import { configFromSettings } from "../settings/config.js";
import { legacyLocalConfigPath, localConfigPath } from "../settings/config-file.js";
import { validateSettingsDocument } from "../settings/settings-validation.js";
import { stateDirectoryMigrationNotice } from "../state/state-directory.js";
import { statePathForConfig } from "../state/sync-state-store.js";
import { startupRecoveryEvidence } from "./startup-recovery-evidence.js";

function inspect(target: string) {
  return lstatSync(target, { bigint: true, throwIfNoEntry: false });
}

function sameFile(before: BigIntStats, now: BigIntStats | undefined) {
  return (
    now?.isFile() &&
    now.dev === before.dev &&
    now.ino === before.ino &&
    now.size === before.size &&
    now.mode === before.mode &&
    now.ctimeNs === before.ctimeNs &&
    now.mtimeNs === before.mtimeNs
  );
}

function readCanonicalSettings() {
  const target = localConfigPath();
  const mayNeedWrite = () => Boolean(inspect(legacyLocalConfigPath()) || inspect(`${target}.mutation-lock`));
  if (mayNeedWrite()) return;
  const before = inspect(target);
  if (
    !before?.isFile() ||
    before.size > MAX_SETTINGS_BYTES ||
    (process.getuid && before.uid !== BigInt(process.getuid())) ||
    (process.platform !== "win32" && (before.mode & 0o777n) !== 0o600n)
  )
    return;
  const fd = openSync(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    if (!sameFile(before, fstatSync(fd, { bigint: true }))) return;
    const bytes = Buffer.alloc(Number(before.size) + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(fd, bytes, offset, bytes.length - offset, offset);
      if (!count) break;
      offset += count;
    }
    if (
      offset !== Number(before.size) ||
      !sameFile(before, fstatSync(fd, { bigint: true })) ||
      !sameFile(before, inspect(target)) ||
      mayNeedWrite()
    )
      return;
    return {
      bytes: bytes.subarray(0, offset),
      fingerprint: documentFingerprint({
        bytes: bytes.subarray(0, offset).toString("base64"),
        identity: { dev: Number(before.dev), ino: Number(before.ino) },
      }),
    };
  } finally {
    closeSync(fd);
  }
}

export function captureStartupBootstrap(
  root: string,
  expected: string,
  signal: AbortSignal,
  reviewOwnsLock?: () => boolean,
): (() => boolean) | undefined {
  signal.throwIfAborted();
  if (stateDirectoryMigrationNotice()) return;
  const recovery = startupRecoveryEvidence(root, reviewOwnsLock);
  if (recovery === undefined) return;
  const consent = readConsent(root);
  if (!consent) return;
  const document = readCanonicalSettings();
  if (document?.fingerprint !== expected) return;
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(document.bytes.toString("utf8"));
  } catch {
    return;
  }
  const settings = validateSettingsDocument(parsed);
  if (!settings.activeSyncSetup) return;
  const config = configFromSettings(settings);
  if (config.reservedIgnoreNames) return;
  const stateFile = statePathForConfig(config);
  const noMergeJournal = () => {
    const setupDirectory = inspect(path.dirname(stateFile));
    return !setupDirectory || (setupDirectory.isDirectory() && !inspect(`${stateFile}.merge-journal.json`));
  };
  const consentToken = JSON.stringify(consent);
  const validate = () => {
    signal.throwIfAborted();
    return (
      readCanonicalSettings()?.fingerprint === expected &&
      !stateDirectoryMigrationNotice() &&
      JSON.stringify(readConsent(root)) === consentToken &&
      noMergeJournal() &&
      startupRecoveryEvidence(root, reviewOwnsLock) === recovery
    );
  };
  return noMergeJournal() && startupRecoveryEvidence(root, reviewOwnsLock) === recovery ? validate : undefined;
}
