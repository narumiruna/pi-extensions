#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

if (process.env.PI_EXTENSIONS_BUILD_READY !== "1") {
	runNpm(["run", "build"]);
	process.env.PI_EXTENSIONS_BUILD_READY = "1";
}
runNpm(["--workspaces", "run", "typecheck"]);

function runNpm(args) {
	const command = process.env.npm_execpath
		? process.execPath
		: process.platform === "win32"
			? "npm.cmd"
			: "npm";
	const commandArgs = process.env.npm_execpath ? [process.env.npm_execpath, ...args] : args;
	const result = spawnSync(command, commandArgs, { cwd: root, stdio: "inherit" });
	if (result.error) {
		console.error(result.error.message);
		process.exit(1);
	}
	if (result.status !== 0) process.exit(result.status ?? 1);
}
