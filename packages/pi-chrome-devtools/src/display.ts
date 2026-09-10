import { stripVTControlCharacters } from "node:util";
import { stripTerminalSequences } from "@earendil-works/pi-tui";

const MAX_SANITIZER_INPUT_CODE_UNITS = 50_000;

export function sanitizeChromeDevtoolsDisplay(value: string, maxCharacters = 50_000) {
	const boundedInput = truncateCodeUnits(value, MAX_SANITIZER_INPUT_CODE_UNITS);
	const safeTerminalInput = truncateAtIncompleteTerminalSequence(boundedInput);
	const withoutBidi = stripVTControlCharacters(stripTerminalSequences(safeTerminalInput)).replace(
		/[\u202a-\u202e\u2066-\u2069]/gu,
		"�",
	);
	const sanitized = Array.from(withoutBidi, (character) => {
		const codePoint = character.codePointAt(0) ?? 0;
		const unsafeControl =
			(codePoint >= 0 && codePoint <= 8) ||
			(codePoint >= 11 && codePoint <= 31) ||
			(codePoint >= 127 && codePoint <= 159);
		const loneSurrogate = character.length === 1 && codePoint >= 0xd800 && codePoint <= 0xdfff;
		return unsafeControl || loneSurrogate ? "�" : character;
	}).join("");
	if (sanitized.length <= maxCharacters) return sanitized;

	return `${truncateCodeUnits(sanitized, Math.max(0, maxCharacters - 1))}…`;
}

// Preflight Pi-recognized sequences linearly so malformed suffixes never reach its parser.
function truncateAtIncompleteTerminalSequence(value: string) {
	let position = value.indexOf("\u001b");
	while (position >= 0) {
		const sequenceEnd = terminalSequenceEnd(value, position);
		if (sequenceEnd === -1) return value.slice(0, position);
		position = value.indexOf("\u001b", sequenceEnd ?? position + 1);
	}
	return value;
}

function terminalSequenceEnd(value: string, position: number): number | undefined {
	const type = value[position + 1];
	if (type === "[") {
		for (let index = position + 2; index < value.length; index++) {
			if ("mGKHJ".includes(value[index] ?? "")) return index + 1;
		}
		return -1;
	}
	if (type !== "]" && type !== "_") return undefined;

	for (let index = position + 2; index < value.length; index++) {
		if (value[index] === "\u0007") return index + 1;
		if (value[index] === "\u001b" && value[index + 1] === "\\") return index + 2;
	}
	return -1;
}

function truncateCodeUnits(value: string, maxCodeUnits: number) {
	if (value.length <= maxCodeUnits) return value;
	let truncated = value.slice(0, Math.max(0, maxCodeUnits));
	const lastCodeUnit = truncated.charCodeAt(truncated.length - 1);
	if (lastCodeUnit >= 0xd800 && lastCodeUnit <= 0xdbff) truncated = truncated.slice(0, -1);
	return truncated;
}
