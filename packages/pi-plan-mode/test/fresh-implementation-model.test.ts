import assert from "node:assert/strict";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { test } from "vitest";
import { startFreshImplementationSession } from "../src/fresh-implementation.js";
import {
	applyFreshImplementationPreferences,
	FRESH_PREFERENCES_ENTRY,
} from "../src/fresh-implementation-preferences.js";
import { IMPLEMENTATION_PLAN_RETENTIONS } from "../src/settings.js";
import { implementationRuntime } from "./implementation-runtime-support.js";

for (const retention of IMPLEMENTATION_PLAN_RETENTIONS) {
	test(`fresh handoff selects the destination model before kickoff (${retention})`, async () => {
		const fixture = await implementationRuntime((pi) => {
			pi.on("session_start", async (event, ctx) => {
				if (event.reason === "new") await applyFreshImplementationPreferences(pi, ctx, () => true);
			});
		});
		try {
			const source = fixture.runtime.session.createReplacedSessionContext();
			const sourceManager = source.sessionManager;
			const sourceEntries = sourceManager.getBranch();
			const kickoffs: Array<{ model?: string; thinking?: string; prompt: string }> = [];
			const ctx = new Proxy(source, {
				get(target, key) {
					if (key === "newSession")
						return (options: Parameters<ExtensionCommandContext["newSession"]>[0]) =>
							fixture.runtime.newSession({
								...options,
								withSession: async (replacement) => {
									const destination = new Proxy(replacement, {
										get(target, key) {
											if (key === "sendUserMessage")
												return async (prompt: string) => {
													kickoffs.push({
														model: target.model?.id,
														thinking: target.thinkingLevel,
														prompt,
													});
												};
											return Reflect.get(target, key);
										},
									});
									await options?.withSession?.(destination);
								},
							});
					return Reflect.get(target, key);
				},
			});
			const result = await startFreshImplementationSession(ctx, {
				plan: "# Approved plan",
				source: "plan_mode_complete",
				stateEntryType: "plan-mode-state",
				retention,
				isCurrent: () => true,
				preferences: {
					implementationModel: { provider: "plan-test", id: "worker" },
					implementationThinkingLevel: "max",
				},
			});
			assert.deepEqual(result, { kind: "started" });
			assert.equal(kickoffs.length, 1);
			assert.equal(kickoffs[0]?.model, "worker");
			assert.equal(kickoffs[0]?.thinking, "max");
			assert.match(kickoffs[0]?.prompt ?? "", /# Approved plan/);
			assert.deepEqual(sourceManager.getBranch(), sourceEntries);
			fixture.pi.setThinkingLevel("high");
			await fixture.runtime.session.extensionRunner.emit({
				type: "session_start",
				reason: "reload",
			});
			assert.equal(fixture.pi.getThinkingLevel(), "high");
			assert.equal(fixture.settings.getDefaultModel(), "planner");
		} finally {
			await fixture.dispose();
		}
	});
}

for (const failure of ["cancelled", "missing-target", "missing-ack", "kickoff"] as const) {
	test(`fresh preference ${failure} preserves source and does not silently start on a fallback`, async () => {
		const fixture = await implementationRuntime((pi) => {
			pi.on("session_start", async (event, ctx) => {
				if (event.reason === "new" && failure !== "missing-ack")
					await applyFreshImplementationPreferences(pi, ctx, () => true);
			});
		});
		try {
			const source = fixture.runtime.session.createReplacedSessionContext();
			const sourceManager = source.sessionManager;
			const before = sourceManager.getBranch();
			let sends = 0;
			let recovered = "";
			if (failure === "cancelled") fixture.cancelReplacement();
			const ctx = new Proxy(source, {
				get(target, key) {
					if (key === "newSession")
						return (options: Parameters<ExtensionCommandContext["newSession"]>[0]) =>
							fixture.runtime.newSession({
								...options,
								withSession: async (replacement) => {
									const destination = new Proxy(replacement, {
										get(target, key) {
											if (key === "sendUserMessage")
												return async () => {
													sends++;
													throw new Error("delivery failed");
												};
											if (key === "ui")
												return {
													...target.ui,
													setEditorText: (text: string) => {
														recovered = text;
													},
												};
											return Reflect.get(target, key);
										},
									});
									await options?.withSession?.(destination);
								},
							});
					return Reflect.get(target, key);
				},
			});
			const result = await startFreshImplementationSession(ctx, {
				plan: "# Approved plan",
				source: "plan_mode_complete",
				stateEntryType: "plan-mode-state",
				retention: "clear-on-start",
				isCurrent: () => true,
				preferences: {
					implementationModel: {
						provider: "plan-test",
						id: failure === "missing-target" ? "missing" : "worker",
					},
				},
			});
			assert.equal(
				result.kind,
				failure === "cancelled"
					? "cancelled"
					: failure === "missing-target"
						? "rejected"
						: "partial",
			);
			assert.equal(sends, failure === "kickoff" ? 1 : 0);
			assert.deepEqual(sourceManager.getBranch(), before);
			if (result.kind === "partial") assert.match(recovered, /# Approved plan/);
			else assert.equal(fixture.ctx.model?.id, "planner");
		} finally {
			await fixture.dispose();
		}
	});
}

test("fresh destination consumes failed preference requests without replay", async () => {
	const fixture = await implementationRuntime();
	try {
		fixture.pi.appendEntry(FRESH_PREFERENCES_ENTRY, {
			id: "bad",
			status: "pending",
			preferences: { implementationModel: { provider: "plan-test", id: "missing" } },
		});
		await applyFreshImplementationPreferences(fixture.pi, fixture.ctx, () => true);
		const before = fixture.runtime.session.sessionManager.getBranch();
		await applyFreshImplementationPreferences(fixture.pi, fixture.ctx, () => true);
		assert.deepEqual(fixture.runtime.session.sessionManager.getBranch(), before);
		assert.equal(fixture.ctx.model?.id, "planner");
	} finally {
		await fixture.dispose();
	}
});
