import assert from "node:assert/strict";
import type { ContextEvent, SessionEntry } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { test } from "vitest";
import {
  renderTodoWidget,
  sanitizeTodoStep,
  TODO_CONTEXT_MESSAGE_TYPE,
  TODO_CONTEXT_VERSION,
  TODO_DETAILS_VERSION,
  TODO_RESTORED_BOUNDARY_ENTRY_TYPE,
  TOOL_NAME,
  type Todo,
  type TodoDetails,
  WIDGET_KEY,
} from "../src/todo-widget.js";
import {
  createContext,
  createHarness,
  customEntry,
  identityTheme,
  setTodos,
  todoToolCallMessage,
  todoToolResultMessage,
  toolResultEntry,
} from "./todo-harness.js";

test("registers the todos-by-step schema and concise maintenance guidance", () => {
  const { tool } = createHarness();

  assert.equal(tool.name, "update_todo_list");
  assert.equal(tool.label, "Todo List");
  assert.match(tool.description, /whenever actual step state changes/u);
  assert.match(tool.description, /require a reason for each blocked todo/u);
  assert.match(tool.promptSnippet, /multi-step work progresses/u);
  assert.deepEqual(tool.promptGuidelines, [
    "Use update_todo_list to track work with multiple meaningful steps; skip it for simple, single-step tasks.",
    "Use update_todo_list to keep the list aligned with actual work: mark a step in_progress before starting it, mark it completed as soon as it finishes, and revise the list before continuing when the plan changes.",
    "Use blocked with a concise reason only when progress depends on an external action or condition; blocked does not mean completed.",
    "Before a progress report or final response, call update_todo_list to reconcile every todo with actual work; do not report completion while the list is stale.",
    "On every update_todo_list call, send the complete current todos array, keep at most one todo in_progress, and send an empty array when no tracked work remains.",
  ]);

  const parameters = tool.parameters as {
    required?: string[];
    properties?: Record<string, unknown>;
  };
  assert.deepEqual(parameters.required, ["todos"]);
  assert.deepEqual(Object.keys(parameters.properties ?? {}), ["todos"]);
  const todosSchema = parameters.properties?.todos as {
    maxItems?: number;
    items?: { required?: string[]; properties?: Record<string, unknown> };
  };
  assert.equal(todosSchema.maxItems, 50);
  assert.deepEqual(todosSchema.items?.required, ["step", "status"]);
  assert.deepEqual(Object.keys(todosSchema.items?.properties ?? {}), ["step", "status", "reason"]);
  assert.deepEqual(todosSchema.items?.properties?.step, {
    description: "A concise, action-oriented step",
    type: "string",
    minLength: 1,
    maxLength: 300,
  });
  assert.deepEqual(todosSchema.items?.properties?.status, {
    type: "string",
    enum: ["pending", "in_progress", "completed", "blocked"],
    description: "The step's current status",
  });
  assert.deepEqual(todosSchema.items?.properties?.reason, {
    description: "Required only for blocked todos; explain what must unblock the step",
    type: "string",
    minLength: 1,
    maxLength: 200,
  });
});

test("restores missing todo state and retains its summary boundary", async () => {
  const harness = createHarness();
  const current = createContext();
  await harness.emit("session_start", current.ctx);
  const todos: Todo[] = [
    { step: "inspect", status: "completed" },
    { step: "implement", status: "in_progress" },
  ];
  await setTodos(harness, current.ctx, todos);

  const ordinary: ContextEvent["messages"] = [
    {
      role: "user",
      content: [{ type: "text", text: "ordinary context" }],
      timestamp: 0,
    },
  ];
  assert.equal(await harness.context(ordinary, current.ctx), ordinary);

  const base: ContextEvent["messages"] = [
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
    {
      role: "user",
      content: [{ type: "text", text: "continue" }],
      timestamp: 0,
    },
  ];
  const initialDetails: TodoDetails = { version: TODO_DETAILS_VERSION, todos };
  const initiallyVisible = [...base, todoToolCallMessage(todos), todoToolResultMessage(initialDetails)];
  assert.equal(
    await harness.context(initiallyVisible, current.ctx),
    initiallyVisible,
    "retained matching evidence must prevent initial restoration",
  );

  const transformed = await harness.context(base, current.ctx);
  assert.equal(transformed.length, 4);
  const reminder = transformed[2];
  assert.equal(reminder?.role, "custom");
  if (reminder?.role !== "custom") assert.fail("Expected a custom todo reminder");
  assert.equal(reminder.customType, TODO_CONTEXT_MESSAGE_TYPE);
  assert.equal(reminder.display, false);
  assert.deepEqual(reminder.details, { version: TODO_CONTEXT_VERSION });
  assert.equal(
    reminder.content,
    `[PI TODO STATUS v${TODO_CONTEXT_VERSION}]\nCurrent todo list as JSON data:\n${JSON.stringify({ todos })}`,
  );
  assert.doesNotMatch(reminder.content as string, /call update_todo_list/u);

  assert.equal(transformed.at(-1), base.at(-1));
  const unchanged = await harness.context(transformed, current.ctx);
  assert.equal(unchanged, transformed);
  const duplicated = [...base.slice(0, 2), reminder, reminder, ...base.slice(2)] as ContextEvent["messages"];
  const deduplicated = await harness.context(duplicated, current.ctx);
  assert.equal(
    deduplicated.filter((message) => message.role === "custom" && message.customType === TODO_CONTEXT_MESSAGE_TYPE)
      .length,
    1,
  );
  assert.equal(deduplicated[2]?.role, "custom");
  const repairedVersion = await harness.context(
    [...base.slice(0, 2), { ...reminder, details: { version: 0 } }, ...base.slice(2)],
    current.ctx,
  );
  assert.deepEqual(repairedVersion[2]?.role === "custom" ? repairedVersion[2].details : undefined, {
    version: TODO_CONTEXT_VERSION,
  });

  for (const toolName of [TOOL_NAME, "todo_widget"]) {
    const details: TodoDetails = { version: TODO_DETAILS_VERSION, todos };
    const visible = [...base, todoToolCallMessage(todos, toolName), todoToolResultMessage(details, toolName)];
    const retained = await harness.context(visible, current.ctx);
    assert.deepEqual(retained[2], reminder);
    assert.deepEqual(retained.slice(3), visible.slice(2));

    const legacyItems = todos.map((todo) => ({ text: todo.step, status: todo.status }));
    const legacyVisible = [
      ...base,
      todoToolCallMessage(legacyItems, toolName, "items"),
      todoToolResultMessage({ version: 1, items: legacyItems }, toolName),
    ];
    const legacyRetained = await harness.context(legacyVisible, current.ctx);
    assert.deepEqual(legacyRetained[2], reminder);
    assert.deepEqual(legacyRetained.slice(3), legacyVisible.slice(2));
  }

  const details: TodoDetails = { version: TODO_DETAILS_VERSION, todos };
  const incompleteContexts = [
    [...base, todoToolCallMessage("invalid")],
    [...base, todoToolCallMessage([{ step: "stale", status: "pending" }])],
    [...base, todoToolCallMessage(todos)],
    [...base, todoToolResultMessage(details)],
    [...base, todoToolCallMessage(todos), todoToolResultMessage(details, TOOL_NAME, true)],
  ];
  for (const incomplete of incompleteContexts) {
    const fallback = await harness.context(incomplete, current.ctx);
    const reminders = fallback.filter(
      (message) => message.role === "custom" && message.customType === TODO_CONTEXT_MESSAGE_TYPE,
    );
    assert.equal(reminders.length, 1);
    const fallbackReminder = reminders[0];
    assert.equal(fallbackReminder?.role, "custom");
    if (fallbackReminder?.role !== "custom") assert.fail("Expected a custom todo reminder");
    assert.equal(fallbackReminder.content, reminder.content);
  }

  const replacementTodos: Todo[] = [{ step: "implement", status: "completed" }];
  await setTodos(harness, current.ctx, replacementTodos);
  const replacementDetails: TodoDetails = {
    version: TODO_DETAILS_VERSION,
    todos: replacementTodos,
  };
  const replacement = [
    ...transformed,
    todoToolCallMessage(replacementTodos),
    todoToolResultMessage(replacementDetails),
  ];
  assert.equal(
    await harness.context(replacement, current.ctx),
    replacement,
    "a later update must supersede rather than remove the restored boundary",
  );

  await setTodos(harness, current.ctx, []);
  assert.equal(
    await harness.context(transformed, current.ctx),
    transformed,
    "clearing the list must not rewrite the established summary prefix",
  );
  const nextSummaryEpoch = base.map((message, index) =>
    index === 0 && message.role === "compactionSummary"
      ? { ...message, summary: "Later work was compacted." }
      : message,
  );
  assert.equal(
    await harness.context(nextSummaryEpoch, current.ctx),
    nextSummaryEpoch,
    "a new summary epoch must use the current cleared state",
  );
  assert.deepEqual(await harness.context([...ordinary, reminder], current.ctx), ordinary);
});

test("restored todo boundaries survive reload and stay branch-local", async () => {
  const initialTodos: Todo[] = [{ step: "before compaction", status: "in_progress" }];
  const initialDetails: TodoDetails = { version: TODO_DETAILS_VERSION, todos: initialTodos };
  const branch: SessionEntry[] = [
    toolResultEntry(initialDetails, TOOL_NAME, "initial", null),
    {
      type: "compaction",
      id: "compaction",
      parentId: "initial",
      timestamp: new Date(0).toISOString(),
      summary: "Earlier work was compacted.",
      firstKeptEntryId: "kept",
      tokensBefore: 100,
    } as SessionEntry,
  ];
  const summaries: ContextEvent["messages"] = [
    {
      role: "compactionSummary",
      summary: "Earlier work was compacted.",
      tokensBefore: 100,
      timestamp: 0,
    },
  ];
  const firstHarness = createHarness();
  const current = createContext({ branch });
  await firstHarness.emit("session_start", current.ctx);
  const first = await firstHarness.context(summaries, current.ctx);
  const restored = first[1];
  assert.equal(restored?.role === "custom" ? restored.customType : undefined, TODO_CONTEXT_MESSAGE_TYPE);
  assert.equal(firstHarness.entries.length, 1);
  const persisted = firstHarness.entries[0];
  assert.equal(persisted?.customType, TODO_RESTORED_BOUNDARY_ENTRY_TYPE);
  branch.push(customEntry(persisted?.customType ?? "", persisted?.data, "boundary", "compaction"));

  const cleared: TodoDetails = { version: TODO_DETAILS_VERSION, todos: [] };
  const clearCall = todoToolCallMessage([]);
  const clearResult = todoToolResultMessage(cleared);
  branch.push(
    {
      type: "message",
      id: "clear-call",
      parentId: "boundary",
      timestamp: new Date(1).toISOString(),
      message: clearCall,
    } as SessionEntry,
    {
      type: "message",
      id: "clear-result",
      parentId: "clear-call",
      timestamp: new Date(2).toISOString(),
      message: clearResult,
    } as SessionEntry,
  );
  const reloadedHarness = createHarness();
  await reloadedHarness.emit("session_start", current.ctx);
  const afterReload = await reloadedHarness.context([...summaries, clearCall, clearResult], current.ctx);
  assert.deepEqual(afterReload[1], restored);
  assert.equal(reloadedHarness.entries.length, 0, "reload must reuse persisted boundary metadata");

  branch.splice(
    0,
    branch.length,
    {
      type: "compaction",
      id: "sibling-compaction",
      parentId: null,
      timestamp: new Date(0).toISOString(),
      summary: "Earlier work was compacted.",
      firstKeptEntryId: "sibling-call",
      tokensBefore: 100,
    } as SessionEntry,
    {
      type: "message",
      id: "sibling-call",
      parentId: "sibling-compaction",
      timestamp: new Date(1).toISOString(),
      message: clearCall,
    } as SessionEntry,
    {
      type: "message",
      id: "sibling-result",
      parentId: "sibling-call",
      timestamp: new Date(2).toISOString(),
      message: clearResult,
    } as SessionEntry,
  );
  await reloadedHarness.emit("session_tree", current.ctx);
  const sibling = [...summaries, clearCall, clearResult];
  assert.equal(await reloadedHarness.context(sibling, current.ctx), sibling);
});

test("preserves version 1 restored boundaries after updates, clears, and tree restoration", async () => {
  const legacyItems = [{ text: "before schema migration", status: "in_progress" as const }];
  const branch: SessionEntry[] = [
    toolResultEntry({ version: 1, items: legacyItems }, "todo_widget", "initial", null),
    {
      type: "compaction",
      id: "compaction",
      parentId: "initial",
      timestamp: new Date(0).toISOString(),
      summary: "Earlier work was compacted.",
      firstKeptEntryId: "kept",
      tokensBefore: 100,
    } as SessionEntry,
  ];
  const summaries: ContextEvent["messages"] = [
    {
      role: "compactionSummary",
      summary: "Earlier work was compacted.",
      tokensBefore: 100,
      timestamp: 0,
    },
  ];
  const firstHarness = createHarness();
  const current = createContext({ branch });
  await firstHarness.emit("session_start", current.ctx);
  await firstHarness.context(summaries, current.ctx);
  const persisted = firstHarness.entries[0];
  assert.ok(persisted);
  assert.equal(persisted.customType, TODO_RESTORED_BOUNDARY_ENTRY_TYPE);
  assert.ok(typeof persisted.data === "object" && persisted.data !== null && !Array.isArray(persisted.data));
  const legacyContent = `[PI TODO STATUS v1]\nCurrent todo list as JSON data:\n${JSON.stringify(legacyItems)}`;
  branch.push(
    customEntry(
      persisted.customType,
      { ...(persisted.data as Record<string, unknown>), content: legacyContent },
      "boundary",
      "compaction",
    ),
  );

  const updatedTodos: Todo[] = [{ step: "after schema migration", status: "completed" }];
  const updateCall = todoToolCallMessage(updatedTodos);
  const updateResult = todoToolResultMessage({
    version: TODO_DETAILS_VERSION,
    todos: updatedTodos,
  });
  branch.push(
    {
      type: "message",
      id: "update-call",
      parentId: "boundary",
      timestamp: new Date(1).toISOString(),
      message: updateCall,
    } as SessionEntry,
    {
      type: "message",
      id: "update-result",
      parentId: "update-call",
      timestamp: new Date(2).toISOString(),
      message: updateResult,
    } as SessionEntry,
  );

  const reloadedHarness = createHarness();
  await reloadedHarness.emit("session_start", current.ctx);
  const afterReload = await reloadedHarness.context([...summaries, updateCall, updateResult], current.ctx);
  assert.equal(afterReload[1]?.role === "custom" ? afterReload[1].content : undefined, legacyContent);
  assert.equal(reloadedHarness.entries.length, 0, "reload must reuse the version 1 boundary");

  const clearCall = todoToolCallMessage([]);
  const clearResult = todoToolResultMessage({ version: TODO_DETAILS_VERSION, todos: [] });
  branch.push(
    {
      type: "message",
      id: "clear-call",
      parentId: "update-result",
      timestamp: new Date(3).toISOString(),
      message: clearCall,
    } as SessionEntry,
    {
      type: "message",
      id: "clear-result",
      parentId: "clear-call",
      timestamp: new Date(4).toISOString(),
      message: clearResult,
    } as SessionEntry,
  );
  await reloadedHarness.emit("session_tree", current.ctx);
  const afterTreeChange = await reloadedHarness.context(
    [...summaries, updateCall, updateResult, clearCall, clearResult],
    current.ctx,
  );
  assert.equal(afterTreeChange[1]?.role === "custom" ? afterTreeChange[1].content : undefined, legacyContent);
});

test("renders completed, current, and pending todos with themed semantic symbols", () => {
  const { calls, theme } = identityTheme();
  const lines = renderTodoWidget(
    [
      { step: "done", status: "completed" },
      { step: "working", status: "in_progress" },
      { step: "later", status: "pending" },
    ],
    theme,
    80,
  );

  assert.deepEqual(lines, ["─".repeat(80), "Todo · 1/3 complete", "✓ done", "▶ working", "○ later"]);
  assert.ok(calls.some(([kind, role]) => kind === "fg" && role === "borderMuted"));
  assert.ok(calls.some(([kind, role]) => kind === "fg" && role === "success"));
  assert.ok(calls.some(([kind, role]) => kind === "fg" && role === "accent"));
  assert.ok(calls.some(([kind, role]) => kind === "fg" && role === "dim"));
  assert.ok(calls.some(([kind, role]) => kind === "style" && role === "bold"));
  assert.ok(calls.some(([kind, role]) => kind === "style" && role === "strikethrough"));
});

test("wraps todo steps with hanging indentation at narrow widths", () => {
  const { theme } = identityTheme();
  const wrappedWords = renderTodoWidget([{ step: "alpha beta gamma", status: "in_progress" }], theme, 10);
  assert.deepEqual(wrappedWords.slice(2), ["▶ alpha", "  beta", "  gamma"]);

  const wrappedCjk = renderTodoWidget([{ step: "界界界", status: "pending" }], theme, 6);
  assert.deepEqual(wrappedCjk.slice(2), ["○ 界界", "  界"]);

  for (const width of [0, 1, 2]) {
    const lines = renderTodoWidget([{ step: "hidden until enough room", status: "completed" }], theme, width);
    for (const line of lines) assert.ok(visibleWidth(line) <= width);
  }
});

test("sanitizes terminal and bidi controls and bounds every rendered line", () => {
  const hostile = "safe\u001b]8;;https://evil\u0007link\u001b]8;;\u0007\n界界\u202e";
  assert.equal(sanitizeTodoStep(hostile), "safelink 界界");

  const { theme } = identityTheme();
  const lines = renderTodoWidget([{ step: hostile, status: "in_progress" }], theme, 6);
  for (const line of lines) assert.ok(visibleWidth(line) <= 6);
  const unsafeSequences = [`${String.fromCharCode(0x1b)}]`, String.fromCharCode(0x07), String.fromCodePoint(0x202e)];
  assert.equal(
    lines.some((line) => unsafeSequences.some((sequence) => line.includes(sequence))),
    false,
  );
});

test("tool replaces the complete list, updates the widget, clears it, and rejects invalid state", async () => {
  const harness = createHarness();
  const current = createContext();
  await harness.emit("session_start", current.ctx);

  const cancelled = new AbortController();
  cancelled.abort();
  await assert.rejects(
    harness.tool.execute("todo-call", { todos: [] }, cancelled.signal, undefined, current.ctx),
    /aborted/iu,
  );

  const result = await setTodos(harness, current.ctx, [
    { step: "task 1", status: "completed" },
    { step: "task 2", status: "in_progress" },
    { step: "task 3", status: "pending" },
  ]);
  assert.equal(result.content[0]?.text, "Todo list updated: 1 of 3 complete; 1 in progress.");
  assert.deepEqual(result.details, {
    version: TODO_DETAILS_VERSION,
    todos: [
      { step: "task 1", status: "completed" },
      { step: "task 2", status: "in_progress" },
      { step: "task 3", status: "pending" },
    ],
  });

  const widget = current.widgets.at(-1);
  assert.equal(widget?.key, WIDGET_KEY);
  assert.deepEqual(widget?.options, { placement: "aboveEditor" });
  assert.equal(typeof widget?.content, "function");
  const { theme } = identityTheme();
  assert.deepEqual(widget?.content?.(current.tui, theme).render(80), [
    "─".repeat(80),
    "Todo · 1/3 complete",
    "✓ task 1",
    "▶ task 2",
    "○ task 3",
  ]);

  await assert.rejects(
    setTodos(harness, current.ctx, [
      { step: "one", status: "in_progress" },
      { step: "two", status: "in_progress" },
    ]),
    /at most one in_progress/u,
  );
  await assert.rejects(
    setTodos(harness, current.ctx, [{ step: " \n ", status: "pending" }]),
    /step must contain non-whitespace/u,
  );

  const cleared = await setTodos(harness, current.ctx, []);
  assert.equal(cleared.content[0]?.text, "Todo list cleared.");
  assert.deepEqual(current.widgets.at(-1), {
    key: WIDGET_KEY,
    content: undefined,
    options: undefined,
  });
});

test("restores current and legacy branch-local state on startup and tree navigation", async () => {
  const legacyDetails = {
    version: 1,
    items: [{ text: "restored", status: "in_progress" }],
  };
  const harness = createHarness();
  const current = createContext({ branch: [toolResultEntry(legacyDetails, "todo_widget")] });
  await harness.emit("session_start", current.ctx);

  const { theme } = identityTheme();
  assert.deepEqual(current.widgets.at(-1)?.content?.(current.tui, theme).render(80), [
    "─".repeat(80),
    "Todo · 0/1 complete",
    "▶ restored",
  ]);

  const migratedContext = await harness.context(
    [
      {
        role: "compactionSummary",
        summary: "Legacy state was compacted.",
        tokensBefore: 100,
        timestamp: 0,
      },
    ],
    current.ctx,
  );
  assert.equal(
    migratedContext[1]?.role === "custom" ? migratedContext[1].content : undefined,
    `[PI TODO STATUS v${TODO_CONTEXT_VERSION}]\nCurrent todo list as JSON data:\n${JSON.stringify({ todos: [{ step: "restored", status: "in_progress" }] })}`,
  );

  current.branch.push(
    toolResultEntry({
      version: 1,
      items: [{ text: "restored from current tool name", status: "in_progress" }],
    }),
  );
  await harness.emit("session_tree", current.ctx);
  assert.deepEqual(current.widgets.at(-1)?.content?.(current.tui, theme).render(80), [
    "─".repeat(80),
    "Todo · 0/1 complete",
    "▶ restored from current tool name",
  ]);

  current.branch.push(
    toolResultEntry({
      version: TODO_DETAILS_VERSION,
      todos: [{ step: "finished branch", status: "completed" }],
    }),
  );
  await harness.emit("session_tree", current.ctx);
  assert.deepEqual(current.widgets.at(-1)?.content?.(current.tui, theme).render(80), [
    "─".repeat(80),
    "Todo · 1/1 complete",
    "✓ finished branch",
  ]);
});

test("guards component widgets to TUI mode and ignores stale session shutdown", async () => {
  const harness = createHarness();
  const previous = createContext();
  const current = createContext();
  await harness.emit("session_start", previous.ctx);
  await setTodos(harness, previous.ctx, [{ step: "old", status: "in_progress" }]);
  await harness.emit("session_start", current.ctx);
  await setTodos(harness, current.ctx, [{ step: "current", status: "in_progress" }]);
  const currentWidgetCount = current.widgets.length;
  const staleMessages = [{ role: "user" as const, content: [{ type: "text" as const, text: "old" }], timestamp: 0 }];
  assert.equal(await harness.context(staleMessages, previous.ctx), staleMessages);

  await harness.emit("session_shutdown", previous.ctx);
  assert.equal(current.widgets.length, currentWidgetCount);
  await assert.rejects(setTodos(harness, previous.ctx, [{ step: "stale", status: "pending" }]), /session changed/u);

  await harness.emit("session_shutdown", current.ctx);
  assert.deepEqual(current.widgets.at(-1), {
    key: WIDGET_KEY,
    content: undefined,
    options: undefined,
  });

  const rpcHarness = createHarness();
  const rpc = createContext({ mode: "rpc" });
  await rpcHarness.emit("session_start", rpc.ctx);
  const result = await setTodos(rpcHarness, rpc.ctx, [{ step: "headless", status: "in_progress" }]);
  assert.equal(result.details.todos[0]?.step, "headless");
  assert.equal(rpc.widgets.length, 0);
});
