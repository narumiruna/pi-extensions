import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { test, vi } from "vitest";
import { LspClient } from "../src/lsp-client.js";
import { deferred, fixture } from "./lifecycle-support.js";

for (const kind of ["diagnostics", "fix"] as const) {
	test(`${kind}: normal document scope, result, listeners and process exit`, async () => {
		const f = fixture();
		vi.spyOn(LspClient.prototype, "start").mockImplementation(f.start);
		try {
			const result = await f.run(kind);
			assert.match(
				result.content[0].text,
				kind === "fix" ? /computed changes/ : /0 diagnostic\(s\)/,
			);
			assert.equal(readFileSync(f.file, "utf8"), "package main\n");
			assert.deepEqual(
				f.events().map((event) => event.method),
				[
					"ready",
					"initialize",
					"initialized",
					"textDocument/didOpen",
					"textDocument/diagnostic",
					...(kind === "fix" ? ["textDocument/codeAction", "codeAction/resolve"] : []),
					"textDocument/didClose",
					"shutdown",
					"exit",
					"exited",
				],
			);
			assert.deepEqual(f.statuses, [`fixture ${kind}`, undefined]);
			assert.equal(getEventListeners(f.controller.signal, "abort").length, 0);
			f.exited();
		} finally {
			await f.dispose();
			vi.restoreAllMocks();
		}
	});

	for (const method of [
		"initialize",
		"textDocument/diagnostic",
		...(kind === "fix" ? ["textDocument/codeAction", "codeAction/resolve"] : []),
	]) {
		test(`${kind}: ${method} rejection preserves error and releases process`, async () => {
			const f = fixture(`lifecycle-error-${method}`);
			vi.spyOn(LspClient.prototype, "start").mockImplementation(f.start);
			try {
				await assert.rejects(f.run(kind), /intentional operation failure/);
				assert.equal(f.statuses.at(-1), undefined);
				assert.equal(getEventListeners(f.controller.signal, "abort").length, 0);
				if (method === "initialize")
					assert.ok(!f.events().some((event) => event.method === "textDocument/didOpen"));
				else assert.ok(f.events().some((event) => event.method === "textDocument/didClose"));
				f.exited();
			} finally {
				await f.dispose();
				vi.restoreAllMocks();
			}
		});
		test(`${kind}: caller cancellation during ${method} drains the real child`, async () => {
			const f = fixture(`lifecycle-hang-${method}`);
			vi.spyOn(LspClient.prototype, "start").mockImplementation(f.start);
			try {
				const task = f.run(kind, { write: true });
				await f.ready(method);
				f.controller.abort();
				await assert.rejects(task, /cancelled|aborted/);
				assert.equal(readFileSync(f.file, "utf8"), "package main\n");
				assert.equal(getEventListeners(f.controller.signal, "abort").length, 0);
				f.exited();
			} finally {
				await f.dispose();
				vi.restoreAllMocks();
			}
		});
	}

	for (const failure of ["missing", "spawn", "timeout", "initial-status"] as const) {
		test(`${kind}: ${failure} startup failure releases owned resources`, async () => {
			const f = fixture(failure === "timeout" ? "lifecycle-hang-initialize" : undefined);
			vi.spyOn(LspClient.prototype, "start").mockImplementation(f.start);
			const shutdown = vi.spyOn(LspClient.prototype, "shutdown");
			if (failure === "missing") f.adapter.defaultCommand.command = path.join(f.root, "missing");
			if (failure === "spawn") {
				const command = path.join(f.root, "broken");
				writeFileSync(command, "#!/nonexistent-interpreter\n", { mode: 0o755 });
				f.adapter.defaultCommand.command = command;
			}
			try {
				await assert.rejects(
					f.run(kind, {
						timeoutMs: failure === "timeout" ? 300 : 1_000,
						context:
							failure === "initial-status"
								? {
										ui: {
											setStatus() {
												throw new Error("initial status failed");
											},
										},
									}
								: undefined,
					}),
					/not found|failed to start|timed out|initial status failed/,
				);
				assert.equal(shutdown.mock.calls.length, 1);
				assert.equal(getEventListeners(f.controller.signal, "abort").length, 0);
				if (failure === "timeout") f.exited();
				assert.ok(!f.events().some((event) => event.method === "textDocument/didOpen"));
			} finally {
				await f.dispose();
				vi.restoreAllMocks();
			}
		});
	}

	for (const uiFailure of ["getter", "setter"] as const) {
		for (const operationFails of [false, true]) {
			test(`${kind}: cleanup ${uiFailure} failure cannot replace ${operationFails ? "operation error" : "result"}`, async () => {
				const f = fixture();
				vi.spyOn(LspClient.prototype, "start").mockImplementation(f.start);
				const shutdown = vi.spyOn(LspClient.prototype, "shutdown");
				let stale = false;
				const original = LspClient.prototype.diagnostics;
				vi.spyOn(LspClient.prototype, "diagnostics").mockImplementation(async function (
					this: LspClient,
					uri,
				) {
					const result = await original.call(this, uri);
					stale = true;
					if (operationFails) throw new Error("original operation error");
					return result;
				});
				const context = {
					get ui() {
						if (stale && uiFailure === "getter") throw new Error("stale context");
						return {
							setStatus(_key: string, value: string | undefined) {
								if (value === undefined) throw new Error("status cleanup failed");
							},
						};
					},
				};
				try {
					const task = f.run(kind, { context });
					if (operationFails) await assert.rejects(task, /original operation error/);
					else await task;
					assert.equal(shutdown.mock.calls.length, 1);
					assert.equal(getEventListeners(f.controller.signal, "abort").length, 0);
					f.exited();
				} finally {
					await f.dispose();
					vi.restoreAllMocks();
				}
			});
		}
	}

	test(`${kind}: cancellation interrupts a pending shutdown and removes its subscription`, async () => {
		const f = fixture("lifecycle-hang-shutdown");
		vi.spyOn(LspClient.prototype, "start").mockImplementation(f.start);
		try {
			const task = f.run(kind);
			await f.ready("shutdown");
			assert.equal(getEventListeners(f.controller.signal, "abort").length, 1);
			f.controller.abort();
			await assert.rejects(task, /aborted|cancelled/);
			assert.equal(getEventListeners(f.controller.signal, "abort").length, 0);
			f.exited();
		} finally {
			await f.dispose();
			vi.restoreAllMocks();
		}
	});

	for (const operationFails of [false, true]) {
		test(`${kind}: resource cleanup error is ${operationFails ? "secondary" : "observable"}`, async () => {
			const f = fixture(operationFails ? "lifecycle-error-initialize" : undefined);
			vi.spyOn(LspClient.prototype, "start").mockImplementation(f.start);
			const shutdown = LspClient.prototype.shutdown;
			const spy = vi.spyOn(LspClient.prototype, "shutdown").mockImplementation(async function (
				this: LspClient,
			) {
				await shutdown.call(this);
				throw new Error("shutdown failure");
			});
			try {
				await assert.rejects(
					f.run(kind),
					operationFails ? /intentional operation failure/ : /shutdown failure/,
				);
				f.exited();
			} finally {
				spy.mockRestore();
				await f.dispose();
				vi.restoreAllMocks();
			}
		});
	}

	for (const method of [
		"start",
		"initialize",
		"diagnostics",
		...(kind === "fix" ? (["codeActions", "resolveActions"] as const) : []),
	] as const) {
		test(`${kind}: cancellation after ${method} response prevents next work`, async () => {
			const f = fixture();
			vi.spyOn(LspClient.prototype, "start").mockImplementation(f.start);
			const original = method === "start" ? f.start : LspClient.prototype[method];
			vi.spyOn(LspClient.prototype, method).mockImplementation(async function (
				this: LspClient,
				...args: unknown[]
			) {
				const result = await (original as (...args: unknown[]) => Promise<unknown>).apply(
					this,
					args,
				);
				f.controller.abort();
				return result;
			} as never);
			try {
				await assert.rejects(f.run(kind, { write: true }), /aborted|cancelled/);
				assert.equal(readFileSync(f.file, "utf8"), "package main\n");
				const next = {
					start: "initialize",
					initialize: "textDocument/didOpen",
					diagnostics: "textDocument/codeAction",
					codeActions: "codeAction/resolve",
					resolveActions: "never",
				}[method];
				assert.ok(!f.events().some((event) => event.method === next));
				if (method !== "start") f.exited();
			} finally {
				await f.dispose();
				vi.restoreAllMocks();
			}
		});
	}
}

test("empty diagnostics selection does not allocate, spawn or publish status", async () => {
	const f = fixture();
	const start = vi.spyOn(LspClient.prototype, "start").mockImplementation(f.start);
	try {
		const result = await f.run("diagnostics", { files: [] });
		assert.match(result.content[0].text, /no supported files/);
		assert.equal(start.mock.calls.length, 0);
		assert.deepEqual(f.statuses, []);
	} finally {
		await f.dispose();
		vi.restoreAllMocks();
	}
});

for (const write of [false, true]) {
	for (const unchanged of [false, true]) {
		test(`fix: write=${write}, unchanged=${unchanged} preserves exact result and disk semantics`, async () => {
			const f = fixture(unchanged ? "lifecycle-unchanged" : undefined);
			vi.spyOn(LspClient.prototype, "start").mockImplementation(f.start);
			try {
				const result = await f.run("fix", { write });
				const text = `${unchanged ? "" : "// fixed\n"}package main\n`;
				const details = result.details as {
					changed: boolean;
					text?: string;
					write: boolean;
					kind: string;
					actions: unknown[];
					appliedActions: unknown[];
				};
				assert.equal(details.changed, !unchanged);
				assert.equal(details.write, write);
				assert.equal(details.kind, "source.fixAll");
				assert.equal(details.text, write ? undefined : text);
				assert.deepEqual(
					details.actions,
					unchanged ? [] : [{ title: "fixture fix", kind: "source.fixAll" }],
				);
				assert.deepEqual(details.appliedActions, details.actions);
				assert.equal(readFileSync(f.file, "utf8"), write ? text : "package main\n");
				f.exited();
			} finally {
				await f.dispose();
				vi.restoreAllMocks();
			}
		});
	}
}

test("diagnostics: partial file open closes all previously opened documents", async () => {
	const f = fixture();
	vi.spyOn(LspClient.prototype, "start").mockImplementation(f.start);
	try {
		await assert.rejects(
			f.run("diagnostics", { files: [f.file, path.join(f.root, "missing.go")] }),
			/ENOENT/,
		);
		assert.deepEqual(
			f
				.events()
				.filter((event) => /didOpen|didClose/.test(event.method))
				.map((event) => event.method),
			["textDocument/didOpen", "textDocument/didClose"],
		);
		f.exited();
	} finally {
		await f.dispose();
		vi.restoreAllMocks();
	}
});

test("fix: write failure still closes document and drains process", async () => {
	const f = fixture();
	vi.spyOn(LspClient.prototype, "start").mockImplementation(f.start);
	const resolve = LspClient.prototype.resolveActions;
	vi.spyOn(LspClient.prototype, "resolveActions").mockImplementation(async function (
		this: LspClient,
		actions,
	) {
		const result = await resolve.call(this, actions);
		unlinkSync(f.file);
		mkdirSync(f.file);
		return result;
	});
	try {
		await assert.rejects(f.run("fix", { write: true }), /EISDIR/);
		assert.ok(f.events().some((event) => event.method === "textDocument/didClose"));
		f.exited();
	} finally {
		await f.dispose();
		vi.restoreAllMocks();
	}
});

for (const kind of ["diagnostics", "fix"] as const) {
	test(`${kind}: B3 deferred, oversized output remains complete`, async () => {
		const f = fixture("lifecycle-large");
		vi.spyOn(LspClient.prototype, "start").mockImplementation(f.start);
		try {
			assert.ok((await f.run(kind)).content[0].text.includes("x".repeat(60_000)));
		} finally {
			await f.dispose();
			vi.restoreAllMocks();
		}
	});
}

test("B1 deferred: one completion still clears a pending sibling's status", async () => {
	const f = fixture();
	vi.spyOn(LspClient.prototype, "start").mockImplementation(f.start);
	const gates = [deferred(), deferred()];
	const ready = [deferred(), deferred()];
	let index = 0;
	const original = LspClient.prototype.diagnostics;
	vi.spyOn(LspClient.prototype, "diagnostics").mockImplementation(async function (
		this: LspClient,
		uri,
	) {
		const id = index++;
		const result = await original.call(this, uri);
		ready[id].resolve();
		await gates[id].promise;
		return result;
	});
	try {
		const first = f.run("diagnostics");
		await ready[0].promise;
		const second = f.run("diagnostics");
		await ready[1].promise;
		gates[0].resolve();
		await first;
		assert.deepEqual(f.statuses, ["fixture diagnostics", "fixture diagnostics", undefined]);
		gates[1].resolve();
		await second;
		f.exited();
	} finally {
		for (const gate of gates) gate.resolve();
		await f.dispose();
		vi.restoreAllMocks();
	}
});

test("B2 deferred: concurrent fixes retain the unqueued read/await/write window", async () => {
	const f = fixture();
	vi.spyOn(LspClient.prototype, "start").mockImplementation(f.start);
	const gate = deferred();
	const ready = deferred();
	let count = 0;
	const original = LspClient.prototype.resolveActions;
	vi.spyOn(LspClient.prototype, "resolveActions").mockImplementation(async function (
		this: LspClient,
		actions,
	) {
		const result = await original.call(this, actions);
		if (++count === 2) ready.resolve();
		await gate.promise;
		return result;
	});
	try {
		const tasks = [f.run("fix", { write: true }), f.run("fix", { write: true })];
		await ready.promise;
		writeFileSync(f.file, "concurrent external edit\n");
		gate.resolve();
		await Promise.all(tasks);
		assert.equal(readFileSync(f.file, "utf8"), "// fixed\npackage main\n");
		f.exited();
	} finally {
		gate.resolve();
		await f.dispose();
		vi.restoreAllMocks();
	}
});
