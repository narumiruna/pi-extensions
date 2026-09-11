import type { Duplex } from "node:stream";
import Hyperswarm, { type PeerDiscovery, type PeerInfo } from "hyperswarm";
import type { ChatTransport, ChatTransportListener, TransportPeer } from "./chat-session.js";
import { type HyperswarmTransportOptions, MAX_DIRECT_NEIGHBORS } from "./network-contract.js";
import { encodeFrame, FrameDecoder, type ProtocolMessage } from "./protocol.js";

export type { HyperswarmTransportOptions } from "./network-contract.js";

interface ActiveConnection {
  socket: Duplex;
  peer: TransportPeer;
}

export { MAX_DIRECT_NEIGHBORS } from "./network-contract.js";

export function directNeighborLimit(requested?: number): number {
  if (!Number.isSafeInteger(requested) || (requested ?? 0) <= 0) return MAX_DIRECT_NEIGHBORS;
  return Math.min(requested ?? MAX_DIRECT_NEIGHBORS, MAX_DIRECT_NEIGHBORS);
}

export class HyperswarmTransport implements ChatTransport {
  private readonly options: HyperswarmTransportOptions;
  private swarm: Hyperswarm | undefined;
  private discovery: PeerDiscovery | undefined;
  private listener: ChatTransportListener | undefined;
  private readonly connections = new Map<Duplex, ActiveConnection>();
  private readonly refreshTimers = new Set<NodeJS.Timeout>();
  private stopPromise: Promise<void> | undefined;

  constructor(options: HyperswarmTransportOptions) {
    this.options = options;
  }

  get connectionCount(): number {
    return this.connections.size;
  }

  get connectedPeerKeys(): string[] {
    return [...this.connections.values()].map(({ peer }) => peer.publicKey.toString("hex")).sort();
  }

  async start(listener: ChatTransportListener, signal?: AbortSignal): Promise<void> {
    if (this.swarm) throw new Error("Hyperswarm transport has already started.");
    const startupSignal = signal ? AbortSignal.any([signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000);
    startupSignal.throwIfAborted();
    this.listener = listener;
    const maxPeers = directNeighborLimit(this.options.maxPeers);
    const swarm = new Hyperswarm({
      keyPair: {
        publicKey: this.options.identity.publicKey,
        secretKey: this.options.identity.secretKey,
      },
      maxPeers,
      ...(this.options.dht ? { dht: this.options.dht } : {}),
      ...(this.options.bootstrap ? { bootstrap: this.options.bootstrap } : {}),
    });
    this.swarm = swarm;
    swarm.on("connection", (socket, info) => this.accept(socket, info));
    swarm.on("error", (error) => this.listener?.onError(safeNetworkError(error)));
    try {
      const discovery = swarm.join(this.options.room.topic, {
        server: true,
        client: true,
        limit: maxPeers,
      });
      this.discovery = discovery;
      await raceAbort(discovery.flushed(), startupSignal);
      startupSignal.throwIfAborted();
      this.scheduleEarlyRefreshes(discovery);
    } catch (error) {
      await this.stop();
      throw error;
    }
  }

  stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    this.stopPromise = this.stopOwned();
    return this.stopPromise;
  }

  private scheduleEarlyRefreshes(discovery: PeerDiscovery): void {
    const delays = [250, 750, 1_500, 3_000, 6_000, 12_000];
    const schedule = (index: number): void => {
      const delayMs = delays[index];
      if (delayMs === undefined || this.discovery !== discovery) return;
      const timer = setTimeout(() => {
        this.refreshTimers.delete(timer);
        if (this.discovery !== discovery) return;
        void discovery
          .refresh()
          .catch(() => undefined)
          .finally(() => {
            if (this.discovery === discovery) schedule(index + 1);
          });
      }, delayMs);
      this.refreshTimers.add(timer);
    };
    schedule(0);
  }

  private accept(socket: Duplex, info: PeerInfo): void {
    if (!this.swarm || !this.listener || this.connections.size >= MAX_DIRECT_NEIGHBORS) {
      socket.destroy();
      return;
    }
    const decoder = new FrameDecoder();
    let closed = false;
    const peer: TransportPeer = {
      publicKey: Buffer.from(info.publicKey),
      send(message: ProtocolMessage) {
        if (closed || socket.destroyed) throw new Error("Peer connection is closed.");
        const accepted = socket.write(encodeFrame(message));
        if (!accepted && socket.destroyed) throw new Error("Peer connection rejected the message.");
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
        this.listener?.onError(new Error("Pi Chat rejected invalid peer protocol data."));
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
    for (const timer of this.refreshTimers) clearTimeout(timer);
    this.refreshTimers.clear();
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
  return new Error(`Pi Chat network ${code}.`);
}
