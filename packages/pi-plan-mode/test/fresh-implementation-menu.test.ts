import assert from "node:assert/strict";
import { test } from "vitest";
import { showReadyPlanMenu } from "../src/plan-action-menus.js";
import { createCustomSelectorHarness, createMockContext } from "./support.js";

function menuOptions(overrides: Record<string, unknown> = {}) {
	return {
		signal: new AbortController().signal,
		isCurrent: () => true,
		implementationOutcome: () => "The plan remains available until implementation ends.",
		getExportDestination: () => ({ configuredPath: "PLAN.md", resolvedPath: "/tmp/PLAN.md" }),
		implementHere: () => undefined,
		implementFresh: () => undefined,
		exportPlan: async () => true,
		save: () => undefined,
		stay: () => undefined,
		exit: () => undefined,
		...overrides,
	};
}

const AVAILABLE_MODELS = [
	{
		provider: "provider\u001b[31m-one",
		id: "model\u202e-one",
		name: "Friendly\u001b]8;;https://unsafe.example\u0007 name\u001b]8;;\u0007",
	},
	{ provider: "provider-two", id: "model-two", name: "Beta specialist" },
];

test("fresh settings select sanitized model metadata and fixed thinking in one menu flow", async () => {
	const dialogs: Array<{ title: string; options: string[] }> = [];
	let freshVisits = 0;
	let availableReads = 0;
	let selectedRuntime: unknown;
	const context = createMockContext({
		mode: "rpc",
		hasUI: true,
		modelRegistry: {
			getAvailable: () => {
				availableReads += 1;
				return AVAILABLE_MODELS;
			},
		},
		select: async (title: string, options: string[]) => {
			dialogs.push({ title, options });
			if (title.startsWith("Proposed plan ready")) return "Start fresh and implement";
			if (title.startsWith("Fresh implementation settings")) {
				freshVisits += 1;
				if (freshVisits === 1)
					return options.find((option) => option.startsWith("Implementation model"));
				if (freshVisits === 2) {
					assert.ok(options.some((option) => option.includes("provider-one/model-one")));
					return options.find((option) => option.startsWith("Implementation thinking"));
				}
				assert.ok(options.some((option) => option.endsWith(": max")));
				return "Start fresh implementation";
			}
			if (title.startsWith("Implementation model")) {
				return options.find((option) => option.includes("provider-one/model-one"));
			}
			if (title.startsWith("Implementation thinking")) return "max";
			return undefined;
		},
	});

	await showReadyPlanMenu(
		context.ctx,
		menuOptions({
			implementFresh: (runtime: unknown) => {
				selectedRuntime = runtime;
			},
		}),
	);

	assert.equal(availableReads, 1);
	assert.deepEqual(selectedRuntime, {
		model: { provider: "provider\u001b[31m-one", modelId: "model\u202e-one" },
		thinkingLevel: "max",
	});
	const rendered = dialogs.flatMap((dialog) => [dialog.title, ...dialog.options]).join("\n");
	assert.equal(rendered.includes("\u001b"), false);
	assert.equal(rendered.includes("\u202e"), false);
	assert.match(rendered, /Friendly name/u);
	const thinkingDialog = dialogs.find((dialog) =>
		dialog.title.startsWith("Implementation thinking"),
	);
	assert.ok(thinkingDialog);
	for (const level of ["off", "minimal", "low", "medium", "high", "xhigh", "max"]) {
		assert.ok(
			thinkingDialog.options.some((option) => option.startsWith(level)),
			level,
		);
	}
});

test("fresh model picker honors the nonempty session model scope", async () => {
	let availableReads = 0;
	let freshVisits = 0;
	let modelOptions: string[] = [];
	let selectedRuntime: unknown;
	const context = createMockContext({
		mode: "rpc",
		hasUI: true,
		scopedModels: [{ model: AVAILABLE_MODELS[1], thinkingLevel: "high" }],
		modelRegistry: {
			getAvailable: () => {
				availableReads += 1;
				return AVAILABLE_MODELS;
			},
		},
		select: async (title: string, options: string[]) => {
			if (title.startsWith("Proposed plan ready")) return "Start fresh and implement";
			if (title.startsWith("Fresh implementation settings")) {
				freshVisits += 1;
				return freshVisits === 1
					? options.find((option) => option.startsWith("Implementation model"))
					: "Start fresh implementation";
			}
			if (title.startsWith("Implementation model")) {
				modelOptions = options;
				return options.find((option) => option.includes("provider-two/model-two"));
			}
			return undefined;
		},
	});

	await showReadyPlanMenu(
		context.ctx,
		menuOptions({
			implementFresh: (runtime: unknown) => {
				selectedRuntime = runtime;
			},
		}),
	);

	assert.equal(availableReads, 0);
	assert.ok(modelOptions.some((option) => option.includes("provider-two/model-two")));
	assert.equal(
		modelOptions.some((option) => option.includes("provider-one/model-one")),
		false,
	);
	assert.deepEqual(selectedRuntime, {
		model: { provider: "provider-two", modelId: "model-two" },
	});
});

test("fresh model choice is searchable in TUI mode", async () => {
	let screen = 0;
	let filteredModelScreen = "";
	const context = createMockContext({
		mode: "tui",
		hasUI: true,
		modelRegistry: { getAvailable: () => AVAILABLE_MODELS },
		custom: async (factory: unknown) => {
			const harness = createCustomSelectorHarness(factory, 80);
			screen += 1;
			if (screen === 1) {
				harness.handleInput("tui.select.down");
				harness.handleInput("tui.select.confirm");
			} else if (screen === 2) {
				harness.handleInput("tui.select.confirm");
			} else {
				harness.handleInput("beta");
				filteredModelScreen = harness.render().join("\n");
				harness.handleInput("\u0003");
			}
			return harness.resultPromise;
		},
	});

	await showReadyPlanMenu(context.ctx, menuOptions());

	assert.match(filteredModelScreen, /provider-two\/model-two/u);
	assert.match(filteredModelScreen, /Beta specialist/u);
	assert.doesNotMatch(filteredModelScreen, /provider-one\/model-one/u);
});

test("closing and reopening fresh settings resets its draft to destination defaults", async () => {
	let invocation = 0;
	let stage = 0;
	const freshSnapshots: string[][] = [];
	const context = createMockContext({
		mode: "rpc",
		hasUI: true,
		modelRegistry: { getAvailable: () => AVAILABLE_MODELS },
		select: async (title: string, options: string[]) => {
			if (title.startsWith("Proposed plan ready")) {
				if (stage === 0) {
					stage = 1;
					return "Start fresh and implement";
				}
				return undefined;
			}
			if (title.startsWith("Fresh implementation settings")) {
				freshSnapshots.push(options);
				if (invocation === 0 && stage === 1) {
					stage = 2;
					return options.find((option) => option.startsWith("Implementation model"));
				}
				return undefined;
			}
			if (title.startsWith("Implementation model")) {
				return options.find((option) => option.includes("provider-two/model-two"));
			}
			return undefined;
		},
	});

	await showReadyPlanMenu(context.ctx, menuOptions());
	invocation = 1;
	stage = 0;
	await showReadyPlanMenu(context.ctx, menuOptions());

	assert.ok(
		freshSnapshots[1]?.some((option) =>
			option.startsWith("Implementation model: provider-two/model-two"),
		),
	);
	assert.ok(
		freshSnapshots.at(-1)?.some((option) => option === "Implementation model: Destination default"),
	);
	assert.ok(
		freshSnapshots
			.at(-1)
			?.some((option) => option === "Implementation thinking: Destination default"),
	);
});
