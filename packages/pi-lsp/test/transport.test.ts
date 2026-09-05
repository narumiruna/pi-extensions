import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { test } from "vitest";
import { LspClient } from "../src/lsp-client.js";
import type { LspServerAdapter } from "../src/types.js";

function fixture(scenario: string, name = "transport") {
	const root = mkdtempSync(path.join(os.tmpdir(), "pi-lsp-transport-"));
	const log = path.join(root, "events.jsonl");
	const adapter: LspServerAdapter = {
		name,
		isDefault: false,
		defaultCommand: {
			command: process.execPath,
			args: [path.resolve("packages/pi-lsp/test/fixtures/transport-server.mjs"), scenario, log],
		},
		missingCommandHint: "Node is required",
		extensions: [".go"],
		skipDirectories: new Set(),
		diagnosticsSettleMs: 20,
		isSupportedFile: () => true,
		languageIdFor: () => "go",
	};
	const client = new LspClient(adapter, adapter.defaultCommand, root, 300);
	const uri = pathToFileURL(path.join(root, "語🙂.go")).href;
	function events(): Array<{ pid: number; method: string }> {
		return existsSync(log)
			? readFileSync(log, "utf8")
					.trim()
					.split("\n")
					.filter(Boolean)
					.map((line) => JSON.parse(line))
			: [];
	}
	async function ready(method: string) {
		while (!events().some((event) => event.method === method)) await setTimeout(5);
	}
	async function start() {
		await client.start();
		await ready("ready");
		// Request deadlines begin after the real subprocess has acknowledged readiness.
	}
	async function dispose() {
		client.close();
		client.close();
		await client.shutdown();
		await client.shutdown();
		const pid = events()[0]?.pid;
		if (pid) assert.throws(() => process.kill(pid, 0), /ESRCH/);
		rmSync(root, { recursive: true, force: true });
	}
	return { client, uri, root, start, ready, dispose };
}

for (const scenario of ["split", "multiple", "out-of-order", "late"]) {
	test(`transport: ${scenario} preserves response correlation and UTF-8`, async () => {
		const f = fixture(scenario);
		try {
			await f.start();
			await f.client.initialize(f.root);
			const request = (kind: string) => f.client.codeActions(f.uri, "語🙂", [], kind);
			if (scenario === "late") {
				await assert.rejects(request("expired"), /timed out/);
				assert.deepEqual(await request("current"), [{ title: "current" }]);
			} else if (scenario === "out-of-order") {
				assert.deepEqual(await Promise.all([request("first"), request("second")]), [
					[{ title: "first" }],
					[{ title: "second" }],
				]);
			} else assert.deepEqual(await request("語🙂"), [{ title: "語🙂" }]);
		} finally {
			await f.dispose();
		}
	});
}

for (const name of ["ty", "ruff"]) {
	test(`transport: ${name} configuration, workspace, capability and unknown server requests`, async () => {
		const f = fixture("server-requests", name);
		try {
			await f.start();
			await f.client.initialize(f.root);
		} finally {
			await f.dispose();
		}
	});
}

for (const scenario of ["bad-header", "bad-json", "partial", "exit", "stdout-close", "hang"]) {
	test(`transport: ${scenario} rejects pending work and repeated disposal drains the child`, async () => {
		const f = fixture(scenario);
		try {
			await f.start();
			await f.client.initialize(f.root);
			await assert.rejects(
				f.client.codeActions(f.uri, "", [], "source.fixAll"),
				scenario === "bad-header" || scenario === "bad-json"
					? /JSON|transport/i
					: scenario === "exit"
						? /intentional transport exit/
						: /timed out|closed/,
			);
		} finally {
			await f.dispose();
		}
	});
}

for (const scenario of ["bad-header", "bad-json", "exit"]) {
	test(`transport: ${scenario} rejects a concurrent push waiter as well as its request`, async () => {
		const f = fixture(scenario);
		try {
			await f.start();
			await f.client.initialize(f.root);
			const results = await Promise.allSettled([
				f.client.codeActions(f.uri, "", [], "source.fixAll"),
				f.client.diagnostics(f.uri),
			]);
			for (const result of results) {
				assert.equal(result.status, "rejected");
				if (result.status === "rejected") {
					assert.match(
						String(result.reason),
						scenario === "exit" ? /intentional transport exit/ : /JSON|transport/i,
					);
				}
			}
		} finally {
			await f.dispose();
		}
	});
}

test("transport: stdin stream errors remain observable", async () => {
	const f = fixture("stdin-close");
	try {
		await f.start();
		await assert.rejects(f.client.initialize(f.root), /write|EPIPE|transport/i);
	} finally {
		await f.dispose();
	}
});

for (const kind of ["request", "diagnostics"] as const) {
	test(`transport: close rejects all pending ${kind}, never returns clean diagnostics`, async () => {
		const f = fixture("hang");
		try {
			await f.start();
			await f.client.initialize(f.root);
			const tasks = [1, 2].map(() =>
				kind === "request"
					? f.client.codeActions(f.uri, "", [], "source.fixAll")
					: f.client.diagnostics(f.uri),
			);
			const rejected = tasks.map((task) => assert.rejects(task, /cancelled/));
			if (kind === "request") await f.ready("textDocument/codeAction");
			f.client.close();
			await Promise.all(rejected);
		} finally {
			await f.dispose();
		}
	});
}

test("transport: silent push-only server without an explicit grace fails", async () => {
	const f = fixture("hang");
	try {
		await f.start();
		await f.client.initialize(f.root);
		await assert.rejects(f.client.diagnostics(f.uri), /before timeout/);
	} finally {
		await f.dispose();
	}
});
