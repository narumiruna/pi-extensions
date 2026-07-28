import assert from "node:assert/strict";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
	createCustomSelectorHarness,
	createMockContext,
	createMockPi,
	driveCustomSelector,
} from "../../../test/support.js";
import chromeDevtools, {
	commandCompletions,
	formatHostForUrl,
	hasParentPathSegment,
	isLocalDevToolsHost,
	isPathInsideRoot,
	normalizeChromeDevtoolsSettings,
	orderedChromeDevtoolsTools,
	parseCommand,
	parseConfiguredPort,
	quoteCommandPart,
	resolveScreenshotPath,
	selectAllowedRoot,
} from "../src/chrome-devtools.js";
import { saveSettings } from "../src/settings.js";

const NEW_SETTINGS_FILE = "pi-chrome-devtools.json";
const LEGACY_SETTINGS_FILE = "pi-chrome-devtools-settings.json";
const LIST_PAGES_TOOL = "chrome_devtools_list_pages";
const EVALUATE_TOOL = "chrome_devtools_evaluate";
const SCREENSHOT_TOOL = "chrome_devtools_screenshot";

test("chrome-devtools registers all CDP tools and command", () => {
	const mock = createMockPi();
	chromeDevtools(mock.pi);

	assert.equal(mock.tools.length, 5);
	assert.deepEqual(
		mock.tools.map((tool) => tool.name),
		[
			"chrome_devtools_list_pages",
			"chrome_devtools_select_page",
			"chrome_devtools_navigate",
			"chrome_devtools_evaluate",
			"chrome_devtools_screenshot",
		],
	);
	assert.ok(mock.commands.has("chrome-devtools"));
	assert.deepEqual([...mock.events.keys()].sort(), ["session_shutdown", "session_start"]);
});

test("chrome-devtools command parsing and completions cover aliases", () => {
	assert.equal(parseCommand(""), "menu");
	assert.equal(parseCommand("toggle"), "tools");
	assert.equal(parseCommand("on"), "enable");
	assert.equal(parseCommand("off"), "disable");
	assert.equal(parseCommand("wat"), "unknown");
	assert.deepEqual(commandCompletions("qui"), [
		{ value: "quickstart", label: "quickstart", description: "Show endpoint and launch help" },
	]);
	assert.equal(commandCompletions("quickstart "), null);
	assert.equal(commandCompletions("quick start"), null);
});

test("chrome-devtools settings normalize ordered unique tool names", () => {
	assert.deepEqual(
		normalizeChromeDevtoolsSettings({
			tools: [SCREENSHOT_TOOL, LIST_PAGES_TOOL, SCREENSHOT_TOOL],
			updatedAt: 1,
		}),
		{ tools: [LIST_PAGES_TOOL, SCREENSHOT_TOOL], updatedAt: 1 },
	);
	assert.equal(normalizeChromeDevtoolsSettings({ tools: ["bad"], updatedAt: 1 }), undefined);
	assert.deepEqual(orderedChromeDevtoolsTools(new Set([EVALUATE_TOOL])), [EVALUATE_TOOL]);
});

test("chrome-devtools preserves active tools when settings are missing", async () => {
	await withTempAgentDir(async () => {
		const chromeDevtoolsModule = await importFreshChromeDevtools();
		const mock = createMockPi({ activeTools: ["other_tool", EVALUATE_TOOL] });
		const { ctx, notifications } = createMockContext();

		chromeDevtoolsModule.default(mock.pi);
		await mock.events.get("session_start")?.[0]?.({}, ctx);

		assert.deepEqual(mock.rawPi.getActiveTools(), ["other_tool", EVALUATE_TOOL]);
		assert.deepEqual(notifications, []);
	});
});

test("chrome-devtools loads the new settings file without a migration warning", async () => {
	await withTempAgentDir(async (agentDir) => {
		writeSettings(agentDir, NEW_SETTINGS_FILE, [SCREENSHOT_TOOL]);
		const chromeDevtoolsModule = await importFreshChromeDevtools();
		const mock = createMockPi({ activeTools: ["other_tool", LIST_PAGES_TOOL] });
		const { ctx, notifications } = createMockContext();

		chromeDevtoolsModule.default(mock.pi);
		await mock.events.get("session_start")?.[0]?.({}, ctx);

		assert.deepEqual(mock.rawPi.getActiveTools(), ["other_tool", SCREENSHOT_TOOL]);
		assert.deepEqual(notifications, []);
	});
});

test("chrome-devtools reads legacy-only settings without modifying either path", async () => {
	await withTempAgentDir(async (agentDir) => {
		writeSettings(agentDir, LEGACY_SETTINGS_FILE, [LIST_PAGES_TOOL]);
		const chromeDevtoolsModule = await importFreshChromeDevtools();
		const mock = createMockPi({ activeTools: ["other_tool", SCREENSHOT_TOOL] });
		const { ctx, notifications } = createMockContext();

		chromeDevtoolsModule.default(mock.pi);
		await mock.events.get("session_start")?.[0]?.({}, ctx);

		assert.deepEqual(mock.rawPi.getActiveTools(), ["other_tool", LIST_PAGES_TOOL]);
		assert.equal(existsSync(path.join(agentDir, NEW_SETTINGS_FILE)), false);
		assert.deepEqual(readSettings(agentDir, LEGACY_SETTINGS_FILE).tools, [LIST_PAGES_TOOL]);
		assert.match(notifications[0]?.message ?? "", /using legacy/i);
		assert.match(notifications[0]?.message ?? "", /rename.*pi-chrome-devtools\.json/i);
	});
});

test("chrome-devtools prefers new settings created while legacy settings are loading", async () => {
	await withTempAgentDir(async (agentDir) => {
		writeSettings(agentDir, LEGACY_SETTINGS_FILE, [LIST_PAGES_TOOL]);
		const chromeDevtoolsModule = await importFreshChromeDevtools();
		const mock = createMockPi({ activeTools: ["other_tool", EVALUATE_TOOL] });
		const { ctx, notifications } = createMockContext();

		chromeDevtoolsModule.default(mock.pi);
		const sessionStart = mock.events.get("session_start")?.[0]?.({}, ctx);
		writeSettings(agentDir, NEW_SETTINGS_FILE, [SCREENSHOT_TOOL]);
		await sessionStart;

		assert.deepEqual(mock.rawPi.getActiveTools(), ["other_tool", SCREENSHOT_TOOL]);
		assert.deepEqual(readSettings(agentDir, NEW_SETTINGS_FILE).tools, [SCREENSHOT_TOOL]);
		assert.equal(existsSync(path.join(agentDir, LEGACY_SETTINGS_FILE)), true);
		assert.match(notifications[0]?.message ?? "", /legacy settings ignored/i);
	});
});

test("chrome-devtools prefers new settings when both files exist and reports legacy ignored", async () => {
	await withTempAgentDir(async (agentDir) => {
		writeSettings(agentDir, NEW_SETTINGS_FILE, [SCREENSHOT_TOOL]);
		writeSettings(agentDir, LEGACY_SETTINGS_FILE, [LIST_PAGES_TOOL]);
		const chromeDevtoolsModule = await importFreshChromeDevtools();
		const mock = createMockPi({ activeTools: ["other_tool", EVALUATE_TOOL] });
		const { ctx, notifications } = createMockContext();

		chromeDevtoolsModule.default(mock.pi);
		await mock.events.get("session_start")?.[0]?.({}, ctx);
		await mock.commands.get("chrome-devtools")?.handler("status", ctx);

		assert.deepEqual(mock.rawPi.getActiveTools(), ["other_tool", SCREENSHOT_TOOL]);
		assert.deepEqual(readSettings(agentDir, NEW_SETTINGS_FILE).tools, [SCREENSHOT_TOOL]);
		assert.equal(existsSync(path.join(agentDir, LEGACY_SETTINGS_FILE)), true);
		assert.match(notifications[0]?.message ?? "", /legacy settings ignored/i);
		const statusMessage = notifications.at(-1)?.message ?? "";
		assert.match(statusMessage, /Settings file: .*pi-chrome-devtools\.json/);
		assert.match(statusMessage, /legacy settings ignored/i);
	});
});

test("chrome-devtools ignores invalid legacy settings without creating the new file", async () => {
	await withTempAgentDir(async (agentDir) => {
		writeFileSync(
			path.join(agentDir, LEGACY_SETTINGS_FILE),
			JSON.stringify({ tools: ["bad"], updatedAt: 1 }),
		);
		const chromeDevtoolsModule = await importFreshChromeDevtools();
		const mock = createMockPi({ activeTools: ["other_tool", EVALUATE_TOOL] });
		const { ctx, notifications } = createMockContext();

		chromeDevtoolsModule.default(mock.pi);
		await mock.events.get("session_start")?.[0]?.({}, ctx);

		assert.deepEqual(mock.rawPi.getActiveTools(), ["other_tool", EVALUATE_TOOL]);
		assert.equal(existsSync(path.join(agentDir, NEW_SETTINGS_FILE)), false);
		assert.match(notifications[0]?.message ?? "", /settings ignored/i);
		assert.match(notifications[0]?.message ?? "", /pi-chrome-devtools-settings\.json/);
	});
});

test("chrome-devtools does not fall back to legacy settings when the new file is invalid", async () => {
	await withTempAgentDir(async (agentDir) => {
		writeFileSync(
			path.join(agentDir, NEW_SETTINGS_FILE),
			JSON.stringify({ tools: ["bad"], updatedAt: 1 }),
		);
		writeSettings(agentDir, LEGACY_SETTINGS_FILE, [LIST_PAGES_TOOL]);
		const chromeDevtoolsModule = await importFreshChromeDevtools();
		const mock = createMockPi({ activeTools: ["other_tool", EVALUATE_TOOL] });
		const { ctx, notifications } = createMockContext();

		chromeDevtoolsModule.default(mock.pi);
		await mock.events.get("session_start")?.[0]?.({}, ctx);

		assert.deepEqual(mock.rawPi.getActiveTools(), ["other_tool", EVALUATE_TOOL]);
		assert.equal(existsSync(path.join(agentDir, LEGACY_SETTINGS_FILE)), true);
		assert.match(notifications[0]?.message ?? "", /legacy settings ignored/i);
		assert.match(notifications[1]?.message ?? "", /settings ignored/i);
		assert.match(notifications[1]?.message ?? "", /pi-chrome-devtools\.json/);
	});
});

test("chrome-devtools saves tool selection only to the new settings file", async () => {
	await withTempAgentDir(async (agentDir) => {
		writeFileSync(
			path.join(agentDir, NEW_SETTINGS_FILE),
			JSON.stringify({ tools: [LIST_PAGES_TOOL], updatedAt: 1, future: { kept: true } }),
		);
		const chromeDevtoolsModule = await importFreshChromeDevtools();
		const mock = createMockPi({ activeTools: ["other_tool", LIST_PAGES_TOOL] });
		const { ctx, notifications } = createMockContext();

		chromeDevtoolsModule.default(mock.pi);
		await mock.commands.get("chrome-devtools")?.handler("disable", ctx);

		assert.deepEqual(mock.rawPi.getActiveTools(), ["other_tool"]);
		assert.deepEqual(readSettings(agentDir, NEW_SETTINGS_FILE).tools, []);
		assert.deepEqual(readSettings(agentDir, NEW_SETTINGS_FILE).future, { kept: true });
		assert.equal(existsSync(path.join(agentDir, LEGACY_SETTINGS_FILE)), false);
		assert.match(notifications[0]?.message ?? "", /Settings file: .*pi-chrome-devtools\.json/);
	});
});

test("chrome-devtools failed publication preserves the prior file and removes its temporary", async () => {
	await withTempAgentDir(async (agentDir) => {
		writeSettings(agentDir, NEW_SETTINGS_FILE, [LIST_PAGES_TOOL]);
		const settingsPath = path.join(agentDir, NEW_SETTINGS_FILE);
		const original = readFileSync(settingsPath, "utf8");

		await assert.rejects(
			saveSettings(
				{ tools: [], updatedAt: 2 },
				{ rename: async () => Promise.reject(new Error("publish failed")) },
			),
			/publish failed/,
		);

		assert.equal(readFileSync(settingsPath, "utf8"), original);
		assert.deepEqual(readdirSync(agentDir), [NEW_SETTINGS_FILE]);
	});
});

test("chrome-devtools legacy-seeded saves preserve canonical settings created before publication", async () => {
	await withTempAgentDir(async (agentDir) => {
		const legacyPath = path.join(agentDir, LEGACY_SETTINGS_FILE);
		const canonicalPath = path.join(agentDir, NEW_SETTINGS_FILE);
		const legacy = JSON.stringify({ tools: [LIST_PAGES_TOOL], updatedAt: 1, legacy: true });
		const concurrent = JSON.stringify({ tools: [SCREENSHOT_TOOL], updatedAt: 2, newer: true });
		writeFileSync(legacyPath, legacy);

		await assert.rejects(
			saveSettings(
				{ tools: [EVALUATE_TOOL], updatedAt: 3 },
				{
					write: async (temporaryPath, data) => {
						writeFileSync(temporaryPath, data);
						writeFileSync(canonicalPath, concurrent);
					},
				},
			),
			/created concurrently.*retry/i,
		);

		assert.equal(readFileSync(canonicalPath, "utf8"), concurrent);
		assert.equal(readFileSync(legacyPath, "utf8"), legacy);
		assert.deepEqual(
			readdirSync(agentDir).sort(),
			[LEGACY_SETTINGS_FILE, NEW_SETTINGS_FILE].sort(),
		);
	});
});

test("chrome-devtools rejects invalid settings updates and restores active tools", async () => {
	await withTempAgentDir(async (agentDir) => {
		const settingsPath = path.join(agentDir, NEW_SETTINGS_FILE);
		const invalid = '{"tools":["invalid"],"future":"kept"}\n';
		writeFileSync(settingsPath, invalid);
		const chromeDevtoolsModule = await importFreshChromeDevtools();
		const mock = createMockPi({ activeTools: ["other_tool", LIST_PAGES_TOOL] });
		const { ctx, notifications } = createMockContext();

		chromeDevtoolsModule.default(mock.pi);
		await mock.commands.get("chrome-devtools")?.handler("disable", ctx);

		assert.equal(readFileSync(settingsPath, "utf8"), invalid);
		assert.deepEqual(mock.rawPi.getActiveTools(), ["other_tool", LIST_PAGES_TOOL]);
		assert.match(notifications.at(-1)?.message ?? "", /settings save failed/i);

		writeSettings(agentDir, NEW_SETTINGS_FILE, [LIST_PAGES_TOOL]);
		await mock.commands.get("chrome-devtools")?.handler("disable", ctx);
		assert.deepEqual(readSettings(agentDir, NEW_SETTINGS_FILE).tools, []);
	});
});

test("chrome-devtools rolls back a failed save after shutdown invalidates its session", async () => {
	await withTempAgentDir(async (agentDir) => {
		mkdirSync(path.join(agentDir, NEW_SETTINGS_FILE));
		const chromeDevtoolsModule = await importFreshChromeDevtools();
		const mock = createMockPi({ activeTools: ["other_tool", LIST_PAGES_TOOL] });
		const { ctx, notifications } = createMockContext();
		chromeDevtoolsModule.default(mock.pi);

		const command = mock.commands.get("chrome-devtools")?.handler("disable", ctx);
		await Promise.resolve();
		assert.deepEqual(mock.rawPi.getActiveTools(), ["other_tool"]);
		const shutdown = mock.events.get("session_shutdown")?.[0]?.({}, ctx);

		await Promise.all([command, shutdown]);
		assert.deepEqual(mock.rawPi.getActiveTools(), ["other_tool", LIST_PAGES_TOOL]);
		assert.deepEqual(notifications, []);
	});
});

test("chrome-devtools serializes rapid tool saves in invocation order", async () => {
	await withTempAgentDir(async (agentDir) => {
		const chromeDevtoolsModule = await importFreshChromeDevtools();
		const mock = createMockPi({ activeTools: ["other_tool"] });
		const { ctx } = createMockContext();
		chromeDevtoolsModule.default(mock.pi);

		const first = mock.commands.get("chrome-devtools")?.handler("enable", ctx);
		const second = mock.commands.get("chrome-devtools")?.handler("disable", ctx);
		await Promise.all([first, second]);

		assert.deepEqual(mock.rawPi.getActiveTools(), ["other_tool"]);
		assert.deepEqual(readSettings(agentDir, NEW_SETTINGS_FILE).tools, []);
	});
});

test("endpoint helpers normalize ports, hosts, and launch quoting", () => {
	assert.equal(parseConfiguredPort("9222"), 9222);
	assert.equal(parseConfiguredPort("0"), undefined);
	assert.equal(parseConfiguredPort("65536"), undefined);
	assert.equal(formatHostForUrl("::1"), "[::1]");
	assert.equal(formatHostForUrl("[::1]"), "[::1]");
	assert.equal(isLocalDevToolsHost("[::1]"), true);
	assert.equal(isLocalDevToolsHost("example.com"), false);
	assert.equal(quoteCommandPart("/Applications/Google Chrome"), '"/Applications/Google Chrome"');
});

test("Chrome DevTools main menu dispatches declarative actions at narrow widths", async () => {
	const mock = createMockPi();
	chromeDevtools(mock.pi);
	const { ctx, notifications } = createMockContext({
		hasUI: true,
		mode: "tui",
		custom: async (factory: unknown) => {
			const { renders, result } = driveCustomSelector(factory, ["tui.select.confirm"], 20);
			assert.ok(renders.flat().every((line) => visibleWidth(line) <= 20));
			return result;
		},
	});
	await mock.commands.get("chrome-devtools")?.handler("", ctx);
	assert.match(notifications.at(-1)?.message ?? "", /Chrome DevTools endpoint/);
});

test("Chrome DevTools tool selection keeps the cursor on the toggled row", async () => {
	await withTempAgentDir(async (agentDir) => {
		const mock = createMockPi({ activeTools: ["other_tool"] });
		chromeDevtools(mock.pi);
		const toolNames = mock.tools.map((tool) => String(tool.name));
		mock.rawPi.setActiveTools(["other_tool", ...toolNames]);
		const { ctx } = createMockContext({
			hasUI: true,
			mode: "tui",
			custom: async (factory: unknown) => {
				const { renders, result } = driveCustomSelector(factory, [
					"tui.select.down",
					"tui.select.confirm",
					"tui.select.cancel",
				]);
				assert.ok(renders[1]?.some((line) => line.includes("› [ ] chrome_devtools_select_page")));
				return result;
			},
		});
		await mock.commands.get("chrome-devtools")?.handler("tools", ctx);

		assert.deepEqual(mock.rawPi.getActiveTools(), [
			"other_tool",
			...toolNames.filter((name) => name !== "chrome_devtools_select_page"),
		]);
		assert.deepEqual(readSettings(agentDir, NEW_SETTINGS_FILE).tools, [
			...toolNames.filter((name) => name !== "chrome_devtools_select_page"),
		]);
	});
});

test("Chrome DevTools tool selection refreshes dynamic state after a saved toggle", async () => {
	await withTempAgentDir(async () => {
		const mock = createMockPi({ activeTools: ["other_tool"] });
		chromeDevtools(mock.pi);
		const toolNames = mock.tools.map((tool) => String(tool.name));
		mock.rawPi.setActiveTools(["other_tool", ...toolNames]);
		let customCalls = 0;
		const { ctx } = createMockContext({
			hasUI: true,
			mode: "tui",
			custom: async (factory: unknown) => {
				customCalls += 1;
				const harness = createCustomSelectorHarness(factory, 80);
				if (customCalls === 1) harness.handleInput("tui.select.confirm");
				else {
					assert.match(harness.render().join("\n"), /Chrome DevTools tools \(4\/5\)/);
					harness.handleInput("tui.select.cancel");
				}
				for (let turn = 0; harness.result === undefined && turn < 2_000; turn += 1) {
					await new Promise<void>((resolve) => setTimeout(resolve, 1));
				}
				assert.notEqual(harness.result, undefined);
				return harness.result;
			},
		});
		await mock.commands.get("chrome-devtools")?.handler("tools", ctx);
		assert.equal(customCalls, 2);
	});
});

test("Chrome DevTools tool selection stays within narrow terminal widths", async () => {
	await withTempAgentDir(async () => {
		const mock = createMockPi({ activeTools: ["other_tool"] });
		chromeDevtools(mock.pi);
		const { ctx } = createMockContext({
			hasUI: true,
			mode: "tui",
			custom: async (factory: unknown) => {
				const { renders, result } = driveCustomSelector(factory, ["tui.select.cancel"], 20);
				assert.ok(renders.flat().every((line) => visibleWidth(line) <= 20));
				return result;
			},
		});
		await mock.commands.get("chrome-devtools")?.handler("tools", ctx);
	});
});

test("Chrome DevTools tool selection uses dialogs instead of custom TUI in RPC mode", async () => {
	await withTempAgentDir(async () => {
		const mock = createMockPi({ activeTools: ["other_tool"] });
		chromeDevtools(mock.pi);
		let customCalls = 0;
		const { ctx } = createMockContext({
			hasUI: true,
			mode: "rpc",
			select: async () => "Done",
			custom: async () => {
				customCalls += 1;
			},
		});

		await mock.commands.get("chrome-devtools")?.handler("tools", ctx);

		assert.equal(customCalls, 0);
	});
});

test("resolveScreenshotPath confines explicit paths to cwd or temp", () => {
	const cwd = mkdtempSync(path.join(os.tmpdir(), "pi-cdp-test-"));
	const resolved = resolveScreenshotPath("@screens/out.png", cwd);

	assert.equal(resolved.path, path.join(cwd, "screens", "out.png"));
	assert.deepEqual(resolved.allowedRoots, [path.resolve(cwd)]);
	assert.equal(resolved.isDefault, false);
	assert.equal(hasParentPathSegment("screens/../out.png"), true);
	assert.throws(() => resolveScreenshotPath("../escape.png", cwd), /must not contain '\.\.'/);
	assert.equal(selectAllowedRoot(path.join(cwd, "screens"), [cwd, os.tmpdir()]), path.resolve(cwd));
	assert.equal(isPathInsideRoot(path.join(cwd, "screens", "out.png"), cwd), true);
});

let importCounter = 0;

async function importFreshChromeDevtools() {
	return (await import(
		`../src/chrome-devtools.js?settings-test=${Date.now()}-${importCounter++}`
	)) as typeof import("../src/chrome-devtools.js");
}

async function withTempAgentDir<T>(fn: (agentDir: string) => Promise<T>) {
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	const agentDir = mkdtempSync(path.join(os.tmpdir(), "pi-cdp-settings-"));
	process.env.PI_CODING_AGENT_DIR = agentDir;
	try {
		return await fn(agentDir);
	} finally {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		rmSync(agentDir, { recursive: true, force: true });
	}
}

function writeSettings(agentDir: string, fileName: string, tools: string[]) {
	writeFileSync(path.join(agentDir, fileName), JSON.stringify({ tools, updatedAt: 1 }));
}

function readSettings(agentDir: string, fileName: string) {
	return JSON.parse(readFileSync(path.join(agentDir, fileName), "utf8")) as {
		tools: string[];
		future?: unknown;
	};
}
