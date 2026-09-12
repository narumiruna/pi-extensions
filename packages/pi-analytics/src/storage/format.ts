import type {
  GenerationOutcome,
  GenerationRecord,
  ProviderErrorCategory,
  ProviderErrorRecord,
  ProviderResponseRecord,
  RunOutcome,
  SettledRun,
  SkillActivationRecord,
  ToolCallRecord,
} from "../types.js";

export const MAX_STORED_RUN_BYTES = 1024 * 1024;
const MAX_STRING_LENGTH = 4096;
const MAX_NESTED_RECORDS = 20_000;
const TRIGGER_SOURCES = ["interactive", "rpc", "extension", "unknown"] as const;
const RUN_OUTCOMES = ["success", "recovered_success", "error", "aborted", "length", "interrupted"] as const;
const GENERATION_OUTCOMES = ["pending", "stop", "tool_use", "error", "aborted", "length", "interrupted"] as const;
const ERROR_CATEGORIES = [
  "dns",
  "timeout",
  "connection_refused",
  "connection_reset",
  "tls",
  "network_other",
  "provider_other",
] as const;

export class AnalyticsStorageFormatError extends Error {
  constructor(message: string, options: { cause?: unknown } = {}) {
    super(message, options);
    this.name = "AnalyticsStorageFormatError";
  }
}

export function encodeStoredRun(run: SettledRun): string {
  const encoded = `${JSON.stringify({
    formatVersion: 1,
    run: parseRun(run, { remaining: MAX_NESTED_RECORDS }),
  })}\n`;
  if (Buffer.byteLength(encoded) > MAX_STORED_RUN_BYTES) {
    throw new AnalyticsStorageFormatError("Analytics record is too large to store safely.");
  }
  return encoded;
}

export function decodeStoredRun(line: string): SettledRun {
  if (Buffer.byteLength(line) > MAX_STORED_RUN_BYTES) {
    throw new AnalyticsStorageFormatError("Analytics record is too large to read safely.");
  }
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch (error) {
    throw new AnalyticsStorageFormatError("Analytics record contains invalid JSON.", {
      cause: error,
    });
  }
  const envelope = asRecord(value, "analytics record");
  if (envelope.formatVersion !== 1) {
    throw new AnalyticsStorageFormatError("Analytics record uses an unsupported format version.");
  }
  return parseRun(envelope.run, { remaining: MAX_NESTED_RECORDS });
}

interface ParseBudget {
  remaining: number;
}

function parseRun(value: unknown, budget: ParseBudget): SettledRun {
  const run = asRecord(value, "run");
  return {
    id: requiredString(run.id, "run.id"),
    startedAtMs: timestampValue(run.startedAtMs, "run.startedAtMs"),
    finishedAtMs: timestampValue(run.finishedAtMs, "run.finishedAtMs"),
    durationMs: durationValue(run.durationMs, "run.durationMs"),
    triggerSource: enumValue(run.triggerSource, TRIGGER_SOURCES, "run.triggerSource"),
    ...optionalProperty("initialProvider", optionalString(run.initialProvider, "run.initialProvider")),
    ...optionalProperty("initialModel", optionalString(run.initialModel, "run.initialModel")),
    outcome: enumValue(run.outcome, RUN_OUTCOMES, "run.outcome") as RunOutcome,
    attemptCount: boundedCount(run.attemptCount, "run.attemptCount"),
    generations: boundedArray(run.generations, "run.generations", budget).map((item, index) =>
      parseGeneration(item, index, budget),
    ),
    tools: boundedArray(run.tools, "run.tools", budget).map(parseTool),
    skills: boundedArray(run.skills, "run.skills", budget).map(parseSkill),
    providerErrors: boundedArray(run.providerErrors, "run.providerErrors", budget).map(parseProviderError),
    toolErrorCount: boundedCount(run.toolErrorCount, "run.toolErrorCount"),
    providerErrorCount: boundedCount(run.providerErrorCount, "run.providerErrorCount"),
    recoveredErrorCount: boundedCount(run.recoveredErrorCount, "run.recoveredErrorCount"),
  };
}

function parseGeneration(value: unknown, index: number, budget: ParseBudget): GenerationRecord {
  const item = asRecord(value, `run.generations[${index}]`);
  const prefix = `run.generations[${index}]`;
  return {
    id: requiredString(item.id, `${prefix}.id`),
    ordinal: boundedCount(item.ordinal, `${prefix}.ordinal`),
    ...optionalProperty("provider", optionalString(item.provider, `${prefix}.provider`)),
    ...optionalProperty("model", optionalString(item.model, `${prefix}.model`)),
    ...optionalProperty("thinkingLevel", optionalString(item.thinkingLevel, `${prefix}.thinkingLevel`)),
    startedAtMs: timestampValue(item.startedAtMs, `${prefix}.startedAtMs`),
    ...optionalProperty("finishedAtMs", optionalTimestamp(item.finishedAtMs, `${prefix}.finishedAtMs`)),
    ...optionalProperty("durationMs", optionalDuration(item.durationMs, `${prefix}.durationMs`)),
    ...optionalProperty("stopReason", optionalString(item.stopReason, `${prefix}.stopReason`)),
    outcome: enumValue(item.outcome, GENERATION_OUTCOMES, `${prefix}.outcome`) as GenerationOutcome,
    responses: boundedArray(item.responses, `${prefix}.responses`, budget).map(parseProviderResponse),
  };
}

function parseProviderResponse(value: unknown, index: number): ProviderResponseRecord {
  const item = asRecord(value, `provider response ${index}`);
  return {
    ordinal: boundedCount(item.ordinal, "providerResponse.ordinal"),
    occurredAtMs: timestampValue(item.occurredAtMs, "providerResponse.occurredAtMs"),
    status: boundedInteger(item.status, "providerResponse.status", 999),
  };
}

function parseTool(value: unknown, index: number): ToolCallRecord {
  const item = asRecord(value, `run.tools[${index}]`);
  const prefix = `run.tools[${index}]`;
  const ordinal = boundedCount(item.ordinal, `${prefix}.ordinal`);
  return {
    id: `tool-${ordinal}`,
    ordinal,
    name: requiredString(item.name, `${prefix}.name`),
    ...optionalProperty("provider", optionalString(item.provider, `${prefix}.provider`)),
    ...optionalProperty("model", optionalString(item.model, `${prefix}.model`)),
    startedAtMs: timestampValue(item.startedAtMs, `${prefix}.startedAtMs`),
    ...optionalProperty("finishedAtMs", optionalTimestamp(item.finishedAtMs, `${prefix}.finishedAtMs`)),
    ...optionalProperty("durationMs", optionalDuration(item.durationMs, `${prefix}.durationMs`)),
    isError: booleanValue(item.isError, `${prefix}.isError`),
    completionState: enumValue(
      item.completionState,
      ["running", "finished", "interrupted"] as const,
      `${prefix}.completionState`,
    ),
  };
}

function parseSkill(value: unknown, index: number): SkillActivationRecord {
  const item = asRecord(value, `run.skills[${index}]`);
  const prefix = `run.skills[${index}]`;
  return {
    id: requiredString(item.id, `${prefix}.id`),
    name: requiredString(item.name, `${prefix}.name`),
    initiatedBy: enumValue(item.initiatedBy, ["user", "model"] as const, `${prefix}.initiatedBy`),
    occurredAtMs: timestampValue(item.occurredAtMs, `${prefix}.occurredAtMs`),
    ...optionalProperty("provider", optionalString(item.provider, `${prefix}.provider`)),
    ...optionalProperty("model", optionalString(item.model, `${prefix}.model`)),
  };
}

function parseProviderError(value: unknown, index: number): ProviderErrorRecord {
  const item = asRecord(value, `run.providerErrors[${index}]`);
  const prefix = `run.providerErrors[${index}]`;
  return {
    id: requiredString(item.id, `${prefix}.id`),
    ...optionalProperty("generationId", optionalString(item.generationId, `${prefix}.generationId`)),
    occurredAtMs: timestampValue(item.occurredAtMs, `${prefix}.occurredAtMs`),
    ...optionalProperty("provider", optionalString(item.provider, `${prefix}.provider`)),
    ...optionalProperty("model", optionalString(item.model, `${prefix}.model`)),
    category: enumValue(item.category, ERROR_CATEGORIES, `${prefix}.category`) as ProviderErrorCategory,
    recovered: booleanValue(item.recovered, `${prefix}.recovered`),
    terminal: booleanValue(item.terminal, `${prefix}.terminal`),
  };
}

function asRecord(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) invalid(name);
  return value as Record<string, unknown>;
}

function boundedArray(value: unknown, name: string, budget: ParseBudget): unknown[] {
  if (!Array.isArray(value)) invalid(name);
  budget.remaining -= value.length;
  if (budget.remaining < 0) {
    throw new AnalyticsStorageFormatError("Analytics record is too large to process safely.");
  }
  return value;
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_STRING_LENGTH) {
    invalid(name);
  }
  return value;
}

function optionalString(value: unknown, name: string): string | undefined {
  return value === undefined ? undefined : requiredString(value, name);
}

function boundedInteger(value: unknown, name: string, maximum: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > maximum) {
    invalid(name);
  }
  return value;
}

function timestampValue(value: unknown, name: string): number {
  return boundedInteger(value, name, Number.MAX_SAFE_INTEGER);
}

function optionalTimestamp(value: unknown, name: string): number | undefined {
  return value === undefined ? undefined : timestampValue(value, name);
}

function durationValue(value: unknown, name: string): number {
  return boundedInteger(value, name, Math.floor(Number.MAX_SAFE_INTEGER / MAX_NESTED_RECORDS));
}

function optionalDuration(value: unknown, name: string): number | undefined {
  return value === undefined ? undefined : durationValue(value, name);
}

function boundedCount(value: unknown, name: string): number {
  return boundedInteger(value, name, MAX_NESTED_RECORDS);
}

function booleanValue(value: unknown, name: string): boolean {
  if (typeof value !== "boolean") invalid(name);
  return value;
}

function enumValue<const T extends readonly string[]>(value: unknown, values: T, name: string): T[number] {
  if (typeof value !== "string" || !values.includes(value)) invalid(name);
  return value as T[number];
}

function optionalProperty<K extends string, T>(key: K, value: T | undefined): { [P in K]?: T } {
  return value === undefined ? {} : ({ [key]: value } as { [P in K]?: T });
}

function invalid(name: string): never {
  throw new AnalyticsStorageFormatError(`Analytics record has an invalid ${name}.`);
}
