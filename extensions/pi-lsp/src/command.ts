import { accessSync, constants, existsSync, statSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import type { ServerCommand } from "./types.js";

export function commandFromEnv(envVar: string, fallback: ServerCommand): ServerCommand {
	const customCommand = process.env[envVar]?.trim();
	if (customCommand) {
		const [command, ...args] = splitCommand(customCommand);
		if (command) return { command, args };
	}

	return fallback;
}

export function commandExists(
	command: string,
	cwd = process.cwd(),
	pathValue = process.env.PATH ?? "",
) {
	return resolveCommandPath(command, cwd, process.platform, pathValue) !== undefined;
}

export function commandPathValue(env: Record<string, string> | undefined) {
	return env?.PATH ?? process.env.PATH ?? "";
}

export function resolveCommandPath(
	command: string,
	cwd = process.cwd(),
	platform: NodeJS.Platform = process.platform,
	pathValue = process.env.PATH ?? "",
) {
	const extensions = platform === "win32" ? ["", ".exe", ".cmd", ".bat"] : [""];
	if (command.includes("/") || command.includes("\\")) {
		const commandPath = path.isAbsolute(command) ? command : path.resolve(cwd, command);
		return resolveRunnableFile(commandPath, extensions, platform);
	}

	for (const directory of pathValue.split(platform === "win32" ? ";" : ":")) {
		const resolved = resolveRunnableFile(
			path.resolve(cwd, directory || ".", command),
			extensions,
			platform,
		);
		if (resolved) return resolved;
	}

	return undefined;
}

function resolveRunnableFile(filePath: string, extensions: string[], platform: NodeJS.Platform) {
	for (const extension of extensions) {
		const candidate = `${filePath}${extension}`;
		if (isRunnableFile(candidate, platform)) return candidate;
	}
	return undefined;
}

function isRunnableFile(filePath: string, platform: NodeJS.Platform) {
	if (!existsSync(filePath)) return false;
	try {
		if (!statSync(filePath).isFile()) return false;
		if (platform !== "win32") accessSync(filePath, constants.X_OK);
		return true;
	} catch {
		return false;
	}
}

export function splitCommand(input: string) {
	const parts: string[] = [];
	let current = "";
	let quote: '"' | "'" | undefined;

	for (let index = 0; index < input.length; index += 1) {
		const char = input[index];
		const next = input[index + 1];

		if (char === "\\" && next !== undefined && shouldEscapeNextCharacter(next, quote)) {
			current += next;
			index += 1;
			continue;
		}

		if ((char === '"' || char === "'") && !quote) {
			quote = char;
			continue;
		}

		if (char === quote) {
			quote = undefined;
			continue;
		}

		if (/\s/.test(char) && !quote) {
			if (current) {
				parts.push(current);
				current = "";
			}
			continue;
		}

		current += char;
	}

	if (current) parts.push(current);
	return parts;
}

function shouldEscapeNextCharacter(next: string, quote: '"' | "'" | undefined) {
	if (next === "\\") return true;
	if (quote) return next === quote;
	return next === '"' || next === "'" || /\s/.test(next);
}
