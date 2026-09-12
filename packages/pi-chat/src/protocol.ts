import { createHmac, timingSafeEqual } from "node:crypto";
import type { ChatIdentity } from "./identity.js";
import { signIdentityPayload, verifyIdentityPayload } from "./identity.js";
import { normalizeNickname } from "./nickname.js";
import type { RoomDescriptor } from "./room.js";

export {
  createPrivateRoom,
  createPublicRoom,
  isCompatibleRoomId,
  legacyRoomId,
  parseInvite,
  type RoomDescriptor,
} from "./room.js";

export const PROTOCOL_VERSION = 2;
export const MAX_FRAME_BYTES = 16 * 1024;
export const MAX_MESSAGE_BYTES = 4 * 1024;
export const MAX_GOSSIP_HOPS = 8;
export const MAX_EVENT_AGE_MS = 5 * 60_000;
const MAX_EVENT_FUTURE_MS = 60_000;
const PUBLIC_KEY = /^[0-9a-f]{64}$/u;
const SIGNATURE = /^[A-Za-z0-9_-]{86}$/u;

export interface HelloMessage {
  v: 2;
  type: "hello";
  roomId: string;
  nonce: string;
  nickname: string;
  proof: string;
}

export interface ChatEvent {
  v: 2;
  kind: "chat";
  roomId: string;
  origin: string;
  id: string;
  issuedAt: number;
  nickname: string;
  text: string;
  signature: string;
}

export interface PresenceEvent {
  v: 2;
  kind: "presence";
  roomId: string;
  origin: string;
  id: string;
  issuedAt: number;
  nickname: string;
  status: "online" | "leaving";
  signature: string;
}

export type RoomEvent = ChatEvent | PresenceEvent;
type UnsignedRoomEvent = Omit<ChatEvent, "signature"> | Omit<PresenceEvent, "signature">;

export interface GossipMessage {
  v: 2;
  type: "gossip";
  event: RoomEvent;
  hops: number;
}

export interface GoodbyeMessage {
  v: 2;
  type: "goodbye";
}

export type ProtocolMessage = HelloMessage | GossipMessage | GoodbyeMessage;

export function createHello(
  room: RoomDescriptor,
  nicknameValue: string,
  senderPublicKey: Uint8Array,
  receiverPublicKey: Uint8Array,
  nonceBytes: Uint8Array,
): HelloMessage {
  const nickname = normalizeNickname(nicknameValue);
  if (!nickname) throw new Error("Nickname is invalid.");
  if (senderPublicKey.byteLength !== 32 || receiverPublicKey.byteLength !== 32) {
    throw new Error("Peer public keys must be 32 bytes.");
  }
  if (nonceBytes.byteLength !== 16) throw new Error("Handshake nonces must be 16 bytes.");
  const nonce = Buffer.from(nonceBytes).toString("base64url");
  return {
    v: 2,
    type: "hello",
    roomId: room.id,
    nonce,
    nickname,
    proof: helloProof(room, nickname, senderPublicKey, receiverPublicKey, nonce),
  };
}

export function verifyHello(
  value: unknown,
  room: RoomDescriptor,
  senderPublicKey: Uint8Array,
  receiverPublicKey: Uint8Array,
): HelloMessage | undefined {
  if (!isRecord(value) || value.v !== 2 || value.type !== "hello") return undefined;
  if (value.roomId !== room.id || typeof value.nonce !== "string" || typeof value.proof !== "string") {
    return undefined;
  }
  const nickname = normalizeNickname(value.nickname);
  if (!nickname || !/^[A-Za-z0-9_-]{22}$/u.test(value.nonce)) return undefined;
  const expected = helloProof(room, nickname, senderPublicKey, receiverPublicKey, value.nonce);
  const actualBytes = Buffer.from(value.proof, "base64url");
  const expectedBytes = Buffer.from(expected, "base64url");
  if (actualBytes.length !== expectedBytes.length || !timingSafeEqual(actualBytes, expectedBytes)) {
    return undefined;
  }
  return {
    v: 2,
    type: "hello",
    roomId: room.id,
    nonce: value.nonce,
    nickname,
    proof: value.proof,
  };
}

export function createChatEvent(
  room: RoomDescriptor,
  identity: ChatIdentity,
  nicknameValue: string,
  text: string,
  issuedAt: number,
  id: string,
): ChatEvent {
  const nickname = normalizeNickname(nicknameValue);
  if (!nickname) throw new Error("Nickname is invalid.");
  if (!text || Buffer.byteLength(text, "utf8") > MAX_MESSAGE_BYTES) {
    throw new Error("Chat message is empty or too large.");
  }
  validateEventFields(issuedAt, id);
  const unsigned: Omit<ChatEvent, "signature"> = {
    v: 2,
    kind: "chat",
    roomId: room.id,
    origin: identity.publicKey.toString("hex"),
    id,
    issuedAt,
    nickname,
    text,
  };
  return { ...unsigned, signature: signIdentityPayload(identity, canonicalEvent(unsigned)) };
}

export function createPresenceEvent(
  room: RoomDescriptor,
  identity: ChatIdentity,
  nicknameValue: string,
  status: PresenceEvent["status"],
  issuedAt: number,
  id: string,
): PresenceEvent {
  const nickname = normalizeNickname(nicknameValue);
  if (!nickname) throw new Error("Nickname is invalid.");
  if (status !== "online" && status !== "leaving") throw new Error("Presence state is invalid.");
  validateEventFields(issuedAt, id);
  const unsigned: Omit<PresenceEvent, "signature"> = {
    v: 2,
    kind: "presence",
    roomId: room.id,
    origin: identity.publicKey.toString("hex"),
    id,
    issuedAt,
    nickname,
    status,
  };
  return { ...unsigned, signature: signIdentityPayload(identity, canonicalEvent(unsigned)) };
}

export function createGossipMessage(event: RoomEvent, hops: number = MAX_GOSSIP_HOPS): GossipMessage {
  if (!Number.isSafeInteger(hops) || hops < 1 || hops > MAX_GOSSIP_HOPS) {
    throw new Error("Gossip hop budget is invalid.");
  }
  return { v: 2, type: "gossip", event, hops };
}

export function verifyRoomEvent(event: RoomEvent, room: RoomDescriptor, now = Date.now()): boolean {
  const parsed = parseRoomEvent(event);
  if (!parsed || parsed.roomId !== room.id) return false;
  if (parsed.issuedAt < now - MAX_EVENT_AGE_MS || parsed.issuedAt > now + MAX_EVENT_FUTURE_MS) {
    return false;
  }
  return verifyIdentityPayload(
    Buffer.from(parsed.origin, "hex"),
    canonicalEvent(withoutSignature(parsed)),
    parsed.signature,
  );
}

export function parseProtocolMessage(value: unknown): ProtocolMessage | undefined {
  if (!isRecord(value) || typeof value.type !== "string") return undefined;
  if (value.v === 2 && value.type === "gossip") {
    if (!Number.isSafeInteger(value.hops) || (value.hops as number) < 1 || (value.hops as number) > MAX_GOSSIP_HOPS) {
      return undefined;
    }
    const event = parseRoomEvent(value.event);
    return event ? { v: 2, type: "gossip", event, hops: value.hops as number } : undefined;
  }
  if (value.v === 2 && value.type === "hello") {
    if (
      typeof value.roomId !== "string" ||
      typeof value.nonce !== "string" ||
      typeof value.proof !== "string" ||
      !normalizeNickname(value.nickname)
    ) {
      return undefined;
    }
    return value as unknown as HelloMessage;
  }
  if (value.v === 2 && value.type === "goodbye") return { v: 2, type: "goodbye" };
  return undefined;
}

export function encodeFrame(message: ProtocolMessage): Buffer {
  const payload = Buffer.from(JSON.stringify(message), "utf8");
  if (payload.length > MAX_FRAME_BYTES) throw new Error("Protocol frame exceeds the size limit.");
  const header = Buffer.allocUnsafe(4);
  header.writeUInt32BE(payload.length);
  return Buffer.concat([header, payload]);
}

export class FrameDecoder {
  private buffer = Buffer.alloc(0);

  push(chunk: Uint8Array): ProtocolMessage[] {
    if (chunk.byteLength === 0) return [];
    const incoming = Buffer.from(chunk);
    const messages: ProtocolMessage[] = [];
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
        throw new Error("Protocol frame exceeds the size limit.");
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
      let text: string;
      try {
        text = new TextDecoder("utf-8", { fatal: true }).decode(payload);
      } catch {
        throw new Error("Protocol frame contains invalid UTF-8.");
      }
      let value: unknown;
      try {
        value = JSON.parse(text) as unknown;
      } catch {
        throw new Error("Protocol frame contains invalid JSON.");
      }
      const parsed = parseProtocolMessage(value);
      if (!parsed) throw new Error("Protocol frame has an invalid message shape.");
      messages.push(parsed);
    }
    return messages;
  }
}

export class PeerRateLimiter {
  private tokens: number;
  private lastRefill: number;
  private readonly burst: number;
  private readonly refillPerSecond: number;
  private readonly now: () => number;

  constructor(options: { burst: number; refillPerSecond: number; now?: () => number }) {
    if (options.burst <= 0 || options.refillPerSecond <= 0) {
      throw new Error("Rate limiter values must be positive.");
    }
    this.burst = options.burst;
    this.tokens = options.burst;
    this.refillPerSecond = options.refillPerSecond;
    this.now = options.now ?? Date.now;
    this.lastRefill = this.now();
  }

  accept(): boolean {
    const current = this.now();
    const elapsed = Math.max(0, current - this.lastRefill);
    this.lastRefill = current;
    this.tokens = Math.min(this.burst, this.tokens + (elapsed / 1000) * this.refillPerSecond);
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }
}

function parseRoomEvent(value: unknown): RoomEvent | undefined {
  if (!isRecord(value) || value.v !== 2 || (value.kind !== "chat" && value.kind !== "presence")) {
    return undefined;
  }
  const nickname = normalizeNickname(value.nickname);
  if (
    typeof value.roomId !== "string" ||
    !PUBLIC_KEY.test(String(value.origin)) ||
    !validId(value.id) ||
    !Number.isSafeInteger(value.issuedAt) ||
    (value.issuedAt as number) < 0 ||
    !nickname ||
    typeof value.signature !== "string" ||
    !SIGNATURE.test(value.signature)
  ) {
    return undefined;
  }
  const common = {
    v: 2 as const,
    roomId: value.roomId,
    origin: value.origin as string,
    id: value.id,
    issuedAt: value.issuedAt as number,
    nickname,
    signature: value.signature,
  };
  if (value.kind === "chat") {
    if (typeof value.text !== "string" || !value.text || Buffer.byteLength(value.text, "utf8") > MAX_MESSAGE_BYTES) {
      return undefined;
    }
    return { ...common, kind: "chat", text: value.text };
  }
  if (value.status !== "online" && value.status !== "leaving") return undefined;
  return { ...common, kind: "presence", status: value.status };
}

function canonicalEvent(event: UnsignedRoomEvent): Buffer {
  const payload =
    event.kind === "chat"
      ? [2, "chat", event.roomId, event.origin, event.id, event.issuedAt, event.nickname, event.text]
      : [2, "presence", event.roomId, event.origin, event.id, event.issuedAt, event.nickname, event.status];
  return Buffer.from(JSON.stringify(payload), "utf8");
}

function withoutSignature(event: RoomEvent): UnsignedRoomEvent {
  if (event.kind === "chat") {
    const { signature: _signature, ...unsigned } = event;
    return unsigned;
  }
  const { signature: _signature, ...unsigned } = event;
  return unsigned;
}

function validateEventFields(issuedAt: number, id: string): void {
  if (!Number.isSafeInteger(issuedAt) || issuedAt < 0) throw new Error("Message timestamp is invalid.");
  if (!validId(id)) throw new Error("Message id is invalid.");
}

function helloProof(
  room: RoomDescriptor,
  nickname: string,
  senderPublicKey: Uint8Array,
  receiverPublicKey: Uint8Array,
  nonce: string,
): string {
  const canonical = JSON.stringify([
    PROTOCOL_VERSION,
    room.id,
    nonce,
    nickname,
    Buffer.from(senderPublicKey).toString("hex"),
    Buffer.from(receiverPublicKey).toString("hex"),
  ]);
  return createHmac("sha256", room.key).update(canonical).digest("base64url");
}

function validId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 64 && !/\p{Cc}/u.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
