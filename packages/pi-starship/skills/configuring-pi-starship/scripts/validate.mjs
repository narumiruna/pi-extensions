#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { parse } from "smol-toml";

const [filePath, ...extraArguments] = process.argv.slice(2);

if (!filePath || extraArguments.length > 0) {
	console.error("Usage: node scripts/validate.mjs <absolute-pi-starship.toml-path>");
	process.exitCode = 2;
} else {
	let document;
	try {
		document = await readFile(filePath, "utf8");
	} catch (error) {
		console.error(`Unable to read ${JSON.stringify(filePath)}: ${formatError(error)}`);
		process.exitCode = 1;
	}

	if (document !== undefined) {
		try {
			parse(document);
			console.log(`Valid TOML: ${JSON.stringify(filePath)}`);
		} catch (error) {
			console.error(`Invalid TOML in ${JSON.stringify(filePath)}: ${formatError(error)}`);
			process.exitCode = 1;
		}
	}
}

function formatError(error) {
	return error instanceof Error ? error.message : String(error);
}
