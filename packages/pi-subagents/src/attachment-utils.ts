import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import * as path from "node:path";
import type ignore from "ignore";
import { sanitizeTerminalText } from "./message-broker.js";

const ATTACHMENT_IGNORE_FILE_NAMES = [".gitignore", ".ignore", ".fdignore"];

export type IgnoreMatcher = ReturnType<typeof ignore>;

function throwInvalidAttachmentIgnoreFile(): never {
  throw new Error("Subagent attachment ignore files must be regular files.");
}

export function throwIfAttachmentAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  const error = new Error("Subagent attachment validation was cancelled.");
  error.name = "AbortError";
  throw error;
}

export function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function prefixIgnorePattern(line: string, prefix: string): string | null {
  const trimmed = line.trim();
  if (!trimmed || (trimmed.startsWith("#") && !trimmed.startsWith("\\#"))) return null;
  let pattern = line;
  let negated = false;
  if (pattern.startsWith("!")) {
    negated = true;
    pattern = pattern.slice(1);
  } else if (pattern.startsWith("\\!")) {
    pattern = pattern.slice(1);
  }
  if (pattern.startsWith("/")) pattern = pattern.slice(1);
  const prefixed = prefix ? `${prefix}${pattern}` : pattern;
  return negated ? `!${prefixed}` : prefixed;
}

export async function addAttachmentIgnoreRules(
  ignoreMatcher: IgnoreMatcher,
  directory: string,
  rootDirectory: string,
  signal: AbortSignal | undefined,
  accountForFile: (ignorePath: string, bytes: number) => void,
): Promise<void> {
  const relativeDirectory = path.relative(rootDirectory, directory);
  const prefix = relativeDirectory ? `${toPosixPath(relativeDirectory)}/` : "";
  for (const filename of ATTACHMENT_IGNORE_FILE_NAMES) {
    throwIfAttachmentAborted(signal);
    const ignorePath = path.join(directory, filename);
    let ignoreStats: Awaited<ReturnType<typeof stat>>;
    try {
      ignoreStats = await stat(ignorePath);
    } catch (error) {
      if (isAbortError(error)) throw error;
      throwIfAttachmentAborted(signal);
      continue;
    }
    if (!ignoreStats.isFile()) throwInvalidAttachmentIgnoreFile();
    accountForFile(ignorePath, ignoreStats.size);
    try {
      const content = await readFile(ignorePath, { encoding: "utf8", signal });
      throwIfAttachmentAborted(signal);
      const patterns = content
        .split(/\r?\n/u)
        .map((line) => prefixIgnorePattern(line, prefix))
        .filter((line): line is string => line !== null);
      if (patterns.length > 0) ignoreMatcher.add(patterns);
    } catch (error) {
      if (isAbortError(error)) throw error;
      throwIfAttachmentAborted(signal);
      // Pi ignores unreadable ignore files.
    }
  }
}

export function toPosixPath(value: string): string {
  return value.split(path.sep).join("/");
}

export function toolSourceId(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function realpath(value: string, label: string): string {
  try {
    return realpathSync(value);
  } catch {
    throw new Error(`${label} path does not exist: ${sanitizeTerminalText(value).slice(0, 512)}`);
  }
}

export function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
