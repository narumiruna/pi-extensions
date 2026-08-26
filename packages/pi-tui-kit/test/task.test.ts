import assert from "node:assert/strict";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { test } from "vitest";
import { createCustomSelectorHarness, createMockContext } from "../../../test/support.js";
import { runTask } from "../src/index.js";

initTheme("dark", false);

test("runTask executes directly outside TUI without opening custom UI", async () => {
	let customCalls = 0;
	const context = createMockContext({
		mode: "rpc",
		hasUI: true,
		custom: async () => {
			customCalls += 1;
		},
	});

	const result = await runTask(context.ctx, {
		label: "Loading",
		task: async ({ signal }) => {
			assert.equal(signal.aborted, false);
			return 42;
		},
	});

	assert.deepEqual(result, { kind: "completed", value: 42 });
	assert.equal(customCalls, 0);
});

test("runTask user cancellation aborts and drains the task before returning", async () => {
	let ctrlCHintCount = 0;
	let observedAbort = false;
	let observedAbortAfterInput = false;
	let resultBeforeDrain: unknown = "not-observed";
	let settled = false;
	let releaseDrain: (() => void) | undefined;
	const drain = new Promise<void>((resolve) => {
		releaseDrain = resolve;
	});
	const context = createMockContext({
		mode: "tui",
		hasUI: true,
		custom: async (factory: unknown) => {
			const harness = createCustomSelectorHarness(factory, 40);
			const frame = harness.render().join("\n");
			ctrlCHintCount = frame.match(/ctrl\+c/gu)?.length ?? 0;
			harness.handleInput("tui.select.cancel");
			await new Promise<void>((resolve) => setImmediate(resolve));
			observedAbortAfterInput = observedAbort;
			resultBeforeDrain = harness.result;
			releaseDrain?.();
			return harness.resultPromise;
		},
	});

	const result = await runTask(context.ctx, {
		label: "Loading",
		task: async ({ signal }) => {
			await new Promise<void>((resolve) => {
				if (signal.aborted) {
					observedAbort = true;
					resolve();
					return;
				}
				signal.addEventListener(
					"abort",
					() => {
						observedAbort = true;
						resolve();
					},
					{ once: true },
				);
			});
			await drain;
			settled = true;
			return "late";
		},
	});

	assert.deepEqual(result, { kind: "cancelled" });
	assert.equal(settled, true);
	assert.equal(ctrlCHintCount, 1);
	assert.equal(observedAbortAfterInput, true);
	assert.equal(resultBeforeDrain, undefined);
});

test("runTask uses callback-injected cancellation keys and renders their hint", async () => {
	let abortedAfterInjectedKey = false;
	let renderedFrame: readonly string[] = [];
	const context = createMockContext({
		mode: "tui",
		hasUI: true,
		custom: async (factory: unknown) => {
			const harness = createCustomSelectorHarness(factory, 40, {
				matches: (data, binding) => binding === "tui.select.cancel" && data === "x",
				getKeys: (binding) => (binding === "tui.select.cancel" ? ["x"] : []),
			});
			renderedFrame = harness.render();
			harness.handleInput("x");
			await new Promise<void>((resolve) => setImmediate(resolve));
			abortedAfterInjectedKey = taskSignal?.aborted ?? false;
			if (!abortedAfterInjectedKey) {
				harness.dispose();
				return undefined;
			}
			return harness.resultPromise;
		},
	});
	let taskSignal: AbortSignal | undefined;

	const result = await runTask(context.ctx, {
		label: "Loading",
		task: async ({ signal }) => {
			taskSignal = signal;
			await new Promise<void>((resolve) => {
				if (signal.aborted) resolve();
				else signal.addEventListener("abort", () => resolve(), { once: true });
			});
			return "late";
		},
	});

	assert.equal(abortedAfterInjectedKey, true);
	assert.deepEqual(result, { kind: "cancelled" });
	assert.equal(renderedFrame[0], "─".repeat(40));
	assert.equal(renderedFrame.at(-1), "─".repeat(40));
	assert.match(renderedFrame.join("\n"), /x\/ctrl\+c cancel/u);
});

test("runTask keeps Ctrl+C as hard cancel when the configured key is remapped", async () => {
	let renderedFrame = "";
	let taskSignal: AbortSignal | undefined;
	let taskSettled = false;
	const context = createMockContext({
		mode: "tui",
		hasUI: true,
		custom: async (factory: unknown) => {
			const harness = createCustomSelectorHarness(factory, 40, {
				matches: (data, binding) => binding === "tui.select.cancel" && data === "x",
				getKeys: (binding) => (binding === "tui.select.cancel" ? ["x"] : []),
			});
			renderedFrame = harness.render().join("\n");
			harness.handleInput("\u0003");
			return harness.resultPromise;
		},
	});

	const result = await runTask(context.ctx, {
		label: "Loading",
		task: async ({ signal }) => {
			taskSignal = signal;
			await new Promise<void>((resolve) => {
				if (signal.aborted) resolve();
				else signal.addEventListener("abort", () => resolve(), { once: true });
			});
			taskSettled = true;
			return "late";
		},
	});

	assert.equal(taskSignal?.aborted, true);
	assert.equal(taskSettled, true);
	assert.deepEqual(result, { kind: "cancelled" });
	assert.match(renderedFrame, /x\/ctrl\+c cancel/u);
	assert.equal(renderedFrame.match(/ctrl\+c/gu)?.length, 1);
	for (const line of renderedFrame.split("\n")) assert.ok(line.length <= 40);
});

test("runTask non-cancellable mode ignores cancel input and hides the hint", async () => {
	let releaseTask: (() => void) | undefined;
	const taskGate = new Promise<void>((resolve) => {
		releaseTask = resolve;
	});
	let taskSignal: AbortSignal | undefined;
	let renderedFrame = "";
	let abortedAfterConfiguredCancel: boolean | undefined;
	let abortedAfterHardCancel: boolean | undefined;
	const context = createMockContext({
		mode: "tui",
		hasUI: true,
		custom: async (factory: unknown) => {
			const harness = createCustomSelectorHarness(factory, 40);
			renderedFrame = harness.render().join("\n");
			harness.handleInput("tui.select.cancel");
			await new Promise<void>((resolve) => setImmediate(resolve));
			abortedAfterConfiguredCancel = taskSignal?.aborted;
			harness.handleInput("\u0003");
			await new Promise<void>((resolve) => setImmediate(resolve));
			abortedAfterHardCancel = taskSignal?.aborted;
			releaseTask?.();
			return harness.resultPromise;
		},
	});

	const result = await runTask(context.ctx, {
		label: "Loading",
		cancellable: false,
		task: async ({ signal }) => {
			taskSignal = signal;
			await taskGate;
			return "done";
		},
	});

	assert.deepEqual(result, { kind: "completed", value: "done" });
	assert.doesNotMatch(renderedFrame, /cancel/iu);
	assert.equal(abortedAfterConfiguredCancel, false);
	assert.equal(abortedAfterHardCancel, false);
});

test("runTask owner abort is stale and drains before closing TUI", async () => {
	const owner = new AbortController();
	let reportStarted: (() => void) | undefined;
	const started = new Promise<void>((resolve) => {
		reportStarted = resolve;
	});
	let taskSettled = false;
	const context = createMockContext({
		mode: "tui",
		hasUI: true,
		custom: async (factory: unknown) => {
			const harness = createCustomSelectorHarness(factory, 40);
			await started;
			owner.abort(new DOMException("Session replaced", "AbortError"));
			const result = await harness.resultPromise;
			assert.equal(taskSettled, true);
			return result;
		},
	});

	const result = await runTask(context.ctx, {
		label: "Loading",
		signal: owner.signal,
		task: async ({ signal }) => {
			reportStarted?.();
			await new Promise<void>((resolve) => {
				if (signal.aborted) resolve();
				else signal.addEventListener("abort", () => resolve(), { once: true });
			});
			taskSettled = true;
			return "late";
		},
	});

	assert.deepEqual(result, { kind: "stale" });
});

test("runTask treats a custom UI that closes without disposal as stale", async () => {
	let observedAbort = false;
	const context = createMockContext({
		mode: "tui",
		hasUI: true,
		custom: async (factory: unknown) => {
			createCustomSelectorHarness(factory, 40);
			return undefined;
		},
	});

	const result = await runTask(context.ctx, {
		label: "Loading",
		task: async ({ signal }) => {
			await new Promise<void>((resolve) => setImmediate(resolve));
			observedAbort = signal.aborted;
			return "late";
		},
	});

	assert.deepEqual(result, { kind: "stale" });
	assert.equal(observedAbort, true);
});

test("runTask treats external component disposal as stale", async () => {
	let reportStarted: (() => void) | undefined;
	const started = new Promise<void>((resolve) => {
		reportStarted = resolve;
	});
	let observedAbort = false;
	const context = createMockContext({
		mode: "tui",
		hasUI: true,
		custom: async (factory: unknown) => {
			const harness = createCustomSelectorHarness(factory, 40);
			await started;
			harness.dispose();
			return undefined;
		},
	});

	const result = await runTask(context.ctx, {
		label: "Loading",
		task: async ({ signal }) => {
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
			return "late";
		},
	});

	assert.deepEqual(result, { kind: "stale" });
	assert.equal(observedAbort, true);
});

test("runTask returns the original error when a custom reporter rejects", async () => {
	const failure = new Error("Task failed");
	let reporterCalls = 0;
	const context = createMockContext({ mode: "print", hasUI: false });

	const result = await runTask(context.ctx, {
		label: "Loading",
		task: async () => {
			throw failure;
		},
		onError: async () => {
			reporterCalls += 1;
			throw new Error("Reporter failed");
		},
	});

	assert.deepEqual(result, { kind: "error", error: failure });
	assert.equal(reporterCalls, 1);
});

test("runTask suppresses errors after the owner becomes stale", async () => {
	let current = true;
	let release: (() => void) | undefined;
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	let reporterCalls = 0;
	const context = createMockContext({ mode: "print", hasUI: false });
	const running = runTask(context.ctx, {
		label: "Loading",
		isCurrent: () => current,
		task: async () => {
			await gate;
			throw new Error("Late failure");
		},
		onError: () => {
			reporterCalls += 1;
		},
	});

	current = false;
	release?.();
	assert.deepEqual(await running, { kind: "stale" });
	assert.equal(reporterCalls, 0);
});
