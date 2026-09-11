declare module "sodium-universal" {
  interface SodiumUniversal {
    crypto_sign_BYTES: number;
    crypto_sign_detached(signature: Uint8Array, message: Uint8Array, secretKey: Uint8Array): void;
    crypto_sign_verify_detached(signature: Uint8Array, message: Uint8Array, publicKey: Uint8Array): boolean;
  }
  const sodium: SodiumUniversal;
  export default sodium;
}

declare module "hyperdht" {
  export interface HyperDhtKeyPair {
    publicKey: Buffer;
    secretKey: Buffer;
  }

  interface HyperDhtConstructor {
    keyPair(seed?: Uint8Array): HyperDhtKeyPair;
  }

  const HyperDHT: HyperDhtConstructor;
  export default HyperDHT;
}

declare module "hyperswarm" {
  import type { Duplex } from "node:stream";
  import type { HyperDhtKeyPair } from "hyperdht";

  export interface PeerInfo {
    publicKey: Buffer;
    topics: Buffer[];
    ban(value?: boolean): void;
  }

  export interface PeerDiscovery {
    flushed(): Promise<void>;
    destroy(): Promise<void>;
    refresh(options?: { client?: boolean; server?: boolean; limit?: number }): Promise<void>;
  }

  export interface HyperswarmOptions {
    keyPair?: HyperDhtKeyPair;
    seed?: Uint8Array;
    maxPeers?: number;
    firewall?: (remotePublicKey: Buffer) => boolean;
    dht?: unknown;
    bootstrap?: unknown[];
  }

  export default class Hyperswarm {
    constructor(options?: HyperswarmOptions);
    connections: Set<Duplex>;
    connecting: number;
    on(event: "connection", listener: (socket: Duplex, info: PeerInfo) => void): this;
    on(event: "update", listener: () => void): this;
    on(event: "error", listener: (error: Error) => void): this;
    join(topic: Buffer, options?: { client?: boolean; server?: boolean; limit?: number }): PeerDiscovery;
    joinPeer(publicKey: Buffer): void;
    leavePeer(publicKey: Buffer): void;
    flush(): Promise<void>;
    destroy(options?: { force?: boolean }): Promise<void>;
  }
}

declare module "hyperdht/testnet.js" {
  interface Testnet {
    nodes: unknown[];
    bootstrap: unknown[];
    createNode(options?: Record<string, unknown>): unknown;
    destroy(): Promise<void>;
  }
  export default function createTestnet(size?: number, options?: Record<string, unknown>): Promise<Testnet>;
}
