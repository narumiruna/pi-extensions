import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test, vi } from "vitest";
import {
  createBestEffortSender,
  type HerdrRequest,
  MAX_HERDR_FRAME_BYTES,
  openHerdrSubscription,
  requestHerdr,
} from "../src/herdr-client.js";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.allSettled(cleanups.splice(0).map((cleanup) => cleanup()));
  vi.restoreAllMocks();
  vi.useRealTimers();
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

  let sendMalformed!: () => void;
  const malformedPath = await listen((socket, received) => {
    socket.write(`${JSON.stringify({ id: received.id, result: { type: "subscription_started" } })}\n`);
    sendMalformed = () => socket.write("{bad}\n");
  });
  const subscription = await openHerdrSubscription(
    malformedPath,
    { id: "subscribe-2", method: "events.subscribe", params: { subscriptions: [] } },
    new AbortController().signal,
    () => {},
    100,
  );
  sendMalformed();
  await assert.rejects(subscription.closed, /invalid JSON/u);
});

function mockConnections() {
  const sockets: net.Socket[] = [];
  vi.spyOn(net, "createConnection").mockImplementation(() => {
    const socket = new EventEmitter() as net.Socket;
    socket.write = vi.fn(() => true);
    socket.destroy = vi.fn(() => {
      socket.emit("close");
      return socket;
    });
    sockets.push(socket);
    return socket;
  });
  return sockets;
}

function frame(value: unknown): Buffer {
  return Buffer.from(`${JSON.stringify(value)}\n`);
}

const subscriptionRequest = { id: "subscribe-1", method: "events.subscribe", params: { subscriptions: [] } };
const subscriptionAck = { id: subscriptionRequest.id, result: { type: "subscription_started" } };
const event = { event: "pane.updated", data: { pane_id: "w1:p2", workspace_id: "w1" } };
const report: HerdrRequest = {
  id: "report-1",
  method: "pane.report_agent",
  params: { pane_id: "w1:p1", source: "herdr:pi", agent: "pi", state: "idle", seq: 42 },
};

function assertReleased(socket: net.Socket, signal: AbortSignal) {
  assert.equal(vi.mocked(socket.destroy).mock.calls.length, 1);
  assert.equal(vi.getTimerCount(), 0);
  assert.equal(vi.mocked(signal.removeEventListener).mock.calls.length, 1);
}

function trackedController() {
  const controller = new AbortController();
  vi.spyOn(controller.signal, "removeEventListener");
  return controller;
}

test("parses a response fragmented at every byte and waits for its newline", async () => {
  vi.useFakeTimers();
  const sockets = mockConnections();
  const controller = trackedController();
  const pending = requestHerdr("mock", request(), controller.signal);
  const socket = sockets[0];
  const response = frame({ id: request().id, result: { type: "pane_list", label: "名前" } });
  let settled = false;
  void pending.then(() => {
    settled = true;
  });
  socket.emit("connect");
  assert.equal(vi.mocked(socket.write).mock.calls[0][0], `${JSON.stringify(request())}\n`);
  for (const byte of response.subarray(0, -1)) socket.emit("data", Buffer.from([byte]));
  await Promise.resolve();
  assert.equal(settled, false);
  socket.emit("data", Buffer.from("\n"));
  assert.deepEqual(await pending, { type: "pane_list", label: "名前" });
  controller.abort();
  socket.emit("connect");
  socket.emit("data", Buffer.from("{bad}\n"));
  assert.equal(vi.mocked(socket.write).mock.calls.length, 1);
  assertReleased(socket, controller.signal);
});

test.each([
  ["matching", { id: "request-1", error: { code: "pane_not_found", message: "missing pane" } }, /missing pane/u],
  ["empty ID", { id: "", error: { code: "invalid_request", message: "bad request" } }, /bad request/u],
  ["no ID", { error: { code: "invalid_request", message: "bad request" } }, /bad request/u],
  ["malformed error", { id: "request-1", error: null, result: { type: "ok" } }, /invalid error/u],
  ["absent result", { id: "request-1" }, /include a result/u],
] as const)("rejects %s response without waiting for close", async (_name, response, message) => {
  vi.useFakeTimers();
  const sockets = mockConnections();
  const controller = trackedController();
  const pending = requestHerdr("mock", request(), controller.signal);
  const rejected = assert.rejects(pending, message);
  sockets[0].emit("data", frame(response));
  await rejected;
  assertReleased(sockets[0], controller.signal);
});

test.each(["no newline", "complete frame", "leftover after frame"] as const)(
  "rejects oversized %s and releases the request",
  async (kind) => {
    vi.useFakeTimers();
    const sockets = mockConnections();
    const controller = trackedController();
    const pending = requestHerdr("mock", request(), controller.signal);
    const rejected = assert.rejects(pending, /size limit/u);
    const payload = Buffer.alloc(MAX_HERDR_FRAME_BYTES + 1, 0x61);
    const chunks =
      kind === "leftover after frame"
        ? [Buffer.concat([frame({ id: "other", result: {} }), payload])]
        : kind === "complete frame"
          ? [Buffer.concat([payload, Buffer.from("\n")])]
          : [payload.subarray(0, MAX_HERDR_FRAME_BYTES), payload.subarray(MAX_HERDR_FRAME_BYTES)];
    for (const chunk of chunks) sockets[0].emit("data", chunk);
    await rejected;
    assertReleased(sockets[0], controller.signal);
  },
);

test("allows the maximum frame size and coalesced frames whose total exceeds the limit", async () => {
  vi.useFakeTimers();
  const sockets = mockConnections();
  const pending = requestHerdr("mock", request(), new AbortController().signal);
  const prefix = '{"id":"other","result":"';
  const suffix = '"}';
  const maximum = Buffer.from(
    `${prefix}${"a".repeat(MAX_HERDR_FRAME_BYTES - prefix.length - suffix.length)}${suffix}\n`,
  );
  sockets[0].emit("data", Buffer.concat([maximum, maximum, frame({ id: request().id, result: { type: "ok" } })]));
  assert.deepEqual(await pending, { type: "ok" });
  assert.equal(vi.getTimerCount(), 0);
});

test.each(["timeout", "abort", "end", "close", "error"] as const)(
  "cleans up exactly once after request %s and ignores late input",
  async (failure) => {
    vi.useFakeTimers();
    const sockets = mockConnections();
    const controller = trackedController();
    const pending = requestHerdr("mock", request(), controller.signal, 100);
    const rejected = assert.rejects(pending);
    const socket = sockets[0];
    if (failure === "timeout") await vi.advanceTimersByTimeAsync(100);
    else if (failure === "abort") controller.abort();
    else if (failure === "error") socket.emit("error", new Error("offline"));
    else socket.emit(failure);
    await rejected;
    socket.emit("connect");
    socket.emit("data", frame({ id: request().id, result: { type: "ok" } }));
    socket.emit("end");
    controller.abort();
    assert.equal(vi.mocked(socket.write).mock.calls.length, 0);
    assertReleased(socket, controller.signal);
  },
);

test("pre-aborted operations do not open sockets", async () => {
  const sockets = mockConnections();
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(requestHerdr("mock", request(), controller.signal), /aborted/u);
  await assert.rejects(
    openHerdrSubscription("mock", subscriptionRequest, controller.signal, () => {}),
    /aborted/u,
  );
  await createBestEffortSender("mock")(report, controller.signal);
  assert.equal(sockets.length, 0);
});

test("accepts only complete correlated ok results for reports", async () => {
  vi.useFakeTimers();
  const sockets = mockConnections();
  const controller = trackedController();
  const pending = createBestEffortSender("mock")(report, controller.signal);
  const socket = sockets[0];
  socket.emit("connect");
  socket.emit("data", frame({ id: "other", result: { type: "ok" } }));
  socket.emit("data", frame({ id: "other", error: { code: "invalid_request", message: "not this report" } }));
  const ack = frame({ id: report.id, result: { type: "ok" } });
  for (const byte of ack.subarray(0, -1)) socket.emit("data", Buffer.from([byte]));
  await Promise.resolve();
  assert.equal(vi.mocked(socket.destroy).mock.calls.length, 0);
  assert.equal(sockets.length, 1);
  socket.emit("data", Buffer.from("\n"));
  await pending;
  assertReleased(socket, controller.signal);
});

test.each([
  ["empty object", () => frame({})],
  ["wrong result", () => frame({ id: report.id, result: { type: "pong" } })],
  ["null result", () => frame({ id: report.id, result: null })],
  ["absent result", () => frame({ id: report.id })],
  ["malformed error", () => frame({ id: report.id, error: null })],
  ["invalid JSON", () => Buffer.from("{bad}\n")],
  ["oversized", () => Buffer.alloc(MAX_HERDR_FRAME_BYTES + 1, 0x61)],
  ["partial", () => Buffer.from('{"id":"report-1","result":')],
] as const)("retries report %s once with unchanged ID and sequence", async (_name, payload) => {
  vi.useFakeTimers();
  const sockets = mockConnections();
  const pending = createBestEffortSender("mock")(report, new AbortController().signal);
  sockets[0].emit("connect");
  sockets[0].emit("data", payload());
  // Closing also covers unrelated or incomplete frames that cannot acknowledge delivery.
  sockets[0].emit("end");
  await Promise.resolve();
  assert.equal(sockets.length, 2);
  sockets[1].emit("connect");
  sockets[1].emit("data", frame({ id: report.id, result: { type: "ok" } }));
  await pending;
  assert.equal(vi.mocked(sockets[0].write).mock.calls[0][0], `${JSON.stringify(report)}\n`);
  assert.equal(vi.mocked(sockets[1].write).mock.calls[0][0], `${JSON.stringify(report)}\n`);
  assert.equal(vi.getTimerCount(), 0);
});

test.each([report.id, "", undefined])("does not retry explicit API rejection with ID %s", async (id) => {
  vi.useFakeTimers();
  const sockets = mockConnections();
  const pending = createBestEffortSender("mock")(report, new AbortController().signal);
  sockets[0].emit("data", frame({ id, error: { code: "invalid_params", message: "invalid source" } }));
  await pending;
  assert.equal(sockets.length, 1);
  assert.equal(vi.getTimerCount(), 0);
});

test("bounds report retry deadlines to 500 and 1500 milliseconds", async () => {
  vi.useFakeTimers();
  const sockets = mockConnections();
  const controller = trackedController();
  const pending = createBestEffortSender("mock")(report, controller.signal);
  await vi.advanceTimersByTimeAsync(499);
  assert.equal(sockets.length, 1);
  assert.equal(vi.mocked(sockets[0].destroy).mock.calls.length, 0);
  await vi.advanceTimersByTimeAsync(1);
  assert.equal(sockets.length, 2);
  assert.equal(vi.mocked(sockets[0].destroy).mock.calls.length, 1);
  await vi.advanceTimersByTimeAsync(1499);
  assert.equal(vi.mocked(sockets[1].destroy).mock.calls.length, 0);
  await vi.advanceTimersByTimeAsync(1);
  await pending;
  assert.equal(vi.mocked(sockets[1].destroy).mock.calls.length, 1);
  assert.equal(vi.mocked(controller.signal.removeEventListener).mock.calls.length, 2);
  assert.equal(vi.getTimerCount(), 0);
});

test.each([1, 2])("aborts report attempt %s without further retry", async (attempt) => {
  vi.useFakeTimers();
  const sockets = mockConnections();
  const controller = new AbortController();
  const pending = createBestEffortSender("mock")(report, controller.signal);
  if (attempt === 2) {
    sockets[0].emit("error", new Error("offline"));
    await Promise.resolve();
  }
  assert.equal(sockets.length, attempt);
  controller.abort();
  await pending;
  assert.equal(sockets.length, attempt);
  assert.equal(vi.mocked(sockets[attempt - 1].destroy).mock.calls.length, 1);
  assert.equal(vi.getTimerCount(), 0);
});

test("stops report retry if aborted between attempts", async () => {
  vi.useFakeTimers();
  const sockets = mockConnections();
  const controller = new AbortController();
  const pending = createBestEffortSender("mock")(report, controller.signal);
  sockets[0].emit("end");
  controller.abort();
  await pending;
  assert.equal(sockets.length, 1);
  assert.equal(vi.getTimerCount(), 0);
});

test("reporting remains silent when connections fail synchronously or asynchronously", async () => {
  vi.useFakeTimers();
  const sockets = mockConnections();
  const pending = createBestEffortSender("mock")(report, new AbortController().signal);
  sockets[0].emit("error", new Error("offline"));
  await Promise.resolve();
  sockets[1].emit("error", new Error("still offline"));
  await pending;
  assert.equal(sockets.length, 2);
  assert.equal(vi.getTimerCount(), 0);
  vi.mocked(net.createConnection).mockImplementation(() => {
    throw new Error("invalid endpoint");
  });
  await createBestEffortSender("mock")(report, new AbortController().signal);
});

test("buffers pre-ack events, ignores unrelated IDs, and drains fragmented and coalesced events", async () => {
  vi.useFakeTimers();
  const sockets = mockConnections();
  const controller = trackedController();
  const events: unknown[] = [];
  const pending = openHerdrSubscription("mock", subscriptionRequest, controller.signal, (value) => events.push(value));
  const socket = sockets[0];
  socket.emit("data", frame({ id: "other", error: { code: "invalid_request", message: "unrelated" } }));
  socket.emit("data", frame(event));
  const ack = frame(subscriptionAck);
  for (const byte of ack.subarray(0, -1)) socket.emit("data", Buffer.from([byte]));
  assert.deepEqual(events, []);
  socket.emit("data", Buffer.concat([Buffer.from("\n"), frame(event), frame({ id: "other", result: {} })]));
  const subscription = await pending;
  assert.deepEqual(events, [event, event]);
  subscription.close();
  subscription.close();
  controller.abort();
  await subscription.closed;
  assertReleased(socket, controller.signal);
});

test.each(["before ready", "after ready", "coalesced with ack"] as const)(
  "fails closed immediately on events_lost %s without passing it to onEvent",
  async (when) => {
    vi.useFakeTimers();
    const sockets = mockConnections();
    const controller = trackedController();
    const events: unknown[] = [];
    const pending = openHerdrSubscription("mock", subscriptionRequest, controller.signal, (value) =>
      events.push(value),
    );
    const socket = sockets[0];
    const lost = frame({ id: subscriptionRequest.id, error: { code: "events_lost", message: "history lost" } });
    if (when === "before ready") {
      const rejected = assert.rejects(pending, { code: "events_lost" });
      socket.emit("data", Buffer.concat([lost, frame(event)]));
      await rejected;
    } else {
      if (when === "after ready") socket.emit("data", frame(subscriptionAck));
      else socket.emit("data", Buffer.concat([frame(subscriptionAck), lost, frame(event)]));
      const subscription = await pending;
      const rejected = assert.rejects(subscription.closed, { code: "events_lost" });
      if (when === "after ready") socket.emit("data", Buffer.concat([lost, frame(event)]));
      await rejected;
      subscription.close();
    }
    socket.emit("data", frame(event));
    assert.deepEqual(events, []);
    assertReleased(socket, controller.signal);
  },
);

test.each(["timeout", "abort", "close", "error", "bad ack", "too many events"] as const)(
  "cleans up a subscription that fails before ready: %s",
  async (failure) => {
    vi.useFakeTimers();
    const sockets = mockConnections();
    const controller = trackedController();
    const events: unknown[] = [];
    const pending = openHerdrSubscription(
      "mock",
      subscriptionRequest,
      controller.signal,
      (value) => events.push(value),
      100,
    );
    const rejected = assert.rejects(pending);
    const socket = sockets[0];
    if (failure === "timeout") await vi.advanceTimersByTimeAsync(100);
    else if (failure === "abort") controller.abort();
    else if (failure === "error") socket.emit("error", new Error("offline"));
    else if (failure === "close") socket.emit("end");
    else if (failure === "bad ack") socket.emit("data", frame({ id: subscriptionRequest.id, result: {} }));
    else socket.emit("data", Buffer.concat(Array.from({ length: 1025 }, () => frame(event))));
    await rejected;
    socket.emit("connect");
    socket.emit("data", Buffer.concat([frame(subscriptionAck), frame(event)]));
    assert.deepEqual(events, []);
    assertReleased(socket, controller.signal);
  },
);

test.each(["close", "abort", "disconnect", "malformed", "oversized", "callback throws"] as const)(
  "stops subscription delivery after %s and releases all resources",
  async (failure) => {
    vi.useFakeTimers();
    const sockets = mockConnections();
    const controller = trackedController();
    const events: unknown[] = [];
    const pending = openHerdrSubscription("mock", subscriptionRequest, controller.signal, (value) => {
      events.push(value);
      if (failure === "callback throws") throw new Error("callback failed");
    });
    const socket = sockets[0];
    socket.emit("data", frame(subscriptionAck));
    const subscription = await pending;
    if (failure === "close") subscription.close();
    else if (failure === "abort") controller.abort();
    else {
      const rejected = assert.rejects(subscription.closed);
      if (failure === "disconnect") socket.emit("end");
      else if (failure === "malformed") socket.emit("data", Buffer.from("{bad}\n"));
      else if (failure === "oversized") socket.emit("data", Buffer.alloc(MAX_HERDR_FRAME_BYTES + 1, 0x61));
      else socket.emit("data", Buffer.concat([frame(event), frame(event)]));
      await rejected;
    }
    if (failure === "close" || failure === "abort") await subscription.closed;
    socket.emit("data", frame(event));
    socket.emit("connect");
    subscription.close();
    subscription.close();
    assert.deepEqual(events, failure === "callback throws" ? [event] : []);
    assertReleased(socket, controller.signal);
  },
);

test("does not drain buffered events after onEvent aborts the subscription", async () => {
  vi.useFakeTimers();
  const sockets = mockConnections();
  const controller = trackedController();
  const events: unknown[] = [];
  const pending = openHerdrSubscription("mock", subscriptionRequest, controller.signal, (value) => {
    events.push(value);
    controller.abort();
  });
  const rejected = assert.rejects(pending, /aborted/u);
  sockets[0].emit("data", Buffer.concat([frame(event), frame(event), frame(subscriptionAck), frame(event)]));
  await rejected;
  assert.deepEqual(events, [event]);
  assertReleased(sockets[0], controller.signal);
});
