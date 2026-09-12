import { createHash } from "node:crypto";
import type { ChatIdentity } from "./identity.js";
import { signIdentityPayload, verifyIdentityPayload } from "./identity.js";
import { createPublicRoom, MAX_EVENT_AGE_MS, MAX_FRAME_BYTES, MAX_GOSSIP_HOPS } from "./protocol.js";

const MAX_EVENT_FUTURE_MS = 60_000;
const DIRECTORY_RECORD_TTL_MS = 90_000;
const MAX_DIRECTORY_RECORDS = 4_096;
const MAX_DIRECTORY_ROOMS = 512;
const MAX_DIRECTORY_SEEN = 16_384;
const DIRECTORY_SEEN_TTL_MS = 10 * 60_000;
const PUBLIC_KEY = /^[0-9a-f]{64}$/u;
const SIGNATURE = /^[A-Za-z0-9_-]{86}$/u;

export const PUBLIC_ROOM_DIRECTORY_TOPIC = createHash("sha256")
  .update("pi-chat/public-room-directory/v2", "utf8")
  .digest();

export interface DirectoryPresence {
  v: 2;
  kind: "directory-presence";
  slug: string;
  origin: string;
  id: string;
  issuedAt: number;
  status: "online" | "leaving";
  signature: string;
}

export interface DirectoryWireMessage {
  v: 2;
  type: "directory";
  event: DirectoryPresence;
  hops: number;
  partial?: true;
}

export interface PublicRoomListing {
  slug: string;
  estimatedParticipants: number;
}

export interface PublicRoomBrowseResult {
  rooms: PublicRoomListing[];
  partial: boolean;
}

export interface DirectoryCatalogOptions {
  now?: () => number;
  maxRecords?: number;
  maxRooms?: number;
}

interface SeenRecord {
  key: string;
  expiresAt: number;
}

export class DirectoryCatalog {
  private readonly now: () => number;
  private readonly maxRecords: number;
  private readonly maxRooms: number;
  private readonly records = new Map<string, DirectoryPresence>();
  private readonly seen = new Map<string, number>();
  private readonly seenOrder: SeenRecord[] = [];
  private truncated = false;

  constructor(options: DirectoryCatalogOptions = {}) {
    this.now = options.now ?? Date.now;
    this.maxRecords = positiveBound(options.maxRecords, MAX_DIRECTORY_RECORDS);
    this.maxRooms = positiveBound(options.maxRooms, MAX_DIRECTORY_ROOMS);
  }

  accept(event: DirectoryPresence): boolean {
    const now = this.now();
    if (!verifyDirectoryPresence(event, now)) return false;
    const seenKey = `${event.origin}:${event.id}`;
    if (this.hasSeen(seenKey)) return false;
    this.remember(seenKey);
    const existing = this.records.get(event.origin);
    if (
      existing &&
      (existing.issuedAt > event.issuedAt ||
        (existing.issuedAt === event.issuedAt && existing.id.localeCompare(event.id) >= 0))
    ) {
      return false;
    }
    if (!existing && this.records.size >= this.maxRecords) {
      this.truncated = true;
      return false;
    }
    const knownSlugs = new Set(
      [...this.records.values()].filter(({ status }) => status === "online").map(({ slug }) => slug),
    );
    if (event.status === "online" && !knownSlugs.has(event.slug) && knownSlugs.size >= this.maxRooms) {
      this.truncated = true;
      return false;
    }
    this.records.set(event.origin, event);
    return true;
  }

  snapshot(): PublicRoomBrowseResult {
    this.prune();
    const counts = new Map<string, number>();
    for (const event of this.records.values()) {
      if (event.status === "online") {
        counts.set(event.slug, (counts.get(event.slug) ?? 0) + 1);
      }
    }
    return {
      rooms: sortDirectoryRooms([...counts].map(([slug, estimatedParticipants]) => ({ slug, estimatedParticipants }))),
      partial: this.truncated,
    };
  }

  currentEvents(): DirectoryPresence[] {
    this.prune();
    return [...this.records.values()].sort(
      (left, right) => right.issuedAt - left.issuedAt || left.origin.localeCompare(right.origin),
    );
  }

  markPartial(): void {
    this.truncated = true;
  }

  private prune(): void {
    const now = this.now();
    for (const [origin, event] of this.records) {
      const ttl = event.status === "leaving" ? MAX_EVENT_AGE_MS : DIRECTORY_RECORD_TTL_MS;
      if (event.issuedAt < now - ttl) this.records.delete(origin);
    }
    this.pruneSeen();
  }

  private hasSeen(key: string): boolean {
    this.pruneSeen();
    return this.seen.has(key);
  }

  private remember(key: string): void {
    const expiresAt = this.now() + DIRECTORY_SEEN_TTL_MS;
    this.seen.set(key, expiresAt);
    this.seenOrder.push({ key, expiresAt });
    while (this.seen.size > MAX_DIRECTORY_SEEN) {
      const removed = this.seenOrder.shift();
      if (removed && this.seen.get(removed.key) === removed.expiresAt) {
        this.seen.delete(removed.key);
      }
    }
  }

  private pruneSeen(): void {
    const now = this.now();
    while (this.seenOrder[0] && this.seenOrder[0].expiresAt <= now) {
      const removed = this.seenOrder.shift();
      if (removed && this.seen.get(removed.key) === removed.expiresAt) {
        this.seen.delete(removed.key);
      }
    }
  }
}

export function createDirectoryPresence(
  identity: ChatIdentity,
  slugValue: string,
  status: DirectoryPresence["status"],
  issuedAt: number,
  id: string,
): DirectoryPresence {
  const slug = validatedSlug(slugValue);
  if (!slug) throw new Error("A public room slug must use lowercase letters, numbers, or hyphens.");
  if (status !== "online" && status !== "leaving") {
    throw new Error("Directory presence state is invalid.");
  }
  if (!Number.isSafeInteger(issuedAt) || issuedAt < 0) {
    throw new Error("Directory presence timestamp is invalid.");
  }
  if (!validId(id)) throw new Error("Directory presence id is invalid.");
  const unsigned: Omit<DirectoryPresence, "signature"> = {
    v: 2,
    kind: "directory-presence",
    slug,
    origin: identity.publicKey.toString("hex"),
    id,
    issuedAt,
    status,
  };
  return {
    ...unsigned,
    signature: signIdentityPayload(identity, canonicalDirectoryPresence(unsigned)),
  };
}

export function verifyDirectoryPresence(value: DirectoryPresence, now = Date.now()): boolean {
  const event = parseDirectoryPresence(value);
  if (!event) return false;
  if (event.issuedAt < now - MAX_EVENT_AGE_MS || event.issuedAt > now + MAX_EVENT_FUTURE_MS) {
    return false;
  }
  const { signature, ...unsigned } = event;
  return verifyIdentityPayload(Buffer.from(event.origin, "hex"), canonicalDirectoryPresence(unsigned), signature);
}

export function createDirectoryWireMessage(
  event: DirectoryPresence,
  hops = MAX_GOSSIP_HOPS,
  partial = false,
): DirectoryWireMessage {
  if (!Number.isSafeInteger(hops) || hops < 1 || hops > MAX_GOSSIP_HOPS) {
    throw new Error("Directory gossip hop budget is invalid.");
  }
  return { v: 2, type: "directory", event, hops, ...(partial ? { partial: true as const } : {}) };
}

export function parseDirectoryWireMessage(value: unknown): DirectoryWireMessage | undefined {
  if (
    !isRecord(value) ||
    value.v !== 2 ||
    value.type !== "directory" ||
    !Number.isSafeInteger(value.hops) ||
    (value.hops as number) < 1 ||
    (value.hops as number) > MAX_GOSSIP_HOPS
  ) {
    return undefined;
  }
  if (value.partial !== undefined && value.partial !== true) return undefined;
  const event = parseDirectoryPresence(value.event);
  return event
    ? {
        v: 2,
        type: "directory",
        event,
        hops: value.hops as number,
        ...(value.partial === true ? { partial: true as const } : {}),
      }
    : undefined;
}

export function encodeDirectoryFrame(message: DirectoryWireMessage): Buffer {
  const payload = Buffer.from(JSON.stringify(message), "utf8");
  if (payload.length > MAX_FRAME_BYTES) throw new Error("Directory frame exceeds the size limit.");
  const header = Buffer.allocUnsafe(4);
  header.writeUInt32BE(payload.length);
  return Buffer.concat([header, payload]);
}

export class DirectoryFrameDecoder {
  private buffer = Buffer.alloc(0);

  push(chunk: Uint8Array): DirectoryWireMessage[] {
    if (chunk.byteLength === 0) return [];
    const incoming = Buffer.from(chunk);
    const messages: DirectoryWireMessage[] = [];
    let offset = 0;
    while (offset < incoming.length) {
      if (this.buffer.length < 4) {
        const headerBytes = Math.min(4 - this.buffer.length, incoming.length - offset);
        this.buffer = Buffer.concat([this.buffer, incoming.subarray(offset, offset + headerBytes)]);
        offset += headerBytes;
        if (this.buffer.length < 4) break;
      }
      const length = this.buffer.readUInt32BE(0);
      if (length > MAX_FRAME_BYTES) {
        this.buffer = Buffer.alloc(0);
        throw new Error("Directory frame exceeds the size limit.");
      }
      const frameBytes = length + 4;
      if (this.buffer.length < frameBytes) {
        const payloadBytes = Math.min(frameBytes - this.buffer.length, incoming.length - offset);
        this.buffer = Buffer.concat([this.buffer, incoming.subarray(offset, offset + payloadBytes)]);
        offset += payloadBytes;
        if (this.buffer.length < frameBytes) break;
      }
      const payload = this.buffer.subarray(4, frameBytes);
      this.buffer = Buffer.alloc(0);
      let value: unknown;
      try {
        value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(payload)) as unknown;
      } catch {
        throw new Error("Directory frame is not valid UTF-8 JSON.");
      }
      const parsed = parseDirectoryWireMessage(value);
      if (!parsed) throw new Error("Directory frame has an invalid message shape.");
      messages.push(parsed);
    }
    return messages;
  }
}

export function sortDirectoryRooms(rooms: readonly PublicRoomListing[]): PublicRoomListing[] {
  return [...rooms].sort(
    (left, right) => right.estimatedParticipants - left.estimatedParticipants || left.slug.localeCompare(right.slug),
  );
}

function parseDirectoryPresence(value: unknown): DirectoryPresence | undefined {
  if (
    !isRecord(value) ||
    value.v !== 2 ||
    value.kind !== "directory-presence" ||
    !validatedSlug(value.slug) ||
    !PUBLIC_KEY.test(String(value.origin)) ||
    !validId(value.id) ||
    !Number.isSafeInteger(value.issuedAt) ||
    (value.issuedAt as number) < 0 ||
    (value.status !== "online" && value.status !== "leaving") ||
    typeof value.signature !== "string" ||
    !SIGNATURE.test(value.signature)
  ) {
    return undefined;
  }
  return {
    v: 2,
    kind: "directory-presence",
    slug: value.slug as string,
    origin: value.origin as string,
    id: value.id,
    issuedAt: value.issuedAt as number,
    status: value.status,
    signature: value.signature,
  };
}

function canonicalDirectoryPresence(event: Omit<DirectoryPresence, "signature">): Buffer {
  return Buffer.from(
    JSON.stringify([2, "directory-presence", event.slug, event.origin, event.id, event.issuedAt, event.status]),
    "utf8",
  );
}

function validatedSlug(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  try {
    return createPublicRoom(value).slug;
  } catch {
    return undefined;
  }
}

function positiveBound(value: number | undefined, fallback: number): number {
  return Number.isSafeInteger(value) && (value ?? 0) > 0 ? Math.min(value ?? fallback, fallback) : fallback;
}

function validId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 64 && !/\p{Cc}/u.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
