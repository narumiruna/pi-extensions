#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join } from "node:path";
import { parse } from "smol-toml";
import { formatDisplayValue, formatError } from "./script-support.mjs";

const [draftPath, destinationPath, expectedPath, ...extraArguments] = process.argv.slice(2);

if (!draftPath || !destinationPath || !expectedPath || extraArguments.length > 0) {
	console.error(
		"Usage: node scripts/apply.mjs <draft-path> <absolute-pi-starship.toml-path> <expected-path|--expect-missing>",
	);
	process.exitCode = 2;
} else if (!isAbsolute(destinationPath) || basename(destinationPath) !== "pi-starship.toml") {
	console.error("The destination must be an absolute path named pi-starship.toml.");
	process.exitCode = 2;
} else {
	let temporaryPath;
	try {
		const draft = await readFile(draftPath, "utf8");
		const expectMissing = expectedPath === "--expect-missing";
		const expected = expectMissing ? undefined : await readFile(expectedPath, "utf8");
		await mkdir(dirname(destinationPath), { recursive: true });
		temporaryPath = join(dirname(destinationPath), `.pi-starship.toml.${randomUUID()}.tmp`);
		await writeFile(temporaryPath, draft, { encoding: "utf8", flag: "wx" });
		parse(await readFile(temporaryPath, "utf8"));
		await assertDestinationUnchanged(destinationPath, expectMissing, expected);
		await rename(temporaryPath, destinationPath);
		temporaryPath = undefined;
		console.log(`Applied valid TOML atomically to ${formatDisplayValue(destinationPath)}`);
	} catch (error) {
		console.error(
			`Draft was not applied to ${formatDisplayValue(destinationPath)}: ${formatError(error)}`,
		);
		process.exitCode = 1;
	} finally {
		if (temporaryPath) {
			try {
				await rm(temporaryPath, { force: true });
			} catch {
				// Cleanup is best-effort and must not obscure the original failure.
			}
		}
	}
}

async function assertDestinationUnchanged(destinationPath, expectMissing, expected) {
	let current;
	try {
		current = await readFile(destinationPath, "utf8");
	} catch (error) {
		if (error && typeof error === "object" && error.code === "ENOENT") {
			if (expectMissing) return;
			throw new Error("The active pi-starship.toml was removed after inspection.");
		}
		throw error;
	}
	if (!expectMissing && current === expected) return;
	throw new Error(
		"The active pi-starship.toml changed after inspection; the newer file was preserved.",
	);
}
