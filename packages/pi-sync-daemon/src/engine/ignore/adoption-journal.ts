import { createHash } from "node:crypto";
import { constants, lstatSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import type { RemoteHead } from "../backends/sync-backend.js";
import { syncDirectory, writeJson } from "../state/json-file.js";
import { stateDir } from "../state/state-directory.js";
import { compileIgnoreRules, sameFile, validateIgnoreFilename } from "./ignore-source.js";

const MAX_BYTES = 32 * 1024 * 1024;
const recoveryMessage =
  "Pending ignore-rule adoption. Run a reviewed Pull from the originating setup, or preserve its recovery evidence.";

export interface AdoptionJournal {
  version: 1;
  setupFingerprint: string;
  stateFingerprint: string;
  filename: string;
  sourceIdentity: string;
  installedIdentity?: string;
  beforeRules: string;
  afterRules: string;
  beforeFiles: Record<string, string>;
  afterFiles: Record<string, string>;
  head: RemoteHead;
  remoteFilesIdentity: string;
  sessionDir?: string;
  backupId: string;
  backupDigest: string;
}

function journalPath() {
  return path.join(stateDir(), "ignore-adoption.json");
}

export function hasPendingAdoption() {
  return lstatSync(journalPath(), { throwIfNoEntry: false }) !== undefined;
}

export function requireNoPendingAdoption() {
  if (hasPendingAdoption()) throw new Error(recoveryMessage);
}

function hex(value: unknown) {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}

function fileIdentity(value: unknown) {
  return typeof value === "string" && /^\d+:\d+:-?\d+$/u.test(value);
}

function hashMap(value: unknown) {
  return Boolean(
    value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      Object.keys(value).length <= 16_384 &&
      Object.values(value).every(hex),
  );
}

async function readAdoptionJournal() {
  const target = journalPath();
  const before = await fs.lstat(target);
  if (
    !before.isFile() ||
    before.nlink !== 1 ||
    before.size > MAX_BYTES ||
    (process.getuid && before.uid !== process.getuid()) ||
    (process.platform !== "win32" && before.mode & 0o077)
  )
    throw new Error(recoveryMessage);
  const handle = await fs.open(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await handle.stat();
    if (
      stat.dev !== before.dev ||
      stat.ino !== before.ino ||
      stat.size !== before.size ||
      stat.mtimeMs !== before.mtimeMs
    )
      throw new Error(recoveryMessage);
    const bytes = Buffer.alloc(stat.size);
    const { bytesRead } = await handle.read(bytes);
    if (bytesRead !== bytes.length || (await handle.stat()).mtimeMs !== stat.mtimeMs) throw new Error(recoveryMessage);
    return JSON.parse(bytes.toString("utf8")) as AdoptionJournal;
  } finally {
    await handle.close();
  }
}

export async function loadAdoptionJournal(): Promise<AdoptionJournal | undefined> {
  if (!hasPendingAdoption()) return;
  try {
    const journal = await readAdoptionJournal();
    if (
      journal?.version !== 1 ||
      !hex(journal.setupFingerprint) ||
      !hex(journal.stateFingerprint) ||
      !fileIdentity(journal.sourceIdentity) ||
      (journal.installedIdentity !== undefined && !fileIdentity(journal.installedIdentity)) ||
      typeof journal.beforeRules !== "string" ||
      typeof journal.afterRules !== "string" ||
      !hashMap(journal.beforeFiles) ||
      !hashMap(journal.afterFiles) ||
      !hex(journal.remoteFilesIdentity) ||
      !hex(journal.backupDigest) ||
      typeof journal.head?.snapshotId !== "string" ||
      typeof journal.head?.snapshotRef !== "string" ||
      typeof journal.head?.revision !== "string" ||
      (journal.sessionDir !== undefined && !path.isAbsolute(journal.sessionDir)) ||
      typeof journal.backupId !== "string" ||
      !/^[\w-]{1,128}$/u.test(journal.backupId)
    )
      throw new Error(recoveryMessage);
    validateIgnoreFilename(journal.filename);
    compileIgnoreRules(journal.beforeRules);
    compileIgnoreRules(journal.afterRules);
    return journal;
  } catch (cause) {
    throw new Error(recoveryMessage, { cause });
  }
}

export async function verifyAdoptionBackup(journal: AdoptionJournal, signal?: AbortSignal) {
  const backups = path.join(stateDir(), "backups");
  if (!(await fs.lstat(backups)).isDirectory()) throw new Error(recoveryMessage);
  const backup = path.join(backups, `${journal.backupId}.json.gz`);
  const handle = await fs.open(backup, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await handle.stat({ bigint: true });
    if (!stat.isFile() || stat.nlink !== 1n || stat.size < 1n || stat.size > 128n * 1024n * 1024n)
      throw new Error(recoveryMessage);
    const hash = createHash("sha256");
    const stream = handle.createReadStream({ start: 0, end: Number(stat.size) - 1, autoClose: false, signal });
    for await (const chunk of stream) hash.update(chunk);
    if (hash.digest("hex") !== journal.backupDigest || !sameFile(stat, await fs.lstat(backup, { bigint: true })))
      throw new Error("The original Pull backup changed; preserve the adoption journal.");
    signal?.throwIfAborted();
  } finally {
    await handle.close();
  }
}

export async function createAdoptionJournal(journal: AdoptionJournal) {
  requireNoPendingAdoption();
  const target = journalPath();
  await writeJson(target, journal, { maxBytes: MAX_BYTES });
  await syncDirectory(path.dirname(path.dirname(target)));
}

async function assertCurrentJournal(journal: AdoptionJournal) {
  if (JSON.stringify(await loadAdoptionJournal()) !== JSON.stringify(journal)) throw new Error(recoveryMessage);
}

export async function recordInstalledIdentity(journal: AdoptionJournal, identity: string) {
  await assertCurrentJournal(journal);
  const next = { ...journal, installedIdentity: identity };
  await writeJson(journalPath(), next, { maxBytes: MAX_BYTES });
  return next;
}

export async function completeAdoptionJournal(journal: AdoptionJournal) {
  await assertCurrentJournal(journal);
  const target = journalPath();
  const backups = path.join(path.dirname(target), "backups");
  if (!(await fs.lstat(backups)).isDirectory()) throw new Error(recoveryMessage);
  const archived = path.join(backups, `${journal.backupId}.ignore-adoption.json`);
  await fs.rename(target, archived);
  await syncDirectory(backups);
  await syncDirectory(path.dirname(target));
  return archived;
}
