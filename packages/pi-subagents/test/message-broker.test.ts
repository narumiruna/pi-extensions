import assert from "node:assert/strict";
import { once } from "node:events";
import net, { type Socket } from "node:net";
import { afterEach, test } from "vitest";
import { createBrokerClient } from "../src/child-communication-bridge.js";
import {
  type BrokerInboundMessage,
  MAX_FRAME_BYTES,
  MAX_MESSAGE_BYTES,
  MAX_MESSAGE_LINES,
  MessageBroker,
} from "../src/message-broker.js";
import type { BrokerCredentials } from "../src/types.js";

const brokers: MessageBroker[] = [];

afterEach(async () => {
  await Promise.all(brokers.splice(0).map((broker) => broker.shutdown()));
});

test("authenticates a child request and preserves the first main response", async () => {
  const messages: BrokerInboundMessage[] = [];
  const { broker, credentials } = await setup((message) => messages.push(message));
  const client = createBrokerClient(credentials);
  const sent = await client.send({ recipient: "main", message: "Which option?" }, undefined);
  assert.deepEqual(sent, { requestId: sent.requestId, accepted: true, duplicate: false });
  assert.deepEqual(messages[0], {
    kind: "request",
    requestId: sent.requestId,
    jobId: "job_1",
    message: "Which option?",
  });
  assert.deepEqual(broker.replyFromMain(sent.requestId, "Option A"), {
    requestId: sent.requestId,
    accepted: true,
    duplicate: false,
  });
  assert.deepEqual(broker.replyFromMain(sent.requestId, "Option B"), {
    requestId: sent.requestId,
    accepted: false,
    duplicate: true,
  });
  assert.equal(await client.wait(sent.requestId, undefined, undefined), "Option A");
  assert.equal(await client.wait(sent.requestId, undefined, undefined), "Option A");
});

test("accepts one child response to a main request and delivers it asynchronously", async () => {
  const messages: BrokerInboundMessage[] = [];
  const { broker, credentials } = await setup((message) => messages.push(message));
  const client = createBrokerClient(credentials);
  const requested = broker.createMainRequest("job_1", "What did you find?");
  const response = await client.send({ requestId: requested.requestId, message: "Two race conditions." }, undefined);
  assert.deepEqual(response, {
    requestId: requested.requestId,
    accepted: true,
    duplicate: false,
  });
  assert.deepEqual(messages, [
    {
      kind: "response",
      requestId: requested.requestId,
      jobId: "job_1",
      message: "Two race conditions.",
    },
  ]);
  assert.deepEqual(await client.send({ requestId: requested.requestId, message: "replacement" }, undefined), {
    requestId: requested.requestId,
    accepted: false,
    duplicate: true,
  });
  await assert.rejects(() => client.wait(requested.requestId, 1, undefined), /unknown or expired/i);
});

test("wait timeout and cancellation stop only the child long poll", async () => {
  const { broker, credentials, observeNextFrame } = await setup(() => undefined);
  const client = createBrokerClient(credentials);
  const sent = await client.send({ recipient: "main", message: "Need a response" }, undefined);
  await assert.rejects(() => client.wait(sent.requestId, 1, undefined), /wait timed out/i);
  const controller = new AbortController();
  const waitFrame = observeNextFrame();
  const cancelled = client.wait(sent.requestId, undefined, controller.signal);
  const serverSocket = await waitFrame;
  const serverClosed = once(serverSocket, "close");
  controller.abort();
  await assert.rejects(cancelled, (error: Error) => error.name === "AbortError");
  await serverClosed;
  const retry = client.wait(sent.requestId, undefined, undefined);
  broker.replyFromMain(sent.requestId, "Still active");
  assert.equal(await retry, "Still active");
});

test("interrupts child waits for queued main requests without consuming the original request", async () => {
  const { broker, credentials, observeNextFrame } = await setup(() => undefined);
  const client = createBrokerClient(credentials);
  const childRequest = await client.send({ recipient: "main", message: "Need the first decision" }, undefined);
  const waitFrame = observeNextFrame();
  const interruptedWait = client.wait(childRequest.requestId, undefined, undefined);
  await waitFrame;
  const mainRequest = broker.createMainRequest("job_1", "Handle this request next");
  assert.equal(broker.markMainRequestQueued(mainRequest.requestId), true);
  assert.equal(broker.interruptChildWaits("job_1"), 1);
  await assert.rejects(interruptedWait, /interrupted.*original request remains active/is);
  await assert.rejects(
    client.wait(childRequest.requestId, undefined, undefined),
    /interrupted.*original request remains active/is,
  );

  assert.deepEqual(await client.send({ requestId: mainRequest.requestId, message: "Next response" }, undefined), {
    requestId: mainRequest.requestId,
    accepted: true,
    duplicate: false,
  });
  broker.replyFromMain(childRequest.requestId, "First decision");
  assert.equal(await client.wait(childRequest.requestId, undefined, undefined), "First decision");
  assert.equal(broker.interruptChildWaits("job_1"), 0);
});

test("enforces four combined outstanding requests and limits consumed replay", async () => {
  const { broker, credentials } = await setup(() => undefined);
  const client = createBrokerClient(credentials);
  const requestIds: string[] = [];
  for (let index = 0; index < 2; index++) {
    requestIds.push((await client.send({ recipient: "main", message: `Child ${index}` }, undefined)).requestId);
    requestIds.push(broker.createMainRequest("job_1", `Main ${index}`).requestId);
  }
  await assert.rejects(() => client.send({ recipient: "main", message: "Fifth" }, undefined), /at most 4 outstanding/i);
  for (const requestId of requestIds.filter((_requestId, index) => index % 2 === 0)) {
    broker.replyFromMain(requestId, "Response");
    await client.wait(requestId, undefined, undefined);
  }
  for (const requestId of requestIds.filter((_requestId, index) => index % 2 === 1)) {
    await client.send({ requestId, message: "Response" }, undefined);
  }
  const newer: string[] = [];
  for (let index = 0; index < 5; index++) {
    const sent = await client.send({ recipient: "main", message: `New ${index}` }, undefined);
    newer.push(sent.requestId);
    broker.replyFromMain(sent.requestId, `New response ${index}`);
    await client.wait(sent.requestId, undefined, undefined);
  }
  await assert.rejects(() => client.wait(requestIds[0] ?? "missing", undefined, undefined), /unknown or expired/i);
  assert.equal(await client.wait(newer.at(-1) ?? "missing", undefined, undefined), "New response 4");
});

test("rejects cross-job responses, concurrent waits, wrong recipients, and revoked tokens", async () => {
  const { broker, credentials, observeNextFrame } = await setup(() => undefined);
  const secondCredentials = broker.issueCredentials({ jobId: "job_2", generation: 1 });
  const first = createBrokerClient(credentials);
  const second = createBrokerClient(secondCredentials);
  const childRequest = await first.send({ recipient: "main", message: "Private to job one" }, undefined);
  await assert.rejects(() => second.wait(childRequest.requestId, 1, undefined), /unknown or expired/i);
  const mainRequest = broker.createMainRequest("job_1", "Private main request");
  await assert.rejects(
    () => second.send({ requestId: mainRequest.requestId, message: "cross-job" }, undefined),
    /unauthorized/i,
  );
  await first.send({ requestId: mainRequest.requestId, message: "authorized" }, undefined);
  await assert.rejects(
    () => first.send({ recipient: "job_2", message: "peer" } as unknown as Parameters<typeof first.send>[0], undefined),
    /only to recipient "main"/i,
  );
  const controller = new AbortController();
  const waitFrame = observeNextFrame();
  const active = first.wait(childRequest.requestId, undefined, controller.signal);
  const serverSocket = await waitFrame;
  await assert.rejects(() => first.wait(childRequest.requestId, 1, undefined), /wait is already active/i);
  const serverClosed = once(serverSocket, "close");
  controller.abort();
  await assert.rejects(active, (error: Error) => error.name === "AbortError");
  await serverClosed;
  broker.revokeJob("job_1");
  await assert.rejects(() => first.send({ recipient: "main", message: "stale" }, undefined), /unauthenticated/i);
});

test("rolls back child requests and responses when main delivery fails", async () => {
  let fail = true;
  const { broker, credentials } = await setup(() => {
    if (fail) throw new Error("delivery unavailable");
  });
  const client = createBrokerClient(credentials);
  await assert.rejects(
    () => client.send({ recipient: "main", message: "Question" }, undefined),
    /delivery unavailable/i,
  );
  assert.equal(broker.hasPendingMainRequest(), false);
  fail = false;
  const mainRequest = broker.createMainRequest("job_1", "Question from main");
  fail = true;
  await assert.rejects(
    () => client.send({ requestId: mainRequest.requestId, message: "Response" }, undefined),
    /delivery unavailable/i,
  );
  fail = false;
  assert.deepEqual(await client.send({ requestId: mainRequest.requestId, message: "Retry" }, undefined), {
    requestId: mainRequest.requestId,
    accepted: true,
    duplicate: false,
  });
});

test("revocation and repeated shutdown settle pending waits once", async () => {
  const { broker, credentials, observeNextFrame } = await setup(() => undefined);
  const client = createBrokerClient(credentials);
  const sent = await client.send({ recipient: "main", message: "Pending" }, undefined);
  const waitFrame = observeNextFrame();
  const pending = client.wait(sent.requestId, undefined, undefined);
  await waitFrame;
  broker.revokeJob("job_1");
  await assert.rejects(pending, /no longer active/i);
  assert.throws(() => broker.replyFromMain(sent.requestId, "stale"), /unauthorized|expired/i);
  await broker.shutdown();
  await broker.shutdown();
});

test("rejects incomplete, malformed, unauthenticated, and oversized frames", async () => {
  const timeoutBroker = new MessageBroker({
    onMessage: () => undefined,
    requestFrameTimeoutMs: 5,
  });
  brokers.push(timeoutBroker);
  await timeoutBroker.start();
  const timeoutCredentials = timeoutBroker.issueCredentials({ jobId: "job_1", generation: 1 });
  assert.match(String((await raw(timeoutCredentials, "{")).error), /frame timed out/i);

  const { credentials } = await setup(() => undefined);
  assert.match(String((await raw(credentials, "not-json\n")).error), /malformed/i);
  assert.match(
    String(
      (
        await raw(
          credentials,
          `${JSON.stringify({ type: "send", token: "0".repeat(64), recipient: "main", message: "x" })}\n`,
        )
      ).error,
    ),
    /unauthenticated/i,
  );
  assert.match(String((await raw(credentials, `${"x".repeat(MAX_FRAME_BYTES + 1)}\n`)).error), /size limit/i);
});

test("bounds message bytes and lines for intact protocol envelopes", async () => {
  const { broker, credentials } = await setup(() => undefined);
  const client = createBrokerClient(credentials);
  await assert.rejects(
    () => client.send({ recipient: "main", message: "x".repeat(MAX_MESSAGE_BYTES + 1) }, undefined),
    /48 KiB|49152/i,
  );
  const tooManyLines = Array.from({ length: MAX_MESSAGE_LINES + 1 }, () => "x").join("\n");
  await assert.rejects(
    () => client.send({ recipient: "main", message: tooManyLines }, undefined),
    /at most 1992 lines/i,
  );
  const sent = await client.send({ recipient: "main", message: "Question" }, undefined);
  assert.throws(() => broker.replyFromMain(sent.requestId, tooManyLines), /at most 1992 lines/i);
  const mainRequest = broker.createMainRequest("job_1", "Question");
  await assert.rejects(
    () => client.send({ requestId: mainRequest.requestId, message: tooManyLines }, undefined),
    /at most 1992 lines/i,
  );
});

async function setup(onMessage: (message: BrokerInboundMessage) => void) {
  const frameObservers: Array<(socket: Socket) => void> = [];
  const broker = new MessageBroker({
    onMessage,
    createServer: (listener) =>
      net.createServer((socket) => {
        const observer = frameObservers.shift();
        if (observer) observeRequestFrame(socket, observer);
        listener(socket);
      }),
  });
  brokers.push(broker);
  await broker.start();
  const credentials = broker.issueCredentials({ jobId: "job_1", generation: 1 });
  return {
    broker,
    credentials,
    observeNextFrame: () =>
      new Promise<Socket>((resolve) => {
        frameObservers.push(resolve);
      }),
  };
}

function observeRequestFrame(socket: Socket, observer: (socket: Socket) => void): void {
  let frame = Buffer.alloc(0);
  const onData = (chunk: Buffer) => {
    frame = Buffer.concat([frame, chunk]);
    if (!frame.includes(0x0a)) return;
    socket.off("data", onData);
    observer(socket);
  };
  socket.on("data", onData);
}

function raw(credentials: BrokerCredentials, content: string): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: credentials.host, port: credentials.port });
    let response = Buffer.alloc(0);
    socket.once("connect", () => socket.write(content));
    socket.on("data", (chunk: Buffer) => {
      response = Buffer.concat([response, chunk]);
    });
    socket.once("error", reject);
    socket.once("close", () => {
      try {
        resolve(JSON.parse(response.toString("utf8")) as Record<string, unknown>);
      } catch (error) {
        reject(error);
      }
    });
  });
}
