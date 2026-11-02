import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { Server, Socket } from "node:net";
import { test, vi } from "vitest";
import { createGroup, DEFAULT_MESSAGE_TTL_MS, FLEET_PROTOCOL_VERSION, type FleetMessage } from "../src/protocol.js";
import { FleetTransport } from "../src/transport.js";

const posixTest = process.platform === "win32" ? test.skip : test;

posixTest("unrefs only listening servers while active request sockets retain delivery and cleanup", async () => {
  const baseDirectory = await mkdtemp("/tmp/pi-fleet-passive-test-");
  const listening: boolean[] = [];
  const servers: Server[] = [];
  const accepted = new Set<Socket>();
  const originalUnref = Server.prototype.unref;
  const serverUnref = vi.spyOn(Server.prototype, "unref").mockImplementation(function (this: Server) {
    listening.push(this.listening);
    servers.push(this);
    this.on("connection", (socket) => accepted.add(socket));
    return originalUnref.call(this);
  });
  const socketUnref = vi.spyOn(Socket.prototype, "unref");
  const group = createGroup(Buffer.alloc(32, 24));
  let delivered!: () => void;
  let release!: () => void;
  const started = new Promise<void>((resolve) => {
    delivered = resolve;
  });
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  const received: FleetMessage[] = [];
  const createTransport = (sessionId: string, onMessage: (message: FleetMessage) => Promise<void> | void) =>
    new FleetTransport({
      group,
      baseDirectory,
      peer: {
        protocolVersion: FLEET_PROTOCOL_VERSION,
        sessionId,
        name: sessionId,
        cwd: "/tmp",
        pid: process.pid,
        acceptsRequests: false,
      },
      onMessage,
    });
  const sender = createTransport("passive-sender", () => {});
  const receiver = createTransport("passive-receiver", async (message) => {
    received.push(message);
    delivered();
    await released;
  });
  try {
    await sender.start();
    await receiver.start();
    assert.deepEqual(listening, [true, true]);
    assert.equal(serverUnref.mock.calls.length, 2);
    const senderPaths = sender.endpointManifest;
    const receiverPaths = receiver.endpointManifest;
    assert.ok(senderPaths);
    assert.ok(receiverPaths);
    const issuedAt = Date.now();
    const message: FleetMessage = {
      id: "msg_passive_delivery",
      fromSessionId: "passive-sender",
      toSessionId: "passive-receiver",
      mode: "notify",
      text: "Delivery remains active",
      issuedAt,
      expiresAt: issuedAt + DEFAULT_MESSAGE_TTL_MS,
    };
    const delivery = sender.send("passive-receiver", message);
    await started;
    assert.equal(socketUnref.mock.calls.length, 0);
    assert.equal(accepted.size, 1);
    assert.equal(
      [...accepted].every((socket) => !socket.destroyed),
      true,
    );
    release();
    assert.deepEqual(await delivery, { accepted: true, duplicate: false });
    assert.deepEqual(received, [message]);
    assert.equal(socketUnref.mock.calls.length, 0);
    await Promise.all([sender.stop(), receiver.stop()]);
    await Promise.all([sender.stop(), receiver.stop()]);
    assert.equal(
      servers.every((server) => !server.listening),
      true,
    );
    assert.equal(
      [...accepted].every((socket) => socket.destroyed),
      true,
    );
    for (const paths of [senderPaths, receiverPaths]) {
      await assert.rejects(readFile(paths.manifestPath), { code: "ENOENT" });
      await assert.rejects(readFile(paths.socketPath), { code: "ENOENT" });
    }
    assert.equal(serverUnref.mock.calls.length, 2);
  } finally {
    release();
    await Promise.all([sender.stop(), receiver.stop()]);
    vi.restoreAllMocks();
    await rm(baseDirectory, { recursive: true, force: true });
  }
});

posixTest("does not unref the server when listening fails and preserves repeated cleanup", async () => {
  const baseDirectory = await mkdtemp("/tmp/pi-fleet-passive-failure-");
  const unref = vi.spyOn(Server.prototype, "unref");
  vi.spyOn(Server.prototype, "listen").mockImplementation(function (this: Server) {
    this.emit("error", new Error("listen failed"));
    return this;
  });
  const transport = new FleetTransport({
    group: createGroup(Buffer.alloc(32, 25)),
    baseDirectory,
    peer: {
      protocolVersion: FLEET_PROTOCOL_VERSION,
      sessionId: "failed-listener",
      name: "failed-listener",
      cwd: "/tmp",
      pid: process.pid,
      acceptsRequests: false,
    },
    onMessage: () => {},
  });
  try {
    await assert.rejects(transport.start(), /listen failed/u);
    assert.equal(unref.mock.calls.length, 0);
    assert.equal(transport.endpointManifest, undefined);
    await transport.stop();
    await transport.stop();
    assert.equal(unref.mock.calls.length, 0);
  } finally {
    await transport.stop();
    vi.restoreAllMocks();
    await rm(baseDirectory, { recursive: true, force: true });
  }
});
