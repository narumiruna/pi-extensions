import { StringEnum } from "@earendil-works/pi-ai";
import {
  buildSessionContext,
  type ContextEvent,
  type ExtensionAPI,
  type ExtensionContext,
  type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { DEFAULT_TODO_SETTINGS, loadTodoSettings, type TodoSettings, type TodoSettingsLoadResult } from "./settings.js";
import { renderCompletionSummary, renderTodoWidget, sanitizeTodoText } from "./widget-renderer.js";

export const TOOL_NAME = "update_todo_list";
export const WIDGET_KEY = "todo";
export const TODO_CONTEXT_MESSAGE_TYPE = "todo-list-status";
export const TODO_CONTEXT_VERSION = 3;
export const TODO_DETAILS_VERSION = 3;
export const TODO_RESTORED_BOUNDARY_ENTRY_TYPE = "todo-restored-context-boundary";
export const MAX_TODOS = 50;
export const MAX_TODO_STEP_LENGTH = 300;
export const MAX_TODO_REASON_LENGTH = 200;
export const COMPLETION_SUMMARY_MS = 3_000;

const TODO_RESTORED_BOUNDARY_VERSION = 1;
const PREVIOUS_TODO_CONTEXT_VERSION = 2;
const PREVIOUS_TODO_DETAILS_VERSION = 2;
const LEGACY_TODO_CONTEXT_VERSION = 1;
const LEGACY_TODO_DETAILS_VERSION = 1;
const WIDGET_OPTIONS = { placement: "aboveEditor" } as const;
const LEGACY_TOOL_NAME = "todo_widget";
const TODO_STATUSES = ["pending", "in_progress", "completed", "blocked"] as const;
const PREVIOUS_TODO_STATUSES = ["pending", "in_progress", "completed"] as const;
const RESUBMIT_GUIDANCE = "Fix the input and resubmit the complete todos array.";

type TodoStatus = (typeof TODO_STATUSES)[number];
type PreviousTodoStatus = (typeof PREVIOUS_TODO_STATUSES)[number];

export interface Todo {
  step: string;
  status: TodoStatus;
  reason?: string;
}

export interface TodoDetails {
  version: typeof TODO_DETAILS_VERSION;
  todos: Todo[];
}

interface PreviousTodo {
  step: string;
  status: PreviousTodoStatus;
}

interface LegacyTodoItem {
  text: string;
  status: PreviousTodoStatus;
}

export interface TodoWidgetDependencies {
  loadSettings?: typeof loadTodoSettings;
  setTimeout?: typeof globalThis.setTimeout;
  clearTimeout?: typeof globalThis.clearTimeout;
}

const TodoParameters = Type.Object({
  todos: Type.Array(
    Type.Object({
      step: Type.String({
        minLength: 1,
        maxLength: MAX_TODO_STEP_LENGTH,
        description: "A concise, action-oriented step",
      }),
      status: StringEnum(TODO_STATUSES, {
        description: "The step's current status",
      }),
      reason: Type.Optional(
        Type.String({
          minLength: 1,
          maxLength: MAX_TODO_REASON_LENGTH,
          description: "Required only for blocked todos; explain what must unblock the step",
        }),
      ),
    }),
    {
      maxItems: MAX_TODOS,
      description: "The complete current todo list; send an empty array to clear it",
    },
  ),
});

export default function todoWidgetExtension(pi: ExtensionAPI, dependencies: TodoWidgetDependencies = {}): void {
  const readSettings = dependencies.loadSettings ?? loadTodoSettings;
  const scheduleTimeout = dependencies.setTimeout ?? globalThis.setTimeout;
  const cancelTimeout = dependencies.clearTimeout ?? globalThis.clearTimeout;
  let activeSession: ExtensionContext["sessionManager"] | undefined;
  let todos: Todo[] = [];
  let settings = cloneDefaultSettings();
  let restoredBoundary: { summaryEpoch: string; content: string } | undefined;
  let settingsController = new AbortController();
  let generation = 0;
  let completionTimer: ReturnType<typeof globalThis.setTimeout> | undefined;
  let completionToken = 0;
  let completionSummaryHidden = false;

  const ownsSession = (ctx: ExtensionContext): boolean => ctx.sessionManager === activeSession;

  const cancelCompletionSummary = (): void => {
    completionToken += 1;
    if (completionTimer !== undefined) cancelTimeout(completionTimer);
    completionTimer = undefined;
  };

  const publish = (ctx: ExtensionContext): void => {
    if (!ownsSession(ctx) || ctx.mode !== "tui") return;
    if (!settings.widget.enabled || todos.length === 0 || completionSummaryHidden) {
      ctx.ui.setWidget(WIDGET_KEY, undefined);
      return;
    }

    const snapshot = cloneTodos(todos);
    const widgetSettings = { ...settings.widget };
    ctx.ui.setWidget(
      WIDGET_KEY,
      (tui, theme) => ({
        render: (width) =>
          renderTodoWidget(snapshot, theme, width, {
            settings: widgetSettings,
            terminalRows: tui.terminal.rows,
          }),
        invalidate: () => {},
      }),
      WIDGET_OPTIONS,
    );
  };

  const publishCompletionSummary = (ctx: ExtensionContext): void => {
    cancelCompletionSummary();
    completionSummaryHidden = false;
    if (!ownsSession(ctx) || ctx.mode !== "tui" || !settings.widget.enabled) {
      publish(ctx);
      return;
    }

    const total = todos.length;
    ctx.ui.setWidget(
      WIDGET_KEY,
      (_tui, theme) => ({
        render: (width) => renderCompletionSummary(total, theme, width),
        invalidate: () => {},
      }),
      WIDGET_OPTIONS,
    );
    const ownerSession = activeSession;
    const token = completionToken;
    completionTimer = scheduleTimeout(() => {
      if (
        completionToken !== token ||
        activeSession !== ownerSession ||
        ctx.sessionManager !== ownerSession ||
        !settings.widget.enabled ||
        !allTodosCompleted(todos)
      ) {
        return;
      }
      completionTimer = undefined;
      completionSummaryHidden = true;
      ctx.ui.setWidget(WIDGET_KEY, undefined);
    }, COMPLETION_SUMMARY_MS);
  };

  pi.registerTool({
    name: TOOL_NAME,
    label: "Todo List",
    description:
      "Replace the current session todo list with the complete supplied todos. Call update_todo_list whenever actual step state changes; keep at most one todo in_progress, require a reason for each blocked todo, and send an empty todos array to clear it.",
    promptSnippet: "Maintain the complete session todo list as multi-step work progresses",
    promptGuidelines: [
      "Use update_todo_list to track work with multiple meaningful steps; skip it for simple, single-step tasks.",
      "Use update_todo_list to keep the list aligned with actual work: mark a step in_progress before starting it, mark it completed as soon as it finishes, and revise the list before continuing when the plan changes.",
      "Use blocked with a concise reason only when progress depends on an external action or condition; blocked does not mean completed.",
      "Before a progress report or final response, call update_todo_list to reconcile every todo with actual work; do not report completion while the list is stale.",
      "On every update_todo_list call, send the complete current todos array, keep at most one todo in_progress, and send an empty array when no tracked work remains.",
    ],
    parameters: TodoParameters,
    prepareArguments: validateTodoArguments,
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      signal?.throwIfAborted();
      if (!ownsSession(ctx)) {
        throw new Error("Cannot update the todo list because the session changed.");
      }
      const nextTodos = validateTodoArguments(params).todos;
      const wasComplete = allTodosCompleted(todos);
      cancelCompletionSummary();
      completionSummaryHidden = false;
      todos = cloneTodos(nextTodos);
      const becameComplete = todos.length > 0 && allTodosCompleted(todos) && !wasComplete;
      if (becameComplete) publishCompletionSummary(ctx);
      else publish(ctx);

      const details: TodoDetails = {
        version: TODO_DETAILS_VERSION,
        todos: cloneTodos(todos),
      };
      if (todos.length === 0) {
        return {
          content: [{ type: "text", text: "Todo list cleared." }],
          details,
        };
      }

      const completed = todos.filter((todo) => todo.status === "completed").length;
      const inProgress = todos.some((todo) => todo.status === "in_progress");
      const blocked = todos.filter((todo) => todo.status === "blocked").length;
      const suffixes = [...(inProgress ? ["1 in progress"] : []), ...(blocked > 0 ? [`${blocked} blocked`] : [])];
      return {
        content: [
          {
            type: "text",
            text: `Todo list updated: ${completed} of ${todos.length} complete${suffixes.length > 0 ? `; ${suffixes.join("; ")}` : ""}.`,
          },
        ],
        details,
      };
    },
  });

  const restoreBranchState = (ctx: ExtensionContext): void => {
    const branch = ctx.sessionManager.getBranch();
    todos = reconstructTodos(branch);
    restoredBoundary = reconstructRestoredTodoBoundary(branch);
  };

  pi.on("session_start", async (_event, ctx) => {
    settingsController.abort();
    settingsController = new AbortController();
    const ownerController = settingsController;
    generation += 1;
    const ownerGeneration = generation;
    activeSession = ctx.sessionManager;
    cancelCompletionSummary();
    completionSummaryHidden = false;
    settings = cloneDefaultSettings();
    restoreBranchState(ctx);
    if (ctx.mode === "tui") ctx.ui.setWidget(WIDGET_KEY, undefined);

    let loaded: TodoSettingsLoadResult;
    try {
      loaded = await readSettings(undefined, ownerController.signal);
    } catch (error) {
      if (ownerController.signal.aborted || ownerGeneration !== generation || !ownsSession(ctx)) {
        return;
      }
      loaded = {
        kind: "invalid",
        path: "pi-todo.json",
        settings: cloneDefaultSettings(),
        issue: error instanceof Error ? error.message : String(error),
      };
    }
    if (ownerController.signal.aborted || ownerGeneration !== generation || !ownsSession(ctx)) {
      return;
    }
    settings = cloneSettings(loaded.settings);
    if (loaded.kind === "invalid" && ctx.hasUI) {
      ctx.ui.notify(
        sanitizeTodoText(`Invalid pi-todo settings at ${loaded.path}; using defaults. ${loaded.issue}`),
        "warning",
      );
    }
    publish(ctx);
  });

  pi.on("context", (event, ctx) => {
    if (!ownsSession(ctx)) return;
    const summaryEpoch = leadingSummaryEpoch(event.messages);
    if (restoredBoundary?.summaryEpoch !== summaryEpoch) restoredBoundary = undefined;
    const messages = reconcileTodoContext(event.messages, todos, restoredBoundary?.content);
    if (restoredBoundary === undefined && summaryEpoch) {
      const boundaryMessage = messages[leadingSummaryBoundary(messages)];
      if (isTodoContextMessage(boundaryMessage)) {
        restoredBoundary = { summaryEpoch, content: boundaryMessage.content };
        pi.appendEntry(TODO_RESTORED_BOUNDARY_ENTRY_TYPE, {
          version: TODO_RESTORED_BOUNDARY_VERSION,
          ...restoredBoundary,
        });
      }
    }
    if (messages !== event.messages) return { messages };
  });

  pi.on("session_tree", (_event, ctx) => {
    if (!ownsSession(ctx)) return;
    cancelCompletionSummary();
    completionSummaryHidden = false;
    restoreBranchState(ctx);
    publish(ctx);
  });

  pi.on("session_shutdown", (_event, ctx) => {
    if (!ownsSession(ctx)) return;
    settingsController.abort();
    generation += 1;
    cancelCompletionSummary();
    if (ctx.mode === "tui") ctx.ui.setWidget(WIDGET_KEY, undefined);
    todos = [];
    settings = cloneDefaultSettings();
    restoredBoundary = undefined;
    completionSummaryHidden = false;
    activeSession = undefined;
  });
}

export { renderTodoWidget, sanitizeTodoText as sanitizeTodoStep };

export function reconcileTodoContext(
  messages: ContextEvent["messages"],
  todos: readonly Todo[],
  restoredBoundaryContent?: string,
): ContextEvent["messages"] {
  const existing = messages.filter(isTodoContextMessage);
  const withoutExisting = messages.filter((message) => !isTodoContextMessage(message));
  const summaryBoundary = leadingSummaryBoundary(withoutExisting);
  const currentContent =
    todos.length > 0 && !hasModelVisibleTodoState(withoutExisting, todos) ? todoContextContent(todos) : undefined;
  const content = summaryBoundary > 0 ? (restoredBoundaryContent ?? currentContent) : undefined;
  if (
    content !== undefined &&
    existing.length === 1 &&
    messages[summaryBoundary] === existing[0] &&
    existing[0]?.content === content &&
    hasTodoContextVersion(existing[0])
  ) {
    return messages;
  }
  if (existing.length === 0 && content === undefined) return messages;
  if (content === undefined) return withoutExisting;

  return [
    ...withoutExisting.slice(0, summaryBoundary),
    {
      role: "custom",
      customType: TODO_CONTEXT_MESSAGE_TYPE,
      content,
      display: false,
      details: { version: TODO_CONTEXT_VERSION },
      timestamp: 0,
    },
    ...withoutExisting.slice(summaryBoundary),
  ];
}

export function validateTodoArguments(value: unknown): { todos: Todo[] } {
  if (!isRecord(value)) rejectTodos("input must be an object with a todos array.");
  if (!Array.isArray(value.todos)) rejectTodos("todos must be an array.");
  if (value.todos.length > MAX_TODOS) {
    rejectTodos(`todos contains ${value.todos.length} items; the maximum is ${MAX_TODOS}.`);
  }

  const todos: Todo[] = [];
  const inProgressIndices: number[] = [];
  for (const [index, entry] of value.todos.entries()) {
    const item = index + 1;
    if (!isRecord(entry)) rejectTodos(`item ${item} must be an object.`);
    if (typeof entry.step !== "string") rejectTodos(`item ${item} step must be a string.`);
    if (entry.step.trim().length === 0) {
      rejectTodos(`item ${item} step must contain non-whitespace text.`);
    }
    if (!hasMaxGraphemeLength(entry.step, MAX_TODO_STEP_LENGTH)) {
      rejectTodos(`item ${item} step exceeds ${MAX_TODO_STEP_LENGTH} characters.`);
    }
    if (!TODO_STATUSES.includes(entry.status as TodoStatus)) {
      rejectTodos(`item ${item} status must be pending, in_progress, completed, or blocked.`);
    }
    const status = entry.status as TodoStatus;
    if (status === "in_progress") inProgressIndices.push(item);

    if (status === "blocked") {
      if (typeof entry.reason !== "string" || entry.reason.trim().length === 0) {
        rejectTodos(`item ${item} is blocked and requires a non-whitespace reason.`);
      }
      if (!hasMaxGraphemeLength(entry.reason, MAX_TODO_REASON_LENGTH)) {
        rejectTodos(`item ${item} reason exceeds ${MAX_TODO_REASON_LENGTH} characters.`);
      }
      todos.push({ step: entry.step, status, reason: entry.reason });
      continue;
    }
    if (Object.hasOwn(entry, "reason")) {
      rejectTodos(`item ${item} may include reason only when status is blocked.`);
    }
    todos.push({ step: entry.step, status });
  }

  if (inProgressIndices.length > 1) {
    rejectTodos(`items ${inProgressIndices.join(" and ")} are in_progress; keep at most one in_progress item.`);
  }
  return { todos };
}

function rejectTodos(message: string): never {
  throw new Error(`Todo list rejected: ${message} ${RESUBMIT_GUIDANCE}`);
}

function todoContextContent(todos: readonly Todo[]): string {
  return `${todoContextPrefix(TODO_CONTEXT_VERSION)}${JSON.stringify({ todos })}`;
}

function reconstructRestoredTodoBoundary(
  entries: readonly SessionEntry[],
): { summaryEpoch: string; content: string } | undefined {
  const summaryEpoch = leadingSummaryEpoch(buildSessionContext([...entries]).messages);
  if (!summaryEpoch) return undefined;
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry?.type !== "custom" || entry.customType !== TODO_RESTORED_BOUNDARY_ENTRY_TYPE) {
      continue;
    }
    if (!isRestoredTodoBoundaryData(entry.data, summaryEpoch)) continue;
    return { summaryEpoch, content: entry.data.content };
  }
  return undefined;
}

function isRestoredTodoBoundaryData(
  value: unknown,
  summaryEpoch: string,
): value is { version: number; summaryEpoch: string; content: string } {
  if (!isRecord(value)) return false;
  if (
    value.version !== TODO_RESTORED_BOUNDARY_VERSION ||
    value.summaryEpoch !== summaryEpoch ||
    typeof value.content !== "string"
  ) {
    return false;
  }
  return isCanonicalTodoContextContent(value.content);
}

function isCanonicalTodoContextContent(content: string): boolean {
  const currentPrefix = todoContextPrefix(TODO_CONTEXT_VERSION);
  if (content.startsWith(currentPrefix)) {
    try {
      const restoredTodos = currentTodosFromToolArguments(JSON.parse(content.slice(currentPrefix.length)));
      return restoredTodos !== undefined && restoredTodos.length > 0 && todoContextContent(restoredTodos) === content;
    } catch {
      return false;
    }
  }

  const previousPrefix = todoContextPrefix(PREVIOUS_TODO_CONTEXT_VERSION);
  if (content.startsWith(previousPrefix)) {
    try {
      const restoredTodos = previousTodoDataFromToolArguments(JSON.parse(content.slice(previousPrefix.length)));
      return (
        restoredTodos !== undefined && restoredTodos.length > 0 && previousTodoContextContent(restoredTodos) === content
      );
    } catch {
      return false;
    }
  }

  const legacyPrefix = todoContextPrefix(LEGACY_TODO_CONTEXT_VERSION);
  if (!content.startsWith(legacyPrefix)) return false;
  try {
    const restoredItems: unknown = JSON.parse(content.slice(legacyPrefix.length));
    return (
      isLegacyTodoItems(restoredItems) &&
      restoredItems.length > 0 &&
      legacyTodoContextContent(restoredItems) === content
    );
  } catch {
    return false;
  }
}

function todoContextPrefix(version: number): string {
  return `[PI TODO STATUS v${version}]\nCurrent todo list as JSON data:\n`;
}

function previousTodoContextContent(todos: readonly PreviousTodo[]): string {
  const canonicalTodos = todos.map((todo) => ({ step: todo.step, status: todo.status }));
  return `${todoContextPrefix(PREVIOUS_TODO_CONTEXT_VERSION)}${JSON.stringify({ todos: canonicalTodos })}`;
}

function legacyTodoContextContent(items: readonly LegacyTodoItem[]): string {
  const canonicalItems = items.map((item) => ({ text: item.text, status: item.status }));
  return `${todoContextPrefix(LEGACY_TODO_CONTEXT_VERSION)}${JSON.stringify(canonicalItems)}`;
}

function hasModelVisibleTodoState(messages: ContextEvent["messages"], todos: readonly Todo[]): boolean {
  const currentResults = new Map<string, string>();
  for (const message of messages) {
    if (
      message.role !== "toolResult" ||
      message.isError ||
      (message.toolName !== TOOL_NAME && message.toolName !== LEGACY_TOOL_NAME)
    ) {
      continue;
    }
    const resultTodos = todosFromDetails(message.details);
    if (resultTodos !== undefined && todosEqual(resultTodos, todos)) {
      currentResults.set(message.toolCallId, message.toolName);
    }
  }
  if (currentResults.size === 0) return false;

  return messages.some(
    (message) =>
      message.role === "assistant" &&
      message.content.some((content) => {
        if (content.type !== "toolCall" || currentResults.get(content.id) !== content.name) {
          return false;
        }
        const argumentTodos = todosFromToolArguments(content.arguments);
        return argumentTodos !== undefined && todosEqual(argumentTodos, todos);
      }),
  );
}

function todosFromToolArguments(value: unknown): Todo[] | undefined {
  return currentTodosFromToolArguments(value) ?? previousTodosFromToolArguments(value);
}

function currentTodosFromToolArguments(value: unknown): Todo[] | undefined {
  if (!isRecord(value)) return undefined;
  if (isTodos(value.todos)) return cloneTodos(value.todos);
  if (isLegacyTodoItems(value.items)) return migrateLegacyItems(value.items);
  return undefined;
}

function previousTodosFromToolArguments(value: unknown): Todo[] | undefined {
  const previous = previousTodoDataFromToolArguments(value);
  return previous ? migratePreviousTodos(previous) : undefined;
}

function previousTodoDataFromToolArguments(value: unknown): PreviousTodo[] | undefined {
  if (!isRecord(value) || !isPreviousTodos(value.todos)) return undefined;
  return value.todos.map((todo) => ({ step: todo.step, status: todo.status }));
}

type TodoContextMessage = Extract<ContextEvent["messages"][number], { role: "custom" }> & {
  content: string;
};

function isTodoContextMessage(message: ContextEvent["messages"][number]): message is TodoContextMessage {
  return message.role === "custom" && message.customType === TODO_CONTEXT_MESSAGE_TYPE;
}

function hasTodoContextVersion(message: TodoContextMessage): boolean {
  return isRecord(message.details) && message.details.version === TODO_CONTEXT_VERSION;
}

function leadingSummaryEpoch(messages: ContextEvent["messages"]): string | undefined {
  const boundary = leadingSummaryBoundary(messages);
  return boundary === 0 ? undefined : JSON.stringify(messages.slice(0, boundary));
}

function leadingSummaryBoundary(messages: ContextEvent["messages"]): number {
  let index = 0;
  while (index < messages.length) {
    const role = messages[index]?.role;
    if (role !== "compactionSummary" && role !== "branchSummary") break;
    index += 1;
  }
  return index;
}

function reconstructTodos(entries: readonly SessionEntry[]): Todo[] {
  let restored: Todo[] = [];
  for (const entry of entries) {
    if (entry.type !== "message") continue;
    const message = entry.message;
    if (
      message.role !== "toolResult" ||
      message.isError ||
      (message.toolName !== TOOL_NAME && message.toolName !== LEGACY_TOOL_NAME)
    ) {
      continue;
    }
    const resultTodos = todosFromDetails(message.details);
    if (resultTodos !== undefined) restored = resultTodos;
  }
  return restored;
}

function todosFromDetails(value: unknown): Todo[] | undefined {
  if (!isRecord(value)) return undefined;
  if (value.version === TODO_DETAILS_VERSION && isTodos(value.todos)) {
    return cloneTodos(value.todos);
  }
  if (value.version === PREVIOUS_TODO_DETAILS_VERSION && isPreviousTodos(value.todos)) {
    return migratePreviousTodos(value.todos);
  }
  if (value.version === LEGACY_TODO_DETAILS_VERSION && isLegacyTodoItems(value.items)) {
    return migrateLegacyItems(value.items);
  }
  return undefined;
}

function isTodos(value: unknown): value is Todo[] {
  if (!Array.isArray(value) || value.length > MAX_TODOS) return false;
  let inProgressCount = 0;
  for (const entry of value) {
    if (!isRecord(entry)) return false;
    if (
      typeof entry.step !== "string" ||
      entry.step.trim().length === 0 ||
      !hasMaxGraphemeLength(entry.step, MAX_TODO_STEP_LENGTH) ||
      !TODO_STATUSES.includes(entry.status as TodoStatus)
    ) {
      return false;
    }
    if (entry.status === "in_progress") inProgressCount += 1;
    if (entry.status === "blocked") {
      if (
        typeof entry.reason !== "string" ||
        entry.reason.trim().length === 0 ||
        !hasMaxGraphemeLength(entry.reason, MAX_TODO_REASON_LENGTH)
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

function hasPreviousTodoShape(value: unknown, stepProperty: "step" | "text"): boolean {
  if (!Array.isArray(value) || value.length > MAX_TODOS) return false;
  let inProgressCount = 0;
  for (const entry of value) {
    if (!isRecord(entry) || Object.hasOwn(entry, "reason")) return false;
    const step = entry[stepProperty];
    if (
      typeof step !== "string" ||
      step.trim().length === 0 ||
      !hasMaxGraphemeLength(step, MAX_TODO_STEP_LENGTH) ||
      !PREVIOUS_TODO_STATUSES.includes(entry.status as PreviousTodoStatus)
    ) {
      return false;
    }
    if (entry.status === "in_progress") inProgressCount += 1;
  }
  return inProgressCount <= 1;
}

function todosEqual(left: readonly Todo[], right: readonly Todo[]): boolean {
  return (
    left.length === right.length &&
    left.every(
      (todo, index) =>
        todo.step === right[index]?.step &&
        todo.status === right[index]?.status &&
        todo.reason === right[index]?.reason,
    )
  );
}

function migratePreviousTodos(todos: readonly PreviousTodo[]): Todo[] {
  return todos.map((todo) => ({ step: todo.step, status: todo.status }));
}

function migrateLegacyItems(items: readonly LegacyTodoItem[]): Todo[] {
  return items.map((item) => ({ step: item.text, status: item.status }));
}

function cloneTodos(todos: readonly Todo[]): Todo[] {
  return todos.map((todo) => ({
    step: todo.step,
    status: todo.status,
    ...(todo.reason === undefined ? {} : { reason: todo.reason }),
  }));
}

function allTodosCompleted(value: readonly Todo[]): boolean {
  return value.length > 0 && value.every((todo) => todo.status === "completed");
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function cloneDefaultSettings(): TodoSettings {
  return { widget: { ...DEFAULT_TODO_SETTINGS.widget } };
}

function cloneSettings(value: Readonly<TodoSettings>): TodoSettings {
  return { widget: { ...value.widget } };
}
