import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
	DefaultResourceLoader,
	ExtensionRunner,
	type ModelRegistry,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { test, vi } from "vitest";
import { fixture } from "./lifecycle-support.js";

for (const kind of ["diagnostics", "fix"] as const) {
	test(`generated ${kind}: installed runner drains active work before stale-context invalidation`, async () => {
		const f = fixture(
			kind === "fix" ? "lifecycle-hang-textDocument/codeAction" : "lifecycle-hang-initialize",
		);
		const agentDir = path.join(f.root, "agent");
		mkdirSync(agentDir);
		vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
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
		let runner: ExtensionRunner | undefined;
		let invalidated = false;
		try {
			const loader = new DefaultResourceLoader({
				cwd: f.root,
				agentDir,
				settingsManager: SettingsManager.inMemory({}),
				additionalExtensionPaths: [path.resolve("packages/pi-lsp/dist/index.ts")],
			});
			await loader.reload();
			const loaded = loader.getExtensions();
			assert.deepEqual(loaded.errors, []);
			runner = new ExtensionRunner(
				loaded.extensions,
				loaded.runtime,
				f.root,
				SessionManager.inMemory(f.root),
				{} as ModelRegistry,
			);
			const errors: unknown[] = [];
			runner.onError((error) => {
				errors.push(error);
			});
			await runner.emit({ type: "session_start", reason: "startup" });
			const ctx = runner.createContext();
			const tool = runner.getToolDefinition(`lsp_${kind}`);
			assert.ok(tool);
			const task = f.track(
				tool.execute(
					"test",
					{ root: f.root, path: "main.go", paths: ["main.go"], write: true },
					f.controller.signal,
					undefined,
					ctx,
				),
			);
			await f.ready(kind === "fix" ? "textDocument/codeAction" : "initialize");
			await runner.emit({ type: "session_shutdown", reason: "reload" });
			f.exited();
			runner.invalidate();
			invalidated = true;
			assert.throws(() => ctx.ui, /stale/);
			await assert.rejects(task, /aborted|cancelled/);
			assert.deepEqual(errors, []);
		} finally {
			f.controller.abort();
			if (runner && !invalidated) await runner.emit({ type: "session_shutdown", reason: "quit" });
			await f.dispose();
			vi.unstubAllEnvs();
		}
	});
}
