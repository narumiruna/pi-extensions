import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DefaultResourceLoader, SettingsManager } from "@earendil-works/pi-coding-agent";
import { afterAll, afterEach, beforeAll, test, vi } from "vitest";
import { createMockContext, createMockPi } from "../../../test/support.js";
import type { HerdrAgentStateOptions } from "../src/herdr-agent-state.js";
import { HERDR_METADATA_REFRESH_MS, HERDR_METADATA_TOKEN_KEYS } from "../src/herdr-metadata.js";

type HerdrModule = typeof import("../src/herdr-agent-state.js");
type HerdrRequest = Parameters<NonNullable<HerdrAgentStateOptions["sendRequest"]>>[0];

const packageRoot = resolve("packages/pi-herdr");
let agentDir: string;
let previousAgentDir: string | undefined;
let herdrModule: HerdrModule;

beforeAll(async () => {
	agentDir = await mkdtemp(join(tmpdir(), "pi-herdr-agent-"));
	previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	herdrModule = await import("../src/herdr-agent-state.js");
});

afterAll(async () => {
	if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
	await rm(agentDir, { force: true, recursive: true });
});

afterEach(() => {
	vi.useRealTimers();
});

function enabledOptions(requests: HerdrRequest[]): HerdrAgentStateOptions {
	return {
		environment: {
			enabled: true,
			paneId: "w1:p2",
			socketEndpoint: "/tmp/herdr.sock",
		},
		now: () => 1234,
		random: () => 0.5,
		sendRequest: async (request) => {
			requests.push(request);
		},
		widgetObserver: {
			start() {},
			async shutdown() {},
		},
	};
}

async function emit(
	mock: ReturnType<typeof createMockPi>,
	name: string,
	event: Record<string, unknown>,
	ctx: unknown,
): Promise<void> {
	for (const handler of mock.events.get(name) ?? []) await handler(event, ctx);
}

async function flushReporting(): Promise<void> {
	await new Promise<void>((resolve) => setImmediate(resolve));
}

function tuiContext(idle = true) {
	return createMockContext({
		mode: "tui",
		hasUI: true,
		isIdle: () => idle,
		sessionManager: {
			getSessionFile: () => "/sessions/pi.jsonl",
			getSessionId: () => "session-id",
		},
	});
}

function stateRequests(requests: HerdrRequest[]) {
	return requests.filter(({ method }) => method === "pane.report_agent");
}

test("Windows socket endpoints preserve qualified pipes and qualify bare names", () => {
	assert.equal(herdrModule.resolveSocketEndpoint("herdr", "win32"), "\\\\.\\pipe\\herdr");
	assert.equal(
		herdrModule.resolveSocketEndpoint("\\\\.\\pipe\\herdr", "win32"),
		"\\\\.\\pipe\\herdr",
	);
	assert.equal(
		herdrModule.resolveSocketEndpoint("\\\\?\\PIPE\\herdr", "win32"),
		"\\\\?\\PIPE\\herdr",
	);
	assert.equal(herdrModule.resolveSocketEndpoint("/tmp/herdr.sock", "linux"), "/tmp/herdr.sock");
});

test("disabled factory registers no lifecycle work", () => {
	const mock = createMockPi();
	herdrModule.createHerdrAgentStateExtension({
		environment: { enabled: false, paneId: "", socketEndpoint: "" },
	})(mock.pi);
	assert.deepEqual([...mock.events.keys()], []);
});

test("TUI lifecycle reports the session and coalesced agent states", async () => {
	const requests: HerdrRequest[] = [];
	const mock = createMockPi();
	herdrModule.createHerdrAgentStateExtension(enabledOptions(requests))(mock.pi);
	const started = tuiContext();

	await emit(mock, "session_start", { reason: "startup" }, started.ctx);
	await flushReporting();
	assert.equal(requests[0]?.method, "pane.report_agent_session");
	assert.deepEqual(requests[0]?.params, {
		pane_id: "w1:p2",
		source: "herdr:pi",
		agent: "pi",
		seq: requests[0]?.params.seq,
		session_start_source: "startup",
		agent_session_path: "/sessions/pi.jsonl",
	});
	assert.equal(stateRequests(requests).at(-1)?.params.state, "idle");

	await emit(mock, "agent_start", {}, started.ctx);
	await flushReporting();
	assert.equal(stateRequests(requests).at(-1)?.params.state, "working");

	await emit(mock, "agent_settled", {}, started.ctx);
	await flushReporting();
	assert.equal(stateRequests(requests).at(-1)?.params.state, "idle");
});

test("blocked events override working state until every blocker clears", async () => {
	const requests: HerdrRequest[] = [];
	const mock = createMockPi();
	herdrModule.createHerdrAgentStateExtension(enabledOptions(requests))(mock.pi);
	const started = tuiContext(false);
	await emit(mock, "session_start", { reason: "startup" }, started.ctx);
	await flushReporting();

	await emit(
		mock,
		"ui_prompt_start",
		{ reason: "ui_prompt", kind: "confirm", title: "Approval" },
		started.ctx,
	);
	await flushReporting();
	assert.equal(stateRequests(requests).at(-1)?.params.state, "blocked");
	assert.equal(stateRequests(requests).at(-1)?.params.message, "Approval");

	await emit(
		mock,
		"ui_prompt_start",
		{ reason: "ui_prompt", kind: "input", title: "Question" },
		started.ctx,
	);
	await emit(
		mock,
		"ui_prompt_end",
		{ reason: "ui_prompt", kind: "confirm", title: "Approval" },
		started.ctx,
	);
	await flushReporting();
	assert.equal(stateRequests(requests).at(-1)?.params.state, "blocked");

	await emit(
		mock,
		"ui_prompt_end",
		{ reason: "ui_prompt", kind: "input", title: "Question" },
		started.ctx,
	);
	await flushReporting();
	assert.equal(stateRequests(requests).at(-1)?.params.state, "working");
});

test("non-TUI sessions never report state", async () => {
	const requests: HerdrRequest[] = [];
	const observerStarts: string[] = [];
	const observerShutdowns: string[] = [];
	const mock = createMockPi();
	herdrModule.createHerdrAgentStateExtension({
		...enabledOptions(requests),
		widgetObserver: {
			start(ctx) {
				observerStarts.push(ctx.mode);
			},
			async shutdown(ctx) {
				observerShutdowns.push(ctx.mode);
			},
		},
	})(mock.pi);
	const started = createMockContext({ mode: "rpc", hasUI: true });
	await emit(mock, "session_start", { reason: "startup" }, started.ctx);
	await emit(mock, "agent_start", {}, started.ctx);
	await emit(mock, "agent_settled", {}, started.ctx);
	await emit(
		mock,
		"ui_prompt_start",
		{ reason: "ui_prompt", kind: "confirm", title: "Hidden" },
		started.ctx,
	);
	await emit(mock, "session_shutdown", { reason: "quit" }, started.ctx);
	await flushReporting();
	assert.deepEqual(requests, []);
	assert.deepEqual(observerStarts, []);
	assert.deepEqual(observerShutdowns, ["rpc"]);
});

test("TUI sessions start and shut down the widget observer", async () => {
	const requests: HerdrRequest[] = [];
	const events: string[] = [];
	const mock = createMockPi();
	herdrModule.createHerdrAgentStateExtension({
		...enabledOptions(requests),
		widgetObserver: {
			start(ctx) {
				events.push(`start:${ctx.mode}`);
			},
			async shutdown(ctx) {
				events.push(`shutdown:${ctx.mode}`);
			},
		},
	})(mock.pi);
	const started = tuiContext();
	await emit(mock, "session_start", { reason: "startup" }, started.ctx);
	await emit(mock, "session_shutdown", { reason: "reload" }, started.ctx);
	assert.deepEqual(events, ["start:tui", "shutdown:tui"]);
});

test("publishes changed metadata from every authoritative event and refreshes bounded TTL", async () => {
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
	const requests: HerdrRequest[] = [];
	const mock = createMockPi();
	mock.rawPi.setSessionName("Initial session");
	let contextUsagePercent: number | null = 24.4;
	const started = tuiContext();
	const mutableContext = started.ctx as unknown as {
		model?: { id: string; provider: string };
		thinkingLevel?: string;
	};
	mutableContext.model = { id: "claude-sonnet", provider: "anthropic" };
	mutableContext.thinkingLevel = "high";
	(started.ctx as unknown as { getContextUsage(): unknown }).getContextUsage = () => ({
		tokens: 24,
		contextWindow: 100,
		percent: contextUsagePercent,
	});
	herdrModule.createHerdrAgentStateExtension(enabledOptions(requests))(mock.pi);

	await emit(mock, "session_start", { reason: "startup" }, started.ctx);
	await flushReporting();
	const metadataRequests = () => requests.filter(({ method }) => method === "pane.report_metadata");
	assert.deepEqual(metadataRequests().at(-1)?.params.tokens, {
		model: "claude-sonnet",
		provider: "anthropic",
		thinking: "high",
		session: "Initial session",
		context_usage: "24%",
	});
	assert.equal(metadataRequests().at(-1)?.params.ttl_ms, 3_600_000);

	for (const name of [
		"session_info_changed",
		"model_select",
		"thinking_level_select",
		"agent_settled",
		"session_compact",
	]) {
		await emit(mock, name, {}, started.ctx);
	}
	await flushReporting();
	assert.equal(metadataRequests().length, 1);

	mock.rawPi.setSessionName("Renamed session");
	await emit(mock, "session_info_changed", { name: "Renamed session" }, started.ctx);
	mutableContext.model = { id: "gpt-5", provider: "openai" };
	await emit(mock, "model_select", {}, started.ctx);
	mutableContext.thinkingLevel = "medium";
	await emit(mock, "thinking_level_select", {}, started.ctx);
	contextUsagePercent = 49.6;
	await emit(mock, "agent_settled", {}, started.ctx);
	contextUsagePercent = null;
	await emit(mock, "session_compact", {}, started.ctx);
	await flushReporting();
	assert.deepEqual(metadataRequests().at(-1)?.params.tokens, {
		model: "gpt-5",
		provider: "openai",
		thinking: "medium",
		session: "Renamed session",
		context_usage: null,
	});
	assert.equal(metadataRequests().length, 6);

	const beforeRefresh = metadataRequests().length;
	await vi.advanceTimersByTimeAsync(HERDR_METADATA_REFRESH_MS - 1);
	assert.equal(metadataRequests().length, beforeRefresh);
	await vi.advanceTimersByTimeAsync(1);
	assert.equal(metadataRequests().length, beforeRefresh + 1);
	assert.deepEqual(
		metadataRequests().at(-1)?.params.tokens,
		metadataRequests().at(-2)?.params.tokens,
	);

	mock.rawPi.setSessionName(undefined as never);
	await emit(mock, "session_info_changed", { name: undefined }, started.ctx);
	await flushReporting();
	const renamedMetadata = metadataRequests().at(-1);
	assert.ok(renamedMetadata);
	assert.equal((renamedMetadata.params.tokens as Record<string, unknown>).session, null);
	await emit(mock, "session_shutdown", { reason: "quit" }, started.ctx);
	const clear = metadataRequests().at(-1);
	assert.deepEqual(
		clear?.params.tokens,
		Object.fromEntries(HERDR_METADATA_TOKEN_KEYS.map((key) => [key, null])),
	);
	assert.deepEqual(Object.keys(clear?.params.tokens as object), [...HERDR_METADATA_TOKEN_KEYS]);
	const afterShutdown = metadataRequests().length;
	await vi.advanceTimersByTimeAsync(HERDR_METADATA_REFRESH_MS * 2);
	assert.equal(metadataRequests().length, afterShutdown);
});

test("coalesces rapid metadata changes behind one delayed send", async () => {
	const requests: HerdrRequest[] = [];
	let release!: () => void;
	const delayed = new Promise<void>((resolve) => {
		release = resolve;
	});
	let delayedMetadata = true;
	const mock = createMockPi();
	const started = tuiContext();
	const mutableContext = started.ctx as unknown as {
		model?: { id: string; provider: string };
	};
	mutableContext.model = { id: "first", provider: "provider" };
	herdrModule.createHerdrAgentStateExtension({
		...enabledOptions(requests),
		async sendRequest(request) {
			requests.push(request);
			if (request.method === "pane.report_metadata" && delayedMetadata) {
				delayedMetadata = false;
				await delayed;
			}
		},
	})(mock.pi);

	await emit(mock, "session_start", { reason: "startup" }, started.ctx);
	await flushReporting();
	mutableContext.model = { id: "second", provider: "provider" };
	await emit(mock, "model_select", {}, started.ctx);
	mutableContext.model = { id: "latest", provider: "provider" };
	await emit(mock, "model_select", {}, started.ctx);
	assert.equal(requests.filter(({ method }) => method === "pane.report_metadata").length, 1);
	release();
	await flushReporting();
	await flushReporting();
	const metadata = requests.filter(({ method }) => method === "pane.report_metadata");
	assert.equal(metadata.length, 2);
	assert.ok(metadata[0]);
	assert.ok(metadata[1]);
	assert.equal((metadata[0].params.tokens as Record<string, unknown>).model, "first");
	assert.equal((metadata[1].params.tokens as Record<string, unknown>).model, "latest");
	await emit(mock, "session_shutdown", { reason: "quit" }, started.ctx);
});

test("replacement aborts stale metadata and prevents an older shutdown clear", async () => {
	const requests: Array<{ request: HerdrRequest; signal: AbortSignal }> = [];
	let release!: () => void;
	const delayed = new Promise<void>((resolve) => {
		release = resolve;
	});
	let delayFirstMetadata = true;
	const mock = createMockPi();
	herdrModule.createHerdrAgentStateExtension({
		...enabledOptions([]),
		async sendRequest(request, signal) {
			requests.push({ request, signal });
			if (request.method === "pane.report_metadata" && delayFirstMetadata) {
				delayFirstMetadata = false;
				await delayed;
			}
		},
	})(mock.pi);
	const oldSession = tuiContext();
	const replacement = tuiContext();
	(oldSession.ctx as unknown as { model: unknown }).model = {
		id: "old",
		provider: "provider",
	};
	(replacement.ctx as unknown as { model: unknown }).model = {
		id: "replacement",
		provider: "provider",
	};

	await emit(mock, "session_start", { reason: "startup" }, oldSession.ctx);
	await flushReporting();
	const stoppingOld = emit(mock, "session_shutdown", { reason: "reload" }, oldSession.ctx);
	const oldMetadata = requests.find(({ request }) => request.method === "pane.report_metadata");
	assert.equal(oldMetadata?.signal.aborted, true);
	await emit(mock, "session_start", { reason: "reload" }, replacement.ctx);
	release();
	await stoppingOld;
	await flushReporting();
	const metadataBeforeFinalShutdown = requests
		.map(({ request }) => request)
		.filter(({ method }) => method === "pane.report_metadata");
	assert.equal(
		metadataBeforeFinalShutdown.some(({ params }) =>
			Object.values(params.tokens as Record<string, unknown>).every((value) => value === null),
		),
		false,
	);
	const firstMetadata = metadataBeforeFinalShutdown[0];
	const latestMetadata = metadataBeforeFinalShutdown.at(-1);
	assert.ok(firstMetadata);
	assert.ok(latestMetadata);
	assert.equal((latestMetadata.params.tokens as Record<string, unknown>).model, "replacement");
	assert.ok(Number(firstMetadata.params.seq) < Number(latestMetadata.params.seq));
	const beforeStaleEvents = metadataBeforeFinalShutdown.length;
	await emit(mock, "agent_settled", {}, replacement.ctx);
	await emit(mock, "model_select", {}, oldSession.ctx);
	await flushReporting();
	assert.equal(
		requests.filter(({ request }) => request.method === "pane.report_metadata").length,
		beforeStaleEvents,
	);
	await emit(mock, "session_shutdown", { reason: "quit" }, replacement.ctx);
});

test("repeated shutdown shares cleanup and sends exactly one clear patch", async () => {
	const requests: HerdrRequest[] = [];
	let release!: () => void;
	const delayed = new Promise<void>((resolve) => {
		release = resolve;
	});
	let delayMetadata = true;
	const mock = createMockPi();
	herdrModule.createHerdrAgentStateExtension({
		...enabledOptions(requests),
		async sendRequest(request) {
			requests.push(request);
			if (request.method === "pane.report_metadata" && delayMetadata) {
				delayMetadata = false;
				await delayed;
			}
		},
	})(mock.pi);
	const started = tuiContext();
	await emit(mock, "session_start", { reason: "startup" }, started.ctx);
	await flushReporting();
	const metadataBeforeShutdown = requests.filter(
		({ method }) => method === "pane.report_metadata",
	).length;
	const firstShutdown = emit(mock, "session_shutdown", { reason: "quit" }, started.ctx);
	const repeatedShutdown = emit(mock, "session_shutdown", { reason: "quit" }, started.ctx);
	release();
	await Promise.all([firstShutdown, repeatedShutdown]);
	const metadataAfterShutdown = requests.filter(({ method }) => method === "pane.report_metadata");
	assert.equal(metadataAfterShutdown.length, metadataBeforeShutdown + 1);
	const clearPatch = metadataAfterShutdown.at(-1);
	assert.ok(clearPatch);
	assert.equal(
		Object.values(clearPatch.params.tokens as Record<string, unknown>).every(
			(value) => value === null,
		),
		true,
	);
});

test("metadata failures never interrupt lifecycle or orderly shutdown", async () => {
	const mock = createMockPi();
	herdrModule.createHerdrAgentStateExtension({
		...enabledOptions([]),
		async sendRequest() {
			throw new Error("socket unavailable");
		},
	})(mock.pi);
	const started = tuiContext();
	await emit(mock, "session_start", { reason: "startup" }, started.ctx);
	await emit(mock, "model_select", {}, started.ctx);
	await emit(mock, "session_shutdown", { reason: "quit" }, started.ctx);
});

test("socket transport retries one failed delivery and preserves the request", async () => {
	const socketPath = join(agentDir, "herdr-test.sock");
	const received: HerdrRequest[] = [];
	const attemptsById = new Map<string, number>();
	let reportState!: () => void;
	const stateReceived = new Promise<void>((resolve) => {
		reportState = resolve;
	});
	const server = net.createServer((socket) => {
		let input = "";
		socket.on("error", () => {
			// The client closes immediately after Herdr acknowledges delivery.
		});
		socket.on("data", (chunk) => {
			input += chunk.toString();
			const newline = input.indexOf("\n");
			if (newline < 0) return;
			const request = JSON.parse(input.slice(0, newline)) as HerdrRequest;
			received.push(request);
			const attempts = (attemptsById.get(request.id) ?? 0) + 1;
			attemptsById.set(request.id, attempts);
			if (request.method === "pane.report_agent_session" && attempts === 1) socket.end();
			else socket.write("{}\n");
			if (request.method === "pane.report_agent") reportState();
		});
	});
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(socketPath, resolve);
	});

	const mock = createMockPi();
	herdrModule.createHerdrAgentStateExtension({
		environment: { enabled: true, paneId: "w1:p2", socketEndpoint: socketPath },
		widgetObserver: {
			start() {},
			async shutdown() {},
		},
	})(mock.pi);
	const started = tuiContext();
	try {
		await emit(mock, "session_start", { reason: "startup" }, started.ctx);
		await stateReceived;
		const sessionReports = received.filter(
			(request) => request.method === "pane.report_agent_session",
		);
		assert.equal(sessionReports.length, 2);
		assert.equal(sessionReports[0]?.id, sessionReports[1]?.id);
		assert.equal(
			received.some((request) => request.method === "pane.report_metadata"),
			true,
		);
		assert.equal(stateRequests(received).at(-1)?.params.state, "idle");
	} finally {
		await emit(mock, "session_shutdown", { reason: "quit" }, started.ctx);
		await new Promise<void>((resolve, reject) => {
			server.close((error) => (error ? reject(error) : resolve()));
		});
		await rm(socketPath, { force: true });
	}
});

test("shutdown aborts a delayed session report before it can publish state", async () => {
	const requests: HerdrRequest[] = [];
	let release!: () => void;
	const delayed = new Promise<void>((resolve) => {
		release = resolve;
	});
	let firstSignal: AbortSignal | undefined;
	const mock = createMockPi();
	herdrModule.createHerdrAgentStateExtension({
		...enabledOptions(requests),
		sendRequest: async (request, signal) => {
			requests.push(request);
			firstSignal ??= signal;
			await delayed;
		},
	})(mock.pi);
	const started = tuiContext();

	const starting = emit(mock, "session_start", { reason: "startup" }, started.ctx);
	await flushReporting();
	assert.equal(requests.filter(({ method }) => method === "pane.report_agent_session").length, 1);
	assert.equal(requests.filter(({ method }) => method === "pane.report_metadata").length, 1);
	const shuttingDown = emit(mock, "session_shutdown", { reason: "reload" }, started.ctx);
	assert.equal(firstSignal?.aborted, true);
	release();
	await Promise.all([starting, shuttingDown]);
	await flushReporting();
	assert.equal(stateRequests(requests).length, 0);
	assert.deepEqual(
		requests.filter(({ method }) => method === "pane.report_metadata").at(-1)?.params.tokens,
		Object.fromEntries(HERDR_METADATA_TOKEN_KEYS.map((key) => [key, null])),
	);

	const requestCount = requests.length;
	await emit(
		mock,
		"ui_prompt_start",
		{ reason: "ui_prompt", kind: "confirm", title: "Stale" },
		started.ctx,
	);
	await flushReporting();
	assert.equal(requests.length, requestCount);
});

test("a disabled widget does not disable lifecycle or metadata reporting", async () => {
	const settingsPath = join(agentDir, "disabled-widget.json");
	await writeFile(settingsPath, JSON.stringify({ widget: false }));
	const requests: HerdrRequest[] = [];
	const mock = createMockPi();
	const start = vi.fn();
	herdrModule.createHerdrAgentStateExtension({
		...enabledOptions(requests),
		settingsPath,
		widgetObserver: { start, async shutdown() {} },
	})(mock.pi);
	const ctx = tuiContext().ctx;
	await emit(mock, "session_start", { reason: "startup" }, ctx);
	await flushReporting();
	assert.equal(start.mock.calls.length, 0);
	assert.ok(requests.some(({ method }) => method === "pane.report_metadata"));
	assert.equal(stateRequests(requests).at(-1)?.params.state, "idle");
	await emit(mock, "session_shutdown", {}, ctx);
});

test("package resources load one extension and the bundled herdr skill", async () => {
	const loader = new DefaultResourceLoader({
		cwd: agentDir,
		agentDir,
		settingsManager: SettingsManager.inMemory({ packages: [packageRoot] }),
		additionalSkillPaths: [join(packageRoot, "skills", "herdr", "SKILL.md")],
		noSkills: true,
		noContextFiles: true,
	});
	await loader.reload();

	const extensions = loader.getExtensions();
	assert.deepEqual(extensions.errors, []);
	assert.equal(extensions.extensions.length, 1);
	const skills = loader.getSkills();
	assert.deepEqual(skills.diagnostics, []);
	assert.deepEqual(
		skills.skills.map(({ name }) => name),
		["herdr"],
	);
});
