import assert from "node:assert/strict";
import { afterEach, test, vi } from "vitest";
import { createMockContext } from "../../../test/support.js";
import { setBrowserManagerOperationsForTests } from "../src/browser-manager.js";
import { applyRuntimeWebMcpSetting, invalidateWebMcpOperations, state } from "../src/runtime.js";
import { executeWebMcpCallTool, executeWebMcpListTool } from "../src/webmcp/tools.js";

const PAGE_ID = "page-1";
const FRAME_ID = "frame-1";
const PAGE_URL = "https://example.test/app";

interface ScenarioTool {
  annotations?: Record<string, boolean>;
  description: string;
  frameId: string;
  inputSchema?: Record<string, unknown>;
  name: string;
  title?: string;
}

interface Scenario {
  currentPageTitle?: () => string;
  currentPageUrl?: () => string;
  onPageLookup?: (lookupIndex: number) => void;
  protocolAvailable?: boolean;
  frameUrl?: (socketIndex: number) => string;
  invocation?: {
    identityChange?: "navigation" | "tool-added" | "tool-removed";
    malformedResponse?: boolean;
    omitResponse?: boolean;
    oversizedResponse?: boolean;
    onStarted?: () => void;
    output?: unknown;
    status?: "Canceled" | "Completed" | "Error";
    errorText?: string;
  };
  loaderId?: (socketIndex: number, frameReadIndex: number) => string;
  tools?: (socketIndex: number) => ScenarioTool[];
}

const defaultTool: ScenarioTool = {
  annotations: { readOnly: true },
  description: "Read page state",
  frameId: FRAME_ID,
  inputSchema: { type: "object", properties: { query: { type: "string" } } },
  name: "read_state",
  title: "Read state",
};

let restoreBrowserOperations: (() => void) | undefined;

afterEach(() => {
  restoreBrowserOperations?.();
  restoreBrowserOperations = undefined;
  vi.unstubAllGlobals();
  vi.useRealTimers();
  state.sessionController.abort();
  state.sessionController = new AbortController();
  state.sessionGeneration += 1;
  state.managedBrowser = undefined;
});

async function withScenario<T>(scenario: Scenario, run: (transport: ScriptedTransport) => Promise<T>) {
  state.host = "127.0.0.1";
  state.port = 9222;
  state.configuredPort = 9222;
  state.portConfigured = true;
  state.autoLaunchEnabled = false;
  state.shuttingDown = false;
  state.sessionController = new AbortController();
  state.sessionGeneration += 1;
  const transport = new ScriptedTransport(scenario);
  let pageLookups = 0;
  vi.stubGlobal("WebSocket", transport.WebSocketConstructor);
  restoreBrowserOperations = setBrowserManagerOperationsForTests({
    fetch: async (input) => {
      const url = new URL(input);
      if (url.pathname === "/json/version") return jsonResponse({ Browser: "Chrome/151" });
      if (url.pathname === "/json/protocol") {
        return jsonResponse(scenario.protocolAvailable === false ? { domains: [] } : protocolDescription());
      }
      if (url.pathname === "/json/list") {
        scenario.onPageLookup?.(pageLookups);
        pageLookups += 1;
        return jsonResponse([
          {
            id: PAGE_ID,
            type: "page",
            title: scenario.currentPageTitle?.() ?? "Example",
            url: scenario.currentPageUrl?.() ?? PAGE_URL,
            webSocketDebuggerUrl: `ws://127.0.0.1/devtools/page/${PAGE_ID}`,
          },
        ]);
      }
      throw new Error(`Unexpected DevTools request: ${url.pathname}`);
    },
  });
  return run(transport);
}

test("discovers frame-aware tools with event-before-response correlation and bounded safe output", async () => {
  await withScenario(
    {
      tools: () => [
        {
          ...defaultTool,
          name: "read\u001b]8;;bad\u0007_state\u202e",
          description: "Read\nstate",
        },
      ],
    },
    async () => {
      const { ctx } = createWebMcpContext({ mode: "tui", hasUI: true });
      const result = await executeWebMcpListTool({}, undefined, ctx);
      assert.equal(result.details.toolCount, 1);
      assert.equal(result.details.truncated, false);
      assert.equal(result.details.identities[0]?.frameOrigin, "https://example.test");
      assert.equal(result.details.identities[0]?.sessionGeneration.includes(":"), true);
      const text = result.content[0]?.text ?? "";
      assert.equal(text.includes("read\\u001b]8;;bad\\u0007_state�"), true);
      assert.equal(text.includes(String.fromCodePoint(0x1b)), false);
      assert.equal(text.includes(String.fromCodePoint(0x202e)), false);
    },
  );
});

test("rejects an inventory assembled across a frame document reload", async () => {
  await withScenario(
    {
      loaderId: (_socketIndex, frameReadIndex) => (frameReadIndex === 0 ? "loader-before" : "loader-after"),
      tools: () => [defaultTool],
    },
    async () => {
      await assert.rejects(
        executeWebMcpListTool({}, undefined, approvingContext().ctx),
        /document changed while Chrome was publishing its tool inventory/u,
      );
    },
  );
});

test("rejects a same-URL reload during the final page lookup before invocation", async () => {
  let loaderId = "loader-1";
  let reloadOnLookup = false;
  await withScenario(
    {
      loaderId: () => loaderId,
      onPageLookup: () => {
        if (reloadOnLookup) loaderId = "loader-reloaded";
      },
      tools: () => [defaultTool],
    },
    async (transport) => {
      const listed = await executeWebMcpListTool({}, undefined, approvingContext().ctx);
      const identity = listed.details.identities[0];
      const { ctx } = createWebMcpContext({
        mode: "tui",
        hasUI: true,
        confirm: async () => {
          reloadOnLookup = true;
          return true;
        },
      });
      await assert.rejects(
        executeWebMcpCallTool({ ...identity, toolName: identity.name, input: {} }, undefined, ctx),
        /document changed during the final page identity check/u,
      );
      assert.equal(transport.invocations, 0);
    },
  );
});

test("cancels invocation-boundary work when the document or selected tool changes", async () => {
  for (const identityChange of ["navigation", "tool-added", "tool-removed"] as const) {
    await withScenario(
      {
        tools: () => [defaultTool],
        invocation: { identityChange },
      },
      async (transport) => {
        const { ctx } = approvingContext();
        const listed = await executeWebMcpListTool({}, undefined, ctx);
        const identity = listed.details.identities[0];
        await assert.rejects(
          executeWebMcpCallTool({ ...identity, toolName: identity.name, input: {} }, undefined, ctx),
          /document or tool changed.*invocation boundary/u,
        );
        assert.equal(transport.invocations, 1);
        assert.equal(transport.cancelInvocations, 1);
        assert.equal(transport.openSocketCount(), 0);
      },
    );
  }
});

test("reports unsupported browsers and malformed WebMCP protocol events", async () => {
  await withScenario({ protocolAvailable: false }, async (transport) => {
    await assert.rejects(
      executeWebMcpListTool({}, undefined, approvingContext().ctx),
      /does not expose.*WebMCP domain/u,
    );
    assert.equal(transport.sockets.length, 0);
  });

  await withScenario(
    {
      tools: () => [{ ...defaultTool, frameId: 42 }] as unknown as ScenarioTool[],
    },
    async () => {
      await assert.rejects(
        executeWebMcpListTool({}, undefined, approvingContext().ctx),
        /malformed WebMCP\.toolsAdded/u,
      );
    },
  );
});

test("sanitizes page-resolution failures before returning tool errors", async () => {
  await withScenario(
    {
      currentPageTitle: () => "malicious\u001b]8;;https://evil\u0007title\u202e",
      currentPageUrl: () => "https://example.test/\u001b[31mred",
    },
    async () => {
      const stalePageId = "missing\u001b]8;;https://evil\u0007page\u202e";
      const { ctx } = approvingContext();
      const operations = [
        () => executeWebMcpListTool({ pageId: stalePageId }, undefined, ctx),
        () =>
          executeWebMcpCallTool(
            {
              documentId: "loader-1",
              frameId: FRAME_ID,
              frameOrigin: "https://example.test",
              input: {},
              pageId: stalePageId,
              schemaDigest: "0".repeat(64),
              sessionGeneration: "0:0",
              toolName: defaultTool.name,
            },
            undefined,
            ctx,
          ),
      ];
      for (const operation of operations) {
        let caught: unknown;
        try {
          await operation();
        } catch (error) {
          caught = error;
        }
        assert.ok(caught instanceof Error);
        assert.match(caught.message, /Chrome DevTools page not found/u);
        assert.match(caught.message, /malicioustitle�/u);
        for (const control of ["\u001b", "\u0007", "\u202e"]) {
          assert.equal(caught.message.includes(control), false);
        }
      }
    },
  );
});

test("requires confirmation for both read-only and mutation-capable page tools", async () => {
  for (const readOnly of [true, false]) {
    await withScenario(
      {
        tools: () => [{ ...defaultTool, annotations: { readOnly } }],
        invocation: { output: { ok: true } },
      },
      async () => {
        let confirmation = "";
        const { ctx } = createWebMcpContext({
          mode: "tui",
          hasUI: true,
          confirm: async (title: string, message: string) => {
            confirmation = `${title}\n${message}`;
            return true;
          },
        });
        const listed = await executeWebMcpListTool({}, undefined, ctx);
        const identity = listed.details.identities[0];
        const called = await executeWebMcpCallTool(
          { ...identity, toolName: identity.name, input: { query: "status" } },
          undefined,
          ctx,
        );
        assert.match(confirmation, /Allow WebMCP tool/u);
        assert.match(confirmation, /annotations are untrusted/u);
        assert.match(called.content[0]?.text ?? "", /"ok": true/u);
      },
    );
  }
});

test("cancellation and non-interactive modes prevent page invocation", async () => {
  await withScenario({ tools: () => [defaultTool] }, async (transport) => {
    const { ctx: printContext } = createWebMcpContext({ mode: "print", hasUI: false });
    const listed = await executeWebMcpListTool({}, undefined, printContext);
    const identity = listed.details.identities[0];
    await assert.rejects(
      executeWebMcpCallTool({ ...identity, toolName: identity.name, input: {} }, undefined, printContext),
      /requires observable confirmation/u,
    );
    assert.equal(transport.invocations, 0);

    const { ctx: cancelledContext } = createWebMcpContext({
      mode: "rpc",
      hasUI: true,
      confirm: async () => false,
    });
    await assert.rejects(
      executeWebMcpCallTool({ ...identity, toolName: identity.name, input: {} }, undefined, cancelledContext),
      /cancelled by the user/u,
    );
    assert.equal(transport.invocations, 0);
  });
});

test("call-time rediscovery rejects changed schemas, removed tools, frames, and navigation", async () => {
  await withScenario(
    {
      tools: (index) =>
        index < 2
          ? [defaultTool]
          : [
              {
                ...defaultTool,
                inputSchema: { type: "object", properties: { changed: { type: "boolean" } } },
              },
            ],
    },
    async () => {
      const { ctx } = approvingContext();
      const listed = await executeWebMcpListTool({}, undefined, ctx);
      const identity = listed.details.identities[0];
      await assert.rejects(
        executeWebMcpCallTool({ ...identity, toolName: identity.name, input: {} }, undefined, ctx),
        /schema or annotations changed/u,
      );
    },
  );

  for (const scenario of [
    { tools: (index: number) => (index < 2 ? [defaultTool] : []) },
    {
      tools: () => [defaultTool],
      frameUrl: (index: number) => (index < 2 ? PAGE_URL : "about:blank#removed"),
    },
    {
      tools: () => [defaultTool],
      loaderId: (index: number) => (index < 2 ? "loader-1" : "loader-reloaded"),
    },
  ]) {
    await withScenario(scenario, async () => {
      const { ctx } = approvingContext();
      const listed = await executeWebMcpListTool({}, undefined, ctx);
      const identity = listed.details.identities[0];
      await assert.rejects(
        executeWebMcpCallTool({ ...identity, toolName: identity.name, input: {} }, undefined, ctx),
        /no longer available|frame origin.*changed|document changed/u,
      );
    });
  }

  let pageUrl = PAGE_URL;
  await withScenario({ tools: () => [defaultTool], currentPageUrl: () => pageUrl }, async () => {
    const listed = await executeWebMcpListTool({}, undefined, approvingContext().ctx);
    const identity = listed.details.identities[0];
    const { ctx } = createWebMcpContext({
      mode: "tui",
      hasUI: true,
      confirm: async () => {
        pageUrl = "https://example.test/navigated";
        return true;
      },
    });
    await assert.rejects(
      executeWebMcpCallTool({ ...identity, toolName: identity.name, input: {} }, undefined, ctx),
      /navigated or was replaced/u,
    );
  });
});

test("forwards Pi cancellation to Chrome and releases the invocation", async () => {
  const controller = new AbortController();
  await withScenario(
    {
      tools: () => [defaultTool],
      invocation: {
        onStarted: () => controller.abort(new Error("Pi cancelled WebMCP")),
      },
    },
    async (transport) => {
      const { ctx } = approvingContext();
      const listed = await executeWebMcpListTool({}, undefined, ctx);
      const identity = listed.details.identities[0];
      await assert.rejects(
        executeWebMcpCallTool({ ...identity, toolName: identity.name, input: {} }, controller.signal, ctx),
        /Pi cancelled WebMCP/u,
      );
      assert.equal(transport.cancelInvocations, 1);
      assert.equal(transport.openSocketCount(), 0);
    },
  );
});

test("cancels a started invocation when the completion event is malformed", async () => {
  await withScenario(
    {
      tools: () => [defaultTool],
      invocation: { malformedResponse: true },
    },
    async (transport) => {
      const { ctx } = approvingContext();
      const listed = await executeWebMcpListTool({}, undefined, ctx);
      const identity = listed.details.identities[0];
      await assert.rejects(
        executeWebMcpCallTool({ ...identity, toolName: identity.name, input: {} }, undefined, ctx),
        /malformed WebMCP\.toolResponded/u,
      );
      assert.equal(transport.cancelInvocations, 1);
      assert.equal(transport.openSocketCount(), 0);
    },
  );
});

test("cancels a started invocation when its completion exceeds the CDP message cap", async () => {
  await withScenario(
    {
      tools: () => [defaultTool],
      invocation: { oversizedResponse: true },
    },
    async (transport) => {
      const { ctx } = approvingContext();
      const listed = await executeWebMcpListTool({}, undefined, ctx);
      const identity = listed.details.identities[0];
      await assert.rejects(
        executeWebMcpCallTool({ ...identity, toolName: identity.name, input: {} }, undefined, ctx),
        /message exceeds the 8 MB limit/u,
      );
      assert.equal(transport.cancelInvocations, 1);
      assert.equal(transport.openSocketCount(), 0);
    },
  );
});

test("cancels a started invocation when completion times out", async () => {
  await withScenario(
    {
      tools: () => [defaultTool],
      invocation: { omitResponse: true },
    },
    async (transport) => {
      const { ctx } = approvingContext();
      const listed = await executeWebMcpListTool({}, undefined, ctx);
      const identity = listed.details.identities[0];
      vi.useFakeTimers();
      const calling = executeWebMcpCallTool({ ...identity, toolName: identity.name, input: {} }, undefined, ctx);
      const rejected = assert.rejects(calling, /Timed out waiting for CDP event/u);
      await vi.advanceTimersByTimeAsync(10_001);
      await rejected;
      assert.equal(transport.cancelInvocations, 1);
      assert.equal(transport.openSocketCount(), 0);
    },
  );
});

test("surfaces page exceptions safely and truncates completed output", async () => {
  await withScenario(
    {
      tools: () => [defaultTool],
      invocation: { status: "Error", errorText: "bad\u001b]8;;link\u0007 tool" },
    },
    async () => {
      const { ctx } = approvingContext();
      const listed = await executeWebMcpListTool({}, undefined, ctx);
      const identity = listed.details.identities[0];
      await assert.rejects(
        executeWebMcpCallTool({ ...identity, toolName: identity.name, input: {} }, undefined, ctx),
        /WebMCP tool failed: bad tool/u,
      );
    },
  );

  await withScenario(
    {
      tools: () => [defaultTool],
      invocation: {
        output: { items: Array.from({ length: 3_000 }, (_value, index) => `item-${index}`) },
      },
    },
    async () => {
      const { ctx } = approvingContext();
      const listed = await executeWebMcpListTool({}, undefined, ctx);
      const identity = listed.details.identities[0];
      const result = await executeWebMcpCallTool({ ...identity, toolName: identity.name, input: {} }, undefined, ctx);
      assert.equal(result.details.truncated, true);
      assert.ok(Buffer.byteLength(result.content[0]?.text ?? "", "utf8") <= 50 * 1024);
      assert.match(result.content[0]?.text ?? "", /WebMCP output truncated/u);
    },
  );
});

test("browser replacement aborts an active confirmation and invalidates the identity", async () => {
  await withScenario({ tools: () => [defaultTool] }, async () => {
    const listed = await executeWebMcpListTool({}, undefined, approvingContext().ctx);
    const identity = listed.details.identities[0];
    const mock = createWebMcpContext({
      mode: "rpc",
      hasUI: true,
      confirm: async () => {
        invalidateWebMcpOperations(sessionOwner(mock.ctx), "browser replaced");
        return true;
      },
    });
    const { ctx } = mock;
    await assert.rejects(
      executeWebMcpCallTool({ ...identity, toolName: identity.name, input: {} }, undefined, ctx),
      /browser replaced/u,
    );
  });
});

function sessionOwner(ctx: unknown) {
  return (ctx as { sessionManager: object }).sessionManager;
}

function createWebMcpContext(options: Parameters<typeof createMockContext>[0]) {
  const mock = createMockContext(options);
  applyRuntimeWebMcpSetting(true, sessionOwner(mock.ctx));
  return mock;
}

function approvingContext() {
  return createWebMcpContext({ mode: "tui", hasUI: true, confirm: async () => true });
}

function jsonResponse(value: unknown) {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function protocolDescription() {
  return {
    domains: [
      {
        domain: "WebMCP",
        commands: ["enable", "disable", "invokeTool", "cancelInvocation"].map((name) => ({
          name,
        })),
        events: ["toolsAdded", "toolsRemoved", "toolInvoked", "toolResponded"].map((name) => ({
          name,
        })),
      },
    ],
  };
}

class ScriptedTransport {
  cancelInvocations = 0;
  invocations = 0;
  readonly sockets: ScriptedWebSocket[] = [];
  readonly WebSocketConstructor: new (
    url: string | URL,
  ) => WebSocket;

  constructor(readonly scenario: Scenario) {
    const transport = this;
    this.WebSocketConstructor = class extends ScriptedWebSocket {
      constructor(url: string | URL) {
        super(url, transport, transport.sockets.length);
        transport.sockets.push(this);
        queueMicrotask(() => this.open());
      }
    } as unknown as new (
      url: string | URL,
    ) => WebSocket;
  }

  openSocketCount() {
    return this.sockets.filter((socket) => !socket.closed).length;
  }
}

class ScriptedWebSocket extends EventTarget {
  closed = false;
  private frameReads = 0;
  readonly sentMethods: string[] = [];

  constructor(
    readonly url: string | URL,
    private readonly transport: ScriptedTransport,
    private readonly index: number,
  ) {
    super();
  }

  close() {
    this.closed = true;
  }

  open() {
    this.dispatchEvent(new Event("open"));
  }

  send(payload: string) {
    const request = JSON.parse(payload) as {
      id: number;
      method: string;
      params: Record<string, unknown>;
    };
    this.sentMethods.push(request.method);
    switch (request.method) {
      case "Page.enable":
        this.response(request.id, {});
        return;
      case "WebMCP.enable":
        this.event("WebMCP.toolsAdded", {
          tools: this.transport.scenario.tools?.(this.index) ?? [defaultTool],
        });
        this.response(request.id, {});
        return;
      case "Page.getFrameTree": {
        const frameReadIndex = this.frameReads;
        this.frameReads += 1;
        this.response(request.id, {
          frameTree: {
            frame: {
              id: FRAME_ID,
              loaderId: this.transport.scenario.loaderId?.(this.index, frameReadIndex) ?? "loader-1",
              url: this.transport.scenario.frameUrl?.(this.index) ?? PAGE_URL,
            },
          },
        });
        return;
      }
      case "WebMCP.invokeTool": {
        this.transport.invocations += 1;
        const invocationId = `invocation-${this.index}`;
        const invocation = this.transport.scenario.invocation ?? {};
        switch (invocation.identityChange) {
          case "navigation":
            this.event("Page.frameNavigated", {
              frame: { id: FRAME_ID, loaderId: "loader-reloaded", url: PAGE_URL },
            });
            break;
          case "tool-added":
            this.event("WebMCP.toolsAdded", {
              tools: [{ ...defaultTool, description: "Replacement implementation" }],
            });
            break;
          case "tool-removed":
            this.event("WebMCP.toolsRemoved", {
              tools: [{ frameId: FRAME_ID, name: defaultTool.name }],
            });
            break;
        }
        if (!invocation.oversizedResponse && !invocation.omitResponse) {
          this.event("WebMCP.toolResponded", {
            invocationId,
            status: invocation.malformedResponse ? "Malformed" : (invocation.status ?? "Completed"),
            ...(invocation.output === undefined ? { output: { ok: true } } : { output: invocation.output }),
            ...(invocation.errorText === undefined ? {} : { errorText: invocation.errorText }),
          });
        }
        this.response(request.id, { invocationId });
        if (invocation.oversizedResponse) {
          queueMicrotask(() => queueMicrotask(() => this.message("x".repeat(8 * 1024 * 1024 + 1))));
        }
        queueMicrotask(() => invocation.onStarted?.());
        return;
      }
      case "WebMCP.cancelInvocation":
        this.transport.cancelInvocations += 1;
        this.response(request.id, {});
        this.event("WebMCP.toolResponded", {
          invocationId: request.params.invocationId,
          status: "Canceled",
        });
        return;
      case "WebMCP.disable":
        this.response(request.id, {});
        return;
      default:
        throw new Error(`Unexpected CDP method: ${request.method}`);
    }
  }

  private event(method: string, params: unknown) {
    queueMicrotask(() => this.message({ method, params }));
  }

  private response(id: number, result: unknown) {
    queueMicrotask(() => this.message({ id, result }));
  }

  private message(payload: unknown) {
    this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(payload) }));
  }
}
