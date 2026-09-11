import assert from "node:assert/strict";
import { test } from "vitest";
import { showReadyPlanMenu } from "../src/plan-action-menus.js";
import { createCustomSelectorHarness, createMockContext } from "./support.js";

function menuOptions(overrides: Record<string, unknown> = {}) {
	return {
		signal: new AbortController().signal,
		isCurrent: () => true,
		implementationOutcome: () => "The plan remains available until implementation ends.",
		planThinkingLevel: undefined,
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
		model: AVAILABLE_MODELS[1],
		thinkingLevel: "low",
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
				if (freshVisits === 1) return "Model";
				if (freshVisits === 2) return "Thinking level";
				return "Start fresh implementation";
			}
			if (title.startsWith("Implementation model")) {
				return options.find((option) => option.includes("model-one [provider-one]"));
			}
			if (title.startsWith("Implementation thinking level")) return "max";
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
	const thinkingDialog = dialogs.find((dialog) =>
		dialog.title.startsWith("Implementation thinking level"),
	);
	assert.ok(thinkingDialog);
	for (const level of ["off", "minimal", "low", "medium", "high", "xhigh", "max"]) {
		assert.ok(
			thinkingDialog.options.some((option) => option.includes(level)),
			level,
		);
	}
});

test("fresh settings use the supplied plan thinking level on older Pi contexts", async () => {
	let selectedRuntime: unknown;
	const context = createMockContext({
		mode: "rpc",
		hasUI: true,
		model: AVAILABLE_MODELS[0],
		thinkingLevel: undefined,
		modelRegistry: { getAvailable: () => AVAILABLE_MODELS },
		select: async (title: string) => {
			if (title.startsWith("Proposed plan ready")) return "Start fresh and implement";
			if (title.startsWith("Fresh implementation settings")) {
				return "Start fresh implementation";
			}
			return undefined;
		},
	});
	delete (context.ctx as Partial<{ thinkingLevel: unknown }>).thinkingLevel;

	await showReadyPlanMenu(
		context.ctx,
		menuOptions({
			planThinkingLevel: "high",
			implementFresh: (runtime: unknown) => {
				selectedRuntime = runtime;
			},
		}),
	);

	assert.deepEqual(selectedRuntime, {
		model: { provider: "provider\u001b[31m-one", modelId: "model\u202e-one" },
		thinkingLevel: "high",
	});
});

test("fresh settings prioritize start and show the plan runtime defaults", async () => {
	let screen = 0;
	let settingsScreen = "";
	const context = createMockContext({
		mode: "tui",
		hasUI: true,
		model: AVAILABLE_MODELS[0],
		thinkingLevel: "medium",
		modelRegistry: { getAvailable: () => AVAILABLE_MODELS },
		custom: async (factory: unknown) => {
			const harness = createCustomSelectorHarness(factory, 90);
			screen += 1;
			if (screen === 1) {
				harness.handleInput("tui.select.down");
				harness.handleInput("tui.select.confirm");
			} else {
				settingsScreen = harness.render().join("\n");
				harness.handleInput("\u0003");
			}
			return harness.resultPromise;
		},
	});

	await showReadyPlanMenu(context.ctx, menuOptions({ planThinkingLevel: "medium" }));

	const start = settingsScreen.indexOf("Start fresh implementation");
	const model = settingsScreen.indexOf("Model");
	const thinking = settingsScreen.indexOf("Thinking level");
	assert.ok(start >= 0 && start < model && model < thinking);
	assert.match(settingsScreen, /→ Start fresh implementation/u);
	assert.match(settingsScreen, /Model\s+model-one \[provider-one\] · same as plan/u);
	assert.match(settingsScreen, /Thinking level\s+medium · same as plan/u);
});

test("fresh settings start from persistent model and thinking defaults", async () => {
	let selectedRuntime: unknown;
	const context = createMockContext({
		mode: "rpc",
		hasUI: true,
		model: AVAILABLE_MODELS[0],
		thinkingLevel: "medium",
		modelRegistry: { getAvailable: () => AVAILABLE_MODELS },
		select: async (title: string) => {
			if (title.startsWith("Proposed plan ready")) return "Start fresh and implement";
			if (title.startsWith("Fresh implementation settings")) {
				return "Start fresh implementation";
			}
			return undefined;
		},
	});

	await showReadyPlanMenu(
		context.ctx,
		menuOptions({
			implementationDefaults: {
				model: { provider: "provider-two", modelId: "model-two" },
				thinkingLevel: "high",
			},
			implementFresh: (runtime: unknown) => {
				selectedRuntime = runtime;
			},
		}),
	);

	assert.deepEqual(selectedRuntime, {
		model: { provider: "provider-two", modelId: "model-two" },
		thinkingLevel: "high",
	});
});

test("unavailable persistent model defaults fall back to same as plan", async () => {
	let availableReads = 0;
	let selectedRuntime: unknown;
	const context = createMockContext({
		mode: "rpc",
		hasUI: true,
		model: AVAILABLE_MODELS[0],
		thinkingLevel: "medium",
		modelRegistry: {
			getAvailable: () => {
				availableReads += 1;
				return availableReads === 1 ? AVAILABLE_MODELS : [AVAILABLE_MODELS[0]];
			},
		},
		select: async (title: string) => {
			if (title.startsWith("Proposed plan ready")) return "Start fresh and implement";
			if (title.startsWith("Fresh implementation settings")) {
				return "Start fresh implementation";
			}
			return undefined;
		},
	});

	await showReadyPlanMenu(
		context.ctx,
		menuOptions({
			implementationDefaults: {
				model: { provider: "provider-two", modelId: "model-two" },
				thinkingLevel: "high",
			},
			implementFresh: (runtime: unknown) => {
				selectedRuntime = runtime;
			},
		}),
	);

	assert.equal(availableReads, 2);
	assert.deepEqual(selectedRuntime, {
		model: {
			provider: "provider\u001b[31m-one",
			modelId: "model\u202e-one",
		},
		thinkingLevel: "high",
	});
	assert.match(context.notifications.at(-1)?.message ?? "", /unavailable.*same as plan/iu);
});

test("stale scoped persistent model defaults fall back to same as plan", async () => {
	let availableReads = 0;
	let selectedRuntime: unknown;
	const context = createMockContext({
		mode: "rpc",
		hasUI: true,
		model: AVAILABLE_MODELS[0],
		thinkingLevel: "medium",
		scopedModels: [{ model: AVAILABLE_MODELS[1] }],
		modelRegistry: {
			getAvailable: () => {
				availableReads += 1;
				return [AVAILABLE_MODELS[0]];
			},
		},
		select: async (title: string) => {
			if (title.startsWith("Proposed plan ready")) return "Start fresh and implement";
			if (title.startsWith("Fresh implementation settings")) {
				return "Start fresh implementation";
			}
			return undefined;
		},
	});

	await showReadyPlanMenu(
		context.ctx,
		menuOptions({
			implementationDefaults: {
				model: { provider: "provider-two", modelId: "model-two" },
				thinkingLevel: "high",
			},
			implementFresh: (runtime: unknown) => {
				selectedRuntime = runtime;
			},
		}),
	);

	assert.equal(availableReads, 1);
	assert.deepEqual(selectedRuntime, {
		model: {
			provider: "provider\u001b[31m-one",
			modelId: "model\u202e-one",
		},
		thinkingLevel: "high",
	});
});

test("fresh thinking choice mirrors the built-in thinking layout", async () => {
	let screen = 0;
	let thinkingScreen = "";
	const context = createMockContext({
		mode: "tui",
		hasUI: true,
		model: AVAILABLE_MODELS[0],
		thinkingLevel: "medium",
		modelRegistry: { getAvailable: () => AVAILABLE_MODELS },
		custom: async (factory: unknown) => {
			const harness = createCustomSelectorHarness(factory, 80);
			screen += 1;
			if (screen === 1) {
				harness.handleInput("tui.select.down");
				harness.handleInput("tui.select.confirm");
			} else if (screen === 2) {
				harness.handleInput("tui.select.down");
				harness.handleInput("tui.select.down");
				harness.handleInput("tui.select.confirm");
			} else {
				for (let index = 0; index < 3; index += 1) {
					harness.handleInput("tui.select.down");
				}
				thinkingScreen = harness.render().join("\n");
				harness.handleInput("\u0003");
			}
			return harness.resultPromise;
		},
	});

	await showReadyPlanMenu(context.ctx, menuOptions({ planThinkingLevel: "medium" }));

	assert.match(thinkingScreen, /Same as plan/u);
	assert.match(thinkingScreen, /off\s+No reasoning/u);
	assert.match(thinkingScreen, /minimal\s+Very brief reasoning \(~1k tokens\)/u);
	assert.match(thinkingScreen, /→ low\s+Light reasoning \(~2k tokens\)/u);
	assert.match(thinkingScreen, /✓ medium\s+Moderate reasoning \(~8k tokens\)/u);
	assert.match(thinkingScreen, /high\s+Deep reasoning \(~16k tokens\)/u);
	assert.match(thinkingScreen, /xhigh\s+Extra-high reasoning \(~32k tokens\)/u);
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
				return freshVisits === 1 ? "Model" : "Start fresh implementation";
			}
			if (title.startsWith("Implementation model")) {
				modelOptions = options;
				return options.find((option) => option.includes("model-two [provider-two]"));
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

	assert.equal(availableReads, 1);
	assert.ok(modelOptions.some((option) => option.includes("model-two [provider-two]")));
	assert.equal(
		modelOptions.some((option) => option.includes("model-one [provider-one]")),
		false,
	);
	assert.deepEqual(selectedRuntime, {
		model: { provider: "provider-two", modelId: "model-two" },
	});
});

test("fresh model picker keeps same as plan available outside the model scope", async () => {
	let freshVisits = 0;
	let modelOptions: string[] = [];
	let selectedRuntime: unknown;
	const context = createMockContext({
		mode: "rpc",
		hasUI: true,
		model: AVAILABLE_MODELS[0],
		thinkingLevel: "medium",
		scopedModels: [{ model: AVAILABLE_MODELS[1] }],
		modelRegistry: { getAvailable: () => AVAILABLE_MODELS },
		select: async (title: string, options: string[]) => {
			if (title.startsWith("Proposed plan ready")) return "Start fresh and implement";
			if (title.startsWith("Fresh implementation settings")) {
				freshVisits += 1;
				return freshVisits === 1 ? "Model" : "Start fresh implementation";
			}
			if (title.startsWith("Implementation model")) {
				modelOptions = options;
				return options.find((option) => option.startsWith("Same as plan"));
			}
			return undefined;
		},
	});

	await showReadyPlanMenu(
		context.ctx,
		menuOptions({
			planThinkingLevel: "medium",
			implementationDefaults: {
				model: { provider: "provider-two", modelId: "model-two" },
			},
			implementFresh: (runtime: unknown) => {
				selectedRuntime = runtime;
			},
		}),
	);

	assert.ok(modelOptions.some((option) => option.startsWith("Same as plan")));
	assert.equal(
		modelOptions.some((option) => option.includes("model-one [provider-one]")),
		false,
	);
	assert.deepEqual(selectedRuntime, {
		model: {
			provider: "provider\u001b[31m-one",
			modelId: "model\u202e-one",
		},
		thinkingLevel: "medium",
	});
});

test("fresh model picker falls back when the scoped-model API is unavailable", async () => {
	let availableReads = 0;
	const context = createMockContext({
		mode: "rpc",
		hasUI: true,
		modelRegistry: {
			getAvailable: () => {
				availableReads += 1;
				return AVAILABLE_MODELS;
			},
		},
		select: async () => undefined,
	});
	delete (context.ctx as Partial<{ scopedModels: unknown }>).scopedModels;

	await showReadyPlanMenu(context.ctx, menuOptions());

	assert.equal(availableReads, 1);
});

test("fresh model choice mirrors the searchable built-in model layout in TUI mode", async () => {
	let screen = 0;
	let initialModelScreen = "";
	let selectedModelScreen = "";
	let filteredModelScreen = "";
	const context = createMockContext({
		mode: "tui",
		hasUI: true,
		model: AVAILABLE_MODELS[0],
		thinkingLevel: "medium",
		modelRegistry: { getAvailable: () => AVAILABLE_MODELS },
		custom: async (factory: unknown) => {
			const harness = createCustomSelectorHarness(factory, 80);
			screen += 1;
			if (screen === 1) {
				harness.handleInput("tui.select.down");
				harness.handleInput("tui.select.confirm");
			} else if (screen === 2) {
				harness.handleInput("tui.select.down");
				harness.handleInput("tui.select.confirm");
			} else {
				initialModelScreen = harness.render().join("\n");
				harness.handleInput("tui.select.down");
				selectedModelScreen = harness.render().join("\n");
				harness.handleInput("beta");
				filteredModelScreen = harness.render().join("\n");
				harness.handleInput("\u0003");
			}
			return harness.resultPromise;
		},
	});

	await showReadyPlanMenu(context.ctx, menuOptions());

	assert.match(initialModelScreen, /→ Same as plan/u);
	assert.match(initialModelScreen, /✓ model-one \[provider-one\] · default/u);
	assert.match(selectedModelScreen, /Model Name: Friendly name/u);
	assert.match(filteredModelScreen, /model-two \[provider-two\]/u);
	assert.match(filteredModelScreen, /Model Name: Beta specialist/u);
	assert.doesNotMatch(filteredModelScreen, /model-one \[provider-one\]/u);
});

test("closing and reopening fresh settings resets its draft to the plan runtime", async () => {
	let invocation = 0;
	let mainVisits = 0;
	let freshVisits = 0;
	let selectedRuntime: unknown;
	const context = createMockContext({
		mode: "rpc",
		hasUI: true,
		model: AVAILABLE_MODELS[0],
		thinkingLevel: "medium",
		modelRegistry: { getAvailable: () => AVAILABLE_MODELS },
		select: async (title: string, options: string[]) => {
			if (title.startsWith("Proposed plan ready")) {
				mainVisits += 1;
				return invocation === 0 && mainVisits > 1 ? undefined : "Start fresh and implement";
			}
			if (title.startsWith("Fresh implementation settings")) {
				freshVisits += 1;
				if (invocation === 0) return freshVisits === 1 ? "Model" : undefined;
				return "Start fresh implementation";
			}
			if (title.startsWith("Implementation model")) {
				return options.find((option) => option.includes("model-two [provider-two]"));
			}
			return undefined;
		},
	});
	const options = menuOptions({
		planThinkingLevel: "medium",
		implementFresh: (runtime: unknown) => {
			selectedRuntime = runtime;
		},
	});

	await showReadyPlanMenu(context.ctx, options);
	invocation = 1;
	mainVisits = 0;
	freshVisits = 0;
	await showReadyPlanMenu(context.ctx, options);

	assert.deepEqual(selectedRuntime, {
		model: { provider: "provider\u001b[31m-one", modelId: "model\u202e-one" },
		thinkingLevel: "medium",
	});
});
