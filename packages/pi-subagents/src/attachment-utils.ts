import { realpathSync } from "node:fs";
import * as path from "node:path";
import type ignore from "ignore";
import { sanitizeTerminalText } from "./message-broker.js";

export const ATTACHMENT_IGNORE_FILE_NAMES = [".gitignore", ".ignore", ".fdignore"];

export type IgnoreMatcher = ReturnType<typeof ignore>;

export function throwInvalidAttachmentIgnoreFile(): never {
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

export function prefixIgnorePattern(line: string, prefix: string): string | null {
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

export function toPosixPath(value: string): string {
  return value.split(path.sep).join("/");
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
