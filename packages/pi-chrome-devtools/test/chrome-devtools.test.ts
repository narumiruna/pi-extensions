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
import { visibleWidth } from "@earendil-works/pi-tui";
import { test, vi } from "vitest";
import {
	createMockContext as createBaseMockContext,
	createCustomSelectorHarness,
	createMockPi,
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
	sanitizeChromeDevtoolsDisplay,
	selectAllowedRoot,
} from "../src/chrome-devtools.js";
import { saveSettings } from "../src/settings.js";

const NATIVE_DEFERRED_MODEL = {
	api: "openai-responses",
	provider: "openai",
	id: "gpt-5.4",
	compat: { supportsToolSearch: true },
};

function createMockContext(overrides: Record<string, unknown> = {}) {
	return createBaseMockContext({ model: NATIVE_DEFERRED_MODEL, ...overrides });
}

const NEW_SETTINGS_FILE = "pi-chrome-devtools.json";
const LEGACY_SETTINGS_FILE = "pi-chrome-devtools-settings.json";
const LIST_PAGES_TOOL = "chrome_devtools_list_pages";
const EVALUATE_TOOL = "chrome_devtools_evaluate";
const SCREENSHOT_TOOL = "chrome_devtools_screenshot";
const LOAD_TOOL = "chrome_devtools_load";
const CAPABILITY_TOOLS = [
	"chrome_devtools_list_pages",
	"chrome_devtools_select_page",
	"chrome_devtools_navigate",
	"chrome_devtools_evaluate",
	"chrome_devtools_screenshot",
] as const;

test("chrome-devtools factory registers without reading action methods", () => {
	const mock = createMockPi();
	mock.rawPi.getActiveTools = () => {
		throw new Error("must wait for session_start");
	};
	mock.rawPi.setActiveTools = () => {
		throw new Error("must wait for session_start");
	};

	assert.doesNotThrow(() => chromeDevtools(mock.pi));
	assert.ok(mock.events.has("session_start"));
});

test("chrome-devtools registers deferred CDP tools and one loader", () => {
	const mock = createMockPi();
	chromeDevtools(mock.pi);

	assert.equal(mock.tools.length, 6);
	assert.deepEqual(
		mock.tools.map((tool) => tool.name),
		[
			"chrome_devtools_list_pages",
			"chrome_devtools_select_page",
			"chrome_devtools_navigate",
			"chrome_devtools_evaluate",
			"chrome_devtools_screenshot",
			LOAD_TOOL,
		],
	);
	for (const tool of mock.tools.filter((candidate) => candidate.name !== LOAD_TOOL)) {
		assert.equal(tool.promptSnippet, undefined);
	}
	assert.ok(mock.commands.has("chrome-devtools"));
	assert.deepEqual([...mock.events.keys()].sort(), [
		"model_select",
		"session_shutdown",
		"session_start",
	]);
});

test("chrome-devtools command parsing and completions cover aliases", () => {
	assert.equal(parseCommand(""), "menu");
	assert.equal(parseCommand("toggle"), "tools");
	assert.equal(parseCommand("settings"), "settings");
	assert.equal(parseCommand("on"), "enable");
	assert.equal(parseCommand("off"), "disable");
	assert.equal(parseCommand("wat"), "unknown");
	assert.deepEqual(commandCompletions("qui"), [
		{ value: "quickstart", label: "quickstart", description: "Show endpoint and launch help" },
	]);
	assert.deepEqual(commandCompletions("set"), [
		{ value: "settings", label: "settings", description: "Edit browser connection settings" },
	]);
	assert.deepEqual(commandCompletions("sel"), [
		{ value: "select", label: "select", description: "Compatibility alias for tools" },
	]);
	assert.deepEqual(commandCompletions("of"), [
		{ value: "off", label: "off", description: "Compatibility alias for disable" },
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

test("chrome-devtools keeps only its loader active when settings are missing", async () => {
	await withTempAgentDir(async () => {
		const chromeDevtoolsModule = await importFreshChromeDevtools();
		const mock = createMockPi({ activeTools: ["other_tool", EVALUATE_TOOL] });
		const { ctx, notifications } = createMockContext();

		chromeDevtoolsModule.default(mock.pi);
		await mock.events.get("session_start")?.[0]?.({}, ctx);

		assert.deepEqual(mock.rawPi.getActiveTools(), ["other_tool", LOAD_TOOL]);
		assert.deepEqual(notifications, []);
	});
});

test("chrome-devtools loader additively activates matching allowed tools", async () => {
	await withTempAgentDir(async () => {
		const chromeDevtoolsModule = await importFreshChromeDevtools();
		const mock = createMockPi({ activeTools: ["other_tool", ...CAPABILITY_TOOLS] });
		const { ctx } = createMockContext();
		chromeDevtoolsModule.default(mock.pi);
		await mock.events.get("session_start")?.[0]?.({}, ctx);
		const loader = mock.tools.find((tool) => tool.name === LOAD_TOOL) as {
			execute: (...args: unknown[]) => Promise<{
				details: { matches: string[]; added: string[] };
			}>;
		};

		const first = await loader.execute(
			"loader-1",
			{ query: "capture a screenshot" },
			new AbortController().signal,
			undefined,
			ctx,
		);
		assert.deepEqual(first.details, { matches: [SCREENSHOT_TOOL], added: [SCREENSHOT_TOOL] });
		assert.deepEqual(mock.rawPi.getActiveTools(), ["other_tool", LOAD_TOOL, SCREENSHOT_TOOL]);

		const second = await loader.execute(
			"loader-2",
			{ query: "capture a screenshot" },
			new AbortController().signal,
			undefined,
			ctx,
		);
		assert.deepEqual(second.details, { matches: [SCREENSHOT_TOOL], added: [] });
		assert.deepEqual(mock.rawPi.getActiveTools(), ["other_tool", LOAD_TOOL, SCREENSHOT_TOOL]);
	});
});

test("chrome-devtools keeps Azure Responses eager when compat enables tool search", async () => {
	await withTempAgentDir(async () => {
		const chromeDevtoolsModule = await importFreshChromeDevtools();
		const unsupportedModel = {
			api: "azure-openai-responses",
			provider: "azure-openai-responses",
			id: "gpt-5.4",
			compat: { supportsToolSearch: true },
		};
		const nativeModel = {
			api: "openai-responses",
			provider: "openai",
			id: "gpt-5.4",
			compat: { supportsToolSearch: true },
		};
		const mock = createMockPi({ activeTools: ["other_tool", ...CAPABILITY_TOOLS] });
		const { ctx } = createMockContext({ model: unsupportedModel });
		chromeDevtoolsModule.default(mock.pi);
		await mock.events.get("session_start")?.[0]?.({}, ctx);
		assert.deepEqual(mock.rawPi.getActiveTools(), ["other_tool", LOAD_TOOL, ...CAPABILITY_TOOLS]);

		await mock.events.get("model_select")?.[0]?.({ model: nativeModel }, ctx);
		assert.deepEqual(mock.rawPi.getActiveTools(), ["other_tool", LOAD_TOOL, ...CAPABILITY_TOOLS]);
	});
});

test("chrome-devtools keeps uppercase Anthropic model IDs eager", async () => {
	await withTempAgentDir(async () => {
		const chromeDevtoolsModule = await importFreshChromeDevtools();
		const model = {
			api: "anthropic-messages",
			provider: "anthropic",
			id: "CLAUDE-SONNET-4-5",
		};
		const mock = createMockPi({ activeTools: ["other_tool", ...CAPABILITY_TOOLS] });
		const { ctx } = createMockContext({ model });
		chromeDevtoolsModule.default(mock.pi);

		await mock.events.get("session_start")?.[0]?.({}, ctx);

		assert.deepEqual(mock.rawPi.getActiveTools(), ["other_tool", LOAD_TOOL, ...CAPABILITY_TOOLS]);
	});
});

test("chrome-devtools honors native Kimi deferred-tool support", async () => {
	await withTempAgentDir(async () => {
		const chromeDevtoolsModule = await importFreshChromeDevtools();
		const model = {
			api: "openai-completions",
			provider: "moonshotai",
			id: "kimi-k2.6",
			compat: { deferredToolsMode: "kimi" },
		};
		const mock = createMockPi({ activeTools: ["other_tool", ...CAPABILITY_TOOLS] });
		const { ctx } = createMockContext({ model });
		chromeDevtoolsModule.default(mock.pi);

		await mock.events.get("session_start")?.[0]?.({}, ctx);

		assert.deepEqual(mock.rawPi.getActiveTools(), ["other_tool", LOAD_TOOL]);
	});
});

test("chrome-devtools honors native additional-tools support", async () => {
	await withTempAgentDir(async () => {
		for (const api of ["openai-responses", "openai-codex-responses"]) {
			const chromeDevtoolsModule = await importFreshChromeDevtools();
			const model = {
				api,
				provider: api === "openai-responses" ? "openai" : "openai-codex",
				id: "gpt-5.4",
				compat: { supportsAdditionalTools: true },
			};
			const mock = createMockPi({ activeTools: ["other_tool", ...CAPABILITY_TOOLS] });
			const { ctx } = createMockContext({ model });
			chromeDevtoolsModule.default(mock.pi);

			await mock.events.get("session_start")?.[0]?.({}, ctx);

			assert.deepEqual(mock.rawPi.getActiveTools(), ["other_tool", LOAD_TOOL]);
		}
	});
});

test("chrome-devtools activates every available tool before switching to an unsupported model", async () => {
	await withTempAgentDir(async () => {
		const chromeDevtoolsModule = await importFreshChromeDevtools();
		const nativeModel = {
			api: "anthropic-messages",
			provider: "anthropic",
			id: "claude-sonnet-4-5",
		};
		const unsupportedModel = {
			api: "anthropic-messages",
			provider: "anthropic",
			id: "claude-haiku-4-5",
		};
		const mock = createMockPi({ activeTools: ["other_tool", ...CAPABILITY_TOOLS] });
		const { ctx } = createMockContext({ model: nativeModel });
		chromeDevtoolsModule.default(mock.pi);
		await mock.events.get("session_start")?.[0]?.({}, ctx);
		assert.deepEqual(mock.rawPi.getActiveTools(), ["other_tool", LOAD_TOOL]);

		await mock.events.get("model_select")?.[0]?.({ model: unsupportedModel }, ctx);
		assert.deepEqual(mock.rawPi.getActiveTools(), ["other_tool", LOAD_TOOL, ...CAPABILITY_TOOLS]);
	});
});

test("chrome-devtools keeps its missing-settings catalog across session replacement", async () => {
	await withTempAgentDir(async () => {
		const chromeDevtoolsModule = await importFreshChromeDevtools();
		const mock = createMockPi({ activeTools: ["other_tool", ...CAPABILITY_TOOLS] });
		const { ctx } = createMockContext();
		chromeDevtoolsModule.default(mock.pi);
		const sessionStart = mock.events.get("session_start")?.[0];
		await sessionStart?.({}, ctx);
		const loader = mock.tools.find((tool) => tool.name === LOAD_TOOL) as {
			execute: (...args: unknown[]) => Promise<{
				details: { matches: string[]; added: string[] };
			}>;
		};

		await loader.execute(
			"loader-1",
			{ query: "capture a screenshot" },
			new AbortController().signal,
			undefined,
			ctx,
		);
		await sessionStart?.({}, ctx);
		const result = await loader.execute(
			"loader-2",
			{ query: "evaluate JavaScript" },
			new AbortController().signal,
			undefined,
			ctx,
		);

		assert.deepEqual(result.details, { matches: [EVALUATE_TOOL], added: [EVALUATE_TOOL] });
	});
});

test("chrome-devtools loader does not expose tools outside the saved catalog", async () => {
	await withTempAgentDir(async (agentDir) => {
		writeSettings(agentDir, NEW_SETTINGS_FILE, [SCREENSHOT_TOOL]);
		const chromeDevtoolsModule = await importFreshChromeDevtools();
		const mock = createMockPi({ activeTools: ["other_tool", EVALUATE_TOOL, SCREENSHOT_TOOL] });
		const { ctx } = createMockContext();
		chromeDevtoolsModule.default(mock.pi);
		await mock.events.get("session_start")?.[0]?.({}, ctx);
		const loader = mock.tools.find((tool) => tool.name === LOAD_TOOL) as {
			execute: (...args: unknown[]) => Promise<{
				details: { matches: string[]; added: string[] };
			}>;
		};

		const result = await loader.execute(
			"loader-1",
			{ query: "evaluate JavaScript" },
			new AbortController().signal,
			undefined,
			ctx,
		);

		assert.deepEqual(result.details, { matches: [], added: [] });
		assert.deepEqual(mock.rawPi.getActiveTools(), ["other_tool", LOAD_TOOL]);

		const genericResult = await loader.execute(
			"loader-2",
			{ query: "browser" },
			new AbortController().signal,
			undefined,
			ctx,
		);
		assert.deepEqual(genericResult.details, {
			matches: [SCREENSHOT_TOOL],
			added: [SCREENSHOT_TOOL],
		});
	});
});

test("chrome-devtools loads the new settings file as the tool catalog without a warning", async () => {
	await withTempAgentDir(async (agentDir) => {
		writeSettings(agentDir, NEW_SETTINGS_FILE, [SCREENSHOT_TOOL]);
		const chromeDevtoolsModule = await importFreshChromeDevtools();
		const mock = createMockPi({ activeTools: ["other_tool", LIST_PAGES_TOOL] });
		const { ctx, notifications } = createMockContext();

		chromeDevtoolsModule.default(mock.pi);
		await mock.events.get("session_start")?.[0]?.({}, ctx);

		assert.deepEqual(mock.rawPi.getActiveTools(), ["other_tool", LOAD_TOOL]);
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

		assert.deepEqual(mock.rawPi.getActiveTools(), ["other_tool", LOAD_TOOL]);
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

		assert.deepEqual(mock.rawPi.getActiveTools(), ["other_tool", LOAD_TOOL]);
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
		const { ctx, notifications } = createMockContext({ mode: "rpc", hasUI: true });

		chromeDevtoolsModule.default(mock.pi);
		await mock.events.get("session_start")?.[0]?.({}, ctx);
		await mock.commands.get("chrome-devtools")?.handler("status", ctx);

		assert.deepEqual(mock.rawPi.getActiveTools(), ["other_tool", LOAD_TOOL]);
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

		assert.deepEqual(mock.rawPi.getActiveTools(), ["other_tool", LOAD_TOOL]);
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

		assert.deepEqual(mock.rawPi.getActiveTools(), ["other_tool", LOAD_TOOL]);
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

		assert.deepEqual(mock.rawPi.getActiveTools(), ["other_tool", LOAD_TOOL]);
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
		assert.deepEqual(mock.rawPi.getActiveTools(), ["other_tool", LOAD_TOOL, LIST_PAGES_TOOL]);
		assert.match(notifications.at(-1)?.message ?? "", /settings save failed/i);

		writeSettings(agentDir, NEW_SETTINGS_FILE, [LIST_PAGES_TOOL]);
		await mock.commands.get("chrome-devtools")?.handler("disable", ctx);
		assert.deepEqual(readSettings(agentDir, NEW_SETTINGS_FILE).tools, []);
	});
});

test("chrome-devtools keeps failed-save rollback eager after an unsupported model switch", async () => {
	await withTempAgentDir(async (agentDir) => {
		const settingsPath = path.join(agentDir, NEW_SETTINGS_FILE);
		writeFileSync(settingsPath, '{"tools":["invalid"]}\n');
		const chromeDevtoolsModule = await importFreshChromeDevtools();
		const mock = createMockPi({ activeTools: ["other_tool", ...CAPABILITY_TOOLS] });
		const { ctx, notifications } = createMockContext();
		chromeDevtoolsModule.default(mock.pi);
		await mock.events.get("session_start")?.[0]?.({}, ctx);
		assert.deepEqual(mock.rawPi.getActiveTools(), ["other_tool", LOAD_TOOL]);

		let markRuntimeApply: (() => void) | undefined;
		const runtimeApplied = new Promise<void>((resolve) => {
			markRuntimeApply = resolve;
		});
		const setActiveTools = mock.rawPi.setActiveTools.bind(mock.rawPi);
		mock.rawPi.setActiveTools = (names) => {
			setActiveTools(names);
			markRuntimeApply?.();
			markRuntimeApply = undefined;
		};

		const command = mock.commands.get("chrome-devtools")?.handler("disable", ctx);
		await runtimeApplied;
		await mock.events.get("model_select")?.[0]?.(
			{
				model: {
					api: "anthropic-messages",
					provider: "anthropic",
					id: "claude-haiku-4-5",
				},
			},
			ctx,
		);
		await command;

		assert.deepEqual(mock.rawPi.getActiveTools(), ["other_tool", LOAD_TOOL, ...CAPABILITY_TOOLS]);
		assert.match(notifications.at(-1)?.message ?? "", /settings save failed/i);
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
		assert.deepEqual(mock.rawPi.getActiveTools(), ["other_tool", LOAD_TOOL]);
		const shutdown = mock.events.get("session_shutdown")?.[0]?.({}, ctx);

		await Promise.all([command, shutdown]);
		assert.deepEqual(mock.rawPi.getActiveTools(), ["other_tool", LOAD_TOOL, LIST_PAGES_TOOL]);
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

		assert.deepEqual(mock.rawPi.getActiveTools(), ["other_tool", LOAD_TOOL]);
		assert.deepEqual(readSettings(agentDir, NEW_SETTINGS_FILE).tools, []);
	});
});

test("status display strips terminal controls and remains bounded", () => {
	assert.equal(
		sanitizeChromeDevtoolsDisplay("safe\u001b]8;;https://evil\u0007link\u001b]8;;\u0007"),
		"safelink",
	);
	assert.equal(sanitizeChromeDevtoolsDisplay("12345", 4), "123…");
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
	const renders: string[][] = [];
	const { ctx, notifications } = createMockContext({
		hasUI: true,
		mode: "tui",
		custom: async (factory: unknown) => {
			const harness = createCustomSelectorHarness(factory, 20);
			if (!harness.isPiTuiKitScreen) return harness.resultPromise;
			renders.push(harness.render());
			harness.handleInput("tui.select.cancel");
			return harness.result;
		},
	});
	await mock.commands.get("chrome-devtools")?.handler("", ctx);
	assert.ok(renders.flat().every((line) => visibleWidth(line) <= 20));
	assert.match(renders.flat().join("\n"), /Tool catalog: 0 of 5/);
	assert.deepEqual(notifications, []);
});

test("Chrome DevTools tool selection keeps the cursor on the staged row", async () => {
	await withTempAgentDir(async (agentDir) => {
		const initialTools = ["other_tool", ...CAPABILITY_TOOLS, LOAD_TOOL];
		const mock = createMockPi({ activeTools: initialTools });
		chromeDevtools(mock.pi);
		let toolScreen = 0;
		let refreshed = "";
		const { ctx } = createMockContext({
			hasUI: true,
			mode: "tui",
			custom: async (factory: unknown) => {
				const harness = createCustomSelectorHarness(factory, 80);
				if (!harness.isPiTuiKitScreen) return harness.resultPromise;
				toolScreen += 1;
				if (toolScreen === 1) {
					harness.handleInput("tui.select.down");
					harness.handleInput("tui.select.confirm");
				} else {
					refreshed = harness.render().join("\n");
					harness.handleInput("\u0003");
				}
				return harness.resultPromise;
			},
		});
		await mock.commands.get("chrome-devtools")?.handler("tools", ctx);

		assert.match(refreshed, /[→›] \[ \] Select the active page/);
		assert.deepEqual(mock.rawPi.getActiveTools(), initialTools);
		assert.equal(existsSync(path.join(agentDir, NEW_SETTINGS_FILE)), false);
	});
});

test("Chrome DevTools tool selection refreshes dynamic draft state after a toggle", async () => {
	await withTempAgentDir(async () => {
		const mock = createMockPi({ activeTools: ["other_tool", ...CAPABILITY_TOOLS, LOAD_TOOL] });
		chromeDevtools(mock.pi);
		let toolScreens = 0;
		let refreshed = "";
		const { ctx } = createMockContext({
			hasUI: true,
			mode: "tui",
			custom: async (factory: unknown) => {
				const harness = createCustomSelectorHarness(factory, 80);
				if (!harness.isPiTuiKitScreen) return harness.resultPromise;
				toolScreens += 1;
				if (toolScreens === 1) harness.handleInput("tui.select.confirm");
				else {
					refreshed = harness.render().join("\n");
					harness.handleInput("\u0003");
				}
				return harness.resultPromise;
			},
		});
		await mock.commands.get("chrome-devtools")?.handler("tools", ctx);
		assert.equal(toolScreens, 2);
		assert.match(refreshed, /Browser tools \(4\/5\)/);
		assert.match(refreshed, /1 unapplied change/);
	});
});

test("Chrome DevTools tool selection stays within narrow terminal widths", async () => {
	await withTempAgentDir(async () => {
		const mock = createMockPi({ activeTools: ["other_tool"] });
		chromeDevtools(mock.pi);
		const renders: string[][] = [];
		const { ctx } = createMockContext({
			hasUI: true,
			mode: "tui",
			custom: async (factory: unknown) => {
				const harness = createCustomSelectorHarness(factory, 20);
				if (!harness.isPiTuiKitScreen) return harness.resultPromise;
				renders.push(harness.render());
				harness.handleInput("\u0003");
				return harness.result;
			},
		});
		await mock.commands.get("chrome-devtools")?.handler("tools", ctx);
		assert.ok(renders.flat().every((line) => visibleWidth(line) <= 20));
	});
});

test("Chrome DevTools tool selection uses dialogs instead of custom TUI in RPC mode", async () => {
	await withTempAgentDir(async () => {
		const mock = createMockPi({ activeTools: ["other_tool"] });
		chromeDevtools(mock.pi);
		let selectCalls = 0;
		let customCalls = 0;
		const { ctx } = createMockContext({
			hasUI: true,
			mode: "rpc",
			select: async () => {
				selectCalls += 1;
				return undefined;
			},
			custom: async () => {
				customCalls += 1;
			},
		});

		await mock.commands.get("chrome-devtools")?.handler("tools", ctx);

		assert.equal(selectCalls, 1);
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

async function importFreshChromeDevtools() {
	vi.resetModules();
	return import("../src/chrome-devtools.js");
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
