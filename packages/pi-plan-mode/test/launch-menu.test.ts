import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { visibleWidth } from "@earendil-works/pi-tui";
import { createRpcHarness, createTuiHarness } from "@narumitw/pi-tui-kit/testing";
import { test } from "vitest";
import planMode from "../src/plan-mode.js";
import { readPlanModeSettings } from "../src/settings.js";
import { builtinTool, createMockContext, createMockPi, extensionTool } from "./support.js";

const REQUIRED_PLAN_TOOLS = ["plan_mode_question", "plan_mode_complete"];
const STARTUP_TOOLS = ["read", "write", "custom", ...REQUIRED_PLAN_TOOLS];
const STABLE_TOOLS = STARTUP_TOOLS;

async function settleWithin<T>(promise: Promise<T>, label: string): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			promise,
			new Promise<never>((_resolve, reject) => {
				timer = setTimeout(() => reject(new Error(`Timed out waiting for ${label}`)), 2_000);
			}),
		]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}

async function waitForOpenCount(
	tui: ReturnType<typeof createTuiHarness>,
	count: number,
	running?: Promise<unknown>,
) {
	const deadline = Date.now() + 2_000;
	while (tui.openCount < count && Date.now() < deadline) {
		if (running) {
			const settled = await Promise.race([
				running.then(() => true),
				new Promise<false>((resolve) => setTimeout(() => resolve(false), 5)),
			]);
			if (settled) break;
		} else await new Promise<void>((resolve) => setTimeout(resolve, 5));
	}
	assert.equal(tui.openCount, count, "expected the launch menu to remain interactive");
}

function launchFixture() {
	const mock = createMockPi({
		activeTools: STABLE_TOOLS,
		allTools: [builtinTool("read"), builtinTool("write"), extensionTool("custom")],
	});
	planMode(mock.pi, { readSettings: async () => ({ kind: "missing" as const }) });
	return mock;
}

function launchFixtureWithSettings(readSettings: () => ReturnType<typeof readPlanModeSettings>) {
	const mock = createMockPi({
		activeTools: STABLE_TOOLS,
		allTools: [builtinTool("read"), builtinTool("write"), extensionTool("custom")],
	});
	planMode(mock.pi, { readSettings });
	return mock;
}

test("inactive bare /plan opens a TUI launch menu without changing Plan state", async () => {
	const mock = launchFixture();
	const tui = createTuiHarness({ width: 42, rows: 18 });
	const context = createMockContext({ mode: "tui", hasUI: true, custom: tui.custom });

	const running = mock.commands.get("plan")?.handler("", context.ctx) as Promise<unknown>;
	await waitForOpenCount(tui, 1, running);
	const frame = tui.render();
	assert.match(frame.join("\n"), /Plan mode/);
	assert.match(frame.join("\n"), /Status: Off/i);
	assert.match(frame.join("\n"), /Start Plan mode/);
	assert.ok(frame.every((line) => line.length <= 42));
	assert.deepEqual(mock.rawPi.getActiveTools(), STABLE_TOOLS);
	assert.equal(mock.entries.length, 0);

	tui.press("tui.select.cancel");
	await running;
	assert.deepEqual(mock.rawPi.getActiveTools(), STABLE_TOOLS);
	assert.equal(mock.entries.length, 0);
	assert.equal(mock.sentUserMessages.length, 0);
});

test("Plan mode has no shortcut by default unless configured", async () => {
	const mock = launchFixture();
	const context = createMockContext({ mode: "tui", hasUI: true });
	await mock.events.get("session_start")?.[0]?.({}, context.ctx);
	const toggle = mock.shortcuts.get("ctrl+alt+p");
	assert.equal(toggle, undefined, "no global shortcut should be registered by default");
});

test("customized plan-mode shortcut from settings toggles Plan mode", async () => {
	const mock = launchFixtureWithSettings(async () => ({
		kind: "loaded" as const,
		settings: { thinkingLevel: "inherit", toggleShortcut: "ctrl+shift+p" },
	}));
	const context = createMockContext({ mode: "tui", hasUI: true });
	await mock.events.get("session_start")?.[0]?.({}, context.ctx);
	const toggle = mock.shortcuts.get("ctrl+shift+p");
	assert.ok(toggle, "custom shortcut should be registered");
	assert.equal(mock.shortcuts.has("ctrl+alt+p"), false);

	await toggle.handler(context.ctx);
	assert.deepEqual(mock.rawPi.getActiveTools(), STABLE_TOOLS);
	assert.equal(context.statuses.get("plan-mode"), "plan active");

	await toggle.handler(context.ctx);
	assert.deepEqual(mock.rawPi.getActiveTools(), STABLE_TOOLS);
	assert.equal(context.statuses.get("plan-mode"), undefined);
});

test("customized plan-mode shortcut rejects mode changes during an active run", async () => {
	let idle = false;
	const mock = launchFixtureWithSettings(async () => ({
		kind: "loaded" as const,
		settings: { thinkingLevel: "inherit", toggleShortcut: "ctrl+shift+p" },
	}));
	const context = createMockContext({
		mode: "tui",
		hasUI: true,
		isIdle: () => idle,
	});
	await mock.events.get("session_start")?.[0]?.({}, context.ctx);
	const toggle = mock.shortcuts.get("ctrl+shift+p");
	assert.ok(toggle);

	await toggle.handler(context.ctx);
	assert.deepEqual(mock.rawPi.getActiveTools(), STARTUP_TOOLS);
	assert.equal(mock.entries.length, 0);
	assert.match(context.notifications.at(-1)?.message ?? "", /run is active.*retry/i);

	idle = true;
	await toggle.handler(context.ctx);
	assert.deepEqual(mock.rawPi.getActiveTools(), STABLE_TOOLS);
	const entriesAfterStart = mock.entries.length;

	idle = false;
	await toggle.handler(context.ctx);
	assert.deepEqual(mock.rawPi.getActiveTools(), STABLE_TOOLS);
	assert.equal(mock.entries.length, entriesAfterStart);
	assert.equal(context.statuses.get("plan-mode"), "plan active");
	assert.match(context.notifications.at(-1)?.message ?? "", /run is active.*retry/i);
});

test("customized plan-mode shortcut from settings supports ctrl+alt+p", async () => {
	const mock = launchFixtureWithSettings(async () => ({
		kind: "loaded" as const,
		settings: { thinkingLevel: "inherit", toggleShortcut: "ctrl+alt+p" },
	}));
	const context = createMockContext({ mode: "tui", hasUI: true });
	await mock.events.get("session_start")?.[0]?.({}, context.ctx);
	const toggle = mock.shortcuts.get("ctrl+alt+p");
	assert.ok(toggle, "custom shortcut should be registered");
	toggle.handler(context.ctx);
	assert.deepEqual(mock.rawPi.getActiveTools(), STABLE_TOOLS);
	assert.equal(context.statuses.get("plan-mode"), "plan active");

	toggle.handler(context.ctx);
	assert.deepEqual(mock.rawPi.getActiveTools(), STABLE_TOOLS);
	assert.equal(context.statuses.get("plan-mode"), undefined);
});

test("the inactive launch menu opens Settings without starting Plan mode", async () => {
	const mock = launchFixture();
	const tui = createTuiHarness();
	const context = createMockContext({ mode: "tui", hasUI: true, custom: tui.custom });

	const running = mock.commands.get("plan")?.handler("", context.ctx) as Promise<unknown>;
	await waitForOpenCount(tui, 1, running);
	tui.press("tui.select.down");
	tui.press("tui.select.down");
	assert.match(tui.render().join("\n"), /→ Settings/);
	tui.press("tui.select.confirm");
	await settleWithin(tui.waitForPending(), "the Settings transition");
	await waitForOpenCount(tui, 2, running);
	assert.match(tui.render().join("\n"), /Plan Mode Settings/);
	assert.deepEqual(mock.rawPi.getActiveTools(), STABLE_TOOLS);
	assert.equal(mock.entries.length, 0);

	tui.press("ctrl+c");
	await settleWithin(running, "launch Settings close");
});

test("Plan Settings uses live active tools registered after session start", async () => {
	const allTools = [builtinTool("read")];
	const mock = createMockPi({ activeTools: ["read"], allTools });
	planMode(mock.pi, { readSettings: async () => ({ kind: "missing" as const }) });
	const tui = createTuiHarness();
	const context = createMockContext({ mode: "tui", hasUI: true, custom: tui.custom });
	await mock.events.get("session_start")?.[0]?.({ reason: "startup" }, context.ctx);
	allTools.push(extensionTool("late_tool"));
	mock.rawPi.setActiveTools([...mock.rawPi.getActiveTools(), "late_tool"]);

	const running = mock.commands.get("plan")?.handler("", context.ctx) as Promise<unknown>;
	await waitForOpenCount(tui, 1, running);
	tui.press("tui.select.down");
	tui.press("tui.select.down");
	tui.press("tui.select.confirm");
	await settleWithin(tui.waitForPending(), "the live Settings transition");
	await waitForOpenCount(tui, 2, running);
	tui.press("tui.select.down");
	tui.press("tui.select.confirm");
	await settleWithin(tui.waitForPending(), "the live tool Settings transition");
	await waitForOpenCount(tui, 3, running);
	tui.press("tui.select.down");
	const frame = tui.render().join("\n");
	assert.match(frame, /late_tool/u);
	assert.match(frame, /user opt-in/u);
	assert.doesNotMatch(frame, /late_tool.*not active/is);

	tui.press("ctrl+c");
	await running;
	tui.dispose();
});

test("persisted Settings become the baseline for the next Plan workflow", async () => {
	const agentDir = await mkdtemp(join(tmpdir(), "pi-plan-mode-launch-settings-"));
	const settingsPath = join(agentDir, "pi-plan-mode.json");
	try {
		await writeFile(settingsPath, '{"thinkingLevel":"off"}\n');
		const mock = createMockPi({
			activeTools: STABLE_TOOLS,
			allTools: [builtinTool("read"), builtinTool("write")],
			thinkingLevel: "low",
		});
		planMode(mock.pi, {
			readSettings: () => readPlanModeSettings(settingsPath),
			settingsPath,
		});
		const context = createMockContext();
		await mock.events.get("session_start")?.[0]?.({}, context.ctx);

		assert.equal(mock.thinkingLevel, "low", "loading defaults must not apply a workflow yet");
		await mock.commands.get("plan")?.handler("start", context.ctx);
		assert.equal(mock.thinkingLevel, "off");
	} finally {
		await rm(agentDir, { recursive: true, force: true });
	}
});

test("the launch menu starts Plan mode only after explicit confirmation", async () => {
	const mock = launchFixture();
	const tui = createTuiHarness();
	const context = createMockContext({ mode: "tui", hasUI: true, custom: tui.custom });

	const running = mock.commands.get("plan")?.handler("", context.ctx) as Promise<unknown>;
	await waitForOpenCount(tui, 1, running);
	tui.press("tui.select.confirm");
	await running;

	assert.deepEqual(mock.rawPi.getActiveTools(), STABLE_TOOLS);
	assert.equal(mock.sentUserMessages.length, 0);
	assert.equal(context.statuses.get("plan-mode"), "plan active");
});

test("launch tool choices remain draft-only until Done starts Plan mode", async () => {
	const mock = launchFixture();
	const tui = createTuiHarness();
	const context = createMockContext({ mode: "tui", hasUI: true, custom: tui.custom });
	await mock.events.get("session_start")?.[0]?.({ reason: "startup" }, context.ctx);

	const running = mock.commands.get("plan")?.handler("", context.ctx) as Promise<unknown>;
	await waitForOpenCount(tui, 1, running);
	tui.press("tui.select.down");
	tui.press("tui.select.confirm");
	await waitForOpenCount(tui, 2);
	assert.match(tui.render().join("\n"), /Choose Plan policy allowlist/);
	assert.equal(tui.isFocusable, true);
	tui.setFocused(true);
	assert.equal(tui.focused, true);

	// read is selected, write is unavailable, custom is opt-in, then the pinned Done action.
	tui.press("tui.select.down");
	tui.press("tui.select.down");
	tui.press("tui.select.confirm");
	await settleWithin(tui.waitForPending(), "the staged tool toggle");
	await waitForOpenCount(tui, 3, running);
	assert.deepEqual(mock.rawPi.getActiveTools(), STARTUP_TOOLS);
	assert.equal(mock.entries.length, 0);
	tui.press("tui.select.down");
	tui.press("tui.select.confirm");
	await settleWithin(running, "launch menu completion");

	assert.deepEqual(mock.rawPi.getActiveTools(), STABLE_TOOLS);
	assert.equal(mock.sentUserMessages.length, 0);
});

test("launch tool drafts and help navigation cancel without side effects", async () => {
	const mock = launchFixture();
	const tui = createTuiHarness();
	const context = createMockContext({ mode: "tui", hasUI: true, custom: tui.custom });
	await mock.events.get("session_start")?.[0]?.({ reason: "startup" }, context.ctx);

	const running = mock.commands.get("plan")?.handler("", context.ctx) as Promise<unknown>;
	await waitForOpenCount(tui, 1, running);
	tui.press("tui.select.down");
	tui.press("tui.select.confirm");
	await waitForOpenCount(tui, 2);
	tui.press("tui.select.down");
	tui.press("tui.select.down");
	tui.press("tui.select.confirm");
	await settleWithin(tui.waitForPending(), "the cancelled staged tool toggle");
	await waitForOpenCount(tui, 3, running);
	tui.press("tui.select.cancel");
	await waitForOpenCount(tui, 4, running);
	assert.deepEqual(mock.rawPi.getActiveTools(), STARTUP_TOOLS);
	assert.equal(mock.entries.length, 0);

	tui.press("tui.select.down");
	tui.press("tui.select.down");
	tui.press("tui.select.confirm");
	await waitForOpenCount(tui, 5, running);
	assert.match(tui.render().join("\n"), /read-only exploration/i);
	tui.press("tui.select.cancel");
	await waitForOpenCount(tui, 6, running);
	tui.press("tui.select.cancel");
	await running;

	assert.deepEqual(mock.rawPi.getActiveTools(), STARTUP_TOOLS);
	assert.equal(mock.entries.length, 0);
	assert.equal(mock.thinkingLevels.length, 0);
	assert.equal(mock.sentUserMessages.length, 0);
});

test("inactive bare /plan adapts the launch menu to RPC", async () => {
	const mock = launchFixture();
	const rpc = createRpcHarness([{ kind: "select", response: "Start Plan mode" }]);
	const context = createMockContext({
		mode: "rpc",
		hasUI: true,
		select: rpc.ui.select,
		input: rpc.ui.input,
		custom: rpc.ui.custom,
	});
	await mock.events.get("session_start")?.[0]?.({ reason: "startup" }, context.ctx);

	await mock.commands.get("plan")?.handler("", context.ctx);
	rpc.assertConsumed();
	assert.equal(
		rpc.dialogs[0]?.title,
		"Plan mode\nStatus: Off — visible Plan helpers stay inactive until /plan starts.\nPlan policy will allow: read.",
	);
	assert.deepEqual(rpc.dialogs[0]?.options, [
		"Start Plan mode",
		"Choose tools, then start…",
		"Settings",
		"How Plan mode works",
	]);
	assert.deepEqual(mock.rawPi.getActiveTools(), STABLE_TOOLS);
	assert.equal(mock.sentUserMessages.length, 0);
});

test("RPC stages tool changes until the explicit start action", async () => {
	const mock = launchFixture();
	const rpc = createRpcHarness([
		{ kind: "select", response: "Choose tools, then start…" },
		{ kind: "select", response: "[ ] custom" },
		{ kind: "select", response: "Done — start with this policy" },
	]);
	const context = createMockContext({
		mode: "rpc",
		hasUI: true,
		select: rpc.ui.select,
		input: rpc.ui.input,
		custom: rpc.ui.custom,
	});
	await mock.events.get("session_start")?.[0]?.({ reason: "startup" }, context.ctx);

	await mock.commands.get("plan")?.handler("", context.ctx);
	rpc.assertConsumed();
	assert.deepEqual(mock.rawPi.getActiveTools(), STABLE_TOOLS);
	assert.equal(mock.sentUserMessages.length, 0);
});

test("reopened launch picker uses live active tools registered after session start", async () => {
	const allTools = [builtinTool("read")];
	const mock = createMockPi({ activeTools: ["read"], allTools });
	planMode(mock.pi, { readSettings: async () => ({ kind: "missing" as const }) });
	const rpc = createRpcHarness([{ kind: "select", response: "Back" }]);
	const context = createMockContext({
		mode: "rpc",
		hasUI: true,
		select: rpc.ui.select,
		input: rpc.ui.input,
		custom: rpc.ui.custom,
	});
	await mock.events.get("session_start")?.[0]?.({ reason: "startup" }, context.ctx);
	allTools.push(extensionTool("late_tool"));
	mock.rawPi.setActiveTools([...mock.rawPi.getActiveTools(), "late_tool"]);
	const activeBefore = mock.rawPi.getActiveTools();

	await mock.commands.get("plan")?.handler("tools", context.ctx);

	rpc.assertConsumed();
	const options = rpc.dialogs[0]?.options ?? [];
	assert.ok(options.includes("[ ] late_tool"));
	assert.ok(
		options.every((option) => !/late_tool.*Not active in Pi|late_tool.*unavailable/iu.test(option)),
	);
	assert.deepEqual(mock.rawPi.getActiveTools(), activeBefore);
	assert.equal(mock.entries.length, 0);
});

test("launch picker retains and sanitizes configured names pending registration", async () => {
	const pendingName = "late\u001b[31m_tool";
	const oversizedName = "x".repeat(500);
	const mock = createMockPi({ activeTools: ["read"], allTools: [builtinTool("read")] });
	planMode(mock.pi, {
		readSettings: async () => ({
			kind: "loaded" as const,
			settings: {
				thinkingLevel: "inherit" as const,
				defaultPlanTools: [pendingName, oversizedName, "start-with-tools", "fourth"],
			},
		}),
	});
	const rpc = createRpcHarness([{ kind: "select", response: "Back" }]);
	const context = createMockContext({
		mode: "rpc",
		hasUI: true,
		select: rpc.ui.select,
		input: rpc.ui.input,
		custom: rpc.ui.custom,
	});
	await mock.events.get("session_start")?.[0]?.({ reason: "startup" }, context.ctx);

	await mock.commands.get("plan")?.handler("tools", context.ctx);

	rpc.assertConsumed();
	const dialog = rpc.dialogs[0];
	assert.ok(dialog);
	assert.match(dialog.title, /Pending registration: late_tool, x+…, start-with-tools, \+1 more/u);
	assert.ok(
		(dialog.options ?? []).some(
			(option) => /late_tool.*Not registered yet/iu.test(option) && !option.includes("\u001b"),
		),
	);
	assert.equal(JSON.stringify(dialog).includes("\u001b"), false);
	assert.equal(JSON.stringify(dialog).includes("x".repeat(200)), false);
	assert.match(JSON.stringify(dialog), /start-with-tools/u);
	assert.equal(mock.entries.length, 0);

	const tui = createTuiHarness({ width: 34, rows: 18 });
	const tuiContext = createMockContext({ mode: "tui", hasUI: true, custom: tui.custom });
	const running = mock.commands.get("plan")?.handler("tools", tuiContext.ctx) as Promise<unknown>;
	await waitForOpenCount(tui, 1, running);
	assert.ok(tui.render().every((line) => visibleWidth(line) <= 34));
	tui.press("ctrl+c");
	await running;
	tui.dispose();
	assert.equal(mock.entries.length, 0);
});

test("Ctrl+C and external disposal discard the inactive launch interaction", async () => {
	for (const ending of ["ctrl-c", "dispose"] as const) {
		const mock = launchFixture();
		const tui = createTuiHarness();
		const context = createMockContext({
			mode: "tui",
			hasUI: true,
			custom: tui.custom,
		});
		const running = mock.commands.get("plan")?.handler("", context.ctx) as Promise<unknown>;
		await waitForOpenCount(tui, 1, running);
		if (ending === "ctrl-c") tui.press("ctrl+c");
		else tui.dispose();
		await settleWithin(running, `${ending} launch cancellation`);

		assert.deepEqual(mock.rawPi.getActiveTools(), STABLE_TOOLS);
		assert.equal(mock.entries.length, 0);
		assert.equal(mock.thinkingLevels.length, 0);
		assert.equal(mock.sentUserMessages.length, 0);
	}
});

test("session replacement and shutdown discard staged launch tools", async () => {
	for (const ending of ["replacement", "shutdown"] as const) {
		const mock = launchFixture();
		const tui = createTuiHarness();
		const context = createMockContext({ mode: "tui", hasUI: true, custom: tui.custom });
		await mock.events.get("session_start")?.[0]?.({ reason: "startup" }, context.ctx);
		const running = mock.commands.get("plan")?.handler("", context.ctx) as Promise<unknown>;
		await waitForOpenCount(tui, 1, running);
		tui.press("tui.select.down");
		tui.press("tui.select.confirm");
		await waitForOpenCount(tui, 2, running);
		tui.press("tui.select.down");
		tui.press("tui.select.down");
		tui.press("tui.select.confirm");
		await settleWithin(tui.waitForPending(), "the lifecycle draft toggle");
		await waitForOpenCount(tui, 3, running);

		if (ending === "replacement") {
			await mock.events.get("session_start")?.[0]?.({ reason: "resume" }, context.ctx);
		} else await mock.events.get("session_shutdown")?.[0]?.({}, context.ctx);
		await settleWithin(running, `${ending} launch cancellation`);

		assert.deepEqual(mock.rawPi.getActiveTools(), STARTUP_TOOLS);
		assert.equal(mock.thinkingLevels.length, 0);
		assert.equal(mock.sentUserMessages.length, 0);
		const latest = mock.entries.at(-1)?.data as { selectedToolNames?: string[] } | undefined;
		assert.equal(latest?.selectedToolNames, undefined);
	}
});

test("/plan tools reuses the pre-start draft and cancellation has no side effects", async () => {
	for (const ending of ["cancel", "done"] as const) {
		const mock = launchFixture();
		const tui = createTuiHarness();
		const context = createMockContext({ mode: "tui", hasUI: true, custom: tui.custom });
		const running = mock.commands.get("plan")?.handler("tools", context.ctx) as Promise<unknown>;
		await waitForOpenCount(tui, 1, running);
		assert.match(tui.render().join("\n"), /Choose Plan policy allowlist/);
		assert.deepEqual(mock.rawPi.getActiveTools(), STABLE_TOOLS);
		assert.equal(mock.entries.length, 0);

		if (ending === "cancel") tui.press("tui.select.cancel");
		else {
			// read, unavailable write, custom, then the pinned Done action.
			for (let index = 0; index < 3; index += 1) tui.press("tui.select.down");
			tui.press("tui.select.confirm");
		}
		await settleWithin(running, `${ending} /plan tools completion`);

		assert.deepEqual(mock.rawPi.getActiveTools(), STABLE_TOOLS);
		assert.equal(context.statuses.get("plan-mode"), ending === "done" ? "plan active" : undefined);
		assert.equal(mock.entries.length > 0, ending === "done");
	}
});

test("/plan tools compatibility shortcut stages directly in RPC", async () => {
	const mock = launchFixture();
	const rpc = createRpcHarness([{ kind: "select", response: "Done — start with this policy" }]);
	const context = createMockContext({
		mode: "rpc",
		hasUI: true,
		select: rpc.ui.select,
		input: rpc.ui.input,
		custom: rpc.ui.custom,
	});

	await mock.commands.get("plan")?.handler("tools", context.ctx);
	rpc.assertConsumed();
	assert.match(rpc.dialogs[0]?.title ?? "", /Choose Plan policy allowlist/);
	assert.deepEqual(mock.rawPi.getActiveTools(), STABLE_TOOLS);
});

test("active Plan mode locks Settings and /plan tools", async () => {
	const mock = launchFixture();
	const context = createMockContext({
		mode: "tui",
		hasUI: true,
		select: async (_title: string, options: string[]) => {
			assert.equal(options.includes("Configure Plan-mode tools"), false);
			assert.equal(options.includes("Settings"), false);
			return undefined;
		},
	});
	await mock.commands.get("plan")?.handler("start", context.ctx);
	const beforeEntries = mock.entries.length;
	await mock.commands.get("plan")?.handler("", context.ctx);
	await mock.commands.get("plan")?.handler("tools", context.ctx);

	assert.match(context.notifications.at(-1)?.message ?? "", /before starting|locked/i);
	assert.deepEqual(mock.rawPi.getActiveTools(), STABLE_TOOLS);
	assert.equal(mock.entries.length, beforeEntries);
});

test("/plan tools rejects non-interactive modes before changing state", async () => {
	for (const mode of ["print", "json"] as const) {
		const mock = launchFixture();
		const context = createMockContext({ mode, hasUI: false });
		await assert.rejects(
			mock.commands.get("plan")?.handler("tools", context.ctx) as Promise<unknown>,
			/requires TUI or RPC|unavailable/i,
		);
		assert.deepEqual(mock.rawPi.getActiveTools(), STABLE_TOOLS);
		assert.equal(mock.entries.length, 0);
	}
});

test("/plan start is deterministic and bare /plan rejects non-interactive modes", async () => {
	for (const mode of ["print", "json"] as const) {
		const rejected = launchFixture();
		const rejectedContext = createMockContext({ mode, hasUI: false });
		await assert.rejects(
			rejected.commands.get("plan")?.handler("", rejectedContext.ctx) as Promise<unknown>,
			/\/plan start.*\/plan <prompt>/i,
		);
		assert.deepEqual(rejected.rawPi.getActiveTools(), STABLE_TOOLS);
		assert.equal(rejected.entries.length, 0);

		const started = launchFixture();
		const startedContext = createMockContext({ mode, hasUI: false });
		await started.commands.get("plan")?.handler("start", startedContext.ctx);
		assert.deepEqual(started.rawPi.getActiveTools(), STABLE_TOOLS);
		assert.equal(started.sentUserMessages.length, 0);
	}
});

test("start is completed while longer start text remains an inline prompt", async () => {
	const mock = launchFixture();
	const context = createMockContext({ mode: "tui", hasUI: true });
	const completions = mock.commands.get("plan")?.getArgumentCompletions?.("") as
		| Array<{ value: string }>
		| undefined;
	assert.ok(completions?.some((item) => item.value === "start"));

	await mock.commands.get("plan")?.handler("start a migration", context.ctx);
	assert.equal(mock.sentUserMessages.at(-1)?.text, "start a migration");
});
