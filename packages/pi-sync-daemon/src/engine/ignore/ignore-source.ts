import { createHash } from "node:crypto";
import { type BigIntStats, constants, lstatSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import ignore from "ignore";
import { isDeniedPath } from "../paths.js";

export const DEFAULT_IGNORE_FILENAME = ".syncignore";
export const DEFAULT_IGNORE_CREATION_RECORD = ".pi-sync.json.syncignore-creation";
export const DEFAULT_IGNORE_RULES = "/auth.json\n/git/\n/npm/\n/sessions/\n/truth.json\n";
export const MAX_IGNORE_BYTES = 64 * 1024;
const MAX_MATCH_PATH_BYTES = 4_096;
const MATCH_CACHE_PATH_BUDGET = 2_048;

const RESERVED_FILENAMES = new Set([
  "auth.json",
  "auth.json.lock",
  "trust.json",
  "trust.json.lock",
  "settings.json",
  "settings.json.lock",
  "models.json",
  "models-store.json",
  "models-store.json.lock",
  "keybindings.json",
  "agents.md",
  "system.md",
  "append_system.md",
  "crashes.json",
  "pi-debug.log",
  "extensions",
  "skills",
  "prompts",
  "themes",
  "npm",
  "sessions",
]);

export type IgnoreSource = { filename: string; text: string; sourceDigest: string } & (
  | { present: false; identity?: undefined }
  | { present: true; identity: string }
);

export function validateIgnoreFilename(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9._ -]{1,255}$/u.test(value) || /^[ ]|[. ]$/u.test(value)) {
    throw new Error("Invalid sync.ignoreFile: use one safe filename in the Pi agent directory.");
  }
  const lower = value.toLowerCase();
  if (
    /^(?:con|prn|aux|nul|com[0-9]|lpt[0-9]) *(?:\.|$)/u.test(lower) ||
    (lower === DEFAULT_IGNORE_FILENAME && value !== DEFAULT_IGNORE_FILENAME) ||
    RESERVED_FILENAMES.has(lower) ||
    isDeniedPath(lower)
  ) {
    throw new Error(`Invalid sync.ignoreFile: "${value}" is a reserved filename.`);
  }
  return value;
}

export class IgnoreCreationPendingError extends Error {
  constructor() {
    super(
      `unfinished creation record "${DEFAULT_IGNORE_CREATION_RECORD}"; retry confirmed setup or migration to verify the starter file, or repair the incomplete creation first`,
    );
  }
}

export async function readIgnoreSource(
  root: string,
  filename = DEFAULT_IGNORE_FILENAME,
  signal?: AbortSignal,
): Promise<IgnoreSource> {
  signal?.throwIfAborted();
  filename = validateIgnoreFilename(filename);
  try {
    const absoluteRoot = path.resolve(root);
    const rootStat = await fs.lstat(absoluteRoot, { bigint: true });
    if (!rootStat.isDirectory()) throw new Error("the Pi agent directory is not a regular directory");
    const canonicalRoot = await fs.realpath(absoluteRoot);
    const checkRoot = async () => {
      const currentRealpath = await fs.realpath(absoluteRoot);
      const current = await fs.lstat(absoluteRoot, { bigint: true });
      if (currentRealpath !== canonicalRoot || !current.isDirectory() || !sameIdentity(rootStat, current)) changed();
      signal?.throwIfAborted();
      checkCreationRecord();
    };
    const target = path.join(canonicalRoot, filename);
    const checkCreationRecord = () => {
      if (
        filename === DEFAULT_IGNORE_FILENAME &&
        lstatSync(path.join(canonicalRoot, DEFAULT_IGNORE_CREATION_RECORD), { throwIfNoEntry: false })
      ) {
        throw new IgnoreCreationPendingError();
      }
    };
    checkCreationRecord();
    const before = await statIfPresent(target);
    await checkRoot();
    if (!before) {
      if (filename !== DEFAULT_IGNORE_FILENAME) throw new Error("the selected file does not exist");
      checkCreationRecord();
      if (lstatSync(target, { throwIfNoEntry: false })) changed();
      signal?.throwIfAborted();
      return {
        filename,
        text: DEFAULT_IGNORE_RULES,
        sourceDigest: ignoreSourceDigest(filename, false, Buffer.from(DEFAULT_IGNORE_RULES)),
        present: false,
      };
    }
    if (!before.isFile() || before.nlink !== 1n) throw new Error("use a regular file with no symlinks or hard links");
    assertIgnoreSize(before.size);
    if ((await fs.realpath(target)) !== target) throw new Error("use the exact on-disk filename, not a path alias");
    const bytes = await readIgnoreBytes(target, before, checkRoot, signal);
    await checkRoot();
    checkCreationRecord();
    const current = lstatSync(target, { bigint: true, throwIfNoEntry: false });
    if (!current || !sameFile(before, current)) changed();
    signal?.throwIfAborted();
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    } catch (cause) {
      throw new Error("the file is not valid UTF-8", { cause });
    }
    if (text.includes("\0")) throw new Error("the file contains NUL characters");
    return {
      filename,
      text,
      sourceDigest: ignoreSourceDigest(filename, true, bytes),
      present: true,
      identity: ignoreFileIdentity(before),
    };
  } catch (cause) {
    signal?.throwIfAborted();
    const detail = (cause as NodeJS.ErrnoException).code
      ? "could not verify or read the file"
      : (cause as Error).message;
    throw new Error(`Ignore file "${filename}": ${detail}.`, { cause });
  }
}

async function statIfPresent(target: string) {
  try {
    return await fs.lstat(target, { bigint: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

export function ignoreFileIdentity(stat: BigIntStats) {
  return `${stat.dev}:${stat.ino}:${stat.birthtimeNs}`;
}

export function sameIdentity(left: BigIntStats, right: BigIntStats) {
  return left.dev === right.dev && left.ino === right.ino && left.birthtimeNs === right.birthtimeNs;
}

export function sameFile(left: BigIntStats, right: BigIntStats) {
  return (
    sameIdentity(left, right) &&
    left.mode === right.mode &&
    left.uid === right.uid &&
    left.gid === right.gid &&
    left.nlink === right.nlink &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

function changed(): never {
  throw new Error("the file or Pi agent directory changed during the read; retry");
}

async function readIgnoreBytes(
  target: string,
  before: BigIntStats,
  checkRoot: () => Promise<void>,
  signal?: AbortSignal,
) {
  signal?.throwIfAborted();
  const flags = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);
  const handle = await fs.open(target, flags);
  try {
    if (!sameFile(before, await handle.stat({ bigint: true }))) changed();
    await checkRoot();
    const buffer = Buffer.alloc(Number(before.size) + 1);
    let count = 0;
    while (count < buffer.length) {
      signal?.throwIfAborted();
      const { bytesRead } = await handle.read(buffer, count, buffer.length - count, count);
      if (bytesRead === 0) break;
      count += bytesRead;
    }
    if (count !== Number(before.size)) changed();
    if (!sameFile(before, await fs.lstat(target, { bigint: true }))) changed();
    await checkRoot();
    if (!sameFile(before, await handle.stat({ bigint: true }))) changed();
    return buffer.subarray(0, count);
  } finally {
    await handle.close();
  }
}

function assertIgnoreSize(bytes: number | bigint) {
  if (bytes > MAX_IGNORE_BYTES) throw new Error(`rules exceed the ${MAX_IGNORE_BYTES}-byte limit`);
}

export function ignoreSourceDigest(filename: string, present: boolean, bytes: Buffer) {
  return createHash("sha256")
    .update("pi-sync-ignore-source-v1\0")
    .update(filename)
    .update(present ? "\0present\0" : "\0absent\0")
    .update(bytes)
    .digest("hex");
}

export function ignorePolicyFingerprint(text: string, sessions: boolean): string {
  return createHash("sha256")
    .update(JSON.stringify(["pi-sync-ignore-policy-v1", sessions, text]))
    .digest("hex");
}

function gitByteString(value: string): string {
  return Buffer.from(value, "utf8").toString("latin1");
}

export function compileIgnoreRules(text: string): (path: string, directory?: boolean) => boolean {
  assertIgnoreSize(Buffer.byteLength(text, "utf8"));
  if (!text.isWellFormed() || text.includes("\0")) throw new Error("Ignore rules must be UTF-8 text without NULs.");
  const rules = text.replace(/^\uFEFF/u, "");
  for (const [index, line] of rules.split("\n").entries()) {
    if (line.startsWith("#")) continue;
    for (let position = 0; position < line.length; position++) {
      if (line[position] !== "\\") continue;
      if (line[++position] === "/") {
        throw new Error(`Ignore rule on line ${index + 1} uses an unsupported escaped path separator.`);
      }
    }
  }
  const compiled = ignore({ ignorecase: false }).add(gitByteString(rules));
  let matcher = ignore({ ignorecase: false }).add(compiled);
  let cachedPathUpperBound = 0;
  return (relativePath, directory = false) => {
    if (Buffer.byteLength(relativePath, "utf8") > MAX_MATCH_PATH_BYTES) {
      throw new Error(`Ignore matching path exceeds the ${MAX_MATCH_PATH_BYTES}-byte limit.`);
    }
    const segments = relativePath.split("/");
    if (
      !relativePath.isWellFormed() ||
      relativePath.includes("\\") ||
      relativePath.includes("\0") ||
      /^[a-z]:/iu.test(relativePath) ||
      segments.some((part) => !part || part === "." || part === "..")
    ) {
      throw new Error("Ignore matching requires a canonical relative path with / separators.");
    }
    if (cachedPathUpperBound + segments.length > MATCH_CACHE_PATH_BUDGET) {
      matcher = ignore({ ignorecase: false }).add(compiled);
      cachedPathUpperBound = 0;
    }
    cachedPathUpperBound += segments.length;
    const serializedPath = gitByteString(relativePath);
    return matcher.ignores(directory ? `${serializedPath}/` : serializedPath);
  };
}
