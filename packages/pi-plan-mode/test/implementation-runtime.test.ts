import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import type { SessionManager } from "@earendil-works/pi-coding-agent";
import { test } from "vitest";
import {
	applyFreshImplementationPreferences,
	FRESH_PREFERENCES_ENTRY,
	freshPreferencesApplied,
} from "../src/fresh-implementation-preferences.js";
import { implementationRuntime } from "./implementation-runtime-support.js";

test("runtime setup failure restores the agent directory and removes its fixture", async () => {
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = "previous-agent-directory";
	let isolatedRoot: string | undefined;
	try {
		await assert.rejects(
			implementationRuntime(undefined, () => {
				isolatedRoot = process.env.PI_CODING_AGENT_DIR;
				throw new Error("injected bind setup failure");
			}),
			/injected bind setup failure/,
		);
		assert.equal(process.env.PI_CODING_AGENT_DIR, "previous-agent-directory");
		assert.ok(isolatedRoot);
		assert.equal(existsSync(isolatedRoot), false);
	} finally {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
	}
});

test("Pi model selection is session-only and applies per-model defaults and capability clamping", async () => {
	const fixture = await implementationRuntime();
	try {
		const worker = fixture.ctx.modelRegistry.find("plan-test", "worker");
		assert.ok(worker);
		// Composed provider definitions are equivalent by identity, not reference.
		const repeated = fixture.ctx.modelRegistry.find("plan-test", "worker");
		assert.notEqual(repeated, worker);
		assert.equal(repeated?.provider, worker.provider);
		assert.equal(repeated?.id, worker.id);
		assert.equal(await fixture.pi.setModel(worker), true);
		assert.equal(fixture.ctx.model?.id, "worker");
		assert.equal(fixture.pi.getThinkingLevel(), "medium");
		fixture.pi.setThinkingLevel("low");
		assert.equal(fixture.pi.getThinkingLevel(), "medium");
		fixture.pi.setThinkingLevel("max");
		assert.equal(fixture.pi.getThinkingLevel(), "max");
		fixture.pi.setThinkingLevel("xhigh");
		assert.equal(fixture.pi.getThinkingLevel(), "max");
		const plain = fixture.ctx.modelRegistry.find("plan-test", "plain");
		assert.ok(plain);
		await fixture.pi.setModel(plain);
		fixture.pi.setThinkingLevel("high");
		assert.equal(fixture.pi.getThinkingLevel(), "off");
		assert.equal(await fixture.pi.setModel({ ...worker, provider: "missing-auth" }), false);
		assert.equal(fixture.ctx.model?.id, "plain");
		assert.equal(fixture.settings.getDefaultModel(), "planner");
		assert.equal(fixture.settings.getDefaultThinkingLevel(), "low");
		assert.ok(fixture.events.includes("model"));
		assert.ok(fixture.events.includes("thinking"));
	} finally {
		await fixture.dispose();
	}
});

test("fresh preference application rolls back before a concurrent replacement", async () => {
	let releaseSelection!: () => void;
	let selectionStarted!: () => void;
	const started = new Promise<void>((resolve) => {
		selectionStarted = resolve;
	});
	const fixture = await implementationRuntime(async (pi) => {
		const planModeUrl = new URL("../src/plan-mode.js", import.meta.url);
		const { default: planMode } = (await import(
			`${planModeUrl.href}?test=${randomUUID()}`
		)) as typeof import("../src/plan-mode.js");
		planMode(pi, {
			readSettings: async () => ({
				kind: "loaded" as const,
				settings: { thinkingLevel: "inherit" },
			}),
		});
		pi.on("model_select", async (event) => {
			if (event.model.id !== "worker") return;
			selectionStarted();
			await new Promise<void>((resolve) => {
				releaseSelection = resolve;
			});
		});
	});
	try {
		let preferenceSession: SessionManager | undefined;
		const firstReplacement = fixture.runtime.newSession({
			setup: async (sessionManager) => {
				preferenceSession = sessionManager;
				sessionManager.appendCustomEntry(FRESH_PREFERENCES_ENTRY, {
					id: "replace-pending",
					status: "pending",
					preferences: {
						implementationModel: { provider: "plan-test", id: "worker" },
						implementationThinkingLevel: "high",
					},
				});
			},
		});
		await started;
		let replacementSettled = false;
		const secondReplacement = fixture.runtime.newSession().then((result) => {
			replacementSettled = true;
			return result;
		});
		await Promise.resolve();
		assert.equal(replacementSettled, false);
		releaseSelection();
		await Promise.all([firstReplacement, secondReplacement]);
		assert.ok(preferenceSession);
		assert.deepEqual(preferenceSession.buildSessionContext().model, {
			provider: "plan-test",
			modelId: "planner",
		});
		assert.equal(preferenceSession.buildSessionContext().thinkingLevel, "low");
		assert.deepEqual(
			preferenceSession
				.getBranch()
				.filter((entry) => entry.type === "model_change")
				.map((entry) => entry.modelId)
				.slice(-2),
			["worker", "planner"],
		);
	} finally {
		await fixture.dispose();
	}
});

test("fresh setup precedes destination start, which applies preferences without using stale source APIs", async () => {
	const fixture = await implementationRuntime((pi) => {
		pi.on("session_start", async (event, ctx) => {
			if (event.reason === "new") await applyFreshImplementationPreferences(pi, ctx, () => true);
		});
	});
	try {
		const sourcePi = fixture.pi;
		let acknowledged = false;
		await fixture.runtime.newSession({
			setup: async (sm) => {
				fixture.events.push("setup");
				sm.appendCustomEntry(FRESH_PREFERENCES_ENTRY, {
					id: "handoff",
					status: "pending",
					preferences: {
						implementationModel: { provider: "plan-test", id: "worker" },
						implementationThinkingLevel: "high",
					},
				});
			},
			withSession: async (ctx) => {
				fixture.events.push("kickoff");
				acknowledged = freshPreferencesApplied(ctx, "handoff");
				assert.equal(ctx.model?.id, "worker");
				assert.equal(ctx.thinkingLevel, "high");
			},
		});
		assert.equal(acknowledged, true);
		assert.ok(fixture.events.indexOf("shutdown") < fixture.events.indexOf("setup"));
		assert.ok(fixture.events.indexOf("setup") < fixture.events.lastIndexOf("start"));
		assert.ok(fixture.events.lastIndexOf("start") < fixture.events.indexOf("kickoff"));
		assert.throws(() => sourcePi.getThinkingLevel(), /stale/);
		assert.equal(fixture.settings.getDefaultModel(), "planner");
		const currentPi = fixture.pi;
		fixture.cancelReplacement();
		assert.deepEqual(await fixture.runtime.newSession(), { cancelled: true });
		assert.equal(fixture.pi, currentPi);
		assert.equal(fixture.ctx.model?.id, "worker");
	} finally {
		await fixture.dispose();
	}
});
