import assert from "node:assert/strict";
import { test } from "vitest";
import { ChatSession, type ChatTransport, type TransportPeer } from "../src/chat-session.js";
import { type ChatIdentity, createIdentity } from "../src/identity.js";
import {
  createChatEvent,
  createGossipMessage,
  createHello,
  createPresenceEvent,
  createPrivateRoom,
  type GossipMessage,
  type ProtocolMessage,
  type RoomDescriptor,
} from "../src/protocol.js";

class FakePeer implements TransportPeer {
  readonly sent: ProtocolMessage[] = [];
  closed = false;
  constructor(readonly publicKey: Buffer) {}
  send(message: ProtocolMessage): void {
    if (!this.closed) this.sent.push(message);
  }
  close(): void {
    this.closed = true;
  }
}

class FakeTransport implements ChatTransport {
  private listener:
    | {
        onPeer(peer: TransportPeer): void;
        onMessage(peer: TransportPeer, message: ProtocolMessage): void;
        onDisconnect(peer: TransportPeer): void;
        onError(error: Error): void;
      }
    | undefined;
  started = false;
  stopped = false;
  start(listener: NonNullable<FakeTransport["listener"]>): Promise<void> {
    this.listener = listener;
    this.started = true;
    return Promise.resolve();
  }
  stop(): Promise<void> {
    this.stopped = true;
    return Promise.resolve();
  }
  connect(peer: FakePeer): void {
    this.listener?.onPeer(peer);
  }
  receive(peer: FakePeer, message: ProtocolMessage): void {
    this.listener?.onMessage(peer, message);
  }
  disconnect(peer: FakePeer): void {
    this.listener?.onDisconnect(peer);
  }
}

function fixture() {
  let now = 100_000;
  const room = createPrivateRoom(Buffer.alloc(32, 9));
  const identity = createIdentity(Buffer.alloc(32, 1));
  const transport = new FakeTransport();
  const session = new ChatSession({
    room,
    identity,
    nickname: "Mika",
    transport,
    now: () => now,
  });
  return {
    room,
    identity,
    transport,
    session,
    setNow(value: number) {
      now = value;
    },
  };
}

function authenticate(
  room: RoomDescriptor,
  local: ChatIdentity,
  transport: FakeTransport,
  seed: number,
  nickname = `Peer${seed}`,
): { identity: ChatIdentity; peer: FakePeer } {
  const seedBytes = Buffer.alloc(32);
  seedBytes.writeUInt32BE(seed);
  const identity = createIdentity(seedBytes);
  const peer = new FakePeer(identity.publicKey);
  transport.connect(peer);
  transport.receive(peer, createHello(room, nickname, identity.publicKey, local.publicKey, Buffer.alloc(16, seed)));
  return { identity, peer };
}

function sentChat(peer: FakePeer, id: string): GossipMessage | undefined {
  const message = peer.sent.find(
    (candidate) => candidate.type === "gossip" && candidate.event.kind === "chat" && candidate.event.id === id,
  );
  return message?.type === "gossip" ? message : undefined;
}

test("authenticates direct neighbors before exposing their active presence", async () => {
  const { room, identity, transport, session } = fixture();
  await session.start();
  const remote = createIdentity(Buffer.alloc(32, 2));
  const peer = new FakePeer(remote.publicKey);
  transport.connect(peer);
  assert.equal(peer.sent[0]?.type, "hello");
  assert.equal(session.snapshot().participants.length, 0);
  transport.receive(peer, createHello(room, "Other", remote.publicKey, identity.publicKey, Buffer.alloc(16, 4)));
  assert.equal(session.snapshot().participants[0]?.label.startsWith("Other~"), true);
  assert.equal(session.snapshot().directNeighbors, 1);
});

test("relays a signed event once across duplicate paths and never sends it back to ingress", async () => {
  const { room, identity, transport, session } = fixture();
  await session.start();
  const first = authenticate(room, identity, transport, 2);
  const second = authenticate(room, identity, transport, 3);
  const origin = createIdentity(Buffer.alloc(32, 4));
  const event = createChatEvent(room, origin, "Origin", "hello gossip", 100_000, "same");

  transport.receive(first.peer, createGossipMessage(event, 4));
  transport.receive(second.peer, createGossipMessage(event, 4));
  assert.equal(session.snapshot().transcript.filter((entry) => entry.text === "hello gossip").length, 1);
  assert.equal(sentChat(first.peer, "same"), undefined);
  assert.equal(sentChat(second.peer, "same")?.type, "gossip");
  if (sentChat(second.peer, "same")?.type === "gossip") {
    assert.equal(sentChat(second.peer, "same")?.hops, 3);
  }
});

test("records local events before relay so loopback cannot duplicate the transcript", async () => {
  const { room, identity, transport, session } = fixture();
  await session.start();
  const neighbor = authenticate(room, identity, transport, 2);
  const result = session.send("local gossip");
  assert.equal(result.relayedTo, 1);
  const relayed = neighbor.peer.sent.find((message) => message.type === "gossip" && message.event.kind === "chat");
  assert.equal(relayed?.type, "gossip");
  if (relayed?.type === "gossip") transport.receive(neighbor.peer, relayed);
  assert.equal(session.snapshot().transcript.filter((entry) => entry.text === "local gossip").length, 1);
  assert.equal(session.snapshot().transcript.at(-1)?.delivery, "relayed");
});

test("accepts an exhausted-hop event locally without forwarding it", async () => {
  const { room, identity, transport, session } = fixture();
  await session.start();
  const first = authenticate(room, identity, transport, 2);
  const second = authenticate(room, identity, transport, 3);
  const origin = createIdentity(Buffer.alloc(32, 4));
  const event = createChatEvent(room, origin, "Origin", "last hop", 100_000, "last-hop");
  transport.receive(first.peer, createGossipMessage(event, 1));
  assert.equal(session.snapshot().transcript.at(-1)?.text, "last hop");
  assert.equal(sentChat(second.peer, "last-hop"), undefined);
});

test("rejects invalid, stale, and over-rate events before state or forwarding", async () => {
  const { room, identity, transport, session, setNow } = fixture();
  await session.start();
  const first = authenticate(room, identity, transport, 2);
  const second = authenticate(room, identity, transport, 3);
  const origin = createIdentity(Buffer.alloc(32, 4));
  const valid = createChatEvent(room, origin, "Origin", "valid", 100_000, "valid");
  transport.receive(first.peer, createGossipMessage({ ...valid, text: "tampered" }, 4));
  setNow(1_000_000);
  transport.receive(first.peer, createGossipMessage(valid, 4));
  assert.equal(session.snapshot().transcript.length, 0);
  assert.equal(sentChat(second.peer, "valid"), undefined);
});

test("bounds accepted events per signed origin before transcript and forwarding", async () => {
  const { room, identity, transport, session } = fixture();
  await session.start();
  const first = authenticate(room, identity, transport, 2);
  const second = authenticate(room, identity, transport, 3);
  const origin = createIdentity(Buffer.alloc(32, 4));
  for (let index = 0; index < 7; index += 1) {
    const event = createChatEvent(room, origin, "Origin", `message ${index}`, 100_000, `origin-${index}`);
    transport.receive(first.peer, createGossipMessage(event));
  }
  assert.equal(session.snapshot().transcript.length, 6);
  assert.equal(sentChat(second.peer, "origin-5")?.type, "gossip");
  assert.equal(sentChat(second.peer, "origin-6"), undefined);
});

test("ignores stale presence updates after a newer departure", async () => {
  const { room, identity, transport, session } = fixture();
  await session.start();
  const remote = authenticate(room, identity, transport, 2, "Current");
  const leaving = createPresenceEvent(room, remote.identity, "Current", "leaving", 100_000, "z");
  const delayedByTime = createPresenceEvent(room, remote.identity, "Old Name", "online", 99_999, "delayed-time");
  const delayedById = createPresenceEvent(room, remote.identity, "Other Old Name", "online", 100_000, "a");

  transport.receive(remote.peer, createGossipMessage(leaving));
  transport.receive(remote.peer, createGossipMessage(delayedByTime));
  transport.receive(remote.peer, createGossipMessage(delayedById));

  assert.equal(session.snapshot().participants.length, 0);
});

test("keeps the newest nickname when presence heartbeats arrive out of order", async () => {
  const { room, identity, transport, session } = fixture();
  await session.start();
  const remote = authenticate(room, identity, transport, 2, "Initial");
  const current = createPresenceEvent(room, remote.identity, "Current", "online", 100_000, "z");
  const delayedByTime = createPresenceEvent(room, remote.identity, "Old By Time", "online", 99_999, "delayed-time");
  const delayedById = createPresenceEvent(room, remote.identity, "Old By Id", "online", 100_000, "a");

  transport.receive(remote.peer, createGossipMessage(current));
  transport.receive(remote.peer, createGossipMessage(delayedByTime));
  transport.receive(remote.peer, createGossipMessage(delayedById));

  assert.equal(session.snapshot().participants[0]?.nickname, "Current");
});

test("does not restore presence when delayed chat predates a departure", async () => {
  const { room, identity, transport, session } = fixture();
  await session.start();
  const remote = authenticate(room, identity, transport, 2, "Current");
  const leaving = createPresenceEvent(room, remote.identity, "Current", "leaving", 100_000, "left");
  const delayedChat = createChatEvent(room, remote.identity, "Old Name", "sent before leaving", 99_999, "delayed-chat");

  transport.receive(remote.peer, createGossipMessage(leaving));
  transport.receive(remote.peer, createGossipMessage(delayedChat));

  assert.equal(session.snapshot().participants.length, 0);
  assert.equal(session.snapshot().transcript.at(-1)?.text, "sent before leaving");
});

test("mutes display by signed origin while continuing to forward its events", async () => {
  const { room, identity, transport, session } = fixture();
  await session.start();
  const first = authenticate(room, identity, transport, 2);
  const second = authenticate(room, identity, transport, 3);
  const origin = createIdentity(Buffer.alloc(32, 4));
  const presence = createPresenceEvent(room, origin, "Origin", "online", 100_000, "presence");
  transport.receive(first.peer, createGossipMessage(presence));
  assert.equal(session.toggleMute(origin.publicKey), true);
  const chat = createChatEvent(room, origin, "Origin", "muted", 100_000, "muted");
  transport.receive(first.peer, createGossipMessage(chat));
  assert.equal(
    session.snapshot().transcript.some((entry) => entry.text === "muted"),
    false,
  );
  assert.equal(sentChat(second.peer, "muted")?.type, "gossip");
});

test("expires stale presence and bounds the active participant catalog at 256", async () => {
  const { room, identity, transport, session, setNow } = fixture();
  await session.start();
  for (let index = 2; index < 262; index += 1) {
    authenticate(room, identity, transport, index);
  }
  assert.equal(session.snapshot().participants.length, 256);
  assert.equal(session.snapshot().participantCatalogFull, true);
  setNow(300_001);
  assert.equal(session.snapshot().participants.length, 0);
});

test("publishes composer focus and clears unread when the view opens", async () => {
  const { session } = fixture();
  await session.start();
  assert.equal(session.snapshot().composerOpen, false);
  session.setViewOpen(true);
  assert.equal(session.snapshot().composerOpen, true);
  session.setViewOpen(false);
  assert.equal(session.snapshot().composerOpen, false);
});

test("leave is idempotent and ignores late transport continuations", async () => {
  const { transport, session } = fixture();
  await session.start();
  const peer = new FakePeer(createIdentity(Buffer.alloc(32, 2)).publicKey);
  transport.connect(peer);
  await Promise.all([session.leave(), session.leave()]);
  transport.connect(new FakePeer(Buffer.alloc(32, 8)));
  assert.equal(transport.stopped, true);
  assert.equal(session.snapshot().state, "disconnected");
  assert.equal(session.snapshot().participants.length, 0);
});
