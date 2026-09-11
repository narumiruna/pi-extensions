import assert from "node:assert/strict";
import type { ContextEvent, SessionEntry } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { test, vi } from "vitest";
import { DEFAULT_TODO_SETTINGS, type TodoSettingsLoadResult } from "../src/settings.js";
import {
	COMPLETION_SUMMARY_MS,
	renderTodoWidget,
	TODO_DETAILS_VERSION,
	TOOL_NAME,
	type Todo,
	validateTodoArguments,
	WIDGET_KEY,
} from "../src/todo-widget.js";
import {
	createContext,
	createHarness,
	customEntry,
	identityTheme,
	loadedSettings,
	setTodos,
	todoToolResultMessage,
	toolResultEntry,
} from "./todo-harness.js";

function customText(message: ContextEvent["messages"][number] | undefined): string {
	return message?.role === "custom" && typeof message.content === "string" ? message.content : "";
}

test("adapts widget rows, prioritizes active work, and honors display settings", async () => {
	const { theme } = identityTheme();
	const todos: Todo[] = [
		{ step: "finished", status: "completed" },
		{ step: "current", status: "in_progress" },
		{ step: "next", status: "pending" },
		{ step: "later", status: "pending" },
	];
	const compact = renderTodoWidget(todos, theme, 40, { terminalRows: 12 });
	assert.deepEqual(compact, [
		"─".repeat(40),
		"Todo · 1/4 complete",
		"▶ current",
		"✓ 1 completed · … 2 more",
	]);

	const expanded = renderTodoWidget(todos, theme, 40, {
		terminalRows: 12,
		settings: {
			enabled: true,
			displayMode: "expanded",
			showCompleted: false,
			maxVisibleItems: 2,
			showProgress: false,
		},
	});
	assert.deepEqual(expanded, ["─".repeat(40), "Todo", "▶ current", "○ next", "… 1 more"]);
	const cappedAdaptive = renderTodoWidget(todos, theme, 40, {
		terminalRows: 60,
		settings: {
			enabled: true,
			displayMode: "adaptive",
			showCompleted: true,
			maxVisibleItems: 1,
			showProgress: true,
		},
	});
	assert.deepEqual(cappedAdaptive, [
		"─".repeat(40),
		"Todo · 1/4 complete",
		"▶ current",
		"✓ 1 completed · … 2 more",
	]);

	const harness = createHarness();
	const current = createContext({ terminalRows: 12 });
	await harness.emit("session_start", current.ctx);
	await setTodos(harness, current.ctx, todos);
	const widget = current.widgets.at(-1)?.content?.(current.tui, theme);
	assert.ok(widget);
	assert.equal(widget.render(40).length, 4);
	(current.tui.terminal as { rows: number }).rows = 60;
	assert.deepEqual(widget.render(40), [
		"─".repeat(40),
		"Todo · 1/4 complete",
		"✓ finished",
		"▶ current",
		"○ next",
		"○ later",
	]);
});

test("bounds wrapped prioritized todos and sanitizes collapsed raw state without mutation", () => {
	const { theme } = identityTheme();
	const todos: Todo[] = [
		{ step: "alpha beta gamma delta epsilon", status: "in_progress" },
		{ step: "safe\u001b]8;;https://evil\u0007link\u202e", status: "pending" },
	];
	const before = structuredClone(todos);
	const lines = renderTodoWidget(todos, theme, 10, { terminalRows: 12 });
	assert.equal(lines.length, 4);
	assert.match(lines[2] ?? "", /^▶ .*…/u);
	assert.match(lines[3] ?? "", /^… 1 more/u);
	for (const line of lines) assert.ok(visibleWidth(line) <= 10);
	assert.deepEqual(todos, before);

	for (const [todo, prefix] of [
		[{ step: "pending task with text that needs several rows", status: "pending" }, /^○ /u],
		[
			{
				step: "blocked task with text that needs several rows",
				status: "blocked",
				reason: "waiting for external approval",
			},
			/^⚠ /u,
		],
	] as const) {
		const prioritized = renderTodoWidget([todo], theme, 10, { terminalRows: 12 });
		assert.equal(prioritized.length, 4);
		assert.match(prioritized[2] ?? "", prefix);
		assert.equal(
			prioritized.some((line) => line.includes("… 1 more")),
			false,
		);
		for (const line of prioritized) assert.ok(visibleWidth(line) <= 10);
	}

	assert.equal(
		lines.some((line) => line.includes(`${String.fromCharCode(0x1b)}]`)),
		false,
	);
	assert.deepEqual(
		renderTodoWidget([{ step: "\u202e", status: "blocked", reason: "\u2066" }], theme, 80, {
			settings: {
				enabled: true,
				displayMode: "expanded",
				showCompleted: true,
				maxVisibleItems: null,
				showProgress: true,
			},
		}),
		[
			"─".repeat(80),
			"Todo · 0/1 complete",
			"⚠ (text hidden after sanitization) — (reason hidden after sanitization)",
		],
	);
});

test("shows a transient completion summary while retaining todo state", async () => {
	vi.useFakeTimers();
	try {
		const harness = createHarness();
		const current = createContext();
		await harness.emit("session_start", current.ctx);
		await setTodos(harness, current.ctx, [{ step: "finish", status: "in_progress" }]);
		const result = await setTodos(harness, current.ctx, [{ step: "finish", status: "completed" }]);
		assert.deepEqual(result.details.todos, [{ step: "finish", status: "completed" }]);
		const { theme } = identityTheme();
		assert.deepEqual(current.widgets.at(-1)?.content?.(current.tui, theme).render(40), [
			"─".repeat(40),
			"✓ 1/1 tasks completed",
		]);

		await vi.advanceTimersByTimeAsync(COMPLETION_SUMMARY_MS - 1);
		assert.equal(typeof current.widgets.at(-1)?.content, "function");
		await vi.advanceTimersByTimeAsync(1);
		assert.deepEqual(current.widgets.at(-1), {
			key: WIDGET_KEY,
			content: undefined,
			options: undefined,
		});

		const restored = await harness.context(
			[
				{
					role: "compactionSummary",
					summary: "Earlier work was compacted.",
					tokensBefore: 10,
					timestamp: 0,
				},
			],
			current.ctx,
		);
		assert.match(customText(restored[1]), /"status":"completed"/u);
	} finally {
		vi.useRealTimers();
	}
});

test("cancels completion timers on updates, clears, tree changes, and session replacement", async () => {
	vi.useFakeTimers();
	try {
		const harness = createHarness();
		const previous = createContext();
		await harness.emit("session_start", previous.ctx);
		await setTodos(harness, previous.ctx, [{ step: "old", status: "in_progress" }]);
		await setTodos(harness, previous.ctx, [{ step: "old", status: "completed" }]);
		await setTodos(harness, previous.ctx, [{ step: "replacement", status: "pending" }]);
		await vi.advanceTimersByTimeAsync(COMPLETION_SUMMARY_MS);
		assert.equal(typeof previous.widgets.at(-1)?.content, "function");

		await setTodos(harness, previous.ctx, [{ step: "replacement", status: "completed" }]);
		await setTodos(harness, previous.ctx, []);
		await vi.advanceTimersByTimeAsync(COMPLETION_SUMMARY_MS);
		assert.equal(previous.widgets.at(-1)?.content, undefined);

		await setTodos(harness, previous.ctx, [{ step: "tree", status: "in_progress" }]);
		await setTodos(harness, previous.ctx, [{ step: "tree", status: "completed" }]);
		previous.branch.push(
			toolResultEntry({
				version: TODO_DETAILS_VERSION,
				todos: [{ step: "tree", status: "completed" }],
			}),
		);
		await harness.emit("session_tree", previous.ctx);
		assert.equal(typeof previous.widgets.at(-1)?.content, "function");

		await setTodos(harness, previous.ctx, [{ step: "session", status: "in_progress" }]);
		await setTodos(harness, previous.ctx, [{ step: "session", status: "completed" }]);
		const current = createContext();
		await harness.emit("session_start", current.ctx);
		await setTodos(harness, current.ctx, [{ step: "current", status: "in_progress" }]);
		const widgetCount = current.widgets.length;
		await vi.advanceTimersByTimeAsync(COMPLETION_SUMMARY_MS);
		assert.equal(current.widgets.length, widgetCount);
	} finally {
		vi.useRealTimers();
	}
});

test("returns actionable validation errors before schema validation and direct execution", async () => {
	const cases: [unknown, RegExp][] = [
		[null, /input must be an object.*resubmit the complete todos array/iu],
		[{}, /todos must be an array.*resubmit/iu],
		[
			{ todos: Array.from({ length: 51 }, () => ({ step: "x", status: "pending" })) },
			/maximum is 50/iu,
		],
		[{ todos: [null] }, /item 1 must be an object/iu],
		[{ todos: [{ step: 1, status: "pending" }] }, /item 1 step must be a string/iu],
		[{ todos: [{ step: "x", status: "unknown" }] }, /item 1 status must be/iu],
		[{ todos: [{ step: "x", status: "blocked" }] }, /item 1 is blocked.*reason/iu],
		[
			{ todos: [{ step: "x", status: "blocked", reason: "x".repeat(201) }] },
			/item 1 reason exceeds 200/iu,
		],
		[
			{ todos: [{ step: "x", status: "pending", reason: "not allowed" }] },
			/reason only when status is blocked/iu,
		],
	];
	for (const [input, pattern] of cases) assert.throws(() => validateTodoArguments(input), pattern);

	const decomposedStep = "e\u0301".repeat(151);
	const emojiReason = "👨‍👩‍👧‍👦".repeat(101);
	assert.deepEqual(
		validateTodoArguments({
			todos: [{ step: decomposedStep, status: "blocked", reason: emojiReason }],
		}),
		{
			todos: [{ step: decomposedStep, status: "blocked", reason: emojiReason }],
		},
	);
	assert.throws(
		() =>
			validateTodoArguments({
				todos: [{ step: "e\u0301".repeat(301), status: "pending" }],
			}),
		/step exceeds 300/iu,
	);

	const canonical = validateTodoArguments({
		todos: [{ step: "wait", status: "blocked", reason: "approval" }],
	});
	assert.deepEqual(canonical, {
		todos: [{ step: "wait", status: "blocked", reason: "approval" }],
	});

	const harness = createHarness();
	const current = createContext();
	await harness.emit("session_start", current.ctx);
	await setTodos(harness, current.ctx, [{ step: "kept", status: "pending" }]);
	const widgetCount = current.widgets.length;
	assert.throws(
		() =>
			harness.tool.prepareArguments({
				todos: [
					{ step: "one", status: "in_progress" },
					{ step: "two", status: "in_progress" },
				],
			}),
		/items 1 and 2.*resubmit the complete todos array/iu,
	);
	await assert.rejects(
		harness.tool.execute(
			"invalid",
			{ todos: [{ step: "x", status: "blocked", reason: " " }] },
			undefined,
			undefined,
			current.ctx,
		),
		/non-whitespace reason.*resubmit/iu,
	);
	assert.equal(current.widgets.length, widgetCount);
});

test("loads display settings, warns safely, and ignores stale async loads", async () => {
	const collapsedHarness = createHarness({
		loadSettings: async () =>
			loadedSettings({
				displayMode: "collapsed",
				showCompleted: false,
				maxVisibleItems: 1,
				showProgress: false,
			}),
	});
	const collapsed = createContext({ terminalRows: 60 });
	await collapsedHarness.emit("session_start", collapsed.ctx);
	await setTodos(collapsedHarness, collapsed.ctx, [
		{ step: "done", status: "completed" },
		{ step: "active", status: "in_progress" },
		{ step: "later", status: "pending" },
	]);
	const { theme } = identityTheme();
	assert.deepEqual(collapsed.widgets.at(-1)?.content?.(collapsed.tui, theme).render(40), [
		"─".repeat(40),
		"Todo",
		"▶ active",
		"… 1 more",
	]);

	const disabledHarness = createHarness({
		loadSettings: async () => loadedSettings({ enabled: false }),
	});
	const disabled = createContext();
	await disabledHarness.emit("session_start", disabled.ctx);
	await setTodos(disabledHarness, disabled.ctx, [{ step: "hidden", status: "completed" }]);
	assert.equal(disabled.widgets.at(-1)?.content, undefined);

	let resolveFirst: ((result: TodoSettingsLoadResult) => void) | undefined;
	let loads = 0;
	const staleHarness = createHarness({
		loadSettings: async () => {
			loads += 1;
			if (loads === 1) {
				return await new Promise<TodoSettingsLoadResult>((resolve) => {
					resolveFirst = resolve;
				});
			}
			return loadedSettings({ showProgress: false });
		},
	});
	const previous = createContext();
	const firstStart = staleHarness.emit("session_start", previous.ctx);
	await vi.waitFor(() => assert.ok(resolveFirst));
	const current = createContext();
	await staleHarness.emit("session_start", current.ctx);
	resolveFirst?.(loadedSettings({ showProgress: true }));
	await firstStart;
	await setTodos(staleHarness, current.ctx, [{ step: "current", status: "pending" }]);
	assert.equal(current.widgets.at(-1)?.content?.(current.tui, theme).render(40)[1], "Todo");

	const invalidHarness = createHarness({
		loadSettings: async () => ({
			kind: "invalid",
			path: "/tmp/unsafe\u001b]8;;x\u0007.json",
			settings: { widget: { ...DEFAULT_TODO_SETTINGS.widget } },
			issue: "bad\u202evalue",
		}),
	});
	for (const mode of ["tui", "rpc", "print", "json"] as const) {
		const context = createContext({ mode });
		await invalidHarness.emit("session_start", context.ctx);
		assert.equal(context.notifications.length, mode === "tui" || mode === "rpc" ? 1 : 0);
		assert.equal(
			context.notifications[0]?.message.includes(String.fromCharCode(0x1b)) ?? false,
			false,
		);
		await invalidHarness.emit("session_shutdown", context.ctx);
	}
});

test("renders blocked todos, preserves reasons, and excludes them from completion", async () => {
	vi.useFakeTimers();
	try {
		const harness = createHarness();
		const current = createContext();
		await harness.emit("session_start", current.ctx);
		const blocked: Todo[] = [
			{ step: "deploy\u001b]8;;x\u0007", status: "blocked", reason: "Need approval\u202e" },
			{ step: "verify", status: "pending" },
		];
		const result = await setTodos(harness, current.ctx, blocked);
		assert.equal(result.content[0]?.text, "Todo list updated: 0 of 2 complete; 1 blocked.");
		assert.deepEqual(result.details, { version: TODO_DETAILS_VERSION, todos: blocked });
		const { theme, calls } = identityTheme();
		const lines = current.widgets.at(-1)?.content?.(current.tui, theme).render(80) ?? [];
		assert.deepEqual(lines, [
			"─".repeat(80),
			"Todo · 0/2 complete",
			"⚠ deploy — Need approval",
			"○ verify",
		]);
		assert.ok(calls.some(([kind, role]) => kind === "fg" && role === "warning"));
		const allBlocked = renderTodoWidget(
			[
				{ step: "first", status: "blocked", reason: "external one" },
				{ step: "second", status: "blocked", reason: "external two" },
			],
			theme,
			40,
			{ terminalRows: 12 },
		);
		assert.deepEqual(allBlocked, [
			"─".repeat(40),
			"Todo · 0/2 complete",
			"⚠ first — external one",
			"⚠ second — external two",
		]);
		await vi.advanceTimersByTimeAsync(COMPLETION_SUMMARY_MS);
		assert.equal(typeof current.widgets.at(-1)?.content, "function");

		const context = await harness.context(
			[
				{
					role: "compactionSummary",
					summary: "Earlier work was compacted.",
					tokensBefore: 10,
					timestamp: 0,
				},
			],
			current.ctx,
		);
		assert.match(customText(context[1]), /Need approval/u);
		assert.match(customText(context[1]), /"blocked"/u);
	} finally {
		vi.useRealTimers();
	}
});

test("ignores errored tool results while reconstructing branch state", async () => {
	const valid = toolResultEntry({
		version: TODO_DETAILS_VERSION,
		todos: [{ step: "valid", status: "pending" }],
	});
	const errored = {
		type: "message",
		id: "errored",
		parentId: valid.id,
		timestamp: new Date(1).toISOString(),
		message: todoToolResultMessage(
			{
				version: TODO_DETAILS_VERSION,
				todos: [{ step: "must not restore", status: "blocked", reason: "error" }],
			},
			TOOL_NAME,
			true,
		),
	} as SessionEntry;
	const harness = createHarness();
	const current = createContext({ branch: [valid, errored] });
	await harness.emit("session_start", current.ctx);
	const { theme } = identityTheme();
	assert.deepEqual(current.widgets.at(-1)?.content?.(current.tui, theme).render(80), [
		"─".repeat(80),
		"Todo · 0/1 complete",
		"○ valid",
	]);
});

test("restores version 2 state and keeps a canonical version 2 summary boundary", async () => {
	const previousStep = "e\u0301".repeat(151);
	const previousTodos = [{ step: previousStep, status: "in_progress" as const }];
	const branch: SessionEntry[] = [
		toolResultEntry({ version: 2, todos: previousTodos }, TOOL_NAME, "initial", null),
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
	const previousContent = `[PI TODO STATUS v2]\nCurrent todo list as JSON data:\n${JSON.stringify({ todos: previousTodos })}`;
	branch.push(
		customEntry(
			persisted.customType,
			{ ...(persisted.data as Record<string, unknown>), content: previousContent },
			"boundary",
			"compaction",
		),
	);

	const reloaded = createHarness();
	await reloaded.emit("session_start", current.ctx);
	const retained = await reloaded.context(summaries, current.ctx);
	assert.equal(retained[1]?.role === "custom" ? retained[1].content : "", previousContent);

	branch.push(
		toolResultEntry(
			{
				version: TODO_DETAILS_VERSION,
				todos: [{ step: "wait", status: "blocked", reason: "approval" }],
			},
			TOOL_NAME,
			"blocked",
			"boundary",
		),
	);
	await reloaded.emit("session_tree", current.ctx);
	const sameEpoch = await reloaded.context(summaries, current.ctx);
	assert.equal(sameEpoch[1]?.role === "custom" ? sameEpoch[1].content : "", previousContent);
});
