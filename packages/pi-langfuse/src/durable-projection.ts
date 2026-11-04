import type { EntryRecord } from "@earendil-works/pi-durable";
import { sanitizeTraceValue } from "./sanitizer.js";
import type { ObservationAttributes } from "./tracing.js";

type Message = NonNullable<EntryRecord["model"]>[number];
const MAX_PROJECTED_ITEMS = 199;

export function durableAttributes(attributes: ObservationAttributes): ObservationAttributes {
  const copy = { ...attributes };
  if (attributes.metadata) {
    const value = sanitizeTraceValue(attributes.metadata, true);
    copy.metadata =
      value && typeof value === "object" && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : { "pi.durable.metadata_omitted": true };
  }
  for (const key of ["name", "model", "sessionId", "userId", "statusMessage", "version"] as const) {
    if (typeof copy[key] === "string") copy[key] = String(sanitizeTraceValue(copy[key], true));
  }
  return copy;
}

export function durableDiagnosticCount(entry: EntryRecord | undefined): number {
  const data = entry?.data;
  return data &&
    typeof data === "object" &&
    !Array.isArray(data) &&
    "diagnostics" in data &&
    Array.isArray(data.diagnostics)
    ? data.diagnostics.length
    : 0;
}

/** Project committed messages without provider configuration, deltas or raw diagnostics. */
export function durableContent(
  messages: readonly Message[] | undefined,
  capture: boolean,
  diagnosticCount = 0,
): unknown {
  if (!capture) return "[content capture disabled]";
  const projected: unknown[] | undefined = messages?.slice(0, MAX_PROJECTED_ITEMS).map((message) => {
    if (message.role === "toolResult" && message.isError)
      return { role: message.role, content: "[tool error content omitted]" };
    if (message.role === "assistant" && message.stopReason === "error")
      return { role: message.role, content: "[assistant error content omitted]" };
    // The public ToolResultEntry shape appends rendered diagnostics as its last text block.
    // That block can contain raw errors, headers or credentials even when the tool succeeds.
    const omitDiagnosticBlock =
      message.role === "toolResult" && diagnosticCount > 0 && message.content.at(-1)?.type === "text";
    const blockCount = message.content.length - (omitDiagnosticBlock ? 1 : 0);
    return {
      role: message.role,
      content:
        typeof message.content === "string"
          ? message.content
          : message.content.slice(0, Math.min(MAX_PROJECTED_ITEMS, blockCount)).map((block) => {
              switch (block.type) {
                case "text":
                  return { type: "text", text: block.text };
                case "thinking":
                  return { type: "thinking", thinking: block.thinking };
                case "toolCall":
                  return { type: "toolCall", id: block.id, name: block.name, arguments: block.arguments };
                case "image":
                  return { type: "image", mimeType: block.mimeType, data: "[base64 omitted]" };
                default:
                  return { type: "unsupported", content: "[block omitted]" };
              }
            }),
      ...(Array.isArray(message.content) && blockCount > MAX_PROJECTED_ITEMS
        ? { blocksOmitted: blockCount - MAX_PROJECTED_ITEMS }
        : {}),
      ...(omitDiagnosticBlock ? { diagnosticsOmitted: diagnosticCount } : {}),
    };
  });
  if (messages && messages.length > MAX_PROJECTED_ITEMS)
    projected?.push({ messagesOmitted: messages.length - MAX_PROJECTED_ITEMS });
  return sanitizeTraceValue(projected, true);
}

export function durableUsage(message: Message): ObservationAttributes {
  if ((message.role !== "assistant" && message.role !== "toolResult") || !message.usage) return {};
  const usageDetails: Record<string, number> = {};
  const costDetails: Record<string, number> = {};
  for (const [key, field] of [
    ["input", "input"],
    ["output", "output"],
    ["cacheRead", "cache_read_input_tokens"],
    ["cacheWrite", "cache_creation_input_tokens"],
    ["totalTokens", "total"],
  ] as const) {
    const value = message.usage[key];
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) usageDetails[field] = value;
  }
  for (const [key, field] of [
    ["input", "input"],
    ["output", "output"],
    ["cacheRead", "cache_read"],
    ["cacheWrite", "cache_write"],
    ["total", "total"],
  ] as const) {
    const value = message.usage.cost[key];
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) costDetails[field] = value;
  }
  return {
    usageDetails,
    costDetails,
    ...(typeof message.usage.cost.totalFromProvider === "boolean"
      ? { metadata: { "pi.usage.cost.total_from_provider": message.usage.cost.totalFromProvider } }
      : {}),
  };
}
