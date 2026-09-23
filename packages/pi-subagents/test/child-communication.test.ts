import assert from "node:assert/strict";
import { Check } from "typebox/value";
import { afterEach, test } from "vitest";
import { createMockPi } from "../../../test/support.js";
import { toolSourceId } from "../src/attachment-utils.js";
import {
  assertChildBootstrapCapacity,
  BROKER_CREDENTIAL_FD,
  BROKER_CREDENTIAL_FD_ENV,
  CHILD_READINESS_FD,
  CHILD_READINESS_FD_ENV,
  captureChildBootstrap,
  takeCapturedReadiness,
} from "../src/broker-credentials.js";
import { type ChildCommunicationClient, createChildCommunicationExtension } from "../src/child-communication-tools.js";
import { createChildReadinessProbe } from "../src/child-readiness-probe.js";
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
  delete process.env[CHILD_READINESS_FD_ENV];
  takeCapturedReadiness();
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
  assert.deepEqual(tools[1]?.prepareArguments?.({ requestId: "req_1", timeoutMs: 250, timeout: 3 }), {
    requestId: "req_1",
    timeout: 3,
  });
  assert.deepEqual(tools[1]?.prepareArguments?.({ requestId: "req_1", timeoutMs: 250, timeout: undefined }), {
    requestId: "req_1",
    timeout: 0.25,
  });
  for (const timeoutMs of ["1500", null]) {
    const malformedAlias = { requestId: "req_1", timeoutMs };
    const preparedMalformed = tools[1]?.prepareArguments?.(malformedAlias);
    assert.deepEqual(preparedMalformed, malformedAlias);
    assert.equal(Check(tools[1]?.parameters, preparedMalformed), false);
  }
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
  for (const [timeout, error] of [
    [0, /finite number of seconds/],
    [Number.NaN, /finite number of seconds/],
    [2_147_483.648, /maximum is 2147483\.647 seconds/],
  ] as const) {
    await assert.rejects(() => tools[1]?.execute("invalid-wait", { requestId: "req_1", timeout }), error);
  }
  assert.equal(calls.length, 3);
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

test("bounds the child bootstrap by serialized UTF-8 bytes", () => {
  const toolNames = (character: string) =>
    Array.from({ length: 66 }, (_, index) => `${String(index).padStart(2, "0")}${character.repeat(126)}`);
  assert.doesNotThrow(() => assertChildBootstrapCapacity(toolNames("a")));
  assert.throws(() => assertChildBootstrapCapacity(toolNames("界")), /child bootstrap size limit/i);
  assert.throws(() => assertChildBootstrapCapacity(toolNames('"')), /child bootstrap size limit/i);
});

test("captures child bootstrap state from private descriptors", () => {
  const communication: BrokerCredentials = {
    host: "127.0.0.1",
    port: 31_337,
    token: "a".repeat(64),
  };
  process.env[BROKER_CREDENTIAL_FD_ENV] = String(BROKER_CREDENTIAL_FD);
  process.env[CHILD_READINESS_FD_ENV] = String(CHILD_READINESS_FD);
  assert.deepEqual(
    captureChildBootstrap(() => JSON.stringify({ communication, expectedTools: ["read", "custom_search"] })),
    {
      communication,
      expectedTools: ["read", "custom_search"],
      readinessFd: CHILD_READINESS_FD,
    },
  );
  assert.deepEqual(takeCapturedReadiness(), {
    fd: CHILD_READINESS_FD,
    expectedTools: ["read", "custom_search"],
  });
  assert.equal(process.env[BROKER_CREDENTIAL_FD_ENV], undefined);
  assert.equal(process.env[CHILD_READINESS_FD_ENV], undefined);
});

test("rejects invalid bootstrap descriptors and payloads after deleting markers", () => {
  process.env[CHILD_READINESS_FD_ENV] = String(CHILD_READINESS_FD);
  assert.throws(() => captureChildBootstrap(() => "{}"), /unexpected.*readiness descriptor/i);
  assert.equal(process.env[CHILD_READINESS_FD_ENV], undefined);

  process.env[BROKER_CREDENTIAL_FD_ENV] = "4";
  assert.throws(() => captureChildBootstrap(() => "{}"), /invalid.*descriptor/i);
  assert.equal(process.env[BROKER_CREDENTIAL_FD_ENV], undefined);

  process.env[BROKER_CREDENTIAL_FD_ENV] = String(BROKER_CREDENTIAL_FD);
  assert.throws(() => captureChildBootstrap(() => "{}"), /invalid.*bootstrap/i);
  assert.equal(process.env[BROKER_CREDENTIAL_FD_ENV], undefined);

  process.env[BROKER_CREDENTIAL_FD_ENV] = String(BROKER_CREDENTIAL_FD);
  assert.throws(
    () =>
      captureChildBootstrap(() =>
        JSON.stringify({
          communication: { host: "127.0.0.1", port: 31_337, token: "a".repeat(64) },
          expectedTools: ["custom_search"],
        }),
      ),
    /readiness descriptor/i,
  );

  for (const expectedTools of [
    ["bad,name"],
    ["bad\u001bname"],
    Array.from({ length: 67 }, (_, index) => `tool_${index}`),
  ]) {
    process.env[BROKER_CREDENTIAL_FD_ENV] = String(BROKER_CREDENTIAL_FD);
    process.env[CHILD_READINESS_FD_ENV] = String(CHILD_READINESS_FD);
    assert.throws(
      () =>
        captureChildBootstrap(() =>
          JSON.stringify({
            communication: { host: "127.0.0.1", port: 31_337, token: "a".repeat(64) },
            expectedTools,
          }),
        ),
      /invalid.*bootstrap/i,
    );
  }
});

test("readiness probe runs after earlier resource hooks", async () => {
  const frames: string[] = [];
  const allTools = ["read", "factory_tool", "session_tool", "resource_tool"].map((name) => ({
    name,
    sourceInfo: { path: `/tmp/${name}.ts` },
  }));
  const mock = createMockPi({ activeTools: ["read"], allTools });
  mock.rawPi.on("resources_discover", () => {
    mock.rawPi.setActiveTools(["read", "factory_tool", "session_tool", "resource_tool"]);
  });
  createChildReadinessProbe(
    {
      fd: CHILD_READINESS_FD,
      expectedTools: ["read", "factory_tool", "session_tool", "resource_tool"],
    },
    (_fd, frame) => frames.push(frame),
    () => undefined,
  )(mock.pi);
  for (const handler of mock.events.get("resources_discover") ?? []) {
    await handler({ type: "resources_discover", cwd: process.cwd(), reason: "startup" }, {});
  }
  assert.deepEqual(
    frames.map((frame) => JSON.parse(frame)),
    [{ ok: true, sources: allTools.map((tool) => toolSourceId(tool.sourceInfo.path)) }],
  );
});

test("readiness probe reports success or missing requested tools once", async () => {
  for (const [activeTools, expectedTools, expectedFrame] of [
    [["read", "custom_search"], ["read", "custom_search"], { ok: true }],
    [["read"], ["read", "custom_search"], { ok: false, error: "Unavailable subagent tools: custom_search." }],
  ] as const) {
    const frames: string[] = [];
    const closed: number[] = [];
    const allTools = activeTools.map((name) => ({ name, sourceInfo: { path: `/tmp/${name}.ts` } }));
    const mock = createMockPi({ activeTools: [...activeTools], allTools });
    createChildReadinessProbe(
      { fd: CHILD_READINESS_FD, expectedTools: [...expectedTools] },
      (_fd, frame) => frames.push(frame),
      (fd) => closed.push(fd),
    )(mock.pi);
    for (const handler of mock.events.get("resources_discover") ?? []) {
      await handler({ type: "resources_discover", cwd: process.cwd(), reason: "startup" }, {});
    }
    for (const handler of mock.events.get("session_shutdown") ?? []) {
      await handler({ type: "session_shutdown", reason: "quit" }, {});
    }
    assert.deepEqual(
      frames.map((frame) => JSON.parse(frame)),
      [
        expectedFrame.ok
          ? { ok: true, sources: expectedTools.map((tool) => toolSourceId(`/tmp/${tool}.ts`)) }
          : expectedFrame,
      ],
    );
    assert.deepEqual(closed, [CHILD_READINESS_FD]);
  }
});
