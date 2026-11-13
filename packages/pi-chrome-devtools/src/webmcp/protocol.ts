import { fetchDevToolsJson } from "../browser-manager.js";
import { CdpClient } from "../cdp-client.js";
import { DEFAULT_TIMEOUT_MS, type DevToolsPage } from "../runtime.js";

export interface WebMcpProtocolAnnotation {
  autosubmit?: boolean;
  consequential?: boolean;
  readOnly?: boolean;
  untrustedContent?: boolean;
}

export interface WebMcpProtocolTool {
  annotations?: WebMcpProtocolAnnotation;
  backendNodeId?: number;
  description: string;
  frameId: string;
  inputSchema?: Record<string, unknown>;
  name: string;
  title?: string;
}

export interface WebMcpFrame {
  id: string;
  loaderId: string;
  securityOrigin?: string;
  url: string;
}

export interface WebMcpInvocationResponse {
  errorText?: string;
  exception?: unknown;
  invocationId: string;
  output?: unknown;
  status: "Canceled" | "Completed" | "Error";
}

export interface WebMcpIdentityWatch {
  dispose(): Promise<void>;
  signal: AbortSignal;
}

interface ProtocolDescription {
  domains?: unknown;
}

const REQUIRED_COMMANDS = ["enable", "disable", "invokeTool", "cancelInvocation"];
const REQUIRED_EVENTS = ["toolsAdded", "toolsRemoved", "toolInvoked", "toolResponded"];
const IDENTITY_WATCH_TIMEOUT_MS = DEFAULT_TIMEOUT_MS * 4;

export async function requireWebMcpDomain(signal: AbortSignal, owner: object) {
  signal.throwIfAborted();
  const protocol = await fetchDevToolsJson<ProtocolDescription>("/json/protocol", { signal }, owner);
  signal.throwIfAborted();
  const domain = findDomain(protocol.domains, "WebMCP");
  if (
    !domain ||
    !hasNamedEntries(domain.commands, REQUIRED_COMMANDS) ||
    !hasNamedEntries(domain.events, REQUIRED_EVENTS)
  ) {
    throw new Error(
      "This browser does not expose the experimental Chrome DevTools WebMCP domain. Use a compatible Chrome build and enable the website's required Origin Trial or WebMCP testing feature.",
    );
  }
}

export async function connectWebMcpPage(page: DevToolsPage, signal: AbortSignal) {
  if (!page.webSocketDebuggerUrl) throw new Error(`Page has no webSocketDebuggerUrl: ${page.id}`);
  return CdpClient.connect(page.webSocketDebuggerUrl, {
    signal: withDeadline(signal),
  });
}

export async function cancelWebMcpInvocation(page: DevToolsPage, invocationId: string) {
  const cleanupSignal = AbortSignal.timeout(1_000);
  const client = await connectWebMcpPage(page, cleanupSignal);
  try {
    await client.send("WebMCP.cancelInvocation", { invocationId }, { signal: cleanupSignal });
  } finally {
    client.close();
  }
}

export async function enableWebMcpIdentityTracking(client: CdpClient, signal: AbortSignal) {
  await client.send("Page.enable", {}, { signal, timeoutMs: DEFAULT_TIMEOUT_MS });
}

export async function enableWebMcp(client: CdpClient, signal: AbortSignal) {
  const eventController = new AbortController();
  const eventSignal = AbortSignal.any([signal, eventController.signal]);
  const toolsAdded = client
    .waitForEvent(
      "WebMCP.toolsAdded",
      (value): value is { tools: WebMcpProtocolTool[] } => {
        const parsed = parseToolsAdded(value);
        if (!parsed) throw new Error("Chrome sent a malformed WebMCP.toolsAdded event");
        return true;
      },
      { signal: eventSignal, timeoutMs: DEFAULT_TIMEOUT_MS },
    )
    .then(
      (value) => ({ ok: true as const, value }),
      (error: unknown) => ({ error, ok: false as const }),
    );
  try {
    await client.send("WebMCP.enable", {}, { signal, timeoutMs: DEFAULT_TIMEOUT_MS });
  } catch (error) {
    eventController.abort();
    await toolsAdded;
    throw error;
  }
  try {
    const result = await toolsAdded;
    if (!result.ok) throw result.error;
    const parsed = parseToolsAdded(result.value);
    if (!parsed) throw new Error("Chrome sent a malformed WebMCP.toolsAdded event");
    return parsed.tools;
  } finally {
    eventController.abort();
  }
}

export async function disableWebMcp(client: CdpClient) {
  try {
    await client.send("WebMCP.disable", {}, { timeoutMs: 1_000 });
  } catch {
    // Best-effort cleanup: the target may already be detached or the domain may be unavailable.
  }
}

export async function readWebMcpFrames(client: CdpClient, signal: AbortSignal) {
  const result = await client.send<unknown>(
    "Page.getFrameTree",
    {},
    {
      signal,
      timeoutMs: DEFAULT_TIMEOUT_MS,
    },
  );
  const frames = parseFrameTree(result);
  if (!frames) throw new Error("Chrome sent a malformed Page.getFrameTree response");
  return frames;
}

export function watchWebMcpIdentity(
  client: CdpClient,
  expected: { documentId: string; frameId: string; toolName: string },
  signal: AbortSignal,
): WebMcpIdentityWatch {
  const stopController = new AbortController();
  const staleController = new AbortController();
  const watchSignal = AbortSignal.any([signal, stopController.signal]);
  const options = { signal: watchSignal, timeoutMs: IDENTITY_WATCH_TIMEOUT_MS };
  const settleWatch = (create: () => Promise<unknown>) => {
    let watch: Promise<unknown>;
    try {
      watch = create();
    } catch (error) {
      watch = Promise.reject(error);
    }
    return watch.then(
      () => {
        if (staleController.signal.aborted) return;
        staleController.abort(
          new DOMException(
            "The selected WebMCP document or tool changed before Chrome completed the invocation boundary.",
            "AbortError",
          ),
        );
      },
      (error) => {
        if (stopController.signal.aborted || signal.aborted || staleController.signal.aborted) {
          return;
        }
        staleController.abort(error);
      },
    );
  };
  const settledWatches = [
    settleWatch(() =>
      client.waitForEvent(
        "Page.frameNavigated",
        (value): value is unknown => frameNavigationChangesIdentity(value, expected.frameId, expected.documentId),
        options,
      ),
    ),
    settleWatch(() =>
      client.waitForEvent(
        "WebMCP.toolsAdded",
        (value): value is unknown => toolChangeMatchesIdentity(value, expected),
        options,
      ),
    ),
    settleWatch(() =>
      client.waitForEvent(
        "WebMCP.toolsRemoved",
        (value): value is unknown => toolChangeMatchesIdentity(value, expected),
        options,
      ),
    ),
  ];
  return {
    signal: AbortSignal.any([signal, staleController.signal]),
    async dispose() {
      stopController.abort();
      await Promise.allSettled(settledWatches);
    },
  };
}

export async function invokeWebMcpTool(
  client: CdpClient,
  request: { frameId: string; input: Record<string, unknown>; toolName: string },
  signal: AbortSignal,
  fallbackCancel?: (invocationId: string) => Promise<unknown>,
): Promise<WebMcpInvocationResponse> {
  signal.throwIfAborted();
  let invocationId: string | undefined;
  let cancellation: Promise<unknown> | undefined;
  const cancel = () => {
    if (!invocationId || cancellation) return;
    const invocationToCancel = invocationId;
    const recoverCancellation = () =>
      fallbackCancel ? fallbackCancel(invocationToCancel).catch(() => undefined) : Promise.resolve();
    try {
      cancellation = client
        .send("WebMCP.cancelInvocation", { invocationId }, { timeoutMs: 1_000 })
        .catch(recoverCancellation);
    } catch {
      cancellation = recoverCancellation();
    }
  };
  const onAbort = () => cancel();
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    let response: unknown;
    try {
      response = await client.send<unknown>(
        "WebMCP.invokeTool",
        { frameId: request.frameId, toolName: request.toolName, input: request.input },
        { timeoutMs: DEFAULT_TIMEOUT_MS },
      );
    } catch (error) {
      if (signal.aborted) throw signal.reason;
      throw error;
    }
    invocationId = parseInvocationId(response);
    if (!invocationId) throw new Error("Chrome sent a malformed WebMCP.invokeTool response");
    if (signal.aborted) cancel();
    let event: WebMcpInvocationResponse;
    try {
      event = await client.waitForEvent(
        "WebMCP.toolResponded",
        (value): value is WebMcpInvocationResponse => {
          const parsed = parseToolResponded(value);
          if (!parsed) throw new Error("Chrome sent a malformed WebMCP.toolResponded event");
          return parsed.invocationId === invocationId;
        },
        { timeoutMs: DEFAULT_TIMEOUT_MS },
      );
    } catch (error) {
      cancel();
      await cancellation;
      if (signal.aborted) throw signal.reason;
      throw error;
    }
    if (signal.aborted) throw signal.reason;
    return event;
  } finally {
    signal.removeEventListener("abort", onAbort);
    await cancellation;
  }
}

function findDomain(value: unknown, name: string): Record<string, unknown> | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.find(
    (candidate): candidate is Record<string, unknown> => isRecord(candidate) && candidate.domain === name,
  );
}

function hasNamedEntries(value: unknown, required: readonly string[]) {
  if (!Array.isArray(value)) return false;
  const names = new Set(
    value.flatMap((candidate) => (isRecord(candidate) && typeof candidate.name === "string" ? [candidate.name] : [])),
  );
  return required.every((name) => names.has(name));
}

function parseToolsAdded(value: unknown): { tools: WebMcpProtocolTool[] } | undefined {
  if (!isRecord(value) || !Array.isArray(value.tools)) return undefined;
  const tools: WebMcpProtocolTool[] = [];
  for (const candidate of value.tools) {
    const tool = parseTool(candidate);
    if (!tool) return undefined;
    tools.push(tool);
  }
  return { tools };
}

function parseTool(value: unknown): WebMcpProtocolTool | undefined {
  if (
    !isRecord(value) ||
    typeof value.name !== "string" ||
    typeof value.description !== "string" ||
    typeof value.frameId !== "string" ||
    (value.inputSchema !== undefined && !isRecord(value.inputSchema)) ||
    (value.title !== undefined && typeof value.title !== "string") ||
    (value.backendNodeId !== undefined && typeof value.backendNodeId !== "number")
  ) {
    return undefined;
  }
  const annotations = parseAnnotations(value.annotations);
  if (value.annotations !== undefined && !annotations) return undefined;
  return {
    name: value.name,
    description: value.description,
    frameId: value.frameId,
    ...(value.title === undefined ? {} : { title: value.title }),
    ...(value.inputSchema === undefined ? {} : { inputSchema: value.inputSchema }),
    ...(annotations ? { annotations } : {}),
    ...(value.backendNodeId === undefined ? {} : { backendNodeId: value.backendNodeId }),
  };
}

function parseAnnotations(value: unknown): WebMcpProtocolAnnotation | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) return undefined;
  const annotations: WebMcpProtocolAnnotation = {};
  for (const key of ["autosubmit", "consequential", "readOnly", "untrustedContent"] as const) {
    if (value[key] === undefined) continue;
    if (typeof value[key] !== "boolean") return undefined;
    annotations[key] = value[key];
  }
  return annotations;
}

function parseFrameTree(value: unknown): WebMcpFrame[] | undefined {
  if (!isRecord(value) || !isRecord(value.frameTree)) return undefined;
  const frames: WebMcpFrame[] = [];
  const visit = (tree: unknown): boolean => {
    if (!isRecord(tree) || !isRecord(tree.frame)) return false;
    const frame = tree.frame;
    if (
      typeof frame.id !== "string" ||
      typeof frame.loaderId !== "string" ||
      typeof frame.url !== "string" ||
      (frame.securityOrigin !== undefined && typeof frame.securityOrigin !== "string")
    ) {
      return false;
    }
    frames.push({
      id: frame.id,
      loaderId: frame.loaderId,
      url: frame.url,
      ...(frame.securityOrigin === undefined ? {} : { securityOrigin: frame.securityOrigin }),
    });
    if (tree.childFrames === undefined) return true;
    return Array.isArray(tree.childFrames) && tree.childFrames.every(visit);
  };
  return visit(value.frameTree) ? frames : undefined;
}

function frameNavigationChangesIdentity(value: unknown, frameId: string, documentId: string) {
  if (!isRecord(value) || !isRecord(value.frame)) {
    throw new Error("Chrome sent a malformed Page.frameNavigated event");
  }
  if (typeof value.frame.id !== "string" || typeof value.frame.loaderId !== "string") {
    throw new Error("Chrome sent a malformed Page.frameNavigated event");
  }
  return value.frame.id === frameId && value.frame.loaderId !== documentId;
}

function toolChangeMatchesIdentity(value: unknown, expected: { frameId: string; toolName: string }) {
  if (!isRecord(value) || !Array.isArray(value.tools)) {
    throw new Error("Chrome sent a malformed WebMCP tool-change event");
  }
  return value.tools.some((tool) => {
    if (!isRecord(tool) || typeof tool.frameId !== "string" || typeof tool.name !== "string") {
      throw new Error("Chrome sent a malformed WebMCP tool-change event");
    }
    return tool.frameId === expected.frameId && tool.name === expected.toolName;
  });
}

function parseInvocationId(value: unknown) {
  return isRecord(value) && typeof value.invocationId === "string" ? value.invocationId : undefined;
}

function parseToolResponded(value: unknown): WebMcpInvocationResponse | undefined {
  if (
    !isRecord(value) ||
    typeof value.invocationId !== "string" ||
    !(["Canceled", "Completed", "Error"] as const).includes(value.status as never) ||
    (value.errorText !== undefined && typeof value.errorText !== "string")
  ) {
    return undefined;
  }
  return {
    invocationId: value.invocationId,
    status: value.status as WebMcpInvocationResponse["status"],
    ...(value.output === undefined ? {} : { output: value.output }),
    ...(value.errorText === undefined ? {} : { errorText: value.errorText }),
    ...(value.exception === undefined ? {} : { exception: value.exception }),
  };
}

function withDeadline(signal: AbortSignal) {
  return AbortSignal.any([signal, AbortSignal.timeout(DEFAULT_TIMEOUT_MS)]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
