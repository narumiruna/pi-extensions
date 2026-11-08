import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { GitFileContext, GitProjectInfo, GitRevisionFile } from "./git-context.js";

const DEFAULT_MAX_FILES = 5_000;
const DEFAULT_MAX_BYTES = 1_000_000;
export const MAX_QUOTE_BYTES = 50_000;
export const MAX_QUOTE_LINES = 500;
export const MAX_PENDING_QUOTES = 8;
export const MAX_PENDING_QUOTE_BYTES = 100_000;
const IGNORED_DIRECTORIES = new Set([
  ".git",
  ".hg",
  ".svn",
  ".next",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "target",
]);

export interface FileQuoteGitProvenance {
  head: string;
  branch?: string;
  status?: string;
  revision?: string;
  blob?: string;
  contentSha256: string;
  source?: "worktree" | "revision" | "git_diff";
  base?: string;
}

export type FileQuoteGitProvenanceInput = Omit<FileQuoteGitProvenance, "contentSha256">;

export interface FileQuote {
  path: string;
  startLine: number;
  endLine: number;
  text: string;
  git?: FileQuoteGitProvenance;
}

export interface LoadedProjectTextFile {
  path: string;
  lines: string[];
}

interface DiscoveryOptions {
  maxFiles?: number;
  signal?: AbortSignal;
}

interface LoadOptions {
  maxBytes?: number;
  beforeOpen?: () => Promise<void>;
  signal?: AbortSignal;
}

export async function discoverProjectFiles(root: string, options: DiscoveryOptions = {}): Promise<string[]> {
  const maxFiles = Math.max(1, options.maxFiles ?? DEFAULT_MAX_FILES);
  const files: string[] = [];
  options.signal?.throwIfAborted();

  const canonicalRoot = await realpath(root);
  const directories: Array<{ directory: string; prefix: string }> = [{ directory: canonicalRoot, prefix: "" }];
  options.signal?.throwIfAborted();

  for (let index = 0; index < directories.length && files.length < maxFiles; index += 1) {
    options.signal?.throwIfAborted();
    const current = directories[index];
    if (!current) break;
    const { directory, prefix } = current;
    const entries = (await readdir(directory, { withFileTypes: true })).sort((left, right) =>
      compareStrings(left.name, right.name),
    );
    options.signal?.throwIfAborted();
    for (const entry of entries) {
      options.signal?.throwIfAborted();
      if (IGNORED_DIRECTORIES.has(entry.name) || entry.isSymbolicLink()) continue;
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
      const absolutePath = resolve(directory, entry.name);
      if (entry.isDirectory()) {
        directories.push({ directory: absolutePath, prefix: relativePath });
      } else if (entry.isFile()) {
        files.push(relativePath);
        if (files.length >= maxFiles) break;
      }
    }
  }
  options.signal?.throwIfAborted();
  return files.sort(compareStrings);
}

export async function loadProjectTextFile(
  root: string,
  projectPath: string,
  options: LoadOptions = {},
): Promise<LoadedProjectTextFile> {
  options.signal?.throwIfAborted();
  if (!projectPath || isAbsolute(projectPath)) throw new Error("File path is outside the project");
  const canonicalRoot = await realpath(root);
  options.signal?.throwIfAborted();
  const candidate = resolve(canonicalRoot, projectPath);
  if (!isInside(canonicalRoot, candidate)) throw new Error("File path is outside the project");

  let canonicalFile: string;
  try {
    canonicalFile = await realpath(candidate);
  } catch (error: unknown) {
    throw new Error(`Cannot open ${projectPath}: ${formatError(error)}`);
  }
  options.signal?.throwIfAborted();
  if (!isInside(canonicalRoot, canonicalFile)) throw new Error("File path is outside the project");
  const info = await lstat(canonicalFile);
  options.signal?.throwIfAborted();
  if (!info.isFile()) throw new Error(`${projectPath} is not a regular file`);

  const maxBytes = Math.max(1, options.maxBytes ?? DEFAULT_MAX_BYTES);
  if (info.size > maxBytes) throw new Error(`${projectPath} exceeds ${maxBytes} bytes`);
  await options.beforeOpen?.();
  options.signal?.throwIfAborted();
  let file: Awaited<ReturnType<typeof open>>;
  try {
    file = await open(canonicalFile, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  } catch (error: unknown) {
    throw new Error(`Cannot safely open ${projectPath}: ${formatError(error)}`);
  }
  try {
    options.signal?.throwIfAborted();
    const openedInfo = await file.stat();
    options.signal?.throwIfAborted();
    if (!openedInfo.isFile()) throw new Error(`${projectPath} is not a regular file`);
    if (openedInfo.dev !== info.dev || openedInfo.ino !== info.ino) {
      throw new Error(`${projectPath} changed while it was being opened safely`);
    }
    if (openedInfo.size > maxBytes) throw new Error(`${projectPath} exceeds ${maxBytes} bytes`);
    const buffer = Buffer.alloc(maxBytes + 1);
    let offset = 0;
    while (offset < buffer.length) {
      options.signal?.throwIfAborted();
      const { bytesRead } = await file.read(buffer, offset, buffer.length - offset, offset);
      options.signal?.throwIfAborted();
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (offset > maxBytes) throw new Error(`${projectPath} exceeds ${maxBytes} bytes`);
    const contents = buffer.subarray(0, offset);
    if (contents.includes(0)) throw new Error(`${projectPath} appears to be binary`);
    return {
      path: projectPath.replaceAll("\\", "/"),
      lines: normalizeTextLines(contents.toString("utf8")),
    };
  } finally {
    await file.close();
  }
}

export function createFileQuote(
  path: string,
  lines: readonly string[],
  anchorIndex: number,
  cursorIndex: number,
  git?: FileQuoteGitProvenanceInput,
): FileQuote {
  if (lines.length === 0) throw new Error("Cannot quote an empty file");
  const startIndex = Math.max(0, Math.min(anchorIndex, cursorIndex, lines.length - 1));
  const endIndex = Math.max(0, Math.min(Math.max(anchorIndex, cursorIndex), lines.length - 1));
  const text = lines.slice(startIndex, endIndex + 1).join("\n");
  return createFileQuoteSnapshot(path, startIndex + 1, endIndex + 1, text, git);
}

export function createFileQuoteSnapshot(
  path: string,
  startLine: number,
  endLine: number,
  text: string,
  git?: FileQuoteGitProvenanceInput,
): FileQuote {
  if (!Number.isSafeInteger(startLine) || !Number.isSafeInteger(endLine) || startLine < 1) {
    throw new Error("Quote lines must be positive integers");
  }
  if (endLine < startLine) throw new Error("Quote end line precedes its start line");
  if (text.split("\n").length > MAX_QUOTE_LINES) {
    throw new Error(`Quote exceeds ${MAX_QUOTE_LINES} lines`);
  }
  if (Buffer.byteLength(text, "utf8") > MAX_QUOTE_BYTES) {
    throw new Error(`Quote exceeds ${MAX_QUOTE_BYTES} bytes`);
  }
  return {
    path,
    startLine,
    endLine,
    text,
    ...(git
      ? {
          git: {
            head: git.head,
            ...(git.branch !== undefined ? { branch: git.branch } : {}),
            ...(git.status !== undefined ? { status: git.status } : {}),
            ...(git.revision !== undefined ? { revision: git.revision } : {}),
            ...(git.blob !== undefined ? { blob: git.blob } : {}),
            contentSha256: createHash("sha256").update(text, "utf8").digest("hex"),
            ...(git.source !== undefined ? { source: git.source } : {}),
            ...(git.base !== undefined ? { base: git.base } : {}),
          },
        }
      : {}),
  };
}

/** Capture the exact worktree or historical preview with selection-time provenance. */
export function createPreviewQuote(
  file: LoadedProjectTextFile,
  anchor: number,
  cursor: number,
  project?: GitProjectInfo,
  git?: GitFileContext,
  revision?: GitRevisionFile,
): FileQuote {
  return createFileQuote(
    file.path,
    file.lines,
    anchor,
    cursor,
    project
      ? {
          head: project.head,
          branch: project.branch,
          status: revision ? "historical" : (git?.status?.label ?? "clean"),
          revision: revision?.revision,
          blob: revision?.blob ?? git?.blob,
          source: revision ? "revision" : "worktree",
          base: revision ? undefined : "HEAD",
        }
      : undefined,
  );
}

export function appendPendingQuote(current: readonly FileQuote[], quote: FileQuote): FileQuote[] {
  if (current.length >= MAX_PENDING_QUOTES) {
    throw new Error(`File Context supports at most ${MAX_PENDING_QUOTES} pending quotes`);
  }
  const totalBytes = [...current, quote].reduce((total, item) => total + Buffer.byteLength(item.text, "utf8"), 0);
  if (totalBytes > MAX_PENDING_QUOTE_BYTES) {
    throw new Error(`Pending quotes exceed ${MAX_PENDING_QUOTE_BYTES} bytes`);
  }
  return [...current, quote];
}

export function formatPromptWithQuote(prompt: string, quote: FileQuote): string {
  return formatPromptWithQuotes(prompt, [quote]);
}

export function formatPromptWithQuotes(prompt: string, quotes: readonly FileQuote[]): string {
  if (quotes.length === 0) return prompt;
  return `${formatQuoteContext(quotes)}\n\n${prompt}`;
}

export function formatQuoteContext(quotes: readonly FileQuote[]): string {
  const blocks = quotes.map((quote) => {
    const path = escapeXml(quote.path);
    const text = escapeXml(quote.text);
    const attributes = [
      `path="${path}"`,
      `lines="${quote.startLine}-${quote.endLine}"`,
      ...formatGitAttributes(quote.git),
    ].join(" ");
    return `<user_file_quote ${attributes}>\n${text}\n</user_file_quote>`;
  });
  const description =
    quotes.length === 1
      ? "The user intentionally selected the file excerpt above."
      : "The user intentionally selected the file excerpts above.";
  return `${blocks.join("\n\n")}\n\n${description}`;
}

function normalizeTextLines(contents: string): string[] {
  if (contents === "") return [];
  const lines = contents.replaceAll("\r\n", "\n").replaceAll("\r", "\n").split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isInside(root: string, candidate: string): boolean {
  const result = relative(root, candidate);
  return result === "" || (!result.startsWith(`..${sep}`) && result !== ".." && !isAbsolute(result));
}

function formatGitAttributes(git: FileQuoteGitProvenance | undefined): string[] {
  if (!git) return [];
  return [
    ["git_head", git.head],
    ["git_branch", git.branch],
    ["git_status", git.status],
    ["git_revision", git.revision],
    ["git_blob", git.blob],
    ["content_sha256", git.contentSha256],
    ["source", git.source],
    ["git_base", git.base],
  ].flatMap(([name, value]) => (value ? [`${name}="${escapeXml(value)}"`] : []));
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
