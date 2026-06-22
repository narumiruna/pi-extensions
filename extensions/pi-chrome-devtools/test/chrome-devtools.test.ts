import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createMockPi } from "../../../test/support.js";
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
			tools: [
				"chrome_devtools_screenshot",
				"chrome_devtools_list_pages",
				"chrome_devtools_screenshot",
			],
			updatedAt: 1,
		}),
		{ tools: ["chrome_devtools_list_pages", "chrome_devtools_screenshot"], updatedAt: 1 },
	);
	assert.equal(normalizeChromeDevtoolsSettings({ tools: ["bad"], updatedAt: 1 }), undefined);
	assert.deepEqual(orderedChromeDevtoolsTools(new Set(["chrome_devtools_evaluate"])), [
		"chrome_devtools_evaluate",
	]);
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
