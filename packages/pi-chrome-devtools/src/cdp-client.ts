import {
  devToolsEndpoint,
  ensureDevToolsEndpoint,
  fetchDevToolsJson,
  formatPageListItem,
  launchHint,
  withEndpointRetry,
} from "./browser-manager.js";
import { DEFAULT_ENDPOINT_WAIT_MS, DEFAULT_TIMEOUT_MS, type DevToolsPage, state } from "./runtime.js";

interface CdpResponse<T = unknown> {
  error?: { code: number; data?: unknown; message: string };
  id: number;
  result?: T;
}

interface CdpEvent {
  method: string;
  params?: unknown;
}

interface PendingRequest {
  cleanup: () => void;
  reject: (reason: unknown) => void;
  resolve: (value: unknown) => void;
}

interface EventWaiter<T = unknown> {
  cleanup: () => void;
  method: string;
  predicate: (params: unknown) => params is T;
  reject: (reason: unknown) => void;
  resolve: (params: T) => void;
}

export type CdpWebSocketConstructor = new (url: string | URL) => WebSocket;

export interface CdpOperationOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface CdpConnectOptions extends CdpOperationOptions {
  webSocketConstructor?: CdpWebSocketConstructor;
}

const MAX_BUFFERED_EVENTS_PER_METHOD = 32;
const MAX_CDP_MESSAGE_BYTES = 8 * 1024 * 1024;
const activePageIds = new WeakMap<object, string>();

interface PageOperationOptions {
  sessionOwner?: object;
  signal?: AbortSignal;
  waitMs?: number;
}

export async function listPages(options: PageOperationOptions = {}) {
  const waitMs = options.waitMs ?? DEFAULT_ENDPOINT_WAIT_MS;
  await ensureDevToolsEndpoint(waitMs, options.signal, options.sessionOwner);
  return withEndpointRetry(
    async () => {
      const pages = await fetchDevToolsJson<DevToolsPage[]>(
        "/json/list",
        { signal: options.signal },
        options.sessionOwner,
      );
      return pages.filter((page) => page.type === "page" && page.webSocketDebuggerUrl);
    },
    waitMs,
    options.signal,
  );
}

export async function getPage(pageId: string, options: PageOperationOptions = {}) {
  const pages = await listPages(options);
  return requirePage(pageId, pages);
}

export async function resolvePage(pageId?: string, options: PageOperationOptions = {}) {
  const pages = await listPages(options);
  if (pageId) return requirePage(pageId, pages);

  const page = resolveDefaultPage(pages, options.sessionOwner);
  if (!page) {
    throw new Error(
      [
        `No Chrome pages found at ${devToolsEndpoint(options.sessionOwner)}.`,
        "Use chrome_devtools_navigate with a URL to create a page, or open a Chrome tab manually.",
        launchHint(options.sessionOwner),
      ].join("\n"),
    );
  }

  return page;
}

export async function resolvePageForNavigation(pageId?: string, options: PageOperationOptions = {}) {
  const pages = await listPages(options);
  if (pageId) return { created: false, page: requirePage(pageId, pages) };

  const page = resolveDefaultPage(pages, options.sessionOwner);
  if (page) return { created: false, page };

  return { created: true, page: await createPage("about:blank", options) };
}

function resolveDefaultPage(pages: DevToolsPage[], owner?: object) {
  const activePageId = owner ? activePageIds.get(owner) : state.activePageId;
  if (!activePageId) return pages[0];

  const activePage = pages.find((candidate) => candidate.id === activePageId);
  if (activePage) return activePage;

  setActivePageId(owner, undefined);
  return pages[0];
}

export function setActivePageId(owner: object | undefined, pageId: string | undefined) {
  if (!owner) {
    state.activePageId = pageId;
    return;
  }
  if (pageId) activePageIds.set(owner, pageId);
  else activePageIds.delete(owner);
}

function requirePage(pageId: string, pages: DevToolsPage[]) {
  const page = pages.find((candidate) => candidate.id === pageId);
  if (page) return page;

  const availablePages = pages.map(formatPageListItem).join("\n");
  throw new Error(
    [
      `Chrome DevTools page not found: ${pageId}.`,
      availablePages ? `Available pages:\n${availablePages}` : "No inspectable Chrome pages are currently available.",
    ].join("\n"),
  );
}

export async function createPage(url: string, options: PageOperationOptions = {}) {
  const waitMs = options.waitMs ?? DEFAULT_ENDPOINT_WAIT_MS;
  await ensureDevToolsEndpoint(waitMs, options.signal, options.sessionOwner);
  const page = await withEndpointRetry(
    () =>
      fetchDevToolsJson<DevToolsPage>(
        `/json/new?${encodeURIComponent(url)}`,
        { method: "PUT", signal: options.signal },
        options.sessionOwner,
      ),
    waitMs,
    options.signal,
  );
  if (page.type !== "page" || !page.webSocketDebuggerUrl) {
    throw new Error("Chrome DevTools created a target that is not an inspectable page.");
  }

  return page;
}

export function formatPage(page: DevToolsPage) {
  return {
    id: page.id,
    type: page.type,
    title: page.title,
    url: page.url,
  };
}

export function textResult<T>(text: string, details: T) {
  return {
    content: [{ type: "text" as const, text }],
    details,
  };
}

export async function withCdp<T>(
  page: DevToolsPage,
  callback: (client: CdpClient) => Promise<T>,
  options: CdpConnectOptions = {},
) {
  if (!page.webSocketDebuggerUrl) throw new Error(`Page has no webSocketDebuggerUrl: ${page.id}`);

  const client = await CdpClient.connect(page.webSocketDebuggerUrl, options);
  try {
    return await callback(client);
  } finally {
    client.close();
  }
}

export class CdpClient {
  #closed = false;
  #eventBuffers = new Map<string, unknown[]>();
  #eventWaiters = new Set<EventWaiter>();
  #nextId = 1;
  #pending = new Map<number, PendingRequest>();
  readonly #socket: WebSocket;

  private constructor(socket: WebSocket) {
    this.#socket = socket;
    socket.addEventListener("message", this.onMessage);
    socket.addEventListener("close", this.onClose);
    socket.addEventListener("error", this.onError);
  }

  static connect(url: string, options: CdpConnectOptions = {}) {
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const WebSocketImplementation = options.webSocketConstructor ?? WebSocket;
    options.signal?.throwIfAborted();
    return new Promise<CdpClient>((resolve, reject) => {
      const socket = new WebSocketImplementation(url);
      let settled = false;
      const settle = (callback: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        options.signal?.removeEventListener("abort", onAbort);
        socket.removeEventListener("open", onOpen);
        socket.removeEventListener("error", onConnectError);
        callback();
      };
      const onOpen = () => settle(() => resolve(new CdpClient(socket)));
      const onConnectError = () =>
        settle(() => {
          socket.close();
          reject(new Error(`Failed to connect to Chrome DevTools WebSocket: ${url}`));
        });
      const onAbort = () =>
        settle(() => {
          socket.close();
          reject(options.signal?.reason ?? abortError("Chrome DevTools connection aborted"));
        });
      const timeout = setTimeout(
        () =>
          settle(() => {
            socket.close();
            reject(new Error(`Timed out connecting to Chrome DevTools WebSocket: ${url}`));
          }),
        timeoutMs,
      );
      options.signal?.addEventListener("abort", onAbort, { once: true });
      socket.addEventListener("open", onOpen, { once: true });
      socket.addEventListener("error", onConnectError, { once: true });
    });
  }

  send<T = unknown>(method: string, params: Record<string, unknown> = {}, options: CdpOperationOptions = {}) {
    this.throwIfClosed();
    options.signal?.throwIfAborted();
    const id = this.#nextId;
    this.#nextId += 1;
    return new Promise<T>((resolve, reject) => {
      const onAbort = () => {
        this.#pending.delete(id);
        cleanup();
        reject(options.signal?.reason ?? abortError(`CDP command aborted: ${method}`));
      };
      const timeout = setTimeout(() => {
        this.#pending.delete(id);
        options.signal?.removeEventListener("abort", onAbort);
        reject(new Error(`Timed out waiting for CDP response: ${method}`));
      }, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
      const cleanup = () => {
        clearTimeout(timeout);
        options.signal?.removeEventListener("abort", onAbort);
      };
      this.#pending.set(id, {
        cleanup,
        reject,
        resolve: resolve as (value: unknown) => void,
      });
      options.signal?.addEventListener("abort", onAbort, { once: true });
      try {
        this.#socket.send(JSON.stringify({ id, method, params }));
      } catch (error) {
        this.#pending.delete(id);
        cleanup();
        reject(error);
      }
    });
  }

  waitForEvent<T>(
    method: string,
    predicate: (params: unknown) => params is T,
    options: CdpOperationOptions = {},
  ): Promise<T> {
    this.throwIfClosed();
    options.signal?.throwIfAborted();
    const buffered = this.#eventBuffers.get(method) ?? [];
    for (const [index, params] of buffered.entries()) {
      if (!predicate(params)) continue;
      buffered.splice(index, 1);
      if (buffered.length === 0) this.#eventBuffers.delete(method);
      return Promise.resolve(params);
    }

    return new Promise<T>((resolve, reject) => {
      const waiter = {} as EventWaiter<T>;
      const onAbort = () => {
        this.#eventWaiters.delete(waiter as EventWaiter);
        cleanup();
        reject(options.signal?.reason ?? abortError(`CDP event wait aborted: ${method}`));
      };
      const timeout = setTimeout(() => {
        this.#eventWaiters.delete(waiter as EventWaiter);
        options.signal?.removeEventListener("abort", onAbort);
        reject(new Error(`Timed out waiting for CDP event: ${method}`));
      }, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
      const cleanup = () => {
        clearTimeout(timeout);
        options.signal?.removeEventListener("abort", onAbort);
      };
      Object.assign(waiter, { cleanup, method, predicate, reject, resolve });
      this.#eventWaiters.add(waiter as EventWaiter);
      options.signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  close(reason: unknown = new Error("Chrome DevTools WebSocket closed")) {
    if (this.#closed) return;
    this.#closed = true;
    this.#socket.removeEventListener("message", this.onMessage);
    this.#socket.removeEventListener("close", this.onClose);
    this.#socket.removeEventListener("error", this.onError);
    this.rejectAll(reason);
    this.#eventBuffers.clear();
    try {
      this.#socket.close();
    } catch {
      // The transport is already unusable; pending work has still been rejected.
    }
  }

  private readonly onClose = () => {
    this.close(new Error("Chrome DevTools WebSocket closed"));
  };

  private readonly onError = () => {
    this.close(new Error("Chrome DevTools WebSocket error"));
  };

  private readonly onMessage = (event: MessageEvent) => {
    if (typeof event.data !== "string") {
      this.close(new Error("Chrome DevTools WebSocket sent an unsupported binary message"));
      return;
    }
    if (event.data.length > MAX_CDP_MESSAGE_BYTES || Buffer.byteLength(event.data, "utf8") > MAX_CDP_MESSAGE_BYTES) {
      this.close(new Error("Chrome DevTools WebSocket message exceeds the 8 MB limit"));
      return;
    }
    let payload: unknown;
    try {
      payload = JSON.parse(event.data) as unknown;
    } catch {
      this.close(new Error("Chrome DevTools WebSocket sent malformed JSON"));
      return;
    }
    if (!isRecord(payload)) {
      this.close(new Error("Chrome DevTools WebSocket sent a malformed message"));
      return;
    }
    if (typeof payload.id === "number") {
      this.handleResponse(payload as unknown as CdpResponse);
      return;
    }
    if (typeof payload.method !== "string") {
      this.close(new Error("Chrome DevTools WebSocket sent a malformed event"));
      return;
    }
    this.handleEvent(payload as unknown as CdpEvent);
  };

  private handleResponse(response: CdpResponse) {
    const pending = this.#pending.get(response.id);
    if (!pending) return;
    this.#pending.delete(response.id);
    pending.cleanup();
    if (response.error) {
      pending.reject(
        new Error(
          `CDP error ${response.error.code}: ${response.error.message}${
            response.error.data === undefined ? "" : ` (${safeJson(response.error.data)})`
          }`,
        ),
      );
      return;
    }
    pending.resolve(response.result);
  }

  private handleEvent(event: CdpEvent) {
    if (event.method === "Inspector.detached" || event.method === "Target.detachedFromTarget") {
      this.close(new Error(`Chrome DevTools target detached: ${safeJson(event.params)}`));
      return;
    }
    for (const waiter of this.#eventWaiters) {
      if (waiter.method !== event.method) continue;
      let matched: boolean;
      try {
        matched = waiter.predicate(event.params);
      } catch (error) {
        this.#eventWaiters.delete(waiter);
        waiter.cleanup();
        waiter.reject(error);
        return;
      }
      if (!matched) continue;
      this.#eventWaiters.delete(waiter);
      waiter.cleanup();
      waiter.resolve(event.params);
      return;
    }
    const buffer = this.#eventBuffers.get(event.method) ?? [];
    buffer.push(event.params);
    if (buffer.length > MAX_BUFFERED_EVENTS_PER_METHOD) {
      this.close(
        new Error(
          `Chrome DevTools WebSocket buffered more than ${MAX_BUFFERED_EVENTS_PER_METHOD} ${event.method} events`,
        ),
      );
      return;
    }
    this.#eventBuffers.set(event.method, buffer);
  }

  private rejectAll(reason: unknown) {
    for (const [id, pending] of this.#pending) {
      this.#pending.delete(id);
      pending.cleanup();
      pending.reject(reason);
    }
    for (const waiter of this.#eventWaiters) {
      this.#eventWaiters.delete(waiter);
      waiter.cleanup();
      waiter.reject(reason);
    }
  }

  private throwIfClosed() {
    if (this.#closed) throw new Error("Chrome DevTools WebSocket is closed");
  }
}

function abortError(message: string) {
  return new DOMException(message, "AbortError");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safeJson(value: unknown) {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
