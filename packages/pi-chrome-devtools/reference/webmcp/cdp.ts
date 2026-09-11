/**
 * Compatibility reference retained beside the packaged WebMCP implementation.
 * This file is intentionally not an extension entrypoint or the production transport.
 */
const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_CDP_MESSAGE_BYTES = 8 * 1024 * 1024;

export interface DevToolsPage {
  id: string;
  title: string;
  type: string;
  url: string;
  webSocketDebuggerUrl: string;
}

export interface WebMcpTool {
  annotations?: {
    readOnlyHint?: boolean;
    untrustedContentHint?: boolean;
  };
  description: string;
  inputSchema?: unknown;
  name: string;
  origin: string;
  title?: string;
}

export interface WebMcpInspection {
  supported: boolean;
  tools: WebMcpTool[];
}

export interface WebMcpExecution {
  result: unknown;
  tool: Pick<WebMcpTool, "name" | "origin">;
}

export interface WebMcpBridge {
  executeTool(
    page: DevToolsPage,
    request: {
      fromOrigins?: string[];
      input: Record<string, unknown>;
      origin?: string;
      toolName: string;
    },
    signal?: AbortSignal,
  ): Promise<WebMcpExecution>;
  inspectPage(page: DevToolsPage, fromOrigins?: string[], signal?: AbortSignal): Promise<WebMcpInspection>;
  listPages(signal?: AbortSignal): Promise<DevToolsPage[]>;
}

type FetchImplementation = typeof fetch;
type WebSocketConstructor = new (url: string | URL) => WebSocket;

interface CdpResponse<T = unknown> {
  error?: { code: number; data?: unknown; message: string };
  id: number;
  result?: T;
}

interface CdpEvaluateResponse {
  exceptionDetails?: {
    exception?: { description?: string };
    text?: string;
  };
  result: {
    description?: string;
    value?: unknown;
  };
}

interface PendingRequest {
  cleanup: () => void;
  reject: (reason: unknown) => void;
  resolve: (value: unknown) => void;
}

export function createCdpBridge(options: {
  endpoint: string;
  fetchImplementation?: FetchImplementation;
  webSocketConstructor?: WebSocketConstructor;
}): WebMcpBridge {
  const endpoint = normalizeEndpoint(options.endpoint);
  const fetchImplementation = options.fetchImplementation ?? fetch;
  const webSocketConstructor = options.webSocketConstructor ?? WebSocket;

  return {
    async listPages(signal) {
      const response = await fetchImplementation(`${endpoint}/json/list`, {
        signal: deadlineSignal(signal),
      });
      if (!response.ok) {
        throw new Error(`Chrome DevTools returned HTTP ${response.status} for /json/list`);
      }

      const payload: unknown = await response.json();
      if (!Array.isArray(payload)) throw new Error("Chrome DevTools /json/list was not an array");

      return payload.flatMap((candidate): DevToolsPage[] => {
        if (!isRecord(candidate) || candidate.type !== "page") return [];
        if (
          typeof candidate.id !== "string" ||
          typeof candidate.title !== "string" ||
          typeof candidate.url !== "string" ||
          typeof candidate.webSocketDebuggerUrl !== "string"
        ) {
          return [];
        }
        return [
          {
            id: candidate.id,
            title: candidate.title,
            type: "page",
            url: candidate.url,
            webSocketDebuggerUrl: candidate.webSocketDebuggerUrl,
          },
        ];
      });
    },

    async inspectPage(page, fromOrigins, signal) {
      return evaluate<WebMcpInspection>(page, discoveryExpression(fromOrigins), webSocketConstructor, signal);
    },

    async executeTool(page, request, signal) {
      const token = crypto.randomUUID();
      const client = await CdpClient.connect(page.webSocketDebuggerUrl, webSocketConstructor, deadlineSignal(signal));
      const operationSignal = deadlineSignal(signal);
      const abort = () => {
        const fallback = setTimeout(() => client.close(operationSignal.reason), 250);
        void client
          .send("Runtime.evaluate", {
            awaitPromise: true,
            expression: abortExpression(token),
            returnByValue: true,
          })
          .catch(() => undefined)
          .finally(() => {
            clearTimeout(fallback);
            client.close(operationSignal.reason);
          });
      };

      try {
        operationSignal.throwIfAborted();
        operationSignal.addEventListener("abort", abort, { once: true });
        const response = await client.send<CdpEvaluateResponse>("Runtime.evaluate", {
          awaitPromise: true,
          expression: executionExpression(token, request),
          returnByValue: true,
        });
        operationSignal.throwIfAborted();
        return unwrapEvaluation<WebMcpExecution>(response);
      } finally {
        operationSignal.removeEventListener("abort", abort);
        client.close();
      }
    },
  };
}

export function discoveryExpression(fromOrigins?: string[]): string {
  return `(async () => {
	const context = document.modelContext;
	if (!context) return { supported: false, tools: [] };
	const fromOrigins = ${javascriptValue(fromOrigins ?? [])};
	const tools = await context.getTools(fromOrigins.length > 0 ? { fromOrigins } : {});
	return {
		supported: true,
		tools: tools.map((tool) => ({
			name: tool.name,
			title: tool.title,
			description: tool.description,
			inputSchema: tool.inputSchema,
			origin: tool.origin,
			annotations: tool.annotations,
		})),
	};
})()`;
}

export function executionExpression(
  token: string,
  request: {
    fromOrigins?: string[];
    input: Record<string, unknown>;
    origin?: string;
    toolName: string;
  },
): string {
  return `(async () => {
	const context = document.modelContext;
	if (!context) throw new Error("This page does not expose document.modelContext");
	const fromOrigins = ${javascriptValue(request.fromOrigins ?? [])};
	const controllers = globalThis[Symbol.for("pi.webmcp.abort-controllers")] ??= new Map();
	const controller = new AbortController();
	controllers.set(${javascriptValue(token)}, controller);
	try {
		const tools = await context.getTools(fromOrigins.length > 0 ? { fromOrigins } : {});
		controller.signal.throwIfAborted();
		const matches = tools.filter((tool) =>
			tool.name === ${javascriptValue(request.toolName)} &&
			(${javascriptValue(request.origin)} === undefined || tool.origin === ${javascriptValue(request.origin)})
		);
		if (matches.length === 0) throw new Error("WebMCP tool not found");
		if (matches.length > 1) throw new Error("WebMCP tool name is ambiguous; provide origin");
		const rawInput = ${javascriptValue(request.input)};
		const input = typeof matches[0].inputSchema === "string" ? JSON.stringify(rawInput) : rawInput;
		const result = await context.executeTool(
			matches[0],
			input,
			{ signal: controller.signal },
		);
		return { result, tool: { name: matches[0].name, origin: matches[0].origin } };
	} finally {
		controllers.delete(${javascriptValue(token)});
	}
})()`;
}

function abortExpression(token: string): string {
  return `void (() => {
	const controllers = globalThis[Symbol.for("pi.webmcp.abort-controllers")];
	controllers?.get(${javascriptValue(token)})?.abort();
})()`;
}

async function evaluate<T>(
  page: DevToolsPage,
  expression: string,
  webSocketConstructor: WebSocketConstructor,
  signal?: AbortSignal,
): Promise<T> {
  const client = await CdpClient.connect(page.webSocketDebuggerUrl, webSocketConstructor, deadlineSignal(signal));
  const operationSignal = deadlineSignal(signal);
  try {
    const response = await client.send<CdpEvaluateResponse>(
      "Runtime.evaluate",
      { awaitPromise: true, expression, returnByValue: true },
      operationSignal,
    );
    return unwrapEvaluation<T>(response);
  } finally {
    client.close();
  }
}

function unwrapEvaluation<T>(response: CdpEvaluateResponse): T {
  if (response.exceptionDetails) {
    throw new Error(
      response.exceptionDetails.exception?.description ?? response.exceptionDetails.text ?? "WebMCP evaluation failed",
    );
  }
  if (!("value" in response.result)) {
    throw new Error(response.result.description ?? "WebMCP evaluation returned no value");
  }
  return response.result.value as T;
}

function normalizeEndpoint(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("WEBMCP_CDP_ENDPOINT must use http: or https:");
  }
  return url.toString().replace(/\/+$/u, "");
}

function deadlineSignal(signal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(DEFAULT_TIMEOUT_MS);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

function javascriptValue(value: unknown): string {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) return "undefined";
  return serialized.replaceAll("\u2028", "\\u2028").replaceAll("\u2029", "\\u2029");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

class CdpClient {
  #nextId = 1;
  #pending = new Map<number, PendingRequest>();

  private constructor(private readonly socket: WebSocket) {
    socket.addEventListener("message", (event) => {
      if (typeof event.data !== "string") {
        this.close(new Error("Chrome DevTools WebSocket sent an unsupported binary message"));
        return;
      }
      if (event.data.length > MAX_CDP_MESSAGE_BYTES || Buffer.byteLength(event.data, "utf8") > MAX_CDP_MESSAGE_BYTES) {
        this.close(new Error("Chrome DevTools WebSocket message exceeds the 8 MB limit"));
        return;
      }
      let response: CdpResponse;
      try {
        response = JSON.parse(event.data) as CdpResponse;
      } catch {
        this.close(new Error("Chrome DevTools WebSocket sent malformed JSON"));
        return;
      }
      if (typeof response.id !== "number") return;

      const pending = this.#pending.get(response.id);
      if (!pending) return;
      this.#pending.delete(response.id);
      pending.cleanup();
      if (response.error) {
        pending.reject(new Error(`CDP error ${response.error.code}: ${response.error.message}`));
      } else {
        pending.resolve(response.result);
      }
    });
    socket.addEventListener("close", () => {
      this.rejectAll(new Error("Chrome DevTools WebSocket closed"));
    });
    socket.addEventListener("error", () => {
      this.rejectAll(new Error("Chrome DevTools WebSocket error"));
    });
  }

  static connect(url: string, WebSocketImplementation: WebSocketConstructor, signal: AbortSignal): Promise<CdpClient> {
    signal.throwIfAborted();
    return new Promise((resolve, reject) => {
      const socket = new WebSocketImplementation(url);
      const timeout = setTimeout(() => {
        socket.close();
        reject(new Error("Timed out connecting to Chrome DevTools WebSocket"));
      }, DEFAULT_TIMEOUT_MS);
      const abort = () => {
        clearTimeout(timeout);
        socket.close();
        reject(signal.reason);
      };
      const cleanup = () => {
        clearTimeout(timeout);
        signal.removeEventListener("abort", abort);
      };
      signal.addEventListener("abort", abort, { once: true });
      socket.addEventListener(
        "open",
        () => {
          cleanup();
          resolve(new CdpClient(socket));
        },
        { once: true },
      );
      socket.addEventListener(
        "error",
        () => {
          cleanup();
          reject(new Error("Failed to connect to Chrome DevTools WebSocket"));
        },
        { once: true },
      );
    });
  }

  send<T = unknown>(method: string, params: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
    signal?.throwIfAborted();
    const id = this.#nextId;
    this.#nextId += 1;
    return new Promise<T>((resolve, reject) => {
      const abort = () => this.close(signal?.reason);
      const timeout = setTimeout(() => {
        this.#pending.delete(id);
        signal?.removeEventListener("abort", abort);
        reject(new Error(`Timed out waiting for CDP response: ${method}`));
      }, DEFAULT_TIMEOUT_MS);
      this.#pending.set(id, {
        cleanup: () => {
          clearTimeout(timeout);
          signal?.removeEventListener("abort", abort);
        },
        reject,
        resolve: resolve as (value: unknown) => void,
      });
      signal?.addEventListener("abort", abort, { once: true });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  close(reason: unknown = new Error("Chrome DevTools WebSocket closed")): void {
    this.rejectAll(reason);
    this.socket.close();
  }

  private rejectAll(reason: unknown): void {
    for (const [id, pending] of this.#pending) {
      this.#pending.delete(id);
      pending.cleanup();
      pending.reject(reason);
    }
  }
}
