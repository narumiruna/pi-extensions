import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { TextDecoder } from "node:util";

export const FLEET_PROTOCOL_VERSION = 2;
export const INVITE_PREFIX = "pifleet:v1:";
export const MAX_FRAME_BYTES = 32 * 1024;
export const MAX_MESSAGE_BYTES = 16 * 1024;
export const DEFAULT_CLOCK_SKEW_MS = 60_000;
export const DEFAULT_MESSAGE_TTL_MS = 2 * 60_000;
export const MAX_MESSAGE_LIFETIME_MS = 5 * 60_000;

const GROUP_DOMAIN = "pi-fleet/group/v1\0";
const FRAME_MAC_DOMAIN = "pi-fleet/frame/v2\0";
const MANIFEST_MAC_DOMAIN = "pi-fleet/manifest/v2\0";
const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/u;
const GROUP_ID = /^[a-f0-9]{32}$/u;
const ENDPOINT_ID = /^[a-f0-9]{24}$/u;
const BASE64URL_32_BYTES = /^[A-Za-z0-9_-]{43}$/u;
const BASE64URL_MAC = /^[A-Za-z0-9_-]{43}$/u;
const ACK_CODES = new Set<FleetAckCode>([
  "delivery_failed",
  "kickoff_consumed",
  "launch_mismatch",
  "rate_limited",
  "requests_disabled",
  "target_busy",
]);

export interface FleetGroup {
  id: string;
  secret: Buffer;
}

export type FleetMessageMode = "notify" | "request" | "reply" | "kickoff";

export interface FleetMessage {
  id: string;
  fromSessionId: string;
  fromName?: string;
  fromCwd?: string;
  toSessionId: string;
  mode: FleetMessageMode;
  text: string;
  issuedAt: number;
  expiresAt: number;
  replyTo?: string;
  launchId?: string;
}

export interface FleetPeerDescription {
  protocolVersion: number;
  sessionId: string;
  endpointId: string;
  name?: string;
  cwd: string;
  pid: number;
  launchId?: string;
  acceptsRequests: boolean;
}

export type FleetLocalPeerDescription = Omit<FleetPeerDescription, "endpointId">;

export type FleetAckStatus = "accepted" | "duplicate" | "rejected" | "busy";

export type FleetAckCode =
  | "delivery_failed"
  | "kickoff_consumed"
  | "launch_mismatch"
  | "rate_limited"
  | "requests_disabled"
  | "target_busy";

export interface FleetAckPayload {
  kind: "ack";
  status: FleetAckStatus;
  code?: FleetAckCode;
  error?: string;
  retryAfterMs?: number;
}

export type FleetPayload =
  | { kind: "describe" }
  | { kind: "description"; peer: FleetPeerDescription }
  | { kind: "message"; message: FleetMessage; kickoffCapability?: string }
  | FleetAckPayload;

export interface UnsignedFleetFrame {
  groupId: string;
  requestId: string;
  targetSessionId: string;
  targetEndpointId: string;
  senderSessionId: string;
  senderEndpointId: string;
  issuedAt: number;
  nonce: string;
  payload: FleetPayload;
}

export interface SignedFleetFrame extends UnsignedFleetFrame {
  version: typeof FLEET_PROTOCOL_VERSION;
  mac: string;
}

export interface UnsignedEndpointManifest {
  groupId: string;
  endpointId: string;
  sessionId: string;
  socketName: string;
  pid: number;
  publishedAt: number;
}

export interface SignedEndpointManifest extends UnsignedEndpointManifest {
  version: typeof FLEET_PROTOCOL_VERSION;
  mac: string;
}

export interface VerifyFrameOptions {
  expectedGroupId: string;
  expectedTargetSessionId: string;
  expectedTargetEndpointId: string;
  now?: number;
  maxClockSkewMs?: number;
  replay?: ReplayWindow;
}

export function createGroup(secret: Uint8Array = randomBytes(32)): FleetGroup {
  const copied = Buffer.from(secret);
  if (copied.length !== 32) throw new Error("Pi Fleet group secret must be exactly 32 bytes");
  const id = createHash("sha256").update(GROUP_DOMAIN).update(copied).digest("hex").slice(0, 32);
  return { id, secret: copied };
}

export function formatInvite(secret: Uint8Array): string {
  return `${INVITE_PREFIX}${createGroup(secret).secret.toString("base64url")}`;
}

export function parseInvite(value: string): FleetGroup {
  if (value !== value.trim() || !value.startsWith(INVITE_PREFIX)) {
    throw new Error("Pi Fleet invite is invalid");
  }
  const encoded = value.slice(INVITE_PREFIX.length);
  if (!BASE64URL_32_BYTES.test(encoded)) throw new Error("Pi Fleet invite is invalid");
  let secret: Buffer;
  try {
    secret = Buffer.from(encoded, "base64url");
  } catch {
    throw new Error("Pi Fleet invite is invalid");
  }
  if (secret.length !== 32 || secret.toString("base64url") !== encoded) {
    throw new Error("Pi Fleet invite is invalid");
  }
  return createGroup(secret);
}

export function createSignedFrame(input: UnsignedFleetFrame, secret: Uint8Array): SignedFleetFrame {
  const frameWithoutMac = {
    version: FLEET_PROTOCOL_VERSION as typeof FLEET_PROTOCOL_VERSION,
    ...normalizeUnsignedFrame(input),
  };
  return {
    ...frameWithoutMac,
    mac: keyedMac(FRAME_MAC_DOMAIN, frameWithoutMac, secret),
  };
}

export function verifySignedFrame(value: unknown, secret: Uint8Array, options: VerifyFrameOptions): SignedFleetFrame {
  const frame = normalizeSignedFrame(value);
  if (frame.groupId !== options.expectedGroupId) {
    throw new Error("Pi Fleet frame belongs to the wrong group");
  }
  if (frame.targetSessionId !== options.expectedTargetSessionId) {
    throw new Error("Pi Fleet frame targets another session");
  }
  if (frame.targetEndpointId !== options.expectedTargetEndpointId) {
    throw new Error("Pi Fleet frame targets another endpoint instance");
  }
  const now = options.now ?? Date.now();
  const maxClockSkewMs = options.maxClockSkewMs ?? DEFAULT_CLOCK_SKEW_MS;
  if (Math.abs(now - frame.issuedAt) > maxClockSkewMs) {
    throw new Error("Pi Fleet frame expired outside the accepted clock window");
  }
  const { mac, ...unsigned } = frame;
  const expected = keyedMac(FRAME_MAC_DOMAIN, unsigned, secret);
  if (!safeMacEqual(mac, expected)) throw new Error("Pi Fleet frame authentication failed");
  const replayKey = [frame.senderSessionId, frame.senderEndpointId, frame.requestId, frame.nonce].join(":");
  if (options.replay && !options.replay.accept(replayKey, now)) {
    throw new Error("Pi Fleet frame was replayed");
  }
  return frame;
}

export function createSignedEndpointManifest(
  input: UnsignedEndpointManifest,
  secret: Uint8Array,
): SignedEndpointManifest {
  const manifestWithoutMac = {
    version: FLEET_PROTOCOL_VERSION as typeof FLEET_PROTOCOL_VERSION,
    ...normalizeUnsignedEndpointManifest(input),
  };
  return {
    ...manifestWithoutMac,
    mac: keyedMac(MANIFEST_MAC_DOMAIN, manifestWithoutMac, secret),
  };
}

export function verifySignedEndpointManifest(
  value: unknown,
  secret: Uint8Array,
  options: { expectedGroupId: string; expectedEndpointId: string },
): SignedEndpointManifest {
  const manifest = normalizeSignedEndpointManifest(value);
  if (manifest.groupId !== options.expectedGroupId) {
    throw new Error("Pi Fleet endpoint manifest belongs to the wrong group");
  }
  if (manifest.endpointId !== options.expectedEndpointId) {
    throw new Error("Pi Fleet endpoint manifest identity does not match its filename");
  }
  if (manifest.socketName !== `${manifest.endpointId}.sock`) {
    throw new Error("Pi Fleet endpoint manifest socket does not match its identity");
  }
  const { mac, ...unsigned } = manifest;
  const expected = keyedMac(MANIFEST_MAC_DOMAIN, unsigned, secret);
  if (!safeMacEqual(mac, expected)) {
    throw new Error("Pi Fleet endpoint manifest authentication failed");
  }
  return manifest;
}

export function validateMessage(value: unknown): FleetMessage {
  if (!isRecord(value)) throw new Error("Pi Fleet message must be an object");
  assertExactKeys(
    value,
    [
      "expiresAt",
      "fromCwd",
      "fromName",
      "fromSessionId",
      "id",
      "issuedAt",
      "launchId",
      "mode",
      "replyTo",
      "text",
      "toSessionId",
    ],
    "message",
  );
  const id = requiredId(value.id, "message id");
  const fromSessionId = requiredId(value.fromSessionId, "sender session id");
  const fromName = optionalBoundedString(value.fromName, "sender name", 200);
  const fromCwd = optionalBoundedString(value.fromCwd, "sender cwd", 4_096);
  const toSessionId = requiredId(value.toSessionId, "target session id");
  const mode = value.mode;
  if (mode !== "notify" && mode !== "request" && mode !== "reply" && mode !== "kickoff") {
    throw new Error("Pi Fleet message mode is invalid");
  }
  if (typeof value.text !== "string") throw new Error("Pi Fleet message text must be a string");
  if (Buffer.byteLength(value.text, "utf8") > MAX_MESSAGE_BYTES) {
    throw new Error("Pi Fleet message is too large");
  }
  const issuedAt = finiteInteger(value.issuedAt, "message issued time");
  const expiresAt = finiteInteger(value.expiresAt, "message expiry time");
  if (expiresAt <= issuedAt || expiresAt - issuedAt > MAX_MESSAGE_LIFETIME_MS) {
    throw new Error("Pi Fleet message lifetime is invalid");
  }
  const replyTo = optionalId(value.replyTo, "reply message id");
  const launchId = optionalId(value.launchId, "launch id");
  if (mode === "reply" && !replyTo) throw new Error("Pi Fleet reply requires a reply message id");
  if (mode === "kickoff" && !launchId) throw new Error("Pi Fleet kickoff requires a launch id");
  return {
    id,
    fromSessionId,
    ...(fromName ? { fromName } : {}),
    ...(fromCwd ? { fromCwd } : {}),
    toSessionId,
    mode,
    text: value.text,
    issuedAt,
    expiresAt,
    ...(replyTo ? { replyTo } : {}),
    ...(launchId ? { launchId } : {}),
  };
}

export function validateMessageTiming(message: FleetMessage, now: number): void {
  if (message.issuedAt > now + DEFAULT_CLOCK_SKEW_MS) {
    throw new Error("Pi Fleet message was issued too far in the future");
  }
  if (message.expiresAt < now) throw new Error("Pi Fleet message has expired");
}

export class ReplayWindow {
  private readonly entries = new Map<string, number>();

  constructor(
    private readonly capacity: number,
    private readonly ttlMs: number,
  ) {
    if (!Number.isInteger(capacity) || capacity < 1) throw new Error("Replay capacity is invalid");
    if (!Number.isFinite(ttlMs) || ttlMs < 1) throw new Error("Replay TTL is invalid");
  }

  accept(key: string, now: number): boolean {
    if (this.has(key, now)) return false;
    this.record(key, now);
    return true;
  }

  has(key: string, now: number): boolean {
    this.prune(now);
    return this.entries.has(key);
  }

  record(key: string, now: number): void {
    this.prune(now);
    this.entries.delete(key);
    this.entries.set(key, now + this.ttlMs);
    while (this.entries.size > this.capacity) {
      const oldest = this.entries.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }

  get size(): number {
    return this.entries.size;
  }

  private prune(now: number): void {
    for (const [key, expiresAt] of this.entries) {
      if (expiresAt > now) continue;
      this.entries.delete(key);
    }
  }
}

export class FixedWindowRateLimiter {
  private readonly entries = new Map<string, { start: number; count: number }>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly maxKeys = 128,
  ) {
    if (!Number.isInteger(limit) || limit < 1) throw new Error("Rate limit is invalid");
    if (!Number.isFinite(windowMs) || windowMs < 1) throw new Error("Rate window is invalid");
    if (!Number.isInteger(maxKeys) || maxKeys < 1) throw new Error("Rate key limit is invalid");
  }

  accept(key: string, now: number): boolean {
    const current = this.entries.get(key);
    if (!current || now - current.start >= this.windowMs || now < current.start) {
      this.entries.delete(key);
      this.entries.set(key, { start: now, count: 1 });
      this.trim();
      return true;
    }
    if (current.count >= this.limit) return false;
    current.count += 1;
    this.entries.delete(key);
    this.entries.set(key, current);
    return true;
  }

  retryAfterMs(key: string, now: number): number {
    const current = this.entries.get(key);
    if (!current || now < current.start || now - current.start >= this.windowMs) return 0;
    return Math.max(1, current.start + this.windowMs - now);
  }

  private trim(): void {
    while (this.entries.size > this.maxKeys) {
      const oldest = this.entries.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }
}

export interface JsonLineDecoderOptions {
  onValue(value: unknown): void;
  onError(error: Error): void;
  maxBytes?: number;
}

export class JsonLineDecoder {
  private buffer = Buffer.alloc(0);
  private discarding = false;
  private readonly maxBytes: number;

  constructor(private readonly options: JsonLineDecoderOptions) {
    this.maxBytes = options.maxBytes ?? MAX_FRAME_BYTES;
  }

  push(chunk: Buffer | Uint8Array): void {
    let incoming = Buffer.from(chunk);
    if (this.discarding) {
      const newline = incoming.indexOf(0x0a);
      if (newline < 0) return;
      incoming = incoming.subarray(newline + 1);
      this.discarding = false;
    }
    if (incoming.length === 0) return;
    this.buffer = Buffer.concat([this.buffer, incoming]);
    while (true) {
      const newline = this.buffer.indexOf(0x0a);
      if (newline < 0) break;
      const line = this.buffer.subarray(0, newline);
      this.buffer = this.buffer.subarray(newline + 1);
      if (line.length > this.maxBytes) {
        this.options.onError(new Error("Pi Fleet JSONL record is too large"));
        continue;
      }
      this.decodeLine(line);
    }
    if (this.buffer.length > this.maxBytes) {
      this.buffer = Buffer.alloc(0);
      this.discarding = true;
      this.options.onError(new Error("Pi Fleet JSONL record is too large"));
    }
  }

  finish(): void {
    if (this.discarding) {
      this.discarding = false;
      return;
    }
    if (this.buffer.length === 0) return;
    const line = this.buffer;
    this.buffer = Buffer.alloc(0);
    this.decodeLine(line);
  }

  private decodeLine(value: Buffer): void {
    const line = value.at(-1) === 0x0d ? value.subarray(0, -1) : value;
    if (line.length === 0) return;
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(line);
    } catch {
      this.options.onError(new Error("Pi Fleet JSONL record contains invalid UTF-8"));
      return;
    }
    try {
      this.options.onValue(JSON.parse(text));
    } catch {
      this.options.onError(new Error("Pi Fleet JSONL record is malformed JSON"));
    }
  }
}

export function validatePeerDescription(value: unknown): FleetPeerDescription {
  if (!isRecord(value)) throw new Error("Pi Fleet peer description is invalid");
  assertExactKeys(
    value,
    ["acceptsRequests", "cwd", "endpointId", "launchId", "name", "pid", "protocolVersion", "sessionId"],
    "peer description",
  );
  if (value.protocolVersion !== FLEET_PROTOCOL_VERSION) {
    throw new Error("Pi Fleet peer protocol version is unsupported");
  }
  const sessionId = requiredId(value.sessionId, "peer session id");
  const endpointId = requiredEndpointId(value.endpointId, "peer endpoint id");
  const name = optionalBoundedString(value.name, "peer name", 200);
  const cwd = optionalBoundedString(value.cwd, "peer cwd", 4_096);
  if (cwd === undefined) throw new Error("Pi Fleet peer cwd is invalid");
  const pid = finiteInteger(value.pid, "peer process id");
  if (pid < 1) throw new Error("Pi Fleet peer process id is invalid");
  const launchId = optionalId(value.launchId, "peer launch id");
  if (typeof value.acceptsRequests !== "boolean") {
    throw new Error("Pi Fleet peer request policy is invalid");
  }
  return {
    protocolVersion: FLEET_PROTOCOL_VERSION,
    sessionId,
    endpointId,
    ...(name ? { name } : {}),
    cwd,
    pid,
    ...(launchId ? { launchId } : {}),
    acceptsRequests: value.acceptsRequests,
  };
}

function normalizeUnsignedFrame(value: UnsignedFleetFrame): UnsignedFleetFrame {
  if (!isRecord(value)) throw new Error("Pi Fleet frame must be an object");
  assertExactKeys(
    value,
    [
      "groupId",
      "issuedAt",
      "nonce",
      "payload",
      "requestId",
      "senderEndpointId",
      "senderSessionId",
      "targetEndpointId",
      "targetSessionId",
    ],
    "frame",
  );
  return normalizeUnsignedFrameFields(value);
}

function normalizeUnsignedFrameFields(value: Record<string, unknown>): UnsignedFleetFrame {
  const groupId = value.groupId;
  if (typeof groupId !== "string" || !GROUP_ID.test(groupId)) {
    throw new Error("Pi Fleet frame group id is invalid");
  }
  return {
    groupId,
    requestId: requiredId(value.requestId, "request id"),
    targetSessionId: requiredId(value.targetSessionId, "target session id"),
    targetEndpointId: requiredEndpointId(value.targetEndpointId, "target endpoint id"),
    senderSessionId: requiredId(value.senderSessionId, "sender session id"),
    senderEndpointId: requiredEndpointId(value.senderEndpointId, "sender endpoint id"),
    issuedAt: finiteInteger(value.issuedAt, "frame issued time"),
    nonce: requiredId(value.nonce, "frame nonce"),
    payload: validatePayload(value.payload),
  };
}

function normalizeSignedFrame(value: unknown): SignedFleetFrame {
  if (!isRecord(value)) throw new Error("Pi Fleet frame must be an object");
  assertExactKeys(
    value,
    [
      "groupId",
      "issuedAt",
      "mac",
      "nonce",
      "payload",
      "requestId",
      "senderEndpointId",
      "senderSessionId",
      "targetEndpointId",
      "targetSessionId",
      "version",
    ],
    "signed frame",
  );
  if (value.version !== FLEET_PROTOCOL_VERSION) {
    throw new Error("Pi Fleet frame protocol version is unsupported");
  }
  const normalized = normalizeUnsignedFrameFields(value);
  if (typeof value.mac !== "string" || !BASE64URL_MAC.test(value.mac)) {
    throw new Error("Pi Fleet frame authentication tag is invalid");
  }
  return { version: FLEET_PROTOCOL_VERSION, ...normalized, mac: value.mac };
}

function validatePayload(value: unknown): FleetPayload {
  if (!isRecord(value) || typeof value.kind !== "string") {
    throw new Error("Pi Fleet frame payload is invalid");
  }
  if (value.kind === "describe") {
    assertExactKeys(value, ["kind"], "describe payload");
    return { kind: "describe" };
  }
  if (value.kind === "description") {
    assertExactKeys(value, ["kind", "peer"], "description payload");
    return { kind: "description", peer: validatePeerDescription(value.peer) };
  }
  if (value.kind === "message") {
    assertExactKeys(value, ["kickoffCapability", "kind", "message"], "message payload");
    const kickoffCapability = optionalId(value.kickoffCapability, "kickoff capability");
    const message = validateMessage(value.message);
    if (kickoffCapability && message.mode !== "kickoff") {
      throw new Error("Pi Fleet kickoff capability is invalid for this message mode");
    }
    return {
      kind: "message",
      message,
      ...(kickoffCapability ? { kickoffCapability } : {}),
    };
  }
  if (value.kind === "ack") {
    assertExactKeys(value, ["code", "error", "kind", "retryAfterMs", "status"], "ack payload");
    const status = value.status;
    if (status !== "accepted" && status !== "duplicate" && status !== "rejected" && status !== "busy") {
      throw new Error("Pi Fleet ack status is invalid");
    }
    const code = optionalAckCode(value.code);
    const error = optionalBoundedString(value.error, "ack error", 1_000);
    const retryAfterMs = optionalPositiveInteger(value.retryAfterMs, "ack retry delay", 86_400_000);
    if (status === "accepted" || status === "duplicate") {
      if (code || error || retryAfterMs !== undefined) {
        throw new Error("Pi Fleet successful ack contains rejection details");
      }
    } else if (!code) {
      throw new Error("Pi Fleet rejected ack requires an error code");
    }
    return {
      kind: "ack",
      status,
      ...(code ? { code } : {}),
      ...(error ? { error } : {}),
      ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
    };
  }
  throw new Error("Pi Fleet frame payload kind is invalid");
}

function normalizeUnsignedEndpointManifest(value: UnsignedEndpointManifest): UnsignedEndpointManifest {
  if (!isRecord(value)) throw new Error("Pi Fleet endpoint manifest must be an object");
  assertExactKeys(
    value,
    ["endpointId", "groupId", "pid", "publishedAt", "sessionId", "socketName"],
    "endpoint manifest",
  );
  return normalizeUnsignedEndpointManifestFields(value);
}

function normalizeUnsignedEndpointManifestFields(value: Record<string, unknown>): UnsignedEndpointManifest {
  const groupId = value.groupId;
  if (typeof groupId !== "string" || !GROUP_ID.test(groupId)) {
    throw new Error("Pi Fleet endpoint manifest group id is invalid");
  }
  const endpointId = requiredEndpointId(value.endpointId, "endpoint manifest id");
  const socketName = value.socketName;
  if (typeof socketName !== "string" || socketName !== `${endpointId}.sock`) {
    throw new Error("Pi Fleet endpoint manifest socket name is invalid");
  }
  const pid = finiteInteger(value.pid, "endpoint manifest process id");
  if (pid < 1) throw new Error("Pi Fleet endpoint manifest process id is invalid");
  return {
    groupId,
    endpointId,
    sessionId: requiredId(value.sessionId, "endpoint manifest session id"),
    socketName,
    pid,
    publishedAt: finiteInteger(value.publishedAt, "endpoint manifest publication time"),
  };
}

function normalizeSignedEndpointManifest(value: unknown): SignedEndpointManifest {
  if (!isRecord(value)) throw new Error("Pi Fleet endpoint manifest must be an object");
  assertExactKeys(
    value,
    ["endpointId", "groupId", "mac", "pid", "publishedAt", "sessionId", "socketName", "version"],
    "signed endpoint manifest",
  );
  if (value.version !== FLEET_PROTOCOL_VERSION) {
    throw new Error("Pi Fleet endpoint manifest protocol version is unsupported");
  }
  const normalized = normalizeUnsignedEndpointManifestFields(value);
  if (typeof value.mac !== "string" || !BASE64URL_MAC.test(value.mac)) {
    throw new Error("Pi Fleet endpoint manifest authentication tag is invalid");
  }
  return { version: FLEET_PROTOCOL_VERSION, ...normalized, mac: value.mac };
}

function keyedMac(domain: string, value: object, secret: Uint8Array): string {
  const key = Buffer.from(secret);
  if (key.length !== 32) throw new Error("Pi Fleet group secret must be exactly 32 bytes");
  return createHmac("sha256", key).update(domain).update(canonicalJson(value)).digest("base64url");
}

function safeMacEqual(actual: string, expected: string): boolean {
  const actualBytes = Buffer.from(actual);
  const expectedBytes = Buffer.from(expected);
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Pi Fleet frame contains a non-finite number");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .filter((key) => value[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  throw new Error("Pi Fleet frame contains unsupported data");
}

function requiredId(value: unknown, label: string): string {
  if (typeof value !== "string" || !SAFE_ID.test(value)) {
    throw new Error(`Pi Fleet ${label} is invalid`);
  }
  return value;
}

function requiredEndpointId(value: unknown, label: string): string {
  if (typeof value !== "string" || !ENDPOINT_ID.test(value)) {
    throw new Error(`Pi Fleet ${label} is invalid`);
  }
  return value;
}

function optionalId(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined;
  return requiredId(value, label);
}

function optionalAckCode(value: unknown): FleetAckCode | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !ACK_CODES.has(value as FleetAckCode)) {
    throw new Error("Pi Fleet ack error code is invalid");
  }
  return value as FleetAckCode;
}

function optionalBoundedString(value: unknown, label: string, maxBytes: number): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || Buffer.byteLength(value, "utf8") > maxBytes) {
    throw new Error(`Pi Fleet ${label} is invalid`);
  }
  return value;
}

function optionalPositiveInteger(value: unknown, label: string, maximum: number): number | undefined {
  if (value === undefined) return undefined;
  const normalized = finiteInteger(value, label);
  if (normalized < 1 || normalized > maximum) throw new Error(`Pi Fleet ${label} is invalid`);
  return normalized;
}

function finiteInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new Error(`Pi Fleet ${label} is invalid`);
  }
  return value;
}

function assertExactKeys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const allowedKeys = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!allowedKeys.has(key)) throw new Error(`Pi Fleet ${label} contains an unknown field`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
