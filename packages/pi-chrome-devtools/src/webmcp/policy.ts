import { createHash } from "node:crypto";
import { stripVTControlCharacters } from "node:util";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize, truncateHead } from "@earendil-works/pi-coding-agent";
import type { TSchema } from "typebox";
import { Check } from "typebox/value";
import type { WebMcpProtocolAnnotation, WebMcpProtocolTool } from "./protocol.js";

export const MAX_WEBMCP_TOOLS = 100;
const MAX_SCHEMA_BYTES = 64 * 1024;
const MAX_INPUT_BYTES = 64 * 1024;
const MAX_OUTPUT_BYTES = 1024 * 1024;
const MAX_JSON_DEPTH = 32;
const MAX_JSON_NODES = 10_000;
const MAX_OUTPUT_NODES = 100_000;
const MAX_SCHEMA_VALIDATION_BRANCHES = 128;

export interface WebMcpToolDescriptor {
  annotations: WebMcpProtocolAnnotation;
  description: string;
  documentId: string;
  frameId: string;
  frameOrigin: string;
  inputSchema: Record<string, unknown>;
  name: string;
  pageId: string;
  pageUrl: string;
  schemaDigest: string;
  sessionGeneration: string;
  title?: string;
}

export interface WebMcpToolIdentity {
  documentId: string;
  frameId: string;
  frameOrigin: string;
  name: string;
  pageId: string;
  schemaDigest: string;
  sessionGeneration: string;
}

export function normalizeWebMcpTool(
  tool: WebMcpProtocolTool,
  context: {
    documentId: string;
    frameOrigin: string;
    pageId: string;
    pageUrl: string;
    sessionGeneration: string;
  },
): WebMcpToolDescriptor {
  const name = boundedString(tool.name, "tool name", 512, { nonEmpty: true });
  const description = boundedString(tool.description, "tool description", 16 * 1024);
  const title = tool.title === undefined ? undefined : boundedString(tool.title, "tool title", 1_024);
  const documentId = boundedString(context.documentId, "document loader ID", 512, {
    nonEmpty: true,
  });
  const frameId = boundedString(tool.frameId, "frame ID", 512, { nonEmpty: true });
  const frameOrigin = boundedString(context.frameOrigin, "frame origin", 2_048, {
    nonEmpty: true,
  });
  const pageId = boundedString(context.pageId, "page ID", 512, { nonEmpty: true });
  const pageUrl = boundedString(context.pageUrl, "page URL", 8_192);
  const inputSchema = tool.inputSchema ?? { type: "object", additionalProperties: true };
  rejectRegexBearingSchema(inputSchema);
  const canonicalSchema = canonicalJsonObject(inputSchema, {
    label: "WebMCP input schema",
    maxBytes: MAX_SCHEMA_BYTES,
    maxDepth: MAX_JSON_DEPTH,
    maxNodes: MAX_JSON_NODES,
  });
  rejectExpensiveValidationSchema(canonicalSchema);
  const annotations = canonicalAnnotations(tool.annotations);
  const schemaDigest = createHash("sha256")
    .update(canonicalStringify({ inputSchema: canonicalSchema, annotations }))
    .digest("hex");
  return {
    annotations,
    description,
    documentId,
    frameId,
    frameOrigin,
    inputSchema: canonicalSchema,
    name,
    pageId,
    pageUrl,
    schemaDigest,
    sessionGeneration: context.sessionGeneration,
    ...(title === undefined ? {} : { title }),
  };
}

export function webMcpIdentity(tool: WebMcpToolDescriptor): WebMcpToolIdentity {
  return {
    sessionGeneration: tool.sessionGeneration,
    pageId: tool.pageId,
    documentId: tool.documentId,
    frameId: tool.frameId,
    frameOrigin: tool.frameOrigin,
    name: tool.name,
    schemaDigest: tool.schemaDigest,
  };
}

export function requireMatchingWebMcpTool(tools: readonly WebMcpToolDescriptor[], expected: WebMcpToolIdentity) {
  const candidates = tools.filter((tool) => tool.frameId === expected.frameId && tool.name === expected.name);
  if (candidates.length === 0) throw new Error("The selected WebMCP tool is no longer available.");
  if (candidates.length > 1) {
    throw new Error("The selected WebMCP tool identity is ambiguous in its frame.");
  }
  const current = candidates[0];
  if (!current) throw new Error("The selected WebMCP tool is no longer available.");
  const mismatches = (
    [
      ["session generation", current.sessionGeneration, expected.sessionGeneration],
      ["page", current.pageId, expected.pageId],
      ["document", current.documentId, expected.documentId],
      ["frame", current.frameId, expected.frameId],
      ["frame origin", current.frameOrigin, expected.frameOrigin],
      ["schema or annotations", current.schemaDigest, expected.schemaDigest],
    ] as const
  ).flatMap(([label, actual, wanted]) => (actual === wanted ? [] : [label]));
  if (mismatches.length > 0) {
    throw new Error(`The selected WebMCP tool became stale: ${mismatches.join(", ")} changed.`);
  }
  return current;
}

export function normalizeWebMcpInput(input: Record<string, unknown>) {
  return canonicalJsonObject(input, {
    label: "WebMCP tool input",
    maxBytes: MAX_INPUT_BYTES,
    maxDepth: MAX_JSON_DEPTH,
    maxNodes: MAX_JSON_NODES,
  });
}

export function validateWebMcpInput(schema: Record<string, unknown>, input: Record<string, unknown>) {
  const normalized = normalizeWebMcpInput(input);
  let valid: boolean;
  try {
    valid = Check(schema as TSchema, normalized);
  } catch (error) {
    throw new Error(
      `The page provided a WebMCP input schema that cannot be validated: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!valid) throw new Error("WebMCP tool input does not match the current page-provided schema.");
  return normalized;
}

export function normalizeWebMcpOutput(output: unknown) {
  return canonicalJsonValue(output, {
    label: "WebMCP tool output",
    maxBytes: MAX_OUTPUT_BYTES,
    maxDepth: MAX_JSON_DEPTH * 2,
    maxNodes: MAX_OUTPUT_NODES,
  });
}

export function boundedWebMcpDiscovery(
  page: { id: string; title: string; url: string },
  tools: readonly WebMcpToolDescriptor[],
) {
  const included: WebMcpToolDescriptor[] = [];
  for (const tool of tools) {
    const candidate = [...included, tool];
    const publication = boundedWebMcpJson({
      page,
      tools: candidate,
      totalToolCount: tools.length,
      truncated: candidate.length < tools.length,
    });
    if (publication.truncated) break;
    included.push(tool);
  }
  const truncated = included.length < tools.length;
  const publication = boundedWebMcpJson({
    page,
    tools: included,
    totalToolCount: tools.length,
    truncated,
  });
  if (publication.truncated) {
    throw new Error("WebMCP discovery metadata cannot fit within Pi's output limit.");
  }
  return { ...publication, included, truncated };
}

export function boundedWebMcpJson(value: unknown) {
  const serialized = sanitizeWebMcpDisplay(JSON.stringify(value, null, 2), Number.MAX_SAFE_INTEGER);
  const result = truncateHead(serialized, {
    maxBytes: Math.max(1, DEFAULT_MAX_BYTES - 256),
    maxLines: Math.max(1, DEFAULT_MAX_LINES - 2),
  });
  if (!result.truncated) return { text: result.content, truncated: false };
  const notice = `\n[WebMCP output truncated: ${result.outputLines}/${result.totalLines} lines, ${formatSize(result.outputBytes)}/${formatSize(result.totalBytes)}.]`;
  return { text: `${result.content}${notice}`, truncated: true };
}

export function webMcpConfirmationMessage(
  tool: WebMcpToolDescriptor,
  input: Record<string, unknown>,
  managedProfile: boolean,
) {
  const inputSummary = sanitizeWebMcpDisplay(JSON.stringify(input, null, 2), 2_000);
  return [
    managedProfile
      ? "This call uses the isolated browser profile managed by Pi."
      : "Warning: this call uses an attached browser profile that may contain everyday authenticated sessions and sensitive state.",
    `Page: ${sanitizeWebMcpDisplay(tool.pageUrl, 4_096)}`,
    `Frame origin: ${sanitizeWebMcpDisplay(tool.frameOrigin, 2_048)}`,
    `Tool: ${sanitizeWebMcpDisplay(tool.name, 512)}`,
    "Page annotations are untrusted and do not bypass this confirmation.",
    "Input:",
    inputSummary,
  ].join("\n");
}

export function sanitizeWebMcpDisplay(value: string, maxCharacters = 50_000) {
  const withoutBidi = stripVTControlCharacters(value).replace(/[\u202a-\u202e\u2066-\u2069]/gu, "�");
  const sanitized = Array.from(withoutBidi, (character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    const unsafeControl =
      (codePoint >= 0 && codePoint <= 8) ||
      (codePoint >= 11 && codePoint <= 31) ||
      (codePoint >= 127 && codePoint <= 159);
    return unsafeControl ? "�" : character;
  }).join("");
  if (sanitized.length <= maxCharacters) return sanitized;
  return `${sanitized.slice(0, Math.max(0, maxCharacters - 1))}…`;
}

export function webMcpErrorMessage(error: unknown) {
  return sanitizeWebMcpDisplay(error instanceof Error ? error.message : String(error), 8_192);
}

function canonicalAnnotations(value: WebMcpProtocolAnnotation | undefined) {
  if (!value) return {};
  return Object.fromEntries(
    Object.entries(value)
      .filter((entry): entry is [string, boolean] => typeof entry[1] === "boolean")
      .sort(([left], [right]) => left.localeCompare(right)),
  ) as WebMcpProtocolAnnotation;
}

function rejectRegexBearingSchema(schema: unknown): void {
  if (Array.isArray(schema)) {
    for (const child of schema) rejectRegexBearingSchema(child);
    return;
  }
  if (!isRecord(schema)) return;
  if (schema.pattern !== undefined || schema.patternProperties !== undefined) {
    throw new Error(
      "WebMCP input schemas with pattern or patternProperties are unsupported because page-controlled regular expressions cannot be evaluated safely.",
    );
  }
  for (const keyword of [
    "additionalItems",
    "additionalProperties",
    "contains",
    "else",
    "if",
    "items",
    "not",
    "propertyNames",
    "then",
    "unevaluatedItems",
    "unevaluatedProperties",
  ] as const) {
    rejectRegexBearingSchema(schema[keyword]);
  }
  for (const keyword of ["allOf", "anyOf", "oneOf", "prefixItems"] as const) {
    if (Array.isArray(schema[keyword])) {
      for (const child of schema[keyword]) rejectRegexBearingSchema(child);
    }
  }
  for (const keyword of ["$defs", "definitions", "dependencies", "dependentSchemas", "properties"] as const) {
    if (!isRecord(schema[keyword])) continue;
    for (const child of Object.values(schema[keyword])) rejectRegexBearingSchema(child);
  }
}

function rejectExpensiveValidationSchema(schema: unknown) {
  let branches = 0;
  const countBranches = (count: number) => {
    branches += count;
    if (branches > MAX_SCHEMA_VALIDATION_BRANCHES) {
      throw new Error(`WebMCP input schema exceeds the validation branch limit of ${MAX_SCHEMA_VALIDATION_BRANCHES}.`);
    }
  };
  const visit = (candidate: unknown): void => {
    if (Array.isArray(candidate)) {
      for (const child of candidate) visit(child);
      return;
    }
    if (!isRecord(candidate)) return;
    for (const keyword of ["allOf", "anyOf", "oneOf"] as const) {
      const alternatives = candidate[keyword];
      if (Array.isArray(alternatives)) countBranches(alternatives.length);
    }
    for (const keyword of ["dependencies", "dependentSchemas"] as const) {
      const dependencies = candidate[keyword];
      if (!isRecord(dependencies)) continue;
      countBranches(Object.values(dependencies).filter(isRecord).length);
    }
    for (const child of Object.values(candidate)) visit(child);
  };
  visit(schema);
}

interface JsonLimits {
  label: string;
  maxBytes: number;
  maxDepth: number;
  maxNodes: number;
}

function canonicalJsonObject(value: Record<string, unknown>, limits: JsonLimits) {
  const canonical = canonicalJsonValue(value, limits);
  if (!isRecord(canonical)) throw new Error(`${limits.label} must be a JSON object.`);
  return canonical;
}

function canonicalJsonValue(value: unknown, limits: JsonLimits) {
  let nodes = 0;
  const visit = (candidate: unknown, depth: number): unknown => {
    nodes += 1;
    if (nodes > limits.maxNodes) {
      throw new Error(`${limits.label} exceeds the ${limits.maxNodes} value limit.`);
    }
    if (depth > limits.maxDepth) {
      throw new Error(`${limits.label} exceeds the depth limit of ${limits.maxDepth}.`);
    }
    if (candidate === null || typeof candidate === "string" || typeof candidate === "boolean") {
      return candidate;
    }
    if (typeof candidate === "number") {
      if (!Number.isFinite(candidate)) throw new Error(`${limits.label} contains a non-finite number.`);
      return candidate;
    }
    if (Array.isArray(candidate)) return candidate.map((entry) => visit(entry, depth + 1));
    if (isRecord(candidate)) {
      return Object.fromEntries(
        Object.keys(candidate)
          .sort()
          .map((key) => [key, visit(candidate[key], depth + 1)]),
      );
    }
    throw new Error(`${limits.label} contains a value that is not JSON-compatible.`);
  };
  const canonical = visit(value, 0);
  const serialized = canonicalStringify(canonical);
  const bytes = Buffer.byteLength(serialized, "utf8");
  if (bytes > limits.maxBytes) {
    throw new Error(`${limits.label} exceeds ${formatSize(limits.maxBytes)} (${formatSize(bytes)}).`);
  }
  return canonical;
}

function canonicalStringify(value: unknown) {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new Error("Value is not JSON-compatible.");
  return serialized;
}

function boundedString(value: string, label: string, maxBytes: number, options: { nonEmpty?: boolean } = {}) {
  if (options.nonEmpty && value.length === 0) throw new Error(`WebMCP ${label} must not be empty.`);
  const bytes = Buffer.byteLength(value, "utf8");
  if (bytes > maxBytes) throw new Error(`WebMCP ${label} exceeds ${formatSize(maxBytes)}.`);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
