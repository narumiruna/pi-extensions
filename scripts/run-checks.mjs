#!/usr/bin/env node

import concurrently from "concurrently";

const checks = ["check:biome", "check:boundaries", "typecheck"];
const env = { ...process.env, PI_EXTENSIONS_BUILD_READY: "1" };

console.log(`Running checks in parallel: ${checks.join(", ")}`);
const { result } = concurrently(
	checks.map((check) => ({ command: `npm:${check}`, name: check, env })),
	{ prefix: "name", prefixColors: ["auto"] },
);

try {
	await result;
} catch {
	process.exitCode = 1;
}
