import assert from "node:assert/strict";
import test from "node:test";
import { initTheme } from "@earendil-works/pi-coding-agent";
import {
	createCustomSelectorHarness,
	createMockContext,
	driveCustomSelector,
} from "../../../test/support.js";
import { defineMenu, type MenuDefinition, type RunMenuResult, runMenu } from "../src/index.js";

initTheme("dark", false);

type State = { count: number };
type ScreenId = "main" | "status" | "settings";
type ActionId = "run" | "automatic";

function runtimeMenu(
	options: {
		busy?: boolean;
		run?: MenuDefinition<State, ScreenId, ActionId>["actions"]["run"];
	} = {},
) {
	return defineMenu<State, ScreenId, ActionId>({
		start: "main",
		screens: {
			main: ({ state }) => ({
				kind: "actions",
				title: `Main ${state.count}`,
				items: [
					{
						id: "run",
						label: "Run",
						action: "run",
						...(options.busy ? { busyLabel: "Running…" } : {}),
					},
					{ id: "status", label: "Status", to: "status" },
					{ id: "settings", label: "Settings", to: "settings" },
				],
				hint: "close",
			}),
			status: ({ state }) => ({
				kind: "detail",
				title: "Status",
				lines: [`Count ${state.count}`],
				hint: "back",
			}),
			settings: () => ({
				kind: "settings",
				title: "Settings",
				items: [
					{
						id: "automatic",
						label: "Automatic",
						currentValue: "Off",
						values: ["Off", "On"],
						action: "automatic",
					},
				],
			}),
		},
		actions: {
			run: options.run ?? (async () => ({ kind: "stay" })),
			automatic: async () => ({ kind: "stay" }),
		},
	});
}

test("runMenu navigates, refreshes dynamic state, restores selection, and closes", async () => {
	let count = 0;
	let customCalls = 0;
	const screens: string[] = [];
	const context = createMockContext({
		mode: "tui",
		hasUI: true,
		custom: async (factory: unknown) => {
			customCalls += 1;
			const inputs =
				customCalls === 1
					? ["tui.select.down", "tui.select.confirm"]
					: customCalls === 2
						? ["tui.select.cancel"]
						: customCalls === 3
							? ["tui.select.up", "tui.select.confirm"]
							: ["\u0003", "\u0003"];
			const driven = driveCustomSelector(factory, inputs, 40);
			screens.push(driven.renders.flat().join(" "));
			return driven.result;
		},
	});
	const menu = runtimeMenu({
		run: async () => {
			count += 1;
			return { kind: "stay" };
		},
	});

	const result = await runMenu(context.ctx, menu, { getState: () => ({ count }) });
	assert.deepEqual(result, { kind: "closed" });
	assert.equal(count, 1);
	assert.equal(customCalls, 4);
	assert.match(screens[1] ?? "", /Count 0/);
	assert.match(screens[3] ?? "", /Main 1/);
});

test("Escape back restores the cursor on the parent row", async () => {
	let customCalls = 0;
	const context = createMockContext({
		mode: "tui",
		hasUI: true,
		custom: async (factory: unknown) => {
			customCalls += 1;
			const harness = createCustomSelectorHarness(factory, 80);
			if (customCalls === 1) {
				harness.handleInput("tui.select.down");
				harness.handleInput("tui.select.confirm");
			} else if (customCalls === 2) harness.handleInput("tui.select.cancel");
			else {
				assert.match(harness.render().join("\n"), /→ Status/);
				harness.handleInput("\u0003");
			}
			return harness.result;
		},
	});

	assert.deepEqual(await runMenu(context.ctx, runtimeMenu(), { getState: () => ({ count: 0 }) }), {
		kind: "closed",
	});
	assert.equal(customCalls, 3);
});

test("RPC uses dialog adaptation without custom TUI and print mode delegates unsupported behavior", async () => {
	let count = 0;
	let customCalls = 0;
	const choices = ["Run", undefined];
	const rpc = createMockContext({
		mode: "rpc",
		hasUI: true,
		select: async () => choices.shift(),
		custom: async () => {
			customCalls += 1;
		},
	});
	const menu = runtimeMenu({
		busy: true,
		run: async () => {
			count += 1;
		},
	});
	assert.deepEqual(await runMenu(rpc.ctx, menu, { getState: () => ({ count }) }), {
		kind: "closed",
	});
	assert.equal(count, 1);
	assert.equal(customCalls, 0);

	let unsupportedMode = "";
	const print = createMockContext({ mode: "print", hasUI: false });
	assert.deepEqual(
		await runMenu(print.ctx, menu, {
			getState: () => ({ count }),
			onUnsupportedMode: (_ctx, mode) => {
				unsupportedMode = mode;
			},
		}),
		{ kind: "unsupported", mode: "print" },
	);
	assert.equal(unsupportedMode, "print");

	const unavailableTui = createMockContext({
		mode: "tui",
		hasUI: false,
		custom: async () => {
			throw new Error("custom UI must not open without UI support");
		},
	});
	assert.deepEqual(
		await runMenu(unavailableTui.ctx, menu, {
			getState: () => ({ count }),
			onUnsupportedMode: (_ctx, mode) => {
				unsupportedMode = mode;
			},
		}),
		{ kind: "unsupported", mode: "tui" },
	);
	assert.equal(unsupportedMode, "tui");
});

test("RPC choices preserve item identity across duplicate and exit labels", async () => {
	let selectCalls = 0;
	const invoked: string[] = [];
	const context = createMockContext({
		mode: "rpc",
		hasUI: true,
		select: async (_title: string, choices: string[]) => {
			selectCalls += 1;
			assert.equal(new Set(choices).size, choices.length);
			if (selectCalls === 1) return choices[1];
			if (selectCalls === 2) return choices[2];
			return choices.at(-1);
		},
	});
	const definition = defineMenu<undefined, "tools", "toggle" | "bulk">({
		start: "tools",
		screens: {
			tools: () => ({
				kind: "multiSelect",
				title: "Tools",
				items: [],
				action: "toggle",
				actions: [
					{ id: "first", label: "Same", action: "bulk" },
					{ id: "second", label: "Same", action: "bulk" },
					{ id: "done-action", label: "Done", action: "bulk" },
				],
				hint: "close",
				doneLabel: "Done",
			}),
		},
		actions: {
			toggle: async () => ({ kind: "stay" }),
			bulk: async ({ itemId }) => {
				invoked.push(itemId);
				return { kind: "stay" };
			},
		},
	});

	assert.deepEqual(await runMenu(context.ctx, definition, { getState: () => undefined }), {
		kind: "closed",
	});
	assert.deepEqual(invoked, ["second", "done-action"]);
	assert.equal(selectCalls, 3);
});

test("an owner signal dismisses an unanswered RPC selector", async () => {
	const owner = new AbortController();
	let releaseFallback: (() => void) | undefined;
	let reportOpened: (() => void) | undefined;
	let selectorSettled = false;
	const fallback = new Promise<void>((resolve) => {
		releaseFallback = resolve;
	});
	const opened = new Promise<void>((resolve) => {
		reportOpened = resolve;
	});
	const context = createMockContext({
		mode: "rpc",
		hasUI: true,
		select: async (
			_title: string,
			_choices: string[],
			dialogOptions?: { signal?: AbortSignal },
		) => {
			reportOpened?.();
			if (dialogOptions?.signal) {
				await new Promise<void>((resolve) => {
					if (dialogOptions.signal?.aborted) resolve();
					else dialogOptions.signal?.addEventListener("abort", () => resolve(), { once: true });
				});
			} else await fallback;
			selectorSettled = true;
			return undefined;
		},
	});
	const running = runMenu(context.ctx, runtimeMenu(), {
		getState: () => ({ count: 0 }),
		signal: owner.signal,
	});
	await opened;
	owner.abort(new DOMException("Session replaced", "AbortError"));
	await new Promise<void>((resolve) => setImmediate(resolve));
	const settledBeforeFallback = selectorSettled;
	releaseFallback?.();

	assert.equal(settledBeforeFallback, true);
	assert.deepEqual(await running, { kind: "stale" });
});

test("a stale action continuation cannot render another screen or report success", async () => {
	let current = true;
	let release: (() => void) | undefined;
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	let customCalls = 0;
	let errorCalls = 0;
	const context = createMockContext({
		mode: "tui",
		hasUI: true,
		custom: async (factory: unknown) => {
			customCalls += 1;
			return driveCustomSelector(factory, ["tui.select.confirm"], 40).result;
		},
	});
	const running = runMenu(
		context.ctx,
		runtimeMenu({
			run: async () => {
				await gate;
				return { kind: "stay" };
			},
		}),
		{
			getState: () => ({ count: 0 }),
			isCurrent: () => current,
			onError: () => {
				errorCalls += 1;
			},
		},
	);
	await new Promise<void>((resolve) => setImmediate(resolve));
	current = false;
	release?.();
	assert.deepEqual(await running, { kind: "stale" });
	assert.equal(customCalls, 1);
	assert.equal(errorCalls, 0);
});

test("an owner signal aborts in-flight state loading", async () => {
	const owner = new AbortController();
	let releaseState: (() => void) | undefined;
	let reportStarted: (() => void) | undefined;
	let observedAbort = false;
	const stateGate = new Promise<void>((resolve) => {
		releaseState = resolve;
	});
	const stateStarted = new Promise<void>((resolve) => {
		reportStarted = resolve;
	});
	const context = createMockContext({ mode: "tui", hasUI: true });
	const options = {
		signal: owner.signal,
		getState: async ({ signal }: { signal: AbortSignal }) => {
			reportStarted?.();
			signal.addEventListener(
				"abort",
				() => {
					observedAbort = true;
				},
				{ once: true },
			);
			await stateGate;
			return { count: 0 };
		},
	};
	const running = runMenu(context.ctx, runtimeMenu(), options);
	await stateStarted;
	owner.abort(new DOMException("Session replaced", "AbortError"));
	await new Promise<void>((resolve) => setImmediate(resolve));
	const observedBeforeRelease = observedAbort;
	releaseState?.();

	assert.equal(observedBeforeRelease, true);
	assert.deepEqual(await running, { kind: "stale" });
});

test("an owner signal closes an idle custom screen", async () => {
	const owner = new AbortController();
	let reportOpened: (() => void) | undefined;
	let closedByOwner = false;
	const opened = new Promise<void>((resolve) => {
		reportOpened = resolve;
	});
	const context = createMockContext({
		mode: "tui",
		hasUI: true,
		custom: async (factory: unknown) => {
			const harness = createCustomSelectorHarness(factory, 40);
			reportOpened?.();
			await new Promise<void>((resolve) => {
				owner.signal.addEventListener("abort", () => resolve(), { once: true });
			});
			closedByOwner = harness.result !== undefined;
			return harness.result;
		},
	});
	const running = runMenu(context.ctx, runtimeMenu(), {
		getState: () => ({ count: 0 }),
		signal: owner.signal,
	});
	await opened;
	owner.abort(new DOMException("Session replaced", "AbortError"));

	assert.deepEqual(await running, { kind: "stale" });
	assert.equal(closedByOwner, true);
});

test("an owner signal aborts and drains an in-flight non-busy action", async () => {
	const owner = new AbortController();
	let reportStarted: (() => void) | undefined;
	let observedAbort = false;
	const actionStarted = new Promise<void>((resolve) => {
		reportStarted = resolve;
	});
	const context = createMockContext({
		mode: "tui",
		hasUI: true,
		custom: async (factory: unknown) =>
			driveCustomSelector(factory, ["tui.select.confirm"], 40).result,
	});
	const running = runMenu(
		context.ctx,
		runtimeMenu({
			run: async ({ signal }) => {
				reportStarted?.();
				await new Promise<void>((resolve) => {
					if (signal.aborted) resolve();
					else {
						signal.addEventListener(
							"abort",
							() => {
								observedAbort = true;
								resolve();
							},
							{ once: true },
						);
					}
				});
				return { kind: "stay" };
			},
		}),
		{ getState: () => ({ count: 0 }), signal: owner.signal },
	);
	await actionStarted;
	owner.abort(new DOMException("Session replaced", "AbortError"));

	assert.deepEqual(await running, { kind: "stale" });
	assert.equal(observedAbort, true);
});

test("a cancellable busy action receives abort, drains, and leaves the menu usable", async () => {
	let aborted = false;
	let settled = false;
	let release: (() => void) | undefined;
	const drainGate = new Promise<void>((resolve) => {
		release = resolve;
	});
	let customCalls = 0;
	const context = createMockContext({
		mode: "tui",
		hasUI: true,
		custom: async (factory: unknown) => {
			customCalls += 1;
			const harness = createCustomSelectorHarness(factory, 40);
			if (customCalls === 1) harness.handleInput("tui.select.confirm");
			else if (customCalls === 2) {
				harness.handleInput("\u001b");
				harness.dispose();
				setImmediate(() => release?.());
			} else {
				assert.equal(settled, true);
				harness.handleInput("\u0003");
			}
			return harness.result;
		},
	});
	const result = await runMenu(
		context.ctx,
		runtimeMenu({
			busy: true,
			run: async ({ signal }) => {
				await new Promise<void>((resolve) => {
					if (signal.aborted) resolve();
					else signal.addEventListener("abort", () => resolve(), { once: true });
				});
				aborted = signal.aborted;
				await drainGate;
				settled = true;
				return { kind: "stay" };
			},
		}),
		{ getState: () => ({ count: 0 }) },
	);
	assert.deepEqual(result, { kind: "closed" });
	assert.equal(aborted, true);
	assert.equal(customCalls, 3);
});

test("external busy-view disposal drains without reopening the obsolete menu", async () => {
	let customCalls = 0;
	let reportStarted: (() => void) | undefined;
	let releaseAction: (() => void) | undefined;
	const started = new Promise<void>((resolve) => {
		reportStarted = resolve;
	});
	const actionGate = new Promise<void>((resolve) => {
		releaseAction = resolve;
	});
	const context = createMockContext({
		mode: "tui",
		hasUI: true,
		custom: async (factory: unknown) => {
			customCalls += 1;
			const harness = createCustomSelectorHarness(factory, 40);
			if (customCalls === 1) harness.handleInput("tui.select.confirm");
			else if (customCalls === 2) {
				await started;
				harness.dispose();
				releaseAction?.();
			} else throw new Error("Disposed busy UI must not reopen its old menu");
			return harness.result;
		},
	});

	const result = await runMenu(
		context.ctx,
		runtimeMenu({
			busy: true,
			run: async () => {
				reportStarted?.();
				await actionGate;
				return { kind: "stay" };
			},
		}),
		{ getState: () => ({ count: 0 }) },
	);

	assert.deepEqual(result, { kind: "stale" });
	assert.equal(customCalls, 2);
});

test("a rejecting error reporter cannot strand a busy action", async () => {
	let customCalls = 0;
	let reporterCalls = 0;
	const context = createMockContext({
		mode: "tui",
		hasUI: true,
		custom: async (factory: unknown) => {
			customCalls += 1;
			const harness = createCustomSelectorHarness(factory, 40);
			if (customCalls === 1) harness.handleInput("tui.select.confirm");
			else if (customCalls === 2) {
				for (let turn = 0; harness.result === undefined && turn < 100; turn += 1) {
					await new Promise<void>((resolve) => setImmediate(resolve));
				}
				assert.notEqual(harness.result, undefined);
				harness.dispose();
			} else harness.handleInput("\u0003");
			return harness.result;
		},
	});

	const result = await runMenu(
		context.ctx,
		runtimeMenu({
			busy: true,
			run: async () => {
				throw new Error("Action failed");
			},
		}),
		{
			getState: () => ({ count: 0 }),
			onError: async () => {
				reporterCalls += 1;
				throw new Error("Reporter failed");
			},
		},
	);

	assert.deepEqual(result, { kind: "closed" });
	assert.equal(customCalls, 3);
	assert.equal(reporterCalls, 1);
});

test("a rejecting error reporter preserves the documented state-load error result", async () => {
	const stateError = new Error("State failed");
	const context = createMockContext({ mode: "tui", hasUI: true });

	const result = await runMenu(context.ctx, runtimeMenu(), {
		getState: () => {
			throw stateError;
		},
		onError: async () => {
			throw new Error("Reporter failed");
		},
	});

	assert.deepEqual(result, { kind: "error", error: stateError });
});

test("component disposal aborts and drains pending setting work before returning", async () => {
	let releaseAction: (() => void) | undefined;
	let reportStarted: (() => void) | undefined;
	const actionGate = new Promise<void>((resolve) => {
		releaseAction = resolve;
	});
	const actionStarted = new Promise<void>((resolve) => {
		reportStarted = resolve;
	});
	const context = createMockContext({
		mode: "tui",
		hasUI: true,
		custom: async (factory: unknown) => {
			const harness = createCustomSelectorHarness(factory, 80);
			harness.handleInput("tui.select.confirm");
			await actionStarted;
			harness.dispose();
			return undefined;
		},
	});
	const running = runMenu(context.ctx, runtimeMenu(), { getState: () => undefined });
	let settled = false;
	const completion = running.then((result) => {
		settled = true;
		return result;
	});
	await actionStarted;
	await new Promise<void>((resolve) => setImmediate(resolve));
	const settledBeforeRelease = settled;
	releaseAction?.();
	const result = await completion;

	assert.equal(settledBeforeRelease, false);
	assert.deepEqual(result, { kind: "stale" });

	function runtimeMenu() {
		return defineMenu<undefined, "settings", "save">({
			start: "settings",
			screens: {
				settings: () => ({
					kind: "settings",
					title: "Settings",
					items: [
						{
							id: "mode",
							label: "Mode",
							currentValue: "Off",
							values: ["Off", "On"],
							action: "save",
						},
					],
				}),
			},
			actions: {
				save: async () => {
					reportStarted?.();
					await actionGate;
					return { kind: "stay" };
				},
			},
		});
	}
});

test("settings refreshes preserve the changed row cursor", async () => {
	let customCalls = 0;
	const context = createMockContext({
		mode: "tui",
		hasUI: true,
		custom: async (factory: unknown) => {
			customCalls += 1;
			const harness = createCustomSelectorHarness(factory, 80);
			if (customCalls === 1) {
				harness.handleInput("tui.select.down");
				harness.handleInput("tui.select.confirm");
			} else {
				assert.match(harness.render().join("\n"), /→ .*Manual mode/);
				harness.handleInput("\u0003");
			}
			for (let turn = 0; harness.result === undefined && turn < 100; turn += 1) {
				await new Promise<void>((resolve) => setImmediate(resolve));
			}
			assert.notEqual(harness.result, undefined);
			return harness.result;
		},
	});
	const definition = defineMenu<undefined, "settings", "save">({
		start: "settings",
		screens: {
			settings: () => ({
				kind: "settings",
				title: "Settings",
				items: [
					{
						id: "automatic",
						label: "Automatic mode",
						currentValue: "Off",
						values: ["Off", "On"],
						action: "save",
					},
					{
						id: "manual",
						label: "Manual mode",
						currentValue: "Off",
						values: ["Off", "On"],
						action: "save",
					},
				],
			}),
		},
		actions: { save: async () => ({ kind: "stay" }) },
	});

	assert.deepEqual(await runMenu(context.ctx, definition, { getState: () => undefined }), {
		kind: "closed",
	});
	assert.equal(customCalls, 2);
});

test("stale settings saves are rejected and drained before the runtime exits", async () => {
	let current = true;
	let release: (() => void) | undefined;
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	let customCalls = 0;
	const definition = runtimeMenu();
	definition.actions.automatic = async () => {
		await gate;
		return { kind: "stay" };
	};
	const context = createMockContext({
		mode: "tui",
		hasUI: true,
		custom: async (factory: unknown) => {
			customCalls += 1;
			const inputs =
				customCalls === 1
					? ["tui.select.down", "tui.select.down", "tui.select.confirm"]
					: ["tui.select.confirm", "tui.select.cancel"];
			const harness = createCustomSelectorHarness(factory, 40);
			for (const input of inputs) harness.handleInput(input);
			while (harness.result === undefined) {
				await new Promise<void>((resolve) => setImmediate(resolve));
			}
			return harness.result;
		},
	});
	const running: Promise<RunMenuResult> = runMenu(context.ctx, definition, {
		getState: () => ({ count: 0 }),
		isCurrent: () => current,
	});
	await new Promise<void>((resolve) => setImmediate(resolve));
	current = false;
	release?.();
	assert.deepEqual(await running, { kind: "stale" });
	assert.equal(customCalls, 2);
});
