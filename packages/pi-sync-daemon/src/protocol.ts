import { createHash } from "node:crypto";
import path from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";

export const PROTOCOL_VERSION = 1;

/** Authenticated idle shutdown after work is drained; callers may wait for this owner to exit. */
export class DaemonStoppingError extends Error {
  override name = "DaemonStoppingError";
  constructor() {
    super("Daemon is closing after its idle grace period; wait for owner exit before reconnecting.");
  }
}
/** This owner expired this client's heartbeat; a normal facts update cannot restore participation. */
export class ClientContactExpiredError extends Error {
  override name = "ClientContactExpiredError";
  constructor() {
    super("Client contact expired; resume the same session before publishing facts.");
  }
}
export const MAX_MESSAGE_BYTES = 4 * 1024 * 1024;
export const REVIEW_PAGE_CHARS = 64 * 1024;
export const MAX_REVIEW_BYTES = 16 * 1024 * 1024;
export const MAX_SETTINGS_BYTES = 512 * 1024;
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export interface Identity {
  version: 1;
  root: string;
  instance: string;
  pid: number;
  token: string;
}
export interface ClientFacts {
  id: string;
  pid: number;
  generation: string;
  cwd: string;
  mode: "tui" | "rpc" | "json" | "print";
  hasUI: boolean;
  idle: boolean;
  ready?: boolean;
  startupDebug?: boolean;
  sessionFile?: string;
  sessionId?: string;
  sessionDir?: string;
  model?: Pick<Model<Api>, "provider" | "id"> & {
    signature: string;
    authSource: "stored" | "environment" | "models_json_key" | "models_json_command";
  };
}
export interface ClientHandoff {
  kind: "replace" | "exit";
  file?: string;
  sessionId?: string;
  cwd?: string;
}
export function validateHandoff(value: unknown): asserts value is ClientHandoff {
  if (
    !record(value) ||
    !["replace", "exit"].includes(String(value.kind)) ||
    ["file", "sessionId", "cwd"].some(
      (key) =>
        value[key] !== undefined &&
        (typeof value[key] !== "string" || value[key].length > 32768 || value[key].includes("\0")),
    ) ||
    ["file", "cwd"].some((key) => typeof value[key] === "string" && !path.isAbsolute(value[key] as string))
  )
    throw new Error("Invalid client handoff.");
}
export interface Request {
  version: 1;
  instance: string;
  root: string;
  token: string;
  method: string;
  params: unknown;
}
export interface Callback {
  id: string;
  job: string;
  kind: string;
  payload: unknown;
  review?: { pages: number; bytes: number; sha256: string };
}
export interface ClientEvent {
  id: number;
  kind: "notify" | "status" | "commit" | "release" | "timings";
  payload: unknown;
}
export interface RemoteError {
  name: string;
  message: string;
  properties?: Record<string, unknown>;
}
export interface JobView {
  id: string;
  phase: "queued" | "running" | "done" | "failed";
  result?: unknown;
  error?: RemoteError;
}
export type ClientContact = "active" | "expired" | "inactive";
export interface PollReply {
  cursor: number;
  callbacks: Callback[];
  events: ClientEvent[];
  job?: JobView;
  /** Absent on owners without protocol-v1 contact resume support. */
  contact?: ClientContact;
}
export interface Execution {
  readonly root: string;
  readonly clientId: string | undefined;
  readonly signal: AbortSignal;
  facts(): ClientFacts | undefined;
  participants(): readonly ClientFacts[];
  /** All live PIDs, including retired clients that must no longer authorize work. */
  liveClients(): readonly ClientFacts[];
  /** Fence attach publication until every queue grant and release in the action settles. */
  withParticipants<T>(action: (peers: readonly ClientFacts[]) => Promise<T>): Promise<T>;
  validate(): void;
  request(kind: string, payload: unknown, clientId?: string, signal?: AbortSignal): Promise<unknown>;
  emit(kind: ClientEvent["kind"], payload: unknown, clientId?: string): void;
  committed(): void;
}
export type Execute = (operation: string, payload: unknown, execution: Execution) => Promise<unknown>;
export function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
export function operationPrefix(identity: Pick<Identity, "instance">) {
  return `${createHash("sha256").update(identity.instance).digest("hex").slice(0, 16)}-`;
}
export function validId(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9-]{16,64}$/u.test(value);
}
export function validateFacts(value: unknown): asserts value is ClientFacts {
  if (
    !record(value) ||
    Object.keys(value).some(
      (key) =>
        ![
          "id",
          "pid",
          "generation",
          "cwd",
          "mode",
          "hasUI",
          "idle",
          "ready",
          "startupDebug",
          "sessionFile",
          "sessionId",
          "sessionDir",
          "model",
        ].includes(key),
    ) ||
    !validId(value.id) ||
    !validId(value.generation) ||
    !Number.isSafeInteger(value.pid) ||
    Number(value.pid) < 1 ||
    Number(value.pid) > 2_147_483_647 ||
    typeof value.cwd !== "string" ||
    value.cwd.length > 32768 ||
    value.cwd.includes("\0") ||
    !path.isAbsolute(value.cwd) ||
    !["tui", "rpc", "json", "print"].includes(String(value.mode)) ||
    typeof value.hasUI !== "boolean" ||
    typeof value.idle !== "boolean" ||
    (value.ready !== undefined && typeof value.ready !== "boolean") ||
    (value.startupDebug !== undefined && typeof value.startupDebug !== "boolean") ||
    ["sessionFile", "sessionId", "sessionDir"].some(
      (key) =>
        value[key] !== undefined &&
        (typeof value[key] !== "string" || value[key].length > 32768 || value[key].includes("\0")),
    ) ||
    ["sessionFile", "sessionDir"].some(
      (key) => typeof value[key] === "string" && !path.isAbsolute(value[key] as string),
    ) ||
    (value.model !== undefined &&
      (!record(value.model) ||
        Object.keys(value.model).some((key) => !["provider", "id", "signature", "authSource"].includes(key)) ||
        typeof value.model.provider !== "string" ||
        !value.model.provider.length ||
        value.model.provider.length > 256 ||
        typeof value.model.id !== "string" ||
        !value.model.id.length ||
        value.model.id.length > 4096 ||
        typeof value.model.signature !== "string" ||
        !/^[a-f0-9]{64}$/u.test(value.model.signature) ||
        !["stored", "environment", "models_json_key", "models_json_command"].includes(String(value.model.authSource))))
  ) {
    throw new Error("Invalid client facts.");
  }
}
export function remoteError(error: unknown): RemoteError {
  if (!(error instanceof Error)) return { name: "Error", message: "Synchronization operation failed." };
  const properties = Object.fromEntries(
    Object.entries(error).filter(([key]) =>
      ["code", "decision", "status", "phase", "snapshotId", "backup", "publication", "snapshotRef"].includes(key),
    ),
  );
  const result = { name: error.name, message: error.message.slice(0, 4096), properties };
  try {
    if (Buffer.byteLength(JSON.stringify(result)) <= MAX_MESSAGE_BYTES / 4) return result;
  } catch {
    /* Opaque/unserializable details must not escape. */
  }
  return {
    name: "Error",
    message:
      "Operation details exceed the local API limit; inspect retained recovery evidence. No truncated review was approved.",
  };
}
