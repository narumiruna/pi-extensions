import assert from "node:assert/strict";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import os from "node:os";
import path, { dirname } from "node:path";
import test from "node:test";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { createMockContext, createMockPi, driveCustomSelector } from "../../../test/support.js";
import firecrawl, {
	cleanObject,
	cleanupResponseArtifacts,
	commandCompletions,
	firecrawlRequest,
	formatPayload,
	formatPersistedSelection,
	jsonResult,
	normalizeApiUrl,
	normalizeFirecrawlSettings,
	orderedFirecrawlTools,
	parseCommand,
	parseResponseBody,
} from "../src/firecrawl.js";
import { saveSettings } from "../src/settings.js";

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

test("firecrawl helpers trim URLs, parse payloads, and remove undefined fields", async () => {
	assert.equal(normalizeApiUrl(" https://example.test/v1/// "), "https://example.test/v1");
	assert.equal(normalizeApiUrl(undefined), "https://api.firecrawl.dev/v1");
	assert.deepEqual(parseResponseBody('{"ok":true}'), { ok: true });
	assert.equal(parseResponseBody("not json"), "not json");
	assert.equal(formatPayload({ ok: true }), '{"ok":true}');
	assert.deepEqual(await jsonResult({ ok: true }, {}), {
		content: [{ type: "text", text: '{\n  "ok": true\n}' }],
		details: {
			truncated: false,
			totalLines: 3,
			totalBytes: 16,
			outputLines: 3,
			outputBytes: 16,
		},
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

test("jsonResult bounds byte-heavy UTF-8 output and saves the exact full response privately", async () => {
	const artifactOwner = {};
	const payload = { markdown: "界".repeat(DEFAULT_MAX_BYTES) };
	const serialized = JSON.stringify(payload, null, 2);
	const result = await jsonResult(payload, artifactOwner);
	const text = result.content[0].text;

	assert.ok(Buffer.byteLength(text, "utf8") <= DEFAULT_MAX_BYTES);
	assert.ok(text.split("\n").length <= DEFAULT_MAX_LINES);
	assert.match(text, /Output truncated/);
	assert.equal(result.details.truncated, true);
	assert.ok(result.details.fullResponsePath);
	assert.equal(readFileSync(result.details.fullResponsePath, "utf8"), serialized);
	assert.equal(statSync(dirname(result.details.fullResponsePath)).mode & 0o777, 0o700);
	assert.equal(statSync(result.details.fullResponsePath).mode & 0o777, 0o600);
	assert.equal("markdown" in result.details, false);

	await cleanupResponseArtifacts(artifactOwner);
});

test("jsonResult bounds line-heavy output including its truncation footer", async () => {
	const artifactOwner = {};
	const payload = Array.from({ length: DEFAULT_MAX_LINES + 100 }, (_, index) => ({ index }));
	const result = await jsonResult(payload, artifactOwner);
	const text = result.content[0].text;

	assert.ok(Buffer.byteLength(text, "utf8") <= DEFAULT_MAX_BYTES);
	assert.ok(text.split("\n").length <= DEFAULT_MAX_LINES);
	assert.match(text, /showing \d+ of \d+ lines/);
	assert.equal(result.details.truncated, true);

	await cleanupResponseArtifacts(artifactOwner);
});

test("jsonResult fits its final footer when a multiline response crosses size units", async () => {
	const artifactOwner = {};
	const payload = {
		lines: Array.from({ length: 15_000 }, () => "x".repeat(80)),
	};
	const result = await jsonResult(payload, artifactOwner);
	const text = result.content[0].text;

	assert.ok(result.details.totalBytes > 1024 * 1024);
	assert.ok(Buffer.byteLength(text, "utf8") <= DEFAULT_MAX_BYTES);
	assert.ok(text.split("\n").length <= DEFAULT_MAX_LINES);
	assert.match(text, /Output truncated/);

	await cleanupResponseArtifacts(artifactOwner);
});

test("jsonResult gives concurrent truncated responses unique artifact paths", async () => {
	const artifactOwner = {};
	const payload = { value: "x".repeat(DEFAULT_MAX_BYTES + 1) };
	const [first, second] = await Promise.all([
		jsonResult(payload, artifactOwner),
		jsonResult(payload, artifactOwner),
	]);

	assert.ok(first.details.fullResponsePath);
	assert.ok(second.details.fullResponsePath);
	assert.notEqual(first.details.fullResponsePath, second.details.fullResponsePath);

	await cleanupResponseArtifacts(artifactOwner);
});

test("response artifact cleanup is isolated by session owner", async () => {
	const firstOwner = {};
	const secondOwner = {};
	const payload = { value: "x".repeat(DEFAULT_MAX_BYTES + 1) };
	const [first, second] = await Promise.all([
		jsonResult(payload, firstOwner),
		jsonResult(payload, secondOwner),
	]);
	assert.ok(first.details.fullResponsePath);
	assert.ok(second.details.fullResponsePath);

	await cleanupResponseArtifacts(firstOwner);

	assert.equal(existsSync(first.details.fullResponsePath), false);
	assert.equal(existsSync(second.details.fullResponsePath), true);
	await cleanupResponseArtifacts(secondOwner);
});

test("cleanup waits for an in-flight artifact write owned by that session", async () => {
	const artifactOwner = {};
	const pending = jsonResult({ value: "x".repeat(DEFAULT_MAX_BYTES + 1) }, artifactOwner);

	await cleanupResponseArtifacts(artifactOwner);
	const result = await pending;

	assert.ok(result.details.fullResponsePath);
	assert.equal(existsSync(result.details.fullResponsePath), false);
});

test("all five Firecrawl tools bound oversized successful responses", async () => {
	const originalFetch = globalThis.fetch;
	const previousApiKey = process.env.FIRECRAWL_API_KEY;
	const paths: string[] = [];
	let artifactOwner: object | undefined;
	globalThis.fetch = async (input) => {
		paths.push(new URL(String(input)).pathname);
		return new Response(JSON.stringify({ data: "x".repeat(DEFAULT_MAX_BYTES * 2) }));
	};
	process.env.FIRECRAWL_API_KEY = "test-key";
	try {
		const mock = createMockPi();
		firecrawl(mock.pi);
		const sessionManager = { getSessionId: () => "tool-test-session" };
		const { ctx } = createMockContext({ sessionManager });
		artifactOwner = sessionManager;
		const inputs = [
			{ url: "https://example.test" },
			{ url: "https://example.test" },
			{ id: "crawl-id" },
			{ url: "https://example.test" },
			{ query: "example" },
		];
		for (const [index, tool] of mock.tools.entries()) {
			const execute = tool.execute as (
				id: string,
				params: unknown,
				signal: AbortSignal | undefined,
				onUpdate: undefined,
				context: typeof ctx,
			) => Promise<{ content: Array<{ type: string; text?: string }> }>;
			const result = await execute(`call-${index}`, inputs[index], undefined, undefined, ctx);
			const text = result.content.find((item) => item.type === "text")?.text ?? "";
			assert.ok(Buffer.byteLength(text, "utf8") <= DEFAULT_MAX_BYTES);
			assert.ok(text.split("\n").length <= DEFAULT_MAX_LINES);
			assert.match(text, /Output truncated/);
		}
		assert.deepEqual(paths, [
			"/v1/scrape",
			"/v1/crawl",
			"/v1/crawl/crawl-id",
			"/v1/map",
			"/v1/search",
		]);
	} finally {
		globalThis.fetch = originalFetch;
		if (previousApiKey === undefined) delete process.env.FIRECRAWL_API_KEY;
		else process.env.FIRECRAWL_API_KEY = previousApiKey;
		if (artifactOwner) await cleanupResponseArtifacts(artifactOwner);
	}
});

test("firecrawl bounds oversized non-2xx responses and saves their exact raw body", async () => {
	const originalFetch = globalThis.fetch;
	const responseText = `{\n  "error": "${"x".repeat(DEFAULT_MAX_BYTES * 2)}",\n  "duplicate": 1,\n  "duplicate": 2\n}`;
	globalThis.fetch = async () => new Response(responseText, { status: 500 });
	const previousApiKey = process.env.FIRECRAWL_API_KEY;
	const artifactOwner = {};
	process.env.FIRECRAWL_API_KEY = "test-key";
	try {
		const hugePath = `/${"a".repeat(DEFAULT_MAX_BYTES * 2)}`;
		await assert.rejects(
			firecrawlRequest("GET", hugePath, undefined, undefined, artifactOwner),
			(error: Error) => {
				assert.ok(Buffer.byteLength(error.message, "utf8") <= DEFAULT_MAX_BYTES);
				assert.match(error.message, /Output truncated/);
				const artifactPath = error.message.match(/Full response saved to: (.+)\]$/)?.[1];
				assert.ok(artifactPath);
				assert.equal(readFileSync(artifactPath, "utf8"), responseText);
				return true;
			},
		);
	} finally {
		globalThis.fetch = originalFetch;
		if (previousApiKey === undefined) delete process.env.FIRECRAWL_API_KEY;
		else process.env.FIRECRAWL_API_KEY = previousApiKey;
		await cleanupResponseArtifacts(artifactOwner);
	}
});

test("session shutdown rejects an error artifact write that starts after cleanup", async () => {
	const originalFetch = globalThis.fetch;
	const previousApiKey = process.env.FIRECRAWL_API_KEY;
	let resolveResponse: (response: Response) => void = () => undefined;
	const pendingResponse = new Promise<Response>((resolve) => {
		resolveResponse = resolve;
	});
	globalThis.fetch = async () => pendingResponse;
	process.env.FIRECRAWL_API_KEY = "test-key";
	const artifactOwner = {};
	const prior = await jsonResult({ value: "x".repeat(DEFAULT_MAX_BYTES + 1) }, artifactOwner);
	assert.ok(prior.details.fullResponsePath);
	const priorDirectory = dirname(prior.details.fullResponsePath);
	const pendingRequest = firecrawlRequest(
		"GET",
		"/late-error",
		undefined,
		undefined,
		artifactOwner,
	);
	try {
		await cleanupResponseArtifacts(artifactOwner);
		resolveResponse(new Response("x".repeat(DEFAULT_MAX_BYTES * 2), { status: 500 }));

		await assert.rejects(pendingRequest, /after session shutdown/);
		assert.equal(existsSync(priorDirectory), false);
	} finally {
		globalThis.fetch = originalFetch;
		if (previousApiKey === undefined) delete process.env.FIRECRAWL_API_KEY;
		else process.env.FIRECRAWL_API_KEY = previousApiKey;
	}
});

test("session shutdown removes only that session's Firecrawl response artifacts", async () => {
	const mock = createMockPi();
	firecrawl(mock.pi);
	const sessionManager = { getSessionId: () => "shutdown-test-session" };
	const { ctx } = createMockContext({ sessionManager });
	const result = await jsonResult({ value: "x".repeat(DEFAULT_MAX_BYTES + 1) }, sessionManager);
	assert.ok(result.details.fullResponsePath);
	const directory = dirname(result.details.fullResponsePath);

	await mock.events.get("session_shutdown")?.[0]?.({}, ctx);

	assert.equal(existsSync(directory), false);
});

test("formatPersistedSelection summarizes all, none, and partial selections", () => {
	assert.equal(formatPersistedSelection([]), "all disabled (0/5 selected)");
	assert.equal(formatPersistedSelection(["firecrawl_scrape"]), "1/5 selected: firecrawl_scrape");
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

test("firecrawl reads legacy-only settings without modifying either path", async () => {
	await withTempAgentDir(async (agentDir) => {
		writeSettings(agentDir, LEGACY_SETTINGS_FILE, [SCRAPE_TOOL]);
		const firecrawlModule = await importFreshFirecrawl();
		const mock = createMockPi({ activeTools: ["other_tool", MAP_TOOL] });
		const { ctx, notifications } = createMockContext();

		firecrawlModule.default(mock.pi);
		await mock.events.get("session_start")?.[0]?.({}, ctx);

		assert.deepEqual(mock.rawPi.getActiveTools(), ["other_tool", SCRAPE_TOOL]);
		assert.equal(existsSync(path.join(agentDir, NEW_SETTINGS_FILE)), false);
		assert.deepEqual(readSettings(agentDir, LEGACY_SETTINGS_FILE).tools, [SCRAPE_TOOL]);
		assert.match(notifications[0]?.message ?? "", /using legacy/i);
		assert.match(notifications[0]?.message ?? "", /rename.*pi-firecrawl\.json/i);
	});
});

test("firecrawl reads valid legacy settings beside a missing canonical symlink target", async () => {
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
		assert.match(notifications[0]?.message ?? "", /using legacy/i);
		assert.match(notifications[0]?.message ?? "", /without modifying the legacy file/i);
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

test("Firecrawl main menu dispatches declarative actions at narrow widths", async () => {
	const mock = createMockPi();
	firecrawl(mock.pi);
	const { ctx, notifications } = createMockContext({
		hasUI: true,
		mode: "tui",
		custom: async (factory: unknown) => {
			const { renders, result } = driveCustomSelector(factory, ["tui.select.confirm"], 20);
			assert.ok(renders.flat().every((line) => visibleWidth(line) <= 20));
			return result;
		},
	});
	await mock.commands.get("firecrawl")?.handler("", ctx);
	assert.match(notifications.at(-1)?.message ?? "", /FIRECRAWL_API_KEY/);
});

test("Firecrawl tool selection keeps the cursor on the toggled row", async () => {
	await withTempAgentDir(async (agentDir) => {
		const mock = createMockPi({ activeTools: ["other_tool"] });
		firecrawl(mock.pi);
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
		writeFileSync(
			path.join(agentDir, NEW_SETTINGS_FILE),
			JSON.stringify({ tools: [CRAWL_TOOL], updatedAt: 1, future: { kept: true } }),
		);
		const firecrawlModule = await importFreshFirecrawl();
		const mock = createMockPi({ activeTools: ["other_tool", CRAWL_TOOL] });
		const { ctx, notifications } = createMockContext();

		firecrawlModule.default(mock.pi);
		await mock.commands.get("firecrawl")?.handler("disable", ctx);

		assert.deepEqual(mock.rawPi.getActiveTools(), ["other_tool"]);
		assert.deepEqual(readSettings(agentDir, NEW_SETTINGS_FILE).tools, []);
		assert.deepEqual(readSettings(agentDir, NEW_SETTINGS_FILE).future, { kept: true });
		assert.equal(existsSync(path.join(agentDir, LEGACY_SETTINGS_FILE)), false);
		assert.match(notifications[0]?.message ?? "", /Settings file: .*pi-firecrawl\.json/);
	});
});

test("firecrawl failed publication preserves the prior file and removes its temporary", async () => {
	await withTempAgentDir(async (agentDir) => {
		writeSettings(agentDir, NEW_SETTINGS_FILE, [CRAWL_TOOL]);
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

test("firecrawl legacy-seeded saves preserve canonical settings created before publication", async () => {
	await withTempAgentDir(async (agentDir) => {
		const legacyPath = path.join(agentDir, LEGACY_SETTINGS_FILE);
		const canonicalPath = path.join(agentDir, NEW_SETTINGS_FILE);
		const legacy = JSON.stringify({ tools: [SCRAPE_TOOL], updatedAt: 1, legacy: true });
		const concurrent = JSON.stringify({ tools: [SEARCH_TOOL], updatedAt: 2, newer: true });
		writeFileSync(legacyPath, legacy);

		await assert.rejects(
			saveSettings(
				{ tools: [MAP_TOOL], updatedAt: 3 },
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

test("firecrawl rejects invalid settings updates and restores active tools", async () => {
	await withTempAgentDir(async (agentDir) => {
		const settingsPath = path.join(agentDir, NEW_SETTINGS_FILE);
		const invalid = '{"tools":["invalid"],"future":"kept"}\n';
		writeFileSync(settingsPath, invalid);
		const firecrawlModule = await importFreshFirecrawl();
		const mock = createMockPi({ activeTools: ["other_tool", CRAWL_TOOL] });
		const { ctx, notifications } = createMockContext();

		firecrawlModule.default(mock.pi);
		await mock.commands.get("firecrawl")?.handler("disable", ctx);

		assert.equal(readFileSync(settingsPath, "utf8"), invalid);
		assert.deepEqual(mock.rawPi.getActiveTools(), ["other_tool", CRAWL_TOOL]);
		assert.match(notifications.at(-1)?.message ?? "", /settings save failed/i);

		writeSettings(agentDir, NEW_SETTINGS_FILE, [CRAWL_TOOL]);
		await mock.commands.get("firecrawl")?.handler("disable", ctx);
		assert.deepEqual(readSettings(agentDir, NEW_SETTINGS_FILE).tools, []);
	});
});

test("firecrawl rolls back a failed save after shutdown invalidates its session", async () => {
	await withTempAgentDir(async (agentDir) => {
		mkdirSync(path.join(agentDir, NEW_SETTINGS_FILE));
		const firecrawlModule = await importFreshFirecrawl();
		const mock = createMockPi({ activeTools: ["other_tool", CRAWL_TOOL] });
		const { ctx, notifications } = createMockContext();
		firecrawlModule.default(mock.pi);

		const command = mock.commands.get("firecrawl")?.handler("disable", ctx);
		await Promise.resolve();
		assert.deepEqual(mock.rawPi.getActiveTools(), ["other_tool"]);
		const shutdown = mock.events.get("session_shutdown")?.[0]?.({}, ctx);

		await Promise.all([command, shutdown]);
		assert.deepEqual(mock.rawPi.getActiveTools(), ["other_tool", CRAWL_TOOL]);
		assert.deepEqual(notifications, []);
	});
});

test("firecrawl serializes rapid tool saves in invocation order", async () => {
	await withTempAgentDir(async (agentDir) => {
		const firecrawlModule = await importFreshFirecrawl();
		const mock = createMockPi({ activeTools: ["other_tool"] });
		const { ctx } = createMockContext();
		firecrawlModule.default(mock.pi);

		const first = mock.commands.get("firecrawl")?.handler("enable", ctx);
		const second = mock.commands.get("firecrawl")?.handler("disable", ctx);
		await Promise.all([first, second]);

		assert.deepEqual(mock.rawPi.getActiveTools(), ["other_tool"]);
		assert.deepEqual(readSettings(agentDir, NEW_SETTINGS_FILE).tools, []);
	});
});

test("Firecrawl tool selection stays within narrow terminal widths", async () => {
	await withTempAgentDir(async () => {
		const mock = createMockPi({ activeTools: ["other_tool"] });
		firecrawl(mock.pi);
		const { ctx } = createMockContext({
			hasUI: true,
			mode: "tui",
			custom: async (factory: unknown) => {
				const { renders, result } = driveCustomSelector(factory, ["tui.select.cancel"], 20);
				assert.ok(renders.flat().every((line) => visibleWidth(line) <= 20));
				return result;
			},
		});
		await mock.commands.get("firecrawl")?.handler("tools", ctx);
	});
});

test("Firecrawl tool selection uses dialogs instead of custom TUI in RPC mode", async () => {
	await withTempAgentDir(async () => {
		const mock = createMockPi({ activeTools: ["other_tool"] });
		firecrawl(mock.pi);
		let customCalls = 0;
		const { ctx } = createMockContext({
			hasUI: true,
			mode: "rpc",
			select: async () => "Done",
			custom: async () => {
				customCalls += 1;
			},
		});

		await mock.commands.get("firecrawl")?.handler("tools", ctx);

		assert.equal(customCalls, 0);
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
	return JSON.parse(readFileSync(path.join(agentDir, fileName), "utf8")) as {
		tools: string[];
		future?: unknown;
	};
}
