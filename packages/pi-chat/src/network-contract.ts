import type { ChatIdentity } from "./identity.js";
import type { RoomDescriptor } from "./room.js";

export const MAX_DIRECT_NEIGHBORS = 8;

export interface HyperswarmTransportOptions {
  room: RoomDescriptor;
  identity: ChatIdentity;
  maxPeers?: number;
  dht?: unknown;
  bootstrap?: unknown[];
}
