import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "vitest";
import { MAX_HERDR_FRAME_BYTES, openHerdrSubscription, requestHerdr } from "../src/herdr-client.js";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.allSettled(cleanups.splice(0).map((cleanup) => cleanup()));
});

async function listen(handle: (socket: net.Socket, request: Record<string, unknown>) => void): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "pi-herdr-client-"));
  const socketPath = join(directory, "api.sock");
  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    let input = "";
    socket.on("data", (chunk) => {
      input += chunk.toString();
      const newline = input.indexOf("\n");
      if (newline < 0) return;
      const request = JSON.parse(input.slice(0, newline)) as Record<string, unknown>;
      input = input.slice(newline + 1);
      handle(socket, request);
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });
  cleanups.push(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(directory, { force: true, recursive: true });
  });
  return socketPath;
}

function request(id = "request-1") {
  return { id, method: "pane.list", params: { workspace_id: "w1" } };
}

test("correlates fragmented request responses and ignores unrelated frames", async () => {
  const socketPath = await listen((socket, received) => {
    assert.equal(received.id, "request-1");
    socket.write(`${JSON.stringify({ id: "other", result: { type: "other" } })}\n`);
    const response = `${JSON.stringify({ id: "request-1", result: { type: "pane_list", panes: [] } })}\n`;
    socket.write(response.slice(0, 9));
    socket.write(response.slice(9));
  });
  const result = await requestHerdr(socketPath, request(), new AbortController().signal, 100);
  assert.deepEqual(result, { type: "pane_list", panes: [] });
});

test("rejects error, malformed, oversized, and result-less responses", async () => {
  const cases: Array<{ payload: string | Buffer; message: RegExp }> = [
    {
      payload: `${JSON.stringify({ id: "request-1", error: { message: "request failed" } })}\n`,
      message: /request failed/u,
    },
    {
      payload: `${JSON.stringify({ id: "", error: { message: "invalid request" } })}\n`,
      message: /invalid request/u,
    },
    { payload: "{nope}\n", message: /invalid JSON/u },
    {
      payload: Buffer.concat([Buffer.alloc(MAX_HERDR_FRAME_BYTES + 1, 0x61), Buffer.from("\n")]),
      message: /size limit/u,
    },
    { payload: `${JSON.stringify({ id: "request-1" })}\n`, message: /include a result/u },
  ];
  for (const entry of cases) {
    const socketPath = await listen((socket) => socket.write(entry.payload));
    await assert.rejects(requestHerdr(socketPath, request(), new AbortController().signal, 100), entry.message);
  }
});

test("bounds request timeout, abort, and early socket close", async () => {
  const timeoutPath = await listen(() => {});
  await assert.rejects(requestHerdr(timeoutPath, request(), new AbortController().signal, 20), /timed out/u);

  const abortController = new AbortController();
  const abortPath = await listen(() => abortController.abort(new DOMException("stop", "AbortError")));
  await assert.rejects(requestHerdr(abortPath, request(), abortController.signal, 100), /stop/u);

  const closePath = await listen((socket) => socket.end());
  await assert.rejects(requestHerdr(closePath, request(), new AbortController().signal, 100), /closed the request/u);
});

test("starts a subscription and delivers coalesced event frames", async () => {
  const event = {
    event: "pane.agent_status_changed",
    data: { pane_id: "w1:p2", workspace_id: "w1", agent_status: "working" },
  };
  const socketPath = await listen((socket, received) => {
    const response = `${JSON.stringify({ id: received.id, result: { type: "subscription_started" } })}\n${JSON.stringify(event)}\n`;
    socket.write(response.slice(0, 17));
    socket.write(response.slice(17));
  });
  const controller = new AbortController();
  const events: unknown[] = [];
  const subscription = await openHerdrSubscription(
    socketPath,
    { id: "subscribe-1", method: "events.subscribe", params: { subscriptions: [] } },
    controller.signal,
    (frame) => events.push(frame),
    100,
  );
  assert.deepEqual(events, [event]);
  controller.abort();
  await subscription.closed;
});

test("rejects invalid subscription acknowledgement and malformed event frames", async () => {
  const invalidAckPath = await listen((socket, received) => {
    socket.write(`${JSON.stringify({ id: received.id, result: { type: "wrong" } })}\n`);
  });
  await assert.rejects(
    openHerdrSubscription(
      invalidAckPath,
      { id: "subscribe-1", method: "events.subscribe", params: { subscriptions: [] } },
      new AbortController().signal,
      () => {},
      100,
    ),
    /invalid subscription acknowledgement/u,
  );

  const malformedPath = await listen((socket, received) => {
    socket.write(`${JSON.stringify({ id: received.id, result: { type: "subscription_started" } })}\n`);
    setTimeout(() => socket.write("{bad}\n"), 10);
  });
  const subscription = await openHerdrSubscription(
    malformedPath,
    { id: "subscribe-2", method: "events.subscribe", params: { subscriptions: [] } },
    new AbortController().signal,
    () => {},
    100,
  );
  await assert.rejects(subscription.closed, /invalid JSON/u);
});
