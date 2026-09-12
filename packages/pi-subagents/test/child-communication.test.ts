import assert from "node:assert/strict";
import { Check } from "typebox/value";
import { afterEach, test } from "vitest";
import { createMockPi } from "../../../test/support.js";
import { BROKER_CREDENTIAL_FD, BROKER_CREDENTIAL_FD_ENV, captureBrokerCredentials } from "../src/broker-credentials.js";
import { type ChildCommunicationClient, createChildCommunicationExtension } from "../src/child-communication-tools.js";
import { MAX_MESSAGE_BYTES } from "../src/message-broker.js";
import type { BrokerCredentials } from "../src/types.js";

interface RegisteredTool {
  name: string;
  label: string;
  description: string;
  promptSnippet?: string;
  parameters: { properties?: Record<string, { maxLength?: number; description?: string }> };
  prepareArguments?: (args: unknown) => unknown;
  execute: (
    id: string,
    params: Record<string, unknown>,
    signal?: AbortSignal,
  ) => Promise<{ content: Array<{ type: string; text: string }>; details: unknown }>;
}

afterEach(() => {
  delete process.env[BROKER_CREDENTIAL_FD_ENV];
});

test("registers fixed send and wait schemas and returns bounded results", async () => {
  const calls: Record<string, unknown>[] = [];
  const client: ChildCommunicationClient = {
    async send(params, signal) {
      calls.push({ type: "send", params, signal });
      return { requestId: "req_1", accepted: true, duplicate: false };
    },
    async wait(requestId, timeoutMs, signal) {
      calls.push({ type: "wait", requestId, timeoutMs, signal });
      return "plain\u001b[31m response";
    },
  };
  const mock = createMockPi();
  createChildCommunicationExtension(client)(mock.pi);
  const tools = mock.tools as unknown as RegisteredTool[];
  assert.deepEqual(
    tools.map((tool) => tool.name),
    ["subagent_send", "subagent_wait"],
  );
  assert.equal(tools[0]?.label, "Subagent · Send to Main");
  assert.equal(tools[0]?.parameters.properties?.message?.maxLength, MAX_MESSAGE_BYTES);
  assert.equal(tools[0]?.parameters.properties?.recipient, undefined);
  assert.equal(tools[0]?.parameters.properties?.requestId?.maxLength, 128);
  assert.equal(Check(tools[0]?.parameters, { message: "Question" }), true);
  assert.equal(Check(tools[0]?.parameters, { requestId: "req_main", message: "Response" }), true);
  assert.equal(Check(tools[0]?.parameters, { recipient: "main", message: "Question" }), false);
  for (const tool of tools) {
    assert.doesNotMatch(
      JSON.stringify({
        description: tool.description,
        promptSnippet: tool.promptSnippet,
        parameters: tool.parameters,
      }),
      /\b(?:background|bounded)\b/i,
    );
  }
  assert.equal(
    tools[1]?.parameters.properties?.timeout?.description,
    "Timeout in seconds (optional, no default timeout)",
  );
  assert.match(tools[1]?.description ?? "", /incoming main-agent request.*original request/is);
  assert.deepEqual(tools[1]?.prepareArguments?.({ requestId: "req_1", timeoutMs: 1_500 }), {
    requestId: "req_1",
    timeout: 1.5,
  });
  const malformedAlias = { requestId: "req_1", timeoutMs: "1500" };
  const preparedMalformed = tools[1]?.prepareArguments?.(malformedAlias);
  assert.deepEqual(preparedMalformed, malformedAlias);
  assert.equal(Check(tools[1]?.parameters, preparedMalformed), false);
  const sent = await tools[0]?.execute("send", { message: "Question" });
  assert.deepEqual(sent, {
    content: [
      {
        type: "text",
        text: JSON.stringify({ requestId: "req_1", accepted: true, duplicate: false }),
      },
    ],
    details: { requestId: "req_1", accepted: true, duplicate: false },
  });
  assert.deepEqual(calls[0]?.params, { recipient: "main", message: "Question" });
  const responded = await tools[0]?.execute("respond", {
    requestId: " req_main ",
    message: "Response",
  });
  assert.deepEqual(responded?.details, {
    requestId: "req_1",
    accepted: true,
    duplicate: false,
  });
  assert.deepEqual(calls[1]?.params, { requestId: "req_main", message: "Response" });
  const waited = await tools[1]?.execute("wait", { requestId: "req_1", timeout: 1.25 });
  assert.deepEqual(waited, {
    content: [{ type: "text", text: "plain[31m response" }],
    details: { requestId: "req_1" },
  });
  assert.equal(calls[2]?.timeoutMs, 1_250);
});

test("child send validates optional response IDs before transport", async () => {
  let calls = 0;
  const client: ChildCommunicationClient = {
    async send() {
      calls++;
      return { requestId: "req_1", accepted: true, duplicate: false };
    },
    async wait() {
      return "response";
    },
  };
  const mock = createMockPi();
  createChildCommunicationExtension(client)(mock.pi);
  const send = (mock.tools as unknown as RegisteredTool[])[0];
  await assert.rejects(
    () => send?.execute("empty-request", { requestId: " ", message: "Response" }),
    /requestId is required/i,
  );
  await assert.rejects(() => send?.execute("empty-message", { message: " " }), /message is required/i);
  assert.equal(calls, 0);
});

test("child tool failures throw and preserve AbortError", async () => {
  const client: ChildCommunicationClient = {
    async send() {
      throw new Error("broker rejected");
    },
    async wait() {
      const error = new Error("cancelled");
      error.name = "AbortError";
      throw error;
    },
  };
  const mock = createMockPi();
  createChildCommunicationExtension(client)(mock.pi);
  const tools = mock.tools as unknown as RegisteredTool[];
  await assert.rejects(() => tools[0]?.execute("send", { message: "Question" }), /broker rejected/);
  await assert.rejects(
    () => tools[1]?.execute("wait", { requestId: "req_1" }),
    (error: Error) => error.name === "AbortError",
  );
});

test("captures credentials from the declared private descriptor", () => {
  const expected: BrokerCredentials = {
    host: "127.0.0.1",
    port: 31_337,
    token: "a".repeat(64),
  };
  process.env[BROKER_CREDENTIAL_FD_ENV] = String(BROKER_CREDENTIAL_FD);
  assert.deepEqual(
    captureBrokerCredentials(() => JSON.stringify(expected)),
    expected,
  );
  assert.equal(process.env[BROKER_CREDENTIAL_FD_ENV], undefined);
});

test("rejects invalid credential descriptors and payloads after deleting the marker", () => {
  process.env[BROKER_CREDENTIAL_FD_ENV] = "4";
  assert.throws(() => captureBrokerCredentials(() => "{}"), /invalid.*descriptor/i);
  assert.equal(process.env[BROKER_CREDENTIAL_FD_ENV], undefined);

  process.env[BROKER_CREDENTIAL_FD_ENV] = String(BROKER_CREDENTIAL_FD);
  assert.throws(() => captureBrokerCredentials(() => "{}"), /invalid.*credentials/i);
  assert.equal(process.env[BROKER_CREDENTIAL_FD_ENV], undefined);
});
