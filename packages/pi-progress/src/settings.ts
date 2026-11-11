import { constants } from "node:fs";
import { chmod, type FileHandle, mkdir, mkdtemp, open, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { getAgentDir, type Theme, type ThemeColor, withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";

export const PROGRESS_SETTINGS_FILE = "pi-progress.json";
export const MAX_PROGRESS_SETTINGS_BYTES = 64 * 1024;
export const PROGRESS_DISPLAY_MODES = ["adaptive", "expanded", "collapsed"] as const;

export type ProgressDisplayMode = (typeof PROGRESS_DISPLAY_MODES)[number];

export interface ProgressBlockedStyle {
  readonly icon: string;
  /** Resolved against the current theme at the display boundary. */
  readonly color: string;
}

const iconSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

export interface ProgressSettings {
  enabled: boolean;
  displayMode: ProgressDisplayMode;
  showCompleted: boolean;
  maxVisibleItems: number | null;
  showProgress: boolean;
  blockedStyle: ProgressBlockedStyle;
}

export const DEFAULT_PROGRESS_SETTINGS: Readonly<ProgressSettings> = Object.freeze({
  enabled: true,
  displayMode: "adaptive",
  showCompleted: true,
  maxVisibleItems: null,
  showProgress: true,
  blockedStyle: Object.freeze({ icon: "⚠", color: "warning" }),
});

export type ProgressSettingsLoadResult =
  | { kind: "missing"; path: string; settings: ProgressSettings }
  | { kind: "loaded"; path: string; settings: ProgressSettings; warnings?: readonly string[] }
  | { kind: "invalid"; path: string; settings: ProgressSettings; issue: string };

export function progressSettingsPath(): string {
  return join(getAgentDir(), PROGRESS_SETTINGS_FILE);
}

export function normalizeProgressSettings(value: unknown, warnings: string[] = []): ProgressSettings | undefined {
  if (!isRecord(value)) return undefined;
  const widgetValue = Object.hasOwn(value, "widget") ? value.widget : undefined;
  if (widgetValue !== undefined && !isRecord(widgetValue)) return undefined;
  // Retain nested pi-progress.json settings; top-level fields take precedence.
  const settings = { ...widgetValue, ...value };

  const enabled = booleanSetting(settings, "enabled", DEFAULT_PROGRESS_SETTINGS.enabled);
  const showCompleted = booleanSetting(settings, "showCompleted", DEFAULT_PROGRESS_SETTINGS.showCompleted);
  const showProgress = booleanSetting(settings, "showProgress", DEFAULT_PROGRESS_SETTINGS.showProgress);
  if (enabled === undefined || showCompleted === undefined || showProgress === undefined) return undefined;

  const displayMode = Object.hasOwn(settings, "displayMode")
    ? settings.displayMode
    : DEFAULT_PROGRESS_SETTINGS.displayMode;
  if (!PROGRESS_DISPLAY_MODES.includes(displayMode as ProgressDisplayMode)) return undefined;

  const maxVisibleItems = Object.hasOwn(settings, "maxVisibleItems")
    ? settings.maxVisibleItems
    : DEFAULT_PROGRESS_SETTINGS.maxVisibleItems;
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
    enabled,
    displayMode: displayMode as ProgressDisplayMode,
    showCompleted,
    maxVisibleItems,
    showProgress,
    blockedStyle: normalizeBlockedStyle(settings.blockedStyle, warnings),
  };
}

export function normalizeBlockedStyle(value: unknown, warnings: string[] = []): ProgressBlockedStyle {
  const defaults = DEFAULT_PROGRESS_SETTINGS.blockedStyle;
  if (value === undefined) return { ...defaults };
  if (!isRecord(value)) {
    warnings.push("blockedStyle must be an object; using its defaults.");
    return { ...defaults };
  }
  let icon = defaults.icon;
  let color = defaults.color;
  if (Object.hasOwn(value, "icon")) {
    if (isBlockedIcon(value.icon)) icon = value.icon;
    else warnings.push("blockedStyle.icon must be one safe, single-cell grapheme; using the default icon.");
  }
  if (Object.hasOwn(value, "color")) {
    if (typeof value.color === "string") color = value.color;
    else warnings.push("blockedStyle.color must name a foreground theme role; using warning.");
  }
  return { icon, color };
}

export function resolveBlockedColor(style: ProgressBlockedStyle, theme: Theme, warnings: string[] = []): ThemeColor {
  // The default is a required Pi role. Do not require an initialized theme for defaults or headless reads.
  if (style.color === "warning") return "warning";
  try {
    // Foreground and background roles share theme.colors, but only this API checks the foreground slot.
    theme.getFgAnsi(style.color as ThemeColor);
    return style.color as ThemeColor;
  } catch {
    warnings.push("blockedStyle.color must name a foreground theme role; using warning.");
    return "warning";
  }
}

function isBlockedIcon(value: unknown): value is string {
  return (
    typeof value === "string" &&
    !/[\p{Cc}\p{Cf}\p{Cs}\p{White_Space}]/u.test(value) &&
    !/^\p{M}/u.test(value) &&
    [...iconSegmenter.segment(value)].length === 1 &&
    visibleWidth(value) === 1
  );
}

export async function loadProgressSettings(
  canonicalPath = progressSettingsPath(),
  signal?: AbortSignal,
): Promise<ProgressSettingsLoadResult> {
  return withFileMutationQueue(canonicalPath, async () => {
    const result = await loadSettingsFile(canonicalPath, signal);
    throwIfAborted(signal);
    return result;
  });
}

export async function saveProgressSettings(
  patch: Partial<ProgressSettings>,
  path = progressSettingsPath(),
  signal?: AbortSignal,
): Promise<ProgressSettings> {
  return withFileMutationQueue(path, async () => {
    let document: Record<string, unknown> = {};
    let mode = 0o600;
    const loaded = await loadSettingsFile(path, signal, (parsed, fileMode) => {
      document = parsed;
      mode = fileMode & 0o777;
    });
    throwIfAborted(signal);
    if (loaded.kind === "invalid") throw new Error(`Cannot save invalid settings: ${loaded.issue}`);
    const nextDocument = { ...document, ...patch };
    if (patch.blockedStyle && isRecord(document.blockedStyle)) {
      nextDocument.blockedStyle = { ...document.blockedStyle, ...patch.blockedStyle };
    }
    const settings = normalizeProgressSettings(nextDocument);
    if (!settings) throw new Error("Invalid settings update");
    const text = `${JSON.stringify(nextDocument, null, 2)}\n`;
    if (Buffer.byteLength(text) > MAX_PROGRESS_SETTINGS_BYTES) throw new Error("Settings update exceeds size limit");

    const parent = dirname(path);
    await mkdir(parent, { recursive: true });
    throwIfAborted(signal);
    const temporary = await mkdtemp(join(parent, ".pi-progress-"));
    try {
      throwIfAborted(signal);
      const staged = join(temporary, "settings.json");
      await writeFile(staged, text, { mode, signal });
      // writeFile applies umask; restore the intended mode before atomic publication.
      await chmod(staged, mode);
      throwIfAborted(signal);
      await rename(staged, path);
      // A rename can complete while cancellation fires; the next queued read sees it.
      return settings;
    } finally {
      // Cleanup failure must not report a successful publication as a failed save.
      await rm(temporary, { recursive: true, force: true }).catch(() => {});
    }
  });
}

async function loadSettingsFile(
  path: string,
  signal?: AbortSignal,
  onDocument?: (document: Record<string, unknown>, mode: number) => void,
): Promise<ProgressSettingsLoadResult> {
  throwIfAborted(signal);
  let handle: FileHandle;
  try {
    handle = await open(path, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0) | (constants.O_NOFOLLOW ?? 0));
  } catch (error) {
    throwIfAborted(signal);
    if (isNodeError(error) && error.code === "ENOENT") {
      return { kind: "missing", path, settings: cloneProgressSettings() };
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
    const warnings: string[] = [];
    const settings = normalizeProgressSettings(parsed, warnings);
    if (!settings || !isRecord(parsed)) return invalidResult(path, "invalid settings shape or values");
    onDocument?.(parsed, stats.mode);
    return { kind: "loaded", path, settings, ...(warnings.length > 0 ? { warnings } : {}) };
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

export function cloneProgressSettings(value: Readonly<ProgressSettings> = DEFAULT_PROGRESS_SETTINGS): ProgressSettings {
  return { ...value, blockedStyle: { ...value.blockedStyle } };
}

function invalidResult(path: string, issue: string): ProgressSettingsLoadResult {
  return { kind: "invalid", path, settings: cloneProgressSettings(), issue };
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
