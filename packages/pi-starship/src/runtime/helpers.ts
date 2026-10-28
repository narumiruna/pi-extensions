import { constants } from "node:fs";
import { access, type FileHandle, open, opendir, realpath, stat } from "node:fs/promises";
import { basename, delimiter, dirname, extname, join, resolve } from "node:path";
import type { CollectorContext, WorkspaceEntry, WorkspaceFileSystem, WorkspaceRefreshInput } from "./types.js";

export { formatVersion } from "../format/version.js";

export const MAX_METADATA_FILE_BYTES = 64 * 1024;
export const COMMAND_TIMEOUT_MS = 2_000;
export const MAX_COMMAND_OUTPUT_BYTES = 64 * 1024;
const MAX_DIRECTORY_ENTRIES = 2_048;
const MAX_LABEL_LENGTH = 160;

export function createFileSystem(input: WorkspaceRefreshInput): WorkspaceFileSystem {
  const defaults: WorkspaceFileSystem = {
    async readFile(path, maxBytes) {
      if (input.signal?.aborted) return undefined;
      let handle: FileHandle | undefined;
      try {
        handle = await open(path, "r");
        const info = await handle.stat();
        if (!info.isFile() || info.size > maxBytes) return undefined;
        // procfs can report zero bytes and sysfs can report a nominal page size.
        // Read through EOF, not stat.size, while keeping one overflow byte.
        const buffer = Buffer.alloc(maxBytes + 1);
        let offset = 0;
        while (offset < buffer.length) {
          if (input.signal?.aborted) return undefined;
          const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, null);
          if (bytesRead === 0) break;
          offset += bytesRead;
        }
        if (input.signal?.aborted || offset > maxBytes) return undefined;
        return buffer.subarray(0, offset).toString("utf8");
      } catch {
        return undefined;
      } finally {
        await handle?.close().catch(() => undefined);
      }
    },
    async readDirectory(path) {
      if (input.signal?.aborted) return [];
      const entries: WorkspaceEntry[] = [];
      try {
        const directory = await opendir(path);
        for await (const entry of directory) {
          if (input.signal?.aborted) break;
          entries.push({
            name: entry.name,
            isFile: entry.isFile(),
            isDirectory: entry.isDirectory(),
          });
          if (entries.length >= MAX_DIRECTORY_ENTRIES) break;
        }
      } catch {
        return [];
      }
      return entries;
    },
    async fileExists(path) {
      try {
        await stat(path);
        return true;
      } catch {
        return false;
      }
    },
    async realPath(path) {
      try {
        return await realpath(path);
      } catch {
        return undefined;
      }
    },
    async isWritable(path) {
      try {
        await access(path, constants.W_OK);
        return true;
      } catch (error) {
        const code = isRecord(error) ? error.code : undefined;
        return code === "EACCES" || code === "EPERM" || code === "EROFS" ? false : undefined;
      }
    },
  };
  return {
    ...defaults,
    ...input.fileSystem,
    ...(input.fileExists ? { fileExists: input.fileExists } : {}),
  };
}

export function safeMetadata(value: unknown, maxLength = MAX_LABEL_LENGTH): string | undefined {
  if (typeof value !== "string") return undefined;
  const sanitized = Array.from(value, (character) => {
    const code = character.codePointAt(0) ?? 0;
    return code <= 0x1f || (code >= 0x7f && code <= 0x9f) || (code >= 0xd800 && code <= 0xdfff) ? "" : character;
  })
    .join("")
    .trim();
  if (!sanitized) return undefined;
  return Array.from(sanitized).slice(0, maxLength).join("");
}

export function ownString(record: unknown, key: string): string | undefined {
  if (!isRecord(record) || !Object.hasOwn(record, key)) return undefined;
  return safeMetadata(record[key]);
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function setString(record: Record<string, string>, key: string, value: unknown): void {
  const safe = safeMetadata(value);
  if (!safe) return;
  Object.defineProperty(record, key, {
    value: safe,
    writable: true,
    enumerable: true,
    configurable: true,
  });
}

export function optionString(
  context: CollectorContext,
  module: Parameters<CollectorContext["options"]>[0],
  key: string,
): string | undefined {
  const value = context.options(module)[key];
  return typeof value === "string" ? value : undefined;
}

export function optionBoolean(
  context: CollectorContext,
  module: Parameters<CollectorContext["options"]>[0],
  key: string,
): boolean {
  return context.options(module)[key] === true;
}

export function optionNumber(
  context: CollectorContext,
  module: Parameters<CollectorContext["options"]>[0],
  key: string,
): number | undefined {
  const value = context.options(module)[key];
  return typeof value === "number" ? value : undefined;
}

export function optionStrings(
  context: CollectorContext,
  module: Parameters<CollectorContext["options"]>[0],
  key: string,
): readonly string[] {
  const value = context.options(module)[key];
  return Array.isArray(value) && value.every((item) => typeof item === "string") ? value : [];
}

export function optionMap(
  context: CollectorContext,
  module: Parameters<CollectorContext["options"]>[0],
  key: string,
): Readonly<Record<string, string>> {
  const value = context.options(module)[key];
  return isRecord(value) ? (value as Record<string, string>) : {};
}

export function exactAlias(value: string | undefined, aliases: Readonly<Record<string, string>>) {
  if (!value) return undefined;
  return Object.hasOwn(aliases, value) ? safeMetadata(aliases[value]) : value;
}

/** Empty values count as present, as in Starship's Context::detect_env_vars. */
export function detectEnvironment(
  environment: Readonly<Record<string, string | undefined>>,
  names: readonly string[],
): boolean {
  if (names.length === 0) return true;
  let hasPositive = false;
  let positiveMatch = false;
  for (const name of names) {
    const negative = name.startsWith("!");
    const key = negative ? name.slice(1) : name;
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(key)) return false;
    const present = Object.hasOwn(environment, key) && typeof environment[key] === "string";
    if (negative && present) return false;
    if (!negative) {
      hasPositive = true;
      positiveMatch ||= present;
    }
  }
  return !hasPositive || positiveMatch;
}

export async function runBounded(
  context: CollectorContext,
  command: string,
  args: string[],
): Promise<string | undefined> {
  if (context.input.signal?.aborted) return undefined;
  try {
    const result = await context.input.exec(command, args, {
      cwd: context.input.cwd,
      timeout: COMMAND_TIMEOUT_MS,
      maxOutputBytes: MAX_COMMAND_OUTPUT_BYTES,
      signal: context.input.signal,
      environment: context.input.environment,
    });
    if (context.input.signal?.aborted || result.code !== 0 || result.killed) return undefined;
    const selectedOutput = result.stdout || result.stderr;
    const output = Buffer.from(selectedOutput).subarray(0, MAX_COMMAND_OUTPUT_BYTES + 1);
    if (output.byteLength > MAX_COMMAND_OUTPUT_BYTES) return undefined;
    return output.toString("utf8");
  } catch {
    return undefined;
  }
}

export function parseIni(source: string): Record<string, Record<string, string>> {
  const result: Record<string, Record<string, string>> = {};
  let section = "";
  for (const rawLine of source.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#") || line.startsWith(";")) continue;
    const sectionMatch = /^\[([^\]]+)\]$/u.exec(line);
    if (sectionMatch?.[1]) {
      section = sectionMatch[1].trim();
      if (!Object.hasOwn(result, section)) setOwn(result, section, {});
      continue;
    }
    const separator = line.indexOf("=");
    if (separator <= 0) continue;
    const key = line.slice(0, separator).trim();
    const value = safeMetadata(line.slice(separator + 1));
    if (!value) continue;
    if (!Object.hasOwn(result, section)) setOwn(result, section, {});
    setOwn(result[section] as Record<string, string>, key, value);
  }
  return result;
}

export function envPathList(value: string | undefined): string[] {
  return (value ?? "")
    .split(delimiter)
    .map((part) => part.trim())
    .filter(Boolean);
}

export function directMatch(
  entries: readonly WorkspaceEntry[],
  files: readonly string[],
  extensions: readonly string[],
  folders: readonly string[],
): boolean {
  const positiveFiles = files.filter((value) => !value.startsWith("!"));
  const negativeFiles = new Set(files.filter((value) => value.startsWith("!")).map((v) => v.slice(1)));
  const positiveExtensions = extensions
    .filter((value) => !value.startsWith("!"))
    .map((value) => value.replace(/^\./u, ""));
  const negativeExtensions = new Set(
    extensions.filter((value) => value.startsWith("!")).map((value) => value.slice(1).replace(/^\./u, "")),
  );
  const positiveFolders = folders.filter((value) => !value.startsWith("!"));
  const negativeFolders = new Set(folders.filter((value) => value.startsWith("!")).map((value) => value.slice(1)));
  if (
    entries.some(
      (entry) =>
        negativeFiles.has(entry.name) ||
        (entry.isFile && negativeExtensions.has(extname(entry.name).slice(1))) ||
        (entry.isDirectory && negativeFolders.has(entry.name)),
    )
  ) {
    return false;
  }
  return entries.some(
    (entry) =>
      positiveFiles.includes(entry.name) ||
      (entry.isFile && positiveExtensions.includes(extname(entry.name).slice(1))) ||
      (entry.isDirectory && positiveFolders.includes(entry.name)),
  );
}

export function parentDirectories(start: string, limit: number): string[] {
  const result: string[] = [];
  let current = resolve(start);
  for (let index = 0; index < limit; index += 1) {
    const parent = dirname(current);
    if (parent === current) break;
    result.push(parent);
    current = parent;
  }
  return result;
}

export function pathName(path: string): string {
  return basename(path.replace(/[\\/]+$/u, "")) || path;
}

export function joinHome(input: WorkspaceRefreshInput, ...parts: string[]): string {
  return join(input.homeDir, ...parts);
}

function setOwn<T>(record: Record<string, T>, key: string, value: T): void {
  Object.defineProperty(record, key, {
    value,
    writable: true,
    enumerable: true,
    configurable: true,
  });
}
