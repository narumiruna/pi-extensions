import { randomUUID } from "node:crypto";
import {
  type BigIntStats,
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, parse, resolve, sep } from "node:path";

export interface DocumentIdentity {
  readonly dev: bigint;
  readonly ino: bigint;
  readonly size: bigint;
  readonly mtimeNs: bigint;
  readonly ctimeNs: bigint;
}

export interface ProfileDocument {
  readonly kind: "profile";
  readonly name: string;
  readonly path: string;
  readonly rawDocument: string | undefined;
  readonly rawBytes: Buffer;
  readonly readError?: string;
  readonly identity: DocumentIdentity;
}

export interface TextProfileDocument extends ProfileDocument {
  readonly rawDocument: string;
}

export interface ArchiveReference {
  readonly name: string;
  readonly path: string;
}

export interface HistoryDocument {
  readonly kind: "history";
  /** Filename, including .toml; not an arbitrary path. */
  readonly name: string;
  readonly path: string;
  /** Undefined when rawBytes are not valid UTF-8; never apply a decoded fallback. */
  readonly rawDocument: string | undefined;
  readonly rawBytes: Buffer;
  readonly readError?: string;
  readonly identity: DocumentIdentity;
  readonly legacy: boolean;
  /** ISO recovery time for new entries; local timestamp for legacy backups. */
  readonly createdAt: string;
}

type Document = ProfileDocument | HistoryDocument;
const HISTORY_NAME =
  /^(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.\d{3}Z)-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.toml$/u;
const LEGACY_NAME = /^pi-starship-(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})\.toml$/u;
const RESERVED_NAME = /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³]|conin\$|conout\$|clock\$)(?:\.|$)/iu;

/** Normalize new names, but never trim, truncate, or replace forbidden characters. */
export function normalizeProfileName(value: string): string {
  const name = value.normalize("NFC");
  if (
    [...name].length < 1 ||
    [...name].length > 80 ||
    name !== name.trim() ||
    name.startsWith(".") ||
    name.endsWith(".") ||
    /[\p{Cc}\p{Cf}\p{Cs}<>:"/\\|?*]/u.test(name) ||
    RESERVED_NAME.test(name) ||
    Buffer.byteLength(`${name}.toml`, "utf8") > 255
  ) {
    throw new Error("Invalid profile name: use 1–80 characters without controls, path characters, or reserved names");
  }
  return name;
}

/** The caller supplies a trusted settings directory; its home/system symlink ancestors are valid. */
function trustedDirectory(path: string): string {
  try {
    return realpathSync(path);
  } catch (error) {
    if (!isMissing(error)) throw error;
    const parent = dirname(path);
    if (parent === path) throw error;
    return join(trustedDirectory(parent), basename(path));
  }
}

function rootPath(settingsPath: string): string {
  return join(trustedDirectory(dirname(resolve(settingsPath))), "pi-starship");
}

function profileDirectory(settingsPath: string): string {
  return join(rootPath(settingsPath), "profiles");
}

function historyDirectory(settingsPath: string): string {
  return join(rootPath(settingsPath), "history");
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

function statIfPresent(path: string): BigIntStats | undefined {
  try {
    return lstatSync(path, { bigint: true });
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw error;
  }
}

/** Paths already have a canonical trusted parent; reject symlinks in every storage-owned component. */
function checkedDirectory(path: string, create = false): boolean {
  const absolute = resolve(path);
  const root = parse(absolute).root;
  let current = root;
  for (const part of absolute.slice(root.length).split(sep).filter(Boolean)) {
    current = join(current, part);
    let stat = statIfPresent(current);
    let created = false;
    if (!stat && create) {
      try {
        mkdirSync(current, { mode: 0o700 });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
      stat = statIfPresent(current);
      created = true;
    }
    if (!stat) return false;
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`Not a safe directory: ${current}`);
    // Persist each new ancestor's directory entry, including a previously absent agent directory.
    if (created) flushDirectory(dirname(current));
  }
  return true;
}

function identity(stat: BigIntStats): DocumentIdentity {
  return Object.freeze({ dev: stat.dev, ino: stat.ino, size: stat.size, mtimeNs: stat.mtimeNs, ctimeNs: stat.ctimeNs });
}

function sameIdentity(left: DocumentIdentity, right: DocumentIdentity): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

function sameFile(left: DocumentIdentity, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function encodeDocument(rawDocument: string): Buffer {
  const bytes = Buffer.from(rawDocument, "utf8");
  if (bytes.toString("utf8") !== rawDocument) throw new Error("Document is not lossless UTF-8 text");
  return bytes;
}

function readBytes(path: string): { rawBytes: Buffer; identity: DocumentIdentity } {
  if (!checkedDirectory(dirname(path))) throw new Error(`Document directory is missing: ${dirname(path)}`);
  const before = statIfPresent(path);
  if (!before?.isFile() || before.isSymbolicLink()) throw new Error(`Not a regular document: ${path}`);
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const opened = fstatSync(fd, { bigint: true });
    if (!opened.isFile() || !sameIdentity(identity(before), identity(opened))) {
      throw new Error(`Document changed while opening: ${path}`);
    }
    const bytes = readFileSync(fd);
    const after = fstatSync(fd, { bigint: true });
    const published = statIfPresent(path);
    if (
      !sameIdentity(identity(opened), identity(after)) ||
      !published ||
      !sameIdentity(identity(after), identity(published))
    ) {
      throw new Error(`Document changed while reading: ${path}`);
    }
    return { rawBytes: bytes, identity: identity(after) };
  } finally {
    closeSync(fd);
  }
}

export function readProfile(settingsPath: string, name: string): ProfileDocument {
  const normalized = normalizeProfileName(name);
  const path = join(profileDirectory(settingsPath), `${normalized}.toml`);
  const document = readBytes(path);
  const decoded = document.rawBytes.toString("utf8");
  const valid = Buffer.from(decoded, "utf8").equals(document.rawBytes);
  return Object.freeze({
    kind: "profile",
    name: normalized,
    path,
    ...document,
    rawDocument: valid ? decoded : undefined,
    ...(valid ? {} : { readError: "Profile document is not valid UTF-8; raw bytes are preserved" }),
  });
}

/** Reject a removed, replaced, or edited profile before applying its reviewed snapshot. */
export function assertProfileUnchanged(settingsPath: string, expected: ProfileDocument): void {
  assertExpected(readProfile(settingsPath, expected.name), expected);
}

export function listProfiles(settingsPath: string): ProfileDocument[] {
  const directory = profileDirectory(settingsPath);
  if (!checkedDirectory(directory)) return [];
  const profiles: ProfileDocument[] = [];
  for (const filename of readdirSync(directory).sort()) {
    if (!filename.endsWith(".toml")) continue;
    const name = filename.slice(0, -5);
    try {
      if (normalizeProfileName(name) !== name) continue;
    } catch {
      continue;
    }
    const stat = statIfPresent(join(directory, filename));
    if (!stat?.isFile() || stat.isSymbolicLink()) continue;
    profiles.push(readProfile(settingsPath, name));
  }
  return profiles;
}

/**
 * Sync mutations cannot interleave in one JS thread. This directory lock also coordinates
 * cooperating store callers in other processes. Contention fails instead of blocking the event
 * loop. A crashed owner's lock requires explicit manual recovery; never guess that a lock is stale.
 * Node has no portable rename-no-replace operation. Collision checks + rename under this lock
 * prevent cooperative clobbering, NOT races with external editors or directory replacement.
 * There is no portable openat/renameat API here; external directory TOCTOU remains as well.
 */
function mutate<T>(settingsPath: string, operation: () => T): T {
  const root = rootPath(settingsPath);
  checkedDirectory(root, true);
  const lock = join(root, ".mutation-lock");
  try {
    mkdirSync(lock, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error(`Profile/history storage is locked; inspect the owner before manually removing ${lock}`);
    }
    throw error;
  }
  const owned = lstatSync(lock, { bigint: true });
  let result!: T;
  let operationError: unknown;
  let failed = false;
  try {
    result = operation();
  } catch (error) {
    failed = true;
    operationError = error;
  }
  try {
    const current = statIfPresent(lock);
    if (current?.isDirectory() && sameFile(identity(owned), current)) rmdirSync(lock);
  } catch (error) {
    if (failed) throw new AggregateError([operationError, error], `Mutation and lock cleanup failed at ${lock}`);
    throw new Error(`Mutation completed but lock cleanup failed at ${lock}`, { cause: error });
  }
  if (failed) throw operationError;
  return result;
}

/** Conservative Unicode caseless key, including expansions such as ß -> ss and final sigma. */
function collisionKey(name: string): string {
  // A second pass includes uppercase sharp S (ẞ -> ß -> ss).
  return name.normalize("NFC").toUpperCase().toLowerCase().toUpperCase().toLowerCase().normalize("NFC");
}

function assertAvailable(directory: string, filename: string): void {
  const key = collisionKey(filename);
  if (readdirSync(directory).some((entry) => collisionKey(entry) === key)) {
    throw new Error(`Document name already exists: ${filename}`);
  }
}

function assertExpected<T extends Document>(current: T, expected: T): void {
  if (
    current.kind !== expected.kind ||
    current.path !== expected.path ||
    current.name !== expected.name ||
    current.rawDocument !== expected.rawDocument ||
    !current.rawBytes.equals(expected.rawBytes) ||
    !sameIdentity(current.identity, expected.identity)
  ) {
    throw new Error(`Document changed since review: ${current.path}`);
  }
}

function flushDirectory(path: string): void {
  // Windows does not support opening/fsyncing directories through this API.
  // File flushing still applies; directory-entry crash durability is POSIX-only.
  if (process.platform === "win32") return;
  checkedDirectory(path);
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_DIRECTORY);
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function flushMutation(directory: string, path: string): void {
  try {
    flushDirectory(directory);
  } catch (error) {
    throw new Error(`Mutation completed at ${path}, but directory flush failed: ${String(error)}`, { cause: error });
  }
}

/** Published files are never removed on a subsequent flush/read failure. */
function publish(directory: string, filename: string, bytes: Buffer, beforeRename: () => void): void {
  const temporary = join(directory, `.tmp-${randomUUID()}`);
  const fd = openSync(
    temporary,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  const owned = fstatSync(fd, { bigint: true });
  let open = true;
  try {
    writeFileSync(fd, bytes);
    fsyncSync(fd);
    closeSync(fd);
    open = false;
    checkedDirectory(directory);
    beforeRename();
    const destination = join(directory, filename);
    renameSync(temporary, destination);
    flushMutation(directory, destination);
  } finally {
    try {
      if (open) closeSync(fd);
    } finally {
      const current = statIfPresent(temporary);
      if (current && sameFile(identity(owned), current)) unlinkSync(temporary);
    }
  }
}

function readTextProfile(settingsPath: string, name: string): TextProfileDocument {
  const document = readProfile(settingsPath, name);
  if (document.rawDocument === undefined) throw new Error(document.readError);
  return { ...document, rawDocument: document.rawDocument };
}

export function createProfile(settingsPath: string, name: string, rawDocument: string): TextProfileDocument {
  const normalized = normalizeProfileName(name);
  const bytes = encodeDocument(rawDocument);
  return mutate(settingsPath, () => {
    const directory = profileDirectory(settingsPath);
    checkedDirectory(directory, true);
    const filename = `${normalized}.toml`;
    assertAvailable(directory, filename);
    publish(directory, filename, bytes, () => assertAvailable(directory, filename));
    return readTextProfile(settingsPath, normalized);
  });
}

export function duplicateProfile(
  settingsPath: string,
  name: string,
  newName: string,
  expected: ProfileDocument,
): ProfileDocument {
  const normalized = normalizeProfileName(newName);
  return mutate(settingsPath, () => {
    const current = readProfile(settingsPath, name);
    assertExpected(current, expected);
    const directory = profileDirectory(settingsPath);
    const filename = `${normalized}.toml`;
    assertAvailable(directory, filename);
    publish(directory, filename, current.rawBytes, () => {
      assertExpected(readProfile(settingsPath, name), expected);
      assertAvailable(directory, filename);
    });
    return readProfile(settingsPath, normalized);
  });
}

export function saveProfile(
  settingsPath: string,
  name: string,
  rawDocument: string,
  expected: ProfileDocument,
): TextProfileDocument {
  const normalized = normalizeProfileName(name);
  const bytes = encodeDocument(rawDocument);
  return mutate(settingsPath, () => {
    const current = readProfile(settingsPath, normalized);
    assertExpected(current, expected);
    if (current.rawDocument === rawDocument) return { ...current, rawDocument };
    publish(profileDirectory(settingsPath), `${normalized}.toml`, bytes, () => {
      assertExpected(readProfile(settingsPath, normalized), expected);
    });
    return readTextProfile(settingsPath, normalized);
  });
}

export function renameProfile(
  settingsPath: string,
  name: string,
  newName: string,
  expected: ProfileDocument,
): ProfileDocument {
  const normalized = normalizeProfileName(newName);
  return mutate(settingsPath, () => {
    const current = readProfile(settingsPath, name);
    assertExpected(current, expected);
    if (current.name === normalized) return current;
    // Explicitly reject case-only renames rather than depending on filesystem case behavior.
    if (collisionKey(current.name) === collisionKey(normalized))
      throw new Error("Case-only profile rename is not supported");
    const directory = profileDirectory(settingsPath);
    assertAvailable(directory, `${normalized}.toml`);
    assertExpected(readProfile(settingsPath, name), expected);
    const destination = join(directory, `${normalized}.toml`);
    renameSync(current.path, destination);
    flushMutation(directory, destination);
    return readProfile(settingsPath, normalized);
  });
}

export function deleteProfile(settingsPath: string, name: string, expected: ProfileDocument): void {
  mutate(settingsPath, () => {
    const current = readProfile(settingsPath, name);
    assertExpected(current, expected);
    unlinkSync(current.path);
    flushMutation(dirname(current.path), current.path);
  });
}

function assertTimestamp(value: string): void {
  const time = Date.parse(value);
  if (!Number.isFinite(time) || new Date(time).toISOString() !== value) throw new Error("Invalid history timestamp");
}

function historyLocation(settingsPath: string, name: string): { path: string; legacy: boolean; createdAt: string } {
  const modern = HISTORY_NAME.exec(name);
  if (modern) {
    const createdAt = modern[1].replace(/T(\d{2})-(\d{2})-(\d{2})/u, "T$1:$2:$3");
    assertTimestamp(createdAt);
    return { path: join(historyDirectory(settingsPath), name), legacy: false, createdAt };
  }
  const legacy = LEGACY_NAME.exec(name);
  if (legacy) {
    const createdAt = `${legacy[1]}-${legacy[2]}-${legacy[3]}T${legacy[4]}:${legacy[5]}`;
    assertTimestamp(`${createdAt}:00.000Z`);
    return { path: join(rootPath(settingsPath), name), legacy: true, createdAt };
  }
  throw new Error("Invalid history filename");
}

export function readHistory(settingsPath: string, name: string): HistoryDocument {
  const location = historyLocation(settingsPath, name);
  const document = readBytes(location.path);
  const decoded = document.rawBytes.toString("utf8");
  const valid = Buffer.from(decoded, "utf8").equals(document.rawBytes);
  return Object.freeze({
    kind: "history",
    name,
    ...location,
    ...document,
    rawDocument: valid ? decoded : undefined,
    ...(valid ? {} : { readError: "Recovery document is not valid UTF-8; raw bytes are preserved" }),
  });
}

export function listHistory(settingsPath: string): HistoryDocument[] {
  const history: HistoryDocument[] = [];
  for (const [directory, pattern] of [
    [historyDirectory(settingsPath), HISTORY_NAME],
    [rootPath(settingsPath), LEGACY_NAME],
  ] as const) {
    if (!checkedDirectory(directory)) continue;
    for (const name of readdirSync(directory).sort()) {
      if (!pattern.test(name)) continue;
      try {
        historyLocation(settingsPath, name);
      } catch (error) {
        if (error instanceof Error && error.message === "Invalid history timestamp") continue;
        throw error;
      }
      const stat = statIfPresent(join(directory, name));
      if (!stat?.isFile() || stat.isSymbolicLink()) continue;
      history.push(readHistory(settingsPath, name));
    }
  }
  return history.sort(
    (left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt) || left.name.localeCompare(right.name),
  );
}

/** Return only after file AND directory fsync. Keep recovery bytes even if a later operation fails. */
export function archiveConfigDocument(settingsPath: string, rawDocument: string | Buffer): ArchiveReference {
  const bytes = typeof rawDocument === "string" ? encodeDocument(rawDocument) : Buffer.from(rawDocument);
  return mutate(settingsPath, () => {
    const directory = historyDirectory(settingsPath);
    checkedDirectory(directory, true);
    const name = `${new Date().toISOString().replace(/:/gu, "-")}-${randomUUID()}.toml`;
    publish(directory, name, bytes, () => assertAvailable(directory, name));
    return Object.freeze({ name, path: join(directory, name) });
  });
}

export function deleteHistory(settingsPath: string, name: string, expected: HistoryDocument): void {
  if (historyLocation(settingsPath, name).legacy) throw new Error("Legacy recovery files are read-only");
  mutate(settingsPath, () => {
    const current = readHistory(settingsPath, name);
    assertExpected(current, expected);
    unlinkSync(current.path);
    flushMutation(dirname(current.path), current.path);
  });
}
