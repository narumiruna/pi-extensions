import { StringEnum } from "@earendil-works/pi-ai";
import { buildSessionContext, type ContextEvent, type SessionEntry } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export const TOOL_NAME = "update_progress";
export const PROGRESS_CONTEXT_MESSAGE_TYPE = "progress-status";
export const PROGRESS_CONTEXT_VERSION = 4;
export const PROGRESS_DETAILS_VERSION = 4;
export const PROGRESS_RESTORED_BOUNDARY_ENTRY_TYPE = "progress-restored-context-boundary";
export const MAX_PROGRESS_STEPS = 50;
export const MAX_PROGRESS_TEXT_LENGTH = 300;
export const MAX_PROGRESS_REASON_LENGTH = 200;

export const LEGACY_TODO_CONTEXT_MESSAGE_TYPE = "todo-list-status";
export const LEGACY_TODO_RESTORED_BOUNDARY_ENTRY_TYPE = "todo-restored-context-boundary";
export const UPDATE_TODO_TOOL_NAME = "update_todo_list";
export const TODO_WIDGET_TOOL_NAME = "todo_widget";

export const PROGRESS_RESTORED_BOUNDARY_VERSION = 1;
const TODO_DETAILS_VERSION = 3;
const PREVIOUS_TODO_DETAILS_VERSION = 2;
const LEGACY_TODO_DETAILS_VERSION = 1;
const PROGRESS_STATUSES = ["pending", "in_progress", "completed", "blocked"] as const;
const PREVIOUS_TODO_STATUSES = ["pending", "in_progress", "completed"] as const;
const RESUBMIT_GUIDANCE = "Fix the input and resubmit the complete steps array.";

type ProgressStatus = (typeof PROGRESS_STATUSES)[number];
type PreviousTodoStatus = (typeof PREVIOUS_TODO_STATUSES)[number];
type SupportedStateVersion = 1 | 2 | 3 | 4;

export interface ProgressStep {
  text: string;
  status: ProgressStatus;
  reason?: string;
}

export interface ProgressDetails {
  version: typeof PROGRESS_DETAILS_VERSION;
  steps: ProgressStep[];
}

interface TodoV3 {
  step: string;
  status: ProgressStatus;
  reason?: string;
}

interface PreviousTodo {
  step: string;
  status: PreviousTodoStatus;
}

interface LegacyTodoItem {
  text: string;
  status: PreviousTodoStatus;
}

export const ProgressParameters = Type.Object(
  {
    steps: Type.Array(
      Type.Object(
        {
          text: Type.String({
            minLength: 1,
            maxLength: MAX_PROGRESS_TEXT_LENGTH,
            description: "A concise, action-oriented step",
          }),
          status: StringEnum(PROGRESS_STATUSES, {
            description: "The step's current status",
          }),
          reason: Type.Optional(
            Type.String({
              minLength: 1,
              maxLength: MAX_PROGRESS_REASON_LENGTH,
              description: "Required only for blocked steps; explain what must unblock the step",
            }),
          ),
        },
        { additionalProperties: false },
      ),
      {
        maxItems: MAX_PROGRESS_STEPS,
        description: "The complete current progress state; send an empty array to clear it",
      },
    ),
  },
  { additionalProperties: false },
);

export function validateProgressArguments(value: unknown): { steps: ProgressStep[] } {
  if (!isRecord(value) || !hasOnlyKeys(value, ["steps"])) {
    rejectProgress("input must be an object containing only a steps array.");
  }
  if (!Array.isArray(value.steps)) rejectProgress("steps must be an array.");
  if (value.steps.length > MAX_PROGRESS_STEPS) {
    rejectProgress(`steps contains ${value.steps.length} items; the maximum is ${MAX_PROGRESS_STEPS}.`);
  }

  const steps: ProgressStep[] = [];
  const inProgressIndices: number[] = [];
  for (const [index, entry] of value.steps.entries()) {
    const item = index + 1;
    if (!isRecord(entry)) rejectProgress(`item ${item} must be an object.`);
    if (!hasOnlyKeys(entry, ["text", "status", "reason"])) {
      rejectProgress(`item ${item} contains an unsupported field.`);
    }
    if (typeof entry.text !== "string") rejectProgress(`item ${item} text must be a string.`);
    if (entry.text.trim().length === 0) {
      rejectProgress(`item ${item} text must contain non-whitespace text.`);
    }
    if (!hasMaxGraphemeLength(entry.text, MAX_PROGRESS_TEXT_LENGTH)) {
      rejectProgress(`item ${item} text exceeds ${MAX_PROGRESS_TEXT_LENGTH} characters.`);
    }
    if (!PROGRESS_STATUSES.includes(entry.status as ProgressStatus)) {
      rejectProgress(`item ${item} status must be pending, in_progress, completed, or blocked.`);
    }
    const status = entry.status as ProgressStatus;
    if (status === "in_progress") inProgressIndices.push(item);

    if (status === "blocked") {
      if (typeof entry.reason !== "string" || entry.reason.trim().length === 0) {
        rejectProgress(`item ${item} is blocked and requires a non-whitespace reason.`);
      }
      if (!hasMaxGraphemeLength(entry.reason, MAX_PROGRESS_REASON_LENGTH)) {
        rejectProgress(`item ${item} reason exceeds ${MAX_PROGRESS_REASON_LENGTH} characters.`);
      }
      steps.push({ text: entry.text, status, reason: entry.reason });
      continue;
    }
    if (Object.hasOwn(entry, "reason")) {
      rejectProgress(`item ${item} may include reason only when status is blocked.`);
    }
    steps.push({ text: entry.text, status });
  }

  if (inProgressIndices.length > 1) {
    rejectProgress(`items ${inProgressIndices.join(" and ")} are in_progress; keep at most one in_progress item.`);
  }
  return { steps };
}

export function cloneProgressSteps(steps: readonly ProgressStep[]): ProgressStep[] {
  return steps.map((step) => ({
    text: step.text,
    status: step.status,
    ...(step.reason === undefined ? {} : { reason: step.reason }),
  }));
}

export function allProgressCompleted(steps: readonly ProgressStep[]): boolean {
  return steps.length > 0 && steps.every((step) => step.status === "completed");
}

export function reconstructProgress(entries: readonly SessionEntry[]): ProgressStep[] {
  let restored: ProgressStep[] = [];
  for (const entry of entries) {
    if (entry.type !== "message") continue;
    const message = entry.message;
    if (message.role !== "toolResult" || message.isError) continue;
    const result = decodePersistedResult(message.toolName, message.details);
    if (result !== undefined) restored = result.steps;
  }
  return restored;
}

export function reconcileProgressContext(
  messages: ContextEvent["messages"],
  steps: readonly ProgressStep[],
  restoredBoundaryContent?: string,
): ContextEvent["messages"] {
  const existing = messages.filter(isOwnedContextMessage);
  const originalBoundary = leadingSummaryBoundary(messages);
  const established = messages[originalBoundary];
  const establishedContent =
    isOwnedContextMessage(established) && contextDescriptor(established.content) !== undefined
      ? established.content
      : undefined;
  const withoutExisting = messages.filter((message) => !isOwnedContextMessage(message));
  const summaryBoundary = leadingSummaryBoundary(withoutExisting);
  const currentContent =
    steps.length > 0 && !hasModelVisibleProgressState(withoutExisting, steps)
      ? progressContextContent(steps)
      : undefined;
  const content = hasLeadingSummary(withoutExisting, summaryBoundary)
    ? (restoredBoundaryContent ?? establishedContent ?? currentContent)
    : undefined;
  const descriptor = content === undefined ? undefined : contextDescriptor(content);
  if (
    descriptor !== undefined &&
    existing.length === 1 &&
    messages[originalBoundary] === existing[0] &&
    existing[0]?.content === content &&
    existing[0].customType === descriptor.customType &&
    hasContextVersion(existing[0], descriptor.version)
  ) {
    return messages;
  }
  if (existing.length === 0 && descriptor === undefined) return messages;
  if (descriptor === undefined || content === undefined) return withoutExisting;

  return [
    ...withoutExisting.slice(0, summaryBoundary),
    {
      role: "custom",
      customType: descriptor.customType,
      content,
      display: false,
      details: { version: descriptor.version },
      timestamp: 0,
    },
    ...withoutExisting.slice(summaryBoundary),
  ];
}

export function reconstructRestoredProgressBoundary(
  entries: readonly SessionEntry[],
): { summaryEpoch: string; content: string } | undefined {
  const summaryEpoch = leadingSummaryEpoch(buildSessionContext([...entries]).messages);
  if (!summaryEpoch) return undefined;
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (
      entry?.type !== "custom" ||
      (entry.customType !== PROGRESS_RESTORED_BOUNDARY_ENTRY_TYPE &&
        entry.customType !== LEGACY_TODO_RESTORED_BOUNDARY_ENTRY_TYPE)
    ) {
      continue;
    }
    if (!isRestoredBoundaryData(entry.data, summaryEpoch)) continue;
    return { summaryEpoch, content: entry.data.content };
  }
  return undefined;
}

export function progressBoundaryContent(messages: ContextEvent["messages"]): string | undefined {
  const message = messages[leadingSummaryBoundary(messages)];
  if (!isOwnedContextMessage(message)) return undefined;
  return contextDescriptor(message.content) === undefined ? undefined : message.content;
}

export function leadingSummaryEpoch(messages: ContextEvent["messages"]): string | undefined {
  const summaryStart = messages[0]?.role === "system" ? 1 : 0;
  const boundary = leadingSummaryBoundary(messages);
  return boundary === summaryStart ? undefined : JSON.stringify(messages.slice(summaryStart, boundary));
}

function rejectProgress(message: string): never {
  throw new Error(`Progress update rejected: ${message} ${RESUBMIT_GUIDANCE}`);
}

function progressContextContent(steps: readonly ProgressStep[]): string {
  return `${progressContextPrefix()}${JSON.stringify({ steps: cloneProgressSteps(steps) })}`;
}

function progressContextPrefix(): string {
  return `[PI PROGRESS STATUS v${PROGRESS_CONTEXT_VERSION}]\nCurrent progress steps as JSON data:\n`;
}

function todoContextPrefix(version: 1 | 2 | 3): string {
  return `[PI TODO STATUS v${version}]\nCurrent todo list as JSON data:\n`;
}

function todoV3ContextContent(todos: readonly TodoV3[]): string {
  return `${todoContextPrefix(3)}${JSON.stringify({ todos: cloneTodoV3(todos) })}`;
}

function previousTodoContextContent(todos: readonly PreviousTodo[]): string {
  const canonical = todos.map((todo) => ({ step: todo.step, status: todo.status }));
  return `${todoContextPrefix(2)}${JSON.stringify({ todos: canonical })}`;
}

function legacyTodoContextContent(items: readonly LegacyTodoItem[]): string {
  const canonical = items.map((item) => ({ text: item.text, status: item.status }));
  return `${todoContextPrefix(1)}${JSON.stringify(canonical)}`;
}

function contextDescriptor(
  content: string,
):
  | { customType: typeof PROGRESS_CONTEXT_MESSAGE_TYPE | typeof LEGACY_TODO_CONTEXT_MESSAGE_TYPE; version: number }
  | undefined {
  const progressPrefix = progressContextPrefix();
  if (content.startsWith(progressPrefix)) {
    try {
      const value: unknown = JSON.parse(content.slice(progressPrefix.length));
      if (!isRecord(value) || !hasOnlyKeys(value, ["steps"]) || !isProgressSteps(value.steps)) return undefined;
      if (value.steps.length === 0 || progressContextContent(value.steps) !== content) return undefined;
      return { customType: PROGRESS_CONTEXT_MESSAGE_TYPE, version: PROGRESS_CONTEXT_VERSION };
    } catch {
      return undefined;
    }
  }

  for (const version of [3, 2, 1] as const) {
    const prefix = todoContextPrefix(version);
    if (!content.startsWith(prefix)) continue;
    try {
      const value: unknown = JSON.parse(content.slice(prefix.length));
      if (version === 3) {
        if (!isRecord(value) || !hasOnlyKeys(value, ["todos"]) || !isTodoV3Array(value.todos)) return undefined;
        if (value.todos.length === 0 || todoV3ContextContent(value.todos) !== content) return undefined;
      } else if (version === 2) {
        if (!isRecord(value) || !hasOnlyKeys(value, ["todos"]) || !isPreviousTodos(value.todos)) return undefined;
        if (value.todos.length === 0 || previousTodoContextContent(value.todos) !== content) return undefined;
      } else {
        if (!isLegacyTodoItems(value) || value.length === 0 || legacyTodoContextContent(value) !== content) {
          return undefined;
        }
      }
      return { customType: LEGACY_TODO_CONTEXT_MESSAGE_TYPE, version };
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function hasModelVisibleProgressState(messages: ContextEvent["messages"], steps: readonly ProgressStep[]): boolean {
  const currentResults = new Map<string, { toolName: string; version: SupportedStateVersion; steps: ProgressStep[] }>();
  for (const message of messages) {
    if (message.role !== "toolResult" || message.isError) continue;
    const result = decodePersistedResult(message.toolName, message.details);
    if (result !== undefined && progressStepsEqual(result.steps, steps)) {
      currentResults.set(message.toolCallId, { toolName: message.toolName, ...result });
    }
  }
  if (currentResults.size === 0) return false;

  return messages.some(
    (message) =>
      message.role === "assistant" &&
      message.content.some((content) => {
        if (content.type !== "toolCall") return false;
        const result = currentResults.get(content.id);
        if (result === undefined || content.name !== result.toolName) return false;
        const argumentSteps = decodeToolArguments(result.toolName, result.version, content.arguments);
        return argumentSteps !== undefined && progressStepsEqual(argumentSteps, steps);
      }),
  );
}

function decodePersistedResult(
  toolName: string,
  value: unknown,
): { version: SupportedStateVersion; steps: ProgressStep[] } | undefined {
  if (!isRecord(value) || typeof value.version !== "number") return undefined;
  if (toolName === TOOL_NAME && value.version === PROGRESS_DETAILS_VERSION) {
    if (!hasOnlyKeys(value, ["version", "steps"]) || !isProgressSteps(value.steps)) return undefined;
    return { version: 4, steps: cloneProgressSteps(value.steps) };
  }
  if (toolName === UPDATE_TODO_TOOL_NAME && value.version === TODO_DETAILS_VERSION) {
    if (!hasOnlyKeys(value, ["version", "todos"]) || !isTodoV3Array(value.todos)) return undefined;
    return { version: 3, steps: migrateTodoV3(value.todos) };
  }
  if (
    (toolName === UPDATE_TODO_TOOL_NAME || toolName === TODO_WIDGET_TOOL_NAME) &&
    value.version === PREVIOUS_TODO_DETAILS_VERSION
  ) {
    if (!hasOnlyKeys(value, ["version", "todos"]) || !isPreviousTodos(value.todos)) return undefined;
    return { version: 2, steps: migratePreviousTodos(value.todos) };
  }
  if (
    (toolName === UPDATE_TODO_TOOL_NAME || toolName === TODO_WIDGET_TOOL_NAME) &&
    value.version === LEGACY_TODO_DETAILS_VERSION
  ) {
    if (!hasOnlyKeys(value, ["version", "items"]) || !isLegacyTodoItems(value.items)) return undefined;
    return { version: 1, steps: migrateLegacyItems(value.items) };
  }
  return undefined;
}

function decodeToolArguments(
  toolName: string,
  version: SupportedStateVersion,
  value: unknown,
): ProgressStep[] | undefined {
  if (!isRecord(value)) return undefined;
  if (toolName === TOOL_NAME && version === 4) {
    return hasOnlyKeys(value, ["steps"]) && isProgressSteps(value.steps) ? cloneProgressSteps(value.steps) : undefined;
  }
  if (toolName === UPDATE_TODO_TOOL_NAME && version === 3) {
    return hasOnlyKeys(value, ["todos"]) && isTodoV3Array(value.todos) ? migrateTodoV3(value.todos) : undefined;
  }
  if ((toolName === UPDATE_TODO_TOOL_NAME || toolName === TODO_WIDGET_TOOL_NAME) && version === 2) {
    return hasOnlyKeys(value, ["todos"]) && isPreviousTodos(value.todos)
      ? migratePreviousTodos(value.todos)
      : undefined;
  }
  if ((toolName === UPDATE_TODO_TOOL_NAME || toolName === TODO_WIDGET_TOOL_NAME) && version === 1) {
    return hasOnlyKeys(value, ["items"]) && isLegacyTodoItems(value.items)
      ? migrateLegacyItems(value.items)
      : undefined;
  }
  return undefined;
}

function isProgressSteps(value: unknown): value is ProgressStep[] {
  if (!Array.isArray(value) || value.length > MAX_PROGRESS_STEPS) return false;
  let inProgressCount = 0;
  for (const entry of value) {
    if (!isRecord(entry) || !hasOnlyKeys(entry, ["text", "status", "reason"])) return false;
    if (
      typeof entry.text !== "string" ||
      entry.text.trim().length === 0 ||
      !hasMaxGraphemeLength(entry.text, MAX_PROGRESS_TEXT_LENGTH) ||
      !PROGRESS_STATUSES.includes(entry.status as ProgressStatus)
    ) {
      return false;
    }
    if (entry.status === "in_progress") inProgressCount += 1;
    if (entry.status === "blocked") {
      if (
        typeof entry.reason !== "string" ||
        entry.reason.trim().length === 0 ||
        !hasMaxGraphemeLength(entry.reason, MAX_PROGRESS_REASON_LENGTH)
      ) {
        return false;
      }
    } else if (Object.hasOwn(entry, "reason")) {
      return false;
    }
  }
  return inProgressCount <= 1;
}

function isTodoV3Array(value: unknown): value is TodoV3[] {
  if (!Array.isArray(value) || value.length > MAX_PROGRESS_STEPS) return false;
  let inProgressCount = 0;
  for (const entry of value) {
    if (!isRecord(entry) || !hasOnlyKeys(entry, ["step", "status", "reason"])) return false;
    if (
      typeof entry.step !== "string" ||
      entry.step.trim().length === 0 ||
      !hasMaxGraphemeLength(entry.step, MAX_PROGRESS_TEXT_LENGTH) ||
      !PROGRESS_STATUSES.includes(entry.status as ProgressStatus)
    ) {
      return false;
    }
    if (entry.status === "in_progress") inProgressCount += 1;
    if (entry.status === "blocked") {
      if (
        typeof entry.reason !== "string" ||
        entry.reason.trim().length === 0 ||
        !hasMaxGraphemeLength(entry.reason, MAX_PROGRESS_REASON_LENGTH)
      ) {
        return false;
      }
    } else if (Object.hasOwn(entry, "reason")) {
      return false;
    }
  }
  return inProgressCount <= 1;
}

function isPreviousTodos(value: unknown): value is PreviousTodo[] {
  return hasPreviousTodoShape(value, "step");
}

function isLegacyTodoItems(value: unknown): value is LegacyTodoItem[] {
  return hasPreviousTodoShape(value, "text");
}

function hasPreviousTodoShape(value: unknown, textProperty: "step" | "text"): boolean {
  if (!Array.isArray(value) || value.length > MAX_PROGRESS_STEPS) return false;
  let inProgressCount = 0;
  for (const entry of value) {
    if (!isRecord(entry) || !hasOnlyKeys(entry, [textProperty, "status"])) return false;
    const text = entry[textProperty];
    if (
      typeof text !== "string" ||
      text.trim().length === 0 ||
      !hasMaxGraphemeLength(text, MAX_PROGRESS_TEXT_LENGTH) ||
      !PREVIOUS_TODO_STATUSES.includes(entry.status as PreviousTodoStatus)
    ) {
      return false;
    }
    if (entry.status === "in_progress") inProgressCount += 1;
  }
  return inProgressCount <= 1;
}

function migrateTodoV3(todos: readonly TodoV3[]): ProgressStep[] {
  return todos.map((todo) => ({
    text: todo.step,
    status: todo.status,
    ...(todo.reason === undefined ? {} : { reason: todo.reason }),
  }));
}

function migratePreviousTodos(todos: readonly PreviousTodo[]): ProgressStep[] {
  return todos.map((todo) => ({ text: todo.step, status: todo.status }));
}

function migrateLegacyItems(items: readonly LegacyTodoItem[]): ProgressStep[] {
  return items.map((item) => ({ text: item.text, status: item.status }));
}

function cloneTodoV3(todos: readonly TodoV3[]): TodoV3[] {
  return todos.map((todo) => ({
    step: todo.step,
    status: todo.status,
    ...(todo.reason === undefined ? {} : { reason: todo.reason }),
  }));
}

function progressStepsEqual(left: readonly ProgressStep[], right: readonly ProgressStep[]): boolean {
  return (
    left.length === right.length &&
    left.every(
      (step, index) =>
        step.text === right[index]?.text &&
        step.status === right[index]?.status &&
        step.reason === right[index]?.reason,
    )
  );
}

type OwnedContextMessage = Extract<ContextEvent["messages"][number], { role: "custom" }> & {
  content: string;
  customType: typeof PROGRESS_CONTEXT_MESSAGE_TYPE | typeof LEGACY_TODO_CONTEXT_MESSAGE_TYPE;
};

function isOwnedContextMessage(message: ContextEvent["messages"][number] | undefined): message is OwnedContextMessage {
  return (
    message?.role === "custom" &&
    (message.customType === PROGRESS_CONTEXT_MESSAGE_TYPE || message.customType === LEGACY_TODO_CONTEXT_MESSAGE_TYPE) &&
    typeof message.content === "string"
  );
}

function hasContextVersion(message: OwnedContextMessage, version: number): boolean {
  return isRecord(message.details) && message.details.version === version;
}

function isRestoredBoundaryData(
  value: unknown,
  summaryEpoch: string,
): value is { version: number; summaryEpoch: string; content: string } {
  return (
    isRecord(value) &&
    value.version === PROGRESS_RESTORED_BOUNDARY_VERSION &&
    value.summaryEpoch === summaryEpoch &&
    typeof value.content === "string" &&
    contextDescriptor(value.content) !== undefined
  );
}

function leadingSummaryBoundary(messages: ContextEvent["messages"]): number {
  let index = messages[0]?.role === "system" ? 1 : 0;
  while (index < messages.length) {
    const role = messages[index]?.role;
    if (role !== "compactionSummary" && role !== "branchSummary") break;
    index += 1;
  }
  return index;
}

function hasLeadingSummary(messages: ContextEvent["messages"], boundary: number): boolean {
  const summaryStart = messages[0]?.role === "system" ? 1 : 0;
  return boundary > summaryStart;
}

// Keep this aligned with TypeBox's maxLength guard so custom validation and schema validation agree.
function hasMaxGraphemeLength(value: string, maximum: number): boolean {
  let count = 0;
  let index = 0;
  while (index < value.length) {
    index = nextGraphemeClusterIndex(value, index);
    count += 1;
    if (count > maximum) return false;
  }
  return true;
}

function nextGraphemeClusterIndex(value: string, clusterStart: number): number {
  const start = value.codePointAt(clusterStart) ?? 0;
  let clusterEnd = clusterStart + codePointLength(start);
  clusterEnd = consumeGraphemeModifiers(value, clusterEnd);
  while (clusterEnd < value.length - 1 && value.codePointAt(clusterEnd) === 0x200d) {
    const next = value.codePointAt(clusterEnd + 1) ?? 0;
    clusterEnd += 1 + codePointLength(next);
    clusterEnd = consumeGraphemeModifiers(value, clusterEnd);
  }
  if (
    isBetween(start, 0x1f1e6, 0x1f1ff) &&
    clusterEnd < value.length &&
    isBetween(value.codePointAt(clusterEnd) ?? 0, 0x1f1e6, 0x1f1ff)
  ) {
    clusterEnd += codePointLength(value.codePointAt(clusterEnd) ?? 0);
  }
  return clusterEnd;
}

function consumeGraphemeModifiers(value: string, start: number): number {
  let index = start;
  while (index < value.length) {
    const point = value.codePointAt(index) ?? 0;
    if (!isCombiningMark(point) && !isBetween(point, 0xfe00, 0xfe0f)) break;
    index += codePointLength(point);
  }
  return index;
}

function isCombiningMark(value: number): boolean {
  return (
    isBetween(value, 0x0300, 0x036f) ||
    isBetween(value, 0x1ab0, 0x1aff) ||
    isBetween(value, 0x1dc0, 0x1dff) ||
    isBetween(value, 0xfe20, 0xfe2f)
  );
}

function codePointLength(value: number): number {
  return value > 0xffff ? 2 : 1;
}

function isBetween(value: number, minimum: number, maximum: number): boolean {
  return value >= minimum && value <= maximum;
}

function hasOnlyKeys(record: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(record).every((key) => allowed.includes(key)) && allowed.some((key) => Object.hasOwn(record, key));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
