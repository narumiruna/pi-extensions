import { createHash, randomUUID } from "node:crypto";
import { type Dir, constants as fsConstants } from "node:fs";
import { link, lstat, mkdir, open, opendir, readFile, realpath, rename, stat, unlink } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep, win32 } from "node:path";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { sanitizeTerminalText } from "@narumitw/pi-tui-kit/terminal-text";
import {
  MAX_DISCOVERED_FILES,
  MAX_MARKDOWN_BYTES,
  MAX_MARKDOWN_LINES,
  MAX_SCAN_DEPTH,
  MAX_SCAN_ERRORS,
  NOTES_DIRECTORY,
  SESSIONS_DIRECTORY,
  TEMPLATES_DIRECTORY,
} from "./constants.js";

export interface NotesPaths {
  root: string;
  notes: string;
  templates: string;
  sessions: string;
}

export interface MarkdownEntry {
  /** Raw normalized relative path used as the stable file identity. */
  relativePath: string;
  /** Presentation-only path with terminal controls removed. */
  displayPath: string;
  size: number;
}

export interface DiscoveryError {
  relativePath?: string;
  message: string;
}

export interface DiscoveryResult {
  entries: MarkdownEntry[];
  errors: DiscoveryError[];
  limited: boolean;
}

export interface NoteSnapshot {
  relativePath: string;
  content: string;
  revision: string;
  size: number;
}

export interface NotesStorageOptions {
  /** Test seam invoked after a complete temporary file is synced and before publication. */
  beforePublish?(targetPath: string, temporaryPath: string): Promise<void> | void;
}

export class NotesStorage {
  readonly paths: NotesPaths;
  private readonly beforePublish?: NotesStorageOptions["beforePublish"];

  constructor(agentDir: string, options: NotesStorageOptions = {}) {
    const root = join(agentDir, "pi-notes");
    this.paths = {
      root,
      notes: join(root, NOTES_DIRECTORY),
      templates: join(root, TEMPLATES_DIRECTORY),
      sessions: join(root, SESSIONS_DIRECTORY),
    };
    this.beforePublish = options.beforePublish;
  }

  async initialize(signal?: AbortSignal): Promise<NotesPaths> {
    throwIfAborted(signal);
    await mkdir(this.paths.root, { recursive: true, mode: 0o700 });
    await verifyManagedDirectory(this.paths.root, signal);
    for (const directory of [this.paths.notes, this.paths.templates, this.paths.sessions]) {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      await verifyManagedDirectory(directory, signal);
    }
    return this.paths;
  }

  async discoverNotes(signal?: AbortSignal): Promise<DiscoveryResult> {
    return discoverMarkdown(this.paths.notes, signal);
  }

  async discoverTemplates(signal?: AbortSignal): Promise<DiscoveryResult> {
    return discoverMarkdown(this.paths.templates, signal);
  }

  async readNote(relativePath: string, signal?: AbortSignal): Promise<NoteSnapshot> {
    const resolved = await resolveExistingMarkdown(this.paths.notes, relativePath, signal);
    const content = await readBoundedMarkdown(resolved.absolutePath, "Note", signal);
    return snapshot(resolved.relativePath, content);
  }

  async readTemplate(relativePath: string, signal?: AbortSignal): Promise<string> {
    const resolved = await resolveExistingMarkdown(this.paths.templates, relativePath, signal);
    return readBoundedMarkdown(resolved.absolutePath, "Template", signal);
  }

  async createNote(
    relativePath: string,
    options: { templatePath?: string; signal?: AbortSignal } = {},
  ): Promise<NoteSnapshot> {
    const normalized = normalizeRelativeMarkdownPath(relativePath);
    const content = options.templatePath ? await this.readTemplate(options.templatePath, options.signal) : "";
    validateMarkdownContent(content, "Note");
    const root = await canonicalDirectory(this.paths.notes, options.signal);
    const target = resolve(root, ...normalized.split("/"));
    assertContained(root, target);
    await ensureSafeParent(root, dirname(target), options.signal);
    throwIfAborted(options.signal);
    try {
      await lstat(target);
      throw new Error(`Note already exists: ${normalized}`);
    } catch (error) {
      if (!isNodeError(error, "ENOENT")) throw error;
    }
    await atomicCreate(root, target, content, options.signal, this.beforePublish);
    return snapshot(normalized, content);
  }

  async editNote(
    relativePath: string,
    expectedRevision: string,
    oldText: string,
    newText: string,
    signal?: AbortSignal,
  ): Promise<NoteSnapshot> {
    if (!oldText) throw new Error("oldText must not be empty; use replace_current_note for a full replacement");
    const normalized = normalizeExistingMarkdownPath(relativePath);
    const queuePath = resolve(this.paths.notes, ...normalized.split("/"));
    return withFileMutationQueue(queuePath, async () => {
      throwIfAborted(signal);
      const current = await this.readNote(normalized, signal);
      assertRevision(current, expectedRevision);
      const index = current.content.indexOf(oldText);
      if (index < 0) throw new Error("oldText was not found in the current note");
      if (current.content.indexOf(oldText, index + oldText.length) >= 0) {
        throw new Error("oldText is not unique in the current note");
      }
      const content = `${current.content.slice(0, index)}${newText}${current.content.slice(index + oldText.length)}`;
      validateMarkdownContent(content, "Note");
      await atomicReplace(this.paths.notes, queuePath, content, current.revision, signal, this.beforePublish);
      return snapshot(normalized, content);
    });
  }

  async replaceNote(
    relativePath: string,
    expectedRevision: string,
    content: string,
    signal?: AbortSignal,
  ): Promise<NoteSnapshot> {
    const normalized = normalizeExistingMarkdownPath(relativePath);
    validateMarkdownContent(content, "Note");
    const queuePath = resolve(this.paths.notes, ...normalized.split("/"));
    return withFileMutationQueue(queuePath, async () => {
      throwIfAborted(signal);
      const current = await this.readNote(normalized, signal);
      assertRevision(current, expectedRevision);
      await atomicReplace(this.paths.notes, queuePath, content, current.revision, signal, this.beforePublish);
      return snapshot(normalized, content);
    });
  }
}

export function normalizeRelativeMarkdownPath(input: string): string {
  if (input !== input.trim()) throw new Error("Note path must not start or end with whitespace");
  if (!input) throw new Error("Note path is required");
  if (
    [...input].some((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint <= 0x1f || codePoint === 0x7f;
    })
  ) {
    throw new Error("Note path must not contain control characters");
  }
  if (isAbsolute(input) || win32.isAbsolute(input)) throw new Error("Note path must be relative");
  const portable = input.replaceAll("\\", "/");
  const segments = portable.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
    throw new Error("Note path must not contain empty, . or .. segments");
  }
  if (!portable.toLowerCase().endsWith(".md")) throw new Error("Note path must end in .md");
  return segments.join("/");
}

function normalizeExistingMarkdownPath(input: string): string {
  if (!input) throw new Error("Markdown path is required");
  if (isAbsolute(input) || win32.isAbsolute(input)) throw new Error("Markdown path must be relative");
  const segments = input.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
    throw new Error("Markdown path must not contain empty, . or .. segments");
  }
  if (!input.toLowerCase().endsWith(".md")) throw new Error("Markdown path must end in .md");
  return segments.join("/");
}

export function revisionFor(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

export function validateMarkdownContent(content: string, label: string): void {
  const bytes = Buffer.byteLength(content, "utf8");
  if (bytes > MAX_MARKDOWN_BYTES) {
    throw new Error(`${label} exceeds the ${MAX_MARKDOWN_BYTES}-byte limit`);
  }
  const lines = content.length === 0 ? 0 : content.split("\n").length;
  if (lines > MAX_MARKDOWN_LINES) {
    throw new Error(`${label} exceeds the ${MAX_MARKDOWN_LINES}-line limit`);
  }
}

async function discoverMarkdown(rootPath: string, signal?: AbortSignal): Promise<DiscoveryResult> {
  const root = await canonicalDirectory(rootPath, signal);
  const entries: MarkdownEntry[] = [];
  const errors: DiscoveryError[] = [];
  let limited = false;

  const report = (message: string, relativePath?: string) => {
    if (errors.length >= MAX_SCAN_ERRORS) {
      limited = true;
      return;
    }
    errors.push({ ...(relativePath ? { relativePath } : {}), message });
  };

  const visit = async (directory: string, depth: number): Promise<void> => {
    if (entries.length >= MAX_DISCOVERED_FILES || limited) {
      limited = true;
      return;
    }
    if (depth > MAX_SCAN_DEPTH) {
      report(`Directory nesting exceeds the ${MAX_SCAN_DEPTH}-level limit`, normalizeDiscoveredPath(root, directory));
      return;
    }
    throwIfAborted(signal);
    let handle: Dir | undefined;
    try {
      handle = await opendir(directory);
    } catch (error) {
      report(safeErrorMessage(error), normalizeDiscoveredPath(root, directory));
      return;
    }
    try {
      for await (const entry of handle) {
        throwIfAborted(signal);
        const absolutePath = join(directory, entry.name);
        const relativePath = normalizeDiscoveredPath(root, absolutePath);
        if (entry.isSymbolicLink()) {
          report("Symbolic links are not managed", relativePath);
          continue;
        }
        if (entry.isDirectory()) {
          await visit(absolutePath, depth + 1);
          continue;
        }
        if (!entry.name.toLowerCase().endsWith(".md")) continue;
        if (!entry.isFile()) {
          report("Entry is not a regular file", relativePath);
          continue;
        }
        if (entries.length >= MAX_DISCOVERED_FILES) {
          limited = true;
          break;
        }
        try {
          const info = await stat(absolutePath);
          throwIfAborted(signal);
          if (!info.isFile()) {
            report("Entry is not a regular file", relativePath);
            continue;
          }
          if (info.size > MAX_MARKDOWN_BYTES) {
            report(`File exceeds the ${MAX_MARKDOWN_BYTES}-byte limit`, relativePath);
            continue;
          }
          await readBoundedMarkdown(absolutePath, "File", signal);
          entries.push({
            relativePath,
            displayPath: sanitizeTerminalText(relativePath),
            size: info.size,
          });
        } catch (error) {
          report(safeErrorMessage(error), relativePath);
        }
      }
    } finally {
      await handle?.close().catch(() => undefined);
    }
  };

  await visit(root, 0);
  entries.sort((first, second) => first.relativePath.localeCompare(second.relativePath));
  errors.sort((first, second) => (first.relativePath ?? "").localeCompare(second.relativePath ?? ""));
  if (limited && errors.length < MAX_SCAN_ERRORS) {
    report(`Discovery stopped at ${MAX_DISCOVERED_FILES} files or ${MAX_SCAN_ERRORS} errors`);
  }
  return { entries, errors, limited };
}

async function resolveExistingMarkdown(
  rootPath: string,
  relativePath: string,
  signal?: AbortSignal,
): Promise<{ relativePath: string; absolutePath: string }> {
  const normalized = normalizeExistingMarkdownPath(relativePath);
  const root = await canonicalDirectory(rootPath, signal);
  const candidate = resolve(root, ...normalized.split("/"));
  assertContained(root, candidate);
  throwIfAborted(signal);
  const linkInfo = await lstat(candidate);
  throwIfAborted(signal);
  if (linkInfo.isSymbolicLink()) throw new Error(`Symbolic-link notes are not supported: ${normalized}`);
  if (!linkInfo.isFile()) throw new Error(`Note is not a regular file: ${normalized}`);
  const canonical = await realpath(candidate);
  throwIfAborted(signal);
  assertContained(root, canonical);
  if (canonical !== candidate) throw new Error(`Note path is not canonical: ${normalized}`);
  return { relativePath: normalized, absolutePath: canonical };
}

async function verifyManagedDirectory(path: string, signal?: AbortSignal): Promise<void> {
  throwIfAborted(signal);
  const info = await lstat(path);
  throwIfAborted(signal);
  if (info.isSymbolicLink() || !info.isDirectory()) throw new Error(`${path} is not a regular directory`);
}

async function canonicalDirectory(path: string, signal?: AbortSignal): Promise<string> {
  throwIfAborted(signal);
  const directInfo = await lstat(path);
  throwIfAborted(signal);
  if (directInfo.isSymbolicLink() || !directInfo.isDirectory()) throw new Error(`${path} is not a regular directory`);
  const canonical = await realpath(path);
  throwIfAborted(signal);
  const info = await stat(canonical);
  throwIfAborted(signal);
  if (!info.isDirectory()) throw new Error(`${path} is not a directory`);
  return canonical;
}

async function ensureSafeParent(root: string, targetParent: string, signal?: AbortSignal): Promise<void> {
  assertContained(root, targetParent);
  const relativeParent = relative(root, targetParent);
  let current = root;
  if (!relativeParent) return;
  for (const segment of relativeParent.split(sep)) {
    current = join(current, segment);
    throwIfAborted(signal);
    try {
      const info = await lstat(current);
      throwIfAborted(signal);
      if (info.isSymbolicLink()) throw new Error(`Parent directory is a symbolic link: ${current}`);
      if (!info.isDirectory()) throw new Error(`Parent path is not a directory: ${current}`);
    } catch (error) {
      if (!isNodeError(error, "ENOENT")) throw error;
      await mkdir(current, { mode: 0o700 });
      throwIfAborted(signal);
    }
    const canonical = await realpath(current);
    throwIfAborted(signal);
    assertContained(root, canonical);
    if (canonical !== current) throw new Error(`Parent directory is not canonical: ${current}`);
  }
}

async function readBoundedMarkdown(path: string, label: string, signal?: AbortSignal): Promise<string> {
  throwIfAborted(signal);
  const info = await stat(path);
  throwIfAborted(signal);
  if (!info.isFile()) throw new Error(`${label} is not a regular file`);
  if (info.size > MAX_MARKDOWN_BYTES) throw new Error(`${label} exceeds the ${MAX_MARKDOWN_BYTES}-byte limit`);
  const content = await readFile(path, "utf8");
  throwIfAborted(signal);
  validateMarkdownContent(content, label);
  return content;
}

async function atomicCreate(
  rootPath: string,
  targetPath: string,
  content: string,
  signal?: AbortSignal,
  beforePublish?: NotesStorageOptions["beforePublish"],
): Promise<void> {
  const temporaryPath = temporaryName(targetPath);
  let published = false;
  try {
    await writeTemporary(temporaryPath, content, 0o600, signal);
    throwIfAborted(signal);
    await beforePublish?.(targetPath, temporaryPath);
    throwIfAborted(signal);
    await revalidateCanonicalParent(rootPath, targetPath, signal);
    throwIfAborted(signal);
    await link(temporaryPath, targetPath);
    published = true;
  } finally {
    await unlink(temporaryPath).catch((error: unknown) => {
      if (!isNodeError(error, "ENOENT") && !published) throw error;
    });
  }
}

async function atomicReplace(
  rootPath: string,
  targetPath: string,
  content: string,
  expectedRevision: string,
  signal?: AbortSignal,
  beforePublish?: NotesStorageOptions["beforePublish"],
): Promise<void> {
  const relativePath = relative(rootPath, targetPath).split(sep).join("/");
  const resolved = await resolveExistingMarkdown(rootPath, relativePath, signal);
  const current = await readBoundedMarkdown(resolved.absolutePath, "Note", signal);
  if (revisionFor(current) !== expectedRevision) throw new Error("Note changed before publication; read it again");
  const info = await stat(resolved.absolutePath);
  throwIfAborted(signal);
  const temporaryPath = temporaryName(targetPath);
  try {
    await writeTemporary(temporaryPath, content, info.mode & 0o777, signal);
    throwIfAborted(signal);
    await beforePublish?.(targetPath, temporaryPath);
    throwIfAborted(signal);
    const latestResolved = await resolveExistingMarkdown(rootPath, relativePath, signal);
    if (latestResolved.absolutePath !== resolved.absolutePath) {
      throw new Error("Note path changed before publication; read it again");
    }
    const latest = await readBoundedMarkdown(latestResolved.absolutePath, "Note", signal);
    if (revisionFor(latest) !== expectedRevision) throw new Error("Note changed before publication; read it again");
    throwIfAborted(signal);
    await rename(temporaryPath, latestResolved.absolutePath);
  } catch (error) {
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
}

async function revalidateCanonicalParent(rootPath: string, targetPath: string, signal?: AbortSignal): Promise<void> {
  const parent = dirname(targetPath);
  assertContained(rootPath, parent);
  throwIfAborted(signal);
  const canonical = await realpath(parent);
  throwIfAborted(signal);
  assertContained(rootPath, canonical);
  if (canonical !== parent) throw new Error("Note parent changed before publication");
}

async function writeTemporary(path: string, content: string, mode: number, signal?: AbortSignal): Promise<void> {
  throwIfAborted(signal);
  const handle = await open(path, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY, mode);
  try {
    throwIfAborted(signal);
    await handle.writeFile(content, "utf8");
    throwIfAborted(signal);
    await handle.sync();
    throwIfAborted(signal);
  } finally {
    await handle.close();
  }
}

function snapshot(relativePath: string, content: string): NoteSnapshot {
  return {
    relativePath,
    content,
    revision: revisionFor(content),
    size: Buffer.byteLength(content, "utf8"),
  };
}

function assertRevision(current: NoteSnapshot, expectedRevision: string): void {
  if (current.revision !== expectedRevision)
    throw new Error("Note revision is stale; read the current note before editing");
}

function assertContained(root: string, candidate: string): void {
  const nested = relative(root, candidate);
  if (nested === "" || (!nested.startsWith(`..${sep}`) && nested !== ".." && !isAbsolute(nested))) return;
  throw new Error("Path escapes the managed notes directory");
}

function normalizeDiscoveredPath(root: string, absolutePath: string): string {
  return relative(root, absolutePath).split(sep).join("/") || ".";
}

function temporaryName(targetPath: string): string {
  return join(dirname(targetPath), `.${basename(targetPath)}.${process.pid}.${randomUUID()}.tmp`);
}

function safeErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  throw signal.reason instanceof Error ? signal.reason : new DOMException("Operation aborted", "AbortError");
}
