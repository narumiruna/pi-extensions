import assert from "node:assert/strict";
import { test } from "vitest";
import { startFreshImplementationSession } from "../src/fresh-implementation.js";
import planMode from "../src/plan-mode.js";
import { restorePlanModeState } from "../src/state.js";
import { createMockContext, createMockPi } from "./support.js";

const STATE_ENTRY_TYPE = "plan-mode-state";
const PLAN = "# Runtime plan\n\n1. Apply destination settings.";
const TARGET = { provider: "target-provider", id: "target-model", name: "Target" };

function stateEntry(data: Record<string, unknown>) {
	return { type: "custom" as const, customType: STATE_ENTRY_TYPE, data };
}

test("pending implementation runtime state restores only strict bounded one-shot values", () => {
	const valid = restorePlanModeState(
		[
			stateEntry({
				enabled: false,
				awaitingAction: false,
				pendingImplementationRuntime: {
					version: 1,
					model: { provider: "provider", modelId: "model" },
					thinkingLevel: "high",
				},
			}),
		],
		STATE_ENTRY_TYPE,
	);
	assert.deepEqual(valid.pendingImplementationRuntime, {
		version: 1,
		model: { provider: "provider", modelId: "model" },
		thinkingLevel: "high",
	});

	const invalidValues = [
		null,
		{},
		{ version: 2, thinkingLevel: "high" },
		{ version: 1, thinkingLevel: "inherit" },
		{ version: 1, thinkingLevel: "high", unknown: true },
		{ version: 1, model: { provider: "", modelId: "model" } },
		{ version: 1, model: { provider: "provider", modelId: "x".repeat(513) } },
		{ version: 1, model: { provider: "provider", modelId: "model", name: "extra" } },
	];
	for (const pendingImplementationRuntime of invalidValues) {
		const restored = restorePlanModeState(
			[stateEntry({ enabled: false, awaitingAction: false, pendingImplementationRuntime })],
			STATE_ENTRY_TYPE,
		);
		assert.equal(restored.pendingImplementationRuntime, undefined);
	}

	const active = restorePlanModeState(
		[
			stateEntry({
				enabled: true,
				awaitingAction: false,
				pendingImplementationRuntime: { version: 1, thinkingLevel: "high" },
			}),
		],
		STATE_ENTRY_TYPE,
	);
	assert.equal(active.pendingImplementationRuntime, undefined);
});

test("fresh preflight re-resolves an explicit model and persists intent beside destination state", async () => {
	let destinationState: unknown;
	const authModels: unknown[] = [];
	const source = createMockContext({
		mode: "rpc",
		hasUI: true,
		model: { provider: "planning-provider", id: "planning-model" },
		modelRegistry: {
			find: (provider: string, id: string) =>
				provider === TARGET.provider && id === TARGET.id ? TARGET : undefined,
			getApiKeyAndHeaders: async (model: unknown) => {
				authModels.push(model);
				return { ok: true as const };
			},
		},
		sessionManager: { getSessionFile: () => "/sessions/planning.jsonl" },
		newSession: async (options: {
			setup?: (manager: {
				appendCustomMessageEntry(): string;
				appendCustomEntry(customType: string, data: unknown): string;
			}) => Promise<void>;
			withSession?: (ctx: { sendUserMessage(message: string): Promise<void> }) => Promise<void>;
		}) => {
			await options.setup?.({
				appendCustomMessageEntry: () => "contract",
				appendCustomEntry(_customType, data) {
					destinationState = data;
					return "state";
				},
			});
			await options.withSession?.({ sendUserMessage: async () => undefined });
			return { cancelled: false };
		},
	});

	const result = await startFreshImplementationSession(source.ctx, {
		plan: PLAN,
		source: "plan_mode_complete",
		retention: "keep",
		stateEntryType: STATE_ENTRY_TYPE,
		runtime: {
			model: { provider: TARGET.provider, modelId: TARGET.id },
			thinkingLevel: "high",
		},
		isCurrent: () => true,
	});

	assert.equal(result.kind, "started");
	assert.deepEqual(authModels, [TARGET]);
	assert.deepEqual(
		(destinationState as { pendingImplementationRuntime?: unknown }).pendingImplementationRuntime,
		{
			version: 1,
			model: { provider: TARGET.provider, modelId: TARGET.id },
			thinkingLevel: "high",
		},
	);
	assert.equal(
		(destinationState as { activeImplementation?: { plan?: string } }).activeImplementation?.plan,
		PLAN,
	);
});

test("clear-on-start persists only temporary runtime intent when an override is selected", async () => {
	let destinationState: unknown;
	const source = createMockContext({
		mode: "rpc",
		hasUI: true,
		model: { provider: "planning-provider", id: "planning-model" },
		modelRegistry: {
			getApiKeyAndHeaders: async () => ({ ok: true as const }),
		},
		sessionManager: { getSessionFile: () => "/sessions/planning.jsonl" },
		newSession: async (options: {
			setup?: (manager: {
				appendCustomMessageEntry(): string;
				appendCustomEntry(customType: string, data: unknown): string;
			}) => Promise<void>;
			withSession?: (ctx: { sendUserMessage(message: string): Promise<void> }) => Promise<void>;
		}) => {
			await options.setup?.({
				appendCustomMessageEntry: () => "contract",
				appendCustomEntry(_customType, data) {
					destinationState = data;
					return "state";
				},
			});
			await options.withSession?.({ sendUserMessage: async () => undefined });
			return { cancelled: false };
		},
	});

	await startFreshImplementationSession(source.ctx, {
		plan: PLAN,
		source: "plan_mode_complete",
		retention: "clear-on-start",
		stateEntryType: STATE_ENTRY_TYPE,
		runtime: { thinkingLevel: "medium" },
		isCurrent: () => true,
	});

	assert.deepEqual(destinationState, {
		enabled: false,
		awaitingAction: false,
		pendingImplementationRuntime: { version: 1, thinkingLevel: "medium" },
	});
});

test("missing or unauthenticated selected models reject before replacing the source session", async () => {
	for (const failure of ["missing", "auth"] as const) {
		let newSessionCalls = 0;
		const context = createMockContext({
			mode: "rpc",
			hasUI: true,
			model: { provider: "planning-provider", id: "planning-model" },
			modelRegistry: {
				find: () => (failure === "missing" ? undefined : TARGET),
				getApiKeyAndHeaders: async () => ({ ok: false as const, error: "configure auth" }),
			},
			newSession: async () => {
				newSessionCalls += 1;
				return { cancelled: false };
			},
		});
		const result = await startFreshImplementationSession(context.ctx, {
			plan: PLAN,
			source: "plan_mode_complete",
			retention: "keep",
			stateEntryType: STATE_ENTRY_TYPE,
			runtime: { model: { provider: TARGET.provider, modelId: TARGET.id } },
			isCurrent: () => true,
		});
		assert.equal(result.kind, "rejected");
		assert.equal(newSessionCalls, 0);
		assert.match(
			context.notifications.at(-1)?.message ?? "",
			/choose another model|configure authentication/iu,
		);
	}
});

test("destination consumes and applies all runtime override classes exactly once", async () => {
	const cases = [
		{ name: "none", runtime: undefined, expectedOrder: [] },
		{
			name: "model only",
			runtime: { version: 1 as const, model: { provider: TARGET.provider, modelId: TARGET.id } },
			expectedOrder: ["model"],
		},
		{
			name: "thinking only",
			runtime: { version: 1 as const, thinkingLevel: "high" as const },
			expectedOrder: ["thinking:high"],
		},
		{
			name: "model and thinking",
			runtime: {
				version: 1 as const,
				model: { provider: TARGET.provider, modelId: TARGET.id },
				thinkingLevel: "high" as const,
			},
			expectedOrder: ["model", "thinking:high"],
		},
	];
	for (const scenario of cases) {
		const branch = scenario.runtime
			? [
					stateEntry({
						enabled: false,
						awaitingAction: false,
						pendingImplementationRuntime: scenario.runtime,
					}),
				]
			: [];
		const order: string[] = [];
		const mock = createMockPi({ thinkingLevel: "low" });
		const originalSetModel = mock.rawPi.setModel.bind(mock.rawPi);
		mock.rawPi.setModel = async (model) => {
			order.push("model");
			return originalSetModel(model);
		};
		const originalSetThinking = mock.rawPi.setThinkingLevel.bind(mock.rawPi);
		mock.rawPi.setThinkingLevel = (level) => {
			order.push(`thinking:${level}`);
			originalSetThinking(level);
		};
		planMode(mock.pi, { readSettings: async () => ({ kind: "missing" as const }) });
		const sessionManager = {
			getBranch: () => branch,
			getEntries: () => branch,
		};
		const context = createMockContext({
			sessionManager,
			modelRegistry: {
				find: (provider: string, id: string) =>
					provider === TARGET.provider && id === TARGET.id ? TARGET : undefined,
				getApiKeyAndHeaders: async () => ({ ok: true as const }),
			},
		});
		await mock.events.get("session_start")?.[0]?.({ reason: "new" }, context.ctx);
		const before = mock.events.get("before_agent_start")?.[0];
		assert.ok(before);
		await before({ prompt: "implement", systemPrompt: "system" }, context.ctx);
		assert.deepEqual(order, scenario.expectedOrder, scenario.name);
		if (scenario.runtime) {
			const consumed = mock.entries.at(-1)?.data as {
				pendingImplementationRuntime?: unknown;
			};
			assert.equal(consumed.pendingImplementationRuntime, undefined, scenario.name);
		}
		await before({ prompt: "again", systemPrompt: "system" }, context.ctx);
		assert.deepEqual(order, scenario.expectedOrder, `${scenario.name} reapplied`);
	}
});

test("destination warns on thinking clamping and consumes a model race failure without retry", async () => {
	const branch = [
		stateEntry({
			enabled: false,
			awaitingAction: false,
			pendingImplementationRuntime: {
				version: 1,
				model: {
					provider: `${TARGET.provider}\u001b[31m`,
					modelId: `${TARGET.id}\u202e`,
				},
				thinkingLevel: "max",
			},
		}),
	];
	const mock = createMockPi({ thinkingLevel: "low", clampThinkingLevel: () => "high" });
	let setModelCalls = 0;
	mock.rawPi.setModel = async () => {
		setModelCalls += 1;
		return false;
	};
	planMode(mock.pi, { readSettings: async () => ({ kind: "missing" as const }) });
	const context = createMockContext({
		sessionManager: { getBranch: () => branch, getEntries: () => branch },
		modelRegistry: {
			find: () => TARGET,
			getApiKeyAndHeaders: async () => ({ ok: true as const }),
		},
	});
	await mock.events.get("session_start")?.[0]?.({ reason: "new" }, context.ctx);
	const before = mock.events.get("before_agent_start")?.[0];
	assert.ok(before);
	await before({ prompt: "implement", systemPrompt: "system" }, context.ctx);
	await before({ prompt: "again", systemPrompt: "system" }, context.ctx);

	assert.equal(setModelCalls, 1);
	assert.equal(mock.thinkingLevel, "high");
	assert.ok(context.notifications.some((notice) => /could not be applied/u.test(notice.message)));
	assert.ok(
		context.notifications.some((notice) => /unsupported.+using high/u.test(notice.message)),
	);
	assert.equal(JSON.stringify(context.notifications).includes("\u001b"), false);
	assert.equal(JSON.stringify(context.notifications).includes("\u202e"), false);
	assert.equal(
		(mock.entries.at(-1)?.data as { pendingImplementationRuntime?: unknown } | undefined)
			?.pendingImplementationRuntime,
		undefined,
	);
});

test("destination drains an asynchronous model and thinking application before shutdown", async () => {
	let releaseModel!: () => void;
	let markModelStarted!: () => void;
	const modelStarted = new Promise<void>((resolve) => {
		markModelStarted = resolve;
	});
	const modelGate = new Promise<void>((resolve) => {
		releaseModel = resolve;
	});
	const branch = [
		stateEntry({
			enabled: false,
			awaitingAction: false,
			pendingImplementationRuntime: {
				version: 1,
				model: { provider: TARGET.provider, modelId: TARGET.id },
				thinkingLevel: "high",
			},
		}),
	];
	const mock = createMockPi({ thinkingLevel: "low" });
	mock.rawPi.setModel = async () => {
		markModelStarted();
		await modelGate;
		return true;
	};
	planMode(mock.pi, { readSettings: async () => ({ kind: "missing" as const }) });
	const context = createMockContext({
		sessionManager: { getBranch: () => branch, getEntries: () => branch },
		modelRegistry: {
			find: () => TARGET,
			getApiKeyAndHeaders: async () => ({ ok: true as const }),
		},
	});
	await mock.events.get("session_start")?.[0]?.({ reason: "new" }, context.ctx);
	const pending = mock.events.get("before_agent_start")?.[0]?.(
		{ prompt: "implement", systemPrompt: "system" },
		context.ctx,
	);
	await modelStarted;
	let shutdownSettled = false;
	const shutdown = Promise.resolve(
		mock.events.get("session_shutdown")?.[0]?.({ reason: "new" }, context.ctx),
	).then(() => {
		shutdownSettled = true;
	});
	await Promise.resolve();
	assert.equal(shutdownSettled, false);
	releaseModel();
	await Promise.all([pending, shutdown]);

	assert.equal(mock.thinkingLevel, "high");
	assert.equal(
		(mock.entries.at(-1)?.data as { pendingImplementationRuntime?: unknown } | undefined)
			?.pendingImplementationRuntime,
		undefined,
	);
});

test("destination shutdown does not wait for uncancellable authentication preflight", async () => {
	let releaseAuth!: () => void;
	let markAuthStarted!: () => void;
	const authStarted = new Promise<void>((resolve) => {
		markAuthStarted = resolve;
	});
	const authGate = new Promise<void>((resolve) => {
		releaseAuth = resolve;
	});
	const branch = [
		stateEntry({
			enabled: false,
			awaitingAction: false,
			pendingImplementationRuntime: {
				version: 1,
				model: { provider: TARGET.provider, modelId: TARGET.id },
			},
		}),
	];
	const mock = createMockPi({ thinkingLevel: "low" });
	planMode(mock.pi, { readSettings: async () => ({ kind: "missing" as const }) });
	const context = createMockContext({
		sessionManager: { getBranch: () => branch, getEntries: () => branch },
		modelRegistry: {
			find: () => TARGET,
			getApiKeyAndHeaders: async () => {
				markAuthStarted();
				await authGate;
				return { ok: true as const };
			},
		},
	});
	await mock.events.get("session_start")?.[0]?.({ reason: "new" }, context.ctx);
	const pending = mock.events.get("before_agent_start")?.[0]?.(
		{ prompt: "implement", systemPrompt: "system" },
		context.ctx,
	);
	await authStarted;
	await mock.events.get("session_shutdown")?.[0]?.({ reason: "new" }, context.ctx);
	releaseAuth();
	await pending;

	assert.equal(mock.setModels.length, 0);
	assert.equal(mock.thinkingLevel, "low");
});

test("destination consumes a thrown model application without retrying", async () => {
	const branch = [
		stateEntry({
			enabled: false,
			awaitingAction: false,
			pendingImplementationRuntime: {
				version: 1,
				model: { provider: TARGET.provider, modelId: TARGET.id },
			},
		}),
	];
	const mock = createMockPi();
	let calls = 0;
	mock.rawPi.setModel = async () => {
		calls += 1;
		throw new Error("provider\u001b[31m changed");
	};
	planMode(mock.pi, { readSettings: async () => ({ kind: "missing" as const }) });
	const context = createMockContext({
		sessionManager: { getBranch: () => branch, getEntries: () => branch },
		modelRegistry: {
			find: () => TARGET,
			getApiKeyAndHeaders: async () => ({ ok: true as const }),
		},
	});
	await mock.events.get("session_start")?.[0]?.({ reason: "new" }, context.ctx);
	const before = mock.events.get("before_agent_start")?.[0];
	assert.ok(before);
	await before({ prompt: "implement", systemPrompt: "system" }, context.ctx);
	await before({ prompt: "again", systemPrompt: "system" }, context.ctx);

	assert.equal(calls, 1);
	assert.match(context.notifications.at(-1)?.message ?? "", /could not be applied/u);
	assert.equal(JSON.stringify(context.notifications).includes("\u001b"), false);
});
