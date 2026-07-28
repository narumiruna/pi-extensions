#!/usr/bin/env node

import { spawn } from "node:child_process";

const checks = ["biome:check", "check:boundaries", "typecheck", "test"];

console.log("Building publishable workspaces before consumer checks");
const buildResult = await runCheck("build");
const buildFailures = failuresFrom([buildResult]);
if (buildFailures.length > 0) {
	reportFailures(buildFailures);
	process.exitCode = 1;
} else {
	console.log(`Running checks in parallel: ${checks.join(", ")}`);
	const env = { ...process.env, PI_EXTENSIONS_BUILD_READY: "1" };
	const results = await Promise.all(checks.map((check) => runCheck(check, env)));
	const failures = failuresFrom(results);
	reportFailures(failures);
	if (failures.length > 0) process.exitCode = 1;
}

function failuresFrom(results) {
	return results.filter(({ code, error }) => error || code !== 0);
}

function reportFailures(failures) {
	for (const { check, code, error, signal } of failures) {
		if (error) {
			console.error(`${check} failed to start: ${error.message}`);
		} else if (signal) {
			console.error(`${check} failed after receiving ${signal}`);
		} else {
			console.error(`${check} failed with exit code ${code}`);
		}
	}
}

function runCheck(check, env = process.env) {
	const { command, args } = npmRunCommand(check);
	return new Promise((resolve) => {
		const child = spawn(command, args, {
			cwd: process.cwd(),
			env,
			stdio: "inherit",
		});
		let settled = false;
		const finish = (result) => {
			if (settled) return;
			settled = true;
			resolve({ check, ...result });
		};

		child.once("error", (error) => finish({ code: null, error, signal: null }));
		child.once("close", (code, signal) => finish({ code, error: null, signal }));
	});
}

function npmRunCommand(check) {
	if (process.env.npm_execpath) {
		return {
			command: process.execPath,
			args: [process.env.npm_execpath, "run", check],
		};
	}
	return {
		command: process.platform === "win32" ? "npm.cmd" : "npm",
		args: ["run", check],
	};
}
