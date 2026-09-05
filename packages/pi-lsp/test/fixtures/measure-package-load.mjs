// One-off evaluation harness: pass a built repository root; each sample gets a new process.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const root = resolve(process.argv[2] ?? ".");
if (process.argv[3] === "load") {
	const agentDir = mkdtempSync(join(tmpdir(), "pi-lsp-load-"));
	process.env.PI_CODING_AGENT_DIR = agentDir;
	try {
		const { DefaultResourceLoader, SettingsManager } = await import(
			pathToFileURL(join(root, "node_modules/@earendil-works/pi-coding-agent/dist/index.js")).href
		);
		const start = performance.now();
		const loader = new DefaultResourceLoader({
			cwd: agentDir,
			agentDir,
			settingsManager: SettingsManager.inMemory({}),
			additionalExtensionPaths: [join(root, "packages/pi-lsp/dist/index.ts")],
		});
		await loader.reload();
		const result = loader.getExtensions();
		if (result.errors.length || result.extensions.length !== 1) {
			throw new Error(JSON.stringify(result.errors));
		}
		console.log((performance.now() - start).toFixed(3));
		result.runtime.invalidate();
	} finally {
		rmSync(agentDir, { recursive: true, force: true });
	}
} else {
	const files = readdirSync(join(root, "packages/pi-lsp/src")).filter((f) => f.endsWith(".ts"));
	const productionLines = files.reduce(
		(n, f) => n + readFileSync(join(root, "packages/pi-lsp/src", f), "utf8").split("\n").length - 1,
		0,
	);
	const samples = Array.from({ length: 10 }, () => {
		const child = spawnSync(process.execPath, [import.meta.filename, root, "load"], {
			encoding: "utf8",
		});
		if (child.status !== 0) throw new Error(child.stderr);
		return Number(child.stdout.trim());
	});
	const sorted = [...samples].sort((a, b) => a - b);
	console.log(
		JSON.stringify(
			{
				node: process.version,
				productionLines,
				samples,
				median: (sorted[4] + sorted[5]) / 2,
			},
			null,
			2,
		),
	);
}
