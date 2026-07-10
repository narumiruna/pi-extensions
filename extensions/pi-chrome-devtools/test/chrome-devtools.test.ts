import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createMockContext, createMockPi } from "../../../test/support.js";
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

test("chrome-devtools migrates a legacy-only settings file and warns", async () => {
	await withTempAgentDir(async (agentDir) => {
		writeSettings(agentDir, LEGACY_SETTINGS_FILE, [LIST_PAGES_TOOL]);
		const chromeDevtoolsModule = await importFreshChromeDevtools();
		const mock = createMockPi({ activeTools: ["other_tool", SCREENSHOT_TOOL] });
		const { ctx, notifications } = createMockContext();

		chromeDevtoolsModule.default(mock.pi);
		await mock.events.get("session_start")?.[0]?.({}, ctx);

		assert.deepEqual(mock.rawPi.getActiveTools(), ["other_tool", LIST_PAGES_TOOL]);
		assert.deepEqual(readSettings(agentDir, NEW_SETTINGS_FILE).tools, [LIST_PAGES_TOOL]);
		assert.equal(existsSync(path.join(agentDir, LEGACY_SETTINGS_FILE)), false);
		assert.match(notifications[0]?.message ?? "", /migrated/i);
		assert.match(notifications[0]?.message ?? "", /pi-chrome-devtools-settings\.json/);
		assert.match(notifications[0]?.message ?? "", /pi-chrome-devtools\.json/);
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
		const chromeDevtoolsModule = await importFreshChromeDevtools();
		const mock = createMockPi({ activeTools: ["other_tool", LIST_PAGES_TOOL] });
		const { ctx, notifications } = createMockContext();

		chromeDevtoolsModule.default(mock.pi);
		await mock.commands.get("chrome-devtools")?.handler("disable", ctx);

		assert.deepEqual(mock.rawPi.getActiveTools(), ["other_tool"]);
		assert.deepEqual(readSettings(agentDir, NEW_SETTINGS_FILE).tools, []);
		assert.equal(existsSync(path.join(agentDir, LEGACY_SETTINGS_FILE)), false);
		assert.match(notifications[0]?.message ?? "", /Settings file: .*pi-chrome-devtools\.json/);
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
	return JSON.parse(readFileSync(path.join(agentDir, fileName), "utf8")) as { tools: string[] };
}
