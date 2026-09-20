import { constants } from "node:fs";
import { type FileHandle, open } from "node:fs/promises";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export const PROGRESS_SETTINGS_FILE = "pi-progress.json";
export const LEGACY_TODO_SETTINGS_FILE = "pi-todo.json";
export const MAX_PROGRESS_SETTINGS_BYTES = 64 * 1024;
export const PROGRESS_DISPLAY_MODES = ["adaptive", "expanded", "collapsed"] as const;

export type ProgressDisplayMode = (typeof PROGRESS_DISPLAY_MODES)[number];

export interface ProgressWidgetSettings {
  enabled: boolean;
  displayMode: ProgressDisplayMode;
  showCompleted: boolean;
  maxVisibleItems: number | null;
  showProgress: boolean;
}

export interface ProgressSettings {
  widget: ProgressWidgetSettings;
}

export const DEFAULT_PROGRESS_SETTINGS: Readonly<ProgressSettings> = Object.freeze({
  widget: Object.freeze({
    enabled: true,
    displayMode: "adaptive",
    showCompleted: true,
    maxVisibleItems: null,
    showProgress: true,
  }),
});

export type ProgressSettingsLoadResult =
  | { kind: "missing"; path: string; settings: ProgressSettings }
  | { kind: "loaded"; path: string; settings: ProgressSettings }
  | { kind: "invalid"; path: string; settings: ProgressSettings; issue: string };

export function progressSettingsPath(): string {
  return join(getAgentDir(), PROGRESS_SETTINGS_FILE);
}

export function normalizeProgressSettings(value: unknown): ProgressSettings | undefined {
  if (!isRecord(value)) return undefined;
  const widgetValue = Object.hasOwn(value, "widget") ? value.widget : undefined;
  if (widgetValue !== undefined && !isRecord(widgetValue)) return undefined;
  const widget = widgetValue ?? {};

  const enabled = booleanSetting(widget, "enabled", DEFAULT_PROGRESS_SETTINGS.widget.enabled);
  const showCompleted = booleanSetting(widget, "showCompleted", DEFAULT_PROGRESS_SETTINGS.widget.showCompleted);
  const showProgress = booleanSetting(widget, "showProgress", DEFAULT_PROGRESS_SETTINGS.widget.showProgress);
  if (enabled === undefined || showCompleted === undefined || showProgress === undefined) return undefined;

  const displayMode = Object.hasOwn(widget, "displayMode")
    ? widget.displayMode
    : DEFAULT_PROGRESS_SETTINGS.widget.displayMode;
  if (!PROGRESS_DISPLAY_MODES.includes(displayMode as ProgressDisplayMode)) return undefined;

  const maxVisibleItems = Object.hasOwn(widget, "maxVisibleItems")
    ? widget.maxVisibleItems
    : DEFAULT_PROGRESS_SETTINGS.widget.maxVisibleItems;
  if (
    maxVisibleItems !== null &&
    (typeof maxVisibleItems !== "number" ||
      !Number.isSafeInteger(maxVisibleItems) ||
      maxVisibleItems < 1 ||
      maxVisibleItems > 50)
  ) {
    return undefined;
  }

  return {
    widget: {
      enabled,
      displayMode: displayMode as ProgressDisplayMode,
      showCompleted,
      maxVisibleItems,
      showProgress,
    },
  };
}

export async function loadProgressSettings(
  canonicalPath = progressSettingsPath(),
  signal?: AbortSignal,
): Promise<ProgressSettingsLoadResult> {
  const canonical = await loadSettingsFile(canonicalPath, signal);
  throwIfAborted(signal);
  if (canonical.kind !== "missing") return canonical;

  const legacyPath = join(dirname(canonicalPath), LEGACY_TODO_SETTINGS_FILE);
  const legacy = await loadSettingsFile(legacyPath, signal);
  throwIfAborted(signal);
  return legacy.kind === "missing" ? canonical : legacy;
}

async function loadSettingsFile(path: string, signal?: AbortSignal): Promise<ProgressSettingsLoadResult> {
  throwIfAborted(signal);
  let handle: FileHandle;
  try {
    handle = await open(path, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0) | (constants.O_NOFOLLOW ?? 0));
  } catch (error) {
    throwIfAborted(signal);
    if (isNodeError(error) && error.code === "ENOENT") {
      return { kind: "missing", path, settings: cloneDefaultSettings() };
    }
    return invalidResult(path, safeReadIssue(error));
  }

  try {
    const stats = await handle.stat();
    throwIfAborted(signal);
    if (!stats.isFile()) return invalidResult(path, "settings path is not a regular file");
    if (stats.size > MAX_PROGRESS_SETTINGS_BYTES) {
      return invalidResult(path, `settings file exceeds ${MAX_PROGRESS_SETTINGS_BYTES} bytes`);
    }

    const buffer = Buffer.alloc(MAX_PROGRESS_SETTINGS_BYTES + 1);
    let offset = 0;
    while (offset < buffer.byteLength) {
      throwIfAborted(signal);
      const { bytesRead } = await handle.read(buffer, offset, buffer.byteLength - offset, offset);
      throwIfAborted(signal);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (offset > MAX_PROGRESS_SETTINGS_BYTES) {
      return invalidResult(path, `settings file exceeds ${MAX_PROGRESS_SETTINGS_BYTES} bytes`);
    }

    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, offset));
    } catch {
      return invalidResult(path, "settings file is not valid UTF-8");
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(text) as unknown;
    } catch {
      return invalidResult(path, "invalid JSON");
    }
    const settings = normalizeProgressSettings(parsed);
    return settings ? { kind: "loaded", path, settings } : invalidResult(path, "invalid settings shape or values");
  } catch (error) {
    throwIfAborted(signal);
    return invalidResult(path, safeReadIssue(error));
  } finally {
    await handle.close();
  }
}

function booleanSetting(record: Record<string, unknown>, key: string, fallback: boolean): boolean | undefined {
  const value = Object.hasOwn(record, key) ? record[key] : fallback;
  return typeof value === "boolean" ? value : undefined;
}

function cloneDefaultSettings(): ProgressSettings {
  return { widget: { ...DEFAULT_PROGRESS_SETTINGS.widget } };
}

function invalidResult(path: string, issue: string): ProgressSettingsLoadResult {
  return { kind: "invalid", path, settings: cloneDefaultSettings(), issue };
}

function throwIfAborted(signal?: AbortSignal): void {
  signal?.throwIfAborted();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function safeReadIssue(error: unknown): string {
  if (isNodeError(error) && error.code === "ELOOP") return "symbolic links are not accepted";
  return error instanceof Error ? error.message : String(error);
}
