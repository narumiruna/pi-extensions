import assert from "node:assert/strict";
import type { ContextEvent, SessionEntry } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { test } from "vitest";
import {
  LEGACY_TODO_CONTEXT_MESSAGE_TYPE,
  LEGACY_TODO_RESTORED_BOUNDARY_ENTRY_TYPE,
  PROGRESS_CONTEXT_MESSAGE_TYPE,
  PROGRESS_CONTEXT_VERSION,
  PROGRESS_DETAILS_VERSION,
  PROGRESS_RESTORED_BOUNDARY_ENTRY_TYPE,
  type ProgressStep,
  reconcileProgressContext,
  renderProgressWidget,
  sanitizeProgressStep,
  TOOL_NAME,
  validateProgressArguments,
  WIDGET_KEY,
} from "../src/progress-widget.js";
import {
  createContext,
  createHarness,
  customEntry,
  identityTheme,
  progressToolCallMessage,
  progressToolResultMessage,
  setProgress,
  toolResultEntry,
} from "./progress-harness.js";

const summary = (text = "Earlier work was compacted."): ContextEvent["messages"][number] => ({
  role: "compactionSummary",
  summary: text,
  tokensBefore: 100,
  timestamp: 0,
});

function renderedBody(current: ReturnType<typeof createContext>): string[] | undefined {
  return current.widgets.at(-1)?.content?.(current.tui, identityTheme().theme).render(80);
}

test("registers only the canonical progress tool and strict steps-by-text schema", () => {
  const harness = createHarness();
  const { tool } = harness;

  assert.deepEqual(
    harness.tools.map(({ name }) => name),
    ["update_progress"],
  );
  assert.equal(tool.name, "update_progress");
  assert.equal(tool.label, "Progress");
  assert.match(tool.description, /whenever actual step state changes/u);
  assert.match(tool.description, /require a reason for each blocked step/u);
  assert.match(tool.promptSnippet, /multi-step work progresses/u);
  assert.deepEqual(tool.promptGuidelines, [
    "Use update_progress to track work with multiple meaningful steps; skip it for simple, single-step tasks.",
    "Use update_progress to keep the progress state aligned with actual work: mark a step in_progress before starting it, mark it completed as soon as it finishes, and revise the steps before continuing when the plan changes.",
    "Use blocked with a concise reason only when progress depends on an external action or condition; blocked does not mean completed.",
    "Before a progress report or final response, call update_progress to reconcile every step with actual work; do not report completion while the progress state is stale.",
    "On every update_progress call, send the complete current steps array, keep at most one step in_progress, and send an empty steps array when no tracked work remains.",
  ]);

  const parameters = tool.parameters as {
    additionalProperties?: boolean;
    required?: string[];
    properties?: Record<string, unknown>;
  };
  assert.equal(parameters.additionalProperties, false);
  assert.deepEqual(parameters.required, ["steps"]);
  assert.deepEqual(Object.keys(parameters.properties ?? {}), ["steps"]);
  const stepsSchema = parameters.properties?.steps as {
    maxItems?: number;
    items?: { additionalProperties?: boolean; required?: string[]; properties?: Record<string, unknown> };
  };
  assert.equal(stepsSchema.maxItems, 50);
  assert.equal(stepsSchema.items?.additionalProperties, false);
  assert.deepEqual(stepsSchema.items?.required, ["text", "status"]);
  assert.deepEqual(Object.keys(stepsSchema.items?.properties ?? {}), ["text", "status", "reason"]);
  assert.deepEqual(stepsSchema.items?.properties?.text, {
    description: "A concise, action-oriented step",
    type: "string",
    minLength: 1,
    maxLength: 300,
  });
  assert.deepEqual(stepsSchema.items?.properties?.status, {
    type: "string",
    enum: ["pending", "in_progress", "completed", "blocked"],
    description: "The step's current status",
  });
  assert.deepEqual(stepsSchema.items?.properties?.reason, {
    description: "Required only for blocked steps; explain what must unblock the step",
    type: "string",
    minLength: 1,
    maxLength: 200,
  });
});

test("validates canonical progress input and rejects every invalid invariant", () => {
  const cases: [unknown, RegExp][] = [
    [null, /object containing only a steps array.*resubmit the complete steps array/iu],
    [{}, /object containing only a steps array/iu],
    [{ steps: [], extra: true }, /containing only a steps array/iu],
    [{ steps: "no" }, /steps must be an array/iu],
    [{ steps: Array.from({ length: 51 }, () => ({ text: "x", status: "pending" })) }, /maximum is 50/iu],
    [{ steps: [null] }, /item 1 must be an object/iu],
    [{ steps: [{ text: "x", status: "pending", extra: true }] }, /unsupported field/iu],
    [{ steps: [{ text: 1, status: "pending" }] }, /text must be a string/iu],
    [{ steps: [{ text: " \n ", status: "pending" }] }, /non-whitespace text/iu],
    [{ steps: [{ text: "x", status: "unknown" }] }, /status must be/iu],
    [{ steps: [{ text: "x", status: "blocked" }] }, /blocked.*reason/iu],
    [{ steps: [{ text: "x", status: "blocked", reason: " " }] }, /non-whitespace reason/iu],
    [{ steps: [{ text: "x", status: "blocked", reason: "x".repeat(201) }] }, /reason exceeds 200/iu],
    [{ steps: [{ text: "x", status: "pending", reason: "not allowed" }] }, /reason only when status is blocked/iu],
    [
      {
        steps: [
          { text: "one", status: "in_progress" },
          { text: "two", status: "in_progress" },
        ],
      },
      /at most one in_progress/iu,
    ],
  ];
  for (const [input, pattern] of cases) assert.throws(() => validateProgressArguments(input), pattern);

  const text = "e\u0301".repeat(151);
  const reason = "👨‍👩‍👧‍👦".repeat(101);
  assert.deepEqual(validateProgressArguments({ steps: [{ text, status: "blocked", reason }] }), {
    steps: [{ text, status: "blocked", reason }],
  });
  assert.throws(
    () => validateProgressArguments({ steps: [{ text: "e\u0301".repeat(301), status: "pending" }] }),
    /text exceeds 300/iu,
  );
  assert.deepEqual(validateProgressArguments({ steps: [] }), { steps: [] });
});

test("writes only version 4 Progress details, updates the widget, and clears state", async () => {
  const harness = createHarness();
  const current = createContext();
  await harness.emit("session_start", current.ctx);
  assert.deepEqual(current.notifications, []);

  const cancelled = new AbortController();
  cancelled.abort();
  await assert.rejects(
    harness.tool.execute("progress-call", { steps: [] }, cancelled.signal, undefined, current.ctx),
    /aborted/iu,
  );

  const steps: ProgressStep[] = [
    { text: "task 1", status: "completed" },
    { text: "task 2", status: "in_progress" },
    { text: "task 3", status: "blocked", reason: "approval" },
  ];
  const result = await setProgress(harness, current.ctx, steps);
  assert.equal(result.content[0]?.text, "Progress updated: 1 of 3 complete; 1 in progress; 1 blocked.");
  assert.deepEqual(result.details, { version: 4, steps });
  assert.equal("todos" in result.details, false);
  const firstDetailStep = result.details.steps[0];
  assert.ok(firstDetailStep);
  assert.equal("step" in firstDetailStep, false);
  assert.deepEqual(renderedBody(current), [
    "─".repeat(80),
    "Progress · 1/3 complete",
    "✓ task 1",
    "▶ task 2",
    "⚠ task 3 — approval",
  ]);
  assert.equal(current.widgets.at(-1)?.key, "progress");

  const cleared = await setProgress(harness, current.ctx, []);
  assert.equal(cleared.content[0]?.text, "Progress cleared.");
  assert.deepEqual(cleared.details, { version: 4, steps: [] });
  assert.deepEqual(current.widgets.at(-1), { key: WIDGET_KEY, content: undefined, options: undefined });
});

test("restores every supported historical result contract", async () => {
  const cases: Array<{ name: string; toolName: string; details: unknown; expected: string }> = [
    {
      name: "canonical v4",
      toolName: "update_progress",
      details: { version: 4, steps: [{ text: "canonical", status: "blocked", reason: "approval" }] },
      expected: "⚠ canonical — approval",
    },
    {
      name: "todo v3",
      toolName: "update_todo_list",
      details: { version: 3, todos: [{ step: "todo three", status: "blocked", reason: "approval" }] },
      expected: "⚠ todo three — approval",
    },
    {
      name: "todo v2",
      toolName: "update_todo_list",
      details: { version: 2, todos: [{ step: "todo two", status: "in_progress" }] },
      expected: "▶ todo two",
    },
    {
      name: "widget v2",
      toolName: "todo_widget",
      details: { version: 2, todos: [{ step: "widget two", status: "completed" }] },
      expected: "✓ widget two",
    },
    {
      name: "todo v1",
      toolName: "update_todo_list",
      details: { version: 1, items: [{ text: "todo one", status: "pending" }] },
      expected: "○ todo one",
    },
    {
      name: "widget v1",
      toolName: "todo_widget",
      details: { version: 1, items: [{ text: "widget one", status: "pending" }] },
      expected: "○ widget one",
    },
  ];

  for (const fixture of cases) {
    const harness = createHarness();
    const current = createContext({ branch: [toolResultEntry(fixture.details, fixture.toolName)] });
    await harness.emit("session_start", current.ctx);
    assert.equal(renderedBody(current)?.at(-1), fixture.expected, fixture.name);
  }
});

test("tree navigation reconstructs only the active branch and accepts valid clears", async () => {
  const branch = [
    toolResultEntry(
      { version: 3, todos: [{ step: "first branch", status: "in_progress" }] },
      "update_todo_list",
      "first",
    ),
  ];
  const harness = createHarness();
  const current = createContext({ branch });
  await harness.emit("session_start", current.ctx);
  assert.equal(renderedBody(current)?.at(-1), "▶ first branch");

  branch.splice(
    0,
    branch.length,
    toolResultEntry({ version: 2, todos: [{ step: "sibling branch", status: "completed" }] }, "todo_widget", "sibling"),
  );
  await harness.emit("session_tree", current.ctx);
  assert.equal(renderedBody(current)?.at(-1), "✓ sibling branch");

  branch.push(toolResultEntry({ version: 4, steps: [] }, TOOL_NAME, "clear", "sibling"));
  await harness.emit("session_tree", current.ctx);
  assert.equal(current.widgets.at(-1)?.content, undefined);
});

test("historical clears replace stale state", async () => {
  const clears = [
    { toolName: "update_progress", details: { version: 4, steps: [] } },
    { toolName: "update_todo_list", details: { version: 3, todos: [] } },
    { toolName: "update_todo_list", details: { version: 2, todos: [] } },
    { toolName: "todo_widget", details: { version: 2, todos: [] } },
    { toolName: "update_todo_list", details: { version: 1, items: [] } },
    { toolName: "todo_widget", details: { version: 1, items: [] } },
  ];
  for (const fixture of clears) {
    const branch = [
      toolResultEntry({ version: 4, steps: [{ text: "stale", status: "pending" }] }, TOOL_NAME, "valid"),
      toolResultEntry(fixture.details, fixture.toolName, "clear", "valid"),
    ];
    const harness = createHarness();
    const current = createContext({ branch });
    await harness.emit("session_start", current.ctx);
    assert.equal(current.widgets.at(-1)?.content, undefined);
  }
});

test("ignores malformed, unrelated, errored, and unsupported historical snapshots", async () => {
  const invalidFixtures: Array<{ name: string; toolName: string; details: unknown; isError?: boolean }> = [
    { name: "wrong tool", toolName: "other", details: { version: 4, steps: [{ text: "bad", status: "pending" }] } },
    { name: "progress v3", toolName: TOOL_NAME, details: { version: 3, todos: [{ step: "bad", status: "pending" }] } },
    {
      name: "todo v4",
      toolName: "update_todo_list",
      details: { version: 4, steps: [{ text: "bad", status: "pending" }] },
    },
    {
      name: "widget v3",
      toolName: "todo_widget",
      details: { version: 3, todos: [{ step: "bad", status: "pending" }] },
    },
    {
      name: "shape mismatch",
      toolName: "update_todo_list",
      details: { version: 2, items: [{ text: "bad", status: "pending" }] },
    },
    { name: "extra detail", toolName: TOOL_NAME, details: { version: 4, steps: [], extra: true } },
    {
      name: "extra item",
      toolName: TOOL_NAME,
      details: { version: 4, steps: [{ text: "bad", status: "pending", extra: true }] },
    },
    { name: "empty text", toolName: TOOL_NAME, details: { version: 4, steps: [{ text: " ", status: "pending" }] } },
    {
      name: "oversized text",
      toolName: TOOL_NAME,
      details: { version: 4, steps: [{ text: "x".repeat(301), status: "pending" }] },
    },
    {
      name: "blocked without reason",
      toolName: TOOL_NAME,
      details: { version: 4, steps: [{ text: "bad", status: "blocked" }] },
    },
    {
      name: "v2 blocked",
      toolName: "update_todo_list",
      details: { version: 2, todos: [{ step: "bad", status: "blocked" }] },
    },
    {
      name: "multiple active",
      toolName: TOOL_NAME,
      details: {
        version: 4,
        steps: [
          { text: "one", status: "in_progress" },
          { text: "two", status: "in_progress" },
        ],
      },
    },
    {
      name: "errored",
      toolName: TOOL_NAME,
      details: { version: 4, steps: [{ text: "bad", status: "pending" }] },
      isError: true,
    },
  ];

  for (const fixture of invalidFixtures) {
    const branch = [
      toolResultEntry({ version: 4, steps: [{ text: "valid", status: "pending" }] }, TOOL_NAME, "valid"),
      toolResultEntry(fixture.details, fixture.toolName, "invalid", "valid", fixture.isError),
    ];
    const harness = createHarness();
    const current = createContext({ branch });
    await harness.emit("session_start", current.ctx);
    assert.equal(renderedBody(current)?.at(-1), "○ valid", fixture.name);
  }
});

test("restores canonical Progress context only after summaries remove matching evidence", () => {
  const steps: ProgressStep[] = [
    { text: "inspect", status: "completed" },
    { text: "implement", status: "in_progress" },
  ];
  const base = [
    summary(),
    { role: "user", content: [{ type: "text", text: "continue" }], timestamp: 0 },
  ] as ContextEvent["messages"];
  const restored = reconcileProgressContext(base, steps);
  const message = restored[1];
  assert.equal(message?.role === "custom" ? message.customType : undefined, PROGRESS_CONTEXT_MESSAGE_TYPE);
  assert.equal(
    message?.role === "custom" ? message.content : undefined,
    `[PI PROGRESS STATUS v4]\nCurrent progress steps as JSON data:\n${JSON.stringify({ steps })}`,
  );
  assert.deepEqual(message?.role === "custom" ? message.details : undefined, { version: PROGRESS_CONTEXT_VERSION });
  assert.equal(reconcileProgressContext(restored, steps), restored);

  const visible = [
    ...base,
    progressToolCallMessage(steps),
    progressToolResultMessage({ version: PROGRESS_DETAILS_VERSION, steps }),
  ];
  assert.equal(reconcileProgressContext(visible, steps), visible);

  const mismatches = [
    [...base, progressToolCallMessage(steps, "update_todo_list", "steps")],
    [...base, progressToolCallMessage(steps), progressToolResultMessage({ version: 3, todos: steps }, TOOL_NAME)],
    [...base, progressToolCallMessage(steps), progressToolResultMessage({ version: 4, steps }, TOOL_NAME, true)],
  ];
  for (const mismatch of mismatches) {
    assert.equal(
      reconcileProgressContext(mismatch, steps).filter(
        (candidate) => candidate.role === "custom" && candidate.customType === PROGRESS_CONTEXT_MESSAGE_TYPE,
      ).length,
      1,
    );
  }
});

test("accepts matching historical call-result pairs without registering historical tools", () => {
  const cases = [
    { toolName: "update_todo_list", version: 3, key: "todos" as const, value: [{ step: "v3", status: "pending" }] },
    { toolName: "update_todo_list", version: 2, key: "todos" as const, value: [{ step: "v2", status: "pending" }] },
    { toolName: "todo_widget", version: 2, key: "todos" as const, value: [{ step: "widget v2", status: "pending" }] },
    { toolName: "update_todo_list", version: 1, key: "items" as const, value: [{ text: "v1", status: "pending" }] },
    { toolName: "todo_widget", version: 1, key: "items" as const, value: [{ text: "widget v1", status: "pending" }] },
  ];
  for (const fixture of cases) {
    const expected: ProgressStep[] = [
      {
        text:
          (fixture.value[0] as { text?: string; step?: string }).text ?? (fixture.value[0] as { step: string }).step,
        status: "pending",
      },
    ];
    const messages = [
      summary(),
      progressToolCallMessage(fixture.value, fixture.toolName, fixture.key),
      progressToolResultMessage(
        fixture.version === 1
          ? { version: fixture.version, items: fixture.value }
          : { version: fixture.version, todos: fixture.value },
        fixture.toolName,
      ),
    ] as ContextEvent["messages"];
    assert.equal(reconcileProgressContext(messages, expected), messages, `${fixture.toolName} v${fixture.version}`);
  }
});

test("requires exact historical tool-call arguments before treating state as model-visible", () => {
  const fixtures = [
    {
      name: "v3 blocked reason mismatch",
      toolName: "update_todo_list",
      argumentName: "todos" as const,
      arguments: [{ step: "wait", status: "blocked" }],
      details: { version: 3, todos: [{ step: "wait", status: "blocked", reason: "approval" }] },
      expected: [{ text: "wait", status: "blocked", reason: "approval" }] as ProgressStep[],
    },
    {
      name: "v2 wrong argument key",
      toolName: "todo_widget",
      argumentName: "items" as const,
      arguments: [{ text: "work", status: "pending" }],
      details: { version: 2, todos: [{ step: "work", status: "pending" }] },
      expected: [{ text: "work", status: "pending" }] as ProgressStep[],
    },
    {
      name: "v1 extra item field",
      toolName: "todo_widget",
      argumentName: "items" as const,
      arguments: [{ text: "work", status: "pending", extra: true }],
      details: { version: 1, items: [{ text: "work", status: "pending" }] },
      expected: [{ text: "work", status: "pending" }] as ProgressStep[],
    },
  ];

  for (const fixture of fixtures) {
    const messages = [
      summary(),
      progressToolCallMessage(fixture.arguments, fixture.toolName, fixture.argumentName),
      progressToolResultMessage(fixture.details, fixture.toolName),
    ] as ContextEvent["messages"];
    const reconciled = reconcileProgressContext(messages, fixture.expected);
    assert.equal(
      reconciled.filter((message) => message.role === "custom" && message.customType === PROGRESS_CONTEXT_MESSAGE_TYPE)
        .length,
      1,
      fixture.name,
    );
  }
});

test("preserves an old Todo boundary byte-for-byte for its summary epoch", async () => {
  const legacyItems = [{ text: "before migration", status: "in_progress" as const }];
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
  const messages = [summary()] as ContextEvent["messages"];
  const firstHarness = createHarness();
  const current = createContext({ branch });
  await firstHarness.emit("session_start", current.ctx);
  await firstHarness.context(messages, current.ctx);
  const generated = firstHarness.entries[0];
  assert.ok(generated);
  const oldContent = `[PI TODO STATUS v1]\nCurrent todo list as JSON data:\n${JSON.stringify(legacyItems)}`;
  branch.push(
    customEntry(
      LEGACY_TODO_RESTORED_BOUNDARY_ENTRY_TYPE,
      { ...(generated.data as Record<string, unknown>), content: oldContent },
      "old-boundary",
      "compaction",
    ),
  );
  branch.push(
    toolResultEntry(
      { version: 4, steps: [{ text: "after migration", status: "completed" }] },
      TOOL_NAME,
      "update",
      "old-boundary",
    ),
  );

  const reloaded = createHarness();
  await reloaded.emit("session_start", current.ctx);
  const sameEpoch = await reloaded.context(messages, current.ctx);
  const oldMessage = sameEpoch[1];
  assert.equal(oldMessage?.role === "custom" ? oldMessage.customType : undefined, LEGACY_TODO_CONTEXT_MESSAGE_TYPE);
  assert.equal(oldMessage?.role === "custom" ? oldMessage.content : undefined, oldContent);
  assert.equal(reloaded.entries.length, 0);

  await setProgress(reloaded, current.ctx, []);
  const afterClear = await reloaded.context(sameEpoch, current.ctx);
  assert.equal(afterClear[1]?.role === "custom" ? afterClear[1].content : undefined, oldContent);
  assert.equal(reconcileProgressContext(afterClear, [], oldContent), afterClear);

  const laterEpoch = [summary("Later work was compacted.")] as ContextEvent["messages"];
  assert.equal(await reloaded.context(laterEpoch, current.ctx), laterEpoch);

  branch.splice(
    0,
    branch.length,
    {
      type: "compaction",
      id: "sibling-compaction",
      parentId: null,
      timestamp: new Date(0).toISOString(),
      summary: "Earlier work was compacted.",
      firstKeptEntryId: "sibling-result",
      tokensBefore: 100,
    } as SessionEntry,
    toolResultEntry(
      { version: 4, steps: [{ text: "sibling state", status: "pending" }] },
      TOOL_NAME,
      "sibling-result",
      "sibling-compaction",
    ),
  );
  await reloaded.emit("session_tree", current.ctx);
  const sibling = await reloaded.context(messages, current.ctx);
  assert.equal(sibling[1]?.role === "custom" ? sibling[1].customType : undefined, PROGRESS_CONTEXT_MESSAGE_TYPE);
  assert.match(sibling[1]?.role === "custom" ? String(sibling[1].content) : "", /sibling state/u);
  assert.doesNotMatch(sibling[1]?.role === "custom" ? String(sibling[1].content) : "", /PI TODO STATUS/u);
});

test("deduplicates old and new owned context messages and canonicalizes a new epoch", () => {
  const steps: ProgressStep[] = [{ text: "current", status: "pending" }];
  const oldContent = `[PI TODO STATUS v3]\nCurrent todo list as JSON data:\n${JSON.stringify({ todos: [{ step: "old", status: "pending" }] })}`;
  const oldMessage = {
    role: "custom",
    customType: LEGACY_TODO_CONTEXT_MESSAGE_TYPE,
    content: oldContent,
    display: false,
    details: { version: 3 },
    timestamp: 0,
  } as ContextEvent["messages"][number];
  const canonical = reconcileProgressContext([summary(), oldMessage], steps);
  assert.equal(canonical[1], oldMessage, "an established old boundary must remain unchanged");

  const duplicated = [summary(), oldMessage, oldMessage] as ContextEvent["messages"];
  const deduplicated = reconcileProgressContext(duplicated, steps, oldContent);
  assert.equal(
    deduplicated.filter(
      (message) =>
        message.role === "custom" &&
        (message.customType === LEGACY_TODO_CONTEXT_MESSAGE_TYPE ||
          message.customType === PROGRESS_CONTEXT_MESSAGE_TYPE),
    ).length,
    1,
  );

  const newEpoch = reconcileProgressContext([summary("new epoch")], steps);
  assert.equal(newEpoch[1]?.role === "custom" ? newEpoch[1].customType : undefined, PROGRESS_CONTEXT_MESSAGE_TYPE);
  assert.match(newEpoch[1]?.role === "custom" ? String(newEpoch[1].content) : "", /PI PROGRESS STATUS v4/u);
});

test("renders Progress terminology, sanitizes hostile text, and bounds every line", () => {
  const hostile = "safe\u001b]8;;https://evil\u0007link\u001b]8;;\u0007\n界界\u202e";
  assert.equal(sanitizeProgressStep(hostile), "safelink 界界");
  const { theme, calls } = identityTheme();
  const steps: ProgressStep[] = [
    { text: "done", status: "completed" },
    { text: hostile, status: "in_progress" },
    { text: "blocked", status: "blocked", reason: "approval\u202e" },
  ];
  const before = structuredClone(steps);
  for (const width of [0, 1, 2, 6, 80]) {
    const lines = renderProgressWidget(steps, theme, width);
    assert.equal(lines[0], "─".repeat(width));
    for (const line of lines) assert.ok(visibleWidth(line) <= width);
    const unsafe = [`${String.fromCharCode(0x1b)}]`, String.fromCharCode(0x07), String.fromCodePoint(0x202e)];
    assert.equal(
      lines.some((line) => unsafe.some((sequence) => line.includes(sequence))),
      false,
    );
  }
  assert.deepEqual(steps, before);
  assert.ok(calls.some(([kind, role]) => kind === "fg" && role === "borderMuted"));
  assert.deepEqual(renderProgressWidget([{ text: "work", status: "pending" }], theme, 80), [
    "─".repeat(80),
    "Progress · 0/1 complete",
    "○ work",
  ]);
});

test("clears the exact widget key on replacement and shutdown and avoids non-TUI widgets", async () => {
  const harness = createHarness();
  const previous = createContext();
  await harness.emit("session_start", previous.ctx);
  await setProgress(harness, previous.ctx, [{ text: "old", status: "in_progress" }]);

  const current = createContext();
  await harness.emit("session_start", current.ctx);
  assert.deepEqual(previous.widgets.at(-1), { key: WIDGET_KEY, content: undefined, options: undefined });
  await setProgress(harness, current.ctx, [{ text: "current", status: "in_progress" }]);
  const currentWidgetCount = current.widgets.length;
  await harness.emit("session_shutdown", previous.ctx);
  assert.equal(current.widgets.length, currentWidgetCount);
  await assert.rejects(setProgress(harness, previous.ctx, [{ text: "stale", status: "pending" }]), /session changed/u);
  await harness.emit("session_shutdown", current.ctx);
  assert.deepEqual(current.widgets.at(-1), { key: WIDGET_KEY, content: undefined, options: undefined });

  for (const mode of ["rpc", "print", "json"] as const) {
    const headlessHarness = createHarness();
    const headless = createContext({ mode });
    await headlessHarness.emit("session_start", headless.ctx);
    const result = await setProgress(headlessHarness, headless.ctx, [{ text: "headless", status: "pending" }]);
    assert.equal(result.details.steps[0]?.text, "headless");
    assert.equal(headless.widgets.length, 0);
    assert.equal(headless.notifications.length, 0);
  }
});

test("restored boundary metadata uses the Progress-owned entry type", async () => {
  const branch = [toolResultEntry({ version: 4, steps: [{ text: "restore", status: "pending" }] })];
  const harness = createHarness();
  const current = createContext({ branch });
  await harness.emit("session_start", current.ctx);
  await harness.context([summary()], current.ctx);
  assert.equal(harness.entries.length, 1);
  assert.equal(harness.entries[0]?.customType, PROGRESS_RESTORED_BOUNDARY_ENTRY_TYPE);
  assert.match(JSON.stringify(harness.entries[0]?.data), /PI PROGRESS STATUS v4/u);
});
