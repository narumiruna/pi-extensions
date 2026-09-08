import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { test } from "vitest";
import {
	IMPLEMENTATION_PLAN_RETENTIONS,
	type ImplementationPreferences,
	type PlanModeSettings,
} from "../src/settings.js";
import { createMockContext, createMockPi } from "./support.js";

const PLANNER = { provider: "test", id: "planner" };
const WORKER = { provider: "test", id: "worker" };
const PREFERENCES: ImplementationPreferences = {
	implementationModel: WORKER,
	implementationThinkingLevel: "high",
};

async function readyFixture(
	settings: PlanModeSettings = { thinkingLevel: "medium", ...PREFERENCES },
) {
	const directory = await mkdtemp(join(tmpdir(), "plan-handoff-"));
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = directory;
	const { default: planMode } = await import("../src/plan-mode.js");
	const mock = createMockPi({ activeTools: ["read", "edit"], thinkingLevel: "low" });
	let model = PLANNER;
	const context = createMockContext({
		mode: "rpc",
		hasUI: true,
		cwd: directory,
		modelRegistry: {
			find: (provider: string, id: string) =>
				[PLANNER, WORKER].find((model) => model.provider === provider && model.id === id),
			getAvailable: () => [PLANNER, WORKER],
			getApiKeyAndHeaders: async () => ({ ok: true }),
		},
	});
	const ctx: ExtensionContext = context.ctx;
	Object.defineProperty(ctx, "model", { get: () => model });
	Object.defineProperty(ctx, "thinkingLevel", { get: () => mock.thinkingLevel });
	mock.rawPi.setModel = async (next) => {
		model = next as typeof model;
		mock.setModels.push(next);
		for (const handler of mock.events.get("model_select") ?? []) await handler({ model }, ctx);
		return true;
	};
	planMode(mock.pi, { readSettings: async () => ({ kind: "loaded", settings }) });
	const emit = async (event: string, data: unknown = {}) => {
		for (const handler of mock.events.get(event) ?? []) await handler(data, ctx);
	};
	const registered = mock.commands.get("plan");
	assert.ok(registered);
	const command = (text: string) => registered.handler(text, context.ctx);
	await emit("session_start", { reason: "startup" });
	await command("start");
	const tool = mock.tools.find((tool) => tool.name === "plan_mode_complete");
	assert.ok(tool);
	const complete = tool.execute as (...args: unknown[]) => Promise<unknown>;
	await complete(
		"complete",
		{ plan: "# Approved\nImplement and test." },
		undefined,
		undefined,
		ctx,
	);
	return {
		mock,
		context,
		ctx,
		command,
		emit,
		manualModel: (next: typeof model) => {
			model = next;
		},
		async dispose() {
			await emit("session_shutdown");
			if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
			await rm(directory, { recursive: true, force: true });
		},
	};
}

for (const { saved, retention } of [false, true].flatMap((saved) =>
	IMPLEMENTATION_PLAN_RETENTIONS.map((retention) => ({ saved, retention })),
)) {
	test(`implementation applies defaults without run-end restoration (saved=${saved}, ${retention})`, async () => {
		const fixture = await readyFixture({
			thinkingLevel: "medium",
			...PREFERENCES,
			implementationPlanRetention: retention,
		});
		try {
			if (saved) await fixture.command("save");
			await fixture.command("implement");
			assert.deepEqual(fixture.ctx.model, WORKER);
			assert.equal(fixture.mock.thinkingLevel, "high");
			assert.equal(fixture.mock.sentUserMessages.length, 1);
			await fixture.emit("agent_end", {
				messages: [{ role: "assistant", content: [], stopReason: "aborted" }],
			});
			await fixture.emit("agent_settled");
			assert.deepEqual(fixture.ctx.model, WORKER);
			assert.equal(fixture.mock.thinkingLevel, "high");
			fixture.manualModel(PLANNER);
			fixture.mock.rawPi.setThinkingLevel("minimal");
			await fixture.command("exit");
			assert.deepEqual(fixture.ctx.model, PLANNER);
			assert.equal(fixture.mock.thinkingLevel, "minimal");
		} finally {
			await fixture.dispose();
		}
	});
}

test("inherit preserves existing Plan thinking restoration without model selection", async () => {
	const fixture = await readyFixture({
		thinkingLevel: "medium",
		implementationThinkingLevel: "inherit",
	});
	try {
		await fixture.command("implement");
		assert.equal(fixture.mock.thinkingLevel, "low");
		assert.deepEqual(fixture.mock.setModels, []);
	} finally {
		await fixture.dispose();
	}
});

test("manual thinking changed by a later model-selection listener is preserved without kickoff", async () => {
	const fixture = await readyFixture();
	try {
		fixture.mock.rawPi.on("model_select", () => {
			fixture.mock.rawPi.setThinkingLevel("max");
		});
		await fixture.command("implement");
		assert.equal(fixture.mock.sentUserMessages.length, 0);
		assert.equal(fixture.mock.thinkingLevel, "max");
		assert.equal(fixture.context.statuses.get("plan-mode"), "plan ready");
	} finally {
		await fixture.dispose();
	}
});

test("session shutdown waits for pending model selection and rolls back before replacement", async () => {
	const fixture = await readyFixture();
	let releaseSelection!: () => void;
	let selectionStarted!: () => void;
	const started = new Promise<void>((resolve) => {
		selectionStarted = resolve;
	});
	fixture.mock.rawPi.on("model_select", async (event) => {
		if ((event as { model?: { id?: string } }).model?.id !== "worker") return;
		selectionStarted();
		await new Promise<void>((resolve) => {
			releaseSelection = resolve;
		});
	});
	try {
		const pending = fixture.command("implement");
		await started;
		let shutdownSettled = false;
		const shutdown = fixture.emit("session_shutdown").then(() => {
			shutdownSettled = true;
		});
		await Promise.resolve();
		assert.equal(shutdownSettled, false);
		releaseSelection();
		await Promise.all([pending, shutdown]);
		assert.equal(fixture.mock.sentUserMessages.length, 0);
		assert.deepEqual(fixture.mock.setModels, [WORKER, PLANNER]);
		assert.deepEqual(fixture.ctx.model, PLANNER);
		assert.equal(fixture.mock.thinkingLevel, "low");
	} finally {
		await fixture.dispose();
	}
});

for (const failure of ["missing-model", "removed-model", "auth", "selection", "kickoff"] as const) {
	test(`implementation ${failure} failure retains the ready plan and previous runtime`, async () => {
		const fixture = await readyFixture(
			failure === "missing-model"
				? { thinkingLevel: "medium", implementationModel: { provider: "missing", id: "model" } }
				: undefined,
		);
		try {
			if (failure === "auth")
				fixture.ctx.modelRegistry.getApiKeyAndHeaders = async () => ({
					ok: false,
					error: "No auth",
				});
			if (failure === "removed-model")
				fixture.ctx.modelRegistry.getApiKeyAndHeaders = async () => {
					fixture.ctx.modelRegistry.find = () => undefined;
					return { ok: true, apiKey: "test" };
				};
			if (failure === "selection") fixture.mock.rawPi.setModel = async () => false;
			if (failure === "kickoff")
				fixture.mock.rawPi.sendUserMessage = () => {
					throw new Error("kickoff failed");
				};
			await fixture.command("implement");
			assert.equal(fixture.mock.sentUserMessages.length, 0);
			assert.equal(fixture.context.statuses.get("plan-mode"), "plan ready");
			assert.deepEqual(fixture.ctx.model, PLANNER);
			assert.equal(fixture.mock.thinkingLevel, "medium");
			assert.ok(fixture.context.notifications.some(({ level }) => level === "error"));
		} finally {
			await fixture.dispose();
		}
	});
}

for (const interruption of [
	"shutdown",
	"exit",
	"manual-model",
	"manual-thinking",
	"busy",
] as const) {
	test(`pending preference preflight stops on ${interruption}`, async () => {
		const fixture = await readyFixture();
		let release!: (value: { ok: true }) => void;
		let ready!: () => void;
		const started = new Promise<void>((resolve) => {
			ready = resolve;
		});
		fixture.ctx.modelRegistry.getApiKeyAndHeaders = () =>
			new Promise((resolve) => {
				release = resolve;
				ready();
			});
		try {
			const pending = fixture.command("implement");
			await started;
			const shutdown = interruption === "shutdown" ? fixture.emit("session_shutdown") : undefined;
			if (shutdown) await shutdown;
			if (interruption === "exit") await fixture.command("exit");
			if (interruption === "manual-model") fixture.manualModel(WORKER);
			if (interruption === "manual-thinking") fixture.mock.rawPi.setThinkingLevel("max");
			if (interruption === "busy") fixture.ctx.isIdle = () => false;
			release({ ok: true });
			await Promise.all([pending, shutdown]);
			assert.equal(fixture.mock.sentUserMessages.length, 0);
			assert.equal(fixture.mock.setModels.length, 0);
		} finally {
			await fixture.dispose();
		}
	});
}
