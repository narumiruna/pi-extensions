import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { initTheme, type KeybindingsManager } from "@earendil-works/pi-coding-agent";
import { createTuiHarness } from "@narumitw/pi-tui-kit/testing";
import { test } from "vitest";
import { createMockContext } from "../../../test/support.js";
import { localConfigPath } from "../src/config.js";
import { showSyncManager } from "../src/manager-ui.js";
import { withTempHome } from "./helpers.js";

initTheme("dark", false);

test("session replacement aborts and drains an active custom operation", async () => {
	await withTempHome(async (agentDir) => {
		mkdirSync(agentDir, { recursive: true });
		writeFileSync(localConfigPath(), JSON.stringify(settings()), { mode: 0o600 });
		const owner = new AbortController();
		const tui = createTuiHarness({ width: 48, rows: 16 });
		const { ctx } = createMockContext({ hasUI: true, mode: "tui", custom: tui.custom });
		let routeSignal: AbortSignal | undefined;
		let reportRouteStarted: () => void = () => undefined;
		const routeStarted = new Promise<void>((resolve) => {
			reportRouteStarted = resolve;
		});
		let releaseRoute: () => void = () => undefined;
		const routeGate = new Promise<void>((resolve) => {
			releaseRoute = resolve;
		});
		let routeSettled = false;
		let managerSettled = false;
		const running = showSyncManager(
			ctx,
			async (route, signal) => {
				if (route !== "sync") return undefined;
				routeSignal = signal;
				reportRouteStarted();
				await routeGate;
				routeSettled = true;
				return undefined;
			},
			owner.signal,
		);
		void running.then(() => {
			managerSettled = true;
		});

		await tui.waitForOpen();
		tui.press("tui.select.confirm");
		await routeStarted;
		owner.abort(new DOMException("Session replaced", "AbortError"));
		await flushAsync();
		try {
			assert.equal(routeSignal?.aborted, true);
			assert.equal(managerSettled, false);
			assert.equal(routeSettled, false);
		} finally {
			releaseRoute();
			if (!routeSignal?.aborted) tui.dispose();
		}
		await running;
		assert.equal(routeSettled, true);
	});
});

test("external disposal aborts and drains an active custom operation", async () => {
	await withTempHome(async (agentDir) => {
		mkdirSync(agentDir, { recursive: true });
		writeFileSync(localConfigPath(), JSON.stringify(settings()), { mode: 0o600 });
		const tui = createTuiHarness({ width: 48, rows: 16 });
		const { ctx } = createMockContext({ hasUI: true, mode: "tui", custom: tui.custom });
		let routeSignal: AbortSignal | undefined;
		let reportRouteStarted: () => void = () => undefined;
		const routeStarted = new Promise<void>((resolve) => {
			reportRouteStarted = resolve;
		});
		let releaseRoute: () => void = () => undefined;
		const routeGate = new Promise<void>((resolve) => {
			releaseRoute = resolve;
		});
		let managerSettled = false;
		const running = showSyncManager(ctx, async (route, signal) => {
			if (route !== "sync") return undefined;
			routeSignal = signal;
			reportRouteStarted();
			await routeGate;
			return undefined;
		});
		void running.then(() => {
			managerSettled = true;
		});

		await tui.waitForOpen();
		tui.press("tui.select.confirm");
		await routeStarted;
		tui.dispose();
		await flushAsync();
		assert.equal(routeSignal?.aborted, true);
		assert.equal(managerSettled, false);
		releaseRoute();
		await running;
	});
});

test.each([
	["configured key", "q"],
	["hard Ctrl+C", "\u0003"],
])(
	"user cancellation via %s aborts and drains an active custom operation",
	async (_name, input) => {
		await withTempHome(async (agentDir) => {
			mkdirSync(agentDir, { recursive: true });
			writeFileSync(localConfigPath(), JSON.stringify(settings()), { mode: 0o600 });
			const tui = createTuiHarness({
				width: 48,
				rows: 16,
				keybindings: remappedCancelKeybindings(),
			});
			const { ctx, notifications } = createMockContext({
				hasUI: true,
				mode: "tui",
				custom: tui.custom,
			});
			let routeSignal: AbortSignal | undefined;
			let reportRouteStarted: () => void = () => undefined;
			const routeStarted = new Promise<void>((resolve) => {
				reportRouteStarted = resolve;
			});
			let releaseRoute: () => void = () => undefined;
			const routeGate = new Promise<void>((resolve) => {
				releaseRoute = resolve;
			});
			let managerSettled = false;
			const running = showSyncManager(ctx, async (route, signal) => {
				if (route !== "sync") return undefined;
				routeSignal = signal;
				reportRouteStarted();
				await routeGate;
				return undefined;
			});
			void running.then(() => {
				managerSettled = true;
			});

			await tui.waitForOpen();
			tui.press("tui.select.confirm");
			await routeStarted;
			await waitForFrame(tui, /Checking current sync setup/u);
			const loaderOpenCount = tui.openCount;
			const frame = tui.render().join("\n");
			assert.match(frame, /q\/ctrl\+c cancel/u);
			assert.equal(frame.match(/ctrl\+c/gu)?.length, 1);
			for (const line of frame.split("\n")) assert.ok(line.length <= 48);
			tui.send(input);
			await flushAsync();
			try {
				assert.equal(routeSignal?.aborted, true);
				assert.equal(managerSettled, false);
				releaseRoute();
				await closeReturnedMenu(tui, loaderOpenCount, () => managerSettled);
			} finally {
				releaseRoute();
				if (tui.isOpen) tui.dispose();
			}
			await running;
			assert.match(notifications.at(-1)?.message ?? "", /cancelled/u);
		});
	},
);

test("commit-aware hard cancellation stays open until the active operation settles", async () => {
	await withTempHome(async (agentDir) => {
		mkdirSync(agentDir, { recursive: true });
		writeFileSync(localConfigPath(), JSON.stringify(settings()), { mode: 0o600 });
		const tui = createTuiHarness({
			width: 48,
			rows: 16,
			keybindings: remappedCancelKeybindings(),
		});
		const { ctx, notifications } = createMockContext({
			hasUI: true,
			mode: "tui",
			custom: tui.custom,
		});
		let routeSignal: AbortSignal | undefined;
		let reportRouteStarted: () => void = () => undefined;
		const routeStarted = new Promise<void>((resolve) => {
			reportRouteStarted = resolve;
		});
		let releaseRoute: () => void = () => undefined;
		const routeGate = new Promise<void>((resolve) => {
			releaseRoute = resolve;
		});
		let managerSettled = false;
		const running = showSyncManager(ctx, async (route, signal, onCommit) => {
			if (route !== "sync") return undefined;
			routeSignal = signal;
			onCommit?.();
			reportRouteStarted();
			await routeGate;
			return undefined;
		});
		void running.then(() => {
			managerSettled = true;
		});

		await tui.waitForOpen();
		tui.press("tui.select.confirm");
		await routeStarted;
		await waitForFrame(tui, /Checking current sync setup/u);
		assert.match(tui.render().join("\n"), /q\/ctrl\+c cancel/u);
		tui.press("ctrl+c");
		try {
			assert.equal(routeSignal?.aborted, false);
			assert.match(notifications.at(-1)?.message ?? "", /cannot be cancelled safely/u);
			const loaderOpenCount = tui.openCount;
			releaseRoute();
			await closeReturnedMenu(tui, loaderOpenCount, () => managerSettled);
		} finally {
			releaseRoute();
			if (tui.isOpen) tui.dispose();
		}
		await running;
	});
});

function remappedCancelKeybindings(): Pick<KeybindingsManager, "matches" | "getKeys"> {
	return {
		matches(data, binding) {
			if (binding === "tui.select.cancel") return data === "q";
			if (binding === "tui.select.confirm" || binding === "tui.input.submit") {
				return data === "\r";
			}
			return false;
		},
		getKeys(binding) {
			if (binding === "tui.select.cancel") return ["q"];
			if (binding === "tui.select.confirm" || binding === "tui.input.submit") return ["enter"];
			return [];
		},
	};
}

function settings() {
	return {
		version: 3,
		activeSyncSetup: "home",
		onSwitch: "ask-before-pull",
		storageConnections: {
			origin: { type: "git", remote: "git@github.com:user/pi-sync.git" },
		},
		syncSetups: {
			home: {
				storage: { connection: "origin", branch: "pi-sync/home", path: "pi-sync/home" },
				sync: { include: ["settings.json"], automatic: true },
			},
		},
	};
}

async function closeReturnedMenu(
	tui: ReturnType<typeof createTuiHarness>,
	previousOpenCount: number,
	isSettled: () => boolean,
): Promise<void> {
	for (let attempt = 0; attempt < 100; attempt += 1) {
		if (isSettled()) return;
		if (tui.isOpen && tui.openCount > previousOpenCount) {
			tui.press("ctrl+c");
			return;
		}
		await new Promise<void>((resolve) => setTimeout(resolve, 1));
	}
	assert.fail("Timed out waiting for the manager to settle or reopen");
}

async function waitForFrame(
	tui: ReturnType<typeof createTuiHarness>,
	pattern: RegExp,
): Promise<void> {
	for (let attempt = 0; attempt < 20; attempt += 1) {
		await flushAsync();
		if (tui.isOpen && pattern.test(tui.render().join("\n"))) return;
	}
	assert.fail(`Timed out waiting for frame: ${pattern}`);
}

async function flushAsync() {
	await Promise.resolve();
	await new Promise<void>((resolve) => setImmediate(resolve));
	await Promise.resolve();
}
