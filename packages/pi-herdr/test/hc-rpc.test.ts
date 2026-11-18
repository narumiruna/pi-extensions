import assert from "node:assert/strict";
import { getEventListeners, once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, test, vi } from "vitest";
import type { HcRequestOptions } from "../src/hc-rpc.mjs";

const script = pathToFileURL(resolve("packages/pi-herdr/src/hc-rpc.mjs")).href;
const { HC_MAX_FRAME_BYTES, requestHc, subscribeHc, withHcConnection } = (await import(
  script
)) as typeof import("../src/hc-rpc.mjs");
const cleanups: Array<() => Promise<void>> = [];

function spyOnConnections() {
  return vi.spyOn(net, "createConnection");
}

let connections: ReturnType<typeof spyOnConnections>;

beforeEach(() => {
  connections = spyOnConnections();
});

afterEach(async () => {
  try {
    await Promise.all(
      connections.mock.results.flatMap((result) => {
        if (result.type !== "return") return [];
        const socket = result.value;
        const closed = socket.closed
          ? Promise.resolve()
          : new Promise<void>((resolve) => socket.once("close", resolve));
        socket.destroy();
        return [closed];
      }),
    );
    await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
  } finally {
    vi.restoreAllMocks();
    vi.useRealTimers();
  }
});

type RpcRequest = { jsonrpc: string; id: number; method: string; params: Record<string, unknown> };
type Peer = { socket: net.Socket; request: RpcRequest; closed: Promise<void> };

async function listen(onRequest?: (peer: Peer) => void) {
  const directory = await mkdtemp(join(tmpdir(), "hc-rpc-"));
  const endpoint =
    process.platform === "win32"
      ? `\\\\.\\pipe\\hc-rpc-${directory.split(/[\\/]/u).at(-1)}`
      : join(directory, "rpc.sock");
  const sockets = new Set<net.Socket>();
  const received = Promise.withResolvers<Peer>();
  const requests: RpcRequest[] = [];
  const server = net.createServer((socket) => {
    sockets.add(socket);
    const closed = new Promise<void>((resolve) => {
      socket.once("close", () => {
        sockets.delete(socket);
        resolve();
      });
    });
    // Late acknowledgements can race deliberate client cancellation.
    socket.on("error", () => {});
    let pending = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      pending += chunk;
      let newline = pending.indexOf("\n");
      while (newline >= 0) {
        const line = pending.slice(0, newline);
        pending = pending.slice(newline + 1);
        try {
          const request = JSON.parse(line) as RpcRequest;
          requests.push(request);
          const peer = { socket, request, closed };
          received.resolve(peer);
          onRequest?.(peer);
        } catch (error) {
          received.reject(error);
        }
        newline = pending.indexOf("\n");
      }
    });
  });
  cleanups.push(async () => {
    const closed = [...sockets].map((socket) => new Promise<void>((resolve) => socket.once("close", resolve)));
    for (const socket of sockets) socket.destroy();
    await Promise.all(closed);
    if (server.listening) {
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
    await rm(directory, { recursive: true, force: true });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(endpoint, resolve);
  });
  return { endpoint, received: received.promise, requests };
}

function client() {
  const result = connections.mock.results.at(-1);
  assert.ok(result && result.type === "return");
  return result.value;
}

function wire(value: unknown) {
  return Buffer.from(`${JSON.stringify(value)}\n`);
}

function ack(result: unknown) {
  return { jsonrpc: "2.0", id: 1, result };
}

function assertReleased(socket: net.Socket, signal?: AbortSignal) {
  assert.equal(socket.destroyed, true);
  assert.equal(socket.listenerCount("data"), 0);
  if (signal) assert.equal(getEventListeners(signal, "abort").length, 0);
}

const options = { timeoutMs: 1000 };

test("sequential peer requests share one bounded socket and match distinct IDs", async () => {
  const fixture = await listen(({ socket, request }) => socket.write(wire({ ...ack(request.method), id: request.id })));
  const controller = new AbortController();
  await withHcConnection(
    fixture.endpoint,
    async (request) => {
      assert.equal(await request("hello"), "hello");
      assert.equal(await request("terminal.get"), "terminal.get");
    },
    { signal: controller.signal },
  );
  assert.equal(connections.mock.calls.length, 1);
  assert.deepEqual(
    fixture.requests.map(({ id }) => id),
    [1, 2],
  );
  assertReleased(client(), controller.signal);
});

test("a disconnect before approval cannot reopen the connection for a mutation", async () => {
  const fixture = await listen(({ socket, request }) => {
    socket.end(wire({ ...ack(request.method), id: request.id }));
  });
  await withHcConnection(fixture.endpoint, async (request, disconnected) => {
    assert.equal(await request("hello"), "hello");
    if (!disconnected.aborted) await once(disconnected, "abort");
    assert.throws(() => request("terminal.run"), /not available/u);
  });
  assert.equal(connections.mock.calls.length, 1);
  assert.deepEqual(
    fixture.requests.map(({ method }) => method),
    ["hello"],
  );
});

test("sends one JSON-RPC 2.0 request with id 1 and settles only the first acknowledgement", async () => {
  const fixture = await listen();
  const params = { task: "inspect 台灣", argv: ["--literal", "$(not-executed)"] };
  const controller = new AbortController();
  const pending = requestHc(fixture.endpoint, "state.get", params, { ...options, signal: controller.signal });
  const peer = await fixture.received;
  assert.deepEqual(peer.request, { jsonrpc: "2.0", id: 1, method: "state.get", params });
  const result = { panes: [{ id: "pane-1" }] };
  peer.socket.write(Buffer.concat([wire(ack(result)), Buffer.from("not-json\n")]));
  assert.deepEqual(await pending, result);
  await peer.closed;
  assert.deepEqual(fixture.requests, [peer.request]);
  assertReleased(client(), controller.signal);
});

test.each([null, false, 0, "", [], {}].map((result) => ({ result })))(
  "accepts a present result without requiring truthiness: $result",
  async ({ result }) => {
    const fixture = await listen();
    const pending = requestHc(fixture.endpoint, "state.get", undefined, options);
    const peer = await fixture.received;
    assert.deepEqual(peer.request.params, {});
    peer.socket.write(wire(ack(result)));
    assert.deepEqual(await pending, result);
  },
);

test("decodes UTF-8 split inside a code point and waits for the complete newline frame", async () => {
  const fixture = await listen();
  const pending = requestHc(fixture.endpoint, "state.get", {}, options);
  const peer = await fixture.received;
  const result = { title: "台灣 🐾" };
  const frame = wire(ack(result));
  const split = frame.indexOf(Buffer.from("台")) + 1;
  const firstRead = once(client(), "data");
  peer.socket.write(frame.subarray(0, split));
  await firstRead;
  const secondRead = once(client(), "data");
  peer.socket.write(frame.subarray(split, frame.length - 1));
  await secondRead;
  assert.equal(client().destroyed, false);
  peer.socket.write(frame.subarray(frame.length - 1));
  assert.deepEqual(await pending, result);
});

const invalidResponses: Array<{ name: string; payload: Buffer; message: RegExp }> = [
  { name: "invalid JSON", payload: Buffer.from("{broken}\n"), message: /Invalid hc JSON frame/u },
  { name: "empty frame", payload: Buffer.from(" \t\n"), message: /Empty hc frame/u },
  { name: "invalid UTF-8", payload: Buffer.from([0xff, 0x0a]), message: /utf-8|encoded data/iu },
  { name: "null envelope", payload: wire(null), message: /Invalid hc RPC response/u },
  { name: "array envelope", payload: wire([ack({})]), message: /Invalid hc RPC response/u },
  { name: "missing version", payload: wire({ id: 1, result: {} }), message: /Invalid hc RPC response/u },
  { name: "wrong version", payload: wire({ jsonrpc: "1.0", id: 1, result: {} }), message: /Invalid hc RPC response/u },
  { name: "missing id", payload: wire({ jsonrpc: "2.0", result: {} }), message: /Invalid hc RPC response/u },
  { name: "wrong id", payload: wire({ jsonrpc: "2.0", id: 2, result: {} }), message: /Invalid hc RPC response/u },
  { name: "string id", payload: wire({ jsonrpc: "2.0", id: "1", result: {} }), message: /Invalid hc RPC response/u },
  { name: "missing result", payload: wire({ jsonrpc: "2.0", id: 1 }), message: /Missing hc RPC result/u },
];

test.each(invalidResponses)("rejects $name and releases the request socket", async ({ payload, message }) => {
  const fixture = await listen();
  const controller = new AbortController();
  const rejected = assert.rejects(
    requestHc(fixture.endpoint, "state.get", {}, { ...options, signal: controller.signal }),
    message,
  );
  const peer = await fixture.received;
  peer.socket.write(payload);
  await rejected;
  await peer.closed;
  assertReleased(client(), controller.signal);
});

test.each([
  { kind: "permission_denied", suffix: " (permission_denied)" },
  { kind: "a".repeat(40), suffix: ` (${"a".repeat(40)})` },
  { kind: "a".repeat(41), suffix: "" },
  { kind: "TASK_SECRET --argv-secret", suffix: "" },
  { kind: "UPPERCASE", suffix: "" },
  { kind: "kind\nsecret", suffix: "" },
  { kind: 7, suffix: "" },
  { kind: null, suffix: "" },
])("redacts native task/argv errors and validates error kind: $kind", async ({ kind, suffix }) => {
  const fixture = await listen();
  const rejected = assert.rejects(requestHc(fixture.endpoint, "task.create", {}, options), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal(error.message, `hc RPC rejected${suffix}; inspect the terminal before retrying`);
    assert.doesNotMatch(error.message, /TASK_SECRET|argv-secret/u);
    return true;
  });
  const peer = await fixture.received;
  peer.socket.write(
    wire({
      jsonrpc: "2.0",
      id: 1,
      result: "must not mask an error",
      error: { message: "TASK_SECRET --argv-secret", data: { kind, task: "TASK_SECRET", argv: ["argv-secret"] } },
    }),
  );
  await rejected;
});

test.each([null, false, "TASK_SECRET --argv-secret", {}])(
  "rejects a present error even if malformed: %j",
  async (error) => {
    const fixture = await listen();
    const rejected = assert.rejects(
      requestHc(fixture.endpoint, "state.get", {}, options),
      /^Error: hc RPC rejected; inspect the terminal before retrying$/u,
    );
    const peer = await fixture.received;
    peer.socket.write(wire({ jsonrpc: "2.0", id: 1, error }));
    await rejected;
  },
);

test.each([true, false])("bounds incoming UTF-8 bytes with a terminating newline: %s", async (terminated) => {
  const fixture = await listen();
  const payload = wire(ack("é".repeat(80)));
  const maxBytes = 128;
  assert.ok(payload.toString("utf8").length < maxBytes);
  assert.ok(payload.length > maxBytes);
  const rejected = assert.rejects(
    requestHc(fixture.endpoint, "state.get", {}, { ...options, maxBytes }),
    /hc frame exceeded the limit/u,
  );
  const peer = await fixture.received;
  peer.socket.write(terminated ? payload : payload.subarray(0, payload.length - 1));
  await rejected;
  await peer.closed;
  assertReleased(client());
});

test("accepts an incoming frame at the exact byte limit, excluding its newline", async () => {
  assert.equal(HC_MAX_FRAME_BYTES, 2 * 1024 * 1024);
  const fixture = await listen();
  const result = "é".repeat(80);
  const payload = wire(ack(result));
  const pending = requestHc(fixture.endpoint, "state.get", {}, { ...options, maxBytes: payload.length - 1 });
  const peer = await fixture.received;
  peer.socket.write(payload);
  assert.equal(await pending, result);
});

test("counts the outgoing newline and UTF-8 bytes in the request limit", async () => {
  const fixture = await listen();
  const params = { task: "é".repeat(80) };
  const size = wire({ jsonrpc: "2.0", id: 1, method: "task.create", params }).length;
  await assert.rejects(
    requestHc(fixture.endpoint, "task.create", params, { ...options, maxBytes: size - 1 }),
    /hc request exceeded the limit/u,
  );
  assertReleased(client());
  const pending = requestHc(fixture.endpoint, "task.create", params, { ...options, maxBytes: size });
  const peer = await fixture.received;
  assert.deepEqual(peer.request.params, params);
  peer.socket.write(wire(ack(null)));
  assert.equal(await pending, null);
  await peer.closed;
  assert.equal(fixture.requests.length, 1);
});

const invalidLimits: HcRequestOptions[] = [
  { maxBytes: 0 },
  { maxBytes: -1 },
  { maxBytes: 1.5 },
  { maxBytes: Number.NaN },
  { maxBytes: Number.POSITIVE_INFINITY },
  { maxBytes: Number.MAX_SAFE_INTEGER + 1 },
  { timeoutMs: 0 },
  { timeoutMs: -1 },
  { timeoutMs: Number.NaN },
  { timeoutMs: Number.POSITIVE_INFINITY },
];

test.each(invalidLimits)("rejects invalid limits without creating a socket: %j", async (limits) => {
  await assert.rejects(requestHc("unused-local-socket", "state.get", {}, limits), /Invalid hc connection limits/u);
  await assert.rejects(subscribeHc("unused-local-socket", limits), /Invalid hc connection limits/u);
  assert.equal(connections.mock.calls.length, 0);
});

test.each(["", " \t\n"])("rejects a missing endpoint without creating a socket: %j", async (endpoint) => {
  await assert.rejects(requestHc(endpoint, "state.get"), /Missing inherited hc endpoint/u);
  await assert.rejects(subscribeHc(endpoint), /Missing inherited hc endpoint/u);
  assert.equal(connections.mock.calls.length, 0);
});

test("an already aborted signal creates neither a socket nor an abort listener", async () => {
  const controller = new AbortController();
  controller.abort(new Error("TASK_SECRET --argv-secret"));
  const requestOptions = { ...options, signal: controller.signal };
  await assert.rejects(requestHc("unused-local-socket", "state.get", {}, requestOptions), /hc operation cancelled/u);
  await assert.rejects(subscribeHc("unused-local-socket", requestOptions), /hc operation cancelled/u);
  assert.equal(connections.mock.calls.length, 0);
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
});

test("aborts a server-observed pending request and removes its handlers", async () => {
  const fixture = await listen();
  const controller = new AbortController();
  const rejected = assert.rejects(
    requestHc(fixture.endpoint, "task.create", {}, { ...options, signal: controller.signal }),
    /hc operation cancelled; remote changes may have occurred/u,
  );
  const peer = await fixture.received;
  assert.equal(getEventListeners(controller.signal, "abort").length, 1);
  controller.abort();
  controller.abort();
  await rejected;
  await peer.closed;
  assertReleased(client(), controller.signal);
});

test.each(["request", "subscription"] as const)(
  "bounds an unacknowledged %s after a request handshake",
  async (mode) => {
    const fixture = await listen();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const controller = new AbortController();
    const requestOptions = { timeoutMs: 25, signal: controller.signal };
    const pending =
      mode === "request"
        ? requestHc(fixture.endpoint, "state.get", {}, requestOptions)
        : subscribeHc(fixture.endpoint, requestOptions);
    const rejected = assert.rejects(pending, /hc connection timed out; outcome may be ambiguous/u);
    const peer = await fixture.received;
    await vi.advanceTimersByTimeAsync(24);
    assert.equal(client().destroyed, false);
    await vi.advanceTimersByTimeAsync(1);
    await rejected;
    await peer.closed;
    assertReleased(client(), controller.signal);
    assert.equal(vi.getTimerCount(), 0);
  },
);

test.each(["end", "destroy"] as const)("rejects request socket %s before acknowledgement", async (method) => {
  const fixture = await listen();
  const rejected = assert.rejects(requestHc(fixture.endpoint, "state.get", {}, options), /hc socket (ended|failed)/u);
  const peer = await fixture.received;
  peer.socket[method]();
  await rejected;
  await peer.closed;
  assertReleased(client());
});

test("rejects cyclic outgoing params, closes the socket, and sends no request", async () => {
  const fixture = await listen();
  const params: Record<string, unknown> = {};
  params.self = params;
  const controller = new AbortController();
  await assert.rejects(
    requestHc(fixture.endpoint, "task.create", params, { ...options, signal: controller.signal }),
    /Invalid hc request/u,
  );
  assert.deepEqual(fixture.requests, []);
  assertReleased(client(), controller.signal);
});

test("delivers acknowledgement, event, heartbeat, and missed notifications from one chunk", async () => {
  const fixture = await listen();
  const events: unknown[] = [];
  const controller = new AbortController();
  const pending = subscribeHc(fixture.endpoint, {
    ...options,
    signal: controller.signal,
    onEvent: (event) => events.push(event),
  });
  const peer = await fixture.received;
  assert.deepEqual(peer.request, { jsonrpc: "2.0", id: 1, method: "events.subscribe", params: {} });
  const snapshot = { sequence: 12, tasks: [] };
  const notifications = [
    { jsonrpc: "2.0", method: "event", params: { sequence: 13, title: "台灣" } },
    { jsonrpc: "2.0", method: "heartbeat", params: {} },
    { jsonrpc: "2.0", method: "missed", params: { from: 14, to: 16 } },
  ];
  peer.socket.write(Buffer.concat([wire(ack(snapshot)), ...notifications.map(wire)]));
  const subscription = await pending;
  assert.deepEqual(subscription.snapshot, snapshot);
  assert.deepEqual(events, notifications);
  await Promise.all([subscription.close(), subscription.close(), subscription.close()]);
  assert.equal(await subscription.closed, undefined);
  await peer.closed;
  controller.abort();
  await subscription.close();
  assert.equal(await subscription.closed, undefined);
  assertReleased(client(), controller.signal);
});

test("clears the acknowledgement deadline after subscribing", async () => {
  const fixture = await listen();
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const notification = { jsonrpc: "2.0", method: "heartbeat", params: {} };
  const delivered = Promise.withResolvers<unknown>();
  const pending = subscribeHc(fixture.endpoint, { timeoutMs: 25, onEvent: delivered.resolve });
  const peer = await fixture.received;
  peer.socket.write(wire(ack({})));
  const subscription = await pending;
  assert.equal(vi.getTimerCount(), 0);
  await vi.advanceTimersByTimeAsync(50);
  assert.equal(client().destroyed, false);
  peer.socket.write(wire(notification));
  assert.deepEqual(await delivered.promise, notification);
  await subscription.close();
  assert.equal(await subscription.closed, undefined);
});

const invalidNotifications = [
  null,
  [],
  { method: "event", params: {} },
  { jsonrpc: "1.0", method: "event", params: {} },
  { jsonrpc: "2.0", method: 1, params: {} },
  { jsonrpc: "2.0", method: "event" },
  { jsonrpc: "2.0", method: "event", params: null },
  { jsonrpc: "2.0", method: "event", params: [] },
  { jsonrpc: "2.0", method: "event", params: "secret" },
];

test.each(invalidNotifications.map((notification) => ({ notification })))(
  "resolves closed with an error for an invalid notification: $notification",
  async ({ notification }) => {
    const fixture = await listen();
    const onEvent = vi.fn();
    const controller = new AbortController();
    const pending = subscribeHc(fixture.endpoint, { ...options, signal: controller.signal, onEvent });
    const peer = await fixture.received;
    peer.socket.write(Buffer.concat([wire(ack({})), wire(notification)]));
    const subscription = await pending;
    const error = await subscription.closed;
    assert.ok(error instanceof Error);
    assert.match(error.message, /Invalid hc notification/u);
    assert.equal(onEvent.mock.calls.length, 0);
    await subscription.close();
    await subscription.close();
    assert.equal(await subscription.closed, error);
    await peer.closed;
    assertReleased(client(), controller.signal);
  },
);

test("resolves closed, rather than rejecting it, on subscription EOF", async () => {
  const fixture = await listen();
  const pending = subscribeHc(fixture.endpoint, options);
  const peer = await fixture.received;
  peer.socket.write(wire(ack(null)));
  const subscription = await pending;
  peer.socket.end();
  const error = await subscription.closed;
  assert.ok(error instanceof Error);
  assert.match(error.message, /hc socket ended/u);
  await subscription.close();
  assert.equal(await subscription.closed, error);
  await peer.closed;
  assertReleased(client());
});

test.each(["end", "destroy"] as const)("rejects subscription socket %s before acknowledgement", async (method) => {
  const fixture = await listen();
  const rejected = assert.rejects(subscribeHc(fixture.endpoint, options), /hc socket (ended|failed)/u);
  const peer = await fixture.received;
  peer.socket[method]();
  await rejected;
  await peer.closed;
  assertReleased(client());
});

test("validates a subscription acknowledgement before delivering notifications", async () => {
  const fixture = await listen();
  const onEvent = vi.fn();
  const rejected = assert.rejects(subscribeHc(fixture.endpoint, { ...options, onEvent }), /Invalid hc RPC response/u);
  const peer = await fixture.received;
  peer.socket.write(wire({ jsonrpc: "2.0", method: "event", params: {} }));
  await rejected;
  assert.equal(onEvent.mock.calls.length, 0);
  await peer.closed;
  assertReleased(client());
});

test("aborts before a late subscription acknowledgement without leaking handlers", async () => {
  const fixture = await listen();
  const controller = new AbortController();
  const onEvent = vi.fn();
  const rejected = assert.rejects(
    subscribeHc(fixture.endpoint, { ...options, signal: controller.signal, onEvent }),
    /hc operation cancelled/u,
  );
  const peer = await fixture.received;
  controller.abort();
  peer.socket.write(Buffer.concat([wire(ack({})), wire({ jsonrpc: "2.0", method: "event", params: { late: true } })]));
  await rejected;
  await peer.closed;
  assert.equal(onEvent.mock.calls.length, 0);
  assertReleased(client(), controller.signal);
});

test("aborts an acknowledged subscription and keeps repeated cleanup safe", async () => {
  const fixture = await listen();
  const controller = new AbortController();
  const pending = subscribeHc(fixture.endpoint, { ...options, signal: controller.signal });
  const peer = await fixture.received;
  peer.socket.write(wire(ack({})));
  const subscription = await pending;
  controller.abort();
  const error = await subscription.closed;
  assert.ok(error instanceof Error);
  assert.match(error.message, /hc operation cancelled/u);
  await Promise.all([subscription.close(), subscription.close()]);
  assert.equal(await subscription.closed, error);
  await peer.closed;
  assertReleased(client(), controller.signal);
});
