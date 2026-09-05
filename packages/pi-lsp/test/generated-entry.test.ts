import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { ExtensionRunner, ModelRegistry } from "@earendil-works/pi-coding-agent";
import { test } from "vitest";

test("declared generated entry preserves registration and partial lifecycle cleanup", async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-lsp-generated-entry-"));
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	const agentDir = join(root, "agent");
	process.env.PI_CODING_AGENT_DIR = agentDir;
	let runner: ExtensionRunner | undefined;
	try {
		const { DefaultResourceLoader, ExtensionRunner, SessionManager, SettingsManager } =
			await import("@earendil-works/pi-coding-agent");
		const loader = new DefaultResourceLoader({
			cwd: root,
			agentDir,
			settingsManager: SettingsManager.inMemory({}),
			additionalExtensionPaths: [resolve("packages/pi-lsp")],
		});
		await loader.reload();
		const loaded = loader.getExtensions();
		assert.deepEqual(loaded.errors, []);
		assert.equal(loaded.extensions.length, 1);
		const extension = loaded.extensions[0];
		assert.equal(extension.resolvedPath, resolve("packages/pi-lsp/dist/index.ts"));
		assert.ok(extension.commands.has("lsp"));
		assert.ok(extension.handlers.has("session_start"));
		assert.ok(extension.handlers.has("session_shutdown"));
		runner = new ExtensionRunner(
			loaded.extensions,
			loaded.runtime,
			root,
			SessionManager.inMemory(root),
			{} as ModelRegistry,
		);
		const errors: unknown[] = [];
		runner.onError((error) => errors.push(error));
		await runner.emit({ type: "session_shutdown", reason: "quit" });
		await runner.emit({ type: "session_start", reason: "startup" });
		await runner.emit({ type: "session_shutdown", reason: "quit" });
		await runner.emit({ type: "session_shutdown", reason: "quit" });
		assert.deepEqual(errors, []);
	} finally {
		if (runner) {
			await runner.emit({ type: "session_shutdown", reason: "quit" });
			runner.invalidate();
		}
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		rmSync(root, { force: true, recursive: true });
	}
});
