import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { test, vi } from "vitest";
import { createMockContext, createMockPi } from "../../../test/support.js";
import type { LspClient } from "../src/lsp-client.js";
import { deferred, fixture } from "./lifecycle-support.js";

async function harness(scenario = "lifecycle-normal") {
	const f = fixture(scenario);
	const agentDir = path.join(f.root, "agent");
	mkdirSync(agentDir);
	vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
	vi.resetModules();
	const { default: lsp } = await import("../src/pi-lsp.js");
	// Fresh extension import also owns a fresh client module.
	const { LspClient: Client } = await import("../src/lsp-client.js");
	const mock = createMockPi();
	lsp(mock.pi);
	writeFileSync(
		path.join(agentDir, "pi-lsp.json"),
		JSON.stringify({
			timeout: 1_000,
			servers: {
				fixture: {
					command: [f.adapter.defaultCommand.command, ...f.adapter.defaultCommand.args],
					extensions: [".go"],
					env: f.adapter.env,
				},
			},
		}),
	);
	const context = createMockContext({ cwd: f.root }) as Omit<
		ReturnType<typeof createMockContext>,
		"ctx"
	> & { ctx: ExtensionContext };
	let stale = false;
	let staleAccesses = 0;
	const ctx = Object.create(context.ctx, {
		ui: {
			get() {
				if (stale) {
					staleAccesses++;
					throw new Error("stale context");
				}
				return context.ctx.ui;
			},
		},
	});
	async function emit(name: string, reason = "quit", target = ctx) {
		for (const handler of mock.events.get(name) ?? [])
			await handler({ type: name, reason }, target);
	}
	function execute(kind: "diagnostics" | "fix", target = ctx, params = {}) {
		const tool = mock.tools.find((tool) => tool.name === `lsp_${kind}`);
		assert.ok(tool);
		return f.track(
			(tool.execute as (...args: unknown[]) => Promise<unknown>)(
				"test",
				{ root: f.root, path: "main.go", paths: ["main.go"], write: true, ...params },
				f.controller.signal,
				undefined,
				target,
			),
		);
	}
	return {
		...f,
		Client,
		mock,
		context,
		ctx,
		emit,
		execute,
		invalidate() {
			stale = true;
		},
		staleAccesses: () => staleAccesses,
		async dispose() {
			await f.dispose();
			vi.restoreAllMocks();
			vi.unstubAllEnvs();
		},
	};
}

for (const kind of ["diagnostics", "fix"] as const) {
	for (const method of [
		"initialize",
		"textDocument/diagnostic",
		...(kind === "fix" ? ["textDocument/codeAction", "codeAction/resolve"] : []),
	]) {
		for (const reason of ["quit", "reload"] as const) {
			test(`${kind}: active ${reason} drains pending ${method} before invalidation`, async () => {
				const h = await harness(`lifecycle-hang-${method}`);
				try {
					await h.emit("session_start", "startup");
					const task = h.execute(kind);
					await h.ready(method);
					const shutdown = h.emit("session_shutdown", reason);
					const repeated = h.emit("session_shutdown", reason);
					await assert.rejects(h.execute(kind, h.ctx, { server: "missing" }), /closing|aborted/);
					await Promise.all([shutdown, repeated]);
					h.exited();
					h.invalidate();
					await assert.rejects(task, /cancelled|aborted/);
					assert.equal(h.staleAccesses(), 0);
					assert.equal(getEventListeners(h.controller.signal, "abort").length, 0);
					assert.equal(readFileSync(h.file, "utf8"), "package main\n");
				} finally {
					await h.dispose();
				}
			});
		}
	}
}

test("shutdown waits for every sibling, even after one operation fails; restart waits for drain", async () => {
	const h = await harness();
	const ready = [deferred(), deferred()];
	const gates = [deferred(), deferred()];
	let index = 0;
	const diagnostics = h.Client.prototype.diagnostics;
	vi.spyOn(h.Client.prototype, "diagnostics").mockImplementation(async function (
		this: LspClient,
		uri,
	) {
		const id = index++;
		const result = await diagnostics.call(this, uri);
		if (id < 2) {
			ready[id].resolve();
			await gates[id].promise;
		}
		if (id === 0) throw new Error("original operation failure");
		return result;
	});
	try {
		const first = h.execute("diagnostics");
		await ready[0].promise;
		const second = h.execute("diagnostics");
		await ready[1].promise;
		let settled = false;
		const closing = h.emit("session_shutdown").then(() => {
			settled = true;
		});
		const restarting = h.emit("session_start", "reload");
		gates[0].resolve();
		await assert.rejects(first, /original operation failure/);
		assert.equal(settled, false);
		await assert.rejects(h.execute("diagnostics", h.ctx, { server: "missing" }), /closing|aborted/);
		gates[1].resolve();
		await assert.rejects(second, /aborted|cancelled/);
		await Promise.all([closing, restarting]);
		await h.execute("diagnostics");
		h.exited();
	} finally {
		for (const gate of gates) gate.resolve();
		await h.dispose();
	}
});

test("session managers sharing one headless UI have independent cancellation scopes", async () => {
	const h = await harness();
	const gate = deferred();
	const ready = deferred();
	const diagnostics = h.Client.prototype.diagnostics;
	let count = 0;
	vi.spyOn(h.Client.prototype, "diagnostics").mockImplementation(async function (
		this: LspClient,
		uri,
	) {
		const result = await diagnostics.call(this, uri);
		if (++count === 2) ready.resolve();
		await gate.promise;
		return result;
	});
	const other = createMockContext({ cwd: h.root, ui: h.context.ctx.ui });
	// The mock helper owns its UI; explicitly reuse exactly the same object.
	const otherCtx = Object.create(other.ctx, { ui: { value: h.context.ctx.ui } });
	try {
		const first = h.execute("diagnostics");
		const second = h.execute("diagnostics", otherCtx);
		await ready.promise;
		const shutdown = h.emit("session_shutdown");
		gate.resolve();
		await assert.rejects(first, /aborted|cancelled/);
		await second;
		await shutdown;
		h.exited();
	} finally {
		gate.resolve();
		await h.dispose();
	}
});

test("shutdown after first route response prevents a later diagnostics route from starting", async () => {
	const h = await harness();
	const agentDir = path.join(h.root, "agent");
	const config = JSON.parse(readFileSync(path.join(agentDir, "pi-lsp.json"), "utf8"));
	config.servers.second = { ...config.servers.fixture };
	writeFileSync(path.join(agentDir, "pi-lsp.json"), JSON.stringify(config));
	const ready = deferred();
	const gate = deferred();
	const shutdown = h.Client.prototype.shutdown;
	vi.spyOn(h.Client.prototype, "shutdown").mockImplementation(async function (this: LspClient) {
		await shutdown.call(this);
		ready.resolve();
		await gate.promise;
	});
	try {
		const task = h.execute("diagnostics");
		await ready.promise;
		const closing = h.emit("session_shutdown");
		gate.resolve();
		await assert.rejects(task, /aborted|cancelled/);
		await closing;
		assert.equal(h.events().filter((event) => event.method === "ready").length, 1);
		h.exited();
	} finally {
		gate.resolve();
		await h.dispose();
	}
});

test("scope closure after a fix response prevents a late disk write", async () => {
	const h = await harness();
	let closing: Promise<void> | undefined;
	const resolve = h.Client.prototype.resolveActions;
	vi.spyOn(h.Client.prototype, "resolveActions").mockImplementation(async function (
		this: LspClient,
		actions,
	) {
		const result = await resolve.call(this, actions);
		closing = h.emit("session_shutdown");
		return result;
	});
	try {
		await assert.rejects(h.execute("fix"), /aborted|cancelled/);
		await closing;
		assert.equal(readFileSync(h.file, "utf8"), "package main\n");
		h.exited();
	} finally {
		await h.dispose();
	}
});

test("shutdown supersedes an awaiting session start without reopening its scope", async () => {
	const h = await harness();
	const ready = deferred();
	const gate = deferred();
	const diagnostics = h.Client.prototype.diagnostics;
	vi.spyOn(h.Client.prototype, "diagnostics").mockImplementation(async function (
		this: LspClient,
		uri,
	) {
		const result = await diagnostics.call(this, uri);
		ready.resolve();
		await gate.promise;
		return result;
	});
	try {
		const task = h.execute("diagnostics");
		await ready.promise;
		const starting = h.emit("session_start", "reload");
		const closing = h.emit("session_shutdown");
		gate.resolve();
		await assert.rejects(task, /aborted|cancelled/);
		await Promise.all([starting, closing]);
		await assert.rejects(h.execute("diagnostics", h.ctx, { server: "missing" }), /closing/);
		h.exited();
	} finally {
		gate.resolve();
		await h.dispose();
	}
});

test("throwing shutdown UI cannot prevent cancellation or settlement", async () => {
	const h = await harness("lifecycle-hang-initialize");
	try {
		const task = h.execute("fix");
		await h.ready("initialize");
		const context = Object.create(h.ctx, {
			ui: {
				get() {
					throw new Error("UI unavailable");
				},
			},
		});
		await h.emit("session_shutdown", "quit", context);
		await assert.rejects(task, /aborted|cancelled/);
		h.exited();
	} finally {
		await h.dispose();
	}
});

test("abort-and-idle replacement and repeated idle lifecycle events leave no old work", async () => {
	const h = await harness("lifecycle-hang-textDocument/diagnostic");
	try {
		await h.emit("session_start", "startup");
		const task = h.execute("diagnostics");
		await h.ready("textDocument/diagnostic");
		h.controller.abort();
		await assert.rejects(task, /cancelled|aborted/);
		await h.emit("session_shutdown", "resume");
		h.exited();
		await h.emit("session_shutdown", "resume");
		await h.emit("session_start", "resume");
		await h.emit("session_shutdown");
	} finally {
		await h.dispose();
	}
});
