import {
  type AssistantMetadataData,
  captureCompletedOutputTokens,
  isAssistantEstimatedCost,
  isAssistantMetadataData,
  isReportedTokenCount,
  isStampThinkingLevel,
  type StampThinkingLevel,
  sanitizeMetadataText,
  type ToolStampOutcome,
} from "./metadata.js";

export const STAMP_ENTRY_TYPE = "pi-stamp";

export interface MessageStampDataV1 {
  version: 1;
  role: "user" | "assistant";
  timestamp: number;
}

export interface MessageStampDataV2 {
  version: 2;
  role: "user" | "assistant";
  timestamp: number;
  previousTimestamp?: number;
}

export interface AssistantMessageStampDataV3 {
  version: 3;
  role: "assistant";
  timestamp: number;
  previousTimestamp?: number;
  completedAt: number;
  firstContentAt?: number;
}

export interface AssistantMessageStampDataV4 {
  version: 4;
  role: "assistant";
  timestamp: number;
  previousTimestamp?: number;
  completedAt?: number;
  firstContentAt?: number;
  metadata: AssistantMetadataData;
}

export interface AssistantMessageStampDataV5 {
  version: 5;
  role: "assistant";
  timestamp: number;
  previousTimestamp?: number;
  completedAt?: number;
  firstContentAt?: number;
  metadata: AssistantMetadataData;
  thinkingLevel: StampThinkingLevel;
}

export interface AssistantMessageStampDataV6 {
  version: 6;
  role: "assistant";
  timestamp: number;
  previousTimestamp?: number;
  completedAt?: number;
  firstContentAt?: number;
  metadata?: AssistantMetadataData;
  thinkingLevel?: StampThinkingLevel;
  estimatedCost?: number;
  costSinceUser: number;
}

export interface AssistantMessageStampDataV7 extends Omit<AssistantMessageStampDataV6, "version" | "costSinceUser"> {
  version: 7;
  completedAt: number;
  timeSinceUserMs: number;
  costSinceUser?: number;
}

export interface AssistantMessageStampDataV8 extends Omit<AssistantMessageStampDataV7, "version" | "timeSinceUserMs"> {
  version: 8;
  outputTokens: number;
  timeSinceUserMs?: number;
}

export interface ToolStampDataV1 {
  version: 1;
  kind: "tool";
  toolCallId: string;
  toolName: string;
  startedAt: number;
  completedAt: number;
  outcome: ToolStampOutcome;
}

export type MessageStampData =
  | MessageStampDataV1
  | MessageStampDataV2
  | AssistantMessageStampDataV3
  | AssistantMessageStampDataV4
  | AssistantMessageStampDataV5
  | AssistantMessageStampDataV6
  | AssistantMessageStampDataV7
  | AssistantMessageStampDataV8;
export type StampEntryData = MessageStampData | ToolStampDataV1;

export function isMessageStampData(value: unknown): value is MessageStampData {
  if (!isRecord(value) || !isStampRole(value.role) || !isValidTimestamp(value.timestamp)) {
    return false;
  }
  if (value.version === 1) {
    return hasOnlyKeys(value, ["version", "role", "timestamp"]);
  }
  if (value.version === 2) {
    return (
      hasOnlyKeys(value, ["version", "role", "timestamp", "previousTimestamp"]) &&
      (!Object.hasOwn(value, "previousTimestamp") || isValidTimestamp(value.previousTimestamp))
    );
  }
  if (value.version === 3) {
    return (
      value.role === "assistant" &&
      hasOnlyKeys(value, ["version", "role", "timestamp", "previousTimestamp", "completedAt", "firstContentAt"]) &&
      isValidTimestamp(value.completedAt) &&
      value.completedAt >= value.timestamp &&
      (!Object.hasOwn(value, "previousTimestamp") || isValidTimestamp(value.previousTimestamp)) &&
      (!Object.hasOwn(value, "firstContentAt") ||
        (isValidTimestamp(value.firstContentAt) &&
          value.firstContentAt >= value.timestamp &&
          value.firstContentAt <= value.completedAt))
    );
  }
  if (value.version === 6 || value.version === 7 || value.version === 8) {
    return (
      value.role === "assistant" &&
      hasOnlyKeys(value, [
        "version",
        "role",
        "timestamp",
        "previousTimestamp",
        "completedAt",
        "firstContentAt",
        "metadata",
        "thinkingLevel",
        "estimatedCost",
        "costSinceUser",
        ...(value.version !== 6 ? ["timeSinceUserMs"] : []),
        ...(value.version === 8 ? ["outputTokens"] : []),
      ]) &&
      (value.version === 6 || isValidTimestamp(value.completedAt)) &&
      (value.version !== 8 ||
        (isReportedTokenCount(value.outputTokens) &&
          (value.completedAt as number) > value.timestamp &&
          (!Object.hasOwn(value, "metadata") || captureCompletedOutputTokens(value.metadata) !== undefined))) &&
      (!(value.version === 7 || Object.hasOwn(value, "timeSinceUserMs")) ||
        (typeof value.timeSinceUserMs === "number" &&
          Number.isFinite(value.timeSinceUserMs) &&
          value.timeSinceUserMs >= 0)) &&
      (!Object.hasOwn(value, "metadata") || isAssistantMetadataData(value.metadata)) &&
      (!Object.hasOwn(value, "thinkingLevel") || isStampThinkingLevel(value.thinkingLevel)) &&
      (Object.hasOwn(value, "costSinceUser")
        ? isAssistantEstimatedCost(value.costSinceUser) &&
          (!Object.hasOwn(value, "estimatedCost") ||
            (isAssistantEstimatedCost(value.estimatedCost) && value.estimatedCost <= value.costSinceUser))
        : value.version !== 6 && !Object.hasOwn(value, "estimatedCost")) &&
      hasValidOptionalAssistantTiming(value, value.timestamp)
    );
  }
  if ((value.version !== 4 && value.version !== 5) || value.role !== "assistant") return false;
  const allowedKeys = [
    "version",
    "role",
    "timestamp",
    "previousTimestamp",
    "completedAt",
    "firstContentAt",
    "metadata",
    ...(value.version === 5 ? ["thinkingLevel"] : []),
  ];
  return (
    hasOnlyKeys(value, allowedKeys) &&
    isAssistantMetadataData(value.metadata) &&
    (value.version !== 5 || isStampThinkingLevel(value.thinkingLevel)) &&
    hasValidOptionalAssistantTiming(value, value.timestamp)
  );
}

export function isToolStampData(value: unknown): value is ToolStampDataV1 {
  return (
    isRecord(value) &&
    value.version === 1 &&
    value.kind === "tool" &&
    hasOnlyKeys(value, ["version", "kind", "toolCallId", "toolName", "startedAt", "completedAt", "outcome"]) &&
    isSafePersistedText(value.toolCallId) &&
    isSafePersistedText(value.toolName) &&
    isValidTimestamp(value.startedAt) &&
    isValidTimestamp(value.completedAt) &&
    value.completedAt >= value.startedAt &&
    (value.outcome === "success" || value.outcome === "error")
  );
}

function hasValidOptionalAssistantTiming(value: Record<string, unknown>, timestamp: number): boolean {
  if (Object.hasOwn(value, "previousTimestamp") && !isValidTimestamp(value.previousTimestamp)) {
    return false;
  }
  if (!Object.hasOwn(value, "completedAt")) return !Object.hasOwn(value, "firstContentAt");
  return (
    isValidTimestamp(value.completedAt) &&
    value.completedAt >= timestamp &&
    (!Object.hasOwn(value, "firstContentAt") ||
      (isValidTimestamp(value.firstContentAt) &&
        value.firstContentAt >= timestamp &&
        value.firstContentAt <= value.completedAt))
  );
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const allowedKeys = new Set(allowed);
  return Object.keys(value).every((key) => allowedKeys.has(key));
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStampRole(value: unknown): value is MessageStampData["role"] {
  return value === "user" || value === "assistant";
}

export function isValidTimestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && !Number.isNaN(new Date(value).getTime());
}

export function isSafePersistedText(value: unknown): value is string {
  return typeof value === "string" && sanitizeMetadataText(value) === value;
}
