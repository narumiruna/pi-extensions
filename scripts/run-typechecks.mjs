#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { selectStagedTypechecks, stagedFiles } from "./select-staged-typechecks.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const stagedOnly = process.argv.slice(2).includes("--staged");

if (!stagedOnly) {
	runFullTypechecks();
	process.exit(0);
}

let selection;
try {
	selection = selectStagedTypechecks(root, stagedFiles(root));
} catch (error) {
	const message = error instanceof Error ? error.message : String(error);
	console.warn(`Could not select staged typechecks (${message}); falling back to all workspaces.`);
	runFullTypechecks();
	process.exit(0);
}

if (selection.mode === "skip") {
	console.log(`Skipping workspace typechecks: ${selection.reason}.`);
	process.exit(0);
}
if (selection.mode === "full") {
	console.log(`Running full workspace typechecks: ${selection.reason}.`);
	runFullTypechecks();
	process.exit(0);
}

console.log(
	`Running affected workspace typechecks for ${selection.workspaceDirectories.join(", ")}: ${selection.reason}.`,
);
if (process.env.PI_EXTENSIONS_BUILD_READY !== "1" && selection.buildWorkspaceNames.length > 0) {
	runWorkspaceScript("build", selection.buildWorkspaceNames, true);
}
runWorkspaceScript("typecheck", selection.workspaceNames);

function runFullTypechecks() {
	if (process.env.PI_EXTENSIONS_BUILD_READY !== "1") {
		runNpm(["run", "build"]);
		process.env.PI_EXTENSIONS_BUILD_READY = "1";
	}
	runNpm(["--workspaces", "run", "typecheck"]);
}

function runWorkspaceScript(script, workspaceNames, ifPresent = false) {
	const workspaceArgs = workspaceNames.flatMap((workspaceName) => ["--workspace", workspaceName]);
	if (ifPresent) workspaceArgs.push("--if-present");
	runNpm([...workspaceArgs, "run", script]);
}

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
