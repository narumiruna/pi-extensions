import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { join } from "node:path";
import { test } from "vitest";
import {
  createGroup,
  createSignedEndpointManifest,
  DEFAULT_MESSAGE_TTL_MS,
  FLEET_PROTOCOL_VERSION,
  type FleetGroup,
  type FleetMessage,
} from "../src/protocol.js";
import { createEndpointPaths, MAX_MANIFEST_BYTES, publishManifest } from "../src/runtime-directory.js";
import { FleetTransport } from "../src/transport.js";

const posixTest = process.platform === "win32" ? test.skip : test;

async function fixture(run: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp("/tmp/pi-fleet-transport-test-");
  try {
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function fleetMessage(
  id: string,
  fromSessionId: string,
  toSessionId: string,
  mode: FleetMessage["mode"] = "notify",
): FleetMessage {
  const issuedAt = Date.now();
  return {
    id,
    fromSessionId,
    toSessionId,
    mode,
    text: `${mode} from ${fromSessionId}`,
    issuedAt,
    expiresAt: issuedAt + DEFAULT_MESSAGE_TTL_MS,
  };
}

function createTransport(
  group: FleetGroup,
  baseDirectory: string,
  sessionId: string,
  onMessage: (message: FleetMessage, signal: AbortSignal) => Promise<void> | void = async () => undefined,
  options: {
    endpointId?: string;
    acceptsRequests?: boolean;
    launchId?: string;
    kickoffCapability?: string;
    requestTimeoutMs?: number;
    discoveryDeadlineMs?: number;
    discoveryProbeTimeoutMs?: number;
  } = {},
): FleetTransport {
  return new FleetTransport({
    group,
    peer: {
      protocolVersion: FLEET_PROTOCOL_VERSION,
      sessionId,
      name: sessionId,
      cwd: `/tmp/${sessionId}`,
      pid: process.pid,
      ...(options.launchId ? { launchId: options.launchId } : {}),
      acceptsRequests: options.acceptsRequests ?? false,
    },
    baseDirectory,
    ...(options.endpointId ? { endpointId: options.endpointId } : {}),
    ...(options.requestTimeoutMs !== undefined ? { requestTimeoutMs: options.requestTimeoutMs } : {}),
    ...(options.discoveryDeadlineMs !== undefined ? { discoveryDeadlineMs: options.discoveryDeadlineMs } : {}),
    ...(options.discoveryProbeTimeoutMs !== undefined
      ? { discoveryProbeTimeoutMs: options.discoveryProbeTimeoutMs }
      : {}),
    ...(options.kickoffCapability ? { kickoffCapability: options.kickoffCapability } : {}),
    onMessage,
  });
}

posixTest("two transports discover endpoint identities, authenticate, deduplicate, and clean up", async () => {
  await fixture(async (baseDirectory) => {
    const group = createGroup(Buffer.alloc(32, 8));
    const received: FleetMessage[] = [];
    const first = createTransport(
      group,
      baseDirectory,
      "first",
      async (message) => {
        received.push(message);
      },
      { endpointId: "1".repeat(24), acceptsRequests: true },
    );
    const second = createTransport(
      group,
      baseDirectory,
      "second",
      async (message) => {
        received.push(message);
      },
      { endpointId: "2".repeat(24) },
    );
    await first.start();
    await second.start();
    const peers = await first.listPeers();
    assert.deepEqual(
      peers.map((peer) => ({ sessionId: peer.sessionId, endpointId: peer.endpointId })),
      [{ sessionId: "second", endpointId: "2".repeat(24) }],
    );
    const outbound = fleetMessage("msg_notify_123456", "first", "second");
    assert.deepEqual(await first.send("second", outbound), {
      accepted: true,
      duplicate: false,
    });
    assert.deepEqual(await first.send("second", outbound), {
      accepted: true,
      duplicate: true,
    });
    assert.equal(received.length, 1);
    assert.deepEqual(await first.send("second", fleetMessage("msg_request_12345", "first", "second", "request")), {
      accepted: false,
      duplicate: false,
      code: "requests_disabled",
      error: "Target session does not allow agent requests",
    });
    assert.equal(received.length, 1);
    const manifest = first.endpointManifest;
    assert.ok(manifest);
    assert.equal((await stat(manifest.manifestPath)).mode & 0o777, 0o600);
    assert.equal((await stat(manifest.socketPath)).mode & 0o777, 0o600);
    await Promise.all([first.stop(), second.stop(), first.stop()]);
    await assert.rejects(readFile(manifest.manifestPath, "utf8"));
    assert.equal((await stat(manifest.directory)).isDirectory(), true);
  });
});

posixTest("launch kickoff is accepted once only for the matching launch id", async () => {
  await fixture(async (baseDirectory) => {
    const group = createGroup(Buffer.alloc(32, 9));
    const received: FleetMessage[] = [];
    const parent = createTransport(group, baseDirectory, "parent");
    const inviteHolder = createTransport(group, baseDirectory, "invite-holder");
    const kickoffCapability = "kickoff_capability_1234567890";
    const child = createTransport(
      group,
      baseDirectory,
      "child",
      async (value) => {
        received.push(value);
      },
      { launchId: "launch_1234567890", kickoffCapability },
    );
    await Promise.all([parent.start(), inviteHolder.start(), child.start()]);
    assert.equal(
      (await inviteHolder.listPeers()).find((peer) => peer.sessionId === "child")?.launchId,
      "launch_1234567890",
    );
    const wrong = {
      ...fleetMessage("msg_kickoff_wrong1", "parent", "child", "kickoff"),
      launchId: "launch_wrong1234",
    };
    assert.equal((await parent.send("child", wrong, undefined, { kickoffCapability })).code, "launch_mismatch");
    const kickoff = {
      ...fleetMessage("msg_kickoff_right1", "parent", "child", "kickoff"),
      launchId: "launch_1234567890",
    };
    const unauthorizedKickoff = {
      ...kickoff,
      id: "msg_kickoff_unauthorized",
      fromSessionId: "invite-holder",
    };
    assert.equal((await inviteHolder.send("child", unauthorizedKickoff)).code, "launch_mismatch");
    assert.equal((await parent.send("child", kickoff, undefined, { kickoffCapability })).accepted, true);
    assert.equal(
      (
        await parent.send("child", { ...kickoff, id: "msg_kickoff_right2" }, undefined, {
          kickoffCapability,
        })
      ).code,
      "kickoff_consumed",
    );
    assert.equal(received.length, 1);
    await Promise.all([parent.stop(), inviteHolder.stop(), child.stop()]);
  });
});

posixTest("failed delivery can be retried without becoming a false duplicate", async () => {
  await fixture(async (baseDirectory) => {
    const group = createGroup(Buffer.alloc(32, 12));
    let deliveryAttempts = 0;
    const sender = createTransport(group, baseDirectory, "retry-sender");
    const receiver = createTransport(group, baseDirectory, "retry-receiver", async () => {
      deliveryAttempts += 1;
      if (deliveryAttempts === 1) return Promise.reject();
    });
    await Promise.all([sender.start(), receiver.start()]);
    const message = fleetMessage("msg_retry_12345678", "retry-sender", "retry-receiver");
    assert.deepEqual(await sender.send("retry-receiver", message), {
      accepted: false,
      duplicate: false,
      code: "delivery_failed",
      error: "Target session rejected the message",
    });
    assert.deepEqual(await sender.send("retry-receiver", message), {
      accepted: true,
      duplicate: false,
    });
    assert.equal(deliveryAttempts, 2);
    await Promise.all([sender.stop(), receiver.stop()]);
  });
});

posixTest("only one concurrent launch kickoff can enter the child session", async () => {
  await fixture(async (baseDirectory) => {
    const group = createGroup(Buffer.alloc(32, 13));
    let releaseDelivery!: () => void;
    let signalDeliveryStarted!: () => void;
    let deliveries = 0;
    const deliveryStarted = new Promise<void>((resolve) => {
      signalDeliveryStarted = resolve;
    });
    const deliveryReleased = new Promise<void>((resolve) => {
      releaseDelivery = resolve;
    });
    const parent = createTransport(group, baseDirectory, "concurrent-parent");
    const child = createTransport(
      group,
      baseDirectory,
      "concurrent-child",
      async () => {
        deliveries += 1;
        if (deliveries === 1) {
          signalDeliveryStarted();
          await deliveryReleased;
        }
      },
      {
        launchId: "launch_concurrent1",
        kickoffCapability: "kickoff_concurrent_capability",
      },
    );
    await Promise.all([parent.start(), child.start()]);
    const first = parent.send(
      "concurrent-child",
      {
        ...fleetMessage("msg_concurrent_first", "concurrent-parent", "concurrent-child", "kickoff"),
        launchId: "launch_concurrent1",
      },
      undefined,
      { kickoffCapability: "kickoff_concurrent_capability" },
    );
    await deliveryStarted;
    const second = await parent.send(
      "concurrent-child",
      {
        ...fleetMessage("msg_concurrent_second", "concurrent-parent", "concurrent-child", "kickoff"),
        launchId: "launch_concurrent1",
      },
      undefined,
      { kickoffCapability: "kickoff_concurrent_capability" },
    );
    releaseDelivery();
    const firstAck = await first;
    await Promise.all([parent.stop(), child.stop()]);
    assert.equal(second.code, "kickoff_consumed");
    assert.equal(firstAck.accepted, true);
    assert.equal(deliveries, 1);
  });
});

posixTest("discovery ignores manifests and sockets with non-private permissions", async () => {
  await fixture(async (baseDirectory) => {
    const group = createGroup(Buffer.alloc(32, 14));
    const first = createTransport(group, baseDirectory, "private-first");
    const second = createTransport(group, baseDirectory, "private-second");
    await Promise.all([first.start(), second.start()]);
    const endpoint = second.endpointManifest;
    assert.ok(endpoint);
    await chmod(endpoint.manifestPath, 0o644);
    assert.deepEqual(await first.listPeers(), []);
    await chmod(endpoint.manifestPath, 0o600);
    await chmod(endpoint.socketPath, 0o666);
    assert.deepEqual(await first.listPeers(), []);
    await Promise.all([first.stop(), second.stop()]);
  });
});

posixTest("a stale authenticated manifest is removed only after a failed probe", async () => {
  await fixture(async (baseDirectory) => {
    const group = createGroup(Buffer.alloc(32, 10));
    const transport = createTransport(group, baseDirectory, "live");
    await transport.start();
    const endpoint = transport.endpointManifest;
    assert.ok(endpoint);
    const stalePaths = createEndpointPaths(endpoint.directory, "a".repeat(24));
    await publishManifest(
      stalePaths.manifestPath,
      createSignedEndpointManifest(
        {
          groupId: group.id,
          endpointId: stalePaths.endpointId,
          sessionId: "stale",
          socketName: `${stalePaths.endpointId}.sock`,
          pid: 999999,
          publishedAt: Date.now(),
        },
        group.secret,
      ),
    );
    assert.deepEqual(await transport.listPeers(), []);
    await assert.rejects(readFile(stalePaths.manifestPath, "utf8"));
    await transport.stop();
  });
});

posixTest("discovery probes concurrently and obeys one overall deadline", async () => {
  await fixture(async (baseDirectory) => {
    const group = createGroup(Buffer.alloc(32, 15));
    const source = createTransport(group, baseDirectory, "source", undefined, {
      endpointId: "f".repeat(24),
      discoveryDeadlineMs: 150,
      discoveryProbeTimeoutMs: 1_000,
    });
    const healthy = createTransport(group, baseDirectory, "healthy", undefined, {
      endpointId: "0".repeat(24),
    });
    await Promise.all([source.start(), healthy.start()]);
    const directory = source.endpointManifest?.directory;
    assert.ok(directory);
    const blackholes: Server[] = [];
    for (let index = 1; index <= 16; index += 1) {
      blackholes.push(
        await createBlackhole(directory, group, index.toString(16).padStart(24, "0"), `blackhole-${index}`),
      );
    }
    const startedAt = Date.now();
    const result = await source.discover();
    const elapsed = Date.now() - startedAt;
    assert.equal(elapsed < 500, true, `discovery took ${elapsed}ms`);
    assert.deepEqual(
      result.peers.map((peer) => peer.sessionId),
      ["healthy"],
    );
    assert.equal(
      result.issues.some((issue) => issue.code === "deadline_exceeded"),
      true,
    );
    await Promise.allSettled(blackholes.map((server) => closeServer(server)));
    await Promise.all([source.stop(), healthy.stop()]);
  });
});

posixTest("invalid manifests do not consume the valid-peer quota", async () => {
  await fixture(async (baseDirectory) => {
    const group = createGroup(Buffer.alloc(32, 16));
    const source = createTransport(group, baseDirectory, "quota-source");
    const target = createTransport(group, baseDirectory, "quota-target");
    await Promise.all([source.start(), target.start()]);
    const directory = source.endpointManifest?.directory;
    assert.ok(directory);
    for (let index = 1; index <= 64; index += 1) {
      const endpointId = index.toString(16).padStart(24, "0");
      await writeFile(join(directory, `${endpointId}.json`), "not-json", { mode: 0o600 });
    }
    await writeFile(join(directory, `${"a".repeat(24)}.json`), Buffer.alloc(MAX_MANIFEST_BYTES + 1, 0x61), {
      mode: 0o600,
    });
    const result = await source.discover();
    assert.deepEqual(
      result.peers.map((peer) => peer.sessionId),
      ["quota-target"],
    );
    assert.equal(
      result.issues.some((issue) => issue.code === "invalid_manifest"),
      true,
    );
    await Promise.all([source.stop(), target.stop()]);
  });
});

posixTest("an endpoint-id collision cannot remove the existing live endpoint", async () => {
  await fixture(async (baseDirectory) => {
    const group = createGroup(Buffer.alloc(32, 21));
    const endpointId = "d".repeat(24);
    const owner = createTransport(group, baseDirectory, "endpoint-owner", undefined, {
      endpointId,
    });
    const collision = createTransport(group, baseDirectory, "endpoint-collision", undefined, {
      endpointId,
    });
    const observer = createTransport(group, baseDirectory, "endpoint-observer");
    await owner.start();
    await assert.rejects(collision.start(), /already in use/u);
    await collision.stop();
    await observer.start();
    assert.deepEqual(
      (await observer.listPeers()).map((peer) => peer.sessionId),
      ["endpoint-owner"],
    );
    await Promise.all([owner.stop(), observer.stop()]);
  });
});

posixTest("a second live endpoint claiming the local session is reported as a conflict", async () => {
  await fixture(async (baseDirectory) => {
    const group = createGroup(Buffer.alloc(32, 22));
    const source = createTransport(group, baseDirectory, "local-session", undefined, {
      endpointId: "1".repeat(24),
    });
    const rival = createTransport(group, baseDirectory, "local-session", undefined, {
      endpointId: "2".repeat(24),
    });
    await Promise.all([source.start(), rival.start()]);
    const discovery = await source.discover();
    assert.deepEqual(discovery.peers, []);
    assert.equal(
      discovery.issues.some((issue) => issue.code === "identity_conflict" && issue.sessionId === "local-session"),
      true,
    );
    await Promise.all([source.stop(), rival.stop()]);
  });
});

posixTest("duplicate live session identities are omitted and cannot be targeted ambiguously", async () => {
  await fixture(async (baseDirectory) => {
    const group = createGroup(Buffer.alloc(32, 17));
    const source = createTransport(group, baseDirectory, "conflict-source");
    const first = createTransport(group, baseDirectory, "same-session", undefined, {
      endpointId: "1".repeat(24),
    });
    const second = createTransport(group, baseDirectory, "same-session", undefined, {
      endpointId: "2".repeat(24),
    });
    await Promise.all([source.start(), first.start(), second.start()]);
    const discovery = await source.discover();
    assert.deepEqual(discovery.peers, []);
    assert.equal(
      discovery.issues.some((issue) => issue.code === "identity_conflict" && issue.sessionId === "same-session"),
      true,
    );
    await assert.rejects(
      source.send("same-session", fleetMessage("msg_conflict_12345", "conflict-source", "same-session")),
      /conflicting live endpoints/u,
    );
    await Promise.all([source.stop(), first.stop(), second.stop()]);
  });
});

posixTest("absolute connection deadlines stop slow pre-authentication clients", async () => {
  await fixture(async (baseDirectory) => {
    const group = createGroup(Buffer.alloc(32, 18));
    const target = createTransport(group, baseDirectory, "slow-target", undefined, {
      requestTimeoutMs: 80,
    });
    await target.start();
    const socketPath = target.endpointManifest?.socketPath;
    assert.ok(socketPath);
    const client = await connect(socketPath);
    const interval = setInterval(() => client.write("{"), 10);
    const startedAt = Date.now();
    await new Promise<void>((resolve) => client.once("close", () => resolve()));
    clearInterval(interval);
    assert.equal(Date.now() - startedAt < 400, true);
    await target.stop();
  });
});

posixTest("an asynchronous delivery is cancelled and cannot hold shutdown indefinitely", async () => {
  await fixture(async (baseDirectory) => {
    const group = createGroup(Buffer.alloc(32, 19));
    let deliveryStarted!: () => void;
    let deliveryAborted!: () => void;
    const started = new Promise<void>((resolve) => {
      deliveryStarted = resolve;
    });
    const aborted = new Promise<void>((resolve) => {
      deliveryAborted = resolve;
    });
    const sender = createTransport(group, baseDirectory, "bounded-sender", undefined, {
      requestTimeoutMs: 100,
    });
    const receiver = createTransport(
      group,
      baseDirectory,
      "bounded-receiver",
      async (_message, signal) => {
        deliveryStarted();
        await new Promise<void>((_resolve, reject) => {
          signal.addEventListener(
            "abort",
            () => {
              deliveryAborted();
              reject(new Error("aborted"));
            },
            { once: true },
          );
        });
      },
      { requestTimeoutMs: 100 },
    );
    await Promise.all([sender.start(), receiver.start()]);
    const send = sender.send(
      "bounded-receiver",
      fleetMessage("msg_bounded_123456", "bounded-sender", "bounded-receiver"),
    );
    await started;
    await assert.rejects(send, /timed out|closed/u);
    await aborted;
    const startedStopping = Date.now();
    await receiver.stop();
    assert.equal(Date.now() - startedStopping < 400, true);
    await sender.stop();
  });
});

posixTest("global and per-sender limits return structured retry information", async () => {
  await fixture(async (baseDirectory) => {
    const group = createGroup(Buffer.alloc(32, 20));
    const receiver = createTransport(group, baseDirectory, "rate-receiver");
    const senders = Array.from({ length: 5 }, (_, index) =>
      createTransport(group, baseDirectory, `rate-sender-${index}`),
    );
    await Promise.all([receiver.start(), ...senders.map((sender) => sender.start())]);
    const sendAccepted = async (senderIndex: number, index: number) => {
      const sender = senders[senderIndex];
      assert.ok(sender);
      const ack = await sender.send(
        "rate-receiver",
        fleetMessage(`msg_rate_${index.toString().padStart(6, "0")}`, `rate-sender-${senderIndex}`, "rate-receiver"),
      );
      assert.equal(ack.accepted, true);
    };
    for (let index = 0; index < 60; index += 1) await sendAccepted(0, index);
    const senderLimited = await senders[0]?.send(
      "rate-receiver",
      fleetMessage("msg_rate_sender_limited", "rate-sender-0", "rate-receiver"),
    );
    assert.equal(senderLimited?.code, "rate_limited");
    assert.equal((senderLimited?.retryAfterMs ?? 0) > 0, true);
    for (let index = 60; index < 239; index += 1) {
      await sendAccepted(1 + Math.floor((index - 60) / 60), index);
    }
    const globallyLimited = await senders[4]?.send(
      "rate-receiver",
      fleetMessage("msg_rate_global_limited", "rate-sender-4", "rate-receiver"),
    );
    assert.equal(globallyLimited?.accepted, false);
    assert.equal(globallyLimited?.code, "rate_limited");
    assert.equal((globallyLimited?.retryAfterMs ?? 0) > 0, true);
    await Promise.all([receiver.stop(), ...senders.map((sender) => sender.stop())]);
  });
});

posixTest("aborted discovery and sends stop promptly", async () => {
  await fixture(async (baseDirectory) => {
    const group = createGroup(Buffer.alloc(32, 11));
    assert.throws(
      () =>
        createTransport(group, baseDirectory, "invalid-timeout", undefined, {
          requestTimeoutMs: 0,
        }),
      /request timeout is invalid/u,
    );
    const transport = createTransport(group, baseDirectory, "only");
    await transport.start();
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(transport.listPeers(controller.signal), /aborted/u);
    await assert.rejects(
      transport.send("missing", fleetMessage("msg_missing_123456", "only", "missing"), controller.signal),
      /aborted/u,
    );
    await transport.stop();
  });
});

async function createBlackhole(
  directory: string,
  group: FleetGroup,
  endpointId: string,
  sessionId: string,
): Promise<Server> {
  const paths = createEndpointPaths(directory, endpointId);
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  await listenServer(server, paths.socketPath);
  await chmod(paths.socketPath, 0o600);
  await publishManifest(
    paths.manifestPath,
    createSignedEndpointManifest(
      {
        groupId: group.id,
        endpointId,
        sessionId,
        socketName: `${endpointId}.sock`,
        pid: process.pid,
        publishedAt: Date.now(),
      },
      group.secret,
    ),
  );
  (server as Server & { fleetTestSockets?: Set<Socket> }).fleetTestSockets = sockets;
  return server;
}

function listenServer(server: Server, path: string): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(path, () => {
      server.off("error", reject);
      resolve();
    });
  });
}

function closeServer(server: Server): Promise<void> {
  for (const socket of (server as Server & { fleetTestSockets?: Set<Socket> }).fleetTestSockets ?? []) {
    socket.destroy();
  }
  return new Promise((resolve) => {
    try {
      server.close(() => resolve());
    } catch {
      resolve();
    }
  });
}

function connect(path: string): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(path);
    socket.once("error", reject);
    socket.once("connect", () => {
      socket.off("error", reject);
      socket.on("error", () => undefined);
      resolve(socket);
    });
  });
}
