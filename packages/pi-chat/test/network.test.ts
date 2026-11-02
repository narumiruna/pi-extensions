import assert from "node:assert/strict";
import { setImmediate as nextTurn } from "node:timers/promises";
import { afterEach, beforeEach, test, vi } from "vitest";
import { ChatSession } from "../src/chat-session.js";
import { createIdentity } from "../src/identity.js";
import { directNeighborLimit, HyperswarmTransport, MAX_DIRECT_NEIGHBORS } from "../src/network.js";
import { createPublicRoom } from "../src/protocol.js";

const fakeNetwork = vi.hoisted(() => {
  class FakeDiscovery {
    flushedCalls = 0;
    refreshCalls = 0;
    destroyCalls = 0;

    async flushed(): Promise<void> {
      this.flushedCalls += 1;
    }

    async refresh(): Promise<void> {
      this.refreshCalls += 1;
    }

    async destroy(): Promise<void> {
      this.destroyCalls += 1;
    }
  }

  class FakeHyperswarm {
    static instances: FakeHyperswarm[] = [];
    readonly discovery = new FakeDiscovery();
    readonly options: Record<string, unknown>;
    readonly joins: Array<{ topic: Buffer; options: Record<string, unknown> }> = [];
    destroyCalls = 0;

    constructor(options: Record<string, unknown>) {
      this.options = options;
      FakeHyperswarm.instances.push(this);
    }

    on(): this {
      return this;
    }

    join(topic: Buffer, options: Record<string, unknown>): FakeDiscovery {
      this.joins.push({ topic: Buffer.from(topic), options });
      return this.discovery;
    }

    async destroy(): Promise<void> {
      this.destroyCalls += 1;
    }
  }

  return { FakeHyperswarm };
});

vi.mock("hyperswarm", () => ({ default: fakeNetwork.FakeHyperswarm }));

beforeEach(() => {
  fakeNetwork.FakeHyperswarm.instances.length = 0;
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

test("room overlays clamp every requested direct-neighbor limit to eight", () => {
  assert.equal(MAX_DIRECT_NEIGHBORS, 8);
  assert.equal(directNeighborLimit(), 8);
  assert.equal(directNeighborLimit(4), 4);
  assert.equal(directNeighborLimit(64), 8);
  assert.equal(directNeighborLimit(-1), 8);
});

test("transport startup joins through a mocked swarm and fully stops owned resources", async () => {
  const identity = createIdentity(Buffer.alloc(32, 1));
  const room = createPublicRoom("mocked-network");
  const dht = { kind: "mock-dht" };
  const transport = new HyperswarmTransport({ room, identity, dht, maxPeers: 64 });

  await transport.start({
    onPeer: () => undefined,
    onMessage: () => undefined,
    onDisconnect: () => undefined,
    onError: () => undefined,
  });

  const swarm = fakeNetwork.FakeHyperswarm.instances[0];
  assert.ok(swarm);
  assert.equal(swarm.options.dht, dht);
  assert.equal(swarm.options.maxPeers, 8);
  assert.equal(swarm.discovery.flushedCalls, 1);
  assert.deepEqual(swarm.joins, [
    {
      topic: room.topic,
      options: { server: true, client: true, limit: 8 },
    },
  ]);

  await transport.stop();
  await transport.stop();
  assert.equal(swarm.discovery.destroyCalls, 1);
  assert.equal(swarm.destroyCalls, 1);
});

test("mocked early discovery refreshes follow the bounded retry schedule", async () => {
  vi.useFakeTimers();
  const identity = createIdentity(Buffer.alloc(32, 2));
  const transport = new HyperswarmTransport({
    room: createPublicRoom("mocked-refresh"),
    identity,
    maxPeers: 8,
  });

  await transport.start({
    onPeer: () => undefined,
    onMessage: () => undefined,
    onDisconnect: () => undefined,
    onError: () => undefined,
  });
  const swarm = fakeNetwork.FakeHyperswarm.instances[0];
  assert.ok(swarm);

  for (const [index, delay] of [250, 750, 1_500, 3_000, 6_000, 12_000].entries()) {
    await vi.advanceTimersByTimeAsync(delay);
    assert.equal(swarm.discovery.refreshCalls, index + 1);
  }
  await vi.advanceTimersByTimeAsync(30_000);
  assert.equal(swarm.discovery.refreshCalls, 6);
  await transport.stop();
});

test("every recursive refresh uses an unreferenced native timer and stop clears the pending timer", async () => {
  const timers = vi.spyOn(globalThis, "setTimeout");
  const clear = vi.spyOn(globalThis, "clearTimeout");
  const transport = new HyperswarmTransport({
    room: createPublicRoom("native-refresh"),
    identity: createIdentity(Buffer.alloc(32, 4)),
  });
  try {
    await transport.start({
      onPeer: () => undefined,
      onMessage: () => undefined,
      onDisconnect: () => undefined,
      onError: () => undefined,
    });
    const swarm = fakeNetwork.FakeHyperswarm.instances[0];
    assert.ok(swarm);
    for (const [index, delay] of [250, 750, 1_500, 3_000, 6_000, 12_000].entries()) {
      assert.equal(timers.mock.calls.length, index + 1);
      assert.equal(timers.mock.calls[index]?.[1], delay);
      const timer = timers.mock.results[index]?.value as NodeJS.Timeout;
      assert.equal(timer.hasRef(), false);
      if (index === 5) {
        await transport.stop();
        assert.ok(clear.mock.calls.some(([value]) => value === timer));
      } else {
        // Dispatch the real timer callback without waiting through the retry delays.
        clearTimeout(timer);
        const callback = timers.mock.calls[index]?.[0];
        assert.ok(callback);
        callback();
        await nextTurn();
        assert.equal(swarm.discovery.refreshCalls, index + 1);
      }
    }
    await transport.stop();
    assert.equal(swarm.discovery.refreshCalls, 5);
    assert.equal(swarm.discovery.destroyCalls, 1);
    assert.equal(swarm.destroyCalls, 1);
  } finally {
    await transport.stop();
  }
});

test("stop prevents a pending refresh from recursively scheduling another timer", async () => {
  vi.useFakeTimers();
  const transport = new HyperswarmTransport({
    room: createPublicRoom("stopped-refresh"),
    identity: createIdentity(Buffer.alloc(32, 5)),
  });
  await transport.start({
    onPeer: () => undefined,
    onMessage: () => undefined,
    onDisconnect: () => undefined,
    onError: () => undefined,
  });
  const swarm = fakeNetwork.FakeHyperswarm.instances[0];
  assert.ok(swarm);
  let finish!: () => void;
  const refresh = vi.spyOn(swarm.discovery, "refresh").mockImplementation(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  await vi.advanceTimersByTimeAsync(250);
  assert.equal(vi.getTimerCount(), 0);
  await transport.stop();
  finish();
  await vi.advanceTimersByTimeAsync(30_000);
  assert.equal(vi.getTimerCount(), 0);
  assert.equal(refresh.mock.calls.length, 1);
  await transport.stop();
  assert.equal(swarm.discovery.destroyCalls, 1);
});

test("a completed mocked startup releases its caller signal without stopping the room", async () => {
  const controller = new AbortController();
  const identity = createIdentity(Buffer.alloc(32, 3));
  const transport = new HyperswarmTransport({
    room: createPublicRoom("mocked-signal"),
    identity,
    maxPeers: 8,
  });
  const session = new ChatSession({
    room: createPublicRoom("mocked-signal"),
    identity,
    nickname: "Owner",
    transport,
  });

  await session.start(controller.signal);
  controller.abort(new DOMException("Menu closed", "AbortError"));
  const swarm = fakeNetwork.FakeHyperswarm.instances[0];
  assert.ok(swarm);
  assert.equal(session.snapshot().state, "connected");
  assert.equal(swarm.destroyCalls, 0);

  await session.leave();
  assert.equal(swarm.destroyCalls, 1);
});
