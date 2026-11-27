import { randomUUID } from "node:crypto";
import { type BigIntStats, constants } from "node:fs";
import { lstat, mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { getAgentDir, withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { parseTree } from "jsonc-parser";
import { INLINE_FORMATTING_PROMPT } from "./prompt.js";

export type PromptHintSettings = { enabled: boolean; text: string };
export type PromptHintChange = { key: "promptHintEnabled"; value: boolean } | { key: "promptHintText"; value: string };

export const DEFAULT_PROMPT_HINT: PromptHintSettings = Object.freeze({ enabled: true, text: INLINE_FORMATTING_PROMPT });
export const CODE_BLOCK_COPY_MODES = ["click", "button", "off"] as const;
export type CodeBlockCopyMode = (typeof CODE_BLOCK_COPY_MODES)[number];
export const DEFAULT_CODE_BLOCK_COPY_MODE = "button";
export const CODE_BLOCK_COPY_BUTTON_POSITIONS = ["left", "right"] as const;
export type CodeBlockCopyButtonPosition = (typeof CODE_BLOCK_COPY_BUTTON_POSITIONS)[number];
export const DEFAULT_CODE_BLOCK_COPY_BUTTON_POSITION = "left";

type InlineSettings = {
  prompt: PromptHintSettings;
  codeBlockCopyMode: CodeBlockCopyMode;
  codeBlockCopyButtonPosition: CodeBlockCopyButtonPosition;
  saveBlocked?: true;
};
type SettingsKey = PromptHintChange["key"] | "codeBlockCopyMode" | "codeBlockCopyButtonPosition";
type SettingsDocument = Record<string, unknown>;

type DocumentSnapshot = { document: SettingsDocument; source?: string; stat?: BigIntStats };
const repair = "Settings cannot be saved. Repair the user pi-inline.json file and reopen the menu.";
const stale = "Settings changed. Reopen the menu before saving.";
const writeFailed = "Settings were not saved. Check file permissions and available disk space.";
const settingsTails = new Map<string, Promise<unknown>>();

function inSettingsQueue<T>(path: string, operation: () => Promise<T>): Promise<T> {
  // Keep request order for the configured path even if Pi's realpath-based key changes
  // when the file is created under a symlinked directory. Neither queue spans processes.
  const result = (settingsTails.get(path) ?? Promise.resolve()).then(() => withFileMutationQueue(path, operation));
  const tail = result.catch(() => undefined);
  settingsTails.set(path, tail);
  return result.finally(() => {
    if (settingsTails.get(path) === tail) settingsTails.delete(path);
  });
}

function settingsPath(): string {
  return resolve(getAgentDir(), "pi-inline.json");
}

async function statFile(path: string): Promise<BigIntStats | undefined> {
  return lstat(path, { bigint: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
    return undefined;
  });
}

function sameFile(a: BigIntStats, b: BigIntStats): boolean {
  return a.dev === b.dev && a.ino === b.ino;
}

async function readDocument(path: string, signal: AbortSignal): Promise<DocumentSnapshot> {
  signal.throwIfAborted();
  const stat = await statFile(path);
  signal.throwIfAborted();
  if (!stat) return { document: {} };
  // Reject symlinks, streams and directories before reading from a verified handle.
  if (!stat.isFile()) throw new Error(repair);
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    signal.throwIfAborted();
    const opened = await handle.stat({ bigint: true });
    signal.throwIfAborted();
    if (!opened.isFile() || !sameFile(stat, opened)) throw new Error(repair);
    const bytes = await readFile(handle, { signal });
    signal.throwIfAborted();
    const source = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    const document: unknown = JSON.parse(source);
    if (!document || typeof document !== "object" || Array.isArray(document)) throw new Error(repair);
    return { document: document as SettingsDocument, source, stat };
  } finally {
    await handle.close();
  }
}

function normalizePromptText(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.replaceAll("\r\n", "\n");
  if (!text.trim() || /(?![\n\t])[\p{Cc}\p{Zl}\p{Zp}\p{Bidi_Control}]/u.test(text)) return undefined;
  return text;
}

function readPromptHint(document: SettingsDocument): PromptHintSettings | undefined {
  const enabled = Object.hasOwn(document, "promptHintEnabled")
    ? document.promptHintEnabled
    : DEFAULT_PROMPT_HINT.enabled;
  const text = Object.hasOwn(document, "promptHintText")
    ? normalizePromptText(document.promptHintText)
    : DEFAULT_PROMPT_HINT.text;
  return typeof enabled === "boolean" && text !== undefined ? { enabled, text } : undefined;
}

export function isCodeBlockCopyMode(value: unknown): value is CodeBlockCopyMode {
  return CODE_BLOCK_COPY_MODES.includes(value as CodeBlockCopyMode);
}

function isCodeBlockCopyButtonPosition(value: unknown): value is CodeBlockCopyButtonPosition {
  return CODE_BLOCK_COPY_BUTTON_POSITIONS.includes(value as CodeBlockCopyButtonPosition);
}

function resolveSettings(document: SettingsDocument | undefined): InlineSettings {
  const prompt = document && readPromptHint(document);
  const mode =
    document &&
    (Object.hasOwn(document, "codeBlockCopyMode") ? document.codeBlockCopyMode : DEFAULT_CODE_BLOCK_COPY_MODE);
  const position =
    document &&
    (Object.hasOwn(document, "codeBlockCopyButtonPosition")
      ? document.codeBlockCopyButtonPosition
      : DEFAULT_CODE_BLOCK_COPY_BUTTON_POSITION);
  const validMode = isCodeBlockCopyMode(mode);
  const validPosition = isCodeBlockCopyButtonPosition(position);
  const settings: InlineSettings = {
    prompt: prompt ?? { ...DEFAULT_PROMPT_HINT },
    codeBlockCopyMode: prompt && validMode ? mode : "off",
    codeBlockCopyButtonPosition: validPosition ? position : DEFAULT_CODE_BLOCK_COPY_BUTTON_POSITION,
  };
  if (!prompt || !validMode || !validPosition) settings.saveBlocked = true;
  return settings;
}

async function readSettings(signal: AbortSignal): Promise<SettingsDocument | undefined> {
  if (signal.aborted) return undefined;
  const path = settingsPath();
  try {
    const { document } = await inSettingsQueue(path, () => readDocument(path, signal));
    return signal.aborted ? undefined : document;
  } catch {
    return undefined;
  }
}

export async function loadPromptSettings(signal: AbortSignal): Promise<InlineSettings> {
  const document = await readSettings(signal);
  if (signal.aborted) {
    return {
      prompt: { ...DEFAULT_PROMPT_HINT },
      codeBlockCopyMode: "off",
      codeBlockCopyButtonPosition: DEFAULT_CODE_BLOCK_COPY_BUTTON_POSITION,
    };
  }
  return resolveSettings(document);
}

function editSetting(source: string | undefined, key: SettingsKey, value: boolean | string): string {
  if (source === undefined) return `${JSON.stringify({ [key]: value }, null, 2)}\n`;

  // The source already passed strict JSON validation. Edit the last matching property
  // to agree with JSON.parse on duplicate keys, without reserializing other values.
  const root = parseTree(source);
  if (root?.type !== "object") throw new Error(repair);
  const properties = root.children ?? [];
  const property = properties.findLast(({ children }) => children?.[0]?.value === key);
  const current = property?.children?.[1];
  if (current) {
    return source.slice(0, current.offset) + JSON.stringify(value) + source.slice(current.offset + current.length);
  }

  const last = properties.at(-1);
  const offset = last ? last.offset + last.length : root.offset + 1;
  return (
    source.slice(0, offset) +
    `${last ? "," : ""}\n  ${JSON.stringify(key)}: ${JSON.stringify(value)}` +
    source.slice(offset)
  );
}

async function publishDocument(
  path: string,
  snapshot: DocumentSnapshot,
  updated: string,
  signal: AbortSignal,
): Promise<boolean> {
  const directory = dirname(path);
  const temporary = join(directory, `.pi-inline-${randomUUID()}.tmp`);
  let ownsTemporary = false;
  try {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    signal.throwIfAborted();
    const handle = await open(temporary, "wx", 0o600);
    ownsTemporary = true;
    try {
      signal.throwIfAborted();
      await writeFile(handle, updated, { encoding: "utf8", signal });
      signal.throwIfAborted();
      await handle.sync();
    } finally {
      await handle.close();
    }
    signal.throwIfAborted();
    const current = await statFile(path);
    signal.throwIfAborted();
    const previous = snapshot.stat;
    if (
      previous
        ? !current?.isFile() ||
          !sameFile(current, previous) ||
          current.size !== previous.size ||
          current.mtimeNs !== previous.mtimeNs ||
          current.ctimeNs !== previous.ctimeNs
        : current !== undefined
    ) {
      return false;
    }
    // Once rename starts, await it even if the caller is cancelled.
    await rename(temporary, path);
    ownsTemporary = false;
    return true;
  } finally {
    if (ownsTemporary) await rm(temporary, { force: true }).catch(() => undefined);
  }
}

export async function savePromptHint(
  expected: PromptHintSettings,
  change: PromptHintChange,
  signal: AbortSignal,
): Promise<boolean> {
  if (signal.aborted) return false;
  const { key } = change;
  if (key === "promptHintEnabled") {
    if (typeof change.value !== "boolean") throw new Error("Select On or Off for the prompt hint.");
    return saveSetting(key, expected.enabled, change.value, signal);
  }
  const value = normalizePromptText(change.value);
  if (key !== "promptHintText" || value === undefined) {
    throw new Error("Enter a nonblank prompt hint without terminal or bidirectional controls.");
  }
  return saveSetting(key, expected.text, value, signal);
}

export async function saveCodeBlockCopyMode(
  expected: CodeBlockCopyMode,
  value: CodeBlockCopyMode,
  signal: AbortSignal,
): Promise<boolean> {
  if (signal.aborted) return false;
  if (!isCodeBlockCopyMode(value)) throw new Error("Select Click block, Copy button, or Off for code block copy.");
  return saveSetting("codeBlockCopyMode", expected, value, signal);
}

export async function saveCodeBlockCopyButtonPosition(
  expected: CodeBlockCopyButtonPosition,
  value: CodeBlockCopyButtonPosition,
  signal: AbortSignal,
): Promise<boolean> {
  if (signal.aborted) return false;
  if (!isCodeBlockCopyButtonPosition(value)) {
    throw new Error("Select Left or Right for the code block copy button position.");
  }
  return saveSetting("codeBlockCopyButtonPosition", expected, value, signal);
}

async function saveSetting(
  key: SettingsKey,
  baseline: boolean | string,
  value: boolean | string,
  signal: AbortSignal,
): Promise<boolean> {
  const path = settingsPath();
  let fail = repair;
  try {
    return await inSettingsQueue(path, async () => {
      const snapshot = await readDocument(path, signal);
      if (signal.aborted) return false;
      const settings = resolveSettings(snapshot.document);
      if (settings.saveBlocked) throw new Error();
      const current = {
        promptHintEnabled: settings.prompt.enabled,
        promptHintText: settings.prompt.text,
        codeBlockCopyMode: settings.codeBlockCopyMode,
        codeBlockCopyButtonPosition: settings.codeBlockCopyButtonPosition,
      }[key];
      if (current !== baseline) {
        fail = stale;
        throw new Error();
      }
      if (value === current) return false;
      const updated = editSetting(snapshot.source, key, value);
      fail = writeFailed;
      const published = await publishDocument(path, snapshot, updated, signal);
      if (!published) {
        fail = stale;
        throw new Error();
      }
      return published;
    });
  } catch {
    if (signal.aborted) return false;
    throw new Error(fail);
  }
}
