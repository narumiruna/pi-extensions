import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type KeyId, matchesKey, visibleWidth } from "@earendil-works/pi-tui";
import { createRpcHarness, createTuiHarness } from "@narumitw/pi-tui-kit/testing";
import { test } from "vitest";
import { createImplementationModelPicker } from "../src/implementation-options.js";
import { showReadyPlanMenu } from "../src/plan-action-menus.js";
import type { ImplementationPreferences } from "../src/settings.js";
import { showPlanModeSettings } from "../src/settings-menu.js";
import { createMockContext } from "./support.js";

const MODEL = { provider: "cheap", id: "org/worker" };
function readyOptions(onImplement: (preferences?: ImplementationPreferences) => void) {
	return {
		signal: new AbortController().signal,
		isCurrent: () => true,
		implementationOutcome: () => "Plan reinjection: Off",
		getExportDestination: () => ({ configuredPath: "PLAN.md", resolvedPath: "/tmp/PLAN.md" }),
		implementHere: onImplement,
		implementFresh: (_signal: AbortSignal, preferences?: ImplementationPreferences) =>
			onImplement(preferences),
		exportPlan: async () => false,
		save: () => {},
		stay: () => {},
		exit: () => {},
	};
}

for (const destination of ["Implement here", "Start fresh and implement"]) {
	test(`RPC options stage model/thinking for ${destination} without saving defaults`, async () => {
		const rpc = createRpcHarness([
			{ kind: "select", response: "Implementation options…" },
			{ kind: "select", response: "Implementation model (Use current)" },
			{ kind: "select", response: "cheap / org/worker" },
			{ kind: "select", response: "Implementation thinking (inherit)" },
			{ kind: "select", response: "Back" },
			{ kind: "select", response: destination },
		]);
		const context = createMockContext({
			mode: "rpc",
			hasUI: true,
			...rpc.ui,
			modelRegistry: { getAvailable: () => [MODEL] },
		});
		const calls: ImplementationPreferences[] = [];
		await showReadyPlanMenu(
			context.ctx,
			readyOptions((preferences) => {
				if (preferences) calls.push(preferences);
			}),
		);
		rpc.assertConsumed();
		assert.deepEqual(calls, [{ implementationModel: MODEL, implementationThinkingLevel: "off" }]);
		assert.match(rpc.dialogs.at(-1)?.title ?? "", /Model: cheap \/ org\/worker.*Thinking: off/);
	});
}

test("TUI options are staged, sanitized, width bounded, and discarded on hard cancellation", async () => {
	const tui = createTuiHarness({ width: 64, rows: 30 });
	const hostile = { provider: "provider\u001b[31m", id: "model\n\u0007" };
	const context = createMockContext({
		mode: "tui",
		hasUI: true,
		custom: tui.custom,
		modelRegistry: { getAvailable: () => [hostile] },
	});
	const calls: unknown[] = [];
	try {
		const running = showReadyPlanMenu(
			context.ctx,
			readyOptions((value) => {
				calls.push(value);
			}),
		);
		await tui.waitForOpen();
		tui.press("tui.select.down");
		tui.press("tui.select.down");
		tui.press("tui.select.confirm");
		await tui.waitForPending();
		await tui.waitForOpen();
		assert.match(tui.render().join("\n"), /Implementation options/);
		tui.press("tui.select.confirm");
		await tui.waitForPending();
		await tui.waitForOpen();
		assert.ok(tui.render(24).every((line) => visibleWidth(line) <= 24));
		assert.equal(tui.render().join("\n").includes("\u0007"), false);
		assert.equal(tui.render().join("\n").includes("\u001b[31m"), false);
		tui.press("tui.select.down");
		tui.press("tui.select.confirm");
		await tui.waitForPending();
		await tui.waitForOpen();
		assert.match(tui.render(64).join("\n"), /provider/);
		tui.press("ctrl+c");
		await running;
		assert.equal(calls.length, 0);
		const reopened = showReadyPlanMenu(
			context.ctx,
			readyOptions((value) => {
				calls.push(value);
			}),
		);
		await tui.waitForOpen();
		assert.match(tui.render().join("\n"), /Model: Use current/);
		tui.dispose();
		await reopened;
		assert.deepEqual(calls, []);
	} finally {
		tui.dispose();
	}
});

test("implementation actions use remapped confirmation and keep hard cancellation", async () => {
	const keys: Record<string, KeyId[]> = {
		"tui.select.confirm": ["ctrl+x"],
		"tui.select.cancel": ["alt+q"],
		"tui.select.down": ["down"],
		"tui.select.up": ["up"],
	};
	const tui = createTuiHarness({
		keybindings: {
			getKeys: (binding) => keys[binding] ?? [],
			matches: (data, binding) => (keys[binding] ?? []).some((key) => matchesKey(data, key)),
		},
	});
	const context = createMockContext({ mode: "tui", hasUI: true, custom: tui.custom });
	let calls = 0;
	try {
		const running = showReadyPlanMenu(
			context.ctx,
			readyOptions(() => {
				calls++;
			}),
		);
		await tui.waitForOpen();
		assert.match(tui.render().join("\n"), /ctrl\+x/i);
		tui.send("\u0018");
		await running;
		assert.equal(calls, 1);
		const cancelled = showReadyPlanMenu(
			context.ctx,
			readyOptions(() => {
				calls++;
			}),
		);
		await tui.waitForOpen();
		tui.press("ctrl+c");
		await cancelled;
		assert.equal(calls, 1);
	} finally {
		tui.dispose();
	}
});

test("model choices use exact opaque identities and respect scoped models", () => {
	const context = createMockContext({
		scopedModels: [{ model: MODEL }],
		modelRegistry: {
			getAvailable: () => {
				throw new Error("scope must win");
			},
		},
	});
	const picker = createImplementationModelPicker(context.ctx);
	assert.deepEqual(picker.selection("implementation-model:0"), MODEL);
	assert.equal(picker.selection("cheap/org/worker"), undefined);
	assert.equal(picker.selection("implementation-current"), null);
});

test("RPC Settings persists implementation defaults without touching the current runtime", async () => {
	const root = await mkdtemp(join(tmpdir(), "plan-options-settings-"));
	const settingsPath = join(root, "settings.json");
	const rpc = createRpcHarness([
		{ kind: "select", response: "Implementation model (Use current)" },
		{ kind: "select", response: "cheap / org/worker" },
		{ kind: "select", response: "Implementation thinking (inherit)" },
		{ kind: "select", response: "Back" },
	]);
	const context = createMockContext({
		mode: "rpc",
		hasUI: true,
		...rpc.ui,
		model: { provider: "expensive", id: "planner" },
		modelRegistry: { getAvailable: () => [MODEL] },
	});
	try {
		await showPlanModeSettings(context.ctx, {
			settingsPath,
			tools: [],
			signal: new AbortController().signal,
			isCurrent: () => true,
			onSaved: () => {},
		});
		rpc.assertConsumed();
		assert.deepEqual(JSON.parse(await readFile(settingsPath, "utf8")), {
			implementationModel: MODEL,
			implementationThinkingLevel: "off",
		});
		assert.deepEqual((context.ctx as { model: unknown }).model, {
			provider: "expensive",
			id: "planner",
		});
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
