import { existsSync } from "node:fs";
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

export function timeoutFromEnv(envVar: string, defaultTimeoutMs: number) {
	const rawValue = Number(process.env[envVar] ?? defaultTimeoutMs);
	return Number.isFinite(rawValue) && rawValue > 0 ? rawValue : defaultTimeoutMs;
}

export function commandExists(command: string) {
	if (command.includes("/") || command.includes("\\")) return existsSync(command);

	const pathValue = process.env.PATH ?? "";
	const extensions = process.platform === "win32" ? ["", ".exe", ".cmd", ".bat"] : [""];
	for (const directory of pathValue.split(process.platform === "win32" ? ";" : ":")) {
		if (!directory) continue;
		for (const extension of extensions) {
			if (existsSync(path.join(directory, `${command}${extension}`))) return true;
		}
	}

	return false;
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
