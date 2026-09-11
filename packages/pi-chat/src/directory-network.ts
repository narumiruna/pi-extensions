import { randomUUID } from "node:crypto";
import type { Duplex } from "node:stream";
import Hyperswarm, { type PeerDiscovery, type PeerInfo } from "hyperswarm";
import type { ChatIdentity } from "./identity.js";
import { MAX_DIRECT_NEIGHBORS } from "./network-contract.js";
import { PeerRateLimiter } from "./protocol.js";
import {
  createDirectoryPresence,
  createDirectoryWireMessage,
  DirectoryCatalog,
  DirectoryFrameDecoder,
  type DirectoryWireMessage,
  encodeDirectoryFrame,
  PUBLIC_ROOM_DIRECTORY_TOPIC,
  type PublicRoomBrowseResult,
} from "./public-room-directory.js";

const DIRECTORY_HEARTBEAT_MS = 30_000;
const DIRECTORY_BROWSE_MS = 1_200;
const MAX_SYNC_RECORDS = 256;

export interface DirectoryPeer {
  publicKey: Buffer;
  send(message: DirectoryWireMessage): void;
  close(): void;
}

export interface DirectoryTransportListener {
  onPeer(peer: DirectoryPeer): void;
  onMessage(peer: DirectoryPeer, message: DirectoryWireMessage): void;
  onDisconnect(peer: DirectoryPeer): void;
  onError(error: Error): void;
}

export interface DirectoryTransport {
  start(listener: DirectoryTransportListener, signal?: AbortSignal): Promise<void>;
  refresh(signal?: AbortSignal): Promise<void>;
  stop(): Promise<void>;
}

export interface PublicRoomDirectory {
  start(signal?: AbortSignal): Promise<void>;
  browse(signal: AbortSignal, collectionMs?: number): Promise<PublicRoomBrowseResult>;
  stop(): Promise<void>;
}

export interface PublicRoomDirectorySessionOptions {
  identity: ChatIdentity;
  transport: DirectoryTransport;
  advertisedSlug?: string;
  now?: () => number;
  createId?: () => string;
}

interface DirectoryPeerState {
  peer: DirectoryPeer;
  limiter: PeerRateLimiter;
  violations: number;
}

export class PublicRoomDirectorySession implements PublicRoomDirectory {
  private readonly identity: ChatIdentity;
  private readonly transport: DirectoryTransport;
  private readonly advertisedSlug?: string;
  private readonly now: () => number;
  private readonly createId: () => string;
  private readonly catalog: DirectoryCatalog;
  private readonly peers = new Map<string, DirectoryPeerState>();
  private started = false;
  private startPromise: Promise<void> | undefined;
  private stopPromise: Promise<void> | undefined;
  private transportStopPromise: Promise<void> | undefined;
  private heartbeatTimer: NodeJS.Timeout | undefined;
  private generation = 0;

  constructor(options: PublicRoomDirectorySessionOptions) {
    this.identity = options.identity;
    this.transport = options.transport;
    this.advertisedSlug = options.advertisedSlug;
    this.now = options.now ?? Date.now;
    this.createId = options.createId ?? randomUUID;
    this.catalog = new DirectoryCatalog({ now: this.now });
  }

  start(signal?: AbortSignal): Promise<void> {
    if (this.startPromise) return this.startPromise;
    if (this.stopPromise) throw new Error("Public room directory has already stopped.");
    this.startPromise = this.startOwned(signal);
    return this.startPromise;
  }

  async browse(signal: AbortSignal, collectionMs = DIRECTORY_BROWSE_MS): Promise<PublicRoomBrowseResult> {
    const temporary = !this.started && !this.advertisedSlug;
    try {
      await this.start(signal);
      signal.throwIfAborted();
      await this.transport.refresh(signal);
      await abortableDelay(Math.max(0, collectionMs), signal);
      signal.throwIfAborted();
      return this.catalog.snapshot();
    } finally {
      if (temporary) await this.stop();
    }
  }

  stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    this.stopPromise = this.stopOwned();
    return this.stopPromise;
  }

  private async startOwned(signal?: AbortSignal): Promise<void> {
    const owner = ++this.generation;
    this.started = true;
    try {
      await this.transport.start(
        {
          onPeer: (peer) => this.onPeer(owner, peer),
          onMessage: (peer, message) => this.onMessage(owner, peer, message),
          onDisconnect: (peer) => this.onDisconnect(owner, peer),
          onError: () => this.catalog.markPartial(),
        },
        signal,
      );
      signal?.throwIfAborted();
      if (owner !== this.generation) return;
      if (this.advertisedSlug) this.publish("online");
      this.heartbeatTimer = setInterval(() => {
        if (owner === this.generation && this.started && this.advertisedSlug) {
          this.publish("online");
        }
      }, DIRECTORY_HEARTBEAT_MS);
      this.heartbeatTimer.unref();
    } catch (error) {
      this.started = false;
      await this.stopTransport();
      throw error;
    }
  }

  private onPeer(owner: number, peer: DirectoryPeer): void {
    if (owner !== this.generation || !this.started) {
      peer.close();
      return;
    }
    const id = peer.publicKey.toString("hex");
    const previous = this.peers.get(id);
    if (previous && previous.peer !== peer) previous.peer.close();
    this.peers.set(id, {
      peer,
      limiter: new PeerRateLimiter({ burst: MAX_SYNC_RECORDS, refillPerSecond: 16, now: this.now }),
      violations: 0,
    });
    const events = this.catalog.currentEvents();
    const partial = events.length > MAX_SYNC_RECORDS || this.catalog.snapshot().partial;
    if (events.length > MAX_SYNC_RECORDS) this.catalog.markPartial();
    for (const [index, event] of events.slice(0, MAX_SYNC_RECORDS).entries()) {
      try {
        peer.send(createDirectoryWireMessage(event, undefined, partial && index === 0));
      } catch {
        break;
      }
    }
  }

  private onMessage(owner: number, peer: DirectoryPeer, message: DirectoryWireMessage): void {
    if (owner !== this.generation || !this.started) return;
    const state = this.peers.get(peer.publicKey.toString("hex"));
    if (!state || state.peer !== peer) return;
    if (!state.limiter.accept()) {
      this.violate(state);
      return;
    }
    if (message.partial) this.catalog.markPartial();
    if (!this.catalog.accept(message.event)) {
      return;
    }
    if (message.hops > 1) {
      this.broadcast(createDirectoryWireMessage(message.event, message.hops - 1, message.partial), peer);
    }
  }

  private onDisconnect(owner: number, peer: DirectoryPeer): void {
    if (owner !== this.generation) return;
    const id = peer.publicKey.toString("hex");
    if (this.peers.get(id)?.peer === peer) this.peers.delete(id);
  }

  private publish(status: "online" | "leaving"): void {
    if (!this.advertisedSlug) return;
    const event = createDirectoryPresence(this.identity, this.advertisedSlug, status, this.now(), this.createId());
    this.catalog.accept(event);
    this.broadcast(createDirectoryWireMessage(event));
  }

  private broadcast(message: DirectoryWireMessage, exclude?: DirectoryPeer): void {
    for (const state of this.peers.values()) {
      if (state.peer === exclude) continue;
      try {
        state.peer.send(message);
      } catch {
        state.violations += 1;
      }
    }
  }

  private violate(state: DirectoryPeerState): void {
    state.violations += 1;
    if (state.violations > 3) {
      state.peer.close();
      this.peers.delete(state.peer.publicKey.toString("hex"));
    }
  }

  private async stopOwned(): Promise<void> {
    this.generation += 1;
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = undefined;
    if (this.started && this.advertisedSlug) this.publish("leaving");
    this.started = false;
    for (const state of this.peers.values()) state.peer.close();
    this.peers.clear();
    await this.stopTransport();
  }

  private stopTransport(): Promise<void> {
    if (!this.transportStopPromise) {
      this.transportStopPromise = this.transport.stop().catch(() => undefined);
    }
    return this.transportStopPromise;
  }
}

export interface HyperswarmDirectoryTransportOptions {
  identity: ChatIdentity;
  dht?: unknown;
  bootstrap?: unknown[];
}

interface ActiveConnection {
  socket: Duplex;
  peer: DirectoryPeer;
}

export class HyperswarmDirectoryTransport implements DirectoryTransport {
  private readonly options: HyperswarmDirectoryTransportOptions;
  private swarm: Hyperswarm | undefined;
  private discovery: PeerDiscovery | undefined;
  private listener: DirectoryTransportListener | undefined;
  private readonly connections = new Map<Duplex, ActiveConnection>();
  private stopPromise: Promise<void> | undefined;

  constructor(options: HyperswarmDirectoryTransportOptions) {
    this.options = options;
  }

  async start(listener: DirectoryTransportListener, signal?: AbortSignal): Promise<void> {
    if (this.swarm) throw new Error("Public room directory transport has already started.");
    const startupSignal = signal ? AbortSignal.any([signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000);
    startupSignal.throwIfAborted();
    this.listener = listener;
    const swarm = new Hyperswarm({
      keyPair: {
        publicKey: this.options.identity.publicKey,
        secretKey: this.options.identity.secretKey,
      },
      maxPeers: MAX_DIRECT_NEIGHBORS,
      ...(this.options.dht ? { dht: this.options.dht } : {}),
      ...(this.options.bootstrap ? { bootstrap: this.options.bootstrap } : {}),
    });
    this.swarm = swarm;
    swarm.on("connection", (socket, info) => this.accept(socket, info));
    swarm.on("error", (error) => this.listener?.onError(safeNetworkError(error)));
    try {
      this.discovery = swarm.join(PUBLIC_ROOM_DIRECTORY_TOPIC, {
        server: true,
        client: true,
        limit: MAX_DIRECT_NEIGHBORS,
      });
      await raceAbort(this.discovery.flushed(), startupSignal);
      startupSignal.throwIfAborted();
    } catch (error) {
      await this.stop();
      throw error;
    }
  }

  async refresh(signal?: AbortSignal): Promise<void> {
    if (!this.discovery) throw new Error("Public room directory is not running.");
    await raceAbort(this.discovery.refresh({ server: true, client: true, limit: MAX_DIRECT_NEIGHBORS }), signal);
  }

  stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    this.stopPromise = this.stopOwned();
    return this.stopPromise;
  }

  private accept(socket: Duplex, info: PeerInfo): void {
    if (!this.swarm || !this.listener || this.connections.size >= MAX_DIRECT_NEIGHBORS) {
      socket.destroy();
      return;
    }
    const decoder = new DirectoryFrameDecoder();
    let closed = false;
    const peer: DirectoryPeer = {
      publicKey: Buffer.from(info.publicKey),
      send(message) {
        if (closed || socket.destroyed) throw new Error("Directory peer connection is closed.");
        const accepted = socket.write(encodeDirectoryFrame(message));
        if (!accepted && socket.destroyed) {
          throw new Error("Directory peer connection rejected the message.");
        }
      },
      close() {
        if (closed) return;
        closed = true;
        socket.destroy();
      },
    };
    this.connections.set(socket, { socket, peer });
    this.listener.onPeer(peer);
    socket.on("data", (chunk: unknown) => {
      if (closed || !this.listener) return;
      try {
        const bytes =
          typeof chunk === "string"
            ? Buffer.from(chunk)
            : Buffer.isBuffer(chunk)
              ? chunk
              : Buffer.from(chunk as Uint8Array);
        for (const message of decoder.push(bytes)) this.listener.onMessage(peer, message);
      } catch {
        closed = true;
        socket.destroy();
        this.listener?.onError(new Error("Pi Chat rejected invalid directory protocol data."));
      }
    });
    const disconnected = () => {
      if (!this.connections.delete(socket)) return;
      closed = true;
      this.listener?.onDisconnect(peer);
    };
    socket.once("close", disconnected);
    socket.once("error", (error) => {
      this.listener?.onError(safeNetworkError(error));
      disconnected();
    });
  }

  private async stopOwned(): Promise<void> {
    const discovery = this.discovery;
    this.discovery = undefined;
    if (discovery) await discovery.destroy().catch(() => undefined);
    for (const { socket } of this.connections.values()) socket.destroy();
    this.connections.clear();
    const swarm = this.swarm;
    this.swarm = undefined;
    this.listener = undefined;
    if (swarm) await swarm.destroy().catch(() => undefined);
  }
}

async function abortableDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(done, milliseconds);
    const abort = () => done(signal.reason ?? new DOMException("Aborted", "AbortError"));
    function done(error?: unknown): void {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      if (error) reject(error);
      else resolve();
    }
    signal.addEventListener("abort", abort, { once: true });
  });
}

async function raceAbort<T>(operation: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return operation;
  signal.throwIfAborted();
  let remove = () => {};
  const aborted = new Promise<never>((_resolve, reject) => {
    const onAbort = () => reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
    signal.addEventListener("abort", onAbort, { once: true });
    remove = () => signal.removeEventListener("abort", onAbort);
  });
  try {
    return await Promise.race([operation, aborted]);
  } finally {
    remove();
  }
}

function safeNetworkError(error: unknown): Error {
  const code = error instanceof Error && "code" in error ? String(Reflect.get(error, "code")) : "error";
  return new Error(`Pi Chat directory network ${code}.`);
}
