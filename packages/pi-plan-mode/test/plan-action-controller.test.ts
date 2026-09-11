import assert from "node:assert/strict";
import { test } from "vitest";
import { createMockContext } from "../../../test/support.js";
import { createPlanActionController } from "../src/plan-action-controller.js";

test("stale Plan actions do not load interactive UI", async () => {
	let interactiveLoads = 0;
	const controller = createPlanActionController({
		loadInteractiveUi: async () => {
			interactiveLoads += 1;
			return {} as never;
		},
		getState: () => ({ enabled: false, awaitingAction: false }),
		captureLifecycle: () => ({
			signal: new AbortController().signal,
			isCurrent: () => false,
		}),
		statusText: () => "off",
		getThinkingLevel: () => "medium",
		implementationOutcome: () => "",
		getExportDestination: () => ({ configuredPath: "plan.md", resolvedPath: "/tmp/plan.md" }),
		show: () => undefined,
		finalize: () => undefined,
		implementHere: () => undefined,
		implementFresh: () => undefined,
		exportPlan: async () => false,
		settings: async () => false,
		save: () => undefined,
		stay: () => undefined,
		exitReady: () => undefined,
		clearSaved: () => undefined,
	});
	const context = createMockContext({ hasUI: true });

	await controller.showSaved(context.ctx);
	await controller.showCurrent(context.ctx);
	await controller.showReady(context.ctx);

	assert.equal(interactiveLoads, 0);
});
