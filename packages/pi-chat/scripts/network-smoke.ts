import assert from "node:assert/strict";
import { type ChildProcess, fork } from "node:child_process";
import { fileURLToPath } from "node:url";
import createTestnet from "hyperdht/testnet.js";
import { ChatSession } from "../src/chat-session.js";
import { HyperswarmDirectoryTransport, PublicRoomDirectorySession } from "../src/directory-network.js";
import { createIdentity, deriveScopedIdentity } from "../src/identity.js";
import { HyperswarmTransport } from "../src/network.js";
import { createPrivateRoom, createPublicRoom, MAX_GOSSIP_HOPS } from "../src/protocol.js";

await smoke("three local DHT peers discover, authenticate, exchange, and fully stop", async () => {
  const testnet = await createTestnet(3);
  const room = createPrivateRoom(Buffer.alloc(32, 42));
  const sessions = Array.from({ length: 3 }, (_, index) => {
    const identity = createIdentity(Buffer.alloc(32, index + 1));
    const transport = new HyperswarmTransport({
      room,
      identity,
      dht: testnet.createNode({ firewalled: false }),
      maxPeers: 8,
    });
    return {
      transport,
      session: new ChatSession({
        room,
        identity,
        nickname: `Dev${index + 1}`,
        transport,
      }),
    };
  });
  try {
    await Promise.all(sessions.map(({ session }) => session.start()));
    await waitFor(
      () => sessions.every(({ session }) => session.snapshot().participants.length === 2),
      () =>
        sessions
          .map(({ session, transport }) => {
            const snapshot = session.snapshot();
            return `${snapshot.state}:${snapshot.participants.length}:${transport.connectionCount}:${snapshot.lastError ?? "ok"}`;
          })
          .join(","),
    );
    const sender = sessions[0];
    assert.ok(sender);
    assert.equal(sender.session.send("hello gossip").relayedTo, 2);
    await waitFor(() =>
      sessions
        .slice(1)
        .every(({ session }) => session.snapshot().transcript.some((entry) => entry.text === "hello gossip")),
    );
  } finally {
    await Promise.allSettled(sessions.map(({ session }) => session.leave()));
    await testnet.destroy();
  }
  assert.equal(
    sessions.every(({ transport }) => transport.connectionCount === 0),
    true,
  );
});

await smoke("ten-peer sparse overlay relays once through a non-origin intermediate", async () => {
  const testnet = await createTestnet(4);
  const room = createPublicRoom("sparse-gossip");
  const sessions = Array.from({ length: 10 }, (_, index) => {
    const identity = createIdentity(Buffer.alloc(32, index + 31));
    const transport = new HyperswarmTransport({
      room,
      identity,
      dht: testnet.createNode({ firewalled: false }),
      maxPeers: 64,
    });
    return {
      identity,
      transport,
      session: new ChatSession({
        room,
        identity,
        nickname: `Sparse${index + 1}`,
        transport,
      }),
    };
  });
  try {
    await Promise.all(sessions.map(({ session }) => session.start()));
    const sender = sessions[0];
    assert.ok(sender);
    const senderKey = sender.identity.publicKey.toString("hex");
    const sessionsByKey = new Map(sessions.map((entry) => [entry.identity.publicKey.toString("hex"), entry]));
    const findAuthenticatedRelayTarget = () => {
      if (
        !sessions.every(
          ({ session, transport }) => session.snapshot().directNeighbors === transport.connectedPeerKeys.length,
        )
      ) {
        return undefined;
      }
      const distances = new Map([[senderKey, 0]]);
      const pending = [senderKey];
      for (const key of pending) {
        const distance = distances.get(key);
        const current = sessionsByKey.get(key);
        if (distance === undefined || distance >= MAX_GOSSIP_HOPS || !current) continue;
        for (const neighbor of current.transport.connectedPeerKeys) {
          if (!sessionsByKey.has(neighbor) || distances.has(neighbor)) continue;
          distances.set(neighbor, distance + 1);
          pending.push(neighbor);
        }
      }
      if (distances.size !== sessions.length) return undefined;
      return sessions.slice(1).find(({ identity }) => {
        const distance = distances.get(identity.publicKey.toString("hex"));
        return distance !== undefined && distance >= 2;
      });
    };
    const relayPath = { target: undefined as ReturnType<typeof findAuthenticatedRelayTarget> };
    await waitFor(
      () => {
        relayPath.target = findAuthenticatedRelayTarget();
        return relayPath.target !== undefined;
      },
      () =>
        sessions
          .map(({ session, transport }) => {
            const snapshot = session.snapshot();
            return `${snapshot.participants.length}/${snapshot.directNeighbors}/${transport.connectionCount}`;
          })
          .join(","),
      20_000,
    );
    assert.equal(
      sessions.every(({ transport }) => transport.connectionCount <= 8),
      true,
    );
    const indirect = relayPath.target;
    assert.ok(indirect, "the sender must have an authenticated target across a two-hop path");
    sender.session.send("through sparse overlay");
    const deliveryCounts = () =>
      sessions.map(
        ({ session }) => session.snapshot().transcript.filter(({ text }) => text === "through sparse overlay").length,
      );
    await waitFor(
      () => deliveryCounts().every((count) => count === 1),
      () => deliveryCounts().join(","),
      8_000,
    );
    await new Promise((resolve) => setTimeout(resolve, 500));
    assert.deepEqual(
      deliveryCounts(),
      Array.from({ length: sessions.length }, () => 1),
    );
  } finally {
    await Promise.allSettled(sessions.map(({ session }) => session.leave()));
    await testnet.destroy();
  }
});

await smoke("early discovery retries recover after initial DHT lookups miss peers", async () => {
  const testnet = await createTestnet(3);
  const room = createPublicRoom("retry-room");
  const sessions = Array.from({ length: 2 }, (_, index) => {
    const identity = createIdentity(Buffer.alloc(32, index + 11));
    const dht = suppressPeerResults(testnet.createNode({ firewalled: false }), 3);
    const transport = new HyperswarmTransport({ room, identity, dht, maxPeers: 8 });
    return new ChatSession({
      room,
      identity,
      nickname: `Retry${index + 1}`,
      transport,
    });
  });
  try {
    await Promise.all(sessions.map((session) => session.start()));
    await waitFor(
      () => sessions.every((session) => session.snapshot().participants.length === 1),
      () => sessions.map((session) => session.snapshot().participants.length).join(","),
      8_000,
    );
  } finally {
    await Promise.allSettled(sessions.map((session) => session.leave()));
    await testnet.destroy();
  }
});

await smoke("a completed startup releases its caller signal without leaving the room", async () => {
  const testnet = await createTestnet(3);
  const room = createPublicRoom("released-startup-signal");
  const controller = new AbortController();
  const sessions = Array.from({ length: 2 }, (_, index) => {
    const identity = createIdentity(Buffer.alloc(32, index + 21));
    const transport = new HyperswarmTransport({
      room,
      identity,
      dht: testnet.createNode({ firewalled: false }),
      maxPeers: 8,
    });
    return new ChatSession({
      room,
      identity,
      nickname: `Owner${index + 1}`,
      transport,
    });
  });
  try {
    await sessions[0]?.start(controller.signal);
    controller.abort(new DOMException("Menu closed", "AbortError"));
    await sessions[1]?.start();
    await waitFor(
      () => sessions.every((session) => session.snapshot().participants.length === 1),
      () => sessions.map((session) => session.snapshot().participants.length).join(","),
      5_000,
    );
  } finally {
    await Promise.allSettled(sessions.map((session) => session.leave()));
    await testnet.destroy();
  }
});

await smoke("two separate Node processes connect through a local DHT bootstrap", async () => {
  const testnet = await createTestnet(3);
  const secret = Buffer.alloc(32, 77);
  const bootstrapArg = Buffer.from(JSON.stringify(testnet.bootstrap)).toString("base64url");
  const fixturePath = fileURLToPath(new URL("./network-peer-fixture.js", import.meta.url));
  const children: ChildProcess[] = [];
  const messages = new Map<ChildProcess, Record<string, unknown>[]>();
  const errors = new Map<ChildProcess, string>();
  const startChild = (index: number): ChildProcess => {
    const child = fork(fixturePath, [bootstrapArg, String(index + 1), secret.toString("base64url")], {
      execArgv: [],
      stdio: ["ignore", "ignore", "pipe", "ipc"],
    });
    children.push(child);
    messages.set(child, []);
    child.on("message", (message: unknown) => {
      if (message && typeof message === "object") {
        messages.get(child)?.push(message as Record<string, unknown>);
      }
    });
    child.stderr?.on("data", (chunk) => {
      errors.set(child, `${errors.get(child) ?? ""}${String(chunk)}`);
    });
    return child;
  };
  try {
    for (let index = 0; index < 2; index += 1) {
      const child = startChild(index);
      await waitFor(
        () => messages.get(child)?.some((message) => message.kind === "ready") === true,
        () => childDetails(children, messages, errors),
        20_000,
      );
    }
    await waitFor(
      () =>
        children.every((child) =>
          messages.get(child)?.some((message) => message.kind === "snapshot" && message.peers === 1),
        ),
      () => childDetails(children, messages, errors),
      27_000,
    );
    children[0]?.send({ command: "send", text: "cross-process hello" });
    await waitFor(
      () =>
        children
          .slice(1)
          .every((child) =>
            messages
              .get(child)
              ?.some((message) => Array.isArray(message.texts) && message.texts.includes("cross-process hello")),
          ),
      () => childDetails(children, messages, errors),
      10_000,
    );
  } finally {
    for (const child of children) {
      if (child.connected) child.send({ command: "stop" });
    }
    await Promise.all(children.map((child) => waitForExit(child)));
    await testnet.destroy();
  }
});

await smoke("local DHT directory discovers two scoped advertisers and fully stops", async () => {
  const testnet = await createTestnet(4);
  const scoped = (seed: number, slug: string) =>
    deriveScopedIdentity(createIdentity(Buffer.alloc(32, seed)), `directory:#${slug}`);
  const makeDirectory = (seed: number, slug?: string) => {
    const identity = slug ? scoped(seed, slug) : createIdentity(Buffer.alloc(32, seed));
    return new PublicRoomDirectorySession({
      identity,
      ...(slug ? { advertisedSlug: slug } : {}),
      transport: new HyperswarmDirectoryTransport({
        identity,
        dht: testnet.createNode({ firewalled: false }),
      }),
    });
  };
  const first = makeDirectory(10, "pi-dev");
  const second = makeDirectory(11, "pi-dev");
  const browser = makeDirectory(12);
  try {
    await Promise.all([first.start(), second.start()]);
    const result = await browser.browse(new AbortController().signal, 1_500);
    assert.deepEqual(result.rooms, [{ slug: "pi-dev", estimatedParticipants: 2 }]);
  } finally {
    await Promise.allSettled([first.stop(), second.stop(), browser.stop()]);
    await testnet.destroy();
  }
});

interface AnnounceResult {
  peers: unknown[];
  [key: string]: unknown;
}

interface AnnounceQuery extends AsyncIterable<AnnounceResult> {
  readonly closestNodes: unknown;
  destroy(): void;
}

interface DhtWithAnnounce {
  announce(...args: unknown[]): AnnounceQuery;
}

function suppressPeerResults(value: unknown, callsToSuppress: number): unknown {
  const dht = value as DhtWithAnnounce;
  const announce = dht.announce.bind(dht);
  let calls = 0;
  dht.announce = (...args: unknown[]): AnnounceQuery => {
    const query = announce(...args);
    calls += 1;
    if (calls > callsToSuppress) return query;
    return {
      get closestNodes() {
        return query.closestNodes;
      },
      destroy: () => query.destroy(),
      async *[Symbol.asyncIterator]() {
        for await (const result of query) yield { ...result, peers: [] };
      },
    };
  };
  return dht;
}

async function smoke(name: string, run: () => Promise<void>): Promise<void> {
  const startedAt = Date.now();
  process.stdout.write(`• ${name}\n`);
  await run();
  process.stdout.write(`  passed (${Date.now() - startedAt} ms)\n`);
}

async function waitFor(predicate: () => boolean, detail: () => string = () => "", timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for local DHT mesh (${detail()})`);
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function childDetails(
  children: readonly ChildProcess[],
  messages: ReadonlyMap<ChildProcess, Record<string, unknown>[]>,
  errors: ReadonlyMap<ChildProcess, string>,
): string {
  return children
    .map((child) => {
      const latest = messages.get(child)?.at(-1);
      return `${child.exitCode ?? "running"}:${JSON.stringify(latest)}:${errors.get(child) ?? ""}`;
    })
    .join(" | ");
}

async function waitForExit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return;
  let timeout: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      new Promise<void>((resolve) => child.once("exit", () => resolve())),
      new Promise<void>((resolve) => {
        timeout = setTimeout(() => {
          child.kill("SIGKILL");
          resolve();
        }, 5_000);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}
