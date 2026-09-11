import assert from "node:assert/strict";
import { test } from "vitest";
import { startFreshImplementationSession } from "../src/fresh-implementation.js";
import planMode from "../src/plan-mode.js";
import {
	MAX_PENDING_IMPLEMENTATION_MODEL_IDENTIFIER_LENGTH,
	restorePlanModeState,
} from "../src/state.js";
import { createMockContext, createMockPi } from "./support.js";

const STATE_ENTRY_TYPE = "plan-mode-state";
const PLAN = "# Runtime plan\n\n1. Apply destination settings.";
const TARGET = { provider: "target-provider", id: "target-model", name: "Target" };

function stateEntry(data: Record<string, unknown>) {
	return { type: "custom" as const, customType: STATE_ENTRY_TYPE, data };
}

async function submitInput(
	mock: ReturnType<typeof createMockPi>,
	ctx: unknown,
	text = "implement",
	source: "extension" | "rpc" = "extension",
) {
	const input = mock.events.get("input")?.[0];
	assert.ok(input);
	return Promise.resolve(input({ text, source }, ctx));
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

	const boundaryProvider = "p".repeat(MAX_PENDING_IMPLEMENTATION_MODEL_IDENTIFIER_LENGTH);
	const boundaryModelId = "m".repeat(MAX_PENDING_IMPLEMENTATION_MODEL_IDENTIFIER_LENGTH);
	const boundary = restorePlanModeState(
		[
			stateEntry({
				enabled: false,
				awaitingAction: false,
				pendingImplementationRuntime: {
					version: 1,
					model: { provider: boundaryProvider, modelId: boundaryModelId },
				},
			}),
		],
		STATE_ENTRY_TYPE,
	);
	assert.deepEqual(boundary.pendingImplementationRuntime?.model, {
		provider: boundaryProvider,
		modelId: boundaryModelId,
	});

	const invalidValues = [
		null,
		{},
		{ version: 2, thinkingLevel: "high" },
		{ version: 1, thinkingLevel: "inherit" },
		{ version: 1, thinkingLevel: "high", unknown: true },
		{ version: 1, model: { provider: "", modelId: "model" } },
		{
			version: 1,
			model: {
				provider: "provider",
				modelId: "x".repeat(MAX_PENDING_IMPLEMENTATION_MODEL_IDENTIFIER_LENGTH + 1),
			},
		},
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

test("unpersistable selected model identifiers reject before source replacement", async () => {
	const invalidIdentifiers = [
		{
			name: "overlong provider",
			field: "provider" as const,
			value: "x".repeat(MAX_PENDING_IMPLEMENTATION_MODEL_IDENTIFIER_LENGTH + 1),
		},
		{
			name: "overlong model ID",
			field: "modelId" as const,
			value: "x".repeat(MAX_PENDING_IMPLEMENTATION_MODEL_IDENTIFIER_LENGTH + 1),
		},
		{ name: "blank provider", field: "provider" as const, value: " " },
		{ name: "blank model ID", field: "modelId" as const, value: " " },
	];
	for (const { name, field, value } of invalidIdentifiers) {
		let findCalls = 0;
		let authCalls = 0;
		let newSessionCalls = 0;
		const context = createMockContext({
			mode: "rpc",
			hasUI: true,
			model: { provider: "planning-provider", id: "planning-model" },
			modelRegistry: {
				find: () => {
					findCalls += 1;
					return TARGET;
				},
				getApiKeyAndHeaders: async () => {
					authCalls += 1;
					return { ok: true as const };
				},
			},
			newSession: async () => {
				newSessionCalls += 1;
				return { cancelled: false };
			},
		});
		const model = {
			provider: TARGET.provider,
			modelId: TARGET.id,
			[field]: value,
		};

		const result = await startFreshImplementationSession(context.ctx, {
			plan: PLAN,
			source: "plan_mode_complete",
			retention: "keep",
			stateEntryType: STATE_ENTRY_TYPE,
			runtime: { model },
			isCurrent: () => true,
		});

		assert.equal(result.kind, "rejected", name);
		assert.equal(findCalls, 0, name);
		assert.equal(authCalls, 0, name);
		assert.equal(newSessionCalls, 0, name);
		assert.match(
			context.notifications.at(-1)?.message ?? "",
			new RegExp(`1-${MAX_PENDING_IMPLEMENTATION_MODEL_IDENTIFIER_LENGTH}`, "u"),
			name,
		);
	}
});

test("fresh preflight suppresses stale warnings and contains notification failures", async () => {
	const staleScenarios = [
		{
			model: { provider: "planning-provider", id: "planning-model" },
			runtime: { model: { provider: TARGET.provider, modelId: TARGET.id } },
			modelRegistry: { find: () => undefined },
		},
		{
			model: undefined,
			runtime: undefined,
			modelRegistry: {},
		},
		{
			model: { provider: "planning-provider", id: "planning-model" },
			runtime: undefined,
			modelRegistry: {
				getApiKeyAndHeaders: async () => {
					throw new Error("stale auth");
				},
			},
		},
	];
	for (const scenario of staleScenarios) {
		let currentChecks = 0;
		const context = createMockContext({
			mode: "rpc",
			hasUI: true,
			model: scenario.model,
			modelRegistry: scenario.modelRegistry,
		});
		const result = await startFreshImplementationSession(context.ctx, {
			plan: PLAN,
			source: "plan_mode_complete",
			retention: "keep",
			stateEntryType: STATE_ENTRY_TYPE,
			runtime: scenario.runtime,
			isCurrent: () => {
				currentChecks += 1;
				return currentChecks === 1;
			},
		});
		assert.equal(result.kind, "rejected");
		assert.deepEqual(context.notifications, []);
	}

	const throwingNotification = createMockContext({
		mode: "rpc",
		hasUI: true,
		model: { provider: "planning-provider", id: "planning-model" },
		modelRegistry: { find: () => undefined },
	});
	(throwingNotification.ctx as { ui: { notify(): void } }).ui.notify = () => {
		throw new Error("stale UI");
	};
	const result = await startFreshImplementationSession(throwingNotification.ctx, {
		plan: PLAN,
		source: "plan_mode_complete",
		retention: "keep",
		stateEntryType: STATE_ENTRY_TYPE,
		runtime: { model: { provider: TARGET.provider, modelId: TARGET.id } },
		isCurrent: () => true,
	});
	assert.equal(result.kind, "rejected");
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
		assert.equal(await submitInput(mock, context.ctx), undefined);
		assert.deepEqual(order, scenario.expectedOrder, scenario.name);
		if (scenario.runtime) {
			const consumed = mock.entries.at(-1)?.data as {
				pendingImplementationRuntime?: unknown;
			};
			assert.equal(consumed.pendingImplementationRuntime, undefined, scenario.name);
		}
		await mock.events.get("agent_start")?.[0]?.({}, context.ctx);
		assert.equal(await submitInput(mock, context.ctx, "again"), undefined);
		assert.deepEqual(order, scenario.expectedOrder, `${scenario.name} reapplied`);
	}
});

test("destination applies restored runtime during resumed session startup", async () => {
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
	const context = createMockContext({
		sessionManager: { getBranch: () => branch, getEntries: () => branch },
		modelRegistry: {
			find: (provider: string, id: string) =>
				provider === TARGET.provider && id === TARGET.id ? TARGET : undefined,
			getApiKeyAndHeaders: async () => ({ ok: true as const }),
		},
	});

	await mock.events.get("session_start")?.[0]?.({ reason: "resume" }, context.ctx);

	assert.deepEqual(order, ["model", "thinking:high"]);
	assert.deepEqual(mock.setModels, [TARGET]);
	assert.equal(mock.thinkingLevel, "high");
	assert.equal(
		(mock.entries.at(-1)?.data as { pendingImplementationRuntime?: unknown } | undefined)
			?.pendingImplementationRuntime,
		undefined,
	);
});

test("destination applies restored runtime during tree navigation", async () => {
	const branch: Array<ReturnType<typeof stateEntry>> = [];
	const mock = createMockPi({ thinkingLevel: "low" });
	planMode(mock.pi, { readSettings: async () => ({ kind: "missing" as const }) });
	const context = createMockContext({
		sessionManager: { getBranch: () => branch, getEntries: () => branch },
		modelRegistry: {
			find: (provider: string, id: string) =>
				provider === TARGET.provider && id === TARGET.id ? TARGET : undefined,
			getApiKeyAndHeaders: async () => ({ ok: true as const }),
		},
	});
	await mock.events.get("session_start")?.[0]?.({ reason: "new" }, context.ctx);
	branch.push(
		stateEntry({
			enabled: false,
			awaitingAction: false,
			pendingImplementationRuntime: {
				version: 1,
				model: { provider: TARGET.provider, modelId: TARGET.id },
				thinkingLevel: "high",
			},
		}),
	);

	await mock.events.get("session_tree")?.[0]?.({}, context.ctx);

	assert.deepEqual(mock.setModels, [TARGET]);
	assert.equal(mock.thinkingLevel, "high");
	assert.equal(
		(mock.entries.at(-1)?.data as { pendingImplementationRuntime?: unknown } | undefined)
			?.pendingImplementationRuntime,
		undefined,
	);
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
	assert.equal(await submitInput(mock, context.ctx), undefined);
	await mock.events.get("agent_start")?.[0]?.({}, context.ctx);
	assert.equal(await submitInput(mock, context.ctx, "again"), undefined);

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

test("destination serializes concurrent prompts across the full runtime application", async () => {
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
	const setModel = mock.rawPi.setModel.bind(mock.rawPi);
	mock.rawPi.setModel = async (model) => {
		markModelStarted();
		await modelGate;
		return setModel(model);
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
	const first = submitInput(mock, context.ctx, "implement", "rpc");
	await modelStarted;
	let secondSettled = false;
	const second = submitInput(mock, context.ctx, "concurrent", "rpc").then((result) => {
		secondSettled = true;
		return result;
	});
	await Promise.resolve();
	assert.equal(secondSettled, false);
	releaseModel();
	assert.deepEqual(await Promise.all([first, second]), [undefined, { action: "handled" }]);
	assert.deepEqual(mock.sentUserMessages, []);
	assert.deepEqual(await submitInput(mock, context.ctx, "late", "rpc"), {
		action: "handled",
	});
	assert.deepEqual(mock.sentUserMessages, []);
	await mock.events.get("agent_start")?.[0]?.({}, context.ctx);
	assert.deepEqual(mock.sentUserMessages, [
		{
			text: "concurrent",
			options: { deliverAs: "followUp", expandPromptTemplates: true },
		},
		{
			text: "late",
			options: { deliverAs: "followUp", expandPromptTemplates: true },
		},
	]);
	assert.equal(mock.setModels.length, 1);
	assert.equal(mock.thinkingLevel, "high");
});

test("destination preserves pre-admission prompts when shutdown interrupts runtime application", async () => {
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
			},
		}),
	];
	const mock = createMockPi();
	const setModel = mock.rawPi.setModel.bind(mock.rawPi);
	mock.rawPi.setModel = async (model) => {
		markModelStarted();
		await modelGate;
		return setModel(model);
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
	const leading = submitInput(mock, context.ctx, "implement", "rpc");
	await modelStarted;
	const image = { type: "image" as const, data: "queued-image", mimeType: "image/png" };
	const input = mock.events.get("input")?.[0];
	assert.ok(input);
	const follower = Promise.resolve(
		input({ text: "queued prompt", images: [image], source: "rpc" }, context.ctx),
	);
	const shutdown = Promise.resolve(
		mock.events.get("session_shutdown")?.[0]?.({ reason: "quit" }, context.ctx),
	);

	assert.deepEqual(mock.sentMessages, [
		{
			message: {
				customType: "plan-mode-recovered-input",
				content: [{ type: "text", text: "queued prompt" }, image],
				display: true,
				details: { source: "rpc" },
			},
			options: { triggerTurn: false },
		},
	]);
	releaseModel();
	assert.deepEqual(await Promise.all([leading, follower]), [
		{ action: "handled" },
		{ action: "handled" },
	]);
	await shutdown;
	assert.deepEqual(mock.sentUserMessages, []);
});

test("destination blocks tree navigation until pre-admission prompts are admitted", async () => {
	const branch = [
		stateEntry({
			enabled: false,
			awaitingAction: false,
			pendingImplementationRuntime: { version: 1, thinkingLevel: "high" },
		}),
	];
	const mock = createMockPi({ thinkingLevel: "low" });
	planMode(mock.pi, { readSettings: async () => ({ kind: "missing" as const }) });
	const context = createMockContext({
		hasUI: true,
		sessionManager: { getBranch: () => branch, getEntries: () => branch },
	});
	await mock.events.get("session_start")?.[0]?.({ reason: "new" }, context.ctx);
	assert.equal(await submitInput(mock, context.ctx, "implement", "rpc"), undefined);
	assert.deepEqual(await submitInput(mock, context.ctx, "queued", "rpc"), {
		action: "handled",
	});

	const result = await mock.events.get("session_before_tree")?.[0]?.(
		{ preparation: { targetId: "older" } },
		context.ctx,
	);
	assert.deepEqual(result, { cancel: true });
	assert.match(context.notifications.at(-1)?.message ?? "", /queued prompts/u);

	await mock.events.get("agent_start")?.[0]?.({}, context.ctx);
	assert.deepEqual(mock.sentUserMessages, [
		{
			text: "queued",
			options: { deliverAs: "followUp", expandPromptTemplates: true },
		},
	]);
});

test("destination serializes a concurrent prompt while authentication is pending", async () => {
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
	const mock = createMockPi();
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
	const first = submitInput(mock, context.ctx, "implement", "rpc");
	await authStarted;
	let secondSettled = false;
	const second = submitInput(mock, context.ctx, "concurrent", "rpc").then((result) => {
		secondSettled = true;
		return result;
	});
	await Promise.resolve();
	assert.equal(secondSettled, false);
	releaseAuth();
	assert.deepEqual(await Promise.all([first, second]), [undefined, { action: "handled" }]);
	await mock.events.get("agent_start")?.[0]?.({}, context.ctx);
	assert.deepEqual(mock.sentUserMessages, [
		{
			text: "concurrent",
			options: { deliverAs: "followUp", expandPromptTemplates: true },
		},
	]);
	assert.equal(mock.setModels.length, 1);
});

test("destination blocks a prompt until runtime intent consumption can persist", async () => {
	const branch = [
		stateEntry({
			enabled: false,
			awaitingAction: false,
			pendingImplementationRuntime: { version: 1, thinkingLevel: "high" },
		}),
	];
	const mock = createMockPi({ thinkingLevel: "low" });
	const appendEntry = mock.rawPi.appendEntry.bind(mock.rawPi);
	const attemptedStates: unknown[] = [];
	let persistenceAvailable = false;
	mock.rawPi.appendEntry = (customType, data) => {
		attemptedStates.push(data);
		if (!persistenceAvailable) throw new Error("disk unavailable");
		appendEntry(customType, data);
	};
	planMode(mock.pi, { readSettings: async () => ({ kind: "missing" as const }) });
	const context = createMockContext({
		sessionManager: { getBranch: () => branch, getEntries: () => branch },
	});
	await mock.events.get("session_start")?.[0]?.({ reason: "new" }, context.ctx);

	assert.deepEqual(await submitInput(mock, context.ctx), { action: "handled" });
	assert.equal(mock.thinkingLevel, "low");
	assert.equal(attemptedStates.length, 2);
	assert.deepEqual(
		(attemptedStates.at(-1) as { pendingImplementationRuntime?: unknown })
			.pendingImplementationRuntime,
		{ version: 1, thinkingLevel: "high" },
	);
	assert.match(context.notifications.at(-1)?.message ?? "", /request was not sent/iu);

	persistenceAvailable = true;
	assert.equal(await submitInput(mock, context.ctx, "retry"), undefined);
	assert.equal(mock.thinkingLevel, "high");
	assert.equal(
		(mock.entries.at(-1)?.data as { pendingImplementationRuntime?: unknown } | undefined)
			?.pendingImplementationRuntime,
		undefined,
	);
});

test("destination drains asynchronous model application and preserves stale runtime intent", async () => {
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
	const pending = submitInput(mock, context.ctx);
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

	assert.equal(mock.thinkingLevel, "low");
	assert.deepEqual(
		(mock.entries.at(-1)?.data as { pendingImplementationRuntime?: unknown } | undefined)
			?.pendingImplementationRuntime,
		{
			version: 1,
			model: { provider: TARGET.provider, modelId: TARGET.id },
			thinkingLevel: "high",
		},
	);
});

test("destination shutdown preserves intent during uncancellable authentication preflight", async () => {
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
	const pending = submitInput(mock, context.ctx);
	await authStarted;
	await mock.events.get("session_shutdown")?.[0]?.({ reason: "new" }, context.ctx);
	releaseAuth();
	await pending;

	assert.equal(mock.setModels.length, 0);
	assert.equal(mock.thinkingLevel, "low");
	assert.deepEqual(
		(mock.entries.at(-1)?.data as { pendingImplementationRuntime?: unknown } | undefined)
			?.pendingImplementationRuntime,
		{
			version: 1,
			model: { provider: TARGET.provider, modelId: TARGET.id },
		},
	);

	await mock.events.get("session_start")?.[0]?.({ reason: "resume" }, context.ctx);
	assert.equal(mock.setModels.length, 1);
	assert.equal(
		(mock.entries.at(-1)?.data as { pendingImplementationRuntime?: unknown } | undefined)
			?.pendingImplementationRuntime,
		undefined,
	);
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
	assert.equal(await submitInput(mock, context.ctx), undefined);
	await mock.events.get("agent_start")?.[0]?.({}, context.ctx);
	assert.equal(await submitInput(mock, context.ctx, "again"), undefined);

	assert.equal(calls, 1);
	assert.match(context.notifications.at(-1)?.message ?? "", /could not be applied/u);
	assert.equal(JSON.stringify(context.notifications).includes("\u001b"), false);
});
