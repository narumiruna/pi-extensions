import assert from "node:assert/strict";
import test from "node:test";
import { type RuntimeDependencies, WebUIRuntime } from "../src/runtime.js";
import type { WebSendRequest, WebUIServerOptions } from "../src/server.js";

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

function harness(overrides: Partial<RuntimeDependencies> = {}) {
	const commands = new Map<string, { handler: (args: string, ctx: never) => Promise<void> }>();
	const events = new Map<string, Array<(event: never, ctx: never) => Promise<void> | void>>();
	const sent: Array<{ content: unknown; options?: unknown }> = [];
	const notifications: string[] = [];
	const widgets = new Map<string, unknown>();
	let idle = true;
	let pending = false;
	let branch: unknown[] = [
		{
			type: "message",
			id: "existing",
			message: { role: "user", content: "before", timestamp: 1 },
		},
	];
	let serverOptions: WebUIServerOptions | undefined;
	let starts = 0;
	let closes = 0;
	let links = 0;
	const server = {
		issueLink() {
			links += 1;
			return `http://127.0.0.1:1234/bootstrap?token=${links}`;
		},
		async close() {
			closes += 1;
		},
	};
	const pi = {
		registerCommand(name: string, command: never) {
			commands.set(name, command);
		},
		on(name: string, handler: never) {
			events.set(name, [...(events.get(name) ?? []), handler]);
		},
		sendUserMessage(content: unknown, options?: unknown) {
			sent.push({ content, ...(options === undefined ? {} : { options }) });
		},
	};
	const ctx = {
		cwd: "/workspace/demo",
		model: { input: ["text", "image"] },
		isProjectTrusted: () => true,
		isIdle: () => idle,
		hasPendingMessages: () => pending,
		sessionManager: {
			getSessionId: () => "session-1",
			getSessionName: () => "Demo session",
			getBranch: () => branch,
		},
		ui: {
			notify(message: string) {
				notifications.push(message);
			},
			setWidget(key: string, value: unknown) {
				if (value === undefined) widgets.delete(key);
				else widgets.set(key, value);
			},
		},
	};
	const dependencies: RuntimeDependencies = {
		startServer: async (options) => {
			starts += 1;
			serverOptions = options;
			return server;
		},
		readPiSettings: async () => ({ autoResize: true, blockImages: false, warnings: [] }),
		processImages: async () => [{ type: "image", data: "processed", mimeType: "image/png" }],
		...overrides,
	};
	const runtime = new WebUIRuntime(pi as never, dependencies);
	runtime.register();
	const emit = async (name: string, event: unknown = {}, context = ctx) => {
		for (const handler of events.get(name) ?? []) await handler(event as never, context as never);
	};
	return {
		commands,
		ctx,
		emit,
		notifications,
		pi,
		runtime,
		sent,
		server,
		widgets,
		get closes() {
			return closes;
		},
		get links() {
			return links;
		},
		get serverOptions() {
			return serverOptions;
		},
		get starts() {
			return starts;
		},
		setIdle(value: boolean) {
			idle = value;
		},
		setPending(value: boolean) {
			pending = value;
		},
		setBranch(value: unknown[]) {
			branch = value;
		},
	};
}

test("/webui lazily starts one server, rotates links, and projects the existing branch", async () => {
	const h = harness();
	await h.emit("session_start");
	await Promise.all([
		h.commands.get("webui")?.handler("", h.ctx as never),
		h.commands.get("webui")?.handler("", h.ctx as never),
	]);
	assert.equal(h.starts, 1);
	assert.equal(h.links, 2);
	assert.match(String(h.widgets.get("webui")), /127\.0\.0\.1/);
	assert.equal(h.serverOptions?.conversation.snapshot().messages[0]?.id, "existing");
});

test("Pi message, tool, and activity events update the browser projection", async () => {
	const h = harness();
	await h.emit("session_start");
	await h.commands.get("webui")?.handler("", h.ctx as never);
	await h.emit("agent_start");
	await h.emit("message_start", {
		message: { role: "assistant", content: [{ type: "text", text: "a" }], timestamp: 2 },
	});
	await h.emit("message_update", {
		message: { role: "assistant", content: [{ type: "text", text: "ab" }], timestamp: 2 },
	});
	await h.emit("tool_execution_start", {
		toolCallId: "call",
		toolName: "bash",
		args: { command: "pwd" },
	});
	await h.emit("tool_execution_update", {
		toolCallId: "call",
		toolName: "bash",
		args: { command: "pwd" },
		partialResult: { content: [{ type: "text", text: "/work" }] },
	});
	await h.emit("tool_execution_end", {
		toolCallId: "call",
		toolName: "bash",
		args: { command: "pwd" },
		result: { content: [{ type: "text", text: "/workspace" }] },
		isError: false,
	});
	await h.emit("message_end", {
		message: { role: "assistant", content: [{ type: "text", text: "abc" }], timestamp: 2 },
	});
	await h.emit("agent_settled");
	const snapshot = h.serverOptions?.conversation.snapshot();
	assert.equal(snapshot?.messages.at(-1)?.final, true);
	assert.deepEqual(snapshot?.messages.at(-1)?.content, [{ type: "text", text: "abc" }]);
	assert.equal(snapshot?.tools[0]?.phase, "end");
	assert.equal(snapshot?.activity, "idle");
});

test("tree navigation and session rename publish authoritative snapshots", async () => {
	const h = harness();
	await h.emit("session_start");
	await h.commands.get("webui")?.handler("", h.ctx as never);
	h.setBranch([
		{
			type: "message",
			id: "branch-user",
			message: { role: "user", content: "branched", timestamp: 4 },
		},
	]);
	await h.emit("session_tree");
	await h.emit("session_info_changed", { name: "Renamed" });
	const snapshot = h.serverOptions?.conversation.snapshot();
	assert.equal(snapshot?.messages[0]?.id, "branch-user");
	assert.equal(snapshot?.session.name, "Renamed");
});

test("browser sends immediately when idle, follows up when busy, and steers explicitly", async () => {
	const h = harness();
	await h.emit("session_start");
	await h.commands.get("webui")?.handler("", h.ctx as never);
	const send = h.serverOptions?.send;
	assert.ok(send);
	assert.deepEqual(await send({ requestId: "1", text: "idle", images: [], delivery: "next" }), {
		delivery: "immediate",
	});
	h.setIdle(false);
	assert.deepEqual(await send({ requestId: "2", text: "later", images: [], delivery: "next" }), {
		delivery: "followUp",
	});
	assert.deepEqual(await send({ requestId: "3", text: "now", images: [], delivery: "steer" }), {
		delivery: "steer",
	});
	assert.deepEqual(h.sent, [
		{ content: "idle" },
		{ content: "later", options: { deliverAs: "followUp" } },
		{ content: "now", options: { deliverAs: "steer" } },
	]);
});

test("browser images are processed under live Pi guards and sent with text", async () => {
	let processOptions: unknown;
	const h = harness({
		processImages: async (_images, options) => {
			processOptions = options;
			return [{ type: "image", data: "safe", mimeType: "image/png" }];
		},
	});
	await h.emit("session_start");
	await h.commands.get("webui")?.handler("", h.ctx as never);
	await h.serverOptions?.send({
		requestId: "image",
		text: "look",
		images: [{ data: "raw", mimeType: "image/png" }],
		delivery: "next",
	});
	assert.ok(processOptions && typeof processOptions === "object");
	const { signal, ...guards } = processOptions as {
		signal: AbortSignal;
		autoResize: boolean;
		blockImages: boolean;
		supportsImages: boolean;
	};
	assert.equal(signal.aborted, false);
	assert.deepEqual(guards, {
		autoResize: true,
		blockImages: false,
		supportsImages: true,
	});
	assert.deepEqual(h.sent[0]?.content, [
		{ type: "text", text: "look" },
		{ type: "image", data: "safe", mimeType: "image/png" },
	]);
});

test("send callbacks fail closed after session replacement and Pi send errors propagate", async () => {
	const h = harness();
	await h.emit("session_start");
	await h.commands.get("webui")?.handler("", h.ctx as never);
	const staleSend = h.serverOptions?.send;
	assert.ok(staleSend);
	await h.emit("session_start", { reason: "reload" });
	await assert.rejects(
		() => staleSend({ requestId: "stale", text: "late", images: [], delivery: "next" }),
		/ended|changed/i,
	);

	const failing = harness();
	failing.pi.sendUserMessage = () => {
		throw new Error("Pi rejected input");
	};
	await failing.emit("session_start");
	await failing.commands.get("webui")?.handler("", failing.ctx as never);
	await assert.rejects(
		() =>
			failing.serverOptions?.send({
				requestId: "failed",
				text: "hello",
				images: [],
				delivery: "next",
			}) ?? Promise.reject(new Error("missing send")),
		/Pi rejected input/,
	);
});

test("image preparation cannot deliver into a replacement session", async () => {
	const processing = deferred<Array<{ type: "image"; data: string; mimeType: string }>>();
	const h = harness({ processImages: async () => processing.promise });
	await h.emit("session_start");
	await h.commands.get("webui")?.handler("", h.ctx as never);
	const sending = h.serverOptions?.send({
		requestId: "race",
		text: "look",
		images: [{ data: "raw" }],
		delivery: "next",
	});
	assert.ok(sending);
	await h.emit("session_start", { reason: "reload" });
	processing.resolve([{ type: "image", data: "safe", mimeType: "image/png" }]);
	await assert.rejects(() => sending, /cancelled|changed/i);
	assert.equal(h.sent.length, 0);
});

test("replacement and shutdown close stale servers and invalidate send callbacks", async () => {
	const gate = deferred<ReturnType<typeof harness>["server"]>();
	const h = harness({ startServer: async () => gate.promise });
	await h.emit("session_start");
	const opening = h.commands.get("webui")?.handler("", h.ctx as never);
	const replacing = h.emit("session_start", { reason: "reload" });
	gate.resolve(h.server);
	await Promise.all([opening, replacing]);
	assert.equal(h.closes, 1);
	assert.match(h.notifications.join("\n"), /changed|start/i);
	await h.emit("session_shutdown");
	assert.equal(h.widgets.get("webui"), undefined);
});

void ({} as WebSendRequest);
