import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { visibleWidth } from "@earendil-works/pi-tui";
import { test } from "vitest";
import {
	createCustomSelectorHarness,
	createMockContext,
	createMockPi,
} from "../../../test/support.js";
import chromeDevtools from "../src/chrome-devtools.js";
import { applyAvailableChromeDevtoolsTools } from "../src/lazy-tools.js";
import { state } from "../src/runtime.js";
import { settingsFilePath } from "../src/settings.js";
import { buildBrowserStatusMessage } from "../src/tool-selector.js";

const CHROME_TOOLS = [
	"chrome_devtools_list_pages",
	"chrome_devtools_select_page",
	"chrome_devtools_navigate",
	"chrome_devtools_evaluate",
	"chrome_devtools_screenshot",
] as const;

test("main menu presents consequential state and five goal-oriented actions without launching Chrome", async () => {
	await withTempAgentDir(async () => {
		const mock = createMockPi({ activeTools: ["other_tool", CHROME_TOOLS[0], CHROME_TOOLS[4]] });
		chromeDevtools(mock.pi);
		let rendered = "";
		const { ctx } = createMockContext({
			hasUI: true,
			mode: "tui",
			custom: async (factory: unknown) => {
				const harness = createCustomSelectorHarness(factory, 40);
				if (!harness.isPiTuiKitScreen) return harness.resultPromise;
				rendered = harness.render().join("\n");
				assert.ok(harness.render().every((line) => visibleWidth(line) <= 40));
				harness.handleInput("tui.select.cancel");
				return harness.result;
			},
		});

		await mock.commands.get("chrome-devtools")?.handler("", ctx);

		assert.match(rendered, /Tool catalog: 2 of 5 available · not\s+saved/);
		assert.match(rendered, /Browser: not started · attaches or\s+launches on first use/);
		assert.match(rendered, /Endpoint: http:\/\/127\.0\.0\.1:9222/);
		assert.match(rendered, /[→›] Choose available browser tools…/);
		assert.match(rendered, /Make all browser tools available…/);
		assert.match(rendered, /Browser status/);
		assert.match(rendered, /Browser settings/);
		assert.match(rendered, /Help/);
		assert.equal(state.managedBrowser, undefined);
		assert.equal(state.launchPromise, undefined);
		assert.equal(state.lastLaunchAttempt, undefined);
	});
});

test("browser status distinguishes unobserved, running, exited, and failed states without probing", () => {
	state.managedBrowser = undefined;
	state.launchPromise = undefined;
	state.lastLaunchAttempt = undefined;
	assert.match(buildBrowserStatusMessage(), /not started; connection has not been checked/);

	state.managedBrowser = {
		process: {} as never,
		userDataDir: "/tmp/test-profile",
		exited: false,
		ready: true,
		ownerGeneration: state.sessionGeneration,
	};
	assert.match(buildBrowserStatusMessage(), /managed browser running/);

	state.managedBrowser.exited = true;
	state.lastLaunchAttempt = {
		candidateLabels: ["Chromium"],
		mode: "dynamic-port",
		selectedCandidate: "Chromium",
		userDataDir: "/tmp/test-profile",
	};
	const exited = buildBrowserStatusMessage();
	assert.match(exited, /managed browser exited/);
	assert.match(exited, /If no endpoint is available/);

	state.managedBrowser = undefined;
	state.lastLaunchAttempt = {
		candidateLabels: ["Chromium"],
		mode: "dynamic-port",
		lastError: "browser unavailable",
	};
	const failed = buildBrowserStatusMessage();
	assert.match(failed, /last launch failed/);
	assert.match(failed, /Last launch error: browser unavailable/);
	assert.match(failed, /does not probe the endpoint or launch Chrome/);
	state.lastLaunchAttempt = undefined;
});

test("main menu shows saved all-enabled state and the reversible disable preview", async () => {
	await withTempAgentDir(async () => {
		writeFileSync(settingsFilePath(), `${JSON.stringify({ tools: CHROME_TOOLS, updatedAt: 1 })}\n`);
		const mock = createMockPi({ activeTools: ["other_tool", ...CHROME_TOOLS] });
		chromeDevtools(mock.pi);
		let rendered = "";
		const { ctx } = createMockContext({
			hasUI: true,
			mode: "tui",
			custom: async (factory: unknown) => {
				const harness = createCustomSelectorHarness(factory, 80);
				if (!harness.isPiTuiKitScreen) return harness.resultPromise;
				rendered = harness.render().join("\n");
				harness.handleInput("\u0003");
				return harness.result;
			},
		});

		await mock.commands.get("chrome-devtools")?.handler("", ctx);

		assert.match(rendered, /Tool catalog: 5 of 5 available · saved/);
		assert.match(rendered, /Make all browser tools unavailable…/);
		assert.match(rendered, /Preview 0 of 5; other active tools stay/);
	});
});

test("staged tool changes show friendly labels and cancellation has no side effects", async () => {
	await withTempAgentDir(async () => {
		const initialTools = ["other_tool", ...CHROME_TOOLS];
		const mock = createMockPi({ activeTools: initialTools });
		chromeDevtools(mock.pi);
		const renders: string[] = [];
		let toolScreen = 0;
		const { ctx, notifications } = createMockContext({
			hasUI: true,
			mode: "tui",
			custom: async (factory: unknown) => {
				const harness = createCustomSelectorHarness(factory, 80);
				if (!harness.isPiTuiKitScreen) return harness.resultPromise;
				const rendered = harness.render().join("\n");
				renders.push(rendered);
				toolScreen += 1;
				if (toolScreen === 1) harness.handleInput("tui.select.confirm");
				else harness.handleInput("\u0003");
				return harness.resultPromise;
			},
		});

		await mock.commands.get("chrome-devtools")?.handler("tools", ctx);

		assert.match(renders[0] ?? "", /List open pages/);
		assert.match(renders[0] ?? "", /chrome_devtools_list_pages/);
		assert.match(renders[1] ?? "", /1 unapplied change/);
		assert.deepEqual(mock.rawPi.getActiveTools(), initialTools);
		assert.equal(existsSync(settingsFilePath()), false);
		assert.deepEqual(notifications, []);
	});
});

test("Ctrl+C in the nested tool workflow closes the whole manager", async () => {
	await withTempAgentDir(async () => {
		const mock = createMockPi({ activeTools: ["other_tool"] });
		chromeDevtools(mock.pi);
		let mainScreens = 0;
		const { ctx } = createMockContext({
			hasUI: true,
			mode: "tui",
			custom: async (factory: unknown) => {
				const harness = createCustomSelectorHarness(factory, 80);
				if (!harness.isPiTuiKitScreen) return harness.resultPromise;
				const rendered = harness.render().join("\n");
				if (hasScreenTitle(rendered, "Chrome DevTools")) {
					mainScreens += 1;
					if (mainScreens === 1) harness.handleInput("tui.select.confirm");
					else harness.handleInput("\u0003");
				} else harness.handleInput("\u0003");
				return harness.resultPromise;
			},
		});

		await mock.commands.get("chrome-devtools")?.handler("", ctx);

		assert.equal(mainScreens, 1);
	});
});

test("session replacement discards a staged draft without stale feedback", async () => {
	await withTempAgentDir(async () => {
		const initialTools = ["other_tool", ...CHROME_TOOLS];
		const mock = createMockPi({ activeTools: initialTools });
		chromeDevtools(mock.pi);
		let toolScreen = 0;
		const { ctx, notifications } = createMockContext({
			hasUI: true,
			mode: "tui",
			custom: async (factory: unknown) => {
				const harness = createCustomSelectorHarness(factory, 80);
				if (!harness.isPiTuiKitScreen) return harness.resultPromise;
				toolScreen += 1;
				if (toolScreen === 1) harness.handleInput("tui.select.confirm");
				else await mock.events.get("session_shutdown")?.[0]?.({}, ctx);
				return harness.resultPromise;
			},
		});

		await mock.commands.get("chrome-devtools")?.handler("tools", ctx);

		assert.deepEqual(mock.rawPi.getActiveTools(), initialTools);
		assert.equal(existsSync(settingsFilePath()), false);
		assert.deepEqual(notifications, []);
	});
});

test("bulk preview and nested detail navigation return without side effects", async () => {
	await withTempAgentDir(async () => {
		const mock = createMockPi({ activeTools: ["other_tool"] });
		chromeDevtools(mock.pi);
		const details: string[] = [];
		const narrowDetails: string[][] = [];
		let mainScreen = 0;
		const { ctx } = createMockContext({
			hasUI: true,
			mode: "tui",
			custom: async (factory: unknown) => {
				const harness = createCustomSelectorHarness(factory, 80);
				if (!harness.isPiTuiKitScreen) return harness.resultPromise;
				const rendered = harness.render().join("\n");
				if (rendered.includes("Review tool changes")) {
					details.push(rendered);
					harness.handleInput("tui.select.cancel");
					return harness.result;
				}
				if (
					hasScreenTitle(rendered, "Browser status") ||
					(rendered.includes("DevTools endpoint") && rendered.includes("Auto-launch")) ||
					hasScreenTitle(rendered, "Chrome DevTools help")
				) {
					details.push(rendered);
					harness.setTerminalRows(8);
					const narrow = harness.render(20);
					assert.ok(narrow.every((line) => visibleWidth(line) <= 20));
					if (!rendered.includes("DevTools endpoint")) narrowDetails.push(narrow);
					harness.handleInput("tui.select.cancel");
					return harness.result;
				}
				mainScreen += 1;
				if (mainScreen === 1) {
					harness.handleInput("tui.select.down");
					harness.handleInput("tui.select.confirm");
				} else if (mainScreen === 2 || mainScreen === 3 || mainScreen === 4) {
					harness.handleInput("tui.select.down");
					harness.handleInput("tui.select.confirm");
				} else harness.handleInput("\u0003");
				return harness.resultPromise;
			},
		});

		await mock.commands.get("chrome-devtools")?.handler("", ctx);

		assert.match(details[0] ?? "", /Proposed availability: 5\/5/);
		assert.match(details[1] ?? "", /does not probe the endpoint or launch Chrome/);
		assert.match(details[2] ?? "", /DevTools endpoint/);
		assert.match(details[2] ?? "", /Auto-launch/);
		assert.ok(narrowDetails.flat().every((line) => visibleWidth(line) <= 20));
		assert.ok(narrowDetails.every((screen) => screen.length <= 5));
		assert.deepEqual(mock.rawPi.getActiveTools(), ["other_tool"]);
		assert.equal(existsSync(settingsFilePath()), false);
		assert.equal(state.managedBrowser, undefined);
	});
});

test("invalid settings keep tool mutation unavailable and preserve the file", async () => {
	await withTempAgentDir(async () => {
		const invalid = "{not-json\n";
		writeFileSync(settingsFilePath(), invalid);
		const mock = createMockPi({ activeTools: ["other_tool", CHROME_TOOLS[0]] });
		chromeDevtools(mock.pi);
		let rendered = "";
		const { ctx } = createMockContext({
			hasUI: true,
			mode: "tui",
			custom: async (factory: unknown) => {
				const harness = createCustomSelectorHarness(factory, 80);
				if (!harness.isPiTuiKitScreen) return harness.resultPromise;
				rendered = harness.render().join("\n");
				harness.handleInput("\u0003");
				return harness.result;
			},
		});

		await mock.commands.get("chrome-devtools")?.handler("", ctx);

		assert.match(rendered, /settings need repair/);
		assert.match(rendered, /\[-\] Choose available browser tools…/);
		assert.match(rendered, /Repair\s+.*invalid JSON\s+before saving/s);
		assert.equal(readFileSync(settingsFilePath(), "utf8"), invalid);
	});
});

test("cancelling the loading state closes without opening the menu or creating settings", async () => {
	await withTempAgentDir(async () => {
		const mock = createMockPi({ activeTools: ["other_tool"] });
		chromeDevtools(mock.pi);
		let menuScreens = 0;
		const { ctx, notifications } = createMockContext({
			hasUI: true,
			mode: "tui",
			custom: async (factory: unknown) => {
				const harness = createCustomSelectorHarness(factory, 40);
				if (harness.isPiTuiKitScreen) {
					menuScreens += 1;
					harness.handleInput("\u0003");
					return harness.result;
				}
				harness.handleInput("tui.select.cancel");
				return harness.resultPromise;
			},
		});

		await mock.commands.get("chrome-devtools")?.handler("", ctx);

		assert.equal(menuScreens, 0);
		assert.equal(existsSync(settingsFilePath()), false);
		assert.deepEqual(mock.rawPi.getActiveTools(), ["other_tool"]);
		assert.deepEqual(notifications, []);
	});
});

test("interactive routes reject unsupported modes while direct mutations remain available", async () => {
	await withTempAgentDir(async () => {
		const mock = createMockPi({ activeTools: ["other_tool", ...CHROME_TOOLS] });
		chromeDevtools(mock.pi);
		const { ctx } = createMockContext({ mode: "json", hasUI: false });
		const command = mock.commands.get("chrome-devtools")?.handler;
		assert.ok(command);
		const invoke = async (args: string) => command(args, ctx);

		await assert.rejects(() => invoke(""), /requires TUI or RPC/);
		await assert.rejects(() => invoke("help"), /requires TUI or RPC/);
		await assert.rejects(() => invoke("status"), /requires TUI or RPC/);
		await assert.rejects(() => invoke("quickstart"), /requires TUI or RPC/);
		await assert.rejects(() => invoke("settings"), /requires TUI or RPC/);
		await assert.rejects(() => invoke("tools"), /requires TUI or RPC/);
		await invoke("disable");

		assert.deepEqual(mock.rawPi.getActiveTools(), ["other_tool", "chrome_devtools_load"]);
		assert.deepEqual(JSON.parse(readFileSync(settingsFilePath(), "utf8")).tools, []);
	});
});

test("apply refreshes review instead of overwriting browser tools changed while waiting", async () => {
	await withTempAgentDir(async () => {
		const initialTools = ["other_tool", ...CHROME_TOOLS];
		const mock = createMockPi({ activeTools: initialTools });
		chromeDevtools(mock.pi);
		let changedWhileWaiting = false;
		let toolScreen = 0;
		let reviewScreen = 0;
		let refreshedReview = "";
		const { ctx, notifications } = createMockContext({
			waitForIdle: async () => {
				if (changedWhileWaiting) return;
				changedWhileWaiting = true;
				applyAvailableChromeDevtoolsTools(mock.pi, CHROME_TOOLS.slice(0, 3));
			},
			hasUI: true,
			mode: "tui",
			custom: async (factory: unknown) => {
				const harness = createCustomSelectorHarness(factory, 80);
				if (!harness.isPiTuiKitScreen) return harness.resultPromise;
				const rendered = harness.render().join("\n");
				if (rendered.includes("Review tool changes")) {
					reviewScreen += 1;
					if (reviewScreen === 1) harness.handleInput("tui.select.confirm");
					else {
						refreshedReview = rendered;
						harness.handleInput("\u0003");
					}
					return harness.resultPromise;
				}
				toolScreen += 1;
				if (toolScreen === 1) harness.handleInput("tui.select.confirm");
				else {
					for (let index = 0; index < 7; index += 1) harness.handleInput("tui.select.down");
					harness.handleInput("tui.select.confirm");
				}
				return harness.resultPromise;
			},
		});

		await mock.commands.get("chrome-devtools")?.handler("tools", ctx);

		assert.equal(reviewScreen, 2);
		assert.match(refreshedReview, /Currently available: 3\/5/);
		assert.match(refreshedReview, /Proposed availability: 4\/5/);
		assert.deepEqual(mock.rawPi.getActiveTools(), [
			"other_tool",
			"chrome_devtools_load",
			...CHROME_TOOLS.slice(0, 3),
		]);
		assert.equal(existsSync(settingsFilePath()), false);
		assert.match(notifications.at(-1)?.message ?? "", /changed while review was open/i);
	});
});

test("a failed confirmed save restores runtime and retains the draft for retry", async () => {
	await withTempAgentDir(async () => {
		const initialTools = ["other_tool", ...CHROME_TOOLS];
		const mock = createMockPi({ activeTools: initialTools });
		chromeDevtools(mock.pi);
		let toolScreen = 0;
		let reviewScreen = 0;
		let retryReview = "";
		const { ctx, notifications } = createMockContext({
			hasUI: true,
			mode: "tui",
			custom: async (factory: unknown) => {
				const harness = createCustomSelectorHarness(factory, 80);
				if (!harness.isPiTuiKitScreen) return harness.resultPromise;
				const rendered = harness.render().join("\n");
				if (rendered.includes("Review tool changes")) {
					reviewScreen += 1;
					if (reviewScreen === 1) {
						mkdirSync(settingsFilePath());
						harness.handleInput("tui.select.confirm");
						return harness.resultPromise;
					}
					retryReview = rendered;
					harness.handleInput("tui.select.cancel");
					return harness.result;
				}
				toolScreen += 1;
				if (toolScreen === 1) harness.handleInput("tui.select.confirm");
				else if (toolScreen === 2) {
					for (let index = 0; index < 7; index += 1) harness.handleInput("tui.select.down");
					harness.handleInput("tui.select.confirm");
				} else harness.handleInput("\u0003");
				return harness.resultPromise;
			},
		});

		await mock.commands.get("chrome-devtools")?.handler("tools", ctx);

		assert.equal(reviewScreen, 2);
		assert.match(retryReview, /Proposed availability: 4\/5/);
		assert.deepEqual(mock.rawPi.getActiveTools(), [
			"other_tool",
			"chrome_devtools_load",
			...CHROME_TOOLS,
		]);
		assert.match(
			notifications.at(-1)?.message ?? "",
			/settings save failed; active tools restored/i,
		);
	});
});

test("successful apply keeps unresolved settings warnings visible in the parent menu", async () => {
	await withTempAgentDir(async () => {
		state.settingsNotice = "Project browser executablePath was ignored.";
		const mock = createMockPi({ activeTools: ["other_tool", ...CHROME_TOOLS] });
		chromeDevtools(mock.pi);
		let mainScreen = 0;
		let toolScreen = 0;
		let refreshedMain = "";
		const { ctx } = createMockContext({
			hasUI: true,
			mode: "tui",
			custom: async (factory: unknown) => {
				const harness = createCustomSelectorHarness(factory, 80);
				if (!harness.isPiTuiKitScreen) return harness.resultPromise;
				const rendered = harness.render().join("\n");
				if (hasScreenTitle(rendered, "Chrome DevTools")) {
					mainScreen += 1;
					if (mainScreen === 1) harness.handleInput("tui.select.confirm");
					else {
						refreshedMain = rendered;
						harness.handleInput("\u0003");
					}
					return harness.resultPromise;
				}
				if (rendered.includes("Review tool changes")) {
					harness.handleInput("tui.select.confirm");
					return harness.resultPromise;
				}
				toolScreen += 1;
				if (toolScreen === 1) harness.handleInput("tui.select.confirm");
				else {
					for (let index = 0; index < 7; index += 1) harness.handleInput("tui.select.down");
					harness.handleInput("tui.select.confirm");
				}
				return harness.resultPromise;
			},
		});

		await mock.commands.get("chrome-devtools")?.handler("", ctx);

		assert.equal(mainScreen, 2);
		assert.match(refreshedMain, /Settings warning: Project browser executablePath was ignored/);
	});
});

test("RPC dialogs preserve staged review and confirmed apply semantics", async () => {
	await withTempAgentDir(async () => {
		const mock = createMockPi({ activeTools: ["other_tool", ...CHROME_TOOLS] });
		chromeDevtools(mock.pi);
		let toolDialog = 0;
		const dialogTitles: string[] = [];
		const { ctx } = createMockContext({
			hasUI: true,
			mode: "rpc",
			select: async (title: string, options: string[]) => {
				dialogTitles.push(title);
				if (options.some((option) => option.includes("List open pages"))) {
					toolDialog += 1;
					if (toolDialog === 1) return options.find((option) => option.includes("List open pages"));
					return options.find((option) => option.includes("Review changes"));
				}
				return options.find((option) => option.includes("Apply tool changes"));
			},
		});

		await mock.commands.get("chrome-devtools")?.handler("tools", ctx);

		assert.ok(dialogTitles.some((title) => title.includes("Currently available: 5/5")));
		assert.ok(dialogTitles.some((title) => title.includes("Proposed availability: 4/5")));
		assert.deepEqual(mock.rawPi.getActiveTools(), [
			"other_tool",
			"chrome_devtools_load",
			...CHROME_TOOLS.slice(1),
		]);
		assert.deepEqual(
			JSON.parse(readFileSync(settingsFilePath(), "utf8")).tools,
			CHROME_TOOLS.slice(1),
		);
	});
});

test("review previews the exact tool effect and one confirmed apply persists it", async () => {
	await withTempAgentDir(async () => {
		const initialTools = ["other_tool", ...CHROME_TOOLS];
		const mock = createMockPi({ activeTools: initialTools });
		chromeDevtools(mock.pi);
		const applicationOrder: string[] = [];
		const setActiveTools = mock.rawPi.setActiveTools.bind(mock.rawPi);
		mock.rawPi.setActiveTools = (names) => {
			applicationOrder.push("apply-runtime");
			setActiveTools(names);
		};
		let toolScreen = 0;
		let review = "";
		let narrowReview: string[] = [];
		const { ctx, notifications } = createMockContext({
			waitForIdle: async () => {
				applicationOrder.push("wait-for-idle");
			},
			hasUI: true,
			mode: "tui",
			custom: async (factory: unknown) => {
				const harness = createCustomSelectorHarness(factory, 80);
				if (!harness.isPiTuiKitScreen) return harness.resultPromise;
				const rendered = harness.render().join("\n");
				if (rendered.includes("Review tool changes")) {
					review = rendered;
					harness.setTerminalRows(8);
					narrowReview = harness.render(20);
					harness.handleInput("tui.select.confirm");
					return harness.resultPromise;
				}
				toolScreen += 1;
				if (toolScreen === 1) {
					harness.handleInput("tui.select.confirm");
					return harness.resultPromise;
				}
				for (let index = 0; index < 7; index += 1) harness.handleInput("tui.select.down");
				harness.handleInput("tui.select.confirm");
				return harness.resultPromise;
			},
		});

		await mock.commands.get("chrome-devtools")?.handler("tools", ctx);

		assert.match(review, /Currently available: 5\/5/);
		assert.match(review, /Proposed availability: 4\/5/);
		assert.match(review, /Unavailable after apply:/);
		assert.match(review, /List open pages \(chrome_devtools_list_pages\)/);
		assert.match(review, /Other active Pi tools remain unchanged/);
		assert.ok(narrowReview.every((line) => visibleWidth(line) <= 20));
		assert.ok(narrowReview.length <= 5);
		assert.deepEqual(applicationOrder, ["wait-for-idle", "apply-runtime"]);
		assert.deepEqual(mock.rawPi.getActiveTools(), [
			"other_tool",
			"chrome_devtools_load",
			...CHROME_TOOLS.slice(1),
		]);
		assert.deepEqual(
			JSON.parse(readFileSync(settingsFilePath(), "utf8")).tools,
			CHROME_TOOLS.slice(1),
		);
		assert.match(notifications.at(-1)?.message ?? "", /Saved: 4 of 5 browser tools available/);
	});
});

function hasScreenTitle(rendered: string, title: string) {
	return rendered.split("\n").includes(title);
}

async function withTempAgentDir(run: () => Promise<void>) {
	const directory = mkdtempSync(path.join(os.tmpdir(), "pi-cdp-menu-test-"));
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = directory;
	try {
		await run();
	} finally {
		state.sessionController.abort();
		state.sessionController = new AbortController();
		state.sessionGeneration += 1;
		state.managedBrowser = undefined;
		state.launchPromise = undefined;
		state.lastLaunchAttempt = undefined;
		state.settingsNotice = undefined;
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		rmSync(directory, { recursive: true, force: true });
	}
}
