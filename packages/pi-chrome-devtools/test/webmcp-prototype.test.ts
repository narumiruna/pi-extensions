import assert from "node:assert/strict";
import { afterEach, test, vi } from "vitest";
import { createCdpBridge, executionExpression } from "../reference/webmcp/cdp.js";

const CONTROLLERS_KEY = Symbol.for("pi.webmcp.abort-controllers");

interface PageTool {
  inputSchema: Record<string, unknown>;
  name: string;
  origin: string;
}

afterEach(() => {
  vi.restoreAllMocks();
  delete (globalThis as unknown as Record<symbol, unknown>)[CONTROLLERS_KEY];
});

test("registers cancellation before discovery and never invokes after an abort", async () => {
  let resolveTools: ((tools: PageTool[]) => void) | undefined;
  const executeTool = vi.fn();
  const documentValue = {
    modelContext: {
      executeTool,
      getTools: () =>
        new Promise<PageTool[]>((resolve) => {
          resolveTools = resolve;
        }),
    },
  };
  const token = "cancel-during-discovery";
  const run = new Function(
    "document",
    `return ${executionExpression(token, {
      input: {},
      toolName: "mutate",
    })}`,
  ) as (document: typeof documentValue) => Promise<unknown>;

  const operation = run(documentValue);
  const controllers = (globalThis as unknown as Record<symbol, Map<string, AbortController>>)[CONTROLLERS_KEY];
  assert.ok(controllers?.has(token));
  controllers.get(token)?.abort(new Error("cancelled during discovery"));
  resolveTools?.([{ inputSchema: {}, name: "mutate", origin: "https://example.test" }]);

  await assert.rejects(operation, /cancelled during discovery/u);
  assert.equal(executeTool.mock.calls.length, 0);
  assert.equal(controllers.has(token), false);
});

test("does not start execution when cancellation wins the connection-ready race", async () => {
  const sockets: FakeWebSocket[] = [];
  class RecordingWebSocket extends FakeWebSocket {
    constructor(url: string | URL) {
      super(url);
      sockets.push(this);
    }
  }
  const bridge = createCdpBridge({
    endpoint: "http://127.0.0.1:9222",
    webSocketConstructor: RecordingWebSocket as unknown as new (url: string | URL) => WebSocket,
  });
  const controller = new AbortController();
  const execution = bridge.executeTool(
    {
      id: "page-1",
      title: "Example",
      type: "page",
      url: "https://example.test",
      webSocketDebuggerUrl: "ws://127.0.0.1/devtools/page/page-1",
    },
    { input: {}, toolName: "mutate" },
    controller.signal,
  );

  const socket = sockets[0];
  assert.ok(socket);
  socket.open();
  controller.abort(new Error("cancelled after readiness"));

  await assert.rejects(execution, /cancelled after readiness/u);
  assert.equal(socket.sent.length, 0);
  assert.equal(socket.closed, true);
});

test("rejects oversized CDP messages before parsing", async () => {
  const sockets: FakeWebSocket[] = [];
  class RecordingWebSocket extends FakeWebSocket {
    constructor(url: string | URL) {
      super(url);
      sockets.push(this);
    }
  }
  const bridge = createCdpBridge({
    endpoint: "http://127.0.0.1:9222",
    webSocketConstructor: RecordingWebSocket as unknown as new (url: string | URL) => WebSocket,
  });
  const inspection = bridge.inspectPage({
    id: "page-1",
    title: "Example",
    type: "page",
    url: "https://example.test",
    webSocketDebuggerUrl: "ws://127.0.0.1/devtools/page/page-1",
  });
  const socket = sockets[0];
  assert.ok(socket);
  socket.open();
  await vi.waitFor(() => assert.equal(socket.sent.length, 1));
  socket.message("x".repeat(8 * 1024 * 1024 + 1));

  await assert.rejects(inspection, /message exceeds the 8 MB limit/u);
  assert.equal(socket.closed, true);
});

test("starts a fresh operation deadline after WebSocket readiness", async () => {
  const timeoutControllers: AbortController[] = [];
  vi.spyOn(AbortSignal, "timeout").mockImplementation(() => {
    const controller = new AbortController();
    timeoutControllers.push(controller);
    return controller.signal;
  });

  const sockets: FakeWebSocket[] = [];
  class RecordingWebSocket extends FakeWebSocket {
    constructor(url: string | URL) {
      super(url);
      sockets.push(this);
    }
  }
  const bridge = createCdpBridge({
    endpoint: "http://127.0.0.1:9222",
    webSocketConstructor: RecordingWebSocket as unknown as new (url: string | URL) => WebSocket,
  });
  const inspection = bridge.inspectPage({
    id: "page-1",
    title: "Example",
    type: "page",
    url: "https://example.test",
    webSocketDebuggerUrl: "ws://127.0.0.1/devtools/page/page-1",
  });

  assert.equal(timeoutControllers.length, 1);
  const socket = sockets[0];
  assert.ok(socket);
  socket.open();
  await vi.waitFor(() => assert.equal(socket.sent.length, 1));
  assert.equal(timeoutControllers.length, 2);

  timeoutControllers[0]?.abort(new Error("expired connection deadline"));
  socket.respond({ result: { value: { supported: true, tools: [] } } });

  await assert.doesNotReject(inspection);
});

class FakeWebSocket extends EventTarget {
  closed = false;
  readonly sent: string[] = [];

  constructor(readonly url: string | URL) {
    super();
  }

  close(): void {
    this.closed = true;
    this.dispatchEvent(new Event("close"));
  }

  open(): void {
    this.dispatchEvent(new Event("open"));
  }

  message(data: string): void {
    this.dispatchEvent(new MessageEvent("message", { data }));
  }

  respond(result: unknown): void {
    const request = JSON.parse(this.sent.at(-1) ?? "null") as { id?: unknown };
    assert.equal(typeof request.id, "number");
    this.message(JSON.stringify({ id: request.id, result }));
  }

  send(payload: string): void {
    this.sent.push(payload);
  }
}
