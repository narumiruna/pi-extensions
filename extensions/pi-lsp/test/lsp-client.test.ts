import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { LspClient } from "../src/lsp-client.js";
import { runDiagnostics } from "../src/runner.js";
import type { LspServerAdapter } from "../src/types.js";

const fixture = path.resolve("extensions/pi-lsp/test/fixtures/diagnostics-server.mjs");

test("advertised pull diagnostic errors propagate", async () => {
	const root = mkdtempSync(path.join(os.tmpdir(), "pi-lsp-pull-error-"));
	const file = path.join(root, "main.go");
	writeFileSync(file, "package main\n");
	const adapter = fixtureAdapter("pull-error", 30);
	const client = new LspClient(adapter, adapter.defaultCommand, root, 1_000);

	try {
		await client.start();
		await client.initialize(root);
		const uri = pathToFileURL(file).href;
		client.didOpen(uri, "package main\n", "go");
		await assert.rejects(client.diagnostics(uri), /intentional pull failure/);
		client.didClose(uri);
	} finally {
		await client.shutdown();
		rmSync(root, { recursive: true, force: true });
	}
});

test("empty pull diagnostics wait for a late push publication", async () => {
	const root = mkdtempSync(path.join(os.tmpdir(), "pi-lsp-empty-pull-late-push-"));
	const file = path.join(root, "main.go");
	writeFileSync(file, "package main\n");
	const adapter = fixtureAdapter("pull-empty-then-push", 30);
	const client = new LspClient(adapter, adapter.defaultCommand, root, 1_000);

	try {
		await client.start();
		await client.initialize(root);
		const uri = pathToFileURL(file).href;
		client.didOpen(uri, "package main\n", "go");
		const diagnostics = await client.diagnostics(uri);
		assert.deepEqual(
			diagnostics.map(({ message }) => message),
			["late pull-capable diagnostic"],
		);
		client.didClose(uri);
	} finally {
		await client.shutdown();
		rmSync(root, { recursive: true, force: true });
	}
});

test("empty pull diagnostics preserve an already published diagnostic", async () => {
	const root = mkdtempSync(path.join(os.tmpdir(), "pi-lsp-empty-pull-existing-push-"));
	const file = path.join(root, "main.go");
	writeFileSync(file, "package main\n");
	const adapter = fixtureAdapter("pull-empty-after-push", 30);
	const client = new LspClient(adapter, adapter.defaultCommand, root, 1_000);

	try {
		await client.start();
		await client.initialize(root);
		const uri = pathToFileURL(file).href;
		client.didOpen(uri, "package main\n", "go");
		await new Promise((resolve) => setTimeout(resolve, 50));
		const diagnostics = await client.diagnostics(uri);
		assert.deepEqual(
			diagnostics.map(({ message }) => message),
			["already published diagnostic"],
		);
		client.didClose(uri);
	} finally {
		await client.shutdown();
		rmSync(root, { recursive: true, force: true });
	}
});

test("empty pull diagnostics fall back after the configured grace period", async () => {
	const root = mkdtempSync(path.join(os.tmpdir(), "pi-lsp-empty-pull-fallback-"));
	const file = path.join(root, "main.go");
	writeFileSync(file, "package main\n");
	const adapter = fixtureAdapter("pull-empty-only", 30);
	const client = new LspClient(adapter, adapter.defaultCommand, root, 1_000);
	const startedAt = Date.now();

	try {
		await client.start();
		await client.initialize(root);
		const uri = pathToFileURL(file).href;
		client.didOpen(uri, "package main\n", "go");
		assert.deepEqual(await client.diagnostics(uri), []);
		assert.ok(Date.now() - startedAt < 500, "empty pull should not wait for the global timeout");
		client.didClose(uri);
	} finally {
		await client.shutdown();
		rmSync(root, { recursive: true, force: true });
	}
});

test("push diagnostics settle on the latest publication", async () => {
	const root = mkdtempSync(path.join(os.tmpdir(), "pi-lsp-push-sequence-"));
	const file = path.join(root, "main.go");
	writeFileSync(file, "package main\n");
	const adapter = fixtureAdapter("push-sequence", 80);
	const client = new LspClient(adapter, adapter.defaultCommand, root, 1_000);

	try {
		await client.start();
		await client.initialize(root);
		const uri = pathToFileURL(file).href;
		client.didOpen(uri, "package main\n", "go");
		const diagnostics = await client.diagnostics(uri);
		assert.deepEqual(
			diagnostics.map(({ message }) => message),
			["first", "second"],
		);
		client.didClose(uri);
	} finally {
		await client.shutdown();
		rmSync(root, { recursive: true, force: true });
	}
});

test("code-action resolution follows the advertised server capability", async () => {
	const root = mkdtempSync(path.join(os.tmpdir(), "pi-lsp-resolve-capability-"));
	const action = { title: "fixture action", data: { id: 1 } };

	try {
		for (const [scenario, expectedTitle] of [
			["resolve-disabled", "fixture action"],
			["resolve-enabled", "fixture action:resolved"],
		] as const) {
			const adapter = fixtureAdapter(scenario, 30);
			const client = new LspClient(adapter, adapter.defaultCommand, root, 1_000);
			try {
				await client.start();
				await client.initialize(root);
				const [resolved] = await client.resolveActions([action]);
				assert.equal(resolved?.title, expectedTitle);
			} finally {
				await client.shutdown();
			}
		}
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("diagnostics open all files before awaiting push publications", async () => {
	const root = mkdtempSync(path.join(os.tmpdir(), "pi-lsp-batch-push-"));
	mkdirSync(path.join(root, "pkg"));
	const files = ["a.go", "b.go", "c.go"].map((name) => path.join(root, "pkg", name));
	for (const file of files) writeFileSync(file, "package pkg\n");
	const adapter = fixtureAdapter("batch-push", 30, files.length);

	try {
		const result = await runDiagnostics(
			adapter,
			{ root, files },
			1_000,
			undefined,
			{ ui: { setStatus() {} } },
			"test",
		);
		const details = result.details as {
			files: Array<{ path: string; diagnostics: Array<{ message: string }> }>;
		};
		assert.deepEqual(
			details.files.map(({ diagnostics }) => diagnostics.length),
			[1, 1, 1],
		);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

function fixtureAdapter(
	scenario: string,
	diagnosticsSettleMs: number,
	expectedFiles?: number,
): LspServerAdapter {
	return {
		name: `fixture-${scenario}`,
		isDefault: false,
		defaultCommand: {
			command: process.execPath,
			args: [fixture, scenario, ...(expectedFiles === undefined ? [] : [String(expectedFiles)])],
		},
		commandEnvVar: `PI_LSP_FIXTURE_${scenario.toUpperCase().replaceAll("-", "_")}_COMMAND`,
		missingCommandHint: "Node is required for the test fixture.",
		extensions: [".go"],
		skipDirectories: new Set(),
		diagnosticsSettleMs,
		pullDiagnosticsGraceMs:
			scenario === "pull-empty-then-push" ||
			scenario === "pull-empty-after-push" ||
			scenario === "pull-empty-only"
				? 200
				: undefined,
		isSupportedFile: (filePath) => filePath.endsWith(".go"),
		languageIdFor: () => "go",
	};
}
