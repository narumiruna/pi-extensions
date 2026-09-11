import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { normalizeNickname } from "./nickname.js";
import { createPublicRoom, isCompatibleRoomId, parseInvite, type RoomDescriptor } from "./room.js";

export const CHAT_SETTINGS_FILE = "pi-chat.json";
const MAX_SETTINGS_BYTES = 64 * 1024;
export type WidgetMode = "dock" | "count" | "latest" | "off";

export type RememberedRoom =
  | { id: string; kind: "public"; slug: string }
  | { id: string; kind: "private"; invite: string };

export interface ChatResumeSettings {
  rooms: RememberedRoom[];
  activeRoomId: string;
  surface: "chat" | "pi";
}

export interface ChatSettings {
  nickname?: string;
  identitySeed?: string;
  widgetMode?: WidgetMode;
  resume?: ChatResumeSettings;
}

export type ChatSettingsPatch = Partial<Omit<ChatSettings, "resume">> & {
  resume?: ChatResumeSettings | null;
};

export type ChatSettingsLoadResult =
  | { kind: "missing" }
  | { kind: "invalid"; reason: string }
  | { kind: "loaded"; settings: ChatSettings };

export interface UpdateChatSettingsOptions {
  settingsPath?: string;
  signal?: AbortSignal;
  beforeRename?: (temporaryPath: string, settingsPath: string) => Promise<void>;
  setPrivateMode?: (path: string) => Promise<void>;
}

type SettingsDocument = Record<string, unknown>;
const queues = new Map<string, Promise<void>>();

export function chatSettingsPath(): string {
  return join(getAgentDir(), CHAT_SETTINGS_FILE);
}

export function normalizeChatSettings(value: unknown): ChatSettings | undefined {
  if (!isRecord(value)) return undefined;
  const settings: ChatSettings = {};
  if (Object.hasOwn(value, "nickname")) {
    const nickname = normalizeNickname(value.nickname);
    if (!nickname) return undefined;
    settings.nickname = nickname;
  }
  if (Object.hasOwn(value, "identitySeed")) {
    if (typeof value.identitySeed !== "string" || !validSeed(value.identitySeed)) return undefined;
    settings.identitySeed = value.identitySeed;
  }
  if (Object.hasOwn(value, "widgetMode")) {
    if (
      value.widgetMode !== "dock" &&
      value.widgetMode !== "count" &&
      value.widgetMode !== "latest" &&
      value.widgetMode !== "off"
    ) {
      return undefined;
    }
    settings.widgetMode = value.widgetMode;
  }
  if (Object.hasOwn(value, "resume")) {
    const resume = normalizeResumeSettings(value.resume);
    if (!resume || !settings.nickname || !settings.identitySeed) return undefined;
    settings.resume = resume;
  }
  return settings;
}

export async function readChatSettings(settingsPath = chatSettingsPath()): Promise<ChatSettingsLoadResult> {
  await queues.get(settingsPath);
  try {
    const contents = await readSettings(settingsPath);
    try {
      const settings = normalizeChatSettings(JSON.parse(contents) as unknown);
      return settings
        ? { kind: "loaded", settings }
        : { kind: "invalid", reason: `${settingsPath}: invalid settings shape` };
    } catch {
      return { kind: "invalid", reason: `${settingsPath}: invalid JSON` };
    }
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return { kind: "missing" };
    return { kind: "invalid", reason: `${settingsPath}: ${safeError(error)}` };
  }
}

export function updateChatSettings(
  patch: ChatSettingsPatch,
  options: UpdateChatSettingsOptions = {},
): Promise<ChatSettings> {
  const settingsPath = options.settingsPath ?? chatSettingsPath();
  return enqueue(settingsPath, async () => {
    options.signal?.throwIfAborted();
    const current = await readDocumentForUpdate(settingsPath);
    const updated: SettingsDocument = { ...current, ...patch };
    if (Object.hasOwn(patch, "resume")) {
      if (patch.resume === null) delete updated.resume;
      else if (patch.resume === undefined) {
        if (Object.hasOwn(current, "resume")) updated.resume = current.resume;
        else delete updated.resume;
      } else updated.resume = mergeResumeDocument(current.resume, patch.resume);
    }
    const settings = normalizeChatSettings(updated);
    if (!settings) throw new Error(`Pi Chat settings at ${settingsPath} have an invalid shape.`);
    await publish(settingsPath, updated, options);
    return settings;
  });
}

export function rememberedRoomFromDescriptor(room: RoomDescriptor): RememberedRoom {
  if (room.kind === "public") {
    const slug = room.label.startsWith("#") ? room.label.slice(1) : room.label;
    const reconstructed = createPublicRoom(slug);
    if (reconstructed.id !== room.id) throw new Error("Public room descriptor is inconsistent.");
    return { id: room.id, kind: "public", slug };
  }
  if (!room.invite || parseInvite(room.invite).id !== room.id) {
    throw new Error("Private room descriptor is inconsistent.");
  }
  return { id: room.id, kind: "private", invite: room.invite };
}

export function descriptorFromRememberedRoom(room: RememberedRoom): RoomDescriptor {
  const descriptor = room.kind === "public" ? createPublicRoom(room.slug) : parseInvite(room.invite);
  if (descriptor.id !== room.id) throw new Error("Remembered room is inconsistent.");
  return descriptor;
}

export async function awaitChatSettingsWrites(settingsPath = chatSettingsPath()): Promise<void> {
  await queues.get(settingsPath);
}

function enqueue<T>(path: string, operation: () => Promise<T>): Promise<T> {
  const previous = queues.get(path) ?? Promise.resolve();
  const result = previous.then(operation, operation);
  const settled = result.then(
    () => undefined,
    () => undefined,
  );
  queues.set(path, settled);
  void settled.finally(() => {
    if (queues.get(path) === settled) queues.delete(path);
  });
  return result;
}

async function readDocumentForUpdate(path: string): Promise<SettingsDocument> {
  let contents: string;
  try {
    contents = await readSettings(path);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return {};
    throw new Error(`Pi Chat settings at ${path} are invalid: ${safeError(error)}`);
  }
  let value: unknown;
  try {
    value = JSON.parse(contents) as unknown;
  } catch {
    throw new Error(`Pi Chat settings at ${path} are invalid: invalid JSON`);
  }
  if (!isRecord(value) || !normalizeChatSettings(value)) {
    throw new Error(`Pi Chat settings at ${path} are invalid: invalid settings shape`);
  }
  return value;
}

async function readSettings(path: string): Promise<string> {
  const pathStats = await lstat(path);
  if (pathStats.isSymbolicLink() || !pathStats.isFile()) {
    throw new Error("settings path is not a regular file");
  }
  const noFollow = constants.O_NOFOLLOW ?? 0;
  const handle = await open(path, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0) | noFollow);
  try {
    const stats = await handle.stat();
    if (!stats.isFile() || stats.dev !== pathStats.dev || stats.ino !== pathStats.ino) {
      throw new Error("settings path changed while opening");
    }
    if (stats.size > MAX_SETTINGS_BYTES) {
      throw new Error(`settings file exceeds ${MAX_SETTINGS_BYTES} bytes`);
    }
    const buffer = Buffer.alloc(MAX_SETTINGS_BYTES + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (offset > MAX_SETTINGS_BYTES) throw new Error(`settings file exceeds ${MAX_SETTINGS_BYTES} bytes`);
    try {
      return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(buffer.subarray(0, offset));
    } catch {
      throw new Error("settings file is not valid UTF-8");
    }
  } finally {
    await handle.close();
  }
}

async function publish(path: string, document: SettingsDocument, options: UpdateChatSettingsOptions): Promise<void> {
  options.signal?.throwIfAborted();
  const contents = `${JSON.stringify(document, null, 2)}\n`;
  if (Buffer.byteLength(contents) > MAX_SETTINGS_BYTES) {
    throw new Error(`Pi Chat settings document exceeds ${MAX_SETTINGS_BYTES} bytes.`);
  }
  const directory = dirname(path);
  await mkdir(directory, { recursive: true });
  const temporaryPath = join(directory, `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
  try {
    await writeFile(temporaryPath, contents, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
      signal: options.signal,
    });
    await options.beforeRename?.(temporaryPath, path);
    options.signal?.throwIfAborted();
    if (process.platform !== "win32") {
      await (options.setPrivateMode ?? ((target) => chmod(target, 0o600)))(temporaryPath);
      options.signal?.throwIfAborted();
    }
    await rename(temporaryPath, path);
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

function normalizeResumeSettings(value: unknown): ChatResumeSettings | undefined {
  if (!isRecord(value) || !Array.isArray(value.rooms)) return undefined;
  if (value.rooms.length === 0 || value.rooms.length > 16) return undefined;
  if (typeof value.activeRoomId !== "string") return undefined;
  if (value.surface !== "chat" && value.surface !== "pi") return undefined;
  const rooms: RememberedRoom[] = [];
  const ids = new Set<string>();
  let activeRoomId: string | undefined;
  for (const candidate of value.rooms) {
    const room = normalizeRememberedRoom(candidate);
    if (!room || ids.has(room.id)) return undefined;
    ids.add(room.id);
    rooms.push(room);
    if (isRecord(candidate) && (candidate.id === value.activeRoomId || room.id === value.activeRoomId)) {
      activeRoomId = room.id;
    }
  }
  if (!activeRoomId || !ids.has(activeRoomId)) return undefined;
  return { rooms, activeRoomId, surface: value.surface };
}

function normalizeRememberedRoom(value: unknown): RememberedRoom | undefined {
  if (!isRecord(value) || typeof value.id !== "string") return undefined;
  try {
    if (value.kind === "public" && typeof value.slug === "string" && !Object.hasOwn(value, "invite")) {
      const room = createPublicRoom(value.slug);
      return isCompatibleRoomId(room, value.id) ? { id: room.id, kind: "public", slug: value.slug } : undefined;
    }
    if (value.kind === "private" && typeof value.invite === "string" && !Object.hasOwn(value, "slug")) {
      const room = parseInvite(value.invite);
      return isCompatibleRoomId(room, value.id) ? { id: room.id, kind: "private", invite: value.invite } : undefined;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function mergeResumeDocument(current: unknown, next: ChatResumeSettings): SettingsDocument {
  const currentResume = isRecord(current) ? current : {};
  const existingRooms = new Map<string, SettingsDocument>();
  if (Array.isArray(currentResume.rooms)) {
    for (const candidate of currentResume.rooms) {
      const normalized = normalizeRememberedRoom(candidate);
      if (normalized && isRecord(candidate)) existingRooms.set(normalized.id, candidate);
    }
  }
  return {
    ...currentResume,
    rooms: next.rooms.map((room) => ({ ...existingRooms.get(room.id), ...room })),
    activeRoomId: next.activeRoomId,
    surface: next.surface,
  };
}

function validSeed(value: string): boolean {
  try {
    return /^[A-Za-z0-9_-]{43}$/u.test(value) && Buffer.from(value, "base64url").length === 32;
  } catch {
    return false;
  }
}

function isRecord(value: unknown): value is SettingsDocument {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function safeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
