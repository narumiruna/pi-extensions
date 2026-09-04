#!/usr/bin/env node

import { resolve } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

if (process.argv.length > 2) {
	console.error("Usage: node scripts/config-path.mjs");
	process.exitCode = 2;
} else {
	process.stdout.write(`${JSON.stringify(resolve(getAgentDir(), "pi-starship.toml"))}\n`);
}
