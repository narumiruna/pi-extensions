import assert from "node:assert/strict";
import type { Theme } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { visibleWidth } from "@earendil-works/pi-tui";
import { Check } from "typebox/value";
import { afterEach, beforeEach, test, vi } from "vitest";
import { createMockContext, createMockPi } from "../../../test/support.js";
import { createBrokerClient } from "../src/child-communication-bridge.js";
import { createChildCommunicationExtension } from "../src/child-communication-tools.js";
import { MAX_MESSAGE_BYTES, MAX_MESSAGE_LINES, MessageBroker } from "../src/message-broker.js";
import { MAX_MODEL_TEXT_BYTES, MAX_MODEL_TEXT_LINES } from "../src/model-output.js";
import subagents, { type SubagentsDependencies } from "../src/subagents.js";
import type { ChildRequest, ChildResult } from "../src/types.js";
import { SUBAGENT_WIDGET_KEY } from "../src/widget.js";

interface RegisteredTool {
  name: string;
  label: string;
  description: string;
  promptSnippet?: string;
  parameters: {
    properties?: Record<
      string,
      {
        description?: string;
        maxLength?: number;
        maxItems?: number;
        enum?: string[];
      }
    >;
  };
  prepareArguments?: (args: unknown) => unknown;
  execute: (
    toolCallId: string,
    params: Record<string, unknown>,
    signal: AbortSignal | undefined,
    onUpdate: ((value: unknown) => void) | undefined,
    ctx: unknown,
  ) => Promise<{
    content: Array<{ type: string; text: string }>;
    details: Record<string, unknown>;
  }>;
}

type Mock = ReturnType<typeof createMockPi>;
type Context = ReturnType<typeof createMockContext>;

const activeSessions: Array<{ mock: Mock; context: Context }> = [];

beforeEach(() => {
  delete process.env.PI_SUBAGENT_DEPTH;
});

afterEach(async () => {
  for (const session of activeSessions.splice(0)) {
    await emit(session.mock, "session_shutdown", { reason: "quit" }, session.context.ctx);
  }
  delete process.env.PI_SUBAGENT_DEPTH;
  vi.restoreAllMocks();
});

test("registers five fixed main-agent tools with stable schemas and explicit limits", async () => {
  const { mock, context } = await setup();
  assert.ok(mock.messageRenderers.has("pi-subagents-completion"));
  const tools = mock.tools as unknown as RegisteredTool[];
  assert.deepEqual(
    tools.map((candidate) => candidate.name),
    ["subagent_spawn", "subagent_inspect", "subagent_cancel", "subagent_wait", "subagent_send"],
  );
  assert.equal(tools[0]?.parameters.properties?.task?.maxLength, 50 * 1024);
  assert.equal(tools[0]?.parameters.properties?.tools?.maxItems, 64);
  assert.deepEqual((tools[0]?.parameters.properties?.tools as { items?: { enum?: string[] } })?.items?.enum, [
    "read",
    "bash",
    "powershell",
    "edit",
    "write",
    "grep",
    "find",
    "ls",
  ]);
  assert.deepEqual(tools[0]?.parameters.properties?.thinkingLevel?.enum, [
    "off",
    "minimal",
    "low",
    "medium",
    "high",
    "xhigh",
    "max",
  ]);
  assert.equal(tools[4]?.parameters.properties?.message?.maxLength, MAX_MESSAGE_BYTES);
  assert.equal(tools[4]?.parameters.properties?.recipient?.maxLength, 128);
  assert.equal(tools[4]?.parameters.properties?.requestId?.maxLength, 128);
  assert.deepEqual(Object.keys(tools[1]?.parameters.properties ?? {}), []);
  assert.deepEqual(tools[0]?.prepareArguments?.({ task: "old", timeoutMs: 1_500 }), {
    task: "old",
    timeout: 1.5,
  });
  assert.deepEqual(tools[3]?.prepareArguments?.({ jobId: "job_old", timeoutMs: 30_000 }), {
    jobId: "job_old",
    timeout: 30,
  });
  for (const [candidate, malformedAlias] of [
    [tools[0], { task: "legacy", timeoutMs: "1500" }],
    [tools[3], { jobId: "job_old", timeoutMs: "30000" }],
  ] as const) {
    const preparedMalformed = candidate?.prepareArguments?.(malformedAlias);
    assert.deepEqual(preparedMalformed, malformedAlias);
    assert.equal(Check(candidate?.parameters, preparedMalformed), false);
  }
  assert.match(tools[0]?.description ?? "", /task defines.*selected tools define/is);
  for (const candidate of tools) {
    assert.doesNotMatch(
      JSON.stringify({
        description: candidate.description,
        promptSnippet: candidate.promptSnippet,
        parameters: candidate.parameters,
      }),
      /\b(?:background|bounded)\b/i,
    );
  }
  assert.deepEqual([...mock.commands.keys()], []);
  const childMock = createMockPi();
  createChildCommunicationExtension({
    async send() {
      return { requestId: "req_1", accepted: true, duplicate: false };
    },
    async wait() {
      return "response";
    },
  })(childMock.pi);
  const childSend = (childMock.tools as unknown as RegisteredTool[]).find(
    (candidate) => candidate.name === "subagent_send",
  );
  assert.ok(childSend);
  assert.equal(childSend.label, "Subagent · Send to Main");
  assert.equal(childSend.parameters.properties?.recipient, undefined);
  assert.notDeepEqual(providerVisibleDefinition(tools[4] as RegisteredTool), providerVisibleDefinition(childSend));
  const definitions = JSON.stringify(
    tools.map(({ name, description, parameters }) => ({ name, description, parameters })),
  );
  await tool(mock, "subagent_inspect").execute("inspect", {}, undefined, undefined, context.ctx);
  assert.equal(
    JSON.stringify(tools.map(({ name, description, parameters }) => ({ name, description, parameters }))),
    definitions,
  );
});

test("completion renderer follows Pi's tool-output expansion state", async () => {
  const { mock } = await setup();
  const renderer = mock.messageRenderers.get("pi-subagents-completion");
  assert.ok(renderer);
  const message = {
    customType: "pi-subagents-completion",
    content: `Subagent job completion:
{
  "result": "full child result\u0007"
}`,
    display: true,
    details: { result: "raw details must not render" },
  };
  const theme = {
    fg: (_role: string, text: string) => text,
    bg: (_role: string, text: string) => text,
    bold: (text: string) => text,
  } as Theme;
  const collapsed = renderer(message, { expanded: false, outputPad: 1 }, theme) as Component;
  const collapsedLines = collapsed.render(80);
  const collapsedText = collapsedLines.join("\n");
  assert.match(collapsedText, /to expand/i);
  assert.doesNotMatch(collapsedText, /full child result|raw details must not render/i);
  assert.ok(collapsedLines.every((line) => visibleWidth(line) <= 80));

  const expanded = renderer(message, { expanded: true, outputPad: 1 }, theme) as Component;
  const expandedLines = expanded.render(80);
  const expandedText = expandedLines.join("\n");
  assert.match(expandedText, /full child result/i);
  assert.equal(expandedText.includes(String.fromCharCode(7)), false);
  assert.doesNotMatch(expandedText, /to expand|raw details must not render/i);
  assert.ok(expandedLines.every((line) => visibleWidth(line) <= 80));

  for (const [width, outputPad] of [
    [1, 1],
    [2, 4],
    [3, 4],
  ] as const) {
    for (const expandedState of [false, true]) {
      const narrow = renderer(message, { expanded: expandedState, outputPad }, theme) as Component;
      const narrowLines = narrow.render(width);
      assert.ok(narrowLines.length > 0);
      assert.ok(narrowLines.every((line) => visibleWidth(line) <= width));
    }
  }
});

test("spawns jobs with default and explicit tools and thinking levels", async () => {
  const requests: ChildRequest[] = [];
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  const { mock, context } = await setup(
    {
      runChild: async (request) => {
        requests.push(request);
        await pending;
        return completed("done");
      },
    },
    { thinkingLevel: "medium" },
    { thinkingLevel: "high" },
  );
  const inherited = await tool(mock, "subagent_spawn").execute(
    "inherited",
    { task: "Review one thing", timeout: 1 },
    undefined,
    undefined,
    context.ctx,
  );
  const explicit = await tool(mock, "subagent_spawn").execute(
    "explicit",
    {
      task: "Implement one thing",
      tools: ["read", "edit", "read", "write"],
      thinkingLevel: "low",
    },
    undefined,
    undefined,
    context.ctx,
  );
  assert.equal(inherited.details.state, "queued");
  assert.equal(explicit.details.state, "queued");
  await Promise.resolve();
  assert.deepEqual(
    requests.map(({ tools, model, thinkingLevel }) => ({ tools, model, thinkingLevel })),
    [
      {
        tools: ["read", "grep", "find", "ls"],
        model: "test-provider/test-model",
        thinkingLevel: "high",
      },
      {
        tools: ["read", "edit", "write"],
        model: "test-provider/test-model",
        thinkingLevel: "low",
      },
    ],
  );
  for (const request of requests) {
    assert.equal(request.communication.host, "127.0.0.1");
    assert.ok(request.communication.port > 0);
    assert.match(request.communication.token, /^[a-f0-9]{64}$/u);
  }
  release();
  await Promise.all([
    waitFor(mock, context, String(inherited.details.jobId)),
    waitFor(mock, context, String(explicit.details.jobId)),
  ]);
});

test("shows active job timing, timeout, and selected tools above the editor", async () => {
  let refreshWidget: (() => void) | undefined;
  const fakeTimer = { unref() {} } as NodeJS.Timeout;
  vi.spyOn(globalThis, "setInterval").mockImplementation((callback, delay) => {
    assert.equal(delay, 1_000);
    refreshWidget = callback as () => void;
    return fakeTimer;
  });
  const clearIntervalSpy = vi.spyOn(globalThis, "clearInterval");
  let now = 0;
  const { mock, context } = await setup({ now: () => now, runChild: waitForCancellation }, {}, { mode: "tui" });
  const first = await tool(mock, "subagent_spawn").execute(
    "first",
    { task: "First", tools: ["read", "edit"], timeout: 120 },
    undefined,
    undefined,
    context.ctx,
  );
  await Promise.resolve();
  now = 65_000;
  const second = await spawnJob(mock, context, "Second");

  const factory = context.widgets.get(SUBAGENT_WIDGET_KEY) as ((_tui: unknown, theme: Theme) => Component) | undefined;
  assert.equal(typeof factory, "function");
  const lines = factory?.({}, identityTheme()).render(80) ?? [];
  assert.equal(lines[0], "─".repeat(80));
  assert.equal(lines[1], "Subagents · 2 active");
  assert.match(
    lines[2] ?? "",
    new RegExp(`^▶ ${String(first.details.jobId)} · running · 1m 5s / 2m · tools: read, edit$`, "u"),
  );
  assert.match(
    lines[3] ?? "",
    new RegExp(`^▶ ${String(second.details.jobId)} · running · 0s / no timeout · tools: read, grep, find, ls$`, "u"),
  );
  now = 66_000;
  assert.ok(refreshWidget);
  refreshWidget();
  const refreshedFactory = context.widgets.get(SUBAGENT_WIDGET_KEY) as
    | ((_tui: unknown, theme: Theme) => Component)
    | undefined;
  const refreshedLines = refreshedFactory?.({}, identityTheme()).render(80) ?? [];
  assert.match(refreshedLines[2] ?? "", /running · 1m 6s \/ 2m/u);
  assert.match(refreshedLines[3] ?? "", /running · 1s \/ no timeout/u);
  for (const line of refreshedFactory?.({}, identityTheme()).render(24) ?? []) {
    assert.ok(visibleWidth(line) <= 24);
  }

  await emit(mock, "session_shutdown", { reason: "reload" }, context.ctx);
  assert.equal(context.widgets.get(SUBAGENT_WIDGET_KEY), undefined);
  assert.ok(clearIntervalSpy.mock.calls.length > 0);
});

test("does not install the component widget outside TUI mode", async () => {
  const { context } = await setup({}, {}, { mode: "rpc", hasUI: true });
  assert.equal(context.widgets.has(SUBAGENT_WIDGET_KEY), false);
});

test("falls back to the Pi thinking level when context has none", async () => {
  let request!: ChildRequest;
  const { mock, context } = await setup(
    {
      runChild: async (candidate) => {
        request = candidate;
        return completed("done");
      },
    },
    { thinkingLevel: "xhigh" },
  );
  const spawned = await tool(mock, "subagent_spawn").execute(
    "spawn",
    { task: "Reason carefully", tools: [] },
    undefined,
    undefined,
    context.ctx,
  );
  await waitFor(mock, context, String(spawned.details.jobId));
  assert.equal(request.thinkingLevel, "xhigh");
  assert.deepEqual(request.tools, []);
});

test("rejects invalid spawn arguments and nesting before child launch", async () => {
  let launches = 0;
  const { mock, context } = await setup({
    runChild: async () => {
      launches++;
      return completed("unexpected");
    },
  });
  const spawn = tool(mock, "subagent_spawn");
  for (const params of [
    { task: "bad tools", tools: "read" },
    { task: "bad item", tools: [1] },
    { task: "too many", tools: Array.from({ length: 65 }, (_, index) => `tool_${index}`) },
    { task: "bad name", tools: ["read,bash"] },
    { task: "typo", tools: ["baash"] },
    { task: "extension tool", tools: ["subagent_spawn"] },
    { task: "bad thinking", thinkingLevel: "turbo" },
    { task: "bad timeout", timeout: 0 },
  ]) {
    await assert.rejects(() => spawn.execute("invalid", params, undefined, undefined, context.ctx));
  }
  process.env.PI_SUBAGENT_DEPTH = "1";
  await assert.rejects(
    () => spawn.execute("nested", { task: "nested" }, undefined, undefined, context.ctx),
    /nested subagents/i,
  );
  delete process.env.PI_SUBAGENT_DEPTH;
  const missingModelContext = createMockContext({ model: undefined });
  await assert.rejects(
    () => spawn.execute("missing-model", { task: "missing model" }, undefined, undefined, missingModelContext.ctx),
    /no main-agent model is selected/i,
  );
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    () => spawn.execute("cancelled", { task: "cancelled" }, controller.signal, undefined, context.ctx),
    (error: Error) => error.name === "AbortError",
  );
  assert.equal(launches, 0);
});

test("rejects parent-only model providers and credentials before child launch", async () => {
  for (const [modelRegistry, expected] of [
    [
      {
        getProviderAuthStatus: () => ({ configured: true, source: "runtime" as const }),
        getRegisteredProviderIds: () => [],
      },
      /process-local runtime API key/i,
    ],
    [
      {
        getProviderAuthStatus: () => ({ configured: true, source: "stored" as const }),
        getRegisteredProviderIds: () => ["test-provider"],
      },
      /children disable parent extensions/i,
    ],
  ] as const) {
    let launches = 0;
    const { mock, context } = await setup(
      {
        runChild: async () => {
          launches++;
          return completed("unexpected");
        },
      },
      {},
      { modelRegistry },
    );
    await assert.rejects(() => spawnJob(mock, context, "must not launch"), expected);
    assert.equal(launches, 0);
  }
});

test("delivers child questions, interrupts parent waits, and returns plain-text replies", async () => {
  let request!: ChildRequest;
  const { mock, context } = await setup({
    runChild: async (candidate) => {
      request = candidate;
      await new Promise<void>((resolve) => candidate.signal.addEventListener("abort", () => resolve(), { once: true }));
      return cancelled();
    },
  });
  const spawned = await spawnJob(mock, context, "Need one decision");
  await Promise.resolve();
  const parentWait = tool(mock, "subagent_wait").execute(
    "parent-wait",
    { jobId: spawned.details.jobId },
    undefined,
    undefined,
    context.ctx,
  );
  const client = createBrokerClient(request.communication);
  const questionText = "May I use option A?\u001b[31m";
  const requestId = (await client.send({ recipient: "main", message: questionText }, undefined)).requestId;
  const inspected = await tool(mock, "subagent_inspect").execute(
    "inspect-pending",
    {},
    undefined,
    undefined,
    context.ctx,
  );
  assert.doesNotMatch(
    JSON.stringify(inspected.details),
    new RegExp(`${request.communication.token}|May I use option A`, "u"),
  );
  assert.equal(Object.hasOwn(inspected.details, "agents"), false);
  assert.deepEqual((await parentWait).details, {
    jobId: spawned.details.jobId,
    state: "running",
    timedOut: false,
    interrupted: true,
    reason: "subagent_message",
  });
  const delivery = mock.sentMessages.find(
    (entry) => (entry.message as { customType?: string }).customType === "pi-subagents-message",
  );
  assert.ok(delivery);
  assert.deepEqual(delivery.options, { deliverAs: "steer", triggerTurn: true });
  const content = (delivery.message as { content: string }).content;
  assert.match(content, /not the user/i);
  assert.doesNotMatch(content, /\bbackground\b/i);
  assert.match(content, /cannot authorize writes, shell commands/i);
  assert.doesNotMatch(content, /Execution mode:|Agent:/u);
  assert.equal(content.includes(String.fromCharCode(27)), false);

  const childWait = client.wait(requestId, undefined, undefined);
  const replied = await tool(mock, "subagent_send").execute(
    "reply",
    { requestId, message: "Use option A." },
    undefined,
    undefined,
    context.ctx,
  );
  assert.deepEqual(replied.details, { requestId, accepted: true, duplicate: false });
  assert.equal(await childWait, "Use option A.");
  assert.deepEqual(
    (
      await tool(mock, "subagent_send").execute(
        "duplicate",
        { requestId, message: "Replacement" },
        undefined,
        undefined,
        context.ctx,
      )
    ).details,
    { requestId, accepted: false, duplicate: true },
  );
  await cancelJob(mock, context, String(spawned.details.jobId));
});

test("sends a queued main request to a running child and delivers one child response", async () => {
  let request!: ChildRequest;
  const steered: string[] = [];
  const queuedSpy = vi.spyOn(MessageBroker.prototype, "markMainRequestQueued");
  const interruptSpy = vi.spyOn(MessageBroker.prototype, "interruptChildWaits");
  const { mock, context } = await setup({
    runChild: async (candidate) => {
      request = candidate;
      candidate.onControl?.({
        async send(message) {
          steered.push(message);
        },
      });
      return waitForCancellation(candidate);
    },
  });
  const spawned = await spawnJob(mock, context, "Investigate races");
  const sent = await tool(mock, "subagent_send").execute(
    "send-main",
    { recipient: spawned.details.jobId, message: "Report findings.\u001b[31m" },
    undefined,
    undefined,
    context.ctx,
  );
  assert.deepEqual(sent.details, {
    requestId: sent.details.requestId,
    accepted: true,
    duplicate: false,
  });
  assert.equal(steered.length, 1);
  assert.deepEqual(queuedSpy.mock.calls, [[sent.details.requestId]]);
  assert.deepEqual(interruptSpy.mock.calls, [[spawned.details.jobId]]);
  assert.ok((queuedSpy.mock.invocationCallOrder[0] ?? 0) < (interruptSpy.mock.invocationCallOrder[0] ?? 0));
  assert.match(steered[0] ?? "", /MAIN_AGENT_REQUEST.*Report findings/is);
  assert.match(steered[0] ?? "", /not the user/i);
  assert.match(steered[0] ?? "", /subagent_send.*requestId/i);
  assert.equal((steered[0] ?? "").includes(String.fromCharCode(27)), false);

  const parentWait = waitFor(mock, context, String(spawned.details.jobId));
  const client = createBrokerClient(request.communication);
  const responded = await client.send(
    { requestId: String(sent.details.requestId), message: "Found two races.\u001b[32m" },
    undefined,
  );
  assert.deepEqual(responded, {
    requestId: sent.details.requestId,
    accepted: true,
    duplicate: false,
  });
  assert.deepEqual((await parentWait).details, {
    jobId: spawned.details.jobId,
    state: "running",
    timedOut: false,
    interrupted: true,
    reason: "subagent_message",
  });
  const responseDelivery = mock.sentMessages.find(
    (entry) =>
      (entry.message as { customType?: string; details?: { kind?: string } }).customType === "pi-subagents-message" &&
      (entry.message as { details?: { kind?: string } }).details?.kind === "response",
  );
  assert.ok(responseDelivery);
  assert.deepEqual(responseDelivery.options, { deliverAs: "steer", triggerTurn: true });
  const responseContent = (responseDelivery.message as { content: string }).content;
  assert.match(responseContent, /SUBAGENT_RESPONSE.*Found two races/is);
  assert.equal(responseContent.includes(String.fromCharCode(27)), false);
  assert.deepEqual(
    await client.send({ requestId: String(sent.details.requestId), message: "replacement" }, undefined),
    { requestId: sent.details.requestId, accepted: false, duplicate: true },
  );
  await cancelJob(mock, context, String(spawned.details.jobId));
});

test("delivers maximum main messages intact inside bounded protocol envelopes", async () => {
  const steered: string[] = [];
  const { mock, context } = await setup({
    runChild: async (candidate) => {
      candidate.onControl?.({
        async send(message) {
          steered.push(message);
        },
      });
      return waitForCancellation(candidate);
    },
  });
  const spawned = await spawnJob(mock, context, "Receive large questions");
  const payloads = ["q".repeat(MAX_MESSAGE_BYTES), Array.from({ length: MAX_MESSAGE_LINES }, () => "q").join("\n")];
  for (const [index, message] of payloads.entries()) {
    const sent = await tool(mock, "subagent_send").execute(
      `send-boundary-${index}`,
      { recipient: spawned.details.jobId, message },
      undefined,
      undefined,
      context.ctx,
    );
    assert.equal(sent.details.accepted, true);
  }
  assert.equal(steered.length, payloads.length);
  for (const [index, content] of steered.entries()) {
    assert.ok(Buffer.byteLength(content, "utf8") <= MAX_MODEL_TEXT_BYTES);
    assert.ok(content.split("\n").length <= MAX_MODEL_TEXT_LINES);
    assert.ok(content.endsWith(`Request:\n${payloads[index]}`));
    assert.doesNotMatch(content, /… \[truncated\]/u);
  }
  await cancelJob(mock, context, String(spawned.details.jobId));
});

test("replays a child response once when it arrives before the main wait", async () => {
  let request!: ChildRequest;
  const { mock, context } = await setup({
    runChild: async (candidate) => {
      request = candidate;
      candidate.onControl?.({ async send() {} });
      return waitForCancellation(candidate);
    },
  });
  const spawned = await spawnJob(mock, context, "Respond before main waits");
  const sent = await tool(mock, "subagent_send").execute(
    "send-before-wait",
    { recipient: spawned.details.jobId, message: "Reply immediately" },
    undefined,
    undefined,
    context.ctx,
  );
  const client = createBrokerClient(request.communication);
  await client.send({ requestId: String(sent.details.requestId), message: "Already answered" }, undefined);

  assert.deepEqual((await waitFor(mock, context, String(spawned.details.jobId))).details, {
    jobId: spawned.details.jobId,
    state: "running",
    timedOut: false,
    interrupted: true,
    reason: "subagent_message",
  });
  assert.deepEqual(
    (
      await tool(mock, "subagent_wait").execute(
        "second-wait",
        { jobId: spawned.details.jobId, timeout: 0.001 },
        undefined,
        undefined,
        context.ctx,
      )
    ).details,
    { jobId: spawned.details.jobId, state: "running", timedOut: true },
  );
  await cancelJob(mock, context, String(spawned.details.jobId));
});

test("preserves a main request when cancellation races with queued RPC delivery", async () => {
  let request!: ChildRequest;
  let steered = "";
  let resolveSendStarted!: () => void;
  let releaseSend!: () => void;
  const sendStarted = new Promise<void>((resolve) => {
    resolveSendStarted = resolve;
  });
  const sendReleased = new Promise<void>((resolve) => {
    releaseSend = resolve;
  });
  const { mock, context } = await setup({
    runChild: async (candidate) => {
      request = candidate;
      candidate.onControl?.({
        async send(message, signal) {
          assert.equal(signal, undefined);
          steered = message;
          resolveSendStarted();
          await sendReleased;
        },
      });
      return waitForCancellation(candidate);
    },
  });
  const spawned = await spawnJob(mock, context, "Long RPC send");
  const controller = new AbortController();
  const pending = tool(mock, "subagent_send").execute(
    "cancel-in-flight",
    { recipient: spawned.details.jobId, message: "Cancel this request" },
    controller.signal,
    undefined,
    context.ctx,
  );
  await sendStarted;
  controller.abort();
  await assert.rejects(pending, (error: Error) => error.name === "AbortError");

  const requestId = steered.match(/^Request ID: (req_[^\n]+)$/mu)?.[1];
  assert.ok(requestId);
  const client = createBrokerClient(request.communication);
  assert.deepEqual(await client.send({ requestId, message: "Response after caller cancellation" }, undefined), {
    requestId,
    accepted: true,
    duplicate: false,
  });
  releaseSend();
  await cancelJob(mock, context, String(spawned.details.jobId));
});

test("rolls back failed or cancelled main sends and rejects invalid selectors", async () => {
  let failDelivery = true;
  let request!: ChildRequest;
  const { mock, context } = await setup({
    runChild: async (candidate) => {
      request = candidate;
      candidate.onControl?.({
        async send() {
          if (failDelivery) throw new Error("synthetic steer failure");
        },
      });
      return waitForCancellation(candidate);
    },
  });
  const spawned = await spawnJob(mock, context, "Long task");
  await Promise.resolve();
  for (let index = 0; index < 5; index++) {
    await assert.rejects(
      () =>
        tool(mock, "subagent_send").execute(
          `failed-${index}`,
          { recipient: spawned.details.jobId, message: `Request ${index}` },
          undefined,
          undefined,
          context.ctx,
        ),
      /synthetic steer failure/i,
    );
  }
  failDelivery = false;
  const accepted = await tool(mock, "subagent_send").execute(
    "accepted",
    { recipient: spawned.details.jobId, message: "Accepted request" },
    undefined,
    undefined,
    context.ctx,
  );
  assert.equal(accepted.details.accepted, true);
  for (const params of [
    { message: "missing selector" },
    { recipient: spawned.details.jobId, requestId: accepted.details.requestId, message: "both" },
    { recipient: "main", message: "wrong recipient" },
    { requestId: accepted.details.requestId, message: "answer own request" },
  ]) {
    await assert.rejects(() =>
      tool(mock, "subagent_send").execute("invalid", params, undefined, undefined, context.ctx),
    );
  }
  await cancelJob(mock, context, String(spawned.details.jobId));
  await assert.rejects(() =>
    tool(mock, "subagent_send").execute(
      "terminal",
      { recipient: spawned.details.jobId, message: "late" },
      undefined,
      undefined,
      context.ctx,
    ),
  );
  assert.equal(request.signal.aborted, true);

  let queuedRequest!: ChildRequest;
  const queued = await setup({
    runChild: async (candidate) => {
      queuedRequest = candidate;
      return waitForCancellation(candidate);
    },
  });
  const queuedJob = await spawnJob(queued.mock, queued.context, "Queued send");
  const controller = new AbortController();
  const pendingSend = tool(queued.mock, "subagent_send").execute(
    "cancelled-send",
    { recipient: queuedJob.details.jobId, message: "cancel me" },
    controller.signal,
    undefined,
    queued.context.ctx,
  );
  await Promise.resolve();
  controller.abort();
  await assert.rejects(pendingSend, (error: Error) => error.name === "AbortError");
  await cancelJob(queued.mock, queued.context, String(queuedJob.details.jobId));
  assert.equal(queuedRequest.signal.aborted, true);
});

test("delivers maximum child messages intact inside bounded protocol envelopes", async () => {
  let request!: ChildRequest;
  const { mock, context } = await setup({
    runChild: async (candidate) => {
      request = candidate;
      return waitForCancellation(candidate);
    },
  });
  const spawned = await spawnJob(mock, context, "Ask large questions");
  await Promise.resolve();
  const client = createBrokerClient(request.communication);
  const payloads = ["q".repeat(MAX_MESSAGE_BYTES), Array.from({ length: MAX_MESSAGE_LINES }, () => "q").join("\n")];
  for (const message of payloads) {
    await client.send({ recipient: "main", message }, undefined);
  }
  const deliveries = mock.sentMessages.filter(
    (entry) => (entry.message as { customType?: string }).customType === "pi-subagents-message",
  );
  assert.equal(deliveries.length, payloads.length);
  for (const [index, delivery] of deliveries.entries()) {
    const content = (delivery.message as { content: string }).content;
    assert.ok(Buffer.byteLength(content, "utf8") <= MAX_MODEL_TEXT_BYTES);
    assert.ok(content.split("\n").length <= MAX_MODEL_TEXT_LINES);
    assert.ok(content.endsWith(`Request:\n${payloads[index]}`));
    assert.doesNotMatch(content, /… \[truncated\]/u);
  }
  await cancelJob(mock, context, String(spawned.details.jobId));
});

test("sanitizes terminal controls at child-output display boundaries", async () => {
  const raw = "reported\u001b[31m output";
  const { mock, context } = await setup({ runChild: async () => completed(raw) });
  const spawned = await spawnJob(mock, context, "Report output");
  const waited = await waitFor(mock, context, String(spawned.details.jobId));
  assert.equal(waited.details.result, raw);
  assert.equal(waited.content[0]?.text.includes(String.fromCharCode(27)), false);
  const completion = mock.sentMessages.find(
    (entry) => (entry.message as { customType?: string }).customType === "pi-subagents-completion",
  );
  assert.ok(completion);
  assert.equal((completion.message as { content: string }).content.includes(String.fromCharCode(27)), false);
});

test("bounds tool and completion text after JSON serialization", async () => {
  const raw = '"\\'.repeat(16 * 1024);
  assert.ok(Buffer.byteLength(raw, "utf8") < MAX_MODEL_TEXT_BYTES);
  const { mock, context } = await setup({ runChild: async () => completed(raw) });
  const spawned = await spawnJob(mock, context, "Report quoted output");
  const waited = await waitFor(mock, context, String(spawned.details.jobId));
  assert.equal(waited.details.result, raw);
  assertModelTextBounded(waited.content[0]?.text ?? "");
  const completion = mock.sentMessages.find(
    (entry) => (entry.message as { customType?: string }).customType === "pi-subagents-completion",
  );
  assert.ok(completion);
  assertModelTextBounded((completion.message as { content: string }).content);
});

test("publishes cancellation only after child teardown settles", async () => {
  let aborted = false;
  let releaseTeardown!: () => void;
  const { mock, context } = await setup({
    runChild: ({ signal }) =>
      new Promise<ChildResult>((resolve) => {
        signal.addEventListener(
          "abort",
          () => {
            aborted = true;
            releaseTeardown = () => resolve(cancelled());
          },
          { once: true },
        );
      }),
  });
  const spawned = await spawnJob(mock, context, "Writer");
  const jobId = String(spawned.details.jobId);
  await Promise.resolve();
  const waiter = waitFor(mock, context, jobId);
  let waiterSettled = false;
  void waiter.then(() => {
    waiterSettled = true;
  });
  const cancellation = cancelJob(mock, context, jobId);
  let cancellationSettled = false;
  void cancellation.then(() => {
    cancellationSettled = true;
  });
  await Promise.resolve();
  assert.equal(aborted, true);
  assert.equal(waiterSettled, false);
  assert.equal(cancellationSettled, false);
  assert.equal(
    mock.sentMessages.some(
      (entry) => (entry.message as { customType?: string }).customType === "pi-subagents-completion",
    ),
    false,
  );
  releaseTeardown();
  assert.equal((await cancellation).details.state, "cancelled");
  assert.equal((await waiter).details.state, "cancelled");
  assert.equal(
    mock.sentMessages.filter(
      (entry) => (entry.message as { customType?: string }).customType === "pi-subagents-completion",
    ).length,
    1,
  );
});

test("wait timeout leaves a job active and cancellation rejects stale output", async () => {
  let resolveChild!: (result: ChildResult) => void;
  const { mock, context } = await setup({
    runChild: ({ signal }) =>
      new Promise<ChildResult>((resolve) => {
        resolveChild = resolve;
        signal.addEventListener("abort", () => resolve(completed("stale completion")), {
          once: true,
        });
      }),
  });
  const spawned = await spawnJob(mock, context, "review task");
  const jobId = String(spawned.details.jobId);
  await Promise.resolve();
  assert.deepEqual(
    (await tool(mock, "subagent_wait").execute("wait", { jobId, timeout: 0.001 }, undefined, undefined, context.ctx))
      .details,
    { jobId, state: "running", timedOut: true },
  );
  assert.deepEqual((await cancelJob(mock, context, jobId)).details, {
    jobId,
    state: "cancelled",
  });
  resolveChild(completed("another stale completion"));
  await Promise.resolve();
  const terminal = await waitFor(mock, context, jobId);
  assert.equal(terminal.details.state, "cancelled");
  assert.doesNotMatch(JSON.stringify(terminal.details), /stale completion/);
});

test("jobs share the eight-job capacity", async () => {
  const { mock, context } = await setup({ runChild: waitForCancellation });
  const jobIds: string[] = [];
  for (let index = 0; index < 8; index++) {
    const result = await spawnJob(mock, context, `Job ${index}`);
    jobIds.push(String(result.details.jobId));
  }
  await assert.rejects(() => spawnJob(mock, context, "Ninth"), /limit reached \(8\)/i);
  await Promise.all(jobIds.map((jobId) => cancelJob(mock, context, jobId)));
});

test("broker startup failure leaves inspect available and prevents child launch", async () => {
  let launched = false;
  const { mock, context } = await setup({
    runChild: async () => {
      launched = true;
      return completed("unexpected");
    },
    createBroker: (onMessage) =>
      new MessageBroker({
        onMessage,
        createServer: () => {
          throw new Error("synthetic bind failure");
        },
      }),
  });
  const inspected = await tool(mock, "subagent_inspect").execute("inspect", {}, undefined, undefined, context.ctx);
  assert.deepEqual(inspected.details, { jobs: [], omitted: { jobs: 0 } });
  await assert.rejects(
    () => spawnJob(mock, context, "must not launch"),
    /messaging is unavailable.*synthetic bind failure/i,
  );
  assert.equal(launched, false);
});

test("session shutdown waits for child teardown without delivering stale completion", async () => {
  let aborted = false;
  let releaseTeardown!: () => void;
  const { mock, context } = await setup({
    runChild: ({ signal }) =>
      new Promise<ChildResult>((resolve) => {
        signal.addEventListener(
          "abort",
          () => {
            aborted = true;
            releaseTeardown = () => resolve(cancelled());
          },
          { once: true },
        );
      }),
  });
  await spawnJob(mock, context, "Old writer");
  await Promise.resolve();
  const shutdown = emit(mock, "session_shutdown", { reason: "reload" }, context.ctx);
  let shutdownSettled = false;
  void shutdown.then(() => {
    shutdownSettled = true;
  });
  await Promise.resolve();
  assert.equal(aborted, true);
  assert.equal(shutdownSettled, false);
  releaseTeardown();
  await shutdown;
  assert.equal(shutdownSettled, true);
  assert.equal(
    mock.sentMessages.some(
      (entry) => (entry.message as { customType?: string }).customType === "pi-subagents-completion",
    ),
    false,
  );
});

test("session replacement cancels old jobs and permits a clean new session", async () => {
  const requests: ChildRequest[] = [];
  const { mock, context } = await setup({
    runChild: async (request) => {
      requests.push(request);
      return waitForCancellation(request);
    },
  });
  await spawnJob(mock, context, "Old session");
  await Promise.resolve();
  const oldClient = createBrokerClient(requests[0]?.communication as ChildRequest["communication"]);
  await emit(mock, "session_start", { reason: "new" }, context.ctx);
  assert.equal(requests[0]?.signal.aborted, true);
  await assert.rejects(() => oldClient.send({ recipient: "main", message: "stale session" }, undefined));
  const next = await spawnJob(mock, context, "New session");
  assert.equal(next.details.state, "queued");
});

async function setup(
  dependencies: SubagentsDependencies = {},
  mockOptions: Parameters<typeof createMockPi>[0] = {},
  contextOverrides: Record<string, unknown> = {},
) {
  const mock = createMockPi(mockOptions);
  const context = createMockContext({
    model: { provider: "test-provider", id: "test-model" },
    modelRegistry: {
      getProviderAuthStatus: () => ({ configured: true, source: "environment" as const }),
      getRegisteredProviderIds: () => [],
    },
    ...contextOverrides,
  });
  subagents(mock.pi, dependencies);
  await emit(mock, "session_start", { reason: "startup" }, context.ctx);
  activeSessions.push({ mock, context });
  return { mock, context };
}

async function emit(mock: Mock, event: string, payload: unknown, context: unknown): Promise<void> {
  for (const handler of mock.events.get(event) ?? []) await handler(payload, context);
}

function tool(mock: Mock, name: string): RegisteredTool {
  const registered = (mock.tools as unknown as RegisteredTool[]).find((candidate) => candidate.name === name);
  assert.ok(registered, `Missing tool ${name}`);
  return registered;
}

function spawnJob(mock: Mock, context: Context, task: string) {
  return tool(mock, "subagent_spawn").execute("spawn", { task }, undefined, undefined, context.ctx);
}

function waitFor(mock: Mock, context: Context, jobId: string) {
  return tool(mock, "subagent_wait").execute("wait", { jobId }, undefined, undefined, context.ctx);
}

function cancelJob(mock: Mock, context: Context, jobId: string) {
  return tool(mock, "subagent_cancel").execute("cancel", { jobId }, undefined, undefined, context.ctx);
}

async function waitForCancellation(request: Pick<ChildRequest, "signal">): Promise<ChildResult> {
  await new Promise<void>((resolve) => request.signal.addEventListener("abort", () => resolve(), { once: true }));
  return cancelled();
}

function completed(result: string): ChildResult {
  return { state: "completed", result, limitations: [], truncated: false };
}

function identityTheme(): Theme {
  return {
    fg: (_role: string, text: string) => text,
  } as Theme;
}

function cancelled(): ChildResult {
  return {
    state: "cancelled",
    error: "cancelled",
    limitations: [],
    truncated: false,
  };
}

function providerVisibleDefinition(tool: RegisteredTool) {
  return {
    name: tool.name,
    label: tool.label,
    description: tool.description,
    promptSnippet: tool.promptSnippet,
    parameters: tool.parameters,
  };
}

function assertModelTextBounded(text: string): void {
  assert.ok(Buffer.byteLength(text, "utf8") <= MAX_MODEL_TEXT_BYTES);
  assert.ok(text.split("\n").length <= MAX_MODEL_TEXT_LINES);
  assert.match(text, /… \[truncated\]$/u);
}
