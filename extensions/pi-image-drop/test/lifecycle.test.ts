import assert from "node:assert/strict";
import test from "node:test";
import { createMockContext, createMockPi } from "../../../test/support.js";
import { digestImages, type ProcessedImage } from "../src/batch.js";
import { ImageDropRuntime } from "../src/runtime.js";
import type { ImageDropServerOptions } from "../src/server.js";
import { DEFAULT_SETTINGS } from "../src/settings.js";

const PNG = Buffer.from("processed-png");
const PROCESSED: ProcessedImage = {
	bytes: PNG,
	mimeType: "image/png",
	width: 10,
	height: 20,
	originalWidth: 10,
	originalHeight: 20,
	sourceFormat: "png",
	outputFormat: "png",
	resized: false,
	hash: "hash-one",
	notes: [],
};

function createHarness(options: { idle?: () => boolean; pending?: () => boolean } = {}) {
	const mock = createMockPi();
	let serverOptions: ImageDropServerOptions | undefined;
	let serverStarts = 0;
	let serverCloses = 0;
	let links = 0;
	const server = {
		issueLink: () => `http://127.0.0.1:1234/bootstrap?token=${++links}`,
		broadcastState() {},
		async close() {
			serverCloses += 1;
		},
	};
	const runtime = new ImageDropRuntime(mock.pi, {
		loadSettings: async () => ({ kind: "missing", settings: { ...DEFAULT_SETTINGS } }),
		readPiSettings: async () => ({ autoResize: true, blockImages: false, warnings: [] }),
		startServer: async (received) => {
			serverStarts += 1;
			serverOptions = received;
			return server;
		},
	});
	runtime.register();
	const context = createMockContext({
		cwd: "/workspace/image-drop",
		model: { id: "vision", provider: "test", input: ["text", "image"] },
		isIdle: options.idle ?? (() => true),
		hasPendingMessages: options.pending ?? (() => false),
	});
	return {
		mock,
		runtime,
		context,
		server,
		get serverOptions() {
			return serverOptions;
		},
		get serverStarts() {
			return serverStarts;
		},
		get serverCloses() {
			return serverCloses;
		},
	};
}

async function emit(
	mock: ReturnType<typeof createMockPi>,
	name: string,
	event: unknown,
	ctx: unknown,
) {
	const handler = mock.events.get(name)?.[0];
	assert.ok(handler, `missing ${name} handler`);
	return handler(event, ctx);
}

test("interactive input appends one ready ordered batch and commits on matching user message", async () => {
	const { mock, runtime, context } = createHarness();
	await emit(mock, "session_start", {}, context.ctx);
	runtime.addReadyImageForTesting("one", "one.png", Buffer.from("source"), PROCESSED);
	const existing = { type: "image" as const, data: "existing", mimeType: "image/jpeg" };

	const transformed = (await emit(
		mock,
		"input",
		{
			type: "input",
			text: "compare",
			images: [existing],
			source: "interactive",
		},
		context.ctx,
	)) as {
		action: string;
		text: string;
		images: Array<{ type: string; data: string; mimeType: string }>;
	};
	assert.equal(transformed.action, "transform");
	assert.equal(transformed.text, "compare");
	assert.deepEqual(transformed.images, [
		existing,
		{ type: "image", data: PNG.toString("base64"), mimeType: "image/png" },
	]);
	assert.equal(runtime.getBatchForTesting()?.publicState().phase, "reserved");
	assert.match(String(context.widgets.get("image-drop")), /queued/);

	await emit(
		mock,
		"message_start",
		{
			type: "message_start",
			message: {
				role: "user",
				content: [{ type: "text", text: "compare" }, ...transformed.images],
			},
		},
		context.ctx,
	);
	assert.equal(runtime.getBatchForTesting()?.publicState().phase, "empty");
	assert.equal(context.widgets.get("image-drop"), undefined);
});

test("agent_settled restores a queued reservation that never became a user message", async () => {
	let idle = false;
	let pending = true;
	const { mock, runtime, context } = createHarness({
		idle: () => idle,
		pending: () => pending,
	});
	await emit(mock, "session_start", {}, context.ctx);
	runtime.addReadyImageForTesting("one", "one.png", Buffer.from("source"), PROCESSED);
	const result = (await emit(
		mock,
		"input",
		{
			type: "input",
			text: "queued prompt",
			source: "interactive",
			streamingBehavior: "steer",
		},
		context.ctx,
	)) as { action: string; images: Array<{ type: "image"; data: string; mimeType: string }> };
	assert.equal(result.action, "transform");
	assert.equal(
		digestImages(result.images),
		runtime.getBatchForTesting()?.currentReservation()?.digest,
	);

	idle = true;
	pending = false;
	await emit(mock, "agent_settled", {}, context.ctx);
	assert.equal(context.editorText, "queued prompt");
	assert.equal(runtime.getBatchForTesting()?.publicState().phase, "ready");
	assert.match(context.notifications.at(-1)?.message ?? "", /restored/i);
});

test("/image-drop lazily starts one server, rotates links, and shutdown releases it", async () => {
	const harness = createHarness();
	await emit(harness.mock, "session_start", {}, harness.context.ctx);
	assert.equal(harness.serverStarts, 0);
	await Promise.all([
		harness.mock.commands.get("image-drop")?.handler("", harness.context.ctx),
		harness.mock.commands.get("image-drop")?.handler("", harness.context.ctx),
	]);
	assert.equal(harness.serverStarts, 1);
	assert.equal(harness.serverOptions?.projectName, "image-drop");
	assert.match(harness.context.notifications[0]?.message ?? "", /token=1/);
	assert.match(harness.context.notifications[1]?.message ?? "", /token=2/);
	assert.match(String(harness.context.widgets.get("image-drop")), /127\.0\.0\.1/);
	await emit(harness.mock, "session_shutdown", {}, harness.context.ctx);
	assert.equal(harness.serverCloses, 1);
	assert.equal(harness.context.widgets.get("image-drop"), undefined);
});

test("browser processing re-reads Pi settings and guards model and blockImages", async () => {
	let settings = { autoResize: false, blockImages: false, warnings: [] as string[] };
	const mock = createMockPi();
	let serverOptions: ImageDropServerOptions | undefined;
	const runtime = new ImageDropRuntime(mock.pi, {
		loadSettings: async () => ({ kind: "missing", settings: { ...DEFAULT_SETTINGS } }),
		readPiSettings: async () => settings,
		startServer: async (options) => {
			serverOptions = options;
			return {
				issueLink: () => "http://127.0.0.1/link",
				broadcastState() {},
				close: async () => {},
			};
		},
	});
	runtime.register();
	const context = createMockContext({
		model: { id: "vision", provider: "test", input: ["text", "image"] },
	});
	await emit(mock, "session_start", {}, context.ctx);
	await mock.commands.get("image-drop")?.handler("", context.ctx);
	assert.equal(await serverOptions?.getAutoResize(), false);
	settings = { autoResize: true, blockImages: true, warnings: [] };
	await assert.rejects(serverOptions?.getAutoResize() ?? Promise.resolve(), /disabled/i);
	settings = { autoResize: true, blockImages: false, warnings: [] };
	(context.ctx as unknown as { model: unknown }).model = {
		id: "text",
		provider: "test",
		input: ["text"],
	};
	await assert.rejects(serverOptions?.getAutoResize() ?? Promise.resolve(), /does not support/i);
});

test("submission reprocesses retained sources after autoResize changes", async () => {
	const mock = createMockPi();
	const seen: boolean[] = [];
	const runtime = new ImageDropRuntime(mock.pi, {
		loadSettings: async () => ({ kind: "missing", settings: { ...DEFAULT_SETTINGS } }),
		readPiSettings: async () => ({ autoResize: false, blockImages: false, warnings: [] }),
		createProcessor: () => ({
			process: async (_source, options) => {
				seen.push(options.autoResize);
				return { ...PROCESSED, bytes: Buffer.from("reprocessed"), hash: "reprocessed" };
			},
		}),
	});
	runtime.register();
	const context = createMockContext({
		model: { id: "vision", provider: "test", input: ["text", "image"] },
	});
	await emit(mock, "session_start", {}, context.ctx);
	runtime.addReadyImageForTesting("one", "one.png", Buffer.from("source"), PROCESSED);
	const result = (await emit(
		mock,
		"input",
		{ type: "input", text: "use current setting", source: "interactive" },
		context.ctx,
	)) as { action: string; images: Array<{ data: string }> };
	assert.equal(result.action, "transform");
	assert.deepEqual(seen, [false]);
	assert.equal(result.images[0]?.data, Buffer.from("reprocessed").toString("base64"));
});

test("failed setting-change reprocessing restores text and blocks the batch", async () => {
	const mock = createMockPi();
	const runtime = new ImageDropRuntime(mock.pi, {
		loadSettings: async () => ({ kind: "missing", settings: { ...DEFAULT_SETTINGS } }),
		readPiSettings: async () => ({ autoResize: false, blockImages: false, warnings: [] }),
		createProcessor: () => ({
			process: async () => Promise.reject(new Error("no-resize output is too large")),
		}),
	});
	runtime.register();
	const context = createMockContext({
		model: { id: "vision", provider: "test", input: ["text", "image"] },
	});
	await emit(mock, "session_start", {}, context.ctx);
	runtime.addReadyImageForTesting("one", "one.png", Buffer.from("source"), PROCESSED);
	const result = (await emit(
		mock,
		"input",
		{ type: "input", text: "keep this", source: "interactive" },
		context.ctx,
	)) as { action: string };
	assert.equal(result.action, "handled");
	assert.equal(context.editorText, "keep this");
	assert.equal(runtime.getBatchForTesting()?.publicState().phase, "blocked");
	assert.match(runtime.getBatchForTesting()?.publicState().items[0]?.error ?? "", /too large/i);
});

test("a new input at an idle recovery boundary preserves both drafts for resubmission", async () => {
	let idle = false;
	const { mock, runtime, context } = createHarness({ idle: () => idle });
	await emit(mock, "session_start", {}, context.ctx);
	runtime.addReadyImageForTesting("one", "one.png", Buffer.from("source"), PROCESSED);
	await emit(
		mock,
		"input",
		{ type: "input", text: "failed preflight", source: "interactive" },
		context.ctx,
	);
	idle = true;
	const result = (await emit(
		mock,
		"input",
		{ type: "input", text: "new draft", source: "interactive" },
		context.ctx,
	)) as { action: string };
	assert.equal(result.action, "handled");
	assert.equal(context.editorText, "failed preflight\n\nnew draft");
	assert.equal(runtime.getBatchForTesting()?.publicState().phase, "ready");
});

test("agent_settled recovery does not overwrite a newer editor draft", async () => {
	let idle = false;
	let pending = true;
	const { mock, runtime, context } = createHarness({ idle: () => idle, pending: () => pending });
	await emit(mock, "session_start", {}, context.ctx);
	runtime.addReadyImageForTesting("one", "one.png", Buffer.from("source"), PROCESSED);
	await emit(
		mock,
		"input",
		{ type: "input", text: "queued prompt", source: "interactive", streamingBehavior: "steer" },
		context.ctx,
	);
	(context.ctx as unknown as { ui: { setEditorText(value: string): void } }).ui.setEditorText(
		"newer draft",
	);
	idle = true;
	pending = false;
	await emit(mock, "agent_settled", {}, context.ctx);
	assert.equal(context.editorText, "newer draft\n\nqueued prompt");
});

test("the next command recovers an idle preflight reservation that never started", async () => {
	let idle = false;
	const { mock, runtime, context } = createHarness({ idle: () => idle });
	await emit(mock, "session_start", {}, context.ctx);
	runtime.addReadyImageForTesting("one", "one.png", Buffer.from("source"), PROCESSED);
	const result = (await emit(
		mock,
		"input",
		{ type: "input", text: "preflight failed", source: "interactive" },
		context.ctx,
	)) as { action: string };
	assert.equal(result.action, "transform");

	idle = true;
	await mock.commands.get("image-drop")?.handler("", context.ctx);
	assert.equal(context.editorText, "preflight failed");
	assert.equal(runtime.getBatchForTesting()?.publicState().phase, "ready");
	assert.match(context.notifications[0]?.message ?? "", /restored/i);
});

test("follow-up input commits only after the matching ordered image message starts", async () => {
	const { mock, runtime, context } = createHarness();
	await emit(mock, "session_start", {}, context.ctx);
	runtime.addReadyImageForTesting("one", "one.png", Buffer.from("source"), PROCESSED);
	const transformed = (await emit(
		mock,
		"input",
		{
			type: "input",
			text: "later",
			source: "interactive",
			streamingBehavior: "followUp",
		},
		context.ctx,
	)) as { action: string; images: Array<{ type: string; data: string; mimeType: string }> };
	assert.equal(transformed.action, "transform");
	await emit(
		mock,
		"message_start",
		{ message: { role: "user", content: [{ type: "text", text: "unrelated" }] } },
		context.ctx,
	);
	assert.equal(runtime.getBatchForTesting()?.publicState().phase, "reserved");
	const laterImage = { type: "image", data: "later", mimeType: "image/jpeg" };
	await emit(
		mock,
		"message_start",
		{ message: { role: "user", content: [...transformed.images, laterImage] } },
		context.ctx,
	);
	assert.equal(runtime.getBatchForTesting()?.publicState().phase, "empty");
});

test("empty image-only interactive input does not consume the browser batch", async () => {
	const { mock, runtime, context } = createHarness();
	await emit(mock, "session_start", {}, context.ctx);
	runtime.addReadyImageForTesting("one", "one.png", Buffer.from("source"), PROCESSED);
	const result = (await emit(
		mock,
		"input",
		{
			type: "input",
			text: "  ",
			images: [{ type: "image", data: "x", mimeType: "image/png" }],
			source: "interactive",
		},
		context.ctx,
	)) as { action: string };
	assert.equal(result.action, "continue");
	assert.equal(runtime.getBatchForTesting()?.publicState().phase, "ready");
});

test("session replacement closes the old server and clears every staged byte", async () => {
	const harness = createHarness();
	await emit(harness.mock, "session_start", {}, harness.context.ctx);
	await harness.mock.commands.get("image-drop")?.handler("", harness.context.ctx);
	harness.runtime.addReadyImageForTesting("one", "one.png", Buffer.from("source"), PROCESSED);
	await emit(harness.mock, "session_start", {}, harness.context.ctx);
	assert.equal(harness.serverCloses, 1);
	assert.equal(harness.runtime.getBatchForTesting()?.publicState().phase, "empty");
	assert.equal(harness.context.widgets.get("image-drop"), undefined);
});

test("an overlapping stale session start cannot replace the newer session", async () => {
	const mock = createMockPi();
	let resolveFirst!: (value: { kind: "missing"; settings: typeof DEFAULT_SETTINGS }) => void;
	let calls = 0;
	const runtime = new ImageDropRuntime(mock.pi, {
		loadSettings: () => {
			calls += 1;
			if (calls === 1) {
				return new Promise((resolve) => {
					resolveFirst = resolve;
				});
			}
			return Promise.resolve({ kind: "missing", settings: { ...DEFAULT_SETTINGS } });
		},
	});
	const oldContext = createMockContext({ cwd: "/workspace/old" });
	const newContext = createMockContext({ cwd: "/workspace/new" });
	const staleStart = runtime.start(oldContext.ctx);
	await new Promise((resolve) => setImmediate(resolve));
	await runtime.start(newContext.ctx);
	const currentBatch = runtime.getBatchForTesting();
	resolveFirst({ kind: "missing", settings: { ...DEFAULT_SETTINGS } });
	await staleStart;
	assert.equal(runtime.getBatchForTesting(), currentBatch);
});

test("non-ready batches block submission and restore editor text", async () => {
	const { mock, runtime, context } = createHarness();
	await emit(mock, "session_start", {}, context.ctx);
	runtime.getBatchForTesting()?.reserveItems([{ id: "pending", name: "pending.png", size: 4 }]);
	const result = (await emit(
		mock,
		"input",
		{ type: "input", text: "do not lose me", source: "interactive" },
		context.ctx,
	)) as { action: string };
	assert.equal(result.action, "handled");
	assert.equal(context.editorText, "do not lose me");
	assert.match(context.notifications.at(-1)?.message ?? "", /wait/i);
});

test("text-only models preserve the draft and text", async () => {
	const { mock, runtime, context } = createHarness();
	(context.ctx as unknown as { model: unknown }).model = {
		id: "text",
		provider: "test",
		input: ["text"],
	};
	await emit(mock, "session_start", {}, context.ctx);
	runtime.addReadyImageForTesting("one", "one.png", Buffer.from("source"), PROCESSED);
	const result = (await emit(
		mock,
		"input",
		{ type: "input", text: "blocked", source: "interactive" },
		context.ctx,
	)) as { action: string };
	assert.equal(result.action, "handled");
	assert.equal(context.editorText, "blocked");
	assert.equal(runtime.getBatchForTesting()?.publicState().phase, "ready");
	assert.match(context.notifications.at(-1)?.message ?? "", /does not support/i);
});

test("blockImages preserves the draft and text", async () => {
	const mock = createMockPi();
	const runtime = new ImageDropRuntime(mock.pi, {
		loadSettings: async () => ({ kind: "missing", settings: { ...DEFAULT_SETTINGS } }),
		readPiSettings: async () => ({ autoResize: true, blockImages: true, warnings: [] }),
	});
	runtime.register();
	const context = createMockContext({
		model: { id: "vision", provider: "test", input: ["text", "image"] },
	});
	await emit(mock, "session_start", {}, context.ctx);
	runtime.addReadyImageForTesting("one", "one.png", Buffer.from("source"), PROCESSED);
	const result = (await emit(
		mock,
		"input",
		{ type: "input", text: "blocked", source: "interactive" },
		context.ctx,
	)) as { action: string };
	assert.equal(result.action, "handled");
	assert.equal(context.editorText, "blocked");
	assert.equal(runtime.getBatchForTesting()?.publicState().phase, "ready");
	assert.match(context.notifications.at(-1)?.message ?? "", /disabled/i);
});

test("non-interactive inputs never consume a browser batch", async () => {
	const { mock, runtime, context } = createHarness();
	await emit(mock, "session_start", {}, context.ctx);
	runtime.addReadyImageForTesting("one", "one.png", Buffer.from("source"), PROCESSED);
	for (const source of ["rpc", "extension"] as const) {
		const result = (await emit(
			mock,
			"input",
			{ type: "input", text: "external", source },
			context.ctx,
		)) as { action: string };
		assert.equal(result.action, "continue");
	}
	assert.equal(runtime.getBatchForTesting()?.publicState().phase, "ready");
});
