import assert from "node:assert/strict";
import {
	existsSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createMockContext, createMockPi, driveCustomSelector } from "../../../test/support.js";
import firecrawl, {
	cleanObject,
	commandCompletions,
	formatPayload,
	formatPersistedSelection,
	installSettingsFileExclusively,
	jsonResult,
	normalizeApiUrl,
	normalizeFirecrawlSettings,
	orderedFirecrawlTools,
	parseCommand,
	parseResponseBody,
} from "../src/firecrawl.js";

const NEW_SETTINGS_FILE = "pi-firecrawl.json";
const LEGACY_SETTINGS_FILE = "pi-firecrawl-settings.json";
const SCRAPE_TOOL = "firecrawl_scrape";
const CRAWL_TOOL = "firecrawl_crawl";
const MAP_TOOL = "firecrawl_map";
const SEARCH_TOOL = "firecrawl_search";

test("firecrawl registers all tools and command", () => {
	const mock = createMockPi();
	firecrawl(mock.pi);

	assert.deepEqual(
		mock.tools.map((tool) => tool.name),
		[
			"firecrawl_scrape",
			"firecrawl_crawl",
			"firecrawl_crawl_status",
			"firecrawl_map",
			"firecrawl_search",
		],
	);
	assert.ok(mock.commands.has("firecrawl"));
	assert.deepEqual([...mock.events.keys()].sort(), ["session_shutdown", "session_start"]);
});

test("firecrawl command parsing and completions cover aliases", () => {
	assert.equal(parseCommand(""), "menu");
	assert.equal(parseCommand("quickstart"), "quickstart");
	assert.equal(parseCommand("select"), "tools");
	assert.equal(parseCommand("on"), "enable");
	assert.equal(parseCommand("off"), "disable");
	assert.equal(parseCommand("wat"), "unknown");
	assert.deepEqual(commandCompletions("con"), [
		{ value: "config", label: "config", description: "Show configuration quick start" },
	]);
	assert.equal(commandCompletions("config "), null);
	assert.equal(commandCompletions("config now"), null);
});

test("firecrawl settings normalize ordered unique valid tool names", () => {
	assert.deepEqual(
		normalizeFirecrawlSettings({
			tools: ["firecrawl_search", "firecrawl_scrape", "firecrawl_search"],
			updatedAt: 1,
		}),
		{ tools: ["firecrawl_scrape", "firecrawl_search"], updatedAt: 1 },
	);
	assert.equal(normalizeFirecrawlSettings({ tools: ["bad"], updatedAt: 1 }), undefined);
	assert.deepEqual(orderedFirecrawlTools(new Set(["firecrawl_search", "firecrawl_map"])), [
		"firecrawl_map",
		"firecrawl_search",
	]);
});

test("firecrawl helpers trim URLs, parse payloads, and remove undefined fields", () => {
	assert.equal(normalizeApiUrl(" https://example.test/v1/// "), "https://example.test/v1");
	assert.equal(normalizeApiUrl(undefined), "https://api.firecrawl.dev/v1");
	assert.deepEqual(parseResponseBody('{"ok":true}'), { ok: true });
	assert.equal(parseResponseBody("not json"), "not json");
	assert.equal(formatPayload({ ok: true }), '{"ok":true}');
	assert.deepEqual(jsonResult({ ok: true }), {
		content: [{ type: "text", text: '{\n  "ok": true\n}' }],
		details: { ok: true },
	});
	assert.deepEqual(
		cleanObject({
			keep: false,
			drop: undefined,
			nested: { drop: undefined, value: null },
			list: [undefined, 1],
		}),
		{ keep: false, nested: { value: null }, list: [undefined, 1] },
	);
});

test("formatPersistedSelection summarizes all, none, and partial selections", () => {
	assert.equal(formatPersistedSelection([]), "all disabled (0/5 selected)");
	assert.equal(formatPersistedSelection(["firecrawl_scrape"]), "1/5 selected: firecrawl_scrape");
});

test("firecrawl installs migrated settings exclusively without leaving temp files", async () => {
	await withTempAgentDir(async (agentDir) => {
		const settingsPath = path.join(agentDir, NEW_SETTINGS_FILE);
		await installSettingsFileExclusively(settingsPath, "first\n");

		await assert.rejects(
			installSettingsFileExclusively(settingsPath, "replacement\n"),
			(error: NodeJS.ErrnoException) => error.code === "EEXIST",
		);

		assert.equal(readFileSync(settingsPath, "utf8"), "first\n");
		assert.deepEqual(readdirSync(agentDir), [NEW_SETTINGS_FILE]);
	});
});

test("firecrawl preserves active tools when settings are missing", async () => {
	await withTempAgentDir(async () => {
		const firecrawlModule = await importFreshFirecrawl();
		const mock = createMockPi({ activeTools: ["other_tool", SEARCH_TOOL] });
		const { ctx, notifications } = createMockContext();

		firecrawlModule.default(mock.pi);
		await mock.events.get("session_start")?.[0]?.({}, ctx);

		assert.deepEqual(mock.rawPi.getActiveTools(), ["other_tool", SEARCH_TOOL]);
		assert.deepEqual(notifications, []);
	});
});

test("firecrawl loads the new settings file without a migration warning", async () => {
	await withTempAgentDir(async (agentDir) => {
		writeSettings(agentDir, NEW_SETTINGS_FILE, [MAP_TOOL]);
		const firecrawlModule = await importFreshFirecrawl();
		const mock = createMockPi({ activeTools: ["other_tool", SCRAPE_TOOL] });
		const { ctx, notifications } = createMockContext();

		firecrawlModule.default(mock.pi);
		await mock.events.get("session_start")?.[0]?.({}, ctx);

		assert.deepEqual(mock.rawPi.getActiveTools(), ["other_tool", MAP_TOOL]);
		assert.deepEqual(notifications, []);
	});
});

test("firecrawl migrates a legacy-only settings file and warns", async () => {
	await withTempAgentDir(async (agentDir) => {
		writeSettings(agentDir, LEGACY_SETTINGS_FILE, [SCRAPE_TOOL]);
		const firecrawlModule = await importFreshFirecrawl();
		const mock = createMockPi({ activeTools: ["other_tool", MAP_TOOL] });
		const { ctx, notifications } = createMockContext();

		firecrawlModule.default(mock.pi);
		await mock.events.get("session_start")?.[0]?.({}, ctx);

		assert.deepEqual(mock.rawPi.getActiveTools(), ["other_tool", SCRAPE_TOOL]);
		assert.deepEqual(readSettings(agentDir, NEW_SETTINGS_FILE).tools, [SCRAPE_TOOL]);
		assert.equal(existsSync(path.join(agentDir, LEGACY_SETTINGS_FILE)), false);
		assert.match(notifications[0]?.message ?? "", /migrated/i);
		assert.match(notifications[0]?.message ?? "", /pi-firecrawl-settings\.json/);
		assert.match(notifications[0]?.message ?? "", /pi-firecrawl\.json/);

		await mock.commands.get("firecrawl")?.handler("disable", ctx);
		await mock.commands.get("firecrawl")?.handler("status", ctx);
		assert.match(notifications.at(-1)?.message ?? "", /migrated/i);
	});
});

test("firecrawl falls back to valid legacy settings when migration fails", async () => {
	await withTempAgentDir(async (agentDir) => {
		writeSettings(agentDir, LEGACY_SETTINGS_FILE, [SCRAPE_TOOL]);
		symlinkSync("missing-firecrawl-settings-target", path.join(agentDir, NEW_SETTINGS_FILE));
		const firecrawlModule = await importFreshFirecrawl();
		const mock = createMockPi({ activeTools: ["other_tool", MAP_TOOL] });
		const { ctx, notifications } = createMockContext();

		firecrawlModule.default(mock.pi);
		await mock.events.get("session_start")?.[0]?.({}, ctx);

		assert.deepEqual(mock.rawPi.getActiveTools(), ["other_tool", SCRAPE_TOOL]);
		assert.equal(existsSync(path.join(agentDir, LEGACY_SETTINGS_FILE)), true);
		assert.match(notifications[0]?.message ?? "", /migration failed/i);
		assert.match(notifications[0]?.message ?? "", /legacy file was used for this session/i);
	});
});

test("firecrawl prefers new settings created while legacy settings are loading", async () => {
	await withTempAgentDir(async (agentDir) => {
		writeSettings(agentDir, LEGACY_SETTINGS_FILE, [SCRAPE_TOOL]);
		const firecrawlModule = await importFreshFirecrawl();
		const mock = createMockPi({ activeTools: ["other_tool", MAP_TOOL] });
		const { ctx, notifications } = createMockContext();

		firecrawlModule.default(mock.pi);
		const sessionStart = mock.events.get("session_start")?.[0]?.({}, ctx);
		writeSettings(agentDir, NEW_SETTINGS_FILE, [SEARCH_TOOL]);
		await sessionStart;

		assert.deepEqual(mock.rawPi.getActiveTools(), ["other_tool", SEARCH_TOOL]);
		assert.deepEqual(readSettings(agentDir, NEW_SETTINGS_FILE).tools, [SEARCH_TOOL]);
		assert.equal(existsSync(path.join(agentDir, LEGACY_SETTINGS_FILE)), true);
		assert.match(notifications[0]?.message ?? "", /legacy settings ignored/i);
	});
});

test("firecrawl prefers new settings when both files exist and reports legacy ignored", async () => {
	await withTempAgentDir(async (agentDir) => {
		writeSettings(agentDir, NEW_SETTINGS_FILE, [SEARCH_TOOL]);
		writeSettings(agentDir, LEGACY_SETTINGS_FILE, [SCRAPE_TOOL]);
		const firecrawlModule = await importFreshFirecrawl();
		const mock = createMockPi({ activeTools: ["other_tool", MAP_TOOL] });
		const { ctx, notifications } = createMockContext();

		firecrawlModule.default(mock.pi);
		await mock.events.get("session_start")?.[0]?.({}, ctx);
		await mock.commands.get("firecrawl")?.handler("status", ctx);

		assert.deepEqual(mock.rawPi.getActiveTools(), ["other_tool", SEARCH_TOOL]);
		assert.deepEqual(readSettings(agentDir, NEW_SETTINGS_FILE).tools, [SEARCH_TOOL]);
		assert.equal(existsSync(path.join(agentDir, LEGACY_SETTINGS_FILE)), true);
		assert.match(notifications[0]?.message ?? "", /legacy settings ignored/i);
		const statusMessage = notifications.at(-1)?.message ?? "";
		assert.match(statusMessage, /Settings file: .*pi-firecrawl\.json/);
		assert.match(statusMessage, /legacy settings ignored/i);
	});
});

test("firecrawl ignores invalid legacy settings without creating the new file", async () => {
	await withTempAgentDir(async (agentDir) => {
		writeFileSync(
			path.join(agentDir, LEGACY_SETTINGS_FILE),
			JSON.stringify({ tools: ["bad"], updatedAt: 1 }),
		);
		const firecrawlModule = await importFreshFirecrawl();
		const mock = createMockPi({ activeTools: ["other_tool", MAP_TOOL] });
		const { ctx, notifications } = createMockContext();

		firecrawlModule.default(mock.pi);
		await mock.events.get("session_start")?.[0]?.({}, ctx);

		assert.deepEqual(mock.rawPi.getActiveTools(), ["other_tool", MAP_TOOL]);
		assert.equal(existsSync(path.join(agentDir, NEW_SETTINGS_FILE)), false);
		assert.match(notifications[0]?.message ?? "", /settings ignored/i);
		assert.match(notifications[0]?.message ?? "", /pi-firecrawl-settings\.json/);
	});
});

test("firecrawl does not fall back to legacy settings when the new file is invalid", async () => {
	await withTempAgentDir(async (agentDir) => {
		writeFileSync(
			path.join(agentDir, NEW_SETTINGS_FILE),
			JSON.stringify({ tools: ["bad"], updatedAt: 1 }),
		);
		writeSettings(agentDir, LEGACY_SETTINGS_FILE, [SCRAPE_TOOL]);
		const firecrawlModule = await importFreshFirecrawl();
		const mock = createMockPi({ activeTools: ["other_tool", MAP_TOOL] });
		const { ctx, notifications } = createMockContext();

		firecrawlModule.default(mock.pi);
		await mock.events.get("session_start")?.[0]?.({}, ctx);

		assert.deepEqual(mock.rawPi.getActiveTools(), ["other_tool", MAP_TOOL]);
		assert.equal(existsSync(path.join(agentDir, LEGACY_SETTINGS_FILE)), true);
		assert.match(notifications[0]?.message ?? "", /legacy settings ignored/i);
		assert.match(notifications[1]?.message ?? "", /settings ignored/i);
		assert.match(notifications[1]?.message ?? "", /pi-firecrawl\.json/);
	});
});

test("Firecrawl tool selection keeps the cursor on the toggled row", async () => {
	await withTempAgentDir(async (agentDir) => {
		const mock = createMockPi({ activeTools: ["other_tool"] });
		firecrawl(mock.pi);
		const toolNames = mock.tools.map((tool) => String(tool.name));
		mock.rawPi.setActiveTools(["other_tool", ...toolNames]);
		const { ctx } = createMockContext({
			hasUI: true,
			custom: async (factory: unknown) => {
				const { renders, result } = driveCustomSelector(factory, [
					"tui.select.down",
					"tui.select.confirm",
					"tui.select.cancel",
				]);
				assert.ok(renders[1]?.some((line) => line.includes("› [ ] firecrawl_crawl")));
				return result;
			},
		});
		await mock.commands.get("firecrawl")?.handler("tools", ctx);

		assert.deepEqual(mock.rawPi.getActiveTools(), [
			"other_tool",
			...toolNames.filter((name) => name !== CRAWL_TOOL),
		]);
		assert.deepEqual(
			readSettings(agentDir, NEW_SETTINGS_FILE).tools,
			toolNames.filter((name) => name !== CRAWL_TOOL),
		);
	});
});

test("firecrawl saves tool selection only to the new settings file", async () => {
	await withTempAgentDir(async (agentDir) => {
		const firecrawlModule = await importFreshFirecrawl();
		const mock = createMockPi({ activeTools: ["other_tool", CRAWL_TOOL] });
		const { ctx, notifications } = createMockContext();

		firecrawlModule.default(mock.pi);
		await mock.commands.get("firecrawl")?.handler("disable", ctx);

		assert.deepEqual(mock.rawPi.getActiveTools(), ["other_tool"]);
		assert.deepEqual(readSettings(agentDir, NEW_SETTINGS_FILE).tools, []);
		assert.equal(existsSync(path.join(agentDir, LEGACY_SETTINGS_FILE)), false);
		assert.match(notifications[0]?.message ?? "", /Settings file: .*pi-firecrawl\.json/);
	});
});

let importCounter = 0;

async function importFreshFirecrawl() {
	return (await import(
		`../src/firecrawl.js?settings-test=${Date.now()}-${importCounter++}`
	)) as typeof import("../src/firecrawl.js");
}

async function withTempAgentDir<T>(fn: (agentDir: string) => Promise<T>) {
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	const agentDir = mkdtempSync(path.join(os.tmpdir(), "pi-firecrawl-settings-"));
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
