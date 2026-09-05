import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { createTuiHarness } from "@narumitw/pi-tui-kit/testing";
import { test } from "vitest";
import { createMockContext } from "../../../test/support.js";
import {
	loadConfig,
	localConfigPath,
	syncConfigReviewFingerprint,
	syncConfigReviewIdentity,
	updateLocalConfig,
} from "../src/config.js";
import { dispatchManagerResult } from "../src/manager-result-dispatcher.js";
import { showSyncManager } from "../src/manager-ui.js";
import type { SyncDecision } from "../src/sync-decision.js";
import { showSyncResolution } from "../src/sync-resolution-ui.js";
import { v3S3Settings, withTempHome } from "./helpers.js";

initTheme("dark", false);

for (const direction of ["push", "pull"] as const) {
	test(`manager preserves an explicit ${direction} direction through conflict resolution`, async () => {
		await withConfiguredDecision(async (decision) => {
			const choices = [
				"More…",
				direction === "push" ? "Push to remote…" : "Pull from remote…",
				direction === "push"
					? "Keep local content and replace remote…"
					: "Use remote content and replace local…",
			];
			const routes: string[] = [];
			const { ctx } = createMockContext({
				hasUI: true,
				mode: "rpc",
				select: async () => choices.shift(),
			});
			await showSyncManager(ctx, async (route) => {
				routes.push(route);
				if (route === direction) return { kind: "decision-required", decision };
				return { kind: "completed", outcome: "applied" };
			});
			assert.deepEqual(routes, [direction, `${direction} --force`]);
		});
	});
}

test("resolution reviews exact differences and invokes local-wins push through the captured setup", async () => {
	await withConfiguredDecision(async (decision) => {
		const tui = createTuiHarness({ width: 60, rows: 18 });
		const { ctx } = createMockContext({ hasUI: true, mode: "tui", custom: tui.custom });
		const routes: Array<{ route: string; target?: string; signal?: AbortSignal }> = [];
		let releaseRoute: () => void = () => undefined;
		const routeGate = new Promise<void>((resolve) => {
			releaseRoute = resolve;
		});
		const running = showSyncResolution(ctx, decision, async (route, signal, _onCommit, target) => {
			routes.push({ route, target, signal });
			await routeGate;
			return { kind: "completed" };
		});

		await tui.waitForOpen();
		for (const width of [32, 60, 100]) {
			const frame = tui.render(width);
			assert.ok(frame.every((line) => visibleWidth(line) <= width));
			assert.match(frame.join("\n"), /Resolve sync conflict/u);
			assert.equal(frame.join("\n").includes("\u001b]8"), false);
		}
		tui.press("tui.select.confirm");
		await tui.waitForOpen();
		const reviewFrame = tui.render().join("\n");
		assert.match(reviewFrame, /Different: settings\.json/u);
		assert.equal(reviewFrame.includes("\u001b]8"), false);
		tui.press("tui.select.cancel");
		await tui.waitForOpen();
		assert.match(tui.render().join("\n"), /Review differences \(recommended\)/u);
		tui.press("tui.select.down");
		tui.press("tui.select.confirm");
		await tui.waitForOpen();
		assert.match(tui.render().join("\n"), /Preparing local-wins push preview/u);
		assert.deepEqual(
			routes.map(({ route, target }) => ({ route, target })),
			[{ route: "push --force", target: "home" }],
		);
		releaseRoute();
		const result = await running;
		assert.deepEqual(result, { kind: "resolved", direction: "push" });
	});
});

test("cancelling a remote-wins preparation drains work and returns to resolution", async () => {
	await withConfiguredDecision(async (decision) => {
		const tui = createTuiHarness({ width: 60, rows: 18 });
		const { ctx, notifications } = createMockContext({
			hasUI: true,
			mode: "tui",
			custom: tui.custom,
		});
		let routeSignal: AbortSignal | undefined;
		let releaseRoute: () => void = () => undefined;
		const routeGate = new Promise<void>((resolve) => {
			releaseRoute = resolve;
		});
		const running = showSyncResolution(ctx, decision, async (_route, signal) => {
			routeSignal = signal;
			await routeGate;
			return { kind: "completed", outcome: "applied" };
		});

		await tui.waitForOpen();
		tui.press("tui.select.down");
		tui.press("tui.select.down");
		tui.press("tui.select.confirm");
		await tui.waitForOpen();
		tui.press("tui.select.cancel");
		assert.equal(routeSignal?.aborted, true);
		releaseRoute();
		await tui.waitForOpen();
		assert.match(tui.render().join("\n"), /Resolve sync conflict/u);
		assert.match(notifications.at(-1)?.message ?? "", /cancelled/u);
		tui.press("ctrl+c");
		assert.deepEqual(await running, { kind: "closed" });
	});
});

test("RPC resolution supports review and remote-empty recovery without custom TUI", async () => {
	await withConfiguredDecision(async (baseDecision) => {
		const decision: SyncDecision = {
			...baseDecision,
			kind: "remote-empty",
			directions: ["push"],
			review: "Remote is empty.\nAdd: settings.json",
		};
		let resolutionVisits = 0;
		const routes: string[] = [];
		const { ctx } = createMockContext({
			hasUI: true,
			mode: "rpc",
			custom: async () => assert.fail("RPC must not open custom TUI"),
			select: async (title: string, options: string[]) => {
				if (title.startsWith("Remote is empty")) {
					resolutionVisits += 1;
					return resolutionVisits === 1
						? "Review differences (recommended)"
						: "Push local content…";
				}
				assert.match(title, /Add: settings\.json/u);
				assert.deepEqual(options, ["Back"]);
				return "Back";
			},
		});
		const result = await showSyncResolution(ctx, decision, async (route, signal) => {
			assert.equal(signal?.aborted, false);
			routes.push(route);
			return { kind: "completed" };
		});
		assert.deepEqual(routes, ["push --force"]);
		assert.deepEqual(result, { kind: "resolved", direction: "push" });
	});
});

test("cancelling the exact push confirmation returns to conflict resolution", async () => {
	await withConfiguredDecision(async (decision) => {
		const tui = createTuiHarness({ width: 60, rows: 18 });
		const { ctx } = createMockContext({ hasUI: true, mode: "tui", custom: tui.custom });
		let releaseRoute: () => void = () => undefined;
		const routeGate = new Promise<void>((resolve) => {
			releaseRoute = resolve;
		});
		const running = showSyncResolution(ctx, decision, async () => {
			await routeGate;
			return { kind: "completed", outcome: "cancelled" };
		});

		await tui.waitForOpen();
		tui.press("tui.select.down");
		tui.press("tui.select.confirm");
		await tui.waitForOpen();
		releaseRoute();
		await tui.waitForPending();
		await tui.waitForOpen();
		assert.match(tui.render().join("\n"), /Resolve sync conflict/u);
		tui.press("ctrl+c");
		assert.deepEqual(await running, { kind: "closed" });
	});
});

test("a repeated conflict refreshes resolution labels instead of closing", async () => {
	await withConfiguredDecision(async (decision) => {
		const tui = createTuiHarness({ width: 60, rows: 18 });
		const { ctx } = createMockContext({ hasUI: true, mode: "tui", custom: tui.custom });
		const refreshed: SyncDecision = {
			...decision,
			kind: "first-sync-settings-diverged",
			directMessage: "Choose an initial source.",
		};
		let releaseRoute: () => void = () => undefined;
		const routeGate = new Promise<void>((resolve) => {
			releaseRoute = resolve;
		});
		const running = showSyncResolution(ctx, decision, async () => {
			await routeGate;
			return { kind: "decision-required", decision: refreshed };
		});

		await tui.waitForOpen();
		tui.press("tui.select.down");
		tui.press("tui.select.confirm");
		await tui.waitForOpen();
		releaseRoute();
		await tui.waitForPending();
		await tui.waitForOpen();
		assert.match(tui.render().join("\n"), /Use local as initial source/u);
		tui.press("ctrl+c");
		assert.deepEqual(await running, { kind: "closed" });
	});
});

test("resolution rejects a sync setup changed after review", async () => {
	await withConfiguredDecision(async (decision) => {
		const tui = createTuiHarness({ width: 60, rows: 18 });
		const { ctx, notifications } = createMockContext({
			hasUI: true,
			mode: "tui",
			custom: tui.custom,
		});
		let routeCalls = 0;
		const running = showSyncResolution(ctx, decision, async () => {
			routeCalls += 1;
			return { kind: "completed" };
		});

		await tui.waitForOpen();
		await updateLocalConfig((current) => ({
			...current,
			syncSetups: {
				...current.syncSetups,
				home: {
					...current.syncSetups.home,
					sync: { ...current.syncSetups.home.sync, include: [] },
				},
			},
		}));
		tui.press("tui.select.down");
		tui.press("tui.select.confirm");
		await tui.waitForOpen();
		assert.equal(routeCalls, 0);
		assert.match(
			notifications.at(-1)?.message ?? "",
			/changed while conflict resolution was open/u,
		);
		assert.match(tui.render().join("\n"), /Resolve sync conflict/u);
		tui.press("ctrl+c");
		assert.deepEqual(await running, { kind: "closed" });
	});
});

test("session replacement aborts and drains a resolution operation", async () => {
	await withConfiguredDecision(async (decision) => {
		const owner = new AbortController();
		const tui = createTuiHarness({ width: 60, rows: 18 });
		const { ctx } = createMockContext({ hasUI: true, mode: "tui", custom: tui.custom });
		let routeSignal: AbortSignal | undefined;
		let releaseRoute: () => void = () => undefined;
		const routeGate = new Promise<void>((resolve) => {
			releaseRoute = resolve;
		});
		const running = showSyncResolution(
			ctx,
			decision,
			async (_route, signal) => {
				routeSignal = signal;
				await routeGate;
				return { kind: "completed" };
			},
			owner.signal,
		);

		await tui.waitForOpen();
		tui.press("tui.select.down");
		tui.press("tui.select.confirm");
		await tui.waitForOpen();
		owner.abort(new DOMException("Session replaced", "AbortError"));
		assert.equal(routeSignal?.aborted, true);
		releaseRoute();
		assert.deepEqual(await running, { kind: "stale" });
	});
});

test("repeated remote-selection decisions refresh through bounded manager dispatch", async () => {
	await withConfiguredDecision(async (_decision, selectionConfigIdentity) => {
		const tui = createTuiHarness({ width: 60, rows: 18 });
		const { ctx } = createMockContext({ hasUI: true, mode: "tui", custom: tui.custom });
		let routeCalls = 0;
		let releaseRoute: () => void = () => undefined;
		const routeGate = new Promise<void>((resolve) => {
			releaseRoute = resolve;
		});
		const running = dispatchManagerResult(
			ctx,
			{
				kind: "remote-selection-required",
				decision: {
					setupName: "home",
					configIdentity: selectionConfigIdentity,
					localInclude: ["settings.json"],
					remoteInclude: ["settings.json", "pi-starship.toml"],
				},
			},
			"sync",
			async (route, _signal, _onCommit, target) => {
				routeCalls += 1;
				assert.equal(route, "push --force");
				assert.equal(target, "home");
				await routeGate;
				return {
					kind: "remote-selection-required",
					decision: {
						setupName: "home",
						configIdentity: selectionConfigIdentity,
						localInclude: ["settings.json"],
						remoteInclude: ["settings.json", "models.json"],
					},
				};
			},
		);

		await tui.waitForOpen();
		tui.press("tui.select.down");
		tui.press("tui.select.down");
		tui.press("tui.select.confirm");
		await tui.waitForOpen();
		assert.equal(routeCalls, 1);
		releaseRoute();
		await tui.waitForPending();
		await tui.waitForOpen();
		assert.match(tui.render().join("\n"), /Synced content differs/u);
		tui.press("tui.select.confirm");
		await tui.waitForOpen();
		assert.match(tui.render().join("\n"), /models\.json/u);
		tui.press("tui.select.cancel");
		await tui.waitForOpen();
		tui.press("tui.select.cancel");
		assert.deepEqual(await running, { kind: "stay" });
	});
});

test("selection continuation hands a file-direction decision to existing resolution", async () => {
	await withConfiguredDecision(async (decision, selectionConfigIdentity) => {
		const tui = createTuiHarness({ width: 60, rows: 18 });
		const { ctx } = createMockContext({ hasUI: true, mode: "tui", custom: tui.custom });
		let routeCalls = 0;
		let releaseRoute: () => void = () => undefined;
		const routeGate = new Promise<void>((resolve) => {
			releaseRoute = resolve;
		});
		const running = dispatchManagerResult(
			ctx,
			{
				kind: "remote-selection-required",
				decision: {
					setupName: "home",
					configIdentity: selectionConfigIdentity,
					localInclude: ["settings.json"],
					remoteInclude: ["settings.json", "pi-starship.toml"],
				},
			},
			"pull",
			async () => {
				routeCalls += 1;
				await routeGate;
				return { kind: "decision-required", decision };
			},
		);

		await tui.waitForOpen();
		tui.press("tui.select.down");
		tui.press("tui.select.down");
		tui.press("tui.select.confirm");
		await tui.waitForOpen();
		assert.equal(routeCalls, 1);
		releaseRoute();
		await tui.waitForPending();
		await tui.waitForOpen();
		assert.match(tui.render().join("\n"), /Resolve sync conflict/u);
		tui.press("tui.select.cancel");
		assert.deepEqual(await running, { kind: "stay" });
	});
});

test("ordinary selection continuation failure is reported only by its route", async () => {
	await withConfiguredDecision(async (_decision, selectionConfigIdentity) => {
		const tui = createTuiHarness({ width: 60, rows: 18 });
		const { ctx, notifications } = createMockContext({
			hasUI: true,
			mode: "tui",
			custom: tui.custom,
		});
		let releaseRoute: () => void = () => undefined;
		const routeGate = new Promise<void>((resolve) => {
			releaseRoute = resolve;
		});
		const running = dispatchManagerResult(
			ctx,
			{
				kind: "remote-selection-required",
				decision: {
					setupName: "home",
					configIdentity: selectionConfigIdentity,
					localInclude: ["settings.json"],
					remoteInclude: ["settings.json", "pi-starship.toml"],
				},
			},
			"push",
			async () => {
				notifications.push({ message: "transport failed", level: "error" });
				await routeGate;
				return { kind: "failed" };
			},
		);

		await tui.waitForOpen();
		tui.press("tui.select.down");
		tui.press("tui.select.down");
		tui.press("tui.select.confirm");
		await tui.waitForOpen();
		assert.equal(notifications.length, 1);
		releaseRoute();
		await tui.waitForPending();
		await tui.waitForOpen();
		assert.match(tui.render().join("\n"), /Synced content differs/u);
		assert.deepEqual(
			notifications.map((item) => item.message),
			["transport failed"],
		);
		tui.press("tui.select.cancel");
		assert.deepEqual(await running, { kind: "stay" });
	});
});

test("the main manager opens inline remote-selection recovery", async () => {
	await withConfiguredDecision(async (_decision, selectionConfigIdentity) => {
		const tui = createTuiHarness({ width: 60, rows: 18 });
		const { ctx } = createMockContext({ hasUI: true, mode: "tui", custom: tui.custom });
		let releaseRoute: () => void = () => undefined;
		const routeGate = new Promise<void>((resolve) => {
			releaseRoute = resolve;
		});
		const running = showSyncManager(ctx, async (route) => {
			assert.equal(route, "sync");
			await routeGate;
			return {
				kind: "remote-selection-required",
				decision: {
					setupName: "home",
					configIdentity: selectionConfigIdentity,
					localInclude: ["settings.json"],
					remoteInclude: ["settings.json", "pi-starship.toml"],
				},
			} as never;
		});

		await tui.waitForOpen();
		tui.press("tui.select.confirm");
		await tui.waitForOpen();
		releaseRoute();
		await tui.waitForPending();
		await tui.waitForOpen();
		assert.match(tui.render().join("\n"), /Synced content differs/u);
		tui.press("tui.select.cancel");
		await tui.waitForOpen();
		assert.match(tui.render().join("\n"), /Manage sync/u);
		tui.press("ctrl+c");
		await running;
	});
});

test("pending selection attention is the manager's first action and blocks Sync now", async () => {
	await withConfiguredDecision(async (_decision, selectionConfigIdentity) => {
		const attention = {
			decision: {
				setupName: "home",
				configIdentity: selectionConfigIdentity,
				localInclude: ["settings.json"],
				remoteInclude: ["settings.json", "pi-starship.toml"],
			},
			origin: "sync" as const,
			offered: true,
		};
		const tui = createTuiHarness({ width: 60, rows: 24 });
		const { ctx } = createMockContext({ hasUI: true, mode: "tui", custom: tui.custom });
		const running = showSyncManager(ctx, async () => ({ kind: "failed" }), undefined, {
			getAttention: () => attention,
		});

		await tui.waitForOpen();
		for (const width of [32, 60, 100]) {
			assert.ok(tui.render(width).every((line) => visibleWidth(line) <= width));
		}
		const frame = tui.render().join("\n");
		assert.match(frame, /Sync status: Review needed/u);
		assert.match(frame, /Review synced content \(recommended\)/u);
		tui.press("tui.select.down");
		assert.match(tui.render().join("\n"), /\[-\] Sync now/u);
		assert.match(tui.render().join("\n"), /Review first/u);
		tui.press("tui.select.up");
		tui.press("tui.select.confirm");
		await tui.waitForOpen();
		assert.match(tui.render().join("\n"), /Synced content differs/u);
		tui.press("tui.select.cancel");
		await tui.waitForOpen();
		assert.match(tui.render().join("\n"), /Manage sync/u);
		tui.press("ctrl+c");
		await running;
	});
});

test("attention for a non-current setup stays reviewable without blocking current Sync now", async () => {
	await withConfiguredDecision(async () => {
		await updateLocalConfig((settings) => ({
			...settings,
			syncSetups: {
				...settings.syncSetups,
				work: {
					storage: { connection: "r2", bucket: "pi-sync-test", path: "pi-sync/work" },
					sync: { include: ["settings.json"], automatic: false },
				},
			},
		}));
		const work = await loadConfig("work");
		const attention = {
			decision: {
				setupName: "work",
				configIdentity: syncConfigReviewFingerprint(work),
				localInclude: ["settings.json"],
				remoteInclude: ["settings.json", "models.json"],
			},
			origin: "pull" as const,
			offered: true,
		};
		const tui = createTuiHarness({ width: 80, rows: 24 });
		const { ctx } = createMockContext({ hasUI: true, mode: "tui", custom: tui.custom });
		let routeCalls = 0;
		let releaseRoute: () => void = () => undefined;
		const routeGate = new Promise<void>((resolve) => {
			releaseRoute = resolve;
		});
		const running = showSyncManager(
			ctx,
			async () => {
				routeCalls += 1;
				await routeGate;
				return { kind: "failed" };
			},
			undefined,
			{
				getAttention: () => attention,
			},
		);

		await tui.waitForOpen();
		const frame = tui.render().join("\n");
		assert.match(frame, /Current sync setup: home/u);
		assert.match(frame, /Review needed for setup work/u);
		assert.match(frame, /Review synced content \(recommended\)/u);
		assert.match(frame, /Sync now \(recommended\)/u);
		assert.doesNotMatch(frame, /\[-\] Sync now/u);
		tui.press("tui.select.down");
		tui.press("tui.select.confirm");
		await tui.waitForOpen();
		assert.equal(routeCalls, 1);
		releaseRoute();
		await tui.waitForPending();
		await tui.waitForOpen();
		tui.press("ctrl+c");
		await running;
	});
});

test("the main manager opens conflict recovery instead of ending at an error", async () => {
	await withConfiguredDecision(async (decision) => {
		const tui = createTuiHarness({ width: 60, rows: 18 });
		const { ctx } = createMockContext({ hasUI: true, mode: "tui", custom: tui.custom });
		let releaseRoute: () => void = () => undefined;
		const routeGate = new Promise<void>((resolve) => {
			releaseRoute = resolve;
		});
		const running = showSyncManager(ctx, async (route) => {
			assert.equal(route, "sync");
			await routeGate;
			return { kind: "decision-required", decision };
		});

		await tui.waitForOpen();
		tui.press("tui.select.confirm");
		await tui.waitForOpen();
		releaseRoute();
		await tui.waitForPending();
		await tui.waitForOpen();
		assert.match(tui.render().join("\n"), /Resolve sync conflict/u);
		tui.press("tui.select.cancel");
		await tui.waitForOpen();
		assert.match(tui.render().join("\n"), /Manage sync/u);
		tui.press("ctrl+c");
		await running;
	});
});

async function withConfiguredDecision(
	run: (decision: SyncDecision, selectionConfigIdentity: string) => Promise<void>,
) {
	await withTempHome(async (agentDir) => {
		mkdirSync(agentDir, { recursive: true });
		writeFileSync(localConfigPath(), JSON.stringify(v3S3Settings()), { mode: 0o600 });
		const config = await loadConfig();
		await run(
			{
				kind: "both-changed",
				setupName: "home",
				configIdentity: syncConfigReviewIdentity(config),
				causes: { localChanged: true, remoteChanged: true, policyChanged: false },
				currentInclude: ["settings.json"],
				review: "Sync setup: home\n\nObserved differences:\nDifferent: settings.json\u001b]8;;bad",
				directions: ["push", "pull"],
				directMessage: "Both local and remote changed.",
			},
			syncConfigReviewFingerprint(config),
		);
	});
}
