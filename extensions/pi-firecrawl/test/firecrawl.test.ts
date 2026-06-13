import assert from "node:assert/strict";
import test from "node:test";
import { createMockPi } from "../../../test/support.js";
import firecrawl, {
	cleanObject,
	commandCompletions,
	formatPayload,
	formatPersistedSelection,
	jsonResult,
	normalizeApiUrl,
	normalizeFirecrawlSettings,
	orderedFirecrawlTools,
	parseCommand,
	parseResponseBody,
} from "../src/firecrawl.js";

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
		{ value: "config", label: "Show configuration quick start" },
	]);
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
