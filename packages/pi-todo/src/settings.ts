import { constants } from "node:fs";
import { type FileHandle, open } from "node:fs/promises";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export const TODO_SETTINGS_FILE = "pi-todo.json";
export const MAX_TODO_SETTINGS_BYTES = 64 * 1024;
export const TODO_DISPLAY_MODES = ["adaptive", "expanded", "collapsed"] as const;

export type TodoDisplayMode = (typeof TODO_DISPLAY_MODES)[number];

export interface TodoWidgetSettings {
  enabled: boolean;
  displayMode: TodoDisplayMode;
  showCompleted: boolean;
  maxVisibleItems: number | null;
  showProgress: boolean;
}

export interface TodoSettings {
  widget: TodoWidgetSettings;
}

export const DEFAULT_TODO_SETTINGS: Readonly<TodoSettings> = Object.freeze({
  widget: Object.freeze({
    enabled: true,
    displayMode: "adaptive",
    showCompleted: true,
    maxVisibleItems: null,
    showProgress: true,
  }),
});

export type TodoSettingsLoadResult =
  | { kind: "missing"; path: string; settings: TodoSettings }
  | { kind: "loaded"; path: string; settings: TodoSettings }
  | { kind: "invalid"; path: string; settings: TodoSettings; issue: string };

export function todoSettingsPath(): string {
  return join(getAgentDir(), TODO_SETTINGS_FILE);
}

export function normalizeTodoSettings(value: unknown): TodoSettings | undefined {
  if (!isRecord(value)) return undefined;
  const widgetValue = Object.hasOwn(value, "widget") ? value.widget : undefined;
  if (widgetValue !== undefined && !isRecord(widgetValue)) return undefined;
  const widget = widgetValue ?? {};

  const enabled = booleanSetting(widget, "enabled", DEFAULT_TODO_SETTINGS.widget.enabled);
  const showCompleted = booleanSetting(widget, "showCompleted", DEFAULT_TODO_SETTINGS.widget.showCompleted);
  const showProgress = booleanSetting(widget, "showProgress", DEFAULT_TODO_SETTINGS.widget.showProgress);
  if (enabled === undefined || showCompleted === undefined || showProgress === undefined) {
    return undefined;
  }

  const displayMode = Object.hasOwn(widget, "displayMode")
    ? widget.displayMode
    : DEFAULT_TODO_SETTINGS.widget.displayMode;
  if (!TODO_DISPLAY_MODES.includes(displayMode as TodoDisplayMode)) return undefined;

  const maxVisibleItems = Object.hasOwn(widget, "maxVisibleItems")
    ? widget.maxVisibleItems
    : DEFAULT_TODO_SETTINGS.widget.maxVisibleItems;
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
      displayMode: displayMode as TodoDisplayMode,
      showCompleted,
      maxVisibleItems,
      showProgress,
    },
  };
}

export async function loadTodoSettings(
  path = todoSettingsPath(),
  signal?: AbortSignal,
): Promise<TodoSettingsLoadResult> {
  throwIfAborted(signal);
  let handle: FileHandle;
  try {
    handle = await open(path, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0) | (constants.O_NOFOLLOW ?? 0));
  } catch (error) {
    throwIfAborted(signal);
    if (isNodeError(error) && error.code === "ENOENT") {
      return { kind: "missing", path, settings: cloneDefaultSettings() };
    }
    return {
      kind: "invalid",
      path,
      settings: cloneDefaultSettings(),
      issue: safeReadIssue(error),
    };
  }

  try {
    const stats = await handle.stat();
    throwIfAborted(signal);
    if (!stats.isFile()) return invalidResult(path, "settings path is not a regular file");
    if (stats.size > MAX_TODO_SETTINGS_BYTES) {
      return invalidResult(path, `settings file exceeds ${MAX_TODO_SETTINGS_BYTES} bytes`);
    }

    const buffer = Buffer.alloc(MAX_TODO_SETTINGS_BYTES + 1);
    let offset = 0;
    while (offset < buffer.byteLength) {
      throwIfAborted(signal);
      const { bytesRead } = await handle.read(buffer, offset, buffer.byteLength - offset, offset);
      throwIfAborted(signal);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (offset > MAX_TODO_SETTINGS_BYTES) {
      return invalidResult(path, `settings file exceeds ${MAX_TODO_SETTINGS_BYTES} bytes`);
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
    const settings = normalizeTodoSettings(parsed);
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

function cloneDefaultSettings(): TodoSettings {
  return { widget: { ...DEFAULT_TODO_SETTINGS.widget } };
}

function invalidResult(path: string, issue: string): TodoSettingsLoadResult {
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
