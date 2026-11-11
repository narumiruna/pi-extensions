import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { contentText } from "@earendil-works/pi-ai";
import { convertToLlm } from "@earendil-works/pi-coding-agent";

export const TYPESAFE_COMPACT_DETAILS_KIND = "pi-typesafe-compact";
export const TYPESAFE_COMPACT_DETAILS_VERSION = 1;
export const MAX_HISTORY_UNITS = 512;
export const MAX_UNIT_CHARS = 32 * 1024;
export const MAX_UNIT_LABEL_CHARS = 512;
export const MAX_TOOL_RESULT_CHARS = 2_000;
export const MAX_RETAINED_BYTES = 256 * 1024;
export const MAX_COMPACTION_SUMMARY_BYTES = 512 * 1024;
export const MAX_COMPACTION_DETAILS_BYTES = 768 * 1024;

export type HistoryUnitKind =
  | "user-text"
  | "user-image"
  | "assistant-text"
  | "assistant-thinking"
  | "tool-call"
  | "tool-result-text"
  | "tool-result-image"
  | "bash-execution"
  | "custom-text"
  | "custom-image"
  | "branch-summary"
  | "compaction-summary";

export type HistoryUnitSource = "prior-retained" | "history" | "turn-prefix";

export interface HistoryUnit {
  id: string;
  order: number;
  kind: HistoryUnitKind;
  source: HistoryUnitSource;
  label: string;
  content: string;
}

export interface TypeSafeCompactDetails {
  kind: typeof TYPESAFE_COMPACT_DETAILS_KIND;
  version: typeof TYPESAFE_COMPACT_DETAILS_VERSION;
  compressedSummary: string;
  retainedUnits: HistoryUnit[];
  evaluator: {
    model: "jev-latest";
    evaluated: number;
    summarized: number;
    retained: number;
    inputTokens: number;
    outputTokens: number;
  };
  readFiles: string[];
  modifiedFiles: string[];
}

export class HistoryBoundsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HistoryBoundsError";
  }
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function boundedText(value: string, label: string): string {
  if (value.length > MAX_UNIT_CHARS) {
    throw new HistoryBoundsError(`${label} exceeds the ${MAX_UNIT_CHARS}-character unit limit`);
  }
  return value;
}

function boundedLabel(value: string): string {
  if (value.length > MAX_UNIT_LABEL_CHARS) {
    throw new HistoryBoundsError(`history unit label exceeds the ${MAX_UNIT_LABEL_CHARS}-character limit`);
  }
  return value;
}

function toolResultText(value: string): string {
  if (value.length <= MAX_TOOL_RESULT_CHARS) return value;
  return `${value.slice(0, MAX_TOOL_RESULT_CHARS)}\n[${value.length - MAX_TOOL_RESULT_CHARS} characters truncated]`;
}

function safeJson(value: unknown, label: string): string {
  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw new HistoryBoundsError(`${label} is not JSON-serializable`);
  }
  return boundedText(serialized ?? "null", label);
}

function imageDescription(mimeType: string, data: string): string {
  return `[image omitted from compaction evaluation: mimeType=${safeJson(mimeType, "image MIME type")}, base64Characters=${data.length}]`;
}

interface UnitDraft {
  kind: HistoryUnitKind;
  label: string;
  content: string;
}

function contentDrafts(
  role: "user" | "custom",
  content: string | Array<{ type: string; text?: string; data?: string; mimeType?: string }>,
  customType?: string,
): UnitDraft[] {
  const prefix = role === "user" ? "User" : `Custom message ${customType ?? "unknown"}`;
  if (typeof content === "string") {
    return [
      {
        kind: role === "user" ? "user-text" : "custom-text",
        label: prefix,
        content: boundedText(content, prefix),
      },
    ];
  }
  return content.map((block) => {
    if (block.type === "image") {
      return {
        kind: role === "user" ? "user-image" : "custom-image",
        label: `${prefix} image`,
        content: imageDescription(block.mimeType ?? "unknown", block.data ?? ""),
      };
    }
    return {
      kind: role === "user" ? "user-text" : "custom-text",
      label: prefix,
      content: boundedText(block.text ?? "", prefix),
    };
  });
}

function draftsForMessage(message: AgentMessage): UnitDraft[] {
  switch (message.role) {
    case "system":
      return [];
    case "user":
      return contentDrafts("user", message.content);
    case "assistant":
      return message.content.map((block) => {
        if (block.type === "toolCall") {
          return {
            kind: "tool-call",
            label: `Assistant tool call ${block.name} (${block.id})`,
            content: safeJson(
              { id: block.id, name: block.name, arguments: block.arguments, namespace: block.namespace },
              `tool call ${block.name}`,
            ),
          };
        }
        if (block.type === "thinking") {
          return {
            kind: "assistant-thinking",
            label: "Assistant thinking",
            content: boundedText(block.thinking, "assistant thinking"),
          };
        }
        return {
          kind: "assistant-text",
          label: "Assistant",
          content: boundedText(block.text, "assistant text"),
        };
      });
    case "toolResult":
      return message.content.map((block) =>
        block.type === "image"
          ? {
              kind: "tool-result-image",
              label: `Tool result ${message.toolName} (${message.toolCallId}) image`,
              content: imageDescription(block.mimeType, block.data),
            }
          : {
              kind: "tool-result-text",
              label: `Tool result ${message.toolName} (${message.toolCallId})${message.isError ? " error" : ""}`,
              content: toolResultText(block.text),
            },
      );
    case "bashExecution": {
      const [converted] = convertToLlm([message]);
      if (converted?.role !== "user") return [];
      return [
        {
          kind: "bash-execution",
          label: `User shell command${message.cancelled ? " cancelled" : ""}`,
          content: boundedText(contentText(converted.content), "bash execution"),
        },
      ];
    }
    case "custom":
      return contentDrafts("custom", message.content, message.customType);
    case "branchSummary":
      return [
        {
          kind: "branch-summary",
          label: "Branch summary",
          content: boundedText(message.summary, "branch summary"),
        },
      ];
    case "compactionSummary":
      return [
        {
          kind: "compaction-summary",
          label: "Compaction summary",
          content: boundedText(message.summary, "compaction summary"),
        },
      ];
  }
}

export function buildHistoryUnits(
  messages: readonly AgentMessage[],
  source: Exclude<HistoryUnitSource, "prior-retained">,
  startOrder = 0,
): HistoryUnit[] {
  const units: HistoryUnit[] = [];
  for (const message of messages) {
    for (const draft of draftsForMessage(message)) {
      const order = startOrder + units.length;
      units.push({
        id: `unit-${String(order).padStart(6, "0")}`,
        order,
        source,
        ...draft,
        label: boundedLabel(draft.label),
      });
      if (units.length + startOrder > MAX_HISTORY_UNITS) {
        throw new HistoryBoundsError(`history exceeds the ${MAX_HISTORY_UNITS}-unit limit`);
      }
    }
  }
  return units;
}

export function combineHistoryUnits(
  priorRetained: readonly HistoryUnit[],
  history: readonly AgentMessage[],
  turnPrefix: readonly AgentMessage[],
): HistoryUnit[] {
  const drafts: Omit<HistoryUnit, "id" | "order">[] = [
    ...priorRetained.map(({ kind, label, content }) => ({
      kind,
      label: boundedLabel(label),
      content,
      source: "prior-retained" as const,
    })),
    ...buildHistoryUnits(history, "history").map(({ kind, label, content, source }) => ({
      kind,
      label,
      content,
      source,
    })),
    ...buildHistoryUnits(turnPrefix, "turn-prefix").map(({ kind, label, content, source }) => ({
      kind,
      label,
      content,
      source,
    })),
  ];
  if (drafts.length > MAX_HISTORY_UNITS) {
    throw new HistoryBoundsError(`history exceeds the ${MAX_HISTORY_UNITS}-unit limit`);
  }
  return drafts.map((draft, order) => ({
    id: `unit-${String(order).padStart(6, "0")}`,
    order,
    ...draft,
  }));
}

function longestBacktickRun(value: string): number {
  let longest = 0;
  for (const match of value.matchAll(/`+/gu)) longest = Math.max(longest, match[0].length);
  return longest;
}

export function formatUnits(units: readonly HistoryUnit[]): string {
  const payload = JSON.stringify(
    units.map(({ id, order, kind, source, label, content }) => ({ id, order, kind, source, label, content })),
    null,
    2,
  );
  const fence = "`".repeat(Math.max(3, longestBacktickRun(payload) + 1));
  return `${fence}json\n${payload}\n${fence}`;
}

export function composeCompactionSummary(compressedSummary: string, retainedUnits: readonly HistoryUnit[]): string {
  const retained =
    retainedUnits.length === 0
      ? "No history units were retained verbatim."
      : `These independently evaluated units were retained as labelled data rather than summarized:\n\n${formatUnits(retainedUnits)}`;
  const summary = `## Compressed history\n\n${compressedSummary.trim() || "No history units were selected for summarization."}\n\n## Retained history\n\n${retained}`;
  if (byteLength(summary) > MAX_COMPACTION_SUMMARY_BYTES) {
    throw new HistoryBoundsError("composed compaction summary exceeds the 512 KiB limit");
  }
  return summary;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const UNIT_KINDS = new Set<HistoryUnitKind>([
  "user-text",
  "user-image",
  "assistant-text",
  "assistant-thinking",
  "tool-call",
  "tool-result-text",
  "tool-result-image",
  "bash-execution",
  "custom-text",
  "custom-image",
  "branch-summary",
  "compaction-summary",
]);
const UNIT_SOURCES = new Set<HistoryUnitSource>(["prior-retained", "history", "turn-prefix"]);

function parseUnit(value: unknown): HistoryUnit | undefined {
  if (!isRecord(value)) return undefined;
  if (
    typeof value.id !== "string" ||
    value.id.length > 64 ||
    typeof value.order !== "number" ||
    !Number.isSafeInteger(value.order) ||
    value.order < 0 ||
    typeof value.kind !== "string" ||
    !UNIT_KINDS.has(value.kind as HistoryUnitKind) ||
    typeof value.source !== "string" ||
    !UNIT_SOURCES.has(value.source as HistoryUnitSource) ||
    typeof value.label !== "string" ||
    value.label.length > MAX_UNIT_LABEL_CHARS ||
    typeof value.content !== "string" ||
    value.content.length > MAX_UNIT_CHARS + 128
  ) {
    return undefined;
  }
  return value as unknown as HistoryUnit;
}

function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item.length > MAX_UNIT_CHARS)) {
    return undefined;
  }
  return [...value];
}

export function parseTypeSafeCompactDetails(value: unknown): TypeSafeCompactDetails | undefined {
  if (!isRecord(value) || value.kind !== TYPESAFE_COMPACT_DETAILS_KIND || value.version !== 1) return undefined;
  try {
    if (byteLength(JSON.stringify(value)) > MAX_COMPACTION_DETAILS_BYTES) return undefined;
  } catch {
    return undefined;
  }
  if (
    typeof value.compressedSummary !== "string" ||
    byteLength(value.compressedSummary) > MAX_COMPACTION_SUMMARY_BYTES
  ) {
    return undefined;
  }
  if (!Array.isArray(value.retainedUnits) || value.retainedUnits.length > MAX_HISTORY_UNITS) return undefined;
  const retainedUnits = value.retainedUnits.map(parseUnit);
  if (retainedUnits.some((unit) => unit === undefined)) return undefined;
  if (byteLength(JSON.stringify(retainedUnits)) > MAX_RETAINED_BYTES) return undefined;
  if (!isRecord(value.evaluator) || value.evaluator.model !== "jev-latest") return undefined;
  for (const field of ["evaluated", "summarized", "retained", "inputTokens", "outputTokens"] as const) {
    if (
      typeof value.evaluator[field] !== "number" ||
      !Number.isSafeInteger(value.evaluator[field]) ||
      value.evaluator[field] < 0
    ) {
      return undefined;
    }
  }
  const readFiles = stringArray(value.readFiles);
  const modifiedFiles = stringArray(value.modifiedFiles);
  if (!readFiles || !modifiedFiles) return undefined;
  return {
    kind: TYPESAFE_COMPACT_DETAILS_KIND,
    version: TYPESAFE_COMPACT_DETAILS_VERSION,
    compressedSummary: value.compressedSummary,
    retainedUnits: retainedUnits as HistoryUnit[],
    evaluator: value.evaluator as TypeSafeCompactDetails["evaluator"],
    readFiles,
    modifiedFiles,
  };
}

export function assertRetainedUnitsBounded(units: readonly HistoryUnit[]): void {
  for (const unit of units) boundedLabel(unit.label);
  if (units.length > MAX_HISTORY_UNITS) {
    throw new HistoryBoundsError(`retained history exceeds the ${MAX_HISTORY_UNITS}-unit limit`);
  }
  if (byteLength(JSON.stringify(units)) > MAX_RETAINED_BYTES) {
    throw new HistoryBoundsError("retained history exceeds the 256 KiB limit");
  }
}

export function fileOperationLists(fileOps: { read: Set<string>; written: Set<string>; edited: Set<string> }): {
  readFiles: string[];
  modifiedFiles: string[];
} {
  const modified = new Set([...fileOps.written, ...fileOps.edited]);
  return {
    readFiles: [...fileOps.read].filter((file) => !modified.has(file)),
    modifiedFiles: [...modified],
  };
}

export function appendFileOperations(
  summary: string,
  readFiles: readonly string[],
  modifiedFiles: readonly string[],
): string {
  return `${summary}\n\n<read-files>\n${readFiles.join("\n")}\n</read-files>\n\n<modified-files>\n${modifiedFiles.join("\n")}\n</modified-files>`;
}
