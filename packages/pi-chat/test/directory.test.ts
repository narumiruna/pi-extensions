import assert from "node:assert/strict";
import { test } from "vitest";
import {
  type DirectoryTransport,
  type DirectoryTransportListener,
  PublicRoomDirectorySession,
} from "../src/directory-network.js";
import { createIdentity, deriveScopedIdentity } from "../src/identity.js";
import { MAX_FRAME_BYTES, MAX_GOSSIP_HOPS } from "../src/protocol.js";
import {
  createDirectoryPresence,
  createDirectoryWireMessage,
  DirectoryCatalog,
  DirectoryFrameDecoder,
  encodeDirectoryFrame,
  parseDirectoryWireMessage,
  sortDirectoryRooms,
  verifyDirectoryPresence,
} from "../src/public-room-directory.js";

function scoped(seed: number, slug: string) {
  return deriveScopedIdentity(createIdentity(Buffer.alloc(32, seed)), `directory:#${slug}`);
}

class IdleDirectoryTransport implements DirectoryTransport {
  listener: DirectoryTransportListener | undefined;
  started = 0;
  refreshed = 0;
  stopped = 0;
  async start(listener: DirectoryTransportListener): Promise<void> {
    this.listener = listener;
    this.started += 1;
  }
  async refresh(): Promise<void> {
    this.refreshed += 1;
  }
  async stop(): Promise<void> {
    this.stopped += 1;
  }
}

class CatalogDirectoryTransport extends IdleDirectoryTransport {
  override async refresh(): Promise<void> {
    await super.refresh();
    const peer = {
      publicKey: Buffer.alloc(32, 99),
      send: () => undefined,
      close: () => undefined,
    };
    this.listener?.onPeer(peer);
    for (const [index, identity] of [scoped(10, "pi-dev"), scoped(11, "pi-dev")].entries()) {
      this.listener?.onMessage(
        peer,
        createDirectoryWireMessage(createDirectoryPresence(identity, "pi-dev", "online", 10_000, `mock-${index}`)),
      );
    }
  }
}

test("directory presence is room-scoped, signed, and mutation resistant", () => {
  const identity = scoped(1, "pi-dev");
  const event = createDirectoryPresence(identity, "pi-dev", "online", 10_000, "event-1");
  assert.equal(verifyDirectoryPresence(event, 10_000), true);
  assert.equal(verifyDirectoryPresence({ ...event, slug: "other" }, 10_000), false);
  assert.equal(verifyDirectoryPresence({ ...event, origin: "00".repeat(32) }, 10_000), false);
  assert.equal(verifyDirectoryPresence(event, 1_000_000), false);
  assert.throws(() => createDirectoryPresence(identity, "Invalid Room", "online", 1, "bad"), /public room slug/u);
});

test("directory frames bound hops and payload bytes before buffering", () => {
  const event = createDirectoryPresence(scoped(1, "pi-dev"), "pi-dev", "online", 10_000, "wire");
  const message = createDirectoryWireMessage(event);
  const encoded = encodeDirectoryFrame(message);
  const decoder = new DirectoryFrameDecoder();
  assert.deepEqual(decoder.push(encoded.subarray(0, 3)), []);
  assert.deepEqual(decoder.push(encoded.subarray(3)), [message]);
  assert.equal(parseDirectoryWireMessage({ ...message, hops: 0 }), undefined);
  assert.equal(parseDirectoryWireMessage({ ...message, partial: false }), undefined);
  assert.equal(parseDirectoryWireMessage({ ...message, hops: MAX_GOSSIP_HOPS + 1 }), undefined);
  const oversized = Buffer.alloc(4);
  oversized.writeUInt32BE(MAX_FRAME_BYTES + 1);
  assert.throws(() => new DirectoryFrameDecoder().push(oversized), /exceeds/u);
});

test("catalog deduplicates origins and sorts count descending then slug ascending", () => {
  const catalog = new DirectoryCatalog({ now: () => 10_000 });
  const first = createDirectoryPresence(scoped(1, "pi-dev"), "pi-dev", "online", 10_000, "a");
  const duplicate = { ...first };
  const second = createDirectoryPresence(scoped(2, "pi-dev"), "pi-dev", "online", 10_000, "b");
  const alpha = createDirectoryPresence(scoped(3, "alpha"), "alpha", "online", 10_000, "c");
  const beta = createDirectoryPresence(scoped(4, "beta"), "beta", "online", 10_000, "d");
  assert.equal(catalog.accept(first), true);
  assert.equal(catalog.accept(duplicate), false);
  assert.equal(catalog.accept(second), true);
  assert.equal(catalog.accept(beta), true);
  assert.equal(catalog.accept(alpha), true);
  assert.deepEqual(catalog.snapshot().rooms, [
    { slug: "pi-dev", estimatedParticipants: 2 },
    { slug: "alpha", estimatedParticipants: 1 },
    { slug: "beta", estimatedParticipants: 1 },
  ]);
});

test("catalog applies signed leaving records, expires heartbeats, and marks bounded results partial", () => {
  let now = 10_000;
  const catalog = new DirectoryCatalog({ now: () => now, maxRecords: 2 });
  const firstIdentity = scoped(1, "one");
  assert.equal(catalog.accept(createDirectoryPresence(firstIdentity, "one", "online", now, "one-online")), true);
  assert.equal(catalog.accept(createDirectoryPresence(scoped(2, "two"), "two", "online", now, "two")), true);
  assert.equal(catalog.accept(createDirectoryPresence(scoped(3, "three"), "three", "online", now, "three")), false);
  assert.equal(catalog.snapshot().partial, true);
  assert.equal(catalog.accept(createDirectoryPresence(firstIdentity, "one", "leaving", now + 1, "one-left")), true);
  assert.deepEqual(catalog.snapshot().rooms, [{ slug: "two", estimatedParticipants: 1 }]);
  now += 100_000;
  assert.deepEqual(catalog.snapshot().rooms, []);
});

test("catalog retains departure ordering against delayed online records", () => {
  const catalog = new DirectoryCatalog({ now: () => 10_002 });
  const identity = scoped(1, "pi-dev");
  const initial = createDirectoryPresence(identity, "pi-dev", "online", 10_000, "initial");
  const leaving = createDirectoryPresence(identity, "pi-dev", "leaving", 10_002, "z");
  const delayedByTime = createDirectoryPresence(identity, "pi-dev", "online", 10_001, "delayed-time");
  const delayedById = createDirectoryPresence(identity, "pi-dev", "online", 10_002, "a");

  assert.equal(catalog.accept(initial), true);
  assert.equal(catalog.accept(leaving), true);
  assert.equal(catalog.accept(delayedByTime), false);
  assert.equal(catalog.accept(delayedById), false);
  assert.deepEqual(catalog.snapshot().rooms, []);
  assert.deepEqual(catalog.currentEvents(), [leaving]);
});

test("sort helper is deterministic and does not mutate caller state", () => {
  const rooms = [
    { slug: "zeta", estimatedParticipants: 1 },
    { slug: "alpha", estimatedParticipants: 1 },
    { slug: "busy", estimatedParticipants: 9 },
  ];
  assert.deepEqual(sortDirectoryRooms(rooms), [rooms[2], rooms[1], rooms[0]]);
  assert.equal(rooms[0]?.slug, "zeta");
});

test("mocked directory discovery returns two scoped advertisers and fully stops", async () => {
  const transport = new CatalogDirectoryTransport();
  const directory = new PublicRoomDirectorySession({
    identity: createIdentity(Buffer.alloc(32, 12)),
    transport,
    now: () => 10_000,
  });

  const result = await directory.browse(new AbortController().signal, 0);
  assert.deepEqual(result.rooms, [{ slug: "pi-dev", estimatedParticipants: 2 }]);
  assert.equal(transport.started, 1);
  assert.equal(transport.refreshed, 1);
  assert.equal(transport.stopped, 1);
});

test("temporary browsing aborts and stops every owned directory resource", async () => {
  const transport = new IdleDirectoryTransport();
  const directory = new PublicRoomDirectorySession({
    identity: createIdentity(Buffer.alloc(32, 8)),
    transport,
  });
  const controller = new AbortController();
  const browsing = directory.browse(controller.signal, 60_000);
  controller.abort(new DOMException("Menu disposed", "AbortError"));
  await assert.rejects(browsing, /Menu disposed/u);
  assert.equal(transport.started, 1);
  assert.equal(transport.stopped, 1);
});
