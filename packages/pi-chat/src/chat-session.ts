import { randomBytes, randomUUID } from "node:crypto";
import type { ChatIdentity } from "./identity.js";
import { formatIdentityLabel, normalizeNickname, uniqueIdentityTags } from "./identity.js";
import {
  createChatEvent,
  createGossipMessage,
  createHello,
  createPresenceEvent,
  type GossipMessage,
  MAX_EVENT_AGE_MS,
  PeerRateLimiter,
  type PresenceEvent,
  type ProtocolMessage,
  type RoomDescriptor,
  type RoomEvent,
  verifyHello,
  verifyRoomEvent,
} from "./protocol.js";

const MAX_TRANSCRIPT = 256;
const MAX_SEEN_MESSAGES = 8_192;
const SEEN_MESSAGE_TTL_MS = 10 * 60_000;
const MAX_PROTOCOL_VIOLATIONS = 3;
const MAX_PARTICIPANTS = 256;
const PARTICIPANT_TTL_MS = 90_000;
const PRESENCE_HEARTBEAT_MS = 30_000;
const MAX_ORIGIN_LIMITERS = 512;

export interface TransportPeer {
  publicKey: Buffer;
  send(message: ProtocolMessage): void;
  close(): void;
}

export interface ChatTransportListener {
  onPeer(peer: TransportPeer): void;
  onMessage(peer: TransportPeer, message: ProtocolMessage): void;
  onDisconnect(peer: TransportPeer): void;
  onError(error: Error): void;
}

export interface ChatTransport {
  start(listener: ChatTransportListener, signal?: AbortSignal): Promise<void>;
  stop(): Promise<void>;
}

export interface TranscriptEntry {
  id: string;
  author: "local" | "remote";
  label: string;
  publicKey: string;
  text: string;
  sentAt: number;
  delivery?: "relayed" | "not-relayed";
  relayedTo?: number;
}

export interface ParticipantSnapshot {
  publicKey: string;
  label: string;
  nickname: string;
  muted: boolean;
}

export interface ChatSnapshot {
  state: "connecting" | "connected" | "degraded" | "disconnected";
  room: RoomDescriptor;
  localLabel: string;
  participants: ParticipantSnapshot[];
  directNeighbors: number;
  participantCatalogFull: boolean;
  transcript: TranscriptEntry[];
  unread: number;
  composerOpen: boolean;
  lastError?: string;
}

export interface ChatSessionOptions {
  room: RoomDescriptor;
  identity: ChatIdentity;
  nickname: string;
  transport: ChatTransport;
  now?: () => number;
  onChange?: (snapshot: ChatSnapshot) => void;
}

interface PeerState {
  peer: TransportPeer;
  authenticated: boolean;
  nickname?: string;
  violations: number;
  limiter: PeerRateLimiter;
}

interface ParticipantState {
  publicKey: Buffer;
  nickname: string;
  muted: boolean;
  lastSeen: number;
}

interface OriginLimiterState {
  limiter: PeerRateLimiter;
  lastSeen: number;
}

interface ParticipantVersionState {
  issuedAt: number;
  id: string;
}

export class ChatSession {
  private readonly room: RoomDescriptor;
  private readonly identity: ChatIdentity;
  private nickname: string;
  private readonly transport: ChatTransport;
  private readonly now: () => number;
  private readonly onChange?: (snapshot: ChatSnapshot) => void;
  private readonly peers = new Map<string, PeerState>();
  private readonly participants = new Map<string, ParticipantState>();
  private readonly mutedOrigins = new Set<string>();
  private readonly transcript: TranscriptEntry[] = [];
  private readonly seen = new Map<string, number>();
  private readonly seenOrder: Array<{ key: string; expiresAt: number }> = [];
  private readonly originLimiters = new Map<string, OriginLimiterState>();
  private readonly participantVersions = new Map<string, ParticipantVersionState>();
  private readonly listeners = new Set<(snapshot: ChatSnapshot) => void>();
  private state: ChatSnapshot["state"] = "disconnected";
  private unread = 0;
  private viewOpen = false;
  private lastError: string | undefined;
  private generation = 0;
  private leavePromise: Promise<void> | undefined;
  private heartbeatTimer: NodeJS.Timeout | undefined;
  private currentPresence: PresenceEvent | undefined;
  private participantCatalogFull = false;

  constructor(options: ChatSessionOptions) {
    const nickname = normalizeNickname(options.nickname);
    if (!nickname) throw new Error("Pi Chat nickname is invalid.");
    this.room = options.room;
    this.identity = options.identity;
    this.nickname = nickname;
    this.transport = options.transport;
    this.now = options.now ?? Date.now;
    this.onChange = options.onChange;
  }

  async start(signal?: AbortSignal): Promise<void> {
    if (this.state !== "disconnected" || this.leavePromise) {
      throw new Error("Pi Chat session has already started.");
    }
    const owner = ++this.generation;
    this.state = "connecting";
    this.emit();
    try {
      await this.transport.start(
        {
          onPeer: (peer) => this.onPeer(owner, peer),
          onMessage: (peer, message) => this.onMessage(owner, peer, message),
          onDisconnect: (peer) => this.onDisconnect(owner, peer),
          onError: (error) => this.onError(owner, error),
        },
        signal,
      );
      signal?.throwIfAborted();
      if (owner !== this.generation) return;
      this.state = "connected";
      this.startHeartbeat(owner);
      this.emit();
    } catch (error) {
      if (owner === this.generation) {
        this.state = "disconnected";
        this.lastError = safeError(error);
        this.emit();
      }
      await this.transport.stop().catch(() => undefined);
      throw error;
    }
  }

  send(text: string): { id: string; relayedTo: number } {
    if (this.state !== "connected" && this.state !== "degraded") {
      throw new Error("Pi Chat is not connected.");
    }
    const id = randomUUID();
    const event = createChatEvent(this.room, this.identity, this.nickname, text, this.now(), id);
    this.remember(eventKey(event));
    const relayedTo = this.broadcast(createGossipMessage(event));
    this.pushTranscript({
      id,
      author: "local",
      label: formatIdentityLabel(this.nickname, this.identity.publicKey),
      publicKey: this.identity.publicKey.toString("hex"),
      text,
      sentAt: event.issuedAt,
      delivery: relayedTo > 0 ? "relayed" : "not-relayed",
      relayedTo,
    });
    this.emit();
    return { id, relayedTo };
  }

  updateNickname(value: string): void {
    const nickname = normalizeNickname(value);
    if (!nickname) throw new Error("Pi Chat nickname is invalid.");
    this.nickname = nickname;
    this.publishPresence("online");
    this.emit();
  }

  mute(publicKey: Uint8Array): void {
    const id = keyId(publicKey);
    if (!this.participants.has(id)) return;
    this.mutedOrigins.add(id);
    const participant = this.participants.get(id);
    if (participant) participant.muted = true;
    this.emit();
  }

  toggleMute(publicKey: Uint8Array): boolean | undefined {
    const id = keyId(publicKey);
    const participant = this.participants.get(id);
    if (!participant) return undefined;
    if (this.mutedOrigins.has(id)) {
      this.mutedOrigins.delete(id);
      participant.muted = false;
    } else {
      this.mutedOrigins.add(id);
      participant.muted = true;
    }
    this.emit();
    return participant.muted;
  }

  subscribe(listener: (snapshot: ChatSnapshot) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  setViewOpen(open: boolean): void {
    if (this.viewOpen === open) return;
    this.viewOpen = open;
    if (open) this.unread = 0;
    this.emit();
  }

  leave(): Promise<void> {
    if (this.leavePromise) return this.leavePromise;
    this.leavePromise = this.leaveOwned();
    return this.leavePromise;
  }

  snapshot(): ChatSnapshot {
    this.pruneParticipants();
    const active = [...this.participants.entries()];
    const tags = uniqueIdentityTags([this.identity.publicKey, ...active.map(([, value]) => value.publicKey)]);
    const localKey = this.identity.publicKey.toString("hex");
    const participants = active
      .map(([publicKey, value]) => ({
        publicKey,
        nickname: value.nickname,
        label: `${value.nickname}~${tags.get(publicKey) ?? formatIdentityLabel(value.nickname, value.publicKey).split("~").at(-1)}`,
        muted: value.muted,
      }))
      .sort((left, right) => left.label.localeCompare(right.label));
    return {
      state: this.state,
      room: this.room,
      localLabel: `${this.nickname}~${tags.get(localKey) ?? formatIdentityLabel(this.nickname, this.identity.publicKey).split("~").at(-1)}`,
      participants,
      directNeighbors: [...this.peers.values()].filter(({ authenticated }) => authenticated).length,
      participantCatalogFull: this.participantCatalogFull,
      transcript: this.transcript.map((entry) => {
        const tag = tags.get(entry.publicKey);
        const nickname = entry.label.split("~", 1)[0] ?? entry.label;
        return { ...entry, label: tag ? `${nickname}~${tag}` : entry.label };
      }),
      unread: this.unread,
      composerOpen: this.viewOpen,
      ...(this.lastError ? { lastError: this.lastError } : {}),
    };
  }

  private onPeer(owner: number, peer: TransportPeer): void {
    if (owner !== this.generation || this.state === "disconnected") {
      peer.close();
      return;
    }
    const id = keyId(peer.publicKey);
    if (id === this.identity.publicKey.toString("hex")) {
      peer.close();
      return;
    }
    const previous = this.peers.get(id);
    if (previous && previous.peer !== peer) previous.peer.close();
    const state: PeerState = {
      peer,
      authenticated: false,
      nickname: previous?.nickname,
      violations: 0,
      limiter: new PeerRateLimiter({ burst: 12, refillPerSecond: 4, now: this.now }),
    };
    this.peers.set(id, state);
    try {
      peer.send(createHello(this.room, this.nickname, this.identity.publicKey, peer.publicKey, randomBytes(16)));
    } catch {
      peer.close();
      this.peers.delete(id);
    }
  }

  private onMessage(owner: number, peer: TransportPeer, message: ProtocolMessage): void {
    if (owner !== this.generation) return;
    const id = keyId(peer.publicKey);
    const state = this.peers.get(id);
    if (!state || state.peer !== peer) return;
    if (!state.authenticated) {
      const hello = verifyHello(message, this.room, peer.publicKey, this.identity.publicKey);
      if (!hello) {
        this.violate(id, state);
        return;
      }
      state.authenticated = true;
      state.nickname = hello.nickname;
      this.upsertParticipant(id, peer.publicKey, hello.nickname, this.now());
      this.sendPresenceTo(state.peer);
      this.emit();
      return;
    }
    if (message.type === "hello") return;
    if (message.type === "goodbye") {
      this.peers.delete(id);
      peer.close();
      this.emit();
      return;
    }
    if (message.type !== "gossip") {
      this.violate(id, state);
      return;
    }
    this.onGossip(id, state, message);
  }

  private onGossip(peerId: string, state: PeerState, message: GossipMessage): void {
    const event = message.event;
    const key = eventKey(event);
    if (event.origin === this.identity.publicKey.toString("hex") || this.hasSeen(key)) return;
    if (!state.limiter.accept()) {
      this.violate(peerId, state);
      return;
    }
    if (!verifyRoomEvent(event, this.room, this.now())) {
      this.violate(peerId, state);
      return;
    }
    if (!this.acceptOrigin(event.origin)) return;
    this.remember(key);
    if (!this.applyEvent(event)) return;
    if (message.hops > 1) {
      this.broadcast(createGossipMessage(event, message.hops - 1), state.peer);
    }
  }

  private applyEvent(event: RoomEvent): boolean {
    const publicKey = Buffer.from(event.origin, "hex");
    const participantStateIsNew = this.acceptParticipantVersion(event);
    if (event.kind === "presence") {
      if (!participantStateIsNew) return false;
      if (event.status === "leaving") {
        this.participants.delete(event.origin);
        this.originLimiters.delete(event.origin);
      } else {
        this.upsertParticipant(event.origin, publicKey, event.nickname, this.now());
      }
      this.emit();
      return true;
    }
    if (participantStateIsNew) {
      this.upsertParticipant(event.origin, publicKey, event.nickname, this.now());
    }
    if (!this.mutedOrigins.has(event.origin)) {
      this.pushTranscript({
        id: event.id,
        author: "remote",
        label: formatIdentityLabel(event.nickname, publicKey),
        publicKey: event.origin,
        text: event.text,
        sentAt: event.issuedAt,
      });
      if (!this.viewOpen) this.unread += 1;
    }
    this.emit();
    return true;
  }

  private acceptParticipantVersion(event: RoomEvent): boolean {
    this.pruneParticipantVersions();
    const existing = this.participantVersions.get(event.origin);
    if (existing && compareEventVersion(existing, event) >= 0) return false;
    if (!existing && this.participantVersions.size >= MAX_SEEN_MESSAGES) {
      let oldestOrigin: string | undefined;
      let oldestVersion: ParticipantVersionState | undefined;
      for (const [origin, candidate] of this.participantVersions) {
        if (!oldestVersion || compareEventVersion(candidate, oldestVersion) < 0) {
          oldestOrigin = origin;
          oldestVersion = candidate;
        }
      }
      if (oldestOrigin) this.participantVersions.delete(oldestOrigin);
    }
    this.participantVersions.set(event.origin, {
      issuedAt: event.issuedAt,
      id: event.id,
    });
    return true;
  }

  private pruneParticipantVersions(): void {
    const oldest = this.now() - MAX_EVENT_AGE_MS;
    for (const [origin, version] of this.participantVersions) {
      if (version.issuedAt < oldest) this.participantVersions.delete(origin);
    }
  }

  private onDisconnect(owner: number, peer: TransportPeer): void {
    if (owner !== this.generation) return;
    const id = keyId(peer.publicKey);
    if (this.peers.get(id)?.peer === peer) {
      this.peers.delete(id);
      this.emit();
    }
  }

  private onError(owner: number, error: Error): void {
    if (owner !== this.generation) return;
    this.state = "degraded";
    this.lastError = safeError(error);
    this.emit();
  }

  private startHeartbeat(owner: number): void {
    this.heartbeatTimer = setInterval(() => {
      if (owner !== this.generation || this.state === "disconnected") return;
      this.publishPresence("online");
      this.pruneParticipants();
      this.emit();
    }, PRESENCE_HEARTBEAT_MS);
    this.heartbeatTimer.unref();
  }

  private publishPresence(status: "online" | "leaving"): void {
    const event = this.newPresence(status);
    this.broadcast(createGossipMessage(event));
  }

  private sendPresenceTo(peer: TransportPeer): void {
    const event = this.currentPresence ?? this.newPresence("online");
    try {
      peer.send(createGossipMessage(event));
    } catch {
      // The transport will publish disconnect state.
    }
  }

  private newPresence(status: "online" | "leaving"): PresenceEvent {
    const event = createPresenceEvent(this.room, this.identity, this.nickname, status, this.now(), randomUUID());
    this.currentPresence = status === "online" ? event : undefined;
    this.remember(eventKey(event));
    return event;
  }

  private broadcast(message: GossipMessage, exclude?: TransportPeer): number {
    let relayedTo = 0;
    for (const state of this.peers.values()) {
      if (!state.authenticated || state.peer === exclude) continue;
      try {
        state.peer.send(message);
        relayedTo += 1;
      } catch {
        state.violations += 1;
      }
    }
    return relayedTo;
  }

  private upsertParticipant(id: string, publicKey: Buffer, nickname: string, lastSeen: number): void {
    const existing = this.participants.get(id);
    if (!existing && this.participants.size >= MAX_PARTICIPANTS) {
      this.participantCatalogFull = true;
      return;
    }
    this.participants.set(id, {
      publicKey: Buffer.from(publicKey),
      nickname,
      muted: this.mutedOrigins.has(id),
      lastSeen,
    });
  }

  private pruneParticipants(): void {
    this.pruneParticipantVersions();
    const oldest = this.now() - PARTICIPANT_TTL_MS;
    for (const [id, participant] of this.participants) {
      if (participant.lastSeen < oldest) {
        this.participants.delete(id);
        this.originLimiters.delete(id);
      }
    }
    if (this.participants.size < MAX_PARTICIPANTS) this.participantCatalogFull = false;
  }

  private acceptOrigin(origin: string): boolean {
    const current = this.now();
    let state = this.originLimiters.get(origin);
    if (!state) {
      if (this.originLimiters.size >= MAX_ORIGIN_LIMITERS) {
        let oldestKey: string | undefined;
        let oldest = Number.POSITIVE_INFINITY;
        for (const [key, candidate] of this.originLimiters) {
          if (candidate.lastSeen < oldest) {
            oldest = candidate.lastSeen;
            oldestKey = key;
          }
        }
        if (oldestKey) this.originLimiters.delete(oldestKey);
      }
      state = {
        limiter: new PeerRateLimiter({ burst: 6, refillPerSecond: 1, now: this.now }),
        lastSeen: current,
      };
      this.originLimiters.set(origin, state);
    }
    state.lastSeen = current;
    return state.limiter.accept();
  }

  private hasSeen(key: string): boolean {
    this.pruneSeen();
    return this.seen.has(key);
  }

  private remember(key: string): void {
    this.pruneSeen();
    const expiresAt = this.now() + SEEN_MESSAGE_TTL_MS;
    this.seen.set(key, expiresAt);
    this.seenOrder.push({ key, expiresAt });
    while (this.seen.size > MAX_SEEN_MESSAGES) {
      const removed = this.seenOrder.shift();
      if (removed && this.seen.get(removed.key) === removed.expiresAt) {
        this.seen.delete(removed.key);
      }
    }
  }

  private pruneSeen(): void {
    const current = this.now();
    while (this.seenOrder[0] && this.seenOrder[0].expiresAt <= current) {
      const removed = this.seenOrder.shift();
      if (removed && this.seen.get(removed.key) === removed.expiresAt) {
        this.seen.delete(removed.key);
      }
    }
  }

  private violate(id: string, state: PeerState): void {
    state.violations += 1;
    if (state.violations > MAX_PROTOCOL_VIOLATIONS) {
      state.peer.close();
      this.peers.delete(id);
      this.emit();
    }
  }

  private pushTranscript(entry: TranscriptEntry): void {
    this.transcript.push(entry);
    if (this.transcript.length > MAX_TRANSCRIPT) this.transcript.shift();
  }

  private async leaveOwned(): Promise<void> {
    this.generation += 1;
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = undefined;
    if (this.state !== "disconnected") this.publishPresence("leaving");
    for (const state of this.peers.values()) {
      if (state.authenticated) {
        try {
          state.peer.send({ v: 2, type: "goodbye" });
        } catch {
          // Best-effort departure notice.
        }
      }
      state.peer.close();
    }
    this.peers.clear();
    this.participants.clear();
    this.originLimiters.clear();
    this.participantVersions.clear();
    this.seen.clear();
    this.seenOrder.length = 0;
    await this.transport.stop().catch((error) => {
      this.lastError = safeError(error);
    });
    this.state = "disconnected";
    this.unread = 0;
    this.transcript.length = 0;
    this.emit();
  }

  private emit(): void {
    const snapshot = this.snapshot();
    this.onChange?.(snapshot);
    for (const listener of this.listeners) listener(snapshot);
  }
}

function eventKey(event: RoomEvent): string {
  return `${event.origin}:${event.id}`;
}

function compareEventVersion(
  left: Pick<RoomEvent, "issuedAt" | "id">,
  right: Pick<RoomEvent, "issuedAt" | "id">,
): number {
  return left.issuedAt - right.issuedAt || left.id.localeCompare(right.id);
}

function keyId(publicKey: Uint8Array): string {
  return Buffer.from(publicKey).toString("hex");
}

function safeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
