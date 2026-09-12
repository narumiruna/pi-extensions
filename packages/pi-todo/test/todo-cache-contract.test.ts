import assert from "node:assert/strict";
import type { ContextEvent, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { convertToLlm } from "@earendil-works/pi-coding-agent";
import { test } from "vitest";
import todoWidgetExtension, {
  reconcileTodoContext,
  TODO_DETAILS_VERSION,
  TOOL_NAME,
  type Todo,
} from "../src/todo-widget.js";

interface RegisteredTool {
  name: string;
  description: string;
  parameters: unknown;
  constrainedSampling?: boolean;
  promptSnippet?: string;
  promptGuidelines?: string[];
}

function registeredTodoTool(): RegisteredTool {
  let tool: RegisteredTool | undefined;
  const pi = {
    registerTool(definition: RegisteredTool) {
      tool = definition;
    },
    on() {},
  } as unknown as ExtensionAPI;
  todoWidgetExtension(pi);
  assert.ok(tool);
  return tool;
}

function normalizedRequest(messages: ContextEvent["messages"]) {
  const tool = registeredTodoTool();
  return {
    effectiveSystemGuidance: [tool.promptSnippet, ...(tool.promptGuidelines ?? [])].filter(
      (value): value is string => typeof value === "string",
    ),
    activeToolNames: [tool.name],
    toolDefinitions: [
      {
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
        constrainedSampling: tool.constrainedSampling,
      },
    ],
    messages: convertToLlm(messages),
  };
}

function userMessage(text: string): ContextEvent["messages"][number] {
  return {
    role: "user",
    content: [{ type: "text", text }],
    timestamp: 0,
  };
}

function assistantMessage(text: string): ContextEvent["messages"][number] {
  return assistantMessageWithContent([{ type: "text", text }], "stop");
}

function todoToolCallMessage(todos: readonly Todo[]): ContextEvent["messages"][number] {
  return assistantMessageWithContent(
    [
      {
        type: "toolCall",
        id: `todo-call-${todos.length}`,
        name: TOOL_NAME,
        arguments: { todos },
      },
    ],
    "toolUse",
  );
}

function assistantMessageWithContent(
  content: Extract<ContextEvent["messages"][number], { role: "assistant" }>["content"],
  stopReason: "stop" | "toolUse",
): ContextEvent["messages"][number] {
  return {
    role: "assistant",
    content,
    api: "openai-responses",
    provider: "cache-contract",
    model: "cache-contract",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason,
    timestamp: 0,
  };
}

function todoToolResultMessage(todos: readonly Todo[]): ContextEvent["messages"][number] {
  return {
    role: "toolResult",
    toolCallId: `todo-call-${todos.length}`,
    toolName: TOOL_NAME,
    content: [{ type: "text", text: todos.length === 0 ? "cleared" : "updated" }],
    details: { version: TODO_DETAILS_VERSION, todos },
    isError: false,
    timestamp: 0,
  };
}

test("todo compaction restoration preserves normalized ordinary-request prefixes", () => {
  const todos: Todo[] = [
    { step: "inspect", status: "completed" },
    { step: "implement", status: "in_progress" },
  ];
  const summaries: ContextEvent["messages"] = [
    {
      role: "compactionSummary",
      summary: "Earlier work was compacted.",
      tokensBefore: 100,
      timestamp: 0,
    },
    {
      role: "branchSummary",
      summary: "Retained branch state.",
      fromId: "branch-start",
      timestamp: 0,
    },
  ];
  const firstRaw = [...summaries, userMessage("continue")];
  const firstMessages = reconcileTodoContext(firstRaw, todos);
  const restored = firstMessages[2];
  if (restored?.role !== "custom" || typeof restored.content !== "string") {
    assert.fail("expected restored todo boundary");
  }
  const first = normalizedRequest(firstMessages);
  const secondRaw = [...firstRaw, assistantMessage("working"), userMessage("continue again")];
  const second = normalizedRequest(reconcileTodoContext(secondRaw, todos, restored.content));

  assert.deepEqual(second.effectiveSystemGuidance, first.effectiveSystemGuidance);
  assert.deepEqual(second.activeToolNames, [TOOL_NAME]);
  assert.deepEqual(second.activeToolNames, first.activeToolNames);
  assert.deepEqual(second.toolDefinitions, first.toolDefinitions);
  assert.deepEqual(second.messages.slice(0, first.messages.length), first.messages);

  const updatedTodos: Todo[] = [{ step: "implement", status: "blocked", reason: "waiting for approval" }];
  const updatedRaw = [...secondRaw, todoToolCallMessage(updatedTodos), todoToolResultMessage(updatedTodos)];
  const updated = normalizedRequest(reconcileTodoContext(updatedRaw, updatedTodos, restored.content));
  assert.deepEqual(updated.messages.slice(0, second.messages.length), second.messages);

  const clearedRaw = [...updatedRaw, todoToolCallMessage([]), todoToolResultMessage([])];
  const cleared = normalizedRequest(reconcileTodoContext(clearedRaw, [], restored.content));
  assert.deepEqual(cleared.messages.slice(0, updated.messages.length), updated.messages);

  assert.equal(reconcileTodoContext(firstMessages, todos, restored.content), firstMessages);
});
