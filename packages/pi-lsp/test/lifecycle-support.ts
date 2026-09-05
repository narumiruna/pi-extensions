import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout } from "node:timers/promises";
import { LspClient } from "../src/lsp-client.js";
import { runDiagnostics, runFix } from "../src/runner.js";
import type { LspServerAdapter, StatusContext } from "../src/types.js";

export function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

export function fixture(scenario = "lifecycle-normal") {
	const root = mkdtempSync(path.join(os.tmpdir(), "pi-lsp-lifecycle-"));
	const file = path.join(root, "main.go");
	const log = path.join(root, "events.jsonl");
	writeFileSync(file, "package main\n");
	const adapter: LspServerAdapter = {
		name: "fixture",
		isDefault: false,
		extensions: [".go"],
		skipDirectories: new Set(),
		defaultCommand: {
			command: process.execPath,
			args: [path.resolve("packages/pi-lsp/test/fixtures/diagnostics-server.mjs"), scenario],
		},
		env: { PI_LSP_TEST_LOG: log },
		missingCommandHint: "install fixture",
		isSupportedFile: (name) => name.endsWith(".go"),
		languageIdFor: () => "go",
	};
	const controller = new AbortController();
	const statuses: Array<string | undefined> = [];
	const ctx: StatusContext = {
		ui: {
			setStatus: (_key, value) => {
				statuses.push(value);
			},
		},
	};
	const clients = new Set<LspClient>();
	const tasks: Promise<unknown>[] = [];
	const originalStart = LspClient.prototype.start;
	// Each test owns its spies; remember real clients for cleanup even against the broken baseline.
	function start(this: LspClient) {
		clients.add(this);
		return originalStart.call(this);
	}
	function track<T>(task: Promise<T>) {
		tasks.push(task);
		void task.catch(() => {});
		return task;
	}
	function run(
		kind: "diagnostics" | "fix",
		options: {
			write?: boolean;
			files?: string[];
			context?: StatusContext;
			timeoutMs?: number;
		} = {},
	) {
		return track(
			kind === "diagnostics"
				? runDiagnostics(
						adapter,
						{ root, files: options.files ?? [file] },
						options.timeoutMs ?? 1_000,
						controller.signal,
						options.context ?? ctx,
						"lsp",
					)
				: runFix(
						adapter,
						{ root, path: "main.go", write: options.write },
						options.timeoutMs ?? 1_000,
						controller.signal,
						options.context ?? ctx,
						"lsp",
					),
		);
	}
	function events(): Array<{
		method: string;
		pid: number;
		params?: { textDocument?: { uri: string } };
	}> {
		return existsSync(log)
			? readFileSync(log, "utf8")
					.trim()
					.split("\n")
					.filter(Boolean)
					.map((line) => JSON.parse(line))
			: [];
	}
	async function ready(method: string) {
		// No timing assertion or subprocess deadline before the server-observable handshake.
		while (!events().some((event) => event.method === method)) await setTimeout(5);
	}
	function exited() {
		const records = events();
		for (const pid of new Set(records.map((event) => event.pid))) {
			assert.ok(records.some((event) => event.pid === pid && event.method === "exited"));
			assert.throws(() => process.kill(pid, 0), /ESRCH/);
		}
	}
	async function dispose() {
		controller.abort();
		for (const client of clients) client.close();
		await Promise.allSettled(tasks);
		await Promise.all([...clients].map((client) => client.shutdown()));
		rmSync(root, { recursive: true, force: true });
	}
	return {
		root,
		file,
		log,
		adapter,
		controller,
		statuses,
		ctx,
		start,
		track,
		run,
		events,
		ready,
		exited,
		dispose,
	};
}
