export interface LoadCommandArguments {
	action: "load";
	source: string;
	skill?: string;
	refresh: boolean;
}

export interface UnloadCommandArguments {
	action: "unload";
	all: boolean;
	name?: string;
}

export type SessionSkillsCommandArguments =
	| { action: "status" }
	| { action: "list" }
	| LoadCommandArguments
	| UnloadCommandArguments;

export const SESSION_SKILLS_USAGE =
	"Usage: /session-skills [load <source> [--skill <name>] [--refresh] | list | unload <name> | unload --all]";

export function tokenizeCommandArguments(input: string): string[] {
	const tokens: string[] = [];
	const text = input.trim();
	let current = "";
	let quote: '"' | "'" | undefined;
	let started = false;

	for (let index = 0; index < text.length; index++) {
		const character = text[index];
		const next = text[index + 1];
		if (character === "\\" && next === "\\" && current === "") {
			current = "\\\\";
			index++;
			started = true;
			continue;
		}
		if (
			character === "\\" &&
			quote !== "'" &&
			next !== undefined &&
			(/\s/u.test(next) || next === '"' || next === "'" || next === "\\")
		) {
			current += next;
			index++;
			started = true;
			continue;
		}
		if (quote) {
			if (character === quote) quote = undefined;
			else current += character;
			started = true;
			continue;
		}
		if (character === '"' || character === "'") {
			quote = character;
			started = true;
			continue;
		}
		if (/\s/u.test(character)) {
			if (started) {
				tokens.push(current);
				current = "";
				started = false;
			}
			continue;
		}
		current += character;
		started = true;
	}

	if (quote) throw new Error("Unterminated quote in command arguments.");
	if (started) tokens.push(current);
	return tokens;
}

export function parseSessionSkillsCommandArguments(input: string): SessionSkillsCommandArguments {
	const [route, ...tokens] = tokenizeCommandArguments(input);
	if (route === undefined) return { action: "status" };
	if (route === "list" && tokens.length === 0) return { action: "list" };
	if (route === "load") return parseLoadTokens(tokens);
	if (route === "unload") return parseUnloadTokens(tokens);
	throw new Error(SESSION_SKILLS_USAGE);
}

function parseLoadTokens(tokens: string[]): LoadCommandArguments {
	let source: string | undefined;
	let skill: string | undefined;
	let refresh = false;
	let optionsEnded = false;

	for (let index = 0; index < tokens.length; index++) {
		const token = tokens[index];
		if (token === "--" && !optionsEnded) {
			optionsEnded = true;
			continue;
		}
		if (!optionsEnded && token === "--refresh") {
			if (refresh) throw new Error(SESSION_SKILLS_USAGE);
			refresh = true;
			continue;
		}
		if (!optionsEnded && (token === "--skill" || token === "-s")) {
			const value = tokens[++index];
			if (!value || value.startsWith("-") || skill !== undefined) {
				throw new Error(SESSION_SKILLS_USAGE);
			}
			skill = value;
			continue;
		}
		if (!optionsEnded && token.startsWith("-")) throw new Error(SESSION_SKILLS_USAGE);
		if (source !== undefined) throw new Error(SESSION_SKILLS_USAGE);
		source = token;
	}

	if (!source) throw new Error(SESSION_SKILLS_USAGE);
	return { action: "load", source, refresh, ...(skill === undefined ? {} : { skill }) };
}

function parseUnloadTokens(tokens: string[]): UnloadCommandArguments {
	if (tokens.length === 1 && tokens[0] === "--all") return { action: "unload", all: true };
	if (tokens.length === 1 && !tokens[0].startsWith("-")) {
		return { action: "unload", all: false, name: tokens[0] };
	}
	throw new Error(SESSION_SKILLS_USAGE);
}
