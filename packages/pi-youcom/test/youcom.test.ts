import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { afterEach, beforeEach, test } from "vitest";
import { createMockContext, createMockPi } from "../../../test/support.js";
import {
	configuredServerUrl,
	hasApiKey,
	normalizeUrl,
	parseSseStream,
	YoucomRequestTimeoutError,
	youcomRequest,
} from "../src/client.js";
import { boundResponseText, cleanupResponses, openResponses } from "../src/response-format.js";
import { YOUCOM_TOOL_NAMES } from "../src/tool-names.js";
import youcom from "../src/youcom.js";

const SEARCH_TOOL = YOUCOM_TOOL_NAMES[0];
const CONTENTS_TOOL = YOUCOM_TOOL_NAMES[1];

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
	delete process.env.YDC_API_KEY;
	delete process.env.YOUCOM_MCP_URL;
});

afterEach(() => {
	for (const key of Object.keys(ORIGINAL_ENV)) {
		if (!(key in process.env)) process.env[key] = ORIGINAL_ENV[key];
	}
	for (const key of Object.keys(process.env)) {
		if (!(key in ORIGINAL_ENV)) delete process.env[key];
	}
});

test("registers search and contents tools without commands", () => {
	const mock = createMockPi();
	youcom(mock.pi);
	const tools = mock.tools.map((tool) => (tool as { name?: string }).name);
	assert.deepEqual(tools.sort(), [CONTENTS_TOOL, SEARCH_TOOL]);
	assert.equal(mock.commands.size, 0);
});

test("keyless configuration targets the free profile endpoint", () => {
	assert.equal(hasApiKey(), false);
	assert.equal(configuredServerUrl(), "https://api.you.com/mcp?profile=free");
});

test("api key configuration targets the authenticated endpoint", () => {
	process.env.YDC_API_KEY = "test-key";
	assert.equal(hasApiKey(), true);
	assert.equal(configuredServerUrl(), "https://api.you.com/mcp");
});

test("endpoint override wins over api key state", () => {
	process.env.YDC_API_KEY = "test-key";
	process.env.YOUCOM_MCP_URL = "https://example.test/mcp";
	assert.equal(configuredServerUrl(), "https://example.test/mcp");
});

test("normalizeUrl trims and drops trailing slashes", () => {
	assert.equal(normalizeUrl(undefined), "https://api.you.com/mcp?profile=free");
	assert.equal(normalizeUrl("  https://example.test/mcp/  "), "https://example.test/mcp");
});

test("parseSseStream returns the JSON-RPC result frame", () => {
	const stream = [
		"event: message",
		'data: {"jsonrpc":"2.0","method":"notifications/message","params":{"level":"info"}}',
		"",
		"event: message",
		'data: {"jsonrpc":"2.0","id":1,"result":{"content":[{"type":"text","text":"{}"}]}}',
		"",
	].join("\n");
	const result = parseSseStream(stream) as { content: Array<{ text: string }> };
	assert.equal(result.content[0].text, "{}");
});

test("parseSseStream surfaces JSON-RPC errors", () => {
	const stream =
		'data: {"jsonrpc":"2.0","id":1,"error":{"code":-32602,"message":"Tool not found"}}\n\n';
	assert.throws(() => parseSseStream(stream), /Tool not found/);
});

test("parseSseStream rejects a stream without result frames", () => {
	assert.throws(() => parseSseStream("event: message\ndata: ping\n\n"), /no JSON-RPC result/);
});

function jsonResponse(streamBody: string) {
	return new Response(streamBody, {
		status: 200,
		headers: { "Content-Type": "text/event-stream" },
	});
}

test("youcomRequest posts a JSON-RPC tool call and parses the SSE reply", async () => {
	const calls: Array<{ url: string; init: RequestInit }> = [];
	const fetchImplementation = (async (url: string, init: RequestInit) => {
		calls.push({ url, init });
		return jsonResponse(
			'data: {"jsonrpc":"2.0","id":1,"result":{"content":[{"type":"text","text":"{\\"ok\\":true}"}]}}\n\n',
		);
	}) as typeof fetch;
	const result = (await youcomRequest(
		"tools/call",
		{ name: "you-search", arguments: { query: "node 24 lts" } },
		undefined,
		fetchImplementation,
	)) as { content: Array<{ text: string }> };
	assert.equal(calls.length, 1);
	assert.equal(calls[0].url, "https://api.you.com/mcp?profile=free");
	assert.equal(calls[0].init.method as string, "POST");
	const headers = calls[0].init.headers as Record<string, string>;
	assert.equal(headers.Accept, "application/json, text/event-stream");
	assert.equal(headers.Authorization, undefined);
	const body = JSON.parse(calls[0].init.body as string) as {
		jsonrpc: string;
		method: string;
		params: { name: string };
	};
	assert.equal(body.method, "tools/call");
	assert.equal(body.params.name, "you-search");
	assert.equal(result.content[0].text, '{"ok":true}');
});

test("youcomRequest sends the bearer header when an api key is configured", async () => {
	process.env.YDC_API_KEY = "secret-key";
	const calls: Array<{ url: string; init: RequestInit }> = [];
	const fetchImplementation = (async (url: string, init: RequestInit) => {
		calls.push({ url, init });
		return jsonResponse('data: {"jsonrpc":"2.0","id":1,"result":{}}\n\n');
	}) as typeof fetch;
	await youcomRequest("tools/list", undefined, undefined, fetchImplementation);
	assert.equal(calls.length, 1);
	assert.equal(calls[0].url, "https://api.you.com/mcp");
	const headers = calls[0].init.headers as Record<string, string>;
	assert.equal(headers.Authorization, "Bearer secret-key");
});

test("youcomRequest reports non-2xx responses with status and bounded body", async () => {
	const fetchImplementation = (async () =>
		new Response("boom", {
			status: 502,
			headers: { "Content-Type": "text/plain" },
		})) as typeof fetch;
	await assert.rejects(
		youcomRequest("tools/list", undefined, undefined, fetchImplementation),
		/HTTP 502/,
	);
});

test("youcomRequest honors external cancellation", async () => {
	const controller = new AbortController();
	const fetchImplementation = (async (_url: string, init: RequestInit) => {
		(init.signal as AbortSignal).addEventListener("abort", () => {}, { once: true });
		controller.abort(new Error("user cancelled"));
		throw new Error("fetch aborted");
	}) as typeof fetch;
	await assert.rejects(
		youcomRequest("tools/list", undefined, controller.signal, fetchImplementation),
		/user cancelled/,
	);
});

test("boundResponseText keeps small payloads intact and exposes details", async () => {
	const owner = {};
	const bounded = await boundResponseText(JSON.stringify({ ok: true }, null, 2), owner);
	assert.equal(bounded.details.truncated, false);
	assert.equal(bounded.text, JSON.stringify({ ok: true }, null, 2));
	await cleanupResponses(owner);
});

test("boundResponseText truncates large payloads and writes an artifact", async () => {
	const owner = {};
	const big = JSON.stringify({
		results: {
			web: Array.from({ length: 5_000 }, (_, i) => ({
				url: `https://example.test/${i}`,
				title: "x".repeat(200),
			})),
		},
	});
	const bounded = await boundResponseText(big, owner);
	assert.equal(bounded.details.truncated, true);
	assert.ok(bounded.details.fullResponsePath);
	assert.ok(bounded.text.includes("Output truncated"));
	assert.ok(bounded.text.length < big.length);
	const artifact = readFileSync(bounded.details.fullResponsePath as string, "utf8");
	assert.equal(artifact, big);
	await cleanupResponses(owner);
});

test("responses after shutdown are discarded", async () => {
	const owner = {};
	await cleanupResponses(owner);
	await assert.rejects(boundResponseText("x".repeat(200_000), owner), /session shutdown/);
});

test("openResponses allows a new session owner after cleanup", async () => {
	const owner = {};
	await cleanupResponses(owner);
	openResponses(owner);
	const bounded = await boundResponseText("small", owner);
	assert.equal(bounded.details.truncated, false);
	await cleanupResponses(owner);
});

test("session lifecycle opens and cleans up response artifacts", async () => {
	const mock = createMockPi();
	youcom(mock.pi);
	const sessionManager = { getSessionId: () => "lifecycle-test-session" };
	const { ctx } = createMockContext({ sessionManager });
	const owner = sessionManager;
	const prior = await boundResponseText("x".repeat(200_000), owner);
	assert.ok(prior.details.fullResponsePath);
	const directory = dirname(prior.details.fullResponsePath as string);
	await mock.events.get("session_start")?.[0]?.({}, ctx);
	await mock.events.get("session_shutdown")?.[0]?.({}, ctx);
	assert.equal(existsSync(directory), false);
});

test("tool execute paths call the client and format results", async () => {
	const originalFetch = globalThis.fetch;
	globalThis.fetch = (async () =>
		jsonResponse(
			'data: {"jsonrpc":"2.0","id":1,"result":{"content":[{"type":"text","text":"{\\"results\\":{}}"}]}}\n\n',
		)) as typeof fetch;
	const mock = createMockPi();
	youcom(mock.pi);
	const sessionManager = { getSessionId: () => "execute-test-session" };
	const { ctx: baseCtx } = createMockContext({ sessionManager });
	const statuses: Array<string | undefined> = [];
	const ctx = baseCtx as unknown as Record<string, unknown>;
	const ui = {
		...(ctx.ui as Record<string, unknown>),
		setStatus: (_key: string, text: string | undefined) => statuses.push(text),
	};
	const toolCtx = { ...ctx, ui, sessionManager };
	try {
		const tool = mock.tools.find(
			(candidate) => (candidate as { name?: string }).name === SEARCH_TOOL,
		);
		assert.ok(tool, "search tool registered");
		const result = (await (
			tool as unknown as {
				execute: (
					id: string,
					params: Record<string, unknown>,
					signal: undefined,
					onUpdate: undefined,
					ctx: unknown,
				) => Promise<{ content: Array<{ text: string }> }>;
			}
		).execute("call-1", { query: "test" }, undefined, undefined, toolCtx)) as {
			content: Array<{ text: string }>;
		};
		assert.ok(result.content[0].text.includes("results"));
		assert.ok(statuses.includes("search"));
	} finally {
		globalThis.fetch = originalFetch;
		await cleanupResponses(sessionManager);
	}
});

test("contents tool rejects execution without an api key", async () => {
	const mock = createMockPi();
	youcom(mock.pi);
	const sessionManager = { getSessionId: () => "contents-test-session" };
	const { ctx: baseCtx } = createMockContext({ sessionManager });
	const ctx = baseCtx as unknown as Record<string, unknown>;
	const tool = mock.tools.find(
		(candidate) => (candidate as { name?: string }).name === CONTENTS_TOOL,
	);
	assert.ok(tool, "contents tool registered");
	await assert.rejects(
		(
			tool as unknown as {
				execute: (
					id: string,
					params: Record<string, unknown>,
					signal: undefined,
					onUpdate: undefined,
					ctx: unknown,
				) => Promise<unknown>;
			}
		).execute("call-1", { url: "https://example.com" }, undefined, undefined, {
			...ctx,
			ui: { ...(ctx.ui as Record<string, unknown>), setStatus: () => {} },
			sessionManager,
		}),
		/YDC_API_KEY/,
	);
});

test("timeout error is distinguishable", () => {
	const error = new YoucomRequestTimeoutError();
	assert.equal(error.name, "YoucomRequestTimeoutError");
});

test("environment is restored between tests", () => {
	assert.equal(process.env.YDC_API_KEY, undefined);
});
