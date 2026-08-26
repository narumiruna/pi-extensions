import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test, vi } from "vitest";
import { createMockContext as createBaseMockContext, createMockPi } from "../../../test/support.js";
import firecrawl from "../src/firecrawl.js";

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
const SCRAPE_TOOL = "firecrawl_scrape";
const CRAWL_TOOL = "firecrawl_crawl";
const CRAWL_STATUS_TOOL = "firecrawl_crawl_status";
const MAP_TOOL = "firecrawl_map";
const SEARCH_TOOL = "firecrawl_search";
const LOAD_TOOL = "firecrawl_load";
const CAPABILITY_TOOLS = [
	SCRAPE_TOOL,
	CRAWL_TOOL,
	CRAWL_STATUS_TOOL,
	MAP_TOOL,
	SEARCH_TOOL,
] as const;

test("firecrawl factory registers without reading action methods", () => {
	const mock = createMockPi();
	mock.rawPi.getActiveTools = () => {
		throw new Error("must wait for session_start");
	};
	mock.rawPi.setActiveTools = () => {
		throw new Error("must wait for session_start");
	};

	assert.doesNotThrow(() => firecrawl(mock.pi));
	assert.ok(mock.events.has("session_start"));
});

test("firecrawl registers deferred capability tools and one loader", () => {
	const mock = createMockPi();
	firecrawl(mock.pi);

	assert.deepEqual(
		mock.tools.map((tool) => tool.name),
		[...CAPABILITY_TOOLS, LOAD_TOOL],
	);
	for (const tool of mock.tools.filter((candidate) => candidate.name !== LOAD_TOOL)) {
		assert.equal(tool.promptSnippet, undefined);
		assert.equal(tool.promptGuidelines, undefined);
	}
	const loader = mock.tools.find((tool) => tool.name === LOAD_TOOL);
	assert.deepEqual(loader?.promptGuidelines, [
		"Use firecrawl_load when a task requires Firecrawl web scraping, crawling, URL discovery, crawl status, or search and the needed firecrawl_* capability is not active.",
		"If FIRECRAWL_API_KEY is missing, report the configuration error instead of retrying repeatedly.",
	]);
	assert.ok(mock.commands.has("firecrawl"));
	assert.deepEqual([...mock.events.keys()].sort(), [
		"model_select",
		"session_shutdown",
		"session_start",
	]);
});

test("firecrawl loader schema bounds task queries and result count", () => {
	const mock = createMockPi();
	firecrawl(mock.pi);
	const loader = mock.tools.find((tool) => tool.name === LOAD_TOOL);
	const schema = loader?.parameters as {
		properties?: {
			query?: { maxLength?: number };
			limit?: { minimum?: number; maximum?: number };
		};
	};

	assert.equal(schema.properties?.query?.maxLength, 500);
	assert.equal(schema.properties?.limit?.minimum, 1);
	assert.equal(schema.properties?.limit?.maximum, 5);
});

test("firecrawl loader additively loads crawl workflows without network access", async () => {
	await withTempAgentDir(async () => {
		const firecrawlModule = await importFreshFirecrawl();
		const mock = createMockPi({ activeTools: ["other_tool", ...CAPABILITY_TOOLS] });
		const { ctx } = createMockContext();
		firecrawlModule.default(mock.pi);
		await mock.events.get("session_start")?.[0]?.({}, ctx);
		assert.deepEqual(mock.rawPi.getActiveTools(), ["other_tool", LOAD_TOOL]);
		const loader = mock.tools.find((tool) => tool.name === LOAD_TOOL) as {
			execute: (...args: unknown[]) => Promise<{
				details: { matches: string[]; added: string[] };
			}>;
		};
		let fetchCalls = 0;
		const originalFetch = globalThis.fetch;
		globalThis.fetch = async () => {
			fetchCalls += 1;
			throw new Error("loader must not fetch");
		};
		try {
			const first = await loader.execute(
				"loader-1",
				{ query: "crawl a website" },
				new AbortController().signal,
				undefined,
				ctx,
			);
			assert.deepEqual(first.details, {
				matches: [CRAWL_TOOL, CRAWL_STATUS_TOOL],
				added: [CRAWL_TOOL, CRAWL_STATUS_TOOL],
			});
			assert.deepEqual(mock.rawPi.getActiveTools(), [
				"other_tool",
				LOAD_TOOL,
				CRAWL_TOOL,
				CRAWL_STATUS_TOOL,
			]);

			const second = await loader.execute(
				"loader-2",
				{ query: "crawl a website" },
				new AbortController().signal,
				undefined,
				ctx,
			);
			assert.deepEqual(second.details.added, []);
			assert.equal(fetchCalls, 0);
		} finally {
			globalThis.fetch = originalFetch;
		}
	});
});

test("firecrawl keeps Azure Responses eager when compat enables tool search", async () => {
	await withTempAgentDir(async () => {
		const firecrawlModule = await importFreshFirecrawl();
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
		const eager = createMockPi({ activeTools: ["other_tool", ...CAPABILITY_TOOLS] });
		const eagerContext = createMockContext({ model: unsupportedModel }).ctx;
		firecrawlModule.default(eager.pi);
		await eager.events.get("session_start")?.[0]?.({}, eagerContext);
		assert.deepEqual(eager.rawPi.getActiveTools(), ["other_tool", LOAD_TOOL, ...CAPABILITY_TOOLS]);

		const switched = createMockPi({ activeTools: ["other_tool", ...CAPABILITY_TOOLS] });
		const nativeContext = createMockContext({ model: nativeModel }).ctx;
		firecrawlModule.default(switched.pi);
		await switched.events.get("session_start")?.[0]?.({}, nativeContext);
		assert.deepEqual(switched.rawPi.getActiveTools(), ["other_tool", LOAD_TOOL]);

		await switched.events.get("model_select")?.[0]?.({ model: unsupportedModel }, nativeContext);
		assert.deepEqual(switched.rawPi.getActiveTools(), [
			"other_tool",
			LOAD_TOOL,
			...CAPABILITY_TOOLS,
		]);

		await switched.events.get("model_select")?.[0]?.({ model: nativeModel }, nativeContext);
		assert.deepEqual(switched.rawPi.getActiveTools(), [
			"other_tool",
			LOAD_TOOL,
			...CAPABILITY_TOOLS,
		]);
	});
});

test("firecrawl keeps uppercase Anthropic model IDs eager", async () => {
	await withTempAgentDir(async () => {
		const firecrawlModule = await importFreshFirecrawl();
		const model = {
			api: "anthropic-messages",
			provider: "anthropic",
			id: "CLAUDE-SONNET-4-5",
		};
		const mock = createMockPi({ activeTools: ["other_tool", ...CAPABILITY_TOOLS] });
		const ctx = createMockContext({ model }).ctx;
		firecrawlModule.default(mock.pi);

		await mock.events.get("session_start")?.[0]?.({}, ctx);

		assert.deepEqual(mock.rawPi.getActiveTools(), ["other_tool", LOAD_TOOL, ...CAPABILITY_TOOLS]);
	});
});

test("firecrawl honors native Kimi deferred-tool support", async () => {
	await withTempAgentDir(async () => {
		const firecrawlModule = await importFreshFirecrawl();
		const model = {
			api: "openai-completions",
			provider: "moonshotai",
			id: "kimi-k2.6",
			compat: { deferredToolsMode: "kimi" },
		};
		const mock = createMockPi({ activeTools: ["other_tool", ...CAPABILITY_TOOLS] });
		const ctx = createMockContext({ model }).ctx;
		firecrawlModule.default(mock.pi);

		await mock.events.get("session_start")?.[0]?.({}, ctx);

		assert.deepEqual(mock.rawPi.getActiveTools(), ["other_tool", LOAD_TOOL]);
	});
});

test("firecrawl honors native additional-tools support", async () => {
	await withTempAgentDir(async () => {
		for (const api of ["openai-responses", "openai-codex-responses"]) {
			const firecrawlModule = await importFreshFirecrawl();
			const model = {
				api,
				provider: api === "openai-responses" ? "openai" : "openai-codex",
				id: "gpt-5.4",
				compat: { supportsAdditionalTools: true },
			};
			const mock = createMockPi({ activeTools: ["other_tool", ...CAPABILITY_TOOLS] });
			const ctx = createMockContext({ model }).ctx;
			firecrawlModule.default(mock.pi);

			await mock.events.get("session_start")?.[0]?.({}, ctx);

			assert.deepEqual(mock.rawPi.getActiveTools(), ["other_tool", LOAD_TOOL]);
		}
	});
});

test("firecrawl keeps its missing-settings catalog across session replacement", async () => {
	await withTempAgentDir(async () => {
		const firecrawlModule = await importFreshFirecrawl();
		const mock = createMockPi({ activeTools: ["other_tool", ...CAPABILITY_TOOLS] });
		const { ctx } = createMockContext();
		firecrawlModule.default(mock.pi);
		const sessionStart = mock.events.get("session_start")?.[0];
		await sessionStart?.({}, ctx);
		const loader = mock.tools.find((tool) => tool.name === LOAD_TOOL) as {
			execute: (...args: unknown[]) => Promise<{ details: { matches: string[] } }>;
		};
		await loader.execute(
			"loader-1",
			{ query: "search the web" },
			new AbortController().signal,
			undefined,
			ctx,
		);
		await sessionStart?.({}, ctx);
		const result = await loader.execute(
			"loader-2",
			{ query: "discover urls for a site" },
			new AbortController().signal,
			undefined,
			ctx,
		);

		assert.deepEqual(result.details.matches, [MAP_TOOL]);
	});
});

test("firecrawl preserves an unsaved catalog across reload API replacement", async () => {
	await withTempAgentDir(async () => {
		const sessionManager = {
			getSessionId: () => "reload-session",
			getBranch: () => [],
			getEntries: () => [],
		};
		const firstModule = await importFreshFirecrawl();
		const first = createMockPi({ activeTools: ["other_tool", SCRAPE_TOOL] });
		const firstContext = createMockContext({ sessionManager }).ctx;
		firstModule.default(first.pi);
		await first.events.get("session_start")?.[0]?.({ reason: "startup" }, firstContext);

		const secondModule = await importFreshFirecrawl();
		const replacement = createMockPi({ activeTools: ["other_tool", ...CAPABILITY_TOOLS] });
		const replacementContext = createMockContext({ sessionManager }).ctx;
		secondModule.default(replacement.pi);
		await replacement.events.get("session_start")?.[0]?.({ reason: "reload" }, replacementContext);
		const loader = replacement.tools.find((tool) => tool.name === LOAD_TOOL) as {
			execute: (...args: unknown[]) => Promise<{ details: { matches: string[] } }>;
		};
		const unavailable = await loader.execute(
			"loader-unavailable",
			{ query: "search the web" },
			new AbortController().signal,
			undefined,
			replacementContext,
		);
		const available = await loader.execute(
			"loader-available",
			{ query: "scrape one page" },
			new AbortController().signal,
			undefined,
			replacementContext,
		);

		assert.deepEqual(unavailable.details.matches, []);
		assert.deepEqual(available.details.matches, [SCRAPE_TOOL]);
	});
});

test("firecrawl restores only allowed loaded capabilities from the active branch", async () => {
	await withTempAgentDir(async (agentDir) => {
		writeSettings(agentDir, [SCRAPE_TOOL, MAP_TOOL, SEARCH_TOOL]);
		const branch = [
			{
				type: "message",
				message: {
					role: "toolResult",
					toolName: LOAD_TOOL,
					addedToolNames: [SEARCH_TOOL],
					details: { matches: [SEARCH_TOOL], added: [SEARCH_TOOL] },
				},
			},
			{
				type: "message",
				message: {
					role: "toolResult",
					toolName: LOAD_TOOL,
					details: { matches: [SCRAPE_TOOL], added: [SCRAPE_TOOL] },
				},
			},
			{
				type: "message",
				message: {
					role: "toolResult",
					toolName: LOAD_TOOL,
					addedToolNames: [CRAWL_TOOL],
					details: { matches: [CRAWL_TOOL], added: [CRAWL_TOOL] },
				},
			},
		];
		const sessionManager = {
			getSessionId: () => "restored-session",
			getBranch: () => branch,
			getEntries: () => [
				...branch,
				{
					type: "message",
					message: {
						role: "toolResult",
						toolName: LOAD_TOOL,
						addedToolNames: [MAP_TOOL],
						details: { matches: [MAP_TOOL], added: [MAP_TOOL] },
					},
				},
			],
		};
		const firecrawlModule = await importFreshFirecrawl();
		const mock = createMockPi({ activeTools: ["other_tool", ...CAPABILITY_TOOLS] });
		const { ctx } = createMockContext({ sessionManager });
		firecrawlModule.default(mock.pi);

		await mock.events.get("session_start")?.[0]?.({ reason: "fork" }, ctx);

		assert.deepEqual(mock.rawPi.getActiveTools(), [
			"other_tool",
			LOAD_TOOL,
			SCRAPE_TOOL,
			SEARCH_TOOL,
		]);
	});
});

test("firecrawl loader filters the allowed catalog before limiting matches", async () => {
	await withTempAgentDir(async (agentDir) => {
		writeSettings(agentDir, [SEARCH_TOOL]);
		const firecrawlModule = await importFreshFirecrawl();
		const mock = createMockPi({ activeTools: ["other_tool", ...CAPABILITY_TOOLS] });
		const { ctx, notifications } = createMockContext({ mode: "rpc", hasUI: true });
		firecrawlModule.default(mock.pi);
		await mock.events.get("session_start")?.[0]?.({}, ctx);
		const loader = mock.tools.find((tool) => tool.name === LOAD_TOOL) as {
			execute: (...args: unknown[]) => Promise<{
				details: { matches: string[]; added: string[] };
			}>;
		};

		const result = await loader.execute(
			"loader-1",
			{ query: "web" },
			new AbortController().signal,
			undefined,
			ctx,
		);

		assert.deepEqual(result.details, { matches: [SEARCH_TOOL], added: [SEARCH_TOOL] });
		assert.deepEqual(mock.rawPi.getActiveTools(), ["other_tool", LOAD_TOOL, SEARCH_TOOL]);
		await mock.commands.get("firecrawl")?.handler("status", ctx);
		const status = notifications.at(-1)?.message ?? "";
		assert.match(status, /1\/5 available/);
		assert.match(status, /Loaded capability tools this session: 1\/5/);
		assert.match(status, /Loader: active/);
		assert.match(status, /Other active tools preserved: 1/);
	});
});

test("firecrawl loader distinguishes scraping, URL discovery, search, and status tasks", async () => {
	await withTempAgentDir(async () => {
		const firecrawlModule = await importFreshFirecrawl();
		const mock = createMockPi({ activeTools: ["other_tool", ...CAPABILITY_TOOLS] });
		const { ctx } = createMockContext();
		firecrawlModule.default(mock.pi);
		await mock.events.get("session_start")?.[0]?.({}, ctx);
		const loader = mock.tools.find((tool) => tool.name === LOAD_TOOL) as {
			execute: (...args: unknown[]) => Promise<{ details: { matches: string[] } }>;
		};
		const cases = [
			["scrape one page as markdown", [SCRAPE_TOOL]],
			["discover urls for a site", [MAP_TOOL]],
			["search the web", [SEARCH_TOOL]],
			["check crawl job status", [CRAWL_STATUS_TOOL]],
		] as const;

		for (const [query, expected] of cases) {
			const result = await loader.execute(
				`loader-${query}`,
				{ query },
				new AbortController().signal,
				undefined,
				ctx,
			);
			assert.deepEqual(result.details.matches, expected);
		}
	});
});

test("firecrawl loader ignores duplicate query terms when ranking tools", async () => {
	await withTempAgentDir(async () => {
		const firecrawlModule = await importFreshFirecrawl();
		const mock = createMockPi({ activeTools: ["other_tool", ...CAPABILITY_TOOLS] });
		const { ctx } = createMockContext();
		firecrawlModule.default(mock.pi);
		await mock.events.get("session_start")?.[0]?.({}, ctx);
		const loader = mock.tools.find((tool) => tool.name === LOAD_TOOL) as {
			execute: (...args: unknown[]) => Promise<{ details: { matches: string[] } }>;
		};

		const unique = await loader.execute(
			"loader-unique",
			{ query: "search crawl" },
			new AbortController().signal,
			undefined,
			ctx,
		);
		const repeated = await loader.execute(
			"loader-repeated",
			{ query: "search search crawl" },
			new AbortController().signal,
			undefined,
			ctx,
		);

		assert.deepEqual(repeated.details.matches, unique.details.matches);
	});
});

test("firecrawl loader includes crawl creation for compound start and status tasks", async () => {
	await withTempAgentDir(async () => {
		const firecrawlModule = await importFreshFirecrawl();
		const mock = createMockPi({ activeTools: ["other_tool", ...CAPABILITY_TOOLS] });
		const { ctx } = createMockContext();
		firecrawlModule.default(mock.pi);
		await mock.events.get("session_start")?.[0]?.({}, ctx);
		const loader = mock.tools.find((tool) => tool.name === LOAD_TOOL) as {
			execute: (...args: unknown[]) => Promise<{ details: { matches: string[] } }>;
		};

		const result = await loader.execute(
			"loader-compound-crawl",
			{ query: "start crawl and monitor status" },
			new AbortController().signal,
			undefined,
			ctx,
		);

		assert.deepEqual(result.details.matches, [CRAWL_TOOL, CRAWL_STATUS_TOOL]);
	});
});

test("firecrawl loader rejects pre-cancelled execution without changing tools", async () => {
	await withTempAgentDir(async () => {
		const firecrawlModule = await importFreshFirecrawl();
		const mock = createMockPi({ activeTools: ["other_tool", ...CAPABILITY_TOOLS] });
		const { ctx } = createMockContext();
		firecrawlModule.default(mock.pi);
		await mock.events.get("session_start")?.[0]?.({}, ctx);
		const loader = mock.tools.find((tool) => tool.name === LOAD_TOOL) as {
			execute: (...args: unknown[]) => Promise<unknown>;
		};
		const controller = new AbortController();
		controller.abort();

		await assert.rejects(
			loader.execute("loader-cancelled", { query: "search" }, controller.signal, undefined, ctx),
			(error: Error) => error.name === "AbortError",
		);
		assert.deepEqual(mock.rawPi.getActiveTools(), ["other_tool", LOAD_TOOL]);
	});
});

async function importFreshFirecrawl() {
	vi.resetModules();
	return import("../src/firecrawl.js");
}

async function withTempAgentDir<T>(fn: (agentDir: string) => Promise<T>) {
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	const agentDir = mkdtempSync(path.join(os.tmpdir(), "pi-firecrawl-lazy-tools-"));
	process.env.PI_CODING_AGENT_DIR = agentDir;
	try {
		return await fn(agentDir);
	} finally {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		rmSync(agentDir, { recursive: true, force: true });
	}
}

function writeSettings(agentDir: string, tools: readonly string[]) {
	writeFileSync(path.join(agentDir, NEW_SETTINGS_FILE), JSON.stringify({ tools, updatedAt: 1 }));
}
