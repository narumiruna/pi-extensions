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
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { test, vi } from "vitest";
import {
	createMockContext as createBaseMockContext,
	createCustomSelectorHarness,
	createMockPi,
	driveCustomSelector,
} from "../../../test/support.js";
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
	sanitizeFirecrawlDisplay,
} from "../src/firecrawl.js";
import { applyAvailableFirecrawlTools } from "../src/lazy-tools.js";
import { saveSettings } from "../src/settings.js";
import { advanceFirecrawlSessionGeneration, buildStatusMessage } from "../src/tool-selector.js";

const NATIVE_DEFERRED_MODEL = {
	api: "openai-responses",
	provider: "openai",
	id: "gpt-5.4",
	compat: { supportsToolSearch: true },
};

function createMockContext(overrides: Record<string, unknown> = {}) {
	return createBaseMockContext({ model: NATIVE_DEFERRED_MODEL, ...overrides });
}

const NEW_SETTINGS_FILE = "pi-firecrawl.json";
const LEGACY_SETTINGS_FILE = "pi-firecrawl-settings.json";
const SCRAPE_TOOL = "firecrawl_scrape";
const CRAWL_TOOL = "firecrawl_crawl";
const MAP_TOOL = "firecrawl_map";
const SEARCH_TOOL = "firecrawl_search";
const CRAWL_STATUS_TOOL = "firecrawl_crawl_status";
const LOAD_TOOL = "firecrawl_load";
const CAPABILITY_TOOLS = [
	SCRAPE_TOOL,
	CRAWL_TOOL,
	CRAWL_STATUS_TOOL,
	MAP_TOOL,
	SEARCH_TOOL,
] as const;

test("firecrawl display sanitization strips terminal controls and remains bounded", () => {
	assert.equal(
		sanitizeFirecrawlDisplay("safe\u001b]8;;https://evil\u0007link\u001b]8;;\u0007"),
		"safelink",
	);
	assert.equal(sanitizeFirecrawlDisplay("12345", 4), "123…");
});

test("firecrawl display truncation preserves complete Unicode characters", () => {
	assert.equal(sanitizeFirecrawlDisplay("😀xy", 2), "😀…");
	assert.equal(sanitizeFirecrawlDisplay("😀", 0), "");
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

test("firecrawl interactive routes reject unsupported modes while direct catalog changes work", async () => {
	await withTempAgentDir(async () => {
		const mock = createMockPi({ activeTools: ["other_tool", ...CAPABILITY_TOOLS] });
		const { ctx } = createMockContext({ mode: "json", hasUI: false });
		firecrawl(mock.pi);
		const command = mock.commands.get("firecrawl")?.handler;
		assert.ok(command);
		const invoke = async (args: string) => command(args, ctx);

		for (const route of ["", "help", "config", "quickstart", "status", "tools", "wat"]) {
			await assert.rejects(() => invoke(route), /requires TUI or RPC|Unknown \/firecrawl/);
		}
		await invoke("enable");
		await invoke("disable");

		assert.deepEqual(mock.rawPi.getActiveTools(), ["other_tool", LOAD_TOOL]);
		assert.deepEqual(
			readSettings(process.env.PI_CODING_AGENT_DIR ?? "", NEW_SETTINGS_FILE).tools,
			[],
		);
	});
});

test("firecrawl unknown-command feedback sanitizes terminal controls in UI modes", async () => {
	const mock = createMockPi();
	const { ctx, notifications } = createMockContext({ mode: "rpc", hasUI: true });
	firecrawl(mock.pi);
	const command = mock.commands.get("firecrawl")?.handler;
	assert.ok(command);

	await command("bad\u001b]8;;https://evil\u0007route", ctx);

	assert.match(notifications[0]?.message ?? "", /Unknown \/firecrawl command: badroute/);
	assert.equal((notifications[0]?.message ?? "").includes("\u001b"), false);
	assert.equal((notifications[0]?.message ?? "").includes("\u0007"), false);
	const nonUiContext = createMockContext({ mode: "json", hasUI: false }).ctx;
	await assert.rejects(
		async () => command("bad\u001b]8;;https://evil\u0007route", nonUiContext),
		(error: Error) =>
			error.message.includes("badroute") &&
			!error.message.includes("\u001b") &&
			!error.message.includes("\u0007"),
	);
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

test("firecrawl rejects non-finite settings timestamps before publication", async () => {
	await withTempAgentDir(async (agentDir) => {
		await assert.rejects(
			saveSettings({ tools: [SCRAPE_TOOL], updatedAt: Number.NaN }),
			/Cannot save invalid Firecrawl settings/,
		);
		assert.equal(existsSync(path.join(agentDir, NEW_SETTINGS_FILE)), false);
	});
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
		const capabilityTools = mock.tools.filter((tool) =>
			CAPABILITY_TOOLS.includes(tool.name as (typeof CAPABILITY_TOOLS)[number]),
		);
		for (const [index, tool] of capabilityTools.entries()) {
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
	assert.equal(formatPersistedSelection([]), "all unavailable (0/5 selected)");
	assert.equal(formatPersistedSelection(["firecrawl_scrape"]), "1/5 selected: firecrawl_scrape");
});

test("firecrawl preserves the current catalog but initially activates only its loader", async () => {
	await withTempAgentDir(async () => {
		const firecrawlModule = await importFreshFirecrawl();
		const mock = createMockPi({ activeTools: ["other_tool", SEARCH_TOOL] });
		const { ctx, notifications } = createMockContext();

		firecrawlModule.default(mock.pi);
		await mock.events.get("session_start")?.[0]?.({}, ctx);

		assert.deepEqual(mock.rawPi.getActiveTools(), ["other_tool", LOAD_TOOL]);
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

		assert.deepEqual(mock.rawPi.getActiveTools(), ["other_tool", LOAD_TOOL]);
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

		assert.deepEqual(mock.rawPi.getActiveTools(), ["other_tool", LOAD_TOOL]);
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

		assert.deepEqual(mock.rawPi.getActiveTools(), ["other_tool", LOAD_TOOL]);
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

		assert.deepEqual(mock.rawPi.getActiveTools(), ["other_tool", LOAD_TOOL]);
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
		const { ctx, notifications } = createMockContext({ mode: "rpc", hasUI: true });

		firecrawlModule.default(mock.pi);
		await mock.events.get("session_start")?.[0]?.({}, ctx);
		await mock.commands.get("firecrawl")?.handler("status", ctx);

		assert.deepEqual(mock.rawPi.getActiveTools(), ["other_tool", LOAD_TOOL]);
		assert.deepEqual(readSettings(agentDir, NEW_SETTINGS_FILE).tools, [SEARCH_TOOL]);
		assert.equal(existsSync(path.join(agentDir, LEGACY_SETTINGS_FILE)), true);
		assert.match(notifications[0]?.message ?? "", /legacy settings ignored/i);
		const statusMessage = notifications.at(-1)?.message ?? "";
		assert.match(statusMessage, /Settings file: .*pi-firecrawl\.json/);
		assert.match(statusMessage, /legacy settings ignored/i);

		rmSync(path.join(agentDir, LEGACY_SETTINGS_FILE));
		await mock.commands.get("firecrawl")?.handler("status", ctx);
		assert.doesNotMatch(notifications.at(-1)?.message ?? "", /legacy settings ignored/i);
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

		assert.deepEqual(mock.rawPi.getActiveTools(), ["other_tool", LOAD_TOOL]);
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

		assert.deepEqual(mock.rawPi.getActiveTools(), ["other_tool", LOAD_TOOL]);
		assert.equal(existsSync(path.join(agentDir, LEGACY_SETTINGS_FILE)), true);
		assert.match(notifications[0]?.message ?? "", /legacy settings ignored/i);
		assert.match(notifications[1]?.message ?? "", /settings ignored/i);
		assert.match(notifications[1]?.message ?? "", /pi-firecrawl\.json/);
	});
});

test("Firecrawl main menu dispatches declarative actions at narrow widths", async () => {
	const mock = createMockPi();
	firecrawl(mock.pi);
	let renderedLines: string[] = [];
	const { ctx, notifications } = createMockContext({
		hasUI: true,
		mode: "tui",
		custom: async (factory: unknown) => {
			const { renders, result } = driveCustomSelector(factory, ["tui.select.confirm"], 20);
			renderedLines = renders.flat();
			return result;
		},
	});
	await mock.commands.get("firecrawl")?.handler("", ctx);
	assert.ok(renderedLines.every((line) => visibleWidth(line) <= 20));
	const rendered = renderedLines.join("\n");
	assert.match(rendered, /Tool catalog: 0\/5/);
	assert.match(rendered, /Loaded this session:\s+0\/5/);
	assert.match(notifications.at(-1)?.message ?? "", /FIRECRAWL_API_KEY/);
});

test("Firecrawl tool selection keeps the cursor on the toggled row", async () => {
	await withTempAgentDir(async (agentDir) => {
		const mock = createMockPi({ activeTools: ["other_tool", ...CAPABILITY_TOOLS, LOAD_TOOL] });
		firecrawl(mock.pi);
		let toggledRowKeptCursor = false;
		const { ctx } = createMockContext({
			hasUI: true,
			mode: "tui",
			custom: async (factory: unknown) => {
				const { renders, result } = driveCustomSelector(factory, [
					"tui.select.down",
					"tui.select.confirm",
					"tui.select.cancel",
				]);
				toggledRowKeptCursor = Boolean(
					renders[1]?.some((line) => line.includes("› [ ] firecrawl_crawl")),
				);
				return result;
			},
		});
		await mock.commands.get("firecrawl")?.handler("tools", ctx);

		assert.equal(toggledRowKeptCursor, true);
		assert.deepEqual(mock.rawPi.getActiveTools(), [
			"other_tool",
			LOAD_TOOL,
			...CAPABILITY_TOOLS.filter((name) => name !== CRAWL_TOOL),
		]);
		assert.deepEqual(
			readSettings(agentDir, NEW_SETTINGS_FILE).tools,
			CAPABILITY_TOOLS.filter((name) => name !== CRAWL_TOOL),
		);
	});
});

test("catalog changes unload unavailable tools and leave newly available tools deferred", async () => {
	await withTempAgentDir(async () => {
		const firecrawlModule = await importFreshFirecrawl();
		const mock = createMockPi({ activeTools: ["other_tool", ...CAPABILITY_TOOLS] });
		const { ctx } = createMockContext();
		firecrawlModule.default(mock.pi);
		await mock.events.get("session_start")?.[0]?.({}, ctx);
		const loader = mock.tools.find((tool) => tool.name === LOAD_TOOL) as {
			execute: (...args: unknown[]) => Promise<unknown>;
		};

		await loader.execute(
			"loader-search",
			{ query: "search the web" },
			new AbortController().signal,
			undefined,
			ctx,
		);
		assert.deepEqual(mock.rawPi.getActiveTools(), ["other_tool", LOAD_TOOL, SEARCH_TOOL]);

		await mock.commands.get("firecrawl")?.handler("disable", ctx);
		assert.deepEqual(mock.rawPi.getActiveTools(), ["other_tool", LOAD_TOOL]);
		await mock.commands.get("firecrawl")?.handler("enable", ctx);
		assert.deepEqual(mock.rawPi.getActiveTools(), ["other_tool", LOAD_TOOL]);
		assert.deepEqual(
			readSettings(process.env.PI_CODING_AGENT_DIR ?? "", NEW_SETTINGS_FILE).tools,
			CAPABILITY_TOOLS,
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

		assert.deepEqual(mock.rawPi.getActiveTools(), ["other_tool", LOAD_TOOL]);
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

test("stale status reads do not publish output after session replacement", async () => {
	await withTempAgentDir(async () => {
		let markWriteStarted: (() => void) | undefined;
		const writeStarted = new Promise<void>((resolve) => {
			markWriteStarted = resolve;
		});
		let releaseWrite: (() => void) | undefined;
		const writeBlock = new Promise<void>((resolve) => {
			releaseWrite = resolve;
		});
		const pendingSave = saveSettings(
			{ tools: [...CAPABILITY_TOOLS], updatedAt: 1 },
			{
				write: async (temporaryPath, data) => {
					writeFileSync(temporaryPath, data);
					markWriteStarted?.();
					await writeBlock;
				},
			},
		);
		await writeStarted;
		const mock = createMockPi({ activeTools: ["other_tool", LOAD_TOOL] });
		firecrawl(mock.pi);
		const status = buildStatusMessage(mock.pi);
		advanceFirecrawlSessionGeneration();
		releaseWrite?.();
		await pendingSave;

		assert.equal(await status, "");
	});
});

test("queued selector saves reject stale availability without overwriting it", async () => {
	await withTempAgentDir(async () => {
		const mock = createMockPi({ activeTools: ["other_tool", ...CAPABILITY_TOOLS] });
		firecrawl(mock.pi);
		let markBlockingWriteStarted: (() => void) | undefined;
		const blockingWriteStarted = new Promise<void>((resolve) => {
			markBlockingWriteStarted = resolve;
		});
		let releaseBlockingWrite: (() => void) | undefined;
		const blockingWrite = new Promise<void>((resolve) => {
			releaseBlockingWrite = resolve;
		});
		const blocker = saveSettings(
			{ tools: [...CAPABILITY_TOOLS], updatedAt: 1 },
			{
				write: async (temporaryPath, data) => {
					writeFileSync(temporaryPath, data);
					markBlockingWriteStarted?.();
					await blockingWrite;
				},
			},
		);
		await blockingWriteStarted;
		let markFirstRuntimeApply: (() => void) | undefined;
		const firstRuntimeApply = new Promise<void>((resolve) => {
			markFirstRuntimeApply = resolve;
		});
		const setActiveTools = mock.rawPi.setActiveTools.bind(mock.rawPi);
		mock.rawPi.setActiveTools = (names) => {
			setActiveTools(names);
			markFirstRuntimeApply?.();
			markFirstRuntimeApply = undefined;
		};
		const directContext = createMockContext().ctx;
		const firstSave = mock.commands.get("firecrawl")?.handler("enable", directContext);
		await firstRuntimeApply;
		let markSelectorActionStarted: (() => void) | undefined;
		const selectorActionStarted = new Promise<void>((resolve) => {
			markSelectorActionStarted = resolve;
		});
		let continueSelector: (() => void) | undefined;
		const selectorMayFinish = new Promise<void>((resolve) => {
			continueSelector = resolve;
		});
		const { ctx, notifications } = createMockContext({
			hasUI: true,
			mode: "tui",
			custom: async (factory: unknown) => {
				const harness = createCustomSelectorHarness(factory, 80);
				harness.handleInput("tui.select.confirm");
				markSelectorActionStarted?.();
				await selectorMayFinish;
				await harness.waitForPending();
				harness.handleInput("tui.select.cancel");
				return harness.resultPromise;
			},
		});
		const selector = mock.commands.get("firecrawl")?.handler("tools", ctx);
		await selectorActionStarted;
		applyAvailableFirecrawlTools(mock.pi, CAPABILITY_TOOLS.slice(0, 3));
		releaseBlockingWrite?.();
		await blocker;
		await firstSave;
		continueSelector?.();
		await selector;

		assert.deepEqual(mock.rawPi.getActiveTools(), [
			"other_tool",
			LOAD_TOOL,
			...CAPABILITY_TOOLS.slice(0, 3),
		]);
		assert.ok(notifications.some(({ message }) => /availability changed/i.test(message)));
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
		assert.deepEqual(mock.rawPi.getActiveTools(), ["other_tool", LOAD_TOOL, CRAWL_TOOL]);
		assert.match(notifications.at(-1)?.message ?? "", /settings save failed/i);
		const loader = mock.tools.find((tool) => tool.name === LOAD_TOOL) as {
			execute: (...args: unknown[]) => Promise<{ details: { matches: string[] } }>;
		};
		const restoredCatalog = await loader.execute(
			"loader-after-rollback",
			{ query: "crawl a website" },
			new AbortController().signal,
			undefined,
			ctx,
		);
		assert.deepEqual(restoredCatalog.details.matches, [CRAWL_TOOL]);

		writeSettings(agentDir, NEW_SETTINGS_FILE, [CRAWL_TOOL]);
		await mock.commands.get("firecrawl")?.handler("disable", ctx);
		assert.deepEqual(readSettings(agentDir, NEW_SETTINGS_FILE).tools, []);
	});
});

test("firecrawl keeps failed-save rollback eager after an unsupported model switch", async () => {
	await withTempAgentDir(async (agentDir) => {
		const settingsPath = path.join(agentDir, NEW_SETTINGS_FILE);
		writeFileSync(settingsPath, '{"tools":["invalid"]}\n');
		const firecrawlModule = await importFreshFirecrawl();
		const mock = createMockPi({ activeTools: ["other_tool", ...CAPABILITY_TOOLS] });
		const { ctx, notifications } = createMockContext();
		firecrawlModule.default(mock.pi);
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

		const command = mock.commands.get("firecrawl")?.handler("disable", ctx);
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

test("firecrawl rolls back a failed save after shutdown invalidates its session", async () => {
	await withTempAgentDir(async (agentDir) => {
		mkdirSync(path.join(agentDir, NEW_SETTINGS_FILE));
		const firecrawlModule = await importFreshFirecrawl();
		const mock = createMockPi({ activeTools: ["other_tool", CRAWL_TOOL] });
		const { ctx, notifications } = createMockContext();
		firecrawlModule.default(mock.pi);

		const command = mock.commands.get("firecrawl")?.handler("disable", ctx);
		await Promise.resolve();
		assert.deepEqual(mock.rawPi.getActiveTools(), ["other_tool", LOAD_TOOL]);
		const shutdown = mock.events.get("session_shutdown")?.[0]?.({}, ctx);

		await Promise.all([command, shutdown]);
		assert.deepEqual(mock.rawPi.getActiveTools(), ["other_tool", LOAD_TOOL, CRAWL_TOOL]);
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

		assert.deepEqual(mock.rawPi.getActiveTools(), ["other_tool", LOAD_TOOL]);
		assert.deepEqual(readSettings(agentDir, NEW_SETTINGS_FILE).tools, []);
	});
});

test("Firecrawl tool selection stays within narrow terminal widths", async () => {
	await withTempAgentDir(async () => {
		const mock = createMockPi({ activeTools: ["other_tool"] });
		firecrawl(mock.pi);
		let renderedLines: string[] = [];
		const { ctx } = createMockContext({
			hasUI: true,
			mode: "tui",
			custom: async (factory: unknown) => {
				const { renders, result } = driveCustomSelector(factory, ["tui.select.cancel"], 20);
				renderedLines = renders.flat();
				return result;
			},
		});
		await mock.commands.get("firecrawl")?.handler("tools", ctx);
		assert.ok(renderedLines.every((line) => visibleWidth(line) <= 20));
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

async function importFreshFirecrawl() {
	vi.resetModules();
	return import("../src/firecrawl.js");
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
