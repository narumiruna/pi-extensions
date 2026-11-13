import { getPage } from "../cdp-client.js";
import { type DevToolsPage, webMcpOperationIsCurrent } from "../runtime.js";
import {
  MAX_WEBMCP_TOOLS,
  normalizeWebMcpOutput,
  normalizeWebMcpTool,
  requireMatchingWebMcpTool,
  type WebMcpToolDescriptor,
  type WebMcpToolIdentity,
  webMcpErrorMessage,
} from "./policy.js";
import {
  cancelWebMcpInvocation,
  connectWebMcpPage,
  disableWebMcp,
  enableWebMcp,
  enableWebMcpIdentityTracking,
  invokeWebMcpTool,
  readWebMcpFrames,
  requireWebMcpDomain,
  type WebMcpFrame,
  type WebMcpProtocolTool,
  watchWebMcpIdentity,
} from "./protocol.js";

export interface WebMcpOperationIdentity {
  owner: object;
  sessionGeneration: number;
  signal: AbortSignal;
  webMcpGeneration: number;
}

export interface WebMcpInvocationResult {
  invocationId: string;
  output: unknown;
  tool: WebMcpToolDescriptor;
}

export async function discoverWebMcpTools(page: DevToolsPage, operation: WebMcpOperationIdentity) {
  assertOperationCurrent(operation);
  await requireWebMcpDomain(operation.signal, operation.owner);
  assertOperationCurrent(operation);
  const client = await connectWebMcpPage(page, operation.signal);
  try {
    const tools = await readInventory(client, page, operation);
    await requireStablePage(client, page, tools, operation);
    return tools;
  } finally {
    await disableWebMcp(client);
    client.close();
  }
}

export async function invokeDiscoveredWebMcpTool(
  page: DevToolsPage,
  expected: WebMcpToolIdentity,
  input: Record<string, unknown>,
  operation: WebMcpOperationIdentity,
): Promise<WebMcpInvocationResult> {
  assertOperationCurrent(operation);
  await requireWebMcpDomain(operation.signal, operation.owner);
  assertOperationCurrent(operation);
  const client = await connectWebMcpPage(page, operation.signal);
  try {
    await enableWebMcpIdentityTracking(client, operation.signal);
    assertOperationCurrent(operation);
    const tools = await readInventory(client, page, operation);
    const tool = requireMatchingWebMcpTool(tools, expected);
    const identityWatch = watchWebMcpIdentity(
      client,
      { documentId: tool.documentId, frameId: tool.frameId, toolName: tool.name },
      operation.signal,
    );
    const guardedOperation = { ...operation, signal: identityWatch.signal };
    try {
      await requireStablePage(client, page, [tool], guardedOperation);
      assertOperationCurrent(guardedOperation);
      const response = await invokeWebMcpTool(
        client,
        { frameId: tool.frameId, toolName: tool.name, input },
        guardedOperation.signal,
        (invocationId) => cancelWebMcpInvocation(page, invocationId),
      );
      assertOperationCurrent(guardedOperation);
      if (response.status === "Canceled") {
        throw new DOMException("Chrome canceled the WebMCP tool invocation.", "AbortError");
      }
      if (response.status === "Error") {
        throw new Error(
          `WebMCP tool failed: ${webMcpErrorMessage(response.errorText ?? remoteExceptionText(response.exception))}`,
        );
      }
      return {
        invocationId: response.invocationId,
        output: normalizeWebMcpOutput(response.output ?? null),
        tool,
      };
    } finally {
      await identityWatch.dispose();
    }
  } finally {
    await disableWebMcp(client);
    client.close();
  }
}

async function readInventory(
  client: Awaited<ReturnType<typeof connectWebMcpPage>>,
  page: DevToolsPage,
  operation: WebMcpOperationIdentity,
) {
  const framesBefore = await readWebMcpFrames(client, operation.signal);
  assertOperationCurrent(operation);
  const protocolTools = await enableWebMcp(client, operation.signal);
  assertOperationCurrent(operation);
  if (protocolTools.length > MAX_WEBMCP_TOOLS) {
    throw new Error(`WebMCP page exposes more than ${MAX_WEBMCP_TOOLS} tools.`);
  }
  const framesAfter = await readWebMcpFrames(client, operation.signal);
  assertOperationCurrent(operation);
  requireStableInventoryDocuments(protocolTools, framesBefore, framesAfter);
  return normalizeInventory(protocolTools, framesAfter, page, operation);
}

function requireStableInventoryDocuments(
  tools: readonly WebMcpProtocolTool[],
  before: readonly WebMcpFrame[],
  after: readonly WebMcpFrame[],
) {
  const beforeLoaders = new Map(before.map((frame) => [frame.id, frame.loaderId]));
  const afterLoaders = new Map(after.map((frame) => [frame.id, frame.loaderId]));
  for (const frameId of new Set(tools.map((tool) => tool.frameId))) {
    const beforeLoader = beforeLoaders.get(frameId);
    const afterLoader = afterLoaders.get(frameId);
    if (!beforeLoader || !afterLoader || beforeLoader !== afterLoader) {
      throw new Error("A WebMCP frame document changed while Chrome was publishing its tool inventory.");
    }
  }
}

function normalizeInventory(
  protocolTools: readonly WebMcpProtocolTool[],
  frames: readonly WebMcpFrame[],
  page: DevToolsPage,
  operation: WebMcpOperationIdentity,
) {
  const frameDocuments = new Map(
    frames.map((frame) => [frame.id, { documentId: frame.loaderId, origin: frameOrigin(frame) }]),
  );
  const tools = protocolTools.map((tool) => {
    const frame = frameDocuments.get(tool.frameId);
    if (!frame) {
      throw new Error(`WebMCP tool ${webMcpErrorMessage(tool.name)} belongs to an unknown frame.`);
    }
    return normalizeWebMcpTool(tool, {
      documentId: frame.documentId,
      frameOrigin: frame.origin,
      pageId: page.id,
      pageUrl: page.url,
      sessionGeneration: generationToken(operation),
    });
  });
  const identities = new Set<string>();
  for (const tool of tools) {
    const key = `${tool.frameId}\u0000${tool.name}`;
    if (identities.has(key)) {
      throw new Error(
        `WebMCP tool identity is duplicated: ${webMcpErrorMessage(tool.name)} in frame ${webMcpErrorMessage(tool.frameId)}.`,
      );
    }
    identities.add(key);
  }
  return tools;
}

async function requireStablePage(
  client: Awaited<ReturnType<typeof connectWebMcpPage>>,
  page: DevToolsPage,
  tools: readonly WebMcpToolDescriptor[],
  operation: WebMcpOperationIdentity,
) {
  const current = await getPage(page.id, {
    sessionOwner: operation.owner,
    signal: operation.signal,
  });
  assertOperationCurrent(operation);
  if (
    current.url !== page.url ||
    current.webSocketDebuggerUrl !== page.webSocketDebuggerUrl ||
    current.type !== page.type
  ) {
    throw new Error("The Chrome page navigated or was replaced during the WebMCP operation.");
  }
  const finalFrames = await readWebMcpFrames(client, operation.signal);
  assertOperationCurrent(operation);
  const finalDocuments = new Map(finalFrames.map((frame) => [frame.id, frame.loaderId]));
  for (const tool of tools) {
    if (finalDocuments.get(tool.frameId) !== tool.documentId) {
      throw new Error("A WebMCP frame document changed during the final page identity check.");
    }
  }
}

function assertOperationCurrent(operation: WebMcpOperationIdentity) {
  operation.signal.throwIfAborted();
  if (!webMcpOperationIsCurrent(operation)) {
    throw new DOMException("The WebMCP operation became stale.", "AbortError");
  }
}

function generationToken(operation: WebMcpOperationIdentity) {
  return `${operation.sessionGeneration}:${operation.webMcpGeneration}`;
}

function frameOrigin(frame: WebMcpFrame) {
  if (frame.securityOrigin && frame.securityOrigin !== "://") return frame.securityOrigin;
  try {
    return new URL(frame.url).origin;
  } catch {
    throw new Error(`Chrome returned an invalid WebMCP frame URL: ${webMcpErrorMessage(frame.url)}`);
  }
}

function remoteExceptionText(value: unknown) {
  if (typeof value === "object" && value !== null) {
    const exception = value as { description?: unknown; value?: unknown };
    if (typeof exception.description === "string") return exception.description;
    if (typeof exception.value === "string") return exception.value;
  }
  return "The page reported an unknown tool error.";
}
