#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = path.join(root, "node_modules", ".cache", "pi-extensions-e2e");
const tsc = path.join(
	root,
	"node_modules",
	".bin",
	process.platform === "win32" ? "tsc.cmd" : "tsc",
);

fs.rmSync(outDir, { recursive: true, force: true });
run(tsc, ["-p", "tsconfig.e2e.json"]);

const testFiles = findFiles(outDir, ".test.js").map((file) => fs.realpathSync(file));
if (testFiles.length === 0) {
	console.error("No compiled E2E test files found.");
	process.exit(1);
}

run(process.execPath, ["--test", ...process.argv.slice(2), ...testFiles]);
run(process.execPath, [path.join(root, "extensions", "pi-goal", "test", "goal-runtime-smoke.mjs")]);

function run(command, args) {
	const result = spawnSync(command, args, { cwd: root, stdio: "inherit" });
	if (result.error) {
		console.error(result.error.message);
		process.exit(1);
	}
	if (result.status !== 0) process.exit(result.status ?? 1);
}

function findFiles(directory, suffix) {
	if (!fs.existsSync(directory)) return [];
	const files = [];
	for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
		const entryPath = path.join(directory, entry.name);
		if (entry.isDirectory()) files.push(...findFiles(entryPath, suffix));
		else if (entry.isFile() && entry.name.endsWith(suffix)) files.push(entryPath);
	}
	return files.sort();
}
