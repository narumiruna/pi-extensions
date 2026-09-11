import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { FleetTerminalPreference } from "./terminal.js";

export const FLEET_SETTINGS_FILE = "pi-fleet.json";
export const MAX_FLEET_SETTINGS_BYTES = 64 * 1024;
export const DEFAULT_FLEET_SETTINGS: Readonly<FleetSettings> = Object.freeze({
  defaultTerminal: "auto",
  confirmSessionLaunch: true,
});

export interface FleetSettings {
  defaultTerminal: FleetTerminalPreference;
  confirmSessionLaunch: boolean;
}

export type FleetSettingsField = keyof FleetSettings;
export type FleetSettingsSource = "built-in" | "user";
export type FleetSettingsPatch = Partial<FleetSettings>;

export interface NormalizedFleetSettings {
  settings: FleetSettings;
  sources: Record<FleetSettingsField, FleetSettingsSource>;
}

export interface FleetSettingsIssue {
  kind: "invalid";
  message: string;
}

export interface FleetSettingsState extends NormalizedFleetSettings {
  issue?: FleetSettingsIssue;
  canSave: boolean;
}

export type FleetSettingsLoadResult =
  | (NormalizedFleetSettings & {
      kind: "missing";
      path: string;
      document: Record<string, unknown>;
    })
  | (NormalizedFleetSettings & {
      kind: "loaded";
      path: string;
      document: Record<string, unknown>;
    })
  | (NormalizedFleetSettings & {
      kind: "invalid";
      path: string;
      issue: FleetSettingsIssue;
    });

export interface FleetSettingsOperations {
  writeFile: typeof writeFile;
  rename: typeof rename;
}

export interface FleetSettingsRuntime {
  get(): Readonly<FleetSettingsState>;
  getPath(): string;
  reload(signal?: AbortSignal): Promise<Readonly<FleetSettingsState>>;
  update(patch: FleetSettingsPatch): Promise<Readonly<FleetSettingsState>>;
  flush(): Promise<void>;
}

export interface FleetSettingsRuntimeOptions {
  path?: string | (() => string);
  operations?: Partial<FleetSettingsOperations>;
}

const SETTING_FIELDS = ["defaultTerminal", "confirmSessionLaunch"] as const satisfies readonly FleetSettingsField[];
const SETTING_FIELD_SET = new Set<string>(SETTING_FIELDS);

export function fleetSettingsFilePath(): string {
  return join(getAgentDir(), FLEET_SETTINGS_FILE);
}

export function normalizeFleetSettingsDocument(value: unknown): NormalizedFleetSettings | undefined {
  if (!isRecord(value)) return undefined;
  const settings: FleetSettings = { ...DEFAULT_FLEET_SETTINGS };
  const sources = builtInSources();

  if (Object.hasOwn(value, "defaultTerminal")) {
    if (
      value.defaultTerminal !== "auto" &&
      value.defaultTerminal !== "tmux" &&
      value.defaultTerminal !== "ghostty" &&
      value.defaultTerminal !== "zellij"
    ) {
      return undefined;
    }
    settings.defaultTerminal = value.defaultTerminal;
    sources.defaultTerminal = "user";
  }
  if (Object.hasOwn(value, "confirmSessionLaunch")) {
    if (typeof value.confirmSessionLaunch !== "boolean") return undefined;
    settings.confirmSessionLaunch = value.confirmSessionLaunch;
    sources.confirmSessionLaunch = "user";
  }
  return { settings, sources };
}

export async function loadFleetSettings(
  path = fleetSettingsFilePath(),
  signal?: AbortSignal,
): Promise<FleetSettingsLoadResult> {
  let text: string;
  try {
    text = await readSettingsDocument(path, signal);
  } catch (error) {
    if (signal?.aborted) throw error;
    if (isNodeError(error) && error.code === "ENOENT") {
      return {
        kind: "missing",
        path,
        document: {},
        settings: { ...DEFAULT_FLEET_SETTINGS },
        sources: builtInSources(),
      };
    }
    return invalidLoad(path, formatError(error));
  }

  try {
    const document = JSON.parse(text) as unknown;
    const normalized = normalizeFleetSettingsDocument(document);
    if (!normalized || !isRecord(document)) {
      return invalidLoad(path, "the document is malformed or contains an invalid setting");
    }
    return { kind: "loaded", path, document, ...normalized };
  } catch (error) {
    return invalidLoad(path, formatError(error));
  }
}

export function createInMemoryFleetSettingsRuntime(): FleetSettingsRuntime {
  let state: FleetSettingsState = {
    settings: { ...DEFAULT_FLEET_SETTINGS },
    sources: builtInSources(),
    canSave: true,
  };
  return {
    get: () => freezeState(state),
    getPath: () => "",
    reload: async () => freezeState(state),
    update: async (patch) => {
      const canonical = normalizePatch(patch);
      state = {
        settings: { ...state.settings, ...canonical },
        sources: {
          ...state.sources,
          ...(canonical.defaultTerminal ? { defaultTerminal: "user" as const } : {}),
          ...(canonical.confirmSessionLaunch !== undefined ? { confirmSessionLaunch: "user" as const } : {}),
        },
        canSave: true,
      };
      return freezeState(state);
    },
    flush: async () => undefined,
  };
}

export function createFleetSettingsRuntime(options: FleetSettingsRuntimeOptions = {}): FleetSettingsRuntime {
  let resolvedPath: string | undefined;
  const getPath = () => {
    resolvedPath ??= typeof options.path === "function" ? options.path() : (options.path ?? fleetSettingsFilePath());
    return resolvedPath;
  };
  const operations: FleetSettingsOperations = {
    writeFile,
    rename,
    ...options.operations,
  };
  let state: FleetSettingsState = {
    settings: { ...DEFAULT_FLEET_SETTINGS },
    sources: builtInSources(),
    canSave: true,
  };
  let queue = Promise.resolve();

  const enqueue = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = queue.then(operation, operation);
    queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };

  return {
    get: () => freezeState(state),
    getPath,
    reload(signal) {
      return enqueue(async () => {
        const loaded = await loadFleetSettings(getPath(), signal);
        if (loaded.kind === "invalid") {
          state = { ...state, issue: loaded.issue, canSave: false };
          return freezeState(state);
        }
        state = { settings: loaded.settings, sources: loaded.sources, canSave: true };
        return freezeState(state);
      });
    },
    update(patch) {
      return enqueue(async () => {
        const canonicalPatch = normalizePatch(patch);
        const latest = await loadFleetSettings(getPath());
        if (latest.kind === "invalid") {
          state = { ...state, issue: latest.issue, canSave: false };
          throw new Error(`Cannot update malformed or invalid settings: ${latest.issue.message}`);
        }
        const document = { ...latest.document, ...canonicalPatch };
        const normalized = normalizeFleetSettingsDocument(document);
        if (!normalized) throw new Error("Refusing to publish invalid Pi Fleet settings.");
        await publishSettingsDocument(document, getPath(), operations);
        state = { ...normalized, canSave: true };
        return freezeState(state);
      });
    },
    async flush() {
      await queue;
    },
  };
}

function normalizePatch(patch: FleetSettingsPatch): FleetSettingsPatch {
  if (!isRecord(patch) || Object.keys(patch).some((key) => !SETTING_FIELD_SET.has(key))) {
    throw new Error("Refusing to update unknown Pi Fleet settings.");
  }
  const normalized = normalizeFleetSettingsDocument(patch);
  if (!normalized) throw new Error("Refusing to update invalid Pi Fleet settings.");
  const canonical: FleetSettingsPatch = {};
  for (const field of SETTING_FIELDS) {
    if (Object.hasOwn(patch, field)) assignSetting(canonical, field, normalized.settings[field]);
  }
  return canonical;
}

function assignSetting<K extends FleetSettingsField>(
  settings: FleetSettingsPatch,
  field: K,
  value: FleetSettings[K],
): void {
  settings[field] = value;
}

async function publishSettingsDocument(
  document: Record<string, unknown>,
  path: string,
  operations: FleetSettingsOperations,
): Promise<void> {
  const contents = `${JSON.stringify(document, null, "\t")}\n`;
  if (Buffer.byteLength(contents, "utf8") > MAX_FLEET_SETTINGS_BYTES) {
    throw new Error(`settings document exceeds ${MAX_FLEET_SETTINGS_BYTES} bytes`);
  }
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = join(dirname(path), `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
  try {
    await operations.writeFile(temporaryPath, contents, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    await operations.rename(temporaryPath, path);
  } finally {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
  }
}

async function readSettingsDocument(path: string, signal?: AbortSignal): Promise<string> {
  throwIfAborted(signal);
  const flags = constants.O_RDONLY | (constants.O_NONBLOCK ?? 0) | (constants.O_NOFOLLOW ?? 0);
  const handle = await open(path, flags);
  try {
    throwIfAborted(signal);
    const [descriptorStats, pathStats] = await Promise.all([handle.stat(), lstat(path)]);
    throwIfAborted(signal);
    if (pathStats.isSymbolicLink()) throw new Error("symbolic links are not accepted");
    if (!descriptorStats.isFile() || !pathStats.isFile()) {
      throw new Error("settings path is not a regular file");
    }
    if (descriptorStats.dev !== pathStats.dev || descriptorStats.ino !== pathStats.ino) {
      throw new Error("settings path changed while it was being opened");
    }
    if (descriptorStats.size > MAX_FLEET_SETTINGS_BYTES) {
      throw new Error(`settings file exceeds ${MAX_FLEET_SETTINGS_BYTES} bytes`);
    }
    const buffer = Buffer.alloc(MAX_FLEET_SETTINGS_BYTES + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const result = await handle.read(buffer, offset, buffer.length - offset, offset);
      throwIfAborted(signal);
      if (result.bytesRead === 0) break;
      offset += result.bytesRead;
    }
    if (offset > MAX_FLEET_SETTINGS_BYTES) {
      throw new Error(`settings file exceeds ${MAX_FLEET_SETTINGS_BYTES} bytes`);
    }
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, offset));
    } catch {
      throw new Error("settings file is not valid UTF-8");
    }
  } finally {
    await handle.close();
  }
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw signal.reason;
}

function invalidLoad(path: string, reason: string): FleetSettingsLoadResult {
  return {
    kind: "invalid",
    path,
    settings: { ...DEFAULT_FLEET_SETTINGS },
    sources: builtInSources(),
    issue: { kind: "invalid", message: `${FLEET_SETTINGS_FILE} ignored (${path}: ${reason})` },
  };
}

function builtInSources(): Record<FleetSettingsField, FleetSettingsSource> {
  return { defaultTerminal: "built-in", confirmSessionLaunch: "built-in" };
}

function freezeState(state: FleetSettingsState): Readonly<FleetSettingsState> {
  return Object.freeze({
    ...state,
    settings: Object.freeze({ ...state.settings }),
    sources: Object.freeze({ ...state.sources }),
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
